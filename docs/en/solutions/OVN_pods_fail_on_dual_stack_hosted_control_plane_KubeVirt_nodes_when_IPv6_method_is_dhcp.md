---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A dual-stack hosted-control-plane (HCP) cluster running on the KubeVirt
provider has worker nodes that come up but cannot start the cluster CNI. The
node-side CNI controller logs:

```text
failed to start node network controller:
  failed to init default node network controller:
  failed to find IPv6 address on interface br-ex
```

The hosted-cluster nodes are guest virtual machines running on the management
cluster. They have an IPv4 address but never acquire an IPv6 address through
SLAAC, so the bridge interface that the cluster CNI binds to has no IPv6 to
attach to.

## Root Cause

The HCP-provisioned guest VMs come up with NetworkManager configured to
solicit IPv6 through DHCPv6 (`ipv6.method: dhcp`):

```bash
nmcli con show id "Wired connection 1" | grep ipv6.method
# ipv6.method: dhcp
```

The infrastructure between the guest VMs and the upstream router only
advertises IPv6 addresses via Stateless Address Autoconfiguration (SLAAC),
not DHCPv6. SLAAC requires NetworkManager to be in `ipv6.method: auto` mode,
which honours router advertisements and assigns the prefix delegated by the
router. With `ipv6.method: dhcp` NetworkManager waits for a DHCPv6 reply that
never arrives, the interface stays IPv6-less, and the CNI controller fails
to find the address it needs on `br-ex`.

## Resolution

Switch the IPv6 method on each affected guest VM to `auto` and reload the
connection so SLAAC takes effect:

```bash
nmcli con mod "Wired connection 1" ipv6.method auto
nmcli con up "Wired connection 1"
```

After the connection comes back up the interface receives its IPv6 prefix
through SLAAC, the CNI controller finds the address on `br-ex`, and the
node-side CNI pods reach `Running`.

For a permanent fix, ship the IPv6 method as part of the NodePool's machine
configuration so newly provisioned guest VMs come up with the correct setting
from boot — which mechanism applies depends on how the guest image is
templated. For one-shot remediation in an existing cluster, the `nmcli`
change above plus a NetworkManager reload (or a node reboot) is sufficient.

## Diagnostic Steps

1. Confirm the CNI failure mode on the affected node:

   ```bash
   kubectl logs -n <cni-namespace> -l app=ovn-controller --tail=200 \
     | grep -i "find IPv6 address on interface"
   ```

2. Confirm IPv6 is missing from the host bridge:

   ```bash
   kubectl debug node/<node> -- chroot /host ip -6 addr show br-ex
   ```

   An empty result (no `inet6` line for a global address) confirms the host
   never received its prefix.

3. Inspect the NetworkManager profile on the host. From the same debug shell:

   ```bash
   nmcli con show "Wired connection 1" | grep ipv6.method
   ```

4. Verify the upstream router is advertising via SLAAC by tcpdumping for ICMPv6
   Router Advertisement messages on the node-side interface — if RAs are
   absent the issue is upstream, not on the guest.

5. Apply the `nmcli con mod ... ipv6.method auto` correction and confirm the
   bridge picks up the address:

   ```bash
   ip -6 addr show br-ex
   ```

   A global `inet6` entry (not just the link-local `fe80::`) indicates SLAAC
   succeeded. The CNI pods on the node restart cleanly afterwards.
