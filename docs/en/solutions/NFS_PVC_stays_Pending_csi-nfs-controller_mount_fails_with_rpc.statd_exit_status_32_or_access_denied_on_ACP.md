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

# NFS PVC stays Pending: csi-nfs-controller mount fails with rpc.statd, exit status 32, or access denied on ACP

## Issue

A PVC on an NFS StorageClass (provisioner `nfs.csi.k8s.io`) stays `Pending`, or the console keeps showing it as `处理中` (Processing), and no PV is created. `kubectl describe pvc` shows:

```text
ExternalProvisioning  Waiting for a volume to be created either by the external provisioner 'nfs.csi.k8s.io' or manually by the system administrator
Provisioning          External provisioner is provisioning volume for claim "<namespace>/<pvc-name>"
ProvisioningFailed    failed to provision volume with StorageClass "<storageclass>": rpc error: code = Internal desc = failed to mount nfs server: ...
```

The NFS plugin Pods are Running (`csi-nfs-controller` 4/4, `csi-nfs-node` 3/3), and often `showmount -e` lists the export and a manual NFS mount on a node works. The `nfs` container log of `csi-nfs-controller` shows the mount failing with one of:

- `rpc.statd is not running but is required for remote locking`, `cannot create /run/rpc.statd.lock`, `Mount failed: exit status 32`
- `mount.nfs: access denied by server while mounting <nfs-server>:<path>`

Sometimes the PVC is created only after the NFS version in the StorageClass is changed, or after `nolock` is added to its `mountOptions`.

At `CreateVolume`, `csi-nfs-controller` mounts the export itself, on the node where it runs, with the StorageClass `server`, `share`, and `mountOptions`, and then creates a per-volume directory. A mount that works by hand from another node, or with other options, does not prove that this mount works.

Related articles: *NFS PVC stays Pending: csi-nfs-controller mount times out or mkdir of the volume directory is denied on ACP* (the mount times out, or succeeds and `mkdir` fails). For the StorageClass fields see [Dynamic NFS storage provisioning for Tekton CICD on ACP](Dynamic_NFS_storage_provisioning_for_Tekton_CICD_on_ACP.md).

## Root Cause

`access denied by server while mounting` has four causes here (Causes 1, 2, 3, and 4); the table in Diagnostic Steps separates them.

### Cause 1: the NFSv3 mount needs rpc.statd, and it is not running on the node

An NFSv3 mount without `nolock` needs `rpc.statd` for remote locking. The CSI container cannot start it itself, because its `/run` is read-only:

```text
/usr/sbin/start-statd: 10: cannot create /run/rpc.statd.lock: Read-only file system
mount.nfs: rpc.statd is not running but is required for remote locking.
mount.nfs: Either use '-o nolock' to keep locks local, or start statd.
Mount failed: exit status 32
GRPC error: rpc error: code = Internal desc = failed to mount nfs server: rpc error: code = Internal desc = mount failed: exit status 32
```

The node that hosts `csi-nfs-controller` has `rpc-statd` stopped, so the mount fails. The same root problem has three other forms:

- An NFSv3 StorageClass whose `mountOptions` omit `nolock`: the manual mount with `nolock` works, the PVC never gets a PV, and adding `nolock` to the class restores provisioning.
- A NAS that must stay on NFSv3 (for example a Huawei NAS through the default NFS CSI plugin): NFS 4.0 and 4.1 work through the plugin and NFS 3.0 fails, while a manual v3 mount on the node succeeds. Installing the NFS client utilities and running `rpcbind` and `rpc-statd` on the nodes fixes it.
- The provisioner reports `failed to get nfs info from nfs host` and `access denied by server while mounting`, the server is reachable, a manual `mount -t nfs -o hard,nfsvers=3,nolock` succeeds, and `rpc-statd.service` is inactive. Restarting and enabling `rpc-statd.service`, then connecting the StorageClass again, restores PVC creation.

### Cause 2: the StorageClass NFS version is one the server does not serve

The `nfsvers` in the StorageClass `mountOptions` is used by `csi-nfs-controller` for its own mount. If the server does not serve that version, every `CreateVolume` fails, and changing the version on the StorageClass makes the next PVC succeed. Examples:

- The server does not support NFSv4 at all and the class uses v4.
- The server runs v4.1 and the storage was integrated as v3 (`nfsvers=3`, `nolock`). The controller reports `access denied by server while mounting`, and a manual v3 mount shows:

  ```text
  mount -t nfs -o hard,nfsvers=3,nolock <nfs-server>:<export-path> /test -v
  mount.nfs: portmap query retrying: RPC: Program not registered
  mount.nfs: mount(2): Permission denied
  mount.nfs: access denied by server while mounting <nfs-server>:<export-path>
  ```

  The same mount without the v3 option succeeds, and `showmount -e` still lists the export. Integrating the NFS storage again with version v4.1 selected makes provisioning and mounting work.

The platform supports NFS protocol versions `v3`, `v4.0`, and `v4.1`.

### Cause 3: the StorageClass share path has no leading /

