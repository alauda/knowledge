---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500163
---

# Moving PVs and PVCs between StorageClasses on ACP

## Issue

On Alauda Container Platform (kube-apiserver v1.34.5; cluster default StorageClass `topolvm-hdd`, provisioner `topolvm.cybozu.com`), an existing PersistentVolumeClaim or PersistentVolume cannot be repointed to a different StorageClass by editing the live object. The StorageClass-derived configuration is baked into the claim and the bound volume at creation time and stays fixed for the lifetime of the object.

## Root Cause

The kube-apiserver enforces immutability of `PersistentVolumeClaim.spec` after the claim is bound. An attempt to change `spec.storageClassName` on a bound PVC — for example a `kubectl patch` that swaps `topolvm-hdd` for any other class — is rejected with the literal validation error `spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`. The validator's allow-list of fields that may still be edited on a bound claim contains only `resources.requests` and `volumeAttributesClassName`; `storageClassName` is not in that list.

On the PersistentVolume side, the API server does not block a write to `PV.spec.storageClassName` — a server-side dry-run patch returns the object as `patched` with no Forbidden response. That apparent mutability is misleading: a real PV does not relocate its data by changing the label. The PV's `spec.csi` block (driver name, `volumeHandle`, provisioning parameters) and the underlying LVM volume on the node remain owned by `topolvm.cybozu.com`, the provisioner that originally created the PV. Relabelling the StorageClass on the PV does not re-parameterise or migrate the volume; it only rewrites the label.

## Resolution

Treat a "move between StorageClasses" as a *copy* workflow, not an in-place edit. Provision a new PVC against the target StorageClass, mount both the old and the new PVC into a helper pod, and migrate the data into the new claim with a generic file-copy mechanism inside that pod (e.g. `rsync` or `tar`); then repoint application workloads at the new PVC and retire the old one. The original PVC and its bound PV are not in-place re-pointed and should be deleted after the copy is verified.

Copy from a quiescent source. `rsync` / `tar` walk the filesystem while it is live, so if the owning workload keeps writing during the copy the destination can capture a torn or inconsistent state — half-written files, or files that mutually disagree (a database and its write-ahead log, for example). Before starting the copy, scale the consuming workload to zero (or otherwise stop writes / enter a maintenance window) so the source PVC is at rest; for stateful systems that support it, take an application-consistent snapshot or use the application's own backup tool instead of a raw file copy. Verify the copied data before deleting the original PVC.

There exist edge cases where the API layer does not reject the change — for example, directly editing `PV.spec.storageClassName` — but those edits do not migrate the underlying provisioned volume and are outside the supported set of actions for moving storage between classes.

On a cluster whose only StorageClass is `topolvm-hdd` (provisioner `topolvm.cybozu.com`, reclaimPolicy `Delete`, volumeBindingMode `WaitForFirstConsumer`), the prerequisite step before any such workflow is to install a second StorageClass to migrate *into*. Of the platform PVCs surveyed on this ACP, all three are bound to `topolvm-hdd`; a "move to a different SC" workflow has no destination class until an administrator adds one.

## Diagnostic Steps

Confirm the rejection path on a bound PVC before assuming the patch is the right tool:

```bash
kubectl patch pvc <name> -n <ns> \
  --type merge \
  -p '{"spec":{"storageClassName":"<other-sc>"}}'
```

The apiserver replies with `The PersistentVolumeClaim "<name>" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`. The same admission rule applies to any update verb that targets `.spec.storageClassName` on a bound PVC; the demonstrated form here is `kubectl patch --type=merge`.

Verify that a `PV.spec.storageClassName` edit, even when the API accepts it, does not persist as a real move. A server-side dry-run is the safe probe:

```bash
kubectl patch pv <pv-name> \
  --type merge \
  -p '{"spec":{"storageClassName":"<other-sc>"}}' \
  --dry-run=server
```

The dry-run returns the object as `patched` with no Forbidden error, but a follow-up read confirms the live `spec.storageClassName` is still the original value, and the bound CSI driver and `volumeHandle` are unchanged:

```bash
kubectl get pv <pv-name> \
  -o jsonpath='{.spec.storageClassName}{"\n"}{.spec.csi.driver}{"\n"}{.spec.csi.volumeHandle}{"\n"}'
```

Enumerate the StorageClasses available on the cluster, and the PVCs already bound, to plan the copy workflow:

```bash
kubectl get storageclass
kubectl get pvc --all-namespaces \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,SC:.spec.storageClassName,STATUS:.status.phase
```

When the listing shows `topolvm-hdd` as the sole class, install the target StorageClass first; the migration workflow above has no destination class to provision the new PVC into until a second class exists.
