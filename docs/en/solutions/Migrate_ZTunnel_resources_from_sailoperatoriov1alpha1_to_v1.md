---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Creating or applying a `ZTunnel` resource for Istio Ambient mode emits a
deprecation warning:

```text
Warning: sailoperator.io/v1alpha1 ZTunnel is deprecated;
use sailoperator.io/v1 ZTunnel
```

Existing ZTunnel manifests still apply (the alpha API is served alongside
the GA one for a transition period), but the warning will become a hard
removal once the alpha is dropped — at which point the apply fails and the
Ambient data plane stops being reconciled.

## Root Cause

The Sail Operator (the GA-track operator that succeeds the older
istio-operator for Ambient-mode Istio) initially exposed ZTunnel as
`sailoperator.io/v1alpha1`. With ZTunnel reaching general availability the
operator promoted the type to `sailoperator.io/v1`. Both versions are
served simultaneously during the deprecation window; the alpha will be
removed in a future operator release.

Resources still keyed on `apiVersion: sailoperator.io/v1alpha1` continue to
work today thanks to API conversion, but they generate the deprecation
warning every time they are read or written, and they will fail outright
once the alpha API is no longer served.

## Resolution

Update every ZTunnel manifest the cluster references to use the GA API
version:

```yaml
apiVersion: sailoperator.io/v1
kind: ZTunnel
metadata:
  name: ztunnel
  namespace: istio-system
spec:
  version: v1.20.0
```

Re-apply with `kubectl apply -f` (or via your GitOps pipeline). The Sail
Operator reconciles in place; the existing Ambient data plane is unaffected
because the underlying CRD storage and the running ZTunnel pods were
already on the same shape.

For any source-controlled manifests, do a single sweep:

```bash
grep -RIn "sailoperator.io/v1alpha1" .
```

For each hit that names `kind: ZTunnel`, change the `apiVersion` line to
`sailoperator.io/v1`. Other Sail Operator types follow their own
deprecation timelines — promote them only after consulting the operator's
release notes for the version installed on the cluster.

## Diagnostic Steps

1. Confirm the operator version the cluster runs (the API version available
   depends on the operator release):

   ```bash
   kubectl get csv -n <service-mesh-operator-ns> | grep -i sail
   ```

2. List the API versions currently served for ZTunnel:

   ```bash
   kubectl api-resources | grep -i ztunnel
   # NAME       APIVERSION             NAMESPACED   KIND
   # ztunnels   sailoperator.io/v1     false        ZTunnel
   ```

   If both `v1alpha1` and `v1` are served, the alpha is still callable but
   marked deprecated. Once only `v1` is listed, alpha applies will fail.

3. Find any persisted alpha ZTunnel resources in-cluster:

   ```bash
   kubectl get ztunnel -A -o yaml | yq '.items[].apiVersion' | sort -u
   ```

   Any `sailoperator.io/v1alpha1` line is a candidate to migrate. Re-apply
   each one with the updated `apiVersion`.

4. Confirm the deprecation warning is gone after the migration. Re-apply or
   re-edit the resource:

   ```bash
   kubectl apply -f ztunnel.yaml
   # no "Warning: sailoperator.io/v1alpha1 ZTunnel is deprecated" line
   ```

5. Validate the Ambient data plane still works end-to-end with a sample
   `kubectl exec` from a workload pod into a peer service in another
   namespace; ZTunnel propagates traffic between them transparently when
   reconciled correctly.
