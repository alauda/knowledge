---
kind:
  - Troubleshooting
products:
  - Alauda Application Services
ProductsVersion:
  - 4.1,4.2,4.3
---

# PostgreSQL fails to start with "Bus error" (exit 135) on nodes with hugepages enabled

## Issue

After hugepages are reserved on a node (`vm.nr_hugepages` set to a non-zero value), PostgreSQL
instances scheduled onto that node stop starting. The pod log shows:

```text
running bootstrap script ... Bus error (core dumped)
child process exited with exit code 135
```

Exit code `135` is `128 + 7` = **SIGBUS**. Two details make this hard to recognise:

- **The two "small default" lines are a symptom, not a setting.** A log containing
  `selecting default "max_connections" ... 20` together with
  `selecting default "shared_buffers" ... 400kB` means `initdb` tried a `postgres --boot`
  child at every candidate size and **all of them crashed**, so it kept the floor values.
  PostgreSQL did not choose a small configuration.
- **With the Zalando operator the failure is invisible at the Kubernetes level.** The pod
  reports `1/1 Running` while Patroni loops:
  `removing initialize key after failed attempt to bootstrap the cluster` →
  `PatroniFatalException: Failed to bootstrap cluster`, and runit restarts it roughly every
  30 seconds. Never conclude the instance is healthy from pod readiness alone — connect with
  `psql`. With CloudNativePG the `-initdb` Job goes to `Error` and retries visibly.

The problem is not specific to PostgreSQL. Any containerised workload that opportunistically
uses hugepages — MySQL, MongoDB, JVM applications with `-XX:+UseLargePages` — is exposed on
the same node.

## Environment

Reproduced and fixed on:

- Alauda Container Platform 4.2, Kubernetes v1.33.7, containerd 1.7.29, **cgroup v1**
- Worker node: amd64, kernel 3.10, **single NUMA node**, `cpuManagerPolicy` not enabled
- CloudNativePG operator v1.29.1-acp.1 with PostgreSQL 18.4, and the Zalando operator with
  `spilo v4.3.0-beta.36`

The mechanism is a property of kubelet plus the hugetlb cgroup controller, so it is not
limited to these versions. The exact cgroup paths below were verified on cgroup v1; on cgroup
v2 the equivalent file is `hugetlb.<size>.max` under the same pod slice.

## Root cause

Two independent facts combine:

1. **kubelet caps hugepages at zero for pods that do not ask for them.** For every pod without
   a `hugepages-<size>` resource request, kubelet writes
   `hugetlb.<size>.limit_in_bytes = 0` on the **pod-level** cgroup
   (`kubepods-<qos>-pod<uid>.slice`).
2. **hugetlb reservation and allocation happen at different times.** `mmap()` with
   `MAP_HUGETLB` checks the reservation against the **global** pool and succeeds. The cgroup
   limit is only charged when a page is **faulted in**. A refusal inside a page fault has no
   errno to return, so the kernel delivers **SIGBUS**.

PostgreSQL's default `huge_pages=try` only falls back to normal pages when `mmap()` *returns
an error*. Here `mmap()` succeeds, so PostgreSQL commits to hugepages and dies on first touch.

This is why the failure appears only on nodes where hugepages exist. On a node with no pool at
all, `mmap(MAP_HUGETLB)` fails immediately with `ENOMEM` and PostgreSQL falls back silently.
**A node that advertises hugepages the pod cannot actually obtain is more dangerous than a
node with none.**

## Diagnosis

### Confirm it is hugepages

Reproduce in seconds inside the container, without waiting for the operator to retry:

```bash
kubectl -n <ns> exec <pod> -- initdb -D /tmp/hugetlb-check -U postgres
```

A `Bus error (core dumped)` confirms it. (Clean up `/tmp/hugetlb-check` afterwards.)

### Read the cgroup counters at the correct level

> **This is the step that is easy to get wrong.** The `/sys/fs/cgroup` view inside a pod is the
> **container** scope, which is *not* where kubelet writes the limit. It reads `unlimited` with
> `failcnt` permanently `0`, because a child cgroup cannot see refusals recorded by its parent.
> An in-pod reading of zero does **not** exonerate the cgroup.

Read the **pod slice**, from the host:

```bash
POD_UID=$(kubectl -n <ns> get pod <pod> -o jsonpath='{.metadata.uid}' | tr - _)
D=/sys/fs/cgroup/hugetlb/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${POD_UID}.slice
cat $D/hugetlb.2MB.limit_in_bytes $D/hugetlb.2MB.failcnt
```

Adjust `burstable` to `besteffort`, or drop that path element for Guaranteed pods. A `limit` of
`0` with a `failcnt` that increments on every crash confirms the diagnosis. Measured values
around a single failing `initdb`:

| cgroup level | `limit_in_bytes` | `failcnt` before → after |
| --- | --- | --- |
| pod slice | `0` | `0` → `25` |
| container scope (visible inside the pod) | unlimited | `0` → `0` |

`HugePages_Free` in `/proc/meminfo` does not move during the failure: the pages are reserved,
refused at fault time, and never allocated.

### Check whether the node actually advertises hugepages

```bash
kubectl get node <node> -o jsonpath='{.status.allocatable.hugepages-2Mi}{"\n"}'
```

kubelet caches machine information, so a runtime `sysctl -w vm.nr_hugepages=N` is **not
visible to kubelet until it is restarted**. A node with a live pool but
`hugepages-2Mi: 0` is the worst state: pods are capped at zero **and** cannot request
hugepages, because the scheduler does not believe the resource exists. If the pool was enabled
online, restart kubelet on that node before using the "request hugepages" option below.

