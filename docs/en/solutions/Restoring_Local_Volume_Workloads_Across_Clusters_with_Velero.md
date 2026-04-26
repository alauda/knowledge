---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Restoring an application that uses local-volume PersistentVolumes onto a different cluster with Velero leaves Pods in `Pending` and PVCs failing to attach. The destination cluster shows one or more of the following symptoms after `velero restore` reports `Phase: Completed`:

- Restored Pod stays `Pending` with `0/N nodes are available: M node(s) had volume node affinity conflict`.
- Restored PVC stays `Pending` with `storageclass.storage.k8s.io "<name>" not found`.
- Restored PV reports `volume "pv-local" already bound to a different claim`.
- `FailedScheduling: pod has unbound immediate PersistentVolumeClaims`.
- Velero restore log warns `could not restore, PersistentVolume "..." already exists. Warning: the in-cluster version is different than the backed-up version`.

The application data is not visible on the destination cluster even though the restore step itself reports success.

## Root Cause

Local PersistentVolumes carry two pieces of cluster-specific state that do not survive a cross-cluster restore unless they are translated explicitly:

1. **Node affinity**. Each local PV has a mandatory `spec.nodeAffinity` that pins the volume to a single node hostname. The hostname only exists on the source cluster; the destination cluster has different node names. The restored PV appears in the API but the scheduler refuses to place any Pod on it, producing the `volume node affinity conflict` message.
2. **StorageClass reference**. PVCs reference `spec.storageClassName`, a cluster-scoped object. Velero does not back up StorageClasses by default, and the destination cluster may use a different name (or no equivalent class at all). The PVC stays `Pending` with `storageclass.storage.k8s.io "..." not found`.

Velero captures Kubernetes API objects as-is — it does not rewrite `nodeAffinity` or `storageClassName`. Without explicit field translation the restored PV/PVC pair is correct for the source cluster and unusable on the destination.

A third compounding issue is that Velero uses `restic`/`kopia` File-System-Backup (FSB) for the volume contents, which restores file bytes only — it does not create the local PV objects, the on-disk directory, or the backing block device. Those have to be present on the destination node before the FSB pod can write into them.

## Resolution

The supported migration flow combines (a) Velero plugin ConfigMaps that rewrite `nodeAffinity` and `storageClassName` during restore, with (b) manual pre-creation of the local PV and on-disk path on the destination node.

### Source cluster prerequisites

- All target Pods are `Running` and their PVCs are `Bound`.
- Local StorageClass is created and has the right `volumeBindingMode: WaitForFirstConsumer`.
- Local PVs and their bound PVCs are healthy.
- Velero is installed in the backup namespace (`velero` or `oadp` depending on packaging).

### 1. Define translation ConfigMaps in the backup namespace

The Velero RestoreItemAction plugins recognize two specific ConfigMap labels: `velero.io/change-pvc-node-selector` for node remapping and `velero.io/change-storage-class` for StorageClass renaming.

Node remapping ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: change-pv-nodes
  namespace: velero
  labels:
    velero.io/plugin-config: ""
    velero.io/change-pvc-node-selector: RestoreItemAction
data:
  "source-node-1.example.local": "destination-node-1.example.local"
  "source-node-2.example.local": "destination-node-2.example.local"
```

StorageClass remapping ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: change-storage-class
  namespace: velero
  labels:
    velero.io/plugin-config: ""
    velero.io/change-storage-class: RestoreItemAction
data:
  # source-class : destination-class
  "local-storage": "local-storage-2"
```

Apply both on the source cluster (so the same backup carries its translation hints) and on the destination cluster (where Velero actually consumes them at restore time). The labels are case-sensitive — `RestoreItemAction` is what Velero searches for.

### 2. Take an FSB-enabled backup

```bash
velero backup create migration-backup-001 \
  --include-namespaces my-app \
  --default-volumes-to-fs-backup \
  -n velero
```

`--default-volumes-to-fs-backup` opts every PVC in the namespace into File-System Backup so volume contents are captured. Without it, only API objects are backed up and the destination cluster will see empty volumes.

### 3. Destination cluster prerequisites

- Velero is installed with the same plugin set and provider configuration as the source.
- A local StorageClass with the destination name (e.g., `local-storage-2`) exists and uses `WaitForFirstConsumer`.
- The local directory path used by each PV is pre-created on the destination node, with the same path as the source PV. Use `kubectl debug node/...` or your node-management tooling to create them:

  ```bash
  kubectl debug node/<destination-node> --image=busybox -- /bin/sh -c \
    "chroot /host mkdir -p /mnt/local-data && chroot /host chmod 777 /mnt/local-data"
  ```

### 4. Pre-create the local PV objects on the destination

For each source local PV, create the destination equivalent with the destination cluster's node hostname and StorageClass. Use the *same* PV name so the PVC's `volumeName` reference (which is preserved in the restore) lines up:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-local-pv          # match source PV name exactly
spec:
  capacity:
    storage: 5Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-storage-2          # destination StorageClass
  local:
    path: /mnt/local-data                    # path created in step 3
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - destination-node-1.example.local
```

### 5. Restore

```bash
velero restore create --from-backup migration-backup-001 -n velero
velero restore describe migration-backup-001-<timestamp> -n velero --details
```

Watch for `Phase: Completed`. Any `(failed)` lines under PV resources should now refer only to PVs the destination already has — those are skipped harmlessly because the in-cluster object exists. Pod scheduling completes once the FSB init container has copied the data into `/mnt/local-data`.

### 6. Verify

```bash
kubectl get pvc -n my-app
kubectl get pods -n my-app
kubectl exec -n my-app <pod> -- ls -la /<volume-mount-path>
```

PVCs should report `Bound`, Pods `Running`, and the data directory should contain the backed-up files.

## Diagnostic Steps

Confirm the failure is the cross-cluster local-PV pattern rather than a more generic restore problem:

```bash
# Restore status
velero restore describe <restore-name> -n velero --details | grep -E "Phase|Warnings|Errors"

# Pod scheduling
kubectl describe pod -n my-app <pod-name> | grep -E "FailedScheduling|node affinity|unbound"

# PVC binding
kubectl describe pvc -n my-app <pvc-name> | grep -E "Status|Events|storageclass"

# Verify the restored PV's nodeAffinity hostname exists on the destination cluster
kubectl get pv <pv-name> -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[*].matchExpressions[*].values[*]}' ; echo
kubectl get nodes -o jsonpath='{.items[*].metadata.name}'
```

If the affinity hostname does not appear in `kubectl get nodes`, the node-translation ConfigMap was not picked up — either it lives in the wrong namespace, the labels are misspelled, or the Velero deployment was running before the ConfigMap was created and needs to be restarted to pick up new plugin configuration. Restart the Velero pod (`kubectl -n velero rollout restart deploy/velero`) and re-run the restore.

> **Limitation**: Velero File-System Backup does not support `hostPath` volumes. It does support local-volume PVs as long as the on-disk path and PV object are pre-created on the destination as described above.
