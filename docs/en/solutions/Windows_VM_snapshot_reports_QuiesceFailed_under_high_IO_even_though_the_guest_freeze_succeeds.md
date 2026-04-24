---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On ACP Virtualization, a `VirtualMachineSnapshot` taken against a Windows VM under heavy disk load reports `QuiesceFailed` in `.status.indications` even though the guest ultimately freezes and the snapshot disk image is usable:

```text
$ kubectl get vmsnapshot <name> -o yaml | yq '.status.indications'
- GuestAgent
- Online
- QuiesceFailed
```

The virt-controller log for the same snapshot shows a freeze-command timeout roughly five seconds after the freeze was issued:

```text
"Failed freezing vm <name>: Internal error occurred: unexpected return
code 400 (400 Bad Request), message: server error. command Freeze failed:
\"LibvirtError(Code=86, Domain=10, Message='Guest agent is not
responding: Guest agent not available for now')\""
```

A second later the same guest-agent command returns `frozen`, and the Windows QEMU Guest Agent log on the guest shows `requester_freeze end successful` followed by a clean thaw. So the freeze did work — but the controller already recorded the snapshot as a failed quiesce.

When the VM is part of an OADP / Velero backup chain, the indication can escalate into a backup-level failure because the outer backup controller short-polls the snapshot state.

## Root Cause

Two layered timeouts are too short for Windows VMs under I/O pressure.

1. **KubeVirt layer — freeze command timeout.** The virt-controller waits ~5 seconds for the QEMU Guest Agent `guest-fsfreeze-freeze` call to return. On Windows the freeze is delegated to the Volume Shadow Copy Service (VSS), and VSS has to call each registered writer (application and filesystem), get them to flush, and hold the freeze point. Under high write load, simply reaching the `requester_freeze end` state inside VSS can take more than 5 seconds. The controller has already marked the quiesce as failed by the time the guest reports `frozen`, so it records `QuiesceFailed` even though the snapshot of the block device is still consistent.

2. **Backup layer — OADP / Velero polling cadence vs. VSS freeze lifetime.** Windows VSS holds a filesystem freeze for a **hard-coded, non-configurable 10 seconds**. Velero polls snapshot readiness at a fixed 5-second interval. If the underlying storage snapshot on the CSI driver takes longer than 5 seconds, Velero will not observe it until the next poll at 10 seconds — right at the VSS deadline — so the snapshot can be taken just past the point at which the Windows guest has already thawed, which is what leads to downstream backup failures that are not apparent from the virt-controller log alone.

So the `QuiesceFailed` indication is a symptom of the *controller* being too impatient, not of the *guest* failing. And when OADP is in the picture, a second timing window stacks on top of it.

## Resolution

### For the KubeVirt-level indication

Upgrade ACP Virtualization to a release where the controller-side freeze timeout is long enough to accommodate Windows VSS under load. The upstream KubeVirt fix raises the `guest-fsfreeze-freeze` timeout and is available in corresponding ACP Virtualization updates; check the component version and upgrade past the fixed build:

```bash
kubectl get csv -A | grep -i virtualization
kubectl get kubevirt -A -o jsonpath='{.items[*].status.observedKubeVirtVersion}'
```

After the upgrade, rerun the snapshot against the same VM under load. The `QuiesceFailed` indication should no longer appear; `Online` and `GuestAgent` are still expected on a live snapshot.

**Interim behaviour without the upgrade.** If upgrading is not immediately possible:

- Take snapshots during a lower I/O window. Pause or throttle the workload inside the guest for the seconds-long freeze window.
- Treat `QuiesceFailed` as informational when the guest-agent log shows `requester_freeze end successful` and `frozen` is returned within a few seconds — the snapshot disk image is still consistent from VSS' point of view; only the controller's opinion is wrong. This is not a policy to adopt long-term, but it lets a backup cycle complete while the cluster is being scheduled for the upgrade.

Do **not** try to extend the VSS freeze window from inside the guest — the 10-second Windows limit is not configurable. The fix is in the controller, not the guest.

### For the OADP / Velero polling window

Upgrade the backup component in parallel. Tracked in the upstream Velero/OADP project; once the fix lands in the ACP `configure/backup` component, Velero's snapshot polling cadence is shorter (or the freeze is held longer from the KubeVirt side) so the two timers overlap cleanly.

Until then, if Velero-driven VM backups must continue:

1. Exclude the problematic Windows VMs from quiesced snapshots (set `includedResources` / annotations to skip VSS-based quiesce for them) and accept crash-consistent snapshots instead. The `csi-volumesnapshot-class` label on the snapshot class determines whether Velero requests a quiesced or a raw CSI snapshot; switching to a non-quiesced class for Windows workloads keeps backups flowing at the cost of consistency guarantees.
2. Schedule Velero backups for these VMs during a low-write window — the VSS path completes predictably inside the freeze budget when the guest is quiescent.

### Longer-term mitigation

If a VM is a frequent offender, check whether the workload can be tuned to flush less synchronously during the freeze window. Anti-virus / indexing services that write continuously are a common cause of runaway VSS freeze times. Excluding those services via policy, or pinning them to a maintenance window, reduces the tail latency of the freeze path independently of any platform fix.

## Diagnostic Steps

1. Confirm the freeze actually succeeded inside the guest, even if the controller said otherwise. The virt-launcher log on the node hosting the VM shows the follow-up `guest-fsfreeze-status` returning `frozen`:

   ```bash
   NS=<vm-namespace>
   VM=<vm-name>
   POD=$(kubectl -n "$NS" get pod -l kubevirt.io=virt-launcher,kubevirt.io/domain="$VM" \
     -o jsonpath='{.items[0].metadata.name}')
   kubectl -n "$NS" logs "$POD" -c compute | grep -E 'fsfreeze|frozen|Freeze'
   ```

   A line of the form `Line [{"return": "frozen"}]` within a few seconds of the controller's `Failed freezing vm` log confirms the guest completed the freeze after the timeout.

2. Pull the virt-controller log to locate the timeout. The two-line pattern is the signature — an info line starting the freeze, then an error line ~5 seconds later:

   ```bash
   kubectl -n <virt-namespace> logs deploy/virt-controller \
     | grep -E 'Freeze VMI|Failed freezing|Freezing vmi .* took' | tail -20
   ```

   The duration in the `Freezing vmi <name> took <n>s` line is the observed freeze latency. If it is consistently >5 s, this KB applies.

3. On the Windows guest, check the QEMU Guest Agent log to see whether VSS reported a successful freeze and thaw. The log locations vary by agent version, but the path typically includes the agent install directory. A clean cycle shows `requester_freeze end successful` followed later by `requester_thaw begin` and `logging re-enabled due to filesystem unfreeze`.

4. If OADP is involved, pull the backup's logs and look for the snapshot readiness check to cross-reference against the freeze window:

   ```bash
   kubectl -n <oadp-namespace> logs deploy/velero \
     | grep -E 'Waiting for snapshot|snapshot is ready|quiesce' | tail -40
   ```

   A poll gap between "Waiting for snapshot" and "snapshot is ready" that approaches 10 seconds indicates the VSS-vs-Velero race described in the root cause.

5. After upgrading the relevant components, validate the fix by scheduling a snapshot (or a full OADP backup) against the same Windows VM under representative I/O load and re-reading `.status.indications`. A clean run shows `GuestAgent` and `Online` without `QuiesceFailed`.
