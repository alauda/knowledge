---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VolumeSnapshotContent stuck deleting due to missing CSI deletion-secret annotations

## Issue

On Alauda Container Platform (Kubernetes server `v1.34.5-1`) with the snapshot module plugin installed, a large number of `VolumeSnapshot` and `VolumeSnapshotContent` objects created by third-party backup tooling can accumulate stuck in a deleting state when the backing CSI driver requires a secret to authenticate `DeleteSnapshot` against the backend storage array. On the cluster the snapshot module plugin provides the `volumesnapshots`, `volumesnapshotcontents` and `volumesnapshotclasses` CRDs under `snapshot.storage.k8s.io/v1` and runs the upstream `snapshot-controller` (image `snapshot-controller:v8.5.0-bea122af`) as a `Deployment` in the `cpaas-system` namespace.

## Root cause

The `snapshot-controller` is the component that drives `DeleteSnapshot` against the CSI driver via the `csi-snapshotter` sidecar. To delete a snapshot on a backend storage array that requires authentication, the sidecar must know which `Secret` carries the credentials, and it learns this from per-`VolumeSnapshotContent` annotations. When a `VolumeSnapshot` is created through the controller against a `VolumeSnapshotClass` whose `.parameters` declare `csi.storage.k8s.io/snapshotter-secret-name` and `csi.storage.k8s.io/snapshotter-secret-namespace`, those values are propagated by the controller onto the dynamically provisioned `VolumeSnapshotContent` as the `snapshot.storage.kubernetes.io/deletion-secret-name` and `snapshot.storage.kubernetes.io/deletion-secret-namespace` annotations.

When a third-party application creates static `VolumeSnapshotContent` objects directly against the API and bypasses the controller's dynamic-provisioning path, the deletion-secret annotations are not injected automatically. Each dynamically provisioned `VolumeSnapshotContent` carries the `snapshot.storage.kubernetes.io/volumesnapshotcontent-bound-protection` finalizer that the `snapshot-controller` places on it; that finalizer holds the object in the API until `DeleteSnapshot` succeeds. While the backing `VolumeSnapshot` is being deleted, the controller stamps the annotation `snapshot.storage.kubernetes.io/volumesnapshot-being-deleted: "yes"` onto the `VolumeSnapshotContent` and then attempts the CSI `DeleteSnapshot`. If the deletion-secret annotations are absent, the CSI driver has no credentials to authenticate to the backend array, `DeleteSnapshot` fails, and the controller retries — the `bound-protection` finalizer keeps the object present and the loop repeats.

## Diagnostic Steps

Confirm that the snapshot CRDs and controller are present on the cluster — these are supplied by the snapshot module plugin and the controller's `Deployment` lives in `cpaas-system`:

```bash
kubectl get crd volumesnapshotcontents.snapshot.storage.k8s.io \
  volumesnapshots.snapshot.storage.k8s.io \
  volumesnapshotclasses.snapshot.storage.k8s.io
kubectl -n cpaas-system get deploy snapshot-controller
```

Identify a stuck `VolumeSnapshotContent` by combining the deletion signal with the absence of the secret annotations under `metadata.annotations`. A stuck object carries `metadata.deletionTimestamp` set and the controller-applied `snapshot.storage.kubernetes.io/volumesnapshot-being-deleted: "yes"` annotation, but lacks `snapshot.storage.kubernetes.io/deletion-secret-name` and `snapshot.storage.kubernetes.io/deletion-secret-namespace`; the `snapshot.storage.kubernetes.io/volumesnapshotcontent-bound-protection` finalizer is still listed under `metadata.finalizers`, which is what keeps the object in the API:

```bash
kubectl get volumesnapshotcontent <name> -o yaml
```

The expected metadata shape on a stuck object looks like the following (only the load-bearing fields shown):

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: <name>
  deletionTimestamp: "<timestamp>"
  finalizers:
  - snapshot.storage.kubernetes.io/volumesnapshotcontent-bound-protection
  annotations:
    snapshot.storage.kubernetes.io/volumesnapshot-being-deleted: "yes"
    # deletion-secret-name / deletion-secret-namespace MISSING
```

## Resolution

The lasting fix is for the third-party orchestrator that creates the static `VolumeSnapshotContent` objects to populate the `snapshot.storage.kubernetes.io/deletion-secret-name` and `snapshot.storage.kubernetes.io/deletion-secret-namespace` annotations on each object at creation time, matching the secret the backing CSI driver expects.

To unblock the existing stuck objects in the meantime, manually annotate each pending `VolumeSnapshotContent` with the deletion-secret coordinates so the CSI driver can authenticate to the backend on the next retry. First identify the secret the driver expects — it is configured on the `VolumeSnapshotClass` under `.parameters` as `csi.storage.k8s.io/snapshotter-secret-name` and `csi.storage.k8s.io/snapshotter-secret-namespace`:

```bash
kubectl get volumesnapshotclass <class-name> -o yaml
```

Then apply the matching deletion-secret annotations to a single stuck `VolumeSnapshotContent` to verify the path before fanning out:

```bash
kubectl annotate volumesnapshotcontent <name> \
  snapshot.storage.kubernetes.io/deletion-secret-name=<secret-name> \
  snapshot.storage.kubernetes.io/deletion-secret-namespace=<secret-namespace> \
  --overwrite
```

Watch the same `VolumeSnapshotContent` afterwards — once the `snapshot-controller` re-drives `DeleteSnapshot` with credentials available, the CSI deletion succeeds, the controller clears the `bound-protection` finalizer, and the object is removed:

```bash
kubectl get volumesnapshotcontent <name>
```
