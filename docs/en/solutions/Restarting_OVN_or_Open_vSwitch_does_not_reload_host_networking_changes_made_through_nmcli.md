---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An administrator updates host networking on a worker node — adjusting a
bond, replacing a NIC, changing a VLAN, modifying an interface — by
calling `nmcli` directly on the node. To pick up the change they restart
the OVN and Open vSwitch services:

```bash
systemctl restart openvswitch
systemctl restart ovn-controller
```

The restart succeeds but the change does not take effect. Pods on the node
keep using the old configuration, the bond shows the old slaves, or the
node loses connectivity to one of the upstream VLANs.

## Root Cause

The host's network stack is layered:

```text
Physical NICs --> bond0 --> OVS port --> br-ex --> CNI gateway
```

NetworkManager owns the **physical interfaces and the bonds** at the bottom
of the stack. Open vSwitch sits one layer up — it consumes interfaces that
NetworkManager has already brought up — and the cluster CNI (OVN-driven or
otherwise) consumes the OVS bridges.

Restarting `openvswitch` or the CNI's controller daemon only re-evaluates
the upper layers. It does not reload anything NetworkManager owns. If the
change was made with `nmcli` (a bond reconfigured, a NIC swapped, a VLAN
relabelled), NetworkManager's in-memory state already reflects the change,
but the physical layer below has not been re-applied to the kernel until
NetworkManager itself is reloaded for the affected interface.

For trivial changes (an IP added to an existing connection, a route
modified) `nmcli connection up <conn>` is enough to reapply NetworkManager
state. For structural changes — bond membership swaps, NIC replacements,
VLAN re-tagging on a bridge that is currently up — the safest path is a
node reboot, because the change disturbs interfaces that downstream
consumers (OVS, the CNI) actively hold open.

## Resolution

Choose the path that matches the change:

### For minor changes (IP/route/DNS/MTU)

Reapply the NetworkManager profile for the affected connection:

```bash
nmcli connection down <conn>
nmcli connection up <conn>
```

Verify the kernel state reflects the new value:

```bash
ip addr show dev <iface>
ip route show
```

OVS and the CNI re-attach to the interface as soon as it is back up — no
service restart required.

### For structural changes (bond, VLAN, NIC swap)

Drain the node first so workloads relocate cleanly:

```bash
kubectl cordon <node>
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

Then reboot the node. On boot, NetworkManager reapplies the new profile,
OVS rebuilds its bridges from scratch on top, and the CNI reattaches
without inheriting any stale state:

```bash
kubectl debug node/<node> -- chroot /host shutdown -r now
# Wait for the node to come back and become Ready, then uncordon:
kubectl uncordon <node>
```

### Long-term: declarative host networking

For repeatable, declarative host-network configuration, drive node
networking through NMState rather than ad-hoc `nmcli` invocations. A
`NodeNetworkConfigurationPolicy` is reconciled by the NMState operator
across all matching nodes, and the operator handles the "down + reapply"
sequence per connection so the change converges reliably without manual
service restarts:

```yaml
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: bond0-add-slave
spec:
  nodeSelector:
    node-role.kubernetes.io/worker: ""
  desiredState:
    interfaces:
      - name: bond0
        type: bond
        state: up
        link-aggregation:
          mode: 802.3ad
          port:
            - eth0
            - eth1
            - eth2   # newly added slave
```

Declarative configuration is also auditable and survives node
re-provisioning, which makes it the recommended approach for any
production cluster that accepts host-network changes regularly.

## Diagnostic Steps

1. Confirm the kernel sees the change before blaming OVS / the CNI:

   ```bash
   ip -d link show <iface>
   ip addr show <iface>
   ```

   If `ip` does not show the new state, the failure is in NetworkManager —
   check the connection profile (`nmcli connection show <conn>`) and
   reapply.

2. Confirm OVS sees the underlying interface:

   ```bash
   ovs-vsctl show
   ```

   The bond must be present as a port on the `br-ex` bridge. If it is
   missing or marked as faulted, OVS lost the interface during the
   change — restart `openvswitch` after the kernel state is correct, or
   reboot.

3. Confirm the CNI is happy:

   ```bash
   kubectl get pods -n <cni-ns> -o wide | grep <node>
   ```

   The node-side CNI pod must be `Running` and pass its readiness probes.
   If it crash-loops, drain and reboot.

4. After a node reboot, confirm the node returns `Ready` and that pods
   scheduled on it can reach the cluster network end-to-end with a
   `kubectl exec` curl from one of them.
