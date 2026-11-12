---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Removing a TopoLVM storage node or releasing its disks on ACP

## Issue

One or more nodes have to leave TopoLVM on Alauda Container Platform, for example before the node is reclaimed or its operating system is reinstalled, or its raw disks must be freed for another consumer such as Ceph. Unused PVCs or mounted workloads may still be on that node.

Or the release was already attempted: a prepare job still errors, `lsblk` still shows content on the local disks, `TopolvmCluster` status still lists nodes other than the one that should remain, and `dd` was then run on the node that was supposed to keep TopoLVM.

A related question is what deletes the data inside a TopoLVM PVC. TopoLVM volumes are node-local LVM logical volumes. Data is lost when the PVC, PV, or `LogicalVolume` is deleted with the volume behind it, when a node is removed from `TopolvmCluster` or its disks are released with the sequence below, or when the data disk of a node that should keep its data is wiped (`dd`, a reinstall that touches data disks, or an uninstall and reinstall of TopoLVM). Removing a node never copies its logical volumes anywhere. Decide first whether the data on the node is gone, backed up, or copied by the application.

## Root Cause

### Cause 1: a TopoLVM storage node has to be removed, or its disks released, while PVCs are still on it

The supported procedure is "Scenario 3: Remove a TopoLVM Storage Node" in the product documentation topic "Remove Disks, Device-Class Volume Groups, or Nodes from LVM Storage". It applies when the node cannot be recovered or will be permanently removed from `TopolvmCluster`, and no device-class volume group on the node is to be kept. Residual PVCs pinned to the node, including unused ones, block handing its disks to another consumer until they are cleaned up.

### Cause 2: the prepare job still errors after a node release, and dd was run on the node that should keep its data

On the node that was meant to keep TopoLVM:

- its `status.nodeStorageState` entry is `phase: Unknown`, while a released node can still show `phase: Ready`;
- its `topolvm-node-<node>` pod is `3/4 CrashLoopBackOff` with many restarts, while `topolvm-controller` and `topolvm-operator` are Running;
- its `topolvm-prepare-vg` log, after the usual device skips (`unsupported diskType lvm`, `contains a filesystem "LVM2_member"`, `has child, considering the child instead`), ends with an error raised from `checkVgIfShrink`:

```text
prepare-vg: list pv for vg <class>-<uuid> failed err:exit status 5
parse out failed cmd:vgs pv_name <class>-<uuid>
```

`pvs` on that node lists only the operating-system volume group; no physical volume exists for the `<class>-<uuid>` group that the ConfigMap and the status name. `dd` against the disk that held that volume group destroyed it. Restarting the operator does not change this.

## Resolution

### Cause 1: a TopoLVM storage node has to be removed, or its disks released, while PVCs are still on it

Prerequisites:

- Workloads that use PVCs on the target node are stopped or migrated, and the remaining nodes can carry them.
- The data on the node is backed up or confirmed not needed.

1. Save the cluster object and stop the operator so it does not write the old node back:

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml > /tmp/topolvmcluster.before.yaml
kubectl -n nativestor-system scale deployment topolvm-operator --replicas=0
```

2. List every TopoLVM PV pinned to the node. Do not skip a line because the PVC looks unused:

```bash
kubectl get pv -o json | jq -r --arg NODE "<node>" '
  .items[]
  | select(.spec.csi.driver=="topolvm.cybozu.com")
  | select(.spec.nodeAffinity.required.nodeSelectorTerms[]?.matchExpressions[]?
      | select(.key=="topology.topolvm.cybozu.com/node") | .values[]? == $NODE)
  | [.metadata.name, .status.phase, .spec.claimRef.namespace, .spec.claimRef.name]
  | @tsv'
