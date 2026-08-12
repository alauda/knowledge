---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After upgrading the ACP Virtualization Operator, live migration fails for VMs that had been live-migrated at least once before the upgrade:

- The target `virt-launcher` pod stays in `Pending` because no node satisfies its scheduling requirements.
- Newly created or cold-restarted VMs migrate successfully.
- The problem is observed on worker nodes running on Intel Emerald Rapids CPUs.

## Root Cause

Older `libvirt` builds do not have an exact match for Emerald Rapids and report `SapphireRapids` as the `host-model`. While that was the reported model, the KubeVirt `node-labeller` applied the label `cpu-model-migration.node.kubevirt.io/SapphireRapids=true` to every node, and any VM that live-migrated during that period picked up a matching `nodeSelector` on its `virt-launcher` pod.

A newer `libvirt` shipped with the updated operator adds a proper entry for Emerald Rapids, which it reports as `SierraForest`. Once the upgrade is applied and the node-labeller re-runs, the `SapphireRapids` label is removed and replaced with `SierraForest`. VMs that still carry the `SapphireRapids` nodeSelector on their `virt-launcher` pod no longer match any node in the cluster, and migration targets fail to schedule.

In addition, the affected build reports the `SapphireRapids` CPU model as `usable=no` in `domcapabilities`, so even a workaround that re-pins the old label on a single node cannot satisfy new migrations reliably.

## Resolution

There are two workarounds. Pick the one that fits the maintenance window for the affected VMs.

**Option A — cold-restart the affected VMs (preferred).** Stopping and starting the VM creates a fresh `virt-launcher` pod without the stale `SapphireRapids` nodeSelector. Subsequent live migrations work as expected.

**Option B — re-apply the missing node label (no VM restart).** For each worker node on which the affected VMs must be able to run:

```bash
# Tell the node-labeller to skip this node so our manual label survives
kubectl annotate node <node> node-labeller.kubevirt.io/skip-node=true

# Re-apply the label the stuck VMs still reference
kubectl label node <node> cpu-model-migration.node.kubevirt.io/SapphireRapids=true
```

Apply Option B only after the operator upgrade has completed. If the node-labeller had been disabled prior to upgrade, re-enable it first, let it re-label the nodes, and then apply the annotate-plus-label step.

Option A is preferred once a maintenance window is available, because Option B pins a CPU model that the host no longer reports as usable.

## Diagnostic Steps

Inspect a failing VM's `virt-launcher` pod for the stale nodeSelector:

```bash
kubectl get pod <virt-launcher-pod> -o yaml | yq '.spec.nodeSelector'
# cpu-model-migration.node.kubevirt.io/SapphireRapids: "true"
```

Compare node labels — post-upgrade, the `SapphireRapids` label is gone and `SierraForest` is present instead:

```bash
kubectl get node --show-labels | grep cpu-model-migration
```

Check `domcapabilities` from the affected VM's `virt-launcher` pod to confirm the CPU model reported by `libvirt`. A fresh post-upgrade pod reports `SierraForest`, while any pod carrying the old model predates the upgrade:

```bash
kubectl exec <virt-launcher-pod> -- virsh domcapabilities | grep -A1 'model'
```
