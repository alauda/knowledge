---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
id: KB260900002
---

# Disable MetalLB FRR to Avoid Conflicts with Host FRR

## Issue

On a bare-metal Alauda Container Platform cluster, a customer-managed FRR service runs as a systemd unit on the nodes and has established BGP sessions. After the MetalLB plugin is installed, the MetalLB Speaker Pods start their own FRR processes and the host's main routing table can lose BGP routes. The two FRR instances can also interfere with each other's BGP sessions.

This solution applies when the host FRR service and MetalLB Speakers run on the same nodes.

## Environment

- Alauda Container Platform 4.2.x, 4.3.x, or 4.4.x.
- The MetalLB plugin is installed and configured for BGP advertisement.
- A customer-managed FRR service runs on one or more nodes as a systemd unit.

## Root Cause

MetalLB Speakers use `hostNetwork: true`. With the `frr` BGP backend, each Speaker Pod also runs the MetalLB-managed `frr`, `reloader`, and `frr-metrics` containers. These processes share the node network namespace with the systemd-managed FRR service, so both FRR instances can modify the host routing table and manage overlapping BGP state.

MetalLB uses the `frr` backend when `spec.bgpBackend` is not set. The MetalLB `MetalLB` custom resource supports the `native` backend, which establishes BGP sessions without deploying the MetalLB FRR containers.

## Resolution

First disable the MetalLB-managed FRR. Only consider switching the backend to the system FRR when MetalLB also needs to use BGP mode.

:::warning
The `kubectl patch` change may be lost after a platform upgrade. Recheck `spec.bgpBackend` after an upgrade and repeat Step 2 if it is no longer `native`.
:::

### 1. Confirm the current MetalLB backend

The plugin creates a `MetalLB` resource named `metallb` in the `metallb-system` namespace by default. Run the following commands before changing it:

```bash
kubectl -n metallb-system get metallb
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

If the `bgpBackend` output is empty, the Operator uses `frr` by default. If the container list includes `frr`, the MetalLB FRR process is running in the Speaker Pod. Replace `metallb` in the commands if the resource has a different name.

### 2. Disable MetalLB FRR

When MetalLB does not need to use BGP mode, a platform administrator can set the backend to `native` to disable the MetalLB-managed FRR containers:

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"native"}}'
```

The command should report `metallb.metallb.io/metallb patched`. The Operator then rolls the Speaker DaemonSet and removes the MetalLB-managed FRR containers. It does not stop or reconfigure the host FRR systemd service.

If MetalLB also needs to use BGP mode, do not perform only this step. Based on the actual network design, further evaluate switching the backend to the system FRR.

### 3. Verify the result

Wait for the Speaker rollout to complete:

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

Confirm that the backend is `native` and the Speaker template no longer contains the MetalLB FRR containers:

```bash
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

The first command must return `native`. The container list must not include `frr`, `reloader`, `frr-metrics`, or `metrics-auth-proxy-frr`. All Speaker Pods should be `Running` and `Ready`.
