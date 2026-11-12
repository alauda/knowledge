---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# An unknown source IP in the Calico Pod CIDR that is not a Pod or Service is a node tunl0 address on ACP

## Issue

On a cluster that uses Calico in IPIP mode:

- The access log of an application Pod keeps showing one client address sending requests to paths the application does not have, and every request returns `404` in rapid succession. Examples: `"POST /seeyon/rest/authentication/ucpcLogin HTTP/1.1" 404`, `"GET /index.php?option=com_joomlapicasa2&controller=../../../../etc/passwd%00 HTTP/1.1" 404`, `"GET /geoserver/ows?service=WFS&version=1.0.0&request=GetCapabilities HTTP/1.1" 404`, `"GET /actuator/httptrace HTTP/1.1" 404`.
- The question is which Pod has this IP. `kubectl get pods -A -o wide` and `kubectl get svc -A -o wide` do not find the address, although it is inside the Pod CIDR and answers `ping`.
- The address may end in `.0`, which looks like a network address and not a host.
- The requests may stop on their own before anyone can capture them.

## Root Cause

### Cause 1: the address is the Calico IPIP tunnel address (tunl0) of a node, so the sender is a process on that node

Calico allocates each node a block of the IP pool (block size from the `IPPool` `blockSize`, for example in `default-ipv4-ippool`) and gives the node's `tunl0` interface an address from its own block. That address is in the Pod CIDR but belongs to no Pod or Service, which is why the usual lookups return nothing.

A process running on the host itself that connects to a Pod on another node goes out through `tunl0`, and the kernel uses the `tunl0` address as the source. The application therefore logs the node's tunnel address as the client. Because blocks start on block boundaries, the first address of a block can end in `.0` and still be a valid tunnel address.

The request paths above match a vulnerability scan. When the node that owns the address runs no application Pods (for example a master with scheduling disabled) and platform audit and container logs do not line up with the requests, the requests did not come from a Pod; security or scanning software installed on that node is the likely origin. Kubernetes, Pod IP allocation and the application itself are not involved.

## Resolution

### Cause 1: the address is the Calico IPIP tunnel address (tunl0) of a node, so the sender is a process on that node

1. Map the address to a node. The node annotation holds each node's IPIP tunnel address, and the IPAM block shows which node owns the range:

   ```bash
   kubectl get nodes -o custom-columns='NAME:.metadata.name,TUNL0:.metadata.annotations.projectcalico\.org/IPv4IPIPTunnelAddr'
   kubectl get ippools.crd.projectcalico.org -o yaml | grep -E 'name:|cidr|blockSize|ipipMode'
   kubectl get ipamblocks.crd.projectcalico.org -o yaml | grep -B 15 -A 30 '<ip>'
   ```

   On the node that owns the block, confirm the interface address:

   ```bash
   ip -br addr show tunl0
   ```

2. Treat the node, not the cluster, as the sender. Check what runs on that node and whether any Pod there could be the client:

   ```bash
   kubectl get pod -A -o wide --field-selector spec.nodeName=<node-name>
   kubectl get events -A -o wide --sort-by=.lastTimestamp | grep <node-name>
   ```

3. While the requests are arriving, find the local process. Run these on the node that owns the address:

   ```bash
   ss -tnp | grep '<app-pod-ip>:<app-port>'
   tcpdump -nn -i tunl0 host <app-pod-ip> and port <app-port> -c 20
   ```

   `ss -p` prints the process name and PID of the connection. A host process (not a container) as the owner confirms this cause.

4. If the requests have already stopped, read the node's OS logs and the scan records of any security or vulnerability-scanning software installed on the node for the same time window, and ask its owner whether a scan ran.

## Diagnostic Steps

Rule out cluster objects first, then look the address up in Calico IPAM:

```bash
kubectl get pods -A -o wide | grep -w <ip>
kubectl get svc -A -o wide | grep -w <ip>
kubectl get ipamblocks.crd.projectcalico.org -o yaml | grep -B 15 -A 30 '<ip>'
kubectl get nodes -o custom-columns='NAME:.metadata.name,TUNL0:.metadata.annotations.projectcalico\.org/IPv4IPIPTunnelAddr' | grep -w <ip>
```

No Pod or Service, an address inside a block whose `affinity` is `host:<node-name>`, and that node's `tunl0` carrying the address is Cause 1. `calicoctl` is not needed for these lookups; the IPAM blocks are custom resources. `arp -n` on the application node shows nothing for this address, because the traffic arrives through the IPIP tunnel rather than on the local segment.
