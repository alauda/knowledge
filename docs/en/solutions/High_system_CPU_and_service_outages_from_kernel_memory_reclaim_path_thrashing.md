---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On nodes running a Linux 5.14-derived kernel (the kernel generation shipped with most enterprise distributions in the 9.x family), processes that approach their cgroup memory limit can drive the node into a CPU-exhaustion state instead of being killed cleanly by the out-of-memory (OOM) killer.

The visible symptoms are:

- Sustained `%sys` CPU use, often pinning multiple cores at 100 %, with no proportional increase in user-mode work.
- Latency cliffs and request-time spikes for collocated workloads on the same node, even those well under their own limits.
- Service outages in containerised processes that brush against `memory.limit_in_bytes` repeatedly without ever crossing the threshold by enough to trigger an OOM kill.
- `perf top` and kernel stack traces dominated by `lru_lock` contention — for example, frames in `lruvec_lru_size`, `isolate_lru_pages`, or `__remove_mapping` waiting on `&pgdat->lru_lock`.

The behaviour is caused by intense spinlock contention on `lruvec->lru_lock` inside the kernel's memory reclaim path. The memory management subsystem aggressively evicts and refaults file-backed memory (the page cache) instead of declaring an OOM. Multiple threads enter direct reclaim simultaneously and spin waiting for lock ownership, so the cgroup never quite gets killed but no useful work happens either.

The trade-off is intentional in the kernel design: protecting large workloads such as databases from catastrophic OOM events is preferred over deterministic kills. In a containerised environment with many small cgroups, however, the same trade-off produces indeterminate thrashing and tail-latency disasters.

## Root Cause

In this kernel generation, the reclaim path treats reclaimable file pages as plentiful and inexpensive to drop, so it drops them rather than triggering an OOM. When the working set genuinely no longer fits, those pages are immediately re-faulted, and the cgroup loops between "evict" and "refault" with all of its threads contending on `lru_lock`. The lock is per-LRU and per-NUMA-node, so contention manifests as sky-high `%sys` time on whichever CPUs happen to be running threads of the saturated cgroup.

The pattern is documented as a kernel-version characteristic, not a configuration mistake. Newer upstream kernels (the 6.x series and the kernel that ships with the 10.x distribution generation) change the heuristics to make this case far less likely.

## Resolution

The mitigations below are independent — they can be applied separately or stacked, depending on how aggressively the workload mix needs the node to shed memory pressure.

### 1. Run a userspace OOM killer (`systemd-oomd`)

`systemd-oomd` watches Pressure Stall Information (PSI) on memory and pre-emptively terminates the cgroup creating the pressure, before the in-kernel reclaim path falls into the spinning state. PSI exposes the wait time on memory stalls per cgroup, which is exactly the signal needed to distinguish "thrashing" from "merely busy".

Enable the service on every node where the symptom has been seen, and configure a cgroup-level threshold appropriate for the workload. For an example threshold:

```ini
# /etc/systemd/system.conf.d/oomd.conf
[OOM]
DefaultMemoryPressureLimit=10%
DefaultMemoryPressureDurationSec=20s
```

Reload and confirm the daemon is active:

```bash
systemctl daemon-reload
systemctl enable --now systemd-oomd.service
systemd-cgls --no-pager | head
```

### 2. Tune Multi-Gen LRU (MGLRU)

When the kernel was built with `CONFIG_LRU_GEN`, MGLRU exposes `min_ttl_ms` to express "if the working set has been refaulting for longer than this, give up reclaim and trigger OOM". Setting a small value (a few seconds) forces a deterministic OOM in the thrashing case while leaving healthy reclaim untouched.

```bash
# Probe whether MGLRU is enabled on this kernel
cat /sys/kernel/mm/lru_gen/enabled

# Set a 5 s ceiling on reclaim attempts before OOM
echo 5000 > /sys/kernel/mm/lru_gen/min_ttl_ms
```

To make the change persistent, deliver it through the node-configuration mechanism in use on the cluster — a `tuned` profile, a host-level systemd unit, or a config-management role — so it survives reboot and node replacement.

### 3. Reserve a floor for file-backed memory with `memory.min`

In cgroup v2, `memory.min` declares "this much memory will not be reclaimed under any circumstances short of OOM". Setting `memory.min` on a workload that relies heavily on its page cache (for example, a process that mmaps a large index) prevents the reclaim loop from re-evicting pages that are about to be refaulted anyway.

For a Pod running under cgroup v2, the equivalent is to use Quality-of-Service-aware controls or a dedicated `memory.min` set on the pod's cgroup directory. If the runtime exposes the value indirectly, set it via the runtime's configuration; otherwise, write to the cgroup tree from a privileged DaemonSet:

```bash
# Within a privileged debug pod with hostPID
mkdir -p /sys/fs/cgroup/<pod-cgroup-path>
echo 4G > /sys/fs/cgroup/<pod-cgroup-path>/memory.min
```

`memory.min` is a hard floor, so size it conservatively. Setting it too high simply pushes the OOM problem onto whichever neighbour cgroup loses memory next.

### 4. Right-size limits

The kernel-level mitigations buy stability; they do not fix an undersized limit. If a workload's working set genuinely exceeds the limit, `systemd-oomd` will keep killing it and MGLRU's `min_ttl_ms` will keep trip-OOMing it. Use the captured PSI data and the workload's actual resident-set size during steady-state to set a limit that fits the working set with adequate headroom.

## Diagnostic Steps

1. Capture per-cgroup memory pressure during the incident:

   ```bash
   # Watch top-level memory PSI
   cat /proc/pressure/memory

   # And the same for a specific pod cgroup
   cat /sys/fs/cgroup/<pod-cgroup-path>/memory.pressure
   ```

   `some` and `full` averages climbing into double-digit percentages indicate stall behaviour, not just elevated memory usage.

2. Confirm the spinlock signature with `perf`:

   ```bash
   perf top -g -e cycles --call-graph dwarf
   ```

   A reclaim-path thrashing event has stack traces dominated by `_raw_spin_lock`, `lru_lock`, and the LRU-isolation functions. If those frames do not dominate, the symptom is something else (genuinely overloaded CPU, runtime issue, etc.) and the mitigations above will not help.

3. Compare the cgroup's working set against its limit:

   ```bash
   cat /sys/fs/cgroup/<pod-cgroup-path>/memory.current
   cat /sys/fs/cgroup/<pod-cgroup-path>/memory.max
   cat /sys/fs/cgroup/<pod-cgroup-path>/memory.stat
   ```

   A `memory.current` consistently within a few percent of `memory.max`, combined with a high `pgmajfault` rate in `memory.stat`, confirms that the cgroup is in the refault loop the article describes.

4. After applying a mitigation, re-measure the same signals over a representative window. The desired outcome is either a clean OOM termination (with `oom_kill` incrementing in `memory.events`) or a flat `memory.pressure` curve — either is preferable to indefinite spinning.
