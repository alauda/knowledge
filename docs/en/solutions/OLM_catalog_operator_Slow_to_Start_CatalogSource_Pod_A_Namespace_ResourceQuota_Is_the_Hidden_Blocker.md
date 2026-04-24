---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `CatalogSource` is recreated (as part of an operator-hub refresh, a catalog image bump, or disaster recovery), and OLM takes an unreasonably long time to bring up the registry pod. During the wait, the `catalog-operator` pod's log fills with a mix of two error shapes:

```text
sync "<ns>/<catsrc>" failed:
  [error using catalogsource <marketplace-ns>/<catsrc>:
    failed to list bundles:
    rpc error: code = Unavailable
    desc = connection error: desc = "transport: Error while dialing:
      dial tcp 10.x.y.z:50051: connect: connection refused",
   ...]
   (repeated for every unrelated CatalogSource)
```

and:

```text
sync "<user-ns>/<catalog>" failed:
  couldn't ensure registry server: error ensuring updated catalog source pod::
  creating update catalog source pod:
  pods "<catalog>-bg44c" is forbidden:
  exceeded quota: <quota-name>,
  requested: requests.memory=50Mi,
  used: requests.memory=2012Mi,
  limited: requests.memory=2Gi
```

The first kind of error is a symptom of the second: while the catalog-operator cannot create the registry pod for one CatalogSource (because a namespace ResourceQuota rejects the creation), the `connection refused` lines for other CatalogSources pile up because the operator reconciles serially and the queue behind the blocked item grows.

## Root Cause

The OLM catalog-operator processes CatalogSource reconciles through a work queue; on each item it ensures the registry pod exists, is healthy, and is serving gRPC on port 50051. When a reconcile hits an admission error — the `ResourceQuota` rejection in this case — the operator records the error and requeues the item. It does not skip ahead to other items:

1. `CatalogSource <A>` is recreated; its registry pod creation is rejected by ResourceQuota.
2. The operator requeues the item with backoff.
3. Other CatalogSources whose registry pods exist and run fine still need periodic reconciles (to refresh the bundle index).
4. Each of those reconciles makes gRPC calls to the running registry pods; the gRPC calls are fine, but the operator's overall throughput is limited by how fast the work queue drains.
5. The combination of "blocked item constantly requeued" plus "other items get scheduled in between" makes progress look slow. The operator is not stuck — it is successfully reconciling others while continuing to fail on the quota-blocked one.

The `connection refused` errors against other catalog sources are the visible symptom of the operator handling requests serially under stress; the **root** cause is the single ResourceQuota rejection that the operator cannot make progress past.

## Resolution

### Raise or remove the blocking ResourceQuota

Identify the quota:

```bash
# The error message names both the namespace and the quota.
NS=<user-ns>
QUOTA=<quota-name>

kubectl -n "$NS" get resourcequota "$QUOTA" -o yaml | yq '.spec, .status'
```

Inspect the `hard` and `used` fields. If `used` is already at or very close to `hard` on `requests.memory`, the catalog pod's 50 MiB request pushes it over. Two options:

**Option 1 — raise the quota.** A catalog pod's resource ask is small (typically 50-100 MiB memory, sub-hundred-millicpu); raising the quota by that delta is usually safe:

```bash
kubectl -n "$NS" patch resourcequota "$QUOTA" --type=merge \
  -p '{"spec":{"hard":{"requests.memory":"4Gi"}}}'
```

**Option 2 — relocate the catalog**. If the quota's purpose is specifically to cap the user namespace's memory budget (the quota was intentional), move the CatalogSource into a dedicated catalog namespace that is not bound by the user quota:

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: example-catalog
  namespace: <catalog-ns>            # not <user-ns>
spec:
  sourceType: grpc
  image: <catalog-image>
```

Reference it from Subscriptions by `spec.sourceNamespace: <catalog-ns>` so the Subscription can still consume from it.

### Clear stuck items so the operator catches up

After the quota is raised, the catalog-operator's next reconcile creates the registry pod successfully. But the existing work queue may still carry the old error state. Give it a shove:

```bash
kubectl -n <olm-ns> delete pod -l app=catalog-operator
```

The fresh pod picks up cleanly. Watch:

```bash
kubectl -n <olm-ns> logs -l app=catalog-operator --tail=200 -f
```

`catalog-operator` should start reporting successful `syncCatalogSource` completions for every CatalogSource including the previously-blocked one. `connection refused` errors stop once queue depth normalises.

### Verify the registry pods

After the operator recovers, every CatalogSource in the cluster should have a `Running` registry pod:

```bash
kubectl get catalogsource -A -o \
  custom-columns='NS:.metadata.namespace,NAME:.metadata.name,READY:.status.connectionState.lastObservedState'
```

Every row should show `READY`. Any `CONNECTING` or `TRANSIENT_FAILURE` that persists is a separate issue (maybe the catalog image itself is broken), worth a specific investigation.

### Prevent recurrence

Two preventive patterns:

- **Keep CatalogSources out of user namespaces with strict quotas.** Dedicate a namespace for catalogs (typical default: `operators` or a cluster-specific `catalog-system`) and reference them cross-namespace from Subscriptions.
- **Size quotas to include operator overhead.** When a ResourceQuota is set on a namespace that hosts operator-managed workloads, budget the operator's own overhead (catalog pod, operator pod if it runs in the user namespace) into the quota so user workloads do not compete with operator infrastructure.

## Diagnostic Steps

Find the specific CatalogSource that triggered the blockage. The error message embeds the namespace/name:

```bash
kubectl -n <olm-ns> logs -l app=catalog-operator --tail=500 | \
  grep -oE "couldn't ensure registry server.*quota.*[^'\"]+" | head -3
```

Identify the quota's current state:

```bash
kubectl -n <user-ns> describe resourcequota <name>
```

Look at the `Used / Hard` ratio. Any resource near 100% is the likely blocker; applying the fix to that resource is what resolves the reconcile.

Inspect the blocked CatalogSource:

```bash
kubectl -n <user-ns> get catalogsource <name> -o yaml | \
  yq '.status.connectionState, .status.message'
```

`message` should clear after the quota fix and the connection state should transition to `READY` on the next reconcile. The sibling CatalogSources whose pods were `Running` all along should not have been affected by the quota issue other than through the shared operator queue latency.
