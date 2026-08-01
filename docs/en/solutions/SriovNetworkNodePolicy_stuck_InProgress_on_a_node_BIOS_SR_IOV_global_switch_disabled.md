---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# SriovNetworkNodePolicy stuck InProgress on a node — BIOS SR-IOV global switch disabled
## Issue

A `SriovNetworkNodePolicy` that targets all worker nodes succeeds on most of them but stays `InProgress` on one (or a small subset). On the affected node:

- No Virtual Functions (VFs) appear under the targeted PCI device.
- `SriovNetworkNodeState` for the node never leaves `InProgress`:

  ```text
  NAMESPACE       NAME                              SYNC STATUS   DESIRED SYNC STATE   CURRENT SYNC STATE   AGE
  sriov-operator  worker13.cluster.example.com      InProgress    Idle                                       141m
  sriov-operator  worker1.cluster.example.com       Succeeded     Idle                 Idle                 141m
  ```

- The `sriov-network-config-daemon` log on the failing node shows the kernel rejecting the request to allocate VFs:

  ```text
  ERROR sriov/sriov.go:550 configSriovPFDevice():
    fail to set NumVfs for device {"device": "0000:b0:00.0",
    "error": "write /sys/bus/pci/devices/0000:b0:00.0/sriov_numvfs: cannot allocate memory"}
  ```

- The host's kernel ring buffer carries:

  ```text
  mlx5_core 0000:b0:00.0: not enough MMIO resources for SR-IOV
  ```

## Root Cause

`cannot allocate memory` on `sriov_numvfs` is the kernel reporting that there is not enough PCIe MMIO BAR space available to instantiate the VFs. Each VF needs its own MMIO window. If the firmware has not enabled SR-IOV at the chipset level, the BIOS does not enlarge the BAR allocation that the PCIe root complex hands to the VF-capable Physical Function — so even a healthy NIC and a correctly configured `SriovNetworkNodePolicy` cannot create the requested VFs. The driver-level message (`not enough MMIO resources`) is the same for any other root cause that constrains BAR allocation, but on production hardware with a single `SriovNetworkNodePolicy` failing per-node, the BIOS toggle is the canonical case.

The SR-IOV operator does not (and cannot) flip BIOS settings — it operates at the kernel layer. Until the firmware enables the global SR-IOV switch, the daemon will retry forever and `SriovNetworkNodeState` stays `InProgress`.

## Resolution

Enable the global SR-IOV switch in the firmware, then reboot the node so the BIOS hands a larger MMIO window to the VF-capable PCIe slots.

### 1. Enable SR-IOV in BIOS

The label varies by vendor. Common locations:

- **Dell servers**: iDRAC UI → **Configuration → BIOS Settings → Integrated Devices → SR-IOV Global Enable** → **Enabled**. Equivalent on the BIOS POST screen under **Integrated Devices**.
- **HPE / HPE iLO**: System Configuration → BIOS/Platform Configuration (RBSU) → System Options → Processor Options → **Intel(R) VT-d** + RBSU → PCI Device Enable/Disable → **SR-IOV** → **Enabled**.
- **Lenovo**: System Settings → Devices and I/O Ports → **PCIe SR-IOV Configuration** → **Enabled**.
- **Supermicro**: Advanced → PCIe/PCI/PnP Configuration → **SR-IOV Support** → **Enabled**.

On servers managed by Redfish, `Bios.Attributes.SriovGlobalEnable` (or vendor-equivalent) can be flipped over the API; combine with a graceful reboot orchestrated by the cluster:

```bash
kubectl cordon <node>
kubectl drain  <node> --ignore-daemonsets --delete-emptydir-data --disable-eviction
# trigger the BIOS-level reconfig + reboot via vendor tooling
kubectl uncordon <node>
```

### 2. Confirm VFs appear

After the node returns:

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
  -- chroot /host bash -c '
    lspci -s 0000:b0:00.0 -vvv | grep -i sr-iov
    cat /sys/bus/pci/devices/0000:b0:00.0/sriov_totalvfs
    cat /sys/bus/pci/devices/0000:b0:00.0/sriov_numvfs
  '
```

`sriov_totalvfs` reflects the firmware-advertised VF capacity; `sriov_numvfs` should now move from 0 toward the `numVfs` requested by the policy as the daemon reconciles.

### 3. Confirm the policy reconciled

```bash
kubectl get sriovnetworknodestate -A
kubectl logs -n <sriov-namespace> -l app=sriov-network-config-daemon \
  --tail=100 | grep -E "configSriovPFDevice|NumVfs"
```

The targeted node should reach `SYNC STATUS: Succeeded`; the daemon should log `configSriovPFDevice()` success without the `cannot allocate memory` line.

## Diagnostic Steps

1. Pin the failure to a single node — compare `SriovNetworkNodeState` across the cluster:

   ```bash
   kubectl get sriovnetworknodestate -A -o wide
   ```

2. Pull the daemon log on the failing node and isolate the device that the kernel is rejecting:

   ```bash
   kubectl logs -n <sriov-namespace> sriov-network-config-daemon-<node-suffix> \
     --tail=200 | grep -E "ERROR|sriov_numvfs"
   ```

3. From the node host context, confirm the BIOS-level cap. If `sriov_totalvfs` is `0` while the same NIC on a healthy node reports a non-zero number, BIOS is the culprit:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host bash -c '
       for pci in /sys/bus/pci/devices/*/sriov_totalvfs; do
         dev=$(echo "$pci" | cut -d/ -f6)
         total=$(cat "$pci")
         echo "$dev  totalvfs=$total"
       done | grep -v " totalvfs=0$"
     '
   ```

4. Cross-check the kernel ring buffer for the `not enough MMIO resources for SR-IOV` line — it is the host-side echo of the same condition:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host dmesg -T | grep -iE "sr-iov|mmio resources"
   ```
