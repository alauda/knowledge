---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.0,4.2.x
---

# Windows VM mouse pointer misalignment in the VNC console — add a USB tablet input device

## Issue

A Windows guest created through ACP Virtualization opens fine in the web VNC console, but the mouse pointer cannot be aimed accurately at UI elements. Symptoms typically observed:

- The host cursor and the guest cursor drift apart — clicking a button on screen actually lands somewhere else.
- The pointer is "stuck" near a corner, or every movement is amplified / inverted relative to the host.
- Drag, scroll, and right-click behave inconsistently; precise actions in installers, RDP-style dialogs, or the Windows logon screen are nearly impossible.

The same VM behaves normally when connected via RDP or via a SPICE-capable client. The misalignment is specific to the VNC channel.

## Root Cause

By default a KubeVirt VirtualMachine exposes a **PS/2-style emulated mouse** to the guest. PS/2 mice send *relative* deltas (Δx, Δy), and the guest OS is responsible for tracking absolute pointer position. Over VNC the client only ever sends *absolute* coordinates (where the user clicked on the framebuffer), so the host has to translate those into a stream of relative deltas before handing them to the guest. The guest then re-derives an absolute position from those deltas.

Two things go wrong with that chain on Windows:

1. **No bidirectional pointer synchronization.** Linux guests run an X/Wayland input layer that resyncs the cursor on every motion event, masking the drift. The Windows pointer subsystem trusts its own internal coordinates and only periodically reconciles them, so the guest's idea of "where the cursor is" diverges from the VNC client's idea after a few movements.
2. **Pointer acceleration ("Enhance pointer precision") is on by default in Windows.** The non-linear acceleration curve is applied to the relative deltas the hypervisor injects, so a 10-pixel host movement does not become a 10-pixel guest movement. The error compounds, producing the runaway drift users see.

Switching to a **USB tablet** input device sidesteps the whole chain. A tablet reports *absolute* coordinates natively, so the VNC client's "user clicked at (x, y)" is delivered to the guest as "pointer is at (x, y)" — no relative-delta translation, no acceleration curve, no drift. Windows ships an in-box HID-compliant tablet driver, so the device is recognized without extra installs.

This is a known KubeVirt design quirk, tracked upstream in [kubevirt/kubevirt#2392](https://github.com/kubevirt/kubevirt/issues/2392). OpenShift Virtualization's Windows VM templates already declare a USB tablet by default for the same reason; ACP's templates do not yet, which is why freshly created Windows VMs hit this.

## Resolution

Add a USB tablet to the VM's `spec.template.spec.domain.devices.inputs` list, then restart the VM so the new device is hot-attached at the next boot.

### Patch an existing VM

```bash
export VM_NS=<vm-namespace>
export VM_NAME=<vm-name>

kubectl patch vm "$VM_NAME" -n "$VM_NS" --type=json -p='[
  {
    "op": "add",
    "path": "/spec/template/spec/domain/devices/inputs",
    "value": [
      {
        "name": "tablet",
        "bus": "usb",
        "type": "tablet"
      }
    ]
  }
]'
```

If the VM already has an `inputs` array (for example, a previous tablet was removed and the key was left empty), the JSON-patch `add` above will replace it. To append instead, target `/spec/template/spec/domain/devices/inputs/-`.

Restart the VM so the new device is presented to the guest:

```bash
virtctl restart "$VM_NAME" -n "$VM_NS"
```

After the guest comes back up, Windows auto-installs the HID-compliant tablet driver. Reconnect the VNC console — the cursor should track the host pointer one-to-one.

### Bake it into new VMs

For VMs created from a YAML manifest, declare the tablet alongside the existing disks and interfaces. The complete `devices` block looks like this (the `inputs` entry is the addition):

```yaml
spec:
  template:
    spec:
      domain:
        devices:
          disks:
            - disk:
                bus: sata
              name: rootdisk
          inputs:
            - bus: usb
              name: tablet
              type: tablet
          interfaces:
            - masquerade: {}
              model: e1000e
              name: default
```

For VMs cloned from a shared template, edit the template once so every subsequent Windows VM inherits the tablet — this matches the OCP default and prevents the issue from recurring on each new VM.

### Why USB and not virtio

KubeVirt accepts `bus: virtio` for the input device, but the Windows in-box driver set does **not** include a virtio-input driver — it would require installing the virtio-win guest tools first, which is exactly the bootstrap step the user cannot complete because the mouse does not work yet. `bus: usb` uses the standard HID class and works on a clean Windows install.

## Diagnostic Steps

1. Confirm the running domain does not already expose a tablet. Inspect the VMI (the live instance), not just the VM template:

   ```bash
   kubectl get vmi "$VM_NAME" -n "$VM_NS" -o jsonpath='{.spec.domain.devices.inputs}'
   ```

   Empty output (or a missing key) confirms only the default PS/2 mouse is attached. A populated array with `"type":"tablet"` means the device is already declared and the misalignment has a different cause (see step 4).

2. Check the libvirt domain XML inside the virt-launcher pod for the actual `<input>` elements presented to QEMU:

   ```bash
   POD=$(kubectl get pod -n "$VM_NS" -l kubevirt.io/domain="$VM_NAME" -o name | head -1)
   kubectl exec -n "$VM_NS" "$POD" -c compute -- virsh dumpxml 1 \
     | grep -A1 '<input'
   ```

   A line like `<input type='tablet' bus='usb'/>` is what you want to see after the patch is applied. `<input type='mouse' bus='ps2'/>` only is the default, broken-for-VNC state.

3. Apply the patch from the Resolution section and restart the VM. Re-run step 2 — the tablet line must appear before reconnecting the VNC console.

4. After reconnecting the console, if the pointer still drifts, the cause is *not* the input device:

   - Check whether the VNC client is scaling the framebuffer (browser zoom level other than 100% can re-introduce misalignment).
   - Inside the guest, open **Settings → Devices → Mouse → Additional mouse options → Pointer Options** and turn off **Enhance pointer precision** — even with a tablet attached, the OS preference can still apply acceleration to certain code paths.
   - Confirm Windows recognized the tablet: **Device Manager → Human Interface Devices → HID-compliant pen** (or "HID-compliant touch screen") should be present without warning icons. If the device is missing, the VM may be booting from a cached configuration; force a clean restart with `virtctl stop` followed by `virtctl start`.

5. For a fleet that pre-dates this fix, list all Windows VMs that lack a tablet input and need patching:

   ```bash
   kubectl get vm -A -o json \
     | jq -r '.items[]
              | select(.spec.template.spec.domain.machine.type? // "" | test("q35"))
              | select((.spec.template.spec.domain.devices.inputs // [])
                       | map(.type) | index("tablet") | not)
              | "\(.metadata.namespace)\t\(.metadata.name)"'
   ```

   Combine with a label selector for the OS family if Windows VMs carry one in your environment (e.g., `os.template.kubevirt.io/windows*`).

## Related Information

- Upstream issue: [kubevirt/kubevirt#2392 — VNC mouse position not synced for Windows guests](https://github.com/kubevirt/kubevirt/issues/2392)
- KubeVirt API reference: `Devices.Inputs` field on `VirtualMachineInstanceSpec`.
- OpenShift Virtualization Windows templates ship the same `inputs: [{type: tablet, bus: usb}]` block by default, which is the reference behaviour ACP-managed templates should converge on.
