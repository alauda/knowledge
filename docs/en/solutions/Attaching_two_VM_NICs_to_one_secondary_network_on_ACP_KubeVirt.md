---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500336
---

# Attaching two VM NICs to one secondary network on ACP KubeVirt

## Issue

On Alauda Container Platform, a KubeVirt VirtualMachine sometimes needs two distinct network interfaces backed by the same secondary network — for example, a redundant data-plane pair on one underlay. Multus keys each attachment by the referenced network name, so a single VM cannot reference the same secondary NetworkAttachmentDefinition on two of its interfaces; the two interface entries collapse onto one attachment instead of producing two separate NICs. On ACP this binding behavior comes from upstream Multus (multus-cni v4.2.4) and the upstream KubeVirt VM CRD (`virtualmachines.kubevirt.io`, namespace `kubevirt`), where the distinct-attachment-per-interface requirement is a generic Multus property rather than a CNI-specific one.

## Root Cause

Because Multus deduplicates attachments by network name, two VM `spec.template.spec.networks[]` entries that point at the same NetworkAttachmentDefinition (`network-attachment-definitions.k8s.cni.cncf.io`, `k8s.cni.cncf.io/v1`) resolve to one logical attachment, and KubeVirt wires only a single corresponding interface. Giving the VM a genuine second NIC on the same underlay therefore requires a second NetworkAttachmentDefinition rather than reusing the first; this follows from generic upstream Multus behavior on multus-cni v4.2.4 and is not specific to any particular CNI.

## Resolution

Define a second NetworkAttachmentDefinition for the additional interface. The two NetworkAttachmentDefinitions are standard upstream Multus CRDs (`k8s.cni.cncf.io/v1`) and each must carry a `metadata.name` that is unique within the namespace, since Multus resolves and deduplicates attachments by that name. On ACP the secondary-network CNI is kube-ovn (image `kube-ovn:v1.15.10`); a kube-ovn secondary NetworkAttachmentDefinition declares CNI `type: kube-ovn` and uses the provider convention `<nad-name>.<namespace>.ovn`, which binds the attachment to a kube-ovn Subnet that must already exist (the Subnet, along with its provider-network and Vlan chain, is a prerequisite the NAD's provider reference resolves against). Create two such NetworkAttachmentDefinitions with distinct names so each can be attached as its own interface.

The following pair illustrates two distinct NetworkAttachmentDefinitions in namespace `kubevirt`, each in the kube-ovn shape and each with a unique `metadata.name`:

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: secondary-net-a
  namespace: kubevirt
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "type": "kube-ovn",
      "provider": "secondary-net-a.kubevirt.ovn"
    }
---
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: secondary-net-b
  namespace: kubevirt
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "type": "kube-ovn",
      "provider": "secondary-net-b.kubevirt.ovn"
    }
```

Reference each NetworkAttachmentDefinition from its own VM network entry, and bind each network to a separate interface. Each unique NetworkAttachmentDefinition is attached to the VM as a distinct interface, with every `spec.template.spec.networks[].multus` entry referencing a distinct `networkName` and each `domain.devices.interfaces[]` entry naming the matching network; this binding is the upstream KubeVirt VM CRD form on ACP in the `kubevirt` namespace:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: dual-nic-vm
  namespace: kubevirt
spec:
  template:
    spec:
      domain:
        devices:
          interfaces:
            - name: nic-a
              bridge: {}
            - name: nic-b
              bridge: {}
      networks:
        - name: nic-a
          multus:
            networkName: secondary-net-a
        - name: nic-b
          multus:
            networkName: secondary-net-b
```

Because the two `networkName` values resolve to two distinct NetworkAttachmentDefinitions, Multus produces two separate attachments and KubeVirt presents two NICs on the same underlay; reusing one NetworkAttachmentDefinition across both entries instead yields a single attachment (multus-cni v4.2.4-b223aa77, kube-ovn v1.15.10, namespace `kubevirt`).

## Diagnostic Steps

Confirm that two distinct NetworkAttachmentDefinitions exist in the VM's namespace and that their names are unique, since duplicate or shared names cause the attachments to collapse to one:

```bash
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt
```

Inspect the VM's network-to-interface binding and verify each `multus.networkName` references a different NetworkAttachmentDefinition, matched one-to-one with an interface entry:

```bash
kubectl get virtualmachine -n kubevirt dual-nic-vm \
  -o jsonpath='{.spec.template.spec.networks}'
```

If only one NIC appears on the running VM despite two interface entries, check that both network entries do not point at the same NetworkAttachmentDefinition name; on multus-cni v4.2.4 two entries sharing one name deduplicate to a single attachment.
