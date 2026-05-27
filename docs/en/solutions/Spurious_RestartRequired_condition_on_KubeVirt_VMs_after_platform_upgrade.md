---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Spurious RestartRequired condition on KubeVirt VMs after platform upgrade

## Issue

On Alauda Container Platform with the `kubevirt-operator` bundle installed (ACP v4.3.13, CSV `kubevirt-hyperconverged-operator.v4.3.5`, KubeVirt image `build-harbor.alauda.cn/3rdparty/kubevirt/virt-controller:v1.7.0-alauda.2` in namespace `kubevirt`), VirtualMachine resources surface a `RestartRequired` entry inside `.status.conditions[]` indicating that a non-live-updatable change has been recorded against the VM template spec and the guest must be restarted for the change to take effect. The same condition shape — `{type, status, reason, message, lastTransitionTime, lastProbeTime}` — also blocks hot-plug operations: while `RestartRequired` is set on a VM, memory and CPU hot-plug updates against that VM are refused by virt-controller until the condition is cleared or the VM is restarted.

The user-visible message attached to the `RestartRequired` condition includes the phrase `a non-live-updatable field was changed in the template spec`, emitted by virt-controller whenever it observes that a non-live-updatable field of `.spec.template.spec` differs from the last stored ControllerRevision snapshot for that VM. Administrators encounter the condition on VMs they did not knowingly edit, which makes the trigger non-obvious until the diff between the current template spec and the per-VM ControllerRevision is inspected.

## Root Cause

virt-controller persists a per-VM `ControllerRevision` (`apps/v1`) whose `.data.spec.template.spec` mirrors the last reconciled VM template spec; on each reconcile it diffs the live VM `.spec.template.spec` against that snapshot and, if any non-live-updatable field has changed, sets `RestartRequired` on the VM rather than applying the change to the running VMI. The VirtualMachine CRD on ACP exposes `.spec.template.spec.domain.firmware.uuid` as a `string` at group/version `kubevirt.io/v1`, with the upstream description that the value is the UUID reported by the VMI BIOS and defaults to a random generated UID when unset. That field value seeds the libvirt domain UUID for the resulting VMI, pinning the VM's domain identity at the hypervisor layer.

virt-controller treats `.spec.template.spec.domain.firmware.uuid` as a non-live-updatable field, so any change to its value — including a transition from unset to a concrete UUID — triggers the `RestartRequired` condition rather than being applied live. When a platform-level reconcile populates a previously-absent `uuid` on existing VMs, the new template spec diverges from the pre-existing ControllerRevision on that exact field; virt-controller sees the delta on a non-live-updatable field and flags every affected VirtualMachine with `RestartRequired`, even though the guest's actual identity has not changed.

## Resolution

For each affected VirtualMachine, clear the existing condition with a `status`-subresource merge patch against the VM. The VirtualMachine CRD on ACP enables the `status` subresource (`subresources.status = {}` under `spec.versions[v1]`), so the patch is structurally accepted and rewrites the `.status.conditions` array without touching `.spec`:

```bash
kubectl patch vm <name> -n <namespace> \
 --subresource=status --type=merge \
 -p '{"status":{"conditions":[]}}'
```

VMs that already carry `RestartRequired` retain that condition across a subsequent upgrade that prevents new injections, because such an upgrade stops further injection but does not retroactively clear conditions that were already recorded on existing VMs. Apply the `status` patch above on the affected VMs after upgrading so they do not continue to report the spurious condition; with the injection-prevention build in place, virt-controller does not re-set `RestartRequired` on those VMs unless a real non-live-updatable change is subsequently made to the template spec. Hot-plug operations (memory or CPU updates) on the affected VMs are unblocked as soon as the condition is cleared, since the hot-plug refusal is gated on `RestartRequired` being present in `.status.conditions[]`.

## Diagnostic Steps

Confirm whether the `RestartRequired` condition is actually present on the VM before patching, and read the attached message to verify it names a non-live-updatable template-spec change:

```bash
kubectl get vm <name> -n <namespace> \
 -o jsonpath='{.status.conditions[?(@.type=="RestartRequired")]}'
```

Identify which field changed by diffing the live VM template spec against the corresponding ControllerRevision snapshot that virt-controller stored for that VM. Capture both sides into separate files and run a textual diff; when `firmware.uuid` is the trigger, it shows up as a single-line addition (previously absent, now set) on the live-spec side:

```bash
kubectl get vm <name> -n <namespace> -o yaml \
 | yq '.spec.template.spec' > vm.spec

kubectl get controllerrevision <revision-name> -n <namespace> -o yaml \
 | yq '.data.spec.template.spec' > revision.spec

diff vm.spec revision.spec
```

If the diff highlights `.domain.firmware.uuid` as the only delta, the condition is the spurious-injection pattern described above and the `status`-subresource clear in **Resolution** is the safe remediation; if the diff highlights other non-live-updatable fields, treat those as real intentional changes that genuinely require a VM restart to take effect rather than a status-only clear.
