---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Harbor unreachable or its PostgreSQL out of space because Harbor storage is full

## Issue

Image push to Harbor does not succeed, no image can be selected when an application is deployed, and a Harbor PVC shows 100 percent usage. Variants of the same capacity problem:

- Harbor is unreachable. Redis writes fail, Redis keeps re-running leader election, and Harbor cannot connect to Redis. Every Harbor component can be Running while pushes fail, and a restart shows Redis cannot write.
- An expansion of the Harbor PVC is rejected because the StorageClass does not support expansion. The PVC object can show a small requested size while the mount is already at 100 percent.
- The PostgreSQL database used by Harbor has run out of storage.
- While the full volume is being fixed, Pods on one TopoLVM data node cannot create containers and their events repeat:

  ```text
  Failed to create pod sandbox: rpc error: code = NotFound desc = failed to create containerd container: failed to create snapshot: missing parent "k8s.io/<n>/sha256:<digest>" bucket: not found
  ```

On the `harbor-core` side, a Redis that cannot persist shows up as:

```text
failed to ping redis://...: MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on disk.
failed to initialize cache: retry timeout
```

## Root Cause

### Cause 1: the NFS export behind Harbor is full

Harbor Redis, and sometimes the other Harbor volumes, are on an NFS StorageClass. When the NFS export fills up, Redis cannot persist writes, leader election runs again and again, and Harbor loses Redis and becomes unreachable.

An NFS-backed volume does not take its limit from the PVC size: the Pod sees the free space of the export. Growing `spec.resources.requests.storage` does not add blocks, and an NFS StorageClass commonly does not support expansion at all. The capacity is the export.

A common NFS class is the NFS client provisioner (provisioner `fuseim.pri/ifs`, often named `nfs-client` and set as the default class):

```yaml
kind: StorageClass
metadata:
  name: nfs-client
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: fuseim.pri/ifs
reclaimPolicy: Delete
parameters:
  archiveOnDelete: "false"
```

This provisioner creates one directory per PVC on a single shared export. Every PVC on the class, from Harbor or any other workload, draws on the same free space, so another workload can fill the export that Harbor Redis writes to. As the default class, it also receives every PVC that names no StorageClass. With `reclaimPolicy: Delete` and `archiveOnDelete: "false"`, deleting a PVC deletes its directory on the export, so deleting and recreating the Redis PVC discards the Redis data.

### Cause 2: a TopoLVM PVC shared by the Harbor components is full

When all Harbor components, PostgreSQL included, store their data on one TopoLVM PVC, that PVC can run out of space. The database can no longer write (PostgreSQL usually reports `No space left on device`), and image uploads fail. Unlike NFS, a TopoLVM volume is a logical volume of the PVC's size on one node, so expanding the PVC adds space, as long as the volume group on that node has free capacity.

### Cause 3: corrupt containerd data on a TopoLVM data node blocks the recovery

The containerd data on one node is corrupt: the snapshot metadata points to a parent snapshot that no longer exists. No Pod on that node can create a container, and every Pod there fails with `FailedCreatePodSandBox ... missing parent ... bucket: not found`, while Pods on other nodes start normally. When the node is a TopoLVM data node, its TopoLVM Pods (for example `topolvm-prepare-vg-<id>` in `nativestor-system`) cannot start either, TopoLVM stays abnormal on that node, and the expansion of a full Harbor PVC (Cause 2) has to wait. Resetting the containerd data on that node makes container creation work again. This is a container runtime fault on the node, not a Harbor fault.

## Resolution

### Cause 1

1. Identify the export and confirm it is the full filesystem:

   ```bash
   NS=<harbor-namespace>
   kubectl -n "$NS" get pvc -o custom-columns='NAME:.metadata.name,SC:.spec.storageClassName,VOLUME:.spec.volumeName'
   kubectl get sc <storageclass-name> -o yaml
   kubectl get pv <pv-name> -o jsonpath='{.spec.nfs.server}{" "}{.spec.nfs.path}{"\n"}'
   REDIS=$(kubectl -n "$NS" get pods -o name | grep redis | head -1)
   kubectl -n "$NS" exec "$REDIS" -- df -h
   kubectl -n "$NS" logs "$REDIS" --tail=100
   ```

   If `.spec.nfs` is empty, the server and path are in the CSI `volumeAttributes` of the PV.

