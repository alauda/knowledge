---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Diagnosing Guest OS Restarts Caused by Storage Fabric Instability
## Issue

A virtual machine workload exhibits unexplained guest-OS restarts, freezes lasting tens of seconds, or — for Windows guests — a Blue Screen of Death (BSOD) followed by an automatic reboot. The platform reports the VM as Running, the `virt-launcher` pod has not been evicted or OOM-killed, and `kubectl get vmi` shows no recent live-migration events. Inside the guest, the event log shows symptoms that look like a kernel hang (Linux: `task ... blocked for more than 120 seconds`; Windows: `IO_REQUEST_NOT_SERVICED` in the bugcheck data, often with stop code `0x9C` or `0xCD`).

The recurring question: is this a problem inside the guest, or is the underlying storage fabric stalling I/O long enough that the guest gives up?

## Root Cause

A guest OS sees its virtual disks through `virtio-blk` or `virtio-scsi`. Those devices are backed by a kernel block-layer pipeline on the host: file system → multipath → HBA driver → fabric. If the fabric (FC, iSCSI, NVMe-oF) becomes unresponsive for longer than the guest's I/O timeout (Linux default 30 s, Windows default 60 s with disk class), the guest concludes the disk is dead. Linux marks I/O failed and may panic; Windows triggers a stop code and reboots.

From outside the guest the easiest signature of fabric stalling is `node_disk_io_time_seconds_total` from the Prometheus `node-exporter`. The metric records the total time the host's block device spent servicing I/O. When the fabric stalls, the rate of this metric *flat-tops* at its theoretical maximum (1 second per second per device) — every second of wall time, every device records a full second of "I/O in progress". A short stall produces a brief plateau; a fabric reset produces a multi-minute one. Stable infrastructure produces a noisy line well below the cap.

## Resolution

The fix for fabric instability lives below this diagnosis (replace flapping HBA, reset switch, throttle a noisy neighbour) — but you must first prove the cause is the fabric and not the guest. The procedure below establishes the causal chain.

### Step 1: Find the Affected Worker

Identify which worker node is hosting the unhappy VM at the moment of the freeze:

```bash
kubectl get vmi <vmi-name> -n <namespace> \
  -o jsonpath='{.status.nodeName}'
```

Lock that node name in — every Prometheus query below is keyed by it.

### Step 2: Query node_disk_io_time_seconds_total

In the platform's monitoring console, run the following PromQL. The window of 5 minutes is long enough to absorb the typical fabric-reset duration.

```promql
rate(node_disk_io_time_seconds_total{instance=~"<worker-node-ip>:.*"}[5m])
```

Read the chart along the time axis covering the freeze:

| Pattern | Interpretation |
|---|---|
| Line stays well below 1.0 across all devices | Fabric is healthy. Look elsewhere. |
| Line for one device hits exactly 1.0 and stays there for ≥ 30 s | That device is stalled. Investigate the HBA / multipath / switch path for that device. |
| Multiple devices hit 1.0 simultaneously | Fabric-wide event (switch reset, controller failover). |

A *plateau* — a flat-topped region — is the diagnostic. Brief peaks below 1.0 are normal load.

### Step 3: Cross-Reference With Multipath and Kernel Events

If Step 2 shows a plateau, drill down into the kernel events on that node to identify which fabric path failed:

```bash
# Open a debug shell on the affected node
kubectl debug node/<node-name> -it --image=registry.alauda.cn:60070/acp/alb-nginx:v4.3.1

# Inside the debug pod, look for fabric-layer messages
chroot /host
journalctl --since '15 minutes ago' --no-pager \
  | grep -iE 'multipath|hba|qla|lpfc|nvme|fcoe|iscsi'
```

Typical signatures:

- `multipathd: failed pathgroup`, followed by a `reinstating` line later — the path went away and came back; that interval is the plateau in your Prometheus chart.
- `qla2xxx: ... NPIV port reinstate failed` — Fibre Channel path failure on Qlogic HBA.
- `nvme0: I/O 13 QID 6 timeout, completion polled` — NVMe-oF queue stall.

The kernel timestamps line up with the start and end of the Prometheus plateau; that alignment is the proof.

### Step 4: Confirm the Guest Symptom is Downstream

The final causal link is to verify the guest symptom (freeze, BSOD, kernel panic) timestamps fall *inside* the fabric stall window, not before it:

```bash
# Look at the virt-launcher pod's events around the same time
kubectl get events -n <namespace> \
  --field-selector involvedObject.name=virt-launcher-<vmi-name> \
  --sort-by='.lastTimestamp'
```

If the guest symptom precedes the plateau, the guest froze independently and stopping the fabric merely manifested it. If the symptom is inside the plateau, the fabric is the cause.

## Diagnostic Steps

A quick triage script that prints the worst-offending device per node over the last hour:

```bash
# Requires `mc` for the platform's monitoring API or use the web UI.
# This shows the same conclusion the PromQL above would reach, but as a
# table for batch review across nodes.
cat <<'EOF'
PromQL:
  topk(5,
    max_over_time(
      rate(node_disk_io_time_seconds_total[1m])[1h:1m]
    ) by (instance, device)
  )
EOF
```

A device whose `max_over_time` is at or very close to 1.0 has experienced a stall in the last hour. Cross-reference the `instance` to the worker that was hosting the freezing VM at that time — they should match. If they do not, you are chasing the wrong node.

When the same device repeatedly plateaus, escalate the underlying fabric or HBA — the platform-side fix is a node drain plus VM live migration onto a worker with a healthy fabric path while the failed component is replaced.
</content>
