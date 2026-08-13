---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.3
id: KB260720001
sourceSHA: a00dfa38a5433f59ea4755229072e0ce6d236ba2c3e9ffe9ca5a36ef2c285aef
---

# PostgreSQL 实例跨集群迁移指南 (Operator v4.3.3)

## 背景

### 挑战

有时，正在运行的 PostgreSQL 实例必须迁移到不同的 Kubernetes 集群——集群退役、硬件刷新、在 ACP 平台之间移动工作负载或合并环境。转储和恢复迁移需要与数据库大小成比例的停机时间，并且会丢失转储后进行的写入。

### 解决方案

本指南使用操作员的热备用（跨集群复制）功能在集群之间迁移 PostgreSQL 实例：目标实例被创建为一个 *备用集群*，通过流复制直接从源引导，保持持续同步，然后在受控的两阶段切换中提升。停机时间仅限于切换本身（几秒到几分钟），并在切换前后通过校验和验证数据完整性。

该操作步骤已在两个不同的 ACP 平台上使用 PostgreSQL Operator v4.3.3 进行了端到端验证（源和目标在不同平台上，通过 NodePort 连接）。它基于 [PostgreSQL 热备用集群配置指南](./How_to_Use_PostgreSQL_Hot_Standby_Cluster.md) (KB251000009)；请先阅读该文档以了解概念背景。

## 环境信息

