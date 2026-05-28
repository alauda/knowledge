---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500376
---

# Changing a StorageClass fsType on ACP — Delete-and-Recreate Procedure

## Issue

On Alauda Container Platform (Kubernetes v1.34.5) the default cluster StorageClass is `topolvm-hdd` (provisioner `topolvm.cybozu.com`, `parameters."csi.storage.k8s.io/fstype": xfs`). Administrators occasionally need a different filesystem on newly provisioned PersistentVolumes — for example switching the value of `csi.storage.k8s.io/fstype` from `xfs` to another value supported by the CSI driver. A direct in-place edit of the existing StorageClass does not work: `storage.k8s.io/v1` admission rejects updates to `parameters`, `provisioner`, `reclaimPolicy`, and `volumeBindingMode` on an existing StorageClass object, with the apiserver returning `parameters: Forbidden: updates to parameters are forbidden` on attempted patches.

## Root Cause

The `storage.k8s.io/v1` StorageClass strategy treats provisioner-shaped fields as immutable after creation. A server-side dry-run patch against `topolvm-hdd.parameters` fails at strategy-level admission with `parameters: Forbidden: updates to parameters are forbidden`; the same admission rule covers `provisioner` and `reclaimPolicy` (both rejected as `Forbidden`) and `volumeBindingMode` (rejected as `field is immutable`). Because UPDATE on `parameters` is forbidden, the only available path to a new `fsType` value is to delete the existing StorageClass object and recreate it with the desired parameters.

## Resolution

Replace the StorageClass by backing up its YAML, editing the parameters in the backup, deleting the live object, and recreating it from the edited manifest. The procedure is safe to apply to user-authored StorageClasses; on ACP the default `topolvm-hdd` SC carries no `ownerReferences` and is annotated `cpaas.io/creator=kubernetes-admin`, indicating it is plain admin-authored and not reconciled by an operator.

Existing PersistentVolumes already bound from the old StorageClass are not affected by this operation. A PV carries its CSI parameters as resolved at provisioning time — for `topolvm-hdd` the PV materializes `spec.csi.fsType: xfs` and `spec.persistentVolumeReclaimPolicy: Delete`, copied from the StorageClass parameters at the moment the PVC was bound. `spec.storageClassName` on the PV is a name reference only, not a live link, so the PV continues to function with its original filesystem after the StorageClass is deleted and recreated.

PVCs that bind after the StorageClass has been recreated will be re-resolved against the new `parameters` values. A newly bound PV will carry `spec.csi.fsType` set from whatever the recreated StorageClass declares at that moment, so changing `csi.storage.k8s.io/fstype` in the recreated manifest yields the new filesystem on subsequently provisioned volumes.

Procedure for changing the `fsType` parameter on a user-authored StorageClass:

```bash
# 1. Back up the StorageClass YAML, stripping volatile metadata.
kubectl get storageclass topolvm-hdd -o yaml \
 | grep -v -E '^\s*(creationTimestamp|resourceVersion|uid|generation|managedFields):' \
 > topolvm-hdd.yaml
```

```bash
# 2. Edit the backup. Update the relevant parameter, for example:
#    parameters:
#      csi.storage.k8s.io/fstype: <new-fstype>
${EDITOR:-vi} topolvm-hdd.yaml
```

```bash
# 3. Delete the live StorageClass object.
kubectl delete storageclass topolvm-hdd
```

```bash
# 4. Recreate it from the edited manifest.
kubectl apply -f topolvm-hdd.yaml
```

The StorageClass API on ACP is the upstream `storage.k8s.io/v1` resource with no ACP-specific wrapper CRD, so standard `kubectl get`, `delete`, and `create`/`apply` against `storageclass` work directly.

Restrict this procedure to StorageClasses that are manually authored. If a StorageClass is reconciled by a CSI driver operator — for instance, an SC owned by an `acp-storage-operator` or `local-storage-operator` reconciler in the platform catalog — manual `parameters` changes can be reverted on the operator's next reconcile loop. Inspect `metadata.ownerReferences` and creator annotations before changing parameters; the absence of `ownerReferences` (as on the default `topolvm-hdd`) is the marker that delete-and-recreate is safe.

## Diagnostic Steps

Confirm StorageClass immutability before attempting the procedure, using a server-side dry-run patch:

```bash
kubectl patch storageclass topolvm-hdd \
 --type merge \
 --dry-run=server \
 -p '{"parameters":{"csi.storage.k8s.io/fstype":"<new-fstype>"}}'
```

A failure with `parameters: Forbidden: updates to parameters are forbidden` confirms the field is immutable at the API strategy level and that delete-and-recreate is the required path.

Check that the target StorageClass is not operator-reconciled before deleting it:

```bash
kubectl get storageclass topolvm-hdd \
 -o jsonpath='{.metadata.ownerReferences}{"\n"}{.metadata.annotations}{"\n"}'
```

An empty `ownerReferences` and a creator annotation such as `cpaas.io/creator=kubernetes-admin` indicate the StorageClass is admin-authored and not reconciled by an operator, which is the safety condition for delete-and-recreate.

Verify that existing PVs survive the operation and continue to carry their original parameters:

```bash
kubectl get pv -o custom-columns=\
NAME:.metadata.name,SC:.spec.storageClassName,FSTYPE:.spec.csi.fsType,RECLAIM:.spec.persistentVolumeReclaimPolicy
```

After recreating the StorageClass with the new parameters, provision a fresh PVC and inspect the resulting PV; its `spec.csi.fsType` should reflect the new parameter value, while PVs created before the change retain their original `spec.csi.fsType`.
