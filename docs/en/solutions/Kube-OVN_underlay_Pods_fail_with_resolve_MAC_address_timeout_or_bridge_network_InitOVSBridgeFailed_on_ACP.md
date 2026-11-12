---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# Kube-OVN underlay Pods fail with resolve MAC address timeout or bridge network InitOVSBridgeFailed on ACP

Related articles: [Node, API and VIP access lost after creating a Kube-OVN ProviderNetwork or underlay subnet on ACP](Node_API_and_VIP_access_lost_after_creating_a_Kube-OVN_ProviderNetwork_or_underlay_subnet_on_ACP.md); [All charts stay ChartDownloading on a new Kube-OVN cluster because ovn-default was created as overlay on ACP](All_charts_stay_ChartDownloading_on_a_new_Kube-OVN_cluster_because_ovn-default_was_created_as_overlay_on_ACP.md); [Adding a node to a Kube-OVN underlay cluster in the web UI fails with network interface not found on ACP](Adding_a_node_to_a_Kube-OVN_underlay_cluster_in_the_web_UI_fails_with_network_interface_not_found_on_ACP.md).

## Issue

Pods on a Kube-OVN underlay subnet cannot be created, on all nodes or only on some, or the bridge network itself reports a failure. Typical signs:

- Sandbox creation fails with an event like this, for CoreDNS right after a console deployment, or for platform Pods such as `kube-ovn-pinger`, `zeus` and `nevermore` on some nodes, or for a fixed-IP business Pod:

  ```text
  Warning FailedCreatePodSandBox ... plugin type="kube-ovn" failed (add): RPC failed; request ip return 500 configure nic eth0 for pod <pod> timeout: read packet ...: <gateway> is not ready for interface eth0 after 200 checks: resolve MAC address of <gateway> timeout
  ```

  On a freshly deployed cluster this can look as if the CoreDNS address were already in use.

- The bridge network (ProviderNetwork) shows status Error with `Ready: false`, and the per-node condition reads:

  ```text
  Ready  False  InitOVSBridgeFailed  failed to create and configure external bridge br-<provider>: nic <nic> does not exist
  ```

- The underlay network breaks right after a ProviderNetwork was renamed (for example while configuring an underlay sub-interface for MetalLB), and does not recover.
- After a power cycle a VLAN sub-interface such as `bond1.131` reappears on the node, and containers on the underlay subnet stop working.

## Root Cause

### Cause 1: the ProviderNetwork is bound to the wrong NIC after deployment

A cluster deployed from the console may bind the ProviderNetwork to a NIC other than the intended underlay NIC, for example when the deployment form did not allow choosing it. `br-provider` is then created on the host-network NIC. `ip r` on the node shows the default route and the host subnet on `br-provider`, while the underlay NIC holds only a kernel link route for its own subnet. Pods on the underlay subnet then try to resolve the gateway through the wrong NIC. In the `resolve MAC address of <gateway> timeout` error, `<gateway>` is in the host network subnet, not the underlay gateway, while the node itself can ping the underlay gateway on the intended NIC.

### Cause 2: the bridge NIC does not exist on some nodes

A ProviderNetwork names one `defaultInterface` for all nodes, plus optional per-node `customInterfaces` and `excludeNodes`. When a node does not have the configured NIC:

- the bridge cannot be created there and the node condition shows `InitOVSBridgeFailed ... nic <nic> does not exist`, while nodes that have the NIC show `InitOVSBridgeSucceeded`;
- if the ProviderNetwork does not list the NIC that some nodes actually use for the underlay (for example `p40p2`), ARP for the gateway cannot complete on those nodes and sandbox creation fails with `resolve MAC address of <gateway> timeout`;
- if a NIC disappears from the host (for example after a hardware or IaaS change), the ProviderNetwork shows every node under `Not Ready Nodes` and `ip a` on the nodes lists the other NICs but not the configured one.

### Cause 3: renaming a ProviderNetwork leaves a stale OVN localnet port

Kube-OVN does not handle a ProviderNetwork rename. The OVN logical switch port of type `localnet` for the underlay subnet (named `localnet.<subnet-name>`) is left behind still pointing at the old provider, and the underlay network stays disconnected. Changing only the ProviderNetwork's NIC while keeping the ProviderNetwork and VLAN names does not trigger this.

