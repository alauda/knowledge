---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3.x,4.4.x'
---

# Resolve Host FRR and MetalLB FRR Conflicts by Using the Native BGP Backend

## Issue

On a bare-metal Alauda Container Platform cluster, a customer-managed FRR service runs as a systemd unit on the nodes and has established BGP sessions. After the MetalLB plugin is installed, the MetalLB Speaker Pods start their own FRR processes and the host's main routing table can lose BGP routes. The two FRR instances can also interfere with each other's BGP sessions.

This solution applies when the host FRR service and MetalLB Speakers run on the same nodes. It does not apply to OpenShift clusters.

## Environment

- Alauda Container Platform 4.3.x or 4.4.x.
- A bare-metal, non-OpenShift cluster.
- The MetalLB plugin is installed and configured for BGP advertisement.
- A customer-managed FRR service runs on one or more nodes as a systemd unit.

## Root Cause

MetalLB Speakers use `hostNetwork: true`. With the `frr` BGP backend, each Speaker Pod also runs the MetalLB-managed `frr`, `reloader`, and `frr-metrics` containers. These processes share the node network namespace with the systemd-managed FRR service, so both FRR instances can modify the host routing table and manage overlapping BGP state.

For non-OpenShift clusters, MetalLB uses the `frr` backend when `spec.bgpBackend` is not set. The MetalLB `MetalLB` custom resource supports the `native` backend, which establishes BGP sessions without deploying the MetalLB FRR containers.

## Resolution

Use the `native` BGP backend and give MetalLB its own BGP session identity.

:::warning
Updating the `MetalLB` resource rolls the Speaker DaemonSet and can briefly interrupt MetalLB BGP advertisements. Perform the change during a maintenance window and confirm the advertised VIP routes after the rollout.
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

If the `bgpBackend` output is empty on a non-OpenShift cluster, the Operator uses `frr` by default. If the container list includes `frr`, the MetalLB FRR process is running in the Speaker Pod. Replace `metallb` in the commands if the resource has a different name.

### 2. Configure independent BGP sessions

In the target cluster, go to **Administrator -> Network Management -> BGP Peers** and create or edit the BGP peers used by MetalLB. Configure values reserved for MetalLB:

- **Local AS Number**: The local AS number for the MetalLB session. Do not reuse the host FRR local AS number when the upstream router requires separate sessions.
- **Peer AS Number** and **Peer IP**: The values configured on the upstream router for the MetalLB session.
- **Local IP**: A source address that is different from the source address used by the host FRR session.
- **RouterID**: A router ID that is different from the host FRR router ID and other BGP instances on the node.
- **BGP-Connected Node**: Only the nodes that have the MetalLB source address and should run the MetalLB Speaker.

If MetalLB and the host FRR service use the same upstream router, configure the router to accept both sessions. MetalLB and host FRR must not reuse the same local address, router ID, or advertised prefixes.

### 3. Configure the BGP external address pool

Go to **Administrator -> Network Management -> External IP Address Pool** and create or edit the pool used by the LoadBalancer Services:

1. Set **Type** to **BGP**.
2. Enter the MetalLB VIP range in **IP Resources**.
3. Associate the MetalLB BGP peer.
4. Select only the nodes that are allowed to advertise the VIP range.

The VIP range must not overlap with prefixes advertised by the host FRR service.

### 4. Switch MetalLB to the native BGP backend

The console does not expose the `spec.bgpBackend` field. A platform administrator must set it with `kubectl`:

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"native"}}'
```

The command should report that the resource was configured. The Operator then rolls the Speaker DaemonSet and removes the MetalLB-managed FRR containers. It does not stop or reconfigure the host FRR systemd service.

### 5. Verify the result

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

The first command must return `native`. The container list must not include `frr`, `reloader`, `frr-metrics`, or `metrics-auth-proxy-frr`. All Speaker Pods should be `Running` and `Ready`. Pod readiness alone does not prove that BGP sessions are established or that VIP prefixes are advertised; confirm both the MetalLB session and the existing host FRR sessions with the upstream router or the customer's normal network monitoring tools.

The `MetalLB` resource stores this setting. Recheck `spec.bgpBackend` after a MetalLB plugin upgrade or reinstall, because a resource recreation or reset can restore the default backend.

## Diagnostic Steps

Use the following checks to determine whether the host FRR and MetalLB FRR conflict is present:

```bash
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{.spec.template.spec.hostNetwork}{"\n"}{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get bgppeers,bgpadvertisements,ipaddresspools
```

An empty backend on a non-OpenShift cluster and an `frr` container in the Speaker template indicate that the default MetalLB FRR backend is active. `hostNetwork` should be `true`. Compare the BGP peer source address, router ID, local AS number, and advertised prefixes with the host FRR configuration and the upstream router configuration.

## Rollback

If the native backend cannot meet the BGP requirements, restore the FRR backend:

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"frr"}}'
kubectl -n metallb-system rollout status daemonset/speaker
```

After the rollout, confirm that the required FRR containers are present and validate the BGP sessions. Do not roll back while the original host FRR conflict is unresolved.
