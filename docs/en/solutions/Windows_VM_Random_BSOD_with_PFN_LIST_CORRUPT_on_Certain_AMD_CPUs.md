---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Windows guest running as a KubeVirt virtual machine on an ACP Virtualization cluster stops with a bugcheck screen carrying the stop code `PFN_LIST_CORRUPT` (numeric code `0x4E`). The crash is random: uptime can range from minutes to days, the workload inside the guest varies, and no single Windows update, driver, or application reliably reproduces it. Crashdumps opened in WinDbg consistently show `PFN_LIST_CORRUPT` as the stop code.

The failure is observed on nodes backed by specific AMD CPU families and does not reproduce on Intel nodes with otherwise-identical VM configuration.

## Root Cause

`PFN_LIST_CORRUPT` is the Windows kernel's signal that the Page Frame Number (PFN) database — the structure describing every physical page of memory the OS is managing — is inconsistent with what the MMU actually returned. In a bare-metal context this is typically a memory-corruption or driver bug. In a virtualized context on affected AMD silicon, the underlying cause is not Windows: it is CPU errata in AMD Family 1Ah Models 00h–0Fh processors, specifically:

- Erratum 1617 — **Speculative Translation Table Access Used for TLB Entry Generation**. Speculative page-table walks can populate TLB entries from transient state, producing a translation the OS did not intend.
- Erratum 1621 — **Spurious Page Fault for Some Initial Page Allocation Mappings**. The CPU can raise a page fault for a mapping that is actually valid, corrupting the guest OS's expectations about fresh allocations.

Either erratum is sufficient on its own to hand the Windows guest a page translation or fault signal that conflicts with what the kernel's PFN tracker believes to be true. Windows sees the mismatch and takes the only safe action it can — a BSOD with `PFN_LIST_CORRUPT`. KubeVirt / virt-launcher are not involved in the crash path; the same errata manifest on bare-metal Windows on the same CPUs.

Because the errata are in silicon, the durable fix is a CPU microcode update that serializes or suppresses the problematic speculation. AMD has published a fixed microcode (revision `0xb002151` or later) for the affected family.

## Resolution

### Preferred: Apply the vendor microcode update to the affected hosts

The only root-cause fix is microcode. Coordinate with the hardware vendor for the node OS running underneath the ACP Virtualization compute nodes and roll out a firmware / microcode package that includes AMD revision `0xb002151` or later.

1. **Identify affected nodes.** Inventory the hypervisor hosts by CPU family. On a Linux-based node OS:

   ```bash
   # From a node shell or via kubectl debug node/<node>:
   grep -E 'vendor_id|model|cpu family|microcode' /proc/cpuinfo | sort -u
   ```

   Any host reporting AMD Family 1Ah (`cpu family: 26`, model `00h`–`0Fh`) is a candidate. Note the current `microcode` revision for comparison after the update.

2. **Stage the firmware update.** Work with the hardware vendor to obtain a BIOS/firmware package that includes the fixed AMD microcode, or deploy the microcode via the node OS's microcode loader (for example, an `intel-ucode` / `amd-ucode` equivalent package — name depends on distribution). The microcode loader is part of early boot and cannot be applied at runtime in a way that survives reboot, so plan for a rolling node update.

3. **Drain and update one compute node at a time.** ACP Virtualization honors pod disruption for VMs via `VirtualMachineInstanceMigration`:

   ```bash
   # Cordon the node so new VMs are not scheduled onto it
   kubectl cordon <node>

   # Live-migrate every VMI off the node
   for vmi in $(kubectl get vmi -A \
       -o jsonpath='{range .items[?(@.status.nodeName=="<node>")]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'); do
     ns=${vmi%/*}; name=${vmi#*/}
     cat <<EOF | kubectl apply -f -
   apiVersion: kubevirt.io/v1
   kind: VirtualMachineInstanceMigration
   metadata:
     name: drain-${name}-$(date +%s)
     namespace: ${ns}
   spec:
     vmiName: ${name}
   EOF
   done

   # Once VMIs have moved, reboot the node to pick up the new microcode
   ```

4. **Verify the microcode level post-reboot.**

   ```bash
   grep microcode /proc/cpuinfo | head -1
   # Expect a revision >= 0xb002151
   ```

5. **Uncordon and proceed to the next node.**

### Workaround if microcode cannot be applied immediately

While the microcode rollout is in flight, Windows guests on affected hosts remain exposed. Two mitigations help reduce the *blast radius* but do not eliminate the root cause:

- **Pin Windows VMs to nodes that are already updated.** Use node labels (for example `cpu.microcode/amd-family-1ah=0xb002151-or-later`) and set a `nodeSelector` on the `VirtualMachine` spec. Unaffected Intel hosts, or AMD hosts on other families, can also be targeted.

   ```yaml
   apiVersion: kubevirt.io/v1
   kind: VirtualMachine
   metadata:
     name: win-guest
   spec:
     template:
       spec:
         nodeSelector:
           cpu.microcode/safe-for-windows: "true"
   ```

- **Keep reliable backups.** Until every candidate host is updated, treat the Windows fleet as at risk of unplanned restart. Use ACP Virtualization's `backup_recovery` workflow to snapshot VMs on a schedule tight enough to match the tolerable RPO.

Other mitigations that surface in vendor advisories for related CPU errata — disabling certain speculative features via MSR tweaks or kernel boot parameters — trade performance for risk reduction and should only be considered with the silicon vendor's explicit guidance; they do not replace the microcode fix.

## Diagnostic Steps

Confirm the symptom matches the erratum pattern before attributing every Windows BSOD to it:

1. **Capture the bugcheck code from inside the guest.**
   - In the Windows console at the moment of crash, the blue screen lists `PFN_LIST_CORRUPT`.
   - In the crashdump file (`C:\Windows\MEMORY.DMP`), open with WinDbg and run `!analyze -v`. The output's `BUGCHECK_CODE` should be `0x4E`.

2. **Confirm the host CPU family.** On the node hosting the crashing VM:

   ```bash
   kubectl get vmi -n <ns> <name> -o jsonpath='{.status.nodeName}{"\n"}'
   # then on that node
   grep -E 'vendor_id|cpu family|model\s+:' /proc/cpuinfo | sort -u
   ```

   Absence of AMD Family 1Ah on the host makes this specific erratum unlikely; look for other root causes (faulty RAM, driver bug in a specific Windows virtio driver version).

3. **Check whether the crash clusters on specific hosts.** If the VMI has moved across several nodes since deployment, a host-level commonality narrows the search:

   ```bash
   kubectl get events -n <ns> \
     --field-selector involvedObject.name=<vmi> \
     -o custom-columns=TIME:.lastTimestamp,NODE:.source.host,REASON:.reason,MSG:.message
   ```

   Crashes concentrated on one subset of nodes — especially a batch with homogeneous AMD hardware — strongly suggest a host-side cause and make the microcode remediation the right lever.
