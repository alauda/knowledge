---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500279
---

# Running mixed-vendor worker nodes and isolating workloads on ACP

## Overview

On Alauda Container Platform (install package v4.3.13, Kubernetes v1.34.5), worker nodes are abstracted by the kubelet and container runtime, which surface only generic node facts — CPU architecture, operating system, kubelet version, and container-runtime version — through `node.status.nodeInfo`, and never the underlying hardware vendor. Because that layer treats every node identically regardless of the machine it runs on, worker nodes sourced from different hardware vendors can join and operate in the same cluster as one homogeneous node pool.

One constraint applies across the whole cluster: all nodes must share the same CPU architecture. The architecture of each node is reported in `node.status.nodeInfo.architecture`, and because container images and the scheduler are built around a single architecture, mixing architectures (for example `amd64` and `arm64`) within one cluster is not supported.

This article covers the supported, vendor-neutral ways to keep workloads pinned to the nodes intended for them — node labels with `nodeSelector`, node taints with pod tolerations, and namespaces for tenant isolation.

## Resolution

To pin workloads to a specific set of worker nodes, label those nodes and set a matching `nodeSelector` on the pods so the scheduler places them only on the labelled nodes. Every node already carries built-in labels usable as selector targets — `kubernetes.io/os`, `kubernetes.io/arch`, and `kubernetes.io/hostname` — and a custom label can be added for finer-grained grouping.

Add a custom label to each node in the target group:

```bash
kubectl label node <node-name> workload-tier=batch
```

Reference the label from the pod template's `nodeSelector`. The API server admits this scheduling field unchanged, so only nodes carrying the matching label become candidates:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: batch-worker
spec:
  nodeSelector:
    workload-tier: batch
  containers:
    - name: app
      image: <image>
```

A complementary approach repels workloads from a set of nodes instead of attracting them: taint the nodes and grant matching tolerations only to the pods allowed there, so the scheduler keeps non-tolerating pods off the tainted nodes. By default the worker nodes carry no taints, so this isolation is opt-in and is applied explicitly with `kubectl taint`.

Taint the nodes that should be reserved:

```bash
kubectl taint node <node-name> dedicated=batch:NoSchedule
```

Give the eligible pods a matching toleration; the API server admits the `tolerations` field unchanged:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: batch-worker
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: batch
      effect: NoSchedule
  containers:
    - name: app
      image: <image>
```

Labels with `nodeSelector` and taints with tolerations compose well: the toleration lets a pod onto a reserved node, while the `nodeSelector` keeps it from drifting onto other nodes.

For separating workloads by tenant rather than by node, use namespaces. The platform uses the core Kubernetes `Namespace` object for this, and multi-tenant isolation is built on plain namespaces combined with RBAC; grouping each tenant's workloads into its own namespace is the recommended isolation boundary at the cluster level.

```bash
kubectl create namespace team-batch
```

## Diagnostic Steps

To confirm a cluster meets the single-architecture requirement, inspect the reported architecture of every node; all values must match before any mixed-vendor node pool is considered consistent:

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.architecture}{"\n"}{end}'
```

The same node-status fields reveal the operating system, kubelet version, and container-runtime version that the platform abstracts uniformly across vendors, which is the basis for mixed-vendor coexistence:

```bash
kubectl get nodes -o wide
```

To verify which nodes are reserved by a taint before scheduling tolerating workloads, list the taints per node:

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
```
