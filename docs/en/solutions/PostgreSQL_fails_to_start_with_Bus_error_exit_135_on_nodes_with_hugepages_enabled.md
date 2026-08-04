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

Everything asserted below was observed in that environment. The underlying mechanism is a
property of kubelet plus the hugetlb cgroup controller rather than of these specific versions,
so it is expected to generalise — but the concrete paths, filenames and numbers here are the
tested ones, and the cgroup layout in particular depends on the **systemd** cgroup driver
(`cgroupDriver: systemd`) and the default kubelet cgroup root. On cgroup v2 the equivalent file
is `hugetlb.<size>.max`; the filename is correct, but the unified hierarchy means the mount
point differs, and that combination was not tested here.

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

`<pod>` can be **any** pod on the suspect node that contains PostgreSQL binaries — it does not
have to be the failing one, and often cannot be. With CloudNativePG the crashing entity is the
`-initdb` Job pod, which runs with `restartPolicy: Never` and may already be `Terminated` by
the time you look, so `exec` returns `container not running`. Start a throwaway pod pinned to
that node with the same image instead.

### Read the cgroup counters at the correct level

> **This is the step that is easy to get wrong.** The `/sys/fs/cgroup` view inside a pod is the
> **container** scope, which is *not* where kubelet writes the limit. It reads `unlimited` with
> `failcnt` permanently `0`, because a child cgroup cannot see refusals recorded by its parent.
> An in-pod reading of zero does **not** exonerate the cgroup.

Read the **pod slice**, from the host:

```bash
set -o pipefail
POD_UID=$(kubectl -n <ns> get pod <pod> -o jsonpath='{.metadata.uid}' | tr - _) \
  || { echo "kubectl failed"; exit 1; }
[ -n "$POD_UID" ] || { echo "pod not found"; exit 1; }
D=/sys/fs/cgroup/hugetlb/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${POD_UID}.slice
cat "$D/hugetlb.2MB.limit_in_bytes" "$D/hugetlb.2MB.failcnt"
```

`set -o pipefail` matters: without it the assignment takes the exit status of `tr`, so a failed
`kubectl` yields status 0 and an empty UID, and you go on to read a path built from nothing.

> This path is the **systemd** cgroup-driver layout, which is what the tested cluster uses
> (`cgroupDriver: systemd` in `/var/lib/kubelet/config.yaml`) and the common default. Under the
> `cgroupfs` driver the shape differs — `/sys/fs/cgroup/hugetlb/kubepods/burstable/pod<uid>/`,
> with the UID keeping its hyphens and no `.slice` suffix. Check `cgroupDriver` on the node
> before assuming either. A non-default `--cgroup-root` shifts the prefix as well.

Adjust `burstable` to `besteffort`, or drop that path element entirely for Guaranteed pods —
only Burstable and BestEffort get a QoS-level cgroup. Substitute the node's default hugepage
size in the filenames: `hugetlb.2MB.*` on x86_64, `hugetlb.512MB.*` on arm64 builds that
default to 512 MiB pages (`grep Hugepagesize /proc/meminfo`).

A `limit` of `0` with a `failcnt` that increments on every crash confirms the diagnosis.
Measured values around a single failing `initdb`:

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

(Use the resource name matching the node's default page size — `hugepages-512Mi` on arm64
builds that default to 512 MiB pages.) **Blank output means the node is not advertising that
hugepage size** — the command still exits 0, so an empty line is a result, not a failure.

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
| Instance already bootstrapped, only failing to restart | Set the `huge_pages: "off"` parameter. Applies to every major version in scope here (13-18). |
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

> **Caution.** `bootstrap.initdb.options` is a deprecated field. Setting it makes
> `buildInitDBFlags` return early, so the operator ignores **every** explicit `initdb` setting:
> `dataChecksums`, `encoding`, `locale`, `localeCollate`, `localeCType`, `localeProvider`,
> `icuLocale`, `icuRules`, `builtinLocale`, and `walSegmentSize`. The cluster-level
> `logLevel` → `-d` side effect is skipped too. Diff your current `bootstrap.initdb` block
> before adding `options`, and restate everything you rely on as raw flags in the same list:
>
> ```yaml
> options: ["-c", "huge_pages=off", "--encoding=UTF8", "--lc-collate=C", "--lc-ctype=C", "-k"]
> ```
>
> Verified in that argv order: `initdb` exits 0, `postgresql.conf` carries `huge_pages = off`,
> and the resulting cluster reports UTF8 / C / C with `data_checksums=on`. Clusters using ICU
> locale settings are the ones most at risk of silent loss here.

### If a CloudNativePG bootstrap has already been failing for a while

