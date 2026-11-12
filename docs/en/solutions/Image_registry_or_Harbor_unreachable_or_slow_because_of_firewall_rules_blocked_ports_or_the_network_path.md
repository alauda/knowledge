---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.2"
  - "4.3"
---

# Image registry or Harbor unreachable or slow because of firewall rules, blocked ports, or the network path

## Issue

Image pulls or pushes never get an HTTP answer, or crawl, and the cause lies between the client and the registry:

| Signature | Cause |
| --- | --- |
| Creating a business cluster gets stuck with an image registry access error; a packet capture shows the node connecting to port `443` of the global VIP instead of `11443` | Cause 1 |
| `ImagePullBackOff` with `rpc error: code = DeadlineExceeded ... Head "http://<harbor-host>/v2/<project>/<repository>/manifests/<tag>": dial tcp <harbor-ip>:80: i/o timeout` on every node of a newly built cluster; restriction rules in the node firewall | Cause 2 |
| `Failed to pull image "nginx:1.7.9" ... Head "https://registry-1.docker.io/v2/library/nginx/manifests/1.7.9": dial tcp ...:443: i/o timeout` in a cluster without Internet egress | Cause 3 |
| Pulls from the platform registry and pushes to Harbor work but are very slow; `ss -ti` shows a high `rcv_ooopack` count | Cause 4 |
| `FATA[0000] failed to copy: read tcp ...: read: connection reset by peer` for a large image whose layers stay at `downloading` with 0.0 B, on nodes in another data center; the same pull works on Harbor's own network | Cause 5 |
| Right after the runtime was switched from Docker to containerd, `Head "http://<registry>/v2/...": dial tcp <registry-ip>:80: i/o timeout` although the registry is HTTPS | Cause 6 |

When there is no error text, first ask: does the same image pull from a node of another cluster, and which network devices sit between the failing nodes and Harbor? If only one node times out and its neighbors pull the same reference, see [Intermittent image pull io timeout from a single ACP node](Intermittent_image_pull_io_timeout_from_a_single_ACP_node.md).

The platform image registry runs in the `global` cluster and listens on port `11443`. Business clusters do not always pull from it on `11443`: an Ingress in the `global` cluster can expose the same registry under the same domain on another port (for example 80), and the business cluster then pulls platform images through that port. Compare the address with the image registry configured for platform components in the business cluster and with the private registry address in the business cluster overview.

## Root Cause

### Cause 1: port 443 from the business cluster to the global VIP is blocked

The firewall between the business cluster and the global cluster allows only `11443`, but the access path also uses port `443` on the global VIP, so registry access fails during cluster creation. Port `443` from the business cluster to the global VIP must also be allowed.

### Cause 2: firewall rules on the nodes, or in front of Harbor, drop the traffic

Restriction rules in the node firewall drop traffic to the Harbor address, so the scheduling nodes of a newly built or rebuilt cluster cannot reach Harbor at all. Deleting those restriction rules restores image downloads. A firewall in front of Harbor has the same effect: the allowance must cover the path from every cluster that pulls to the address in Harbor's external URL.

### Cause 3: the cluster cannot reach the public registry the image names

An image reference without a registry host, such as `nginx:1.7.9`, resolves to `docker.io/library/nginx:1.7.9`. Without access to Docker Hub every such pull times out. Helm charts that reference Docker Hub images fail the same way.

### Cause 4: TCP packet reordering on a multipath physical network

When the physical network forwards one flow over several paths, for example through a redundant ESXi uplink, segments arrive out of order and throughput collapses. TCP statistics show many out-of-order segments (for example `rcv_ooopack=1519`). Removing the redundant link improves pull and push throughput significantly.

### Cause 5: a WAF on the path resets large pulls from an external data center

Nodes in an external data center that reach Harbor through a jump host, WAF, or firewall fail to pull a large image (for example about 20 GiB): the layers stay at `downloading` with 0.0 B, then the pull fails with `connection reset by peer`. The same pull succeeds from the global cluster and from other clusters on Harbor's network. The WAF intercepts the transfer and resets the connection. Adjusting the WAF fixes it; no Harbor setting is involved.

### Cause 6: after a Docker-to-containerd switch, the node has no valid registry login

