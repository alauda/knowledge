---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Hosted Control Plane (HCP) cluster whose worker NodePool is realised through KubeVirt VMs gets stuck: the NodePool never reaches its desired replica count because individual VMs sit in `Provisioning` indefinitely. Inspection shows the chain `VirtualMachine → DataVolume → PVC → importer pod`, with the importer pod scheduled but stalled on `unbound immediate PersistentVolumeClaims`, and the underlying PVC stuck in `Pending` while the external CSI provisioner is still working.

```text
$ kubectl get vm <vm-name>
NAME            AGE   STATUS         READY
<vm-name>       22m   Provisioning   False

$ kubectl get dv <vm-name>-rootdisk
NAME                  PHASE             PROGRESS   RESTARTS   AGE
<vm-name>-rootdisk    ImportScheduled   N/A                   22m

$ kubectl get pvc | grep <vm-name>-rootdisk
<vm-name>-rootdisk    Pending           csi-storageclass         22m
```

After roughly twenty minutes the controller decides the VM never came up and tears it down, and a fresh DataVolume / PVC is started. The new PVC inherits the same slow provisioning path, the timer fires again, and the loop repeats — leaving the NodePool permanently short of capacity.

## Root Cause

Two timers are racing:

1. The CSI provisioner takes well over the default 20-minute machine startup window to actually create the backing volume — instrumentation on the `csi-provisioner` and the storage-vendor driver shows individual `CreateVolume` GRPC calls completing in roughly 17 minutes per request, with a long queue of VMs piling on at the same time.
2. The HCP machine-health controller treats anything that has not become `Ready` within `node-startup-timeout` (default `20m`) as a failed bring-up and recreates it. Recreation invalidates the in-flight DataVolume, the importer pod is rescheduled, the cycle restarts.

In other words: the CSI back end *is* eventually provisioning the volume successfully — the `csi-provisioner` log shows `successfully created PV ...` — but it does so just after the supervisor has already given up on the VM.

## Resolution

Extend the per-NodePool startup timeout so that the slowest realistic CSI provisioning latency is comfortably inside the bring-up window, then let the existing DataVolumes finish.

1. Identify the HostedCluster object that owns the affected NodePool:

   ```bash
   kubectl -n clusters get hostedcluster
   ```

2. Annotate the HostedCluster to widen the machine-health-check node-startup timeout from the default to a value that exceeds your worst observed CSI `CreateVolume` latency. Sixty minutes is a reasonable starting point when individual provisioning calls run 15–20 minutes:

   ```bash
   kubectl -n clusters annotate hostedcluster <name> \
     hypershift.io/machine-health-check-node-startup-timeout=60m
   ```

   (The annotation key may differ between Hosted Control Plane releases — consult the version of the controller installed on the management cluster for the exact prefix it observes.)

3. Stop forcing-recreating VMs. Once the annotation is in effect, the existing PVCs will be allowed to finish binding; importer pods will move from `Pending` to `Running`, the DataVolumes will report `Succeeded`, and the `virt-launcher` pods will start and bring the VMs to `Ready`.

4. In parallel, treat the storage latency itself as a separate problem. A 17-minute `CreateVolume` is a back-end symptom (saturation, queue depth, fabric scan time, etc.), and increasing the supervisor timeout only papers over it. Open a ticket with the storage vendor or platform team to investigate the slow path; the timer extension is the workaround, not the fix.

This pattern is the same regardless of which CSI driver sits behind the StorageClass — any provisioner whose tail latency exceeds the default startup window will look identical from the KubeVirt side.

## Diagnostic Steps

Confirm the failure mode end-to-end before changing the timeout. Walking the chain top-down isolates whether the bottleneck is in scheduling, in CSI, or in the VM controller itself.

1. **VM and DataVolume status.** A VM that is `Provisioning` with the DataVolume stuck in `ImportScheduled` for tens of minutes is the canonical signal:

   ```bash
   kubectl -n <hcp-ns> get vm,dv,pvc | grep <vm-name>
   ```

2. **Importer pod scheduling.** A `Pending` importer pod with `0/N nodes are available: pod has unbound immediate PersistentVolumeClaims` confirms that the block is the PVC, not the pod itself:

   ```bash
   kubectl -n <hcp-ns> describe pod importer-prime-<uid>
   ```

3. **PVC events.** Look for `ExternalProvisioning … Waiting for a volume to be created` — the PVC has handed off to the out-of-tree provisioner and is waiting:

   ```bash
   kubectl -n <hcp-ns> describe pvc prime-<uid>
   ```

4. **CSI provisioner timing.** In the `csi-provisioner` sidecar logs, correlate the `Started` line for the PVC with the eventual `successfully created PV` line. The wall-clock gap is the actual provisioning latency. If that gap is consistently larger than `node-startup-timeout`, this article applies:

   ```bash
   kubectl -n <csi-ns> logs <csi-controller-pod> -c csi-provisioner | grep <pvc-name>
   ```

5. **Vendor driver timing.** The vendor's CSI driver container often logs per-call durations (e.g. `Duration:101.6 sec` for a `CreateVolume`). Sum the individual primitives to pinpoint which back-end operation is slow — this is what to take to the storage team:

   ```bash
   kubectl -n <csi-ns> logs <csi-controller-pod> -c <vendor-csi-container> | grep -E 'CreateVolume|Duration'
   ```

6. **NodePool churn.** A NodePool whose VMs keep being recreated every ~20 minutes is the smoking gun for the timeout race; a stable NodePool whose VMs simply take long is a different (and benign) shape:

   ```bash
   kubectl -n clusters get nodepool <name> -o yaml | grep -A3 conditions
   ```

After raising the annotation, repeat steps 1–2; the importer pods should reach `Running` and the DataVolumes should advance through `ImportInProgress` → `Succeeded` without further controller-driven recreation.
