---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Distinguishing JVM Heap Growth from Page Cache in Container Memory Metrics
## Issue

A JVM-based workload (a Spring-Boot service, a Java integration runtime, a Tomcat-style app server) runs with a clearly bounded Java heap — for example, `-Xmx2G` — yet the pod's `container_memory_usage_bytes` metric in the cluster's monitoring stack climbs steadily over time and eventually plateaus at several gigabytes higher than the configured heap. By the time it reaches `7G` against a 2G heap, dashboards alert on memory pressure, on-call assumes a heap leak, and the operator team starts the JVM-leak-hunt playbook — heap dumps, GC logs, JFR captures.

In many of these cases the JVM is innocent. Heap dumps show the in-use heap well below `-Xmx`, GC logs are clean, and there is no allocation pattern that would explain the growth. Yet the container-level metric keeps rising. The question is whether the additional bytes are an actual JVM problem (off-heap allocations, native code leak, direct buffers) or an artifact of how container memory is accounted (page cache, kernel slab counted in the cgroup).

## Root Cause

`container_memory_usage_bytes` is sourced from the cgroup memory controller's `memory.usage_in_bytes` (cgroup v1) or `memory.current` (cgroup v2). It includes:

- Anonymous (in-use) pages — the JVM heap, native heap, thread stacks, direct buffers.
- Kernel data structures attributed to the cgroup (slab, kmem if enabled).
- **The page cache attributable to files the cgroup's processes have read or mapped.**

A long-running JVM that reads from disk — JAR files lazily loaded, log files appended, configuration reloaded, mapped data files for the workload — accumulates page-cache pages in the cgroup's memory accounting. These pages are *clean and reclaimable*: under memory pressure the kernel will drop them without notifying the process, and they are listed under `inactive_file` in `memory.stat`. They show up in `container_memory_usage_bytes` (because they are in the cgroup's accounting), but they are **not** the JVM's working set.

The metric `container_memory_working_set_bytes`, by contrast, is computed as approximately `usage − inactive_file`. It is the kubelet's best estimate of memory the kernel could *not* reclaim under pressure — i.e., the actual working set. For a JVM workload, `container_memory_working_set_bytes` is the right number to alert on; `container_memory_usage_bytes` is informational.

Two diagnostics directly distinguish the two stories:

1. The **gap** between `container_memory_usage_bytes` and `container_memory_working_set_bytes` per pod equals (approximately) the page cache attributed to that pod. A multi-gigabyte gap that is steady or growing in proportion to disk I/O is page cache, not a leak.
2. Inside the pod, `/sys/fs/cgroup/memory.stat` (cgroup v1) or `/sys/fs/cgroup/memory.stat` under the unified hierarchy (v2) exposes `inactive_file:` directly. If `inactive_file` is approximately equal to (`usage_bytes − heap`), page cache is the entire story.

The same accounting applies to any container, not just JVMs — but JVM workloads are over-represented in this confusion because operators look at the configured `-Xmx` and assume "anything beyond this must be a leak". The JVM's own off-heap usage (Metaspace, code cache, direct ByteBuffers) is typically a few hundred megabytes, not gigabytes; gigabytes of mystery memory in a JVM container is almost always page cache.

## Resolution

The investigation has two outcomes — page cache (no action) or genuine off-heap growth (further investigation) — and the diagnostic is short enough to do in one pass.

### Step 1 — Confirm whether the gap is page cache

In the cluster's monitoring UI, plot the two metrics side by side for the affected pod over the same window:

```text
container_memory_usage_bytes{namespace="<ns>", pod="<pod>", container="<container>"}
container_memory_working_set_bytes{namespace="<ns>", pod="<pod>", container="<container>"}
```

If `working_set_bytes` is roughly flat (or growing only modestly) while `usage_bytes` climbs, the difference is page cache. The pod is **not** leaking. Decide whether to:

- Adjust the alert. Move the alert from `container_memory_usage_bytes` to `container_memory_working_set_bytes`, which is what kubelet uses for OOM-eviction decisions anyway.
- Adjust the limit. The pod is using its entire memory limit including reclaimable cache, which is healthy behaviour but can mask an upcoming pressure event. If working-set + a safety margin still fits comfortably, no change is needed; if working-set is creeping toward the limit, page-cache pressure can still cause occasional evictions and the limit should be raised.

