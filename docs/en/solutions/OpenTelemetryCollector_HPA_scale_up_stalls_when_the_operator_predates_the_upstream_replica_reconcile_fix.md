---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OpenTelemetryCollector HPA scale-up stalls when the operator predates the upstream replica-reconcile fix

## Issue

An `OpenTelemetryCollector` running in `deployment` mode is configured with `.spec.autoscaler` populated (`minReplicas`, `maxReplicas`, `targetCPUUtilization`, `targetMemoryUtilization`). The OpenTelemetry operator builds the matching `HorizontalPodAutoscaler` (autoscaling/v2) automatically, and the HPA's `scaleTargetRef` points back at the `OpenTelemetryCollector` CR (not directly at the collector Deployment) via the OTel CR's scale subresource.

```text
$ kubectl -n <otel-ns> get opentelemetrycollectors,deploy,hpa
NAME                                                MODE         VERSION   READY   AGE
opentelemetrycollector.opentelemetry.io/<name>      deployment   0.147.0   2/2     25s
deployment.apps/<name>-collector                    2/2                     25s
horizontalpodautoscaler.autoscaling/<name>-collector   REFERENCE: OpenTelemetryCollector/<name>   2   8   1
```

The HPA observed on the cluster is a stock `autoscaling/v2` `HorizontalPodAutoscaler` whose `scaleTargetRef` is `OpenTelemetryCollector/<name>` with `apiVersion: opentelemetry.io/v1beta1` — the operator routes HPA-driven changes through the OTel CR's scale subresource (`specReplicasPath=.spec.replicas`, `statusReplicasPath=.status.scale.replicas`), and the actual collector Deployment is updated by the operator in response. The path from "HPA raises desired replicas" to "collector Deployment grows" therefore runs through the operator's reconcile of the scale subresource — making the operator the load-bearing component in the scale-up.

## Root Cause

