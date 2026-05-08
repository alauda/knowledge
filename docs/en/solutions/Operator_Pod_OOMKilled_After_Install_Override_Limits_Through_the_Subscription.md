---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Operator Pod OOMKilled After Install — Override Limits Through the Subscription
## Issue

An operator installed through OLM enters a crash loop shortly after its initial rollout. The `Subscription` reports `AtLatestKnown`, the `InstallPlan` is `Complete`, and the `ClusterServiceVersion` reaches `Succeeded`, but the operator's controller-manager pod oscillates between `CrashLoopBackOff` and `OOMKilled`:

```bash
kubectl -n cluster-observability-operator get pod \
  | grep -v Running
# NAME                                      READY   STATUS             RESTARTS
# observability-operator-6f58b549d4-r42pn   0/1     CrashLoopBackOff   7 (12s ago)
```

The pod's last-terminated state confirms the kernel OOM-killer was the cause:

```bash
kubectl -n cluster-observability-operator get pod <pod> -o json \
  | jq '.status.containerStatuses[0].lastState.terminated'
# {
#   "exitCode": 137,
#   "reason": "OOMKilled",
#   ...
# }
```

The shipped defaults for some operator packages include container `limits.memory` values that are lower than the actual working set of the controller on a busy cluster. The operator's in-cluster workload (CRD watches, lease renewal, informer caches) grows proportionally to the number of managed objects, so the out-of-the-box limit is correct for a small environment and undersized for a larger one.

This note uses the Cluster Observability Operator as the concrete example, but the mechanism applies to any OLM-managed operator whose controller pod is `OOMKilled` right after install or after a workload-scale increase.

## Root Cause

Every `ClusterServiceVersion` carries a pod template for the operator's deployment, including the `resources` block. When the pod hits `limits.memory`, the kernel OOM-killer reaps it, kubelet restarts the container, and the cycle repeats — memory pressure does not clear itself because the operator's working set is a function of cluster state, not of the restart.

Editing the `Deployment` directly does not help: OLM reconciles the CSV back to its canonical shape and the change is reverted within one or two minutes. The resource block therefore must be expressed at the **subscription** layer, which is OLM's supported extension point for per-install overrides.

The `Subscription` CRD exposes `spec.config.resources`, and OLM merges that block into the rendered `Deployment` spec before reconciling. The override persists across operator upgrades — OLM carries the subscription config across `CSV` bumps — so the fix does not need to be re-applied when a newer operator version rolls out.

## Resolution

### Identify the starved pod and its current limits

```bash
# Replace <ns> / <pod> with the operator namespace and pod name.
kubectl -n <ns> get pod <pod> -o jsonpath='{.spec.containers[*].resources}{"\n"}' | jq
```

Typical undersized defaults for a monitoring/observability controller look like:

```json
{
  "limits":   { "cpu": "50m", "memory": "150Mi" },
  "requests": { "cpu": "5m",  "memory": "50Mi"  }
}
```

Confirm the OOMKilled reason once more so the tuning target is clear:

```bash
kubectl -n <ns> describe pod <pod> | grep -A2 -E 'Last State|OOMKilled|Exit Code'
```

### Override through the Subscription

Edit the `Subscription` that installed the operator and add a `config.resources` block:

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: cluster-observability-operator
  namespace: cluster-observability-operator
spec:
  channel: stable
  installPlanApproval: Automatic
  name: cluster-observability-operator
  source: <catalog-source-name>
  sourceNamespace: <catalog-source-namespace>
  config:
    resources:
      limits:
        cpu: 400m
        memory: 1024Mi
      requests:
        cpu: 100m
        memory: 256Mi
```

Apply with `kubectl apply -f subscription.yaml` or edit in place:

```bash
kubectl -n cluster-observability-operator edit subscription \
  cluster-observability-operator
```

OLM reconciles the change within a minute: the controller's `Deployment` picks up the new `resources` block and the pods roll. Watch:

```bash
kubectl -n cluster-observability-operator get pod -w
```

Pods should reach `Ready` and stay there. `restartCount` stops incrementing once the new limit accommodates the working set.

### Choose the target limit

Start with the measured working set + a safety margin:

1. Temporarily raise the limit to a known-sufficient value (for example `2Gi`) so the pod stops OOM-killing.
2. Observe steady-state memory after the pod has reconciled for one or two full informer periods:

   ```bash
   kubectl top pod -n <ns> <pod>
   ```

   Or via cgroup counters for a longer sample:

   ```bash
   kubectl exec -n <ns> <pod> -- \
     cat /sys/fs/cgroup/memory.current
   ```

3. Set `limits.memory` to the observed peak × 1.25–1.5.
4. Set `requests.memory` to the steady-state value so the scheduler reserves enough headroom and the QoS class becomes `Burstable` or `Guaranteed`.

The same loop applies to CPU — `cpu: 50m` is often too small for a controller that reconciles several custom resource types, and a cramped CPU quota manifests as slow lease renewals and intermittent `leaderelection lost` errors.

### Revert if oversized

If the override later turns out to be too generous (wasted reserved memory on a small cluster), lower it with the same edit. The block can be removed entirely to fall back to the CSV defaults:

```bash
kubectl -n cluster-observability-operator patch subscription \
  cluster-observability-operator --type=json \
  -p='[{"op":"remove","path":"/spec/config/resources"}]'
```

The operator deployment reconciles to the shipped defaults on the next OLM tick.

## Diagnostic Steps

Confirm the operator's install chain is intact (OOMKilled on a pod that never made it past install is a different problem):

```bash
kubectl -n <ns> get csv
kubectl -n <ns> get installplan
kubectl -n <ns> get subscription
```

`csv` in `Succeeded`, `installplan` in `Complete`, `subscription` at its latest known CSV — the install is healthy, and the OOM is a runtime concern only.

Read the pod's actual limits versus the subscription's requested override:

```bash
kubectl -n <ns> get pod <pod> -o jsonpath='{.spec.containers[*].resources}{"\n"}' | jq
kubectl -n <ns> get subscription <name> -o jsonpath='{.spec.config.resources}{"\n"}' | jq
```

If the two differ, OLM has not yet reconciled the override or the `subscription` does not belong to this operator. Verify with:

```bash
kubectl -n <ns> get csv -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.olm\.operatorGroup}{"\n"}{end}'
```

If the pod keeps OOM-killing even after the override propagates, the working set is genuinely above what was raised to. Raise the limit again, or investigate the operator for a memory leak — compare RSS across restart cycles and report to the operator's maintainers if it grows unbounded.
