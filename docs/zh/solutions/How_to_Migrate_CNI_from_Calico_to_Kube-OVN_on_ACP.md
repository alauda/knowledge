---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18
id: KB260600001
sourceSHA: pending
---

# 操作手册：ACP 集群 CNI 原地切换 Calico → Kube-OVN

## 适用场景

集群当前使用 Calico 作为 CNI 插件，因业务需求（如需要固定 IP、多子网、网络策略增强等）需要切换为 Kube-OVN，且不希望重建集群。

:::warning
本文档适用于 ACP 3.18 版本。
:::

## 前置条件

在开始操作前，请确认以下条件已满足：

1. **集群版本**：ACP 3.18，集群生命周期由 `ait/tke` 管理。
2. **Kube-OVN 制品已入库**：chart 和镜像已推送到现场 registry，目标集群节点可正常拉取：
   - chart：`acp/chart-cpaas-kube-ovn`（以现场 ProductBase/artifacts 实际版本为准）
   - image：`acp/kube-ovn`（以现场实际版本为准）
   - sentry 使用的 registry secret 可用
3. **已安排维护窗口**：CNI 切换会导致集群网络中断，已有 Pod 不会自动迁移网络，请确保在业务可接受的维护时段内操作。

## 操作影响

| 影响项 | 说明 |
|--------|------|
| 网络中断 | 切换过程中集群网络会中断，已有 Pod 的网络连通性将受到影响 |
| 节点重启 | 步骤 6 需要逐台重启节点以清理 Calico 残留 |

:::danger
此操作不可逆，请确保已充分评估风险并在维护窗口内操作。
:::

## 解决方案

:::warning
**注意集群上下文**：步骤 4 在 **Global 集群**上操作，其余步骤在**业务集群**上操作。操作前请确认当前 kubeconfig 上下文指向正确的集群。
:::

### 步骤 1：记录当前网络配置

**在业务集群上操作**

在执行变更前，先从当前 Subnet 中记录网络参数，后续步骤 4 配置 Kube-OVN 时需要用到：

```bash
# 记录默认 subnet 的 gateway、excludeIps、cidrBlock
kubectl get subnet default-ipv4-ippool -o jsonpath='{.spec.gateway}{"\n"}'
kubectl get subnet default-ipv4-ippool -o jsonpath='{.spec.excludeIps}{"\n"}'
kubectl get subnet default-ipv4-ippool -o jsonpath='{.spec.cidrBlock}{"\n"}'
```

请保存以上输出结果，其中：
- `gateway` → 步骤 4 的 `<GW>`
- `excludeIps` → 步骤 4 的 `<EXCLUDE_IPS>`
- `cidrBlock` → 用于确认 Pod CIDR 范围

### 步骤 2：清理 Raven 和子网资源

**在业务集群上操作**

删除 Raven 组件和子网/IPS 资源，避免和 Kube-OVN 冲突：

```bash
# 删除 Raven
kubectl -n kube-system delete svc raven
kubectl -n kube-system delete deploy raven
kubectl delete clusterrolebinding raven
kubectl delete clusterrole system:raven
kubectl -n kube-system delete sa raven

# 删除 subnet（需先去掉 finalizer）
for name in $(kubectl get subnet -o jsonpath='{.items[*].metadata.name}'); do
    kubectl patch subnet $name -p '{"metadata":{"finalizers":[]}}' --type=merge
    kubectl delete subnet $name
done

# 删除 ips
kubectl delete ips --all
```

### 步骤 3：为 Node 打标签

**在业务集群上操作**

为控制平面节点打上 OVN master 标签，Kube-OVN 的 central 组件将调度到该节点：

```bash
# 替换 <control-plane-node> 为实际的控制平面节点名称
kubectl label node <control-plane-node> kube-ovn/role=master --overwrite
```

:::warning
必须执行此步骤，否则 OVN central 组件会因缺少调度标签而无法启动。
:::

### 步骤 4：修改 Cluster CR 触发 CNI 切换

**在 Global 集群上操作**

