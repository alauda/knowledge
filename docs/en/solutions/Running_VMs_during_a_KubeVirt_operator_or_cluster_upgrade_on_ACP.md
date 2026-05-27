---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500239
---

# Running VMs during a KubeVirt operator or cluster upgrade on ACP

## Issue

On Alauda Container Platform, the Virtualization (KubeVirt) capability ships as the `kubevirt-hyperconverged` operator, driven by the upstream HyperConverged Cluster Operator (HCO). The control plane runs in the `kubevirt` namespace (`virt-operator`, `virt-handler`, `virt-controller`, `virt-api`) and registers the standard upstream VM lifecycle CRDs — `virtualmachines.kubevirt.io`, `virtualmachineinstances.kubevirt.io`, and `virtualmachineinstancemigrations.kubevirt.io` — alongside the HCO control-plane CRD `hyperconvergeds.hco.kubevirt.io`. Virtualization administrators planning to upgrade the operator or the underlying platform need to know whether Virtual Machines that are currently running will be shut down or paused as part of the upgrade.

## Root Cause

Upgrading the `kubevirt-hyperconverged` operator is designed so that running Virtual Machines are not expected to be shut down or paused. The HyperConverged CR carries `spec.workloadUpdateStrategy`, and on this cluster `workloadUpdateMethods` is set to `["LiveMigrate"]`; HCO propagates the same `LiveMigrate` strategy down to the embedded KubeVirt CR it reconciles during the upgrade. When new `virt-launcher` images roll out, this strategy is intended to live-migrate running VMs rather than stop them, with the migration paced as a rolling update (`batchEvictionSize=10`, `batchEvictionInterval=1m0s`) rather than performed as a bulk stop.

Upgrading the underlying platform is likewise not expected to shut down or pause running Virtual Machines beyond the disruption inherent to the node reboots that any node upgrade entails. The live-migration machinery that handles workload eviction is present and running — the `kubevirt-migration-controller` and a `virt-handler` DaemonSet (one pod per node) — so that VMs can be migrated off a node as it is drained for an upgrade.

## Resolution

No special action is required to keep running VMs alive across either an operator upgrade or a platform upgrade: the `LiveMigrate` workload-update strategy configured on the HyperConverged CR — and propagated to the embedded KubeVirt CR — is what governs this behavior. Before relying on this, confirm the workload-update strategy is in effect, and review any version-specific prerequisites or behavioral changes for the operator and platform releases involved in the upgrade so they can be accounted for ahead of time.

This cluster runs the KubeVirt operator at image `build-harbor.alauda.cn/3rdparty/kubevirt/virt-operator:v1.7.0-alauda.2` (HCO operator 1.17.0; observed KubeVirt version `v1.7.0-alauda.2`), and the operator self-reports `Upgradeable=True`, `Available=True`, `Degraded=False`, consistent with a non-disruptive upgrade path.

## Diagnostic Steps

Confirm the workload-update strategy that governs how running VMs are handled when the operator rolls new `virt-launcher` images. Read it from the singleton HyperConverged CR in the `kubevirt` namespace:

```bash
kubectl get hyperconverged -n kubevirt \
  -o jsonpath='{.items[0].spec.workloadUpdateStrategy}'
```

A `workloadUpdateMethods` list containing `LiveMigrate` confirms that running VMs are live-migrated rather than shut down or paused on an operator upgrade. Confirm the live-migration controller and the per-node `virt-handler` DaemonSet are present and running, since they perform the eviction and migration during operator and node upgrades:

```bash
kubectl get pods -n kubevirt
kubectl get daemonset -n kubevirt virt-handler
```
