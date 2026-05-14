---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# CFS Throttling on a Mostly Idle Container
## Issue

A container reports non-zero CPU throttling counters even though the workload appears almost completely idle and the average CPU usage stays well below both `requests.cpu` and `limits.cpu`. The throttle metric (`container_cpu_cfs_throttled_periods_total` in Prometheus) ticks up steadily, while user-visible utilisation remains near zero. Operators see this most often on small sidecars, log shippers, or health-check loops.

## Root Cause

The Linux Completely Fair Scheduler (CFS) enforces a CPU `limit` by handing the cgroup a quota that must fit inside a fixed period (the kubelet defaults the period to 100 ms and derives the quota from `limits.cpu`). Throttling is counted **per period**, not over the whole window an operator looks at on a dashboard.

A short burst — for example, a 30 ms wake-up to flush a buffer on a container with `limits.cpu: 100m` (10 ms of quota per 100 ms period) — exhausts the quota for that period and the cgroup is paused for the remainder. Averaged over a minute the container looks idle, but each individual wake-up is throttled. This is the kernel behaving as documented; it is not a metric error and not specific to any container runtime.

## Resolution

Treat the throttling counter as a signal that the workload's burstiness exceeds the per-period quota the limit was set to deliver, then act on the cause rather than the symptom.

1. **Raise or remove the CPU limit on bursty workloads.** For containers whose work is dominated by short, latency-sensitive spikes (sidecars, exporters, init logic), the limit is usually doing more harm than good. Either set `limits.cpu` substantially higher than the average request, or omit it entirely and rely on `requests.cpu` for scheduling. A common starting point is `limits.cpu` = 4 to 8 times the steady-state usage so a single burst can finish inside one period.

   ```yaml
   resources:
     requests:
       cpu: "100m"
     limits:
       cpu: "1"     # was "100m"; allows a 100 ms burst inside one CFS period
   ```

2. **Verify with the throttled-time metric, not just throttled-periods.** Use `container_cpu_cfs_throttled_seconds_total` divided by `container_cpu_cfs_periods_total` for a fraction. A handful of throttled periods per minute against tens of thousands of periods is normal noise; a fraction above a few percent is worth tuning.

   ```bash
   kubectl top pod <pod> --containers
   kubectl exec <pod> -c <container> -- \
     cat /sys/fs/cgroup/cpu.stat
   # Look at nr_throttled and throttled_usec
   ```

3. **Consider lengthening the CFS period for latency-sensitive pods.** Kubernetes exposes `cpuCFSQuotaPeriod` in the kubelet configuration. A longer period (e.g. 1000 ms) lets the kernel amortise short bursts across a wider window. This is a node-level change and affects every pod on the node — apply it to a tainted pool that hosts only the latency-sensitive workloads, never cluster-wide. The platform's node-configuration surface under `configure/clusters/nodes` is the supported way to roll out kubelet drop-ins; do not edit `/var/lib/kubelet/config.yaml` directly.

4. **As a last resort, disable the CFS quota for a specific pool.** Setting `cpuCFSQuota: false` in the kubelet configuration removes hard quota enforcement for every pod on that node — they fall back to `requests` for fair-share but can use any spare CPU on the host. This is appropriate only for trusted workloads on dedicated nodes and is the change with the largest blast radius. Document it in the node-pool description so future operators do not assume a default.

## Diagnostic Steps

Confirm that throttling correlates with bursts and not with sustained load:

```bash
kubectl exec <pod> -c <container> -- sh -c '
  while true; do
    awk "/^nr_periods/ {p=\$2} /^nr_throttled/ {t=\$2} \
         /^throttled_usec/ {u=\$2} END {print p, t, u}" /sys/fs/cgroup/cpu.stat
    sleep 5
  done'
```

A jump in `nr_throttled` while the average CPU stays low is the textbook signature of bursty work hitting a tight quota. If `throttled_usec` grows in fractional-millisecond steps, the bursts are tiny and the limit is the right place to fix it; if it grows in tens of milliseconds, the workload genuinely wants more CPU than the limit allows and `requests` should grow as well.

Inspect kernel-side throttling for context:

```bash
kubectl debug node/<node> -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sh -c '
    cat /sys/fs/cgroup/kubepods.slice/.../cpu.stat 2>/dev/null | head'
```

If the cause turns out to be a single misbehaving init container that spends 200 ms initialising and trips the quota at every restart, the fix is to widen the limit just for that container — leaving the steady-state container under a tighter limit is fine. The throttling counter is only a problem when it correlates with user-visible latency.
