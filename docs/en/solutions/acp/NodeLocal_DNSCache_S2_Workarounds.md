---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
---

# S2 Temporary Workarounds for NodeLocal DNSCache Port 8080 Conflicts and DNS Single-Point Risk

## Problem

After the NodeLocal DNSCache plugin is installed in an ACP cluster, the following operational risks may occur:

- The `node-cache` Pod on each node runs with `hostNetwork: true` and listens on `127.0.0.1:8080` as its health check endpoint. If a business process, operations agent, or other node-level component also needs to use node-local port `8080`, a port conflict may occur.
- After NodeLocal DNSCache takes effect, newly created Pods use the node-local DNS address by default. If the `node-cache` Pod on a node is unavailable, DNS resolution for Pods on that node may fail.

## Root Cause

The current NodeLocal DNSCache plugin does not expose the following settings in the installation parameters:

- Health check port.
- Multiple DNS server configuration for kubelet `cluster-dns`.

The generated Corefile and DaemonSet probe use `8080` by default:

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

The plugin installation job also configures kubelet `--cluster-dns` to the NodeLocal DNSCache IP. If CoreDNS ClusterIP must be used as an additional DNS server, S2 or implementation engineers need to temporarily modify the kubelet configuration on the target cluster.

## Temporary Workarounds

This article provides two independent S2 temporary workarounds:

- Workaround 1: Change the NodeLocal DNSCache health check port to avoid node port `8080` conflicts.
- Workaround 2: Configure multiple DNS servers and use CoreDNS ClusterIP as an additional DNS server to reduce the impact when node-local DNS is unavailable.

These workarounds are not persistent product capabilities. Manual changes may be overwritten after plugin upgrade, plugin reinstall, platform reconciliation, chart re-rendering, or node rebuild. For long-term use, the required configuration should be productized.

## Workaround 1: Avoid NodeLocal DNSCache Port 8080 Conflicts

Use this workaround when a business process, operations agent, or other node-level component must use node-local port `8080`.

Before you start, confirm that:

- You have an administrator kubeconfig for the target cluster.
- The business side really needs to release node-local port `8080`.
- You have selected a new port that is not used by other node components, for example `18080`.
- You have scheduled a change window, and a short rolling restart of NodeLocal DNSCache Pods is acceptable.

### 1.1 Confirm NodeLocal DNSCache Resource Names

Find the NodeLocal DNSCache DaemonSet and ConfigMap in the target cluster:

```bash
kubectl get ds -A | grep -i node-local
kubectl get cm -A | grep -i node-local
```

Record the actual namespace, DaemonSet name, and ConfigMap name. The following steps use the default names as examples:

```bash
NS=kube-system
DS=node-local-dns
CM=node-local-dns
NEW_PORT=18080
```

If the resource names are different in the actual environment, replace these variables.

### 1.2 Back Up Current Resources

Back up the ConfigMap and DaemonSet before making changes:

```bash
kubectl -n "$NS" get cm "$CM" -o yaml > node-local-dns-cm.backup.yaml
kubectl -n "$NS" get ds "$DS" -o yaml > node-local-dns-ds.backup.yaml
```

Confirm that the backup files are generated:

```bash
ls -l node-local-dns-cm.backup.yaml node-local-dns-ds.backup.yaml
```

### 1.3 Change the Corefile Health Check Port

Edit the NodeLocal DNSCache ConfigMap:

```bash
kubectl -n "$NS" edit cm "$CM"
```

Change the health check port in the Corefile from `8080` to the new port. For example, change:

```text
health 127.0.0.1:8080
```

to:

```text
health 127.0.0.1:18080
```

Do not change the DNS service port `53` or the metrics port `9353`.

### 1.4 Change the DaemonSet Probe Port

Edit the NodeLocal DNSCache DaemonSet:

```bash
kubectl -n "$NS" edit ds "$DS"
```

