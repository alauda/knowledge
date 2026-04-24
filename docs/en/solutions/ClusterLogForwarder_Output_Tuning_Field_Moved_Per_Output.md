---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `ClusterLogForwarder` (CLF) manifest that previously set delivery, retry and write tuning under each output as a single shared `tuning:` block stops applying its tuning after the cluster log forwarder is moved to the v6 schema. The forwarder reconciles, the output appears healthy, but the per-output back-pressure, retry interval and message size limits behave as if they had not been set — log shippers run with built-in defaults instead.

The platform's preferred path for this workload is the ACP `observability/log` surface backed by the platform's Logging Service, which exposes the same Vector-based collector pipeline; the CLF CRD is the underlying contract and is what this article works with.

## Root Cause

In the v5 schema, every output type shared one `spec.outputs[].tuning` block:

```yaml
spec:
  outputs:
    - name: my-http
      type: http
      tuning:
        delivery: AtMostOnce
        maxWrite: 1M
        minRetryDuration: 1
        maxRetryDuration: 1
        compression: none
```

In the v6 schema the tuning fields moved **inside** the per-type block, because Vector exposes a different set of knobs per sink. The path is now `spec.outputs[].<type>.tuning`. The legacy `spec.outputs[].tuning` field is silently ignored on v6 — the manifest applies cleanly, the output object is created, and the shipper falls back to defaults. The field name `delivery` was also normalised to `deliveryMode` in the same change.

## Resolution

1. **Move the tuning block under the output type.** For an HTTP sink the block now nests under `http`; for a Loki sink it nests under `loki`; for Kafka under `kafka`, and so on. The legacy top-level block at the output level must be removed — leaving both in place will not merge them and is a source of confusion for the next operator.

   ```yaml
   spec:
     outputs:
       - name: my-http
         type: http
         http:
           url: https://collector.example.internal/ingest
           tuning:
             deliveryMode: AtMostOnce
             maxRetryDuration: 1
             maxWrite: 1M
             minRetryDuration: 1
   ```

2. **Rename `delivery` to `deliveryMode`.** The old key is silently dropped; the schema validator does not always reject it, so a working-looking manifest can land in the cluster with no delivery guarantee at all.

3. **Set tuning per output, not per forwarder.** With the tuning block now scoped under each type, two outputs can carry different delivery modes. Use this — for example, `AtLeastOnce` on the durable Loki output and `AtMostOnce` on a sampling-only HTTP webhook — rather than copy-pasting one shared block.

4. **Reconcile and confirm the values landed in the collector.** A successful `kubectl apply` and a `Ready` condition on the CLF object only proves the reconciler accepted the manifest; the collector still needs to render the new sink configuration.

   ```bash
   kubectl -n logging get clusterlogforwarder instance -o yaml \
     | yq '.spec.outputs[] | {name, http: .http.tuning, loki: .loki.tuning}'
   ```

5. **Roll the collector pods if they were already up at the time of the change.** Vector reloads on configuration change but a deployment-rollout makes the change observable from a `kubectl rollout status` and produces a clean log line in the collector that the new sink config is in effect.

## Diagnostic Steps

Confirm whether the running collector picked up the tuning. Vector exposes its applied configuration through its admin endpoint; reading the rendered sink config is the most direct way to verify a mode like `AtMostOnce` is in effect.

```bash
kubectl -n logging get pod -l app.kubernetes.io/name=vector
kubectl -n logging exec <vector-pod> -- \
  sh -c 'cat /etc/vector/vector.yaml | grep -A3 -i mode'
```

Inspect the collector logs for a sink-creation entry; a missing tuning block typically shows up as default values printed at startup. A working sink with the new tuning logs the explicit `deliveryMode`:

```bash
kubectl -n logging logs <vector-pod> -c collector --tail=200 \
  | grep -i -E "sink|tuning|deliveryMode"
```

If the manifest still uses the legacy `spec.outputs[].tuning` path on a v6 forwarder, `kubectl get clusterlogforwarder -o yaml` will show that block sitting unmerged outside the per-type section — that is the signal to move it. After moving the block and re-applying, the unmerged section disappears from the resolved object.
