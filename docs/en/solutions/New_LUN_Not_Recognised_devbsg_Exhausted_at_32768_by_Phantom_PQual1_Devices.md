---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# New LUN Not Recognised — `/dev/bsg` Exhausted at 32768 by Phantom (PQual=1) Devices
## Issue

A newly-allocated LUN or PV on a SAN-backed storage device is not recognised by a cluster node. Workloads that depend on the new LUN — pods with PVCs, VMs with attached disks — fail to start because the OS never presents a `sdX` block device for the LUN. The kernel's `dmesg` / journal surfaces a SCSI subsystem error pointing at the `bsg` layer rather than the storage path:

```text
sd H:C:T:L: bsg: too many bsg devices
sd H:C:T:L: Failed to register bsg queue, errno=-28
```

A quick inspection of `/dev/bsg/` shows the limit has been hit:

```bash
ls /dev/bsg/ | wc -l
# 32768
```

But the actual number of `sdX` block devices on the host is much smaller — maybe a few dozen. The `bsg` exhaustion is not caused by too many usable disks; it is caused by the kernel registering `bsg` entries for **phantom LUNs** that the SAN reports but never actually serves.

## Root Cause

Each SCSI device the kernel detects during a SCSI bus scan receives both a high-level block interface (`sdX`) and a generic SCSI interface (`sgN` / `bsg` entry). The block interface attaches only for devices that report themselves as fully-present in the bus-scan response. The generic `bsg` interface attaches **regardless** of the device's state — it is the administrative side-channel and is meant to exist for any target the initiator can see.

A SAN target that is currently reporting "hey I can talk to you but I have nothing allocated yet" sends back a response with **PQual=1** (Peripheral Qualifier = 1). PQual=1 means "the target position is real but no logical unit is currently attached". The kernel's `sd` driver correctly refuses to attach `sdX` to a PQual=1 device; the `bsg` subsystem still allocates an entry for it.

When a SAN is misconfigured — auto-registers the host, exposes a large number of LUN IDs, most of them unused — each of those unused IDs returns PQual=1. The initiator's `bsg` slots fill up with phantom devices. On Linux kernel versions where `BSG_MAX_DEVS` is hard-coded at 32768, that ceiling is reached quickly; every new real LUN that should genuinely get a `sdX` cannot register its `bsg` entry, fails the allocation with `errno=-28`, and the SCSI mid-layer treats the whole registration as failed.

The net effect: real LUNs the storage team just allocated cannot be used because the `bsg` table is full of phantoms from LUNs that were never meant to be active.

## Resolution

The durable fix is on the SAN side — the storage and networking teams own the configuration that creates the phantom LUNs. Clean up on the SAN and the phantoms age out of the initiator over minutes to hours.

### Step 1 — identify phantom (PQual=1) entries on the affected node

The `sg_inq` tool queries each `bsg` device for its Peripheral Qualifier:

```bash
NODE=<node>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c '
    for bsg in /dev/bsg/*; do
      case "$(basename "$bsg")" in
        *:*:*:*)
          pq=$(sg_inq "$bsg" 2>/dev/null | grep -oE "PQual=[0-9]")
          printf "%s\t%s\n" "$bsg" "${pq:-PQual=?}"
          ;;
      esac
    done | awk -F"\t" "\$2==\"PQual=1\" {print; c++} END { print \"Total PQual=1:\", c }"
  '
```

Run against an affected node. A count in the thousands (or up to the full 32768) is the phantom-overflow shape.

The specific Vendor / Product strings inside each phantom also come out of `sg_inq <bsg>`. Note the vendors — that identifies which storage appliance is producing the phantoms:

```bash
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c 'sg_inq /dev/bsg/0:0:0:1 2>/dev/null | grep -E "Vendor|Product"'
```

### Step 2 — fix the SAN-side configuration

The actionable work is with the storage team:

- **Remove incorrect mappings** from the SAN. LUNs that are visible to the host but should not be — because the host is not supposed to use them, or because they were part of an old deployment — should be unmapped.
- **Narrow zone configuration**. In an FC SAN, a host's zone should only include the targets whose LUNs that host will actually use. Over-permissive zones invite unnecessary target registration and the PQual=1 cascade.
- **Audit migrations**. If the node was recently migrated from an old storage environment to a new one, both sides need cleanup — the old environment's LUN mappings, and the new environment's auto-registration behaviour.

Once the SAN's configuration is tight, phantom LUN responses stop appearing in the initiator's scan, and existing phantoms age out.

### Step 3 — let phantoms clear

The initiator does not immediately release phantom `bsg` entries. Even after a `rescan-scsi-bus.sh` or a node reboot, phantoms that were registered in the kernel's state take minutes to hours to fully disappear. Workloads that need the new LUN urgently may need to wait:

```bash
# Trigger a rescan to pick up the cleanup.
kubectl debug node/$NODE --image=busybox -- \
  chroot /host rescan-scsi-bus.sh

# Watch the bsg count drop over time.
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c 'while :; do echo "$(date) bsg=$(ls /dev/bsg | wc -l)"; sleep 60; done' &
```

The count should trend down. When it falls below the 32768 ceiling by a comfortable margin, new LUN registrations succeed again.

### Node reboot as a last resort

Rebooting the node clears the `bsg` table completely at boot, which reestablishes a clean starting point. But if the SAN-side misconfiguration has not been fixed, phantoms begin registering again immediately and the limit is re-hit within hours. Reboot only after step 2 has been done; otherwise the reboot wastes a maintenance window for no durable gain.

### Newer kernel releases

On kernels where `BSG_MAX_DEVS` is variable (a much larger default, sometimes `2^20`), the immediate exhaustion is far less likely. If the cluster's node OS is on such a kernel, the node can absorb a larger number of phantoms without reaching the ceiling — but the SAN-side cleanup is still the right fix; the larger ceiling just gives more headroom.

### Do not

- **Do not manually `rm /dev/bsg/<entry>`.** It removes the `bsg` entry but does not update the SCSI mid-layer's view — the mid-layer still thinks the slot is in use. Subsequent rescans may re-register the phantom in a different slot.
- **Do not patch the kernel's `BSG_MAX_DEVS`** on production nodes as a one-off. It is not a supported configuration change and carries risk around kernel state management.

## Diagnostic Steps

Confirm the error is a `bsg` exhaustion:

```bash
NODE=<affected-node>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host dmesg -T | grep -iE 'bsg.*too many|Failed to register bsg' | tail -5
```

If the lines are present on any `H:C:T:L` tuple, the bus scan hit the ceiling.

Count `bsg` entries:

```bash
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c 'ls /dev/bsg/ | wc -l'
# 32768 — ceiling reached.
```

Sample phantom entries:

```bash
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c '
    sg_inq /dev/bsg/0:0:0:1 2>/dev/null | grep -E "PQual|Vendor|Product"
    sg_inq /dev/bsg/0:0:0:2 2>/dev/null | grep -E "PQual|Vendor|Product"
  '
```

`PQual=1` with empty Vendor/Product fields confirms the phantoms.

After SAN-side cleanup, monitor the `bsg` count trend over the next hour; it should fall steadily. When it drops well below 32768, the originally-failed LUN registration can be retried:

```bash
# Retry a rescan after the count normalises.
kubectl debug node/$NODE --image=busybox -- \
  chroot /host rescan-scsi-bus.sh --add-new-targets
```

The new LUN should then appear as `/dev/sdX`, and the workload depending on it starts succeeding.
