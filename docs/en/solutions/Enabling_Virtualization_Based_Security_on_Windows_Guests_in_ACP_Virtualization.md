---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Operators running Microsoft Windows guests on ACP Virtualization want to enable Virtualization-Based Security (VBS) inside the guest. VBS is a Windows security stack (Credential Guard, Device Guard, HVCI) that relies on the guest OS running its own hypervisor-style isolation boundary on top of the host hypervisor — it therefore imposes specific requirements on the `VirtualMachine` spec that are not defaulted.

Turning the in-guest policy on without the matching `VirtualMachine` spec fields either fails silently (Windows refuses to enable VBS and logs an error in the System event log) or enables it in a degraded mode. This note enumerates the features the VM must expose and gives a working `VirtualMachine` manifest fragment.

## Root Cause

VBS is a composite feature. For Windows to enable it, the guest must see **all** of the following:

1. **vTPM** — a virtualised TPM 2.0 device presented to the guest. VBS uses it for key sealing.
2. **UEFI with Secure Boot** — firmware that can enforce signed-boot chain. Legacy BIOS is not sufficient.
3. **Nested virtualization** — exposure of the host CPU's virtualization extension (VT-x / AMD-V) to the guest, so the guest can itself run a hypervisor. This is what lets Windows create the VBS secure world.
4. **Hyper-V enlightenments** — a cluster of paravirtual interfaces (timers, IPI, synic, vpindex, etc.) that Windows uses to run efficiently as a guest and that VBS specifically relies on for cross-boundary signalling.

All four map onto explicit fields in the KubeVirt `VirtualMachine` spec. Missing any of them breaks VBS enablement in the guest.

Nested virtualization additionally requires the underlying worker node's CPU to have virtualization extensions **enabled in firmware** and exposed to the kernel (`kvm_intel` / `kvm_amd` module loaded with `nested=1`). If the node is itself a VM on another hypervisor, the outer hypervisor must also expose virtualization extensions into the node — otherwise the `require` policy on the `vmx` / `svm` CPU feature prevents the guest from starting.

VBS carries a performance cost because every privileged operation crosses an additional boundary inside Windows. Enabling HVCI (Hypervisor-Enforced Code Integrity) on top of VBS adds a second layer. Measure the workload under realistic load after enabling and tune CPU pinning / NUMA topology if latency-sensitive.

## Resolution

### Confirm the host is nested-virtualization capable

On each worker node that will host Windows VBS guests, verify the CPU flag and the KVM module's `nested` option:

```bash
NODE=<worker-name>
kubectl debug node/$NODE --image=busybox -- \
  sh -c '
    chroot /host sh -c "grep -Eo \"(vmx|svm)\" /proc/cpuinfo | head -1
                        cat /sys/module/kvm_intel/parameters/nested 2>/dev/null ||
                        cat /sys/module/kvm_amd/parameters/nested 2>/dev/null"
  '
```

The first line should print `vmx` (Intel) or `svm` (AMD); the second should print `Y` or `1`. If `nested` is `N` / `0`, enable it through the cluster's node configuration channel (the kernel argument is `kvm_intel.nested=1` for Intel or `kvm_amd.nested=1` for AMD) and reboot the node.

### Configure the `VirtualMachine` manifest

Express all four VBS requirements on the VM spec. The fragment below is the minimal set — omit anything already in the VM and merge the rest in:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: win11-vbs
  namespace: my-vms
spec:
  template:
    spec:
      domain:
        # 1. vTPM — persistent so key material survives reboots.
        devices:
          tpm:
            persistent: true

        # 2. UEFI + Secure Boot — efi.secureBoot implies SMM.
        firmware:
          bootloader:
            efi:
              persistent: true
              secureBoot: true

        # 3. Nested virtualization — expose vmx (Intel) or svm (AMD) to guest.
        #    `require` means the VM fails to schedule on a host that can't
        #    provide the feature, instead of starting without VBS support.
        cpu:
          features:
            - name: vmx           # use `svm` on AMD worker nodes
              policy: require

        # 4. Hyper-V enlightenments — the cluster of features VBS relies on.
        clock:
          timer:
            hyperv: {}
        features:
          acpi: {}
          apic: {}
          smm: {}                   # required for secureBoot + VBS
          hyperv:
            relaxed: {}
            vapic: {}
            vpindex: {}
            synic: {}
            synictimer:
              direct: {}
            ipi: {}
            runtime: {}
            reset: {}
            reenlightenment: {}
            spinlocks:
              spinlocks: 8191
            frequencies: {}
            tlbflush: {}
            evmcs: {}               # Intel only; drop on AMD hosts
```

Apply the manifest and start the VM. Log in to the guest and enable VBS through the standard Windows tooling (Group Policy under **Computer Configuration → Administrative Templates → System → Device Guard**, or the Registry key `HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard\EnableVirtualizationBasedSecurity = 1`). Reboot the guest and verify.

### Verify VBS is active inside the guest

From an elevated PowerShell prompt on the Windows VM:

```powershell
Get-CimInstance -ClassName Win32_DeviceGuard `
  -Namespace root\Microsoft\Windows\DeviceGuard |
  Select-Object -Property *Running*, *Configured*, *Virtualization*
```

The output includes `VirtualizationBasedSecurityStatus` (`2` = running), `SecurityServicesRunning` (`1` = VBS, `2` = HVCI), and the list of features that **can** run on this hardware given what the VM exposes. If `VirtualizationBasedSecurityStatus = 0`, open the System event log and look for the `Hyper-V-Hypervisor` source to see which requirement was not satisfied.

## Diagnostic Steps

If the VM does not start, describe it and look at `virt-launcher` events:

```bash
kubectl -n my-vms get vm win11-vbs -o jsonpath='{.status.conditions}{"\n"}' | jq
kubectl -n my-vms describe vmi win11-vbs
kubectl -n my-vms get pod -l kubevirt.io/domain=win11-vbs
```

A `require` policy failure on `vmx` / `svm` surfaces as a scheduling failure; the `virt-launcher` pod never comes up and the VMI stays in `Scheduling`. Check a candidate node actually advertises the CPU feature:

```bash
kubectl get node -o custom-columns='NAME:.metadata.name,VMX:.metadata.labels.cpu-feature\\.node\\.kubevirt\\.io/vmx'
```

Nodes that do not advertise the feature either lack nested virtualization in firmware, have `kvm_intel.nested` / `kvm_amd.nested` disabled, or are themselves VMs on a hypervisor that does not expose virtualization extensions inward.

If the VM starts but Windows does not enable VBS, the System event log is the authoritative source. Common entries:

- `Hypervisor launch failed; Hyper-V components were not available` — the nested CPU feature is not exposed to the guest. Re-check the `cpu.features` stanza with `policy: require`.
- `Secure Boot is not enabled on this machine` — `firmware.bootloader.efi.secureBoot` is missing or the OVMF variables have been regenerated without Secure Boot keys. Re-apply the VM with `persistent: true`.
- `The TPM is not ready for use` — `devices.tpm.persistent` missing. VBS sealed keys need a persistent vTPM; a non-persistent one appears fresh on every boot.
- `Code Integrity determined that a process (\Device\HarddiskVolume…) attempted to load a driver that did not meet the Code Integrity requirements` — HVCI is enabled and the guest's driver stack has unsigned drivers. Resolve at the driver level; HVCI cannot tolerate unsigned kernel modules.

Finally, observe the CPU overhead. Measure the workload's CPU utilisation with and without VBS enabled on an otherwise identical VM — the delta informs whether HVCI is worth enabling on top, and whether CPU pinning or dedicated node affinity is needed for latency-sensitive guests.
