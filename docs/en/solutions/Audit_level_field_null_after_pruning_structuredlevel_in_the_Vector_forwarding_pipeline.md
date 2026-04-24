---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On ACP Logging Service, a `ClusterLogForwarder` with a `prune` filter of type `notIn` sends audit logs to Loki. The field `.k8s_audit_level` is explicitly kept in the `notIn` list, yet every audit record that reaches Loki shows `k8s_audit_level: null`:

```text
{"@timestamp":null,"k8s_audit_level":null,"kubernetes":{...},"log_source":"kubeAPI","log_type":"audit"}
```

The filter configuration looks correct — `k8s_audit_level` is not being pruned directly — but the field is still empty downstream.

## Root Cause

The value of `.k8s_audit_level` is not produced at ingest time. It is **derived** inside the Vector pipeline from `._internal.structured.level` in a later `remap` transform. For the `kubeAPI` audit source, the generated `vector.toml` contains logic similar to:

```text
if ._internal.log_type == "audit" && ._internal.log_source == "kubeAPI" {
    .k8s_audit_level = ._internal.structured.level
}
```

The prune transform runs **before** this remap stage. When the `notIn` list omits `.structured.level`, the prune step drops the `structured` subtree entirely, so by the time the remap stage looks up `._internal.structured.level`, the value is already gone and the derived field resolves to `null`. Keeping `.k8s_audit_level` in the `notIn` list is not enough because the source field it is computed from was pruned upstream.

## Resolution

Add `.structured.level` to the prune filter's `notIn` list so the remap stage can still read the source value.

Preferred path on ACP — update the `ClusterLogForwarder` that Logging Service renders into the collector config:

```bash
kubectl -n <logging-namespace> edit clusterlogforwarder <name>
```

Adjust the `prune-filter` section to keep `.structured.level` alongside `.k8s_audit_level`:

```yaml
spec:
  filters:
    - name: prune-filter
      type: prune
      prune:
        notIn:
          - .message
          - .k8s_audit_level
          - .structured.level       # required for k8s_audit_level to populate
          - .kubernetes.container_name
          - .kubernetes.namespace_name
          - .kubernetes.pod_name
          - .log_source
          - .log_type
  pipelines:
    - name: default-logstore
      filterRefs:
        - prune-filter
      inputRefs:
        - audit
      outputRefs:
        - default-lokistack
```

If the deployment is running a plain upstream Vector collector (no Logging Service operator), apply the same principle to the hand-written `vector.toml`: the prune transform that feeds the `viaq` remap must preserve every `_internal` path the remap depends on. The general rule is **prune last, not first** — derived fields like `.k8s_audit_level`, `.openshift_audit_level`, and `.level` all read from `._internal.structured.*`, so any prune filter placed ahead of the viaq remap must include those paths.

After the edit, the collector pods roll automatically. A new audit record forwarded to Loki should then carry the populated level:

```text
{"@timestamp":null,"k8s_audit_level":"Metadata","level":"Metadata","log_source":"kubeAPI","log_type":"audit"}
```

Once the fix is confirmed, remove the `.structured.level` workaround only if a later Logging Service release moves the derivation ahead of the prune stage — otherwise keep it in place.

## Diagnostic Steps

1. Confirm the symptom by forwarding a known audit event and querying Loki for the pruned stream:

   ```bash
   kubectl -n <logging-namespace> logs -l app.kubernetes.io/name=logging-loki-gateway \
     --tail=50
   ```

   In the log UI, switch the input from `application` to `audit` and expand a single line. If `k8s_audit_level` is `null` while other `notIn` fields (for example `kubernetes.namespace_name`) carry real values, the prune filter is the likely cause.

2. Inspect the rendered Vector configuration to verify the transform ordering:

   ```bash
   kubectl -n <logging-namespace> get cm <collector-config> \
     -o jsonpath='{.data.vector\.toml}' \
     | grep -A 20 'transforms.pipeline_.*_prune_filter'
   ```

   The `prune_filter` transform's output is fed directly into the next `viaq` transform. If the `notIn` list inside the prune source does not contain an `"_internal", "structured", "level"` tuple, the subsequent remap cannot recover `k8s_audit_level`.

3. After changing the forwarder, confirm the rendered config carries the new path:

   ```bash
   kubectl -n <logging-namespace> get cm <collector-config> \
     -o jsonpath='{.data.vector\.toml}' \
     | grep 'structured'
   ```

   The matching line should list `["_internal","structured","level"]` inside the prune filter's notIn block.

4. If the collector pods did not roll on their own, delete them to force a re-read of the generated config:

   ```bash
   kubectl -n <logging-namespace> delete pod -l component=collector
   ```
