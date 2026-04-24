---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A Windows VM freshly migrated onto ACP Virtualization shows, in the VM's network-interface list on the ACP console, a `Loopback Pseudo-Interface` alongside the expected Ethernet NICs. At first glance the extra entry looks like the migration toolkit or KubeVirt accidentally added a spurious interface. The entry typically carries the address `127.0.0.1` and does not participate in any configured pod-network or secondary-network attachment.

This note confirms that the loopback entry is **expected** on Windows guests and explains where it comes from, so the extra interface is not mistakenly flagged as a migration artefact.

## Why the Loopback Appears

The network-interface list the ACP console displays for a VM is not read from the pod or the KubeVirt spec directly. Two sources combine:

1. The VM's `domain` spec — the explicitly-attached interfaces (`spec.template.spec.domain.devices.interfaces`) from the `VirtualMachine` CR.
2. The **in-guest report** from the QEMU guest agent — everything the guest OS reports through the agent as its visible network interfaces.

The second source is where the loopback comes from.

Windows reports its network inventory through the IP Helper API. That API treats the loopback interface (`127.0.0.1` / the "Loopback Pseudo-Interface") as a regular enumerated interface, just like a physical Ethernet card. When the QEMU guest agent queries the OS for the interface list, the loopback shows up in the response. The agent relays that response to the hypervisor, KubeVirt records it on the VMI status, and the ACP console renders the whole list — including the loopback — on the VM's network page.

Linux guests also have a loopback (`lo`) but the Linux guest-agent path has historically filtered it before reporting, so the same visual surprise does not appear there. Windows does not filter it; Windows guests show loopback in the list.

There is no bug. Nothing about this interface needs to be removed, hidden, or worked around. The loopback is used by the guest OS itself for in-VM IPC between processes; removing or renumbering it would break whatever in-guest software relies on `127.0.0.1`.

## What the Listing Looks Like

A typical inspection of a Windows VMI's interface status lists both the "real" NIC and the loopback:

```bash
kubectl -n <ns> get vmi <windows-vm> -o json | \
  jq '.status.interfaces[] | {name, ipAddress, mac, interfaceName}'
# {
#   "name": "default",
#   "ipAddress": "10.128.12.42",
#   "mac": "02:00:00:AA:BB:42",
#   "interfaceName": "Ethernet"
# }
# {
#   "name": null,
#   "ipAddress": "127.0.0.1",
#   "mac": null,
#   "interfaceName": "Loopback Pseudo-Interface 1"
# }
```

Distinguishing features of the loopback entry:

- `ipAddress: 127.0.0.1` (or an IPv6 loopback `::1`).
- `mac: null` (loopback has no MAC).
- `name: null` (no reference to any `VirtualMachine.spec.networks[].name` — the loopback is not a user-defined network attachment).
- `interfaceName` matches the Windows IP Helper's representation (`Loopback Pseudo-Interface 1`).

The "real" NICs carry a non-null `name` that maps to entries in `spec.template.spec.networks` and a MAC address the cluster's SDN plumbed.

## When the Listing Actually Is Wrong

Most Windows VM interface displays include the loopback — that is not a problem. Situations that would be worth investigating:

- **Extra entries with IPs that do not correspond to any configured attachment and are not loopback.** For example, a `169.254.x.x` address (Windows' APIPA fallback) suggests the real NIC failed DHCP — the concerning fix is on the real NIC, not the extra entry.
- **Missing real NICs.** The loopback is there but the configured Ethernet is absent from the list; suggests the guest-agent is not fully started, the NIC has not bound, or the VM's network plumbing has a problem.
- **Duplicate non-loopback interfaces.** More real-NIC entries than the VM declares may suggest a leaked interface from a prior VM generation or a migration artefact.

For each of those, the relevant logs live in the VMI's status and in the `virt-launcher` pod's events — the loopback itself is not the investigation target.

## Diagnostic Steps

Count the expected versus observed interfaces:

```bash
NS=<ns>; VM=<windows-vm>
# Declared in spec:
kubectl -n "$NS" get vm "$VM" -o json | \
  jq '.spec.template.spec.networks | length'
# 1

# Reported by guest-agent (includes loopback for Windows):
kubectl -n "$NS" get vmi "$VM" -o json | \
  jq '.status.interfaces | length'
# 2   — the one declared NIC + loopback
```

If the delta is exactly 1 (loopback), the listing is normal. If the delta is different, investigate using the bullets above.

From inside the Windows guest, confirm the loopback is the only "extra" interface:

```powershell
# Inside the Windows VM:
Get-NetIPInterface | Select-Object InterfaceAlias, AddressFamily
```

The loopback appears as `Loopback Pseudo-Interface 1` at the OS level. Matching the OS's view with the cluster-side view confirms the console's listing is a faithful reflection of the guest state.

No fix is required; the interface is expected. Document the pattern so support tickets about the loopback entry can be closed with a reference to this note.