The `share` parameter of the StorageClass is written as a relative name (for example `sfs-example-0001`) instead of the export path (`/sfs-example-0001`). `csi-nfs-controller` mounts exactly that string, so the server refuses an export it does not have:

```text
failed to provision volume with StorageClass "<storageclass>": rpc error: code = Internal desc = failed to mount nfs server: rpc error: code = Internal desc = mount failed: exit status 32
Mounting arguments: -t nfs -o hard,nfsvers=3,nolock <nfs-server>:sfs-example-0001 /tmp/pvc-<uid>
Output: mount.nfs: access denied by server while mounting <nfs-server>:sfs-example-0001
```

`rpc-statd` can be active on every node, and a manual mount of `<nfs-server>:/sfs-example-0001` (with the slash) succeeds on the controller node. On some NAS devices no error text is shown at all; the PVC simply stays Pending until `share` is corrected.

### Cause 4: the NAS authorizes only some nodes, not the node running csi-nfs-controller

Mount permission on the NAS was granted to the worker nodes, not to the control-plane nodes (or to some other subset). Dynamic provisioning is done by `csi-nfs-controller`, which mounts the export from whichever node it runs on. By default it is not pinned to a fixed node (its `nodeSelector` is `kubernetes.io/os: linux`), so it can land on a node that has no mount permission on the NAS, and PVC creation fails with a permission error right after the StorageClass is created.

## Resolution

### Cause 1: the NFSv3 mount needs rpc.statd, and it is not running on the node

Use one of two repairs: run `rpc-statd` on the nodes, or add `nolock` to the StorageClass. Use the service when the NAS has to stay on NFSv3 with locking; use `nolock` when the error suggests it or the service cannot be enabled.

**Run rpc-statd on the nodes.** Run this on every node that can run `csi-nfs-controller` or a Pod that uses the volume. If `rpc.statd` is not installed, install the node OS package that provides `rpcbind` and `rpc-statd` (the NFS client utilities) first.

> **Warning:** `rpcbind` and `rpc-statd` listen on the node and take part in NFSv3 locking; restarting `rpc-statd` briefly interrupts NFSv3 lock recovery on that node. Do this only when a Cause 1 signature is confirmed and the unit is inactive. Roll back with `sudo systemctl disable --now rpc-statd rpcbind`.

```bash
systemctl status rpc-statd rpcbind
sudo systemctl enable --now rpcbind
sudo systemctl enable --now rpc-statd
rpcinfo -p 127.0.0.1
```

`rpcinfo` should list program `100000` (portmapper) and program `100024` (status). In the `failed to get nfs info from nfs host` form, also connect the StorageClass to the NFS storage again after the service is running.

**Or add nolock to the StorageClass.** Kubernetes stores mount options without the `-o` flag.

```bash
kubectl edit storageclass <storageclass>
```

```yaml
mountOptions:
  - hard
  - nfsvers=3
  - nolock
```

`mountOptions` on an existing class can be changed; `parameters` cannot. Existing PVs keep the options they were provisioned with.

**Then recreate the Pending claim.**

> **Warning:** Deleting a PVC whose PV uses reclaim policy `Delete` makes the provisioner remove the backend directory. Do this only when the claim is still Pending, `spec.volumeName` is empty, and no application data was written. A directory the provisioner has already removed cannot be restored; if `spec.volumeName` is set, stop and check the reclaim policy first.

```bash
kubectl -n <namespace> get pvc <pvc-name> -o jsonpath='{.spec.volumeName}{"\n"}'
kubectl -n <namespace> get pvc <pvc-name> -o yaml > "$HOME/<pvc-name>.yaml"
kubectl -n <namespace> delete pvc <pvc-name>
```

Create it again from your manifest (remove `metadata.uid`, `metadata.resourceVersion`, and `status` if you reuse the saved copy).

### Cause 2: the StorageClass NFS version is one the server does not serve

1. From the node that runs `csi-nfs-controller`, try the class's version and another version:

   ```bash
   kubectl get storageclass <storageclass> -o jsonpath='{.mountOptions}{"\n"}'
   sudo mount -t nfs -o nfsvers=4.1 <nfs-server>:<export-path> /mnt && sudo umount /mnt
   sudo mount -t nfs -o nfsvers=3,nolock <nfs-server>:<export-path> /mnt && sudo umount /mnt
   rpcinfo -p <nfs-server>
   ```

   `portmap query retrying: RPC: Program not registered` on the v3 mount means the server does not offer NFSv3 to this client. A server that serves only NFSv4 may not answer `rpcinfo` at all. On the NFS server, `nfsstat -s` shows which versions it serves.

2. Set the version that mounted in the StorageClass `mountOptions` (for a server without NFSv4, `nfsvers=3` plus `nolock` as in Cause 1), or integrate the NFS storage again with that version selected in the **NFS Protocol Version** field of the StorageClass form. Then create the PVC again.

   ```bash
   kubectl edit storageclass <storageclass>
   ```

### Cause 3: the StorageClass share path has no leading /

