---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The Vector log collector running on ACP repeatedly logs warnings when forwarding events to a `LokiStack` output:

```
WARN sink{component_kind="sink" component_id=loki ...}:
  vector::sinks::loki::config:
  Failed to render template for label_value: TemplateRenderingError ...
  field "kubernetes.labels.app" is missing.
```

Concrete symptoms:

- The `ClusterLogForwarder` declares one or more `labelKeys` under `.spec.outputs[].lokiStack.labelKeys.global` (or `.app` / `.infra` / `.audit`).
- A subset of the configured `labelKey`s never appears as a Loki stream label, even though other labels work.
- Loki receives the events (counts climb) but the LogQL query that filters on the missing label returns nothing.

## Root Cause

`labelKeys` on a `LokiStack` output instructs Vector to lift the named field from each Kubernetes log event and attach it as a Loki **stream label**. Vector renders each label by reading the field path from the event:

- `kubernetes.namespace_name` — present on every event Vector reads from a Pod log.
- `kubernetes.labels.app` — present **only** if the source Pod itself carries a label called `app`.
- `kubernetes.labels.<custom>` — present only if the source Pod has that exact label.

When the configured field is not on a particular event, Vector cannot render the template and emits the `TemplateRenderingError` warning. The event is still delivered to Loki — but with the missing label dropped silently — so the failure is loud in collector logs but invisible at the Loki side until you query and find no results.

The two ways to make the warning stop:

1. **Add the missing label to every Pod that ships logs** — the field becomes present and the template renders.
2. **Remove the failing `labelKey`** from the `ClusterLogForwarder` — Vector stops trying to render it.

Pick (1) when the label is genuinely useful for query (a team / app / version dimension you query in dashboards). Pick (2) when the label is a leftover that no current dashboard or alert references.

## Resolution

### Step 1 — identify the failing `labelKey`

Capture the warning from Vector and read the field name from the message:

```bash
NS=<logging-namespace>
kubectl -n "$NS" logs ds/collector --tail=1000 2>/dev/null | \
  grep -E 'Failed to render template for label_value|field ".*" is missing' | head -10
```

Each line names one missing field. Strip duplicates to get the failing set:

```bash
kubectl -n "$NS" logs ds/collector --tail=20000 2>/dev/null | \
  grep -oE 'field "[^"]+" is missing' | sort -u
# Example output:
#   field "kubernetes.labels.app" is missing
#   field "kubernetes.labels.team" is missing
```

### Step 2 — confirm the field really is missing on the source Pods

Pick one running Pod whose logs are forwarded and check the field path:

```bash
APP_NS=<app-namespace>
POD=$(kubectl -n "$APP_NS" get pod -o=jsonpath='{.items[0].metadata.name}')

kubectl -n "$APP_NS" get pod "$POD" -o=jsonpath='{.metadata.labels}' | jq .
# Look for "app" — if not present, that's why the label_value renders empty.
```

If many Pods are missing the label, you have the diagnosis.

### Step 3 — choose the fix

#### Option A — add the missing label to source Pods (preferred when the label is useful)

If, say, every workload in the namespace logically has an `app` identity but the labels were inconsistent, add a `pod-template-labels` patch to the workloads' templates:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      labels:
        app: my-app          # add this if missing
        team: payments       # add other labelKeys you want surfaced
```

Roll the workload (`kubectl rollout restart deploy/my-app`). The new pods carry the label; their next log event renders cleanly. Older pods without the label keep emitting warnings until they are themselves rolled.

A scriptable sweep for many workloads:

```bash
TARGET_NS=<ns>
for d in $(kubectl -n "$TARGET_NS" get deploy -o=name); do
  if ! kubectl -n "$TARGET_NS" get "$d" -o=jsonpath='{.spec.template.metadata.labels.app}' >/dev/null 2>&1; then
    echo "Missing 'app' label: $d"
  fi
