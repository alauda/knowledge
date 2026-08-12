---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3.x,4.4.x'
---

# S2 Workaround for Host FRR and MetalLB FRR Conflicts

## Problem

Some bare-metal ACP nodes already run a customer-managed FRR service as a systemd unit. When MetalLB uses its `frr` BGP backend, each MetalLB speaker Pod runs in the host network namespace with FRR-related containers. The MetalLB FRR process can then modify routes in the node's main routing table and interfere with the customer-managed FRR service.

## Root Cause

MetalLB speakers use `hostNetwork: true`. With the `frr` BGP backend, the speaker Pod includes `frr`, `reloader`, and `frr-metrics` containers. The MetalLB FRR process shares the node network namespace with the systemd-managed FRR service, so both processes can affect the host routing and BGP control plane.

## Temporary Workaround

Change MetalLB to its `native` BGP backend. This removes the MetalLB-managed FRR containers from the speaker Pod, so MetalLB no longer runs an FRR process in the node network namespace.

Use this workaround only when all of the following conditions are met:

- The cluster is not OpenShift. The MetalLB native BGP backend is not supported on OpenShift.
- The customer accepts the native MetalLB BGP implementation instead of the MetalLB FRR backend.
- MetalLB and the host FRR service do not use the same BGP local address, neighbor, router ID, or advertised prefixes.
- A maintenance window is available. Updating the `MetalLB` resource rolls the MetalLB speaker DaemonSet.

This workaround prevents MetalLB from deploying its own FRR containers. It does **not** make two independent BGP implementations safe to use with the same BGP identity or the same advertised routes. Configure independent BGP peers and non-overlapping advertised prefixes, or schedule MetalLB speakers only on nodes that do not run the customer FRR service.

The change is a configuration workaround. Verify the configuration after a MetalLB plugin upgrade or reinstall.

### 1. Check the current MetalLB configuration

Identify the MetalLB custom resource and record its current BGP backend:

```bash
kubectl -n metallb-system get metallb
kubectl -n metallb-system get metallb metallb -o jsonpath='{.spec.bgpBackend}{"\n"}'
```

The commands in this article use the default resource name `metallb`. If the cluster uses a different resource name, replace it in all subsequent commands.

Before changing the backend, record the current speaker placement and BGP configuration:

```bash
kubectl -n metallb-system get ds speaker -o wide
kubectl -n metallb-system get bgppeers,bgpadvertisements,ipaddresspools
```

Confirm with the network administrator that the MetalLB BGP peers and advertised address pools do not overlap with the host FRR service on every node where a speaker will run.

### 2. Back up the MetalLB resource

Save the current custom resource so that the change can be reverted:

```bash
kubectl -n metallb-system get metallb metallb -o yaml > metallb-before-native-backend.yaml
```

Do not use the backup file to restore `status` fields. The rollback command in this article updates only `spec.bgpBackend`.

### 3. Switch to the native BGP backend

Set `spec.bgpBackend` to `native`:

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"native"}}'
```

Wait for the speaker DaemonSet rollout to complete:

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

### 4. Verify that MetalLB FRR containers are removed

List the speaker Pod template containers:

```bash
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

The output must not include these containers:

- `frr`
- `reloader`
- `frr-metrics`
- `metrics-auth-proxy-frr` (when secure FRR metrics had been enabled)

Confirm that all speaker Pods are ready:

```bash
kubectl -n metallb-system get pods -l app=metallb,component=speaker
```

Finally, verify BGP session state and route advertisement using the customer's normal network monitoring tools. Do not treat Pod readiness as proof that BGP sessions are established or that the expected LoadBalancer prefixes are advertised.

### 5. Optional: isolate speaker nodes from host FRR nodes

When a separate set of nodes is available for MetalLB speakers, constrain the speaker DaemonSet through the `MetalLB` resource. Label only nodes that do not run the customer-managed FRR service:

```bash
kubectl label node <metallb-node> metallb.alauda.io/speaker=true
```

Then add the node selector to the MetalLB resource:

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"nodeSelector":{"metallb.alauda.io/speaker":"true"}}}'
```

Wait for the speaker DaemonSet rollout and confirm that speakers run only on the intended nodes:

```bash
kubectl -n metallb-system rollout status daemonset/speaker
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

Use this optional step when node isolation is needed. It reduces the chance of a host-level conflict, but it does not remove the requirement for distinct BGP peers and prefixes.

## Rollback

If native mode does not meet the BGP requirements, restore the MetalLB FRR backend:

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"frr"}}'
kubectl -n metallb-system rollout status daemonset/speaker
```

After the rollout, confirm that the required FRR-related containers are present again and validate BGP sessions before returning the cluster to service. Do not roll back to `frr` while the original host FRR conflict is unresolved.
