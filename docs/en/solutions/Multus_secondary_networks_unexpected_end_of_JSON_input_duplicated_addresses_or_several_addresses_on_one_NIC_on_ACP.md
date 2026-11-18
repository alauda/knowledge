---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# Multus secondary networks: unexpected end of JSON input, duplicated addresses or several addresses on one NIC on ACP

## Issue

A Pod with secondary networks attached through Multus (`k8s.v1.cni.cncf.io/networks` and `NetworkAttachmentDefinition`) does not get the NICs or addresses that were intended:

- The Pod is scheduled, then sandbox creation fails, and Multus reports `failed to unmarshal Spec.Config: unexpected end of JSON input` for `multus-cni-network`.
- The Pod should get three VLAN addresses and instead shows two identical ones.
- A multi-homed Pod should receive several addresses from the same subnet on one NIC, and no annotation makes Kube-OVN do it.

Related articles: "Kube-OVN Pods fail with AddressOutOfRange, AddressConflict or no address allocated on ACP"; "Calico Pods get no address: disabled default IPPool, Raven fixed IP mismatch, reserved IPs or deleted raven on ACP".

## Root Cause

### Cause 1: failed to unmarshal Spec.Config: unexpected end of JSON input

`GetCNIConfig` cannot parse the NetworkAttachmentDefinition: its `spec.config` (or the annotation that carries it) is truncated or is not valid JSON. Every new Pod that references the attachment fails the same way; Pods that already started keep their NIC.

### Cause 2: k8s.v1.cni.cncf.io/networks lists the same attachment twice

The annotation repeats one attachment and omits another, for example `default/vlan161,default/vlan161` instead of `default/vlan161,default/vlan162`. IPAM does what the annotation asks, so the Pod gets two addresses from the same network.

### Cause 3: one NIC cannot be given several addresses in the same subnet automatically

Kube-OVN and OVN cannot allocate several addresses from one subnet onto a single NIC of a Pod, and there is no annotation that turns it on. This is a current product gap, not a misconfigured Subnet.

## Resolution

### Cause 1: failed to unmarshal Spec.Config: unexpected end of JSON input

Replace `spec.config` with a complete JSON document, validate it before updating the object, then delete the failed Pod so Multus reads the new config.

> **Warning:** The replacement must be the full JSON string; there is no partial update. Save the object first and re-apply the saved copy to roll back.

```bash
kubectl get network-attachment-definitions.k8s.cni.cncf.io -A
kubectl get network-attachment-definitions.k8s.cni.cncf.io <nad> -n <namespace> -o yaml > /root/nad.before.yaml
python3 -m json.tool < /tmp/nad-config.json > /dev/null && echo valid
kubectl edit network-attachment-definitions.k8s.cni.cncf.io <nad> -n <namespace>
kubectl -n <namespace> delete pod <failed-pod>
```

For a safe way to rewrite the field, see "Updating a NetworkAttachmentDefinition's spec.config JSON Safely".

### Cause 2: k8s.v1.cni.cncf.io/networks lists the same attachment twice

Set the annotation to the distinct attachments, in the order of the addresses you intend, and let the Pod be recreated.

> **Warning:** Patching the Pod template rolls the workload.

```bash
kubectl patch deploy <deploy> -n <namespace> --type=merge -p '{"spec":{"template":{"metadata":{"annotations":{"k8s.v1.cni.cncf.io/networks":"default/vlan160,default/vlan161,default/vlan162"}}}}}'
```

Use your own NetworkAttachmentDefinition names; the example shows each VLAN listed once.

### Cause 3: one NIC cannot be given several addresses in the same subnet automatically

Give each address its own NIC and its own NetworkAttachmentDefinition, or use one address. If a single NIC must carry several addresses from one subnet, raise a product requirement; there is no cluster-side switch.

## Diagnostic Steps

```bash
kubectl -n <namespace> describe pod <pod> | grep -A5 -E 'FailedCreatePodSandBox|multus'
kubectl -n <namespace> get pod <pod> -o jsonpath='{.metadata.annotations.k8s\.v1\.cni\.cncf\.io/networks}{"\n"}'
kubectl -n <namespace> exec <pod> -- ip -br addr
```

- `failed to unmarshal Spec.Config: unexpected end of JSON input`: Cause 1.
- The same attachment name twice in the annotation and two identical addresses in the Pod: Cause 2.
- A request for several same-subnet addresses on one NIC: Cause 3.
