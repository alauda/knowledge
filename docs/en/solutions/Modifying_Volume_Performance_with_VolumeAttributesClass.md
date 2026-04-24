---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A `StorageClass` defines how a new volume is provisioned, but its name is immutable on an existing `PersistentVolumeClaim` — once a PVC is bound, changing the performance tier historically meant deleting the volume, creating a new one, and migrating data. `VolumeAttributesClass` (VAC) is the upstream Kubernetes CSI feature that closes that gap. It carries the driver-level knobs (IOPS, throughput, provider-specific parameters) that can be mutated on a live volume, and the reference on a PVC is mutable. Changing which VAC a PVC points at triggers the CSI driver to reconfigure the underlying volume without detaching the pod.

VAC went GA in Kubernetes v1.34 and is usable on any cluster whose CSI driver advertises the `ModifyVolume` capability. The surface is pure upstream Kubernetes API, so it works identically on ACP.

## Prerequisites

- A CSI driver that implements `ModifyVolume`. On AWS that means the EBS CSI driver at v1.35 or later; on Google Cloud the PD CSI driver on instance families that support Hyperdisk (C3 / N4). For third-party CSI drivers consult the vendor matrix — the capability is advertised in the `CSIDriver` object, `spec.volumeAttributesClass` handling.
- A cluster version with the `VolumeAttributesClass` feature enabled (Kubernetes v1.34+; earlier releases required an alpha/beta feature gate).
- The CSI driver bound to a `StorageClass` the PVC already uses.

## Resolution

Define one `VolumeAttributesClass` per performance tier you want to offer. The object only describes the target parameters — it does not provision storage itself. Two examples below describe a baseline and a high-performance tier against the AWS EBS CSI driver.

```yaml
apiVersion: storage.k8s.io/v1beta1
kind: VolumeAttributesClass
metadata:
  name: base-iops-example
driverName: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
---
apiVersion: storage.k8s.io/v1beta1
kind: VolumeAttributesClass
metadata:
  name: high-iops-example
driverName: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "5000"
  throughput: "125"
```

Apply them and reference the baseline on a new PVC. The PVC stays `Pending` until a pod consumes it if the `StorageClass` uses `WaitForFirstConsumer` — schedule a workload to bind it, then confirm the VAC is attached:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3-csi
  volumeAttributesClassName: base-iops-example
  resources:
    requests:
      storage: 20Gi
```

```bash
kubectl apply -f pvc.yaml
kubectl get pvc example -o jsonpath='{.spec.volumeAttributesClassName}{"\n"}'
```

To upgrade the live volume to the high-performance tier, patch the PVC to point at the new VAC. The CSI driver picks up the change, calls the cloud provider's modify-volume API, and reports progress back on the PVC status. No pod restart is needed; I/O continues while the provider reconciles the new parameters.

```bash
kubectl patch pvc example \
  --type=merge \
  -p '{"spec":{"volumeAttributesClassName":"high-iops-example"}}'

kubectl get pvc example \
  -o jsonpath='{.status.currentVolumeAttributesClassName}{"\n"}{.status.modifyVolumeStatus}{"\n"}'
```

Unspecified parameters are "sticky": switching to a new VAC that omits a field keeps the value from the previous VAC rather than reverting to a driver default. Make every VAC declare the full set of parameters you care about so the live state is always a function of the VAC name alone.

## Diagnostic Steps

Watch the PVC transition through the three expected states:

1. **In progress** — the driver is reconfiguring the volume. Check the PVC status:

   ```bash
   kubectl get pvc example -o yaml \
     | grep -A3 modifyVolumeStatus
   ```

   While this is pending the application keeps running on the prior parameters.

2. **Error** — the provider rejected the modification (invalid parameter combination, cooldown window not elapsed). The PVC status carries the error message:

   ```bash
   kubectl describe pvc example | sed -n '/Events/,$p'
   ```

   The volume stays on its last known good configuration, so no data is at risk. Common causes: switching between two VACs too quickly (AWS EBS enforces roughly six hours between modifications on a single volume), or requesting a throughput/IOPS combination outside the driver's supported range.

3. **Success** — the provider has applied the new parameters; `status.currentVolumeAttributesClassName` reflects the target VAC.

When multiple PVCs across a cluster should be tracked, list them and the VAC each one currently has:

```bash
kubectl get pvc -A \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,VAC:.spec.volumeAttributesClassName,CUR:.status.currentVolumeAttributesClassName
```

Rows where `VAC` and `CUR` differ are PVCs mid-modification or stuck on an error — check their events. Cloud providers also typically expose modification history on the volume itself (EBS `DescribeVolumesModifications`, GCP disk attributes) for timeline reconstruction when a rollback is needed.
