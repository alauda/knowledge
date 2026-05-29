---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Dynamic NFS storage provisioning for Tekton CI/CD on ACP

## Issue

CI/CD tooling such as Tekton needs persistent storage that survives pod restarts so successive tasks in a pipeline can hand workspace data to each other. The conventional pattern is dynamic provisioning: a Pod or PipelineRun references a PersistentVolumeClaim, the PVC names a StorageClass, and an external provisioner watches the PVC and creates a PersistentVolume on demand. Many on-prem deployments back this with NFS so a single export can serve `ReadWriteMany` pipeline workspaces and per-PVC subdirectories.

On Alauda Container Platform (Kubernetes `v1.34.5`, cluster `glean-lab-base-0529`), the upstream `nfs-subdir-external-provisioner` Helm chart is not part of the artifacts catalog and there is no first-party packaging for it. The cluster ships a different NFS dynamic-provisioning driver instead: the `nfs` ModulePlugin (`chart-csi-driver-nfs`, default channel `v4.4.0-beta.7`, repository `acp/chart-csi-driver-nfs`), which installs the upstream `kubernetes-csi/csi-driver-nfs` CSI driver. The driver registers under `nfs.csi.k8s.io` and plays the same dynamic-provisioning role through a CSI flange instead of the sig-storage-lib external-provisioner pod that the article-style chart uses.

## Resolution

### 1. Install the NFS CSI ModulePlugin

The driver ships as a `ClusterPluginInstance` against the `nfs` plugin name; on a stock cluster the plugin definition resolves through the marketplace ModulePlugin (already installed by default). Confirm the plugin is present and that the CSI driver registered itself, then verify the controller plus per-node DaemonSet pods are Running:

```bash
kubectl get clusterplugininstance nfs
# NAME   PLUGIN
# nfs    nfs

kubectl get csidriver nfs.csi.k8s.io
# NAME             ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY   ...   MODES        AGE
# nfs.csi.k8s.io   false            false            false             ...   Persistent   4h6m

kubectl -n cpaas-system get pods -l app.kubernetes.io/name=csi-driver-nfs
```

The plugin lays down a `csi-nfs-controller` Deployment plus a `csi-nfs-node` DaemonSet in `cpaas-system`; both must be Running before any NFS-backed PVC can mount.

### 2. Provide a reachable NFS export

The driver mounts using the standard Linux NFS client on each worker node — exactly the same kernel-side mount the article-style provisioner would use. The cluster does not run an NFS server; pick a customer-owned export reachable from every worker node IP range, and confirm the export's access controls (`no_root_squash` / `rw` / allowed hosts) permit the kubelet's mount.

### 3. Create an NFS-backed StorageClass

Name `nfs.csi.k8s.io` as the provisioner and pass the server and share through `parameters`. With dynamic provisioning enabled, each PVC that references this StorageClass gets its own subdirectory carved out of the share, and a PV is created automatically:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-csi
provisioner: nfs.csi.k8s.io
parameters:
  server: nfs.example.internal
  share: /exports/cluster
reclaimPolicy: Delete
volumeBindingMode: Immediate
```

`provisioner: nfs.csi.k8s.io` is the substitution for the article's NFS Subdirectory External Provisioner: same dynamic-provisioning behavior, CSI-driver lineage instead of sig-storage-lib. The `parameters.server` and `parameters.share` map to what the upstream Helm chart would write into its `nfs.server` and `nfs.path` values.

### 4. Optionally mark it the default

A cluster's default StorageClass is the one carrying the upstream `storageclass.kubernetes.io/is-default-class: "true"` annotation. PVCs that omit `spec.storageClassName` get mutated to whichever StorageClass is currently default, exactly as in upstream Kubernetes:

```bash
kubectl get sc
# NAME                    PROVISIONER          RECLAIMPOLICY   VOLUMEBINDINGMODE      ...
# topolvm-hdd (default)   topolvm.cybozu.com   Delete          WaitForFirstConsumer   ...

