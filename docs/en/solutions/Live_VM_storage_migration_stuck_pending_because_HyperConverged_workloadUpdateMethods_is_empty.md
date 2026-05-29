---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Live VM storage migration stuck pending because HyperConverged workloadUpdateMethods is empty

## Issue

On Alauda Container Platform (Kubernetes server `v1.34.5-1`) with the virtualization operator installed (KubeVirt operator `v1.7.0-alauda.1-dirty`, HCO operator `1.17.0`), a live storage migration of a running virtual machine never starts. The `VirtualMachine` and `VirtualMachineInstance` specs have been rewritten to reference the new `PersistentVolumeClaim`, but the running VMI continues to use the old PVC and no `VirtualMachineInstanceMigration` (VMIM) appears for the target VMI.

On this platform the operator installs the `HyperConverged` CR `kubevirt-hyperconverged` into the namespace `kubevirt`, and the live-migration primitive is `virtualmachineinstancemigrations.kubevirt.io/v1` (`spec.vmiName` targets the VMI to migrate, and the VMIM must be created in the VMI's namespace).

## Root cause

Live storage migration of a running VM relies on KubeVirt's live-migration mechanism to transition the running VMI from the old PVC to the new PVC; without a `VirtualMachineInstanceMigration` object the VMI cannot be migrated and the orchestration that depends on it cannot progress.

The `HyperConverged` CR exposes `spec.workloadUpdateStrategy.workloadUpdateMethods` — a `[]string` with documented members `LiveMigrate` and `Evict`. The CRD description states verbatim: *"An empty list defaults to no automated workload updating"*. The HCO operator propagates `spec.workloadUpdateStrategy` from the `HyperConverged` CR down to the underlying `KubeVirt` CR, and the `virt-controller` workload-updater watches `KubeVirt.spec.workloadUpdateStrategy.workloadUpdateMethods` to decide whether it is authorised to dispatch an automated migration in response to a workload-shape change (a PVC reference change is one such trigger).

When `workloadUpdateMethods` is set to `[]` on the `HyperConverged` CR, the propagated `KubeVirt` CR `spec.workloadUpdateStrategy` ends up with **no** `workloadUpdateMethods` key at all — the empty list is dropped on the way down. With no method to dispatch, the workload-updater leaves `status.outdatedVirtualMachineInstanceWorkloads` at `0` and never creates a `VirtualMachineInstanceMigration` for the affected VMI. The spec change made by the higher-level migration controller is recorded, but no live migration is triggered and the migration stays Pending.

## Diagnostic Steps

Confirm the `HyperConverged` CR is reachable in the `kubevirt` namespace:

```bash
kubectl get hyperconverged -A
```

Inspect the `HyperConverged` CR's `workloadUpdateStrategy`. An empty `workloadUpdateMethods` list is the failure condition for this issue:

```bash
kubectl get hyperconverged kubevirt-hyperconverged -n kubevirt \
  -o jsonpath='{.spec.workloadUpdateStrategy}'
```

Expected failure output (note the empty list):

```text
{"batchEvictionInterval":"1m0s","batchEvictionSize":10,"workloadUpdateMethods":[]}
```

Confirm the propagated value on the `KubeVirt` CR — this is the field the `virt-controller` workload-updater actually reads. When the `HyperConverged` value is `[]`, the `workloadUpdateMethods` key is absent here:

```bash
kubectl get kubevirt -n kubevirt \
  -o jsonpath='{.items[0].spec.workloadUpdateStrategy}'
```

Confirm that no `VirtualMachineInstanceMigration` has been created for the affected VMI in its namespace:

```bash
kubectl get vmim -n <vmi-namespace>
```

A second corroborating signal is the workload-updater queue being empty even though a VMI's referenced PVC was rewritten — `status.outdatedVirtualMachineInstanceWorkloads` on the `KubeVirt` CR stays at `0`:

```bash
kubectl get kubevirt -n kubevirt \
  -o jsonpath='{.items[0].status.outdatedVirtualMachineInstanceWorkloads}'
```

## Resolution

Patch the `HyperConverged` CR to set `spec.workloadUpdateStrategy.workloadUpdateMethods` to `["LiveMigrate"]`. With at least one method present, the propagated `KubeVirt` CR re-acquires the field, the workload-updater becomes authorised to dispatch automated migrations, and it creates the `VirtualMachineInstanceMigration` object the stuck migration needs:

```bash
kubectl patch hyperconverged kubevirt-hyperconverged -n kubevirt \
  --type merge \
  -p '{"spec":{"workloadUpdateStrategy":{"workloadUpdateMethods":["LiveMigrate"]}}}'
```

Verify the propagation made it to the `KubeVirt` CR — the field must reappear here for the workload-updater to act:

```bash
kubectl get hyperconverged kubevirt-hyperconverged -n kubevirt \
  -o jsonpath='{.spec.workloadUpdateStrategy}'
kubectl get kubevirt -n kubevirt \
  -o jsonpath='{.items[0].spec.workloadUpdateStrategy}'
```

Watch the namespace where the stuck VMI lives — a `VirtualMachineInstanceMigration` should appear automatically and progress `Pending` → `Scheduling` → `Running` → `Succeeded`. If the workload is genuinely live-migratable (its `VirtualMachineInstance` reports `status.conditions[type=LiveMigratable].status=True`) the migration will complete; if it is not live-migratable, the workload-updater will skip it under the `LiveMigrate` method:

```bash
kubectl get vmim -n <vmi-namespace> -w
```
