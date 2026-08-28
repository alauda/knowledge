---
kind:
   - Solution
products: 
  - Alauda Application Services
ProductsVersion:
   - 4.x
id: KB251000009
sourceSHA: 437b0ae4bd0b6c1f91f85b06fc6f30c9d3c8d0389642f2c332a3dec4a8364949
---

# PostgreSQL 热备集群配置指南

## 背景

### 挑战

现代应用要求其 PostgreSQL 数据库具备高可用与灾难恢复能力。传统备份方案往往伴随明显的停机时间和数据丢失。手工搭建的复制方案在配置和维护上都很复杂。

### 解决方案

本指南提供了使用 Alauda Container Platform (ACP) 搭建 PostgreSQL 热备集群的完整说明。该方案同时支持集群内与跨集群复制，能够实现：

- **最小化数据丢失**：持续的流式复制确保数据丢失最小（通常最多只有数秒的数据）
- **手动故障切换**：在需要时以可控方式提升备集群，实现高可用
- **地理冗余**：通过跨集群复制实现灾难恢复
- **运维简单**：通过 Kubernetes 自定义资源实现自动化配置

## 环境信息

适用版本：>=ACP 4.1.0，PostgreSQL Operator：>=4.1.8（LoadBalancer 支持需要 PostgreSQL Operator >=4.2.0）

## 快速参考

### 关键概念
- **主集群（Primary Cluster）**：接受读/写操作的主 PostgreSQL 集群
- **备集群（Standby Cluster）**：持续从主集群同步数据的副本集群
- **流式复制（Streaming Replication）**：集群之间实时的 WAL（Write-Ahead Log，预写日志）复制
- **主备切换（Switchover）**：维护期间对集群进行有计划的提升/降级
- **故障切换（Failover）**：主集群不可用时的紧急提升

### 常见使用场景

