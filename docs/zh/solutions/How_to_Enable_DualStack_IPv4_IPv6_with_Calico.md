---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.5,4.3.1,4.4.0'
---

# 如何将 Calico 集群从 IPv4 升级为双栈（IPv4/IPv6）

## 目的

本文介绍如何将使用 Calico 作为 CNI 插件的 Kubernetes 集群，从纯 IPv4 模式升级为 IPv4/IPv6 双栈模式。

## 环境

- 使用 Calico 作为 CNI 插件的 Alauda Container Platform 集群。
- **Calico 双栈的特殊要求**：与 Kube-OVN 不同，Calico 要求节点网卡本身已配置 IPv6 地址，且节点间 IPv6 路由互通，才能正常建立双栈网络。

## 前置条件

| 项目 | 要求 |
|------|------|
| ACP 版本 | ≥ 4.2.5，或 ≥ 4.3.1，或 ≥ 4.4.0 |
| CNI 插件 | Calico |
| 节点内核 | 已启用 IPv6（`net.ipv6.conf.all.disable_ipv6 = 0`）且已开启转发（`net.ipv6.conf.all.forwarding = 1`） |
| 节点网卡 | 已配置真实 IPv6 地址（GUA，如 `2004::/64` 段） |
| 节点间网络 | IPv6 路由互通（节点间可 IPv6 ping 通） |


## 解决方案

:::warning
升级过程中，业务 Pod 需要重启才能重新获取双栈 IP 地址。请提前规划操作窗口，并通知相关业务团队。
:::

### 步骤 1：修改所有 Master 节点的 kube-apiserver 配置

`kube-apiserver` 以静态 Pod 方式运行，配置文件路径：

```
/etc/kubernetes/manifests/kube-apiserver.yaml
```

将 `--service-cluster-ip-range` 参数修改为双栈格式：

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 2：修改所有 Master 节点的 kube-controller-manager 配置

配置文件路径：

```
/etc/kubernetes/manifests/kube-controller-manager.yaml
```

将以下两个参数修改为双栈格式：

```yaml
- --cluster-cidr=10.3.0.0/16,fd00:10:3::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 3：修改 Calico 的 moduleInfo 配置

#### 3.1 查找目标集群的 moduleInfo

在 Global 集群节点上执行，找到对应集群的 Calico moduleInfo：

```bash
kubectl get moduleInfo -A | grep {集群名} | grep calico
```

#### 3.2 编辑 moduleInfo，修改双栈相关参数

```bash
kubectl edit moduleInfo {moduleInfo名称} -n {namespace}
```

将以下参数修改为双栈配置：

```yaml
spec:
  config:
    components:
      networking:
        NET_STACK: dual
      dual_stack:
        v4PodCIDR: 10.3.0.0/16
        v6PodCIDR: fd00:10:3::/112
```

### 步骤 4：等待 Calico 核心组件重启

等待以下 Calico 核心组件全部重启完成：

- `calico-node`
- `calico-kube-controllers`

### 步骤 5：验证双栈功能

全部组件 Running 后，重启所有容器网络 Pod 使其重新获取双栈 IP，然后执行以下命令验证：

```bash
# 查看 Pod 是否已分配双栈 IP
kubectl get pod <pod-name> -o jsonpath='{.status.podIPs}'
```

预期输出示例：

```json
[{"ip":"10.3.x.x"},{"ip":"fd00:10:3::x"}]
```

## 相关信息

### CIDR 地址规划参考

| 用途 | IPv4 | IPv6 |
|------|------|------|
| Pod CIDR | `10.3.0.0/16` | `fd00:10:3::/112` |
| Service CIDR | `10.4.0.0/16` | `fd00:10:4::/112` |
