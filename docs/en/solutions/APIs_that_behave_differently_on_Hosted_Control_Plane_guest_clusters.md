---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A Hosted Control Plane (HCP) guest cluster runs the standard Kubernetes data plane on its worker nodes, but the control-plane components live as pods inside the management cluster's hosting namespace, not on the guest itself. As a result, several cluster-scoped APIs that are normally configured **inside** the cluster are either invisible from the guest, or must be set on the management-side `HostedCluster` / `NodePool` resources. This document is a reference of the affected APIs and where to configure each.

## Resolution

### Resources that do not exist on the guest cluster

These APIs are not exposed to clients of the guest cluster's `kube-apiserver`. Trying to `get` or `apply` them returns a `not registered` error.

| Resource (would-be on a non-hosted cluster) | Where to configure on HCP |
|---|---|
| `MachineConfig`, `MachineConfigPool` | `NodePool.spec.config` (a list of `ConfigMap` references in the hosting namespace whose payloads are merged into the node bootstrap render) |
| `Machine`, `MachineSet`, `MachineDeployment` | The Cluster API objects live in the **management** cluster, not the guest. Scale through `NodePool.spec.replicas`. |
| `MachineAutoscaler` | `NodePool.spec.autoScaling.{min,max}` |
| `MachineHealthCheck` | `NodePool.spec.management.autoRepair` (boolean) |
| `KubeletConfig` | A `ConfigMap` referenced by `NodePool.spec.config` containing a `KubeletConfiguration` payload |
| `ContainerRuntimeConfig` | A `ConfigMap` referenced by `NodePool.spec.config` |
| `ImageContentSourcePolicy`, `ImageTagMirrorSet`, `ImageDigestMirrorSet` | `HostedCluster.spec.imageContentSources` |
| `Tuned`, `PerformanceProfile` | A `ConfigMap` referenced by `NodePool.spec.tuningConfig`. The tuning operator runs in the control-plane namespace on the management cluster. |

### Resources whose configuration moves to `HostedCluster.spec.configuration`

The following **cluster-scoped configuration** APIs are normally edited as singletons inside a cluster. On HCP they are merged into the guest by the control-plane controllers from a single source of truth on the `HostedCluster`:

- `APIServer`
- `Authentication`
- `OAuth`
- `Scheduler`
- `FeatureGate`
- `Ingress`
- `Network`
- `Proxy`
- `Image`

```yaml
spec:
  configuration:
    apiServer: { ... }
    authentication: { ... }
    oauth: { ... }
    proxy:
      httpProxy: ...
      httpsProxy: ...
      noProxy: ...
```

`DNS` and `Infrastructure` configuration is derived from the `HostedCluster` itself and not separately editable on the guest.

### Default IngressController

When the `Ingress` capability is enabled, the default `IngressController` for the guest is reconciled by the hosted-cluster control-plane operator (HCCO) from the management side. Editing it in the guest will be overwritten on the next reconcile.

### Where to put referenced `Secret` / `ConfigMap` payloads

Configuration that references external bytes — OAuth identity-provider client secrets, serving certificates, trusted CA bundles — must be created in the `HostedCluster`'s **management-side namespace**. The control-plane operators read from there, render the resulting cluster configuration, and propagate it into the guest. Creating the same `Secret` inside the guest's cluster-config namespace has no effect.

### Things that look supported but aren't

- `Service` of type `ExternalName` is rejected by the API server admission with `unsupported service type`. Use `ClusterIP` plus an `EndpointSlice`/`Endpoints` pointing at the external host instead, or use a `headless` Service with a custom DNS strategy.

## Diagnostic Steps

1. Confirm a missing API is in fact not registered on the guest:

   ```bash
   kubectl --kubeconfig=<guest-kubeconfig> api-resources | grep -i <kind>
   ```

   If it is missing from `api-resources`, the resource is not part of this guest's API surface — see the table above for the management-side equivalent.

2. Inspect the rendered guest configuration that the control-plane operator is shipping:

   ```bash
   kubectl get hostedcluster <name> -n <hosting-ns> \
     -o jsonpath='{.spec.configuration}' | jq .
   ```

3. Inspect the bootstrap data being passed to a `NodePool`:

   ```bash
   kubectl get nodepool <name> -n <hosting-ns> -o jsonpath='{.spec.config}' | jq .
   ```

4. List the `ConfigMap` and `Secret` payloads in the hosting namespace to confirm they are present where the control plane expects them:

   ```bash
   kubectl get cm,secret -n <hosting-ns>
   ```
