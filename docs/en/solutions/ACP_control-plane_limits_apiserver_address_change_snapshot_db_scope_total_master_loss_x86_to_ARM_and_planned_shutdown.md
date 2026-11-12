---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# ACP control-plane limits: apiserver address change, snapshot.db scope, total master loss, x86 to ARM, and planned shutdown

## Issue

- A business-cluster apiserver VIP or URL has changed and the ACP console still uses the old address.
- A namespace was deleted and the only copy left is an etcd `snapshot.db` or `snapshot-etcd` file.
- All masters are lost and the only copy is the platform etcd backup; a version-specific command list for a full restore is requested.
- The `global` cluster runs on x86 and has to move to ARM.
- The whole cluster has a scheduled shutdown.

These are procedure and product-limit questions, not a single-member etcd repair and not a database-full alarm.

Related articles: "Replacing or rejoining an ACP master node: same-IP replacement, etcd-join, extra masters, and control-plane requests".

## Root Cause

### Cause 1: A business cluster apiserver address change has no standard platform procedure

On platform versions 3.12, 3.18, and 4.2 there is no standard procedure to point the console or the `global` cluster at a new business-cluster apiserver VIP or address.

### Cause 2: A deleted namespace cannot be restored on its own from snapshot.db

A single namespace cannot be extracted from `snapshot.db` (running `strings` on the file does not produce the objects). The supported path is a restore of the whole cluster from an etcd backup, which returns every namespace to that backup's point in time. There is no reference procedure for starting a separate etcd just to read one namespace.

### Cause 3: All masters lost with only an etcd backup has no supported restore

There is no supported procedure to rebuild a cluster from the etcd backup alone after all masters are lost, on any version including 4.3, with or without bare-metal masters. An etcd snapshot stores cluster data but not the certificates and keys the cluster needs. The backup job can also save node files (`/etc/kubernetes/pki`, manifests, kubelet configuration, container runtime units), but those are version-specific; a cluster rebuilt from them is not a standard deployment and is likely to fail a later upgrade. A `snapshot-etcd` file is the platform backup, not a namespace extract and not a rebuild kit.

### Cause 4: An x86 global cluster cannot be moved to ARM by replacing servers or importing etcd

Replacing the servers does not change the cluster's CPU architecture, and redeploying an ARM `global` and importing the existing etcd data does not let it take over the existing business clusters. An ARM `global` is a new deployment plus a business migration.

### Cause 5: A scheduled shutdown of the whole cluster

A planned outage needs an etcd backup first and a normal `shutdown` rather than a power cut. Power the nodes off together when possible; otherwise shut down workers first and masters after. After power-on, platform components recover on their own.

## Resolution

### Cause 1: A business cluster apiserver address change has no standard platform procedure

Do not create a procedure by rewriting kube-apiserver manifests or restoring etcd. Collect the old and new URLs and contact Alauda support for a version-specific procedure. The following prints the server URL a kubeconfig uses; it does not update the platform:

```bash
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
```

### Cause 2: A deleted namespace cannot be restored on its own from snapshot.db

Restoring the namespace means restoring the whole cluster from the etcd backup, which is a planned-downtime decision for every namespace, not a partial extract. `file` only identifies the blob:

```bash
file snapshot.db
```

### Cause 3: All masters lost with only an etcd backup has no supported restore

Plan for this before it happens:

1. Take full server or VM backups on a schedule, in addition to the etcd backup.
2. Protect master disks (for example with RAID) and repair failed disks promptly.
3. Run critical workloads on more than one independent cluster.

Check how many etcd members are still running:

```bash
kubectl -n kube-system get pods -l component=etcd -o wide
```

Zero running members with only `snapshot-etcd` or `snapshot.db` left is this limit. With one or more healthy members, the remaining members are repaired or replaced one at a time instead.

### Cause 4: An x86 global cluster cannot be moved to ARM by replacing servers or importing etcd

Plan a new ARM deployment and a migration of the business workloads. `uname -m` only confirms the current architecture:

```bash
uname -m
kubectl get nodes -o wide
```

### Cause 5: A scheduled shutdown of the whole cluster

Take the etcd backup before any power-off: run the backup on the platform's etcd backup task and confirm that a current backup record exists, or take a snapshot with `etcdctl snapshot save` from a healthy member.

```bash
kubectl get etcdbackupconfiguration -A
```

> **Warning:** `shutdown -h now` powers this node off. The etcd backup must already exist. Run it on workers before masters when the nodes cannot go down together. Rollback is powering the node on again. A node that does not return after power-on is a new fault, not a step of this shutdown.

```bash
sudo shutdown -h now
```

After power-on, wait for the platform components to recover and check:

```bash
kubectl get nodes
kubectl get pods -A | grep -v -E 'Running|Completed'
```

## Diagnostic Steps

```bash
kubectl -n kube-system get pods -l component=etcd -o wide
kubectl get nodes -l node-role.kubernetes.io/control-plane= -o wide
kubectl get nodes -o wide
```

- Address change of an existing business cluster on 3.12, 3.18, or 4.2: Cause 1.
- `snapshot.db` in hand and one missing namespace: Cause 2.
- Every master lost and the only copy is an etcd backup: Cause 3.
- x86 `global` to ARM by server swap or etcd import: Cause 4.
- Planned power-off of the whole cluster: Cause 5.
