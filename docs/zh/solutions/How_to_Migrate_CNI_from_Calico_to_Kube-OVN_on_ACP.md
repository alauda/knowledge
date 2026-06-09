---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18
id: KB260600001
sourceSHA: c5e6f3f031103beeb071fe1c61be000780be57edbd5f8345070f48437490ac32
---

# 如何在 ACP 上将 CNI 从 Calico 迁移到 Kube-OVN

## 场景

集群当前使用 Calico 作为 CNI 插件，需要迁移到 Kube-OVN。

:::warning
本文件仅适用于业务集群。全球集群不支持 CNI 迁移。
:::

:::warning
本文件适用于 ACP 3.18。
:::

## 先决条件

在开始之前，请确保满足以下条件：

1. **集群版本**：ACP 3.18，由 `ait/tke` 管理集群生命周期。
2. **Kube-OVN 工件可用**：Chart 和镜像已推送到本地注册表，并且目标集群节点可以拉取：
   - chart: `acp/chart-cpaas-kube-ovn`（使用本地 ProductBase/artifacts 中的实际版本）
   - image: `acp/kube-ovn`（使用本地实际版本）
   - Sentry 使用的注册表密钥有效
3. **维护窗口已安排**：CNI 迁移会导致集群网络中断。现有 Pods 不会自动迁移网络。确保在可接受的维护窗口内进行操作。

## 影响

| 项目                 | 描述                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| 网络中断             | 迁移期间集群网络将受到干扰。现有 Pods 将失去连接。                                       |
| 节点重启             | 第 6 步需要逐个重启节点以清理 Calico 残留。                                             |

:::danger
此操作是不可逆的。确保您已充分评估风险，并在维护窗口内操作。
:::

## 解决方案

### 第 1 步：记录当前网络配置

**在业务集群上操作**

在进行任何更改之前，记录当前子网的网络参数。这些将在第 4 步配置 Kube-OVN 时需要：

```bash
# 确认子网名称
kubectl get subnet

# 记录默认子网的网关和 excludeIps（将 default-ipv4-ippool 替换为实际子网名称）
kubectl get subnet default-ipv4-ippool -o jsonpath='{.spec.gateway}{"\n"}'
kubectl get subnet default-ipv4-ippool -o jsonpath='{.spec.excludeIps}{"\n"}'
```

保存输出。您将需要：

- `gateway` → `<GW>` 在第 4 步中
- `excludeIps` → `<EXCLUDE_IPS>` 在第 4 步中

### 第 2 步：清理 Raven 和子网资源

**在业务集群上操作**

删除 Raven 组件和子网/IPS 资源，以避免与 Kube-OVN 冲突：

```bash
# 删除 Raven
kubectl -n kube-system delete svc raven
kubectl -n kube-system delete deploy raven
kubectl delete clusterrolebinding raven
kubectl delete clusterrole system:raven
kubectl -n kube-system delete sa raven

# 删除子网（先移除 finalizers）
for name in $(kubectl get subnet -o jsonpath='{.items[*].metadata.name}'); do
    kubectl patch subnet $name -p '{"metadata":{"finalizers":[]}}' --type=merge
    kubectl delete subnet $name
done

# 删除 IPs
kubectl delete ips --all
```

### 第 3 步：标记节点

**在业务集群上操作**

给控制平面节点标记 OVN 主节点标签。Kube-OVN 的核心组件将调度到此节点：

```bash
# 标记所有控制平面节点
kubectl label --overwrite node -l node-role.kubernetes.io/control-plane kube-ovn/role=master
```

:::warning
此步骤是必需的。没有 `kube-ovn/role=master` 标签，OVN 核心组件将无法调度。
:::

### 第 4 步：修改集群 CR 以触发 CNI 迁移

**在全球集群上操作**

注释集群以声明切换到 Kube-OVN。参数详情：

