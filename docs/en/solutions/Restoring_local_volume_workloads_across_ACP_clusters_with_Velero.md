---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500564
---

# Restoring local-volume workloads across ACP clusters with Velero

## Issue

On Alauda Container Platform (install package `installer-v4.3.0-online`, kubernetes v1.34.5), Velero ships through the `chart-velero` ModulePlugin (chart v4.1.0, image `registry.alauda.cn:60080/3rdparty/velero/velero:v1.15.2-v4.1.0`, init plugins `velero-plugin-for-aws:v1.11.1-v4.1.0` and `velero-plugin-for-change-registry:v4.1.0`) and runs in the `cpaas-system` namespace; that controller watches `Backup` and `Restore` resources only inside its own namespace and wraps Kubernetes API objects as-is at backup time, preserving fields such as a `PersistentVolume`'s `spec.nodeAffinity` and its annotations without rewriting them. When such a backup is restored onto a *different* ACP cluster, that as-is behaviour collides with two facts about local-type `PersistentVolume`s: a local PV is bound to a single node through its `spec.nodeAffinity` block (a `VolumeNodeAffinity` shaped as `required.nodeSelectorTerms[].matchExpressions[{key,operator,values}]`, typically keyed on `kubernetes.io/hostname`), and the upstream kube-scheduler refuses to place a Pod that references such a PV onto any node that does not satisfy that affinity, surfacing the predicate failure to the Pod's events as `node(s) had volume node affinity conflict`. As a result, restored Pods backed by local PVs land in `Pending` on the destination cluster because the source-cluster hostnames encoded in the PV's `nodeAffinity` do not exist there.

The same restore can fail for a second, independent reason: `StorageClass` is a cluster-scoped resource (`storageclasses.storage.k8s.io`, `NAMESPACED=false`) and is not pulled along with the namespaced objects of a workload backup, so a restored `PersistentVolumeClaim` whose `spec.storageClassName` points at a `StorageClass` that does not exist on the destination cluster stays in `Pending` with a `ProvisioningFailed` event reading `storageclass.storage.k8s.io "<name>" not found`; the workload Pod that references that PVC, in turn, stays in `Pending` with the scheduler condition `pod has unbound immediate PersistentVolumeClaims` (`FailedScheduling`).

## Root Cause

Local-type `PersistentVolume`s carry two pieces of source-cluster identity that do not survive a literal copy across clusters: the node hostname embedded in `spec.nodeAffinity` and the `storageClassName` reference on the bound PVC. Velero's restore path preserves both fields exactly as they were captured, because the velero controller treats API objects as opaque payloads and does not mutate `spec.nodeAffinity`, `storageClassName`, or related references during restore. With the source hostnames still pinned, kube-scheduler's `VolumeNodeAffinity` predicate fails for every destination node and produces the `volume node affinity conflict` event; with a missing destination `StorageClass`, the upstream PV controller emits `ProvisioningFailed` against the PVC and the Pod stays scheduler-blocked behind an unbound PVC.

A third constraint shapes which volumes can ride through Velero's File-System Backup (FSB, the `--default-volumes-to-fs-backup` mode) at all. FSB, driven by the restic uploader in the Velero binary on this platform, supports backing up and restoring local volumes, but it does not support backing up or restoring `hostPath` volumes; a backup that includes hostPath-backed Pods will produce volumes that cannot be reconstituted on the destination side regardless of how the cluster identity issues above are resolved.

## Resolution

Bring the destination cluster into agreement with the backup before restoring, then let Velero replay the namespaced objects. Velero preserves API objects as-is on restore, so cluster-scoped and node-pinned state that the source backup carried — the `StorageClass` referenced by the PVCs and the local `PersistentVolume` whose `nodeAffinity` targets a source-cluster hostname — has to exist on the destination side first.

Ensure the destination `StorageClass` referenced by the backup's PVCs already exists on the destination cluster before the restore runs. `StorageClass` is cluster-scoped and is not restored automatically with the namespaced workload; if the backup pins a `storageClassName` that the destination cluster does not have, the restored PVC will sit in `Pending` with the `storageclass.storage.k8s.io "<name>" not found` event described above.

