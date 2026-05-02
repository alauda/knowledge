---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# How kubectl top Calculates Memory and the Meaning of Working Set
## Overview

Operators routinely look at three different memory numbers for the same container and find that none of them agree:

- `kubectl top pod` shows one figure;
- `free` (or `cat /proc/meminfo`) inside the container shows a much larger one;
- a Prometheus dashboard plotting `container_memory_usage_bytes` shows yet a third value.

None of these tools is wrong. They are answering different questions against different cgroup counters. This article walks through the counters that the kubelet, cAdvisor, and the platform monitoring stack expose, so that "memory usage" can be reasoned about precisely.

## Resolution

### What `kubectl top` reports

`kubectl top pod` and `kubectl top node` consume metrics from the metrics-server, which in turn reads from the kubelet's `/metrics/resource` endpoint. The kubelet derives those numbers from cAdvisor, which reads cgroup files for each container. The specific value reported as "memory" is the **working set**:

```text
working_set = memory.usage_in_bytes - memory.stat.inactive_file
```

The intent of the working set is to approximate "memory that the kernel cannot trivially reclaim under pressure". Page-cache pages on the inactive list are cheap to evict, so they are subtracted off; everything else (anonymous RSS, dirty cache, kernel-pinned cache) is counted in.

### How the underlying cgroup counters compose

For a container's cgroup, `/sys/fs/cgroup/memory/memory.usage_in_bytes` is the *sum of all charged pages*, including page cache. Decomposing it through `memory.stat`:

```text
memory.usage_in_bytes  ≈  memory.stat.rss        # anonymous + swapped-in
                       +  memory.stat.cache      # page cache (active + inactive)
                       +  memory.stat.kernel     # slabs, etc.
```

The working set carves the page cache in half along the kernel's active/inactive LRU split, keeping the active half in the number and discarding the inactive half. That is why the working set tracks closer to "what the OOM killer would have to evict" than the raw `usage_in_bytes` does.

The same numbers can be inspected directly on a node via the cgroup files (cgroup v1 layout shown; v2 collapses these into `memory.current` and `memory.stat`):

```bash
NODE=<node-name>
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sh -c '
     cat /sys/fs/cgroup/memory/memory.usage_in_bytes
     cat /sys/fs/cgroup/memory/memory.stat
   '
```

### Mapping to the Prometheus / cAdvisor names

The platform monitoring stack scrapes cAdvisor and exposes both flavours. The names map directly onto the cgroup counters above:

| Prometheus metric | cgroup expression | What it tells the operator |
|---|---|---|
| `container_memory_working_set_bytes` | `usage_in_bytes - inactive_file` | Same number `kubectl top` reports; closest to "non-reclaimable memory". The OOM-killer's input. |
| `container_memory_usage_bytes` | `memory.usage_in_bytes` | Total charged pages including reclaimable cache. Will appear larger than the working set. |
| `container_memory_rss` | `memory.stat.rss` | Anonymous-only (no cache). Useful for spotting genuine application growth. |
| `container_memory_cache` | `memory.stat.cache` | Page cache. A high value here that drops under pressure is normal. |

For dashboards and alerts that approximate "is this container close to OOM", **`container_memory_working_set_bytes` is the right choice** — it is what the kubelet evictor and the OOM killer effectively use as the evictable cut-off, and it lines up with `kubectl top`.

### Why `free` and other host-level views diverge

`free`, `top`, and `docker stats` (or `crictl stats`) each compute "memory used" from a different combination of `/proc/meminfo`, the cgroup tree, and the container runtime's own bookkeeping. None of them subtract `inactive_file`, and `free` reports memory at the host level (so cache shared across many containers is attributed to "buffers/cache"). Comparing `free` inside a container with `kubectl top` is rarely useful; the two answer different questions and should not be expected to match.

### Why working set climbs to ~95 % and stays there

This is a regular source of false-alarm tickets. Linux holds onto page cache as long as there is no pressure — there is no virtue in unused memory — so the working set will rise to fill whatever budget the cgroup has and remain there. When real pressure arrives, `inactive_file` is reclaimed first, then `active_file` is demoted to inactive and reclaimed, and the working set drops. A flat-line at 95 % under no pressure is **healthy steady state**, not a leak. A working set that crosses the cgroup limit and stays there *is* a problem and will end with an OOM kill — alert on sustained-high working set with no slack, not on the absolute percentage.

## Diagnostic Steps

To confirm what `kubectl top` is reading for a pod, compare its number against the live cgroup files:

```bash
POD=<pod>; NS=<namespace>
kubectl top pod -n "$NS" "$POD"

# Inside the container (or a debug container with /sys mounted):
kubectl exec -n "$NS" "$POD" -- sh -c '
  cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null \
      || cat /sys/fs/cgroup/memory.current
  echo "---"
  cat /sys/fs/cgroup/memory/memory.stat 2>/dev/null \
      || cat /sys/fs/cgroup/memory.stat
'
```

The reported figure should equal `usage_in_bytes - inactive_file` (cgroup v1) or the equivalent computed from `memory.stat` (cgroup v2). Discrepancies of a few hundred KB are expected (the metrics pipeline samples on an interval); discrepancies of many MB suggest the kubelet has not refreshed its cAdvisor view yet — restart the kubelet only as a last resort.

To compare across the metrics surface:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/metrics/resource" \
  | grep -E '^container_memory_(working_set|rss)_bytes'
```

If the working set on a node is consistently above the eviction threshold, expect pods to be evicted in the order their `memory.usage` exceeds their `requests.memory`. Right-sizing requests and (where appropriate) limits is the durable fix; lifting the eviction threshold without addressing the underlying request budget only delays the same outcome.
