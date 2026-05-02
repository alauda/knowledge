---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# PVC capacity dashboard frozen at stale values when CSI driver health is degraded
## Issue

The cluster's storage dashboard reports an incorrect used / capacity
value for one or more PersistentVolumeClaims. Inside the consuming pod
the actual usage is much lower (or higher) than what the dashboard shows:

```text
console PVC usage:        70 GiB
df -h inside pod:         37 GiB
```

The Prometheus series that the dashboard reads from
(`kubelet_volume_stats_used_bytes{persistentvolumeclaim="..."}`) is
present but its values are flat — the line on the graph stops moving and
no longer tracks real filesystem activity. New writes inside the pod do
not change the metric.

## Root Cause

`kubelet_volume_stats_*` metrics are not measured by the kubelet
itself; the kubelet calls each CSI driver's `NodeGetVolumeStats` gRPC
method on a regular interval and re-emits the result as a Prometheus
series. The dashboard then plots that series.

If the CSI driver behind a particular PVC stops responding to
`NodeGetVolumeStats` — a degraded driver pod, a network policy blocking
the driver from its control plane, an outbound firewall blocking the
driver from a vendor licensing endpoint, an in-progress driver
upgrade — the kubelet's call returns an error, the metric for that PVC
is not refreshed, and Prometheus carries forward the last successful
value. The dashboard therefore shows a stale, frozen value that is
unrelated to current usage.

Common triggers in the field:

- Strict outbound firewall rules that prevent the CSI driver from
  reaching its vendor licensing or telemetry endpoint.
- Misconfigured corporate proxies that route the driver's outbound
  traffic into a black hole.
- Network policies in the driver's namespace that restrict access to
  shared infrastructure pods.
- The driver's own pods in `CrashLoopBackOff` for unrelated reasons
  (image pull, resource quota, RBAC).

The PVC itself stays mounted and its data path keeps working — pods
read and write normally — because the data path is independent from
the metrics path. Only the observability layer is affected, but the
gap shows up to operators as "the storage dashboard is wrong" and is
often misdiagnosed as a metrics-pipeline bug.

## Resolution

Restore the CSI driver's ability to answer `NodeGetVolumeStats`:

1. **Inspect the driver pod's health.** The driver runs a controller
   plus a node-side daemonset. The metric stalls if the per-node
   plugin pod is not happy on the node where the consuming workload
   lives.

   ```bash
   kubectl get pods -n <csi-driver-ns> -o wide
   kubectl describe pod -n <csi-driver-ns> <driver-pod>
   ```

2. **Inspect the driver pod's log for outbound failures.** Most
   commercial drivers gate their per-volume operations on a successful
   call to a vendor endpoint, an internal control plane, or a metadata
   service. Repeated `i/o timeout` or `connection refused` against any
   such endpoint stops `NodeGetVolumeStats` from succeeding:

   ```bash
   kubectl logs -n <csi-driver-ns> <driver-pod> --tail=500 \
     | grep -iE "(timeout|refused|unauthorized|forbidden)"
   ```

3. **Open the firewall to the failing endpoint.** For a vendor
   licensing/registration endpoint, configure the cluster egress
   firewall (or the per-pod proxy `noProxy`) to allow HTTPS to the
   vendor's hostname. After connectivity is restored the driver's
   periodic registration succeeds and `NodeGetVolumeStats` starts
   returning real values again.

4. **Restart the metrics consumers** so dashboards refresh quickly
   without waiting for the natural scrape window:

   ```bash
   kubectl delete pod -n <monitoring-ns> -l app.kubernetes.io/name=prometheus
   ```

5. **Verify the dashboard catches up.** Compare the
   `kubelet_volume_stats_used_bytes` series against `df -h` inside the
   consuming pod. They should match within a few minutes of Prometheus
   resuming successful scrapes.

For long-term hygiene, set up an alert that fires when a PVC's
`kubelet_volume_stats_used_bytes` series goes flat for an extended
period despite the workload being active — this catches CSI-side
degradation before users notice missing capacity alerts:

```text
absent_over_time(kubelet_volume_stats_used_bytes{persistentvolumeclaim=~".+"}[1h])
```

## Diagnostic Steps

1. Confirm the metric is stale, not absent. Plot
   `kubelet_volume_stats_used_bytes{persistentvolumeclaim="<pvc>"}` over
   the last 24 hours; a flat line that stops at the moment the driver
   degraded is the characteristic signal.

2. Compare against ground truth from inside the pod:

   ```bash
   kubectl exec -n <ns> <pod> -- df -h <mount-point>
   ```

3. Cross-check with a healthy PVC backed by a different driver on the
   same node. If that PVC's series moves normally, the kubelet/scrape
   path is fine and the issue is driver-specific.

4. After restoring driver health, the next scrape should overwrite the
   stale value. Watch in real time:

   ```bash
   kubectl exec -n <ns> <pod> -- bash -c 'dd if=/dev/zero of=/data/test bs=1M count=100; sleep 60; df -h /data'
   ```

   then plot the same Prometheus query — the line should jump.

5. If the dashboard remains wrong after the driver recovers, restart
   the Prometheus pods to force re-evaluation; this is rare but happens
   when the scrape pipeline cached a long horizon of stale values.
