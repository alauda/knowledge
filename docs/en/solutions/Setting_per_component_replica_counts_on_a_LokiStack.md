---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A LokiStack-backed log store grew large enough that the default replica counts can no longer keep up. Symptoms vary by component:

- **Distributor / ingester** queueing on writes; clients see `429 Too Many Requests` from the gateway.
- **Querier / query-frontend** slow on UI dashboards or LogQL CLI calls; some queries time out.
- **Index-gateway** intermittent index-lookup latency spikes.

The fix is to scale the affected component horizontally. Editing the underlying StatefulSet directly is reverted by the LokiStack operator within seconds; the change has to flow through the LokiStack CR's `spec.template.<component>.replicas` field. One important exception: the **compactor** is a singleton — bumping its replica count is silently ignored.

## Resolution

Identify the active LokiStack CR and edit its `spec.template` block to set the desired replica count per component. Each top-level component carries its own `replicas` key:

```yaml
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
  namespace: cpaas-logging
spec:
  size: 1x.medium
  template:
    distributor:
      replicas: 3
    ingester:
      replicas: 3              # writes; main scaling lever
    querier:
      replicas: 3              # reads; bump alongside query-frontend
    queryFrontend:
      replicas: 2
    indexGateway:
      replicas: 2
    gateway:
      replicas: 2
    compactor:
      replicas: 1              # always 1; raising this has no effect
```

Apply with `kubectl apply -f` or `kubectl edit lokistack logging-loki -n cpaas-logging`. The LokiStack operator re-renders each component's StatefulSet with the new replica count. New replicas come up within a minute (ingester takes longer because it must replay WAL).

### Component sizing notes

The replica count interacts with the t-shirt `spec.size` in two ways:

- **`spec.size`** sets per-pod CPU and memory; **`spec.template.<comp>.replicas`** sets pod count. Scale the replica count independently when more pods are needed but per-pod resources are already adequate.
- Some t-shirt sizes already pre-set replica counts greater than 1. Setting `spec.template.<comp>.replicas` lower than the t-shirt's default may be ignored by the operator — the t-shirt is the floor.

Practical defaults for a busy cluster sized at `1x.medium` or larger:

| Component | Suggested replica range | Why scale |
|---|---|---|
| `distributor` | 2–4 | Stateless; raise when ingest QPS climbs |
| `ingester` | 3+ | Holds the in-memory WAL; quorum requires odd count |
| `querier` | 2–6 | CPU-bound on heavy LogQL; raise when query latency p95 climbs |
| `queryFrontend` | 1–2 | Splits and caches queries; rarely needs > 2 |
| `indexGateway` | 1–3 | Cache-friendly; raise when index lookups become a bottleneck |
| `gateway` | 2+ | Stateless TLS terminator and tenant router |
| `compactor` | **1 (fixed)** | Singleton by upstream design; multi-instance corrupts the index |

The compactor restriction is enforced by the operator: setting `spec.template.compactor.replicas: 2` is rejected (or silently coerced back to 1, depending on operator version). Compactor's job — claim a chunk file, compact it, mark old chunks for retention — relies on global lock semantics. Two compactors racing on the same chunk would either double-delete or leave dangling index entries. If compactor throughput is the binding constraint, the lever is per-pod resources (raise the t-shirt size) or the compactor's `compactor.compaction-interval` knob in the runtime config, not horizontal scaling.

### Confirm the new replicas come up

Watch the pods come up:

```bash
kubectl -n cpaas-logging get pods -l app.kubernetes.io/component=ingester -w
```

After all expected replicas reach `Running`, list the StatefulSet replicas to confirm the operator rendered the requested count:

```bash
kubectl -n cpaas-logging get statefulset \
  -l app.kubernetes.io/instance=logging-loki \
  -o custom-columns=NAME:.metadata.name,DESIRED:.spec.replicas,READY:.status.readyReplicas
```

If the desired and ready columns don't match within a few minutes, fall through to the diagnostic steps.

## Diagnostic Steps

If a replica count change does not take effect, the LokiStack operator may not be reconciling. Check its log for objections:

```bash
kubectl -n cpaas-logging logs deploy/loki-operator-controller-manager --tail=200 \
  | grep -E "logging-loki|reconcile|template"
```

A `replicas value out of range` or `feature gated by spec.size` line indicates the requested count is not allowed for the chosen t-shirt — bump `spec.size` first.

If the StatefulSet shows the new desired replicas but pods are not coming up:

```bash
kubectl -n cpaas-logging describe statefulset logging-loki-ingester
kubectl -n cpaas-logging get pvc -l app.kubernetes.io/component=ingester
```

Each new ingester replica needs a fresh PVC. If the StorageClass is `WaitForFirstConsumer`, the PVC stays in `Pending` until the pod is scheduled — confirm there is enough free capacity in the chosen storage backend and that the StorageClass's provisioner is healthy.

If a query-frontend or querier replica increase did not improve latency, check whether the gateway is now the bottleneck:

```promql
histogram_quantile(0.95,
  sum by (le) (rate(loki_request_duration_seconds_bucket{
    job="logging-loki-gateway"
  }[5m]))
)
```

A high p95 here points at gateway, not querier — bump `gateway` replicas alongside the query path.

For the compactor specifically (which cannot be scaled), check whether retention sweeps are keeping up with the ingest rate:

```bash
kubectl -n cpaas-logging logs deploy/logging-loki-compactor --tail=200 \
  | grep -E 'retention|compaction interval|skipped'
```

Repeated `skipped: previous run still in progress` messages indicate compaction is the bottleneck. The fix is one of:

- Raise the compactor's per-pod resources (move to a larger `spec.size`).
- Loosen retention so the compactor has fewer chunks to mark per cycle.
- Move retention enforcement to the object-store lifecycle policy and stop using Loki-side retention; the compactor still runs for index compaction but skips the deletion sweep.

When the compactor pod itself is healthy and other components scaled up cleanly, the LokiStack is correctly sized for the workload.
