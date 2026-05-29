---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# KubeVirt VM storage migration leaves orphaned source PVCs on ACP

## Issue

On Alauda Container Platform, the KubeVirt control plane is installed in the `kubevirt` namespace, built from upstream KubeVirt `v1.7.0-alauda.2` (HCO operator `1.17.0`), with `HyperConverged/kubevirt-hyperconverged` in `Deployed` state. The `virtualmachines.kubevirt.io` CRD on ACP serves `v1` and `v1alpha3` and is upstream-verbatim, including the VM-level field `.spec.updateVolumesStrategy` (description: `UpdateVolumesStrategy is the strategy to apply on volumes updates`) that triggers a live storage migration when set to `Migration` together with a `claimName` change in `.spec.template.spec.volumes[]` to the new target PVCs.

After such a migration completes, the running VM's `.spec.template.spec.volumes[]` now references the freshly provisioned (migrated) PVCs — for example `claimName: <vm>-mig-<suffix>` instead of the original `claimName: <vm>-<original-suffix>` — and the VMI continues to run off those new PVCs without interruption. Operators then observe a doubled storage allocation on the backend: both the original PVCs and the migrated PVCs remain provisioned at the same time, and storage-array deduplication / compression dashboards do not show the expected drop in utilization.

## Root Cause

KubeVirt's VM storage migration mechanism — whether driven through the upstream-native `.spec.updateVolumesStrategy: Migration` field on `virtualmachines.kubevirt.io`, or through ACP's additional `migrations.kubevirt.io/v1alpha1` `VirtualMachineStorageMigrationPlan` / `VirtualMachineStorageMigration` CRD set reconciled by the `kubevirt-migration-controller` deployment in the `kubevirt` namespace — provisions a new PVC and re-points the live VMI's disks, but it does **not** automatically delete the source PVCs. The ACP-side `VirtualMachineStorageMigrationPlan` CRD has no `delete` / `reclaim` / `cleanup` / `deleteSource` / `keepSource` knob anywhere in its schema; its `status.completedMigrations[].sourcePVCs[]` only *tracks* the source PVCs by `{name, namespace, sourcePVC, volumeName}` and never issues a deletion.

Because the migration leaves the source PVCs untouched, those PVCs remain in `phase: Bound` to their original `PersistentVolume` objects long after the VM has switched to the new disks. From the cluster's point of view they are still in active use by a claim, so the binding holds. The default StorageClass on ACP is `topolvm-hdd` (provisioner `topolvm.cybozu.com`) with `RECLAIMPOLICY=Delete`, but `Delete` only fires when a PV transitions to `Released` — and a PV cannot become `Released` while a PVC still binds it. As a result the cluster ends up consuming capacity for both the source and the migrated PVCs simultaneously, which is the doubled-capacity symptom seen on the backend.

## Resolution

Confirm the VM's volume references have actually moved to the migrated PVCs, then delete the orphaned source PVCs to release their PV bindings. Once the source PVCs are gone, the `Delete` reclaim policy on a dynamically provisioned PV invokes the CSI driver's `DeleteVolume` RPC and the backend allocation is freed, restoring the expected non-doubled utilization on the storage array.

Before deleting anything, verify that the source PVC names no longer appear in `.spec.template.spec.volumes[].persistentVolumeClaim.claimName` on the live VirtualMachine — if they are absent, deletion is safe and will not disrupt the running VMI:

```bash
kubectl -n <vm-namespace> get vm <vm-name> \
  -o jsonpath='{.spec.template.spec.volumes[*].persistentVolumeClaim.claimName}{"\n"}'
```

Once the output lists only the migrated `claimName`s (and not the original source PVCs), delete each orphaned source PVC. The PersistentVolumeClaim resource is core `v1` and is operated on with standard `kubectl` commands on ACP:

```bash
kubectl -n <vm-namespace> get pvc <source-pvc-name>
kubectl -n <vm-namespace> delete pvc <source-pvc-name>
```

After deletion, the bound PV transitions through `Released` and (with `persistentVolumeReclaimPolicy: Delete`, the default for dynamically provisioned PVs on `topolvm-hdd`) is removed by the CSI driver, which releases the backend allocation; storage-backend utilization then drops to the expected post-migration footprint.

## Diagnostic Steps

Inspect the current set of VM volume references to identify which PVCs the live VirtualMachine is actually using after a migration. Any PVC name listed here is in use; PVCs in the same namespace that are not listed are candidates for deletion:

```bash
kubectl -n <vm-namespace> get vm <vm-name> \
  -o jsonpath='{range .spec.template.spec.volumes[*]}{.name}{"\t"}{.persistentVolumeClaim.claimName}{"\n"}{end}'
```

List the PVCs in the VM's namespace and inspect their phase to confirm the orphaned source PVCs are still `Bound`. A `Bound` source PVC that is no longer referenced in the VM spec is the signature of the post-migration orphan state:

```bash
kubectl -n <vm-namespace> get pvc
kubectl -n <vm-namespace> get pvc <source-pvc-name> \
  -o jsonpath='{.status.phase}{"\n"}'
```

Cross-reference the bound PV's reclaim policy to predict what happens on PVC deletion. With `persistentVolumeReclaimPolicy: Delete` (the cluster-wide default for dynamically provisioned PVs on `topolvm-hdd`), deleting the PVC releases the PV and the CSI driver removes the backing volume; with `Retain`, the PV stays after PVC deletion and the operator must clean up manually:

```bash
kubectl get sc
kubectl get pv <pv-name> \
  -o jsonpath='{.spec.persistentVolumeReclaimPolicy}{"\n"}'
```

Confirm the storage-migration mechanism itself is running on the cluster — on ACP the `kubevirt-migration-controller` deployment in the `kubevirt` namespace reconciles the `migrations.kubevirt.io/v1alpha1` CRD set, and its presence confirms which surface (the upstream `.spec.updateVolumesStrategy` field on the VM or the ACP-specific `VirtualMachineStorageMigrationPlan` CR) is available to trigger storage migrations on this cluster:

```bash
kubectl -n kubevirt get deploy kubevirt-migration-controller
kubectl get crd | grep -E 'migrations.kubevirt.io|virtualmachinestoragemigration'
kubectl explain virtualmachine.spec.updateVolumesStrategy
```