1. Read the class and the controller's mount arguments:

   ```bash
   kubectl get storageclass <storageclass> -o jsonpath='{.parameters.server}{" "}{.parameters.share}{"\n"}'
   kubectl -n cpaas-system logs deploy/csi-nfs-controller -c nfs --tail=500 | grep -E 'Mounting arguments|access denied'
   showmount -e <nfs-server>
   ```

   A `share` without a leading `/`, or mount arguments with no `/` after the colon, matches this cause. `showmount -e` lists the export paths exactly as the server publishes them (NFSv3 servers; an NFSv4-only server may not answer).

2. StorageClass `parameters` cannot be updated in place, so recreate the class under the same name with the corrected `share`.

   > **Warning:** While the class is deleted, new PVCs that name it cannot be provisioned. Deleting a StorageClass does not remove existing PVs or PVCs. Do this only when the Cause 3 signature is confirmed. Back up the class first; roll back with `kubectl apply -f /tmp/<storageclass>.yaml`.

   ```bash
   kubectl get storageclass <storageclass> -o yaml > /tmp/<storageclass>.yaml
   cp /tmp/<storageclass>.yaml /tmp/<storageclass>-fixed.yaml
   vi /tmp/<storageclass>-fixed.yaml
   kubectl delete storageclass <storageclass>
   kubectl apply -f /tmp/<storageclass>-fixed.yaml
   ```

   In the copy, set `share: /<export-path>` and remove `metadata.uid`, `metadata.resourceVersion`, `metadata.creationTimestamp`, and `metadata.managedFields`.

3. If a claim still has no PV after a few minutes, recreate it as in Cause 1 (only while it holds no data).

### Cause 4: the NAS authorizes only some nodes, not the node running csi-nfs-controller

1. Find the node that runs the controller and compare it with the NAS client allowlist:

   ```bash
   kubectl get pods -A -o wide | grep csi-nfs-controller
   ```

2. Grant NAS mount permission (the client allowlist or export rule) to every node in the cluster. This is the recommended fix, because `csi-nfs-controller` can be rescheduled to any node, and Pods mount NFS through `csi-nfs-node` on whichever node they run.

3. If new nodes should not need NAS permission, pin `csi-nfs-controller` to a labeled set of nodes that the NAS authorizes. Restarting or recreating the `csi-nfs-controller` Pod does not affect existing PVCs or PVs.

   > **Warning:** Saving the Deployment restarts `csi-nfs-controller`; provisioning pauses until it is Ready, and stays stopped if no labeled node is schedulable. A plugin reinstall or upgrade can drop the edit. Do this only when the Cause 4 signature is confirmed and every labeled node can mount the export. Back up the Deployment first; roll back with `kubectl -n cpaas-system apply -f /tmp/csi-nfs-controller.yaml`, or set the `nodeSelector` back to `kubernetes.io/os: linux`.

   ```bash
   kubectl label node <nas-authorized-node> storage.example/nas-access=allowed
   kubectl -n cpaas-system get deploy csi-nfs-controller -o yaml > /tmp/csi-nfs-controller.yaml
   kubectl -n cpaas-system edit deploy csi-nfs-controller
   ```

   ```yaml
   spec:
     template:
       spec:
         nodeSelector:
           storage.example/nas-access: allowed
   ```

   `storage.example/nas-access` is a placeholder label key; every node that runs NFS workloads still needs NAS permission.

## Diagnostic Steps

1. Read the claim's events, the class, and the controller log:

   ```bash
   kubectl -n <namespace> describe pvc <pvc-name>
   kubectl get storageclass <storageclass> -o yaml
   kubectl -n cpaas-system get pods -o wide | grep csi-nfs
   kubectl -n cpaas-system logs deploy/csi-nfs-controller -c nfs --tail=200
   ```

2. On the node that runs `csi-nfs-controller`, repeat the controller's mount by hand with the class's `server`, `share`, and options:

   ```bash
   systemctl status rpc-statd rpcbind
   sudo mount -t nfs -v -o hard,nfsvers=3,nolock <nfs-server>:<export-path> /mnt && sudo umount /mnt
   ```

3. Match the signature:

   | Controller log or manual test | Cause |
   | --- | --- |
   | `rpc.statd is not running`, `cannot create /run/rpc.statd.lock`, `exit status 32` | 1 |
   | `access denied by server`; a manual mount with `nolock` works; `rpc-statd` inactive | 1 |
   | `portmap query retrying: RPC: Program not registered` with `nfsvers=3`; a mount without `nfsvers=3` works | 2 |
   | Mounting arguments `<nfs-server>:<path>` with no `/` after the colon | 3 |
   | Manual mount denied from the controller node, allowed from a node the NAS authorizes | 4 |
   | `timeout after 110s`, or `failed to make subdirectory ... permission denied` | *NFS PVC stays Pending: csi-nfs-controller mount times out or mkdir of the volume directory is denied on ACP* |

A host mount that works does not by itself clear a Pending claim: the controller uses host networking and its own node, StorageClass options, and `share` string, so a failure that appears only in the controller log still blocks provisioning.
