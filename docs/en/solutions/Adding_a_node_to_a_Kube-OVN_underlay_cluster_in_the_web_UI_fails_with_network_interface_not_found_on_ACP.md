---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
---

# Adding a node to a Kube-OVN underlay cluster in the web UI fails with network interface not found on ACP

## Issue

In the web UI, adding a node to a business cluster that uses a Kube-OVN underlay network fails with an error that the network interface (`网卡`, NIC) was not found. Only the node IP, the username and the password were entered.

- The add-node page seems to have no place to enter the NIC, and the NIC of this node cannot be added on the network provider page either.
- The cluster nodes do not all use the same NIC name. The bridge network status lists the nodes being added as `InitOVSBridgeFailed` with `failed to create and configure external bridge br-provider: nic <nic> does not exist`, and the node that has `<nic>` as `InitOVSBridgeSucceeded`.

## Root Cause

### Cause 1: the NIC setting of each node row in the add-node form was left collapsed and empty

On ACP 4.0, the add-node form of an underlay cluster has a network interface setting for every node, but it is folded into the node row. It opens from the expand arrow (`>`) at the very start of the row, to the left of the node type selector (for example `计算节点`, compute node) and the `IPv4 地址` (IPv4 address) field. When the row is not expanded, no interface is specified for the node, and node addition fails with the interface-not-found error.

The `nic <nic> does not exist` condition on the new nodes is consistent with this: with no per-node entry, the bridge network looks for its default interface, which those machines do not have.

## Resolution

### Cause 1: the NIC setting of each node row in the add-node form was left collapsed and empty

1. On the node to be added, read the name of the NIC that carries the underlay network. A VLAN interface prints as `<name>@<parent>`; enter the part before `@`.

   ```bash
   ip -br link
   ip -br addr
   ```

2. In the add-node form, click the `>` arrow at the start of the node row to expand it.
3. Fill in the network interface of that node with the NIC name from step 1, then submit. The node is then added.
4. Check that the bridge network now reports the node as ready:

   ```bash
   kubectl get provider-networks <name> -o jsonpath='{range .status.conditions[*]}{.node}{" "}{.reason}{" "}{.message}{"\n"}{end}'
   ```

   `InitOVSBridgeSucceeded` for the new node means the bridge was created on the NIC you entered.

For a node that is already in the cluster and was never given a matching NIC, set the per-node NIC in the ProviderNetwork itself (`customInterfaces`, or `excludeNodes` for a node without an underlay NIC), as described in [Kube-OVN underlay Pods fail with resolve MAC address timeout or bridge network InitOVSBridgeFailed on ACP](Kube-OVN_underlay_Pods_fail_with_resolve_MAC_address_timeout_or_bridge_network_InitOVSBridgeFailed_on_ACP.md).

## Diagnostic Steps

Compare what the bridge network expects with what the new machine has:

```bash
kubectl get provider-networks <name> -o jsonpath='default={.spec.defaultInterface}{"\n"}custom={.spec.customInterfaces}{"\n"}exclude={.spec.excludeNodes}{"\n"}'
kubectl get provider-networks <name> -o jsonpath='{range .status.conditions[*]}{.node}{" "}{.reason}{"\n"}{end}' | grep -v Succeeded
ip -br link
```

- A node being added through the web UI whose NIC name differs from the default interface, together with a NIC-not-found error on the add, points to the collapsed NIC field (Cause 1).
- If the NIC that the bridge network names is missing on a node that has been in the cluster for a while, or it vanished after a hardware or IaaS change, the node row is not the issue; fix the ProviderNetwork or restore the NIC on the host (see the article linked above).
- If `kube-ovn-cni` on the node fails with `failed to initialize config` or `failed to parse config` for an old interface name, the tunnel interface is wrong, not the bridge NIC; see [kube-ovn-cni fails on one node after a NIC rename, clock skew or hostname change on ACP](kube-ovn-cni_fails_on_one_node_after_a_NIC_rename_clock_skew_or_hostname_change_on_ACP.md).
