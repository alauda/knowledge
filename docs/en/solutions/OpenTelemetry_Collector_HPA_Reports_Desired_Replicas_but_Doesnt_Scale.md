---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OpenTelemetry Collector HPA Reports Desired Replicas but Doesn't Scale
## Issue

An `OpenTelemetryCollector` resource has `spec.autoscaler` configured with `minReplicas`, `maxReplicas`, and CPU/memory targets. Under sustained load the resulting HorizontalPodAutoscaler reports desired replicas above the current count — e.g., `3 current / 6 desired` — yet the Collector Deployment never scales beyond the current count. Traffic keeps piling up and collectors drop events.

```text
$ kubectl describe hpa otel-collector -n <ns>
Metrics: (current / target)
  resource memory on pods (as a percentage of request):  118% (618848256) / 80%
  resource cpu on pods (as a percentage of request):     12% (12m) / 80%
Min replicas:  2
Max replicas:  8
OpenTelemetryCollector pods:  3 current / 3 desired
```

## Root Cause

Pre-`0.140.0` releases of the OpenTelemetry Operator contained a regression where the HPA wrote `desiredReplicas` into the wrong field on the `OpenTelemetryCollector` custom resource — specifically, the operator reconciled from `spec.autoscaler.minReplicas` instead of from the `.spec.replicas` field the HPA was actually updating. The HPA therefore computed the right target, told the operator "scale to 6", and the operator — reading `minReplicas=2` — kept the Deployment at the minimum and never acted on the HPA's output.

The bug is tracked upstream (opentelemetry-operator issue 4400). The fix is in version `0.140.0-1`+ of the operator; any release before that exhibits the behaviour.

## Resolution

Pick one of two paths depending on whether you can upgrade the operator.

### Preferred: Upgrade the OpenTelemetry operator

Upgrade to `0.140.0-1` or later. The upstream fix corrects the reconciliation path so the HPA's desiredReplicas actually drives the Deployment. No CR changes needed afterward.

```bash
kubectl -n <otel-operator-ns> get csv   # or: helm list -n …
# find the OpenTelemetry operator
```

After the upgrade, observe the Deployment scale in response to load:

```bash
kubectl -n <ns> get deploy -l app.kubernetes.io/component=opentelemetry-collector --watch
```

### Workaround: Remove `minReplicas` from the CR

If the operator upgrade has to wait, remove the `minReplicas` field from `.spec.autoscaler`. With the field absent, the buggy reconciliation path no longer short-circuits to the minimum and the HPA's desiredReplicas takes effect.

Apply the edit:

```bash
kubectl -n <ns> patch opentelemetrycollector <name> --type=json \
  -p='[{"op":"remove","path":"/spec/autoscaler/minReplicas"}]'
```

Note the trade-off: without `minReplicas`, the HPA's default floor (`minReplicas=1`) applies. If you were using `minReplicas=2` for HA reasons, restore that guarantee with a PodDisruptionBudget that requires two pods available at all times:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: otel-collector-pdb
  namespace: <ns>
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/component: opentelemetry-collector
      app.kubernetes.io/instance: <collector-name>
```

Once the operator is upgraded, re-add `minReplicas` to the CR and remove the workaround.

### Prevention

The bug affects any `OpenTelemetryCollector` with `spec.autoscaler.minReplicas` set and operator version `< 0.140.0-1`. Keep the operator version pinned in your gitops repo and include it in the upgrade watchlist for the observability area.

## Diagnostic Steps

Confirm the symptom matches — HPA aware, Collector unresponsive:

```bash
kubectl -n <ns> get opentelemetrycollector <name> -o jsonpath='{.spec.autoscaler}{"\n"}'
kubectl -n <ns> get hpa -o wide | grep <name>
kubectl -n <ns> describe hpa <hpa-name> | sed -n '/Metrics:/,/Events:/p'
```

A `desired/current` mismatch where desired > current while `Min replicas` equals the current count is the signature.

Cross-check by reading the operator's reconciled `.status.replicas` on the CR:

```bash
kubectl -n <ns> get opentelemetrycollector <name> \
  -o jsonpath='{.status.scale}{"\n"}'
# {"replicas":2,"selector":"app.kubernetes.io/component=opentelemetry-collector,...","statusReplicas":"2/2"}
```

`status.scale.replicas` should match the HPA's `desiredReplicas`. If the status replicas lag and the field is pegged at `minReplicas`, the bug is active; apply the workaround or upgrade.

After either fix, the Deployment should respond to load within one HPA sync window (default 15s) and scale up through the normal cycle. If it still does not scale, the issue is elsewhere — check cluster-level resource caps (ResourceQuota, LimitRange, node capacity) that may be blocking new pods.
