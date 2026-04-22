---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2,4.3'
id: KB260400012
sourceSHA: 318617ec87e729be0d2d8bf0a84444f02bd0dda6b7eca934fb4f0541ff15be1f
---

# 将 Calico 集群从 IPv4 升级到双栈 (IPv4/IPv6)

## 问题

本文档描述了如何将使用 Calico 作为 CNI 插件的 Kubernetes 集群从仅 IPv4 模式升级到双栈 IPv4/IPv6 模式。

## 环境

- 使用 Calico 作为 CNI 插件的 Alauda Container Platform 集群。
- Calico 双栈的特殊要求：与 Kube-OVN 不同，Calico 需要节点 NIC 上配置真实的 IPv6 地址，并且节点之间的 IPv6 路由必须可达，才能正确工作双栈网络。

## 先决条件

| 项目               | 要求                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| ACP 版本           | 4.2, 4.3                                                                                                              |
| CNI 插件           | Calico                                                                                                                |
| 节点内核           | 已启用 IPv6 (`net.ipv6.conf.all.disable_ipv6 = 0`) 并且已启用转发 (`net.ipv6.conf.all.forwarding = 1`) |
| 节点 NIC          | 配置了真实的 IPv6 地址（例如 GUA `2004::/64`）                                                      |
| 节点间网络        | 节点之间的 IPv6 路由可达，并且节点可以通过 IPv6 相互 ping 通                                       |

## 解决方案

:::warning
在升级过程中，所有使用容器网络的 Pod 必须重新启动以重新获取双栈 IP 地址。请提前规划维护窗口并通知相关应用团队。
同时，本文档中对 `calico-node` 等组件的参数更改会创建 `resourcePatch` 条目。这些 `resourcePatch` 条目可能在集群升级过程中被删除，这可能导致此处配置的双栈参数丢失。请在升级过程中特别注意这一点，并在升级后根据需要重新检查和重新应用相关参数。
:::

### 步骤 1：更新所有主节点上的 kube-apiserver 配置

`kube-apiserver` 作为静态 Pod 运行。配置文件路径为：

```text
/etc/kubernetes/manifests/kube-apiserver.yaml
```

将 `--service-cluster-ip-range` 更新为双栈格式：

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 2：更新所有主节点上的 kube-controller-manager 配置

配置文件路径为：

```text
/etc/kubernetes/manifests/kube-controller-manager.yaml
```

将以下两个参数更新为双栈格式：

```yaml
- --cluster-cidr=10.3.0.0/16,fd00:10:3::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 3：更新 `calico-config` ConfigMap

运行：

```bash
kubectl edit configmap calico-config -n kube-system
```

将 `assign_ipv6` 参数设置为 `true`。

### 步骤 4：更新 `calico-node` DaemonSet 配置

运行：

```bash
kubectl edit daemonset calico-node -n kube-system
```

在 `env` 下添加以下环境变量：

```yaml
- name: IP6
  value: "autodetect"
- name: CALICO_IPV6POOL_CIDR
  value: "fd00:10:3::/112"
- name: IP6_AUTODETECTION_METHOD
  value: "first-found"
- name: FELIX_IPV6SUPPORT
  value: "true"
```

`CALICO_IPV6POOL_CIDR` 的值定义了分配 IPv6 地址的 CIDR 范围。

### 步骤 5：确认 Calico 自动创建默认的 IPv6 IPPool

在应用上述更改后，Calico 会自动使用 `CALICO_IPV6POOL_CIDR` 中配置的 CIDR 范围创建默认的 IPv6 IPPool。

运行：

```bash
kubectl get ippool -A
```

预期输出类似于：

```text
NAME                  AGE
default-ipv4-ippool   5d4h
default-ipv6-ippool   2m34s
```

确认 `default-ipv6-ippool` 已被创建。

### 步骤 6：将默认子网更新为双栈子网

在集群升级到双栈后，现有的默认子网 `default-ipv4-ippool` 仍然是单栈的，并且尚未映射到双栈 IPPool。这不会影响新的 IPv6 IPPool 本身，但会影响自定义资源 `Subnet` 和 `IPs` 的正确查询。

如果要更新默认子网，请运行：

```bash
kubectl edit subnet default-ipv4-ippool
```

将子网配置更新为双栈格式，例如：

```yaml
cidrBlock: 10.3.0.0/16,fd00:10:3::/112
protocol: Dual
```

### 步骤 7：删除需要 CNI 分配地址的 Pods

运行以下脚本以删除所有使用容器网络并且 `restartPolicy=Always` 的 Pods：

```bash
#!/usr/bin/env bash
for ns in $(kubectl get ns --no-headers -o custom-columns=NAME:.metadata.name); do
  for pod in $(kubectl get pod --no-headers -n "$ns" --field-selector spec.restartPolicy=Always -o custom-columns=NAME:.metadata.name,HOST:spec.hostNetwork | awk '{if ($2!="true") print $1}'); do
    kubectl delete pod "$pod" -n "$ns" --ignore-not-found --wait=false
  done
done
```

在 Pods 重新启动后，它们将被分配 IPv4 和 IPv6 地址。

运行 `kubectl get ips -A` 并确认新创建的 IP 条目包含 IPv4 和 IPv6 地址。

要进一步验证 IPv6 连接性，从 `kubectl get ips -A` 输出中选择两个使用容器网络的 Pods 的 IPv6 地址，并在它们之间运行 `ping6`。

## 附加信息

### CIDR 规划参考

| 目的        | IPv4          | IPv6              |
| ------------ | ------------- | ----------------- |
| Pod CIDR     | `10.3.0.0/16` | `fd00:10:3::/112` |
| Service CIDR | `10.4.0.0/16` | `fd00:10:4::/112` |
