---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# Node, API and VIP access lost after creating a Kube-OVN ProviderNetwork or underlay subnet on ACP

Related articles: [Kube-OVN underlay Pods fail with resolve MAC address timeout or bridge network InitOVSBridgeFailed on ACP](Kube-OVN_underlay_Pods_fail_with_resolve_MAC_address_timeout_or_bridge_network_InitOVSBridgeFailed_on_ACP.md); [All charts stay ChartDownloading on a new Kube-OVN cluster because ovn-default was created as overlay on ACP](All_charts_stay_ChartDownloading_on_a_new_Kube-OVN_cluster_because_ovn-default_was_created_as_overlay_on_ACP.md).

## Issue

One of the following happens right after an underlay network is set up with Kube-OVN:

- A ProviderNetwork (bridge network) was just created and the cluster becomes unavailable: the login page opens but login fails, the cluster VIP does not answer `ping`, and a new interface `br-<name>` appears on every node with the same addresses as the node NIC.
- A new cluster is being created with Kube-OVN, transport mode `Underlay`, a custom default subnet and a VLAN ID. As soon as creation starts, the masters can no longer be logged into, and the switch reports MAC or IP conflicts such as `ARP_USER_DUPLICATE_IPADDR_DETECT` (`user IP address conflict`).
- Before setting up an underlay network on bonded NICs, an engineer asks how the bond is configured and what the platform needs.

All three come from the choice of the node NIC that the ProviderNetwork uses, or from addresses that collide with the node network.

## Root Cause

### Cause 1: the ProviderNetwork defaultInterface is the NIC that carries the node IP

When a ProviderNetwork is created, Kube-OVN moves the NIC named in `defaultInterface` (or `customInterfaces`) into the OVS bridge `br-<name>`. The node addresses and all routes of that NIC move to the bridge. If that NIC is the one that carries the node IP (for example `defaultInterface: bond0` when `bond0` holds the node address), node, API server and VIP access break on every node. The underlay NIC must be a separate NIC, not the one that carries the node IP.

The resource is named `provider-networks` (`provider-networks.kubeovn.io`, cluster-scoped). `kubectl delete ProviderNetwork <name>` fails with `the server doesn't have a resource type "ProviderNetwork"`.

### Cause 2: the underlay subnet chosen at cluster creation overlaps the node network

When a cluster is created with an underlay default subnet that lies in the same segment as the node IPs, platform component Pods receive addresses from that subnet as soon as creation starts. Those addresses collide with node addresses in the same VLAN: the switch sees one IP on several MACs (`ARP_USER_DUPLICATE_IPADDR_DETECT`), and the masters become unreachable. Stopping the creation or scale-out task restores node access.

### Cause 3: NIC bonding for an underlay network is done on the node, not by the platform

An underlay network needs the gateway address, the subnet, the VLAN ID and the NIC. The platform does not configure bonds. Node-level NIC configuration, including bond, trunk and VLAN, is done in the node operating system. The platform then creates a bridge on top of that interface. If the bond is missing on some nodes, or it is the NIC that holds the node IP, the bridge either fails on those nodes or takes node access with it (Cause 1).

## Resolution

### Cause 1: the ProviderNetwork defaultInterface is the NIC that carries the node IP

1. From a session that still reaches the API (a node console, or any master that still answers), save and delete the ProviderNetwork.

   > **Warning:** Deleting a ProviderNetwork removes the bridge from every node, and underlay Pods that use it lose their network. Here that is the intended effect, because node access is already broken. There is no undo; to roll back, recreate the object from the saved YAML (with a corrected NIC).

   ```bash
   kubectl get provider-networks
   kubectl get provider-networks <name> -o yaml > /root/pn-<name>.yaml
   kubectl delete provider-networks <name>
   ip -br addr show br-<name> || true
   ```

   After the delete, the node addresses return to the NIC and node, API and VIP access come back.

2. Choose a `defaultInterface` from `ip -br addr` that does not hold the node IP, and create the ProviderNetwork again with it.

### Cause 2: the underlay subnet chosen at cluster creation overlaps the node network

1. Stop the cluster creation or scale-out task that started handing out addresses. Node access comes back once it stops.
2. Plan an underlay subnet that does not include any node address, and recreate the cluster with it. Exclude every node, gateway and VIP address that must stay in the same VLAN.

   ```bash
   kubectl get nodes -o wide
   kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,VLAN:.spec.vlan,EXCLUDE:.spec.excludeIps'
   ```

### Cause 3: NIC bonding for an underlay network is done on the node, not by the platform

1. Configure the bond (and any trunk or VLAN) in the operating system of every underlay node. NetworkManager is the preferred tool for node network management, because the platform's functional tests run with it.
2. Check that the bond exists with the same name on all those nodes, and that it is not the NIC that carries the node IP:

   ```bash
   ip -d link show <bond-name>
   cat /proc/net/bonding/<bond-name>
   ip -br addr show <bond-name>
   ```

3. Give the platform the bond name, whether the switch port is a trunk or an access (VLAN) port, the VLAN ID, the subnet and the gateway. Nodes whose underlay NIC has another name are listed under `customInterfaces` of the ProviderNetwork; nodes without an underlay NIC go under `excludeNodes` (see the related article on `InitOVSBridgeFailed`).

## Diagnostic Steps

1. Check where the node address sits. If it is on `br-<name>` and no longer on the physical NIC or bond, Cause 1 applies:

   ```bash
   ip -br addr
   ip route
   kubectl get provider-networks -o yaml | grep -E 'name:|defaultInterface|interface:'
   ```

2. Compare the underlay subnet with the node addresses. A subnet CIDR that contains node IPs, together with duplicate-IP alarms on the switch, is Cause 2:

   ```bash
   kubectl get nodes -o wide
   kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,VLAN:.spec.vlan'
   ```

3. For a bond, confirm that it exists and has the expected members on every underlay node before the bridge network is created (Cause 3):

   ```bash
   ip -d link show | grep -A1 -E 'bond|vlan'
   ```
