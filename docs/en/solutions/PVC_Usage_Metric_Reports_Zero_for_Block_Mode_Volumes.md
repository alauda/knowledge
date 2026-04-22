---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A PersistentVolumeClaim used by a VirtualMachine (or any workload consuming raw block storage) shows zero used bytes in the platform's dashboards:

- `kubelet_volume_stats_used_bytes` returns `0`.
- The console's PVC usage gauge reads 0% even though the guest filesystem reports the disk is nearly full.
- Storage silently fills to capacity, and the VM eventually pauses with an `I/O error`.

The mismatch is not cosmetic — without a working usage metric, alerting and capacity planning are both blind.

## Root Cause

`kubelet_volume_stats_used_bytes` is populated from the CSI `NodeGetVolumeStats` RPC. For filesystem-mode PVs, the driver mounts the volume and reports `df`-style usage back. For **block-mode** PVs, there is no filesystem at the PVC layer — the volume is a raw device handed straight to the consumer. The CSI specification explicitly makes `used_bytes` / `available_bytes` **optional** for block volumes, and many driver implementations either omit the RPC entirely or return zeros.

When an application (VirtualMachine, database with direct block I/O, raw-device logger) puts a filesystem on that block device, the usage exists — just not at a layer the kubelet can see. The guest knows its `/var/log` is 95% full; the CSI driver sees a raw device that is 100% "allocated" and nothing else.

## Resolution

Move the observation point to where the usage actually lives, and enable space reclamation so the backend storage is not forever inflated.

1. **Read usage from the guest or the consumer**, not from the PVC metric. For VirtualMachines, the VM details page in ACP Virtualization exposes per-mount-point usage that comes from the guest agent (qemu-guest-agent on Linux, virtio-serial channel on Windows). Ensure the guest agent is installed and running in every VM that needs a usage metric.

   For non-virtual consumers of block PVs, scrape the application's own metric endpoint (Postgres `pg_database_size`, Redis `used_memory_rss`, etc.) instead of the PVC metric.

2. **Add a node-exporter-style collector for the guest filesystem** when you need a unified dashboard across VMs and pods. Deploy the telemetry agent inside the VM image so the guest's `df` output lands in the platform's metrics pipeline via `node_filesystem_*` series labelled with the VM name.

3. **Enable block-level space reclamation.** Without `discard`, deletes inside the guest do not return blocks to the storage backend, so even a working usage metric would show the volume as always-full:

   - On the PV's mount options (filesystem PV backed by a thin provisioner):

     ```yaml
     apiVersion: v1
     kind: PersistentVolume
     metadata:
       name: data-pv
     spec:
       mountOptions:
         - discard
     ```

   - Inside the VM guest, schedule `fstrim` (Linux) or ensure the guest filesystem advertises `Defrag` / TRIM (Windows):

     ```bash
     # systemd timer on every Linux guest that ships fstrim.timer
     sudo systemctl enable --now fstrim.timer
     ```

   - For databases that over-provision, rebuild indexes periodically to release reclaimable pages.

4. **Escalate to the storage vendor when you need backend-visible metrics.** Most enterprise CSI drivers have an opt-in to expose backend LUN utilisation through their own `/metrics` endpoint — the data is there, it just does not flow through `NodeGetVolumeStats`. Add the vendor's ServiceMonitor to Prometheus rather than trying to coerce the kubelet metric into reporting something it cannot.

5. **Write alerts against the right signal.** Replace `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.85` with a VM-guest metric or the vendor's utilisation metric; the kubelet metric is structurally wrong for block PVs and cannot be made correct.

## Diagnostic Steps

Confirm the volume is block-mode:

```bash
kubectl get pvc -n <ns> <pvc> -o jsonpath='{.spec.volumeMode}{"\n"}'
# Block
kubectl get pv $(kubectl get pvc -n <ns> <pvc> -o jsonpath='{.spec.volumeName}') \
  -o jsonpath='{.spec.volumeMode}{"\n"}'
```

Check the PVC usage metric and see whether the driver returned anything:

```bash
kubectl -n monitoring exec -it $(kubectl -n monitoring get pod -l prometheus=k8s -o name | head -1) -c prometheus -- \
  sh -c 'wget -qO- "http://localhost:9090/api/v1/query?query=kubelet_volume_stats_used_bytes{persistentvolumeclaim=\"<pvc>\"}" | jq .'
```

A `result` array with a value of `"0"` (or no result at all) matches the failure mode. Verify the driver implements `NODE_GET_VOLUME_STATS`:

```bash
kubectl -n <csi-ns> get csinode -o json | jq '.items[].spec.drivers'
kubectl describe csidriver <driver-name>
```

Compare to the truth on the consumer side. For VirtualMachines:

```bash
kubectl get vm <vm> -o jsonpath='{.status.volumeStatus}'
# or, on the running VM via the VM-detail page, read the guest-reported usage
```

If the guest says `95%` and the PVC metric says `0%`, you are looking at exactly the issue above — plan around it rather than waiting for the metric to start reporting.
