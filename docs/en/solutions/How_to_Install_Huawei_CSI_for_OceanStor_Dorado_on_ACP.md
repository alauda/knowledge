---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
id: KB260600012
---

# How to Install and Configure Huawei CSI for OceanStor Dorado on ACP

## Overview

This guide walks you through manually (offline) installing the Huawei CSI driver on an ACP cluster and integrating it with a Huawei OceanStor Dorado storage array. It covers preparing the nodes, deploying the CSI components, configuring a storage backend, creating a StorageClass, and validating the integration with a test PVC. Both the iSCSI and NFS protocols are validated.

## Environment

| Component | Version |
|-----------|---------|
| Container Platform | ACP 4.x (validated on 4.2) |
| Node Operating System | Micro OS 5.5 |
| Storage Device | OceanStor Dorado 6.1.6 |
| Huawei CSI | v4.11.0 |
| Installation Method | Manual |
| Validated Protocols | iSCSI, NFS |

> **Note**: The procedure applies to all ACP 4.x versions. The Huawei CSI and OceanStor Dorado versions, however, are coupled — confirm that the CSI version you install is on the compatibility list for your Dorado firmware version before proceeding. The versions in the table above are the ones validated for this guide.

## Prerequisites

- An ACP 4.x cluster, with `kubectl` access to it.
- A reachable OceanStor Dorado array, and the management address, storage pool names, and data-plane portal addresses provided by the storage administrator.
- Layer-3 connectivity between every cluster node (master and worker) and the storage management plane and data plane. Confirm this during environment planning.
- The Huawei CSI v4.11.0 package obtained from the official Huawei channel, containing the `manual/` (installation YAML), `image/` (offline images), and `bin/` (the `oceanctl` tool) directories.
- A node with a container runtime (for example Docker) that can load the offline images and push them to the cluster image registry.

The following placeholders are used throughout this guide. Replace them with the values for your environment:

| Placeholder | Description |
|-------------|-------------|
| `<dorado-management-ip>` | Dorado management plane address |
| `<iscsi-portal-ip>` | iSCSI data-plane portal address |
| `<nfs-portal-ip>` | NFS data-plane portal address |
| `<registry>` | Cluster image registry address |
| `<pool-name>` | OceanStor storage pool name |

## Resolution

### 1. Prepare the cluster nodes

#### 1.1 Verify network connectivity

All cluster nodes (both master and worker) must be able to reach the storage management plane and data plane:

| Purpose | Address | Description |
|---------|---------|-------------|
| Dorado management plane | `<dorado-management-ip>:8088` | CSI manages the storage through this address |
| iSCSI data plane | `<iscsi-portal-ip>` | iSCSI portal, business IO path |
| NFS data plane | `<nfs-portal-ip>` | NFS portal, business IO path |

Verify connectivity on each node:

```shell
ping <dorado-management-ip>
# ping only checks ICMP reachability; also verify the management API port (8088) is open
curl -k https://<dorado-management-ip>:8088
ping <iscsi-portal-ip>
ping <nfs-portal-ip>
```

#### 1.2 Configure the firewall

Micro OS keeps firewalld and SELinux enabled. The webhook service port of `huawei-csi-controller` (4433/tcp) must be opened:

```shell
# Show the currently opened ports
firewall-cmd --list-ports

# Open 4433/tcp (CSI webhook port)
firewall-cmd --zone=public --add-port=4433/tcp --permanent && firewall-cmd --reload

# Verify
firewall-cmd --list-ports
```

#### 1.3 Confirm host software dependencies

Confirm that the following services are running on **all nodes**, based on the protocols you plan to use:

**iSCSI protocol (required when using iSCSI):**

```shell
systemctl status iscsi iscsid
# If not started:
systemctl enable iscsi iscsid --now
```

**NFS protocol (required when using NFS):**

```shell
systemctl status rpcbind
# If not started:
systemctl enable rpcbind --now
```

**DM-Multipath (required when using iSCSI/FC):**

```shell
systemctl status multipathd.socket multipathd
# If not started:
systemctl enable multipathd --now
```

#### 1.4 Configure multipath

Confirm that `/etc/multipath.conf` contains the following configuration. If the file does not exist, create it with this content:

```text
defaults {
        user_friendly_names yes
        find_multipaths no
}
```

### 2. Prepare the installation package and images

#### 2.1 Upload images to the registry

On the node with a container runtime, load the following image packages and push them to the cluster image registry one by one:

