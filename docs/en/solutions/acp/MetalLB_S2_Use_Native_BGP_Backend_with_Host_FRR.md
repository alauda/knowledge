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

MetalLB Speakers use `hostNetwork: true`. When `spec.bgpBackend` is not set, MetalLB uses the default `frr` backend and runs the `frr`, `reloader`, and `frr-metrics` containers in each Speaker Pod. The FRR processes in these containers share the node network namespace with the host FRR service and may modify the same routing and FRR state.

## Resolution

Use a `ResourcePatch` to set the MetalLB backend to `native`. The MetalLB Operator then regenerates the Speaker DaemonSet without the MetalLB-managed FRR containers. This solution only disables the MetalLB-managed FRR. If MetalLB also needs BGP advertisement, evaluate the appropriate backend separately first.

### 1. Confirm the Current MetalLB Configuration

The `MetalLB` resource is created in the `metallb-system` namespace with the name `metallb` by default. Run the following commands to confirm the resource name and current Speaker containers:

```bash
kubectl -n metallb-system get metallb
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

If `bgpBackend` is empty, the default `frr` backend is in use. If the container list includes `frr`, the MetalLB-managed FRR is running.

### 2. Create a ResourcePatch to Disable MetalLB FRR

Create the following `ResourcePatch`. Set `release` to the release identifier of the MetalLB plugin. If the MetalLB resource has a different name, update `target.name` accordingly.

```yaml
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  name: metallb-disable-frr
spec:
  release: metallb-system/metallb
  target:
    apiVersion: metallb.io/v1beta1
    kind: MetalLB
    name: metallb
    namespace: metallb-system
  jsonPatch:
    - op: add
      path: /spec/bgpBackend
      value: native
```

```bash
kubectl apply -f metallb-disable-frr.yaml
```

After the `ResourcePatch` is applied, the Operator rolls the Speaker DaemonSet. It does not stop or reconfigure the host FRR systemd service.

### 3. Verify That FRR Is Disabled

Wait for the Speaker update to complete:

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

Confirm that MetalLB uses the `native` backend and that the Speaker has only its main container:

```bash
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

The first command should return `native`. The container list should not include `frr`, `reloader`, or `frr-metrics`. All Speaker Pods should be `Running` and `Ready`.

:::warning
Configuration changed through a `ResourcePatch` may be lost after a platform upgrade. Recheck `spec.bgpBackend` and the Speaker container list after an upgrade. If the backend has returned to `frr`, apply this solution again.
:::
