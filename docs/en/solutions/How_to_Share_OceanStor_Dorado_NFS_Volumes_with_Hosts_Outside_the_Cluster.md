---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
id: KB260700085
---

# How to Share OceanStor Dorado NFS Volumes with Hosts Outside the Cluster

## Overview

An NFS PersistentVolume provisioned by the OceanStor CSI driver For Dorado is stored as a filesystem and an NFS share on the storage array. A host outside the cluster can mount the share directly if it can reach the NFS portal and is allowed by the access-client rule.

This guide describes two supported approaches:

- Create the filesystem and NFS share on the array, and then connect the existing volume to Kubernetes as a static volume. This approach provides a fixed export path.
- Use a dynamically provisioned volume and obtain its generated export path from the PersistentVolume.

Use a static volume when an external system requires a stable mount path. Use a dynamically provisioned volume when Kubernetes manages the volume lifecycle and external access is required only after provisioning.

## Environment

| Component | Version |
|-----------|---------|
| Container Platform | ACP 4.x (validated on 4.3.1) |
| Node Operating System | Micro OS 5.5 |
| Storage Device | OceanStor Dorado 6.1.9 |
| OceanStor CSI driver For Dorado | v4.12.0 |
| External host | CentOS 7 with `nfs-utils` |
| Validated Protocol | NFS (v4.1 / v4.2) |

> **Note**: The procedures in this guide were validated with the versions listed above. Confirm CSI driver and storage firmware compatibility before applying them to another version combination.

## Prerequisites

- An ACP 4.x cluster with the OceanStor CSI driver For Dorado installed and an NFS backend configured. See *How to Install and Configure OceanStor CSI driver For Dorado on ACP*.
- A StorageClass with `volumeType: fs` and an `authClient` value that permits the external host.
- Layer-3 connectivity from the external host to the NFS data-plane portal. NFSv4.1/4.2 mounts require TCP port 2049 only. The `showmount` check in this guide additionally needs rpcbind (port 111) and the mountd port; if those are not open, the volume can still be mounted but `showmount` fails.
- `nfs-utils`, or an equivalent NFS client package, installed on the external host.
- For a static volume, administrative access to the storage REST API or DeviceManager UI and the storage pool information provided by the storage administrator.

The following placeholders are used throughout this guide. Replace them with values from your environment:

| Placeholder | Description |
|-------------|-------------|
| `<nfs-portal-ip>` | NFS data-plane portal address |
| `<dorado-management-ip>` | Storage management plane address |
| `<external-host>` | Host outside the cluster that mounts the volume |
| `<backend-name>` | CSI storage backend name, for example `backend-nfs` |
| `<storage-class>` | NFS StorageClass name |
| `<storage-pool-id>` | Numeric storage pool ID, not the pool name |
| `<volume-name>` | Filesystem name you choose for the static volume, for example `acp_static_nfs` |
| `<device-id>` | Storage device ID returned when the REST session is created |
| `<fs-id>` | Filesystem ID returned when the filesystem is created |
| `<share-id>` | NFS share ID returned when the share is created |
| `<client-cidr>` | CIDR range that is allowed to mount the share |
| `<namespace>` | Namespace of the PVC |

## Resolution

### 1. Select the volume provisioning approach

Each NFS volume has a filesystem, an NFS share, and one or more access-client rules on the array. The StorageClass `authClient` parameter is used for the access-client rule. For example, `authClient: "*"` allows every client that can reach the NFS portal to mount the share.

No additional CSI configuration is required for external mounting. The provisioning approach determines the export path and lifecycle:

| Item | Static volume | Dynamically provisioned volume |
|------|---------------|--------------------------------|
| Export path | Uses the filesystem name selected when the volume is created | Uses a generated name stored in the PV |
| External-host configuration | Can be prepared before the Kubernetes objects are created | Must be updated with the generated path after provisioning |
| Lifecycle | Created and controlled separately from dynamic provisioning | Normally controlled by the PVC and StorageClass reclaim policy |

### 2. Create the static volume on the array

Create the filesystem, NFS share, and access-client rule in this order. The following block shows the request bodies for the storage REST API; it is not a runnable script. Each request goes to `https://<dorado-management-ip>/deviceManager/rest/<device-id>/...` and requires an authenticated session: create a session first (`POST /deviceManager/rest/xxxxx/sessions`) to obtain `<device-id>` and an `iBaseToken`, then send that token in the `iBaseToken` header of each subsequent request. The same objects can also be created in the DeviceManager UI.

