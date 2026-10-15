---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.1.x
id: KB261000012
---

# Preserving TopoLVM Data of KubeVirt VMs When Reinstalling Node Operating Systems on ACP

## Issue

The nodes of a workload cluster must be moved to a different operating system, for example because CentOS 7 is no longer in the supported baseline. KubeVirt virtual machines in the cluster store their disks on TopoLVM local storage. TopoLVM volumes are local to a node, so these VMs cannot be live-migrated away and must be stopped while their node is processed.

This solution processes the nodes one at a time:

- **Primary path: reinstall only the system disk and keep the data in place.** A TopoLVM volume is an LV in a volume group (VG) on the data disks, and the LVM metadata is stored on the data disks themselves. If the reinstallation does not touch the data disks and the node rejoins the cluster with its original hostname and IP address, the PVC, PV, and LogicalVolume objects in Kubernetes still point to the original LVs, and the VMs can start on their original PVCs.
- **Safety net: clone the VM disks to Ceph RBD before the reinstallation.** If a data disk is wiped by mistake, the Ceph copy can be restored.
- **Fallback: if the data disks are lost, clone the disks from Ceph back to TopoLVM.**

For each node, the downtime mainly consists of the time to clone the disks to Ceph and the time to reinstall the node and add it back. On the primary path, no data has to be cloned back.

## Environment

This solution applies to Alauda Container Platform 4.1.x with TopoLVM and KubeVirt. It was validated end to end on ACP 4.1.7 by moving nodes from CentOS 7.9 to RHEL 9.6, covering both the primary path and the fallback path.

## Prerequisites

Confirm each of the following before you start:

1. **Roles of the nodes to reinstall.** If any control plane node is included, you must also restore the Kube-OVN control plane membership (step 9), and you must process only one control plane node at a time. Worker nodes do not require that step.
2. **The target operating system and version are supported by the current ACP version.** Change the operating system of all nodes on the current ACP version first, and upgrade ACP afterwards.
3. **The installation method can reinstall the system disk only.** The installer, installation template, or the "reinstall" function of the virtualization platform must not wipe, recreate, or replace the data disks. If only a full machine rebuild is possible, the primary path is not available and you must use the fallback path.
4. **TopoLVM data disk layout.** Record which disks make up the VG on each node. Nodes whose VG spans several disks carry a higher risk when device names change (see step 6).
5. **Ceph RBD capacity for the backup.** The usable capacity (after replication) must be at least the total size of the TopoLVM VM disks on one node. Back up one node at a time and release the space after acceptance.
6. **Downtime window.** The downtime of one node is roughly: backup clone time + time to remove, reinstall, and add back the node + verification time. On the fallback path, add the time of one more clone back to TopoLVM. The clone speed depends on the performance of the TopoLVM disks and of Ceph, so measure it with one VM first and estimate from the amount of data on each node.
7. **No TopoLVM node finalizer is set on the nodes.** Otherwise, deleting a Node object also deletes the TopoLVM PVCs on that node:

   ```bash
   kubectl get node -o custom-columns=NAME:.metadata.name,FINALIZERS:.metadata.finalizers
   ```

   The output must not contain `topolvm.cybozu.com/node`.

## Resolution

The following steps apply to a single node, referred to as `<node>`. Finish and accept one node before you start the next one.

### 1. Record the node state

Before the reinstallation, save the following information to a location outside the node:

```bash
NODE=<node>
mkdir -p backup-$NODE && cd backup-$NODE

# Node object: labels and taints (they are lost when the node is added back)
kubectl get node $NODE -o yaml > node.yaml

# Mapping between the TopoLVM volumes and PVs on this node
kubectl get pv -o json | jq -r --arg n "$NODE" '.items[]
  | select(.spec.csi.driver=="topolvm.cybozu.com")
  | select(.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]==$n)
  | [.spec.claimRef.namespace, .spec.claimRef.name, .metadata.name, .spec.csi.volumeHandle] | @tsv' > pv-lv-map.tsv
kubectl get logicalvolume -o yaml > logicalvolumes.yaml

# Device configuration of TopoLVM and Ceph
kubectl get topolvmcluster -A -o yaml > topolvmcluster.yaml
kubectl get cm -n nativestor-system lvmdconfig-$NODE -o yaml > lvmdconfig.yaml
kubectl get cephcluster -A -o yaml > cephcluster.yaml 2>/dev/null

# VMs running on this node
kubectl get vmi -A -o wide | awk -v n="$NODE" 'NR==1 || $0 ~ n' > vmi-on-node.txt
```

