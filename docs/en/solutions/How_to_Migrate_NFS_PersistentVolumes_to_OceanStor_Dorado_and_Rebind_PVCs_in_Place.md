---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
---

# How to Migrate NFS PersistentVolumes to OceanStor Dorado and Rebind PVCs in Place

## Overview

`PersistentVolumeClaim.spec.volumeName` is immutable. An existing PVC cannot be updated to reference a different PersistentVolume. To migrate a workload to a new NFS volume without changing the PVC name, delete and recreate the PVC with the same name, and pre-bind the new PV to that claim.

This guide describes how to copy the data, reserve the new PV for the original PVC name, and restore the workload. The procedure requires a maintenance window. It is validated for Deployment and StatefulSet workloads.

For a StatefulSet, the PVC names generated from `volumeClaimTemplates` remain unchanged. After migration, the StatefulSet must also be recreated with an updated template so that later scale-out operations use the new StorageClass.

## Environment

| Component | Version |
|-----------|---------|
| Container Platform | ACP 4.x (validated on 4.3.1) |
| Node Operating System | Micro OS 5.5 |
| Storage Device | OceanStor Dorado 6.1.9 |
| OceanStor CSI driver For Dorado | v4.12.0 |
| Source storage | NFS, provisioned by `nfs.csi.k8s.io` |
| Target storage | Dorado NFS (`volumeType: fs`) |
| Validated workloads | Deployment (RWX), StatefulSet (RWO, 2 ordinals) |

> **Note**: The data-copy procedure is for `Filesystem`-mode volumes. A `Block`-mode volume requires a block-level copy method. The PVC rebinding procedure uses Kubernetes objects only and can be applied to other storage types.

## Prerequisites

- An ACP 4.x cluster with the OceanStor CSI driver For Dorado installed and a target NFS StorageClass available.
- `kubectl` access with permission to patch PersistentVolumes, which are cluster-scoped resources.
- A maintenance window in which the workload can be stopped.
- Sufficient capacity on the target array for the new volumes.
- An image that contains `rsync`, or another copy tool that preserves the required file metadata.
- A current backup and a verified rollback plan for the workload.

The following placeholders are used throughout this guide. Replace them with values from your environment:

| Placeholder | Description |
|-------------|-------------|
| `<namespace>` | Workload namespace |
| `<pvc>` | Existing PVC name, which is preserved |
| `<tmp-pvc>` | Temporary PVC used to provision the target volume |
| `<storage-class>` | Target StorageClass backed by the new array |
| `<workload>` | Workload resource, for example `deploy/app` or `sts/web` |
| `<selector>` | Label selector for the workload Pods |
| `<new-pv>` | PV provisioned for the temporary target PVC |

## Resolution

### 1. Review the PVC rebinding requirements

The migration has two operations:

- Copy data from the source volume to the target volume.
- Rebind the original PVC name to the target PV.

The PVC must be deleted and recreated because `PersistentVolumeClaim.spec.volumeName` cannot be changed. The workload manifest can continue to reference the original PVC name.

The PV records its PVC binding in `PersistentVolume.spec.claimRef`:

| Field | Meaning |
|-------|---------|
| `namespace`, `name` | Namespace and name of the claim that owns the volume |
| `uid` | UID of the specific PVC object; a recreated PVC has a different UID |
| `resourceVersion` | Optimistic concurrency token for the referenced object |

These fields determine the PV state:

| `claimRef` condition | PV state and behavior |
|----------------------|-----------------------|
| No `claimRef` | `Available`; any matching PVC can bind |
| `namespace` and `name` are present, but `uid` is absent | `Available`; reserved for the named PVC |
| Complete `claimRef`, and the referenced PVC exists | `Bound` |
| Complete `claimRef`, but the PVC with that `uid` no longer exists | `Released` |

A `Released` PV does not return to `Available` automatically. Reserving the new PV therefore requires two merge patches. The first patch sets the target `namespace` and `name`. Because a merge patch retains unspecified fields, the stale `uid` remains and the PV stays `Released`. The second patch must explicitly set both `uid` and `resourceVersion` to `null`.

Before starting, confirm that the final PVC will match the target PV in all of the following areas:

- The requested capacity does not exceed the PV capacity.
- The PVC access modes are supported by the PV.
- `storageClassName` matches the PV exactly.

### 2. Provision the target volume

Read the source PVC so that the temporary PVC uses compatible access modes and capacity:

```bash
kubectl -n <namespace> get pvc <pvc> \
  -o custom-columns=\
NAME:.metadata.name,MODES:.spec.accessModes,SIZE:.spec.resources.requests.storage
```

Create a temporary PVC on the target StorageClass:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <tmp-pvc>
  namespace: <namespace>