Patching the Cluster spec only works if the `-initdb` Job is still retrying. Once it has
exhausted its backoff, **the fix above has no effect on its own** — and the cluster gives you
almost no signal that this has happened. Sequence observed end-to-end on operator
`v1.29.1-acp.1`:

1. The `-initdb` Job runs `restartPolicy: Never` with the default `backoffLimit: 6`, so it
   stops after 7 pod attempts (about 10 minutes of exponential backoff) and is marked
   `Failed / BackoffLimitExceeded`.
2. **`status.phase` stays `Setting up primary` regardless.** The reconciler is stuck earlier,
   logging `Selected PVC is not ready yet, waiting for 1 second` in a tight loop, because the
   PVC from the failed attempt never received its ready marker. Diagnose from the Job, not the
   Cluster phase:

   ```bash
   kubectl -n <ns> get jobs -l cnpg.io/cluster=<cluster>
   kubectl -n <ns> get cluster <cluster> -o jsonpath='{.status.danglingPVC}{"\n"}'
   ```

   A `Failed` Job plus a non-empty `danglingPVC` is this state. (Operator v1.29.2 and later
   include upstream #11035, "report failed instance creation jobs instead of waiting forever",
   which surfaces it in the phase instead. `v1.29.1-acp.1` does not.)
3. Patching the spec does nothing — the failed Job is not replaced.
4. Deleting the Job does not help either; the PVC loop continues.
5. **Do not delete the PVC by itself.** That moves the cluster into a second and worse state:
   `One or more instances were previously created, but no PersistentVolumeClaims (PVCs) exist.
   The cluster is in an unrecoverable state. To resolve this, restore the cluster from a recent
   backup.`

**Recovery: delete the Cluster and recreate it with the fix already in the spec.**

```bash
kubectl -n <ns> delete cluster <cluster>
kubectl -n <ns> apply -f cluster-with-huge-pages-off.yaml
```

This is safe *specifically because bootstrap never completed* — there is no data in that PVC to
lose. Verified: the recreated cluster reached `Running` with `huge_pages=off` on the same
hugepage-enabled node. **Never do this to a cluster that bootstrapped successfully and later
failed to restart** — that one has data, and the GUC-only fix in the table above applies.

The practical conclusion is to put the fix in the manifest *before* first apply on any node
that has, or might get, a hugepage pool.

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

**PostgreSQL 15 and later** can estimate the requirement for you. The parameter needs a data
directory — it cannot be queried on an empty container:

```bash
# against an existing instance
kubectl -n <ns> exec <pod> -- bash -c \
  'postgres -D "$PGDATA" -c shared_buffers=256MB -C shared_memory_size_in_huge_pages'
```

**It returns a page count, not a size.** Multiply by the node's default hugepage size to get the
resource quantity. The same default `shared_buffers` returns `75` on a node with 2 MiB pages
and `1` on a node with 512 MiB pages — writing the raw number into
`hugepages-2Mi: <count>Mi` under-provisions by the page-size factor.

Measured on PostgreSQL 18.4 with 2 MiB pages: 75 pages at the 128 MB default, 543 at
`shared_buffers=1GB`, 4222 at `8GB` — roughly `shared_buffers` plus 10-15% of control
structures, so budget headroom rather than an exact fit. An exact-fit limit means any later
growth of the shared memory segment faults into SIGBUS instead of failing cleanly at startup.

**PostgreSQL 14 and earlier do not have this parameter** — `postgres -C
shared_memory_size_in_huge_pages` returns `FATAL: unrecognized configuration parameter`
(verified on 13 and 14; present from 15). Size those manually: `shared_buffers` plus about 15%,
divided by the page size, rounded up.

Before a first bootstrap there is no data directory on any version, so the query is unavailable
— there is no `--config-file` shortcut, `postgres` still demands `-D`. Either run `initdb` into
a throwaway directory purely to take the measurement, or use the manual estimate.

> **Match the page size to the node.** The resource name and the page count both follow the
> node's *default* hugepage size, which is what `huge_pages=on` consumes
> (`huge_page_size = 0` means "use the system default"). Check it first:
>
> ```bash
> grep Hugepagesize /proc/meminfo
> ```
>
> x86_64 nodes are normally `2048 kB` → request `hugepages-2Mi`. Some arm64 builds, including
> Kylin Linux Advanced Server V10 on 64 KiB pages, default to `524288 kB` → the resource is
> `hugepages-512Mi` and every count above is in 512 MiB units. Requesting `hugepages-2Mi` on
> such a node asks for a resource it does not advertise, and the pod stays `Pending`.

The node must also advertise the resource at all — see the kubelet restart note above.

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
