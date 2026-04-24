---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `LokiStack` deployment (the Loki distributor/ingester/compactor/index-gateway/querier topology managed as a single CR by the Loki operator that ACP ships through `observability/log` and the **Logging Service** extension) was created against one `StorageClass`, and the operator now needs to be moved to a different `StorageClass`. The storage swap raises three immediate questions:

- Does the Loki operator support changing `storageClassName` on a live `LokiStack` at all?
- Will the change drop logs?
- What is the right order of operations so the temporary local state held by ingesters is not thrown away mid-rotation?

The answers below assume Loki is configured against an external object store (S3, MinIO, or compatible) — the standard production topology — and that the PVCs only carry transient state.

## Root Cause

A `LokiStack`'s persistent state is split across two layers:

1. **Object storage** (S3-compatible): all flushed chunks, the index, and the long-term query data. This is where the **logs themselves** live. The `StorageClassName` of the StatefulSet PVCs has no relationship to object storage — changing it does not touch the chunks.
2. **PVC-backed local state** on each Loki component: the **Write Ahead Log (WAL)** held by ingesters before flush, plus per-component caches (compactor working set, index-gateway local index, etc.). PVCs are recreated when the `StorageClassName` changes; their contents are lost.

So the answer to "will logs be lost?" is: **persistent log data is safe** because it lives in object storage; **only the in-flight WAL data on ingesters is at risk** because that is the one piece of PVC content that has not yet been flushed.

The other layer of the problem is the rotation order. A `LokiStack` consists of multiple StatefulSets and the operator restarts them on its own schedule. The `storageClassName` field on the LokiStack CR is the *desired* state; for it to take effect on existing PVCs, the PVCs themselves have to be deleted and recreated — the operator does not migrate PVCs in place. That deletion has to be done component-by-component, with the **ingester rotation last** and with a controlled flush before each ingester restart, so the WAL is drained to object storage before its PVC is removed.

The Loki operator on ACP is designed around this: the CR change is safe to make ahead of time; the rotation is then driven by deleting the PVCs and StatefulSets in the right order so the operator recreates them under the new `StorageClass`.

## Resolution

### Preferred: rotate the LokiStack on ACP's logging surface, ingesters last with a controlled flush

The procedure below is for `LokiStack` managed on ACP through `observability/log` (in-core) or the **Logging Service** extension. Test it once on a non-production LokiStack before running on a production one.

Throughout, the variables map to the LokiStack CR name and namespace:

```bash
cr="<lokistack-name>"            # e.g. logging-loki
ns="<lokistack-namespace>"       # the namespace the LokiStack lives in
new_sc="<target-storage-class>"  # the StorageClass to migrate to
```

#### Step 0. Verify the LokiStack is healthy before touching it

All component pods must be `Ready`:

```bash
kubectl -n "$ns" get pods -l app.kubernetes.io/instance="$cr"
```

Confirm the operator is in `Managed` mode — if it is `Unmanaged`, no changes will be applied:

```bash
kubectl -n "$ns" get lokistack "$cr" -o jsonpath='{.spec.managementState}{"\n"}'
```

Expect `Managed`.

#### Step 1. Update the LokiStack CR's storageClassName

Read the current value (so it can be confirmed and reverted if needed):

```bash
kubectl -n "$ns" get lokistack "$cr" -o jsonpath='{.spec.storageClassName}{"\n"}'
kubectl -n "$ns" get pvc -l app.kubernetes.io/instance="$cr" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"  storageClassName="}{.spec.storageClassName}{"\n"}{end}'
```

Patch the CR to the new class:

```bash
kubectl -n "$ns" patch lokistack/"$cr" \
  --type=merge \
  -p "{\"spec\":{\"storageClassName\":\"$new_sc\"}}"
```

Verify the change persisted:

```bash
kubectl -n "$ns" get lokistack "$cr" -o jsonpath='{.spec.storageClassName}{"\n"}'
```

The CR now carries the new class. Existing PVCs are unchanged at this point — the operator does not rewrite live PVCs.

#### Step 2. Rotate the **compactor**

The compactor's PVC is purely a working set; nothing in it needs to survive the rotation. The only subtlety is that the PVC has to be deleted **before** the StatefulSet is restarted, so the operator-driven recreate picks up the new `StorageClass`.

In one terminal, start the PVC delete (it will block on the StatefulSet still using it):

```bash
kubectl -n "$ns" delete pvc -l app.kubernetes.io/component=compactor
```

In a second terminal, delete the StatefulSet so the operator recreates it with the new PVC:

```bash
kubectl -n "$ns" delete sts -l app.kubernetes.io/component=compactor
```

Wait for the new compactor pod to come up `Running` and `1/1`, and confirm its PVC is now on the new class:

```bash
kubectl -n "$ns" get pod -l app.kubernetes.io/component=compactor -w
kubectl -n "$ns" get pvc -l app.kubernetes.io/component=compactor
```

#### Step 3. Rotate the **index-gateway**

Same pattern as the compactor; the index-gateway's PVC is a local cache the gateway will rebuild from the index in object storage.

```bash
kubectl -n "$ns" delete pvc -l app.kubernetes.io/component=index-gateway
# in a second terminal:
kubectl -n "$ns" delete sts -l app.kubernetes.io/component=index-gateway
kubectl -n "$ns" get pod -l app.kubernetes.io/component=index-gateway -w
kubectl -n "$ns" get pvc -l app.kubernetes.io/component=index-gateway
```

