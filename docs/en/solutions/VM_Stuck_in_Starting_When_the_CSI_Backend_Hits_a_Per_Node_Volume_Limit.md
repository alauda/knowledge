---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Stuck in Starting When the CSI Backend Hits a Per-Node Volume Limit
## Issue

A VM managed by the platform's virtualization stack will not finish starting:

- The `VirtualMachine` object reports `Starting`, but the corresponding `virt-launcher-*` pod stays in `ContainerCreating` for an unusually long time.
- The VM's PVC is `Bound` but already carries a `deletionTimestamp` — i.e. someone (typically a snapshot-restore or clone workflow) has marked the storage for removal while the launcher is still trying to attach.
- The PV behind that PVC also has a `deletionTimestamp` and a `kubernetes.io/pv-protection` finalizer that has not been removed.

```text
$ kubectl get pv <name> -o yaml
deletionGracePeriodSeconds: 0
deletionTimestamp: "2026-01-30T14:05:47Z"
finalizers:
- kubernetes.io/pv-protection
```

In parallel the CSI driver is logging provisioning failures with a back-end error of the form:

```text
rpc error: code = Unknown desc = failed to create cloned volume...
Reason: Maximum number of volumes reached on node "<node>"., Code: <vendor-error-code>
```

## Root Cause

Two independent conditions are interacting and the symptom is the union of both:

1. **The storage backend is at its per-node volume cap.** The CSI driver requests a clone (this happens during VM restore/snapshot flows that materialise a fresh PVC from an existing volume), and the back end refuses because the target node already has the maximum number of volumes the storage system is willing to attach there. The clone never appears, so the new PVC never finishes provisioning.

2. **The previous PV will not finalise.** The `kubernetes.io/pv-protection` finalizer is held by the kube-controller-manager and is only removed once nothing is using the volume. Because a `virt-launcher` pod is still in `ContainerCreating` and is — from the API server's point of view — a candidate consumer of the volume, the controller declines to clear the finalizer. The PV cannot be deleted, the underlying storage stays consumed, and the per-node cap stays at the limit.

Each issue alone is benign; combined, they form a deadlock: the launcher won't terminate because its volume isn't ready, and the volume isn't ready because the launcher is still listed as using the old volume.

## Resolution

Break the deadlock from the launcher side first, then unblock the storage side, then restart the VM with a fresh, healthy clone.

1. **Force-delete the unresponsive virt-launcher pod** so the API server stops counting it as a consumer of the old volume:

   ```bash
   kubectl -n <vm-ns> get pods | grep -E "virt-launcher|<vm-name>"
   kubectl -n <vm-ns> delete pod <virt-launcher-pod> --force --grace-period=0
   ```

   With the launcher gone, the `pv-protection` finalizer will be cleared by the controller and the old PV will finally be removed.

2. **Reclaim capacity on the storage backend.** Coordinate with the storage administrator to delete orphaned volumes that should already have been released (failed clones, half-rolled-back snapshots, abandoned restores). The goal is to bring the per-node volume count below the backend's configured cap before retrying.

3. **Re-issue the clone / snapshot restore.** Once capacity is back under the limit, the PVC can be re-created and the back end will provision the clone successfully.

4. **Verify the VM transitions to `Running`** and that its new PVC reaches `Bound`:

   ```bash
   kubectl -n <vm-ns> get vm <vm-name>
   kubectl -n <vm-ns> get pvc | grep <vm-name>
   kubectl -n <vm-ns> get pods | grep virt-launcher-<vm-name>
   ```

To prevent the failure from recurring: keep some headroom under the storage backend's per-node attachment limit (it is enforced by the storage system, not by Kubernetes), and never run snapshot-restore workflows in parallel against nodes that are already close to the cap.

## Diagnostic Steps

Before deleting anything, confirm the diagnosis matches all three observations — otherwise force-deleting the launcher could mask a different failure.

1. **VM and pod state.** A long-lived `ContainerCreating` launcher with a `Starting` VM is the entry point:

   ```bash
   kubectl -n <vm-ns> get vm,vmi
   kubectl -n <vm-ns> get pods -l vm.kubevirt.io/name=<vm-name>
   ```

2. **PVC marked for deletion while still bound.** The `deletionTimestamp` is the diagnostic — if the PVC is `Bound` and still owned by something, this article applies:

   ```bash
   kubectl -n <vm-ns> get pvc <pvc-name> -o yaml | grep -E 'deletionTimestamp|finalizers'
   ```

3. **PV finalizer still held.** Confirm the PV is in the same state and identify which finalizer is blocking:

   ```bash
   kubectl get pv <pv-name> -o jsonpath='{.metadata.finalizers}{"\n"}'
   kubectl get pv <pv-name> -o jsonpath='{.metadata.deletionTimestamp}{"\n"}'
   ```

4. **CSI driver error.** Inspect the CSI controller log to find the vendor-side reason. A `Maximum number of volumes reached on node` message (or the vendor's equivalent error code) confirms the cap, not a Kubernetes problem:

   ```bash
   kubectl -n <csi-ns> logs <csi-controller-pod> -c csi-provisioner | grep <pvc-name>
   kubectl -n <csi-ns> logs <csi-controller-pod> -c <vendor-csi-container> | grep -i 'maximum number of volumes'
   ```

5. **Per-node attachment count.** From the storage backend's own management surface, list the active volumes attached to the affected node and compare against the configured limit. The Kubernetes `VolumeAttachment` count is a useful cross-check but is not authoritative — the cap is enforced by the storage system itself:

   ```bash
   kubectl get volumeattachment | grep <node-name>
   ```

If any of these signals are missing, do *not* force-delete the launcher: a stuck launcher with a healthy PV is a different (image, network, or device) issue.