Run the following on the node and save the output:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE
blkid
ls -l /dev/disk/by-id/ /dev/disk/by-path/
pvs; vgs -o +vg_uuid; lvs -o +lv_uuid
# Export a metadata backup of each VG
for vg in $(vgs --noheadings -o vg_name); do vgcfgbackup -f /root/$vg.vg $vg; done
```

Copy `/root/*.vg` to a location outside the node.

### 2. Stop the VMs and back up their disks to Ceph RBD

Stop the VMs on this node one by one. Use **Stop** on the VM page of the platform console, or use kubectl:

```bash
kubectl patch vm <vm> -n <namespace> --type=merge -p '{"spec":{"running":false}}'
kubectl wait vmi <vm> -n <namespace> --for=delete --timeout=10m
```

For each TopoLVM disk of the VM, create a DataVolume that clones it to Ceph RBD. Use the same `volumeMode` as the source disk:

```yaml
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata:
  name: bak-<source-pvc>
  namespace: <namespace>
spec:
  source:
    pvc:
      namespace: <namespace>
      name: <source-pvc>
  storage:
    storageClassName: <ceph-rbd-storageclass>
    volumeMode: <Block-or-Filesystem>
    accessModes: [ReadWriteOnce]
    resources:
      requests:
        storage: <source-size>
```

Wait until all clones finish:

```bash
kubectl get dv -n <namespace> -w    # every PHASE is Succeeded
```

**Keep the original TopoLVM PVCs and PVs. Do not delete them.**

It is recommended to spot-check that the backup of one VM is usable: clone the backup once more into a temporary disk, attach it to a temporary VM on another node, confirm that the VM boots, and then delete the temporary VM.

### 3. Check before you continue

Continue only when all of the following are true:

- All VMs on this node are stopped.
- All backup DataVolumes are `Succeeded`.
- The node state recorded in step 1 is saved outside the node.

### 4. Remove the node from the platform

Remove `<node>` from the platform by following the standard procedure. **Remove the node first, then reinstall the operating system.** Do not reverse this order.

After the node is removed, the PVC, PV, and LogicalVolume objects and `lvmdconfig-<node>` in the `nativestor-system` namespace are kept. **Do not delete them manually.**

For a control plane node, check after the removal that the Kube-OVN control plane still has a quorum:

```bash
kubectl get pod -n kube-system -l app=ovn-central -o wide
kubectl get deploy -n kube-system ovn-central \
  -o jsonpath='{.spec.replicas} {.spec.template.spec.containers[0].env[?(@.name=="NODE_IPS")].value}{"\n"}'
```

### 5. Reinstall the operating system on the system disk only

- Install the new operating system on the system disk only.
- Exclude all data disks from the disks selectable in the installer. If possible, detach the data disks during the installation.
- Keep the original hostname and IP address. TopoLVM PVs are bound to the node name through node affinity, and on ACP the node name is usually the node IP. If the node name changes, the original PVs can no longer be scheduled to this node.

### 6. Before adding the node back: check the data disks

Run the following on the new operating system:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE
blkid
pvs; vgs; lvs
```

Check each item:

1. **The VGs and LVs are present and match the record from step 1.** If `vgs` does not show the TopoLVM VG, check whether the LVM devices file (`/etc/lvm/devices/system.devices`) is enabled. If it is, import the VG with `vgimportdevices <vg>`.
2. **Whether the device names changed.** After the reinstallation, the device names of the data disks can change (for example, the two data disks `vdb` and `vdc` are swapped). When the disks have no serial number, the `by-path` names change as well. **Identify each disk by its content:** for TopoLVM, the PV that holds the VG in `pvs`; for a Ceph OSD, the `ceph_bluestore` type in `blkid`.
3. **If a device name changed, correct the storage configuration before adding the node back:**

   ```bash
   # TopoLVM: change the device of this node in deviceClasses to the new device name
   kubectl edit topolvmcluster -n nativestor-system <name>
   # Rook-Ceph (if Ceph runs on the nodes of this cluster): change storage.nodes[].devices of this node to the new device name
   kubectl edit cephcluster -n rook-ceph <name>
   ```

   > **Warning**: If you add the node back without this correction, the TopoLVM operator checks the VG against the old device names. If none of the PVs in the VG are in the configuration and their number differs from the configuration, the operator deletes the whole VG (`vgremove`). Pay particular attention to nodes whose VG spans several disks.

4. **The data disks were wiped** (`pvs` is empty and `blkid` prints nothing): the primary path is not available. Go to [Fallback: restore from Ceph when the data disks are lost](#fallback-restore-from-ceph-when-the-data-disks-are-lost).

### 7. Add the node back with its original role

Add the node back to the cluster from the platform with its original hostname, original IP address, and original role (control plane or worker).

### 8. Restore the taints, the virtualization switch, and custom labels

When the node is added back, its Node object is recreated. The taints and labels that were set on the node are lost, and a control plane node may get a default taint. Compare with the `node.yaml` saved in step 1:

| Item | Action |
|---|---|
| Taints | Restore the state before the reinstallation. For example, if `node-role.kubernetes.io/control-plane:NoSchedule` did not exist before but appears after the node is added back, remove it. Otherwise virt-handler is not scheduled to the node and the VMs cannot start. |
| Virtualization switch (`vm.cpaas.io/baremetal`) | Enable the virtualization switch again on the node page of the platform console. |
| Custom labels | If the `nodeSelector` or affinity of a VM refers to a custom node label, add the label back. |

The following labels are generated by the components automatically and **do not** need to be restored:

- `topology.topolvm.cybozu.com/node`: generated after the TopoLVM CSI driver registers on the node.
- `kubevirt.io/schedulable`, `cpu-model.node.kubevirt.io/*`, and similar labels: generated after virt-handler starts.

Example of removing the added taint (only if the node did not have it before the reinstallation):

```bash
kubectl taint node <node> node-role.kubernetes.io/control-plane:NoSchedule-
```

Confirm that virt-handler runs on the node and that the node exposes KVM resources:

```bash
kubectl get pod -n kubevirt -o wide | grep <node>
kubectl get node <node> -o jsonpath='{.status.allocatable.devices\.kubevirt\.io/kvm}{"\n"}'
```

### 9. Control plane nodes only: restore the Kube-OVN control plane membership

**Perform this step for control plane nodes only.** On ACP 4.1, removing a control plane node from the platform also removes it from the OVN database cluster (`ovn-central`), but **adding the node back does not add it back to the OVN database cluster**. Without this step, the OVN database cluster loses one member each time. When the second control plane node is processed, the cluster loses its quorum and new Pods can no longer get network addresses.

This step should be performed by, or under the guidance of, the person responsible for the network or Kube-OVN:

1. Add the node to `NODE_IPS` of `ovn-central`, and restore the replica count to the number of control plane nodes.
2. Update `OVN_DB_IPS` of the following components to the IPs of all control plane nodes: `kube-ovn-controller`, `ovn-ic-controller`, and `ovs-ovn`.

These workloads are managed by the platform's Kube-OVN chart. When they are modified manually, the platform creates a ResourcePatch to keep the change. **Check the content of the generated ResourcePatch**: it can also pin other fields, such as the replica count at the moment of the change.

> Changing `ovs-ovn` restarts OVS on each node in a rolling manner, and the network of that node is briefly interrupted. This item was not tested in the validation environment.

Verify:

```bash
P=$(kubectl get pod -n kube-system -l app=ovn-central -o name | head -1)
kubectl exec -n kube-system $P -- ovs-appctl -t /var/run/ovn/ovnnb_db.ctl cluster/status OVN_Northbound
kubectl exec -n kube-system $P -- ovs-appctl -t /var/run/ovn/ovnsb_db.ctl cluster/status OVN_Southbound
```

`Servers` must list all control plane nodes, and a leader must exist.

### 10. Verify the storage

```bash
# The TopoLVM node components run normally and the node state is Ready
kubectl get pod -n nativestor-system -o wide | grep <node>
kubectl get topolvmcluster -n nativestor-system -o jsonpath='{range .items[*].status.nodeStorageState[*]}{.node} {.phase}{"\n"}{end}'

# The LogicalVolumes recorded in step 1 still exist
kubectl get logicalvolume -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,VOLID:.status.volumeID | grep <node>

# Ceph (if it runs in this cluster): the original OSD is up again and no new OSD was created
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

### 11. Start the VMs on their original PVCs

Start the VMs without changing their disk configuration. Use **Start** in the console, or use kubectl:

```bash
kubectl patch vm <vm> -n <namespace> --type=merge -p '{"spec":{"running":true}}'
kubectl get vmi -n <namespace> -o wide
```

Confirm that the VMs run on `<node>`, and complete the workload verification.

### 12. Delete the backups

After the workloads are accepted, delete the backup DataVolumes of this node's VMs on Ceph to free the space for the next node:

```bash
kubectl delete dv -n <namespace> bak-<source-pvc>
```

### Fallback: restore from Ceph when the data disks are lost

Use the following steps if step 6 shows that the data disks were wiped.

#### A. Restore TopoLVM

After the node is added back, `status.json` in `lvmdconfig-<node>` still records the old VG as ready. The operator does not recreate the VG, and topolvm-node keeps crash-looping. Remove this record so that the operator recreates the VG on the empty disk:

```bash
kubectl get cm -n nativestor-system lvmdconfig-<node> -o yaml > lvmdconfig-before-fix.yaml
kubectl patch cm -n nativestor-system lvmdconfig-<node> --type=json \
  -p '[{"op":"remove","path":"/data/status.json"}]'
```

Wait until `status.json` appears again and the VG under `successClasses` is `Ready`.

If `status.json` reports `disk may has filesystem or is not raw disk` for the device, and `pvs` on the node shows only a PV without a VG on that disk, the previous creation stopped halfway. After confirming that the PV holds no VG, run `pvremove /dev/<disk>` and remove `status.json` once more.

#### B. Clone from Ceph back to TopoLVM

For each backup, create a DataVolume that clones it to TopoLVM:

```yaml
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata:
  name: rst-<source-pvc>
  namespace: <namespace>
spec:
  source:
    pvc:
      namespace: <namespace>
      name: bak-<source-pvc>
  storage:
    storageClassName: <topolvm-storageclass>
    volumeMode: <Block-or-Filesystem>
    accessModes: [ReadWriteOnce]
    resources:
      requests:
        storage: <source-size>
```

The TopoLVM StorageClass uses `WaitForFirstConsumer`, so the DataVolume stays in `PendingPopulation` until a Pod or VM uses it.

#### C. Switch the VM to the restored disks

Change the VM so that its disks refer to the `rst-*` DataVolumes. If the VM uses `dataVolumeTemplates`, remove the old templates as well, so that the disks are not imported again from the old templates. Pin the VM to `<node>` with a `nodeSelector` so that all of its disks are created on the same node:

```bash
kubectl patch vm <vm> -n <namespace> --type=json -p '[
 {"op":"replace","path":"/spec/dataVolumeTemplates","value":[]},
 {"op":"replace","path":"/spec/template/spec/volumes","value":[
   {"name":"<root-volume>","dataVolume":{"name":"rst-<root-pvc>"}},
   {"name":"<data-volume>","dataVolume":{"name":"rst-<data-pvc>"}}]}]'
```

Then start the VM as described in step 11.

Keep all other volumes of the VM (cloud-init, Secrets, and so on). Do not drop them in the change.

#### D. Clean up stale objects

After the VM runs normally, delete the old PVCs that point to LVs that no longer exist, together with their old DataVolumes. The PVs and LogicalVolumes are cleaned up automatically:

```bash
kubectl delete dv -n <namespace> <old-dv>
kubectl delete pvc -n <namespace> <old-pvc>
```

#### E. When Ceph runs on the nodes of this cluster

If the Ceph OSD disk was wiped as well, Rook creates a new OSD on the empty disk and recreates the mon of this node. After the cluster returns to `HEALTH_OK`, remove the stale old OSD:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd safe-to-destroy osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge <id> --yes-i-really-mean-it
kubectl -n rook-ceph delete deploy rook-ceph-osd-<id>
```

## Risks and Rollback

| Risk | Mitigation |
|---|---|
| The data disks are wiped during the reinstallation | The Ceph backup from step 2; follow the fallback path |
| Device names change after the reinstallation and an operator acts on the wrong disk | Check and correct the storage configuration before adding the node back (step 6) |
| The OVN database cluster loses its quorum after control plane nodes are removed, and the cluster network fails | Process one control plane node at a time; restore the OVN membership (step 9) before the next one |
| A taint is added or the virtualization switch is off after the node is added back, so VMs cannot be scheduled | Save `node.yaml` in step 1 and restore in step 8 |
| The local volumes of the monitoring components are on the reinstalled node | The history data of Prometheus and Alertmanager is lost, and monitoring is unavailable while the node is offline |

Rollback: if any step fails, the backup on Ceph is a usable recovery point. Do not touch the node before the backup is verified, and do not delete the backup before the workloads are accepted.
