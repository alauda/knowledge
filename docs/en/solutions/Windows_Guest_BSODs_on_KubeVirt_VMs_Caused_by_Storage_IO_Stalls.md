---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Microsoft Windows guests running on Alauda Container Platform Virtualization fall into intermittent Blue Screen of Death (BSOD) events. The bug-check codes vary but cluster around memory and paging:

- `0x1A` MEMORY MANAGEMENT (most common)
- `0x7A` KERNEL DATA INPAGE ERROR
- `0x50` PAGE FAULT IN NONPAGED AREA
- `0xEF` CRITICAL PROCESS DIED

The crashes are not reproducible by guest workload alone — they appear randomly under load and the corresponding KubeVirt event log on the host shows no fault on the virt-launcher pod itself.

## Root Cause

Windows declares its block stack to be wedged once an I/O has not returned for the configured timeout (60 seconds by default for the `viostor`/`vioscsi` virtio drivers). When the storage backend behind the VM disk does take longer than that — slow Ceph RBD recovery, busy NFS export, congested cloud volume, etc. — the guest's `nt!MiWaitForInPageComplete` path eventually trips an `nt!MiReportPageHashError` and the kernel halts with one of the codes above.

A WinDbg trace from such a dump typically shows:

```text
0: kd> k
00 nt!KeBugCheckEx
01 nt!MiReportPageHashError+0x25
02 nt!MiValidatePagefilePageHash+0x30e
03 nt!MiWaitForInPageComplete+0x1828c6
04 nt!MiIssueHardFault+0x1ad
05 nt!MmAccessFault+0x32f
06 nt!KiPageFault+0x358
```

A separate but related virtio-win driver issue — incorrect transfer length on bus reset — used to mask this with a `MEMORY MANAGEMENT` code; updated virtio-win drivers turn the symptom into the more accurate `CRITICAL PROCESS DIED`. The underlying cause (storage stall longer than the guest timeout) is unchanged.

## Resolution

Treat the BSOD as a downstream symptom of latency in the storage path. Fix the storage first; only use the registry workaround as a temporary cushion.

### 1. Verify the storage path under load

For each backing PVC the failing VM uses:

```bash
kubectl -n <ns> get pvc <pvc> -o jsonpath='{.spec.storageClassName}{"\n"}'
kubectl get sc <sc> -o yaml
```

Identify the provisioner and check it from the side normally responsible for it:

- Block (Ceph RBD, iSCSI, cloud disk) — confirm there is no degraded OSD / locked image / throttled volume during the BSOD window. From the Ceph toolbox: `ceph -s`, `ceph osd perf`, `rbd status <pool>/<image>`.
- File (NFS, CephFS) — check the export server for `nfsiostat`/`mountstats`-level latencies. Mount-level slow-downs above ~30 s correlate strongly with these BSODs.

Cross-reference timestamps with the VM's host:

```bash
kubectl debug node/<host> -- chroot /host \
  journalctl -u kubelet --since "<bsod-time -2m>" --until "<bsod-time +2m>"
```

Look for any `task <virt-launcher-pid> blocked for more than 120 seconds` or qemu I/O completion timeouts in `dmesg`.

### 2. Right-size guest RAM

Frequent paging makes the BSOD more likely because every page fault becomes another potential storage stall. Confirm the VM has enough memory not to thrash:

```bash
kubectl -n <ns> get vm <vm> -o jsonpath='{.spec.template.spec.domain.resources.requests.memory}{"\n"}'
```

Compare with the guest's actual working set (Performance Monitor → Memory → Available MBytes). If the VM is constantly under 10% free, raise the request before chasing the storage further.

### 3. Temporary workaround — extend the guest virtio I/O timeout

Only use this while the storage cause is being investigated. Higher timeouts let the guest survive longer stalls but will also delay genuine error recovery, so do not leave them in place permanently.

Inside the Windows guest, set:

```text
HKLM\System\CurrentControlSet\Services\viostor\Parameters\IoTimeoutValue = REG_DWORD 120
HKLM\System\CurrentControlSet\Services\vioscsi\Parameters\IoTimeoutValue = REG_DWORD 120
```

Reboot the guest. The 120-second value (instead of the default 60) is enough to cover most transient backend stalls.

### 4. Update the virtio-win drivers

If running an older virtio-win build, update to a recent release. This will not eliminate the BSODs caused by real storage stalls, but it does prevent a separate driver bug (transfer length on reset) from layering an additional MEMORY MANAGEMENT crash on top, making future diagnosis cleaner.

## Diagnostic Steps

1. Capture the BSOD details from inside the guest console: stop code, parameters, and (if a kernel dump is configured) the WinDbg `!analyze -v` output. Look for `MiReportPageHashError` in the stack — that confirms a paging-side stall as opposed to e.g. a driver bug.

2. Get the qemu-side view from the virt-launcher pod:

   ```bash
   kubectl -n <ns> logs <virt-launcher-pod> -c compute | grep -i 'I/O.*\(stall\|timeout\)'
   ```

3. Trend the storage backend latency for the affected PVC over the BSOD window using the platform's monitoring stack:

   ```text
   histogram_quantile(0.99,
     rate(node_disk_io_time_weighted_seconds_total{
            device=~"rbd[0-9]+",
            instance="<host>"}[1m]))
   ```

   Sustained p99 above the guest's `IoTimeoutValue` is the smoking gun.

4. If the storage is healthy and the BSODs persist, the issue may be a separate low-latency-storage driver corner case rather than a stall — check the virtio-win release notes for known driver bugs in the version installed in the guest before raising the timeout further.
