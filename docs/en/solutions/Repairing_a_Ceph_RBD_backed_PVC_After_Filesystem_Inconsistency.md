---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Repairing a Ceph RBD-backed PVC After Filesystem Inconsistency
## Issue

A pod fails to mount its PersistentVolumeClaim and the kubelet reports a filesystem-inconsistency error from the underlying Ceph RBD volume. The pod stays in `ContainerCreating` indefinitely; events on the pod or in the kubelet journal contain a line of the form:

```text
MountVolume.MountDevice failed for volume "pvc-..." /dev/rbd0: UNEXPECTED INCONSISTENCY;
RUN fsck MANUALLY (i.e., without -a or -p options).
```

The CSI plugin retries the mount on a back-off interval (typical message: `No retries permitted until ... durationBeforeRetry 2m...`). The application Deployment, StatefulSet, or dependent pods stay unscheduled or in `Pending` state until the volume is repaired.

## Root Cause

Ceph RBD volumes consumed via the Ceph CSI driver carry an ext4 (or xfs) filesystem that the kubelet mounts inside the workload's mount namespace. If the volume was mid-write during a node hard-reset, an OSD outage, a network partition, or an NTP-driven time jump on a storage node, the on-disk filesystem journal can be left inconsistent. The kernel mounts safely up to a point — `fsck -a` is run automatically on first mount — but if the corruption requires interactive repair the kubelet refuses to mount and surfaces the `UNEXPECTED INCONSISTENCY` message.

The CSI driver does not run `fsck` interactively because that operation can rewrite metadata. It is treated as an explicit operator action.

## Resolution

The repair flow is: scale the workload down, run `fsck` against the RBD device from inside the CSI node plugin pod, scale the workload back up. Capture the dry-run and full-repair output for the change record; corruption that needs interactive `fsck` is itself a signal worth investigating.

> **Pre-flight**: collect the kubelet journal from the affected node starting from the last time the PV was attached cleanly (`journalctl -k --since="..."`). The collected log is the only direct evidence of what was in flight when the inconsistency was introduced.

### 1. Locate the CSI plugin pod for the affected node

The Ceph CSI node plugin runs as a DaemonSet in the storage namespace (typical names: `cephfs-rbd-plugin`, `csi-rbdplugin`, or `<storagecluster>.rbd.csi.ceph.com-nodeplugin`). Identify the pod scheduled on the same node as the failed workload:

```bash
node=$(kubectl get pod <failed-pod> -n <workload-ns> -o jsonpath='{.spec.nodeName}')
kubectl get pods -n <storage-ns> -l app=csi-rbdplugin -o wide --field-selector spec.nodeName="$node"
```

### 2. Read the Ceph monitor endpoint and admin keyring from the toolbox pod

The repair commands need a working Ceph client config. The Ceph storage system ships a `rook-ceph-tools` (or equivalent) Deployment that already has both:

```bash
TOOLS_POD=$(kubectl get pods -n <storage-ns> -l app=rook-ceph-tools -o name | head -1)
kubectl exec -n <storage-ns> "$TOOLS_POD" -- grep mon_host /etc/ceph/ceph.conf
kubectl exec -n <storage-ns> "$TOOLS_POD" -- cat /etc/ceph/keyring
```

Note the `mon_host` value (host:port pairs) and the `[client.admin] key = ...` line.

### 3. Identify the underlying RBD image of the PVC

Each PV in a Ceph CSI StorageClass references a `volumeAttributes.imageName` that is the RBD object name in the pool:

```bash
PVC_NAME=<failed-pvc>
PV_NAME=$(kubectl get pvc "$PVC_NAME" -n <workload-ns> -o jsonpath='{.spec.volumeName}')
kubectl get pv "$PV_NAME" -o yaml | grep -E "imageName|pool"
```

Capture both `imageName` and `pool` (e.g., `cephblockpool`) for the next step.

### 4. Scale the workload down

```bash
kubectl scale -n <workload-ns> deployment/<deploy-name> --replicas=0
# or for a StatefulSet:
kubectl scale -n <workload-ns> statefulset/<sts-name> --replicas=0
```

Wait until the pod actually terminates so the kubelet releases the volume:

```bash
kubectl wait -n <workload-ns> --for=delete pod -l app=<app-label> --timeout=120s
```

If the pod is stuck `Terminating` because the volume is wedged, force-delete with `--grace-period=0 --force`. The volume must be unmapped from the node before any `rbd` operation on the same image will succeed.

### 5. Exec into the CSI plugin pod and run fsck

The CSI node plugin container ships `rbd`, `e2fsck`, `xfs_repair`, and the kernel `rbd` module bindings:

```bash
kubectl exec -it -n <storage-ns> <csi-plugin-pod> -c csi-rbdplugin -- bash
```

Inside the pod, write the keyring to a temp path and verify the cluster is reachable:

```bash
echo -e "[client.admin]\nkey = <key-from-step-2>" > /tmp/keyring
export CEPH_ARGS="-m <mon_host-from-step-2> --keyring=/tmp/keyring"
rados lspools
```

If `rados lspools` lists the pools, the client config is good.

Confirm that no other node has the volume mapped (this is the most common reason `fsck` fails halfway through):

```bash
rbd -p <pool> status <imageName>
```

The `Watchers` line should be empty. If a watcher is reported, it points to a node where the kernel still holds the device — unmount it on that node first.

Map the device read-write:

```bash
rbd map <pool>/<imageName>
# Output: /dev/rbd0 (or rbd1, ...)
```

Run a dry-run check first; capture the output for the change record:

```bash
e2fsck -n /dev/rbd0
```

Then run the actual repair:

```bash
e2fsck -fyv /dev/rbd0
```

Flags:
- `-f` forces a check even if the superblock is marked clean.
- `-y` answers yes to every repair prompt (mandatory for unattended repair).
- `-v` is verbose.

For an xfs filesystem use `xfs_repair /dev/rbd0` instead.

Unmap the device and remove the keyring file before exiting:

```bash
rbd unmap <pool>/<imageName>
rm -f /tmp/keyring
exit
```

### 6. Scale the workload back up

```bash
kubectl scale -n <workload-ns> deployment/<deploy-name> --replicas=<original-count>
```

Watch the pod come back up and verify it can read its data path. If the new pod also fails to mount, the corruption may be in the journal area itself; in that case, restore from the latest backup or RBD snapshot rather than running further repairs.

## Diagnostic Steps

Confirm the message is the `UNEXPECTED INCONSISTENCY` variant rather than a different mount failure (some `MountVolume.MountDevice failed` messages are CSI-driver bugs, attach-detach race conditions, or capacity issues — `fsck` will not help with those):

```bash
kubectl describe pod <failed-pod> -n <workload-ns>
kubectl get events -n <workload-ns> --sort-by='.lastTimestamp' | grep -i "fsck\|inconsistency\|MountDevice"
```

Pull recent kubelet messages from the node:

```bash
kubectl debug node/<node-name> -- chroot /host journalctl -u kubelet --since "10 minutes ago" | grep -i "rbd\|fsck"
```

If multiple PVCs on the same node hit the same error simultaneously, the root cause is at the storage-cluster layer (an OSD flap, a degraded MON, a clock skew event), not the individual filesystems. Investigate the Ceph cluster health and Pacific/Reef mgr/health logs before running `fsck` on every affected volume — a flapping OSD can corrupt a freshly-repaired filesystem within minutes.
