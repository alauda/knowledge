---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Node events show CIDRNotAvailable and some nodes have an empty podCIDR on a Kube-OVN cluster on ACP

## Issue

On a cluster whose CNI is Kube-OVN, node events with reason `CIDRNotAvailable` appear, and the following command returns a value on some nodes and nothing on others:

```bash
kubectl get node <node-name> -o jsonpath='{.spec.podCIDR}{"\n"}{.spec.podCIDRs}{"\n"}'
```

The question is whether these events and the empty fields affect the cluster network.

Related articles: "Kube-OVN Pods fail with AddressOutOfRange, AddressConflict or no address allocated on ACP".

## Root Cause

### Cause 1: CIDRNotAvailable comes from Kubernetes node CIDR allocation, which Kube-OVN does not use

In Kubernetes, `spec.podCIDR` and `spec.podCIDRs` on a Node are filled by the node IPAM controller of kube-controller-manager when node CIDR allocation is enabled (`--allocate-node-cidrs` with a `--cluster-cidr`). When that controller cannot assign a range to a node, it records a `CIDRNotAvailable` event for the node and leaves the field empty.

Kube-OVN does not take Pod addresses from the Node `podCIDR`. It allocates them from its own `Subnet` resources (the default subnet, or the subnet bound to the project or namespace). For that reason the `CIDRNotAvailable` events have no impact on the Kube-OVN cluster network itself. Why the controller could not allocate a range in a particular cluster is a separate question and does not change this conclusion.

## Resolution

### Cause 1: CIDRNotAvailable comes from Kubernetes node CIDR allocation, which Kube-OVN does not use

No change is required for the Kube-OVN network. Confirm that Pod networking is healthy on the nodes with an empty `podCIDR`:

1. Pods on such a node have addresses and are `Running`:

   ```bash
   kubectl get pods -A -o wide --field-selector spec.nodeName=<empty-cidr-node>
   ```

2. The Kube-OVN subnets are ready and have free addresses:

   ```bash
   kubectl get subnet
   ```

3. `kube-ovn-controller` reports no allocation failures:

   ```bash
   kubectl -n kube-system logs deploy/kube-ovn-controller --tail=500 | grep -iE 'no address allocated|NoAvailableAddress'
   ```

If all three are clean, the events can be ignored for the network. If Pods do fail to get addresses, the cause is in Kube-OVN allocation, not in the Node `podCIDR`; see the related article.

## Diagnostic Steps

1. Compare the nodes that have a `podCIDR` with those that do not:

   ```bash
   kubectl get nodes -o custom-columns='NAME:.metadata.name,PODCIDR:.spec.podCIDR,PODCIDRS:.spec.podCIDRs'
   kubectl get events -A --field-selector reason=CIDRNotAvailable
   ```

2. Check whether kube-controller-manager allocates node CIDRs, and from which range:

   ```bash
   kubectl -n kube-system get pods -l component=kube-controller-manager -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.containers[*].command}{"\n"}{end}' | tr ',' '\n' | grep -E 'allocate-node-cidrs|cluster-cidr|node-cidr-mask-size'
   ```

3. Confirm the cluster CNI is Kube-OVN and Pod addresses come from its subnets:

   ```bash
   kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,NS:.spec.namespaces'
   kubectl get pods -A -o wide | head
   ```

Pod addresses inside the Kube-OVN subnet CIDRs on nodes with and without a `podCIDR` confirm that the events do not affect the cluster network.
