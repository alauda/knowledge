---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x,4.3.x,4.4.x
id: KB260900019
---

# Switching the NFS CSI StorageClass server domain on ACP

## Issue

An NFS CSI StorageClass (`provisioner: nfs.csi.k8s.io`) stores the NFS server in `parameters.server`. When a PVC is provisioned, the CSI driver writes that server into the resulting PV's `spec.csi.volumeAttributes.server` and `spec.csi.volumeHandle`.

Kubernetes does not allow an existing StorageClass `parameters` field, a PV CSI source, or a bound PVC's `storageClassName` and `volumeName` to be changed in place. Therefore, switching both new and existing PVCs requires two operations:

1. Delete and recreate the StorageClass with the **same name** and the new server domain, so subsequently created PVCs use the new domain.
2. Recreate each existing PVC/PV object so the existing claim uses a new PV with the new domain.

Existing PVC migration requires an unmount window. The NFS data is not copied when the old and new domains expose the same logical NFS Server and export; the new PV is another CSI reference to the same subdirectory.

## Preconditions

Use this procedure only when all of the following are true:

- The StorageClass provisioner is `nfs.csi.k8s.io`.
- The old and new domains identify the same logical NFS Server and the same export.
- The export path, subdirectory, data, UID/GID mapping, permissions, ACLs, and mount options are compatible.
- The new domain is reachable from every node that may mount the PVC.
- A maintenance window is available for each PVC or application.

The old and new domains do not need to resolve to the same IP. An NFS Server may expose the same export through multiple IPs, VIPs, or failover addresses. IP checks only prove network reachability; they do not prove storage identity.

If the new domain identifies a different NFS backend, stop and use a data-copy and backend-migration procedure instead.

## Kubernetes and NFS CSI constraints

`StorageClass.parameters` is immutable after creation. The following server-side dry run must be rejected:

```bash
kubectl patch storageclass <storage-class-name> --type=merge \
  --dry-run=server \
  -p '{"parameters":{"server":"<new-domain>"}}'
```

The PV CSI source is also immutable after creation. `spec.csi.volumeAttributes.server` and `spec.csi.volumeHandle` cannot be patched. A bound PVC cannot be retargeted to another PV; its `spec.volumeName` is already set by the binder.

The NFS CSI driver uses `volumeAttributes.server` for `NodePublishVolume`. Its `volumeHandle` also contains the server as the first component and must be updated consistently in a replacement PV. The StorageClass parameter is commonly named `subDir`, while the generated PV attribute is commonly shown as `subdir`; preserve the spelling and value from the original PV.

## Procedure

### 1. Confirm the NFS Server and export

Have the NFS administrator confirm that both domains identify the same logical NFS Server and export. From a worker node or an equivalent debug Pod, verify DNS and NFS port reachability:

```bash
getent hosts <old-domain>
getent hosts <new-domain>
nc -vz <new-domain> 2049
```

For NFSv3 only, `showmount -e <new-domain>` can be used to inspect exports. NFSv4 commonly has no rpcbind/mountd endpoint for `showmount`; verify the export through the PVC/Pod mount test in step 3 instead.

Do not proceed if the new endpoint is not reachable or if the export/data identity cannot be established.

### 2. Delete and recreate the same-name StorageClass

Freeze new PVC creation, autoscaling, and conflicting GitOps reconciliation during this operation. Keep the original backup unchanged and create a working copy for the new domain:

```bash
SC=<storage-class-name>
WORKDIR="nfs-domain-migration-$(date +%Y%m%d%H%M%S)"
mkdir -p "$WORKDIR"

kubectl get csidriver nfs.csi.k8s.io
kubectl get storageclass "$SC" -o yaml --show-managed-fields=false \
  > "$WORKDIR/storageclass.yaml"
cp "$WORKDIR/storageclass.yaml" "$WORKDIR/storageclass.new.yaml"
```

Edit `storageclass.new.yaml` as follows:

- Keep `metadata.name` unchanged.
- Change only `parameters.server` to `<new-domain>`.
- Keep `share`, mountOptions, reclaimPolicy, volumeBindingMode, labels, and annotations unchanged.
- Remove `creationTimestamp`, `resourceVersion`, `uid`, and `generation`.

Then replace the object:

```bash
kubectl delete storageclass "$SC"
kubectl apply -f "$WORKDIR/storageclass.new.yaml"
kubectl get storageclass "$SC" \
  -o jsonpath='server={.parameters.server}{"\n"}'
```