If `working_set_bytes` itself is climbing in lockstep with `usage_bytes`, the growth is **not** page cache. Skip to Step 3.

### Step 2 — Cross-check inside the pod

The cgroup `memory.stat` exposes the cache breakdown directly. From inside the pod (or via `kubectl exec`):

```bash
kubectl -n <ns> exec -it <pod> -c <container> -- cat /sys/fs/cgroup/memory.stat
```

For a v2 cgroup the relevant lines are `anon`, `file`, `inactive_file`, `active_file`. For v1 the file names are similar but under `/sys/fs/cgroup/memory/memory.stat`. The relation:

- `anon` ≈ JVM heap + native heap + thread stacks + direct buffers.
- `file` = `active_file + inactive_file` = page cache held in this cgroup.
- `inactive_file` = the reclaimable subset.

If `anon` is approximately the configured Java heap (within a few hundred MiB) and `file` accounts for the rest of the gap, the metric story is confirmed and no JVM action is needed.

### Step 3 — When the growth is real off-heap

If `working_set_bytes` and `anon` are both climbing, the JVM (or another process in the container) is genuinely consuming more memory beyond the heap. Standard escalation path:

- Native Memory Tracking. Restart the JVM with `-XX:NativeMemoryTracking=summary` and capture `jcmd <pid> VM.native_memory summary` over time. A growing `Internal` or `Other` section points to direct ByteBuffers or JNI allocations.
- Direct buffer pool. Expose `java.nio.BufferPool` MBeans and watch `Direct` pool's `MemoryUsed`.
- Class metadata. Watch `Metaspace` and `CodeCache` via JMX or `-Xlog:gc*`.
- Native libraries. If the workload links a native library (a JDBC driver, an image-processing library, a crypto provider), profile with `jemalloc`'s leak profiler or `pmap -x <pid>` to see large anonymous mappings.

Each of these is a JVM-side investigation; none of them touch the cluster.

### Step 4 — Why this matters for cluster-side capacity planning

When sizing memory limits and reservations for JVM workloads, plan against `container_memory_working_set_bytes`, not `container_memory_usage_bytes`. The working set is what the scheduler should treat as "needed"; the usage figure includes opportunistic page cache that the kernel will release without harm under pressure. Conflating the two leads to oversized limits, lower bin-packing density, and false-positive memory-pressure alerts.

Alauda Container Platform's monitoring surface (`observability/monitor`) exposes both metrics through the cluster Prometheus, so dashboards and alert rules can be retargeted without instrumentation changes.

## Diagnostic Steps

1. From a Prometheus query (or the cluster monitoring UI), compare the two metrics for the suspect pod:

   ```text
   container_memory_usage_bytes{namespace="<ns>", pod="<pod>"}
   container_memory_working_set_bytes{namespace="<ns>", pod="<pod>"}
   ```

   A large and steady gap = page cache.

2. Confirm against the cgroup directly:

   ```bash
   kubectl -n <ns> exec -it <pod> -c <container> -- \
     sh -c 'cat /sys/fs/cgroup/memory.stat 2>/dev/null \
            || cat /sys/fs/cgroup/memory/memory.stat'
   ```

   Read out `anon`, `file`, `inactive_file`. The page-cache story is confirmed when `file` ≈ (`usage_bytes − anon`).

3. From the JVM, confirm the heap is in fact bounded as configured:

   ```bash
   kubectl -n <ns> exec -it <pod> -c <container> -- \
     jcmd 1 GC.heap_info
   ```

   `used` and `committed` should stay within `-Xmx`. If they do not, the JVM heap itself is the leak; revert to standard heap-leak analysis.

4. If working-set is rising alongside usage, capture a Native Memory Tracking summary and inspect the non-heap categories:

   ```bash
   kubectl -n <ns> exec -it <pod> -c <container> -- \
     jcmd 1 VM.native_memory summary
   ```

   A `Class`, `Code`, `Internal`, or `Other` section growing without bound is the next thing to investigate.

5. After re-aiming alert rules at `container_memory_working_set_bytes`, watch for false positives over a representative window (one full traffic cycle, e.g. 24h). If alerts go quiet but real OOM kills still occur, the working-set itself is too close to the limit — raise the limit, do not raise the alert threshold.
