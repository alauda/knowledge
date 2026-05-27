---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500201
---

# virt-launcher Sync VMI loop on KubeVirt VMs with multiple secondary networks on ACP

## Issue

On Alauda Container Platform with the `kubevirt-operator` bundle installed (CSV `kubevirt-hyperconverged-operator.v4.3.5`, channel `alpha`, HCO singleton in the `kubevirt` namespace, KubeVirt at `v1.7.0-alauda.2`), a KubeVirt VirtualMachine configured with two or more secondary networks attached via Multus can drive its virt-launcher pod into a high-rate reconcile loop. The virt-launcher container (`registry.alauda.cn:60080/3rdparty/kubevirt/virt-launcher:v1.7.0-alauda.2`) emits many `Synced vmi` info lines per second from `pos=server.go:208`, each line a one-line JSON record of the shape `{component:"virt-launcher", level:"info", msg:"Synced vmi", pos:"server.go:208", timestamp:...}` carrying the VMI's name, namespace, and UID.

On the same trigger the VM's IP address visibly flaps in the VirtualMachineInstance status. The VMI CRD (`kubevirt.io` group, kinds `VirtualMachineInstance` at versions `v1` and `v1alpha3`) defines `.status.interfaces[]` entries that carry `ipAddress`, `ipAddresses[]`, `mac`, `name`, `interfaceName`, `podInterfaceName`, `linkState`, and `infoSource`; while the loop is active these entries — including the reported IP — are rewritten on every reconcile iteration and appear to come and go when watched with `kubectl get vmi -o yaml`.

## Root Cause

`.status.interfaces[]` on a VMI is a merged view fed by multiple producers: the `infoSource` field on each entry is an enum with the values `domain`, `guest-agent`, and `multus-status`, identifying which subsystem contributed the data. When a VM carries more than one Multus-attached secondary network, the producers disagree on what the merged interface set should look like, so each reconcile pass writes a new desired state. The node-agent (`virt-handler`, image `build-harbor.alauda.cn/3rdparty/kubevirt/virt-handler:v1.7.0-alauda.2`) issues a fresh per-VMI Sync RPC into the virt-launcher cmd-server for every such update, while the control-plane controller (`virt-controller`, image `build-harbor.alauda.cn/3rdparty/kubevirt/virt-controller:v1.7.0-alauda.2`) keeps driving the VMI reconcile — together producing the per-second `Synced vmi` log line and the visible IP flap in `.status.interfaces[]`.

## Resolution

Reorder the interface list in the VirtualMachine template so the pod-network interface is the first entry. The VM CRD on ACP is `kubevirt.io/VirtualMachine` (versions `v1` and `v1alpha3`), and the per-VM template interface list lives at `spec.template.spec.domain.devices.interfaces[]`; the matching `spec.template.spec.networks[]` block supports both the stock `pod` network type and the `multus` network type, where `multus.networkName` references a `NetworkAttachmentDefinition` (`k8s.cni.cncf.io/v1`) name. Editing the VM YAML to move the interface entry whose `name` matches the `pod`-network entry in `networks[]` into the first position of `interfaces[]` mitigates the loop.

Apply the change in place against the VM object (the example assumes a VM with one pod-network interface named `default` and two Multus-attached secondary interfaces; replace the VM name and namespace as appropriate):

```bash
kubectl edit vm -n <vm-namespace> <vm-name>
```

The reordered template looks like this — the `pod`-network entry in `networks[]` is matched by the first entry in `interfaces[]` by `name`, with the Multus-attached secondary entries following:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
spec:
  template:
    spec:
      domain:
        devices:
          interfaces:
            - name: default
              masquerade: {}
            - name: secondary-1
              bridge: {}
            - name: secondary-2
              bridge: {}
      networks:
        - name: default
          pod: {}
        - name: secondary-1
          multus:
            networkName: <nad-namespace>/<nad-name-1>
        - name: secondary-2
          multus:
            networkName: <nad-namespace>/<nad-name-2>
```

After saving, KubeVirt regenerates the VMI from the updated template; the `Synced vmi` log rate in the new virt-launcher pod and the stability of `.status.interfaces[]` on the new VMI should both confirm whether the workaround applies to this VM's specific interface topology.

## Diagnostic Steps

Confirm the symptom on the virt-launcher side by streaming the pod's logs in the VM's namespace and grepping for the `Synced vmi` message; a healthy VM emits this line at startup and during legitimate reconciles, while a VM caught in the loop emits it many times per second from `pos=server.go:208` with `level:"info"` and the JSON envelope described above:

```bash
kubectl logs -n <vm-namespace> -l kubevirt.io=virt-launcher,vm.kubevirt.io/name=<vm-name> \
  --tail=200 -f
```

Confirm the matching VMI-side symptom by reading the VMI's status block and watching `.status.interfaces[]`; in the loop state, the `ipAddress` / `ipAddresses` / `mac` / `interfaceName` / `podInterfaceName` / `linkState` / `infoSource` fields on the affected entries are rewritten on every reconcile iteration and the IP flips between values rather than stabilising:

```bash
kubectl get vmi -n <vm-namespace> <vm-name> \
  -o jsonpath='{.status.interfaces}' | jq .
```

Cross-check the VM template against the workaround by reading the interface and network lists on the VM object — the first entry of `spec.template.spec.domain.devices.interfaces[]` should have the same `name` as the `pod`-network entry in `spec.template.spec.networks[]`, with any `multus` networks (each referencing a `NetworkAttachmentDefinition` via `networkName`) ordered after it:

```bash
kubectl get vm -n <vm-namespace> <vm-name> \
  -o jsonpath='{.spec.template.spec.domain.devices.interfaces}{"\n"}{.spec.template.spec.networks}{"\n"}'
```
