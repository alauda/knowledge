---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# One unhealthy CatalogSource blocks every operator install via OLM
## Issue

A new operator install (or an existing one's upgrade) fails with `ResolutionFailed` even though the operator the user is installing has nothing to do with the failing catalog. Subscription events look like:

```text
failed to populate resolver cache from source community-catalog/cpaas-marketplace:
  failed to list bundles: rpc error: code = Unavailable desc = connection error:
  desc = "transport: Error while dialing dial tcp 172.30.0.5:50051: connect: connection refused"
```

The OLM controllers also log the same error against the unrelated catalog. The user notices that one specific catalog (often a third-party one whose registry image stopped serving, an air-gap mirror that was rotated, or a proxied catalog whose proxy is down) is in `Failed` state — and every operator install is now stuck even though the rest of the catalogs are healthy.

## Root Cause

OLM's dependency resolver evaluates **every** known CatalogSource together when resolving a Subscription, because a transitive dependency could in principle live in any catalog. If any one CatalogSource fails to populate (the registry pod is down, gRPC is unreachable, the bundle index is corrupt), the resolver cannot guarantee that its decision is correct — it might pick the wrong version of a transitive dependency because it didn't see the catalog that actually had the right one. Rather than commit a possibly-wrong choice, OLM halts.

The behaviour is intentional and documented as a safety property: "if any catalog is sick, no installs". The trade-off is that one broken catalog wedges the entire marketplace until either the catalog is fixed or it is removed from the resolver's view.

## Resolution

Two options. Pick by whether the broken catalog can be repaired in place.

### Option 1 — fix the broken CatalogSource

If the unhealthy catalog can be brought back (the registry image is reachable, the proxy works, the bundle index is regenerated), the cleanest fix is just to repair it. OLM resumes resolution within a couple of seconds of the catalog returning to `Ready`.

Identify the unhealthy CatalogSource:

```bash
NS=cpaas-marketplace
kubectl -n "$NS" get catalogsource \
  -o custom-columns=NAME:.metadata.name,STATUS:.status.connectionState.lastObservedState
```

A `TRANSIENT_FAILURE` or empty `STATUS` is the broken one. Look at its registry pod:

```bash
kubectl -n "$NS" get pods -l olm.catalogSource
kubectl -n "$NS" logs <catalog-registry-pod> --tail=200
```

Common fixes:

- **`ImagePullBackOff`** — the catalog image moved or its pull secret expired. Update the CatalogSource's `spec.image` or refresh the pull secret.
- **`grpc connection refused`** — the registry container crashed. Delete the pod; the controller respawns it.
- **OOM** — the catalog has too many bundles for the default 100Mi. Bump `spec.grpcPodConfig.memoryRequests` and `memoryLimits`.

Once the catalog reports `READY`, retry the failing Subscription's resolution by touching its annotations:

```bash
kubectl -n "$INSTALL_NS" annotate subscription <sub-name> \
  cpaas.io/force-reresolve="$(date +%s)" --overwrite
```

The Subscription resolves and the InstallPlan rolls out.

### Option 2 — segregate catalogs so the broken one drops out of resolution

When the broken catalog cannot be fixed quickly (a third-party catalog whose vendor is down, a mirror under maintenance, a corrupted index that needs rebuilding), the workaround is to suppress the default catalogs and re-create only the ones that are needed under different names. New Subscriptions then explicitly reference one of the renamed catalogs, and the resolver no longer pulls the broken one into its world view.

Back up every catalog, rename a copy of the healthy ones, disable the platform-default catalogs, and recreate the renamed ones:

```bash
NS=cpaas-marketplace

# 1. Snapshot every CatalogSource into per-catalog YAML.
for cs in $(kubectl -n "$NS" get catalogsource -o jsonpath='{.items[*].metadata.name}'); do
  echo "snapshot $cs"
  kubectl -n "$NS" get catalogsource "$cs" -o yaml > "${cs}.yaml"
  cp "${cs}.yaml" "${cs}_backup.yaml"
done

# 2. Append `-custom` to the name field of every snapshot.
for f in *.yaml; do
  [[ "$f" == *_backup.yaml ]] && continue
  sed -i 's/^\(  name:\) \(.*\)$/\1 \2-custom/' "$f"
done

# 3. Disable the platform's default catalogs (only relevant if the platform
#    ships a top-level OperatorHub-equivalent CR that auto-provisions defaults).
kubectl get operatorhub.config.cpaas.io cluster && \
  kubectl patch operatorhub.config.cpaas.io cluster --type=json \
    -p '[{"op": "add", "path": "/spec/disableAllDefaultSources", "value": true}]'

# 4. Re-create the renamed catalogs (skipping the broken one).
for f in *.yaml; do
  [[ "$f" == *_backup.yaml ]] && continue
  [[ "$f" == "<broken-catalog>.yaml" ]] && continue
  kubectl apply -f "$f"
done
```

The renamed catalogs pull from the same registry images as the originals, so operator content is identical. New Subscriptions must reference the new names — older Subscriptions that pointed at the now-disabled defaults need to be edited to point at the `-custom` catalog or they will report `CatalogSource was removed`.

If the platform exposes no `disableAllDefaultSources` knob, the equivalent is to delete the broken CatalogSource entirely. The default-source reconciler will recreate it; loop the deletion via a small controller (or fix the upstream catalog) — that's why Option 1 is preferred when the catalog can be repaired.

## Diagnostic Steps

To understand why the resolver halted, look at the catalog-operator logs alongside the affected Subscription:

```bash
OLM_NS=cpaas-operators-system
kubectl -n "$OLM_NS" logs deploy/catalog-operator --tail=500 \
  | grep -E "failed to populate resolver cache|<sub-name>"
```

Lines like `failed to populate resolver cache from source <ns>/<catalog>` name the broken catalog directly.

To enumerate the health of every catalog at once:

```bash
kubectl get catalogsource -A \
  -o custom-columns=\
NS:.metadata.namespace,\
NAME:.metadata.name,\
STATE:.status.connectionState.lastObservedState,\
LAST:.status.connectionState.lastConnectTime
```

Anything not in `READY` state is the candidate. A long gap in `LAST` means the registry pod has not been reachable for a while.

To inspect what the registry pod is actually serving, port-forward and query its gRPC endpoint:

```bash
kubectl -n "$NS" port-forward svc/<catalog-source> 50051:50051 &
grpcurl -plaintext localhost:50051 list
```

A working catalog responds with `api.Registry`. A broken one returns `connection refused` or hangs — that is the same failure the resolver sees.

After applying the rename workaround, confirm new Subscriptions resolve:

```bash
kubectl -n cpaas-operators get subscription <sub-name> -o yaml \
  | yq '.status.conditions[] | {type,reason,message}'
```

A `Resolved` condition with `reason: AllCatalogSourcesHealthy` confirms the resolver saw only the renamed (healthy) catalogs and the broken one is no longer in its view.