2. Expand the export on the NFS server (or the storage array behind it) until `df` in the Pod shows free space. No Harbor resource change and no PVC resize is needed.

3. If the export cannot grow, remove only files on it that the storage owner confirms are unused.

   > **Warning:** Only when `df` on this export is full, Redis shows write failures or repeated leader election, and the file is confirmed unused. Impact: deletion cannot be undone. Precondition: the PV server and path match this export, and a copy or snapshot exists of anything Harbor might still reference. Rollback: only by restoring that copy.

   ```bash
   # On the NFS server, export path taken from the PV:
   du -xhd1 <export-path> | sort -h
   rm -f <export-path>/<confirmed-unused-file>
   ```

4. If the Redis Pod is still in `CrashLoopBackOff` after `df` shows free space, restart only that Pod.

   > **Warning:** Only when the export is no longer full and Redis is still crash-looping. Impact: Redis restarts and drops its in-memory data for one start. The controller recreates the Pod and the volume is kept; Redis rebuilds its cache.

   ```bash
   kubectl -n "$NS" delete "$REDIS"
   ```

### Cause 2

1. Confirm which PVC is full, that it is TopoLVM, that its StorageClass allows expansion, and that the node holding the volume has free capacity:

   ```bash
   NS=<harbor-namespace>
   kubectl -n "$NS" get pvc -o custom-columns='NAME:.metadata.name,SC:.spec.storageClassName,REQ:.spec.resources.requests.storage,CAP:.status.capacity.storage'
   kubectl -n "$NS" exec <harbor-pg-pod> -- df -h
   kubectl get sc <storageclass-name> -o jsonpath='{.provisioner}{" "}{.allowVolumeExpansion}{"\n"}'
   kubectl get pv <pv-name> -o jsonpath='{.spec.nodeAffinity}{"\n"}'
   kubectl get node <node-name> -o yaml | grep -i capacity
   ```

   On ACP the default TopoLVM class `topolvm-hdd` uses provisioner `topolvm.cybozu.com`. The PV `nodeAffinity` names the node that holds the logical volume; its TopoLVM capacity annotation shows what the volume group can still give. Check that the TopoLVM Pods on that node are Running (`kubectl -n nativestor-system get pods -o wide`); if they are not, fix Cause 3 first.

2. Expand the PVC.

   > **Warning:** Only when `df` shows the TopoLVM PVC full, `allowVolumeExpansion` is `true`, and the node has more free capacity than the increase. Impact: the TopoLVM CSI driver extends the logical volume and the filesystem using space from that node's volume group. This cannot be undone: Kubernetes does not allow a PVC request to be reduced.

   ```bash
   kubectl -n "$NS" patch pvc <harbor-pvc> --type=merge \
     -p '{"spec":{"resources":{"requests":{"storage":"<new-size>"}}}}'
   kubectl -n "$NS" get pvc <harbor-pvc> -o jsonpath='{.status.capacity.storage}{"\n"}'
   kubectl -n "$NS" exec <harbor-pg-pod> -- df -h
   ```

   If `status.capacity` has grown but `df` has not, read the PVC conditions with `kubectl -n "$NS" describe pvc <harbor-pvc>`.

3. If the Harbor resource declares a size for this PVC, set it to the new size. A PVC larger than the declared size makes every Harbor Pod cycle on the next edit of the Harbor resource; see [Harbor core service unavailable or internal server error, stuck instance status, or Pods cycling after an edit](Harbor_core_service_unavailable_or_internal_server_error_stuck_instance_status_or_Pods_cycling_after_an_edit.md) (Cause 4).

4. Verify that image push works and that images can be selected in application deployment.

### Cause 3

