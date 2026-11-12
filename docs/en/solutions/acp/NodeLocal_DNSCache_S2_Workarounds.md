---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
id: KB261000048
---

# Temporary Workarounds for Common NodeLocal DNSCache Issues in Field Environments

This article provides temporary workarounds for five common NodeLocal DNSCache issues in field environments:

- DNS resolution is affected when the `node-cache` Pod on a node is unavailable.
- Health check port `8080` conflicts.
- External monitoring systems or dashboards cannot collect NodeLocal DNSCache metrics.
- A custom domain added as a hosts record in CoreDNS is not resolved through NodeLocal DNSCache.
- `node-local-dns` Pods remain after the plugin is uninstalled.

These workarounds are temporary. Manual changes may be overwritten after plugin upgrade, plugin reinstall, platform reconciliation, chart re-rendering, or node rebuild. Perform the change in a maintenance window.

## Issue 1: DNS resolution fails when the `node-cache` Pod is unavailable

**Symptom:** After NodeLocal DNSCache takes effect, newly created Pods use the node-local DNS address as their DNS server. If the `node-cache` Pod on a node becomes unavailable, is evicted, or restarts during an upgrade, DNS resolution for Pods on that node may fail.

**Cause:** The plugin installation job configures kubelet `--cluster-dns` to the NodeLocal DNSCache IP. By default, newly created Pods have only the NodeLocal DNSCache IP in `/etc/resolv.conf`, without the CoreDNS ClusterIP as an additional DNS server.

**Resolution:** Configure CoreDNS ClusterIP as an additional DNS server for kubelet. After configuration, newly created Pods have both the NodeLocal DNSCache IP and CoreDNS ClusterIP in `/etc/resolv.conf`.

Get the CoreDNS ClusterIP:

```bash
kubectl -n kube-system get svc kube-dns
```

Log in to each node that needs the change, then edit the kubelet argument file:

```bash
vi /var/lib/kubelet/kubeadm-flags.env
```

Change kubelet `--cluster-dns` from a single NodeLocal DNSCache IP to a combination of NodeLocal DNSCache IP and CoreDNS ClusterIP. For example:

```text
--cluster-dns=169.254.20.10,10.96.0.10
```

In this example, `169.254.20.10` is the NodeLocal DNSCache IP and `10.96.0.10` is the CoreDNS ClusterIP. Do not remove other kubelet arguments on the same line.

Restart kubelet after saving the change:

```bash
systemctl restart kubelet
```

The kubelet `cluster-dns` change only affects newly created Pods. Existing Pods do not automatically update `/etc/resolv.conf`. Recreate the affected business Pods during the maintenance window. For example:

```bash
kubectl -n <namespace> rollout restart deployment/<deployment-name>
kubectl -n <namespace> rollout status deployment/<deployment-name>
```

Create a temporary Pod and confirm that `/etc/resolv.conf` contains both the NodeLocal DNSCache IP and CoreDNS ClusterIP:

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- cat /etc/resolv.conf
```

Expected output contains similar entries:

```text
nameserver 169.254.20.10
nameserver 10.96.0.10
```

After multiple DNS servers are configured, CoreDNS can be used as a fallback when NodeLocal DNSCache is unavailable, but this is not a transparent failover mechanism. Images that use musl libc, such as Alpine Linux, usually switch faster. Images that use glibc may repeatedly wait for timeout across multiple queries triggered by `ndots` and `search`, which can slow down DNS resolution during the failure.

If the workload is sensitive to DNS resolution delay during the failure, reduce the resolver timeout and retry count for the affected workload:

```yaml
dnsConfig:
  options:
    - name: timeout
      value: "1"
    - name: attempts
      value: "1"
```

This configuration gives up on an unavailable DNS server faster, but it also reduces tolerance for transient DNS latency or packet loss. Validate it with the affected workload before use.

## Issue 2: NodeLocal DNSCache health check uses port 8080

**Symptom:** After NodeLocal DNSCache is enabled, a business process, operations agent, or `hostNetwork` Pod on the node cannot bind `127.0.0.1:8080` or `0.0.0.0:8080`.

**Cause:** The `node-cache` Pod runs with `hostNetwork: true` and exposes its health check endpoint on the node loopback `127.0.0.1:8080`. The current plugin does not expose the health check port. The generated Corefile and DaemonSet probe use `8080` by default.

```text
health 127.0.0.1:8080
```

```yaml
livenessProbe:
  httpGet:
    host: 127.0.0.1
    path: /health
    port: 8080
