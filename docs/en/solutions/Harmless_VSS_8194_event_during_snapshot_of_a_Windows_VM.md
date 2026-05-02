---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Harmless VSS 8194 event during snapshot of a Windows VM
## Issue

When a VirtualMachineSnapshot is taken against a Windows Server 2019 or 2022 guest running on ACP virtualization, the snapshot itself completes successfully and the resulting `VirtualMachineSnapshotContent` is usable. Inside the guest, however, the Windows Application event log records a Volume Shadow Copy Service error with event ID 8194 shortly after the snapshot is requested. The event looks similar to the following:

```text
Event Id: 8194
Source:   VSS
Volume Shadow Copy Service error: Unexpected error querying for the
IVssWriterCallback interface. hr = 0x80070005, Access is denied.
Operation: Gathering Writer Data
Context:
   Writer Class Id:    {e8132975-6f93-4464-a53e-1050253ae220}
   Writer Name:        System Writer
   Writer Instance ID: {3c9fbd01-f0e2-49b3-b604-e975f94808b1}
```

Snapshot reconciliation finishes, `readyToUse: true` is set on the `VirtualMachineSnapshot`, and the VM continues to run — so despite the noisy guest log, the snapshot data is valid.

## Root Cause

The VSS error comes from an interaction between `qemu-guest-agent` on the Windows guest and the Windows VSS `IVssWriterCallback` interface. When the guest agent initiates the freeze required for a crash-consistent or application-consistent snapshot, it queries each registered VSS writer. The System Writer returns `hr = 0x80070005` (access denied) for the callback interface probe, which VSS logs at error severity even though the freeze/thaw sequence that the guest agent actually needs succeeds afterwards. The event is a benign side effect of the probe, not of the snapshot operation itself. The underlying behaviour is tracked upstream in the QEMU / guest agent projects and does not affect snapshot integrity.

## Resolution

No action is required on the VM, on the snapshot, or on ACP virtualization — the snapshot produced is consistent and can be restored from. Treat the 8194 entry as informational on Windows guests running `qemu-guest-agent` against KubeVirt.

If downstream monitoring rules (SIEM, log ingestion) alert on any `VSS` error, add a filter for event ID 8194 with `Source: VSS` scoped to VM guests managed by ACP virtualization so that snapshot-driven noise does not trigger incidents. Keep the guest agent installed and running — removing it to silence the log entry would lose filesystem freeze/thaw coordination, which is required for consistent snapshots of running Windows VMs.

Track the guest agent package updates; when a revised `qemu-guest-agent` build that suppresses the probe is shipped via the ACP virtualization guest-tools channel, update the VM's installed agent to eliminate the event.

## Diagnostic Steps

1. Confirm the snapshot actually succeeded rather than assuming the VSS error means failure:

   ```bash
   kubectl get virtualmachinesnapshot <name> -n <namespace> \
     -o jsonpath='{.status.phase}{"\n"}{.status.readyToUse}{"\n"}'
   ```

   A `Succeeded` phase with `readyToUse: true` indicates the snapshot is valid regardless of the Windows event log.

2. Inspect the `VirtualMachineSnapshotContent` and bound `VolumeSnapshot` objects so that the data path (CSI driver, underlying storage) is confirmed healthy:

   ```bash
   kubectl get virtualmachinesnapshotcontent -n <namespace>
   kubectl get volumesnapshot -n <namespace>
   ```

3. On the Windows guest, correlate the 8194 entry with the snapshot timestamp — the event should appear only at the moment the guest-agent freeze runs, and no further errors should follow once the thaw completes. Persistent 8194 events outside snapshot windows point at an unrelated Windows VSS configuration problem, not at ACP virtualization.

4. If the snapshot phase is `Failed` or `readyToUse` stays `false`, the VSS event is not the cause. Look at the KubeVirt control-plane pods and the CSI driver logs for the backing storage:

   ```bash
   kubectl logs -n <kubevirt-namespace> deployment/virt-controller
   kubectl logs -n <csi-driver-namespace> <csi-driver-pod>
   ```

   Troubleshoot those stacks per the relevant ACP virtualization and storage guidance rather than the Windows event log.
</content>
</invoke>