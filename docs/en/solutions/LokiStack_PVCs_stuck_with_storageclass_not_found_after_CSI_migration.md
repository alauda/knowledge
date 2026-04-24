---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After deploying a `LokiStack` custom resource with `storageClassName: gp2` (or `gp3`), the Loki component PVCs never bind. The logging namespace shows `ProvisioningFailed` events of the form:

```text
Warning  ProvisioningFailed  persistentvolumeclaim/storage-logging-loki-compactor-0
storageclass.storage.k8s.io "gp2" not found
Warning  ProvisioningFailed  persistentvolumeclaim/storage-logging-loki-ingester-0
storageclass.storage.k8s.io "gp2" not found
Warning  ProvisioningFailed  persistentvolumeclaim/wal-logging-loki-ingester-0
storageclass.storage.k8s.io "gp2" not found
```

The Loki pods stay Pending because their attached PVCs cannot be provisioned. The symptom can appear on fresh installs or, more commonly, when a cluster has been upgraded to a version where in-tree volume plugins were migrated to CSI and the legacy `gp2` / `gp3` StorageClass names are no longer present.

## Root Cause

Historical LokiStack examples, including older reference configurations, use the in-tree StorageClass names `gp2` and `gp3`. Recent platform versions complete the CSI migration for EBS — the in-tree provisioner is disabled and only the CSI-backed StorageClasses remain. On a CSI-migrated cluster the available names are typically `gp2-csi` and `gp3-csi` (the CSI driver installs them during the migration). A `LokiStack` that still references `gp2` or `gp3` therefore points at a non-existent StorageClass and PVC provisioning fails.

The same pattern applies to any platform whose default in-tree driver has been migrated to a CSI driver — the names change even though the underlying block device type is identical.

## Resolution

Update the `LokiStack` custom resource to reference a StorageClass that actually exists on the cluster. List the available ones first:

```bash
kubectl get storageclass
```

Representative output on a CSI-migrated AWS cluster:

```text
NAME            PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE      AGE
gp2-csi         ebs.csi.aws.com         Delete          WaitForFirstConsumer   7d
gp3-csi         ebs.csi.aws.com         Delete          WaitForFirstConsumer   7d
```

Edit the `LokiStack` to use the CSI-backed name (use the class that matches your workload — `gp3-csi` is usually the better default on AWS):

```yaml
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
  namespace: <logging-namespace>
spec:
  size: 1x.small
  storageClassName: gp3-csi
  storage:
    schemas:
      - version: v13
        effectiveDate: "2024-01-01"
    secret:
      name: logging-loki-s3
      type: s3
  tenants:
    mode: static
```

Apply the change with:

```bash
kubectl apply -f lokistack.yaml
```

If PVCs have already been created with the broken reference, they need to be recreated — `storageClassName` is immutable on an existing PVC. The safe sequence is:

```bash
# 1. Scale LokiStack pods down so the StatefulSets release their PVCs.
kubectl -n <logging-namespace> scale statefulset --all --replicas=0

# 2. Delete the broken PVCs (no data has been written yet because binding failed).
kubectl -n <logging-namespace> delete pvc -l app.kubernetes.io/part-of=loki

# 3. Scale the StatefulSets back up; the operator recreates the PVCs with the
#    new storageClassName.
kubectl -n <logging-namespace> scale statefulset --all --replicas=1
```

If Loki pods are already running and holding data you want to keep, create the CSI StorageClass under the legacy name (point `gp2` at the CSI provisioner) rather than editing the `LokiStack`. This keeps existing PVCs valid:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp2
parameters:
  type: gp2
  encrypted: "true"
provisioner: ebs.csi.aws.com
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

Choose one of the two paths consistently — do not leave the cluster with both a legacy `gp2` alias and mixed references in `LokiStack`.

On ACP cloud deployments that use Ceph, MinIO, or TopoLVM for Loki rather than EBS, pick the StorageClass exposed by the ACP `storage` component (for example the `ocs-storagecluster-ceph-rbd` class from `storagesystem_ceph`, or a `topolvm-*` class from `storagesystem_topolvm`). The same edit applies — change `storageClassName` in `LokiStack` to the name that `kubectl get storageclass` actually lists.

## Diagnostic Steps

Confirm the StorageClass referenced by `LokiStack` does not exist:

```bash
kubectl get lokistack -n <logging-namespace> -o \
  jsonpath='{.items[*].spec.storageClassName}{"\n"}'
kubectl get storageclass | grep -E "gp2|gp3"
```

Look for the provisioning-failure events:

```bash
kubectl get events -n <logging-namespace> --sort-by=.lastTimestamp \
  | grep -E "storageclass.*not found|ProvisioningFailed"
```

Inspect a Loki PVC directly to see which class it tried to use:

```bash
kubectl get pvc -n <logging-namespace> storage-logging-loki-ingester-0 \
  -o jsonpath='{.spec.storageClassName}{"\n"}'
```

After applying the fix, watch the PVCs bind and the Loki components come Ready:

```bash
kubectl get pvc -n <logging-namespace> -w
kubectl get pod -n <logging-namespace> -w
```
