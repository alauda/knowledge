---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Why kubelet_volume_stats metrics are missing for third-party CSI volumes
## Issue

Persistent Volumes provisioned by a third-party CSI driver (Portworx, Pure
PSO, NetApp Trident, etc.) fill up without producing the usual capacity
alerts. Querying Prometheus for the standard volume stats series yields no
data:

```text
kubelet_volume_stats_used_bytes{persistentvolumeclaim="..."}     # empty
kubelet_volume_stats_available_bytes{persistentvolumeclaim="..."} # empty
kubelet_volume_stats_capacity_bytes{persistentvolumeclaim="..."}  # empty
```

Other kubelet-emitted metrics (CPU, memory, container counts) are present in
Prometheus, so the scrape pipeline itself is healthy.

## Root Cause

The `kubelet_volume_stats_*` family is not produced by the kubelet on its
own. Each metric value is the result of a `NodeGetVolumeStats` gRPC call the
kubelet makes against the CSI driver's node-plugin socket on the worker. The
driver returns the used/available/capacity bytes, the kubelet wraps them in
the metric, and the standard metrics endpoint exposes them for Prometheus to
scrape.

If the CSI driver does not implement `NodeGetVolumeStats` for a given volume,
or implements it but cannot answer (driver pod is unhealthy, the driver lost
contact with its control plane, the driver's licensing/back-end check is
failing) the metric simply never gets emitted. Prometheus therefore sees no
samples for that PVC and any alert rule on top of those samples stays
silent — there is nothing to evaluate against.

In the field this typically presents as an environment-specific outage of
the CSI driver: a network policy blocking the driver from its control plane,
an outbound firewall blocking the driver from a vendor licensing endpoint,
or the driver pod itself in `CrashLoopBackOff`. The volume keeps working for
existing pods (the data path is independent of the metrics path), but the
metrics pipeline reports nothing.

## Resolution

The corrective action is a property of the CSI driver, not of the cluster:

1. **Confirm the driver implements `NodeGetVolumeStats`.** Check the driver's
   release notes / capabilities documentation. A few older or special-purpose
   drivers do not implement the call at all — in that case there is no
   cluster-side fix; either accept the gap or escalate it as a feature
   request to the driver vendor.

2. **Confirm the driver's node plugin is healthy.** A degraded driver cannot
   answer `NodeGetVolumeStats` even if it implements the call:

   ```bash
   kubectl get pods -n <csi-driver-ns> -o wide
   kubectl describe pod -n <csi-driver-ns> <driver-pod-on-affected-node>
   ```

3. **Confirm the driver's outbound dependencies are reachable.** Many
   commercial CSI drivers gate volume operations on a successful registration
   call to a vendor licensing endpoint. Block that endpoint and the driver
   stops answering metrics:

   ```bash
   kubectl logs -n <csi-driver-ns> <driver-pod> --tail=200
   ```

   Errors like `i/o timeout` or `connection refused` against an external
   hostname or against an internal API service of the driver are the usual
   smoking gun.

4. **Confirm the kubelet itself can reach the driver socket.** On the
   affected node — the cluster PSA on ACP rejects `chroot /host`, so read
   the host paths through the debug pod's `/host` bind-mount directly:

   ```bash
   kubectl debug node/<node> --image=<image-with-shell> -- \
     ls /host/var/lib/kubelet/plugins/<driver>

   # Search the kubelet's journal entries (host's /var/log/journal is
   # visible at /host/var/log/journal):
   kubectl debug node/<node> --image=<image-with-journalctl> --profile=sysadmin -- \
     journalctl --root=/host -u kubelet -n 200 | grep -i "NodeGetVolumeStats"
   ```

5. After the driver is healthy, restart any Prometheus pods that have stale
   memory of the missing series so the dashboards refresh without waiting
   for a natural scrape:

   ```bash
   kubectl delete pod -n <monitoring-ns> -l app.kubernetes.io/name=prometheus
   ```

For environments where the third-party CSI driver consistently fails to emit
volume statistics, the safer pattern is to switch the affected workloads to
a CSI driver that does emit them — for example one of the platform's
Ceph, MinIO, NFS, or local-storage operators which all implement
`NodeGetVolumeStats` correctly and feed `kubelet_volume_stats_*` directly.

## Diagnostic Steps

1. Confirm the metric is genuinely missing rather than blocked by a label
   filter:

   ```text
   count by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes)
   ```

   If the PVC of interest is not in the result set, the driver is not
   emitting stats for it.

2. Confirm other kubelet metrics are present from the same node. If
   `kubelet_node_name`, `kubelet_running_pods`, etc. are all there, the
   scrape and the kubelet are fine and the gap is driver-specific.

3. Check the CSI controller and node pods' logs for repeated errors against
   licensing or control-plane endpoints. Restoring outbound connectivity is
   often the only fix needed.

4. Compare against known-good PVCs on the same node backed by a different
   StorageClass / driver — if those PVCs do produce
   `kubelet_volume_stats_used_bytes`, the kubelet/scrape path is healthy and
   the issue is specific to the affected driver.
