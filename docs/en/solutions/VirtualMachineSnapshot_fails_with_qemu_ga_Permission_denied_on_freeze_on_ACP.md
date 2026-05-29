---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VirtualMachineSnapshot fails with qemu-ga Permission denied on freeze on ACP

## Issue

On Alauda Container Platform with the Virtualization (KubeVirt) capability installed, taking a `VirtualMachineSnapshot` of a running VirtualMachineInstance asks the in-guest QEMU guest agent to quiesce the guest filesystems via `guest-fsfreeze-freeze` before the underlying disk snapshot is captured. When the snapshot succeeds in this consistent mode, the resulting `VirtualMachineSnapshot` records the fact in `status.sourceIndications` with indication `GuestAgent` and the message "Guest agent was active and attempted to quiesce the filesystem for application consistency", alongside an `Online` indication that explicitly notes consistency depends on guest-agent quiescing.

The freeze step can fail for a specific reason: the guest agent process inside the VM is unable to open one of the mount points it has been asked to freeze. When that happens, `virt-handler` (the per-node KubeVirt agent that issues the freeze call to libvirt/QEMU on the node hosting the VMI) logs the failure on its lifecycle path with the literal message text `Failed to freeze VMI` and a `reason` field that carries the libvirt error string, including the substring `command Freeze failed` and the suffix `guest-fsfreeze-freeze ... Permission denied` from the QEMU agent. `virt-controller`, the KubeVirt control-plane component that orchestrates the freeze, emits a matching pair of log lines around any freeze call — `Freeze VMI <name>` when the call begins and `Freezing vmi <name> took <duration>` when it returns — and surfaces the failure as the standard "unexpected return code 400 (400 Bad Request)" wrapper around the libvirt error.

The same failure text lands on the `VirtualMachineSnapshot` CR itself: the `snapshot.kubevirt.io/v1beta1` `VirtualMachineSnapshot` API on this cluster carries a `status.error` object with `message` and `time` fields, described as "the last error encountered during the snapshot/restore", which is where the `command Freeze failed ... Permission denied` text is propagated for end users to read with `kubectl get vmsnapshot <name> -o yaml`.

## Root Cause

The freeze call fails because the QEMU guest agent, running inside the VM as `/usr/bin/qemu-ga`, cannot open the directory it has been asked to freeze. On a guest OS that confines `qemu-ga` with SELinux, the agent runs in the `virt_qemu_ga_t` domain and is only allowed to access files whose SELinux types are on its allow-list. A directory that has just been created on a freshly-mounted filesystem typically carries no SELinux label and shows up under `ls -lZd` as `system_u:object_r:unlabeled_t:s0`; that type is not on the allow-list for `virt_qemu_ga_t`, so the kernel denies the open and the agent returns `Permission denied` to libvirt, which `virt-handler` then surfaces as the `Failed to freeze VMI` log line on the platform side.

The denial is purely an in-guest SELinux policy decision — it does not depend on the platform that runs KubeVirt. The same VM image that hits this failure on any other KubeVirt distribution will hit it identically on ACP, and the fix is also entirely in the guest OS: relabel the path or grant `virt_qemu_ga_t` the access it needs. None of the remediation involves changing anything on the cluster control plane or the `kubevirt` namespace.

## Resolution

The remediation runs inside the guest OS of the VM, not on the ACP control plane — the failure surfaces on the platform via the same `status.error.message` on the `VirtualMachineSnapshot` CR that propagates any freeze failure. Two paths are available; option A is the broad fix that covers most cases, and option B is a surgical fix for one specific path.

**Option A — broad fix (recommended):** allow the confined `qemu-ga` to read files whose type is on the SELinux `non_security_file_type` attribute (which includes `unlabeled_t` directories created by a fresh `mkfs`), by enabling the corresponding SELinux boolean inside the guest. This needs to be made persistent across reboots:

```bash
# inside the VM, as root
setsebool -P virt_qemu_ga_read_nonsecurity_files 1
```

After enabling the boolean, re-trigger the snapshot. A `VirtualMachineSnapshot` taken against the same VMI is expected to complete with `status.phase: Succeeded` and `status.sourceIndications` recording both the `GuestAgent` quiesce indication and the `Online` indication, the same way the cluster surfaces a healthy guest-quiesced snapshot.

**Option B — surgical fix:** keep the SELinux confinement tight and explicitly allow `virt_qemu_ga_t` the access it needs to one specific target type only. Generate a custom policy module from the audit denial, build it, and load it inside the guest:

```bash
# inside the VM, as root
grep AVC /var/log/audit/audit.log | grep <target-path> \
  | audit2allow -M qemu-ga-<target-name>
semodule -i qemu-ga-<target-name>.pp
```

If the underlying issue is a missing or wrong label on a specific path rather than a missing allow rule, relabel the path to its default SELinux context first; `restorecon` does this in place:

```bash
# inside the VM, as root
restorecon -Rv /<affected-path>
```

After either fix, re-run the snapshot from the ACP side and verify the snapshot reaches `status.phase: Succeeded` rather than carrying a `status.error.message` containing `command Freeze failed ... Permission denied`.

## Diagnostic Steps

Confirm the failure path end-to-end before applying any in-guest fix; the snapshot CR is the canonical entry point because the freeze error lands on its `status.error` object.

Inspect the failing `VirtualMachineSnapshot` object first; the freeze error is propagated onto it as a structured `status.error{message,time}` object, and `status.sourceIndications` will not show the `GuestAgent` quiesce indication that a healthy snapshot shows:

```bash
kubectl get vmsnapshot -n <namespace> <snapshot-name> -o yaml
```

Cross-check on the platform side by grepping the `virt-handler` DaemonSet logs in the `kubevirt` namespace for the `Failed to freeze VMI` line — `virt-handler` runs as one pod per node, so target the pod on the node currently hosting the affected VMI. The `reason` field on this log line carries the verbatim libvirt error, including the `guest-fsfreeze-freeze ... Permission denied` substring that points at the in-guest denial:

```bash
kubectl logs -n kubevirt -l kubevirt.io=virt-handler \
  --all-containers --tail=2000 \
  | grep -E 'Failed to freeze VMI|guest-fsfreeze-freeze|Permission denied'
```

Also confirm the matching control-plane view from `virt-controller` in the same namespace; for any freeze attempt against a given VMI it emits a `Freeze VMI <name>` log line, a `Freezing vmi <name> took <duration>` line on return, and surfaces the underlying failure as "unexpected return code 400 (400 Bad Request)":

```bash
kubectl logs -n kubevirt -l kubevirt.io=virt-controller \
  --tail=2000 \
  | grep -E 'Freeze VMI|Freezing vmi|return code 400'
```

Once the fix has been applied inside the guest, re-create the snapshot and confirm `status.phase: Succeeded` together with the `GuestAgent` indication appearing under `status.sourceIndications` — that pair confirms the guest agent was reachable and that the filesystem was quiesced for application consistency, rather than the snapshot being taken without quiescing.
