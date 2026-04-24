---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `VirtualMachineRestore` operation (from a snapshot, typically to roll a VM back to a known state) fails to progress. The restore object reports:

```yaml
status:
  conditions:
    - lastProbeTime: null
      lastTransitionTime: "..."
      reason: Restore target failed to be ready within 5m0s.
               Please power off the target VM before attempting restore
      status: "False"
      type: Progressing
```

The ACP console's VM panel shows the target VM as **Stopped** — the operator has already clicked power-off and waited — but the restore keeps insisting the VM is not off. Retrying in the UI does nothing; the restore object re-times out.

This shows up on Windows guests somewhat more often than on Linux, because Windows in-guest shutdowns sometimes take longer than the console's state-tracking window and lead to the split-state where the VM reports stopped while the VMI lingers.

## Root Cause

The restore controller checks the **actual** state of the cluster objects, not the UI's summary. Specifically, it looks for a `VirtualMachineInstance` (VMI) object with the target VM's name:

- If no VMI exists → the restore proceeds.
- If a VMI exists, regardless of its phase → the restore refuses and logs "Target VM Not Powered Off".

The UI's "Stopped" badge is driven by the parent `VirtualMachine` object's condition. When an in-guest shutdown doesn't cleanly signal back to the control plane, the VMI can stay in `Succeeded` / `Failed` phase for a while — fully stopped from the guest's perspective, but still present as a Kubernetes object from the restore controller's perspective. The VM object transitions to `Stopped` because the guest is in fact not running; but the orphan VMI object is still there.

This is the same class of issue as the `runStrategy: Manual` cleanup gap — the VMI is not automatically reaped under some shutdown paths. The VM is stopped; the VMI is just not **gone**.

## Resolution

### Delete the orphaned VMI, then retry the restore

```bash
NS=<vm-ns>; VM=<vm-name>

# Confirm the orphan VMI.
kubectl -n "$NS" get vmi "$VM" -o \
  jsonpath='{.status.phase}{"\t"}{.metadata.creationTimestamp}{"\n"}'
# e.g.: Succeeded    2026-01-05T10:30:00Z

# Force-delete the VMI. The VM object is already Stopped, so this does
# not take the VM down — it just clears the leftover VMI object.
kubectl -n "$NS" delete vmi "$VM"
```

Once the VMI is gone, clean up the failed restore (it will not auto-recover) and re-issue it:

```bash
# Delete the failed VMRestore.
kubectl -n "$NS" delete vmrestore <restore-name>

# Recreate the restore (same spec as before).
kubectl -n "$NS" apply -f vmrestore.yaml
```

Watch the new restore progress:

```bash
kubectl -n "$NS" get vmrestore <restore-name> -o \
  jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
```

`Progressing=True`, then `Ready=True` confirms the restore ran to completion.

### If the VMI deletion does not complete

Occasionally a VMI's finalizers block deletion — the `virt-launcher` pod may also need force-removal:

```bash
kubectl -n "$NS" get pod -l kubevirt.io/domain="$VM" -o name | \
  xargs kubectl -n "$NS" delete --force --grace-period=0

# Then the VMI.
kubectl -n "$NS" delete vmi "$VM" --force --grace-period=0
```

Force-deletion bypasses the normal graceful shutdown. Because the VMI is already in a terminal phase (the guest stopped), there is no running state to preserve. If the VMI still refuses to delete, inspect its finalizers:

```bash
kubectl -n "$NS" get vmi "$VM" -o jsonpath='{.metadata.finalizers}{"\n"}'
# ["kubevirt.io/virtualMachineControllerFinalize"]
```

Remove stuck finalizers (last-resort; do this only after confirming the VMI is not needed):

```bash
kubectl -n "$NS" patch vmi "$VM" \
  --type=json -p='[{"op":"remove","path":"/metadata/finalizers"}]'
```

### Prevent recurrence

The orphaned-VMI pattern shows up more often with certain `runStrategy` values and with Windows guests whose in-guest shutdown is slow. Two preventive measures:

- Use `runStrategy: RerunOnFailure` (not `Manual`) when the workload tolerates auto-recovery after crashes. `RerunOnFailure` reaps the VMI on clean shutdowns automatically.
- If `runStrategy: Manual` is required by the workload, schedule a periodic sweeper (a simple CronJob with RBAC to delete stale VMIs) to catch any orphans. See the companion note on guest-initiated shutdowns for a reference implementation.

## Diagnostic Steps

Confirm the orphan is the restore blocker:

```bash
NS=<ns>; VM=<vm-name>
kubectl -n "$NS" get vm "$VM" -o \
  jsonpath='{.status.printableStatus}{"\n"}'
# Stopped

kubectl -n "$NS" get vmi "$VM" 2>/dev/null && \
  echo "VMI still exists — orphan confirmed" || \
  echo "VMI is gone — issue is elsewhere"
```

If the VMI still exists while the VM is stopped, that is the condition this note describes. If the VMI is already gone and the restore still reports "not powered off", the issue is different — inspect the VMRestore's status in more detail for the actual failure reason.

Read the `virt-launcher` pod state to know what triggered the leftover:

```bash
kubectl -n "$NS" get pod -l kubevirt.io/domain="$VM" -o wide
kubectl -n "$NS" describe pod <virt-launcher-pod> | grep -A5 -E 'Last State|Reason|Exit Code'
```

A clean exit (Exit Code 0) combined with `runStrategy: Manual` on the VM is the usual pattern. Document the result so the preventive measure (different runStrategy or a sweeper) can be chosen based on evidence.

After the fix, the next restore completes, and `kubectl -n "$NS" get vm "$VM" -o yaml` reflects the restored snapshot's state (disk contents, CR fields) on the VM's next start.
