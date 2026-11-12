---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.14.x
  - 4.2.x
  - 4.3.x
---

# What platform backup, application snapshots, and volume snapshots cover on ACP

## Issue

Before choosing a backup feature on Alauda Container Platform, these questions come up:

- Is the data of a native application snapshot stored in etcd? Does it cover only YAML, and does it miss ConfigMaps, Secrets, and ALB resources? Should the platform backup and restore component use S3 storage, and does it back up everything in a namespace?
- An application backup has both "Kubernetes resources" and "PVC data volumes" selected. Is the data inside the volumes backed up?
- A namespace runs MySQL and Redis data services. Is a full namespace backup, PVCs included, enough?
- How are applications, ConfigMaps, and Secrets moved from namespace B in cluster A to namespace D in cluster C, or a whole namespace from a shared cluster to a dedicated one?
- Can an existing namespace be renamed without affecting its pods?
- Where is the "restore volume snapshot" action?
- Releases go out through the platform API. Can the resources be backed up before each release and rolled back automatically if the release goes wrong?
- Some ConfigMaps are missing after a namespace restore. Can the backup be inspected to see whether it contained them?

## Root Cause

### Cause 1: native application snapshot versus the platform backup and restore component

On ACP 3.14.1, the native application snapshot backs up only PVC data; it does not back up Kubernetes resource objects, ConfigMaps, Secrets, or ALB resources, and it does not store anything in etcd. The platform backup and restore component (Velero) performs a namespace-level full backup that includes ConfigMaps and Secrets; S3 external storage is recommended for it. Whether ALB resources are covered depends on the backup policy.

When an application backup has both "Kubernetes resources" and "PVC data volumes" selected, the data inside the volumes is backed up too: Velero saves the namespace's Kubernetes resources and the data on the volumes bound to its PVCs to the configured backup repository, as a file-level backup with the restic uploader. On restore, Velero recreates the resources and writes the volume data back into the new PVCs.

### Cause 2: a namespace backup is not enough for MySQL and Redis

A namespace-level backup, even with PVCs, cannot guarantee data consistency for databases and risks data corruption. Data services support only their own dedicated backup and restore. Their resources are excluded from the namespace backup with a label selector, and MySQL and Redis are backed up with the data services' own backup.

### Cause 3: migrating an application or namespace to another cluster

Cross-cluster migration uses the platform backup and restore flow: back up the source namespace with an application backup policy, then run an application restore task on the target cluster. Source and target clusters should have similar CPU and memory capacity, so migrated pods do not stay `Pending`.

### Cause 4: a namespace cannot be renamed in place

A namespace name cannot be changed, and a rename affects the resources in it. Renaming means creating a new namespace and moving the resources into it.

### Cause 5: there is no standalone "restore from volume snapshot" action

Data is restored by creating a new PVC from the volume snapshot and mounting that PVC in the workload.

### Cause 6: no built-in pre-release backup and automatic rollback through the API

The platform does not support backing up the current resources and rolling back automatically through the API. Cluster backup and restore (**Cluster > Backup and Restore**) is for disaster recovery, not release rollback. What exists on ACP 4.2 is the native application version snapshot, which is recorded automatically only for changes made in the web console, and Deployment-level rollback.

### Cause 7: checking whether a backup contained a specific ConfigMap or Secret

A namespace-level backup by the platform component includes the namespace's ConfigMaps and Secrets. After a restore, the Velero log of the restore cluster names each restored object in an `Attempting to restore ConfigMap: <name>` entry, which shows that the backup carried it. Without a restore, the backup's resource list shows it.

## Resolution

### Cause 1: native application snapshot versus the platform backup and restore component

Use the platform backup and restore component with S3 external storage when ConfigMaps, Secrets, and the rest of the namespace must be protected. To include volume data, select both "Kubernetes resources" and "PVC data volumes" in the application backup. On ACP 3.14.1, confirm that volume snapshots or a storage-level backup are available for the StorageClass in use before relying on the component for PVC data. Before relying on it for ALB rules, check what the backup policy includes.

```bash
kubectl get storageclass
kubectl get volumesnapshotclass
```

To check that a finished backup carried volume data, list its pod volume backups and the repository:

```bash
kubectl -n cpaas-system get podvolumebackups.velero.io -l velero.io/backup-name=<backup-name>
kubectl -n cpaas-system get backuprepositories.velero.io
```

### Cause 2: a namespace backup is not enough for MySQL and Redis

1. Back up MySQL and Redis with the data services' dedicated backup and restore.
2. Exclude their resources from the namespace backup with `NotIn` expressions in the backup's `labelSelector`:

```yaml
labelSelector:
  matchExpressions:
  # resources with label a=b are not backed up
  - key: a
    operator: NotIn
    values: ["b"]
  # resources with label c=d are not backed up
  - key: c
    operator: NotIn
    values: ["d"]
```

Replace `a`/`b` and `c`/`d` with labels that the data-service objects (instances, StatefulSets, pods, PVCs) carry and the business workloads do not. List the labels first:

```bash
kubectl -n <namespace> get statefulset,pod,pvc --show-labels | grep -iE 'mysql|redis'
```

