---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Fixed IPs outside the Kube-OVN IPPool bound to a namespace can still be assigned to its Pods on ACP

## Issue

A Kube-OVN `IPPool` is bound to a namespace through `spec.namespaces`, with the intention that Pods in that namespace only use addresses from the pool. When a workload in that namespace is configured with a fixed IP, addresses outside the bound pool can still be selected and assigned, including addresses intended for other namespaces. This raises the concern that a fixed IP chosen this way conflicts with an address planned for another namespace and causes a production outage.

## Root Cause

### Cause 1: the namespace binding of an IPPool applies only to automatic IP allocation

Binding an IPPool to a namespace restricts only the addresses that Kube-OVN allocates **automatically** to Pods of that namespace: a Pod without a fixed IP gets its address from the bound pool instead of from the rest of the subnet.

An IP that is specified manually for a Pod or workload (a fixed IP) is not limited by the namespace binding. Kube-OVN accepts a manually specified address from outside the bound pool, so the binding does not stop a fixed IP from taking an address that belongs to another namespace's pool. This is current product behavior, not a misconfiguration.

## Resolution

### Cause 1: the namespace binding of an IPPool applies only to automatic IP allocation

There is no setting that makes the namespace binding apply to manually specified IPs. Keep the namespace's addresses inside its pool with one of these approaches:

1. Let Pods of the namespace get their IPs automatically. Do not configure fixed IPs for workloads that do not need them; their addresses then always come from the bound pool.

2. When a workload does need a fixed IP, pick it only from the pool bound to its namespace. Read the pool's ranges first:

   ```bash
   kubectl get ippool <pool-name> -o jsonpath='{.spec.subnet}{"\n"}{.spec.ips}{"\n"}{.spec.namespaces}{"\n"}'
   ```

   Check that the address is not already used before you assign it:

   ```bash
   kubectl get ip -o wide | grep -w <fixed-ip>
   kubectl get pod -A -o wide | grep -w <fixed-ip>
   ```

   Both commands should return nothing for a free address.

3. Treat fixed IPs as a reviewed setting. Because the binding does not check them, the person who configures a fixed IP has to make sure it lies inside the namespace's pool.

## Diagnostic Steps

1. List the IPPools, their subnets and the namespaces they are bound to:

   ```bash
   kubectl get ippool
   kubectl get ippool <pool-name> -o yaml
   ```

2. List the Pods of the namespace with their IPs and compare them with the pool's `spec.ips`:

   ```bash
   kubectl -n <namespace> get pod -o wide
   ```

   Expected for this article: Pods without a fixed IP have addresses inside the bound pool. A Pod whose address lies outside the pool is one that was given its IP manually.

3. Find the workloads of the namespace that request a fixed IP. Fixed IPs are set through Kube-OVN annotations in the Pod template, such as `ovn.kubernetes.io/ip_address` (one address) or `ovn.kubernetes.io/ip_pool` when it holds a list of addresses. An `ovn.kubernetes.io/ip_pool` value that is the name of an IPPool is not a fixed IP; addresses are then allocated automatically from that pool:

   ```bash
   kubectl -n <namespace> get deploy,statefulset -o yaml | grep -E 'ovn.kubernetes.io/(ip_address|ip_pool)'
   ```

   Every fixed address found here has to be checked against the bound pool by hand, as described in the Resolution.
