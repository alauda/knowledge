---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After upgrading the ACP GitOps component (Argo CD) on a cluster with exactly three schedulable worker nodes, the `redis-ha-haproxy` Deployment that fronts the Argo CD Redis HA tier never completes its rollout. A fourth replica is created alongside the three Running ones and remains `Pending` indefinitely:

```text
gitops-redis-ha-haproxy-745cb8db58-8jscz   0/1   Pending   0   32s
gitops-redis-ha-haproxy-85dbf4d9c-56vjr    1/1   Running   0   9m59s
gitops-redis-ha-haproxy-85dbf4d9c-wkbwh    1/1   Running   0   9m59s
gitops-redis-ha-haproxy-85dbf4d9c-zvfjs    1/1   Running   0   9m59s
```

The Deployment's desired replica count is three, but during the upgrade a surge pod is scheduled before any existing pod is terminated, and no node is available to host it.

## Root Cause

The `redis-ha-haproxy` Deployment combines a hard pod anti-affinity rule with a surging rolling-update strategy. The anti-affinity is `requiredDuringSchedulingIgnoredDuringExecution` keyed on `kubernetes.io/hostname`, so every replica must land on a distinct node:

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: gitops-redis-ha-haproxy
        topologyKey: kubernetes.io/hostname
```

The upgrade then applies the default surge strategy:

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 25%
    maxSurge: 25%
```

`maxSurge: 25%` against three replicas rounds up to one, so the controller creates a fourth pod *before* it terminates any of the three existing pods. On a three-worker cluster, every node already hosts a replica of the same Deployment, so the hard anti-affinity rule rejects every candidate node and the new pod stays `Pending`. The rollout never progresses because no existing pod is evicted to make room.

## Resolution

The root fix is to prevent the surge so the rollout has to terminate a pod before creating the replacement. The upstream Argo CD project addressed the same condition in `GITOPS-8033` by shipping patched charts where `maxSurge: 0` on this Deployment; those fixes were picked up in the corresponding Argo CD 1.17.3 / 1.18.2 rebuild. On ACP GitOps, move to a release that carries the fix and re-run the rollout.

Preferred path on ACP — bump the GitOps component to a version that carries the upstream fix, then let the operator reconcile the Deployment:

```bash
kubectl -n <gitops-namespace> get argocd
kubectl -n <gitops-namespace> describe argocd <name> | grep -i version
```

If an immediate upgrade is not possible, patch the Deployment manually. On ACP GitOps the operator owns this field and will reconcile it back, so the patch is a temporary unblock rather than a permanent edit — pair it with scheduling the upgrade.

```bash
kubectl -n <gitops-namespace> patch deployment gitops-redis-ha-haproxy \
  --type=strategic \
  -p '{"spec":{"strategy":{"rollingUpdate":{"maxSurge":0,"maxUnavailable":1}}}}'
```

With `maxSurge: 0` / `maxUnavailable: 1`, the Deployment drops a pod first, which frees the node, then schedules the replacement onto the now-empty slot. The three-node hard anti-affinity constraint is satisfied at every step.

If using a raw upstream Argo CD Helm chart (no operator), set the same values directly on the HAProxy sub-chart:

```yaml
redis-ha:
  haproxy:
    deploymentStrategy:
      type: RollingUpdate
      rollingUpdate:
        maxSurge: 0
        maxUnavailable: 1
```

A lasting mitigation on any permanent three-worker footprint is to add at least one more worker (or label a dedicated control-plane node as schedulable for this workload). With four nodes available, the surge pod has somewhere to go and the rollout completes even without the strategy tweak.

## Diagnostic Steps

1. Confirm the Pending pod is blocked on scheduling, not on image pull or resource requests:

   ```bash
   kubectl -n <gitops-namespace> get pod -l app.kubernetes.io/name=gitops-redis-ha-haproxy
   kubectl -n <gitops-namespace> describe pod <pending-pod>
   ```

   Look at the `Events` section. A scheduler message such as `0/6 nodes are available: 3 node(s) didn't match pod anti-affinity rules, 3 node(s) had untolerated taints` confirms the diagnosis — three workers are already occupied, the other three are control-plane or tainted.

2. Check the anti-affinity rule on the Deployment:

   ```bash
   kubectl -n <gitops-namespace> get deploy gitops-redis-ha-haproxy \
     -o jsonpath='{.spec.template.spec.affinity.podAntiAffinity}' | jq .
   ```

   A `requiredDuringSchedulingIgnoredDuringExecution` entry on `topologyKey: kubernetes.io/hostname` with a matching `labelSelector` is the hard constraint driving the stall.

3. Check the current rolling update strategy and compare against your worker count:

   ```bash
   kubectl -n <gitops-namespace> get deploy gitops-redis-ha-haproxy \
     -o jsonpath='{.spec.strategy}' | jq .
   kubectl get nodes -l node-role.kubernetes.io/worker= -o name | wc -l
   ```

   If `replicas == workers` and `maxSurge > 0`, every rollout will hit this exact symptom until the Deployment is patched or another worker is added.

4. Watch the rollout progress after applying the patch or upgrade:

   ```bash
   kubectl -n <gitops-namespace> rollout status deploy/gitops-redis-ha-haproxy --timeout=5m
   ```

   A clean rollout returns `deployment "gitops-redis-ha-haproxy" successfully rolled out` without any intermediate Pending pod.