`NotIn` also keeps objects that do not have the key, so business objects without the label stay in the backup. Test a restore of the filtered backup in a non-production namespace.

### Cause 3: migrating an application or namespace to another cluster

1. Install the backup and restore component and give the cluster a default S3 storage.
2. Create an application backup policy for the source namespace and run it.
3. On the target cluster, create an application restore task and select the backup from the restore task list. A different target namespace is set with namespace mapping (`spec.namespaceMapping` on the Velero `Restore` object).
4. Check capacity first so restored pods can schedule:

```bash
kubectl describe nodes | grep -A6 'Allocated resources'
```

Restored objects that refer to their source namespace, nodes, registry, or StorageClass are covered in [Application restore fails, hangs, or restored workloads do not run on another cluster on ACP](./Application_restore_fails_hangs_or_restored_workloads_do_not_run_on_another_cluster_on_ACP.md).

### Cause 4: a namespace cannot be renamed in place

Create the new namespace and move the resources into it. The platform backup and restore feature (Cause 3, with namespace mapping) covers Kubernetes resources and PVC data and is recommended when many resources have to move. For a few services, recreating them by hand in the new namespace is fine. Delete the old namespace only after the workloads in the new one are verified.

> **Warning:** Deleting the old namespace deletes every object in it, and PVCs whose PV reclaim policy is `Delete` lose their data. Precondition: the new namespace runs correctly and its PVCs hold the data. Rollback: none except restoring from a backup.

```bash
kubectl delete namespace <old-namespace>
```

### Cause 5: there is no standalone "restore from volume snapshot" action

1. In the left navigation, click **Storage > PersistentVolumeClaims (PVC)**.
2. Click the name of the backed-up PVC and select the **Volume Snapshots** tab.
3. Locate the snapshot, click ⋮, and choose **Create PersistentVolumeClaim**.
4. Fill in the PVC parameters and click **Create**.
5. Mount it, for example in a Deployment: **Compute Components > Deployments** > the Deployment > **Actions > Update**; in the **Container Group** section, change the storage volume to the new PVC and click **Update**.

The update rolls the Deployment's pods; afterwards the restored data is at the volume mount path. The product documentation describes the same procedure in "Restore Data" and in the best practice on using volume snapshots for data backup.

### Cause 6: no built-in pre-release backup and automatic rollback through the API

Options:

- Native applications: create a version snapshot by hand before each API-driven release, because API deployments are not recorded. Console path: **Container Platform > Application Management > Native Applications** > application details > **Version Snapshot** > **Create**. To roll back, open **History Versions**, click the version number, and select **Roll Back to This Version**. At most 6 snapshots are kept; the oldest is deleted when the limit is exceeded. No API is documented for creating or rolling back snapshots.
- Individual Deployments: roll back with `ac rollout undo` (or the upstream `kubectl rollout undo`).
- Automation: build it on the native Kubernetes API, which the platform forwards under its own URL prefix.

```bash
kubectl rollout history deployment/<name> -n <namespace>
```

> **Warning:** `rollout undo` replaces the Deployment's pod template with the previous revision and rolls all pods. Precondition: the previous revision is the one you want (check the history). Rollback: `kubectl rollout undo deployment/<name> -n <namespace> --to-revision=<revision>` back to the revision you left.

```bash
ac rollout undo deployment/<name> -n <namespace>
```

### Cause 7: checking whether a backup contained a specific ConfigMap or Secret

After a restore, search the Velero log of the restore cluster:

```bash
kubectl -n cpaas-system logs deploy/velero | grep 'restore=cpaas-system/<restore-name>' | grep '<configmap-name>'
```

An `Attempting to restore ConfigMap: <configmap-name>` entry means the object was in the backup; see [ConfigMaps missing after a namespace restore that completed without errors on ACP](./ConfigMaps_missing_after_a_namespace_restore_that_completed_without_errors_on_ACP.md) for what to check next.

Without a restore, print the backup's resource list with the Velero CLI in the Velero pod, on a cluster whose backup storage holds the backup:

```bash
kubectl -n cpaas-system get backups.velero.io <backup-name> -o jsonpath='{.status.phase}{" "}{.status.progress}{"\n"}'
kubectl exec -n cpaas-system deploy/velero -- ./velero backup describe <backup-name> --details | grep -E 'v1/ConfigMap|<source-namespace>/<configmap-name>'
```

The `Resource List` section lists objects as `<namespace>/<name>` under each kind. An object that is not listed was not in the backup; then check the policy's included namespaces and its `labelSelector` (Cause 2).

## Diagnostic Steps

```bash
kubectl -n cpaas-system get backups.velero.io,schedules.velero.io
kubectl get volumesnapshot -A
kubectl -n <namespace> get pvc
```

- Snapshot versus platform backup scope, or whether PVC data is included: Cause 1.
- A namespace with MySQL or Redis: Cause 2.
- Moving a namespace or application to another cluster or namespace: Cause 3.
- Renaming a namespace: Cause 4.
- Restoring a PVC from a volume snapshot: Cause 5.
- Pre-release backup and rollback for API deployments: Cause 6.
- Whether a backup contained a specific object: Cause 7.
