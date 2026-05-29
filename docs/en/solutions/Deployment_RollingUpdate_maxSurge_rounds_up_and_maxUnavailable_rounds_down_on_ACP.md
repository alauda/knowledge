---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500446
---

# Deployment RollingUpdate maxSurge rounds up and maxUnavailable rounds down on ACP

## Overview

On Alauda Container Platform (kube `v1.34.5`, kube-controller-manager image `registry.alauda.cn:60080/tkestack/kube-controller-manager:v1.34.5`), the upstream Kubernetes `apps/v1` Deployment primitive is used unchanged, and its `spec.strategy.rollingUpdate.maxSurge` and `spec.strategy.rollingUpdate.maxUnavailable` fields accept either an absolute integer or a percentage string (the standard `IntOrString` form); the apiserver round-trips both shapes under `apps/v1` against live Deployments on this cluster.

When the value is supplied as a percentage, the in-tree deployment controller in `kube-controller-manager` resolves it to an integer count at reconcile time. The two fields use opposite rounding directions: `maxSurge` is resolved by rounding up — `ceil(percent * desired_replicas)` — so that a non-zero percentage of any positive replica count always yields at least one surge slot. `maxUnavailable` is resolved by rounding down — `floor(percent * desired_replicas)` — so that fractional percentages of small replica counts collapse to zero rather than reducing the available pod count further.

The rounding direction is fixed inside the deployment controller's `ResolveFenceposts` rollout helper, which computes the absolute number from the percentage via the upstream `IntOrString` scale logic in apimachinery, with the rounding direction determined by the call site: round-up for `maxSurge` and round-down for `maxUnavailable`. Because the controller-manager binary in use is the upstream `v1.34.5` build, the in-tree v1.34.5 controller code carries the rollout helper and the rounding behavior matches the upstream documentation exactly.

## Resolution

To compute the effective surge and unavailable counts for a Deployment that uses percentage-form rolling-update parameters, take `.spec.replicas` and apply the two rounding rules in opposite directions. For `replicas=3, maxSurge=25%, maxUnavailable=25%`, the controller resolves `0.25 * 3 = 0.75` to `ceil(0.75)=1` allowed surge pod and `floor(0.75)=0` allowed unavailable pods; a Deployment with `spec.replicas=3` and the `maxSurge=25%`/`maxUnavailable=25%` strategy is present on this cluster, with the spec values persisted as `IntOrString` under `apps/v1`.

Inspect a Deployment's rolling-update parameters and the resulting steady state directly with `kubectl`:

```bash
kubectl get deployment <name> -n <namespace> \
  -o jsonpath='{.spec.replicas}{"\t"}{.spec.strategy.rollingUpdate.maxSurge}{"\t"}{.spec.strategy.rollingUpdate.maxUnavailable}{"\n"}'
kubectl get deployment <name> -n <namespace> \
  -o jsonpath='{.status.replicas}{"\t"}{.status.readyReplicas}{"\t"}{.status.availableReplicas}{"\n"}'
```

When choosing percentage values, account for the asymmetry: at small replica counts, a single percentage applied to both fields will not produce equal integer budgets, because the surge side rounds up and the unavailable side rounds down. To allow zero unavailable pods during a rollout, set `maxUnavailable: 0` explicitly (an absolute integer, not a percentage); to guarantee at least one surge slot regardless of replica count, leave `maxSurge` as a non-zero percentage and rely on the round-up rule. The same percentage applied to both fields will only yield equal counts when `percent * replicas` is an integer; otherwise the surge count exceeds the unavailable count by one.

Express the parameters in either form interchangeably; both the absolute integer and the percentage string are accepted under `apps/v1` Deployment on this cluster:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: <image>
```