```text
# 1. Filesystem. CAPACITY is in 512-byte sectors, so 4194304 = 2 GiB.
#    PARENTID is the numeric storage pool ID, not the pool name.
# POST /deviceManager/rest/<device-id>/filesystem
{
  "NAME": "<volume-name>",
  "PARENTID": "<storage-pool-id>",
  "CAPACITY": 4194304,
  "ALLOCTYPE": 1,
  "SECTORSIZE": 16384
}

# 2. NFS share. Use the FS ID from the response to request 1 as <fs-id>.
# POST /deviceManager/rest/<device-id>/NFSHARE
{ "SHAREPATH": "/<volume-name>/", "FSID": "<fs-id>", "vstoreId": "0" }

# 3. Access client. Use the share ID from the response to request 2 as <share-id>.
#    These values match what the CSI driver sets on dynamically
#    provisioned volumes, so behaviour stays consistent.
# POST /deviceManager/rest/<device-id>/NFS_SHARE_AUTH_CLIENT
{
  "NAME": "*", "PARENTID": "<share-id>",
  "ACCESSVAL": 1, "SYNC": 0, "ALLSQUASH": 1,
  "ROOTSQUASH": 1, "SECURE": 1, "vstoreId": "0"
}
```

The `CAPACITY` value is measured in 512-byte sectors. `PARENTID` must be the numeric ID of the storage pool, not its name. `<fs-id>` comes from the filesystem-creation response, and `<share-id>` from the NFS-share response. After creation, the export is available at `<nfs-portal-ip>:/<volume-name>`.

The static volume can be connected to Kubernetes by creating the PV yourself or by asking the CSI driver to manage the existing volume. Select one of the following methods.

### 3. Connect the static volume by creating a PV and PVC

Create a PV and pre-bind a PVC to it:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-static-nfs
spec:
  # Empty string: this PV takes no part in dynamic provisioning
  storageClassName: ""
  volumeMode: Filesystem
  accessModes: ["ReadWriteMany"]
  capacity:
    storage: 2Gi
  # An administrator-provisioned volume must never be deleted by Kubernetes
  persistentVolumeReclaimPolicy: Retain
  # Not inherited from a StorageClass, so set it here or the NFS version is negotiated
  mountOptions:
    - nfsvers=4.1
  csi:
    driver: csi.huawei.com
    volumeHandle: <backend-name>.<volume-name>   # format: <backend-name>.<filesystem-name>
    volumeAttributes:
      backend: <backend-name>
      name: <volume-name>
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: static-a
  namespace: <namespace>
spec:
  # Must also be an empty string, otherwise the default StorageClass is
  # substituted and the claim will not bind
  storageClassName: ""
  accessModes: ["ReadWriteMany"]
  resources:
    requests:
      storage: 2Gi
  volumeName: pv-static-nfs
```

Set `storageClassName: ""` on both the PV and PVC. If the field is omitted from the PVC, Kubernetes can substitute the default StorageClass and the PVC will not bind to this PV.

A static PV does not inherit `mountOptions` from a StorageClass. When `mountOptions` is omitted in this environment, NFS negotiation selects version 4.2. Setting `nfsvers=4.1` makes the mount use version 4.1.

### 4. Connect the static volume by using CSI volume management

Instead of creating the PV, add the volume-management annotations and required label to a PVC. The CSI driver imports the existing volume and generates the PV:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: static-b
  namespace: <namespace>
  annotations:
    csi.huawei.com/manageVolumeName: <volume-name>   # volume name on the array
    csi.huawei.com/manageBackendName: <backend-name>
  labels:
    provisioner: csi.huawei.com                        # required
spec:
  accessModes: ["ReadWriteMany"]
  storageClassName: <storage-class>                    # a real StorageClass, not ""
  resources:
    requests:
      storage: 2Gi                                     # must match the array-side size
```

The PVC must contain both `csi.huawei.com/manageVolumeName` and `csi.huawei.com/manageBackendName`, and the `provisioner: csi.huawei.com` label. In this method, `storageClassName` refers to an existing StorageClass rather than an empty string.

The generated PV is named `pvc-<uid>`. Its `volumeHandle` points to `<backend-name>.<volume-name>`, and the export path continues to use the filesystem name selected on the array.

> **Important**: The generated PV inherits `reclaimPolicy` from the StorageClass. If the StorageClass uses `Delete`, deleting the PVC also deletes the manually created filesystem. Immediately after the PVC becomes `Bound`, change the generated PV to `Retain`:
>
> ```bash
> kubectl patch pv <generated-pv-name> \
>   -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
> ```

### 5. Mount and verify the static volume

The external host can mount the path selected when the filesystem was created:

```bash
mkdir -p /mnt/appdata
mount -t nfs -o vers=4.1 <nfs-portal-ip>:/<volume-name> /mnt/appdata
```

