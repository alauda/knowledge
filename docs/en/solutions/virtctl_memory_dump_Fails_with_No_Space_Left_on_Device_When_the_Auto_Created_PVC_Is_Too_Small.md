---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On an ACP Virtualization cluster (KubeVirt under the hood), requesting an on-demand memory dump of a running VM fails mid-transfer:

```text
Memory dump to pvc testmemorydump failed:
  Domain memory dump failed:
    virError(Code=9, Domain=0,
      Message='operation failed: /usr/libexec/libvirt_iohelper: failure with
               /var/run/kubevirt/hotplug-disks/<pvc>/<vm>-<pvc>-<ts>.memory.dump:
               Unable to write ... : No space left on device')
```

The command is typically invoked with the convenience flag that creates the target PVC for the operator:

```bash
virtctl memory-dump get <vm-name> --create-claim --claim-name=testmemorydump
```

When the flag auto-creates the claim, the resulting PVC can be sized below what the dump actually needs, and the dump aborts with `ENOSPC` after libvirt has already begun streaming guest memory into it.

## Root Cause

`virtctl memory-dump ... --create-claim` derives the PVC size from the VM's memory request. When the VMI spec was written without an explicit `.spec.domain.resources.requests.memory` (or was produced from a template that left it empty), the computed size collapses to a small default — far smaller than the guest's actual RAM footprint and the filesystem overhead the CSI driver needs on top of it.

libvirt streams the dump straight into that PVC mounted as a hotplug disk. Once the file reaches the PVC's capacity minus the filesystem overhead, the next write hits `ENOSPC` and libvirt aborts the operation. The KubeVirt-side tracker for this undersizing behaviour is `CNV-82027`.

## Resolution

The durable workaround is to stop relying on `--create-claim` for memory dumps and provision the PVC yourself with a size derived from the VM's configured memory, not from whatever happened to land in the VMI spec.

### Sizing formula

The target PVC must hold the guest's RAM plus libvirt's metadata plus the filesystem overhead the CSI driver charges against the volume:

```text
PVC size >= (guest_memory + 100 MiB) * (1 + filesystem_overhead)
```

`filesystem_overhead` defaults to `0.055` (5.5%) for the block-to-filesystem wrapper used by KubeVirt's Containerized Data Importer (CDI); a safer rule of thumb is `0.07` (7%) to give pressure headroom.

For an 8 GiB guest:

```text
PVC size = (8 GiB + 100 MiB) * 1.07
        ≈ 8.1 GiB * 1.07
        ≈ 8.7 GiB
```

Round up to the nearest size the StorageClass actually provisions (most dynamic provisioners round up to the next GiB anyway).

### Pre-create the PVC

Create the PVC in the same namespace as the VM, with the StorageClass that KubeVirt uses for hotplug disks on this cluster and with `accessModes: [ReadWriteOnce]` (the dump does not need RWX; hotplug attach will work either way).

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: testmemorydump
  namespace: <vm-namespace>
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 9Gi      # guest_mem + 100Mi + ~7% FS overhead, rounded up
  storageClassName: <hotplug-capable-sc>
```

Apply it, then run the dump against the pre-existing claim — notice the absence of `--create-claim`:

```bash
kubectl apply -f memory-dump-pvc.yaml
virtctl memory-dump get <vm-name> \
  --claim-name=testmemorydump \
  --namespace=<vm-namespace>
```

The dump streams into the PVC and completes. The resulting file is at `<mount>/memory.dump` inside a pod that mounts the claim, or can be retrieved with:

```bash
virtctl memory-dump download <vm-name> \
  --claim-name=testmemorydump \
  --namespace=<vm-namespace> \
  --output=./vm-memory.dump
```

### Preventive fix for new VMs

If dumps on this VM are going to be a recurring activity, patch the VMI spec to always carry an explicit memory request equal to the guest memory. Once the field is populated, `virtctl ... --create-claim` on future invocations will compute a correctly sized PVC on its own, and the workaround is no longer needed.

```yaml
spec:
  template:
    spec:
      domain:
        resources:
          requests:
            memory: 8Gi
        memory:
          guest: 8Gi
```

## Diagnostic Steps

Before blaming the dump, confirm the failure really is disk-full and not a timeout or a libvirt auth error. The VMI event surface is the single most useful place:

```bash
kubectl -n <vm-namespace> get vmi <vm-name> -o yaml \
  | yq '.status.conditions, .status.volumeStatus'
kubectl -n <vm-namespace> describe vmi <vm-name> | grep -A3 -i dump
```

`virError(Code=9, ... No space left on device)` on the memory-dump event is the unambiguous signature of this bug. If instead the event reports a libvirt permission error or a hotplug volume-not-ready condition, the root cause is different and the PVC sizing fix will not help.

To confirm the PVC is the bottleneck rather than the underlying PV, inspect the mounted size inside the virt-launcher pod at the moment of failure:

```bash
POD=$(kubectl -n <vm-namespace> get pod \
  -l kubevirt.io/vm=<vm-name> \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n <vm-namespace> exec "$POD" -c compute -- \
  df -h /var/run/kubevirt/hotplug-disks/testmemorydump
```

If the mount's `Avail` is a few hundred MiB at the moment of the crash while the guest has many GiB of RAM, the PVC is undersized — resize the claim (if the StorageClass supports online resize) or recreate it with the formula above.
