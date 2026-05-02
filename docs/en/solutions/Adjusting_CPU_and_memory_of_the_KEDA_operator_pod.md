---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Adjusting CPU and memory of the KEDA operator pod
## Issue

The KEDA operator pod (`keda-operator`) ships with a small default resources block — typically `requests: cpu=100m, memory=100Mi` and `limits: cpu=500m, memory=500Mi`. Clusters running many `ScaledObject` / `ScaledJob` resources, or a high-frequency external trigger (Prometheus, Kafka lag, custom CR), push the operator's reconcile loop and metrics-server traffic well past the default limit. The operator pod then hits CPU throttling or OOM, slows down `ScaledObject` reconciliation, and downstream HPA decisions lag.

The fix is to bump the resources block on the operator pod itself. Editing the Deployment by hand is reverted by the controller-of-controllers within seconds; the change has to flow through the `KedaController` CR instead.

## Resolution

The KEDA operator's parent CR (`KedaController`) exposes a `spec.operator.resources` (or `spec.operator.resourcesKedaOperator` on older versions) field that the controller propagates onto the operator pod's container spec. Setting it through the CR makes the override survive operator upgrades and reconciliations.

### KEDA controller v2.11+ (current upstream API)

```yaml
apiVersion: keda.sh/v1alpha1
kind: KedaController
metadata:
  name: keda
  namespace: cpaas-keda
spec:
  watchNamespace: ""             # cluster-wide
  operator:
    resources:
      requests:
        cpu: "1"
        memory: 1Gi
      limits:
        cpu: "1"
        memory: 2Gi
  metricsServer:
    resources:                   # bump separately if external-metrics traffic is heavy
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: "1"
        memory: 1Gi
```

### KEDA controller v2.9 (legacy field name)

The older release wraps the same struct under a different key. If the operator running on the cluster predates v2.10, use:

```yaml
spec:
  operator:
    resourcesKedaOperator:
      requests:
        cpu: "1"
        memory: 1Gi
      limits:
        cpu: "1"
        memory: 2Gi
```

Applying the CR triggers a reconcile and the operator's controller-of-controllers re-renders the keda-operator Deployment with the new resources. Confirm the rendered Deployment shows the new values:

```bash
kubectl -n cpaas-keda get deployment keda-operator \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="keda-operator")].resources}' \
  | jq
```

The pod restarts to pick up the new container template.

### Sizing guidance

Start from the default and bump in proportion to the active workload:

| ScaledObject count | suggested requests | suggested limits |
|---|---|---|
| < 50 | 100m / 100Mi | 500m / 500Mi (default) |
| 50–500 | 500m / 256Mi | 1 / 1Gi |
| 500–2000 | 1 / 512Mi | 1 / 2Gi |
| > 2000 | 2 / 1Gi | 2 / 4Gi (and split-instance per namespace) |

`memory` is usually the binding resource — KEDA caches every active trigger's last evaluation. The metrics server (queried by the HPA controller) tends to be CPU-bound; if HPA decisions lag during scale-up storms, raise `metricsServer` separately.

### When CPU/memory bumps are not enough

Two more knobs exist if a single-instance KEDA can't keep up even with generous limits:

- `spec.operator.parallelism` (where supported by the installed KEDA version) raises the worker count for ScaledObject reconciliation.
- Splitting one cluster-wide KedaController into multiple namespace-scoped instances. Note that on most upstream KEDA versions `spec.watchNamespace` accepts only a single namespace or the empty string (cluster-wide); a comma-separated list is silently ignored. Plan one KedaController per high-load namespace and a cluster-wide one for the rest.

The keda-operator Deployment itself ships as `replicas=1` with leader-election; raising the replica count is **not** supported on most upstream releases — only one instance reconciles at a time anyway.

## Diagnostic Steps

To confirm the operator is hitting its limits, look at CPU throttling and OOM history:

```bash
kubectl -n cpaas-keda top pod -l app=keda-operator
kubectl -n cpaas-keda get pod -l app=keda-operator \
  -o jsonpath='{.items[*].status.containerStatuses[*].lastState.terminated.reason}'
```

A non-empty `OOMKilled` history confirms the memory limit needs to go up. Persistent CPU usage at or near the limit points at CPU throttling — confirm via cAdvisor metrics:

```promql
rate(container_cpu_cfs_throttled_seconds_total{
  namespace="cpaas-keda",
  pod=~"keda-operator-.*"
}[5m])
```

A non-zero throttling rate means the limit needs to grow.

For metrics-server pressure (separate from the operator), watch how many external-metrics requests the HPA controller is firing:

```promql
rate(apiserver_request_total{
  group="external.metrics.k8s.io"
}[5m])
```

A sustained tens-per-second rate is enough to require a metricsServer resource bump — increase `spec.metricsServer.resources.limits` independently of the operator.

If the override CR was applied but the Deployment did not pick up the new values, the controller-of-controllers may not have recognised the change. Restart it once to force re-reconciliation:

```bash
kubectl -n cpaas-keda rollout restart deploy/keda-olm-operator
```

The rendered keda-operator Deployment should refresh within a minute, and the operator pod restarts with the requested resources.
