---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.1"
  - "4.2"
  - "4.3"
---

# External load balancer in front of ALB: stalls, pool members, client IP, health checks and 503 on ACP

## Issue

The path is client, then an external load balancer (an F5 or a cloud load balancer) or the platform VIP, then the ALB (`global-alb2` for the platform, or a business ALB), then the Pods. Typical reports:

- The console is often slow through the F5 address: a page or API call takes about 19 seconds, especially on first open, while the ALB shows the request finishing quickly.
- A business service behind the ALB fails intermittently, and the ALB logs show no errors.
- The console does not load: the browser shows `ERR_CONNECTION_CLOSED`, and `curl` to the platform domain fails with `curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL`, while a request straight to a master on 443 works.
- The platform audit log records node IPs instead of the real client; on a global cluster without an external load balancer, `login` events show master IPs in `SourceIPs`.
- Which nodes belong in the F5 pool, and whether the health check can probe a `/healthz` endpoint.
- A port added on an ALB is unreachable through the F5, or a new load balancer returns `503 Service Unavailable` through the external load balancer while the ALB answers inside the cluster.
- The health check of a VIP shows only one of the three global masters up for port `80`.

The ALB access log in the `nginx` container is the dividing line: a request that never shows up there was lost in front of the ALB.

## Root Cause

### Cause 1: requests stall for about 19 seconds only through the F5 VIP

In the browser timing of a slow request, Stalled is about 19 seconds of the total while `Waiting for server response` is tens of milliseconds. The `global-alb2` access log shows the same requests with `status: 200` and `request_time` well under a second; the protocol is HTTP/2, and going to the ALB address directly does not reproduce it. A client capture with the filter `tcp.analysis.retransmission` shows repeated `[TCP Retransmission]` to port 443 lasting about 19 seconds, only toward that F5 VIP. The F5 virtual server for 443 had X-Forwarded-For (XFF) insertion enabled; disabling it stopped the stalls.

### Cause 2: the F5 pool contains a node that does not run this ALB

The pool covered four nodes while the ALB Pods ran on three. The fourth node ran another ALB that also listened on 443 but had no rule for this service. Because the port was open, the health check marked it healthy and part of the traffic went there.

### Cause 3: the console does not load and global-alb2 logs no request

`curl -kv https://<platform-domain>:443` connects, sends the TLS `Client hello`, then fails with `SSL_ERROR_SYSCALL`, and `global-alb2` logs nothing for browser or `curl` requests through the domain, although the domain resolves correctly. A request straight to a master on 443 completes the TLS handshake, returns `HTTP/2 302` with `location: /console-platform/portal` and `via: alb`, and is logged. The fault is in the F5 and network in front of the platform.

### Cause 4: a Layer-4 load balancer hides the client IP from the audit log

A TCP (Layer-4) load balancer on ports 443, 6443 and 11443 does not pass the client address, so the audit records show the backend node IPs as the source.

### Cause 5: the health check needs a target

No `/healthz`-style endpoint is provided for the external load balancer to probe on the platform port 443; a TCP check on the port is the supported method.

### Cause 6: the F5 port for a new ALB listener is wrong

The port configured on the F5 for the ALB did not match the port the ALB listens on, so the F5 did not forward it.

### Cause 7: 503 from the external load balancer because the firewall allows only the MetalLB address

The external load balancer returns `HTTP/1.1 503 Service Unavailable` with `This server is temporarily unable to service requests.`, while from inside the cluster, with the domain pointed at the ALB's MetalLB address, `curl -v http://<domain>/<path>` returns `200` with `Via: alb`. The firewall between the external load balancer and the cluster allowed traffic only to the MetalLB address. That address is not bound to a server: MetalLB announces it by ARP from one of the nodes and it can move, so traffic to the node IPs that actually carry it was blocked.

### Cause 8: login events record master IPs because the self-built global VIP runs in IPVS mode

Without an external load balancer, the global VIP is the self-built VIP (alive). In its default mode alive forwards with IPVS, which does not guarantee that the source IP is passed through, so a `login` audit event (`RequestURI` `/api/v2/token/callback?...`) can list a master address in `SourceIPs`, while requests through the ALB keep the client address.

### Cause 9: a VIP health check shows one member up because only one ALB listens on that port

A VIP can carry several ports with different owners: `80` and `443` for HTTP and HTTPS access, `11443` for the platform image registry, `6443` for the Kubernetes API server, and NodePorts of deployed tools. When port `80` on the global VIP is not used for platform access but is served only by a host-network business ALB that is bound to one master by its node selector, the health check for `80` shows only that master up. That is expected, not a fault.

## Resolution

### Cause 1: requests stall for about 19 seconds only through the F5 VIP

Disable XFF on the F5 virtual server for port 443 of the platform. Until the F5 owner changes it, accessing the platform through the ALB address directly is a workaround. Compare with an F5 configuration that does not stall before changing other settings.

### Cause 2: the F5 pool contains a node that does not run this ALB

Keep the pool to the nodes that actually run this ALB's Pods, and keep it in step with the ALB node selector (shown on **Network Management > Load Balancers > Update**) when nodes are added or relabeled.

```bash
kubectl -n cpaas-system get pods -l service_name=alb2-<alb-name> -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName
kubectl get nodes -l <alb-node-selector-key>=<value>
```

### Cause 3: the console does not load and global-alb2 logs no request

Prove the split with the commands in Diagnostic Steps and hand it to the F5 and network teams; no platform change is required.

