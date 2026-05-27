---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500231
---

# ArgoCD redis-ha-haproxy stuck Pending during rollout on a node-count-equal-to-replicas cluster

## Issue

On Alauda Container Platform, the `argocd` ModulePlugin applies a stock ArgoCD CR named `argocd-gitops` in namespace `argocd` (chart `chart-argocd-installer v4.2.0`). When the CR has `.spec.ha.enabled=true`, the operator materializes an `argocd-gitops-redis-ha-haproxy` Deployment with `replicas: 3`, fronting the `argocd-gitops-redis-ha-server` redis StatefulSet. During a rolling update of this Deployment on a cluster whose worker node count equals the replica count, a freshly created surge pod is observed in `0/1 Pending` alongside the three `Running` replicas, following the upstream `<deployment>-<rs-hash>-<suffix>` naming scheme.

## Root Cause

The `argocd-gitops-redis-ha-haproxy` pod template sets a hard hostname-spread rule: `podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution` with `labelSelector.matchLabels.app.kubernetes.io/name=argocd-gitops-redis-ha-haproxy` at `topologyKey: kubernetes.io/hostname`, plus a soft `preferredDuringSchedulingIgnoredDuringExecution` term at `failure-domain.beta.kubernetes.io/zone` weight 100; the hard hostname term forces every replica onto a distinct node. The same Deployment uses `strategy.type: RollingUpdate` with `rollingUpdate.maxSurge: 25%` and `rollingUpdate.maxUnavailable: 25%`.

The Kubernetes Deployment contract for `maxSurge` calculates the absolute number from the percentage by rounding up, so 25% of 3 replicas allows 1 extra surge pod created before any existing replica is torn down. The contract for required pod anti-affinity is that if the anti-affinity requirements are not met at scheduling time, the pod will not be scheduled onto the node. With three existing replicas already pinned one-per-node by the `kubernetes.io/hostname` term, a 4th surge pod carrying the same `app.kubernetes.io/name` label has no node left that satisfies the required term and therefore remains Pending until the rollout aborts or a fourth node becomes available.

## Resolution

The collision is a property of the Deployment shape rendered when `.spec.ha.enabled=true` interacts with a cluster whose worker count equals the redis-ha-haproxy replica count. Two operator-surface workarounds avoid it; both edit the `argocd-gitops` ArgoCD CR in namespace `argocd` (haproxy container image `build-harbor.alauda.cn/3rdparty/haproxy:2.0.34-alpine-2`, chart `chart-argocd-installer v4.2.0`) and let the operator reconcile the change down into the `argocd-gitops-redis-ha-haproxy` Deployment.

Option A — disable HA on the ArgoCD CR. This collapses the 3-replica redis-ha-haproxy Deployment so the surge-vs-anti-affinity collision cannot recur. Set `.spec.ha.enabled=false` and let the operator tear down the redis-ha-haproxy Deployment and the redis-ha StatefulSet:

```bash
kubectl patch argocd -n argocd argocd-gitops \
 --type merge \
 -p '{"spec":{"ha":{"enabled":false}}}'
```

Option B — override the redis-ha-haproxy pod template's anti-affinity so the hard hostname term becomes soft. Relaxing the required term to a `preferredDuringSchedulingIgnoredDuringExecution` rule keeps the spread preference but lets the surge pod schedule on a node that already hosts a matching replica, breaking the deadlock. The override must be expressed through the `argocd-gitops` ArgoCD CR's `.spec.ha` block (which owns the redis-ha-haproxy Deployment via the operator reconcile chain) rather than by editing the Deployment directly, because operator-managed Deployments are reverted on the next reconcile loop.

After either change, watch the Deployment until the surge pod clears:

```bash
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy
kubectl get pod -n argocd -l app.kubernetes.io/name=argocd-gitops-redis-ha-haproxy -o wide
```

## Diagnostic Steps

Confirm the Deployment shape and replica count that the operator rendered from `argocd-gitops`:

```bash
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy \
 -o jsonpath='{.spec.replicas}{"\n"}'
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy \
 -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}{"\n"}'
```

Read the rolling-update strategy on the Deployment — `maxSurge: 25%` plus `maxUnavailable: 25%` is the shape that drives the 1-extra-pod surge math on a 3-replica Deployment:

```bash
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy \
 -o jsonpath='{.spec.strategy}{"\n"}'
```

Read the pod template's affinity to confirm the required `kubernetes.io/hostname` term carries `labelSelector.matchLabels.app.kubernetes.io/name=argocd-gitops-redis-ha-haproxy` (the own-ReplicaSet match is what makes the surge pod un-schedulable when every node already hosts a replica):

```bash
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy \
 -o jsonpath='{.spec.template.spec.affinity.podAntiAffinity}{"\n"}'
```

List the haproxy pods with node placement; the precondition for the collision is one matching pod per node on every worker — i.e. no node free to host a 4th replica:

```bash
kubectl get pod -n argocd \
 -l app.kubernetes.io/name=argocd-gitops-redis-ha-haproxy \
 -o wide
```

If a Pending pod is present, `kubectl describe pod` on it surfaces the standard scheduler event for the required term — node count and matching pods enumerated — which matches the contract that an unsatisfied required anti-affinity term keeps the pod off every node:

```bash
kubectl describe pod -n argocd <pending-haproxy-pod-name>
```