spec:
  # Set these to the source PVC's access modes, read in the previous command.
  # ReadWriteMany matches the validated Deployment; the validated StatefulSet
  # uses ReadWriteOnce. Do not widen the modes unintentionally.
  accessModes: ["ReadWriteMany"]
  storageClassName: <storage-class>
  resources:
    requests:
      # Must be >= the source volume. The rebinding step later creates the
      # final claim against this same volume, so its capacity is fixed here.
      storage: 2Gi
```

Wait until the PVC is bound:

```bash
kubectl -n <namespace> wait --for=jsonpath='{.status.phase}'=Bound \
  pvc/<tmp-pvc> --timeout=180s
```

For a StatefulSet, create one target PVC for each ordinal.

### 3. Copy the initial data

Create a temporary Pod that mounts the source and target PVCs:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: migrator
  namespace: <namespace>
spec:
  restartPolicy: Never
  containers:
    - name: m
      image: <image-with-rsync>
      command: ["sh", "-c", "sleep infinity"]
      volumeMounts:
        - {name: src, mountPath: /src}
        - {name: dst, mountPath: /dst}
  volumes:
    - name: src
      persistentVolumeClaim: {claimName: <pvc>}
    - name: dst
      persistentVolumeClaim: {claimName: <tmp-pvc>}
```

Run an initial copy while the application is still running. This pass moves most of the data before the maintenance window:

```bash
kubectl -n <namespace> exec migrator -- \
  rsync -aHAX --numeric-ids --delete --exclude='/.snapshot' /src/ /dst/
```

Use `rsync` where possible so that the final pass transfers only changed data. Note the following options and their limits:

- `-H` preserves hard links, `-A` preserves POSIX ACLs, and `-X` preserves extended attributes.
- `--numeric-ids` synchronizes UID/GID by numeric value instead of by user and group name, which keeps ownership correct when the source and target hosts have different name-to-ID mappings. It does **not** override NFS squash: `root_squash` and `all_squash` are applied by the NFS server to the client's credentials, independent of any `rsync` flag.
- `-aHAX` does not include `--sparse`. If the data contains sparse files, such as virtual machine images or preallocated database files, add `-S` so that the holes are not written as real data, and size the target volume accordingly.
- `--exclude='/.snapshot'` prevents `--delete` from trying to remove the target volume's read-only `.snapshot` directory. The leading slash limits the match to the volume root.

Without the exclusion, `rsync` can report the following errors and exit with a non-zero status:

```text
rmdir: '/data/.snapshot': Permission denied
rm:    can't remove '/data/.snapshot': Permission denied
```

Because the copy runs across NFS, the copy process must be able to read every source file and to set ownership on the target. Run the migrator as UID 0, confirm that the source export does not squash root, and confirm that the target export allows `chown`. Otherwise, `0600` files may be unreadable or ownership cannot be restored. Test with a representative file before the full copy.

If an image with `rsync` is not available, the following command runs inside the Pod and preserves permissions, ownership, and symbolic links, but transfers all data on every pass:

```bash
kubectl -n <namespace> exec migrator -- sh -c 'tar -C /src -cf - . | tar -C /dst -xpf -'
```

Plain `tar` without `--xattrs --acls` does not preserve POSIX ACLs or extended attributes, and expands sparse files to their full size. Select the copy method according to the workload's metadata requirements.

The source PVC is provisioned by `nfs.csi.k8s.io`, whose `CSIDriver.spec.attachRequired` is `false`. NFS volumes are not attached through a `VolumeAttachment`, so mounting the source PVC on the migrator Pod while the application also mounts it does not cause a `Multi-Attach error`, even across nodes. The migrator can run on any node. For an attach-based driver such as iSCSI or RBD, where `attachRequired` is `true`, a `ReadWriteOnce` source instead requires the migrator and the application to share a node. In all cases, evaluate application consistency before copying a volume that is still being written.

Because both volumes use NFS, the copy can alternatively run on a host that can reach both NFS servers. This avoids the in-cluster Pod entirely but requires suitable network access outside the cluster.

### 4. Protect both PVs with the Retain policy

Set variables for the remaining procedure and record the target and source PV names:

```bash
NS=<namespace>; PVC=<pvc>; TMP=<tmp-pvc>; WORKLOAD=<workload>
NEWPV=$(kubectl -n $NS get pvc $TMP -o jsonpath='{.spec.volumeName}')
OLDPV=$(kubectl -n $NS get pvc $PVC -o jsonpath='{.spec.volumeName}')
```

Before deleting either PVC, change both PVs to `Retain`:

