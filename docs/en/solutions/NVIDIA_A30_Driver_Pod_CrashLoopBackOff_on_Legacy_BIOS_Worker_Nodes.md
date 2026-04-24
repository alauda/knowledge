---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a worker node equipped with an NVIDIA A30 GPU, the driver DaemonSet pod (`nvidia-driver-daemonset-*`) refuses to initialize. It enters `CrashLoopBackOff` with hundreds of restarts, and the downstream `gpu-feature-discovery` pod stays stuck in `Init:0/1` because the driver never becomes ready:

```text
nvidia-driver-daemonset-xxx       1/2   CrashLoopBackOff   238   21h
gpu-feature-discovery-xxxx        0/1   Init:0/1           0     16h
```

Driver-container logs report:

```text
modprobe: ERROR: could not insert 'nvidia': No such device
```

And the host kernel ring buffer (`dmesg`) shows, for the PCI slot that carries the A30, a pair of messages of the form:

```text
NVRM: BAR1 is 0M @ 0x0 (PCI:0000:0b:00.0)
nvidia: probe of 0000:0b:00.0 failed with error -1
NVRM: None of the NVIDIA devices were initialized.
```

Other GPU models on similar hardware (notably the T4) come up without issue on the same node — so the problem looks GPU-model-specific rather than a generic driver or platform fault.

## Root Cause

The error `BAR1 is 0M @ 0x0` is the NVIDIA kernel module telling you that the platform firmware never allocated a usable PCI **Base Address Register (BAR1)** for the GPU. Without a BAR mapping, the driver cannot map device memory, so `modprobe nvidia` loads the module but the device probe fails and the driver reports zero GPUs.

Why it fails specifically on A30 and not on T4:

- The T4's BAR1 (frame-buffer aperture exposed to the CPU over PCIe) is small enough — typically around 256 MiB — that legacy BIOS firmware can place it in the low 32-bit (sub-4 GB) address region that legacy PCI allocation was designed for.
- The A30's BAR1 is **significantly larger** (on the order of tens of GiB) and cannot fit in the sub-4 GB region at all. Mapping it requires the firmware to allocate PCI address space **above 4 GB** — often called *Above-4G Decoding* or *64-bit BAR support* in firmware UIs.
- Legacy BIOS firmware commonly cannot allocate PCIe memory above the 4 GB line; either the feature is not implemented, or it is gated behind UEFI-only paths. The result is `BAR1 is 0M @ 0x0`: the BAR was nominally assigned, but at an empty window that the device cannot actually use.
- With no BAR mapping, the driver cannot register the device. `lspci` still shows the card (it is enumerated on the PCI bus) but `/proc/driver/nvidia/` on the affected host has no entry for it.

So the class of the problem is **firmware-level resource allocation**, not a software driver bug. The fix has to happen at the boot-firmware layer.

## Resolution

### Preferred: boot the affected nodes in UEFI mode

On ACP, GPU scheduling for NVIDIA devices is provided by the **Hami** extension (GPU scheduler with sharing support) and the **NVIDIA GPU Device Plugin** extension — together they replace the monolithic upstream NVIDIA GPU Operator path and expose GPU capacity to workloads through the `hardware_accelerator` capability. Both of these assume the NVIDIA kernel driver is alive on the node; neither can work around a missing BAR. The fix is at the firmware.

For affected nodes:

1. Reprovision the node so that it boots in **UEFI (EFI)** mode rather than legacy BIOS. On most platforms this is a BIOS-setup / boot-order choice; on virtualized workers it is the virtual machine's firmware-type setting. UEFI firmware routinely allocates 64-bit PCI address space and will place the A30's BAR1 above 4 GB automatically.

