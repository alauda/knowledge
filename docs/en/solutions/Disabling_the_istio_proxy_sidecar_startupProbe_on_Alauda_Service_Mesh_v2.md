---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500540
---

# Disabling the istio-proxy sidecar startupProbe on Alauda Service Mesh v2

## Issue

On Alauda Container Platform (kubernetes v1.34.5, `servicemesh-operator2.v2.1.2` packaging Istio v1.28.6), the `istio-proxy` sidecar container that the Istio mutating injection webhook adds to mesh-member pods is a pure upstream Istio data-plane primitive, and on this Istio revision the rendered container carries a Kubernetes `startupProbe`. The `startupProbe` field is the standard `core/v1.Container.startupProbe` (`Probe`); per its upstream description, when the probe fails the pod is restarted, identical to a `livenessProbe` failure.

On workloads whose application container is slow to come up — for example, JVM-heavy images, pods that wait on a remote dependency at boot, or nodes under transient pressure — repeated `startupProbe` failures on the injected `istio-proxy` cause the kubelet to restart the pod. The restart cycles add observable seconds of latency before the kubelet begins evaluating `readinessProbe` and `livenessProbe`, but the mesh data plane itself is unaffected once the sidecar finally passes startup.

## Resolution

The injected `istio-proxy` sidecar shape is driven by the upstream Istio injection template, which accepts `global.proxy.startupProbe.enabled`; setting that template value to `false` causes the injection webhook to render the `istio-proxy` container without a `startupProbe`. On Alauda Service Mesh v2 (servicemesh-operator2.v2.1.2) that template value is reached through the Sail `Istio` custom resource (`sailoperator.io/v1`) — its `spec.values` block exposes upstream Istio configuration values, and the field is set under `spec.values.global.proxy.startupProbe.enabled` directly.

Edit the cluster's Sail `Istio` custom resource (its name and namespace depend on how servicemesh-operator2 was installed; substitute the actual control-plane name and namespace) and add the values override:

```bash
kubectl -n istio-system edit istio default
```

```yaml
apiVersion: sailoperator.io/v1
kind: Istio
metadata:
  name: default
spec:
  version: v1.28.6
  values:
    global:
      proxy:
        startupProbe:
          enabled: false
```

The `startupProbe` field on a running container is immutable — its upstream description states `This cannot be updated.` — so pods that were running before the `Istio` CR change retain the previous sidecar shape. Restart (re-inject) those pods so the injection webhook re-renders their `istio-proxy` container without the `startupProbe`:

```bash
kubectl -n <workload-namespace> rollout restart deployment <name>
```

After the rollout, newly-created pods will carry an `istio-proxy` container with no `startupProbe`, and the kubelet will begin `readinessProbe` and `livenessProbe` evaluation immediately at container start.

## Diagnostic Steps

When pods exhibit slow start-up that traces back to the `istio-proxy` `startupProbe`, the kubelet emits Kubernetes `Event` objects with `reason=Unhealthy` and a `message` referencing the failing startup probe (for example, `startup probe failed: ...`); these events are visible in both the namespace event list and the `describe pod` output:

```bash
kubectl -n <workload-namespace> get events --sort-by=.lastTimestamp | grep -i startup
kubectl -n <workload-namespace> describe pod <pod-name>
```

On a meshed namespace whose pods carry the injected `istio-proxy` sidecar, inspect the container directly on a candidate pod to confirm the `startupProbe` field is present (before the change) or absent (after re-injection):

```bash
kubectl -n <workload-namespace> get pod <pod-name> \
  -o jsonpath='{.spec.containers[?(@.name=="istio-proxy")].startupProbe}'
```

If the field prints as a non-empty JSON object, the pod is still running with the probe and must be restarted to pick up the updated injection-template values.
