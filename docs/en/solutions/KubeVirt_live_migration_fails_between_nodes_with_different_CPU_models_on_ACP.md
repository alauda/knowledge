---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# KubeVirt live migration fails between nodes with different CPU models on ACP

## Issue

On Alauda Container Platform Virtualization for KubeVirt (plugin `kubevirt-hyperconverged-operator.v4.3.5`, KubeVirt `v1.7.0-alauda.1`, HCO installed in the `kubevirt` namespace), a cluster whose nodes carry different physical CPU types cannot reliably live-migrate every VM between arbitrary nodes. A VirtualMachine whose `spec.template.spec.domain.cpu.model` is left at the `host-model` default takes on the exact CPU model of the node it was scheduled onto, so it is only able to migrate to a node that also supports that same model. When the nodes do not share a common model, a VM pinned to a model that exists on only one node has no compatible migration target.

## Root Cause

The KubeVirt node-labeller records, per node, which CPU models that node natively supports for VM scheduling using `cpu-model.node.kubevirt.io/<model>` labels. It separately records which CPU models a node can accept as a live-migration target using `cpu-model-migration.node.kubevirt.io/<model>` labels. On a heterogeneous cluster these label families do not advertise the same models on every node — the scheduling label sets differ from node to node, reflecting the differing physical CPUs.

The migration label set on a node is a strict superset of, and can differ from, that node's scheduling label set. A node can therefore advertise a model under `cpu-model-migration.node.kubevirt.io/<model>` (it can host that model as a migration target) while not advertising the same model under `cpu-model.node.kubevirt.io/<model>` (it would not schedule a new VM onto that model). Because a `host-model` VM pins to the exact model of its scheduling node, the combination of pinned model and divergent per-node label sets is what leaves a VM without a usable migration target.

## Resolution

Set a cluster-wide default CPU model that is common to all nodes, choosing the latest CPU model present in the scheduling labels of every node. The `HyperConverged` CR (`hco.kubevirt.io/v1beta1`) exposes `spec.defaultCPUModel`, which is empty by default; while it is unset and a VM leaves its CPU model unset, the VM falls back to `host-model` and pins to its scheduling node. Setting `defaultCPUModel` to a model that every node advertises for scheduling gives all VMs a portable model so they can migrate across the heterogeneous nodes.

Apply the value to the singleton `HyperConverged` CR in the `kubevirt` namespace:

```bash
kubectl patch hyperconverged -n kubevirt kubevirt-hyperconverged \
  --type merge \
  -p '{"spec":{"defaultCPUModel":"<model-common-to-all-nodes>"}}'
```

Choose the model carefully: a model that appears only in the `cpu-model-migration.node.kubevirt.io` labels but not in any `cpu-model.node.kubevirt.io` scheduling label has no scheduling label for the scheduler to match, so setting it as `defaultCPUModel` may leave a VM unable to start or schedule. Restrict the chosen value to models that are present in the scheduling label set of every node.

## Diagnostic Steps

Enumerate the CPU models each node advertises for scheduling by reading the `cpu-model.node.kubevirt.io` labels across the nodes; the leading count from `uniq -c` is the number of nodes advertising that model, and a model whose count is below the total node count is not common to all nodes:

```bash
kubectl get nodes -l kubernetes.io/os=linux -o yaml \
  | grep 'cpu-model.node.kubevirt.io' \
  | sort | uniq -c
```

To choose a safe `defaultCPUModel`, compare the scheduling labels against the migration labels on the same node. A model that shows up only under `cpu-model-migration.node.kubevirt.io` is a migration-target-only model and must not be selected as the default:

```bash
kubectl get node <node> -o yaml \
  | grep -E 'cpu-model(-migration)?\.node\.kubevirt\.io' \
  | sort
```

A model that is present under `cpu-model.node.kubevirt.io` on every node is a valid common scheduling model and is a safe candidate for `defaultCPUModel`.
