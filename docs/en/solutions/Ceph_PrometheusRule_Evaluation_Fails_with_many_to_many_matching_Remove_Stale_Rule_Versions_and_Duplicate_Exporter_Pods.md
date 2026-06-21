---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Ceph PrometheusRule Evaluation Fails with "many-to-many matching" — Remove Stale Rule Versions and Duplicate Exporter Pods
## Issue

A Ceph-based storage cluster reports evaluation errors on one of its shipped alerting rules — typically the one that joins `ceph_disk_occupation` against device and pool metadata:

```text
ceph_disk_occupation: Evaluating rule failed with
  "many-to-many matching not allowed: matching labels must be unique on one side"
```

In parallel, the storage namespace may show **two** instances of the ceph metrics exporter pod running where only one should exist:

```text
$ kubectl -n <storage-ns> get pods | grep metrics
ocs-metrics-exporter-74c467b6c7-pkqls   2/3   Running   0   48m
ocs-metrics-exporter-85b6dd7776-jspzj   2/3   Running   0   24d
```

Both symptoms trace to the same kind of residue: old `PrometheusRule` objects left behind across previous operator versions, and older exporter deployments that were not cleanly garbage-collected. The alerts are either permanently noisy or permanently silent — the operator's latest rule expects a specific label shape that older residual rules break.

## Root Cause

The ceph storage operator ships its alerting rules through `PrometheusRule` objects. Historical versions shipped different rule names: `prometheus-ceph-v14-rules`, `prometheus-ceph-v16-rules`, etc. Across operator upgrades, newer builds produce `prometheus-ceph-rules` (without a version suffix) and the older ones are expected to be garbage-collected — but that collection does not always complete cleanly.

When two rule sets coexist, each exports labels that overlap. When Prometheus evaluates a rule like `ceph_disk_occupation` that uses a vector match (join two metrics on a shared label), it sees multiple matching series from the different rule sets and aborts evaluation with `many-to-many matching not allowed: matching labels must be unique on one side`. No alerts fire, no dashboards render, until the ambiguity is resolved.

Duplicate `ocs-metrics-exporter` pods are a related symptom: one from the current operator's Deployment and one from a previous Deployment whose reconciliation stopped mid-upgrade. The exporter publishes labelled metrics; two exporters publish two sets of (otherwise identical) series, which aggravates the many-to-many issue on the rule side.

Both residues — stale PrometheusRules and duplicate exporter pods — need cleanup. The operator will reconcile the intended state on the next loop; the residue it cannot self-correct must be deleted manually.

## Resolution

Three steps: clean the stale rules, clean the duplicate exporter, confirm the evaluation error clears.

### Step 1 — list and identify stale PrometheusRules in the storage namespace

```bash
NS=<storage-ns>    # the namespace hosting the ceph/rook operator
kubectl -n "$NS" get prometheusrule -o \
  custom-columns='NAME:.metadata.name,AGE:.metadata.creationTimestamp'
```

Example output:

```text
NAME                        AGE
noobaa-prometheus-rules     5y44d
ocs-prometheus-rules        3y61d
prometheus-ceph-rules       729d
prometheus-ceph-v14-rules   5y44d    # <-- stale, from an old operator release
prometheus-ceph-v16-rules   3y5d     # <-- stale, from an old operator release
s3bucket-nearfull-alert     96d
```

Versioned rules (`prometheus-ceph-v14-rules`, `prometheus-ceph-v16-rules`) are the residue. The unversioned `prometheus-ceph-rules` is the current operator's rule set. Keep the unversioned one; delete the versioned ones.

### Step 2 — delete the stale rules

```bash
kubectl -n "$NS" delete prometheusrule prometheus-ceph-v14-rules
kubectl -n "$NS" delete prometheusrule prometheus-ceph-v16-rules
# Repeat for any other versioned entry.
```

The operator will not recreate them — they are not in its desired state. Only the current rule set remains.

### Step 3 — check the metrics exporter

```bash
kubectl -n "$NS" get pod | grep metrics
```

Zero or one exporter pod is the expected state; two is the problem shape. If two are running:

```bash
kubectl -n "$NS" scale deployment ocs-metrics-exporter --replicas=0

# Wait for pods to terminate completely.
kubectl -n "$NS" get pod -l app=ocs-metrics-exporter -w

# Scale back up.
kubectl -n "$NS" scale deployment ocs-metrics-exporter --replicas=1

# Confirm a single exporter is running.
kubectl -n "$NS" get pod | grep metrics
```

The `scale to 0` forces all pods to terminate; the reconciler's next scale-up creates a single fresh pod. If two pods persist after the cycle, there may be two distinct `Deployment` objects (one from each operator generation) — inspect:

```bash
kubectl -n "$NS" get deployment | grep metrics
```

and delete the older one if it exists.

### Step 4 — verify the rule evaluation recovers

Wait for Prometheus to re-evaluate the rule group (default interval is usually 30s-1m). Then check the platform's rule-evaluation view or query directly:

```bash
# If the platform exposes Prometheus's API through a route/service.
PROM_URL=<platform-prometheus-url>
curl -sk "$PROM_URL/api/v1/rules" | \
  jq -r '.data.groups[].rules[] | select(.name == "ceph_disk_occupation") | {name, state, lastError}'
```

`state: ok` and empty `lastError` indicates the rule now evaluates cleanly. Alerts on the rule should fire or clear as their underlying condition dictates, rather than being permanently stuck because the evaluator refused to run.

### Preventive posture

Follow the operator's upgrade notes when bumping versions to see if any stale rules need pre-clean. If the cluster has been through many upgrades, a periodic audit of `PrometheusRule` in the storage namespace against the operator's current documented rule names catches residue before it starts affecting alert fidelity.

## Diagnostic Steps

Inspect the Prometheus operator's log (or the user-workload Prometheus pod) for the exact rule evaluation error:

```bash
kubectl -n cpaas-monitoring logs \
  -l app.kubernetes.io/name=prometheus \
  --tail=500 | grep -E 'many-to-many|ceph_disk_occupation'
```

Reports of the exact alert name and the `many-to-many` string confirm this pattern.

Compare the label sets of the conflicting rules to confirm they genuinely overlap:

```bash
for rule in prometheus-ceph-v14-rules prometheus-ceph-v16-rules prometheus-ceph-rules; do
  echo "=== $rule ==="
  kubectl -n "$NS" get prometheusrule "$rule" -o jsonpath='{.spec.groups[*].rules[*].record}' 2>/dev/null
  echo
done | sort -u
```

If multiple `prometheus-ceph-*` rules produce the same recording-rule name (same `record` field), the evaluator sees duplicate inputs and fails.

After Step 2 + Step 3, the listing shrinks to a single rule set:

```bash
kubectl -n "$NS" get prometheusrule -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
  | grep -c '^prometheus-ceph'
# 1
```

And the exporter:

```bash
kubectl -n "$NS" get pod | grep -c ocs-metrics-exporter
# 1
```

Both at one indicates the environment is now in the shape the operator expects, and no further evaluator errors should accrue.
