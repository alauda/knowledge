---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The Service Mesh v3 (Istio) must-gather flow gathers mesh-wide data — every namespace participating in the mesh — even when the operator is only interested in a single namespace's traffic, sidecar config, or policy state. This is by design: the bundled must-gather plugin is shaped for full-mesh diagnosis. For targeted diagnostics (one application's namespace, one tenant's CRs), the full collection is heavyweight and expensive to ship in a support case.

There is no namespace filter exposed by the must-gather image itself; scoping has to be done with the lower-level `kubectl inspect`-class flow that drives must-gather under the hood.

## Resolution

Use `kubectl inspect` directly, passing both the standard resource set (`all`) and an explicit comma-separated list of every Istio CRD. The CRD list is what makes the inspect collect mesh state from the namespace; without it, inspect collects only the standard core API objects.

### 1. Build the list of Istio CRDs

The mesh ships several CRDs whose group ends in `istio.io` (`gateway.networking.istio.io`, `security.istio.io`, `telemetry.istio.io`, `networking.istio.io`, etc.). Generate a CSV of all of them dynamically:

```bash
ISTIO_CRDS=$(kubectl get crd -o name \
  | grep istio.io \
  | cut -d/ -f2 \
  | tr '\n' ',' \
  | sed 's/,$//')
echo "$ISTIO_CRDS"
```

This avoids drift if a future mesh version adds or renames a CRD.

### 2. Inspect the target namespace

Pass both `all` (the standard Kubernetes resource group) and the CRD list to `kubectl inspect`, scoped to the namespace you care about:

```bash
TARGET_NS=istio-system           # or your workload's namespace
kubectl inspect "ns/$TARGET_NS" --all-namespaces=false \
  --types="all,${ISTIO_CRDS}" \
  --dest-dir=./scoped-mesh-bundle
```

(If your `kubectl inspect` does not accept `--types`, use the older signature `kubectl inspect ns/<ns> all,${ISTIO_CRDS}`. The shape of the call is the same: a target namespace and the resource list.)

The output bundle contains:

- All standard Kubernetes objects in the target namespace (Pods, Services, Deployments, ConfigMaps, Secrets metadata-only, etc.).
- Every Istio CR that lives in or references the target namespace (`VirtualService`, `DestinationRule`, `AuthorizationPolicy`, `PeerAuthentication`, `Gateway`, `Telemetry`, `EnvoyFilter`, etc.).
- Pod logs for the target namespace.

### 3. Add per-pod sidecar diagnostics if needed

`kubectl inspect` does not capture envoy admin endpoints. For sidecar-side state (clusters, listeners, routes, config dump), add explicit per-pod calls and append them to the bundle:

```bash
mkdir -p scoped-mesh-bundle/sidecar
for pod in $(kubectl -n "$TARGET_NS" get pod -l 'sidecar.istio.io/inject!=false' -o name | cut -d/ -f2); do
  for ep in clusters listeners routes config_dump certs; do
    kubectl -n "$TARGET_NS" exec "$pod" -c istio-proxy -- \
      curl -s "http://localhost:15000/$ep" \
      > "scoped-mesh-bundle/sidecar/${pod}.${ep}.json" 2>/dev/null
  done
done
```

This is the equivalent of what `istioctl proxy-config` produces, captured in machine-readable form.

### 4. Tar and ship

```bash
tar -czf scoped-mesh-bundle.tgz scoped-mesh-bundle/
```

The resulting tarball is typically one to two orders of magnitude smaller than a full-mesh must-gather, and contains only the namespace's mesh footprint plus its pod-level Envoy state — exactly what a per-namespace investigation needs.

## Diagnostic Steps

1. Confirm that the Service Mesh must-gather flag set does not in fact accept a namespace filter (so scoped collection has to bypass it):

   ```bash
   kubectl-must-gather --help | grep -iE 'namespace|scope' || echo "no scoping flag"
   ```

2. Run the full must-gather once on a small lab cluster to confirm the size delta is what you expect — it sets the baseline for the value of scoping in production:

   ```bash
   kubectl-must-gather --image=<istio-must-gather-image> --dest-dir=./full-mesh-bundle
   du -sh ./full-mesh-bundle
   ```

3. Confirm the CRD list is complete in your cluster — any newly-added Istio CRD should appear here:

   ```bash
   kubectl get crd -o name | grep istio.io
   ```

4. After the scoped collection, sanity-check that the bundle contains the namespace's `VirtualService` / `DestinationRule` / `AuthorizationPolicy` files:

   ```bash
   find ./scoped-mesh-bundle -name '*.yaml' \
     | xargs grep -l "namespace: $TARGET_NS" | head
   ```
