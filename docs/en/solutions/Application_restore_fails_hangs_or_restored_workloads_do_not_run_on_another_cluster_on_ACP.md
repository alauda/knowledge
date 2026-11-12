---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Application restore fails, hangs, or restored workloads do not run on another cluster on ACP

## Issue

An application (namespace) backup made with the platform backup and restore feature (Velero, objects `restores.velero.io` in `cpaas-system`) exists, and the restore on Alauda Container Platform fails, hangs, or finishes while the restored namespace does not work on the target:

- The restore fails with `admission webhook "vconnector.kb.io" denied the request: Connector.connectors.alauda.io/<name> is invalid: spec.authSecretRef.Namespace: Invalid value: "<namespace-a>": secretRef namespace must be empty or equal to connector namespace: <namespace-b>`.
- In a disaster-recovery drill, a namespace backed up on one platform is restored to a separate DR platform and:
  - restored StatefulSet or Deployment pods stay `Pending` because their `nodeSelector` still names the source host;
  - images fail to pull because the two platforms use different Harbor registries;
  - PVCs that used `local-path` on the source cannot be used on the DR cluster.
- A running restore task hangs and must be stopped by hand; it stays in progress with no error, even after the target namespace was deleted.
- Before relying on cross-platform restore: must the project match, and does a restore across two global platforms behave differently?

A restore replays the namespace's own YAML as it was captured. Anything in that YAML that refers to the source environment (node labels, registry address, StorageClass, node-pinned PVs) is restored unchanged, and everything outside the namespace (project association, image pull authorization, load balancer rules, DNS) has to be prepared on the target.

## Root Cause

### Cause 1: a restored Connector points at a Secret in another namespace

The `vconnector.kb.io` admission webhook validates `Connector` (`connectors.alauda.io`) objects and accepts `spec.authSecretRef.namespace` only when it is empty or equal to the Connector's own namespace. When the Connector is restored into a namespace different from the one named in `spec.authSecretRef`, the webhook rejects it and the restore fails. The problem is the namespace relationship between the Connector and its Secret, not the backup content.

### Cause 2: restored pods are Pending because nodeSelector holds the source cluster's node value

Restored workloads keep their `nodeSelector` (for example the original host IP). The restore does not rewrite scheduling fields, so on a cluster whose nodes do not carry that label value the pods cannot be scheduled: `0/<n> nodes are available: <n> node(s) didn't match Pod's node affinity/selector`.

### Cause 3: ErrImagePull / ImagePullBackOff because the target platform uses a different Harbor

The restored YAML still names the source registry, and the target namespace has no pull authorization for it.

### Cause 4: local-path PVCs are unusable on the DR cluster

`local-path` writes to a directory on the host node. The DR cluster has no identical `local-path` StorageClass, so the restored PVCs cannot be provisioned. Local PV data does not move with the YAML, and a restored local PV keeps the source node in its `nodeAffinity`, so it cannot bind on the DR cluster. StorageClass project assignment is not related to this.

### Cause 5: project and cross-platform expectations

Projects must be the same on the source and the DR cluster. A restore between two independent global platforms is a migration of YAML resources: only the namespace's own YAML is restored, and business dependencies (project association, image pull secrets, load balancer rules, DNS resolution) are adapted by hand on the new platform. The target cluster must also be able to read the backup from object storage, for example by binding the same S3 storage on both platforms.

### Cause 6: a restore task stays in progress and deleting the target namespace does not stop it

A restore task is a `restores.velero.io` resource. Deleting the target namespace does not stop or terminate it, so the task keeps showing in progress without an error.

## Resolution

### Cause 1: a restored Connector points at a Secret in another namespace

1. Compare the Connector's namespace with its Secret reference in the source:

```bash
kubectl get connectors.connectors.alauda.io -A
kubectl -n <source-namespace> get connectors.connectors.alauda.io <connector-name> -o yaml | grep -A3 authSecretRef
```

2. Bring the pair into the shape the webhook accepts: the referenced Secret is in the same namespace as the Connector, and `spec.authSecretRef.namespace` is empty or that same namespace after the restore. Adjust the Secret's namespace and the Connector configuration accordingly, then run the restore again.
3. Check the target:

```bash
kubectl -n <target-namespace> get connectors.connectors.alauda.io <connector-name> -o jsonpath='{.metadata.namespace} {.spec.authSecretRef}{"\n"}'
kubectl -n <target-namespace> get secret <secret-name>
```

### Cause 2: restored pods are Pending because nodeSelector holds the source cluster's node value

Either label target nodes with the value the workload asks for, or remove the `nodeSelector`:

```bash
kubectl -n <namespace> get statefulset <name> -o jsonpath='{.spec.template.spec.nodeSelector}{"\n"}'
kubectl label node <target-node> <label-key>=<label-value>
```

> **Warning:** Removing `nodeSelector` changes the pod template, so the workload rolls its pods and they may land on any node. Precondition: the restored pods are `Pending` because the selector names a source-cluster node, and the object is saved. Rollback: re-apply the saved YAML.

```bash
kubectl -n <namespace> get statefulset <name> -o yaml > /tmp/<name>-sts.yaml
kubectl -n <namespace> patch statefulset <name> --type=json \
  -p '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'
```

Use `deployment` instead of `statefulset` for a Deployment. A pod bound to a local PV is also limited by the PV's `nodeAffinity` (Cause 4).

### Cause 3: ErrImagePull / ImagePullBackOff because the target platform uses a different Harbor

