---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a node, the NetworkManager keyfile for an interface has been written with the interface name **and** its UUID concatenated into the filename, for example:

```text
/etc/NetworkManager/system-connections/eno12399-9a1caf6f-5476-4883-9c92-b4a55ff8cf6a.nmconnection
```

The expected layout is one file per interface, named after the interface alone (`eno12399.nmconnection`). The UUID-suffixed variant is harder to reason about in node-configuration tooling and breaks subsequent declarative updates that match on the conventional filename.

## Root Cause

NetworkManager generates a UUID-suffixed filename when more than one keyfile claims the same `interface-name` and a conflicting connection already exists in `/etc/NetworkManager/system-connections/`. The most common trigger is a prior write that left the original `eno12399.nmconnection` in place and a second tool then created a new connection for the same NIC. To avoid an outright collision, NetworkManager appends the UUID and persists both files. The interface still comes up — usually with whichever profile NetworkManager autoconnects first — but the on-disk shape is no longer what the platform's node-configuration layer expects.

On ACP, node network configuration is owned by the platform's declarative node-configuration surface (`configure/clusters/nodes`, backed by the **Immutable Infrastructure** extension product). The platform writes a single canonical keyfile per interface, so a UUID-suffixed file is treated as drift: the next reconcile may either ignore it (leaving the unexpected file behind) or overwrite the canonical one, depending on which connection NetworkManager activates first.

## Resolution

### Preferred: declarative node-configuration update

Express the desired NetworkManager keyfile through `configure/clusters/nodes` (Immutable Infrastructure). The platform serialises the connection profile to `/etc/NetworkManager/system-connections/<interface>.nmconnection` on every matching node and reloads NetworkManager idempotently. Manual edits on the node are reverted at the next reconcile, which is exactly what is wanted here — the goal is to converge to a single canonical filename.

A typical declarative profile for the example interface looks like:

```ini
[connection]
id=eno12399
uuid=9a1caf6f-5476-4883-9c92-b4a55ff8cf6a
type=ethernet
interface-name=eno12399
autoconnect=true

[ethernet]

[ipv4]
method=auto

[ipv6]
method=auto
```

Apply the configuration through the node-configuration page (or the equivalent `NodeConfig`/`MachineProfile` CRD), select the matching node pool, and let the platform roll the change.

### Manual cleanup (only when declarative path is unavailable)

If the platform-managed surface cannot be used (early bring-up, isolated lab, or maintenance against a single node), clean the duplicate by hand. Open a debug shell on the node:

```bash
NODE=<node-name>
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host bash
```

Then on the node:

1. Back up the UUID-suffixed file.

   ```bash
   cp -rp /etc/NetworkManager/system-connections/eno12399-9a1caf6f-5476-4883-9c92-b4a55ff8cf6a.nmconnection /tmp/
   ```

2. Remove the duplicate.

   ```bash
   rm -f /etc/NetworkManager/system-connections/eno12399-9a1caf6f-5476-4883-9c92-b4a55ff8cf6a.nmconnection
   ```

3. Ensure the canonical file (`/etc/NetworkManager/system-connections/eno12399.nmconnection`) holds the desired settings — the same `[connection] / [ethernet] / [ipv4] / [ipv6]` blocks shown above. Adjust `uuid=` if the canonical file does not already have one.

4. Reload NetworkManager so the on-disk layout is re-read.

   ```bash
   systemctl restart NetworkManager
   ```

   On a node that is hosting workloads, `nmcli connection reload` followed by `nmcli connection up eno12399` is less disruptive than restarting the service.

After the manual fix, immediately re-express the same profile through the declarative node-configuration surface; otherwise the next reconcile (or a node replacement) is likely to recreate the duplicate.

## Diagnostic Steps

Identify which keyfiles NetworkManager is currently honoring on a node:

```bash
chroot /host nmcli -f NAME,UUID,DEVICE,FILENAME connection show
```

Look for two rows that name the same `DEVICE` (`eno12399`); their `FILENAME` columns reveal which file the duplicate UUID was appended to.

Confirm whether the canonical file is the one actually applied:

```bash
chroot /host nmcli -g GENERAL.CON-PATH device show eno12399
```

The output should be `/etc/NetworkManager/system-connections/eno12399.nmconnection`. If it points at the UUID-suffixed file, NetworkManager is still using the duplicate — re-apply the declarative profile and reload.

Verify NetworkManager picked up the cleanup without dropping the link:

```bash
chroot /host journalctl -u NetworkManager --since "5 min ago" | grep -i eno12399
chroot /host ip -br addr show dev eno12399
```

If a node continues to materialise the UUID-suffixed file after every reconcile, two declarative profiles likely target the same `interface-name`. Inspect the rendered `NodeConfig`/`MachineProfile` set for the node pool and remove the redundant entry.
