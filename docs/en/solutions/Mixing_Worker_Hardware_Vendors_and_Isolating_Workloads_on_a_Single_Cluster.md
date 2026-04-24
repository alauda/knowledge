---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A single ACP cluster can absorb worker nodes from different hardware vendors (one batch from Dell, another from Cisco, future expansion onto a different supplier) and still schedule workloads predictably. Kubernetes — and ACP's `configure/clusters/nodes` surface on top of it — abstracts node-level differences behind labels and node pools, so the cluster does not need to be rebuilt for each new chassis batch. This article covers the requirements for mixing vendors and the four orthogonal mechanisms that the platform exposes to isolate workloads onto specific subsets of those workers.

## Issue

Two related questions come up when a cluster grows past its first hardware refresh:

- Can workers from different vendors be added to the same cluster without splitting it?
- How should workloads be pinned to a particular vendor / generation / hardware capability without manually targeting individual nodes?

The answers are "yes, with constraints" and "use the four mechanisms below in combination". The wrong answers — running multiple clusters per vendor, or targeting nodes by name — produce operational drag that compounds at every refresh.

## Root Cause

Kubernetes treats a node as a generic compute resource described by labels (`kubernetes.io/arch`, `kubernetes.io/os`, `node.kubernetes.io/instance-type`, plus any custom labels the operator stamps). The scheduler does not care which OEM built the chassis as long as:

- Every node in the cluster runs the same CPU architecture. The scheduler will accept a node with a different arch (say, an `arm64` worker added to an `amd64` cluster), but workloads not built for that arch will fail with `exec format error` once they land. Mixed-arch clusters require multi-arch container images and explicit `nodeAffinity` on every workload — the operational cost almost always outweighs the savings.
- Every node runs a node OS that the platform supports. The platform's node lifecycle (node pool reconciliation, kubelet upgrades, kernel parameter rollouts) needs the OS to be in its supported matrix; a vendor-specific OS image typically is not.
- Every node meets the platform's minimum hardware requirements (CPU, memory, disk for the kubelet's container store, NIC for the cluster CNI).

When those three constraints are met, the rest is policy: how do workloads find the right node?

## Resolution

Combine these four primitives based on the strictness of the isolation requirement. None of them require redeploying the cluster.

1. **Node labels with `nodeSelector` (lightest touch — default-allow scheduling).** Stamp a label on each vendor's nodes; workloads opt in via `nodeSelector`. Other workloads still schedule onto the same nodes if they have no selector — labels are advisory, not exclusive.

   ```bash
   kubectl label node <dell-worker-01> hardware-vendor=dell
   kubectl label node <cisco-worker-01> hardware-vendor=cisco
   ```

   ```yaml
   spec:
     nodeSelector:
       hardware-vendor: dell
   ```

   Use this when "I want this workload near these nodes" but it is fine for other workloads to share.

2. **Taints + tolerations (strict isolation — default-deny).** Taint a node and only pods that tolerate it will land:

   ```bash
   kubectl taint node <gpu-worker-01> workload=ml-only:NoSchedule
   ```

   ```yaml
   spec:
     tolerations:
       - key: workload
         operator: Equal
         value: ml-only
         effect: NoSchedule
   ```

   Use this for nodes whose hardware (GPU, large NVMe, special NIC) should not be wasted on generic pods. The tainted node refuses any workload that lacks the matching toleration, which keeps the resource reserved for the intended consumers.

3. **Node pools (manage many nodes as a unit).** Under `configure/clusters/nodes`, group nodes that share a vendor / generation / role into a pool. The pool carries the labels, the taints, and the kubelet customisation for every node in it; adding new nodes to the pool stamps the same configuration automatically. This is the right level for isolating an entire chassis batch — never label or taint nodes one at a time once the pool exists.

   - One pool per vendor for clean chassis lifecycle (drain a pool, retire its nodes, replace them).
   - One pool per workload class (`ingress`, `compute-heavy`, `storage-heavy`) when the chassis is uniform but the workloads are not.
   - Avoid overlapping pools — a node that belongs to two pools picks up both pools' kubelet customisations and the merge order can surprise you (see the related article on `KubeletConfig` selectors that miss pool labels).

4. **Namespaces with default scheduling rules (organisational isolation, not hardware).** Project / namespace boundaries are about *who* can see and manage a workload, not *which* node it runs on. Use them for tenant isolation, RBAC, and quota — not for hardware steering. To bind every pod in a namespace to a specific node pool, use a `PodNodeSelector` admission plugin (or its ACP equivalent in the `security/project` configuration), which stamps a `nodeSelector` onto every pod admitted to the namespace.

### Combine them — typical patterns

- **Reserved hardware for one team:** taint the nodes (`team=alpha:NoSchedule`), and add the same toleration to that team's namespace via a default-toleration admission plugin, plus a `nodeSelector` so accidental cross-tenant scheduling is impossible even if a third party guesses the toleration.
- **Mixed vendor worker pool, one workload requires Dell-specific NIC offload:** keep all workers in one pool, label the Dell subset, set `nodeAffinity` on the workload (preferred-during-scheduling, with a `hardware-vendor=dell` rule). The pod prefers Dell nodes but can fall back to Cisco if Dell capacity is exhausted.
- **GPU node added later from a different vendor:** put the GPU node in its own pool (its own kubelet config can carry the device plugin DaemonSet selector), taint it, and let only GPU-requesting workloads tolerate the taint.

## Diagnostic Steps

Verify a node carries the labels and taints that its pool says it should:

```bash
kubectl get node <node> -o jsonpath='{.metadata.labels}' | jq .
kubectl get node <node> -o jsonpath='{.spec.taints}' | jq .
```

Compare against the pool's declared label / taint set:

```bash
kubectl get <nodepool-kind> <pool-name> -o yaml | grep -A5 -E 'labels:|taints:'
```

If they disagree, the pool's reconciler has not finished rolling — wait for the rollout, or check the pool's status conditions.

For a workload that is not landing where expected, ask the scheduler for the per-predicate verdict:

```bash
kubectl get pod <stuck-pod> -o yaml | grep -A20 status
kubectl get events --field-selector involvedObject.name=<stuck-pod>
```

A `0/N nodes are available: M node(s) had untolerated taint {workload: ml-only}` event tells you exactly which constraint excluded the node — usually a missing toleration on the pod or a missing label on the target node.

When mixing architectures by accident, the symptom is a successfully scheduled pod that immediately fails to start. Check the node arch the pod landed on:

```bash
kubectl get pod <pod> -o jsonpath='{.spec.nodeName}{"\n"}' \
  | xargs -I{} kubectl get node {} -o jsonpath='{.metadata.labels.kubernetes\.io/arch}{"\n"}'
```

If the architecture differs from the image's manifest, add `nodeAffinity` requiring `kubernetes.io/arch` to match the supported architectures, or rebuild the image as a multi-arch manifest list.
