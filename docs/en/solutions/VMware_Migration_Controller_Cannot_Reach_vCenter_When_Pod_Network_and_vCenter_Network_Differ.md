---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The VMware-migration controller (Forklift-family) cannot reach vCenter over the cluster's default pod network. Plan creation or inventory sync fails with vCenter connection errors; logs in the migration-api pod show HTTPS timeouts against the vCenter VIP or FQDN. A common assumption is that the controller needs a "dedicated transfer network" — but a transfer network is for **data-plane** VM disk transport, not for the controller's vCenter REST calls.

## Root Cause

The migration controller's vCenter calls are normal egress traffic from a pod. By default, the cluster CNI (OVN-based in ACP's Kube-OVN) performs **in-cluster routing** for pod egress — the pod sends, the CNI tunnels it through the overlay, and the packet emerges from a gateway/egress node with the node's SNAT source IP. If the vCenter endpoint is only reachable from a subset of nodes (e.g. a specific management VLAN), the controller pod scheduled on a non-management node has no usable egress path — traffic arrives at vCenter from an IP not authorised by the firewall, or doesn't arrive at all.

There is currently no supported way to attach an additional network directly to the migration-api pod to give it a dedicated vCenter-facing interface. The practical fix is to change how the cluster routes that egress.

## Resolution

Decide whether the vCenter is reachable from *any* node's primary IP:

- **Some nodes can reach vCenter, others cannot** → route via the host. Enable `routingViaHost` on the cluster network, which tells the CNI to hand egress traffic to the node's kernel routing table instead of tunnelling through an egress node. Pod egress then uses whichever physical interface on the hosting node reaches vCenter. Schedule the migration-api pod (and its worker pods) on nodes that are part of the management network.
- **Only a specific set of nodes can reach vCenter** → pair `routingViaHost` with a node selector on the migration controller deployment so its pod only lands on reachable nodes. This keeps the egress-node question out of the picture entirely.
- **vCenter is reachable from every node's primary IP** → verify the default egress path works (`curl -vk https://<vcenter>/ui` from a debug pod on a worker). Intermittent failures then point at DNS, proxy, or NetworkPolicy — not at the pod-network routing itself.

### Enabling host-routing for egress

The CNI flag in ACP is on the cluster's primary Network resource. Confirm the exact apiVersion/path against the ACP networking operator before applying; the conceptual shape is:

```yaml
spec:
  defaultNetwork:
    ovnKubernetesConfig:
      gatewayConfig:
        routingViaHost: true
```

On ACP, this setting rolls through a node-by-node CNI restart. Expect a brief window where egress latency bumps. Traffic then leaves each node via its own kernel routing table. Firewalls must be configured to accept from every node IP that can host the migration controller; enumerate those IPs up front.

### Schedule the controller on the right nodes

Label nodes that reach vCenter and pin the migration-api to them:

```bash
kubectl label node <node-a> <node-b> migration-reachable=true
```

```yaml
spec:
  template:
    spec:
      nodeSelector:
        migration-reachable: "true"
```

### Validate before retrying

From a debug pod on a labelled node, confirm vCenter is reachable:

```bash
kubectl debug node/<node-a> -it \
  --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
  -- chroot /host curl -vk --connect-timeout 5 https://<vcenter-fqdn>/sdk 2>&1 | head
```

A `200 OK` or `302` response indicates the path is usable; a timeout or SSL failure points at firewall / trust-store issues that `routingViaHost` alone won't solve.

## Diagnostic Steps

Check the migration-api pod's connection errors:

```bash
kubectl -n <migration-ns> get pod -l app.kubernetes.io/component=forklift-api -o wide
kubectl -n <migration-ns> logs -l app.kubernetes.io/component=forklift-api --tail=100 \
  | grep -iE 'vcenter|vsphere|timeout|tls|x509|connection'
```

Find the source IP the controller's egress actually leaves as:

```bash
# From within the controller pod
kubectl -n <migration-ns> exec deploy/<forklift-api> -- \
  sh -c 'curl -s ifconfig.io || curl -s https://api.ipify.org'
```

If the returned IP is not in the firewall's allowlist, either re-route (via `routingViaHost`) or rework the allowlist. Pin the pod to a node whose egress IP is already allowlisted:

```bash
kubectl get node -o custom-columns='NAME:.metadata.name,INTERNAL-IP:.status.addresses[?(@.type=="InternalIP")].address'
```

Once routing is correct, a fresh migration plan should reach the vCenter inventory within seconds and conversion begins. Persistent DNS or TLS errors after routing is fixed point at cluster trust-store or proxy config — different failure mode.
