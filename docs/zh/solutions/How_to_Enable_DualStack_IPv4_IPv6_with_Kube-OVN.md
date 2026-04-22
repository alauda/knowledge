---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2,4.3'
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
| ACP 版本 | 4.2, 4.3 |
| CNI 插件 | Kube-OVN |
| 节点内核 | 已启用 IPv6（`net.ipv6.conf.all.disable_ipv6 = 0`）且已开启转发（`net.ipv6.conf.all.forwarding = 1`） |
| 节点网卡 | 已配置真实 IPv6 地址（GUA，如 `2004::/64` 段）并配置默认路由 |


## 解决方案

:::warning
升级过程中，所有使用容器网络的 Pod 需要重启，才能重新获取双栈 IP 地址。请提前规划操作窗口，并通知相关业务团队。
同时，本文中对 `kube-ovn-controller`、`kube-ovn-cni` 等组件参数的修改会生成 `resourcePatch`。集群升级时这些 `resourcePatch` 可能会被删除，导致这里配置的双栈参数丢失。升级时请重点关注这一点，并在升级后重新检查相关参数，必要时重新设置。
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

对于 MicroOS 集群，集群升级后此配置会丢失，因此不建议将其作为持久化修改方式。不要依赖 `/var/lib/kubelet/kubeadm-flags.env` 在升级后保持不变。升级完成后，建议重新检查 kubelet 的 `--node-ip=<IPv4>,<IPv6>` 配置以及 `Node.status.addresses` 是否仍为双栈；如配置丢失，需重新设置并重启 kubelet。
:::

### 步骤 4：修改 `kube-system/kube-ovn-controller` 的参数

编辑 Deployment：

```bash
kubectl edit deploy kube-ovn-controller -n kube-system
```

将以下参数修改为双栈格式：

```yaml
- --node-switch-cidr=100.64.0.0/16,fd00:100:64::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
- --default-cidr=10.3.0.0/16,fd00:10:3::/112
```

### 步骤 5：验证节点注解是否已更新为双栈

执行以下命令：

```bash
kubectl get node <node-name> -o yaml
```

确认以下注解已经更新为双栈格式：

```yaml
ovn.kubernetes.io/cidr: 100.64.0.0/16,fd00:100:64::/112
ovn.kubernetes.io/gateway: 100.64.0.1,fd00:100:64::1
```

### 步骤 6：修改 `kube-system/kube-ovn-cni` 的参数

编辑 DaemonSet：

```bash
kubectl edit ds kube-ovn-cni -n kube-system
```

将以下参数修改为双栈格式：

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### 步骤 7：验证节点 IPv6 路由

在节点上执行：

```bash
ip -6 r
```

预期可以看到类似以下 IPv6 路由：

```text
fd00:100:64::/112 dev ovn0 proto kernel metric 256 pref medium
```

### 步骤 8：重启所有使用容器网络的 Pod

执行以下脚本，删除所有使用容器网络且 `restartPolicy=Always` 的 Pod：

```bash
#!/usr/bin/env bash
for ns in $(kubectl get ns --no-headers -o custom-columns=NAME:.metadata.name); do
  for pod in $(kubectl get pod --no-headers -n "$ns" --field-selector spec.restartPolicy=Always -o custom-columns=NAME:.metadata.name,HOST:spec.hostNetwork | awk '{if ($2!="true") print $1}'); do
    kubectl delete pod "$pod" -n "$ns" --ignore-not-found --wait=false
  done
done
```

### 步骤 9：验证双栈 IP 是否已生成

执行以下命令：

```bash
kubectl get ips
```

预期可以看到 Pod 已同时分配 IPv4 和 IPv6 地址，例如：

```text
kube-ovn-pinger-vq896.kube-system   10.3.0.16   fd00:10:3::10   9a:3f:b1:71:58:5f   192.168.141.125   ovn-default
```

如需进一步验证 IPv6 连通性，可以使用 `kube-ovn-pinger` 对同一集群内使用容器网络的 Pod IPv6 地址执行 `ping6`，例如：

```bash
kubectl exec -it -n kube-system kube-ovn-pinger-6fbx6 -- ping6 fd00:10:3::17
```

预期输出类似：

```text
Defaulted container "pinger" out of: pinger, hostpath-init (init)
PING fd00:10:3::17 (fd00:10:3::17): 56 data bytes
64 bytes from fd00:10:3::17: icmp_seq=0 ttl=64 time=2.989 ms
```

## 相关信息

### CIDR 地址规划参考

| 用途 | IPv4 | IPv6 |
|------|------|------|
| Pod CIDR | `10.3.0.0/16` | `fd00:10:3::/112` |
| Service CIDR | `10.4.0.0/16` | `fd00:10:4::/112` |
| Join CIDR | `100.64.0.0/16` | `fd00:100:64::/112` |
