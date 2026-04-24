---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Vector pods inside the cluster log pipeline grow well beyond the resource request and there is no obvious culprit. Operators need a per-component breakdown — which `source`, `transform`, or `sink` is holding the bytes — before they can size limits, prune transforms, or open an upstream bug. The default Vector build does **not** publish allocation metrics, and operators want a temporary way to enable them, capture the data, and roll back.

## Root Cause

Vector exposes per-component allocation tracing only when the binary is started with the command-line flag `--allocation-tracing`. That switch is opt-in because the per-allocation accounting hooks add measurable overhead — Vector itself documents the feature as diagnostic-only and explicitly not for steady-state production use. Versions from `v0.27.0` onward ship the flag; the variant bundled in the platform's logging stack is well past that floor.

Because the collector pods are normally driven by an operator that re-renders the launch command from the managed configuration, simply patching the running ConfigMap or Secret is wiped on the next reconcile. The procedure therefore needs a brief window where the operator stops reconciling, the collector binary is relaunched with the extra flag, and the pods are bounced.

## Resolution

### Preferred: Platform Logging Surface

The ACP **Logging Service** (and the in-core `observability/log` area) exposes the cluster log pipeline as a managed surface. When per-collector memory growth is the symptom, raise it through the Logging Service first — the platform team can either provide the allocation-tracing build for a given window, or supply pre-built dashboards on the standard collector metrics that already isolate noisy `transform` chains. That keeps unsupported flags out of long-running clusters.

### Fallback: Temporary Allocation-Tracing Mode

When the platform-managed surface is not yet enabled, or the suspected leak only reproduces on a specific tenant, the collector can be flipped into an unmanaged window long enough to capture the metrics:

1. **Suspend reconciliation on the forwarder.** With the resource name in `$cr` and the pipeline namespace in `$ns`, set the management state to unmanaged so subsequent edits are not reverted:

   ```bash
   kubectl -n "$ns" patch obsclf/"$cr" \
     --type=merge \
     -p '{"spec":{"managementState":"Unmanaged"}}'
   ```

2. **Inject `--allocation-tracing` into the launch command.** Edit the rendered config object and append the flag to the line that execs the collector binary:

   ```bash
   kubectl -n "$ns" edit cm "$cr"-config
   ```

   Change

   ```text
   exec /usr/bin/vector --config-toml /etc/vector/vector.toml
   ```

   to

   ```text
   exec /usr/bin/vector --config-toml /etc/vector/vector.toml --allocation-tracing
   ```

   In older pipeline shapes the launch script ships in a Secret rather than a ConfigMap; in that case extract the script with `kubectl get secret/collector-config -o yaml`, edit `run-vector.sh`, and re-apply.

3. **Recycle the collector pods so they pick up the new launch command.**

   ```bash
   kubectl -n "$ns" delete pod -l app.kubernetes.io/instance="$cr"
   ```

4. **Capture the data.** Allocation metrics are now available two ways:

   - Interactive: drop into one of the pods and run `vector top` — the **Memory Used** column will be populated per component.

     ```bash
     POD=$(kubectl -n "$ns" get pod -l app.kubernetes.io/instance="$cr" \
              -o jsonpath='{.items[0].metadata.name}')
     kubectl -n "$ns" exec -it "$POD" -- vector top
     ```

   - Historical: scrape the new Prometheus series exposed by the collector:

     | Series | Meaning |
     |---|---|
     | `vector_component_allocated_bytes` | live bytes attributed to each component |
     | `vector_component_allocated_bytes_total` | cumulative allocations |
     | `vector_component_deallocated_bytes_total` | cumulative frees |

     A growing `_allocated_total` without matching `_deallocated_total` for a single `component_id` label is the leak signal.

5. **Revert.** Once the analysis is done, restore the managed state so the operator re-renders the standard launch command and removes the tracing overhead:

   ```bash
   kubectl -n "$ns" patch obsclf/"$cr" \
     --type=merge \
     -p '{"spec":{"managementState":"Managed"}}'
   ```

   Leaving the flag enabled in production is not recommended — the per-allocation hooks add latency and CPU that show up on shipping pipelines.

## Diagnostic Steps

Confirm the running collector picked up the new flag:

```bash
kubectl -n "$ns" get pod -l app.kubernetes.io/instance="$cr" \
  -o jsonpath='{range .items[*]}{.spec.containers[?(@.name=="collector")].args}{"\n"}{end}'
```

Confirm the new metric series is present:

```bash
kubectl -n "$ns" exec -it "$POD" -- \
  curl -s http://127.0.0.1:8686/metrics | grep ^vector_component_allocated_bytes
```

If `vector top` shows zero in the **Memory Used** column even after the bounce, the binary did not start with `--allocation-tracing` — usually because the management state was not flipped before the edit and the operator overwrote the change. Re-run the patch in step 1 and reapply.
