---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260600001
sourceSHA: a7cc54bebdfe6c13c880cb37f8ff3f997de9d70912a737d8a3dab89d2c4a42d5
---

# ZooKeeper 安装指南

## 概述

ZooKeeper 是一个分布式协调服务，用于维护配置信息、命名、提供分布式同步和组服务。本指南解释了如何使用 Alauda 应用目录中的 Helm Chart 在 Alauda 容器平台 (ACP) 上部署 ZooKeeper 3.8.6 集群。

## 先决条件

- 支持动态供给的 StorageClass（每个 Pod 需要一个专用 PVC）
- 从 **应用商店 > 应用入驻** 下载的 `violet` CLI，版本需与您的集群匹配

## 安装

### 1. 上传材料包

```bash
violet push \
  --platform-address <platform-address> \
  --clusters <business-cluster-name> \
  --platform-username <platform-admin-username> \
  --platform-password <platform-admin-password> \
  zookeeper-v2.2.0.tgz
```

登录平台，切换到目标项目和命名空间，并确认 ZooKeeper 包在应用商店中可见。

### 2. 部署 Chart

在应用商店中找到 ZooKeeper Chart 并点击 **部署**。关键参数：

| 参数                               | 默认值   | 描述                                                                                  |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `zookeeper.replicaCount`           | `3`      | 副本数量。必须为奇数（1, 3, 5, 7）。生产环境至少使用 3 个。                           |
| `persistence.size`                 | `5Gi`    | 每个 Pod 的 PVC 容量。                                                                |
| `persistence.storageClass`         | —        | StorageClass 名称。留空以使用集群默认值。                                            |
| `env.ZOO_MAX_CLIENT_CNXNS`         | `60`     | 每个 IP 的最大客户端连接数。                                                          |
| `env.ZOO_AUTOPURGE_PURGEINTERVAL`  | `0`      | 快照自动清除间隔（小时）。生产环境设置为 `24`。                                       |

### 3. 验证部署

**检查 Pod 状态**

```bash
kubectl get pods -n <namespace> -l "app=zookeeper,component=server"
```

预期：3 个 Pod 处于 `Running` 状态，READY 列显示 `2/2`。

**健康检查**

```bash
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  sh -c "echo ruok | nc 127.0.0.1 2181"
# 预期输出：imok
```

**验证集群选举**

```bash
for i in 0 1 2; do
  echo "Pod-${i}: $(kubectl exec -n <namespace> <release>-zookeeper-${i} -- \
    sh -c "echo mntr | nc 127.0.0.1 2181 | grep zk_server_state")"
done
```

预期：恰好 1 个 `leader` 和 2 个 `follower`。

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

集群部署完成后，应用程序通过 ClusterIP 服务连接：

```
<release>-zookeeper.<namespace>.svc.cluster.local:2181
```

## 常见问题

### Q1. 快照目录 (/data) 磁盘使用量不断增长

默认情况下，自动清除功能是禁用的 (`ZOO_AUTOPURGE_PURGEINTERVAL=0`)。通过 Helm 升级进行更新：

```yaml
env:
  ZOO_AUTOPURGE_PURGEINTERVAL: 24
  ZOO_AUTOPURGE_SNAPRETAINCOUNT: 5
```

### Q2. 节点维护（排空）期间 ZooKeeper 无法使用

在 3 节点集群中，同时失去超过 1 个 Pod 会破坏法定人数。Chart 附带一个 PodDisruptionBudget（`maxUnavailable=1`），因此 `kubectl drain` 会自动等待每个 Pod 恢复后再逐个驱逐。无需额外操作。
