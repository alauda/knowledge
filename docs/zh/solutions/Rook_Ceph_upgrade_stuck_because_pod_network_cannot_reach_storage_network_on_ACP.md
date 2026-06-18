---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.1
id: KB260600091
sourceSHA: 5329c4e171c2c4e64c46996c0ccec3f33a497eabf5ccebff1e40badfc505a4e5
---

# Rook-Ceph 升级后 CephCluster 处于 Progressing 状态，因为 Pod 网络无法连接到存储网络

## 问题

在将 Alauda 容器平台从 4.2.4 升级到 4.3.1 的过程中，Alauda Build 的 Rook-Ceph 从 Reef 18.2.7 升级到 Squid 19.2.3。在升级过程中，OSD 的发布可能会停滞，`CephCluster` 会长时间保持在 `Progressing` 状态。

在受影响的环境中，Rook-Ceph 组件在升级前已进行自定义：`rook-ceph-operator`、CSI 提供者组件或相关的 Rook-Ceph Pod 被更改为使用 `hostNetwork` 运行，以便绕过 Pod 网络与存储网络之间的连接缺口。升级后，OLM CSV 和组件 ConfigMaps 中的手动更改被新的默认配置覆盖。受影响的组件在常规 Pod 网络上重新启动，无法再访问 Ceph 存储网络，从而阻碍了 Rook-Ceph 的升级。

## 环境

- Alauda 容器平台：从 4.2.4 升级到 4.3.1
- Rook-Ceph：从 Reef 18.2.7 升级到 Squid 19.2.3
- 命名空间：`rook-ceph`
- 适用场景：Pod 网络无法连接到 Ceph 存储网络，且环境之前依赖手动 `hostNetwork` 更改以实现 Rook-Ceph 组件的连接

## 根本原因

升级本身并不会造成网络故障。根本问题在于集群未满足所需的网络条件：常规 Pod 网络上的 Pod 无法访问 Ceph 存储网络。在升级之前，环境依赖手动自定义，将选定的 Rook-Ceph 控制平面或 CSI 组件移动到主机网络上。

在升级过程中，OLM 从新的 CSV 渲染并管理与操作相关的 Deployments。组件 ConfigMaps 中的手动参数也可能被默认值或后续的协调替换。因此，直接编辑 CSV 或 ConfigMap 并不是持久的升级配置。当这些编辑被还原时，Rook-Ceph 组件返回到常规 Pod 网络，失去对 Ceph 网络的访问，OSD 升级和 `CephCluster` 协调停滞。

## 诊断步骤

检查 `CephCluster` 是否仍处于升级或 `Progressing` 状态：

```bash
kubectl -n rook-ceph get cephcluster
kubectl -n rook-ceph describe cephcluster
```

检查 Rook-Ceph operator、工具、CSI 提供者或相关 Pod 是否被重新创建，以及它们的 Deployments 是否在常规 Pod 网络上运行：

```bash
kubectl -n rook-ceph get pod -o wide
kubectl -n rook-ceph get deploy -o jsonpath='{range .items[*]}{.metadata.name}{" hostNetwork="}{.spec.template.spec.hostNetwork}{"\n"}{end}'
```

检查 CSV 以确认 `rook-ceph-operator`、`rook-ceph-tools` 或与 CSI 相关的 Deployments 的 `hostNetwork` 设置是否已被还原：

```bash
kubectl get csv -A | grep rook-ceph
kubectl -n rook-ceph get csv <rook-ceph-csv-name> -o yaml
```

检查 `rook-ceph-operator-config` 是否仍包含强制主机网络的升级前参数：

```bash
kubectl -n rook-ceph get configmap rook-ceph-operator-config -o yaml
```

验证常规 Pod 网络到 Ceph 存储网络的连接性。以下命令仅显示方法；将 `<storage-network-ip>` 替换为可访问的 Ceph MON、OSD 或存储网络上的其他地址：

```bash
kubectl -n rook-ceph run network-check --rm -it --restart=Never \
  --image=busybox:1.36 -- sh

ping <storage-network-ip>
nc -vz <ceph-mon-ip> 3300
nc -vz <ceph-mon-ip> 6789
```

如果常规 Pod 无法访问存储网络，而主机网络 Pod 可以，则升级停滞的主要风险在于缺失的网络连接，而不是 Rook-Ceph 版本本身。

## 解决方案

长期解决方案是使 Ceph 存储网络可以从 Pod 网络访问。需要访问 Ceph 的 Rook-Ceph operator、CSI 提供者、工具和其他组件必须能够在常规 Pod 网络上运行时访问存储网络。

根据站点的网络模型确认以下项目：

- Pod CIDR 或 CNI 出口地址可以路由到 Ceph 公共网络和任何所需的集群网络。
- Ceph MON 端口 `3300` 和 `6789`，以及所需的 OSD 端口范围，允许从 Pod 网络或 CNI SNAT 地址的网络 ACL、防火墙和安全组访问。
- 如果使用 NetworkPolicy，允许 `rook-ceph` 命名空间中相关 Pod 到 Ceph 存储网络的出口。
- 如果 CNI SNAT 处理 Pod 到外部流量，则存储网络允许转换后的源地址。

修复网络路径后，重新检查常规 Pod 到 Ceph MON 和 OSD 地址的连接性，然后验证 Rook-Ceph 协调是否恢复：

```bash
kubectl -n rook-ceph get cephcluster
kubectl -n rook-ceph get pod -o wide
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=200
```

当 `CephCluster` 返回到 `Ready` 状态，OSD Pods 完成其滚动升级，并且新创建的 PVC 可以正常绑定和挂载时，升级阻塞问题得到解决。

## 临时恢复

如果必须在修复网络路径之前恢复生产服务，请临时恢复升级前的 `hostNetwork` 自定义，以便 Rook-Ceph 组件可以通过节点网络访问存储网络。这仅是紧急解决方案。它不是最终修复，因为手动 CSV 和 ConfigMap 编辑可能在后续升级或协调中再次被覆盖。

首先识别当前的 Rook-Ceph CSV：

```bash
kubectl get csv -A | grep rook-ceph
```

在 `rook-ceph` 命名空间中编辑 Rook-Ceph CSV。在 `rook-ceph-operator`、`rook-ceph-tools` 或已确认需要存储网络访问的 CSI 提供者组件的 Deployment 模板中，恢复：

```yaml
hostNetwork: true
```

然后检查或恢复 `rook-ceph-operator-config` 中的临时参数：

```bash
kubectl -n rook-ceph edit configmap rook-ceph-operator-config
```

示例值：

```yaml
data:
  ROOK_ENFORCE_HOST_NETWORK: "true"
```

更改后，观察受影响的 Pods 重新启动，并确认 `CephCluster` 继续进展：

```bash
kubectl -n rook-ceph get pod -w
kubectl -n rook-ceph get cephcluster -w
```

在紧急恢复后，安排网络修复，并在下次升级之前消除对手动 `hostNetwork` 自定义的依赖。

## 升级前预防

在升级 Rook-Ceph 之前，检查环境是否依赖手动自定义：

```bash
kubectl -n rook-ceph get deploy -o yaml | grep -n "hostNetwork"
kubectl -n rook-ceph get configmap rook-ceph-operator-config -o yaml
kubectl -n rook-ceph get csv -o yaml | grep -n "hostNetwork"
```

如果组件只能通过 `hostNetwork` 访问存储网络，请在升级平台或 Rook-Ceph 之前修复 Pod 网络与存储网络之间的连接。不要将直接编辑的 CSV 或操作员 ConfigMap 视为持久的升级配置。

## 相关问题

- Jira: ACP-53205
