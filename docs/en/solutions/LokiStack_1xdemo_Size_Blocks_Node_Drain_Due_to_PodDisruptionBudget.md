---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Draining a node that is running LokiStack workloads fails repeatedly. The drain controller or `kubectl drain` retries evicting the Loki pods and logs:

```text
error when evicting pods/"logging-loki-distributor-84f4ccd8d5-5xz6m"
  -n "<log-namespace>" (will retry after 5s):
  Cannot evict pod as it would violate the pod's disruption budget.
error when evicting pods/"logging-loki-index-gateway-0"
  -n "<log-namespace>" (will retry after 5s):
  Cannot evict pod as it would violate the pod's disruption budget.
error when evicting pods/"logging-loki-ingester-0"
  -n "<log-namespace>" (will retry after 5s):
  Cannot evict pod as it would violate the pod's disruption budget.
```

The node stays cordoned; the rollout / maintenance operation is stuck.

## Root Cause

The LokiStack size `1x.demo` is intended for labs and demos — it runs each component (`distributor`, `ingester`, `querier`, `query-frontend`, `index-gateway`) at **one replica**. The operator still creates a `PodDisruptionBudget` with `minAvailable: 1` for each of those components. With only one replica, `ALLOWED DISRUPTIONS` is therefore `0`, and any voluntary eviction is rejected. A node drain is one big voluntary-eviction storm, so it blocks indefinitely.

A quick confirmation:

```bash
kubectl -n <log-namespace> get pdb
```

```text
NAME                           MIN AVAILABLE  ALLOWED DISRUPTIONS
logging-loki-distributor       1              0
logging-loki-gateway           1              1
logging-loki-index-gateway     1              0
logging-loki-ingester          1              0
logging-loki-querier           1              0
logging-loki-query-frontend    1              0
```

## Resolution

Pick one of two approaches. Option 1 is the intended, long-term fix; option 2 is a manual bypass when the cluster genuinely has to stay on the demo size.

### Option 1 — Move off the demo size or raise per-component replicas (recommended)

`1x.demo` is not meant to run across node rollouts. For anything that outlives a lab demo, switch the LokiStack to a production size (`1x.small` or larger), which provisions multiple replicas per component out of the box and gives each PDB a non-zero disruption budget.

If staying on `1x.demo` is unavoidable, override replica counts in `spec.template` so every component that has a PDB runs at least two pods:

```yaml
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
  namespace: <log-namespace>
spec:
  template:
    distributor:
      replicas: 2
    gateway:
      replicas: 2
    indexGateway:
      replicas: 2
    ingester:
      replicas: 2
    querier:
      replicas: 2
    queryFrontend:
      replicas: 2
```

Notes:

- **Do not raise the compactor** above 1 replica. The LokiStack compactor is expected to run as a singleton.
- If `ruler` is not in use, leave it out of the override — adding `ruler` replicas just consumes resources on a feature that is disabled.

After the reconcile, verify each component has two pods and the PDBs now show `ALLOWED DISRUPTIONS: 1`:

```bash
kubectl -n <log-namespace> get pods -l app.kubernetes.io/name=lokistack
kubectl -n <log-namespace> get pdb
```

Node drains will now proceed.

### Option 2 — Manually delete the blocking Loki pods (workaround)

When raising replicas is not feasible right now (e.g. a single-node demo), the only way to complete a drain is to delete the blocking Loki pods manually while the drain is in flight. This is a best-effort bypass — it accepts a gap in ingest/query availability during the restart and may force the ingester to replay its write-ahead log, which can be slow.

From one terminal, start the drain and let it retry:

```bash
kubectl cordon <node-name>
kubectl drain <node-name> \
  --ignore-daemonsets --delete-emptydir-data --force
```

From a second terminal connected to the same cluster, delete the pods the drain reports as blocked:

```bash
kubectl -n <log-namespace> delete pod \
  logging-loki-ingester-0 logging-loki-index-gateway-0
```

Repeat for every pod the drain prints out. The drain will complete once the evicted pods are gone and do not come back on the cordoned node.

If the ingester then fails to start because its WAL is corrupt or the replay takes forever, treat that as a separate failure mode — resolve the WAL state directly on the `logging-loki-ingester-*` pod before running more drains.

## Diagnostic Steps

Confirm the size is `1x.demo`:

```bash
kubectl -n <log-namespace> get lokistack <lokistack-name> \
  -o jsonpath='{.spec.size}{"\n"}'
```

List the PDBs and look for zero `ALLOWED DISRUPTIONS` on the Loki components:

```bash
kubectl -n <log-namespace> get pdb
```

Tail the drain controller / `kubectl drain` output for the `Cannot evict pod as it would violate the pod's disruption budget` message pointing at `logging-loki-*` pods.

After applying Option 1, confirm the desired state before the next drain:

```bash
kubectl -n <log-namespace> get pods -l app.kubernetes.io/name=lokistack -o wide
kubectl -n <log-namespace> get pdb
```

Every Loki component except `compactor` should now have two pods and its PDB should report `ALLOWED DISRUPTIONS: 1`.
