---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
---

# Use USB Redirection for KubeVirt VMs on ACP

## Overview

ACP Virtualization can expose USB devices to a KubeVirt VirtualMachine in two different ways:

- **USB host passthrough** attaches a USB device that is physically connected to a worker node. This is the better fit for fixed, long-lived devices and performance-sensitive workloads.
- **USB Redirection**, also called client passthrough, redirects a USB device from the workstation that runs `virtctl usbredir` into a running VirtualMachineInstance (VMI). This is the better fit for temporary, user-held, low-throughput devices.

USB Redirection is not hardware passthrough. Traffic flows through the client, the Kubernetes and KubeVirt subresource connection, `virt-handler`, `virt-launcher`, and the QEMU usbredir channel before it reaches the guest OS. Use it for flexible access to temporary USB peripherals, not as a high-throughput storage or low-latency control path.

Recommended use cases:

| Use case | Recommended mechanism | Reason |
| --- | --- | --- |
| USB device is fixed on a worker node and should stay attached to one VM | USB host passthrough | Shorter path, clearer device ownership, better performance |
| User or operator needs to temporarily redirect a local USB device to a VM | USB Redirection | The device does not need to be present on a worker node |
| USB flash drive or external disk used for long-running data transfer | Prefer PVCs, image import, SCP/SSH, object storage, or host passthrough | USB Redirection adds network and userspace forwarding overhead |
| USB token, smart card reader, serial adapter, barcode scanner | USB Redirection, after device-level validation | Low-throughput interaction usually fits this model |
| Industrial control, audio/video capture, or strict timing workloads | Host passthrough or a dedicated hardware design | USB Redirection is sensitive to latency and jitter |

## Prerequisites

The cluster side must meet these conditions:

- ACP Virtualization is installed and healthy.
- ACP 4.3.x or later Virtualization is used. These ACP KubeVirt builds include the USB Redirection subresource and the `clientPassthrough` API field.
- The running VMI has `spec.domain.devices.clientPassthrough` configured. Updating the VM template is not enough for a running VMI; restart the VM so a new `virt-launcher` pod and QEMU domain are created with usbredir slots.

The client side is the machine where the USB device is physically connected and where `virtctl usbredir` runs. For Linux clients, install:

- `virtctl` compatible with the ACP Virtualization version.
- `usbredirect`.
- `lsusb`, usually from the `usbutils` package.

The client must be able to reach the Kubernetes API endpoint for the target cluster and keep the `virtctl usbredir` streaming connection open. It does not need direct network access to worker nodes, the `virt-launcher` pod, the VM IP address, or the guest SSH port. SSH or console access to the guest is only needed if you want to verify the redirected device from inside the OS.

On Debian or Ubuntu based clients:

```bash
sudo apt-get install -y usbredirect usbutils
```

Managing local USB devices usually requires privileged access, so run `virtctl usbredir` with `sudo` unless a site-specific udev rule grants the required access.

Windows clients require the Windows build of `usbredirect` and UsbDk, and `usbredirect` must be in `PATH`. Before using Windows as a supported delivery workflow, validate the full client setup in your Windows environment: confirm that `usbredirect` is discoverable from the terminal, UsbDk can access the target USB device, and a trial `virtctl usbredir` session can attach and detach the device cleanly.

## Grant Minimal RBAC

Users need read access to the VMI and `get` access to the `virtualmachineinstances/usbredir` subresource. ACP's built-in KubeVirt `admin` and `edit` roles normally include this permission; the `view` role does not include USB Redirection access.

For a least-privilege namespace-scoped role, create a Role and RoleBinding like this:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: vm-usbredir
  namespace: <vm-namespace>
