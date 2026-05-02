---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Disabling Virtualization-Based Security (VBS) in a Windows Guest on ACP Virtualization
## Issue

A Windows VM running on ACP Virtualization shows lower-than-expected CPU performance, especially on workloads that make heavy system calls, touch memory frequently, or rely on low-latency I/O. The administrator suspects Virtualization-Based Security (VBS) — a set of Hyper-V enlightenment features enabled by default on modern Windows builds — and wants to disable it for VMs that do not need it.

Symptoms reported:

- Benchmarks (CPU-intensive workloads, database micro-benchmarks) come in 10–30% slower than a bare-metal or non-VBS guest of the same shape.
- `Get-CimInstance -ClassName Win32_DeviceGuard` inside the guest reports VBS as running (`VirtualizationBasedSecurityStatus: 2`).
- Windows Defender Credential Guard and Memory Integrity (HVCI) are present, even though the workload has no need for them.

## Root Cause

Windows 10 / 11 and Windows Server 2019+ ship with VBS components that rely on **nested virtualization** inside the guest:

- VBS itself runs a small isolated hypervisor (Secure Kernel) in the guest, which in turn runs above the cluster's host hypervisor (KVM + KubeVirt's `virt-launcher`). This is two levels of virtualization — the outer level handled by the host CPU, the inner by the guest.
- Credential Guard stores domain secrets inside that isolated secure kernel; Memory Integrity (HVCI) enforces code-signing in the same isolated context.
- Each of these features introduces additional VM-exits on privileged operations (page table updates, MSR writes, etc.), which the host hypervisor must emulate. The more frequent these exits, the larger the performance penalty.

The security benefit is real — but it is wasted on a VM that is not part of an Active Directory domain, does not store credentials locally, or runs a pure workload (CI runner, batch job, analytics engine). In those cases the VBS performance tax is pure overhead.

The fix has two sides. Inside the guest, disable VBS / HVCI / Credential Guard via the Windows registry and reboot. On the ACP VM spec, drop the nested-virtualization Hyper-V flags so KubeVirt stops exposing the feature bits the guest uses to turn VBS back on.

## Resolution

### Step 1 — decide whether to disable

Before turning VBS off, confirm the security trade-off is acceptable:

- **Keep VBS on**: VMs that join an Active Directory domain, store Kerberos TGTs, run third-party apps that rely on Credential Guard, or are subject to a compliance standard that mandates HVCI.
- **Safe to turn off**: isolated workloads (databases, build agents, compute-only VMs), VMs behind a trusted internal network, or VMs where the performance loss is blocking a business requirement.

Document the decision in the VM's change record — security-review signoff is usually required.

### Step 2 — disable VBS inside the Windows guest

Microsoft's [Enable virtualization-based protection of code integrity](https://learn.microsoft.com/en-us/windows/security/hardware-security/enable-virtualization-based-protection-of-code-integrity?tabs=reg) documents the exact registry keys. The relevant ones to set to `0` for a full disable:

```powershell
# Run in an elevated PowerShell session inside the guest.
$base = "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard"
New-Item -Path $base -Force | Out-Null
Set-ItemProperty -Path $base -Name "EnableVirtualizationBasedSecurity" -Value 0 -Type DWord
Set-ItemProperty -Path $base -Name "RequirePlatformSecurityFeatures" -Value 0 -Type DWord
Set-ItemProperty -Path $base -Name "LsaCfgFlags" -Value 0 -Type DWord

$scenarios = "$base\Scenarios"
Set-ItemProperty -Path "$scenarios\HypervisorEnforcedCodeIntegrity" -Name "Enabled" -Value 0 -Type DWord
Set-ItemProperty -Path "$scenarios\CredentialGuard" -Name "Enabled" -Value 0 -Type DWord
```

Also disable Credential Guard via Group Policy (if managed that way) so it is not re-enabled on next domain sync:

- **Local Group Policy Editor** → Computer Configuration → Administrative Templates → System → Device Guard → **Turn On Virtualization Based Security** → **Disabled**.

Reboot the guest. The registry changes take effect only on boot.

### Step 3 — remove the Hyper-V enlightenment flags from the VM spec

VBS still requires the host to expose the CPU feature bits (`HV_FEATURE_EX`, `HV_SYNIC`, etc.) that the guest enters to set up its inner hypervisor. Removing those bits stops Windows from ever attempting to re-enable VBS on its own.

Edit the VirtualMachine:

```bash
NS=<vm-namespace>
VM=<vm-name>
kubectl -n "$NS" edit vm "$VM"
```