```

**Resolution:** Change both the Corefile `health` port and the DaemonSet probe port. The two values must stay consistent.

Set resource variables:

```bash
NS=kube-system
DS=node-local-dns
CM=node-local-dns
```

Edit the ConfigMap and change the health check port in the Corefile to an unused port, for example `18080`:

```bash
kubectl -n "$NS" edit cm "$CM"
```

```text
health 127.0.0.1:18080
```

Edit the DaemonSet and change `livenessProbe.httpGet.port` of the `node-cache` container to the same port:

```bash
kubectl -n "$NS" edit ds "$DS"
```

```yaml
livenessProbe:
  httpGet:
    host: 127.0.0.1
    path: /health
    port: 18080
```

Wait for the DaemonSet rolling update to complete:

```bash
kubectl -n "$NS" rollout status ds "$DS"
```

To confirm node port listeners, log in to a node running the `node-cache` Pod and run:

```bash
ss -ltnp | grep ':18080'
ss -ltnp | grep ':8080'
```

The expected result is that `18080` is listened on by NodeLocal DNSCache, and `8080` is no longer listened on by NodeLocal DNSCache.

### Reverse case: a host process already holds port 8080

**Symptom:** While NodeLocal DNSCache is deployed, the `node-local-dns` Pod on one node does not start, and its log shows:

```text
listen tcp 169.254.20.10:8080: bind: address already in use
```

**Cause:** A process on that node already listens on port `8080` on all addresses (`0.0.0.0:8080`, shown by `lsof` as `TCP *:webcache (LISTEN)`). A wildcard listener holds the port for every local address, so the cache cannot bind its health address on `8080` and exits on that node only. The listener can be an ordinary host service, for example a Java service started from a user's home directory under a non-root account; `/proc/<pid>/cgroup` shows whether it is a container workload.

**Resolution:** Identify the process and its owner first:

```bash
kubectl -n kube-system logs <node-local-dns-pod> --previous | grep 'address already in use'
ss -ltnp | grep ':8080'
lsof -i :8080
ls -l /proc/<pid>/exe /proc/<pid>/cwd
cat /proc/<pid>/cgroup
systemctl status <pid>
```

Then either move the NodeLocal DNSCache health port as described above, or, if the owner of the host service agrees, stop that service. If `systemctl status <pid>` names a unit, stop the unit (`systemctl stop <unit>`), because a supervised service starts again after a plain `kill`; otherwise use `kill <pid>`.

> **Warning:** Stopping the process stops the host service that owns port `8080` on this node, and its in-flight work is lost. Do it only after the service owner confirms it can stop on this node or move to another port or host. To roll back, start the service again with its own start method; `node-local-dns` then fails to bind again on this node.

Confirm that the port is free (the `ss` output is empty), then recreate the cache Pod on that node:

```bash
ss -ltnp | grep ':8080'
kubectl -n kube-system delete pod <node-local-dns-pod>
kubectl -n kube-system get pod -o wide | grep node-local-dns
```

## Issue 3: NodeLocal DNSCache metrics cannot be collected externally

**Symptom:** External monitoring systems or dashboards cannot access NodeLocal DNSCache metrics.

**Cause:** The Corefile `prometheus` directive may bind to the NodeLocal DNSCache IP, for example `169.254.20.10:9253`. If the external monitoring collection path cannot reach that node-local address, metrics cannot be collected.

**Resolution:** Change only the `prometheus` listen address in the Corefile. Do not change the DNS service port.

Set resource variables:

```bash
NS=kube-system
CM=node-local-dns
DS=node-local-dns
```

Edit the ConfigMap:

```bash
kubectl -n "$NS" edit cm "$CM"
```

Change the `prometheus` directive that binds to a fixed IP:

```text
prometheus 169.254.20.10:9253
```

to listen only on the port:

```text
prometheus :9253
```

If the target environment uses a metrics port other than `9253`, keep the existing port and remove only the IP binding.

Restart the DaemonSet to apply the configuration:

```bash
kubectl -n "$NS" rollout restart ds "$DS"
kubectl -n "$NS" rollout status ds "$DS"
```

Confirm that the Corefile is updated, and verify that metrics can be accessed from the monitoring collection path:

```bash
kubectl -n "$NS" get cm "$CM" -o yaml | grep 'prometheus'
```

## Issue 4: A CoreDNS hosts record is not resolved through NodeLocal DNSCache

**Symptom:** A domain was added as a hosts record in CoreDNS (for example under **Host Alias**). In a test Pod, `nslookup <domain> <coredns-service-ip>` returns the address, but plain `nslookup <domain>` fails, and the Pod's `/etc/resolv.conf` points at the NodeLocal DNSCache address (for example `169.254.20.10`). When the same record is added to the upstream DNS instead, both forms resolve.

**Cause:** NodeLocal DNSCache reads its own Corefile from its ConfigMap, not from `cpaas-coredns`. Its Corefile has server blocks only for the cluster zones, such as `cluster.local:53` and `in-addr.arpa:53`, each with `forward . <coredns-service-ip> { force_tcp }`, plus a catch-all `.:53` block. Only the zones that have their own block are forwarded to CoreDNS. Any other name, including a custom domain, falls into `.:53` and goes to the node's upstream DNS without passing through CoreDNS, so a record that exists only in CoreDNS is never seen on the default path. A record in the upstream DNS is visible on both paths because both end at that upstream.

**Resolution:** Add a server block for the custom domain to the NodeLocal DNSCache ConfigMap, so that queries for that zone are forwarded to CoreDNS. Copy the existing `in-addr.arpa:53` block exactly and change only the zone name. Keep the `bind` line and the `forward` target as they appear in the live ConfigMap, including any `__PILLAR__` token. For example:

```text
example.internal:53 {
    errors
    cache 30
    reload
    bind 169.254.20.10 __PILLAR__DNS__SERVER__
    forward . <coredns-service-ip> {
        force_tcp
    }
    prometheus 169.254.20.10:9253
}
```

Save the ConfigMap before editing:

```bash
kubectl -n "$NS" get cm "$CM" -o jsonpath='{.data.Corefile}{"\n"}'
kubectl -n "$NS" get cm "$CM" -o yaml > /tmp/nodelocaldns.before.yaml
```

> **Warning:** A syntax error in this Corefile stops the cache from loading the new configuration, and every Pod that uses NodeLocal DNSCache on the affected nodes can lose DNS. Do this only when the record already answers `nslookup <domain> <coredns-service-ip>`. To roll back, run `kubectl apply -f /tmp/nodelocaldns.before.yaml`.

```bash
kubectl -n "$NS" edit cm "$CM"
```

The `reload` plugin picks up the new Corefile after the kubelet refreshes the mounted ConfigMap, which can take about a minute. If the new zone is still not served after that, restart the DaemonSet; DNS from Pods on a node can pause while its cache Pod restarts.

```bash
kubectl -n "$NS" rollout restart ds "$DS"
kubectl -n "$NS" rollout status ds "$DS"
kubectl exec -n <namespace> <pod> -- nslookup <domain>
```

The last command, without an explicit server, is the acceptance test.

## Issue 5: `node-local-dns` Pods remain after the plugin is uninstalled

**Symptom:** The NodeLocal DNSCache plugin was uninstalled and the page reports the uninstall as successful, but `kubectl -n kube-system get ds,pod | grep node-local-dns` still lists the DaemonSet and its Pods.

**Cause:** This is expected product behavior. The `node-local-dns` DaemonSet and its Pods remaining after the plugin is uninstalled does not mean that the uninstall failed.

**Resolution:** No recovery action is required. To confirm that what remains is the retained DaemonSet:

```bash
kubectl -n kube-system get ds -o wide | grep -iE 'node-?local'
kubectl -n kube-system get pod -o wide | grep node-local-dns
```