### Cause 4: a Layer-4 load balancer hides the client IP from the audit log

Change the front listener for port 443 to HTTP(S) mode with XFF enabled; the ALB processes XFF correctly. If the load balancer terminates HTTPS, configure the platform's `dex.tls` certificate on it. Keep 6443 and 11443 as TCP. After the switch, re-run the timing and retransmission checks, because Cause 1 involved XFF on a 443 virtual server.

### Cause 5: the health check needs a target

Configure a TCP check on 443, pointed only at the pool members of Cause 2.

### Cause 6: the F5 port for a new ALB listener is wrong

Read the listener ports, test them on the ALB nodes, and have the F5 owner correct the virtual server or pool port:

```bash
kubectl -n cpaas-system get ft | grep <alb-name>
nc -vz -w 3 <alb-node-ip> <alb-port>
```

### Cause 7: 503 from the external load balancer because the firewall allows only the MetalLB address

Open the firewall from the external load balancer to the IP addresses of all cluster nodes that can announce the MetalLB address (the **Available Nodes** of the external address pool), not only to the MetalLB address.

### Cause 8: login events record master IPs because the self-built global VIP runs in IPVS mode

Switch alive to ARP mode.

> **Warning:** Redeploying alive moves the global VIP, briefly interrupting the console, API calls and image pulls through it, and the registry static Pod is recreated on each master. Do it in a maintenance window, with copies of `/etc/kubernetes/alive/alive.yaml`, `/etc/kubernetes/alive/vipmode` (if present) and `/etc/kubernetes/manifests/registry.yaml` from every master. Roll back by restoring the annotation to its previous value and the saved files.

1. Only on a cluster upgraded from 4.0: on every node that runs alive, save and remove the leftover mode file.

   ```bash
   cp /etc/kubernetes/alive/vipmode /root/alive-vipmode.backup
   rm /etc/kubernetes/alive/vipmode
   ```

2. On the global cluster, annotate the cluster; alive is redeployed and `alive.yaml` gains `vip_mode: arp`.

   ```bash
   kubectl annotate clusters.platform.tkestack.io <global-cluster-name> cpaas.io/alive-vip-mode=arp
   grep -n vip_mode /etc/kubernetes/alive/alive.yaml
   ```

3. When the global cluster uses its built-in registry behind the same VIP, edit `/etc/kubernetes/manifests/registry.yaml` on all three masters and change `--server-bind-address=$(MY_POD_IPS)` to `--server-bind-address=0.0.0.0`; the kubelet recreates the registry Pod.

Then log in from a known client and check that the new `login` event records that address.

### Cause 9: a VIP health check shows one member up because only one ALB listens on that port

No change is needed when the port belongs to a single-node host-network ALB. Identify which ALB serves the port and where it runs; if the port should be served on all members, move or scale that ALB (or change the VIP pool to its nodes).

```bash
kubectl get pods -A -o wide | grep alb
kubectl get ft -A | grep -E '\b80\b|00080'
ss -lntp | grep ':80 '
```

## Diagnostic Steps

1. Separate the load balancer from the platform: from the same client, call the domain and a master directly while watching the ALB log:

   ```bash
   curl -k -o /dev/null -sS -w 'code=%{http_code} connect=%{time_connect} total=%{time_total}\n' https://platform.example.com/
   curl -k -o /dev/null -sS -w 'code=%{http_code} total=%{time_total}\n' --resolve platform.example.com:443:<master-ip> https://platform.example.com/
   kubectl -n cpaas-system logs -f -l service_name=alb2-global-alb2 -c nginx --max-log-requests=6 | grep --line-buffered '<client-ip>'
   ```

   A slow or failing domain call that never reaches the log, with a fast direct call, is in front of the ALB (Causes 1 and 3).

2. For Cause 3, the decisive pair is:

   ```bash
   curl -kv https://platform.example.com:443 2>&1 | grep -E 'Client hello|SSL_ERROR_SYSCALL|HTTP/'
   curl -kv https://<master-ip>:443 2>&1 | grep -E 'subject:|HTTP/|location:|via:'
   ```

3. For Cause 1, capture on the client and count retransmissions per target:

   ```bash
   tcpdump -nn -i <client-nic> host 192.0.2.10 and tcp port 443 -w /tmp/f5-vip.pcap
   tshark -r /tmp/f5-vip.pcap -Y tcp.analysis.retransmission | wc -l
   ```

4. For Causes 2 and 9, compare pool members with ALB placement, and run `ss -lntp | grep -E ':(80|443) '` on each member; a listener that belongs to a different ALB is Cause 2, a port served by one single-node ALB is Cause 9.

5. For Cause 8, confirm the recorded addresses are masters, not Pods or Services, and read the alive mode:

   ```bash
   kubectl get pod -A -o wide | grep <recorded-source-ip>
   kubectl get clusters.platform.tkestack.io <global-cluster-name> -o jsonpath='{.metadata.annotations.cpaas\.io/alive-vip-mode}{"\n"}'
   grep -n -E 'vip_mode|ipvs' /etc/kubernetes/alive/alive.yaml
   ```

6. For a `503` the ALB did not generate (Cause 7), test the rule from inside the cluster with the domain pinned to the ALB address; `Via: alb` and the expected status put the fault in front of the ALB:

   ```bash
   curl -sv --resolve app.example.com:80:192.0.2.40 http://app.example.com/<path> 2>&1 | grep -E '^< HTTP|^< Via'
   ```
