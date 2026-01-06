---
kind:
   - Solution
products: 
  - Alauda Application Services
ProductsVersion:
   - 3.x,4.x
id: KB260100003
---

# Create a PostgreSQL Instance Using Hostpath PV Without an External Provisioner

## Introduction

This guide explains how to configure an instance of Alauda support for PostgreSQL to store its data in a specific directory on your Kubernetes host machine. This is achieved by creating a manual `StorageClass` and a `PersistentVolume` (PV). This approach is useful when an external storage provisioner is not available.

## Prerequisites

1. **Postgres Operator**: Ensure the Alauda support for PostgreSQL Operator is installed in your cluster.
2. **Host Directory**: Create the target directory on your worker node and set the correct permissions. The Alauda support for PostgreSQL (Spilo) image runs as `UID 101` and `GID 103`.

```bash
# Run these on your host machine
sudo mkdir -p /mnt/data/postgres-1
sudo chown -R 101:103 /mnt/data/postgres-1
```

## Procedure

### 1. Create the Manual StorageClass

To bypass dynamic provisioning, create a StorageClass with the "no-provisioner" provisioner. This indicates that storage volumes (PVs) will be provisioned manually.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: manual-hostpath
  labels:
    project.cpaas.io/<your-project-name>: "true" # Replace <your-project-name> with your actual project name
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

### 2. Create the PersistentVolume (PV)

A PersistentVolume (PV) represents the storage on the host directory. It must reference the `storageClassName` defined in the previous step.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-pv-1
spec:
  capacity:
    storage: 10Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual-hostpath
  hostPath:
    path: "/mnt/data/postgres-1" # Path on the host machine
  nodeAffinity: # Optional but recommended: Pin to a specific node
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - your-node-name # Replace with your actual node name
```

### 3. Define the Postgres Instance

In your `postgresql` manifest, set `volume.storageClass` to the manual StorageClass created earlier. For additional configuration options, refer to [Create Instance](https://docs.alauda.io/postgresql/4.1/functions/01_create_instance.html).

```yaml
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: pg-single
spec:
  ipFamilyPrefer: ""
  teamId: ACID
  enableExporter: true
  enablePgpool2: false
  spiloPrivileged: false
  spiloRunAsGroup: 103
  spiloRunAsUser: 101
  spiloAllowPrivilegeEscalation: false
  enableReadinessProbe: true
  # restrictedPsaEnabled: true # Open this for ACP 4.2
  postgresql:
    parameters:
      log_directory: /var/log/pg_log
    version: "16"
  numberOfInstances: 1 # For hostPath, it is safest to start with 1
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
    limits:
      cpu: "1"
      memory: 2Gi
  volume:
    size: 10Gi
    storageClass: manual-hostpath
```

## Important Considerations

### High Availability (HA)

If you set `numberOfInstances` to 2 or more, the operator will attempt to create multiple `PersistentVolumeClaims`. You must create a matching number of `PersistentVolumes` (e.g., `postgres-pv-1`, `postgres-pv-2`) pointing to **different** host directories.

### Troubleshooting

If the Pod stays in `Pending` state, check the events:

```bash
kubectl describe pod <postgres-pod-name>
```

Common issues include:
- **StorageClass Mismatch**: The `storageClassName` in the PV must exactly match the one in the StorageClass and the Postgres manifest.
- **Capacity**: The PV capacity must be equal to or greater than the requested `volume.size` in the Postgres manifest.
- **Permissions**: If the Pod starts but crashes with a "Permission Denied" error in logs, verify the `chown -R 101:103` step on the host directory.
- **Admission Webhook Denied**: If you see an error like `admission webhook "pvc-validator.cpaas.io" denied the request`, check if the `<your-project-name>` in the `StorageClass` label matches the project name where the Postgres instance is deployed.
- **Scheduling Failed (Node Affinity)**: If the PV is `Available` but the Pod fails with `didn't find available persistent volumes to bind`, check the PV's `nodeAffinity`. You likely forgot to replace `your-node-name` with a real node hostname from `kubectl get nodes`.

### Reusability

When you delete the Postgres instance, the `PersistentVolume` will go into a `Released` state (because of the `Retain` policy). To reuse it for a new database, you must manually delete the PV and recreate it, or clear the `spec.claimRef` field in the PV metadata.
