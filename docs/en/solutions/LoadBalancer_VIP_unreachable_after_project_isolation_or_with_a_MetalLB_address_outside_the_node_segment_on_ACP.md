---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# LoadBalancer VIP unreachable after project isolation or with a MetalLB address outside the node segment on ACP

## Issue

The external IP that MetalLB assigned to a `LoadBalancer` Service does not answer on its port:

- After the cluster network policy "Isolation between Projects" was turned on, every VIP exposed through MetalLB `LoadBalancer` Services became unreachable. Turning the isolation off brings them back.
- A tool exposed by MetalLB (for example Harbor) cannot be reached from the global cluster. The integration fails with `katanomi-plugin to harbor domain address request timeout`. The domain resolves, but from a global master and from inside the `katanomi-plugin` container network namespace:
  - `ping <harbor-ip>` returns `Destination Port Unreachable`, `4 packets transmitted, 0 received, +4 errors, 100% packet loss`;
  - `curl -v https://<harbor-ip>:443 --insecure` and `telnet <harbor-ip> 443` hang at `Trying <harbor-ip>...`.

## Root Cause

### Cause 1: with isolation between projects, LoadBalancer traffic arrives from the join subnet

On a Kube-OVN cluster, traffic that arrives for a `LoadBalancer` Service is SNATed to the node's `ovn0` address, not to the node IP. `ovn0` sits in the Kube-OVN join subnet (the `Subnet` named `join`), so the backend Pod sees a source address from the join subnet. The isolation policy does not allow that subnet, so the traffic is dropped.

The cluster network policy introduced in ACP 4.2 is based on `AdminNetworkPolicy` / `ClusterNetworkPolicy`, supports CIDR matching, and can be configured on the console page; the older cluster network policy lacks this. Kube-OVN does not support skipping ACL checks for specific subnets, so the fix is to allow the join subnet explicitly while keeping isolation on.

### Cause 2: the MetalLB address is in a segment the nodes are not in

In MetalLB layer 2 mode, a node answers ARP for the VIP on its own network, so the external address pool must be Layer 2 reachable from the nodes that announce it. When the nodes have their addresses in one `/24` and the MetalLB address is in a different `/24` that the nodes are not attached to, no node can answer for the VIP and it is unreachable from other networks. This is not a firewall problem; compare the VIP with the node segment before requesting firewall changes.

## Resolution

### Cause 1: with isolation between projects, LoadBalancer traffic arrives from the join subnet

Only when the VIPs fail with isolation on and work with it off, on Kube-OVN. Read the join subnet CIDR:

```bash
kubectl get subnet join -o jsonpath='{.spec.cidrBlock}{"\n"}'
ip -4 addr show ovn0
```

On ACP 4.2 and later, keep isolation enabled and allow the join subnet on the cluster network policy page:

1. Go to **Networking > Cluster Network Policies > Config Network Policy**.
2. With **Isolation between Projects** enabled, add an **Access Using IP Addresses** entry.
3. Set **Source IP Segment** to the join subnet CIDR and **Target** to the project whose LoadBalancer VIPs must be reachable.

For a namespace that keeps its own `NetworkPolicy`, the equivalent ingress rule is:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-join-subnet
  namespace: <namespace>
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - ipBlock:
            cidr: <join-subnet-cidr>
```

> **Warning:** The join subnet is the source of all node-to-Pod traffic on Kube-OVN, so allowing it lets every node, and anything SNATed through a node, reach the selected Pods. Narrow `podSelector` and `ports` to the LoadBalancer backends where required. Save the current policies first. Roll back with `kubectl -n <namespace> delete networkpolicy allow-join-subnet`, or by removing the entry on the policy page.

```bash
kubectl get networkpolicy -A -o yaml > /tmp/all-netpol.before.yaml
kubectl -n <namespace> apply -f allow-join-subnet.yaml
curl -sv --max-time 5 http://<vip>:<port>/ -o /dev/null
```

### Cause 2: the MetalLB address is in a segment the nodes are not in

Change the address pool to a free address in the nodes' segment, then update everything that refers to the old address (DNS or CoreDNS host records, integrations, client configuration).

> **Warning:** The Service gets a new external IP; clients and records that use the old address stop working until updated. Only when the VIP is outside every subnet configured on the announcing nodes, and the new address is not used by any other host. Save the pool and Service YAML; restoring them is the rollback.

```bash
kubectl get ipaddresspools.metallb.io -A -o yaml > /tmp/metallb-pools.before.yaml
kubectl -n <metallb-namespace> edit ipaddresspools.metallb.io <pool>
kubectl -n <namespace> get svc <service> -o wide
curl -kv --max-time 5 https://<new-vip>:443/ -o /dev/null
```

Test the new address from a global node before re-running the integration. If the integration uses a domain name held in a CoreDNS host record, point that record at the new address; see "CoreDNS Host Alias records do not take effect because a ResourcePatch removes data hosts from cpaas-coredns on ACP".

## Diagnostic Steps

1. Confirm the failing endpoint is the MetalLB external IP and Service port, and read the MetalLB logs:

   ```bash
   kubectl get svc -A -o wide | grep LoadBalancer
   kubectl get pod -A | grep -i metallb
   kubectl -n <metallb-namespace> logs <speaker-pod> --tail=50
   ```

2. Check whether isolation between projects is enabled and whether the VIPs failed when it was turned on:

   ```bash
   kubectl get adminnetworkpolicy
   kubectl get networkpolicy -A
   ```

   Yes to both: Cause 1.

3. Compare the VIP with the node addresses:

   ```bash
   kubectl get nodes -o wide
   ip -4 addr show
   ip -4 route
   ```

   A VIP in no node subnet: Cause 2. To see the failure from the calling component, repeat the test inside its network namespace on a global master:

   ```bash
   crictl ps | grep katanomi-plugin
   crictl inspect <container-id> | grep -i '"pid"'
   nsenter -t <pid> -n curl -v --max-time 10 https://<vip>:443 --insecure
   ```

If an application Pod (not the VIP) broke after a policy change, see "Application breaks after a NetworkPolicy change: Ingress, Pod-to-Pod ping, Redis Sentinel or Harbor on ACP".
