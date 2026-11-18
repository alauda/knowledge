---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# NFS PVC stays Pending: csi-nfs-controller mount times out or mkdir of the volume directory is denied on ACP

## Issue

A PVC on an NFS StorageClass (provisioner `nfs.csi.k8s.io`) stays `Pending`, or the console keeps showing it as `处理中` (Processing) or creating, and no PV is created. The NFS plugin Pods are Running. The PVC events or the `nfs` container log of `csi-nfs-controller` show one of:

```text
failed to mount nfs server: rpc error: code = Internal desc = mount volume <nfs-server>:<export-path> to /tmp/pvc-<uid> timeout after 110s
```

```text
GRPC error: rpc error: code = Internal desc = failed to make subdirectory: mkdir /tmp/pvc-<uid>/pvc-<uid>: permission denied
```

A typical case is an application that creates its own claims, for example a Harbor deployment whose PostgreSQL PVCs (`pgdata-acid-postgresql-0`, `pgdata-acid-postgresql-1`) are never provisioned, or a new RWX PVC created right after an NFS StorageClass was added.

At `CreateVolume`, `csi-nfs-controller` mounts the export on the node where it runs, under `/tmp/pvc-<uid>`, creates a per-volume directory in it, and unmounts it again. These two failures sit on either side of that mount.

Related articles: *NFS PVC stays Pending: csi-nfs-controller mount fails with rpc.statd, exit status 32, or access denied on ACP* (the mount itself is refused).

## Root Cause

### Cause 1: the provisioner mounts the export but cannot create the volume directory in it

The mount succeeds, then the provisioner fails to create the per-volume directory because the NFS server has not granted the required permissions on the export directory. The driver log shows the export mounted on `/tmp/pvc-<uid>`, then:

```text
GRPC error: rpc error: code = Internal desc = failed to make subdirectory: mkdir /tmp/pvc-<uid>/pvc-<uid>: permission denied
```

and then the temporary mount being unmounted again (`unmount volume ... successfully`). The claim stays Pending. Once the server-side permissions are opened, the PVC is created. A PVC that stays in "creating" right after a new StorageClass was created can also come from an NFS server configuration that is not finished (export not defined, clients not allowed, or service not started).

### Cause 2: the cluster nodes cannot reach the NFS server

The provisioner cannot complete the mount at all. The PVC events cycle between `Provisioning` (`External provisioner is provisioning volume for claim ...`) and `ProvisioningFailed` with `mount volume <nfs-server>:<export-path> to /tmp/pvc-<uid> timeout after 110s`, and the provisioner log counts repeated failures (for example `failures=9`). Network connectivity from the cluster nodes to the NFS storage is missing, for example because of routing, a firewall, or a storage-side client allowlist. For example, on ACP 4.3.0 the PostgreSQL PVCs that a Harbor deployment creates in `cpaas-solution` stay Pending this way when the nodes cannot reach the NFS NAS. When the cluster nodes cannot reach the NFS server address at all, opening network access from the nodes to the server is the whole fix; the PVC is then created and mounted normally.

## Resolution

### Cause 1: the provisioner mounts the export but cannot create the volume directory in it

1. Search the controller log for the exact text:

   ```bash
   kubectl -n cpaas-system logs deploy/csi-nfs-controller -c nfs --tail=500 | grep -E 'failed to make subdirectory|permission denied'
   ```

2. From the node that hosts `csi-nfs-controller`, mount with the StorageClass options and try to create a directory:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep csi-nfs-controller
   sudo mount -t nfs -o hard,nfsvers=3,nolock <nfs-server>:<export-path> /mnt
   sudo mkdir /mnt/provision-test && sudo rmdir /mnt/provision-test
   sudo umount /mnt
   ```

   Use the `nfsvers` and options from the StorageClass. If the mount succeeds and `mkdir` fails, this cause is confirmed.

3. Grant the permissions on the NFS server side. The provisioner creates directories as root, so on a Linux `nfsd` an export with `root_squash` over a root-owned directory blocks it; compare the export with one that provisions correctly (`exportfs -v`). On a storage appliance, set the equivalent permission for the export on the array. If the server configuration is incomplete, finish it first (export defined, clients allowed, service started).

   > **Warning:** Widening export permissions lets the allowed clients create and change files in the export. Do this only when the mount succeeds and the `mkdir` test fails. Back up the export configuration first; roll back by restoring `/etc/exports` from the backup and running `sudo exportfs -ra` (on an appliance, revert the export setting).

   ```bash
   sudo cp -a /etc/exports /etc/exports.bak
   sudo vi /etc/exports
   sudo exportfs -ra
   sudo exportfs -v
   ```

4. Repeat the `mkdir` test, then create the PVC again. The claim should become `Bound`.

### Cause 2: the cluster nodes cannot reach the NFS server

1. From the node that hosts `csi-nfs-controller` (and from the other nodes), test the path to the server:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep csi-nfs-controller
   rpcinfo -p <nfs-server>
   timeout 5 bash -c '</dev/tcp/<nfs-server>/2049' && echo reachable
   ```

   A timeout or no route confirms this cause.

2. Fix the network path between the cluster nodes and the NFS server: routing, firewalls in between, and the storage-side client allowlist. Allow NFS (TCP 2049) and, for NFSv3, the RPC services the server registers (portmapper on 111 and the ports `rpcinfo -p` lists).

3. When the connectivity test succeeds from every node, create the claim again. If only one node cannot reach the server while others can, investigate that node's routes and source address.

## Diagnostic Steps

1. Read the claim's events and the controller log:

   ```bash
   kubectl -n <namespace> describe pvc <pvc-name>
   kubectl -n cpaas-system get pods -o wide | grep csi-nfs
   kubectl -n cpaas-system logs deploy/csi-nfs-controller -c nfs --tail=200
   ```

2. On the node that runs `csi-nfs-controller`, repeat the controller's mount by hand:

   ```bash
   sudo mount -t nfs -v -o hard,nfsvers=3,nolock <nfs-server>:<export-path> /mnt
   ```

3. Match the signature:

   | Controller log or manual test | Cause |
   | --- | --- |
   | Mount succeeds, then `failed to make subdirectory ... permission denied`; manual `mkdir` in the export fails | 1 |
   | `timeout after 110s`; manual mount or `/dev/tcp/<nfs-server>/2049` hangs from the controller node | 2 |
   | `rpc.statd`, `exit status 32`, or `access denied by server while mounting` | *NFS PVC stays Pending: csi-nfs-controller mount fails with rpc.statd, exit status 32, or access denied on ACP* |

The controller Pod uses host networking and the node's route table, so a test from a different node, or from inside an application Pod, does not prove the controller's path works.
