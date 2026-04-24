---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After upgrading the in-cluster service-mesh control plane to a newer minor (for example a 2.6-class release), the Kiali observability pod stops coming back up and stays in crashloop. The container log fixates on a single line:

```text
W ... reflector.go:547] istio.io/client-go/.../factory.gen.go:142:
   failed to list *v1.VirtualService: the server could not find the
   requested resource (get virtualservices.networking.istio.io)
```

That message comes from a Kiali informer trying to call an Istio resource version that the cluster does not expose, so every reconcile crashes during reflector initialisation and the pod goes back to `CrashLoopBackOff`.

## Root Cause

Kiali talks to the Istio control plane through Istio's typed client. Each Kiali release pins the Istio API surface it expects to find — for example a Kiali built against Istio 1.21+ assumes the new generation of `networking.istio.io` resources is available. If the underlying mesh is on an older Istio release that does not yet ship those resources (or the mesh control plane is still mid-upgrade), Kiali's informer cannot list the type and fails fast.

A common way to land in this state:

1. The Service Mesh control plane is upgraded by editing the mesh control-plane CR.
2. The Kiali resource was created independently (not declared *inside* the mesh control-plane CR) and its `spec.version` was left at the default.
3. The Kiali operator's "default" tracks the latest published Kiali, which has already moved past the Istio version the mesh ships.
4. The result is a Kiali release that is **newer than the mesh**, asking for APIs the mesh has not added yet.

The supported lifecycle is the opposite: the mesh decides which Kiali release is compatible, and the Kiali resource follows. When Kiali is declared inside the mesh control-plane CR, the operator picks a version that matches the mesh's Istio major/minor automatically.

## Resolution

### Preferred: ACP Service Mesh Surface

In ACP the **Service Mesh** capability (`docs/en/service_mesh/`, both v1 and v2 variants based on Istio) treats Kiali as part of the mesh control-plane lifecycle. Declare Kiali through the Service Mesh control-plane resource instead of as a standalone object — the controller then pins Kiali to a release matched to the mesh's Istio version, and an `upgrade` of the mesh moves Kiali atomically alongside it. That removes the version-skew window entirely.

### Underlying Mechanics

For environments that already have a standalone Kiali in `CrashLoopBackOff`, pin the Kiali version to one compatible with the running Istio control plane and let the operator reconcile:

1. Identify the mesh's Istio version:

   ```bash
   kubectl -n <mesh-namespace> get smcp -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.chartVersion}{"\t"}{.status.appliedVersion}{"\n"}{end}'
   ```

2. Edit the standalone Kiali resource and set `spec.version` explicitly to a Kiali release that the mesh's Istio supports (consult the mesh control-plane release notes for the matrix):

   ```bash
   kubectl -n <mesh-namespace> edit kiali
   ```

   ```yaml
   spec:
     version: v1.73   # example — match to the mesh's Istio compatibility table
   ```

3. The Kiali operator detects the version change, downgrades (or upgrades) the deployment, and the new pod restarts the informer against the API surface that actually exists on the cluster:

   ```bash
   kubectl -n <mesh-namespace> get pod -l app=kiali -w
   ```

4. Once the pod is `Running`, fold the Kiali declaration **into** the mesh control-plane resource so the next mesh upgrade carries Kiali along automatically. The standalone Kiali resource can then be removed or marked as managed by the mesh CR.

A pragmatic shortcut is to *not* defend the standalone Kiali at all: delete it, declare Kiali inside the mesh control-plane resource, and let the operator install the compatible Kiali release.

## Diagnostic Steps

Confirm which Istio resources the cluster actually exposes — this is the source of truth that Kiali queries against:

```bash
kubectl api-resources --api-group=networking.istio.io
kubectl api-resources --api-group=security.istio.io
```

The output lists every group/version the API server serves. A Kiali pod whose log claims `the server could not find the requested resource` for a type that *does* appear here is talking to the wrong API server (kubeconfig issue); a Kiali whose missing type does **not** appear here is suffering version skew — apply the resolution above.

Inspect the operator's reconcile decision when the version field is changed:

```bash
kubectl -n <kiali-operator-namespace> logs -l app.kubernetes.io/name=kiali-operator --tail=200 \
  | grep -E 'reconcile|version|deploy'
```

Validate the live pod against the requested version:

```bash
kubectl -n <mesh-namespace> get pod -l app=kiali \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
```

If the pod still references the old image after the edit, the operator did not pick up the change — look for an `Unmanaged` annotation on the Kiali resource, or a webhook that is rejecting the new spec.
