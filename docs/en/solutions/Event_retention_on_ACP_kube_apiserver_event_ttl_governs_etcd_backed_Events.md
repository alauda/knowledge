---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.3.x
---

# Event retention on ACP — kube-apiserver event-ttl governs etcd-backed Events

## Overview

Kubernetes `Event` objects (`v1/Event`) are first-class API resources stored in the cluster's etcd-backed object store, served as a versioned list (`kind: EventList`, with `metadata.resourceVersion` advancing on each write). Each `Event` carries lifecycle fields — `firstTimestamp`, `lastTimestamp`, and a `count` that increments while the same condition keeps firing — and the kube-apiserver applies an `event-ttl` to these objects so that expired entries are garbage-collected from etcd. On Alauda Container Platform running kube-apiserver `v1.34.5` (image `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`), the kube-apiserver is a static pod whose `Pod` object has `metadata.annotations."kubernetes.io/config.source" = file`, so the retention setting lives in the on-node manifest rather than in any cluster-scoped CR [ev:c1].

## Root Cause

The on-node static-pod manifest for kube-apiserver on ACP does not pass the `--event-ttl` flag (a `grep -c 'event-ttl'` of the manifest returns 0). When the flag is omitted, the kube-apiserver falls back to its built-in default, so on this cluster the upstream kube-apiserver default — not an ACP- or operator-specific override — governs how long Events remain in etcd before they are garbage-collected [ev:c1].

## Resolution

Treat `Event` retention on ACP as upstream kube-apiserver behavior governed by the `--event-ttl` flag in the static-pod manifest on each control-plane node. Read the running kube-apiserver pod's image and configuration source to confirm it is the static pod rather than a managed Deployment [ev:c1]:

```bash
kubectl -n kube-system get pod -l component=kube-apiserver \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.kubernetes\.io/config\.source}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
```

To inspect whether `--event-ttl` is set, read the static-pod manifest on the node hosting kube-apiserver (typically under `/etc/kubernetes/manifests/`) and grep for the flag; on this ACP cluster no override is present, so the upstream default applies cluster-wide [ev:c1].

## Diagnostic Steps

To observe the lifecycle of an `Event` end-to-end, generate one from a workload and inspect the API object directly. Create a transient isolation namespace and deploy a Pod that references an image guaranteed to fail to pull; the kubelet and scheduler produce a chain of `Scheduled`, `Pulling`, `Failed`, and `BackOff` Events that the kube-apiserver persists. Each Event surfaces with `firstTimestamp` set to the first occurrence, `lastTimestamp` updated as the condition keeps firing, and `count` incremented per repeat. These fields are dedup / aggregation metadata that let multiple occurrences of the same condition collapse into one object; they are *not* what expires the Event. Retention is governed separately by the kube-apiserver storage-layer TTL set with `--event-ttl`: each Event is written with that TTL, and the apiserver's etcd storage removes it once the TTL elapses, independent of the `firstTimestamp` / `lastTimestamp` / `count` values [ev:c1].

List the Events as a versioned API object to confirm they are etcd-backed [ev:c1]:

```bash
kubectl -n <repro-namespace> get events \
  -o yaml | head -40
```

The output begins with `kind: EventList` and carries a `metadata.resourceVersion` value; each item under `items[]` carries its own `firstTimestamp`, `lastTimestamp`, and `count`. Because the on-node manifest does not pass `--event-ttl`, an Event observed in this namespace remains queryable through the standard upstream retention window before kube-apiserver removes it from etcd [ev:c1].