After the container runtime of business nodes is switched from Docker to containerd, a manual pull on a node sends a plain HTTP request to port 80, which the registry does not serve, and times out. Logging the node in to the registry again with `nerdctl -n k8s.io login <registry>:11443 --insecure-registry` makes the pulls work. This is not a firewall rule: the fault follows the runtime switch. The underlying mechanism has not been identified.

## Resolution

### Cause 1

1. From a business cluster node, while the failing operation runs, confirm the destination port:

   ```bash
   tcpdump -nn -i any host <global-vip> and tcp
   nc -vz -w 3 <global-vip> 443
   nc -vz -w 3 <global-vip> 11443
   ```

2. If SYNs to `443` get no answer while `11443` connects, have the network team allow TCP `443` from every business cluster node to the global VIP, in addition to `11443`. If the business cluster pulls through a global Ingress port, allow that port too. Retry the cluster creation step.

### Cause 2

1. Test from the node and list the rules that match the Harbor address:

   ```bash
   nc -vz -w 3 <harbor-ip> <port>
   iptables-save > /root/iptables-before.rules
   iptables-save | grep -nE '<harbor-ip>|DROP|REJECT'
   firewall-cmd --state 2>/dev/null && firewall-cmd --list-all
   ```

2. Remove the restriction rule that drops or rejects traffic to the Harbor address or port.

   > **Warning:** Only when `nc` times out from the node and a matching drop or reject rule is found. Impact: the node's security posture changes, and deleting the wrong line can cut traffic that Kubernetes, the CNI, or kube-proxy rely on. Precondition: `/root/iptables-before.rules` exists, the rule is a site restriction rule (not in a `KUBE-*`, OVN, or other CNI chain), `<table>` is the table that holds it (`filter` by default, `raw` for `PREROUTING` rules), and the security owner approves. Rollback: `iptables-restore < /root/iptables-before.rules`.

   ```bash
   iptables -t <table> -L <chain> -n --line-numbers | grep '<harbor-ip>'
   iptables -t <table> -D <chain> <rule-number>
   nc -vz -w 3 <harbor-ip> <port>
   crictl pull <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

   If firewalld or a host security agent manages the rule, remove it there as well, or it returns after a reload.

3. For a firewall in front of Harbor (including rules in the `raw` table `PREROUTING` chain of the Harbor host), open the path to the address and port of Harbor's external URL. Image pulls by the kubelet and containerd leave from the node IPs, so allow the node IPs of every cluster that pulls. Service IPs never arrive at Harbor as a source. Pods that call Harbor themselves, such as build Pods, arrive with the node IP when their subnet translates outgoing traffic (Kube-OVN `natOutgoing: true`) and with the Pod IP otherwise:

   ```bash
   kubectl get subnet -o custom-columns=NAME:.metadata.name,CIDR:.spec.cidrBlock,NAT:.spec.natOutgoing
   ```

### Cause 3

Open egress to the public registry, or bring the image into Harbor. To bring it in, save the image on a machine that can download it, then load, tag, and push it on a host that reaches Harbor:

```bash
# On the connected machine:
docker pull docker.io/library/<image>:<tag>
docker save docker.io/library/<image>:<tag> -o <image>-<tag>.tar
# On a host that reaches Harbor:
docker load -i <image>-<tag>.tar
docker tag docker.io/library/<image>:<tag> <harbor-host>:<port>/<project>/<image>:<tag>
docker push <harbor-host>:<port>/<project>/<image>:<tag>
```

Change the workload, or the Helm chart values, to the Harbor reference, and give the workload a pull Secret for that project (see [Harbor image pull returns 401 because of the pull Secret, the project account, or node credentials](Harbor_image_pull_returns_401_because_of_the_pull_Secret_the_project_account_or_node_credentials.md)).

### Cause 4

1. Measure reordering on a live transfer:

   ```bash
   ss -ti dst <registry-ip> | grep -oE 'rcv_ooopack:[0-9]+|retrans:[0-9/]+|reordering:[0-9]+'
   nstat -az | grep -iE 'TCPOFOQueue|TCPSACKReorder|TCPTSReorder'
   ```

   A `rcv_ooopack` count that keeps growing during one pull points at the physical path.

2. Have the virtualization team remove the redundant link that splits the flow, or change the uplink teaming so one flow stays on one physical path.

   > **Warning:** Impact: changing ESXi uplinks affects every VM on that host and can drop their network briefly. Precondition: a maintenance window, the current vSwitch and teaming configuration recorded, and the remaining uplink confirmed healthy. Rollback: re-add the link with the recorded configuration.

3. Repeat the same pull and compare elapsed time and `rcv_ooopack`.

### Cause 5

1. Run the same pull on a node in the external data center and on a node of the global cluster:

   ```bash
   crictl pull <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

   Layers that never leave 0.0 B before `read: connection reset by peer`, on the remote node only, confirm the cause.

