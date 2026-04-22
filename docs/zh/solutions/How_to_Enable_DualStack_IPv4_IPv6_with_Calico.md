---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2,4.3'
---

# 如何将 Calico 集群从 IPv4 升级为双栈（IPv4/IPv6）

## 目的

本文介绍如何将使用 Calico 作为 CNI 插件的 Kubernetes 集群，从纯 IPv4 模式升级为 IPv4/IPv6 双栈模式。

## 环境

- 使用 Calico 作为 CNI 插件的 Alauda Container Platform 集群。

## 前置条件

| 项目 | 要求 |
|------|------|
| ACP 版本 | 4.2, 4.3 |
| CNI 插件 | Calico |
| 节点内核 | 已启用 IPv6（`net.ipv6.conf.all.disable_ipv6 = 0`）且已开启转发（`net.ipv6.conf.all.forwarding = 1`） |
| 节点网卡 | 已配置真实 IPv6 地址（GUA，如 `2004::/64` 段） |
| 节点间网络 | IPv6 路由互通（节点间可 IPv6 ping 通） |


## 解决方案

:::warning
升级过程中，所有使用容器网络的 Pod 需要重启，才能重新获取双栈 IP 地址。请提前规划操作窗口，并通知相关业务团队。
同时，本文中对 `calico-node` 等组件参数的修改会生成 `resourcePatch`。集群升级时这些 `resourcePatch` 可能会被删除，导致这里配置的双栈参数丢失。升级时请重点关注这一点，并在升级后重新检查相关参数，必要时重新设置。
:::

### 步骤 1：修改所有 Master 节点的 kube-apiserver 配置

`kube-apiserver` 以静态 Pod 方式运行，配置文件路径：

```text
/etc/kubernetes/manifests/kube-apiserver.yaml
```

将 `--service-cluster-ip-range` 参数修改为双栈格式：

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 2：修改所有 Master 节点的 kube-controller-manager 配置

配置文件路径：

```text
/etc/kubernetes/manifests/kube-controller-manager.yaml
```

将以下两个参数修改为双栈格式：

```yaml
- --cluster-cidr=10.3.0.0/16,fd00:10:3::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 3：修改 `calico-config` ConfigMap

执行以下命令：

```bash
kubectl edit configmap calico-config -n kube-system
```

将 `assign_ipv6` 参数设置为 `true`。

### 步骤 4：修改 `calico-node` DaemonSet 配置

执行以下命令：

```bash
kubectl edit daemonset calico-node -n kube-system
```

在 `env` 中增加以下环境变量：

```yaml
- name: IP6
  value: "autodetect"
- name: CALICO_IPV6POOL_CIDR
  value: "fd00:10:3::/112"
- name: IP6_AUTODETECTION_METHOD
  value: "first-found"
- name: "FELIX_IPV6SUPPORT"
  value: "true"
```

其中，`CALICO_IPV6POOL_CIDR` 的取值表示期望分配 IPv6 地址的 CIDR 范围。

### 步骤 5：确认 Calico 已自动创建默认 IPv6 IPPool

以上修改完成后，Calico 会自动生成一个默认的 IPv6 IPPool，其地址范围为 `CALICO_IPV6POOL_CIDR` 所设置的 CIDR 范围。

执行以下命令：

```bash
kubectl get ippool -A
```

预期输出类似：

```text
NAME                  AGE
default-ipv4-ippool   5d4h
default-ipv6-ippool   2m34s
```

确认 `default-ipv6-ippool` 已创建。

### 步骤 6：修改默认子网为双栈子网

升级成双栈后，原有默认子网 `default-ipv4-ippool` 仍为单栈类型，尚未建立与双栈 IPPool 的对应关系。这不会影响新生成 IPv6 IPPool 的使用，但会影响自定义资源 `Subnet` 和 `IPs` 的正确查询。

如需修改默认子网，可执行以下命令：

```bash
kubectl edit subnet default-ipv4-ippool
```

将子网配置修改为双栈格式，例如：

```yaml
cidrBlock: 10.3.0.0/16,fd00:10:3::/112
protocol: Dual
```

### 步骤 7：删除需要 CNI 分配地址的 Pod

执行以下脚本，删除所有使用容器网络且 `restartPolicy=Always` 的 Pod：

```bash
#!/usr/bin/env bash
for ns in $(kubectl get ns --no-headers -o custom-columns=NAME:.metadata.name); do
  for pod in $(kubectl get pod --no-headers -n "$ns" --field-selector spec.restartPolicy=Always -o custom-columns=NAME:.metadata.name,HOST:spec.hostNetwork | awk '{if ($2!="true") print $1}'); do
    kubectl delete pod "$pod" -n "$ns" --ignore-not-found --wait=false
  done
done
```

Pod 重启后会重新分配 IPv4 和 IPv6 两个地址。

执行 `kubectl get ips -A`，确认新创建的 IP 已同时包含 IPv4 和 IPv6 地址。

如需进一步验证 IPv6 连通性，可从 `kubectl get ips -A` 的输出中选择同一集群内两个使用容器网络的 Pod IPv6 地址，互相执行 `ping6` 测试。

## 相关信息

### CIDR 地址规划参考

| 用途 | IPv4 | IPv6 |
|------|------|------|
| Pod CIDR | `10.3.0.0/16` | `fd00:10:3::/112` |
| Service CIDR | `10.4.0.0/16` | `fd00:10:4::/112` |
