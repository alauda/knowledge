---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Istio Sidecar CPU Limit Defaults to 2000m When Not Explicitly Defined in the Istio CR
## Overview

On ACP Service Mesh v2 (Istio 1.26.x), a cluster operator who deliberately omits the sidecar's CPU limit in the `Istio` custom resource — whether by leaving the field unset, setting it to `null`, or passing an empty value — finds that injected `istio-proxy` sidecars still come up with a CPU limit of `2000m`. This is surprising: plain Kubernetes semantics say that an unset `limits.cpu` means no limit, but the mesh is clearly setting one.

The behaviour is intentional and inherited from upstream Istio. The internal chart values that ship with Istio carry default `requests` and `limits` for the proxy, and Helm's value-merge semantics prevent a user-supplied `null` or empty entry from silencing them.

## Resolution

Three questions arise in practice: *why* the value is not truly empty; what the operator can do to genuinely unset it; and whether they should.

### Why null in the Istio CR does not override the default

Upstream Istio's Helm charts expose a layered defaults system. The chart `charts/istio-control/istio-discovery/templates/zzz_profile.yaml` (see upstream Istio 1.26.x sources) merges from a special internal map named `_internal_defaults_do_not_set`, which contains the production-safe baselines:

```yaml
# excerpt of upstream Istio internal defaults
global:
  proxy:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 2000m
        memory: 1024Mi
```

Helm merges user-supplied values on top of this map. A key that is *absent* in user values leaves the default in place; a key that is *present but null* also leaves the default in place, because Helm's deep merge treats `null` as "not specified" rather than as a directive to remove. The only way to override one of these values is to write an explicit, non-null value at the same path.

Hence an `Istio` CR with:

```yaml
spec:
  values:
    global:
      proxy:
        resources:
          limits:
            cpu: null       # has no effect — the default 2000m remains
```

leaves `istio-proxy` running with `limits.cpu: 2000m`. So does an `Istio` CR that does not mention `limits` at all.

### How to force the sidecar to run without a CPU limit

To run sidecars without any CPU ceiling, the operator must write an explicit value that Helm treats as "intentionally cleared". The cleanest approach is to set `limits` to an empty map, which Helm propagates as a zero-length object and the Kubernetes admission then treats as an absent `limits` field:

```yaml
apiVersion: sailoperator.io/v1
kind: Istio
metadata:
  name: default
spec:
  values:
    global:
      proxy:
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits: {}        # explicit empty — erases the default
```

Applying this CR and then bouncing the injected workloads (so the mutating webhook injects a fresh sidecar spec) produces `istio-proxy` pods whose `resources.limits` block is empty:

```bash
kubectl get pod <app-pod> \
  -o yaml | yq '.spec.containers[] | select(.name=="istio-proxy") | .resources'
```

If the team merely wants a *different* CPU limit rather than no limit, set the concrete value:

```yaml
spec:
  values:
    global:
      proxy:
        resources:
          limits:
            cpu: 500m       # explicit override of the 2000m default
            memory: 1024Mi
```

### Whether the default should be overridden at all

The upstream default is not arbitrary. `2000m` is picked as a safe production ceiling: it is high enough that well-behaved sidecars never hit it under normal request load, and low enough that a pathological proxy (for example, one running into an XDS sync loop or getting flooded with health checks) cannot consume an entire node's CPU. Removing the limit trades that containment guarantee for the ability to burst above the default.

Recommended choices:

- **Production workloads handling steady traffic:** leave the default. `2000m` at the limit plus `100m` at the request is a conservative shape and rarely the bottleneck in practice.
- **Latency-sensitive workloads with occasional bursts:** raise the limit explicitly rather than remove it. A limit of `4000m` still provides containment while permitting larger bursts.
- **Workloads with heavy mTLS fan-out or large numbers of upstreams:** profile the sidecar under realistic load before changing anything. If throttling is observed at `2000m`, raise; if not, leave alone.
- **No-limit sidecars:** rare and only justified when the platform uses other mechanisms (QoS classes, node-level CPU manager, dedicated mesh-ingress nodes) to prevent a runaway proxy from starving its neighbours.

## Diagnostic Steps

Confirm what the proxy actually has, not what the CR was intended to set.

```bash
# Which Istio CR is active, and what resources block does it carry?
kubectl get istio -A
kubectl get istio <name> -n <ns> -o yaml \
  | yq '.spec.values.global.proxy.resources'
```

If `resources.limits.cpu` is missing or `null`, the chart default of `2000m` applies. If it is set to an explicit scalar, that scalar applies.

```bash
# What did the mutating webhook actually inject into a running pod?
kubectl get pod <app-pod> -o yaml \
  | yq '.spec.containers[] | select(.name=="istio-proxy") | .resources'
```

This is the authoritative answer. The values here are what the kubelet enforces. Compare them against the `Istio` CR's `global.proxy.resources` to decide whether the chart default or a user override is in force.

```bash
# If an override was added but the change hasn't taken effect, the sidecar
# is still from the old injection. Bounce the workload to pick up the new
# mutating-webhook output:
kubectl rollout restart deploy <app-deployment>
```

A change to `global.proxy.resources` only takes effect on **new** pods; existing pods keep whatever was injected at their creation time. Restarts (or pod evictions) are the standard way to force re-injection.