1. Confirm that the error is limited to one node:

   ```bash
   kubectl -n nativestor-system get pods -o wide
   kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name> | grep -v -E 'Running|Completed'
   kubectl get events -A --field-selector reason=FailedCreatePodSandBox | grep -E 'missing parent|bucket: not found'
   ```

   On the node, find the containerd root and check the runtime log:

   ```bash
   sudo containerd config dump | grep -E '^(root|state) '
   sudo journalctl -u containerd --since "1 hour ago" | grep -E 'missing parent|bucket: not found' | tail -20
   ```

2. Drain the node.

   > **Warning:** Only when Pods on this node fail with `failed to create snapshot: missing parent ... bucket: not found` and Pods on other nodes start normally. Impact: the node's Pods are evicted; Pods whose TopoLVM volumes are on this node stay Pending until it is back. Precondition: a maintenance window for the workloads on this node. Rollback: `kubectl uncordon <node-name>`.

   ```bash
   kubectl cordon <node-name>
   kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
   ```

3. Reset the containerd data by moving the data directory aside (the default root is `/var/lib/containerd`; use the `root` value printed in step 1 if it differs).

   > **Warning:** Only after step 2. Impact: every container on the node stops, and afterwards the node has no local images and pulls every image again, including the sandbox (pause), TopoLVM, and CSI images. Precondition: the registries those images come from are reachable from the node; images stored only in the Harbor being repaired cannot be pulled until Harbor works again. Rollback: stop `kubelet` and `containerd`, move the saved directory back, and start both services, which also brings back the corrupt state.

   ```bash
   sudo systemctl disable --now kubelet
   sudo systemctl disable --now containerd
   sudo reboot
   # after the reboot both services stay stopped:
   sudo mv /var/lib/containerd /var/lib/containerd.bak-$(date +%Y%m%d%H%M)
   sudo systemctl enable --now containerd
   sudo systemctl enable --now kubelet
   ```

4. Bring the node back and check TopoLVM:

   ```bash
   kubectl get node <node-name>
   kubectl uncordon <node-name>
   kubectl -n nativestor-system get pods -o wide | grep <node-name>
   ```

   The Pods on the node, including the TopoLVM Pods, reach Running with no new `FailedCreatePodSandBox` events. Then expand the full Harbor PVC (Cause 2). Remove the saved `/var/lib/containerd.bak-<date>` directory only after the node has run normally for a while; that removal cannot be undone.

## Diagnostic Steps

Read the StorageClass of the full volume first: NFS is Cause 1, TopoLVM is Cause 2.

```bash
NS=<harbor-namespace>
kubectl -n "$NS" get pvc -o custom-columns='NAME:.metadata.name,SC:.spec.storageClassName,REQ:.spec.resources.requests.storage,CAP:.status.capacity.storage'
kubectl get pods -A -o wide | grep -E 'harbor|redis'
kubectl -n "$NS" exec <redis-or-pg-pod> -- df -h
kubectl get sc <storageclass-name> -o jsonpath='{.provisioner}{" "}{.allowVolumeExpansion}{"\n"}'
```

| What you see | Cause |
| --- | --- |
| Redis write failures or repeated leader election, `MISCONF ... not able to persist on disk` in core, NFS export at 100 percent; or a PVC expand rejected on an NFS class | Cause 1: on NFS, `df -h <export-path>` on the server is the reading that matters, not the PVC capacity |
| `df` in the PostgreSQL Pod full on a TopoLVM PVC | Cause 2: the PVC size is the ceiling, expand it |
| Pods on one node fail with `FailedCreatePodSandBox ... missing parent ... bucket: not found` | Cause 3: fix the node before expanding |
| `too many clients already` or `wal_keep_segments` in the database log | [Harbor PostgreSQL rejects sessions with too many clients already (SQLSTATE 53300)](Harbor_PostgreSQL_rejects_sessions_with_too_many_clients_already_SQLSTATE_53300.md) or [Harbor PostgreSQL database Pod never starts after an operator upgrade, with transparent huge pages, low CPU, or on NFS](Harbor_PostgreSQL_database_Pod_never_starts_after_an_operator_upgrade_with_transparent_huge_pages_low_CPU_or_on_NFS.md) |