#### Step 4. Rotate the **ingesters** — flush the WAL first

Ingesters are the only component whose PVCs carry data that does not live in object storage yet: the WAL holds chunks that have not been flushed. Removing those PVCs without flushing first will lose any logs that were in flight at the moment.

**Pre-conditions:**

- The LokiStack must have **at least 3 ingesters** before this step. The procedure restarts ingesters one at a time; with fewer than 3, the ring loses quorum and ingestion stops until all replicas are back. If the deployment has fewer than 3, scale up (via the LokiStack `size` parameter) before proceeding.
- Allow enough delay between flushing one ingester and restarting the next for the ingester to (a) finish flushing chunks, (b) leave the ring cleanly, and (c) for the new pod to join the ring. The exact delay depends on WAL size; 5 minutes per ingester is a reasonable starting figure for moderately-loaded clusters.

**Procedure:**

First, restart the ingester StatefulSet so the operator picks up the new PVC template (this will cause a brief disruption while pods restart in their default order — that disruption is unavoidable):

```bash
kubectl -n "$ns" delete sts -l app.kubernetes.io/component=ingester
kubectl -n "$ns" get pod -l app.kubernetes.io/component=ingester -w
```

Wait until ingesters are all `Running` and `1/1` again. Then, **per ingester**, drive a graceful flush via Loki's HTTP `/ingester/shutdown?flush=true` endpoint, then delete the pod so the operator brings up a replacement against the new PVC. The endpoint:

1. Flushes pending chunks from the WAL to object storage.
2. Removes the ingester from the hash ring.
3. Lets the pod terminate cleanly.

Loop over the ingesters one at a time:

```bash
delay_after_flush=60       # let the flush settle
delay_between_pods=300     # let the new pod rejoin the ring before moving on

# delete the existing PVCs — the StatefulSet recreate will request new ones
kubectl -n "$ns" delete pvc -l app.kubernetes.io/component=ingester &

# in a second terminal, drain ingesters one by one
for pod in $(kubectl -n "$ns" get pod \
              -l app.kubernetes.io/component=ingester -o name); do
  echo "### draining $pod"
  kubectl -n "$ns" exec "$pod" -- \
    curl -k \
      --cert /var/run/tls/http/server/tls.crt \
      --key  /var/run/tls/http/server/tls.key \
      --noproxy 127.0.0.1 \
      -H 'Accept: application/json' \
      "https://127.0.0.1:3100/ingester/shutdown?flush=true"
  sleep "$delay_after_flush"
  kubectl -n "$ns" delete "$pod"
  sleep "$delay_between_pods"
done
```

For larger WALs the per-pod delay should be increased — the safer pattern is to run the loop body **by hand** for each ingester, watching the pod's logs for `flushed all chunks` before deleting it.

Confirm the migration completed cleanly:

```bash
kubectl -n "$ns" get pod -l app.kubernetes.io/component=ingester
kubectl -n "$ns" get pvc -l app.kubernetes.io/component=ingester
```

All ingester pods should be `1/1 Running`; all PVCs should now show `STORAGECLASS=$new_sc`. Recent log queries against the LokiStack should return without gaps — confirmation that the flush took the WAL safely through to object storage before the PVC was rotated.

### Fallback: an OSS Loki deployment that ACP does not manage

If the cluster runs Loki/`LokiStack` outside ACP's logging surface (a hand-rolled `helm install grafana/loki` deployment, for example), the same Kubernetes objects are involved (StatefulSets, PVCs, the same `/ingester/shutdown?flush=true` endpoint) and the same per-component rotation order applies — the only difference is the operator owning the CR. Edit the upstream `LokiStack` (or its underlying `helm` values) to change `storageClassName`, then drive the per-component rotation as above, with ingesters last and a flush before each replacement.

## Diagnostic Steps

Before the rotation, capture the current state so reversibility is possible:

```bash
kubectl -n "$ns" get lokistack "$cr" -o yaml > lokistack-pre.yaml
kubectl -n "$ns" get pvc -l app.kubernetes.io/instance="$cr" -o wide
```

After each component rotation, confirm:

- The PVCs for that component are bound to the new `StorageClass`:

  ```bash
  kubectl -n "$ns" get pvc -l app.kubernetes.io/component=<component> \
    -o custom-columns=NAME:.metadata.name,SC:.spec.storageClassName,STATUS:.status.phase
  ```

- The pods for that component are healthy and the operator has not raised any new condition on the `LokiStack` CR:

  ```bash
  kubectl -n "$ns" get lokistack "$cr" -o jsonpath='{.status.conditions}' | \
    jq -r '.[] | "\(.type)=\(.status) \(.reason): \(.message)"'
  ```

  Expected: `Ready=True`, no `Failed` / `Pending` conditions.

For the ingester rotation specifically, confirm the WAL flush worked by querying recent timestamps from the LokiStack right after each ingester restart. If a query for the last ~5 minutes of any active stream returns a gap that is larger than the inter-pod delay, the flush did not complete before the pod was removed — increase `delay_after_flush` and `delay_between_pods` and verify the WAL size on subsequent ingesters with:

```bash
kubectl -n "$ns" exec <ingester-pod> -- \
  du -sh /var/loki/wal 2>/dev/null
```

A growing WAL size between flush calls indicates ingest is outpacing flush; in that case the rotation should be done at a quieter time, or the LokiStack should be horizontally scaled before the rotation.
