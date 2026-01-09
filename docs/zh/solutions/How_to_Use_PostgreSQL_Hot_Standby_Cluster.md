---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB251000009
sourceSHA: 5eae23c900f5a89e26fec5e773b3d048e043b171bab6d6bbf975d3c26b823250
---

# PostgreSQL 热备份集群配置指南

## 背景

### 挑战

现代应用程序要求其 PostgreSQL 数据库具备高可用性和灾难恢复能力。传统的备份解决方案通常涉及显著的停机时间和数据丢失。手动复制设置复杂，难以配置和维护。

### 解决方案

本指南提供了使用 Alauda 容器平台 (ACP) 设置 PostgreSQL 热备份集群的全面说明。该解决方案支持集群内和跨集群的复制，能够实现：

- **最小数据丢失**：持续流式复制确保最小的数据丢失（通常最多几秒的数据）
- **手动故障转移**：在需要时可控地提升备用集群的高可用性
- **地理冗余**：跨集群复制以实现灾难恢复
- **操作简便**：通过 Kubernetes 自定义资源实现自动配置

## 环境信息

适用版本：>=ACP 4.1.0，PostgreSQL Operator：>=4.1.8（负载均衡器支持需要 PostgreSQL Operator >=4.2.0）

## 快速参考

### 关键概念

- **主集群**：接受读/写操作的主 PostgreSQL 集群
- **备用集群**：持续从主集群同步的副本集群
- **流式复制**：集群之间的实时 WAL（预写日志）复制
- **切换**：在维护期间计划的集群提升/降级
- **故障转移**：当主集群不可用时的紧急提升

### 常见用例