In `.spec.template.spec.domain.features.hyperv`, remove (or set to `false`) the flags that expose nested-virt capabilities:

```yaml
spec:
  template:
    spec:
      domain:
        features:
          hyperv:
            # Keep the basic enlightenments — they are safe and improve perf:
            relaxed:
              enabled: true
            vapic:
              enabled: true
            spinlocks:
              enabled: true
              spinlocks: 8191
            # Drop / disable the ones VBS uses:
            # synic:        {enabled: false}   # remove if present
            # synictimer:   {enabled: false}
            # vpindex:      {enabled: false}
            # vendorid:     {enabled: false}
            # ipi:          {enabled: false}
            # tlbflush:     {enabled: false}
            # evmcs:        {enabled: false}   # Intel nested-virt enlightenment
```

Specifically remove any entry under `hyperv` whose name maps to a Hyper-V "management" or "synthetic interrupt" feature — `synic`, `synictimer`, `vpindex`, `ipi`, `tlbflush`, `evmcs`. Keep `relaxed`, `vapic`, and `spinlocks` — those are pure enlightenments with no nested-virt dependency and can improve performance.

If the VM has `.spec.template.spec.domain.cpu.features` that enable nested-virt CPU bits (`vmx` on Intel, `svm` on AMD), remove those too.

Also disable secure-boot / TPM resources when they are present only to satisfy VBS:

```yaml
spec:
  template:
    spec:
      domain:
        firmware:
          bootloader:
            efi:
              secureBoot: false          # from true
          # Remove or do not add the tpm block:
          # tpm: {}
```

### Step 4 — apply and power-cycle the VM

KubeVirt applies domain changes on the next power-on of the VM, not on live reconfigure:

```bash
kubectl -n "$NS" virtctl stop "$VM"
# Wait for the VMI to disappear
until ! kubectl -n "$NS" get vmi "$VM" >/dev/null 2>&1; do sleep 2; done
kubectl -n "$NS" virtctl start "$VM"
```

### Step 5 — verify VBS is off inside the guest

After the VM comes back up and Windows has finished booting, log in as admin and run:

```powershell
Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard |
  Format-List VirtualizationBasedSecurityStatus,
              SecurityServicesConfigured,
              SecurityServicesRunning
```

Expected output when VBS is fully off:

```
VirtualizationBasedSecurityStatus : 0
SecurityServicesConfigured        : {}
SecurityServicesRunning           : {}
```

`0` means "not enabled"; `1` means "enabled but not running"; `2` means "running". Any value other than `0` indicates Step 2 or Step 3 was incomplete — re-read the registry keys and the Hyper-V feature list and reboot once more.

### Step 6 — re-run the workload benchmark

Run the same CPU / syscall / memory benchmark that first surfaced the issue. Compare against the pre-change baseline. A successful disable typically recovers 10–30% of the runtime, depending on how often the workload traps into the kernel.

Record the before/after numbers in the change record — they are useful if the security team later asks why VBS is off on this particular VM.

## Diagnostic Steps

Check whether VBS is running inside the guest without logging in, using the VNC console or the KubeVirt serial console to run the one-line PowerShell query above.

Inspect the VM spec for the Hyper-V enlightenment flags that matter:

```bash
NS=<vm-namespace>
VM=<vm-name>
kubectl -n "$NS" get vm "$VM" -o=yaml | \
  yq '.spec.template.spec.domain | {cpu: .cpu.features, hyperv: .features.hyperv, firmware: .firmware}'
```

A VM still exposing `synic`, `synictimer`, `vpindex`, or `ipi` under `.features.hyperv`, or `vmx` / `svm` under `.cpu.features`, is still offering the nested-virt surface that VBS will consume.

Measure the VM-exit rate on the host before and after the change to quantify the overhead. On a node running the VM, open a debug shell:

```bash
# Find the virt-launcher pod and its node:
kubectl -n "$NS" get vmi "$VM" -o=jsonpath='{.status.nodeName}'

# On that node:
oc=$(kubectl get pod -n "$NS" -l kubevirt.io=virt-launcher -o=jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" exec "$oc" -- perf kvm stat live -d 30
```

A VM with VBS running typically shows 5–15× more VM-exits per second than the same VM with VBS disabled, dominated by `EPT_VIOLATION`, `MSR_WRITE`, and `CR_ACCESS` exit reasons.

If the benchmark does not recover after all steps, the remaining overhead is unlikely to be VBS — look elsewhere (NUMA imbalance, non-dedicated CPU, host-level contention).