Change `livenessProbe.httpGet.port` of the `node-cache` container from `8080` to the same new port:

```yaml
livenessProbe:
  httpGet:
    host: 127.0.0.1
    path: /health
    port: 18080
```

If the DaemonSet in the target environment also includes a `readinessProbe`, and that probe also accesses `/health` or port `8080`, change it to the same new port.

### 1.5 Wait for the DaemonSet Rolling Update

After the DaemonSet Pod template is changed, Kubernetes starts a DaemonSet rolling update. Wait for the update to complete:

```bash
kubectl -n "$NS" rollout status ds "$DS"
```

Confirm that all NodeLocal DNSCache Pods are running:

```bash
kubectl -n "$NS" get pods -l k8s-app="$DS" -o wide
```

If the Pod label in the environment is not `k8s-app=<DaemonSet name>`, adjust the query label according to `.spec.selector.matchLabels` of the DaemonSet.

### 1.6 Verify the Change

Confirm that the ConfigMap uses the new port:

```bash
kubectl -n "$NS" get cm "$CM" -o yaml | grep 'health 127.0.0.1'
```

The expected output should contain the new port, for example:

```text
health 127.0.0.1:18080
```

Confirm that the DaemonSet probe port uses the new port:

```bash
kubectl -n "$NS" get ds "$DS" -o yaml | grep -A5 -E 'livenessProbe|readinessProbe'
```

The expected output should show the new probe port.

If you need to check node port usage, log in to a node that has a NodeLocal DNSCache Pod and run:

```bash
ss -ltnp | grep ':18080'
ss -ltnp | grep ':8080'
```

Expected results:

- Port `18080` is listened on by the NodeLocal DNSCache process.
- Port `8080` is no longer listened on by the NodeLocal DNSCache process.

Finally, verify DNS resolution from a business Pod or a temporary Pod:

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc
```

The command should resolve `kubernetes.default.svc` successfully.

### 1.7 Roll Back

If the NodeLocal DNSCache Pod becomes abnormal or DNS resolution fails after the change, restore the backup files:

```bash
kubectl apply -f node-local-dns-cm.backup.yaml
kubectl apply -f node-local-dns-ds.backup.yaml
kubectl -n "$NS" rollout status ds "$DS"
```

After rollback, verify Pod status and DNS resolution again:

```bash
kubectl -n "$NS" get pods -l k8s-app="$DS" -o wide
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc
```

## Workaround 2: Configure CoreDNS ClusterIP as an Additional DNS Server

Use this workaround when you want to reduce the single-point impact of NodeLocal DNSCache. After configuration, newly created Pods have both the NodeLocal DNSCache IP and CoreDNS ClusterIP in `/etc/resolv.conf`.

This workaround does not guarantee transparent failover. DNS resolver retry behavior differs between business images. When the first DNS server is unavailable, some workloads may wait for timeout before trying the next DNS server, which can slow down DNS resolution during the failure.

Before you start, confirm that:

- You have an administrator kubeconfig for the target cluster.
- You have confirmed the NodeLocal DNSCache IP, for example `169.254.20.10`.
- You have confirmed the CoreDNS Service ClusterIP.
- You have scheduled a change window. Changing kubelet configuration requires restarting kubelet, and existing Pods do not automatically update `/etc/resolv.conf`; affected Pods need to be recreated.

### 2.1 Get CoreDNS ClusterIP

Query the DNS Service in the `kube-system` namespace:

```bash
kubectl -n kube-system get svc kube-dns
```

Record the value in the `CLUSTER-IP` column. The following steps use `10.96.0.10` as an example; replace it with the actual value.

If the DNS Service in the target cluster is not named `kube-dns`, find the actual name first:

```bash
kubectl -n kube-system get svc | grep -E 'kube-dns|coredns'
```

### 2.2 Change kubelet cluster-dns on Nodes

Log in to each node that needs the change, and back up the kubelet argument file:

```bash
sudo cp -a /var/lib/kubelet/kubeadm-flags.env /var/lib/kubelet/kubeadm-flags.env.bak.$(date +%Y%m%d%H%M%S)
```

Edit the kubelet argument file:

```bash
sudo vi /var/lib/kubelet/kubeadm-flags.env
```

Change kubelet `--cluster-dns` from the single NodeLocal DNSCache IP to a combination of NodeLocal DNSCache IP and CoreDNS ClusterIP. For example, change:

```text
--cluster-dns=169.254.20.10
```

to:

```text
--cluster-dns=169.254.20.10,10.96.0.10
```

Where:

- `169.254.20.10` is the NodeLocal DNSCache IP.
- `10.96.0.10` is the CoreDNS ClusterIP.

Do not remove other kubelet arguments on the same line.

### 2.3 Restart kubelet

After saving the configuration, restart kubelet:

```bash
sudo systemctl restart kubelet
```

If the target operating system does not use systemd, use the kubelet restart method supported by that environment.

Confirm that kubelet is running again:

```bash
sudo systemctl status kubelet
```

### 2.4 Recreate Affected Pods

The kubelet `cluster-dns` change only affects newly created Pods. Existing Pods do not automatically update `/etc/resolv.conf`.

During the change window, recreate the business Pods that need to use multiple DNS servers. The recreation method depends on the workload controller type. For example, for a Deployment:

```bash
kubectl -n <namespace> rollout restart deployment/<deployment-name>
kubectl -n <namespace> rollout status deployment/<deployment-name>
```

### 2.5 Verify the Change

Create a temporary Pod and confirm that `/etc/resolv.conf` contains both the NodeLocal DNSCache IP and CoreDNS ClusterIP:

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- cat /etc/resolv.conf
```

