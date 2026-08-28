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

# PostgreSQL 热备份集群配置指南

## 背景

### 挑战

现代应用程序要求其 PostgreSQL 数据库具备高可用性和灾难恢复能力。传统的备份解决方案通常涉及显著的停机时间和数据丢失。手动复制设置复杂，难以配置和维护。

### 解决方案

本指南提供了使用 Alauda 容器平台 (ACP) 设置 PostgreSQL 热备份集群的全面说明。该解决方案支持集群内和跨集群的复制，能够实现：

- **最小数据丢失**：持续的流式复制确保最小的数据丢失（通常最多几秒的数据）
- **手动故障转移**：在需要时可控地提升备用集群以实现高可用性
- **地理冗余**：跨集群复制以实现灾难恢复
- **操作简便**：通过 Kubernetes 自定义资源实现自动配置

## 环境信息

适用版本：>=ACP 4.1.0，PostgreSQL Operator：>=4.1.8（负载均衡器支持需要 PostgreSQL Operator >=4.2.0）

## 快速参考

### 关键概念

- **主集群**：接受读/写操作的主 PostgreSQL 集群
- **备用集群**：持续从主集群同步的副本集群
- **流式复制**：集群之间实时的 WAL（预写日志）复制
- **切换**：在维护期间计划的集群提升/降级
- **故障转移**：当主集群不可用时的紧急提升

### 常见用例

