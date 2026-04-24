---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a cluster that uses a CSI driver backed by an NVMe-over-TCP storage array (for example an HPE Alletra-class backend), `PersistentVolumeClaim` objects stay in `Pending`, workloads (including VMs) never start, and the kubelet surfaces `NodeStageVolume` failures of the form:

```text
MapVolume.SetUpDevice failed for volume "<pv>":
  rpc error: code = Internal desc = NVMe/TCP discovery failed:
    failed to connect to NVMe target: failed to resolve host *
  could not add new controller: failed to get transport address
```

Basic network checks from the worker node succeed — the NVMe target IP is reachable, TCP port 4420 is open, and `nvme discover` executed by hand on the node returns valid subsystem entries — yet the CSI node plugin still refuses to stage the volume during pod startup.

## Root Cause

The failure happens strictly inside the CSI driver's NVMe session negotiation, not in the platform network path or in kubelet. When NVMe discovery has already succeeded out-of-band but the driver emits `failed to resolve host *` / `failed to get transport address` during `NodeStageVolume`, the driver is mis-handling the transport address returned by the discovery controller before it calls `nvme connect`. That is a bug in the driver's own connection-handling code path — the surrounding Kubernetes, kubelet, and CSI sidecar components are all functioning correctly.

The `*` (or empty) host in the error is the giveaway: the driver is passing an unresolved placeholder to the NVMe connect call because its parser failed to extract the real `traddr` from the discovery response.

## Resolution

Upgrade the CSI driver to the vendor release that ships the fix for NVMe/TCP session establishment. For the HPE CSI driver the fix is in **v3.1.0** and later; for any other vendor, consult the driver's release notes for the `NVMe connect` / `transport address` bug and pick a version that lists it as resolved.

Upgrade steps (generic):

1. Confirm the current driver version so you can roll back if needed:

   ```bash
   kubectl -n <csi-ns> get pods -l app=<csi-driver> \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}'
   ```

2. Follow the vendor's upgrade procedure — typically updating the `HelmChart` / operator subscription / manifest set that installs the driver's controller `Deployment` and node-plugin `DaemonSet`. Do not edit the in-cluster CSI images ad-hoc; let the installer roll them.

3. Wait for the node plugin `DaemonSet` to reach `Ready` on every worker:

   ```bash
   kubectl -n <csi-ns> rollout status ds/<csi-node-plugin>
   kubectl get csidrivers
   ```

4. Re-trigger staging on a stuck `PersistentVolumeClaim`. In most cases the kubelet will retry `NodeStageVolume` automatically; if a pod is stuck in `ContainerCreating` past the retry window, delete it so the scheduler and kubelet re-run the volume lifecycle:

   ```bash
   kubectl -n <ns> delete pod <pod>
   ```

5. Confirm the PVC binds and a subsequent pod reaches `Running`:

   ```bash
   kubectl -n <ns> get pvc,pod
   ```

If upgrading the driver is not immediately possible, the only safe workaround is to route affected workloads onto a storage class that does not use the affected transport (for example a different NVMe/TCP driver, or iSCSI-backed `StorageClass`). Reverting to manual `nvme connect` on the host does not help because the kubelet's `NodeStageVolume` path still goes through the broken driver logic.

## Diagnostic Steps

The goal of the walk-through below is to separate "network / fabric is broken" from "CSI driver is broken", so you do not waste cycles chasing the wrong layer.

```bash
# 1. Cluster health — rule out a broader control-plane issue first.
kubectl get nodes
kubectl get --raw=/readyz?verbose | head -20
kubectl get events -A --sort-by=.lastTimestamp | tail -30

# 2. Confirm the CSI controller and node plugin are actually running on every
#    worker that is supposed to host NVMe-backed workloads.
kubectl -n <csi-ns> get deploy,ds
kubectl -n <csi-ns> get pods -o wide | grep -E 'controller|node'
kubectl get csidrivers

# 3. Inspect the kubelet-side event that triggered NodeStageVolume.
kubectl describe pod <pending-pod> -n <ns> | \
  grep -E 'MapVolume|NodeStage|NVMe'

# 4. Re-run the CSI node plugin log for the affected node to catch the
#    driver-side error message directly.
NODE=<worker>
POD=$(kubectl -n <csi-ns> get pod -l app=<csi-node-plugin> \
        --field-selector spec.nodeName=$NODE -o name | head -1)
kubectl -n <csi-ns> logs "$POD" -c <csi-node-container> --tail=200 | \
  grep -E 'NVMe|transport|connect|resolve host'
```

On the worker node itself (reachable via `kubectl debug node/<name>` with a host-namespace image), confirm the fabric is healthy independently of the driver:

```bash
# Routing and port reachability to the NVMe target.
ip route get <target-ip>
nc -zv <target-ip> 4420

# Manual discovery. If this succeeds while NodeStageVolume fails,
# the fabric is fine and the problem lives in the driver.
nvme discover -t tcp -a <target-ip> -s 4420
```

Decision point:

- Manual `nvme discover` **fails** → investigate the fabric, host NVMe initiator, firewall, or multipath configuration.
- Manual `nvme discover` **succeeds** but the CSI plugin still errors out with `failed to resolve host *` / `failed to get transport address` → apply the **Resolution** above (driver upgrade).
