---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

The Virtualization area of the platform runs virtual machines on top of KubeVirt, which in turn launches guest workloads inside `qemu-kvm` processes wrapped by `virt-launcher` pods. Because the guest operating system runs on the same QEMU/KVM stack used by mainstream Linux virtualization, almost any OS that boots on `qemu-kvm` will start. "Will boot" is not the same as "is supported", however — only a subset of guest operating systems are validated by the platform and shipped with `virtio` driver paths, machine-type defaults, and support commitments.

This article describes how to read the guest-OS support matrix for the platform's KubeVirt-based virtualization, and how to verify that a candidate guest OS is on the supported list before designing a VM workload around it.

## Resolution

### What "Supported" Means in Practice

A supported guest OS has three properties that an unsupported one does not:

1. **Validated boot path.** The platform team has booted a stock image of the guest OS with the default `MachineType`, paravirtual `virtio-net-pci` NIC, and `virtio-blk` disk and confirmed it reaches login. Issues filed against a supported guest OS receive engineering attention; issues against an unsupported guest OS are best-effort.
2. **Driver coverage.** For Linux guests, a kernel that includes the upstream `virtio_*` modules. For Windows guests, the platform ships a signed `virtio-win` driver ISO that auto-mounts as a CD-ROM device when a Windows template is selected; this gives the guest installer working storage and network drivers without manual user action.
3. **Lifecycle alignment.** A guest OS that has been declared end-of-life by its vendor is removed from the support matrix one platform release after the vendor's EOL. The matrix never lists "extended support" community builds — only OS releases that the original vendor still ships security errata for.

### Where the Authoritative Matrix Lives

Each release of the Virtualization stack publishes a guest-OS support matrix. The matrix is keyed by:

- **OS family** — for example, a major Linux distribution, Windows Server, or Windows Desktop.
- **OS version** — the specific release within the family (kernel major.minor for Linux, build number for Windows).
- **Machine type** — `q35`, `pc-i440fx`, etc. Most modern guests use `q35`.
- **Architecture** — `x86_64`, `aarch64`. Not every guest OS is supported on every architecture even if the same OS family is.

Treat the matrix as a *checklist*: a candidate guest must match on family, version, machine type, and architecture before declaring it supported.

### Selecting a Supported Guest at VM Creation Time

VM creation refers to the supported list through a `VirtualMachineImageTemplate` (or equivalent template object provided by the Virtualization area). The template carries:

- The pre-validated cloud image's container disk reference.
- A default `domain.machine.type` matching the validated machine type.
- Default disk and NIC interfaces (`virtio-blk`, `virtio-net-pci`).
- For Windows templates, a pre-attached `virtio-win` CD-ROM definition.

Always start a new VM from a published template rather than crafting a `VirtualMachine` spec from scratch — this is the single most reliable way to land on a supported guest OS configuration.

```bash
# Inspect the templates available on the cluster
kubectl get virtualmachineimagetemplates -A

# Describe a specific template to see the guest OS, machine type,
# and default interfaces it sets
kubectl describe virtualmachineimagetemplate <template-name> -n <namespace>
```

### Booting an Unsupported Guest

Unsupported guests can still be useful for evaluation, internal tooling, or driver development. Two adjustments make the experience smoother:

- **Disable virtio acceleration** when the guest kernel lacks `virtio_*` modules; fall back to emulated `e1000` NIC and `sata` disk in the VM spec. This is significantly slower but boots virtually any OS.
- **Mount a virtio driver ISO** if the unsupported guest is Windows and you want better-than-emulated performance. Bring your own driver ISO; do not assume the platform-shipped one will be compatible.

Boot an unsupported guest at your own risk:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: unsupported-guest-eval
spec:
  template:
    spec:
      domain:
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: sata        # not virtio
          interfaces:
            - name: default
              model: e1000       # not virtio
              masquerade: {}
```

Do not deploy unsupported guests for production workloads — the support matrix exists precisely to mark which guest OSes the platform team will sustain across upgrades.

## Diagnostic Steps

Confirm the guest OS reported inside the VM matches what the platform thinks is running:

```bash
# Discover the VMI representing the running VM
kubectl get vmi -n <namespace>

# Read the guest-agent-reported OS info
kubectl get vmi <vmi-name> -n <namespace> \
  -o jsonpath='{.status.guestOSInfo}'
```

If `guestOSInfo` is empty, the `qemu-guest-agent` is not installed or not running inside the guest; install it before relying on guest-agent-driven features such as freeze/thaw snapshots or live migration drain hooks.

Confirm the machine type and CPU model the platform actually launched the guest with:

```bash
kubectl get vmi <vmi-name> -n <namespace> \
  -o jsonpath='{.spec.domain.machine.type}{"\n"}{.spec.domain.cpu.model}{"\n"}'
```

If either differs from what the support matrix expects for the chosen guest OS, edit the originating `VirtualMachine` spec to align — divergence here is the most common reason a supported guest behaves like an unsupported one.
</content>
</invoke>