| 参数           | 描述                     | 来源                                                                            |
| --------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `join-cidr`     | Kube-OVN 加入子网 CIDR   | 推荐：`100.64.0.0/16`。确保它与现有网络不冲突。                                 |
| `gateway`       | 默认 Pod 网关             | 第 1 步中记录的子网 `spec.gateway`                                             |
| `exclude-ips`   | 子网排除的地址           | 第 1 步中记录的子网 `spec.excludeIps`                                          |

```bash
# 将 <CLS> 替换为目标集群名称，<GW> 和 <EXCLUDE_IPS> 替换为实际值
kubectl annotate cls <CLS> \
  cpaas.io/network-type=kube-ovn \
  kube-ovn.cpaas.io/join-cidr=100.64.0.0/16 \
  kube-ovn.cpaas.io/transmit-type=overlay \
  kube-ovn.cpaas.io/gateway=<GW> \
  kube-ovn.cpaas.io/exclude-ips=<EXCLUDE_IPS> \
  --overwrite
```

修改集群后，注释 ClusterModule 以时间戳触发迁移：

```bash
kubectl annotate clustermodule <CLS> \
  cni-switch.alauda.io/requested-at="$(date +%Y-%m-%dT%H:%M:%S%z)" \
  --overwrite
```

### 第 5 步：验证 Kube-OVN 组件是否准备就绪

**在业务集群上操作**

检查 Kube-OVN 安装进度，确认所有 Pods 正在运行：

```bash
kubectl get pod -n kube-system | grep ovn
```

以下组件应全部处于 `Running` 状态：

| 组件                   | 描述                | 预期副本数       |
| ---------------------- | ------------------- | ----------------- |
| `kube-ovn-cni`         | 每个节点一个        | 节点数量          |
| `ovs-ovn`              | 每个节点一个        | 节点数量          |
| `ovn-central`          | 控制平面            | ≥1                |
| `kube-ovn-controller`  | 网络控制器          | ≥1                |

:::warning
在所有组件处于 Running 状态之前，请勿继续进行下一步。
:::

### 第 6 步：卸载 Calico 并清理节点

**在业务集群上操作**

在 Kube-OVN 准备就绪后，清理所有 Calico 资源。

**6.1 删除 Calico CRDs 及其实例**

```bash
kubectl get crd -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | while read crd; do
  if ! echo $crd | grep '.crd.projectcalico.org$' >/dev/null; then
    continue
  fi
  for name in $(kubectl get $crd -o jsonpath='{.items[*].metadata.name}'); do
    kubectl delete $crd $name
  done
  kubectl delete crd $crd
done
```

**6.2 清理与 Raven 相关的 resourcePatches**

在第 2 步中删除 Raven 组件后，相关的 resourcePatch 资源仍将保留，需要清理：

```bash
# 查看与 Raven 相关的 resourcePatches
kubectl get resourcePatch | grep raven

# 删除所有与 Raven 相关的 resourcePatches
for name in $(kubectl get resourcePatch --no-headers | grep raven | awk '{print $1}'); do
  kubectl delete resourcePatch "$name"
done
```

**6.3 清理残留文件并逐个重启节点**

:::warning
节点必须逐个处理。等待当前节点重启后恢复并确认其状态，然后再进行下一个节点的操作。并行操作多个节点可能导致集群不可用。
:::

在 **每个节点** 上运行：

```bash
# 清理 CNI 配置残留
rm -f /etc/cni/net.d/10-calico.conflist /etc/cni/net.d/calico-kubeconfig
rm -f /opt/cni/bin/calico /opt/cni/bin/calico-ipam

# 清理 Calico 数据目录
rm -rf /var/lib/calico /var/run/calico /var/log/calico

# 重启节点（重启后，cali* 虚拟 NIC、tunl0 隧道、iptables/ipset 规则将自动移除）
reboot
```

节点重启后，确认其处于 `Ready` 状态，然后再进行下一个节点：

```bash
kubectl get node <node-name>
```

### 第 7 步：最终验证

**在业务集群上操作**

```bash
kubectl get apprelease -n cpaas-system | grep cni-
```

预期输出：

```text
cni-kube-ovn   Synced   Ready    chart synced   94m      95m
```

仅应保留 `cni-kube-ovn`；不应有 `cni-calico`。