修改 Cluster 的 annotation，声明切换到 Kube-OVN。参数说明如下：

| 参数 | 说明 | 获取方式 |
|------|------|----------|
| `join-cidr` | Kube-OVN join 子网 CIDR | 建议使用 `100.64.0.0/16`，需确保不与现有网络冲突 |
| `gateway` | 默认 Pod 网关 | 步骤 1 中记录的 Subnet `spec.gateway` |
| `exclude-ips` | 子网排除地址 | 步骤 1 中记录的 Subnet `spec.excludeIps` |

```bash
# 替换 <CLS> 为目标集群名称，替换 <GW> 和 <EXCLUDE_IPS> 为实际值
kubectl annotate cls <CLS> \
  cpaas.io/network-type=kube-ovn \
  kube-ovn.cpaas.io/join-cidr=100.64.0.0/16 \
  kube-ovn.cpaas.io/transmit-type=overlay \
  kube-ovn.cpaas.io/gateway=<GW> \
  kube-ovn.cpaas.io/exclude-ips=<EXCLUDE_IPS> \
  --overwrite
```

修改 Cluster 后，对 ClusterModule 打一个时间戳注解来触发切换：

```bash
kubectl annotate clustermodule <CLS> \
  cni-switch.alauda.io/requested-at="$(date +%Y-%m-%dT%H:%M:%S%z)" \
  --overwrite
```

### 步骤 5：确认 Kube-OVN 组件就绪

**在业务集群上操作**

观察 Kube-OVN 组件安装进度，确认所有 Pod 正常运行：

```bash
kubectl get pod -n kube-system | grep ovn
```

期望输出中以下组件均为 `Running` 状态：

| 组件 | 说明 | 期望副本数 |
|------|------|-----------|
| `kube-ovn-cni` | 每个节点一个 | 节点数 |
| `ovs-ovn` | 每个节点一个 | 节点数 |
| `ovn-central` | 控制平面 | ≥1 |
| `kube-ovn-controller` | 网络控制器 | ≥1 |

:::warning
所有组件都 Running 后再继续下一步。如果有 Pod 异常，可通过 `kubectl describe pod <pod-name> -n kube-system` 排查。
:::

### 步骤 6：卸载 Calico 和节点清理

**在业务集群上操作**

Kube-OVN 就绪后，清理 Calico 所有资源。

**6.1 删除 Calico CRD 及其实例**

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

**6.2 清理 Raven 相关的 resourcePatch**

步骤 2 删除 Raven 组件后，其对应的 resourcePatch 资源仍会残留，需要一并清理：

```bash
# 查看 Raven 相关的 resourcePatch
kubectl get resourcePatch | grep raven

# 删除所有 Raven 相关的 resourcePatch
for name in $(kubectl get resourcePatch --no-headers | grep raven | awk '{print $1}'); do
  kubectl delete resourcePatch "$name"
done
```

**6.3 逐台节点清理残留文件并重启**

:::warning
必须逐台操作，等当前节点重启恢复并确认状态正常后，再处理下一台。同时操作多台节点可能导致集群不可用。
:::

在**每台节点**上执行：

```bash
# 清理 CNI 配置残留
rm -f /etc/cni/net.d/10-calico.conflist /etc/cni/net.d/calico-kubeconfig
rm -f /opt/cni/bin/calico /opt/cni/bin/calico-ipam

# 清理 Calico 数据目录
rm -rf /var/lib/calico /var/run/calico /var/log/calico

# 重启节点（重启后 cali* 虚拟网卡、tunl0 隧道、iptables/ipset 规则会自动清除）
reboot
```

节点重启后，确认该节点状态为 `Ready` 后再处理下一台：

```bash
kubectl get node <node-name>
```

### 步骤 7：最终校验

**在业务集群上操作**

```bash
kubectl get apprelease -n cpaas-system | grep cni-
```

期望输出类似：

```
cni-kube-ovn   Synced   Ready    chart synced   94m      95m
```

仅剩 `cni-kube-ovn`，没有 `cni-calico`。