2. If UEFI is not an option (for example on an older server that simply does not have UEFI firmware), enable the BIOS-side equivalents that widen PCI allocation, when the firmware exposes them. The exact wording varies by vendor but the functional options are:
    - **Above 4G Decoding** — must be **Enabled**.
    - **PCI 64-bit BAR Support** (sometimes "Resizable BAR" or "Large BAR") — must be **Enabled**.
    - **MMIO High Allocation** / **MMIO High Granularity** — must be set to the largest available size, or **Auto**.

3. After the firmware change, reboot the node. Before scheduling GPU workloads back onto it, verify the driver initialized cleanly (see Diagnostic Steps). The NVIDIA driver pod should transition to `Running` on its own without manual intervention — no Kubernetes-level change is required once the firmware exposes the BAR.

4. Bring the node back into the cluster and let the GPU device plugin re-advertise capacity. `gpu-feature-discovery` will move off `Init:0/1` to `Running`, the node labels describing GPU capabilities will populate, and Hami will start scheduling GPU requests onto the node.

In virtualized-worker environments the same principle applies: the VM's firmware type must be UEFI (OVMF) rather than legacy BIOS, and the hypervisor must be configured to pass through enough PCI address space for the guest to allocate the A30's BAR1. Large-BAR pass-through has hypervisor-specific knobs; coordinate with the virtualization platform owner.

### Fallback: downgrade GPU choice if firmware cannot be changed

If the node firmware cannot be moved to UEFI and does not expose Above-4G / 64-bit BAR controls, the only workable option is to use a GPU whose BAR1 fits in sub-4 GB address space (T4 or similar small-BAR accelerators). The A30 cannot be made to work behind a legacy BIOS that refuses 64-bit PCI allocation; there is no driver-side workaround.

## Diagnostic Steps

Confirm the failure mode first: the symptom is "driver loads, device probe fails, no BAR". From a shell on the affected host:

```bash
lspci -nn | grep -i nvidia
```

The card should enumerate — for example as `3D controller ... NVIDIA ... GA100GL [A30] ...`. If it does not enumerate at all, the problem is elsewhere (hardware seating, PCIe lane allocation) and BAR/MMIO is not the story.

Then read the kernel ring buffer for the PCI address of the card:

```bash
dmesg | grep -iE 'NVRM|nvidia'
```

The diagnostic triplet is `NVRM: BAR1 is 0M @ 0x0`, `probe of <addr> failed with error -1`, `None of the NVIDIA devices were initialized`. If those three appear together, it is a BAR-allocation problem.

Check whether the driver actually registered any device node:

```bash
ls -l /proc/driver/nvidia/ 2>/dev/null || echo '(no /proc/driver/nvidia — driver did not bind)'
ls /dev/nvidia* 2>/dev/null     || echo '(no /dev/nvidia* — driver did not bind)'
```

Empty output confirms the driver module loaded but no device bound — consistent with the BAR hypothesis.

Confirm the current firmware boot mode:

```bash
bootctl status
```

`Firmware: UEFI ...` is what you want on an A30-equipped node. `Firmware: BIOS ...` (or equivalent legacy indication) is the marker that the node is stuck in the problematic mode.

From the cluster side, inspect the stuck driver pod's logs for the same signature, so the firmware-level finding can be tied to the Kubernetes-level symptom:

```bash
kubectl -n <gpu-operator-namespace> logs \
  pod/nvidia-driver-daemonset-<hash> -c nvidia-driver-ctr
```

The logs echo the same `modprobe: ERROR: could not insert 'nvidia'` that the host sees, confirming this is a platform-level BAR problem rather than a misconfigured DaemonSet.

After reprovisioning the node to UEFI, the healthy post-reboot state is:

- `dmesg | grep -i NVRM` shows no errors; BAR1 is assigned a non-zero size at an address above `0x100000000` (the 4 GB line).
- `nvidia-smi` (in the driver container or on the host if available) lists the A30 with its full memory.
- The driver DaemonSet pod reports `Running` and `gpu-feature-discovery` transitions to `Running`; the node gains the expected GPU-capacity labels and allocations start succeeding.
