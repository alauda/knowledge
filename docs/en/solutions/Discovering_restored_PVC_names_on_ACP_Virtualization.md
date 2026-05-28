---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500382
---

# Discovering restored PVC names on ACP Virtualization

## Issue

On Alauda Container Platform with the `kubevirt-operator` bundle (plugin version `kubevirt v1.7.0-alauda.2`, upstream KubeVirt 1.17.0, installed in the `kubevirt` namespace on Kubernetes v1.34.5), a freshly created VirtualMachine's boot disk PVC name is predictable: `spec.template.spec.volumes[].dataVolume.name` on the VM CR names both the DataVolume and the PersistentVolumeClaim that backs it in the same namespace, so operators can locate the boot disk by reading the VM manifest. When the same workload is materialised back from a snapshot, the PVC name is no longer derived from that VM-facing field — the restore controller writes the resulting PVC reference into a separate status field on the restore CR, and locating the new PVC requires reading that status rather than guessing the name.

## Resolution

Read the boot disk PVC name from the VirtualMachine CR. The `kubevirt.io/v1` VirtualMachine schema's `spec.template.spec.volumes[].dataVolume.name` field carries the name of both the DataVolume and the PVC in the VM's namespace, so a single `kubectl get vm -o jsonpath` against that path returns the PVC name without further lookup:

```bash
kubectl get vm -n <vm-namespace> <vm-name> \
 -o jsonpath='{.spec.template.spec.volumes[*].dataVolume.name}'
```

After a restore from a VirtualMachineSnapshot, do not infer the PVC name — read it from the restore object. The `snapshot.kubevirt.io/v1beta1` VirtualMachineRestore CRD exposes `status.restores[].persistentVolumeClaim` (required field), where the restore controller records the materialised PVC name for each volume entry. Query the restore CR after it reports completion to obtain the authoritative PVC reference:

```bash
kubectl get virtualmachinerestore -n <vm-namespace> <restore-name> \
 -o jsonpath='{.status.restores[*].persistentVolumeClaim}'
```

The same `status.restores[]` array carries one entry per volume restored, so multi-disk VMs surface each PVC reference under its own index. Use this status field as the single source of truth for follow-up operations — mounting, backup, or attaching to a fresh VM — instead of constructing PVC names by hand from the source VM or DataVolume name.

For workflows that need a predictable PVC name up front rather than a post-hoc lookup, the VirtualMachineRestore `spec` accepts a `volumeRestoreOverrides` array — each entry pins `restoreName` to a chosen PVC name for the matching source `volumeName`, alongside optional `labels` and `annotations` on the resulting PVC. Declaring the override at restore creation time means `status.restores[].persistentVolumeClaim` reports the operator-chosen name rather than a controller-generated default, which lets downstream automation reference the PVC by a stable identifier:

```yaml
apiVersion: snapshot.kubevirt.io/v1beta1
kind: VirtualMachineRestore
spec:
  target:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: <vm-name>
  virtualMachineSnapshotName: <snapshot-name>
  volumeRestoreOverrides:
  - volumeName: <source-volume-name>
    restoreName: <desired-pvc-name>
```

## Diagnostic Steps

Confirm the plugin and CRD group/version that ship the restore controller before troubleshooting any restored-PVC discovery flow. On `installer-v4.3.0-online`, the `kubevirt-operator` bundle installs the `kubevirt.io/v1` VirtualMachine CRD and the `snapshot.kubevirt.io/v1beta1` VirtualMachineRestore CRD in the `kubevirt` namespace; verify both are present and Established before relying on restore status to surface PVC names:

```bash
kubectl get crd virtualmachines.kubevirt.io \
 virtualmachinerestores.snapshot.kubevirt.io \
 -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.versions[*].name}{"\n"}{end}'
```

If the VirtualMachineRestore CRD is absent, the snapshot/restore path is not installed and PVC discovery via `status.restores[].persistentVolumeClaim` is unavailable until the bundle that ships those CRDs is enabled.