```shell
# Load images (replace <arch> with the node architecture, e.g. amd64 or arm64)
docker load -i huawei-csi-v4.11.0-<arch>.tar
docker load -i storage-backend-controller-v4.11.0-<arch>.tar
docker load -i storage-backend-sidecar-v4.11.0-<arch>.tar
docker load -i huawei-csi-extender-v4.11.0-<arch>.tar

# Tag and push (repeat for each image)
docker tag huawei-csi:4.11.0 <registry>/huawei-csi:4.11.0
docker push <registry>/huawei-csi:4.11.0
```

#### 2.2 Replace the image addresses in the YAML files

By default, the YAML files in the CSI package reference the official image addresses. Replace them with your cluster image registry address. Run the following in the `manual/esdk/deploy/` directory:

```shell
# First inspect the current image references to identify the default registry prefix
grep 'image:' *.yaml

# Replace that default prefix with your cluster registry address.
# Set <default-registry-address> to the prefix shown by the grep above (the part before /huawei-csi).
# A '#' delimiter is used because registry addresses contain '/'.
sed -i 's#<default-registry-address>#<registry>#g' *.yaml

# Confirm the replacement result
grep 'image:' *.yaml
```

> **Note**: If the image tag suffix (commit hash) does not match the version you actually pushed, replace it with `sed` as well:
>
> ```shell
> sed -i 's/<old-tag-suffix>/<new-tag-suffix>/g' *.yaml
> ```

### 3. Deploy the CSI components

Enter the `manual/esdk/` directory and run the following in order:

#### 3.1 Create the namespace

```shell
kubectl create ns huawei-csi
```

#### 3.2 Deploy the Backend CRD

```shell
kubectl apply -f ./crds/backend/
```

#### 3.3 Deploy the Snapshot CRD (optional, Kubernetes v1.20+)

`--validate=false` skips client-side schema validation. It is required here because the bundled snapshot CRD manifests may target a different snapshot API version than the one on the cluster.

```shell
kubectl apply -f ./crds/snapshot-crds/ --validate=false
```

#### 3.4 Deploy the CSIDriver

```shell
kubectl apply -f ./deploy/csidriver.yaml
```

#### 3.5 Deploy the Controller

```shell
kubectl apply -f ./deploy/huawei-csi-controller.yaml
```

#### 3.6 Deploy the Node

```shell
kubectl apply -f ./deploy/huawei-csi-node.yaml
```

#### 3.7 Verify the deployment status

```shell
kubectl get pod -n huawei-csi
```

The deployment is successful when all Pods are in the `Running` state.

### 4. Configure the storage backend

Use the `oceanctl` tool (located in the `bin/` directory of the CSI package) to create the backend.

#### 4.1 Backend authentication

You do not need to create the credentials Secret manually. When you run `oceanctl create backend` (steps 4.2 and 4.3), it interactively prompts for the storage account user name and password and stores them in a Kubernetes Secret in the `huawei-csi` namespace automatically:

```text
Please enter this backend user name:
Please enter this backend password:
```

Use a Dorado account that has permission to manage the target storage pool.

#### 4.2 Create an iSCSI backend

Create `backend-blk.yaml`:

```yaml
storage: "oceanstor-san"
name: "backend-blk"
namespace: "huawei-csi"
urls:
  - "https://<dorado-management-ip>:8088"
pools:
  - "<pool-name>"
parameters:
  protocol: "iscsi"
  portals:
    - "<iscsi-portal-ip>"
maxClientThreads: "30"
```

Create the backend:

```shell
./bin/oceanctl create backend -f backend-blk.yaml -i yaml --log-dir /tmp/
```

#### 4.3 Create an NFS backend

Create `backend-nfs.yaml`:

```yaml
storage: "oceanstor-nas"
name: "backend-nfs"
namespace: "huawei-csi"
urls:
  - "https://<dorado-management-ip>:8088"
pools:
  - "<pool-name>"
parameters:
  protocol: "nfs"
  portals:
    - "<nfs-portal-ip>"
maxClientThreads: "30"
```

Create the backend:

```shell
./bin/oceanctl create backend -f backend-nfs.yaml -i yaml --log-dir /tmp/
```

#### 4.4 Verify the backend status

```shell
./bin/oceanctl get backend -n huawei-csi
```

### 5. Configure the StorageClass

#### 5.1 iSCSI StorageClass

