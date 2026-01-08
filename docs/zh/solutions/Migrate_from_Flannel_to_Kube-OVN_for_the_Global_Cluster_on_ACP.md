---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 4
id: KB260100005
sourceSHA: 9abfb6ec9977d7c233a0a0a77873935a46211bffcbff92fa08155a8c34603352
---

# 将 Flannel 迁移到 Kube-OVN 以支持 ACP 上的全球集群

## 问题

在 Alauda 容器平台（ACP）中，自 v4.0.6 起已移除 Flannel。对于将 Flannel 作为 CNI 插件运行的全球集群，需要将 Flannel 迁移到另一个 CNI 插件，例如 Kube-OVN。

本文档描述了如何将 Flannel 迁移到 Kube-OVN 以支持 ACP 上的全球集群。

## 环境

1. 使用 Flannel 作为 CNI 插件的 ACP 全球集群。

## 解决方案

:::warning
在迁移过程中，需要重启节点，并且容器网络将会中断，这将导致全球集群中出现一系列预期的故障，包括但不限于平台管理控制台无法访问。请提前规划操作窗口。
:::

### 准备工作

与 Flannel 相比，Kube-OVN 将自动创建一个名为 `join` 的子网，以连接主机网络和容器网络。在执行迁移之前，请提前规划 `join` 子网的 CIDR。

### 步骤

在全球集群的主节点上，执行以下脚本。确保将 `JOIN_SUBNET` 的值修改为所需的 `join` 子网的 CIDR：

```bash
#!/bin/bash

set -ex

# join 子网的 CIDR
JOIN_SUBNET=100.64.0.0/16

# 为主节点添加标签
kubectl label --overwrite node -l node-role.kubernetes.io/control-plane kube-ovn/role=master

# 更新集群信息
kubectl label --overwrite cls global cni-type=kube-ovn
kubectl annotate --overwrite cls global kube-ovn.cpaas.io/join-cidr=${JOIN_SUBNET} kube-ovn.cpaas.io/transmit-type=overlay
kubectl patch -n cpaas-system upcluster global --type=merge -p '{"spec":{"networkType":"kube-ovn"}}'

# 等待 kube-ovn 安装完成
while true; do
  echo "等待 minfo 被创建..."
  if [ $(kubectl get minfo -l cpaas.io/cluster-name=global,cpaas.io/module-name=kube-ovn -o name | wc -l) -eq 1 ]; then
    break
  fi
  sleep 5
done

while true; do
  echo "等待 ars 被创建..."
  name=$(kubectl -n cpaas-system get ars cni-kube-ovn --ignore-not-found -o name)
  if [ "$name" != "" ]; then
    break
  fi
  sleep 5
done

# 等待 kube-ovn 准备就绪
kubectl -n cpaas-system wait ars cni-kube-ovn --for condition=Health --timeout=900s

# 删除 flannel
kubectl delete --ignore-not-found minfo -l cpaas.io/cluster-name=global,cpaas.io/module-name=cni
kubectl delete --ignore-not-found -n cpaas-system ars cni-flannel
```

在全球集群的 **所有** 节点上，执行以下命令以清理与 Flannel 相关的文件：

```bash
# 移除 CNI 配置和二进制文件
rm -fv /etc/cni/net.d/10-flannel.conflist /opt/cni/bin/flannel
```

根据相关规范，重启全球集群中的所有节点。

在全球集群的主节点上，执行以下命令以清理节点注释：

```bash
# 移除注释
kubectl get node -o name | while read node; do
  kubectl annotate --overwrite $node \
    flannel.alpha.coreos.com/backend-data- \
    flannel.alpha.coreos.com/backend-type- \
    flannel.alpha.coreos.com/kube-subnet-manager- \
    flannel.alpha.coreos.com/public-ip-
done
```

等待集群组件恢复，并验证全球集群的功能是否正常。