| 场景 | 推荐方案 | 章节参考 |
|----------|---------------------|------------------|
| **高可用** | 集群内复制 | [集群内配置](#intra-cluster-setup) |
| **灾难恢复** | 跨集群复制 | [跨集群配置](#cross-cluster-setup) |
| **计划内维护** | 主备切换流程 | [常规操作](#normal-operations) |
| **紧急恢复** | 手动故障切换流程 | [灾难恢复](#disaster-recovery) |

## 前提条件

在实施 PostgreSQL 热备之前，请确保具备：

- ACP v4.1.0 或更高版本，以及 PostgreSQL Operator v4.1.8 或更高版本
- 已按照[安装指南](https://docs.alauda.io/postgresql/4.1/installation.html)部署 PostgreSQL 插件
- 对 PostgreSQL 运维和 Kubernetes 概念有基本了解
- 已阅读 [PostgreSQL Operator 基础操作指南](https://docs.alauda.io/postgresql/4.1/functions/index.html)，了解创建实例、备份、监控等基本操作
- **存储资源**：
  - 主集群：存储容量应能容纳数据库大小加上预写日志（WAL）文件（通常需额外 10-20% 的空间）
  - 备集群：与主集群相同的存储容量，以确保数据完整复制。确保 **StorageClass 性能（IOPS/吞吐量）**与主集群一致，防止故障切换后出现性能下降。
  - 考虑未来增长，并设置合适的 `max_slot_wal_keep_size`（建议至少 10GB）
- **网络资源**：
  - 集群内：标准 Kubernetes 网络性能即可
  - 跨集群：低延迟连接（<20ms）且带宽充足（生产负载至少 1 Gbps）
  - 稳定的网络连通性，防止复制中断
- **计算资源**：
  - 主集群：为数据库操作和复制进程提供充足的 CPU 和内存
  - 备集群：与主集群相近的 CPU 和内存分配，以承担读操作及可能的提升

### 重要限制

- 源集群和目标集群必须运行相同的 PostgreSQL 版本
- 主集群和备集群的 `replSvcType` 必须相同
- 备集群初始仅支持单副本实例
- 备集群提升后如需多副本高可用，需要调整配置
- 复制状态的监控和告警需要额外配置

## 配置指南

### 集群内配置

#### 主集群配置

**使用 Web 控制台：**

创建 PostgreSQL 实例的详细说明请参考[创建实例文档](https://docs.alauda.io/postgresql/4.1/functions/01_create_instance.html)。然后，为热备启用主集群配置：

1. 完成 PostgreSQL 基础配置
2. 切换到 YAML 视图并启用集群复制：

```yaml
spec:
  clusterReplication:
    enabled: true
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

4. 完成实例创建并等待状态变为 Running

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

验证集群状态（预期输出："Running"）：

```bash
$ kubectl -n $NAMESPACE get postgresql $PRIMARY_CLUSTER -ojsonpath='{.status.PostgresClusterStatus}{"\n"}'
Running
```

#### 备集群配置

**准备工作：**
1. 获取主集群管理员凭据
2. 在备集群 namespace 中创建包含主集群管理员凭据的 bootstrap secret：

```yaml
kind: Secret
apiVersion: v1
metadata:
  name: standby-bootstrap-secret
  namespace: standby-namespace  # Replace with your standby cluster namespace
type: kubernetes.io/basic-auth
stringData:
  username: postgres
  password: "<YOUR-PRIMARY-ADMIN-PASSWORD>"
```

**重要说明：**
- 将 namespace 替换为你的备集群所在的 namespace
- 用户名和密码必须与主集群的管理员凭据一致
- 该 secret 的名称应在备集群配置中通过 `bootstrapSecret` 引用

3. 在主集群上执行 checkpoint 以确保 WAL 一致性：
```bash
kubectl exec -n <primary-namespace> <primary-pod-name> -- psql -c "CHECKPOINT;"
```

**使用 Web 控制台：**

1. 以单副本配置创建实例
2. 切换到 YAML 视图并配置复制：

> **注意**：将 `peerHost` 替换为你的主集群的实际 Service IP。

```yaml
spec:
  numberOfInstances: 1
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 10.96.140.172  # Primary cluster read-write service IP
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

验证备集群状态：
```bash
$ kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
+ Cluster: acid-standby (7562204126329651274) -------+-----------+----+-----------+
| Member         | Host             | Role           | State     | TL | Lag in MB |
+----------------+------------------+----------------+-----------+----+-----------+
| acid-standby-0 | fd00:10:16::29b8 | Standby Leader | streaming |  1 |           |
+----------------+------------------+----------------+-----------+----+-----------+
```

### 跨集群配置

#### 有防火墙环境下的端口规划

当两个 Kubernetes 集群之间的流量需要经过防火墙时，应在创建集群**之前**确定要放行哪些端口。默认情况下 operator 让 Kubernetes 自动分配 NodePort，且 Service 每次被重建都会重新分配一个新端口——这种分配既无法提前提交防火墙变更申请，也无法在[故障排查](#troubleshooting)中描述的集群重建步骤之后保持不变。

**防火墙必须放行哪些端口**

| 方向 | 目标节点 | 需要放行的端口 |
| --- | --- | --- |
| 备集群 → 主集群 | 每个运行主集群 PostgreSQL pod 的节点 | 主集群 **master** Service 的 NodePort |
| 主集群 → 备集群 | 每个运行备集群 PostgreSQL pod 的节点 | 备集群 **master** Service 的 NodePort |

有两点很容易弄错：

- **要在每个可能运行 PostgreSQL pod 的节点上放行端口，而不仅仅是写进 `peerHost` 的那个地址。** operator 会记录每个成员 pod 所在的主机 IP，并根据该列表构建跨集群 endpoints，因此连接可能建立到其中任意一个节点。如果 pod 可能被重新调度到其他节点，也要把那些节点包含进来。
- **两个方向都必须放行。** 复制正常运行时只有备集群主动连接主集群，但主备切换期间方向会反转：被降级的集群变成发起连接的一方。只允许备集群 → 主集群的规则集在第一次主备切换之前都能工作，之后就会失效。

**确定需要固定的 Service**

一个集群有多个 Service，且没有一个名为 `master`。对于名为 `<cluster-name>` 的集群：

| Service 名称 | 角色 | `serviceTemplates` 键 | 是否纳入防火墙规则 |
| --- | --- | --- | --- |
| `<cluster-name>` | master | `master` | **是**——这就是需要放行的 NodePort |
| `<cluster-name>-repl` | replica | `replica` | 否 |
| `<cluster-name>-xcr` | 跨集群别名 | 不可配置 | 否 |
| `<cluster-name>-exporter` | 指标 | 不可配置 | 否 |

:::warning `-repl` 是 replica Service，不是 replication Service
`-repl` 后缀代表的是 **replica**（从节点）：它是对 replica pod 做负载均衡的只读客户端接入点，与跨集群复制毫无关系。它与 "replication" 的相似性使其成为申请防火墙规则时最常见的错误答案。
:::

:::info `-xcr` Service 的 NodePort 不需要放行
`<cluster-name>-xcr` Service 也会获得自己自动分配的 NodePort，但它是**对端**集群的本地别名：它的目标端口是对端的 master NodePort。流量只从它发出，不会有流量到达它，也不会有任何外部客户端连接它。它还是由 operator 直接构建而非来自 `serviceTemplates`，因此它的端口无法固定——也不需要固定。
:::

要查询必须放行的端口——Web 控制台显示的是集群 IP 而非节点端口，因此直接查询：

```bash
kubectl get svc -n <namespace> <cluster-name> -o jsonpath='{.spec.ports[0].nodePort}'
```


**将 NodePort 固定为指定值**

`clusterReplication` 没有用于指定端口号的字段。请通过 `spec.serviceTemplates.master` 固定 master Service 的 NodePort，该模板会被合并进生成的 Service：

```yaml
spec:
  clusterReplication:
    enabled: true
    replSvcType: NodePort
  serviceTemplates:
    master:
      spec:
        type: NodePort
        ports:
          - name: postgresql
            port: 5432
            targetPort: 5432
            nodePort: 31234        # must be within the cluster's node port range
```

对两个集群套用同样的模式；如果它们共用一套防火墙策略，则为每个集群选择不同的端口号。此后备集群的 `peerPort` 就是你在主集群上固定的那个端口号，Service 被重建时它也不会再变化。

:::warning 端口条目要完整写出
模板中的 `ports` 列表会**整体替换**生成的列表，而不是逐字段合并，因此不完整的条目不会继承其所替换条目的默认值。

schema 能拦住最糟的情况：`port` 是必填项，省略它的条目会被直接拒绝，报 `spec.serviceTemplates.master.spec.ports[0].port: Required value`。`targetPort` 是可选的，Kubernetes 会将其默认为 `port` 的值。像上面展示的那样把条目完整写出，可以让结果不依赖这两种行为，并让意图清晰可读。
:::

:::warning 确认你集群中的 CRD 接受 `serviceTemplates`
该字段存在于 operator bundle 附带的 CRD schema 中，但并非每一份打包分发的 CRD 副本都包含它。如果 operator 在 `enable_crd_registration: true` 下运行，它可能会用一份缺少该字段的 schema 替换已安装的 CRD。

具体表现取决于客户端。`kubectl apply` 默认请求严格的字段校验，会立刻报错：

```
error: ... strict decoding error: unknown field "spec.serviceTemplates"
```

不请求严格校验的客户端——`kubectl apply --validate=ignore`、较旧的客户端、以及部分控制器和 GitOps 工具——会被告知对象已成功创建，而 API server 丢弃了该字段。NodePort 于是仍保持自动分配，日志中没有任何信息解释原因。请直接确认 schema，而不是依赖 apply 成功：

```bash
kubectl get crd postgresqls.acid.zalan.do -o json \
  | jq '.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.serviceTemplates != null'
```

该命令必须输出 `true`。如果输出的是 `false`，请使用下文的 LoadBalancer 方案，或者放行自动分配的端口，并在任何会重建 Service 的变更之后重新检查这些端口。
:::

**在配对集群之前确定端口**

在集群配对之前选定端口号，之后将其视为固定不变。

:::warning 修改已配对集群的节点端口会中断复制且无法自愈
对端是通过 `sys_operator.multi_cluster_info` 元数据表得知端口的，而该表本身要经由复制流才能到达备集群。修改主集群的节点端口会切断复制流，更新后的行因此永远无法到达：主集群记录了新端口，而备集群会无限期保留旧端口，把它的 `-xcr` endpoints 指向一个已不存在的端口。双方无法自行重新同步，因为唯一能传递这份修正的通道正是被这次修改切断的那条。

恢复方法是恢复之前的节点端口，此时备集群会重连并追平；或者重建备集群。请提前规划好端口号，而不是在正在运行的配对集群上调整。
:::

**替代方案：使用 LoadBalancer**

使用 `replSvcType: LoadBalancer`（operator v4.2.0 或更高版本）时，对端连接的是负载均衡器地址的 5432 端口，不涉及任何 NodePort，防火墙规则通常因此更简单也更稳定。这要求两个集群都具备负载均衡器实现。

:::info 在重新规划端口之前先确认故障确实出在防火墙
从 PostgreSQL pod 内部看，防火墙丢包和集群自身 overlay 网络的故障表现完全相同：连接超时。请从备集群一侧的**节点 shell** 上测试，而不是从 pod 里：

```bash
nc -vz <primary-node-ip> <primary-master-nodeport>
```

`Connection refused` 说明路径是通的，只是该端口上没有服务在监听——端口号或 Service 写错了。超时则与防火墙丢包相符。如果节点级测试成功而 pod 级测试超时，问题出在集群网络内部，修改端口号解决不了。
:::

#### 主集群配置

**方式 1：使用 NodePort**

为跨集群访问配置使用 NodePort service 类型的主集群：

```yaml
spec:
  clusterReplication:
    enabled: true
    replSvcType: NodePort
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

**方式 2：使用 LoadBalancer（需要 Operator v4.2.0+）**

配置使用 LoadBalancer service 类型的主集群：

```yaml
spec:
  clusterReplication:
    enabled: true
    replSvcType: LoadBalancer
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

#### 备集群配置

**准备工作：**

1. 获取主集群管理员凭据
2. 在备集群 namespace 中创建包含主集群管理员凭据的 bootstrap secret：

```yaml
kind: Secret
apiVersion: v1
metadata:
  name: standby-bootstrap-secret
  namespace: standby-namespace  # Replace with your standby cluster namespace
type: kubernetes.io/basic-auth
stringData:
  username: postgres
  password: "<YOUR-PRIMARY-ADMIN-PASSWORD>"
```

3. 在主集群上执行 checkpoint 以确保 WAL 一致性：
```bash
kubectl exec -n <primary-namespace> <primary-pod-name> -- psql -c "CHECKPOINT;"
```

**方式 1：通过 NodePort 连接**

配置备集群通过 NodePort 连接：

> **注意**：将 `peerHost` 替换为主集群的实际节点 IP，并将 `peerPort` 替换为 NodePort。

```yaml
spec:
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 192.168.130.206  # Primary cluster node IP
    peerPort: 31661            # Primary cluster NodePort
    replSvcType: NodePort
    bootstrapSecret: standby-bootstrap-secret
```

**方式 2：通过 LoadBalancer 连接（需要 Operator v4.2.0+）**

创建完成后，从主集群的 service 获取 External IP，然后配置备集群：

```yaml
spec:
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 203.0.113.10     # Primary cluster LoadBalancer External IP
    peerPort: 5432             # Standard PostgreSQL port (or the specific LB port)
    replSvcType: LoadBalancer
    bootstrapSecret: standby-bootstrap-secret
```

**验证步骤：**

备集群成功运行后，验证其 External IP 已正确记录在主集群的 `sys_operator.multi_cluster_info` 表中。

1. 在主集群上查看该表内容：
   ```bash
   kubectl exec <primary-pod> -- psql -x -c "SELECT * FROM sys_operator.multi_cluster_info;"
   ```

2. 如果备集群那条记录的 `external_ip` 字段为空，请手动将其更新为备集群的 LoadBalancer IP。

   首先，获取备集群的 LoadBalancer IP：
   ```bash
   kubectl get svc -n <standby-namespace> <standby-cluster-name>
   ```
   记下输出中的 `EXTERNAL-IP`。

   然后，执行更新：
   ```bash
   kubectl exec <primary-pod> -- psql -c "UPDATE sys_operator.multi_cluster_info SET external_ip='<STANDBY-LB-IP>' WHERE cluster_name='<standby-cluster-name>';"
   ```

## 常规操作

### 主备切换流程

为避免脑裂场景，请分三个阶段执行计划内主备切换。**阶段 3 不是可选项**——提升新主集群并不会改变应用把数据库连接发往哪里。

> **重要**：对于跨集群部署，请确保在执行命令之前将 `kubectl` context 切换到相应的集群。

:::info 切换之前先确认复制元数据是干净的
阶段 1 会将当前主集群**原地**降级。被降级的集群从 `sys_operator.multi_cluster_info` 表中
获取新对端的连接信息，因此主备切换的可靠性
完全取决于该表的内容。

如果任一集群曾被删除并重建，请先确认每个集群恰好只有一行记录
再继续——参见
[陈旧的复制元数据](#stale-replication-metadata-after-recreating-a-cluster)。

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role, node_port, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```
:::

#### 阶段 1：将主集群降级为备集群

```bash
kubectl -n $NAMESPACE patch pg $PRIMARY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":true},"numberOfInstances":1}}'
```

验证降级结果：
```bash
$ kubectl -n $NAMESPACE exec $PRIMARY_CLUSTER-0 -- patronictl list
+ Cluster: acid-primary (7562204126329651274) -------+---------+----+-----------+
| Member         | Host             | Role           | State   | TL | Lag in MB |
+----------------+------------------+----------------+---------+----+-----------+
| acid-primary-0 | fd00:10:16::29b3 | Standby Leader | running |  1 |           |
+----------------+------------------+----------------+---------+----+-----------+
```

#### 阶段 2：将备集群提升为主集群

```bash
kubectl -n $NAMESPACE patch pg $STANDBY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":false},"numberOfInstances":2}}'
```

验证提升结果：
```bash
$ kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
+ Cluster: acid-standby (7562204126329651274) -----+-----------+----+-----------+
| Member         | Host             | Role         | State     | TL | Lag in MB |
+----------------+------------------+--------------+-----------+----+-----------+
| acid-standby-0 | fd00:10:16::29b8 | Leader       | running   |  2 |           |
| acid-standby-1 | fd00:10:16::2a2e | Sync Standby | streaming |  2 |         0 |
+----------------+------------------+--------------+-----------+----+-----------+
```

#### 阶段 3：将应用重新指向新主集群

⚠ **主备切换不会替你完成这一步。** 完成阶段 1 和阶段 2 之后，原来的主集群成为
**只读备集群**，而应用的数据库连接仍然指向它。写入会持续
失败：

```
ERROR: cannot execute UPDATE in a read-only transaction
ERROR: cannot execute INSERT in a read-only transaction
```

复制健康并不代表服务已恢复——**必须显式地将应用连接
重新指向新主集群。**

**1. 确认新主集群可写**

```bash
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- psql -Atc "select pg_is_in_recovery()"
# expected: f
```

**2. 获取新主集群的连接地址**

```bash
# Intra-cluster: use the master service directly
echo "$STANDBY_CLUSTER.$NAMESPACE.svc.cluster.local:5432"

# Cross-cluster: the application reaches it via NodePort / LoadBalancer
kubectl -n $NAMESPACE get svc $STANDBY_CLUSTER -o wide
```

> 在跨集群部署中，这与配置备集群时使用的 `peerHost` / `peerPort` 属于同一类路径——
> 请同样确认防火墙允许它。

**3. 确认凭据**

数据库凭据保存在一个以**集群名命名**的 Secret 中，因此 Secret 名称会随
集群而变化：

```bash
kubectl -n $NAMESPACE get secret \
  <username>.$STANDBY_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

**4. 更新应用配置并重启**

按照应用的配置方式（ConfigMap / Secret / 环境变量 / 连接串）更新数据库地址，
然后重启其 pod 使新连接生效。

**5. 验证**

```bash
# Connections from the application should appear on the new primary
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- \
  psql -x -c "select client_addr, usename, state, query_start from pg_stat_activity
                where backend_type = 'client backend'"
```

确认在应用和数据库
的日志中都不再出现 `read-only transaction` 错误。

> **建议**：在应用支持的情况下，通过一个与集群名解耦的间接层进行连接
> （稳定的 Service 别名、外部 DNS 名称，或连接池），
> 这样将来的主备切换只需要重新指向该间接层，
> 而无需修改应用配置。

### 监控复制状态

在主集群上检查复制状态：

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

当主集群发生故障且无法及时恢复时：

1. **需要人工介入**：使用手动故障切换流程提升备集群
2. 更新应用连接，使其指向新主集群（参见*常规操作 → 阶段 3*）
3. 原主集群恢复后，将其重新配置为备集群
4. **注意**：视故障发生时的复制堆积量，可能会有部分数据丢失

### 备集群故障

备集群故障不会影响主集群的运行。恢复是自动完成的：

1. 修复导致备集群故障的根本问题
2. 备集群会自动重连并重新同步
3. 监控复制状态，确保追平完成

## 故障排查

### 常见问题

#### 复制槽错误

##### 症状

- 备节点日志中出现 "Exception when changing replication slots" 错误
- 具体错误堆栈显示 TypeError，提示 '>' not supported between 'int' and 'NoneType'
- 错误日志示例：
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

当前 Patroni 版本中的已知 bug，将在后续版本中修复

##### 解决方案

手动删除有问题的复制槽：

```sql
SELECT pg_catalog.pg_drop_replication_slot('xdc_hotstandby');
```

#### 备集群加入失败

##### 症状

备集群无法加入复制，出现数据同步问题

##### 原因

两种不同的情况会产生相同的症状，而它们的补救方法不同。请先判断
自己属于哪一种再行动。

- **备集群落后，且它需要的 WAL 已被回收。** 备集群日志反复出现
  `requested WAL segment ... has already been removed`。数据完好且一致；备集群
  只是拿不到追平所需的 WAL。
- **备集群已经分叉。** 备集群日志报
  `requested starting point ... is not in this server's history`，或者两个集群报告的
  `system identifier` 值不同。流式复制无法调和这种情况。

##### 诊断

```bash
# 1. Same lineage? The two values must match. Different values mean these are unrelated databases.
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- \
  pg_controldata /home/postgres/pgdata/pgroot/data | grep -i "system identifier"

# 2. What is the standby actually reporting? Read the error, not just the symptom.
kubectl -n <ns> exec <standby-pod> -c postgres -- \
  tail -200 /home/postgres/pgdata/pgroot/pg_log/postgresql-*.csv | grep -iE "removed|history"

# 3. Does the primary still hold the WAL the standby needs, and is anything retaining it?
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -x \
  -c "select substr(name,1,8) as timeline, count(*) as segments,
             min(name) as oldest, max(name) as newest
        from pg_ls_waldir() where name ~ '^[0-9A-F]{24}$' group by 1 order by 1;" \
  -c "select slot_name, active, restart_lsn, wal_status,
             pg_size_pretty(safe_wal_size) as safe
        from pg_replication_slots;"
```

请使用主集群的**当前 leader**，它不一定是 pod `-0`。请用
`patronictl list` 来确定。

##### 解决方案

:::warning 重建会使你失去用其他任何方式恢复的能力
下面的操作会删除备集群。删除会移除 `spec.clusterReplication`，于是
operator 会在主集群上删掉 `xdc_hotstandby` 复制槽，**为该对端保留的所有 WAL
会被立即释放**。备集群仍然需要的任何 WAL，在主集群下一次 checkpoint 时即可
被回收。

如果备集群只是落后而非分叉，执行此操作会把一个可恢复的
局面变成需要完整基础备份的局面，并且销毁了用于判定
复制为何停止的证据。

**删除任何东西之前：**

1. 先完成上面的诊断步骤并记录输出。
2. 如果缺失的 WAL 仍然存在——在主集群的 `pg_wal` 中、在 WAL 归档中、或在主集群的另一个
   成员上——可以改为把这些段提供给备集群来修复它。将完整的段
   复制到备集群的 `pg_wal` 目录中（属主为
   `postgres`，权限 `600`）并重启它。用校验和把每个复制的文件与源文件核对：
   卡住的备集群往往已经持有它正在失败的那个段的**不完整**副本，
   而这个不完整的文件也是完整的 16 MiB 大小，因此文件大小并不能说明完整性。
3. 对主集群的卷做一次存储级快照。
:::

1. 删除故障的备集群
2. 从主集群中移除该集群的元数据：
```sql
DELETE FROM sys_operator.multi_cluster_info WHERE cluster_name='<failed-cluster-name>';
```

   **步骤 2 必须在步骤 3 之前完成，且不可跳过。** 每个集群的行以
   从该集群 Kubernetes UID 推导出的 ID 为键，因此重建后的集群会以
   *新的* ID 注册。如果旧行仍然存在，表中最终会为同一个集群保留
   两行记录——一行是当前的，一行是过期的。参见
   [陈旧的复制元数据](#stale-replication-metadata-after-recreating-a-cluster)。

3. 按照初始配置流程重建备集群
4. 验证每个集群恰好只有一行记录：

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role, node_port, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```

5. 备集群运行起来之后，确认复制确实处于被保留的状态——而不仅仅是
   连接上了。复制槽必须存在、处于 active 状态并跟踪该备集群：

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -x -c \
  "select slot_name, active, restart_lsn, wal_status from pg_replication_slots
    where slot_name = 'xdc_hotstandby';"
```

空的 `restart_lsn` 意味着该槽没有保留任何内容，无论
`max_slot_wal_keep_size` 如何设置 WAL 都会被回收。没有对应行则意味着槽不存在，该对端完全没有任何保留。

#### 集群重建后的陈旧复制元数据

##### 症状

主备切换之后或集群重建之后，复制没有恢复，尽管两个
集群都在运行且它们之间的网络路径是通的。被降级或被重建的集群
可能在用一个已不再使用的端口或地址访问对端。

##### 原因

跨集群复制把每个参与集群的连接信息保存在主集群上的
`sys_operator.multi_cluster_info` 表中。每一行的 ID 从集群的
Kubernetes UID 推导而来，因此**重建后的集群会以新 ID 注册，而不是更新已有的
行**。如果之前的行没有先被删除，表中就会有两行描述同一个
集群，其中一行是过期的。

在**早于 v4.3.4 的 PostgreSQL Operator 版本**上，读取对端信息的查询不做任何
排序，返回的第一行会被采用，因此过期的行可能被优先于
当前的行选中。这些版本在重新注册时也不会刷新行的 `last_update` 时间戳，
因此时间戳无法可靠地指示哪一行是当前的。

**PostgreSQL Operator v4.3.4 及更高版本**在每次注册时都会刷新 `last_update`，并选择
最近更新的行，因此残留的行不再具有优先权。

##### 诊断

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role,
          repl_svc_ip, node_port, trim(member_hosts) as member_hosts, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```

预期每个集群恰好一行。同一个 `cluster_name` 出现多行即表明存在残留
元数据。将 `node_port` 与对端当前的 master Service 比对：

```bash
kubectl -n <ns> get svc <peer-cluster-name> -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'
```

##### 解决方案

1. 删除过期的行，只保留 `node_port` 和 `member_hosts` 与
   对端当前 master Service 相符的那一行：

```sql
DELETE FROM sys_operator.multi_cluster_info WHERE id = <obsolete-id>;
```

2. 等待 operator 完成调谐，然后确认 `-xcr` Service 的 endpoints 现在指向对端
   当前的端口：

```bash
kubectl -n <ns> get endpoints <cluster-name>-xcr -o yaml
```

3. 在可行的情况下，运行 PostgreSQL Operator v4.3.4 或更高版本，它会选择最近更新的
   行，因此不受残留元数据影响。

#### 数据同步问题

##### 症状

复制堆积量增大，备集群落后

##### 解决方案

- 验证集群之间的网络连通性
- 检查两个集群的存储性能
- 关注 `max_slot_wal_keep_size` 设置，确保 WAL 保留量充足
- 如果资源配置不足，考虑增加资源
- **重要**：定期监控对于最大限度减少故障切换期间的潜在数据丢失至关重要

### 诊断命令

检查复制状态：
```bash
# On standby cluster
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list

# On primary cluster  
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

- 合理设置 `max_slot_wal_keep_size`（生产环境至少 10GB）
- 为数据库负载使用具备足够 IOPS 的专用存储类
- 对复制堆积量和集群健康状况实施监控
- 定期在非生产环境中演练故障切换流程

### 运维准则

- 在维护窗口内与应用方协同执行主备切换
- 监控主集群和备集群的磁盘空间
- 保持各集群间 PostgreSQL 版本一致
- 在复制之外，仍要保留近期的备份

## 参考

### 自定义资源参数

**主集群配置：**
- `clusterReplication.enabled`：启用复制（true/false）
- `clusterReplication.replSvcType`：Service 类型（ClusterIP/NodePort/LoadBalancer）
- `postgresql.parameters.max_slot_wal_keep_size`：WAL 保留大小

**备集群配置：**
- `clusterReplication.isReplica`：标记为备集群（true）
- `clusterReplication.peerHost`：主集群接入地址
- `clusterReplication.peerPort`：主集群端口
- `clusterReplication.bootstrapSecret`：认证 secret

### 相关链接

- [PostgreSQL Operator 文档](https://docs.alauda.io/postgresql/4.1/functions/index.html)
- [PostgreSQL Operator 安装指南](https://docs.alauda.io/postgresql/4.1/installation.html)

## 总结

本指南提供了在 Alauda Container Platform 上实施 PostgreSQL 热备集群的完整说明。该方案通过流式复制与手动故障切换管理，提供企业级的高可用与灾难恢复能力。

获得的关键收益：
- **最小化数据丢失**：持续的 WAL 复制将潜在数据丢失降到最低（通常仅数秒）
- **可控的故障切换**：手动提升确保得到充分验证并降低风险
- **灵活部署**：同时支持集群内与跨集群场景
- **生产就绪**：经过实战检验、面向企业级负载的配置模式

遵循这些实践，组织可以在对关键故障切换操作保持掌控的同时，确保其 PostgreSQL 数据库满足严格的可用性与恢复目标。
