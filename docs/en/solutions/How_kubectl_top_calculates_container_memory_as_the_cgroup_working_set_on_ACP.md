---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# How kubectl top calculates container memory as the cgroup working set on ACP

## Issue

On Alauda Container Platform (Kubernetes v1.34.5), the per-pod and per-node memory figure shown by `kubectl top pods` and `kubectl top nodes` is the container *working set*, not the total amount of memory the container has touched. The `metrics.k8s.io/v1beta1` API on ACP is served by `cpaas-monitor-prometheus-adapter` in the `cpaas-system` namespace (helm chart `prometheus-adapter-1.4.2`), with the APIService reporting `Available=True`; the adapter's memory `containerQuery` is a sum of the cAdvisor series `container_memory_working_set_bytes`, so the value reaching the CLI is the working set itself rather than any platform-specific computation. On a measured pod, the kubelet `PodMetrics` value for the `prometheus` container was `memory=530544Ki` and the cAdvisor sample at the same scrape was `container_memory_working_set_bytes=532905984` bytes — the same number within sample skew between the two collection paths.

Because the working set is a smaller, cache-stripped figure, it does not line up with what node-scoped tools like `free` or container-runtime utilities report for the same workload; total cgroup usage on the same container at the same instant was `container_memory_usage_bytes=1895079936` (~1.895 GB) versus a working set of ~533 MB, roughly a 3.5x gap driven entirely by page cache that the working-set view strips out.

## Root Cause

The working set follows the standard cgroup-derived form: it is the container's total memory usage minus the file-backed page cache that is currently inactive (reclaimable). The same shape is observable through the kubelet `/stats/summary` endpoint on every node — a sampled node reported `usageBytes=15259226112`, `workingSetBytes=5915795456`, and `rssBytes=3337379840`, so `usage > workingSet > rss` strictly, with the ~9.3 GB gap between usage and working set attributable to cache that has already been demoted to the inactive list and is therefore not counted. The same `/stats/summary` payload also surfaces per-cgroup PSI (`pressure stall`) full/some `{avg10, avg60, avg300}` fields populated for the node, which requires the unified-hierarchy cgroup stack to be in use, so the kubelet-exposed working-set value on these nodes is the unified-hierarchy form rather than any legacy stat layout.

Total cgroup usage decomposes into resident anonymous memory plus the page cache, and that identity holds on this cluster. For the `prometheus` container, cAdvisor reported `container_memory_rss=530235392` and `container_memory_cache=1352925184`, summing to 1883160576 bytes — within ~12 MB of `container_memory_usage_bytes=1895079936` at the same scrape. The working set sits at ~533 MB and is essentially equal to `rss` for this container, so the ~1.36 GB gap between usage and working set is the cache portion (mostly inactive file pages) that the working-set definition strips out — the same arithmetic reason that `free` and runtime-level tools, which count cache against the workload, report a higher number than `kubectl top`.

## Resolution

Read the working set with the standard memory view. The values returned by these commands are populated by `cpaas-monitor-prometheus-adapter` from `container_memory_working_set_bytes`, so they are the working set by construction rather than a derived approximation:

```bash
kubectl top pods -n <namespace>
kubectl top nodes
```

Treat the reported number as the working set: a smaller, distinct value than total memory usage, with the difference held by reclaimable page cache. The same scrape exposes both the working set and total usage for direct comparison — querying `container_memory_working_set_bytes` and `container_memory_usage_bytes` on the same container will typically show usage well above the working set, and the gap matches the page-cache series within tens of MB.

Do not cross-compare the working set against tools that measure a different scope or in a different way. Total cgroup usage as exposed by `container_memory_usage_bytes` (~1.9 GB in the sample above) includes cache that the working-set view strips, so the same workload looks several times larger in any tool that reports total usage. The container's own usage and working set are the smaller cgroup-scoped values surfaced by `kubectl top` and the metrics API; node-scoped utilities answer a different question and will not match.

## Diagnostic Steps

To inspect the working set in monitoring queries, use the cAdvisor-exported Prometheus series. Both metrics are scraped from `job=kubelet` on port `10250` (cAdvisor is embedded in the kubelet) and are present in the in-cluster Prometheus' `/api/v1/label/__name__/values` listing on this build (image `registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4`). The working set is published as `container_memory_working_set_bytes`, and the total cgroup usage is published as `container_memory_usage_bytes`:

```text
container_memory_working_set_bytes   # what kubectl top reports
container_memory_usage_bytes         # total cgroup usage (>= working set)
container_memory_rss                 # resident anonymous portion
container_memory_cache               # page cache; the slack between usage and working set
```

To confirm the working-set identity directly on a node without leaving the Kubernetes API surface, read the kubelet's summary endpoint via `kubectl get --raw`; the same `usageBytes` / `workingSetBytes` / `rssBytes` fields surface there per container and per node and can be cross-checked against the Prometheus series at the same instant:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/stats/summary" \
  | grep -E '"(usageBytes|workingSetBytes|rssBytes)"'
```

A `usage` figure that sits well above `workingSet` on the same container is expected and confirms the cache-stripping shape rather than indicating a leak; the difference matches `container_memory_cache` within scrape jitter on a healthy node.
