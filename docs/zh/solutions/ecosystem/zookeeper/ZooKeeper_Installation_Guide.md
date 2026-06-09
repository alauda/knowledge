---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '3.18,4.0,4.1'
id: KB260600001
---

# ZooKeeper 安装指南

## 概述

ZooKeeper 是一个分布式协调服务，用于维护配置信息、命名、提供分布式同步和组服务。本指南介绍如何在 Alauda 容器平台 (ACP) 上通过 Helm Chart 部署 ZooKeeper 3.8.6 集群。

## 先决条件

- 支持动态供给的 StorageClass（每个 Pod 需要独立 PVC）
- 从**应用商店 > 应用入驻**下载与集群版本匹配的 `violet` 工具

## 安装步骤

### 1. 上传材料包

```bash
violet push \
  --platform-address <platform-address> \
  --clusters <business-cluster-name> \
  --platform-username <platform-admin-username> \
  --platform-password <platform-admin-password> \
  zookeeper-v2.2.0.tgz
```

登录平台，切换到目标项目和命名空间，确认 ZooKeeper 包在应用商店中可见。

### 2. 部署 Chart

在应用商店中找到 ZooKeeper Chart，点击**部署**。关键参数说明：

| 参数 | 默认值 | 说明 |
| ---- | ------ | ---- |
| `zookeeper.replicaCount` | `3` | 副本数，必须为奇数（1、3、5、7）。生产环境至少 3。 |
| `persistence.size` | `5Gi` | 每个 Pod 的 PVC 容量。 |
| `persistence.storageClass` | — | StorageClass 名称，空值使用集群默认。 |
| `env.ZOO_MAX_CLIENT_CNXNS` | `60` | 单 IP 最大客户端连接数。 |
| `env.ZOO_AUTOPURGE_PURGEINTERVAL` | `0` | 快照自动清理间隔（小时）。生产建议设为 `24`。 |

### 3. 验证部署

**检查 Pod 状态**

```bash
kubectl get pods -n <namespace> -l "app=zookeeper,component=server"
```

期望：3 个 Pod 均为 `Running`，READY 列为 `2/2`。

**健康检查**

```bash
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  sh -c "echo ruok | nc 127.0.0.1 2181"
# 期望输出：imok
```

**验证集群选举**

```bash
for i in 0 1 2; do
  echo "Pod-${i}: $(kubectl exec -n <namespace> <release>-zookeeper-${i} -- \
    sh -c "echo mntr | nc 127.0.0.1 2181 | grep zk_server_state")"
done
```

期望：恰好 1 个 `leader`，2 个 `follower`。

**数据读写验证**

```bash
# 写入
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  zkCli.sh -server localhost:2181 create /test "hello"

# 读取
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  zkCli.sh -server localhost:2181 get /test

# 清理
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  zkCli.sh -server localhost:2181 delete /test
```

## 客户端连接

集群部署完成后，应用通过 ClusterIP Service 访问：

```
<release>-zookeeper.<namespace>.svc.cluster.local:2181
```

## 常见问题

### Q1. 快照目录磁盘持续增长

默认关闭自动清理（`ZOO_AUTOPURGE_PURGEINTERVAL=0`）。通过 Helm upgrade 修改：

```yaml
env:
  ZOO_AUTOPURGE_PURGEINTERVAL: 24
  ZOO_AUTOPURGE_SNAPRETAINCOUNT: 5
```

### Q2. 节点维护（drain）时 ZooKeeper 不可用

3 节点集群同时不可用节点超过 1 个会失去法定人数。Chart 已配置 PDB（`maxUnavailable=1`），`kubectl drain` 会自动等待 Pod 恢复后再驱逐下一个，无需额外操作。
