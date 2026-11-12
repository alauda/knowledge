---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# TopoLVM device class or storage devices show Unavailable or Unknown on ACP

## Issue

On the Local Storage page of Alauda Container Platform, a TopoLVM device class or several storage devices are shown as unavailable (`不可用`, "Unavailable"), or the node's local-storage status is `Unknown`. Typical reports:

- After a node reboot the local-storage status was `Unknown`, and the device class was then deleted from `TopolvmCluster` by hand while the logical volumes were still on the disk.
- The device class is unavailable, sometimes with no error text, and the question is whether it affects use and how to clear it.
- NVMe devices in one or more device classes are unavailable, and the `topolvm-operator` log repeats `cluster is not health should requene`.
- Under **Storage Management > Local Storage > topolvm > Storage Devices** the list can be empty (`无设备`, "No devices").

Operands are in `nativestor-system`; the cluster object is `topolvm`; per-node lvmd settings are a ConfigMap such as `lvmdconfig-<node>` (use the name `kubectl get cm -n nativestor-system` prints).

Related articles: [TopoLVM lvmd exits with should have at least one device-class or Error: not found on ACP](./TopoLVM_lvmd_exits_with_should_have_at_least_one_device-class_or_Error_not_found_on_ACP.md) (the volume group name on the node differs from the configuration, or the volume groups are missing).

## Root Cause

### Cause 1: the device class was deleted after a reboot while the logical volumes were still on disk

After a reboot showed `Unknown`, the device class was removed from `TopolvmCluster` by hand. `kubectl get topolvmclusters.topolvm.cybozu.com -n nativestor-system topolvm -o yaml` then shows `useAllDevices`, `useAllNodes`, and `useLoop` all `false`, and `status.nodeStorageState` holds only a failed class, for example `className: sdc`, device `/dev/sdc1`, `state: Offline`, message `disk may has filesystem or is not raw disk please check`, class message `create failed`. The class that still holds the data (for example `sdb`, volume group `sdb-<uuid>`) is no longer listed, while its logical volumes are still on the disk. This is outside the supported node and device removal procedures, and full recovery is not guaranteed.

### Cause 2: devices Offline because the stored disk serial lacks the suffix udev reports

The `topolvm-operator` log repeats:

```text
topolvm-controller: failed to reconcile failed to reconcile cluster "topolvm": cluster is not health should requene
```

and the `topolvm-prepare-vg-<hash>` Job is removed and recreated in a loop. In `topolvmcluster/topolvm` status the device has a `serial` and `state: Offline`, and its class is `state: UnReady`. On the node, `udevadm info /dev/<disk>` reports `ID_SERIAL=<serial>_1`, while `status.json` in the node's lvmd ConfigMap holds the same serial without the `_1` suffix. Because the stored serial does not match, TopoLVM treats the disk as gone.

### Cause 3: the device class shows unavailable, and restarting the operator and the controller clears it

The device class is unavailable, none of the shapes above or in the related article matches (names agree, logical volumes intact, serials match, the class is still in the spec), and restarting `topolvm-operator` and `topolvm-controller` brings the class back. The underlying reason for this shape is not known.

## Resolution

### Cause 1: the device class was deleted after a reboot while the logical volumes were still on disk

The recommended path is to migrate the data off the node, then uninstall and redeploy TopoLVM. The temporary procedure below lets the existing volumes be created and mounted again, but it is not a clean steady state: the node stays `Unknown`, and upgrades and later TopoLVM updates are blocked while the operator is stopped. Risks include an overwritten configuration, a volume group that does not match, existing logical volumes that are not recognized, and PVC mounts that then fail permanently. Validate it on a replica environment of the same version and architecture first.

1. Stop the operator from its CSV so it does not rewrite the ConfigMap. Set `spec.install.spec.deployments` for the deployment named `topolvm-operator` to `replicas: 0`, and confirm the operator pod is gone.

> **Warning:** Operator replicas 0 stops reconciliation for every TopoLVM node, not only this one. Precondition: `lvs` still shows the volumes you need, the CSV is saved, and you accept the `Unknown` status and blocked upgrades. Rollback: set the replicas back to `1`.

```bash
kubectl get csv -A | grep topolvm
kubectl -n nativestor-system get csv <csv-name> -o yaml > /tmp/topolvm-csv.before.yaml
kubectl -n nativestor-system edit csv <csv-name>
```

2. On ConfigMap `lvmdconfig-<node>`, keep the existing `devices` and `status.json` keys, do not set `immutable`, and add `lvmd.yaml` if it is missing. The volume group must be the one `vgs` shows, which still holds the logical volumes. Leave other disks out.

```yaml
lvmd.yaml: |
  socket-name: /run/topolvm/lvmd.sock
  device-classes:
  - name: <class>
    volume-group: <vg-name>
    default: true
```

```bash
kubectl -n nativestor-system get cm lvmdconfig-<node> -o yaml > /tmp/lvmdconfig.before.yaml
kubectl -n nativestor-system edit cm lvmdconfig-<node>
kubectl -n nativestor-system get cm lvmdconfig-<node> -o yaml | grep lvmd.yaml
```