```bash
kubectl patch pv $NEWPV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl patch pv $OLDPV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

> **Warning**: Do not continue until both PVs use `Retain`. Deleting a PVC while its PV still uses `reclaimPolicy: Delete` can delete the underlying volume. The new PV must be retained to protect the migrated data, and the old PV must be retained to preserve the rollback path. This is the only checkpoint whose omission can cause irreversible data loss.

Verify both policies:

```bash
kubectl get pv $NEWPV $OLDPV \
  -o custom-columns=NAME:.metadata.name,POLICY:.spec.persistentVolumeReclaimPolicy
```

### 5. Stop the workload and complete the final synchronization

Record the replica count, stop the workload, and wait for its Pods to be deleted:

```bash
REPLICAS=$(kubectl -n $NS get $WORKLOAD -o jsonpath='{.spec.replicas}')
kubectl -n $NS scale $WORKLOAD --replicas=0
kubectl -n $NS wait --for=delete pod -l <selector> --timeout=300s
```

Run the final synchronization and compare file checksums:

```bash
kubectl -n $NS exec migrator -- \
  rsync -aHAX --numeric-ids --delete --exclude='/.snapshot' /src/ /dst/

kubectl -n $NS exec migrator -- sh -c '
  set -eu
  for d in /src /dst; do
    ( cd "$d" && find . -type f -not -path "./.snapshot/*" -print0 \
        | sort -z | xargs -0 -r md5sum ) > /tmp/$(basename "$d").sum
  done
  diff /tmp/src.sum /tmp/dst.sum && echo CONTENT_OK'
```

`set -eu` and NUL-delimited (`-print0` / `sort -z` / `xargs -0`) handling are required: without them, a filename containing spaces splits into separate arguments and a failed `md5sum` only writes to stderr, so two empty `.sum` files can compare equal and print `CONTENT_OK` even when the data differs. This check is immediately followed by PVC deletion, so a false positive is not acceptable.

This check compares regular-file contents only. Ownership, permissions, ACLs, extended attributes, symbolic-link targets, and hard-link relationships are not verified here; check them separately according to the workload's requirements (see the FAQ). Do not continue unless the checksums match.

### 6. Delete and recreate the PVC under its original name

Delete the migrator Pod and both PVCs:

```bash
kubectl -n $NS delete pod migrator
kubectl -n $NS delete pvc $TMP $PVC
```

Both PVs enter the `Released` state and retain their data.

Reserve the new PV for the original PVC name. Run both merge patches in the following order:

```bash
kubectl patch pv $NEWPV --type merge -p \
  "{\"spec\":{\"claimRef\":{\"apiVersion\":\"v1\",\"kind\":\"PersistentVolumeClaim\",\"namespace\":\"$NS\",\"name\":\"$PVC\"}}}"

kubectl patch pv $NEWPV --type merge -p \
  '{"spec":{"claimRef":{"uid":null,"resourceVersion":null}}}'
```

The second merge patch is required. Without it, the stale `uid` remains in `claimRef` and the PV stays `Released`.

Confirm that the new PV is `Available` and reserved for the original PVC name:

```bash
kubectl get pv $NEWPV -o custom-columns=\
NAME:.metadata.name,STATUS:.status.phase,CLAIM:.spec.claimRef.name,UID:.spec.claimRef.uid
```

```text
NAME             STATUS      CLAIM      UID
pvc-0464141b-…   Available   app-data   <none>
```

Recreate the PVC with its original name and pre-bind it to the new PV:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc>            # unchanged
  namespace: <namespace>
spec:
  accessModes: ["ReadWriteMany"]      # match the source PVC (ReadWriteOnce for the StatefulSet)
  storageClassName: <storage-class>   # must match the new PV exactly
  resources:
    requests:
      storage: 2Gi                    # must be <= the PV capacity
  volumeName: <new-pv>
```

Wait for the PVC to become `Bound` before restarting the workload.

### 7. Restart and verify the workload

Restore the recorded replica count:

```bash
kubectl -n $NS scale $WORKLOAD --replicas=$REPLICAS
```

Confirm that the workload uses the target NFS mount and verify the application data:

```bash
kubectl -n $NS exec <pod> -- sh -c 'mount | grep " /data "'
```

For the validated Deployment with `ReadWriteMany`, the following checks succeeded:

| Check | Result |
|-------|--------|
| File checksums | Matched the pre-migration baseline |
| Permissions and ownership | Preserved, including a mode `600` file owned by `1000:1000` |
| Symbolic links | Preserved, including relative targets |
| Deployment manifest | Unchanged and continued to reference the original PVC name |
| Mount point | Changed to the target NFS export |
| Concurrent writers | Two replicas and one external host observed each other's writes |

For the validated StatefulSet with `ReadWriteOnce` and two ordinals, each ordinal retained its own data and PVC name, and both mount points changed to the target array without cross-volume data.

### 8. Recreate a StatefulSet with the target StorageClass

Apply the migration separately to each StatefulSet ordinal, such as `data-web-0` and `data-web-1`. Each ordinal has its own source and target volume.

