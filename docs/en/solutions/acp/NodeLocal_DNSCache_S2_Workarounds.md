---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
---

# Temporary Workarounds for NodeLocal DNSCache Port 8080 Conflicts and DNS Single-Point Risk

## Problem

After NodeLocal DNSCache is enabled in an ACP cluster, the following risks may occur:

- The `node-cache` Pod runs with `hostNetwork: true` and exposes its health check endpoint on the node loopback `127.0.0.1:8080`. If a business process, operations agent, or `hostNetwork` Pod on the same node also binds `127.0.0.1:8080` or `0.0.0.0:8080`, a port conflict occurs.
- After NodeLocal DNSCache takes effect, newly created Pods use the node-local DNS address as their DNS server. If the `node-cache` Pod on a node is unavailable, DNS resolution for Pods on that node may fail and does not automatically switch to CoreDNS without impact.

## Root Cause

The current NodeLocal DNSCache plugin exposes only the NodeLocal DNS IP parameter. It does not expose the health check port or multiple DNS server settings for kubelet. The generated Corefile and DaemonSet probe use `8080` by default:

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

The plugin installation job also configures kubelet `--cluster-dns` to the NodeLocal DNSCache IP. To release port `8080`, or to use CoreDNS ClusterIP as an additional DNS server, you need to temporarily modify runtime resources or node kubelet configuration.

## Resolution

The following workarounds are temporary. Manual changes may be overwritten after plugin upgrade, plugin reinstall, platform reconciliation, chart re-rendering, or node rebuild. Perform the change in a maintenance window and keep backups before editing resources.

### Workaround 1: Change the NodeLocal DNSCache health check port

Use this workaround when node-local port `8080` must be released. Change both the Corefile `health` port and the DaemonSet probe port. The two values must stay consistent.

Confirm resource names and back up current resources:

```bash
NS=kube-system
DS=node-local-dns
CM=node-local-dns

kubectl -n "$NS" get cm "$CM" -o yaml > node-local-dns-cm.backup.yaml
kubectl -n "$NS" get ds "$DS" -o yaml > node-local-dns-ds.backup.yaml
```

If the DaemonSet or ConfigMap uses a different name in the actual environment, find the resource first:

```bash
kubectl get ds -A | grep -i node-local
kubectl get cm -A | grep -i node-local
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

If the target environment also has a `readinessProbe` that accesses `/health` or `8080`, change it as well. Do not change DNS service port `53` or metrics port `9353`.

Wait for the DaemonSet rolling update to complete and verify DNS resolution:

```bash
kubectl -n "$NS" rollout status ds "$DS"
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc
```

To confirm node port listeners, log in to a node running the `node-cache` Pod and run:

```bash
ss -ltnp | grep ':18080'
ss -ltnp | grep ':8080'
```

The expected result is that `18080` is listened on by NodeLocal DNSCache, and `8080` is no longer listened on by NodeLocal DNSCache.

### Workaround 2: Configure CoreDNS ClusterIP as an additional DNS server

Use this workaround when you want to reduce the single-point impact of NodeLocal DNSCache. After configuration, newly created Pods have both the NodeLocal DNSCache IP and CoreDNS ClusterIP in `/etc/resolv.conf`.

This is not a transparent failover mechanism. DNS resolver retry behavior differs between business images. When the first DNS server is unavailable, some workloads may wait for timeout before trying the next DNS server, which can slow down DNS resolution during the failure.

Get the CoreDNS ClusterIP:

```bash
kubectl -n kube-system get svc kube-dns
```

If the DNS Service in the target cluster is not named `kube-dns`, find the actual name first:

```bash
kubectl -n kube-system get svc | grep -E 'kube-dns|coredns'
```

Log in to each node that needs the change, then back up and edit the kubelet argument file:

```bash
sudo cp -a /var/lib/kubelet/kubeadm-flags.env /var/lib/kubelet/kubeadm-flags.env.bak.$(date +%Y%m%d%H%M%S)
sudo vi /var/lib/kubelet/kubeadm-flags.env
```

Change kubelet `--cluster-dns` from a single NodeLocal DNSCache IP to a combination of NodeLocal DNSCache IP and CoreDNS ClusterIP. For example:

```text
--cluster-dns=169.254.20.10,10.96.0.10
```

In this example, `169.254.20.10` is the NodeLocal DNSCache IP and `10.96.0.10` is the CoreDNS ClusterIP. Do not remove other kubelet arguments on the same line.

Restart kubelet after saving the change:

```bash
sudo systemctl restart kubelet
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

If NetworkPolicy is enabled in the cluster, allow Pods to access both the NodeLocal DNSCache IP and CoreDNS ClusterIP on TCP/UDP port `53`.

## Diagnostic Steps

Confirm that NodeLocal DNSCache is installed and Pods are Ready:

```bash
kubectl -n kube-system get pods -l k8s-app=node-local-dns -o wide
kubectl -n kube-system rollout status ds/node-local-dns
```

Confirm whether the current Corefile and DaemonSet probe still use `8080`:

```bash
kubectl -n kube-system get cm node-local-dns -o yaml | grep 'health 127.0.0.1'
kubectl -n kube-system get ds node-local-dns -o yaml | grep -A5 -E 'livenessProbe|readinessProbe'
```

Confirm the DNS servers used by newly created Pods:

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- cat /etc/resolv.conf
```

## Rollback

If changing the health check port causes problems, restore the backed-up ConfigMap and DaemonSet:

```bash
kubectl apply -f node-local-dns-cm.backup.yaml
kubectl apply -f node-local-dns-ds.backup.yaml
kubectl -n kube-system rollout status ds/node-local-dns
```

If configuring multiple DNS servers causes problems, log in to the modified nodes, restore `/var/lib/kubelet/kubeadm-flags.env` from the backup, and restart kubelet:

```bash
sudo cp -a /var/lib/kubelet/kubeadm-flags.env.bak.<timestamp> /var/lib/kubelet/kubeadm-flags.env
sudo systemctl restart kubelet
```

Then recreate the affected Pods so their `/etc/resolv.conf` is regenerated.

## Related Information

If the cluster is upgraded by rebuilding nodes, directly changing `/var/lib/kubelet/kubeadm-flags.env` on nodes is lost after node rebuild. You need to synchronize the same multi-address `cluster-dns` value to every `kubeletExtraArgs` location in the cluster template:

- `KubeadmControlPlane` → `initConfiguration` → `nodeRegistration` → `kubeletExtraArgs`
- `KubeadmControlPlane` → `joinConfiguration` → `nodeRegistration` → `kubeletExtraArgs`
- `KubeadmConfigTemplate` → `template` → `spec` → `joinConfiguration` → `nodeRegistration` → `kubeletExtraArgs`

The long-term fix should be implemented on the product side, for example by exposing the health check port in the NodeLocal DNSCache plugin parameters, or by supporting multiple kubelet `cluster-dns` addresses in the plugin or cluster configuration.