- PostgreSQL Operator: v4.3.3 在 **源** 和 **目标** 集群上均运行（请参见 [重要限制](#important-limitations)）
- ACP: 任何能够运行 v4.3.3 操作员的 4.x 集群；源和目标可以在不同的 ACP 平台上
- PostgreSQL: 双方必须使用相同的主要版本（本指南使用 16）

## 重要限制

- **操作员版本必须在两侧匹配。** 跨版本配对（例如，v4.2+/v4.3 的备用与由 v4.1.x 管理的主节点）会失败并显示 `pq: column "external_ip" does not exist`，并且——危险的是——会将“备用”作为一个空的独立主节点运行（记录为 ECO-703）。请参见 [故障排除](#troubleshooting)。
- 源和目标必须运行相同的 PostgreSQL 主要版本。
- 备用集群必须最初以 `numberOfInstances: 1` 创建；提升后再扩展。
- `replSvcType` 在两个集群上必须相同。
- 目标集群必须能够访问源集群的节点 IP + NodePort（备用从主节点拉取）。在开始之前验证这一点——请参见步骤 2。如果集群之间 **没有网络路径**，则流复制方法无法工作——请改用 [无集群间连接的工作站中继逻辑迁移](#alternative-migration-without-inter-cluster-connectivity)。
- 在混合架构的目标集群上，将实例（理想情况下是操作员）固定到与源架构匹配的节点。流复制逐位复制数据目录；PostgreSQL 不支持混合架构复制。

## 迁移概述

```
步骤 1  准备源：启用 clusterReplication，记录 NodePort，基线校验和
步骤 2  预检：网络可达性，版本/架构检查
步骤 3  在目标上创建备用（从源引导，保持流复制）
步骤 4  验证同步：身份、堆积量、校验和
步骤 5  切换：两阶段切换（降级源，提升目标）
步骤 6  迁移后：重新指向客户端；保留反向备用或拆除
```

## 步骤 1：准备源实例

如果源实例尚未启用集群复制，请进行补丁（这是在线更改；操作员创建复制元数据并公开主服务）：

```bash
SRC_NS="pg-migrate"
SRC_CLUSTER="acid-mig"

kubectl -n $SRC_NS patch postgresql $SRC_CLUSTER --type merge -p '{
  "spec": {
    "clusterReplication": {"enabled": true, "replSvcType": "NodePort"},
    "postgresql": {"parameters": {"max_slot_wal_keep_size": "10GB"}}
  }
}'
```

> `max_slot_wal_keep_size` 限制了备用断开连接时为复制槽保留的 WAL 大小。根据您的卷大小进行设置：它必须适合实例的可用磁盘空间，并定义了您可以容忍的备用停机时间，超过此时间需要重新引导。

记录备用将使用的连接坐标：

```bash
# 源主服务的 NodePort
kubectl -n $SRC_NS get svc $SRC_CLUSTER -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'

# 托管实例的节点 IP（集群的任何节点 IP 对 NodePort 都有效）
kubectl -n $SRC_NS get pod -l cluster-name=$SRC_CLUSTER -o jsonpath='{range .items[*]}{.status.hostIP}{"\n"}{end}'
```

确认源在复制元数据中注册了自己（角色 `primary`，正确的 `node_port`）：

```bash
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -x \
  -c "SELECT * FROM sys_operator.multi_cluster_info;"
```

进行数据完整性基线检查。根据您的模式调整校验和查询——关键是得到一个可以在迁移后进行比较的数字：

```bash
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -d <yourdb> -tA -c "
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
# 每个表的示例校验和：
#   SELECT count(*), sum(hashtext(id::text || payload)) FROM your_table;
```

最后，强制进行检查点，以便备用的基础备份从一致的点开始：

```bash
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -c "CHECKPOINT;"
```

## 步骤 2：目标上的预检

**网络可达性**——备用（操作员 pod *和* PostgreSQL pods）必须能够访问源 NodePort。从目标集群的覆盖网络中的 pod 测试，在将运行实例的节点上：

```bash
# 从目标集群的任何 pod 中：
kubectl exec <some-pod> -- bash -c 'timeout 4 bash -c "echo > /dev/tcp/<SRC_NODE_IP>/<SRC_NODEPORT>" && echo OPEN || echo CLOSED'
```

如果输出为 `CLOSED`，请先停止并修复连接。请注意，可达性可能因节点而异（已观察到个别节点的出口故障）；从您将调度到的节点进行测试。

**版本检查**——两个操作员必须是 v4.3.3（或至少相同版本）：

```bash
kubectl -n operators get csv | grep postgres-operator
```

**架构**——在混合架构目标上，现在决定节点集并使用 `nodeAffinity` 进行固定（在步骤 3 中显示）。

## 步骤 3：在目标集群上创建备用

创建命名空间和一个引导密钥，保存 **源** 集群的管理员凭证：

```bash
TGT_NS="pg-migrate"

# 从源集群读取管理员密码：
kubectl --context <source-ctx> -n $SRC_NS get secret \
  postgres.${SRC_CLUSTER}.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d
```

```yaml
kind: Secret
apiVersion: v1
metadata:
  name: standby-bootstrap-secret
  namespace: pg-migrate
type: kubernetes.io/basic-auth
stringData:
  username: postgres
  password: "<SOURCE-ADMIN-PASSWORD>"
```

创建备用实例。保持 PostgreSQL 版本、参数和卷大小与源一致；从单个副本开始：

```yaml
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: acid-mig            # 名称可能与源不同
  namespace: pg-migrate
spec:
  teamId: acid
  numberOfInstances: 1      # 备用集群初始时需要
  postgresql:
    version: "16"           # 必须与源主要版本匹配
    parameters:
      max_slot_wal_keep_size: '10GB'
  volume:
    size: 5Gi               # 与源相同的容量
    storageClass: <target-storageclass>
  # 仅在混合架构集群上需要——与源架构匹配：
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: "<SRC_NODE_IP>"
    peerPort: <SRC_NODEPORT>
    replSvcType: NodePort
    bootstrapSecret: standby-bootstrap-secret
```

创建时发生的事情：操作员连接到源，将数据库用户凭证秘密复制到目标命名空间，创建一个本地 `<name>-xcr` 服务，其端点指向源节点，并使用 `pg_basebackup` 从源引导 pod。`patronictl list` 在基础备份期间显示 `creating replica`（持续时间取决于数据库大小和链接带宽），然后显示 `Standby Leader | streaming`。

## 步骤 4：验证同步

在切换之前，以下三个检查必须通过。

**1. 流状态和共享身份**——`patronictl list` 打印的集群标识符在源和目标上必须 *相同*（它是 PostgreSQL 系统标识符）。如果目标显示不同的标识符，则它作为独立集群引导，并且不包含您的数据——请参见 [故障排除](#troubleshooting)。

```bash
# 目标——期望：Standby Leader | streaming
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- patronictl list

# 源——期望备用已连接，且槽处于活动状态：
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -c \
  "SELECT application_name, client_addr, state FROM pg_stat_replication;
   SELECT slot_name, active FROM pg_replication_slots WHERE slot_name='xdc_hotstandby';"
```

**2. 复制堆积量**——在源上写入，确认它在几秒钟内出现在目标上，并比较 LSN：

```bash
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -tA -c "SELECT pg_current_wal_lsn();"
kubectl -n $TGT_NS exec acid-mig-0     -c postgres -- psql -U postgres -tA -c "SELECT pg_last_wal_replay_lsn();"
```

**3. 数据校验和**——在目标上重新运行步骤 1 的基线查询；每个值必须匹配。

## 步骤 5：切换（两阶段切换）

按照文档中记录的顺序执行切换——先降级，然后提升——以确保没有时刻存在两个可写的主节点。

1. **停止源上的应用写入**（缩减写入者，或在应用层保持流量）。

2. **确认零堆积量**（步骤 4，检查 2——一旦停止写入，两个 LSN 必须相等）。

3. **第一阶段——将源降级**为备用：

```bash
kubectl --context <source-ctx> -n $SRC_NS patch postgresql $SRC_CLUSTER --type merge \
  -p '{"spec":{"clusterReplication":{"isReplica":true},"numberOfInstances":1}}'
```

等待源显示 `Standby Leader`（它可能会短暂经过 `stopped`）。降级的源通过复制元数据自动找到目标——其 spec 中不需要添加 `peerHost`。

4. **第二阶段——提升目标**并将其扩展到完整大小：

```bash
kubectl --context <target-ctx> -n $TGT_NS patch postgresql acid-mig --type merge \
  -p '{"spec":{"clusterReplication":{"isReplica":false},"numberOfInstances":2}}'
```

5. **等待真实的提升信号。** 不要仅依赖 `pg_is_in_recovery()`——在提升和扩展期间，集群状态可以读取为 `Running`，而 Patroni 仍在转换角色。等待 **所有** 以下条件成立：

```bash
# a) Patroni 显示状态为运行的 Leader（此时时间线增加是正常的）：
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- patronictl list
# b) CR 报告为 Running：
kubectl -n $TGT_NS get postgresql acid-mig -o jsonpath='{.status.PostgresClusterStatus}{"\n"}'
# c) 新的副本正在流式传输（扩展后）：
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- psql -U postgres -c \
  "SELECT application_name, state FROM pg_stat_replication;"
```

6. **验证新主节点的写入和完整性**：插入一个标记行，重新运行校验和查询，与基线进行比较。

> 在提升+扩展期间，目标的 pod 之间发生领导权变更（伴随额外的时间线增加）是正常的操作员滚动行为，并不表示存在问题。

## 步骤 6：迁移后

- **重新指向客户端**到目标集群的服务（并更新应用程序使用的任何外部访问，如 NodePort/LoadBalancer/ingress）。
- 降级的源现在是目标的实时 **反向灾难恢复备用**：在目标上的写入会复制回源。选择一个：
  - **保留它**作为灾难恢复/回滚保险（建议至少保留一段时间）。回滚是相同的两阶段切换，方向相反。
  - **拆除它**并完全移除复制设置——见下文。
- 扩展/调整目标（副本数量、资源、备份计划、监控）以匹配源的配置。

### 拆除源并移除复制配置

按 **顺序** 执行这些步骤——在移除主节点的复制配置之前，必须先删除备用，否则备用在仍然流式传输的情况下会失去上游。

**1. 删除降级的源实例**（在源集群上）：

```bash
kubectl --context <source-ctx> -n $SRC_NS delete postgresql $SRC_CLUSTER
# CR 删除时 PVC 保留取决于操作员配置——检查并
# 删除任何残留以回收存储：
kubectl --context <source-ctx> -n $SRC_NS get pvc -l cluster-name=$SRC_CLUSTER
kubectl --context <source-ctx> -n $SRC_NS delete pvc -l cluster-name=$SRC_CLUSTER --ignore-not-found
```

操作员会连同 CR 删除它所拥有的凭证秘密。

**2. 通过移除 `clusterReplication` 块将目标转换为普通（非复制）实例**：

```bash
kubectl --context <target-ctx> -n $TGT_NS patch postgresql acid-mig --type json \
  -p '[{"op":"remove","path":"/spec/clusterReplication"}]'
```

操作员处理此转换：它重新应用正常主节点的 Patroni 配置，从数据库中删除 `sys_operator` 元数据模式，并从复制配置中移除 `xdc_hotstandby` 槽。（反向操作——将现有普通实例 *转换为* 备用——不是支持的转换；备用必须作为备用创建。）

**3. 清理操作员未删除的剩余对象**：

```bash
# 引导密钥（用户创建，永远不是操作员拥有）：
kubectl --context <target-ctx> -n $TGT_NS delete secret standby-bootstrap-secret

# 在角色更改后，<name>-xcr 服务仍然存在（仅在 CR 本身删除时移除）——删除它：
kubectl --context <target-ctx> -n $TGT_NS delete svc acid-mig-xcr --ignore-not-found

# 物理复制槽也可能仍然存在，即使它已从 Patroni 配置中删除——如果步骤 4 检查发现它，则删除：
kubectl --context <target-ctx> -n $TGT_NS exec acid-mig-0 -c postgres -- psql -U postgres -c \
  "SELECT pg_drop_replication_slot('xdc_hotstandby')
     WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='xdc_hotstandby' AND NOT active);"
```

**4. 验证目标是一个干净的独立实例：**

```bash
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- psql -U postgres -tA -c \
  "SELECT count(*) FROM pg_replication_slots WHERE slot_name='xdc_hotstandby';
   SELECT count(*) FROM pg_namespace WHERE nspname='sys_operator';"
# 两个计数必须为 0
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- patronictl list
# 期望是一个普通的 Leader/Replica 集群，没有 Standby Leader
```

## 替代方案：无集群间连接的迁移

当集群之间 **没有网络路径** 但您的工作站可以访问两个 Kubernetes API 服务器时，迁移可以通过工作站作为逻辑转储/恢复进行中继，两个 `kubectl exec` 会话之间进行管道——集群之间从不相互通信。停机时间等于完整复制的持续时间（与流式切换的几秒钟相比），但没有操作员版本或 CPU 架构限制，并且目标上的 PostgreSQL 主要版本只需与源相同或更新。

完整的验证程序是一个单独的解决方案：[如何在网络隔离的集群之间迁移 PostgreSQL 实例](./How_to_Migrate_a_PostgreSQL_Instance_Between_Network_Isolated_Clusters.md) (KB260721001)。

## 故障排除

### 备用失败并显示 `pq: column "external_ip" does not exist`——并作为一个空的独立主节点运行

**原因：** 源和目标之间的操作员版本不匹配（例如，源主节点由 v4.1.x 管理，目标操作员为 v4.2+/v4.3）。这些行之间的复制元数据表模式不同，并且从未迁移（ECO-703）。备用创建钩子中途中止，pod 陷入正常引导：它作为一个 *全新、空的、可写的* 主节点启动，而其 CR 仍显示 `isReplica: true`。

**检测：** 比较 `patronictl list` 中两侧的集群标识符——不同的标识符意味着独立集群，而不是备用。

**修复：** 将两个操作员升级到相同版本（首选）。如果源操作员无法立即升级，请在源主节点上添加缺失的列（对两个版本都是安全的——所有语句通过名称引用列）：

```sql
ALTER TABLE sys_operator.multi_cluster_info ADD COLUMN IF NOT EXISTS external_ip CHAR(64) DEFAULT '';
```

然后干净地重新创建备用——请参见下一个项目。

### 重新创建失败的备用：创建钩子失败，显示密钥“已存在”

操作员在引导之前将源的凭证秘密复制到目标命名空间，如果它们已经存在于先前的尝试中，则复制步骤会失败。要从头开始重试备用创建，请删除所有以下内容：

```bash
kubectl -n $TGT_NS delete postgresql acid-mig
kubectl -n $TGT_NS delete pvc -l cluster-name=acid-mig     # 必须删除失败尝试的数据
kubectl -n $TGT_NS delete secret \
  postgres.acid-mig.credentials.postgresql.acid.zalan.do \
  standby.acid-mig.credentials.postgresql.acid.zalan.do
```

然后重新应用备用清单。

### 备用卡在 `creating replica`

基础备份仍在复制（大型数据库——检查网络吞吐量）或无法连接。验证步骤 2 的可达性 *从备用 pod 所在的节点*；每个节点的出口差异是一个真实的故障模式。还要确认引导密钥包含当前源管理员密码。

### 备用日志中的复制槽错误（`TypeError ... 'int' and 'NoneType'`）

已知的 Patroni 问题；复制通常会继续。请参见 [热备用指南的故障排除部分](./How_to_Use_PostgreSQL_Hot_Standby_Cluster.md#troubleshooting)——如有需要，删除 `xdc_hotstandby` 槽。

## 验证检查表

| 检查                                | 何时                   | 通过条件                                                           |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| 网络预检                            | 步骤 3 之前            | 目标覆盖 pod 可以访问 `SRC_NODE_IP:NODEPORT`                      |
| 操作员版本                          | 步骤 3 之前            | 两个集群上的版本相同                                               |
| 共享系统标识符                     | 步骤 3 之后            | `patronictl list` 标识符在两侧相等                                 |
| 流复制                              | 步骤 3 之后            | 目标 `Standby Leader / streaming`；源槽 `xdc_hotstandby` 活动     |
| 校验和（切换前）                    | 步骤 4                 | 所有值与基线匹配                                                  |
| LSN 一致性                          | 步骤 5，停止写入      | `pg_current_wal_lsn()` == `pg_last_wal_replay_lsn()`               |
| 提升                                | 步骤 5                 | Patroni Leader 运行 + CR 运行 + 副本流式传输                      |
| 校验和（切换后）                    | 步骤 5                 | 所有值与基线匹配；目标上的新写入成功                               |
| 反向复制（如果源保留）              | 步骤 6                 | 目标写入出现在降级的源上                                         |