kubectl annotate sc nfs-csi storageclass.kubernetes.io/is-default-class=true --overwrite
kubectl annotate sc topolvm-hdd storageclass.kubernetes.io/is-default-class- --overwrite
```

Out of the box ACP ships `topolvm-hdd` as the default; only one StorageClass should carry the annotation at a time, so flip the old default off when promoting `nfs-csi`. If `nfs-csi` should be an additive choice rather than the default, leave both annotations alone.

### 5. Use the StorageClass from a Tekton Pipeline workspace

The Tekton operator (`tektoncd-operator`, ships in the platform catalog as the `Alauda DevOps Pipelines` OperatorBundle, default channel `latest`, version `v4.2.0`) installs `TektonConfig` / `TektonPipeline` and exposes `tekton.dev/v1` Pipeline / PipelineRun resources in the standard upstream shape. A workspace backed by a PVC simply names the PVC under `workspaces[].persistentVolumeClaim.claimName`, and successive tasks share the mounted directory:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pipeline-shared
  namespace: cicd
spec:
  accessModes: ["ReadWriteMany"]
  resources:
    requests:
      storage: 1Gi
  storageClassName: nfs-csi
---
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: build-and-test
  namespace: cicd
spec:
  pipelineRef:
    name: build-and-test
  workspaces:
  - name: shared-data
    persistentVolumeClaim:
      claimName: pipeline-shared
```

Under the NFS CSI driver the PVC can request `ReadWriteMany`, so tasks scheduled on different nodes can mount the same workspace concurrently. Backing the same workspace with the default `topolvm-hdd` SC works too, but topolvm is a local-volume provisioner and only allows `ReadWriteOnce`; for sequential tasks Tekton handles that by scheduling an affinity-assistant StatefulSet to colocate the pods. This pattern was verified on `glean-lab-base-0529`: a two-task pipeline (`write` then `read`) sharing a `topolvm-hdd`-backed PVC workspace ran to `SUCCEEDED`, with the `read` task printing the file the `write` task wrote.

## Diagnostic Steps

Confirm the driver and StorageClass are installed and the StorageClass renders correctly:

```bash
kubectl get csidriver nfs.csi.k8s.io
kubectl get sc nfs-csi -o yaml
kubectl -n cpaas-system get pods -l app.kubernetes.io/name=csi-driver-nfs
```

Create a smoke-test PVC and watch the external provisioner pick it up:

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nfs-smoke
  namespace: default
spec:
  accessModes: ["ReadWriteMany"]
  resources:
    requests:
      storage: 100Mi
  storageClassName: nfs-csi
EOF

kubectl describe pvc nfs-smoke
```

A healthy provisioning cycle emits a `Provisioning` event whose source is `nfs.csi.k8s.io_<driver-pod>` and ends with a `ProvisioningSucceeded`. If the `server` or `share` in the StorageClass is unreachable from the node where the smoke-test pod lands, the event reads `ProvisioningFailed` with the underlying `mount.nfs:` error (`Failed to resolve server …`, `Connection refused`, `access denied by server`); those are NFS-server-side faults, not cluster faults, and they need to be fixed on the export before any PVC will bind.

## Notes

The article's named `nfs-subdir-external-provisioner` Helm chart is not in the ACP artifacts catalog (`PACKAGE_NOT_FOUND` against the artifacts repo). It can still be applied off-catalog from upstream manifests if there is a hard requirement on its on-disk layout, but it carries no platform packaging, no ledger entry, and no `ClusterPluginInstance` — the supported path is `csi-driver-nfs`.

The Jenkins workflow described in the upstream guide (`Alauda DevOps Jenkins v3` OperatorBundle, `jenkins-operator` v3.20.15) follows the same pattern at the pod-spec level — a PVC mounted into Jenkins controller/agent pods — but the operator install and the controller-PVC binding path were not exercised on this cluster in this revision; treat the Jenkins variant as analogous-but-unverified.