This is an upstream defect in the OpenTelemetry Operator, tracked as [open-telemetry/opentelemetry-operator#4400](https://github.com/open-telemetry/opentelemetry-operator/issues/4400), present in operator builds up to and including `0.135.0-1` and fixed upstream in `0.140.0-1`. On ACP, the post-fix operator is shipped as the `opentelemetry-operator2` PackageManifest, currently at `opentelemetry-operator2.v0.147.0-r0` (controller image `build-harbor.alauda.cn/asm/opentelemetry-operator2:0.147.0-r0`) — well past the upstream `0.140.0-1` fix line, so an `opentelemetry-operator2`-based install on ACP already contains the fix. Confirming the running operator's image is `0.147.0-r0` (or newer) is sufficient to rule the bug out as the cause of an HPA-vs-Deployment stall; an older operator image is the prerequisite for the bug to be present at all.

A secondary but visually similar stall happens when the metrics pipeline cannot supply fresh CPU/memory samples. The HPA then reports `FailedGetResourceMetric` / `failed to get … utilization` and never raises desired replicas in the first place — a separate failure mode that must be ruled out before attributing the stall to the operator bug. The article's diagnostic recipe targets an upstream `metrics-server` pod under a monitoring namespace; on ACP the metrics-API provider differs by cluster and must be located on-cluster (see Diagnostic Steps).

## Resolution

**Use a post-fix OpenTelemetry operator on the cluster.** On ACP the post-fix operator is shipped as the `opentelemetry-operator2` PackageManifest (`opentelemetry-operator2.v0.147.0-r0`, controller image `0.147.0-r0`), which sits well past the upstream `0.140.0-1` fix line. On a fresh cluster, subscribe it into a dedicated namespace with an `AllNamespaces`-mode OperatorGroup (the package does not support `OwnNamespace`/`SingleNamespace`/`MultiNamespace` install modes — subscribing into a namespace that already carries an `OwnNamespace` OperatorGroup, e.g. `istio-system`, will leave the CSV in `Failed` with `UnsupportedOperatorGroup`). On the verified install, the CSV reaches `Succeeded` and the controller pod runs healthy.

```yaml
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: opentelemetry-operator2-og
  namespace: opentelemetry-operator2
spec: {}            # empty spec == AllNamespaces install mode
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: opentelemetry-operator2
  namespace: opentelemetry-operator2
spec:
  channel: stable
  name: opentelemetry-operator2
  source: platform
  sourceNamespace: cpaas-system
```

After the subscription reconciles, confirm the CSV and controller pod with `kubectl get csv -n opentelemetry-operator2` and `kubectl -n opentelemetry-operator2 get pods` — phase is `Succeeded`, pod is `1/1 Running`.

**Workaround on an old/affected operator build.** If upgrading to the post-fix operator is not yet possible, removing the `minReplicas` field from `.spec.autoscaler` on the `OpenTelemetryCollector` CR removes the field that the faulty reconcile path reads and writes back. The CRD allows the field to be omitted (it is not required), and the operator then defaults the resulting HPA's `spec.minReplicas` to `1`; the HPA-driven scale-up takes effect because the reconcile path no longer has a `minReplicas` value to copy back into the Deployment.

```yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: <name>
  namespace: <otel-ns>
spec:
  mode: deployment
  autoscaler:
    # minReplicas: 2          # remove this line
    maxReplicas: 8
    targetCPUUtilization: 80
    targetMemoryUtilization: 80
```

## Diagnostic Steps

Read the autoscaler block on the `OpenTelemetryCollector` CR to see whether `minReplicas` is set (the workaround target) and what the configured targets are.

```bash
kubectl -n <otel-ns> get opentelemetrycollector <name> -o jsonpath='{.spec.autoscaler}{"\n"}'
```

Inspect the operator-built HPA. Its `REFERENCE` should be `OpenTelemetryCollector/<name>` (the operator-managed HPA targets the OTel CR via the scale subresource, not the Deployment directly); `Min replicas`, `Max replicas` and the metric targets should match the CR. The metrics column shows the current vs target utilisation; `OpenTelemetryCollector pods: <X> current / <Y> desired` is the HPA's view of the desired replica count.

```bash
kubectl -n <otel-ns> describe hpa <name>-collector
```

Read `.status.scale.replicas` on the `OpenTelemetryCollector` directly — this is what the HPA reads and writes through the scale subresource, and it should equal the HPA's current scale view (`OpenTelemetryCollector pods: <X> current` in the describe output). If `.status.scale.replicas` is below the HPA's desired count and the running operator image is pre-`0.140.0-1`, the bug is in scope.

```bash
kubectl -n <otel-ns> get opentelemetrycollector <name> -o jsonpath='{.status.scale}{"\n"}'
```

Verify that the metrics pipeline that backs the HPA is actually serving `metrics.k8s.io`. The article's recipe assumes the upstream `metrics-server` pod under a monitoring namespace; on ACP the provider differs by cluster — some clusters preinstall `cpaas-system/cpaas-monitor-prometheus-adapter` as the `v1beta1.metrics.k8s.io` provider, and on clusters that do not, the APIService is absent entirely and the HPA describe carries `FailedGetResourceMetric: the server could not find the requested resource (get pods.metrics.k8s.io)` (a stall that is independent of the operator bug).

```bash
kubectl get apiservice v1beta1.metrics.k8s.io \
  -o jsonpath='{.spec.service.namespace}/{.spec.service.name}{"\n"}{.status.conditions[0].type}={.status.conditions[0].status}{"\n"}'
```

If the APIService is absent or its `Available` condition is not `True`, the HPA cannot read metrics — fix the metrics provider first (install a `metrics.k8s.io` provider, e.g. prometheus-adapter, or restore the existing one to `Available=True`) before attributing the scale-up failure to the operator bug. If the APIService is `Available`, scrape its pod logs (e.g. `kubectl -n cpaas-system logs deploy/cpaas-monitor-prometheus-adapter`) for `context deadline exceeded` or other kubelet-scrape errors that would suppress fresh samples.

Finally, confirm the operator version that is actually reconciling the CR — pinning the bug-vs-fix question requires knowing whether the controller image is pre- or post-`0.140.0-1`.

```bash
kubectl get csv -A | grep -iE 'opentelemetry'
kubectl -n <opentelemetry-operator-ns> get deploy \
  opentelemetry-operator-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
```

The expected image on a post-fix install is `build-harbor.alauda.cn/asm/opentelemetry-operator2:0.147.0-r0` (CSV `opentelemetry-operator2.v0.147.0-r0`, phase `Succeeded`).
