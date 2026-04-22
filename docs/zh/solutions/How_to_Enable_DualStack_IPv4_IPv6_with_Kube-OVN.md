---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2,4.3'
id: KB260400013
sourceSHA: 76e736aadc9daf88f5d7d392b566e217f7ad6b69f760c527354e1178e69ccfb4
---

# 将 Kube-OVN 集群从 IPv4 升级到双栈 (IPv4/IPv6)

## 问题

本文档描述了如何将使用 Kube-OVN 作为 CNI 插件的 Kubernetes 集群从仅 IPv4 模式升级到双栈 IPv4/IPv6 模式。

## 环境

- 使用 Kube-OVN 作为 CNI 插件的 Alauda 容器平台集群。
- 集群节点操作系统支持 IPv6，且在内核中未禁用。
- 集群节点的网络接口卡 (NIC) 配置了真实的 IPv6 地址，并且节点之间的 IPv6 路由可达。

## 先决条件

| 项目        | 要求                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| ACP 版本    | 4.2, 4.3                                                                                                              |
| CNI 插件    | Kube-OVN                                                                                                              |
| 节点内核    | IPv6 已启用 (`net.ipv6.conf.all.disable_ipv6 = 0`)，并且转发已启用 (`net.ipv6.conf.all.forwarding = 1`) |
| 节点 NIC    | 配置了真实的 IPv6 地址 (GUA，例如 `2004::/64`)，并且配置了默认路由                    |

## 解决方案

:::warning
在升级过程中，所有使用容器网络的 Pod 必须重新启动以重新获取双栈 IP 地址。请提前规划维护窗口并通知相关应用团队。
同时，本文档中对 `kube-ovn-controller` 和 `kube-ovn-cni` 等组件的参数更改会创建 `resourcePatch` 条目。这些 `resourcePatch` 条目在集群升级期间可能会被删除，这可能导致此处配置的双栈参数丢失。在升级期间请特别注意这一点，并在升级后如有需要重新检查并重新应用相关参数。
:::

### 步骤 1：更新所有主节点上的 kube-apiserver 配置

`kube-apiserver` 作为静态 Pod 运行。配置文件路径为：

```
/etc/kubernetes/manifests/kube-apiserver.yaml
```

将 `--service-cluster-ip-range` 更新为双栈格式：

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 2：更新所有主节点上的 kube-controller-manager 配置

配置文件路径为：

```
/etc/kubernetes/manifests/kube-controller-manager.yaml
```

将以下两个参数更新为双栈格式：

```yaml
- --cluster-cidr=10.3.0.0/16,fd00:10:3::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 3：更新所有节点上的 kubelet `--node-ip` 参数

在裸金属双栈环境中，kubelet 必须显式配置双栈节点地址。否则，`Node.status.addresses` 通常只报告 IPv4 `InternalIP`，这可能会影响依赖于节点地址的 Kube-OVN 路由行为。

常见的配置文件路径为：

```bash
/var/lib/kubelet/kubeadm-flags.env
```

将单栈配置更改为：

```bash
--node-ip=<IPv4>
```

更改为双栈：

```bash
--node-ip=<IPv4>,<IPv6>
```

示例：

```bash
--node-ip=192.168.134.191,2001:db8::191
```

:::warning
`<IPv6>` 必须使用先前在节点 NIC 上配置的 IPv6 地址，如先决条件中所述。请勿使用来自 Kube-OVN `join` 网络的地址。
:::

更改后，重启 kubelet：

```bash
systemctl daemon-reload
systemctl restart kubelet
```

:::warning
对于自管理集群，升级 kubelet 通常不会覆盖 `/var/lib/kubelet/kubeadm-flags.env` 中现有的 `--node-ip` 配置。

对于 MicroOS 集群，此配置在集群升级后会丢失，因此请勿将此文件更改视为持久配置方法。请勿依赖 `/var/lib/kubelet/kubeadm-flags.env` 在升级后保持不变。升级后，请重新检查 kubelet 是否仍使用 `--node-ip=<IPv4>,<IPv6>`，以及 `Node.status.addresses` 是否仍为双栈。如果配置缺失，请重新应用并重启 kubelet。
:::

### 步骤 4：更新 `kube-system/kube-ovn-controller` 参数

编辑部署：

```bash
kubectl edit deploy kube-ovn-controller -n kube-system
```

将以下参数更新为双栈格式：

```yaml
- --node-switch-cidr=100.64.0.0/16,fd00:100:64::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
- --default-cidr=10.3.0.0/16,fd00:10:3::/112
```

### 步骤 5：验证节点注释已更新为双栈

运行：

```bash
kubectl get node <node-name> -o yaml
```

确认以下注释已更新为双栈格式：

```yaml
ovn.kubernetes.io/cidr: 100.64.0.0/16,fd00:100:64::/112
ovn.kubernetes.io/gateway: 100.64.0.1,fd00:100:64::1
```

### 步骤 6：更新 `kube-system/kube-ovn-cni` 参数

编辑 DaemonSet：

```bash
kubectl edit ds kube-ovn-cni -n kube-system
```

将以下参数更新为双栈格式：

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 7：验证节点 IPv6 路由

在节点上运行以下命令：

```bash
ip -6 r
```

您应该看到类似的 IPv6 路由：

```text
fd00:10:3::/112 dev ovn0 proto static src 2004::192:168:134:191 metric 1024 pref medium
fd00:100:64::/112 dev ovn0 proto kernel metric 256 pref medium
```

一条路由是 Pod CIDR，另一条是 Join CIDR。

### 步骤 8：重启所有使用容器网络的 Pod

运行以下脚本以删除所有使用容器网络且 `restartPolicy=Always` 的 Pod：

```bash
#!/usr/bin/env bash
for ns in $(kubectl get ns --no-headers -o custom-columns=NAME:.metadata.name); do
  for pod in $(kubectl get pod --no-headers -n "$ns" --field-selector spec.restartPolicy=Always -o custom-columns=NAME:.metadata.name,HOST:spec.hostNetwork | awk '{if ($2!="true") print $1}'); do
    kubectl delete pod "$pod" -n "$ns" --ignore-not-found --wait=false
  done
done
```

### 步骤 9：验证已分配双栈 IP

运行：

```bash
kubectl get ips
```

您应该看到分配给 Pod 的 IPv4 和 IPv6 地址，例如：

```text
kube-ovn-pinger-vq896.kube-system   10.3.0.16   fd00:10:3::10   9a:3f:b1:71:58:5f   192.168.141.125   ovn-default
```

要进一步验证 IPv6 连接性，您可以使用 `kube-ovn-pinger` 对同一集群中使用容器网络的 Pod 的 IPv6 地址运行 `ping6`，例如：

```bash
kubectl exec -it -n kube-system kube-ovn-pinger-6fbx6 -- ping6 fd00:10:3::17
```

预期输出类似于：

```text
Defaulted container "pinger" out of: pinger, hostpath-init (init)
PING fd00:10:3::17 (fd00:10:3::17): 56 data bytes
64 bytes from fd00:10:3::17: icmp_seq=0 ttl=64 time=2.989 ms
```

## 附加信息

### CIDR 规划参考

| 目的        | IPv4            | IPv6                |
| ------------ | --------------- | ------------------- |
| Pod CIDR     | `10.3.0.0/16`   | `fd00:10:3::/112`   |
| Service CIDR | `10.4.0.0/16`   | `fd00:10:4::/112`   |
| Join CIDR    | `100.64.0.0/16` | `fd00:100:64::/112` |