During the short interval in which the object is absent, new PVCs that reference this StorageClass cannot provision. Existing bound PVCs continue to use their current PVs.

### 3. Verify a new PVC

Create a temporary PVC and Pod using the original StorageClass name. The test workload must write and read a marker file. After the PVC is `Bound` and the Pod is ready, find its PV and check the server:

```bash
kubectl get pvc -n <test-namespace> <test-pvc> \
  -o jsonpath='pv={.spec.volumeName}{"\n"}'
kubectl get pv <test-pv> \
  -o jsonpath='server={.spec.csi.volumeAttributes.server}{"\n"}handle={.spec.csi.volumeHandle}{"\n"}'
kubectl -n <test-namespace> exec <test-pod> -- \
  sh -c 'echo nfs-domain-cutover > /mnt/domain-marker && cat /mnt/domain-marker'
```

The generated PV must contain `<new-domain>` in both `volumeAttributes.server` and the first component of `volumeHandle`. If this test fails, delete only the temporary PVC/Pod and restore the StorageClass from the unchanged `storageclass.yaml` backup after cleaning generated metadata. Do not start existing PVC migration.

### 4. Migrate existing PVCs

At the start of this phase, list all PVCs that reference the StorageClass. The PVC's `spec.volumeName` identifies the PV; the full PV YAML is retrieved only when that PVC is processed.

```bash
kubectl get pvc -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,SC:.spec.storageClassName,PV:.spec.volumeName,PHASE:.status.phase' \
  | tee "$WORKDIR/pvc-inventory.txt"
```

Process one PVC or one application at a time. `Pending` PVCs do not have a bound PV to migrate and must be investigated separately.

#### 4.1 Stop the workload and save the objects

For each bound PVC, find the Pods that actually mount it, then inspect their owner and stop the Deployment, StatefulSet, or other workload manually:

```bash
PVC_NS=<pvc-namespace>
PVC_NAME=<pvc-name>
OLD_PV=<old-pv-name>

kubectl -n "$PVC_NS" get pods \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{" "}{end}{"\n"}{end}' \
  | grep -w "$PVC_NAME"

POD_NAME=<pod-name>
kubectl -n "$PVC_NS" get pod "$POD_NAME" \
  -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}/{.name}{"\n"}{end}'

# Use the workload kind and name returned above.
kubectl -n "$PVC_NS" scale deployment/<workload-name> --replicas=0
kubectl -n "$PVC_NS" wait --for=delete "pod/${POD_NAME}" --timeout=120s
```

If multiple Pods mount the PVC, wait for every one to be deleted before continuing. Save the objects without `managedFields`:

```bash
kubectl get pv "$OLD_PV" -o yaml --show-managed-fields=false \
  > "$WORKDIR/pv-${OLD_PV}.backup.yaml"
kubectl -n "$PVC_NS" get pvc "$PVC_NAME" -o yaml \
  --show-managed-fields=false \
  > "$WORKDIR/pvc-${PVC_NS}-${PVC_NAME}.backup.yaml"
```

Keep these backups until the migrated workload has been verified.

#### 4.2 Protect the old PV and preserve data

Set the old PV's reclaim policy to `Retain` and read it back before deleting the PVC:

```bash
kubectl patch pv "$OLD_PV" --type=merge \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv "$OLD_PV" \
  -o jsonpath='reclaim={.spec.persistentVolumeReclaimPolicy}{"\n"}'
```

Only continue when the output is `Retain`. After the PVC is deleted, the old PV must remain as `Released`; its NFS subdirectory must remain intact.

#### 4.3 Prepare and create the replacement PV

Copy the saved PV YAML to a new file. Do not apply the raw backup. Delete these fields from the new PV manifest:

- `metadata.creationTimestamp`, `resourceVersion`, `uid`, `generation`, and `finalizers`;
- `status`;
- binding-controller annotations such as `pv.kubernetes.io/bind-completed` and `pv.kubernetes.io/bound-by-controller`;
- `spec.claimRef.uid` and other old claimRef metadata, keeping only the PVC namespace and name.

Modify these fields:

