---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Storage-Class Migration of a Running VM Hangs at DirectVolume When workloadUpdateMethods Is Empty
## Issue

A storage-class migration that moves a running VM's data to a new StorageClass hangs indefinitely in the DirectVolume phase. The migration controller (Migration Toolkit for Containers / Konveyor-style `MigMigration`) reports that the VM's live migration is `Pending`, and no `VirtualMachineInstanceMigration` (VMIM) object is ever created:

```text
- message: Running Rsync Pods to migrate Persistent Volume data
  name: DirectVolume
  phase: WaitForDirectVolumeMigrationToComplete
  progress:
    - 1 total volumes; 0 successful; 0 running; 0 failed
    - '[test-vm-vm-<suffix>] Live Migration vms/test-vm: Pending'
  started: "2026-03-11T11:45:47Z"
```

This is a KubeVirt-layer problem; the same behaviour applies on any ACP Virtualization cluster that fronts KubeVirt, regardless of whether the higher-level migration is driven by the upstream Konveyor toolkit or by the ACP workflow for moving VM storage between StorageClasses.

## Root Cause

Storage-class migration for a *running* VM cannot detach and reattach the disk in place — the VM is using it. The pipeline instead relies on KubeVirt's **live migration** to move the VMI from a virt-launcher pod that mounts the old PVC to one that mounts the new (rsync-populated) PVC. That handoff is triggered by a spec change on the VM / VMI that references the new PVC.

Whether KubeVirt reacts to that spec change with an automatic live migration is gated by the `workloadUpdateStrategy.workloadUpdateMethods` field on the HyperConverged / KubeVirt operator's custom resource. The virt-controller's workload-updater explicitly skips creating a `VirtualMachineInstanceMigration` object when this list is empty:

```yaml
spec:
  workloadUpdateStrategy:
    batchEvictionInterval: 1m0s
    batchEvictionSize: 10
    workloadUpdateMethods: []        # <- empty, automatic migration disabled
```

With the list empty, the VM's spec is updated to point at the new PVC, but the running VMI stays pinned to the old one — forever. The migration controller sees "spec changed, waiting for VMI to follow" and parks the `DirectVolume` step in `WaitForDirectVolumeMigrationToComplete`.

## Resolution

Enable `LiveMigrate` in the KubeVirt / HyperConverged workload update strategy, then let the migration controller retry.

### 1. Patch the KubeVirt operator CR to permit live-migrate workload updates

The KubeVirt operator CR (exposed on an ACP Virtualization cluster under the namespace that installs the virt operator — commonly `cpaas-system` or the dedicated virt namespace; the field and schema are identical to upstream KubeVirt HCO):

```bash
# Inspect the current value (adjust namespace/name to match the cluster)
kubectl -n <virt-operator-ns> get hyperconverged kubevirt-hyperconverged \
  -o yaml | yq '.spec.workloadUpdateStrategy'
```

Add `LiveMigrate` to the list:

```bash
kubectl -n <virt-operator-ns> patch hyperconverged kubevirt-hyperconverged \
  --type merge \
  -p '{"spec":{"workloadUpdateStrategy":{"workloadUpdateMethods":["LiveMigrate"]}}}'
```

If the cluster is already running a mix of migratable and non-migratable workloads, `LiveMigrate` is the safe choice: it will only update workloads that pass KubeVirt's migratability checks, and leave the rest in place. `Evict` is the harder option and is not needed for storage-class migration.

### 2. Nudge the migration controller to retry

Once the workload-updater is allowed to issue live migrations, the virt-controller should react automatically to the outstanding spec change and create the VMIM. Verify:

```bash
# The VMIM object should now exist for the VM being migrated
kubectl -n <vm-namespace> get vmim

# The parent MigMigration / migration CR should leave WaitForDirectVolumeMigrationToComplete
kubectl -n <mig-namespace> get migmigration <mig-name> \
  -o yaml | yq '.status.phase, .status.conditions'
```

If the virt-controller still does not create the VMIM within a few minutes, bounce it so it re-reconciles the pending workload updates:

```bash
kubectl -n <virt-operator-ns> rollout restart deploy/virt-controller
```

### 3. (Optional) Leave LiveMigrate enabled or revert

`LiveMigrate` as a workload update method is the KubeVirt-recommended setting for clusters that run long-lived VMs. It lets the operator transparently migrate workloads during control-plane upgrades or KubeVirt version bumps, which is also what storage migration depends on. Unless there is an environment-specific reason to keep it empty, leave the patch in place after the storage migration finishes.

## Diagnostic Steps

Before patching, confirm the failure really is the workload-updater and not, for example, a VM that is genuinely non-migratable (a node selector that pins it, a pod disruption budget that blocks eviction, a non-shared storage topology).

1. Check that MTC did rewrite the VM and VMI to reference the new PVC. Both should list the same new claim name.

   ```bash
   kubectl -n <vm-namespace> get vm test-vm \
     -o yaml | yq '.spec.template.spec.volumes'
   kubectl -n <vm-namespace> get vmi test-vm \
     -o yaml | yq '.spec.volumes'
   ```

   If the two disagree (VM points at the new PVC, VMI still at the old), the spec update landed on the VM but the VMI never caught up — exactly the signature of a missing live migration.

2. Confirm no VMIM exists:

   ```bash
   kubectl -n <vm-namespace> get vmim
   ```

   Empty output, together with a "Pending" note in the migration status, narrows the cause to the workload-updater gate rather than a failed migration attempt.

3. Inspect `workloadUpdateMethods`:

   ```bash
   kubectl -n <virt-operator-ns> get hyperconverged kubevirt-hyperconverged \
     -o yaml | yq '.spec.workloadUpdateStrategy.workloadUpdateMethods'
   ```

   An empty list (`[]`) is the root cause. A populated list that contains `LiveMigrate` but the VMIM is still not being created points at a different problem — investigate virt-controller logs for the specific reject reason.

4. After the patch, verify the migration completes:

   ```bash
   kubectl -n <vm-namespace> get vmim -w
   kubectl -n <vm-namespace> get vmi test-vm -o yaml \
     | yq '.status.migrationState'
   ```

   The VMIM transitions through `Pending → Scheduling → Running → Succeeded`, and the VMI's `migrationState.completed` flips to `true` once it lands on the new PVC.
