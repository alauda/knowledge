---
title: When etcd auto-defragmentation does not run on Alauda Container Platform
component: configure
scenario: troubleshooting
tags: [etcd, defragmentation, kube-system, control-plane]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# When etcd auto-defragmentation does not run on Alauda Container Platform

## Issue

On Alauda Container Platform (kube v1.34.5), the etcd database size keeps growing on the control plane and never appears to shrink on its own. Operators expect a periodic, automatic defragmentation cycle, but the on-disk size reported by `etcdctl endpoint status` stays flat or grows even though etcd itself is healthy and accepting writes. A manual defragmentation, on the other hand, reliably reduces the on-disk size [ev:c4].

The platform ships etcd as a kubeadm-managed static pod (`etcd-<control-plane-IP>` in the `kube-system` namespace), running the upstream `tkestack/etcd:v3.5.28-260421` image. The kubelet starts whatever manifest is in `/etc/kubernetes/manifests/etcd.yaml`; no higher-level controller reconciles defragmentation policy on top of it [ev:c4].

## Root Cause

The upstream etcd binary supports defragmentation as a client-driven operation (`etcdctl defrag`), but it does not defragment itself on a schedule [ev:c4]. The static-pod manifest enables only the periodic compaction loop (`--auto-compaction-mode=periodic --auto-compaction-retention=24h`), which reclaims logical revisions in the MVCC store but leaves the underlying BoltDB file allocated. Compaction reduces `current-db-size-in-use-bytes`; defragmentation is the separate operation that shrinks `current-db-size-bytes` back down to match [ev:c4][ev:c2].

The signal that tells an operator whether defragmentation is worthwhile is the fragmentation ratio, computed from the two size fields etcd already exposes:

```text
fragmentation = (size_on_disk - size_in_use) / size_on_disk
```

Where `size_on_disk` is the BoltDB file's allocated bytes and `size_in_use` is the bytes occupied by live (post-compaction) revisions [ev:c2]. A high ratio means the file has accumulated free pages that only `defrag` will reclaim.

## Resolution

Read the fragmentation telemetry from the etcd pod's own log, then run a manual defragmentation when the ratio justifies it [ev:c2][ev:c4].

The periodic compaction loop emits one log line every five minutes that carries both size fields:

```bash
kubectl -n kube-system logs etcd-<control-plane-IP> --tail=200 \
  | grep 'finished scheduled compaction'
```

A representative entry looks like:

```text
{"level":"info","caller":"mvcc/kvstore_compaction.go:72","msg":"finished scheduled compaction",
 "compact-revision":1198057,"took":"216.242588ms",
 "current-db-size-bytes":99495936,"current-db-size":"100 MB",
 "current-db-size-in-use-bytes":62197760,"current-db-size-in-use":"62 MB"}
```

Compute the ratio from `current-db-size-bytes` and `current-db-size-in-use-bytes` in that line — that is the same arithmetic the upstream rule of thumb uses [ev:c2]. Operators typically run defragmentation once the ratio crosses roughly 45% on a database larger than ~100 MiB; below that threshold the reclaimable space is usually not worth the brief write blocking that defragmentation incurs [ev:c2].

When the ratio justifies it, run defragmentation directly against the local member. The etcd image ships the standard `etcdctl` binary and the kubeadm-style PKI paths are mounted at `/etc/kubernetes/pki/etcd/` inside the pod [ev:c4]:

```bash
kubectl -n kube-system exec etcd-<control-plane-IP> -- \
  etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    defrag
```

Confirm the on-disk size shrank by re-reading endpoint status:

```bash
kubectl -n kube-system exec etcd-<control-plane-IP> -- \
  etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    endpoint status -w table
```

The `DB SIZE` column is the same number `current-db-size-bytes` reports in the compaction log; a successful defragmentation drops it close to the in-use value [ev:c4].

In a multi-master deployment, repeat the defragmentation per member, one at a time, against each member's `etcd-<control-plane-IP>` pod — etcd serves reads and writes from the surviving quorum while one peer is briefly blocked during its own defrag [ev:c4].

## Diagnostic Steps

Inspect the live database state with `etcdctl endpoint status` against the local member; the `DB SIZE` column reflects the on-disk allocation that defragmentation would shrink [ev:c4]:

```bash
kubectl -n kube-system exec etcd-<control-plane-IP> -- \
  etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    endpoint status -w table
```

To estimate the fragmentation ratio without invoking `etcdctl`, scrape the most recent `mvcc/kvstore_compaction.go` line from the etcd pod log and apply the arithmetic above against `current-db-size-bytes` and `current-db-size-in-use-bytes` [ev:c2]:

```bash
kubectl -n kube-system logs etcd-<control-plane-IP> --tail=400 \
  | grep -oE '"current-db-size-bytes":[0-9]+|"current-db-size-in-use-bytes":[0-9]+' \
  | tail -2
```

If the ratio remains high after a defragmentation, run the defrag command again — a single pass cannot reclaim pages still pinned by an in-flight transaction, and a second pass usually completes the reclaim [ev:c4].
