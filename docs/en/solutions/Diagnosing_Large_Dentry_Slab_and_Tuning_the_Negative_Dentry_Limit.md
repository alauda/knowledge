---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Diagnosing Large Dentry Slab and Tuning the Negative-Dentry Limit
## Issue

A worker node intermittently goes unresponsive: file-related system calls (`stat`, `open`, `unlink`, mount/umount) slow to a crawl, the container runtime stalls, and the kubelet logs report `PLEG is not healthy` followed by the node flipping to `NodeNotReady`. After recovery, the symptoms reappear under the same workload some hours or days later.

A common cause is unbounded growth of the kernel's dentry cache, dominated by **negative dentries** — cached records for path lookups that resolved to "no such file". Once that slab grows into the millions of entries, every directory traversal and unmount path takes longer, systemd reload can stall, and any liveness/readiness probe that walks the filesystem (notably ones that shell out to `curl` repeatedly) compounds the problem.

## Root Cause

A *dentry* is the in-kernel object that ties a path name to its inode. The kernel keeps a cache of these objects (the dentry cache, `dcache`) so that repeated path lookups do not have to traverse the on-disk directory structure each time.

When a process attempts to `stat`/`open` a path that does **not** exist, the kernel still creates a dentry — a *negative dentry* — to short-circuit the next lookup of the same missing path. For workloads that probe many candidate paths (configuration scanners, antivirus tools, security agents) this is a feature: the second lookup is essentially free.

Two properties of negative dentries make them an operational hazard at scale:

1. **They are unbounded by definition.** Positive dentries are at most as numerous as the entries on the mounted filesystems; negative dentries cover everything that does *not* exist, which is infinite.
2. **They are reclaimed only under memory pressure.** As long as there is free memory, the kernel keeps them. On a node with hundreds of GB of RAM and a workload that creates negative lookups continuously (probes that loop over many paths, container starts that scan many search paths), the slab grows for days before reclaim kicks in — and once it does, reclaim itself can stall lookups.

The visible kubelet failure (`PLEG is not healthy`) is downstream: the kubelet's relist routine has to traverse the cgroup tree and the container runtime's state, both of which involve filesystem operations that block on the same dentry hash buckets.

## Resolution

There is no single setting that "fixes" dentry growth — the cache is doing what it was designed to do. The available options are: cap the negative half of the cache via the kernel sysctl (preferred when the kernel supports it), reclaim periodically as a workaround, or remove the source of the negative lookups in the application.

### Preferred: cap negative dentries at the kernel level

Recent kernels expose a soft cap on the number of negative dentries:

```text
/proc/sys/fs/negative-dentry-limit
```

The value is an integer from `0` to `100` and represents **0.1 % of total system memory** per unit; `0` means "no limit". When the negative-dentry count crosses the resulting threshold, the kernel runs a reclaim helper until it falls back below.

Sizing example for a node with 32 GiB RAM, targeting roughly one million negative dentries (each entry is ~192 bytes, so the slab footprint is ~192 MiB):

```text
target_bytes  = 1_000_000 * 192          ≈ 192 MiB
total_bytes   = 32 GiB                   ≈ 33.3 GiB
percent       = 192 MiB / 33.3 GiB * 100 ≈ 0.577 %
sysctl value  = round(percent / 0.1)     = 6
```

Because nodes in ACP are managed declaratively, do not edit `/etc/sysctl.conf` by hand on the host — the change will be reverted at the next node reconcile. Instead, declare the sysctl through the platform's node-configuration surface (`configure/clusters/nodes`, kernel-parameter or sysctl section). A typical entry looks like:

```yaml
sysctls:
  - name: fs.negative-dentry-limit
    value: "6"
```

The platform rolls the change out by draining each affected node and reloading sysctl values; no manual reboot of a healthy worker is necessary.

If the kernel running on a particular node pool does not expose `negative-dentry-limit`, that node falls back to the workaround below — confirm the file exists with `kubectl debug node/<node> -- chroot /host ls /proc/sys/fs/negative-dentry-limit` before declaring the sysctl, otherwise the rollout will fail per node.

### Workaround: scheduled cache drop

Where the sysctl is unavailable, periodically drop the slab caches so the dentry pool is bounded by the cron interval rather than memory pressure:

```bash
echo 2 > /proc/sys/vm/drop_caches
```

Run it as a privileged DaemonSet / systemd unit on the affected nodes, triggered either by interval or by a Prometheus alert on dentry-slab size. Note the trade-off: each drop briefly invalidates the *positive* dentry cache as well, causing a small latency spike on the next lookups. The interval should be long enough that the spike is invisible to workloads (an hourly cadence is typical) and short enough that the slab stays within budget.

### Durable fix: stop generating the negative lookups

A workload that touches a non-existent path on every probe interval will keep the slab full no matter what the cap is. Common culprits, in rough order of how often they appear:

- **Liveness/readiness probes that shell out** (e.g. `curl http://localhost/health`) — `curl` walks several search paths and config directories at startup; on a probe that runs every two seconds across many pods, this is a large negative-dentry source. Replace shell probes with `httpGet`/`exec` probes that hit a single, fixed binary, or run an in-process health endpoint.
- **Application configuration loaders** that probe a list of candidate paths (default, site-local, user). Constraining the search to one canonical path eliminates the dentries.
- **Security / endpoint-protection agents** that scan many candidate paths per file event. These usually have a tunable scan list — tighten it.

If the source cannot be identified by code review, sample with `perf trace -e syscalls:sys_enter_openat` or BPF tools (`opensnoop`) to find which command is opening non-existent paths most often.

## Diagnostic Steps

Inspect the dentry slab and negative-dentry counters on a suspect node:

```bash
NODE=<node-name>
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sh -c '
     grep -E "^(name|dentry)" /proc/slabinfo
     echo "--- /proc/sys/fs/dentry-state (nr_dentry nr_unused age_limit want_pages nr_negative)"
     cat /proc/sys/fs/dentry-state
   '
```

The fifth column of `dentry-state` is the negative count. Values in the millions on a node showing `PLEG is not healthy` are a strong signal — sustained values above a few million almost always correlate with visible kubelet latency.

If `sar -v` is collected, the `dentunusd` column trends the unused dentry count over time and surfaces unbounded growth between reboots:

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sar -v
```

A monotonically increasing line over hours or days, with no plateau, points squarely at runaway negative-dentry creation rather than a one-off spike.

To attribute the growth to a specific process while reproducing the load:

```bash
kubectl debug node/$NODE --image=registry.k8s.io/e2e-test-images/busybox:1.36 -it -- \
  chroot /host sh -c 'perf trace -e openat 2>&1 | head -n 200'
```

Aggregating by command (`awk` on the perf output) typically points at one or two PIDs producing most of the failed `openat`s — that is the workload to fix.