- Set `metadata.name` to a new PV name, for example `<old-pv-name>-migrated`;
- Set `spec.persistentVolumeReclaimPolicy` to `Retain`;
- Change `spec.csi.volumeAttributes.server` to `<new-domain>`;
- Replace the first server component in `spec.csi.volumeHandle`, keeping the share and subdirectory suffix unchanged;
- Keep capacity, access modes, volumeMode, mountOptions, share, subdirectory, and other CSI attributes unchanged, except for the PV-name attribute if the driver wrote one.

Example replacement PV:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: <old-pv-name>-migrated
  annotations:
    pv.kubernetes.io/provisioned-by: nfs.csi.k8s.io
spec:
  capacity:
    storage: <same-capacity>
  accessModes:
    - ReadWriteMany
  volumeMode: Filesystem
  persistentVolumeReclaimPolicy: Retain
  storageClassName: <storage-class-name>
  mountOptions:
    - nfsvers=4.1
  claimRef:
    namespace: <pvc-namespace>
    name: <pvc-name>
  csi:
    driver: nfs.csi.k8s.io
    volumeHandle: <new-domain>#<original-share-and-subdirectory-suffix>
    volumeAttributes:
      server: <new-domain>
      share: <same-share>
      subdir: <same-subdir>
```

#### 4.4 Prepare and create the replacement PVC

Copy the saved PVC YAML to a new file. Delete `metadata.creationTimestamp`, `resourceVersion`, `uid`, `generation`, `finalizers`, `status`, and binding-controller annotations. Change only `spec.volumeName` to the new PV name; keep the original StorageClass name, capacity, access modes, volumeMode, labels, and required annotations.

Example replacement PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc-name>
  namespace: <pvc-namespace>
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: <same-capacity>
  volumeMode: Filesystem
  storageClassName: <storage-class-name>
  volumeName: <old-pv-name>-migrated
```

After checking both new manifests, switch the objects:

```bash
kubectl -n "$PVC_NS" delete pvc "$PVC_NAME" --wait=true
kubectl wait --for=jsonpath='{.status.phase}'=Released \
  "pv/${OLD_PV}" --timeout=120s
kubectl create -f "$WORKDIR/pv-${NEW_PV}.yaml"
kubectl create -f "$WORKDIR/pvc-${PVC_NS}-${PVC_NAME}.new.yaml"
kubectl wait --for=jsonpath='{.status.phase}'=Bound \
  -n "$PVC_NS" "pvc/${PVC_NAME}" --timeout=120s
```

The PVC name and the workload's `claimName` remain unchanged. The new PVC is statically bound to the replacement PV and must not trigger dynamic provisioning of another subdirectory.

#### 4.5 Start and verify the workload

Start the workload again and verify:

- the Pod is Running/Ready;
- the replacement PV has the new server and handle;
- the original files are present;
- application reads and writes succeed;
- logs contain no stale file handle, permission, or mount errors.

After verification, the old PV object can be deleted while it remains `Retain`; deleting that object does not delete the NFS directory. Restore the replacement PV's original reclaim policy if required.

### 5. Closeout

After all bound PVCs have been migrated, check the target PVs and the StorageClass:

```bash
kubectl get pv -o custom-columns=\
NAME:.metadata.name,SC:.spec.storageClassName,SERVER:.spec.csi.volumeAttributes.server,CLAIM:.spec.claimRef.name,PHASE:.status.phase
kubectl get storageclass <storage-class-name> \
  -o jsonpath='server={.parameters.server}{"\n"}'
```

All target PVCs must be `Bound`, all consuming Pods must be healthy, and no target PV may still reference the old domain. Keep the old NFS domain and backend available until the observation window and rollback window have ended.

## Rollback

If StorageClass validation fails before PVC migration, recreate the same-name StorageClass from the original `storageclass.yaml` backup after removing generated metadata.

If one PVC migration fails, stop its workload, delete the replacement PVC/PV, and restore the old PV/PVC from the backups. The old PV must be `Retain`, and the old NFS domain must still resolve.

If several PVCs have already migrated, restoring the StorageClass alone is insufficient. Reverse-migrate each PVC/PV that was already switched. Do not remove the old domain or backend until rollback is no longer required.

## Different IP addresses

Different IP addresses are acceptable only when the NFS administrator confirms that both domains expose the same logical NFS Server and export, and the new endpoint passes reachability, mount, data, and permission checks.

If the domains identify different NFS backends, first copy the data and complete a final consistency sync during a maintenance window. Only then perform the PV/PVC object replacement. A hostname-only change in that situation can mount an empty or unrelated directory and can make rollback lose writes made on the new backend.
