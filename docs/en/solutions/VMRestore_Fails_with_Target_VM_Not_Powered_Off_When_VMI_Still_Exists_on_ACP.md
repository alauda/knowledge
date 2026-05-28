---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500361
---

# VMRestore Fails with "Target VM Not Powered Off" When VMI Still Exists on ACP

## Issue

On Alauda Container Platform with the KubeVirt operator bundle installed (image `build-harbor.alauda.cn/3rdparty/kubevirt/virt-controller:v1.7.0-alauda.2`, HCO CSV `kubevirt-hyperconverged-operator.v4.3.5`, namespace `kubevirt`), a `VirtualMachineRestore` CR (`snapshot.kubevirt.io/v1beta1`, namespaced) created to restore a VM from a `VirtualMachineSnapshot` may stall and surface a `Progressing=False` condition on its `status.conditions` whose `reason` / `message` text states that the restore target failed to be ready within five minutes and asks for the target VM to be powered off before attempting restore.

The `VirtualMachineRestore` CRD is installed by the KubeVirt operator (labels `app.kubernetes.io/managed-by=virt-operator`, `app.kubernetes.io/version=1.17.0`, plus annotation `kubevirt.io/install-strategy-version=v1.7.0-alauda.2`); the `v1beta1` group/version is the storage version while `v1alpha1` is still served for compatibility.

## Root Cause

The KubeVirt restore controller decides whether the target VM is powered off by checking the cluster for the existence of a corresponding `VirtualMachineInstance` (VMI) object, not by reading any rendered status field outside the API. As long as a VMI for the target VM is present in the namespace, the restore precondition is treated as unsatisfied and reconciliation refuses to proceed regardless of what the parent `VirtualMachine` reports.

The authoritative VM lifecycle state on ACP is read directly from the API: `VirtualMachine.status.printableStatus` on the parent CR (values such as `Starting` or `ImagePullBackOff` are surfaced verbatim there) together with the presence or absence of the `VirtualMachineInstance` namespaced object. A VMI may linger in the namespace after a failed stop request — the parent `VirtualMachine` may already show a stopped intent while the VMI object remains — and that lingering VMI alone is enough to keep the restore controller in its "target not powered off" branch.

## Resolution

Delete the lingering `VirtualMachineInstance` directly. VMIs are namespaced resources reachable through `kubectl`, and deleting the VMI tears down the underlying virt-launcher pod (whose lifecycle is owned by the VMI), which force-stops the VM and clears the restore precondition.

```bash
# Identify the lingering VMI for the target VM
kubectl get vmi -n <namespace>

# Force-stop by deleting the VMI; the owning virt-launcher pod terminates with it
kubectl delete vmi <vm-name> -n <namespace>
```

After the VMI is gone, the `VirtualMachineRestore` controller's existence check for the target VMI returns empty on the next reconcile and the restore precondition (no active VMI for the target VM) is satisfied.

## Diagnostic Steps

Read the failed restore's condition block to confirm the failure mode — the `Progressing=False` condition with the timeout / "power off the target VM" reason/message text is the signature of this precondition check; other failure modes on the same `status.conditions` slice will emit different reason strings:

```bash
kubectl get vmrestore -n <namespace> <restore-name> -o yaml
```

Check VM and VMI ground truth via the API rather than relying on any rendered view. `VirtualMachine.status.printableStatus` carries the authoritative lifecycle phase, and the presence of a `VirtualMachineInstance` object in the same namespace is what the restore controller actually consults. By default KubeVirt names the VMI identically to its parent VM, but a custom template may override this — list VMIs in the namespace first and match by owner reference if the names differ:

```bash
kubectl get vm -n <namespace> <vm-name> \
  -o jsonpath='{.status.printableStatus}{"\n"}'
kubectl get vmi -n <namespace> \
  -o jsonpath='{range .items[?(@.metadata.ownerReferences[0].name=="<vm-name>")]}{.metadata.name}{"\n"}{end}'
```

If the VMI listing returns an object owned by the target VM while the VM's printable status already indicates a stopped or transitional state, the cluster is in the lingering-VMI state described above; delete that VMI as shown in Resolution to unblock the restore.
