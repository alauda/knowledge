---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3.x,4.4.x'
---

# Resolve Host FRR and MetalLB FRR Conflicts by Using the Native BGP Backend

## Problem

Some bare-metal ACP nodes already run a customer-managed FRR service as a systemd unit. When MetalLB uses its `frr` BGP backend, each MetalLB speaker Pod runs in the host network namespace with FRR-related containers. The MetalLB FRR process can then modify routes in the node's main routing table and interfere with the customer-managed FRR service.

## Root Cause

MetalLB speakers use `hostNetwork: true`. With the `frr` BGP backend, the speaker Pod includes `frr`, `reloader`, and `frr-metrics` containers. The MetalLB FRR process shares the node network namespace with the systemd-managed FRR service, so both processes can affect the host routing and BGP control plane.

## Resolution

Change MetalLB to its `native` BGP backend. This removes the MetalLB-managed FRR containers from the speaker Pod, so MetalLB no longer runs an FRR process in the node network namespace.

Use this workaround only on a non-OpenShift cluster. Confirm the cluster type before changing the backend.

### 1. Configure BGP peers in the console

Open the target cluster, then go to **Networking -> BGP Peers**. Create or edit the BGP peer used by MetalLB.

Do not edit a ConfigMap or manually create `BGPPeer` resources for this configuration. Set these fields in the console:

- **Local AS**, **Remote AS**, and **Remote IP**: use the values assigned for MetalLB by the network team.
- **Local IP**: use an address that is not used by the host FRR service.
- **Router ID**: use an identifier that is not used by the host FRR service.
- **BGP connection node**: select only the nodes assigned to MetalLB. When available, select nodes that do not run the customer-managed FRR service.

MetalLB and host FRR must not use the same local address, neighbor, router ID, or advertised prefixes.

### 2. Configure the BGP external address pool in the console

Go to **Networking -> External IP Pools** and create or edit the pool used by the LoadBalancer Services:

1. Set **Type** to **BGP**.
2. Enter the MetalLB VIP range in **IP Resources**.
3. Associate the BGP peer created in the previous step.
4. Select only the nodes that are allowed to advertise the VIP range.

The VIP range must not overlap with prefixes advertised by the host FRR service.

### 3. Switch the MetalLB backend

The current console exposes BGP peers and external address pools, but does not expose the MetalLB `bgpBackend` setting. A platform administrator changes this setting to `native` during the maintenance window. The change rolls the speaker DaemonSet.

### 4. Verify the result

After the speaker rollout, confirm that the speaker Pod no longer contains `frr`, `reloader`, or `frr-metrics` containers. Then use the normal network monitoring tools to confirm the MetalLB BGP session and VIP route advertisement.

Pod readiness alone does not prove that the BGP session is established or that the expected VIP prefixes are advertised.

## Rollback

If native mode cannot meet the BGP requirements, a platform administrator can change the backend back to `frr`. Do not roll back while the original host FRR conflict is unresolved.