2. Have the network team adjust the WAF that intercepts the transfer, then retry the pull from the remote node.

3. As an interim workaround while the path is broken, copy the image onto the hosts that run the workload and set the image pull policy to `IfNotPresent`.

   > **Warning:** Impact: with `IfNotPresent` those hosts do not refresh the tag until the policy changes or the local image is removed, so a later push of the same tag is not picked up and a registry outage is hidden. Precondition: the image is already on the hosts that will run the workload; use it only until the WAF change is verified. Rollback: set the policy back to `Always`.

   ```bash
   kubectl patch deploy <deploy> -n <namespace> --type=json \
     -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'
   ```

### Cause 6

1. Confirm the node was just switched to containerd, the failing request goes to `http://...:80`, and the registry answers on its HTTPS port:

   ```bash
   kubectl get node <node> -o jsonpath='{.status.nodeInfo.containerRuntimeVersion}{"\n"}'
   crictl pull <registry-host>/<project>/<repository>:<tag>
   nc -vz -w 3 <registry-host> 11443
   ```

2. Log the node in to the registry again.

   > **Warning:** Only when the runtime switch preceded the failure and the pull goes to port 80. Impact: `nerdctl login` stores the registry credential, base64-encoded, in `/root/.docker/config.json` on this node, and the kubelet then sends it for pulls from that registry; `--insecure-registry` skips certificate verification for this login. Precondition: the account is one approved for node pulls, and the existing config file is copied aside. Rollback: `nerdctl -n k8s.io logout <registry-host>:11443`, or restore the copied file.

   ```bash
   cp -a /root/.docker/config.json /root/docker-config.json.bak 2>/dev/null
   nerdctl -n k8s.io login <registry-host>:11443 --insecure-registry
   crictl pull <registry-host>/<project>/<repository>:<tag>
   ```

3. Repeat on every switched node. If the pull still goes to port 80, compare `/etc/containerd/certs.d/` with a node that pulls (see [Harbor push or pull fails because the client uses the wrong scheme: HTTP response to HTTPS client, or port 443 refused](Harbor_push_or_pull_fails_because_the_client_uses_the_wrong_scheme_HTTP_response_to_HTTPS_client_or_port_443_refused.md)).

## Diagnostic Steps

1. Record the image reference, the node, and the first error line. `DeadlineExceeded` or `i/o timeout` means the TCP connection never completed; a `401`, `x509`, or `HTTP response to HTTPS client` line is not a network-path problem.

2. Check whether every node fails or only one:

   ```bash
   kubectl get pods -A -o wide | grep -E 'ImagePull|ErrImage'
   ```

   All nodes of a new or rebuilt cluster point to Cause 1 or Cause 2.

3. From a failing node, test each port the image reference and the platform use:

   ```bash
   nc -vz -w 3 <registry-host> <port>
   curl -sv --connect-timeout 10 http://<registry-host>:<port>/v2/
   curl -sv --connect-timeout 10 https://<registry-host>/v2/
   ```

   A timeout on `443` toward the global VIP selects Cause 1. A timeout toward Harbor with matching drop or reject rules on the node selects Cause 2. A timeout toward a public registry selects Cause 3.

4. If transfers complete but slowly, read `ss -ti` during a pull. A high `rcv_ooopack` selects Cause 4; low reordering with slow transfers needs a bandwidth test on the path.

5. A connection reset on a large pull from an external data center, with the same pull succeeding next to Harbor, selects Cause 5.

6. Before removing firewall rules for a port 80 timeout, ask whether the node runtime was just switched from Docker to containerd. A switch, an `http://...:80` request for an HTTPS registry, and no matching drop rule select Cause 6.
