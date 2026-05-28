---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Distinguishing JVM heap growth from page cache in container memory metrics

## Issue

A JVM workload running in a pod can show `container_memory_usage_bytes` climbing well above the configured heap size, which is easily mistaken for a heap leak. On Alauda Container Platform v4.3.4 the bundled Prometheus stack (prometheus image `v3.11.3-v4.3.4`, prometheus-operator/config-reloader `v0.91.0-v4.3.4`, unified Prometheus in the `cpaas-system` namespace) scrapes the kubelet cAdvisor metrics cluster-wide, and `container_memory_usage_bytes` for a container's memory cgroup includes file-backed reclaimable page cache, not only the process's anonymous heap memory — so the reported value can exceed the heap by a wide margin without any anonymous memory having grown.

## Root Cause

The container cgroup's usage figure folds together two very different kinds of memory. Anonymous memory — the JVM heap, bounded by `-Xmx` — counts toward the process working set and is the memory relevant to an out-of-memory kill, because it cannot be reclaimed by the kernel on demand. Page cache, by contrast, is file-backed memory that the kernel can reclaim under memory pressure, so growth in `container_memory_usage_bytes` driven by page cache does not by itself indicate a JVM heap leak. Because both are accounted in the same cgroup usage counter, a container that has read a large amount of file data appears to "use" far more memory than its heap occupies, while the additional memory is reclaimable cache rather than leaked heap.

## Resolution

To tell the two apart, compare `container_memory_usage_bytes` against `container_memory_working_set_bytes` for the same container. The working set metric is derived as usage minus the reclaimable inactive page cache, so it tracks memory that cannot simply be reclaimed under pressure more closely than the raw usage metric does. A large gap between the two for one container indicates that page cache accounts for the difference; on the observed Prometheus container the usage value exceeded the working set by roughly 1.38 GB, and that gap was attributable to file cache rather than to the heap. The anonymous heap-class memory remains inside the working set figure and is never subtracted out, so the working set is the value to watch for genuine heap or OOM concerns.

A PromQL comparison surfaces the gap per container:

```text
container_memory_usage_bytes{namespace="<ns>", pod="<pod>"}
  - container_memory_working_set_bytes{namespace="<ns>", pod="<pod>"}
```

Note that on ACP's cAdvisor the per-container RSS metric is not exposed, so the anonymous (heap-class) portion is not available as a scrapeable Prometheus series; that portion must be read from the in-container cgroup stat file instead, as described below.

## Diagnostic Steps

Read the cgroup memory statistics from inside the container to attribute the gap precisely. The nodes run cgroup v2 (the unified `cgroup2fs` hierarchy), where `/sys/fs/cgroup/memory.stat` exposes an `inactive_file` field reporting the amount of reclaimable file-backed page cache attributed to the container's cgroup. Reading that file confirms the relationship directly — the usage-minus-working-set gap equals the `inactive_file` value (in the observed case the two matched within about 0.4%), which establishes that the inactive page cache is exactly the memory the working set metric drops.

```bash
kubectl exec -n <ns> <pod> -c <container> -- cat /sys/fs/cgroup/memory.stat
```

Under cgroup v2 the same file separates anonymous memory into an `anon` field, distinct from the `inactive_file` page cache field. This separation makes the diagnosis decisive: when `inactive_file` is approximately equal to the observed memory growth above the JVM heap size, page cache is the cause of that growth rather than a heap leak. Only the inactive file cache is reclaimed and excluded from the working set; the `anon` heap-class memory is counted into the working set and is not subtracted, so comparing `anon` against the heap bound and `inactive_file` against the growth-above-heap cleanly separates reclaimable cache from genuine heap occupancy.

If `anon` tracks the configured heap while the excess sits in `inactive_file`, the growth is reclaimable page cache and the kernel will release it under pressure, so no heap remediation is warranted.