## Resolution

Pick a row. Do **not** disable the node's hugepage pool as a first move — on a shared node
those pages usually belong to another workload, and removing them has taken applications down.

| Situation | Action |
| --- | --- |
| Instance already bootstrapped, only failing to restart | Set the `huge_pages: "off"` parameter. Works on every major version. |
| Fresh bootstrap needed, PostgreSQL **16 or later** | Set the parameter **and** pass `huge_pages=off` to `initdb`. |
| Fresh bootstrap needed, PostgreSQL **15 or earlier** | No `initdb` option exists. Request hugepages instead, or bootstrap on a node without a pool and move the instance afterwards. |
| PostgreSQL should genuinely use the hugepages | Request `hugepages-<size>` in `resources` and set `huge_pages: "on"`. |

### Why the parameter alone is not enough for a fresh bootstrap

Both operators write `postgresql.conf` **after** `initdb` completes. The crash happens in
`initdb`'s bootstrap child, before that file exists. A cluster created with only
`huge_pages: "off"` still fails to bootstrap — verified. PostgreSQL 16 added
`initdb -c NAME=VALUE` (`--set`), and it is honoured by the bootstrap child, which gives a
configuration-only route on 16+.

### Zalando operator

```yaml
spec:
  postgresql:
    parameters:
      huge_pages: "off"
  patroni:
    initdb:
      set: "huge_pages=off"
```

Patroni renders each `{key: value}` entry as `--key=value`, and PostgreSQL 16's option is
`-c, --set`. The key must therefore be `set`; writing `c` produces an invalid `--c=...` flag.

### CloudNativePG operator

```yaml
spec:
  postgresql:
    parameters:
      huge_pages: "off"
  bootstrap:
    initdb:
      options: ["-c", "huge_pages=off"]
```

> **Caution.** `bootstrap.initdb.options` is a deprecated field, and setting it makes the
> operator ignore every explicit `initdb` setting — `dataChecksums`, `encoding`,
> `localeCollate`, `localeCType`, `walSegmentSize`. If you rely on any of them, restate them as
> raw flags in the same list, for example
> `["-c", "huge_pages=off", "--encoding=UTF8", "--lc-collate=C", "--lc-ctype=C", "-k"]`.

### Option: let PostgreSQL use the hugepages

If the pool is meant for the database, give the pod a real limit instead of removing the
request. This fixes both bootstrap and steady state:

```yaml
spec:
  postgresql:
    parameters:
      huge_pages: "on"
      shared_buffers: 256MB
  resources:
    requests: { cpu: 200m, memory: 1Gi, hugepages-2Mi: 512Mi }
    limits:   { cpu: "1",  memory: 1Gi, hugepages-2Mi: 512Mi }
```

Size the request from `postgres -C shared_memory_size_in_huge_pages` plus headroom. An
exact-fit limit means any later growth of the shared memory segment faults into SIGBUS instead
of failing cleanly at startup. The node must advertise `hugepages-2Mi` — see the kubelet
restart note above.

## Verification

Pod readiness is not a valid check, because the Zalando operator reports `1/1 Running`
throughout the failure. Use these instead.

The instance is actually serving, and using the intended memory type:

```bash
kubectl -n <ns> exec <pod> -- psql -U postgres -tAc \
  "select 'ALIVE', current_setting('huge_pages'), current_setting('shared_buffers')"
```

Expect `ALIVE|off|...` for the disable path, or `ALIVE|on|...` for the request path.

No further cgroup refusals — `failcnt` stops incrementing on the pod slice (same command as in
Diagnosis).

For the request path only, confirm the pages are genuinely held, on the node:

```bash
grep -iE 'hugepages_total|hugepages_free|hugepages_rsvd' /proc/meminfo
```

Read **`HugePages_Rsvd`**, not `HugePages_Free`. Pages that are reserved but not yet touched
still count as free, so `HugePages_Free` understates usage and is not a reliable indicator.

## Limitations and trade-offs

- Setting `huge_pages: "off"` gives up the TLB benefit of hugepages for that instance. For most
  ACP PostgreSQL workloads this is not measurable; if the database is the reason hugepages were
  reserved, use the request path instead.
- The fix is per-cluster. Every PostgreSQL instance that may land on a hugepage-enabled node
  needs it, and so does every other hugepage-capable workload on those nodes.
- Requesting hugepages does **not** protect against a node whose free pages are unreachable for
  another reason, for example a restrictive `cpuset.mems` on a multi-NUMA machine with an
  unevenly distributed pool. Disabling hugepages in the database does, because no
  `MAP_HUGETLB` mapping is created at all.
- `vm.nr_hugepages=0` on the node is a last resort. Identify who consumes the pool first; the
  database is the workload that should adapt, since it is the one opportunistically taking
  pages it cannot fault in.

## Related

- `How_to_Migrate_a_PostgreSQL_Instance_to_Another_Node.md` — moving an instance off an
  affected node when no in-place option exists (PostgreSQL 15 and earlier).
- `CX_series_KubeVirt_VM_fails_to_start_with_FailedScheduling_on_dedicated_CPU_and_hugepages.md`
  — the opposite failure mode for the same resource. A workload that *requests*
  `hugepages-2Mi` and cannot get it stays `Pending` with `Insufficient hugepages-2Mi`, which is
  an honest, visible failure. The SIGBUS described here happens precisely because the workload
  never requested the resource, so nothing stopped it from being scheduled.