| 场景                   | 推荐方法               | 部分参考                             |
| ---------------------- | ---------------------- | ------------------------------------ |
| **高可用性**           | 集群内复制             | [集群内设置](#intra-cluster-setup)  |
| **灾难恢复**           | 跨集群复制             | [跨集群设置](#cross-cluster-setup)  |
| **计划维护**           | 切换操作步骤           | [正常操作](#normal-operations)      |
| **紧急恢复**           | 手动故障转移步骤       | [灾难恢复](#disaster-recovery)      |

## 先决条件

在实施 PostgreSQL 热备份之前，请确保您具备：

- ACP v4.1.0 或更高版本，PostgreSQL Operator v4.1.8 或更高版本
- 按照 [安装指南](https://docs.alauda.io/postgresql/4.1/installation.html) 部署 PostgreSQL 插件
- 对 PostgreSQL 操作和 Kubernetes 概念有基本了解
- 阅读 [PostgreSQL Operator 基本操作指南](https://docs.alauda.io/postgresql/4.1/functions/index.html)，以了解创建实例、备份和监控等基本操作
- **存储资源**：
  - 主集群：存储容量应能容纳数据库大小加上预写日志 (WAL) 文件（通常需要额外 10-20% 的空间）
  - 备用集群：与主集群相同的存储容量，以确保完整的数据复制。确保 **StorageClass 性能 (IOPS/吞吐量)** 与主集群匹配，以防止故障转移后的性能下降。
  - 考虑未来增长并设置适当的 `max_slot_wal_keep_size`（建议最小 10GB）
- **网络资源**：
  - 集群内：标准 Kubernetes 网络性能
  - 跨集群：低延迟连接 (<20ms) 和足够的带宽（生产工作负载至少 1 Gbps）
  - 稳定的网络连接以防止复制中断
- **计算资源**：
  - 主集群：足够的 CPU 和内存以支持数据库操作和复制进程
  - 备用集群：与主集群相似的 CPU 和内存分配，以处理读操作和潜在的提升

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

请参考 [创建实例文档](https://docs.alauda.io/postgresql/4.1/functions/01_create_instance.html) 获取创建 PostgreSQL 实例的详细说明。然后，启用主集群的热备份配置：

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

4. 完成实例创建并等待状态为运行中

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

1. 获取主集群的管理员凭据
2. 在备用集群命名空间中创建包含主集群管理员凭据的引导密钥：

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

- 将命名空间替换为您的备用集群的命名空间
- 用户名和密码必须与主集群的管理员凭据匹配
- 密钥名称应在备用集群配置中作为 `bootstrapSecret` 引用

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
    peerHost: 10.96.140.172  # 主集群读写服务 IP
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
+ 集群: acid-standby (7562204126329651274) -------+-----------+----+-----------+
| 成员           | 主机             | 角色           | 状态     | TL | 堆积量 (MB) |
+----------------+------------------+----------------+-----------+----+-----------+
| acid-standby-0 | fd00:10:16::29b8 | 备用领导者     | streaming |  1 |           |
+----------------+------------------+----------------+-----------+----+-----------+
```

### 跨集群设置

#### 防火墙环境的端口规划

在两个 Kubernetes 集群之间的流量通过防火墙的环境中，在创建集群之前决定允许哪些端口。默认情况下，操作员允许 Kubernetes 自动分配 NodePorts，每当服务被重新创建时，都会分配一个新端口——这是您无法提前提交防火墙更改请求的分配，并且在 [故障排除](#troubleshooting) 中描述的集群重建步骤中不会保留。

**防火墙必须允许哪些端口**

| 方向                         | 目标节点                                   | 需要打开的端口                              |
| --------------------------- | ------------------------------------------ | ------------------------------------------- |
| 备用集群 → 主集群          | 每个运行主集群 PostgreSQL Pod 的节点      | 主集群的 **主** 服务 NodePort               |
| 主集群 → 备用集群          | 每个运行备用集群 PostgreSQL Pod 的节点    | 备用集群的 **主** 服务 NodePort             |

两个容易出错的点：

- **在每个可以托管 PostgreSQL Pod 的节点上打开端口，而不仅仅是您在 `peerHost` 中输入的地址。** 操作员记录每个成员 Pod 的主机 IP，并从该列表构建跨集群端点，因此可以连接到其中的任何一个。如果 Pods 可以重新调度到其他节点，也要包括这些节点。
- **两个方向都是必需的。** 在复制正常运行时，只有备用集群拨打主集群，但在切换期间方向会反转：降级的集群成为拨打的一方。仅允许备用 → 主的规则在第一次切换之前有效，然后会失败。

**识别要固定的服务**

一个集群有多个服务，没有一个名为 `master`。对于名为 `<cluster-name>` 的集群：

| 服务名称                | 角色                | `serviceTemplates` 键 | 包含在防火墙规则中               |
| ----------------------- | ------------------- | ---------------------- | -------------------------------- |
| `<cluster-name>`        | 主                  | `master`               | **是** — 这是需要打开的 NodePort |
| `<cluster-name>-repl`   | 副本                | `replica`              | 否                               |
| `<cluster-name>-xcr`    | 跨集群别名          | 不可配置               | 否                               |
| `<cluster-name>-exporter` | 监控               | 不可配置               | 否                               |

:::warning `-repl` 是副本服务，而不是复制服务
`-repl` 后缀代表 **副本**：这是一个只读客户端端点，在副本 Pods 之间进行负载均衡，并且与跨集群复制无关。它与“复制”的相似性使其成为请求防火墙规则时最常见的错误答案。
:::

:::info `-xcr` 服务 NodePort 不需要打开
`<cluster-name>-xcr` 服务也会接收自己的自动分配 NodePort，但它是 **peer** 集群的本地别名：其目标端口是 peer 的主 NodePort。流量通过它离开，没有任何流量到达它，且没有外部客户端与之连接。它也是由操作员直接构建的，而不是从 `serviceTemplates` 中构建的，因此其端口无法固定——也不需要固定。
:::

要读取必须打开的端口——Web 控制台显示的是集群 IP 而不是节点端口，因此直接查询：

```bash
kubectl get svc -n <namespace> <cluster-name> -o jsonpath='{.spec.ports[0].nodePort}'
```

**将 NodePort 固定为固定数字**

`clusterReplication` 没有端口号字段。使用 `spec.serviceTemplates.master` 固定主服务的 NodePort，该字段会合并到生成的服务中：

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
            nodePort: 31234        # 必须在集群的节点端口范围内
```

对两个集群应用相同的模式，如果它们共享防火墙策略，则为每个选择不同的数字。备用集群的 `peerPort` 就是您在主集群上固定的数字，并且在服务重新创建时不再更改。

:::warning 完整写出端口条目
模板的 `ports` 列 **替换** 生成的列表，而不是逐字段合并，因此部分条目不会继承其替换条目的默认值。

模式捕获了最坏的情况：`port` 是必需的，省略它的条目会被拒绝，错误信息为 `spec.serviceTemplates.master.spec.ports[0].port: Required value`。`targetPort` 是可选的，Kubernetes 默认将其设置为 `port` 的值。完整写出条目，如上所示，使结果独立于这两种行为，并使意图清晰可读。
:::

:::warning 验证您的集群中的 CRD 是否接受 `serviceTemplates`
该字段在与操作员包一起提供的 CRD 模式中存在，但并非每个打包的 CRD 副本中都有。如果操作员以 `enable_crd_registration: true` 运行，它可以用省略该字段的模式替换已安装的 CRD。

这取决于客户端的表现。`kubectl apply` 默认请求严格字段验证并会响亮失败：

```
error: ... strict decoding error: unknown field "spec.serviceTemplates"
```

不请求严格验证的客户端——`kubectl apply --validate=ignore`、较旧的客户端以及某些控制器和 GitOps 工具——会被告知对象已成功创建，而 API 服务器会丢弃该字段。NodePort 然后保持自动分配，日志中没有解释原因。确认模式而不是依赖于应用成功：

```bash
kubectl get crd postgresqls.acid.zalan.do -o json \
  | jq '.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.serviceTemplates != null'
```

该命令必须打印 `true`。如果打印 `false`，请使用下面的负载均衡器选项，或打开自动分配的端口，并在任何重新创建服务的更改后重新检查它们。
:::

**在配对集群之前设置端口**

在配对集群之前选择端口号，并在之后将其视为固定。

:::warning 更改配对集群的节点端口会破坏复制并不会自我修复
对等方从 `sys_operator.multi_cluster_info` 元数据表中学习端口，该表通过复制流到备用集群。更改主集群的节点端口会切断流，因此更新的行永远不会到达：主集群记录新端口，而备用集群则无限期保持旧端口，将其 `-xcr` 端点指向不再存在的端口。两侧无法自行重新同步，因为唯一可以传递更正的通道是更改切断的通道。

恢复方法是恢复先前的节点端口，此时备用集群重新连接并赶上，或重建备用集群。提前规划数字，而不是在运行的配对上进行调整。
:::

**替代方案：使用负载均衡器**

使用 `replSvcType: LoadBalancer`（操作员 v4.2.0 或更高版本），对等方连接到负载均衡器地址的 5432 端口，不涉及 NodePort，这通常使防火墙规则更简单且更稳定。这需要两个集群中都有负载均衡器的实现。

:::info 在重新编号端口之前确认故障确实是防火墙
防火墙丢弃和集群自身的覆盖网络故障在 PostgreSQL Pod 内部看起来是相同的：连接超时。从备用侧的 **节点 shell** 测试，而不是从 Pod：

```bash
nc -vz <primary-node-ip> <primary-master-nodeport>
```

`Connection refused` 表示路径是开放的，但没有监听该端口——端口号或服务是错误的。超时与防火墙丢弃一致。如果节点级测试成功，但 Pod 级测试超时，则问题出在集群网络内部，更改端口号不会解决问题。
:::

#### 主集群配置

**选项 1：使用 NodePort**

配置主集群以 NodePort 服务类型进行跨集群访问：

```yaml
spec:
  clusterReplication:
    enabled: true
    replSvcType: NodePort
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

**选项 2：使用负载均衡器（需要操作员 v4.2.0+）**

配置主集群以负载均衡器服务类型：

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

1. 获取主集群的管理员凭据
2. 在备用集群命名空间中创建包含主集群管理员凭据的引导密钥：

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

> **注意**：将 `peerHost` 替换为主集群的实际节点 IP，将 `peerPort` 替换为 NodePort。

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

**选项 2：通过负载均衡器连接（需要操作员 v4.2.0+）**

在创建后从主集群的服务中获取外部 IP，然后配置备用集群：

```yaml
spec:
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 203.0.113.10     # 主集群负载均衡器外部 IP
    peerPort: 5432             # 标准 PostgreSQL 端口（或特定的 LB 端口）
    replSvcType: LoadBalancer
    bootstrapSecret: standby-bootstrap-secret
```

**验证步骤：**

在备用集群成功运行后，验证其外部 IP 是否在主集群的 `sys_operator.multi_cluster_info` 表中正确记录。

1. 检查主集群的表内容：
   ```bash
   kubectl exec <primary-pod> -- psql -x -c "SELECT * FROM sys_operator.multi_cluster_info;"
   ```

2. 如果备用集群记录的 `external_ip` 字段为空，请手动使用备用集群的负载均衡器 IP 更新它。

   首先，检索备用集群的负载均衡器 IP：

   ```bash
   kubectl get svc -n <standby-namespace> <standby-cluster-name>
   ```

   从输出中注意 `EXTERNAL-IP`。

   然后，执行更新：

   ```bash
   kubectl exec <primary-pod> -- psql -c "UPDATE sys_operator.multi_cluster_info SET external_ip='<STANDBY-LB-IP>' WHERE cluster_name='<standby-cluster-name>';"
   ```

## 正常操作

### 切换操作步骤

为避免脑裂场景，按三个阶段进行计划切换。**第 3 阶段不是可选的**——提升新主集群并不会改变应用程序发送数据库连接的地方。

> **重要**：对于跨集群设置，请确保在执行命令之前将 `kubectl` 上下文切换到适当的集群。

:::info 在切换之前确认复制元数据是干净的
第 1 阶段在 **原地** 降级当前主集群。降级的集群从 `sys_operator.multi_cluster_info` 表中获取新对等方的连接详细信息，因此切换的可靠性仅取决于该表的内容。

如果任一集群曾被删除并重新创建，请在继续之前验证每个集群确实存在一行——请参见
[过时的复制元数据](#stale-replication-metadata-after-recreating-a-cluster)。

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role, node_port, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```

:::

#### 第 1 阶段：将主集群降级为备用

```bash
kubectl -n $NAMESPACE patch pg $PRIMARY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":true},"numberOfInstances":1}}'
```

验证降级：

```bash
$ kubectl -n $NAMESPACE exec $PRIMARY_CLUSTER-0 -- patronictl list
+ 集群: acid-primary (7562204126329651274) -------+---------+----+-----------+
| 成员           | 主机             | 角色           | 状态   | TL | 堆积量 (MB) |
+----------------+------------------+----------------+---------+----+-----------+
| acid-primary-0 | fd00:10:16::29b3 | 备用领导者     | running |  1 |           |
+----------------+------------------+----------------+---------+----+-----------+
```

#### 第 2 阶段：将备用提升为主集群

```bash
kubectl -n $NAMESPACE patch pg $STANDBY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":false},"numberOfInstances":2}}'
```

验证提升：

```bash
$ kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
+ 集群: acid-standby (7562204126329651274) -----+-----------+----+-----------+
| 成员           | 主机             | 角色         | 状态     | TL | 堆积量 (MB) |
+----------------+------------------+--------------+-----------+----+-----------+
| acid-standby-0 | fd00:10:16::29b8 | 领导者       | running   |  2 |           |
| acid-standby-1 | fd00:10:16::2a2e | 同步备用     | streaming |  2 |         0 |
+----------------+------------------+--------------+-----------+----+-----------+
```

#### 第 3 阶段：将应用程序指向新主集群

⚠ **切换不会为您执行此操作。** 在第 1 阶段和第 2 阶段之后，前主集群是一个 **只读备用**，而应用程序的数据库连接仍指向它。写入操作将继续失败：

```
ERROR: cannot execute UPDATE in a read-only transaction
ERROR: cannot execute INSERT in a read-only transaction
```

健康的复制并不意味着服务已恢复——**应用程序连接必须明确重新指向。**

**1. 确认新主集群可写**

```bash
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- psql -Atc "select pg_is_in_recovery()"
# 预期输出: f
```

**2. 获取新主集群的连接端点**

```bash
# 集群内：直接使用主服务
echo "$STANDBY_CLUSTER.$NAMESPACE.svc.cluster.local:5432"

# 跨集群：应用程序通过 NodePort / 负载均衡器访问
kubectl -n $NAMESPACE get svc $STANDBY_CLUSTER -o wide
```

> 在跨集群设置中，这与配置备用时使用的 `peerHost` / `peerPort` 是同一类路径——也确认防火墙允许它。

**3. 确认凭据**

数据库凭据存储在名为 **集群名称** 的密钥中，因此密钥名称随集群变化：

```bash
kubectl -n $NAMESPACE get secret \
  <username>.$STANDBY_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

**4. 更新应用程序配置并重启**

根据应用程序的配置（ConfigMap / Secret / 环境变量 / 连接字符串）更新数据库端点，然后重启其 Pods，以使新连接生效。

**5. 验证**

```bash
# 应用程序的连接应出现在新主集群上
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- \
  psql -x -c "select client_addr, usename, state, query_start from pg_stat_activity
                where backend_type = 'client backend'"
```

确认在应用程序或数据库日志中不再出现 `只读事务` 错误。

> **建议**：在应用程序支持的情况下，通过与集群名称解耦的间接方式连接（稳定的服务别名、外部 DNS 名称或连接池），以便未来的切换只需重新指向该间接方式，而不是编辑应用程序配置。

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

1. **需要手动干预**：使用手动故障转移程序提升备用集群
2. 更新应用程序连接以指向新主集群（见 *正常操作 → 第 3 阶段*）
3. 当原主集群恢复时，将其重新配置为备用
4. **注意**：根据故障时的复制延迟，可能会发生一些数据丢失

### 备用集群故障

备用集群故障不会影响主集群的操作。恢复是自动的：

1. 修复导致备用故障的根本问题
2. 备用集群将自动重新连接并重新同步
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

备用集群无法加入复制，数据同步问题

##### 原因

两种不同的情况会产生相同的症状，且它们有不同的补救措施。在采取行动之前，请确定您遇到的是哪一种。

- **备用落后，所需的 WAL 已被回收。** 备用日志重复 `requested WAL segment ... has already been removed`。数据是完整且一致的；备用集群只是无法获取所需的 WAL 以赶上。
- **备用已分歧。** 备用日志报告 `requested starting point ... is not in this server's history`，或者两个集群报告不同的 `system identifier` 值。流式复制无法调和这一点。

##### 诊断

```bash
# 1. 相同的血统？两个值必须匹配。不同的值意味着这些是无关的数据库。
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- \
  pg_controldata /home/postgres/pgdata/pgroot/data | grep -i "system identifier"

# 2. 备用实际报告什么？阅读错误，而不仅仅是症状。
kubectl -n <ns> exec <standby-pod> -c postgres -- \
  tail -200 /home/postgres/pgdata/pgroot/pg_log/postgresql-*.csv | grep -iE "removed|history"

# 3. 主集群是否仍持有备用所需的 WAL，是否有任何东西保留它？
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -x \
  -c "select substr(name,1,8) as timeline, count(*) as segments,
             min(name) as oldest, max(name) as newest
        from pg_ls_waldir() where name ~ '^[0-9A-F]{24}$' group by 1 order by 1;" \
  -c "select slot_name, active, restart_lsn, wal_status,
             pg_size_pretty(safe_wal_size) as safe
        from pg_replication_slots;"
```

使用主集群的 **当前领导者**，这不一定是 Pod `-0`。通过 `patronictl list` 确定它。

##### 解决方案

:::warning 重建会丢弃您以其他方式恢复的能力
下面的过程会删除备用集群。删除它会移除 `spec.clusterReplication`，因此操作员会在主集群上删除 `xdc_hotstandby` 复制槽，并且 **所有 WAL 保留立即释放**。备用集群仍然需要的任何 WAL 在主集群的下一个检查点时都会变得可以回收。

如果备用集群仅落后而不是分歧，应用此过程会将可恢复的情况转换为需要完整基础备份的情况，并破坏确定复制停止原因所需的证据。

**在删除任何内容之前：**

1. 完成上述诊断步骤并记录输出。

2. 如果缺失的 WAL 仍然存在——在主集群的 `pg_wal` 中，在 WAL 存档中，或在主集群的其他成员中——可以通过使这些段对备用集群可用来修复备用集群。将完整的段复制到备用集群的 `pg_wal` 目录中（由 `postgres` 拥有，模式为 `600`），然后重启它。通过校验和验证每个复制的文件与其源的匹配：一个卡住的备用集群通常已经持有它失败的 **部分** 复制，因此文件大小并不能指示完整性。

3. 对主集群的卷进行存储级快照。
   :::

4. 删除失败的备用集群

5. 从主集群中删除集群元数据：

```sql
DELETE FROM sys_operator.multi_cluster_info WHERE cluster_name='<failed-cluster-name>';
```

**步骤 2 必须在步骤 3 之前完成，并且不能跳过。** 每个集群的行由集群的 Kubernetes UID 派生的 ID 键入，因此重新创建的集群会在 *新* ID 下注册。如果旧行仍然存在，表中将持有同一集群的两行——一行是当前的，一行是过时的。请参见
[过时的复制元数据](#stale-replication-metadata-after-recreating-a-cluster)。

3. 按照初始设置程序重新创建备用集群
4. 验证每个集群确实存在一行：

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role, node_port, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```

5. 在备用集群运行后，确认复制确实保留——而不仅仅是连接。该槽必须存在、处于活动状态，并跟踪备用集群：

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -x -c \
  "select slot_name, active, restart_lsn, wal_status from pg_replication_slots
    where slot_name = 'xdc_hotstandby';"
```

空的 `restart_lsn` 表示该槽不保留任何内容，WAL 将无论 `max_slot_wal_keep_size` 如何都被回收。缺少行意味着不存在槽，且对等方根本没有保留。

#### 重新创建集群后的过时复制元数据

##### 症状

在切换或重新创建集群后，复制没有恢复，即使两个集群都在运行且它们之间的网络路径是开放的。降级或重新创建的集群可能会在不再使用的端口或地址上寻址对等方。

##### 原因

跨集群复制在主集群的 `sys_operator.multi_cluster_info` 表中存储每个参与集群的连接详细信息。每行的 ID 是从集群的 Kubernetes UID 派生的，因此 **重新创建的集群在新 ID 下注册，而不是更新现有行**。如果先前的行没有先被删除，表中将持有两行描述同一集群，其中一行是过时的。

在 **PostgreSQL Operator 版本早于 v4.3.4** 的情况下，读取对等方详细信息的查询不应用任何排序，因此返回的第一行将被使用，因此可能会选择过时的行而不是当前行。这些版本在重新注册时也不会刷新行的 `last_update` 时间戳，因此时间戳无法可靠地指示哪一行是当前的。

**PostgreSQL Operator v4.3.4 及更高版本** 在每次注册时刷新 `last_update`，并选择最近更新的行，因此剩余的行不再优先。

##### 诊断

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role,
          repl_svc_ip, node_port, trim(member_hosts) as member_hosts, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```

期望每个集群恰好一行。对于同一 `cluster_name` 的多于一行表示存在剩余元数据。将 `node_port` 与对等方当前主服务进行比较：

```bash
kubectl -n <ns> get svc <peer-cluster-name> -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'
```

##### 解决方案

1. 删除过时的行，仅保留与对等方当前主服务的 `node_port` 和 `member_hosts` 匹配的行：

```sql
DELETE FROM sys_operator.multi_cluster_info WHERE id = <obsolete-id>;
```

2. 允许操作员进行协调，然后确认 `-xcr` 服务端点现在指向对等方的当前端口：

```bash
kubectl -n <ns> get endpoints <cluster-name>-xcr -o yaml
```

3. 在可行的情况下，运行 PostgreSQL Operator v4.3.4 或更高版本，该版本选择最近更新的行，因此不受剩余元数据的影响。

#### 数据同步问题

##### 症状

复制延迟增加，备用集群落后

##### 解决方案

- 验证集群之间的网络连接
- 检查两个集群的存储性能
- 监控 `max_slot_wal_keep_size` 设置以确保足够的 WAL 保留
- 如果资源配置不足，考虑增加资源
- **重要**：定期监控对于最小化故障转移期间的潜在数据丢失至关重要

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

- 适当设置 `max_slot_wal_keep_size`（生产环境建议最小 10GB）
- 使用具有足够 IOPS 的专用存储类以支持数据库工作负载
- 实施复制延迟和集群健康监控
- 在非生产环境中定期测试故障转移程序

### 操作指南

- 在维护窗口期间进行切换，并与应用程序协调
- 监控主集群和备用集群的磁盘空间
- 保持 PostgreSQL 版本在集群之间同步
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

本指南提供了在 Alauda 容器平台上实施 PostgreSQL 热备份集群的全面说明。该解决方案通过流式复制和手动故障转移管理提供企业级高可用性和灾难恢复能力。

实现的关键好处：

- **最小数据丢失**：持续的 WAL 复制最小化潜在的数据丢失（通常为几秒）
- **可控故障转移**：手动提升确保适当的验证并降低风险
- **灵活部署**：支持集群内和跨集群场景
- **生产就绪**：经过实战检验的配置模式，适用于企业工作负载

通过遵循这些实践，组织可以确保其 PostgreSQL 数据库满足严格的可用性和恢复目标，同时保持对关键故障转移操作的控制。
