---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Removing Rook-Ceph fails in the UI, or the CephCluster stays in Deleting on ACP

## Issue

Ceph distributed storage has to be removed from a cluster of Alauda Container Platform, and the removal does not finish:

- Deleting the distributed storage from the UI fails.
- The product cleanup procedure was followed and every PVC on Ceph was deleted, but `kubectl get cephclusters -A` keeps showing `rook-ceph/ceph-cluster` with PHASE `Deleting`, MESSAGE `Deleting the CephCluster`, and HEALTH `HEALTH_WARN`. Removing the finalizers once did not make it go away.
- Some PVCs on Ceph belong to cluster services, and it is unclear what removing Ceph does to them.

This article covers the whole `CephCluster` (`cephclusters.ceph.rook.io` in namespace `rook-ceph`, for example `ceph-cluster` with `DATADIRHOSTPATH` `/var/lib/rook`; Rook puts the finalizer `cephcluster.ceph.rook.io` on it). A single `CephObjectStore` stuck in `Deleting` while the cluster is healthy is covered in [CephObjectStore stays in Deleting with failed to list buckets no route to host on ACP](./CephObjectStore_stays_in_Deleting_with_failed_to_list_buckets_no_route_to_host_on_ACP.md).

## Root Cause

### Cause 1: distributed storage deletion fails in the UI

When the UI deletion fails, Ceph is removed manually with the product documentation topic "Cleanup Distributed Storage". That procedure removes the distributed storage resources in order, starting with the VolumeSnapshotClasses and then the StorageClasses, and requires every PVC and PV that uses Ceph to be deleted first.

Removing Ceph deletes the data in every PVC Ceph backs, including PVCs of platform or cluster services, not only business PVCs. The impact on those services has to be settled before deletion.

### Cause 2: PHASE Deleting, MESSAGE Deleting the CephCluster, because finalizers remain

After the PVCs were removed and the cleanup procedure was followed, the `CephCluster` object still carries finalizers, so Kubernetes keeps it in `Deleting`. A partial finalizer edit leaves some of them behind and the object stays.

## Resolution

### Cause 1: distributed storage deletion fails in the UI

1. List what still uses Ceph:

```bash
kubectl get pvc -A -o wide | grep -E 'ceph|rbd|cephfs'
kubectl get pv | grep -E 'ceph|rbd|cephfs'
kubectl get sc
kubectl get volumesnapshotclass
```

2. For each PVC, find its owner. If any belongs to a platform or cluster service, decide with the service owner how its data is migrated or backed up first.

> **Warning:** Removing Ceph deletes the data in every Ceph-backed PVC, including PVCs of cluster services, and those services stop working. Precondition: every Ceph PVC is listed, each owner has agreed, and data that must survive is migrated or backed up outside this Ceph cluster. Rollback: none; a new Ceph cluster does not bring the data back.

3. Open "Cleanup Distributed Storage" in the product documentation for the installed version (also reachable from the help entry in the top-right corner of the platform) and run its steps in order. If the `CephCluster` then stays in `Deleting`, continue with Cause 2.

### Cause 2: PHASE Deleting, MESSAGE Deleting the CephCluster, because finalizers remain

Use this only when the cleanup procedure has been followed up to the cluster deletion, no PVC or PV that uses Ceph remains, and the `CephCluster` stays in `Deleting`.

1. Check what is still there:

```bash
kubectl get cephclusters -A
kubectl -n rook-ceph get cephcluster ceph-cluster -o jsonpath='{.metadata.finalizers}{"\n"}'
kubectl get pv | grep -E 'ceph|rbd|cephfs'
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=100
```

If the operator log names objects that still depend on the cluster, clean those up first, following the procedure, before touching finalizers.

> **Warning:** Removing the finalizers lets Kubernetes delete the `CephCluster` object without waiting for Rook to finish its cleanup. Rook then no longer manages anything of this cluster; data on the OSD disks and under `/var/lib/rook` on the nodes stays until the procedure's later steps clean it. Precondition: you have decided to remove this Ceph cluster, every Ceph PVC and PV is gone, and the earlier steps of the procedure are done. Rollback: none.

2. Remove all finalizers and check the result:

```bash
kubectl -n rook-ceph patch cephcluster ceph-cluster --type merge -p '{"metadata":{"finalizers":null}}'
kubectl -n rook-ceph get cephcluster ceph-cluster -o jsonpath='{.metadata.finalizers}{"\n"}'
kubectl get cephclusters -A
```

Editing the object with `kubectl edit cephclusters -n rook-ceph ceph-cluster` and deleting the whole `finalizers` list has the same effect; check afterwards that the list is really empty. `No resources found` from `kubectl get cephclusters -A` means the object is gone.

3. Continue with the remaining steps of the cleanup procedure (operator removal and disk cleanup on the nodes).

## Diagnostic Steps

```bash
kubectl get cephclusters -A
kubectl -n rook-ceph get cephcluster ceph-cluster -o yaml | grep -A5 finalizers
kubectl get pvc -A | grep -E 'ceph|rbd|cephfs'
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=100
```

- UI deletion fails and Ceph PVCs still exist: Cause 1. Settle the data impact, then run the cleanup procedure.
- `Deleting` / `Deleting the CephCluster` after the PVCs and PVs are gone, with a non-empty `finalizers` list: Cause 2.
- The operator log names dependent objects: clean those first, following the procedure.