done
```

For policy enforcement, add a Kyverno / Gatekeeper rule that requires the labels you ship to Loki — that prevents future drift.

#### Option B — remove the failing `labelKey` from the `ClusterLogForwarder`

If the missing label is a leftover, drop it from the output config:

```bash
CR=<clusterlogforwarder-name>
NS=<logging-namespace>

kubectl -n "$NS" edit clusterlogforwarder "$CR"
```

Find the failing key under `.spec.outputs[].lokiStack.labelKeys.<scope>` and remove the line:

```yaml
spec:
  outputs:
    - name: default-lokistack
      lokiStack:
        labelKeys:
          global:
            - kubernetes.pod_name
            - kubernetes.container_name
            - kubernetes.namespace_name
            - log_type
            - level
            # - kubernetes.labels.app   # ← remove this line
            - cluster.labels.name       # keep / remove based on what the dashboards use
        target:
          name: logging-loki
          namespace: <ns>
```

Save and apply. The collector operator regenerates Vector's config and rolls the DaemonSet. New collector pods stop emitting the warning.

`kubectl -n "$NS" rollout status ds/collector` to confirm the roll completed.

### Step 4 — confirm the warning is gone

```bash
sleep 30
kubectl -n "$NS" logs ds/collector --tail=200 2>/dev/null | \
  grep -E 'Failed to render template for label_value' | wc -l
# Expected: 0 (or much smaller — old pod rotation may take a couple of minutes)
```

If the count is still high after a few minutes:

- The `ClusterLogForwarder` change did not propagate — recheck `.status.conditions` for a `Ready=True`.
- Other failing keys remain — re-run Step 1.
- Pods without the label keep emitting events — Option A is also needed.

### Step 5 — verify the labels appear in Loki

Query Loki for the labels Vector is now sending:

```bash
# From a debug pod or your local kubectl with LokiStack gateway access:
LOKI_GW=https://logging-loki-gateway-http.<ns>.svc:8080
TOKEN=$(kubectl -n <ns> create token loki-querier --duration=1h)

curl -sk -H "Authorization: Bearer $TOKEN" \
  "$LOKI_GW/api/logs/v1/application/loki/api/v1/labels" | jq .
```

Expected: every `labelKey` you kept in the config appears in the returned label list. The removed ones (Option B) no longer appear; the added ones (Option A) appear after the source pod has shipped at least one event with the label.

If a label appears but no values surface (`labels: ["app"]` but `app: []`), the field is technically rendering but always empty — the source pods carry the key with an empty value. Investigate the workload's pod-template labels.

## Diagnostic Steps

Sample one event end-to-end to see exactly what Vector sees:

```bash
# Bump the collector log level briefly (varies by collector image — check the operator's CRD):
kubectl -n "$NS" set env ds/collector LOG=debug
sleep 30
kubectl -n "$NS" logs ds/collector --tail=200 | grep -B1 -A20 'rendering label'
kubectl -n "$NS" set env ds/collector LOG-      # revert
```

The debug output shows the JSON event Vector parsed and the template substitutions it tried.

For systemic visibility, add a Prometheus alert when the warning rate is non-zero:

```yaml
- alert: LokiCollectorLabelTemplateError
  expr: |
    sum(rate(vector_component_errors_total{component_id="loki",error_type="render"}[5m])) > 0
  for: 5m
  labels: {severity: warning}
  annotations:
    summary: "Vector failing to render label_value for Loki"
    description: "Check ClusterLogForwarder.spec.outputs[].lokiStack.labelKeys for missing fields."
```

After Step 3, the metric should fall to zero. Failing to fall after a roll-out + 10-minute window means another labelKey is also missing — re-enumerate with Step 1.

If you find that nearly every label fails and Vector is rendering almost nothing, the ClusterLogForwarder is misconfigured to pull from a field shape (e.g., `kubernetes.labels.*` flat vs nested). Recheck the operator's documented label paths for your collector version — paths can change between major versions.
