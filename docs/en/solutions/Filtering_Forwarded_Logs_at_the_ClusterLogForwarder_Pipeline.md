---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A platform operator needs to reduce the volume that the log collector ships to a downstream sink. The two recurring asks are:

- attach extra `syslog` `facility` and `severity` values to forwarded audit log records, so a downstream SIEM can route them differently;
- restrict which application or audit log records leave the cluster at all, by namespace, label, container, or by an arbitrary record field.

Sending every container line and every Kubernetes API audit event to a remote sink is expensive and frequently triggers backpressure on the collector. Filtering belongs at the source.

## Root Cause

The collector pipeline (Vector under the hood) supports two distinct shaping points, and confusion between them is the most common reason filtering "does not work":

- **Input filtering** runs before the record enters a pipeline. It is the right place to drop entire log streams (a noisy namespace, a verbose audit user) and to attach a constant `syslog` facility/severity to a stream of audit records.
- **Output filtering / content filters** run after the input has been selected, on the in-flight record. This is where individual fields are pruned (`prune`) or whole records matching a predicate are dropped (`drop`).

The platform's preferred surface — `observability/log` plus the **Logging Service** extension — exposes both points through the `ClusterLogForwarder` CR. There is no need to template Vector TOML by hand.

## Resolution

### Preferred: Configure Filters Through the Platform Logging Surface

Use the `observability/log` console (or the Logging Service extension) to declare filters on a `ClusterLogForwarder`. The platform reconciles them into the Vector pipeline and validates the result before rolling. Concretely, declare:

1. an **input** that selects only the streams the downstream cares about (per-namespace, per-label, per-container, or `audit` with an audit-policy-style selector);
2. a **filter** of type `prune` to strip noisy fields, of type `drop` to discard records matching a predicate, or of type `kubeAPIAudit` to apply an audit-policy-style allow/deny tree to API audit events;
3. a **pipeline** that wires the input through the filter chain to the output.

A minimal `ClusterLogForwarder` that selects only application logs from two namespaces, prunes high-cardinality kubernetes labels, and drops health-probe noise looks like this:

```yaml
apiVersion: observability.alauda.io/v1
kind: ClusterLogForwarder
metadata:
  name: forwarder
  namespace: logging
spec:
  serviceAccount:
    name: logging-collector
  inputs:
    - name: app-billing
      type: application
      application:
        includes:
          - namespace: billing
          - namespace: payments
        excludes:
          - container: istio-proxy
  filters:
    - name: prune-labels
      type: prune
      prune:
        in:
          - .kubernetes.labels."pod-template-hash"
          - .kubernetes.labels."controller-revision-hash"
    - name: drop-probes
      type: drop
      drop:
        - test:
            - field: .message
              matches: "GET /healthz"
            - field: .kubernetes.container_name
              matches: "^proxy$"
  outputs:
    - name: remote-syslog
      type: syslog
      syslog:
        url: tcp://syslog.example.com:514
        rfc: RFC5424
        facility: local0
        severity: informational
  pipelines:
    - name: app-to-syslog
      inputRefs: [app-billing]
      filterRefs: [prune-labels, drop-probes]
      outputRefs: [remote-syslog]
```

For audit traffic specifically, set `facility` and `severity` per output (here `local0` / `informational`) so the downstream SIEM can route on standard syslog headers. The same output type can be reused by multiple pipelines; declare additional pipelines that pin different audit slices to different facility codes when the SIEM needs the separation.

### Trim Audit Volume with kubeAPIAudit Filter

Kubernetes API audit events dwarf every other source on a busy cluster. Add a `kubeAPIAudit` filter to keep only the verbs/users/resources that matter, instead of forwarding the full firehose:

```yaml
filters:
  - name: audit-trim
    type: kubeAPIAudit
    kubeAPIAudit:
      rules:
        - level: None
          users:
            - "system:apiserver"
            - "system:kube-controller-manager"
        - level: None
          verbs: ["get", "watch", "list"]
        - level: Metadata
          resources:
            - group: ""
              resources: ["secrets", "configmaps"]
        - level: RequestResponse
          resources:
            - group: "rbac.authorization.k8s.io"
              resources: ["roles", "rolebindings", "clusterroles", "clusterrolebindings"]
```

Wire it into the audit pipeline via `filterRefs`. The default reduction on a typical cluster is 80–95% of audit volume, which usually keeps the downstream sink within its quota.

### Fallback: Selecting by Pod Name or Label Without a CR Edit

If the workload owner cannot edit `ClusterLogForwarder` directly, place the selector at the namespace level by labeling the source namespace (`logging.opt-in=true`) and reference that label from a single platform-managed input. This keeps the routing decision close to the application owner without giving them write access to the cluster-wide forwarder.

## Diagnostic Steps

Confirm the forwarder is healthy and the pipeline applied:

```bash
kubectl -n logging get clusterlogforwarder forwarder -o yaml
kubectl -n logging get clusterlogforwarder forwarder \
  -o jsonpath='{.status.conditions}' | jq .
```

Tail the collector pod and look for filter compile errors:

```bash
kubectl -n logging get pods -l app.kubernetes.io/component=collector
kubectl -n logging logs ds/collector --tail=200 | grep -Ei "filter|drop|prune|error"
```

If records still arrive at the sink that should have been dropped, validate the predicate locally before redeploying. The `drop.test` block uses anchored regexes against record fields, and a missing `^`/`$` is a common reason a rule "does nothing":

```bash
# inside a debug pod with the same Vector image:
echo '{"message":"GET /healthz","kubernetes":{"container_name":"proxy"}}' \
  | vector --config-yaml /tmp/test.yaml
```

If audit events are not arriving at all, check the audit pipeline's `inputRefs` — the `audit` input requires the platform-side audit policy to be configured to emit events at the desired level; a filter cannot recover detail that was never recorded.