When one underlay NIC carries several VLAN subnets through sub-interfaces, give each VLAN its own ProviderNetwork.

### Cause 4: the node OS recreates a VLAN sub-interface that conflicts with the underlay

The underlay NIC (for example `bond1`) is attached to `ovs-system` by the ProviderNetwork. If the node OS also creates a VLAN sub-interface on that NIC (for example `bond1.131`), the sub-interface conflicts with the underlay subnet of the same VLAN, and underlay Pods time out resolving the gateway MAC, although a test VLAN interface on the node reaches the gateway. `ip a | grep bond1` shows the physical NICs enslaved to `bond1`, `bond1` with `master ovs-system`, and a leftover `bond1.131@bond1` in state `DOWN`.

The sub-interface can come back without any script creating it. On CentOS 7, the network service (`/etc/init.d/network`) recreates it every time `network` restarts or the node boots, even with kubelet and containerd stopped. A likely explanation is that the service implicitly creates the VLAN sub-interface when the `8021q` module is loaded, `bond1` exists and VLAN 131 context is present on the system (for example an address of that VLAN's segment on `bond0`).

## Resolution

### Cause 1: the ProviderNetwork is bound to the wrong NIC after deployment

Point the ProviderNetwork at the NIC that reaches the underlay gateway.

> **Warning:** Changing `defaultInterface` re-creates the bridge on each node and interrupts underlay traffic. Save the object first and restore it to roll back. Do not select the NIC that carries the node IP; that takes node access with it.

```bash
kubectl get provider-networks <name> -o yaml > /root/pn-<name>.before.yaml
kubectl edit provider-networks <name>
```

After the correct NIC is set, IP allocation works again. If traffic between the host subnet and the underlay subnet is still blocked, a firewall between them has to be opened on the network side.

If the underlay subnet has only a few usable addresses (for example about 20), it is too small for the platform components. Deploy a standard overlay cluster first and add the underlay subnet afterwards.

### Cause 2: the bridge NIC does not exist on some nodes

1. On every failing node, read the real NIC name:

   ```bash
   ip -br link
   kubectl get provider-networks <name> -o yaml
   ```

2. Make the ProviderNetwork match the hardware: list nodes whose underlay NIC has another name under `customInterfaces`, and put nodes that have no underlay NIC under `excludeNodes`.

   > **Warning:** Editing the ProviderNetwork reconfigures the bridge on the listed nodes and briefly interrupts underlay traffic there. Save the object first; to roll back, apply the saved copy.

   ```yaml
   apiVersion: kubeovn.io/v1
   kind: ProviderNetwork
   metadata:
     name: <name>
   spec:
     defaultInterface: <nic-on-most-nodes>
     customInterfaces:
       - interface: <nic-on-these-nodes>
         nodes:
           - <node-a>
     excludeNodes:
       - <node-without-underlay-nic>
   ```

   For example, when only one node has the configured NIC and the others have no underlay NIC, list the others under `excludeNodes`; the bridge network then becomes available (`可用`, Available).

3. If a NIC has vanished from a node, restore it on the host first; the ProviderNetwork cannot use an interface the kernel does not show.
4. Recreate the failed Pods, keep underlay Pods off excluded nodes with a node selector, and check gateway ARP on the underlay NIC:

   ```bash
   arping -c 3 -I <underlay-nic> <gateway>
   ```

### Cause 3: renaming a ProviderNetwork leaves a stale OVN localnet port

Only when the underlay broke right after a ProviderNetwork rename:

1. List the `localnet` ports and find the one that still points at the old ProviderNetwork. The `network_name` option of a `localnet` port is the provider it maps to; a value that names the old ProviderNetwork marks the stale port.

   ```bash
   kubectl get provider-networks,vlan,subnet
   kubectl ko nbctl show | grep -B2 -A3 localnet | tee /root/localnet.before
   kubectl ko nbctl lsp-get-options localnet.<subnet-name>
   kubectl ko vsctl <node> get open . external-ids:ovn-bridge-mappings
   ```

2. Delete the stale port and restart `kube-ovn-controller` so that it creates the port again for the current provider.

   > **Warning:** `lsp-del` removes the port from the OVN northbound database at once, and the underlay subnet has no path to the physical network until `kube-ovn-controller` creates it again. Delete only the `localnet` port confirmed in step 1, and keep the saved listing. The delete cannot be undone except by the controller recreating the port. Restarting `kube-ovn-controller` pauses IP allocation until the new leader is ready.

   ```bash
   kubectl ko nbctl lsp-del localnet.<subnet-name>
   kubectl -n kube-system rollout restart deploy/kube-ovn-controller
   kubectl -n kube-system rollout status deploy/kube-ovn-controller
   kubectl ko nbctl lsp-get-options localnet.<subnet-name>
   ```

3. Keep ProviderNetwork and VLAN names stable afterwards. To use a different interface, change only the NIC.

### Cause 4: the node OS recreates a VLAN sub-interface that conflicts with the underlay

1. When a Pod is already stuck, delete the leftover sub-interface. This needs root; without `sudo` the command returns `RTNETLINK answers: Operation not permitted`.

   > **Warning:** Only when the interface is a leftover VLAN sub-interface on the NIC that the ProviderNetwork has attached to `ovs-system`, and nothing on the host uses it. Deleting a sub-interface that carries a host address cuts that address. To roll back, recreate it with `ip link add link <nic> name <nic>.<vlan-id> type vlan id <vlan-id>`.

   ```bash
   ip a | grep <underlay-nic>
   sudo ip link del <underlay-nic>.<vlan-id>
   ```

   The stuck Pod then starts.

2. Remove the source of the interface from the OS network configuration if you can find it. If you cannot, add a udev rule that deletes the interface whenever it appears (replace `bond1.131` with your conflicting interface):

   > **Warning:** The rule deletes the named interface every time it appears, including when someone creates it on purpose. Name the interface exactly. To roll back, delete the rule file and reload udev.

   ```bash
   cat > /etc/udev/rules.d/99-disable-bond1.131.rules <<'RULE'
   SUBSYSTEM=="net", KERNEL=="bond1.131", ENV{SYSTEMD_ALIAS}="*", RUN+="/bin/sh -c '/sbin/ip link set bond1.131 down; /sbin/ip link delete bond1.131'"
   RULE
   udevadm control --reload-rules
   udevadm trigger
   ```

3. Confirm the rule: restart the network service, or reboot once in a maintenance window, and check that the interface does not come back.

   > **Warning:** Restarting the network service briefly drops every host interface and can cut the session you are using. Run it from a console, in a maintenance window, one node at a time.

   ```bash
   systemctl restart network
   ip link show <underlay-nic>.<vlan-id>
   ```

## Diagnostic Steps

```bash
kubectl get provider-networks -o yaml
kubectl get vlan,subnet
ip -br addr
ip route
ip -d link show | grep -A1 -E 'vlan|br-'
kubectl get provider-networks <name> -o jsonpath='{range .status.conditions[*]}{.node}{" "}{.type}{" "}{.status}{" "}{.reason}{" "}{.message}{"\n"}{end}'
kubectl ko nbctl show | grep -B2 -A3 localnet
```

- `br-provider` holding the node address and default route right after deployment, with `resolve MAC address of <gateway> timeout` for a gateway in the host network subnet, is Cause 1.
- A bridge network that fails only on nodes missing the interface, a node condition `InitOVSBridgeFailed` with `nic <nic> does not exist`, or gateway ARP failing only on nodes whose underlay NIC is not listed, is Cause 2.
- An underlay failure that started right after renaming a ProviderNetwork, with a `localnet` port whose `network_name` is the old name, is Cause 3.
- An unexpected VLAN sub-interface after a reboot, or a `DOWN` sub-interface such as `bond1.131@bond1` on a NIC whose master is `ovs-system` while underlay Pods time out resolving the gateway MAC, is Cause 4.
- If the underlay gateway does not answer ARP from any NIC of the node, the fault is in the switch or gateway configuration, not in the ProviderNetwork.
