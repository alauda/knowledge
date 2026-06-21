---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# MetalLB L2 Address Pool and the Machine Network Can Share the Same CIDR
## Overview

Operators deploying MetalLB in Layer 2 (L2) mode sometimes ask whether MetalLB's `IPAddressPool` can take addresses from the same CIDR that the cluster's nodes live on:

```text
Machine network CIDR:      10.0.0.0/24
Node IPs:                  10.0.0.10 – 10.0.0.15
MetalLB L2 address pool:   10.0.0.200 – 10.0.0.220
```

Short answer: **yes**, and this is actually the recommended shape. MetalLB L2 mode **requires** the announced IPs to share an L2 segment with the cluster's nodes — which means they must be within the same subnet. Using a non-overlapping range of the node's CIDR for the pool meets that requirement cleanly.

This note expands on why the shared-CIDR setup works and what to be careful about.

## How L2 Mode Announces IPs

In L2 mode, MetalLB "owns" an IP by answering ARP queries (IPv4) or NDP solicitations (IPv6) for it. When an external client sends traffic to `10.0.0.200`, the upstream router looks up the MAC address for that IP by ARP; whichever node holds the IP at that moment replies with its own MAC, and traffic flows to that node. The node then forwards to the pod backing the Service.

This handshake works only if the client (or the router) and the announcing MetalLB node are **on the same Layer 2 broadcast domain**. ARP does not cross IP routers; a pool IP on a subnet that the client cannot reach through ARP is unreachable.

The node's own IPs are, by definition, on a broadcast domain reachable by whatever routes clients use to reach the cluster. A MetalLB pool drawn from the node's CIDR inherits that reachability automatically. Pools drawn from a different CIDR require either:

- The different CIDR to also be on the same L2 segment (configured upstream so the gateway knows to treat that range as local);
- Or `BGP` mode instead of L2 (MetalLB then announces the prefix to a BGP peer, which routes packets without ARP).

For most clusters, reusing the node CIDR is the simplest option.

## Requirements and Pitfalls

### Non-overlapping ranges

The pool's IP range must **not** overlap with the IPs currently assigned to nodes or any other machine (management workstations, bootstrap servers, out-of-band DHCP). If the pool includes an already-in-use IP, two machines will each claim it — the ARP result is indeterminate and traffic intermittently misroutes.

Keep node addresses and pool addresses in clearly separated sub-ranges of the CIDR. The example above (nodes in `10.0.0.10-15`, pool in `10.0.0.200-220`) works well. Reserve ranges with generous margins for future growth.

### DHCP coordination

If the machine network is DHCP-managed, the DHCP server needs to **exclude** the pool's range from its lease pool, otherwise the DHCP server will hand out pool addresses to other machines. The collision is the same as overlapping ranges, delayed by DHCP lease behaviour.

Update the DHCP server's exclusion list and verify with `dhcp-lease-query` (or the server's admin tooling) that no lease sits inside the pool range.

### MAC reply from one node only

In L2 mode, only one node at a time announces ARP for a given pool IP (the "leader" for that IP). If the leader fails, MetalLB picks a new leader and traffic fails over in seconds. This is transparent to clients on the L2 segment.

Do not place the pool's CIDR in a routed setup that expects multiple L2 paths — the ARP response is single-source; whatever routing protocol sits upstream should not be multi-pathing toward the pool IPs.

### Cross-subnet traffic goes through the gateway

Clients outside the machine network reach the pool IP by routing through the subnet's gateway. The gateway resolves the pool IP by ARP on the machine network's L2 segment. Any firewall / ACL between the client and the machine network must permit traffic to the pool IPs the same way it permits traffic to the node IPs.

## Applied Example

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: shared-machine-network-pool
  namespace: metallb-system
spec:
  addresses:
    - 10.0.0.200-10.0.0.220
  autoAssign: true
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: shared-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - shared-machine-network-pool
```

After applying, any `Service` of `type: LoadBalancer` that does not pin to a specific address gets an IP from `10.0.0.200-220`. Clients on the machine network reach the service through an ARP lookup of the chosen IP; clients in other subnets reach it through the gateway, which itself ARPs on the machine network.

## Diagnostic Steps

After configuring, create a small LoadBalancer service and verify the announce works:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: metallb-probe
  namespace: default
spec:
  type: LoadBalancer
  ports: [{port: 80, targetPort: 80}]
  selector: {app: nonexistent-for-this-probe}
EOF

kubectl get service metallb-probe -o jsonpath='{.status.loadBalancer.ingress[0].ip}{"\n"}'
# e.g. 10.0.0.201
```

From a workstation on the machine network, verify ARP resolves the IP to the leader node's MAC:

```bash
# Workstation on the machine network:
arping -c 3 10.0.0.201

# Cross-reference the responding MAC with the cluster nodes' MACs:
kubectl get node -o custom-columns='NAME:.metadata.name,INTERNAL_IP:.status.addresses[?(@.type=="InternalIP")].address'
# Then on the workstation: arp -n 10.0.0.201 → matches one of the node IPs' MACs.
```

A successful ARP response from a node's MAC confirms the L2 announcement is working. `Destination Host Unreachable` from the workstation, or a MAC not matching any node, indicates either no leader selected the IP yet (retry after a few seconds) or the ARP path is blocked (firewall rule, VLAN misconfiguration on the upstream switch).

For IPv6 pools, use `ndping` / `ndisc6` on the workstation to verify the analogous NDP advertisement.

After the pool starts serving traffic, monitor whether any pool IP collides with a non-cluster device by watching for duplicate-address events on the machine network — most switched networks log these, and MetalLB's `speaker` pod log surfaces ARP conflicts it detects.
