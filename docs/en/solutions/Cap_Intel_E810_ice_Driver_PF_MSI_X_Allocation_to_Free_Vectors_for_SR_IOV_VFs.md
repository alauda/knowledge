---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Cap Intel E810 ice Driver PF MSI-X Allocation to Free Vectors for SR-IOV VFs
## Issue

On worker nodes with high CPU counts and an Intel E810 (`ice` driver) NIC, the Physical Function (PF) reserves MSI-X interrupt vectors proportional to the host's online CPUs. The E810 has a finite total MSI-X vector pool; when the PF claims most of it, SR-IOV Virtual Functions (VFs) are left with too few queues for adequate Receive Side Scaling (RSS) performance — VF receive throughput drops, latency spikes under load, and per-VF queue depth becomes a bottleneck.

## Root Cause

The `ice` kernel driver's default behavior is to scale PF MSI-X reservation to the lower of `num_online_cpus()` and the per-PF firmware ceiling. On a 96-thread node, the PF can claim 96 vectors out of the device's roughly 1000-vector pool, multiplied by the number of PFs on the same NIC. With 4 PFs that is up to 384 vectors gone before VFs even exist; with `numvfs > 32` per PF the per-VF allocation drops below the recommended 16-queue minimum for 25 GbE line-rate.

The fix is to constrain the PF's MSI-X reservation explicitly via the `devlink` parameter `msix_vec_per_pf_max`, then trim the PF's active channel count with `ethtool -L combined N`, freeing the surplus vectors for redistribution to VFs at SR-IOV enable time.

## Resolution

The change must be applied **before** VFs are created — the driver allocates the vector pool at PF probe and again at SR-IOV enable. Three deliveries:

### Step 1 — Determine the right cap value

Inspect the device pool and current PF allocation:

```bash
# vector pool exposed by the device
devlink dev info pci/0000:b1:00.0 | grep msix
devlink resource show pci/0000:b1:00.0
# current PF MSI-X
ethtool -l <ifname>
```

Compute the per-PF cap as:

```text
cap_per_pf = floor(total_pool / num_PFs) - vf_reserve
where vf_reserve >= num_VFs * desired_VF_queues
```

For a 4-PF NIC with 1000-vector pool, 8 VFs/PF at 16 queues each: `cap = 1000/4 - 8*16 = 250 - 128 = 122`. Round down to a power of two (`64`) for predictable RSS spread.

### Step 2 — Apply the cap with devlink

```bash
devlink dev param set pci/0000:b1:00.0 \
    name msix_vec_per_pf_max value 64 cmode driverinit
devlink dev reload pci/0000:b1:00.0
```

`cmode driverinit` defers the value until the next driver init; `devlink dev reload` triggers that init in place without rebooting the host.

### Step 3 — Trim the PF's active channels

```bash
ethtool -L <ifname> combined 32
```

This shrinks the PF's channel ring to 32 queues; the rest of the now-released vectors become available for VFs once SR-IOV is enabled.

### Step 4 — Make the change persistent

For Pattern A (declarative through the platform's node-config workflow), package the commands as a systemd oneshot unit and a udev rule so they re-apply at boot before the network stack comes up:

```text
# /etc/systemd/system/glean-ice-msix.service
[Unit]
Description=Cap ice PF MSI-X to free vectors for SR-IOV VFs
After=systemd-modules-load.service
Before=network.target sriov-config.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/glean-ice-msix.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
# /usr/local/sbin/glean-ice-msix.sh
#!/bin/sh
set -e
for pci in /sys/bus/pci/drivers/ice/0000:*; do
    bdf=$(basename "$pci")
    devlink dev param set "pci/$bdf" name msix_vec_per_pf_max value 64 cmode driverinit || true
    devlink dev reload "pci/$bdf" || true
done
for nic in $(ls -1 /sys/class/net | grep -v lo); do
    drv=$(ethtool -i "$nic" 2>/dev/null | awk '/^driver:/{print $2}')
    [ "$drv" = "ice" ] && ethtool -L "$nic" combined 32 || true
done
```

Wrap both files into the platform's node configuration mechanism (`configure/clusters/nodes` for in-place edits, or the Immutable Infrastructure workflow for image-rebuild deliveries), targeted only at the SR-IOV-bearing node pool.

### Step 5 — Enable SR-IOV VFs after the cap is in effect

Either through the SR-IOV Network Operator's `SriovNetworkNodePolicy` CRD or through `echo N > /sys/class/net/<ifname>/device/sriov_numvfs`. The freshly-allocated VFs now receive the vectors freed by the PF cap.

## Diagnostic Steps

To confirm the cap is in effect:

```bash
devlink dev param show pci/0000:b1:00.0 name msix_vec_per_pf_max
ethtool -l <ifname>          # PF channel count
```

To confirm the VFs received enough vectors:

```bash
ethtool -l <vf-ifname>       # combined channel count on each VF
cat /proc/interrupts | grep <vf-ifname>
```

If VF channel count is stuck below the desired RSS spread, the kernel may have applied the PF cap but the SR-IOV enable raced ahead. Re-run `devlink dev reload` followed by `ethtool -L`, then disable + re-enable VFs:

```bash
echo 0 > /sys/class/net/<ifname>/device/sriov_numvfs
echo 8 > /sys/class/net/<ifname>/device/sriov_numvfs
```

If the change does not survive reboot, the systemd unit is firing too late. Confirm it sequences `Before=sriov-config.service` and that `udevadm settle` resolves before `ExecStart` runs.
