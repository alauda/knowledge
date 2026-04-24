---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A JVM-based workload (in-memory cache, search indexer, analytics engine, application server) reports stuttering response times under load. Grafana shows CPU usage well below the container's `limits.cpu`, yet the same pod's `container_cpu_cfs_throttled_periods_total` counter is climbing rapidly. The pod itself does not crash and is not OOM-killed; performance just sags during traffic peaks.

This is a hot path for any container that spawns many short-lived threads — JVMs are the canonical case, but the same shape appears for Go runtimes with high `GOMAXPROCS`, Node.js worker pools, and Python multiprocessing pools.

## Root Cause

The Linux Completely Fair Scheduler (CFS) enforces container CPU limits through a quota / period bucket: every CFS period (default 100 ms), each container receives a CPU-time quota equal to `limits.cpu * period`. Once the cgroup spends its quota, every thread in the cgroup is preempted off-CPU until the next period rolls. The container's *average* CPU usage may remain well below the limit, but threads are stalled in bursts.

Two factors make this especially visible on multi-threaded workloads:

- **Limit is applied across the entire cgroup, not per-thread.** A container with `limits.cpu: "2"` running 32 threads still gets only 200 ms of CPU per 100 ms wall-clock period across all of those threads. A burst that wakes 32 threads simultaneously will exhaust the quota in a fraction of the period.
- **JVMs and similar runtimes default `parallelism` to the host's CPU count.** If the JVM does not detect the container limit, the GC threads, ForkJoinPool, and thread pools size themselves to the node, not to the container. The container then has the wrong number of threads competing for a small slice of CPU.

Throttling does **not** kill the pod — it only delays threads. There is no `OOMKill`, no liveness-probe failure unless probe timeouts are aggressive, and no obvious incident. The symptom surface is purely latency and tail-percentile degradation.

## Resolution

Combine three orthogonal fixes; the right combination depends on how strict the cluster's resource discipline is:

1. **Tighten or relax `limits.cpu` based on observed throttling.** The simplest test: temporarily widen `limits.cpu` (e.g. from `2` to `4`) and observe whether the throttling counter stops climbing. If it does, the limit was the binding constraint; pick a value that gives the workload headroom for its burst pattern. The general guideline for container CPU sizing is `limits.cpu ≈ 1.5x to 2x` the steady-state demand for bursty workloads.

   ```yaml
   resources:
     requests:
       cpu: "1"
       memory: "4Gi"
     limits:
       cpu: "4"
       memory: "4Gi"
   ```

   The `requests` value is what scheduler uses to place the pod and what HPA uses for utilisation; the `limits` value is what CFS enforces. Setting them equal makes the pod Guaranteed, which is required for the static CPU Manager policy to pin the workload to dedicated cores (eliminating CFS throttling entirely for that pod).

2. **Ensure the runtime is container-aware.** A JVM running on OpenJDK 11+ honours the container limit via `-XX:+UseContainerSupport` (default-on). A JVM on OpenJDK 8u191+ honours it via the same flag plus `-XX:MaxRAMPercentage` for memory. Verify the running JVM actually sees the container's CPU limit:

   ```bash
   kubectl exec <pod> -- jcmd 1 VM.flags | grep -E 'ActiveProcessorCount|UseContainerSupport'
   ```

   If `ActiveProcessorCount` returns the host's full CPU count instead of the container limit, the container is not detected (older base image, custom JVM args overriding the default) — fix the image or set `-XX:ActiveProcessorCount=N` explicitly to match `limits.cpu`.

3. **Pin Guaranteed pods to dedicated cores via the static CPU Manager policy.** When a workload is sensitive to even small amounts of throttling (cache hit-rate workloads, latency-sensitive services), promote the pod to Guaranteed QoS (set `requests == limits` for both CPU and memory, integer CPU count) and enable the static CPU Manager policy on the worker pool. Pinned cores skip CFS quota entirely:

   ```yaml
   resources:
     requests:
       cpu: "4"
       memory: "8Gi"
     limits:
       cpu: "4"
       memory: "8Gi"
   ```

   Combined with a node pool that has `cpuManagerPolicy: static` declared in its kubelet customisation, this pod gets four exclusive cores and never throttles. See the cluster's node-configuration surface (`configure/clusters/nodes`) for how to enable the static policy on a worker pool.

4. **Optional — relax the CFS period for shorter-burst workloads.** The default 100 ms period is hostile to workloads that burn CPU in 10 ms bursts and idle for the rest. The kubelet supports `cpuCFSQuotaPeriod` (default 100 ms) — lowering it to 25 ms reduces throttling latency for very bursty workloads at a slight overall throughput cost. This is a node-pool-wide change; coordinate with the platform owner before applying.

## Diagnostic Steps

Confirm throttling is the actual cause and not a different bottleneck. Pull the per-pod throttling rate from the cluster's metrics stack:

```text
sum(rate(container_cpu_cfs_throttled_periods_total{pod="<pod>"}[5m]))
  /
sum(rate(container_cpu_cfs_periods_total{pod="<pod>"}[5m]))
```

Anything above ~5% sustained means CFS is preempting the pod's threads regularly. Above 30% the workload is severely throttled and tail latency is dominated by it.

Inspect the container's actual cgroup quota and period from inside the pod:

```bash
kubectl exec <pod> -- sh -c '
  cat /sys/fs/cgroup/cpu.max 2>/dev/null \
  || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us'
```

`cpu.max` (cgroup v2) reports `<quota> <period>` — quota of `400000 100000` means 4 CPUs over a 100 ms period (matching `limits.cpu: "4"`). `-1` or `max` means unlimited (no `limits.cpu` set).

Check the pod's QoS class and whether CPU Manager pinned cores to it:

```bash
kubectl get pod <pod> -o jsonpath='{.status.qosClass}{"\n"}'
kubectl exec <pod> -- cat /sys/fs/cgroup/cpuset.cpus.effective
```

A Guaranteed pod with the static CPU Manager policy enabled has `cpuset.cpus.effective` showing a small range of pinned cores (e.g. `2-5`); a Burstable pod shows the entire allocatable range and is subject to CFS.

If using a JVM, dump the runtime view of CPU count:

```bash
kubectl exec <pod> -- jcmd 1 VM.system_properties \
  | grep -E 'java.runtime|cpu.count|processors'
```

If the JVM reports the host's CPU count rather than the container's limit, the runtime is not container-aware and is over-allocating its thread pools — fixing that often eliminates the throttling without raising `limits.cpu`.
