---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3.1'
---

# Rook-Ceph 升级后 CephCluster 持续 Progressing，因为 Pod 网络无法访问存储网络

## 问题

在 Alauda Container Platform 从 4.2.4 升级到 4.3.1 的过程中，Alauda Build of Rook-Ceph 从 Reef 18.2.7 升级到 Squid 19.2.3。升级期间 OSD 升级卡住，`CephCluster` 长时间处于 `Progressing` 状态。

现场曾在升级前对 Rook-Ceph 组件做过差异化配置：将 `rook-ceph-operator` 和 CSI provisioner 等组件改为 `hostNetwork` 运行，以绕过 Pod 网络无法访问存储网络的问题。升级后，OLM CSV 和组件 ConfigMap 中的手工修改被新版本默认配置覆盖，相关组件重新以普通 Pod 网络启动，导致它们无法访问 Ceph 存储网络，进而阻塞 Rook-Ceph 升级。

## 环境

- Alauda Container Platform: 4.2.4 升级到 4.3.1
- Rook-Ceph: Reef 18.2.7 升级到 Squid 19.2.3
- 命名空间: `rook-ceph`
- 适用场景: Pod 网络与 Ceph 存储网络未打通，且升级前通过 `hostNetwork` 手工规避过 Rook-Ceph 组件连通性问题

## 根本原因

该问题不是升级过程主动破坏了网络，而是集群原本存在网络前提不满足：普通 Pod 网络无法访问 Ceph 存储网络。升级前的环境依赖手工差异化配置，让部分 Rook-Ceph 控制面或 CSI 组件使用主机网络访问存储网络。

升级时，OLM 会根据新版本 CSV 重新渲染并管理 operator 相关 Deployment；组件 ConfigMap 中的手工参数也可能被默认配置或后续 reconcile 覆盖。因此，直接编辑 CSV 或 ConfigMap 形成的 `hostNetwork` 差异不是稳定配置。升级后这些差异被还原，Rook-Ceph 组件回到普通 Pod 网络后无法访问 Ceph 网络，导致 OSD 升级和 `CephCluster` reconcile 卡住。

## 诊断步骤

查看 `CephCluster` 是否持续处于升级中或 `Progressing` 状态：

```bash
kubectl -n rook-ceph get cephcluster
kubectl -n rook-ceph describe cephcluster
```

查看 Rook-Ceph operator、tools、CSI provisioner 等 Pod 是否重建过，以及是否运行在普通 Pod 网络：

```bash
kubectl -n rook-ceph get pod -o wide
kubectl -n rook-ceph get deploy -o jsonpath='{range .items[*]}{.metadata.name}{" hostNetwork="}{.spec.template.spec.hostNetwork}{"\n"}{end}'
```

检查 CSV 中与 `rook-ceph-operator`、`rook-ceph-tools` 或 CSI 相关 Deployment 的 `hostNetwork` 配置是否已经被还原：

```bash
kubectl get csv -A | grep rook-ceph
kubectl -n rook-ceph get csv <rook-ceph-csv-name> -o yaml
```

检查 `rook-ceph-operator-config` 中是否仍保留升级前用于强制 host network 的参数：

```bash
kubectl -n rook-ceph get configmap rook-ceph-operator-config -o yaml
```

从普通 Pod 网络验证到 Ceph 存储网络的连通性。以下命令只给出检查方式，`<storage-network-ip>` 需要替换为现场 Ceph MON、OSD 或存储网络上可验证的地址：

```bash
kubectl -n rook-ceph run network-check --rm -it --restart=Never \
  --image=busybox:1.36 -- sh

ping <storage-network-ip>
nc -vz <ceph-mon-ip> 3300
nc -vz <ceph-mon-ip> 6789
```

如果普通 Pod 无法访问存储网络，而 host network Pod 可以访问，则说明升级卡住的核心风险是网络连通性缺失，而不是 Rook-Ceph 版本本身。

## 解决方案

长期解决方案是打通 Pod 网络到 Ceph 存储网络的访问路径，使 Rook-Ceph operator、CSI provisioner、tools 以及其他需要访问 Ceph 的组件在普通 Pod 网络下也能访问存储网络。

根据现场网络模型，至少需要确认以下方向：

- Pod CIDR 或 CNI 出口地址能够路由到 Ceph public network 和必要的 cluster network。
- Ceph MON 端口 `3300`、`6789` 以及 OSD 所需端口范围在网络 ACL、防火墙和安全组中允许来自 Pod 网络或 CNI SNAT 地址访问。
- 如果使用 NetworkPolicy，需要允许 `rook-ceph` 命名空间内相关 Pod 到 Ceph 存储网络的 egress。
- 如果 CNI 对 Pod 到外部网络做 SNAT，需要确认存储网络侧允许 SNAT 后的源地址。

网络修复后，重新检查普通 Pod 到 Ceph MON 和 OSD 地址的连通性，再观察 Rook-Ceph reconcile 是否恢复：

```bash
kubectl -n rook-ceph get cephcluster
kubectl -n rook-ceph get pod -o wide
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=200
```

当 `CephCluster` 恢复到 `Ready`，OSD Pod 完成滚动升级，且新建 PVC 能正常绑定和挂载时，说明升级阻塞已解除。

## 临时恢复

如果生产环境必须先恢复升级流程，可以临时恢复升级前的 `hostNetwork` 差异配置，使 Rook-Ceph 组件重新通过主机网络访问存储网络。该方式只能作为应急规避，不应作为最终方案，因为 CSV 和 ConfigMap 手工修改可能在后续升级或 reconcile 中再次被覆盖。

先确认当前 Rook-Ceph CSV：

```bash
kubectl get csv -A | grep rook-ceph
```

编辑 `rook-ceph` 命名空间中的 Rook-Ceph CSV，在与 `rook-ceph-operator`、`rook-ceph-tools` 或现场确认需要访问存储网络的 CSI provisioner 相关的 Deployment 模板中补回：

```yaml
hostNetwork: true
```

再检查或补回 `rook-ceph-operator-config` 中的临时参数：

```bash
kubectl -n rook-ceph edit configmap rook-ceph-operator-config
```

示例值：

```yaml
data:
  ROOK_ENFORCE_HOST_NETWORK: "true"
```

修改后观察相关 Pod 是否重建，并确认 `CephCluster` 是否继续推进：

```bash
kubectl -n rook-ceph get pod -w
kubectl -n rook-ceph get cephcluster -w
```

应急恢复完成后，仍需要安排网络修复，并在下次升级前取消对手工 `hostNetwork` 差异的依赖。

## 升级前预防检查

在升级 Rook-Ceph 前，检查是否存在依赖手工差异化配置的环境：

```bash
kubectl -n rook-ceph get deploy -o yaml | grep -n "hostNetwork"
kubectl -n rook-ceph get configmap rook-ceph-operator-config -o yaml
kubectl -n rook-ceph get csv -o yaml | grep -n "hostNetwork"
```

如果发现只有通过 `hostNetwork` 才能访问存储网络，应先修复 Pod 网络到存储网络的连通性，再执行平台或 Rook-Ceph 升级。不要把直接编辑 CSV 或 operator ConfigMap 作为可持久升级配置使用。

## 关联问题

- Jira: ACP-53205