The two static-volume methods have the following behavior:

| Item | Create the PV and PVC | Use CSI volume management |
|------|-----------------------|---------------------------|
| Kubernetes objects to create | PV and PVC | PVC only |
| `storageClassName` | Must be `""` on both objects | Existing StorageClass |
| PV name | Selected by the administrator | Generated as `pvc-<uid>` |
| Reclaim policy | Set directly on the PV; use `Retain` | Inherited from the StorageClass; change `Delete` to `Retain` immediately |
| `mountOptions` | Set directly on the PV | Inherited from the StorageClass |
| Validated PVC status | `Bound` | `Bound` |
| Validated NFS version | 4.2 without `mountOptions`; 4.1 when specified | 4.1 inherited from the StorageClass |
| External access | Fixed export path and bidirectional read/write | Fixed export path and bidirectional read/write |

Creating the PV and PVC directly makes the reclaim policy and mount options explicit. CSI volume management requires fewer Kubernetes objects but requires an immediate reclaim-policy check.

### 6. Mount a dynamically provisioned volume

A volume created from a normal PVC can also be mounted outside the cluster. Its export path is generated and must be read from `.spec.csi.volumeAttributes.name`. The export path is not the PV name. The CSI driver changes the hyphens in the generated value to underscores.

1. Read the export path from the PV:

   ```bash
   kubectl get pv <pv-name> -o jsonpath='{.spec.csi.volumeAttributes.name}'
   ```

   ```text
   pvc_0464141b_4e64_47b1_bc9b_a9f41c686bf6
   ```

2. Optionally confirm that the export is visible from the external host. This check relies on rpcbind and mountd; if only NFSv4 port 2049 is open, skip it and mount directly.

   ```bash
   showmount -e <nfs-portal-ip>
   ```

   ```text
   /pvc_0464141b_4e64_47b1_bc9b_a9f41c686bf6 *
   ```

3. Mount the export:

   ```bash
   mkdir -p /mnt/appdata
   mount -t nfs -o vers=4.1 \
     <nfs-portal-ip>:/pvc_0464141b_4e64_47b1_bc9b_a9f41c686bf6 /mnt/appdata
   ```

Files written by a Pod are immediately visible on the external host, and files written on the external host are visible in the Pod.

The generated path changes if the volume is reprovisioned. Update the external-host configuration whenever this occurs. The volume also remains subject to the StorageClass reclaim policy. If an external host depends on it, set the PV to `Retain` before the PVC can be deleted:

```bash
kubectl patch pv <pv-name> \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

### 7. Configure permissions and exclude the snapshot directory

The root directory of a new volume is `root:root` with mode `755`. Root is not squashed on these exports. As a result, root on an allowed external host can write to the volume, but a non-root user receives `Permission denied` unless its UID and GID have suitable permissions.

To permit non-root access, align the UID/GID used by the Pod and external host, or set `fsPermission` in the StorageClass. The following value grants read, write, and execute permissions to all users and should be limited to environments where that access is acceptable:

```yaml
parameters:
  fsPermission: "777"
```

The array also creates a read-only `.snapshot` directory at the volume root. It cannot be deleted. Any backup or synchronization process that traverses the root must exclude it. When using `rsync --delete`, specify `--exclude='/.snapshot'`. The leading slash limits the exclusion to the volume-root directory and does not exclude identically named directories elsewhere in the data tree.

### 8. Restrict NFS client access

`authClient: "*"` allows every host that can reach the NFS portal to mount the share. Restrict this value to the network that requires access:

```yaml
parameters:
  authClient: "<client-cidr>"
```

For a static volume, set the same restriction in the `NAME` field of the `NFS_SHARE_AUTH_CLIENT` rule instead of using `*`.

Treat access to the NFS portal as data access because root is not squashed. On an array shared by multiple teams, confirm the correct storage pool and logical ports with the storage administrator. Use `reclaimPolicy: Retain` for every volume that has external consumers.

## FAQ

### Why does the PV name fail as an NFS export path?

For a dynamically provisioned volume, the export path is stored in `.spec.csi.volumeAttributes.name`. It is not the PV name, and the generated path uses underscores where the corresponding generated identifier uses hyphens. Read the value from the PV before configuring the external host.

### Why does an external non-root user receive `Permission denied`?

The volume root is created as `root:root` with mode `755`. Root is not squashed, but other users do not have write permission by default. Align UID/GID values or configure an appropriate `fsPermission` value.

### Why does `rsync --delete` fail on `.snapshot`?

`.snapshot` is a read-only array-managed directory at the volume root and cannot be removed. Use `--exclude='/.snapshot'` so that `rsync --delete` does not attempt to delete it.
