---
title: Diagnosing a large dentry slab and tuning negative-dentry pressure on ACP nodes
component: configure
scenario: troubleshooting
tags: [node, kernel, dentry, slab, drop_caches, vfs_cache_pressure, pleg]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Diagnosing a large dentry slab and tuning negative-dentry pressure on ACP nodes

## Issue

Workloads on an ACP worker node intermittently show slow file-related syscalls (lookup, unmount, reclaim), brief container-runtime stalls, or kubelet flips that surface as a node Ready condition going `False` — usually the standard `Ready / MemoryPressure / DiskPressure / PIDPressure` set the kubelet maintains [ev:c4]. The condition flips back to `True / KubeletReady` once the kubelet relist catches up, but the symptom recurs.

A dentry is the kernel object that names a file path; the Linux dcache keeps these objects in memory so path lookups are fast [ev:c1_a]. The dcache also caches *negative dentries* — entries that remember a previous lookup for a path that did not exist [ev:c1_b]. On a node under pressure the dentry slab can grow to hundreds of thousands of active objects, which is observable on any ACP worker via `/proc/slabinfo` and `/proc/sys/fs/dentry-state` [ev:c6][ev:c7].

## Root Cause

Each lookup of a non-existent path can install a negative dentry, and these accumulate over time because they cover paths that never existed and are not bounded by anything on disk [ev:c2]. A common driver inside a container platform is a probe (liveness/readiness) or a periodic command that repeatedly resolves missing files or library paths; on a lab ACP node a deliberate loop of 5000 `stat(2)` calls against non-existent paths increased the `nr_negative` field of `/proc/sys/fs/dentry-state` from 1568 to 6857 within seconds [ev:c5]. The same mechanism applies to any frequently-invoked process whose lookup pattern misses.

The modern Linux kernel that ships with the ACP node OS (Ubuntu 22.04, kernel 5.15.0-56-generic on the lab cluster used to ground this article) provides the generic reclaim controls `vfs_cache_pressure` (default `100`), `swappiness`, and `drop_caches` under `/proc/sys/vm/`, and exposes only `dentry-state` under `/proc/sys/fs/` for dcache visibility [ev:c11]. There is no per-kernel knob to cap the absolute number of negative dentries — the kernel relies on its general slab-shrinker pressure to reclaim them.

## Resolution

For an immediate, version-agnostic mitigation on any ACP node, write `2` to `/proc/sys/vm/drop_caches`; this tells the kernel to release reclaimable slab pages, which includes the dentry and inode caches. On a lab worker this collapsed the dentry slab from `230554` active objects to `33204` and the `nr_negative` counter from `49153` to `221` — about a 99 % release [ev:c12]:

```bash
# from a privileged debug pod with hostPID + hostPath /proc mounted as /hostproc
echo 2 > /hostproc/sys/vm/drop_caches
```

The write is non-destructive — it only releases memory the kernel was already willing to reclaim on the next pressure event, the same memory accounted for in `/proc/slabinfo`'s dentry row [ev:c6]. The sysctl is write-only (`--w-------`) so `cat` returns `Permission denied`; that is expected on this kernel.

For sustained pressure, also adjust `vfs_cache_pressure`. The default `100` keeps reclaim biased toward staying in cache; raising the value biases the kernel toward reclaiming dentries and inodes sooner [ev:c11]:

```bash
# bias the kernel toward reclaiming dentries/inodes more aggressively
sysctl -w vm.vfs_cache_pressure=200
```

The change takes effect immediately; observe the dentry slab over time before persisting it to `/etc/sysctl.d/` [ev:c6].

Note: legacy RHEL7 kernels carried a vendor patch exposing `fs.negative-dentry-limit` to cap the negative-dentry count as a soft percentage of total memory. That knob is not part of upstream Linux and is not present on the ACP node OS — listing `/proc/sys/fs/` on the lab kernel (5.15.0-56-generic on Ubuntu 22.04) shows only `dentry-state` matching a `dentry|klimit` grep [ev:c11]. Recipes that write to `fs.negative-dentry-limit` do not apply here; use `drop_caches` and `vfs_cache_pressure` instead.

## Diagnostic Steps

Schedule a privileged debug pod on the worker under investigation, then read `/proc/sys/fs/dentry-state` and `/proc/slabinfo` from inside the pod via a `hostPath` mount [ev:c6][ev:c7]. The pod needs `hostPID: true` so the host's `/proc` is accessible:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: dentry-probe
  namespace: <article-namespace>
spec:
  hostPID: true
  nodeName: <node-name>
  tolerations:
  - operator: Exists
  containers:
  - name: probe
    image: registry.alauda.cn:60080/3rdparty/kubectl:v4.3.3
    command: ["sleep","3600"]
    securityContext:
      privileged: true
    volumeMounts:
    - { name: host,     mountPath: /host }
    - { name: hostproc, mountPath: /hostproc }
  volumes:
  - { name: host,     hostPath: { path: / } }
  - { name: hostproc, hostPath: { path: /proc } }
```

Inspect the dentry slab. The first numeric column is `active_objs`; on a healthy node this grows with load but should not stay at multi-hundred-thousand levels without dropping back during memory reclaim [ev:c6]:

```bash
kubectl exec -n <article-namespace> dentry-probe -- \
  sh -c 'grep -e active_objs -e ^dentry /hostproc/slabinfo'
```

Sample output:

```text
# name            <active_objs> <num_objs> <objsize> <objperslab> ...
dentry            230497 231021    192   21    1 ...
```

Read `/proc/sys/fs/dentry-state` to break the slab down into total dentries, unused dentries, and the negative-dentry count. The fields, in order, are `nr_dentry`, `nr_unused`, `age_limit`, `want_pages`, `nr_negative`, and a reserved slot — the 5th value is the one to watch for negative-dentry growth [ev:c7]:

```bash
kubectl exec -n <article-namespace> dentry-probe -- cat /hostproc/sys/fs/dentry-state
# 230230  197653  45  0  49123  0
#                            ^^^^^ nr_negative
```

To confirm the mechanism on a candidate node, run a short missed-lookup loop and re-read the counter; an increase of several thousand in `nr_negative` confirms that missed `stat(2)` calls install negative dentries on this kernel [ev:c2][ev:c5]:

```bash
kubectl exec -n <article-namespace> dentry-probe -- sh -c '
  cat /hostproc/sys/fs/dentry-state
  chroot /host sh -c "for i in \$(seq 1 5000); do stat /tmp/does-not-exist-\$i 2>/dev/null; done; true" >/dev/null 2>&1
  cat /hostproc/sys/fs/dentry-state'
```

When the node is misbehaving, correlate with the kubelet `Ready` condition history (`kubectl get node <name> -o jsonpath='{.status.conditions}'`); the condition uses the standard upstream `NodeCondition` schema, so a `Ready=False` with a `PLEG`-related reason indicates the kubelet relist could not complete in time [ev:c4]. Combining the slab and condition reads tells you whether the dcache is the cause or an effect.

Once the source process has been identified — typically by inspecting probe definitions, periodic CronJobs, or an in-cluster agent — release the accumulated slab on demand and verify the drop:

```bash
kubectl exec -n <article-namespace> dentry-probe -- sh -c '
  cat /hostproc/sys/fs/dentry-state
  echo 2 > /hostproc/sys/vm/drop_caches
  cat /hostproc/sys/fs/dentry-state'
```

A two-line comparison shows the `nr_negative` field collapsing to a low double-digit value, confirming that the workaround is effective on the node and that the underlying source still needs a fix [ev:c12].