Expected output contains similar entries:

```text
nameserver 169.254.20.10
nameserver 10.96.0.10
```

Verify DNS resolution:

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc
```

If NetworkPolicy is enabled in the cluster, allow Pods to access both the NodeLocal DNSCache IP and CoreDNS ClusterIP on TCP/UDP port `53`.

### 2.6 Persist the Configuration for Node Rebuild Scenarios

If the cluster is upgraded by rebuilding nodes, directly changing `/var/lib/kubelet/kubeadm-flags.env` on nodes is lost after node rebuild. You need to synchronize the same multi-address `cluster-dns` value to every `kubeletExtraArgs` location in the cluster template:

- `KubeadmControlPlane` → `initConfiguration` → `nodeRegistration` → `kubeletExtraArgs`
- `KubeadmControlPlane` → `joinConfiguration` → `nodeRegistration` → `kubeletExtraArgs`
- `KubeadmConfigTemplate` → `template` → `spec` → `joinConfiguration` → `nodeRegistration` → `kubeletExtraArgs`

Example:

```yaml
cluster-dns: "169.254.20.10,10.96.0.10"
```

### 2.7 Roll Back

If problems occur after configuring multiple DNS servers, log in to the modified nodes and restore `/var/lib/kubelet/kubeadm-flags.env` from the backup file:

```bash
sudo cp -a /var/lib/kubelet/kubeadm-flags.env.bak.<timestamp> /var/lib/kubelet/kubeadm-flags.env
sudo systemctl restart kubelet
```

Then recreate the affected Pods so their `/etc/resolv.conf` is regenerated.

## Long-Term Recommendation

The long-term fix should be implemented on the product side. For example:

- Expose the health check port in the NodeLocal DNSCache plugin parameters, and render the value to both the Corefile and DaemonSet probe.
- Support multiple kubelet `cluster-dns` addresses in the NodeLocal DNSCache plugin or cluster configuration.
- Evaluate whether NodeLocal DNSCache should continue to be enabled by default in future DNS architecture evolution.

Before the productized solution is delivered, this article should only be used as a temporary workaround guide for S2 or implementation engineers.
