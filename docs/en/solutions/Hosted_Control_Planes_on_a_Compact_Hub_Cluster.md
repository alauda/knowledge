---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A bare-metal hub cluster is built as a 3-node compact deployment — every node serves both as a control-plane node and as a workload host. The team wants to run **Hosted Control Planes** (HCP) on this hub: each managed cluster's control plane lives in pods on the hub, while its data plane runs elsewhere. Two questions come up:

1. Is it valid to host control planes on a hub that has no separate worker nodes?
2. Once the hosted clusters are running, the platform reports the hub as still consuming the same entitlements as a hub-with-workers, even though the only "workloads" are hosted-control-plane pods. Is the count correct, and how can it be made representative?

## Root Cause

Hosted Control Plane (the **Hosted Control Plane** extension component, based on the upstream HyperShift project) installs each managed cluster's API server, etcd, controller-manager, and scheduler as pods inside the hub's namespace, then advertises an external endpoint for the data-plane nodes to join. In a compact hub the only place those pods *can* land is on the three control-plane-and-worker nodes — there is no dedicated worker pool to schedule them onto.

This is supported, but with two consequences that surprise operators on first encounter:

1. **Resource contention.** A hosted control plane is not free: each one runs a small etcd, an API server, and several controllers. Stacking several hosted control planes onto three nodes that already host the hub's own control plane consumes meaningful CPU/memory and competes with cluster operators on the same nodes.
2. **Entitlement counting.** The platform's subscription accounting attributes a node's entire capacity to the hub unless the operator opts in to a labelling scheme that distinguishes "infrastructure" workloads (cluster operators, hosted control planes) from "user" workloads. On a compact hub with no user workloads at all, the operator must explicitly mark the nodes as infrastructure-only so that hosted control plane pods do not register as user workload, and so the subscription metric reflects what the cluster is really doing.

## Resolution

Treat the compact-hub HCP topology as a **deliberate trade-off**: it is genuinely compact (one cluster instead of two), but it is not a production-grade setup for high-volume hosted clusters. Limit the number of hosted control planes per compact hub to a small handful (a frequently cited ceiling is three), and schedule them onto the hub's nodes with a clear infrastructure-vs-user split.

### 1. Label the hub nodes as infrastructure

Mark every hub node with the infrastructure role label. The Hosted Control Plane operator reads this label to decide where its hosted-cluster pods are allowed to run, and the subscription accounting reads the same label to determine which capacity is "shared infrastructure" rather than user workload.

```bash
for n in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  kubectl label node "$n" node-role.kubernetes.io/infra="" --overwrite
done
```

The control-plane role stays in place — these nodes are *both* control-plane and infra. Do not remove `node-role.kubernetes.io/control-plane`.

### 2. Tell the Hosted Control Plane operator to schedule onto infra

Configure the operator (the `HostedClusterConfig`/equivalent CR for the **Hosted Control Plane** product) so its rendered Deployments include a `nodeSelector` matching `node-role.kubernetes.io/infra: ""`. Once applied, every new hosted control plane pod is bound to the labelled nodes; existing hosted control planes are rolled when the operator reconciles the configuration.

### 3. Avoid `masterSchedulable=false` and infra taints

Two intuitively-appealing tightenings should be **left off** on a compact hub:

- **Setting the control-plane nodes non-schedulable.** This breaks the entire setup, because there are no worker nodes to fall back to — required cluster operator pods will sit `Pending`.
- **Adding a `node-role.kubernetes.io/infra:NoSchedule` taint.** Same failure mode: cluster operators that do not tolerate the taint cannot schedule, and they too go `Pending`.

The compact hub's safety boundary is not enforced by taints; it is enforced operationally — a documented rule that no user workload is admitted to the hub. Make this explicit in admission policy (e.g. an OPA/Kyverno rule rejecting non-system namespaces on the hub) rather than relying on scheduler primitives that this topology can't tolerate.

### 4. Cap the number of hosted clusters

Three hosted control planes per compact hub is a reasonable ceiling. Beyond that, the hub's three nodes start to compete for memory between the platform's own etcd and the hosted etcds, which is the failure mode users hit first. If more hosted clusters are needed, switch the hub to a non-compact layout (separate worker pool) and migrate the hosted-cluster pods onto the worker pool.

## Diagnostic Steps

Confirm the infra labelling is in place on every hub node:

```bash
kubectl get nodes -L node-role.kubernetes.io/control-plane,node-role.kubernetes.io/infra
```

Inspect where each hosted control plane pod has actually landed. The exact label used to mark hosted-control-plane workloads varies with the operator version (typically a key under the hosted-control-plane group); check the operator's CRD reference for the current value, then list pods carrying it:

```bash
kubectl get pods -A -o wide \
  -l hosted-control-plane=true \
  --sort-by=.spec.nodeName
```

Every row should show one of the three hub nodes; any pod that landed elsewhere means the operator's `nodeSelector` did not get the infra label, or a hosted cluster's component overrides the default placement.

Spot-check resource pressure on the hub:

```bash
kubectl top nodes
kubectl top pods -A --sort-by=memory | head -n 30
```

Memory is usually the first resource to bind. If the top consumers are `etcd-*` pods belonging to multiple hosted clusters and the hub's own etcd, the hub is near its capacity for hosted control planes — plan a scale-out before adding another hosted cluster.

If subscription metrics still report the hub as "user workload" capacity, double-check that:

1. Every hub node has `node-role.kubernetes.io/infra` set,
2. No user-namespace pods are running on the hub (`kubectl get pods -A --field-selector=spec.nodeName=<hub-node> -o wide` should list only system and hosted-control-plane workloads),
3. The Hosted Control Plane operator's CR explicitly references the infra selector for its rendered deployments.