For each local `PersistentVolume` in the backup, manually pre-create a matching destination PV before the restore. The pre-created PV must reuse the same `metadata.name` as the source PV, so that the restored PVC's `spec.volumeName` still resolves to it and the binding survives the restore. Its `spec.nodeAffinity` must point at a node hostname that actually exists on the destination cluster — a `kubernetes.io/hostname In [<destination-node>]` term — so the scheduler can place workloads that reference it. The standard local-PV shape applies: `spec.local.path` (a `LocalVolumeSource`) names the on-disk path on the chosen node, and `spec.nodeAffinity` carries the `required.nodeSelectorTerms[].matchExpressions` block keyed on `kubernetes.io/hostname`. A minimal manifest:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: <same-name-as-source-pv>
spec:
  capacity:
    storage: <same-as-source>
  accessModes:
    - ReadWriteOnce
  storageClassName: <destination-storageclass-name>
  local:
    path: /var/lib/<workload>/data
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - <destination-node-hostname>
```

The directory referenced by `spec.local.path` must already exist on the named destination node before the PV will bind; the local-volume provisioner does not create the path itself, and a kubelet that cannot find the directory at mount time will leave the dependent Pod stuck on a mount failure that no Velero-side diagnostic surfaces.

When the workload uses File-System Backup (FSB), the local-volume contents flow through the restic uploader on restore and land in the destination PV's filesystem. Backups whose volumes are `hostPath` rather than local-type cannot be carried this way — FSB does not support hostPath volumes — and need a different data-movement path before any of the above will produce a usable destination workload.

On ACP the install-side prerequisite that gates any `Backup` or `Restore` CR is not a `DataProtectionApplication` CR but the velero `ClusterPluginInstance` itself: `cpins.spec.config.backupsEnabled=true` plus a populated `BackupStorageLocation` triple (bucket, s3Url, region) and matching `credentials` (secretId, secretKey) must be set on the `velero` cpins before the controller will admit a Restore — the default cpins ships with `backupsEnabled:false` and an empty BSL, and a Restore CR submitted against that state fails validation before any of the diagnostics below fire.

With the velero cpins configured and the destination `StorageClass` and the renamed-node local PVs in place, trigger the Velero restore against the backup. Velero's controller in the `cpaas-system` namespace watches `Restore` resources in that namespace and processes them with the upstream velero binary.

## Diagnostic Steps

Inspect the restored PVC to confirm both its bound PV name and the `storageClassName` it is asking for; the same command exposes the `accessModes` and `capacity` it expects:

```bash
kubectl describe pvc -n <ns> <pvc-name>
```

A `ProvisioningFailed` event mentioning `storageclass.storage.k8s.io "<name>" not found` here means the destination cluster is missing the named `StorageClass` and the PVC is blocked at provisioning; the dependent Pod will show `FailedScheduling` with `pod has unbound immediate PersistentVolumeClaims` until that PVC binds.

Inspect each local `PersistentVolume` to read back the `spec.nodeAffinity` block — the `kubernetes.io/hostname` `matchExpressions` printed there is the exact node identity the scheduler is matching against:

```bash
kubectl describe pv <pv-name>
```

If a Pod backed by a local PV is `Pending` with `node(s) had volume node affinity conflict`, the hostname under the PV's `nodeAffinity` does not exist on the destination cluster; in a cross-cluster restore scenario this is the residue of Velero preserving the source-cluster hostname unchanged, and the fix is the pre-created destination PV described in the resolution.

Drive Velero's own restore reporter directly against the controller deployment in `cpaas-system` to list per-resource restore outcomes (created / failed) and the warnings the restore emitted:

```bash
kubectl exec -n cpaas-system deploy/velero -- \
  ./velero restore describe <restore-name> --details
```

A warning of the form `PersistentVolume "<name>" already exists ... the in-cluster version is different than the backed-up version` against one of the local PVs is the expected signal that the destination cluster already carries a manually pre-created PV under the same name and Velero kept the in-cluster object intact rather than overwriting it.
