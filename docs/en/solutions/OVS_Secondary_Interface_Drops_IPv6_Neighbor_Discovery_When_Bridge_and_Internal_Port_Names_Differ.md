---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OVS Secondary Interface Drops IPv6 Neighbor Discovery When Bridge and Internal Port Names Differ
## Issue

A node in Alauda Container Platform exposes a secondary network through an OVS bridge defined by an NMState `NodeNetworkConfigurationPolicy` (NNCP). External hosts on the same IPv6 subnet cannot reach the IPv6 address configured on that bridge:

- IPv6 ICMP requests time out from the external side.
- The IPv6 Neighbor Discovery Protocol (NDP) appears broken — multicast neighbor-solicitation packets reach the host's NIC but the OVS internal port never replies.
- IPv4 on the same bridge works correctly; only the IPv6 path is affected.

The setup that triggers it has the OVS bridge and its internal `ovs-interface` port carrying **different** names. For example:

```yaml
- name: ovs-sec-br-vlan-100        # OVS bridge name
  type: ovs-bridge
- name: br-name                    # OVS internal port name (mismatch!)
  type: ovs-interface
```

## Root Cause

When the OVS bridge name and the name of the OVS internal port differ, the host kernel's multicast group bookkeeping for the internal port falls out of sync with what `ovs-vswitchd` expects. The result is that the kernel does not deliver inbound IPv6 multicast frames (the `solicited-node` group used for neighbor discovery) to the OVS internal port's network namespace, so the kernel never generates a neighbor advertisement reply.

Because IPv4 ARP is unicast at L2 (or broadcast inside the local segment) it still works; only IPv6 NDP, which depends on multicast group membership being exposed to the bridge port, is broken.

The bug lives in the OVS / kernel multicast snooping interaction. It is tracked upstream and a fix is in progress; until then the supported workaround is to keep the names aligned.

## Resolution

Edit the NNCP so the OVS bridge and the OVS internal port use the **same** name. Example:

```yaml
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: nmstate-name-ovs-bridge
spec:
  desiredState:
    interfaces:
    - name: br-name                # bridge and internal port share this name
      type: ovs-bridge
      state: up
      bridge:
        options:
          mcast-snooping-enable: true
          stp: false
        port:
        - name: br-name            # internal port matches bridge name
        - name: bond0.<vlan>
    - name: br-name                # internal port itself
      type: ovs-interface
      state: up
      ipv4:
        enabled: true
        address:
        - ip: <ipv4-addr>
          prefix-length: <plen>
      ipv6:
        enabled: true
        address:
        - ip: <ipv6-addr>
          prefix-length: 112
    - name: bond0.<vlan>
      type: vlan
      vlan:
        base-iface: bond0
        id: <vlan-id>
      state: up
```

Apply with `kubectl apply -f`. The NMState handler will detect the change, recreate the OVS bridge, and the new internal port will inherit the matching name. IPv6 neighbor discovery resumes within a few seconds.

If renaming the bridge would break other consumers (e.g. monitoring rules keyed off the existing bridge name), an alternative is to keep the bridge name and rename only the internal port to match the bridge — symmetry between the two is what the workaround requires, not a particular value.

## Diagnostic Steps

1. Confirm the asymmetric naming pattern in the running NNCP:

   ```bash
   kubectl get nncp -o yaml | grep -E 'name|type: ovs-(bridge|interface)'
   ```

   If you see an `ovs-bridge` and an `ovs-interface` whose `name:` fields differ, this is the configuration that triggers the bug.

2. From an external host on the same IPv6 subnet, prove the failure is at NDP and not at L3:

   ```bash
   curl -k "https://[<ipv6-addr>]/" -6 --connect-timeout 30 -v
   ```

   The request times out and `tcpdump` from the host shows the neighbor solicitation arriving but never being answered.

3. From inside the affected node, capture multicast on every interface:

   ```bash
   kubectl debug node/<host> -- chroot /host \
     toolbox -- tcpdump -nni any -y LINUX_SLL2 icmp6
   ```

   Expected pattern when broken:

   ```text
   M IP6 <peer> > <solicited-node>: ICMP6, neighbor solicitation, who has <ipv6-addr>
   M IP6 <peer> > <solicited-node>: ICMP6, neighbor solicitation, who has <ipv6-addr>
   M IP6 <peer> > <solicited-node>: ICMP6, neighbor solicitation, who has <ipv6-addr>
   ```

   Solicitations repeat with no advertisement back. After applying the rename, an `ICMP6, neighbor advertisement, tgt is <ipv6-addr>` should follow each solicitation immediately.

4. After remediation verify multicast group membership on the internal port:

   ```bash
   kubectl debug node/<host> -- chroot /host \
     ip -6 maddr show dev br-name
   ```

   The list should include the solicited-node group (`ff02::1:ff??:????`) corresponding to the configured IPv6 address. If absent, the rename did not take effect — confirm the NNCP applied cleanly with `kubectl get nncp <name> -o yaml`.