Rebinding the PVCs does not update the StatefulSet's `volumeClaimTemplates`. If the template still contains the old StorageClass, a later scale-out creates new PVCs on the old storage and splits the StatefulSet across storage systems:

```text
data-web-0   Bound   <dorado-storage-class>   <- migrated
data-web-1   Bound   <dorado-storage-class>   <- migrated
data-web-2   Bound   <old-storage-class>      <- newly created from the template
```

`volumeClaimTemplates` cannot be changed in place:

```text
The StatefulSet "web" is invalid: spec: Forbidden: updates to statefulset spec for
fields other than 'replicas', 'ordinals', 'template', 'updateStrategy',
'revisionHistoryLimit', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds'
are forbidden
```

Delete the StatefulSet with `--cascade=orphan`, update `storageClassName` in `volumeClaimTemplates`, and recreate it:

```bash
kubectl -n <namespace> delete sts <name> --cascade=orphan
# edit storageClassName in volumeClaimTemplates, then:
kubectl apply -f <statefulset>.yaml
```

The orphan deletion leaves the Pods and PVCs in place. The recreated StatefulSet adopts the existing Pods through its label selector. In the validation, Pod age remained continuous and restart counts stayed at zero, confirming that the Pods did not restart. Perform this step immediately after migration so that future scale-out uses the target StorageClass.

### 9. Review risk and rollback actions

| Step | Consequence of failure | Rollback |
|------|------------------------|----------|
| Initial data copy | No application interruption; the source remains available | Delete the temporary PVC and retry |
| Set both PVs to `Retain` | Omitting this protection can destroy a volume when its PVC is deleted | No recovery after deletion; this is the only irreversible checkpoint |
| Stop the workload | Downtime begins | Restore the recorded replica count |
| Final sync and verification | A checksum mismatch indicates an incomplete copy | Restore the workload; the source remains unchanged |
| Delete the PVCs | PVs become `Released`; data remains intact because both use `Retain` | Recreate the original PVC and bind it to the old PV |
| Reserve the new PV | Binding does not complete; no data is deleted | Reapply the two merge patches |
| Recreate the PVC | The PVC stays `Pending` if its fields do not match | Delete the PVC, correct it, and recreate it |
| Restart the workload | The volume does not mount correctly | Scale to zero and rebind the original PVC name to the old PV |
| Recreate the StatefulSet | The controller does not adopt existing Pods if selectors do not match | Correct the manifest and recreate the StatefulSet; orphaned Pods remain running |

After both PVs are confirmed as `Retain`, every subsequent migration step is reversible. The old PV provides the rollback path. To restore it, reserve the old PV for the original PVC name with the same two-patch procedure, and recreate the PVC with `volumeName` set to the old PV.

Before deleting either PVC, run this check and confirm that both rows show `Retain`:

```bash
kubectl get pv $NEWPV $OLDPV \
  -o custom-columns=NAME:.metadata.name,POLICY:.spec.persistentVolumeReclaimPolicy
```

### 10. Finalize after a successful migration

Both PVs are left as `Retain`, which leaves cleanup decisions to the administrator. After the workload has run on the target volume long enough to close the rollback window:

- The old PV stays `Released`. Once a backup is confirmed and the rollback path is no longer needed, delete the old PV and reclaim the underlying volume on the source system. Deleting the PV object does not free the source-side storage.
- Decide the target PV's final reclaim policy. It remains `Retain`, so a later PVC deletion does not remove the array-side volume. Keep `Retain` for volumes that are shared or consumed externally; the volume must then be cleaned up by hand. Restore `Delete` only if the volume's lifecycle should follow its PVC.

## FAQ

### What must match when the PVC is recreated?

The PVC request must not exceed the PV capacity. Its access modes must be a subset of the modes supported by the PV. Its `storageClassName` must match the PV exactly. For a static PV, set `storageClassName: ""` on both the PV and PVC; omitting the PVC field can cause Kubernetes to substitute the default StorageClass.

### Why does the PV remain in Released after the first patch?

The first merge patch changes `claimRef.namespace` and `claimRef.name` but preserves the stale `uid` because unspecified fields are not removed. The second merge patch must set both `uid` and `resourceVersion` to `null`. The PV can then become `Available` while remaining reserved for the named PVC.

### How should file ownership be checked after migration?

Source and target NFS servers can apply different squash policies, and that mapping happens on the server, not in `rsync`. Run the copy as UID 0 against a source export that does not squash root and a target export that allows `chown`. Use `--numeric-ids` so that IDs are matched by value rather than by name, and verify representative files after the copy. Confirm UID/GID values, permissions, ACLs, extended attributes, hard links, symbolic links, and sparse-file handling according to the application's requirements.
