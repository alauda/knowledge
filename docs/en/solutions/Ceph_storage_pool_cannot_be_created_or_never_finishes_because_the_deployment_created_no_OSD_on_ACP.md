---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Ceph storage pool cannot be created or never finishes because the deployment created no OSD on ACP

## Issue

A new Ceph distributed storage cluster on Alauda Container Platform is deployed, but no OSD is created, so the storage pool cannot be built on it:

- In step 3 of the distributed storage wizard (create storage pool), the device class dropdown shows `无数据` ("no data") for the class created in step 2.
- Creating a block storage pool does not complete, and some deployment options show no output.
- `CephCluster` is `Ready` with `HEALTH_WARN`, the `rook-ceph-osd-prepare-*` pods are `Completed`, and there is no `rook-ceph-osd-<id>` pod. `kubectl describe cephcluster` lists versions only for `mgr` and `mon`, with no OSD entry.

With no OSD there is no CRUSH device class, so the pool form has nothing to offer, and a replicated pool cannot place its copies.

Work in the `rook-ceph` namespace (`CephCluster`, operator Deployment `rook-ceph-operator`, toolbox Deployment `rook-ceph-tools`).

Related articles: [A raw disk added to a Ceph device class does not become an OSD on ACP](./A_raw_disk_added_to_a_Ceph_device_class_does_not_become_an_OSD_on_ACP.md) (disks added to an existing cluster), [Ceph OSD crash-loops with not a block device, or an OSD has to move to another device class on ACP](./Ceph_OSD_crash-loops_with_not_a_block_device_or_an_OSD_has_to_move_to_another_device_class_on_ACP.md), [Ceph operator install returns 404, or the storage page is empty because rook-ceph-tools never starts on ACP](./Ceph_operator_install_returns_404_or_the_storage_page_is_empty_because_rook-ceph-tools_never_starts_on_ACP.md) (the tools pod is not Running).

## Root Cause

### Cause 1: leftover data on the disks, so prepare completes without creating an OSD

The disks selected for the cluster still carry data from an earlier use. Prepare runs, skips them, and finishes as `Completed` without creating an OSD. This is confirmed on ACP 4.3.3 (Ceph 19.2.5), where cleaning the disks resolved it. A `ReconcileFailed` event `failed to add finalizer ... the object has been modified` next to `ReconcileSucceeded` can appear at the same time; it is not the cause.

### Cause 2: the device name was entered with extra quotes

The disk name was typed with extra quotes during deployment, so `CephCluster` records it literally, for example:

```yaml
storage:
  useAllDevices: false
  nodes:
    - name: <node>
      devices:
        - name: '"vde"'
```

The device name is `"vde"` (with the double quotes), which matches no device on the node. Storage initialization fails because no OSD is created on `vde`.

## Resolution

### Cause 1: leftover data on the disks, so prepare completes without creating an OSD

1. Confirm that no OSD was created and the tools pod is Running:

```bash
kubectl -n rook-ceph get pods | grep -E 'rook-ceph-osd-|rook-ceph-tools'
kubectl -n rook-ceph describe cephcluster <cephcluster-name> | grep -A12 -i versions
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph logs <rook-ceph-osd-prepare-pod> | grep -i -E 'skipping|available'
```

Only `rook-ceph-osd-prepare-*` pods in `Completed`, no `rook-ceph-osd-<id>` pod, and no OSD in `ceph -s` match this cause. If the tools pod is not Running, use the related article on the tools pod instead.

2. On each disk node, confirm the target is an unused data disk, and find the CSI pod running on that node:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT /dev/<device>
kubectl -n rook-ceph get pods -o wide | grep -i csi
```

3. Zap the disk from inside that CSI pod.

> **Warning:** `ceph-bluestore-tool zap-device` erases BlueStore labels and signatures on `/dev/<device>`. Irreversible. Precondition: only when step 1 matches, `lsblk` shows this is the disk you intend to give Ceph, it is not mounted, it is not the OS disk, and it does not back an `up` OSD. Rollback: none.

```bash
kubectl -n rook-ceph exec <csi-pod-on-that-node> -- ceph-bluestore-tool zap-device --dev /dev/<device>
```

If `exec` reports that a container must be chosen, rerun with `-c <container>`. The signature wipe on the node in Cause 1 of [A raw disk added to a Ceph device class does not become an OSD on ACP](./A_raw_disk_added_to_a_Ceph_device_class_does_not_become_an_OSD_on_ACP.md) is the alternative when the tool is not available in the pod.

4. If no OSD pod appears after the disks are clean, restart the operator so prepare runs again.

> **Warning:** Restarting `rook-ceph-operator` restarts only the operator pod; prepare and reconcile pause until it is Ready. Precondition: the disks are clean. Rollback: none needed.

```bash
kubectl -n rook-ceph rollout restart deploy/rook-ceph-operator
kubectl -n rook-ceph get pods | grep -E 'rook-ceph-osd-'
```

5. When OSD pods are Running, the device class appears in the pool wizard; create the pool again.

### Cause 2: the device name was entered with extra quotes

1. Look at the device names exactly as stored:

```bash
kubectl -n rook-ceph get cephcluster <cephcluster-name> -o jsonpath='{range .spec.storage.nodes[*]}{.name}{": "}{.devices}{"\n"}{end}'
```

A name such as `"\"vde\""` or one that contains `'` or `"` is this cause.

> **Warning:** Editing `spec.storage` makes the operator prepare the devices named there. A wrong name can point prepare at a different disk. Precondition: you saved the object, and the corrected name is the free data disk that `lsblk` shows on that node. Rollback: apply the saved device entries with `kubectl -n rook-ceph edit cephcluster <cephcluster-name>`.

2. Correct the names:

```bash
kubectl -n rook-ceph get cephcluster <cephcluster-name> -o yaml > cephcluster-before.yaml
kubectl -n rook-ceph edit cephcluster <cephcluster-name>
```

Under `spec.storage.nodes[].devices`, set each name to the bare device name, for example `- name: vde`, on every node that has the wrong value.

3. Watch prepare create the OSDs and the pool finish:

```bash
kubectl -n rook-ceph get pods | grep -E 'rook-ceph-osd-'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

When entering disk names in the wizard, type the bare name as `lsblk` shows it (`vde`), without quotes. The `?` help icon next to each field on the create page describes what the field expects.

## Diagnostic Steps

```bash
kubectl -n rook-ceph get cephcluster
kubectl -n rook-ceph get pods -o wide | grep -E 'osd|tools'
kubectl -n rook-ceph get cephcluster <cephcluster-name> -o yaml | grep -n -A6 'nodes:'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

- Prepare pods `Completed`, no OSD pod, device names correct, and `lsblk -f` or the prepare log shows the disks still hold data: Cause 1.
- Device names in `spec.storage.nodes[].devices` wrapped in extra quotes: Cause 2.
- `rook-ceph-tools` not Running, or `tty: true` on its container: see the related article on the tools pod.
- An existing cluster where a newly added disk does not become an OSD: see the related article on raw disks added to a device class.
