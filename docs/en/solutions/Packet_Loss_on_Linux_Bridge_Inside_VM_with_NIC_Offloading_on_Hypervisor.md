---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Packet Loss on Linux Bridge Inside VM with NIC Offloading on Hypervisor
## Issue

A guest VM running on Alauda Container Platform Virtualization shows TX drops and severely degraded throughput when traffic is forwarded through a Linux bridge inside the VM — typically when `podman` (or a nested Kubernetes node) is using a default bridge network on the guest. Curl downloads from external hosts plateau at a fraction of expected throughput; `ip -s -d link` on the guest bridge counts steady TX errors. The same VM with traffic going straight out (no inner bridge) does not lose packets.

The pattern reported in the field uses Intel E810 (ice driver) NICs on the hypervisor with stock NIC offloads enabled.

## Root Cause

A kernel `sk_buff` is arriving at the host's GSO engine with a malformed `gso_type` — TCP-over-IPv4 traffic, but the buffer is not flagged as `SKB_GSO_TCPV4`. The check at the top of `tcp4_gso_segment()` then bails with `-EINVAL` and the kernel drops the segment. The remote end retransmits with smaller packets (which do get through) but the connection is throttled by retransmit timers, hence the slow throughput.

A vmcore captured at the moment of drop confirms the bad metadata:

```text
crash> skb_shared_info 0xff43...
struct skb_shared_info {
  flags = 0x0,
  gso_size = 0x542,
  gso_segs = 0x0,
  gso_type = 0x12,    /* 0x10 SKB_GSO_TCPV6 | 0x02 SKB_GSO_DODGY */
                      /* 0x01 SKB_GSO_TCPV4 NOT set                 */
  ...
};
```

The mismatched `gso_type` is produced upstream of the bridge — by the hypervisor NIC driver / kernel offload path bridging through a virtio-net front-end into a guest where another bridge re-aggregates packets. The combination of stock kernel ice driver and stock NIC offloads on the affected hypervisor build is what generates the bad descriptors; later kernels in the 5.14 line have the fix.

## Resolution

Two viable fixes; pick the one that matches your operational constraints.

### Update the hypervisor kernel

Roll the affected hypervisor nodes onto a kernel build in which the ice GSO descriptor handling is fixed (5.14.0-427.79.1 or newer in the el9.4 line). The bug is non-reproducible after the upgrade. Verify with:

```bash
kubectl debug node/<host> -- chroot /host uname -r
```

If the node OS image is image-based and updates ship through the platform's node-update mechanism, request the update through that path rather than running `dnf` by hand on a single node — otherwise the patched kernel will be reverted on the next image roll-out.

### Disable problematic offloads on the physical NIC

If the kernel update cannot be scheduled immediately, disable the offload engines on the affected NIC so the bad descriptors never reach the GSO path:

```bash
kubectl debug node/<host> -- chroot /host \
  ethtool -K <nic> rx off tx off gso off gro off tso off sg off \
                  rx-gro-list off tx-gso-partial off
```

Verify with `ethtool -k <nic>` that all the toggles report `off [fixed]` or just `off`. Throughput drops on chips that rely heavily on hardware offload — measure before/after — but the per-segment drops should disappear.

To make the change survive a reboot, write it through the platform's node configuration mechanism (the same one used for sysctls or chrony), so the offloads are reapplied during early boot. Do not rely on a one-shot `ethtool` invocation: any node restart, NIC reset, or image roll-out will undo it.

## Diagnostic Steps

Confirm the failure mode before taking remediation:

1. From inside the guest, watch the bridge's TX-error counter while running a download:

   ```bash
   ip -s -d link show <br0>
   curl -o /dev/null https://<external-host>/large-file
   ip -s -d link show <br0>
   ```

   A steady, monotonically rising `TX errors` counter on the bridge while throughput is far below link speed matches the symptom.

2. From the hypervisor, capture on the physical NIC and look for retransmits / missing segments tied to a single TCP flow:

   ```bash
   kubectl debug node/<host> -- chroot /host \
     tcpdump -nei <nic> -s 96 host <external-host> and tcp port 443
   ```

3. Inspect the NIC's hardware offload state:

   ```bash
   kubectl debug node/<host> -- chroot /host ethtool -k <nic> | head -30
   ```

   If the issue stops after disabling offloads, the bug is the GSO descriptor path described above. If it persists, the cause is elsewhere (MTU mismatch on the bridge, conntrack overflow on the host, etc.) and offload tuning will not help.

4. If a vmcore is available, the smoking gun is the `gso_type` not having bit 0 (`SKB_GSO_TCPV4`) set on a packet `tcp4_gso_segment` is processing — the same evidence shown in the Root Cause section.
