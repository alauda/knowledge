---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# MetalLB FRRNodeState resources and controller replica count behaviour
## Overview

Two questions come up regularly when MetalLB is deployed in Layer 2 (L2) mode under the cluster's load-balancer operator:

- A `frrnodestate` resource appears for every node even though no `BGPPeer` or `BGPAdvertisement` is defined. Are these required? Do they consume resources?
- The `controller` `Deployment` is set to a single replica by default. How is high availability handled, and can the replica count be raised?

Both behaviours are by design and stable across recent MetalLB releases that consolidate the routing engine on FRR.

## Resolution

### `FRRNodeState` resources are expected, even in L2-only deployments

Recent MetalLB releases standardise the underlying engine on FRR (Free Range Routing). Earlier releases used a Go-native BGP implementation; the move to FRR brings broader protocol coverage and a single, well-known dataplane. The `frrnodestate` custom resource is the mechanism the operator uses to surface the per-node FRR daemon health that runs inside each `speaker` pod. Even when no BGP session is configured, the resource exists as a placeholder for status reporting and reports zero active sessions. It does not affect L2 ARP/NDP behaviour and has negligible runtime cost.

No action is required. Removing or muting these resources is not supported.

### The `controller` Deployment runs one replica by design

The MetalLB `controller` is responsible for IP Address Management (IPAM): allocating addresses from configured `IPAddressPool` ranges to `Service` objects of type `LoadBalancer`. It does not handle the dataplane. Active LoadBalancer announcements (ARP for IPv4, NDP for IPv6 in L2 mode; BGP advertisement in BGP mode) are sourced by the `speaker` `DaemonSet`, which runs on every eligible node. As a result:

- When the `controller` pod restarts, existing `Service` IPs remain reachable because announcements continue from the speaker pods.
- The only window of impact during a controller outage is new `LoadBalancer` allocations and changes to `IPAddressPool`. A brief delay there is acceptable for upgrade or pod-eviction scenarios.
- The `MetalLB` operator CRD does not expose a replica count for the controller, and active-active redundancy is not necessary for IPAM logic that already coordinates through the API server's optimistic concurrency model.

The intended high-availability story is therefore:

- Dataplane HA → DaemonSet on every node, with announcement failover handled by the speaker election within the L2 announcer.
- Control-plane HA → fast restart of the single controller pod, no traffic impact.

If a longer controller outage is anticipated (for example, while moving the operator to a different node pool), drain only one node at a time and let the controller `Deployment` reschedule.

## Diagnostic Steps

1. List the per-node FRR state resources to confirm they are present and inert:

   ```bash
   kubectl get frrnodestates -n metallb-system
   kubectl describe frrnodestate <node> -n metallb-system | head -n 40
   ```

   In a pure L2 deployment the `Status` block shows no peers and no learned routes.

2. Check that the controller is healthy and that exactly one replica is desired:

   ```bash
   kubectl get deployment controller -n metallb-system \
     -o jsonpath='{.spec.replicas}{"\t"}{.status.availableReplicas}{"\n"}'
   ```

3. Verify the speaker DaemonSet covers every eligible node:

   ```bash
   kubectl get daemonset speaker -n metallb-system
   kubectl get pods -n metallb-system -l component=speaker -o wide
   ```

4. Confirm a `LoadBalancer` `Service` has been allocated an external IP from the configured pool:

   ```bash
   kubectl get svc -A --field-selector spec.type=LoadBalancer
   ```
