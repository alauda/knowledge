---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Virtual machines whose disks are backed by Ceph-RBD volumes mounted in `accessMode: ReadWriteMany` (RWX) — typical for VM live migration — pause unexpectedly. The VMI status reports:

```yaml
status:
  conditions:
    - reason: PausedIOError
      status: "True"
      type: Paused
      message: "VMI was paused, low-level IO error detected"
```

The guest needs a power-cycle to resume. The `virt-launcher` pod log shows the libvirt event for the same transition:

```text
"Transitioned guest <vm> to paused state due to IO error"
```

The host kernel records the underlying RBD failure in `dmesg`, and the Ceph cluster shows clients being repeatedly blocklisted. The pattern correlates with the cluster's weekly reclaim-space schedule.

## Root Cause

The Ceph-RBD `StorageClass` shipped for VM workloads carries an annotation read by the CSI Addons controller, conventionally:

```yaml
metadata:
  annotations:
    reclaimspace.csiaddons/schedule: "@weekly"
```

(The actual annotation key is the one published by the CSI Addons project for the deployed driver — verify with `kubectl get storageclass <name> -o yaml`.) The CSI Addons controller automatically creates a `ReclaimSpaceCronJob` for every PVC backed by this `StorageClass`. The reclaim job runs one of two operations:

- `fstrim` on **filesystem-mode** volumes that are currently mounted to a pod, or
- `rbd sparsify` on volumes that are **not** attached to any pod, to discard 4 MiB chunks of zeroes inside the RBD image.

The interaction that pauses the VM is between `rbd sparsify` and RWX **block-mode** volumes:

1. The CronJob fires while the PVC happens to be momentarily detached (live migration in flight, VM stopped, etc.). It launches `rbd sparsify` on the image.
2. There is no mount-time watcher check on RWX **block** mode. While `rbd sparsify` is running in the background, a VM elsewhere can re-mount the same RBD image as a block device.
3. Concurrent writes from the VM and `rbd sparsify` on the same image trigger Ceph client blocklisting; the VM's RBD client is fenced and any in-flight I/O fails.
4. libvirt observes the I/O error and pauses the guest.

The same root cause applies to any VM whose disk uses a Ceph-RBD `StorageClass` with the auto-reclaim schedule annotation, regardless of whether the workload is virtualization or generic — the sparsify-on-mounted-RWX problem only manifests in RWX block.

## Resolution

The fix is to stop reclaim-space jobs from running automatically on RWX Ceph-RBD volumes that may be mounted by VMs. Two paths, depending on whether the VMs already exist.

### For new VMs — create a derived StorageClass without the schedule

Clone the default Ceph-RBD `StorageClass` and remove the reclaim-schedule annotation. Use the new class for every new VM disk:

```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: ceph-rbd-virt-noreclaim
  annotations:
    description: Ceph-RBD RWO+RWX block for VM disks, no auto reclaim
    storageclass.kubevirt.io/is-default-virt-class: "true"
provisioner: rbd.csi.ceph.com
parameters: { ... copy from the default ... }
```

Reset the `is-default-virt-class` annotation on the original class to `"false"` so new VMs land on the safer class:

```bash
kubectl annotate storageclass <original> \
  storageclass.kubevirt.io/is-default-virt-class=false --overwrite
```

### For VMs already provisioned — disable the existing reclaim cron jobs

For each affected PVC, mark the associated `ReclaimSpaceCronJob` as `unmanaged` (so the controller does not recreate it) and suspend it:

```bash
kubectl get reclaimspacecronjob -n <vm-ns>

kubectl patch reclaimspacecronjob/<name> -n <vm-ns> --type=merge \
  -p '{"metadata":{"annotations":{"csiaddons/state":"unmanaged"}}}'

kubectl patch reclaimspacecronjob/<name> -n <vm-ns> --type=merge \
  -p '{"spec":{"suspend":true}}'
```

Restart the Ceph-RBD CSI pods in the storage namespace so the change is picked up by the in-flight reconciler:

```bash
kubectl delete pod -n <ceph-storage-ns> -l app=csi-rbdplugin
kubectl delete pod -n <ceph-storage-ns> -l app=csi-rbdplugin-provisioner
```

(The exact label selectors depend on the CSI driver version — list with `kubectl get pod -n <ceph-storage-ns> -L app` first.)

### Running reclaim manually on demand

If reclamation of free space inside an RBD image is genuinely required, run it as a one-off `ReclaimSpaceJob` against an **unmounted** PVC:

1. Power down the VM (`virtctl stop`), confirm the PVC is detached.
2. Create a `ReclaimSpaceJob` referencing the PVC. Set a generous `timeout` for large images:

   ```yaml
   apiVersion: csiaddons/v1alpha1
   kind: ReclaimSpaceJob
   metadata:
     name: reclaim-<pvc>
     namespace: <vm-ns>
   spec:
     target:
       persistentVolumeClaim: <pvc>
     timeout: 3600
   ```

3. Watch progress:

   ```bash
   kubectl get reclaimspacejob -n <vm-ns> -w
   ```

4. After the job reports `Succeeded`, restart the VM.

## Diagnostic Steps

1. Confirm the VMI is paused for an I/O error:

   ```bash
   kubectl get vmi <vm> -n <vm-ns> -o jsonpath='{.status.conditions}' | jq .
   ```

2. Inspect the VM's `virt-launcher` pod log for the libvirt transition message:

   ```bash
   kubectl logs <virt-launcher-pod> -n <vm-ns> | grep -i "paused state due to IO error"
   ```

3. Look for kernel-level RBD errors on the worker node:

   ```bash
   kubectl debug node/<worker> -- chroot /host dmesg | grep -i 'rbd:'
   ```

4. Check Ceph for client blocklist activity around the same time and confirm a sparsify job ran on the same RBD image:

   ```bash
   kubectl exec -n <ceph-storage-ns> <ceph-tools-pod> -- ceph osd blacklist ls
   kubectl get reclaimspacejob,reclaimspacecronjob -A
   ```

5. List the StorageClass annotations to verify whether automatic reclaim is in effect for VM disks:

   ```bash
   kubectl get storageclass -o yaml | grep -E 'name:|reclaimspace.*/schedule'
   ```
