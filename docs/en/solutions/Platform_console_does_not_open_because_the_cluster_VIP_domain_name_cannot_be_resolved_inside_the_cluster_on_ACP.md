---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Platform console does not open because the cluster VIP domain name cannot be resolved inside the cluster on ACP

## Issue

The ACP console cannot be opened, although every platform pod on the `global` cluster is `Running` and the API server certificates are not expired. Restarting platform components does not help. Platform components that proxy requests to the cluster may log that the cluster is temporarily not accessible.

The cluster's VIP (the cluster access address entered at installation) is a **domain name**, not an IP address.

## Root Cause

When the cluster VIP is configured as a domain name, platform components inside the cluster must resolve that name to reach the cluster. Name resolution inside the cluster works as follows:

- Pods that use cluster DNS ask CoreDNS. CoreDNS answers from its own records (such as **Host Alias** entries) and forwards every other name to the DNS servers in the node's `/etc/resolv.conf`.
- Host-network components use the node's `/etc/resolv.conf` directly.

If the DNS servers listed in the nodes' default `/etc/resolv.conf` cannot resolve the VIP domain name, and CoreDNS has no record for it, nothing inside the cluster can resolve the cluster address. The components keep running, but their requests to the cluster fail, so the console does not open.

A browser on a workstation may still resolve the name (for example through a local hosts file or a different DNS server), which hides the problem from the outside.

## Resolution

Make the VIP domain name resolvable inside the cluster, in one of two ways.

1. **Fix the node DNS (preferred).** Make sure the DNS servers in `/etc/resolv.conf` on every cluster node can resolve the VIP domain name: add the record on those DNS servers, or point the nodes to DNS servers that have it. This covers both host-network components and Pods, because CoreDNS forwards to the same servers.

   After the change, check on each node:

   ```bash
   cat /etc/resolv.conf
   nslookup <vip-domain>
   ```

   If NetworkManager or another tool generates `/etc/resolv.conf`, make the change there (for example `nmcli con mod <connection-name> ipv4.dns "<dns-server>"`), so it survives a reboot.

   CoreDNS Pods normally run with `dnsPolicy: Default` and copy the node's resolver configuration only when they are created, so they keep forwarding to the old servers until they are recreated. Check the policy, and restart CoreDNS after every node has been changed:

   > **Warning:** Restarting CoreDNS briefly interrupts DNS for Pods in the cluster while the new Pods start. Do it only after `nslookup <vip-domain>` works on every node. No rollback is needed for the restart itself.

   ```bash
   kubectl -n kube-system get deploy | grep -i coredns
   kubectl -n kube-system get deploy <coredns-deployment> -o jsonpath='{.spec.template.spec.dnsPolicy}{"\n"}'
   kubectl -n kube-system rollout restart deployment/<coredns-deployment>
   kubectl -n kube-system rollout status deployment/<coredns-deployment>
   ```

2. **Add a static record to CoreDNS.** If the node DNS servers cannot be changed, add the record to the cluster DNS plugin:

   1. Open **Administrator** > **Marketplace** > **Cluster Plugins**, find **Alauda Container Platform Cluster DNS** and click **Update**.
   2. Under **Host Alias**, enter the VIP address as **IP** and the VIP domain name under **Domains**, then click **Update**.

   If the console cannot be opened at all, add the record from the command line on a `global` control plane node as an emergency measure, in hosts-file format, to the `hosts` key of the ConfigMap `cpaas-coredns` in `kube-system`.

   > **Warning:** `cpaas-coredns` drives DNS for every Pod in the cluster, and a syntax error in it can break all in-cluster name resolution. Do this only when step 2 of the Diagnostic Steps shows that the node DNS cannot resolve the VIP name and option 1 is not possible. Keep every existing line of `hosts` and only append the new one. To roll back, run `kubectl apply -f cpaas-coredns.before.yaml`.

   ```bash
   kubectl -n kube-system get cm cpaas-coredns -o yaml > cpaas-coredns.before.yaml
   kubectl -n kube-system edit cm cpaas-coredns
   ```

   ```yaml
   data:
     hosts: |
       <existing entries, unchanged>
       <vip-address> <vip-domain>
   ```

   A manual edit of this ConfigMap can be overwritten when the plugin is reconciled. Once the console opens, enter the same record under **Host Alias** so that it persists. A CoreDNS record only helps Pods that use cluster DNS. Host-network components still depend on the node DNS (option 1).

3. Reload the console in the browser and confirm it opens.

## Diagnostic Steps

1. Confirm that the cluster VIP is a domain name. Find the address the cluster was installed with, for example in the `server:` field of the kubeconfig used on the control plane nodes:

   ```bash
   grep 'server:' ~/.kube/config /etc/kubernetes/*.conf 2>/dev/null
   ```

2. On a cluster node, resolve the name through the node's DNS servers. `NXDOMAIN`, `server can't find` or a timeout matches this issue:

   ```bash
   nslookup <vip-domain>
   for ns in $(awk '/^nameserver/{print $2}' /etc/resolv.conf); do nslookup <vip-domain> $ns; done
   ```

3. Resolve the name from inside a Pod that has `nslookup` (or `getent`). `unknown host` or `can't resolve` confirms that cluster DNS cannot resolve it either:

   ```bash
   kubectl -n <namespace> exec <pod> -- nslookup <vip-domain>
   ```

4. Rule out an unreachable VIP: if the name resolves but the address does not answer, the problem is the VIP itself, not DNS:

   ```bash
   curl -k -m 5 https://<vip-address>:6443/healthz
   ```

5. Rule out a look-alike: if the VIP domain resolves inside Pods and the `tke-platform-api` log on `global` contains `x509` errors for `localhost:9443`, the console failure comes from an expired certificate held by a long-running `tke-platform-api`, not from DNS:

   ```bash
   kubectl -n cpaas-system logs deploy/tke-platform-api --tail=500 | grep -E 'localhost:9443|certificate has expired'
   ```