| 场景                  | 推荐方法              | 章节参考                                   |
| --------------------- | --------------------- | ------------------------------------------ |
| **高可用性**          | 集群内复制            | [集群内设置](#intra-cluster-setup)       |
| **灾难恢复**          | 跨集群复制            | [跨集群设置](#cross-cluster-setup)       |
| **计划维护**          | 切换操作步骤          | [正常操作](#normal-operations)            |
| **紧急恢复**          | 手动故障转移步骤      | [灾难恢复](#disaster-recovery)            |

## 先决条件

在实施 PostgreSQL 热备份之前，请确保您具备：

- ACP v4.1.0 或更高版本，PostgreSQL Operator v4.1.8 或更高版本
- 按照 [安装指南](https://docs.alauda.io/postgresql/4.1/installation.html) 部署 PostgreSQL 插件
- 对 PostgreSQL 操作和 Kubernetes 概念有基本了解
- 阅读 [PostgreSQL Operator 基本操作指南](https://docs.alauda.io/postgresql/4.1/functions/index.html)，了解创建实例、备份和监控等基本操作
- **存储资源**：
  - 主集群：存储容量应能容纳数据库大小加上预写日志 (WAL) 文件（通常需要额外 10-20% 的空间）
  - 备用集群：与主集群相同的存储容量以确保完整的数据复制。确保 **StorageClass 性能 (IOPS/吞吐量)** 与主集群匹配，以防故障转移后性能下降。
  - 考虑未来增长并设置适当的 `max_slot_wal_keep_size`（建议最小 10GB）
- **网络资源**：
  - 集群内：标准 Kubernetes 网络性能
  - 跨集群：低延迟连接 (<20ms) 和足够的带宽（生产工作负载至少 1 Gbps）
  - 稳定的网络连接以防止复制中断
- **计算资源**：
  - 主集群：足够的 CPU 和内存以支持数据库操作和复制过程
  - 备用集群：与主集群相似的 CPU 和内存分配，以处理读取操作和潜在的提升

### 重要限制

- 源集群和目标集群必须运行相同的 PostgreSQL 版本
- 主集群和备用集群的 `replSvcType` 必须相同
- 备用集群最初仅支持单个副本实例
- 备用集群上的多副本高可用性需要在提升后进行配置调整
- 监控和警报复制状态需要额外的设置

## 配置指南

### 集群内设置

#### 主集群配置

**使用 Web 控制台：**

请参考 [创建实例文档](https://docs.alauda.io/postgresql/4.1/functions/01_create_instance.html) 获取创建 PostgreSQL 实例的详细说明。然后，为热备份启用主集群配置：

1. 完成基本的 PostgreSQL 配置
2. 切换到 YAML 视图并启用集群复制：

```yaml
spec:
  clusterReplication:
    enabled: true
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

4. 完成实例创建并等待状态为 Running

**使用命令行：**

使用以下命令创建启用复制的主集群：

```bash
PRIMARY_CLUSTER="acid-primary"
NAMESPACE="your-namespace"

cat << EOF | kubectl -n $NAMESPACE create -f -
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: $PRIMARY_CLUSTER
spec:
  teamId: ACID
  postgresql:
    version: "16"
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 2
  clusterReplication:
    enabled: true
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
  volume:
    size: 50Gi
EOF
```

验证集群状态（预期输出：“Running”）：

```bash
$ kubectl -n $NAMESPACE get postgresql $PRIMARY_CLUSTER -ojsonpath='{.status.PostgresClusterStatus}{"\n"}'
Running
```

#### 备用集群配置

**准备工作：**

1. 获取主集群管理员凭据
2. 在备用集群命名空间中创建引导密钥，包含主集群的管理员凭据：

```yaml
kind: Secret
apiVersion: v1
metadata:
  name: standby-bootstrap-secret
  namespace: standby-namespace  # 替换为您的备用集群命名空间
type: kubernetes.io/basic-auth
stringData:
  username: postgres
  password: "<YOUR-PRIMARY-ADMIN-PASSWORD>"
```

**重要说明：**

- 用您的备用集群命名空间替换命名空间
- 用户名和密码必须与主集群的管理员凭据匹配
- 密钥名称应在备用集群配置中引用为 `bootstrapSecret`

3. 在主集群上执行检查点以确保 WAL 一致性：

```bash
kubectl exec -n <primary-namespace> <primary-pod-name> -- psql -c "CHECKPOINT;"
```

**使用 Web 控制台：**

1. 创建单副本配置的实例
2. 切换到 YAML 视图并配置复制：

> **注意**：将 `peerHost` 替换为主集群的实际服务 IP。

```yaml
spec:
  numberOfInstances: 1
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 10.96.140.172  # 主集群的读写服务 IP
    peerPort: 5432
    replSvcType: ClusterIP
    bootstrapSecret: standby-bootstrap-secret
```

**使用命令行：**

```bash
STANDBY_CLUSTER="acid-standby"
NAMESPACE="standby-namespace"

cat << EOF | kubectl -n $NAMESPACE create -f -
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: $STANDBY_CLUSTER
spec:
  teamId: ACID
  postgresql:
    version: "16"
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 10.96.140.172
    peerPort: 5432
    replSvcType: ClusterIP
    bootstrapSecret: standby-bootstrap-secret
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
  volume:
    size: 50Gi
EOF
```

验证备用状态：

```bash
$ kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
+ Cluster: acid-standby (7562204126329651274) -------+-----------+----+-----------+
| Member         | Host             | Role           | State     | TL | Lag in MB |
+----------------+------------------+----------------+-----------+----+-----------+
| acid-standby-0 | fd00:10:16::29b8 | Standby Leader | streaming |  1 |           |
+----------------+------------------+----------------+-----------+----+-----------+
```

### 跨集群设置

#### 主集群配置

**选项 1：使用 NodePort**

配置主集群为 NodePort 服务类型以便跨集群访问：

```yaml
spec:
  clusterReplication:
    enabled: true
    replSvcType: NodePort
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

**选项 2：使用 LoadBalancer（需要 Operator v4.2.0+）**

配置主集群为 LoadBalancer 服务类型：

```yaml
spec:
  clusterReplication:
    enabled: true
    replSvcType: LoadBalancer
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

#### 备用集群配置

**准备工作：**

1. 获取主集群管理员凭据
2. 在备用集群命名空间中创建引导密钥，包含主集群的管理员凭据：

```yaml
kind: Secret
apiVersion: v1
metadata:
  name: standby-bootstrap-secret
  namespace: standby-namespace  # 替换为您的备用集群命名空间
type: kubernetes.io/basic-auth
stringData:
  username: postgres
  password: "<YOUR-PRIMARY-ADMIN-PASSWORD>"
```

3. 在主集群上执行检查点以确保 WAL 一致性：

```bash
kubectl exec -n <primary-namespace> <primary-pod-name> -- psql -c "CHECKPOINT;"
```

**选项 1：通过 NodePort 连接**

配置备用集群通过 NodePort 连接：

> **注意**：将 `peerHost` 替换为主集群的实际节点 IP，`peerPort` 替换为 NodePort。

```yaml
spec:
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 192.168.130.206  # 主集群节点 IP
    peerPort: 31661            # 主集群 NodePort
    replSvcType: NodePort
    bootstrapSecret: standby-bootstrap-secret
```

**选项 2：通过 LoadBalancer 连接（需要 Operator v4.2.0+）**

在创建主集群服务后获取外部 IP，然后配置备用集群：

```yaml
spec:
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 203.0.113.10     # 主集群 LoadBalancer 外部 IP
    peerPort: 5432             # 标准 PostgreSQL 端口（或特定的 LB 端口）
    replSvcType: LoadBalancer
    bootstrapSecret: standby-bootstrap-secret
```

**验证步骤：**

在备用集群成功运行后，验证其外部 IP 是否正确记录在主集群的 `sys_operator.multi_cluster_info` 表中。

1. 检查主集群中的表内容：
   ```bash
   kubectl exec <primary-pod> -- psql -x -c "SELECT * FROM sys_operator.multi_cluster_info;"
   ```

2. 如果备用集群记录的 `external_ip` 字段为空，请手动使用备用集群的 LoadBalancer IP 更新它。

   首先，获取备用集群的 LoadBalancer IP：

   ```bash
   kubectl get svc -n <standby-namespace> <standby-cluster-name>
   ```

   注意输出中的 `EXTERNAL-IP`。

   然后，执行更新：

   ```bash
   kubectl exec <primary-pod> -- psql -c "UPDATE sys_operator.multi_cluster_info SET external_ip='<STANDBY-LB-IP>' WHERE cluster_name='<standby-cluster-name>';"
   ```

## 正常操作

### 切换操作步骤

为避免脑裂场景，执行计划切换时分为两个阶段：

> **重要**：对于跨集群设置，请确保在执行命令之前将您的 `kubectl` 上下文切换到适当的集群。

#### 阶段 1：将主集群降级为备用

```bash
kubectl -n $NAMESPACE patch pg $PRIMARY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":true},"numberOfInstances":1}}'
```

验证降级：

```bash
$ kubectl -n $NAMESPACE exec $PRIMARY_CLUSTER-0 -- patronictl list
+ Cluster: acid-primary (7562204126329651274) -------+---------+----+-----------+
| Member         | Host             | Role           | State   | TL | Lag in MB |
+----------------+------------------+----------------+---------+----+-----------+
| acid-primary-0 | fd00:10:16::29b3 | Standby Leader | running |  1 |           |
+----------------+------------------+----------------+---------+----+-----------+
```

#### 阶段 2：将备用提升为主

```bash
kubectl -n $NAMESPACE patch pg $STANDBY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":false},"numberOfInstances":2}}'
```

验证提升：

```bash
$ kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
+ Cluster: acid-standby (7562204126329651274) -----+-----------+----+-----------+
| Member         | Host             | Role         | State     | TL | Lag in MB |
+----------------+------------------+--------------+-----------+----+-----------+
| acid-standby-0 | fd00:10:16::29b8 | Leader       | running   |  2 |           |
| acid-standby-1 | fd00:10:16::2a2e | Sync Standby | streaming |  2 |         0 |
+----------------+------------------+--------------+-----------+----+-----------+
```

### 监控复制状态

检查主集群的复制状态：

```bash
$ kubectl exec $(kubectl -n $NAMESPACE get pod -l spilo-role=master,cluster-name=$PRIMARY_CLUSTER | tail -n+2 | awk '{print $1}') -- curl -s localhost:8008 | jq
{
  "state": "running",
  "postmaster_start_time": "2025-10-18 02:52:03.144373+00:00",
  "role": "standby_leader",
  "server_version": 160010,
  "xlog": {
    "received_location": 503637736,
    "replayed_location": 503637736,
    "replayed_timestamp": "2025-10-18 02:55:37.197686+00:00",
    "paused": false
  },
  "timeline": 2,
  "replication_state": "streaming",
  "dcs_last_seen": 1760756364,
  "database_system_identifier": "7562204126329651274",
  "patroni": {
    "version": "3.2.2",
    "scope": "acid-primary",
    "name": "acid-primary-0"
  }
}

$ kubectl exec $(kubectl -n $NAMESPACE get pod -l spilo-role=master,cluster-name=$STANDBY_CLUSTER | tail -n+2 | awk '{print $1}') -- curl -s localhost:8008 | jq
{
  "state": "running",
  "postmaster_start_time": "2025-10-17 14:57:25.629615+00:00",
  "role": "master",
  "server_version": 160010,
  "xlog": {
    "location": 503640096
  },
  "timeline": 2,
  "replication": [
    {
      "usename": "standby",
      "application_name": "acid-primary-0",
      "client_addr": "fd00:10:16::29b3",
      "state": "streaming",
      "sync_state": "async",
      "sync_priority": 0
    },
    {
      "usename": "standby",
      "application_name": "acid-standby-1",
      "client_addr": "fd00:10:16::2a2e",
      "state": "streaming",
      "sync_state": "sync",
      "sync_priority": 1
    }
  ],
  "dcs_last_seen": 1760756544,
  "database_system_identifier": "7562204126329651274",
  "patroni": {
    "version": "3.2.2",
    "scope": "acid-standby",
    "name": "acid-standby-0"
  }
}
```

## 灾难恢复

### 主集群故障

当主集群故障且无法及时恢复时：

1. **需要手动干预**：使用手动故障转移步骤提升备用集群
2. 更新应用程序连接以指向新的主集群
3. 当原主集群恢复时，将其重新配置为备用
4. **注意**：根据故障时的复制延迟，可能会发生一些数据丢失

### 备用集群故障

备用集群故障不会影响主集群的操作。恢复是自动的：

1. 修复导致备用故障的根本问题
2. 备用将自动重新连接并重新同步
3. 监控复制状态以确保赶上完成

## 故障排除

### 常见问题

#### 复制槽错误

##### 症状

- 备用节点日志中出现“更改复制槽时异常”错误
- 特定错误回溯显示 TypeError，'>' 不支持 'int' 和 'NoneType' 之间的比较
- 示例错误日志：

```text
2025-10-10T09:06:19.452Z ERROR: Exception when changing replication slots
Traceback (most recent call last):
  ...
  File "/usr/local/lib/python3.10/dist-packages/patroni/postgresql/slots.py", line 383, in _ensure_physical_slots
    if lsn and lsn > value['restart_lsn']:  # The slot has feedback in DCS and needs to be advanced
TypeError: '>' not supported between instances of 'int' and 'NoneType'
```

- 尽管出现这些错误，集群操作和复制可能仍然正常运行

##### 原因

当前 Patroni 版本中的已知错误，将在未来版本中修复

##### 解决方案

手动删除有问题的复制槽：

```sql
SELECT pg_catalog.pg_drop_replication_slot('xdc_hotstandby');
```

#### 备用加入失败

##### 症状

备用集群未能加入复制，数据同步问题

##### 原因

集群之间的数据漂移过大，导致无法基于 WAL 恢复

##### 解决方案

1. 删除失败的备用集群
2. 从主集群中删除集群元数据：

```sql
DELETE FROM sys_operator.multi_cluster_info WHERE cluster_name='<failed-cluster-name>';
```

3. 按照初始设置程序重新创建备用集群

#### 数据同步问题

##### 症状

复制延迟增加，备用落后

##### 解决方案

- 验证集群之间的网络连接
- 检查两个集群的存储性能
- 监控 `max_slot_wal_keep_size` 设置以确保足够的 WAL 保留
- 如果资源不足，考虑增加资源
- **重要**：定期监控对于最小化故障转移期间潜在的数据丢失至关重要

### 诊断命令

检查复制状态：

```bash
# 在备用集群上
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list

# 在主集群上  
kubectl -n $NAMESPACE exec $PRIMARY_CLUSTER-0 -- patronictl list
```

验证流式复制：

```bash
kubectl exec -it <primary-pod> -- psql -c "SELECT * FROM pg_stat_replication;"
```

检查 WAL 设置：

```bash
kubectl exec -it <primary-pod> -- psql -c "SHOW max_slot_wal_keep_size;"
```

## 最佳实践

### 配置建议

- 适当设置 `max_slot_wal_keep_size`（生产环境建议至少 10GB）
- 为数据库工作负载使用专用存储类，确保足够的 IOPS
- 实施复制延迟和集群健康监控
- 在非生产环境中定期测试故障转移程序

### 操作指南

- 在维护窗口期间与应用程序协调执行切换
- 监控主集群和备用集群的磁盘空间
- 保持集群之间 PostgreSQL 版本同步
- 除了复制外，保持最近的备份

## 参考

### 自定义资源参数

**主集群配置：**

- `clusterReplication.enabled`：启用复制（true/false）
- `clusterReplication.replSvcType`：服务类型（ClusterIP/NodePort/LoadBalancer）
- `postgresql.parameters.max_slot_wal_keep_size`：WAL 保留大小

**备用集群配置：**

- `clusterReplication.isReplica`：标记为备用（true）
- `clusterReplication.peerHost`：主集群端点
- `clusterReplication.peerPort`：主集群端口
- `clusterReplication.bootstrapSecret`：身份验证密钥

### 有用链接

- [PostgreSQL Operator 文档](https://docs.alauda.io/postgresql/4.1/functions/index.html)
- [PostgreSQL Operator 安装指南](https://docs.alauda.io/postgresql/4.1/installation.html)

## 总结

本指南提供了在 Alauda 容器平台上实施 PostgreSQL 热备份集群的全面说明。该解决方案通过流式复制和手动故障转移管理提供企业级的高可用性和灾难恢复能力。

实现的关键好处：

- **最小数据丢失**：持续的 WAL 复制最小化潜在的数据丢失（通常为几秒）
- **可控故障转移**：手动提升确保适当的验证并降低风险
- **灵活部署**：支持集群内和跨集群场景
- **生产就绪**：经过实战检验的企业工作负载配置模式

通过遵循这些实践，组织可以确保其 PostgreSQL 数据库满足严格的可用性和恢复目标，同时保持对关键故障转移操作的控制。
