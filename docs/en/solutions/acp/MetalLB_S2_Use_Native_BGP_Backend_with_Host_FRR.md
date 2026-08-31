---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
---

# Disable MetalLB FRR to Avoid Conflicts with Host FRR

## Issue

In an Alauda Container Platform cluster, a customer-managed FRR service runs on the nodes. After MetalLB is installed, each Speaker Pod starts the MetalLB-managed FRR container by default. Both FRR instances share the node network namespace and may conflict with each other.

When MetalLB does not currently need to use BGP mode, you can first disable the MetalLB-managed FRR containers.

## Environment

- Alauda Container Platform 4.2.x, 4.3.x, or 4.4.x.
- The MetalLB plugin is installed.
- A customer-managed FRR service runs on one or more nodes as a systemd unit.

## Root Cause

MetalLB Speakers use `hostNetwork: true`. MetalLB uses the default `frr` backend and runs the `frr`, `reloader`, and `frr-metrics` containers in each Speaker Pod. The FRR processes in these containers share the node network namespace with the host FRR service and may modify the same routing and FRR state.

## Resolution

Use a `ResourcePatch` to remove the MetalLB-managed FRR containers and init containers from the Speaker DaemonSet. This solution does not modify the backend of the `MetalLB` resource. If MetalLB also needs BGP advertisement, evaluate the backend separately.

### 1. Confirm the Current MetalLB Configuration

The Speaker DaemonSet is created in the `metallb-system` namespace with the name `speaker` by default. Run the following command to confirm the current container order:

```bash
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

The default container order is `speaker`, `frr`, `reloader`, and `frr-metrics`. The init container order is `cp-frr-files`, `cp-reloader`, `cp-metrics`, and `frr-volume-permissions`. If the actual order differs, adjust the JSON Patch paths in Step 2 to match it.

### 2. Create a ResourcePatch to Disable MetalLB FRR

Create the following `ResourcePatch`. Set `release` to the release identifier of the MetalLB plugin. The example removes the FRR-related containers, init containers, and volumes from the end of each list to avoid shifting array indexes. If the actual order differs, adjust the paths first.

```yaml
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  name: metallb-disable-frr
spec:
  release: metallb-system/metallb
  target:
    apiVersion: apps/v1
    kind: DaemonSet
    name: speaker
    namespace: metallb-system
  jsonPatch:
    - op: remove
      path: /spec/template/spec/containers/3
    - op: remove
      path: /spec/template/spec/containers/2
    - op: remove
      path: /spec/template/spec/containers/1
    - op: remove
      path: /spec/template/spec/initContainers/3
    - op: remove
      path: /spec/template/spec/initContainers/2
    - op: remove
      path: /spec/template/spec/initContainers/1
    - op: remove
      path: /spec/template/spec/initContainers/0
    - op: remove
      path: /spec/template/spec/volumes/6
    - op: remove
      path: /spec/template/spec/volumes/5
    - op: remove
      path: /spec/template/spec/volumes/4
    - op: remove
      path: /spec/template/spec/volumes/3
    - op: remove
      path: /spec/template/spec/volumes/2
    - op: remove
      path: /spec/template/spec/containers/0/volumeMounts/1
```

```bash
kubectl apply -f metallb-disable-frr.yaml
```

After the `ResourcePatch` is applied, the Speaker DaemonSet rolls. This does not stop or reconfigure the host FRR systemd service and does not modify the backend of the `MetalLB` resource.

### 3. Verify That FRR Is Disabled

Wait for the Speaker update to complete:

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

Confirm that the Speaker has only its main container and no FRR init containers:

```bash
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.initContainers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

Both lists should contain only `speaker`. All Speaker Pods should be `Running` and `Ready`.

:::warning
Configuration changed through a `ResourcePatch` may be lost after a platform upgrade. Recheck the Speaker container list after an upgrade. If the FRR containers or init containers have returned, apply this solution again.
:::
