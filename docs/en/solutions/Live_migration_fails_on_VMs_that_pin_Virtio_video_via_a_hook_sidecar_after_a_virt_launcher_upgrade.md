---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After the cluster's virtualization runtime is rolled forward to a new patch version, **live migration** stops working for a subset of VMs. The common factor among the failing VMs is that they use a *hook sidecar* to set the guest's display device to the Virtio video driver (rather than letting the runtime pick the default).

`virt-launcher` on the destination side records a QEMU migration-load failure that points at the video device:

```text
{"component":"virt-launcher","level":"error",
 "msg":"internal error: QEMU unexpectedly closed the monitor...
  qemu-kvm: get_pci_config_device: Bad config data..."}
{"component":"virt-launcher","level":"info",
 "msg":"qemu-kvm: Failed to load PCIDevice:config"}
{"component":"virt-launcher","level":"info",
 "msg":"qemu-kvm: Failed to load virtio-gpu:virtio"}
{"component":"virt-launcher","level":"info",
 "msg":"qemu-kvm: error while loading state for instance 0x0 of device '0000:00:01.0/virtio-gpu'"}
{"component":"virt-launcher","level":"info",
 "msg":"qemu-kvm: load of migration failed: Invalid argument"}
```

The source side keeps running fine; the destination side rejects the incoming migration stream because the source's PCI device shape does not match what the new virt-launcher image produces.

## Root Cause

The new virt-launcher image ships a QEMU package set that re-introduces the `virtio-vga` device variant (the package containing the device implementation was missing in the previous patch and is back in this one). The source VM was started against the *previous* image, which fell back to `virtio-gpu-pci`. The destination, running the *new* image, generates `virtio-vga` instead — because libvirt now sees the device as available and selects it.

QEMU's live-migration protocol streams the device state of every PCI device on the source VM into the equivalent device on the destination. The destination rejects the stream when the device class on the source does not match the device class on the destination — which is exactly what happens here:

| version | display device libvirt picks | source vs destination |
|---|---|---|
| previous | `virtio-gpu-pci` | what the source VM is running with |
| current | `virtio-vga` | what the destination virt-launcher will instantiate |

The QEMU monitor reports `Bad config data` and `Failed to load PCIDevice:config` because the migration stream contains a `virtio-gpu-pci` state and the destination is trying to apply it to a `virtio-vga` device. The two PCI shapes are not state-compatible across the live wire.

VMs that **don't** use the hook sidecar to pin Virtio video pick whatever default the runtime offers and have a consistent device class on both sides — they migrate normally. Only the hook-sidecar VMs are caught in the cross-version asymmetry.

## Resolution

Reset the source side to use the new device class. The migration stream is generated from the running QEMU process, so the only way to change the source's device class is to **cold-restart** (Stop and Start, not just Restart) the affected VMs. After a cold restart, the source VM is running on the new virt-launcher image and instantiates `virtio-vga`; from then on, both sides agree and live migration works again.

### 1. Identify the affected VMs

Any VM with a hook sidecar that pins Virtio video is a candidate:

```bash
kubectl get vm -A -o json \
  | jq -r '.items[]
            | select(.spec.template.metadata.annotations["hooks.kubevirt.io/hookSidecars"] != null)
            | "\(.metadata.namespace)/\(.metadata.name)"'
```

If you want to be conservative, treat every hook-sidecar VM as affected. If you want to be precise, additionally inspect each candidate's hook annotation and keep only those whose payload sets the display device to `virtio` / `virtio-vga`.

### 2. Cold-restart each VM

A live restart (the runtime's `restart` action) is **not** enough — it migrates the state to a new pod, preserving the device shape. Use stop-then-start:

```bash
kubectl virt stop -n <ns> <vm>            # waits for graceful shutdown
kubectl virt start -n <ns> <vm>
```

If the cluster's `kubectl` does not have the `virt` plugin, the equivalent is to scale the VM's `running:` field down and back up:

```bash
kubectl patch vm -n <ns> <vm> --type merge -p '{"spec":{"running":false}}'
# wait until VMI is gone
kubectl wait --for=delete vmi/<vm> -n <ns> --timeout=10m
kubectl patch vm -n <ns> <vm> --type merge -p '{"spec":{"running":true}}'
```

Coordinate with the workload owner — a cold restart is a few seconds of downtime per VM.

### 3. Verify a live migration works

Pick one of the freshly-restarted VMs and trigger a live migration to another node:

```bash
kubectl create -f - <<EOF
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstanceMigration
metadata:
  generateName: <vm>-test-
  namespace: <ns>
spec:
  vmiName: <vm>
EOF
kubectl get vmim -n <ns> -w
```

A `Succeeded` migration without `Bad config data` errors in the destination virt-launcher log proves the device shape is now consistent end-to-end.

### Avoiding the same trap on the next upgrade

When the runtime release notes call out a change to the QEMU device package set, plan a cold-restart wave for any VM that pins device shapes through a hook sidecar. The routine "live migrate everything off a node before draining" is what surfaced the issue here — the live migration cannot bridge the device-shape gap. A scheduled cold-restart maintenance window before the rollout is cheaper than chasing failed migrations after.

## Diagnostic Steps

1. Confirm the failure shape is the device-state mismatch and not a generic networking / RDMA migration issue. The signature in the destination virt-launcher log is the trio:

   ```text
   Failed to load PCIDevice:config
   Failed to load virtio-gpu:virtio
   error while loading state for instance 0x0 of device '0000:00:01.0/virtio-gpu'
   ```

   All three referencing `virtio-gpu` (the source-side class) is what diagnoses this case.

2. Compare the device line in the source VM's QEMU command line against the destination's. From a debug shell into both virt-launcher pods:

   ```bash
   kubectl exec -n <ns> <virt-launcher-source>      -- cat /var/run/kubevirt-private/.../qemu.cmd | grep -E 'vga|virtio-(gpu|vga)'
   kubectl exec -n <ns> <virt-launcher-destination> -- cat /var/run/kubevirt-private/.../qemu.cmd | grep -E 'vga|virtio-(gpu|vga)'
   ```

   `virtio-gpu-pci` on one side and `virtio-vga` on the other proves the asymmetry.

3. After cold-restarting a VM, re-read the source-side QEMU command line and confirm it now lists `virtio-vga`. If it still says `virtio-gpu-pci`, the VM did not actually go through Stop/Start — most likely the platform's automation did a graceful restart that re-used the device template; redo the cycle as `running:false` → wait for VMI to disappear → `running:true`.

4. If a small subset of VMs has a hard requirement for `virtio-gpu-pci` (some image overlays do), you can pin the device by hand in the VM template. Edit the VM CR's `spec.template.spec.domain.devices.video` (or equivalent) to specify `virtio-gpu-pci` explicitly; that overrides libvirt's auto-selection on the new image and keeps the source/destination consistent without needing the hook sidecar at all.
