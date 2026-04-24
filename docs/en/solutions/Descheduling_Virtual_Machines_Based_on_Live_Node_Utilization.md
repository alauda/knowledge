---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Stock descheduler profiles only react to **static** signals — request/limit ratios, pod count per node, taints. They do not move workloads when a node's *actual* CPU, memory, or network utilization spikes, which is the symptom that matters most in mixed virtualization clusters where a few resource-hungry virtual machines can saturate a host while peers idle.

Operators want a descheduler profile that:

- consumes live node-level metrics (CPU, memory, network) from the platform monitoring stack,
- preferentially evicts virtualization workloads (so the cluster gains the benefit of live migration instead of cold restart),
- coexists with the regular long-running-workload safeguards already in place.

## Root Cause

The default `LowNodeUtilization`/`HighNodeUtilization` strategies in the open-source descheduler use the kubelet's request-based view of capacity, not the metrics pipeline. That view is correct for batch scheduling but lags reality on virtualization hosts where:

- a virtual machine often requests far less than it actually consumes (CPU is shared, not pinned),
- network bandwidth is not modelled in pod requests at all,
- live migration (rather than restart) is preferred for re-balancing — but the open-source descheduler does not know which workload is a virtual machine and which is a regular pod.

A virtualization-aware profile is required: one that reads observed utilization, identifies the eviction candidate as a `VirtualMachineInstance`, and triggers a live migration rather than a destructive eviction.

## Resolution

### Preferred: ACP Virtualization Scheduling

The ACP `virtualization` capability ships descheduler integration tuned for virtual-machine workloads, fed by the platform `observability/monitor` metrics. Operators are expected to enable rebalancing through the ACP virtualization page rather than authoring a raw descheduler profile by hand — that path also handles the interaction with the cluster's pod-disruption budgets and the live-migration policy in one place.

The profile that does the live-utilization rebalancing for virtual machines is exposed as **KubeVirtRelieveAndMigrate** (or its ACP-surface equivalent). Once enabled, the descheduler watches node utilization, identifies hot nodes, picks `VirtualMachineInstance` candidates, and triggers live migration instead of pod eviction.

### Underlying Mechanics

For environments tuning the descheduler directly, enable the `KubeVirtRelieveAndMigrate` profile on the descheduler resource. A minimal shape looks like:

```yaml
apiVersion: operator.kubedescheduler.io/v1
kind: KubeDescheduler
metadata:
  name: cluster
  namespace: <descheduler-namespace>
spec:
  profiles:
    - KubeVirtRelieveAndMigrate
  profileCustomizations:
    devEnableEvictionsInBackground: true
```

Important constraints to verify before rollout:

- **Do not enable `LongLifeCycle` and `KubeVirtRelieveAndMigrate` together.** The two profiles are mutually exclusive — `LongLifeCycle` deliberately *avoids* moving long-running pods, while the virtualization profile *wants* to move them. Combining them produces unpredictable eviction decisions.
- The profile depends on node-level utilization metrics being scraped by the platform's Prometheus stack. Confirm the underlying `NodeMetrics` API is populated before relying on the profile.
- The profile only triggers live migration for VirtualMachineInstances that are **actually migrateable** — non-shared root disks, host-device passthrough, or vTPM without a target backend will downgrade the action to no-op. Validate migration eligibility in advance.

When the goal is just to balance regular pods (no virtual machines involved), use a tuned `LowNodeUtilization` profile instead — it is cheaper and does not require the metrics pipeline.

## Diagnostic Steps

Confirm the profile is loaded:

```bash
kubectl -n <descheduler-namespace> get kubedescheduler/cluster \
  -o jsonpath='{.spec.profiles}{"\n"}'
```

Watch the descheduler decide:

```bash
kubectl -n <descheduler-namespace> logs -l app=descheduler --tail=200 \
  | grep -E 'KubeVirtRelieveAndMigrate|migrating|evicting'
```

A successful eviction of a virtualization workload should appear in the KubeVirt event stream as a `Migrating` event on the VMI, **not** as a `Killing` event on the underlying virt-launcher pod:

```bash
kubectl get events -A \
  --field-selector involvedObject.kind=VirtualMachineInstance \
  --sort-by=.lastTimestamp | tail -n 20
```

If the descheduler keeps logging "no candidates" while nodes are clearly hot, check:

1. that node utilization is actually visible to the descheduler — `kubectl top nodes` should return non-zero values,
2. that the candidate VMIs are migrateable (`kubectl get vmi <name> -o jsonpath='{.status.conditions}'`),
3. that no `PodDisruptionBudget` is blocking the move (the descheduler honours PDBs and will skip rather than violate them).