3. Restore the node under `spec.storage.deviceClasses` of `topolvmcluster/topolvm`: the same `className`, `default: true`, the device path with `type: disk`, and `volumeGroup` set to `<vg-name>`. Do not add disks that are not in that volume group.

> **Warning:** A wrong `volumeGroup` or device path makes the node plugin look at the wrong disk. Precondition: `vgs` and `lvs` match the names you write, and the cluster YAML is saved. Rollback: restore the saved cluster object; fix the ConfigMap first rather than scaling the operator up to undo a bad name.

4. Finish in this order:
   1. In the CSV, set the `topolvm-operator` replicas to `1`, so the operator recreates `topolvm-node` for the node.
   2. The recreated `topolvm-node` fails to start. Set the replicas in the CSV back to `0` and confirm the operator pod is gone.
   3. Re-apply the `lvmd.yaml` edit from step 2 and check it.
   4. Confirm that `topolvm-node` on that node starts, with the operator still at 0 replicas.

When PVCs mount and capacity is displayed while the node is still `Unknown`, stop here; do not scale the operator up. Plan the data migration and the TopoLVM redeploy.

### Cause 2: devices Offline because the stored disk serial lacks the suffix udev reports

1. On each affected node, compare the udev serial with the stored one:

```bash
udevadm info --query=property --name=/dev/<disk> | grep '^ID_SERIAL='
kubectl -n nativestor-system get cm -o name | grep -i lvm
kubectl -n nativestor-system get cm <lvmd-configmap> -o jsonpath='{.data.status\.json}{"\n"}'
```

> **Warning:** Scaling `topolvm-operator` to 0 pauses reconciliation for every TopoLVM node, and a wrong serial keeps the device Offline. Existing mounts keep working. Precondition: the udev `ID_SERIAL` and the stored serial differ for this device (for example only the `_1` suffix is missing), and the ConfigMap is saved. Rollback: apply the saved ConfigMap while the operator is still at 0, then scale it back to 1.

2. Stop the operator, set the device's serial in `status.json` to the exact `ID_SERIAL` value udev printed, then start the operator:

```bash
kubectl -n nativestor-system get cm <lvmd-configmap> -o yaml > /tmp/lvmd-configmap.before.yaml
kubectl -n nativestor-system scale deployment topolvm-operator --replicas=0
kubectl -n nativestor-system edit cm <lvmd-configmap>
kubectl -n nativestor-system scale deployment topolvm-operator --replicas=1
```

If OLM sets the operator back to 1 replica during the edit, stop it from the CSV as in Cause 1.

3. The ConfigMap then shows the device `Online` and the class `Ready`, and `topolvmcluster` shows the disk online. If the console still shows the devices unavailable after the serial is corrected, contact support with the operator log and the ConfigMap; an additional fix was needed for the console to show the device classes as healthy (`健康`) and available (`可用`).

### Cause 3: the device class shows unavailable, and restarting the operator and the controller clears it

1. Before restarting, collect what is needed to find the cause if it returns: whether any disk operation was done on the node, the cluster object, and the prepare pod's events and logs. Run the commands where a kubeconfig for the cluster is available (`The connection to the server localhost:8080 was refused` means the host has no kubeconfig; it is not a TopoLVM symptom).

```bash
kubectl get po -A -o wide | grep topolvm
kubectl get topolvmclusters -n nativestor-system topolvm -o yaml
kubectl -n nativestor-system describe pod <topolvm-prepare-vg-pod>
kubectl -n nativestor-system logs <topolvm-prepare-vg-pod> --all-containers
```

> **Warning:** Restarting the operator and the controller recreates those pods; new mounts wait until they are Ready, and mounts that already succeeded stay mounted. Precondition: no volume group mismatch, no deleted class, and no serial mismatch. Rollback: none needed.

2. Restart both:

```bash
kubectl -n nativestor-system rollout restart deployment topolvm-operator
kubectl -n nativestor-system rollout restart deployment topolvm-controller
kubectl -n nativestor-system get pods -o wide
```

Every node then shows a normal status (`正常`), and the device class shows available (`可用`) with its usage. If it becomes unavailable again, collect the prepare pod logs before restarting a second time. A `topolvm-prepare-vg` pod that stays `Pending` for a node that has already left the cluster is a different problem (stale node status).

## Diagnostic Steps

```bash
kubectl -n nativestor-system get pods -o wide
kubectl -n nativestor-system get topolvmcluster topolvm -o yaml
kubectl -n nativestor-system get cm lvmdconfig-<node> -o yaml
kubectl -n nativestor-system logs deploy/topolvm-operator --tail=100
```

On the node:

```bash
pvs
vgs
lvs -a
udevadm info --query=property --name=/dev/<disk> | grep '^ID_SERIAL='
```

- `Unknown` after a reboot, a device class someone deleted from the spec, and `lvs` still showing data: Cause 1.
- Devices `Offline`, the operator repeating `cluster is not health should requene`, and a serial in `status.json` that lacks the suffix `udevadm info` shows: Cause 2.
- Unavailable with none of the above, and with volume group names that match: Cause 3.
- `lvmd` exiting with `should have at least one device-class` or `Error: not found`: see Related articles.