1. Read which registry the restored pod uses and whether it has a pull secret. For pods that pull after retries without a pull secret, this also shows the registry they really used:

```bash
kubectl -n <namespace> get pod <pod> -o jsonpath='{range .spec.containers[*]}{.image}{"\n"}{end}{.spec.imagePullSecrets}{"\n"}'
kubectl -n <namespace> describe pod <pod> | grep -A5 -iE 'Failed|pull'
```

2. Choose one direction:
   - The same images exist in the target platform's registry: before the restore, perform the pre-recovery resource creation step described in the platform backup and restore documentation. It replaces the image registry address in the restored YAML. Then restore again.
   - Keep one shared Harbor: integrate that Harbor on both platforms (through toolchain management) and assign it to the project, then bring the recovered namespace under management with the import-namespace feature, which creates the registry authorization.

### Cause 4: local-path PVCs are unusable on the DR cluster

1. Create a `local-path` StorageClass on the DR cluster identical to the source one:

```bash
kubectl get storageclass local-path -o yaml > /tmp/local-path-sc.yaml   # on the source cluster
kubectl apply -f /tmp/local-path-sc.yaml                                # on the DR cluster, after removing uid, resourceVersion, creationTimestamp
```

2. Plan for empty volumes: the data in the source local PVs is not carried over.
3. For a restored local PV that names a source-cluster node, recreate the PV with the same name and a DR-cluster node in `nodeAffinity`. The API server rejects in-place changes to `spec.nodeAffinity` of an existing PV. The full procedure is in [Restoring local-volume workloads across ACP clusters with Velero](./Restoring_local_volume_workloads_across_ACP_clusters_with_Velero.md). Before deleting any restored PV, set its reclaim policy to `Retain` and save its YAML, so the provisioner does not remove the backing directory:

```bash
kubectl patch pv <pv-name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv <pv-name> -o yaml > /tmp/<pv-name>.yaml
```

### Cause 5: project and cross-platform expectations

1. Create the same project on the target platform and put the target namespace in it before restoring.
2. Prepare by hand what the namespace YAML does not carry: image registry access (Cause 3), StorageClasses (Cause 4), load balancer rules, and DNS records.
3. Make sure the target cluster can read the backup from the object storage that holds it.

### Cause 6: a restore task stays in progress and deleting the target namespace does not stop it

1. Confirm the task is still in progress and read what it last did:

```bash
kubectl -n cpaas-system get restores.velero.io <restore-name> -o jsonpath='{.status.phase}{"\n"}'
kubectl -n cpaas-system describe restores.velero.io <restore-name>
kubectl -n cpaas-system logs deploy/velero --tail=500 | grep '<restore-name>'
```

> **Warning:** Deleting the `restores.velero.io` object abandons the task and removes its status. It cannot be resumed, and objects it already restored stay in the target namespace. Precondition: `status.phase` stays `InProgress` with no progress in the Velero log, the owner accepts abandoning this restore, and the object is saved. Rollback: none for this task; run a new restore from the same backup, which this delete does not remove.

2. Stop the task by deleting the `restore` resource:

```bash
kubectl -n cpaas-system get restores.velero.io <restore-name> -o yaml > /tmp/<restore-name>.yaml
kubectl -n cpaas-system delete restores.velero.io <restore-name>
kubectl -n cpaas-system get restores.velero.io <restore-name>
```

3. Clean up by hand what the task already restored. Velero labels restored objects with `velero.io/restore-name`; if the list is empty and the namespace still exists, compare the namespace with the backup by hand.

```bash
kubectl -n <target-namespace> get all,configmap,secret,pvc -l velero.io/restore-name=<restore-name>
```

> **Warning:** Deleting the restored objects removes them from the target namespace, and a PVC whose PV reclaim policy is `Delete` loses its volume data. Precondition: the `restores.velero.io` object is gone, and every listed object was created by this partial restore and holds nothing to keep. Rollback: run a new restore.

```bash
kubectl -n <target-namespace> delete <kind> <name>
```

## Diagnostic Steps

1. On the cluster that runs the restore, read the status and errors:

```bash
kubectl -n cpaas-system get restores.velero.io
kubectl -n cpaas-system describe restores.velero.io <restore-name>
kubectl -n cpaas-system logs deploy/velero --tail=500 | grep -iE 'admission webhook|denied|<restore-name>'
```

2. For a finished restore whose workloads do not run, read the events in the restored namespace:

```bash
kubectl -n <namespace> get pods,pvc
kubectl -n <namespace> get events --sort-by=.lastTimestamp | tail -40
```

3. Match the signature:
   - `vconnector.kb.io` and `secretRef namespace must be empty or equal to connector namespace`: Cause 1.
   - `didn't match Pod's node affinity/selector` and a `nodeSelector` with a source node value: Cause 2.
   - `ErrImagePull` / `ImagePullBackOff` on a source-registry address: Cause 3.
   - PVC `Pending` on `local-path`, or `volume node affinity conflict`: Cause 4.
   - Project or cross-platform questions: Cause 5.
   - `status.phase` stays `InProgress` with no error, including after the target namespace was deleted: Cause 6.
   - `status.phase` is `Completed` without errors but ConfigMaps or other objects are missing: see [ConfigMaps missing after a namespace restore that completed without errors on ACP](./ConfigMaps_missing_after_a_namespace_restore_that_completed_without_errors_on_ACP.md).

## Related Information

- [What platform backup, application snapshots, and volume snapshots cover on ACP](./What_platform_backup_application_snapshots_and_volume_snapshots_cover_on_ACP.md)