```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: huawei-sc-iscsi
provisioner: csi.huawei.com
parameters:
  backend: backend-blk
  volumeType: lun
  allocType: thin
  fsType: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
```

```shell
kubectl apply -f sc-iscsi.yaml
```

#### 5.2 NFS StorageClass

```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: huawei-sc-nfs
provisioner: csi.huawei.com
parameters:
  backend: backend-nfs
  volumeType: fs
  allocType: thin
  authClient: "*"
mountOptions:
  - nfsvers=4.1
reclaimPolicy: Delete
allowVolumeExpansion: true
```

```shell
kubectl apply -f sc-nfs.yaml
```

> **Note**: `authClient: "*"` allows any NFS client to mount the volume, which is convenient for validation. For production, restrict it to specific client IPs or CIDR ranges (for example, `192.0.2.0/24`).

### 6. Verification

Create a test PVC to verify that the storage integration works correctly:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: huawei-sc-iscsi   # or huawei-sc-nfs
  resources:
    requests:
      storage: 10Gi
```

```shell
kubectl apply -f test-pvc.yaml
kubectl get pvc test-pvc
```

The verification is successful when the PVC status becomes `Bound`.

## FAQ

### Creating a backend fails with `context deadline exceeded`

**Error message:**

```text
failed to configure the backend account. Error from server (InternalError): error when creating "STDIN": Internal error occurred: failed calling webhook "storage-backend-controller.xuanwu.huawei.io": failed to call webhook: Post "https://huawei-csi-controller.huawei-csi.svc:4433/storagebackendclaim?timeout=10s": context deadline exceeded
```

**Cause analysis:**

- Storage network is unreachable: the CSI controller cannot connect to the Dorado management address or portal.
- Communication between the kube-apiserver and the CSI webhook is abnormal (for example, intercepted by an HTTPS proxy).

**Troubleshooting steps:**

1. Check the controller logs:

   ```shell
   # Get the controller pod name
   kubectl get pod -n huawei-csi

   # View the log file (on the node where the controller runs)
   tail -f /var/log/huawei/storage-backend-controller/*.log
   ```

2. Confirm that the node can reach the Dorado management address:

   ```shell
   ping <dorado-management-ip>
   curl -k https://<dorado-management-ip>:8088
   ```

3. Confirm that the firewall has opened port 4433 (see step 1.2).

**Temporary workaround:**

If troubleshooting does not resolve the issue, try restarting the CSI controller pod:

```shell
kubectl delete pod -n huawei-csi -l app=huawei-csi-controller
```

Alternatively, as a last resort, temporarily delete the webhook (after deletion, backend creation is no longer validated). The webhook is automatically restored after the controller restarts:

> **Warning**: Deleting the webhook disables backend-configuration validation. Use this only for troubleshooting in a non-production environment, and restore it immediately afterward by restarting the controller.

```shell
kubectl delete validatingwebhookconfiguration storage-backend-controller.xuanwu.huawei.io
# Restart the controller to restore the webhook
kubectl delete pod -n huawei-csi -l app=huawei-csi-controller
```

### A Pod cannot access the mounted volume as a non-root user (fsPermission / fsGroup issue)

When a Pod uses `securityContext` to specify a non-root user (for example, `runAsUser: 1000`), it may encounter insufficient permissions on the volume directory. There are three solutions:

**Solution 1: Set fsPermission in the StorageClass**

Suitable for quickly opening up permissions in a development or test environment:

```yaml
parameters:
  fsPermission: "777"
```

> **Warning**: `fsPermission: "777"` grants full read/write/execute to every user on the node. Avoid it in production; prefer the `fsGroup`-based approaches in Solution 2 or 3.

**Solution 2: Explicitly specify fsType in the StorageClass + use ReadWriteOnce for the PVC**

Explicitly specify `fsType` in the StorageClass and set the PVC `accessMode` to `ReadWriteOnce`. Only then does the `fsGroup` in the Pod's `securityContext` take effect:

```yaml
# StorageClass
parameters:
  fsType: ext4

# Pod securityContext
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
```

**Solution 3: Modify the CSIDriver fsGroupPolicy before deployment**

Before installing the CSI, modify the CSIDriverObject configuration in `csidriver.yaml`:

```yaml
# Set in deploy/csidriver.yaml
spec:
  fsGroupPolicy: File
```

After deployment, the Pod's `securityContext.fsGroup` takes effect:

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
```
