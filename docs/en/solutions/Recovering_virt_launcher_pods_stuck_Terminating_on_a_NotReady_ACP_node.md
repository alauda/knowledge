---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500165
---

# Recovering virt-launcher pods stuck Terminating on a NotReady ACP node

## Issue

On Alauda Container Platform running KubeVirt `v1.7.0-alauda.2` with the Hyperconverged Cluster Operator `v1.17.0` (Kubernetes `v1.34.5`), a worker node that loses contact with the control plane stops posting its kubelet heartbeat, and the node-lifecycle controller in `kube-controller-manager` flips the node's `Ready`, `MemoryPressure`, `DiskPressure`, and `PIDPressure` conditions to `Unknown` with reason `NodeStatusUnknown` once the `--node-monitor-grace-period` (50s on this cluster) elapses without a fresh status update.

Any pod bound to the unreachable node remains in the `Terminating` phase, because the API server cannot confirm that the kubelet has actually stopped its containers and released its resources while the node is unreachable. The `virt-launcher-<vmi>` carrier pods that back each running VirtualMachineInstance are no exception: they are ordinary pods created by `virt-controller` and supervised by the `virt-handler` DaemonSet (one pod per node) in the `kubevirt` namespace, and on a NotReady node they are also stuck in `Terminating` for the same reason.

Because the `virt-launcher` carrier pods never finish terminating, their bound VirtualMachineInstances (`virtualmachineinstances.kubevirt.io`) are not torn down and recreated on healthy nodes — VM failover is not triggered automatically on this install.

## Root Cause

This ACP install carries the HCO cluster default `spec.evictionStrategy: None` on the singleton `HyperConverged` CR `kubevirt-hyperconverged` in the `kubevirt` namespace, which means live-migrate-on-drain is off by default and a VMI on a NotReady node will not be auto-evacuated; the `workloadUpdateStrategy.methods=["LiveMigrate"]` setting only governs operator updates, not node-failure evacuation. Stuck `Terminating` virt-launcher pods are therefore the expected steady state after the node-lifecycle grace period expires and until the node object itself is removed or the node returns.

The standard upstream node-lifecycle loop is what drives this. The `kube-controller-manager` on this cluster runs `nodelifecycle` as part of its default `--controllers=*,bootstrapsigner,tokencleaner` set, and once `--node-monitor-grace-period=50s` passes without a kubelet heartbeat the controller flips the node's conditions to `Unknown` with reason `NodeStatusUnknown`; pod cleanup for that node then waits on the API server being able to talk to the kubelet, which by definition it cannot.

## Resolution

Confirm the node is truly unreachable (for example powered off, NIC down, or experiencing hardware failure) before taking any destructive action — deleting a node object that is only transiently disconnected will tear down pods that may still be running on it.

Once the node is confirmed unreachable, delete the node object so the control plane can finalize pod cleanup for everything that was bound to it. The node-lifecycle controller and the API server will then release the stuck `Terminating` pods, including the affected `virt-launcher-<vmi>` carriers, so that the control plane can finally clean them up; recreation of the VirtualMachineInstances on remaining healthy nodes only follows when each VMI has an owner that drives recreation (a `VirtualMachine` with a recreating `RunStrategy`, or a `VirtualMachineInstanceReplicaSet`) — a bare VMI is not relaunched by `virt-controller` on its own:

```bash
kubectl delete node <node-name>
```

Once the underlying issue is resolved, power the node back on and let it rejoin the cluster; the kubelet will re-register the node object and resume posting its status to the control plane.

## Diagnostic Steps

Inspect the node's conditions to confirm it has crossed the `NodeStatusUnknown` threshold rather than reporting a transient blip. On an unreachable node, the `Ready`, `MemoryPressure`, `DiskPressure`, and `PIDPressure` conditions all read `status: Unknown` with reason `NodeStatusUnknown`, in contrast to a healthy node where `Ready=True` carries `reason=KubeletReady` and `message=kubelet is posting ready status`:

```bash
kubectl describe node <node-name>
```

The condition messages on the unreachable node read `Kubelet stopped posting node status`, which is the kubelet-supplied wording the node-lifecycle controller surfaces once it stops receiving heartbeats.

List `Terminating` pods across all namespaces to surface the stuck virt-launcher carriers and any other workloads pinned to the unreachable node:

```bash
kubectl get pods -A | grep Terminating
```

The `STATUS` column here is the printer-synthesized phase the API server returns for pods whose `DeletionTimestamp` is set but whose graceful termination has not completed; on a healthy cluster this command returns nothing, so any hit on a single node is a strong signal to cross-check that node's `Ready` condition before proceeding.
