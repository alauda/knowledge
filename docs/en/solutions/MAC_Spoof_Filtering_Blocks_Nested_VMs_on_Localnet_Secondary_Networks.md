---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# MAC Spoof Filtering Blocks Nested VMs on Localnet Secondary Networks
## Issue

A virtual machine on Alauda Container Platform Virtualization is attached to a localnet secondary network backed by Kube-OVN, and one of these patterns stops working:

- A nested KVM guest is launched inside the VM and bridged out through a Linux bridge inside the VM. The nested guest cannot reach anything on the secondary network.
- A high-availability virtual IP scheme (CARP, VRRP, keepalived) on top of the VM does not converge, because the floating MAC address that the standby VM advertises is silently dropped.
- A custom userspace bridge or DPDK appliance running inside the VM and forwarding traffic with source MAC addresses other than the VM's own NIC has its packets blackholed at the host.

In all cases the VM itself works fine — only frames whose source MAC differs from the VM's primary NIC MAC are lost.

## Root Cause

When a VM connects to an OVN localnet secondary network, the OVS bridge backing that network applies a MAC spoof filter on the VM's port. The filter pins the port to the MAC address allocated to the VM and drops any frame whose source MAC differs from that pinned value.

This is the correct default for tenant isolation, but it is incompatible with three legitimate workloads:

1. **Nested virtualisation** — the inner Linux bridge inside the guest forwards traffic on behalf of the nested VMs, so the outer port sees frames whose source MAC is the nested VM's MAC, not the host VM's MAC.
2. **VRRP/CARP/keepalived** — the standby instance is supposed to advertise a virtual MAC address (typically `00:00:5e:00:01:VRID`) once it claims the VIP. The OVS port pins to the original MAC and drops the gratuitous ARP carrying the virtual one.
3. **In-VM software switching/DPDK PMDs** that intentionally rewrite the source MAC.

The OVN localnet attachment type does not currently expose a per-port toggle to disable the spoof filter.

## Resolution

The supported workaround is to attach the VM to a **Linux bridge** secondary network through Multus instead of an OVN localnet attachment. The Multus + Linux bridge data path does not enforce a per-port MAC pin, so frames with arbitrary source MACs flow through.

1. Confirm the host NIC and VLAN that should carry the secondary network. If the VLAN you need is the same as the cluster network VLAN already trunked over `br-ex` (or the equivalent default OVS bridge), you cannot create a Linux bridge over the same physical NIC for that VLAN — the kernel will not let two bridges own the same VLAN sub-interface. Use a separate uplink NIC instead.

2. Define a `NodeNetworkConfigurationPolicy` (or equivalent host-network mechanism) to create the Linux bridge on the chosen NIC:

   ```yaml
   apiVersion: nmstate.io/v1
   kind: NodeNetworkConfigurationPolicy
   metadata:
     name: br-vmnet
   spec:
     desiredState:
       interfaces:
       - name: br-vmnet
         type: linux-bridge
         state: up
         ipv4: { enabled: false }
         bridge:
           options:
             stp: { enabled: false }
           port:
             - name: ens224
       - name: ens224
         type: ethernet
         state: up
   ```

3. Publish a Multus `NetworkAttachmentDefinition` that uses the `cnv-bridge` (or `bridge`) plugin against `br-vmnet`:

   ```yaml
   apiVersion: k8s.cni.cncf.io/v1
   kind: NetworkAttachmentDefinition
   metadata:
     name: vmnet-vlan100
     namespace: tenant-a
   spec:
     config: |
       {
         "cniVersion": "0.3.1",
         "type": "cnv-bridge",
         "bridge": "br-vmnet",
         "vlan": 100,
         "macspoofchk": false
       }
   ```

   `macspoofchk: false` explicitly disables the spoof check on this attachment.

4. Edit the VM spec so the relevant NIC binds to the Multus network instead of the localnet OVN attachment:

   ```yaml
   spec:
     template:
       spec:
         domain:
           devices:
             interfaces:
             - name: secondary
               bridge: {}
         networks:
         - name: secondary
           multus:
             networkName: tenant-a/vmnet-vlan100
   ```

5. Power-cycle the VM (a live migration is sufficient on most setups) so the new NIC binding takes effect, then verify from inside the guest that frames with synthetic source MACs are now passing — for example by triggering a VRRP master election or pinging from the nested VM.

## Diagnostic Steps

To prove the spoof filter is the culprit before changing topology:

1. From the host running the VM, capture on the physical NIC and look for the dropped frames:

   ```bash
   kubectl debug node/<host> -- \
     tcpdump -nei <nic> ether src not <vm-mac>
   ```

   If you see the source-MAC-mismatched frames arriving on the NIC but never leaving the OVS bridge towards their destination, the spoof filter is dropping them.

2. From inside the VM, generate a synthetic ARP with a foreign MAC (`arping`, `nping --arp-sender-mac`) and confirm it never reaches the next hop.

3. After switching to the Linux-bridge attachment, repeat the test — the same frames should now be visible on a peer host.

If a Linux-bridge attachment is not feasible (no spare NIC, VLAN collision with the cluster network), the use case must wait until the OVN localnet attachment exposes a `mac_spoof: disable` knob; until then there is no in-band workaround on a pure Kube-OVN localnet path.