rules:
  - apiGroups: ["kubevirt.io"]
    resources: ["virtualmachineinstances"]
    verbs: ["get"]
  - apiGroups: ["subresources.kubevirt.io"]
    resources: ["virtualmachineinstances/usbredir"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: vm-usbredir
  namespace: <vm-namespace>
subjects:
  - kind: User
    apiGroup: rbac.authorization.k8s.io
    name: <user-name>
roleRef:
  kind: Role
  apiGroup: rbac.authorization.k8s.io
  name: vm-usbredir
```

Verify the permission:

```bash
kubectl auth can-i get virtualmachineinstances/usbredir.subresources.kubevirt.io \
  -n <vm-namespace>
```

The expected result is:

```text
yes
```

## Enable USB Redirection on a VM

Add `clientPassthrough: {}` under `spec.template.spec.domain.devices` in the VM template.

For a new VM manifest, include the following field. Only the fields relevant to USB Redirection are shown:

```yaml
spec:
  template:
    spec:
      domain:
        devices:
          clientPassthrough: {}
```

For an existing VM, patch the template:

```bash
kubectl patch vm <vm-name> -n <vm-namespace> --type=merge \
  -p '{"spec":{"template":{"spec":{"domain":{"devices":{"clientPassthrough":{}}}}}}}'
```

Restart the VM so the running VMI receives the new device configuration:

```bash
virtctl restart <vm-name> -n <vm-namespace>
```

Confirm that the running VMI contains the field:

```bash
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.domain.devices.clientPassthrough}{"\n"}'
```

Expected output:

```text
{}
```

When `clientPassthrough` is set, KubeVirt creates four QEMU usbredir slots for the VMI. To inspect the live domain:

```bash
POD=$(kubectl get pod -n <vm-namespace> -l kubevirt.io/domain=<vm-name> \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n <vm-namespace> "$POD" -c compute -- \
  virsh dumpxml 1 | grep -A4 '<redirdev'
```

The domain XML should contain redirection devices backed by paths similar to `virt-usbredir-0` through `virt-usbredir-3`.

## Redirect a Client USB Device

On the client machine, list USB devices:

```bash
lsusb
```

Example output:

```text
Bus 002 Device 003: ID 0951:1666 Kingston Technology DataTraveler 100 G3
```

Redirect by vendor and product ID:

```bash
sudo virtctl -n <vm-namespace> usbredir 0951:1666 <vm-name>
```

Alternatively, redirect by bus and device address:

```bash
sudo virtctl -n <vm-namespace> usbredir 02-03 <vm-name>
```

Keep the `virtctl usbredir` process running for as long as the device should remain attached. Press `Ctrl+C` to disconnect. If the client process exits, the client network disconnects, the USB device is unplugged, the VM restarts, or the `virt-launcher` pod is recreated, the guest loses the redirected device and you must run `virtctl usbredir` again.

## Verify in the Guest

Log in to the guest OS and confirm that the USB device is visible:

```bash
lsusb
```

For USB storage devices used only for validation, also check block devices:

```bash
lsblk -f
blkid
```

Do not mount the same storage device on the client and guest at the same time. If you must validate a USB flash drive or card reader, unmount it on the client first and prefer read-only access in the guest:

```bash
sudo mkdir -p /mnt/usb
sudo mount -o ro /dev/sdX1 /mnt/usb
ls -la /mnt/usb
sudo umount /mnt/usb
```

Replace `/dev/sdX1` with the partition name shown inside the guest.

## Limitations and Risks

USB Redirection depends on `usbredirect`, the client OS USB stack, KubeVirt subresource streaming, QEMU usbredir support, and the guest OS driver. A device may enumerate successfully but still fail at the business-application layer because of driver, protocol, latency, or timing requirements.

Important limitations:

- One VMI gets four USB Redirection slots.
- The redirection session is tied to the running client process and the current VMI/`virt-launcher` lifecycle.
- Client network interruptions remove the device from the guest.
- API server, load balancer, or proxy idle timeouts may affect long-lived sessions.
- High-throughput storage, real-time control, and audio/video devices are poor fits.
- USB storage devices can be corrupted if mounted by both the client and guest.

Validate each sensitive device model, especially USB tokens, smart card readers, serial adapters, and devices with strict timing behavior.

## Troubleshooting

### `Not configured with USB Redirection`

The running VMI does not contain `clientPassthrough`.

Check the live VMI:

```bash
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.domain.devices.clientPassthrough}{"\n"}'
```

If the output is empty, patch the VM template and restart the VM.

### `VMI not running`

The target VMI is not in `Running` state.

```bash
virtctl start <vm-name> -n <vm-namespace>
kubectl wait vmi/<vm-name> -n <vm-namespace> --for=condition=Ready --timeout=180s
```

### `Error on finding usbredirect in $PATH`

The client cannot find the `usbredirect` binary.

```bash
sudo apt-get install -y usbredirect
which usbredirect
```

### `Could not init libusb` or permission denied

The local user cannot take control of the USB device.

```bash
sudo virtctl -n <vm-namespace> usbredir <vendor>:<product> <vm-name>
```

For a longer-term Linux client setup, create a site-approved udev rule for the device.

### No free USB Redirection slot

The VMI may already have four active USB Redirection sessions, or an old local client process may still be running.

On the client machine:

```bash
pgrep -af 'virtctl.*usbredir|usbredirect'
```

Stop only the stale process that owns the old session, then retry.

### Client storage device does not return as `/dev/sdX` after disconnect

Some USB storage devices may remain unbound from the client storage driver after a redirection session ends. First try a physical unplug and replug. If physical replug is not possible, inspect the local USB tree:

```bash
lsusb -t
```

If the relevant interface shows `Driver=[none]`, rebind it to `usb-storage` using the interface ID shown on the client:

```bash
sudo modprobe usb-storage
echo -n '<usb-interface-id>' | sudo tee /sys/bus/usb/drivers/usb-storage/bind
```

The interface ID looks like `3-4:1.0`, but it must be taken from the actual client host.

## Related Information

- KubeVirt Client Passthrough: https://github.com/kubevirt/user-guide/blob/main/docs/compute/client_passthrough.md
- KubeVirt v1.7.0 USB Redirection validation: https://github.com/kubevirt/kubevirt/blob/v1.7.0/pkg/virt-api/rest/usbredir.go
- KubeVirt v1.7.0 `clientPassthrough` API field: https://github.com/kubevirt/kubevirt/blob/v1.7.0/staging/src/kubevirt.io/api/core/v1/schema.go
- usbredir project: https://gitlab.freedesktop.org/spice/usbredir/