```

An empty list means no TopoLVM volume is pinned to that node.

> **Warning:** The deletes below remove every TopoLVM PVC, PV, and LogicalVolume pinned to the node, and the data on those volumes is destroyed. Precondition: the workloads are stopped, a backup exists if the data matters, and the node name in the query is the node you mean to retire. Rollback: none after the LogicalVolume is deleted.

3. For each line, delete the objects. The LogicalVolume name equals the PV name:

```bash
kubectl delete pvc -n <pvc-namespace> <pvc-name>
kubectl delete pv <pv-name>
kubectl delete logicalvolumes.topolvm.cybozu.com <pv-name>
```

4. Run `kubectl -n nativestor-system edit topolvmclusters.topolvm.cybozu.com topolvm` and delete the whole `nodeName: <node>` element under `spec.storage.deviceClasses`.
5. Run `kubectl -n nativestor-system edit configmaps lvmdconfig-<node>` and delete the entire `lvmd.yaml` and `status.json` sections.
6. Start the operator again and confirm the node is gone from `status.nodeStorageState`:

```bash
kubectl -n nativestor-system scale deployment topolvm-operator --replicas=1
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
```

If only the spec was edited and a `topolvm-prepare-vg` Job for the node stays `Pending`, the node is still in status; clean the status as well instead of repeatedly deleting Jobs.

When nodes are being replaced and the StorageClass reclaim policy is `Retain`, release each PV before removing the node: delete the application that no longer uses the volumes, delete the matching `logicalvolume` and then the PV, and confirm with `lvs` that the LV is gone (see [TopoLVM capacity stays full after PVCs are deleted on ACP](./TopoLVM_capacity_stays_full_after_PVCs_are_deleted_on_ACP.md), Cause 2). A full replacement of workers in the global cluster, for example for an unused registry instance, ran in this order: delete the registry's template repositories and the registry instance; release the Retain PVs; check on each node that the local storage space is released; clean up the TopoLVM resources; uninstall the log collection and log storage plugins; cordon the nodes, force-evict their pods, and check that nothing is scheduled back; delete the nodes; redeploy TopoLVM and the registry on the new nodes.

> **Warning:** Draining evicts every pod on the node, including pods with local data (`--delete-emptydir-data`). Precondition: the TopoLVM volumes on the node are released and the plugins that keep data there are uninstalled. Rollback: `kubectl uncordon <node>` allows scheduling again; evicted pods are recreated elsewhere by their owners.

```bash
kubectl cordon <node>
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --force
kubectl get pods -A -o wide --field-selector spec.nodeName=<node>
```

### Cause 2: the prepare job still errors after a node release, and dd was run on the node that should keep its data

1. Confirm that the volume group is really gone:

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
pvs
vgs <class>-<uuid>
```

`vgs` failing for the name in status, no physical volume for it in `pvs`, and the `list pv for vg ... exit status 5` log confirm this cause. If `pvs` shows the device in a TopoLVM volume group with a different name, that is a name mismatch, not damage; see [TopoLVM lvmd exits with should have at least one device-class or Error: not found on ACP](./TopoLVM_lvmd_exits_with_should_have_at_least_one_device-class_or_Error_not_found_on_ACP.md).

2. There is no in-place undo for `dd` on the disk that held the volume group you meant to keep. Treat the bytes on that disk as lost. The way forward is to uninstall and reinstall TopoLVM on the cluster.

> **Warning:** Uninstalling TopoLVM after `dd` on the disk you meant to keep discards that node's local volumes. Precondition: this cause is confirmed, a backup exists or the data is expendable, and you are in a maintenance window. Rollback: none.

To avoid this: when status still lists nodes that were removed, clean the stale status first. Never wipe the disk of a node that is meant to keep its data.

## Diagnostic Steps

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml
kubectl get cm,deploy -n nativestor-system
kubectl get job,pod -n nativestor-system -o wide | grep prepare-vg
pvs
vgs
```

- A request to remove a live node, or to free its disks for another consumer: Cause 1.
- `prepare-vg: list pv for vg <class>-<uuid> failed err:exit status 5`, no physical volume for that group in `pvs`, and `dd` already run on the node you meant to keep: Cause 2.

## Related Information

- [TopoLVM node pod does not start after a reboot because its data disk was formatted on ACP](./TopoLVM_node_pod_does_not_start_after_a_reboot_because_its_data_disk_was_formatted_on_ACP.md): uses the removal sequence above and then adds the node back.
- [Preserving TopoLVM Data of KubeVirt VMs When Reinstalling Node Operating Systems on ACP](./Preserving_TopoLVM_Data_of_KubeVirt_VMs_When_Reinstalling_Node_Operating_Systems_on_ACP.md)
