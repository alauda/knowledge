---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.5,4.3.1,4.4.0'
---

# 如何将 Kube-OVN 集群从 IPv4 升级为双栈（IPv4/IPv6）

## 目的

本文介绍如何将使用 Kube-OVN 作为 CNI 插件的 Kubernetes 集群，从纯 IPv4 模式升级为 IPv4/IPv6 双栈模式。

## 环境

- 使用 Kube-OVN 作为 CNI 插件的 Alauda Container Platform 集群。
- 集群节点操作系统已支持 IPv6（内核未禁用 IPv6）。
- 集群节点网卡已配置真实 IPv6 地址，节点间 IPv6 路由互通。

## 前置条件

| 项目 | 要求 |
|------|------|
| ACP 版本 | ≥ 4.2.5，或 ≥ 4.3.1，或 ≥ 4.4.0 |
| CNI 插件 | Kube-OVN |
| 节点内核 | 已启用 IPv6（`net.ipv6.conf.all.disable_ipv6 = 0`）且已开启转发（`net.ipv6.conf.all.forwarding = 1`） |
| 节点网卡 | 已配置真实 IPv6 地址（GUA，如 `2004::/64` 段）并配置默认路由 |


## 解决方案

:::warning
升级过程中，所有容器网络 Pod 需要重启才能重新获取双栈 IP 地址。请提前规划操作窗口，并通知相关业务团队。
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

### 步骤 3：修改所有节点的 kubelet `--node-ip` 参数

在裸机双栈场景下，kubelet 需要显式配置双栈节点地址，否则 `Node.status.addresses` 中通常只会上报 IPv4 `InternalIP`，并可能影响依赖节点地址的 Kube-OVN 路由能力。

常见配置文件路径：

```bash
/var/lib/kubelet/kubeadm-flags.env
```

将单栈配置：

```bash
--node-ip=<IPv4>
```

修改为双栈配置：

```bash
--node-ip=<IPv4>,<IPv6>
```

示例：

```bash
--node-ip=192.168.134.191,2001:db8::191
```

:::warning
`<IPv6>` 必须使用前置条件中节点网卡已配置的 IPv6 地址，不能使用 Kube-OVN `join` 网段地址。
:::

修改完成后，重启 kubelet：

```bash
systemctl daemon-reload
systemctl restart kubelet
```

:::warning
对于自建集群，升级 kubelet 时通常不会覆盖 `/var/lib/kubelet/kubeadm-flags.env` 中已有的 `--node-ip` 配置。

对于 MicroOS 集群，集群升级后此配置会丢失，因此不建议将其作为持久化修改方式。
:::

### 步骤 4：修改 Kube-OVN 的 moduleInfo 配置

#### 4.1 查找目标集群的 moduleInfo

在 Global 集群节点上执行，找到对应集群的 Kube-OVN moduleInfo：

```bash
kubectl get moduleInfo -A | grep {集群名} | grep kube-ovn
```

示例输出：

```
business-1-2bcc878187dd9f0bb1c2b144032eae99   business-1   kube-ovn   kube-ovn   Processing   v4.2.28   ...
```

#### 4.2 编辑 moduleInfo，修改双栈相关参数

```bash
kubectl edit moduleInfo {moduleInfo名称}
```

将以下 5 个参数修改为双栈配置：

```yaml
spec:
  config:
    components:
      dual_stack:
        JOIN_CIDR: 100.64.0.0/16,fd00:100:64::/112
        POD_CIDR: 10.3.0.0/16,fd00:10:3::/112
        POD_GATEWAY: ""
        SVC_CIDR: 10.4.0.0/16,fd00:10:4::/112
      networking:
        NET_STACK: dual_stack
```

:::tip
`POD_GATEWAY` 在双栈模式下置空，由 Kube-OVN 自动分配网关。
:::

### 步骤 5：等待 Kube-OVN 核心组件重启

等待业务集群 Kube-OVN 核心组件全部重启完成：

- `kube-ovn-controller`
- `kube-ovn-cni`
- `ovn-central`
- `ovs-ovn`


### 步骤 6：验证双栈功能

以上组件 Running 后，重启所有容器网络 Pod 使其重新获取双栈 IP，然后执行以下命令验证：

```bash
# 查看节点是否已同时上报 IPv4/IPv6 InternalIP
kubectl get node <node-name> -o yaml

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
| Join CIDR | `100.64.0.0/16` | `fd00:100:64::/112` |
