---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500095
sourceSHA: 22946602fd053867ad56641a5c11009970009a4f00a29b22bb9d450286020e3e
---

# 在 Kubernetes 集群之间迁移 Redis 数据

:::info 适用版本
- 平台 **4.x**，**redis-operator 5.1** 或更高版本。源端为 Redis 7.x 时，需要晚于 **5.1.1** 的 redis-operator 版本，参见[选择迁移模式](#choose-a-migration-mode)。
- 平台 **3.8.x – 3.16.x**：操作步骤相同，但需要自行指定镜像，并且只支持 Redis 5.x 和 6.x。参见[附录：平台 3.x](#appendix-platform-3x)。
:::

## 介绍

本文介绍如何使用平台内置的、基于 **RedisShake** 的迁移功能，把数据从一个 Redis 实例复制到另一个 Redis 实例，两个实例可以位于不同的 Kubernetes 集群中。一次迁移用一个 `RedisShake` 自定义资源描述，由 redis-operator 执行。源端和目标端都可以是以下任意一种架构：

| 架构 | 说明 |
| --- | --- |
| `standalone` | 单节点 Redis |
| `sentinel` | 基于 Sentinel 的主从实例 |
| `cluster` | 分片的 Redis Cluster |

`RedisShake` 资源有两种运行模式：

- **`sync`**：先复制全量数据，再持续同步源端的每一次写入。它不会自行结束，删除资源后才会停止。适用于切换之前源端必须持续提供服务的场景。
- **`rump`**：扫描源端，把所有 key 复制一次后结束。某个 key 复制完成后，源端对它的写入不会同步到目标端。适用于整个复制期间都可以停止源端写入的场景。

## 选择迁移模式 {#choose-a-migration-mode}

| 源端 Redis | 目标端 Redis | 模式 |
| --- | --- | --- |
| 5.x 或 6.x | 6.x 或 7.2 | `sync` |
| 7.0 或 7.2 | 7.2 | redis-operator 晚于 5.1.1 时使用 `sync`；更早的版本使用 `rump` |
| 7.x | 5.x 或 6.x | 不支持 |
| 7.4 或更高版本 | 任意 | 不支持 |

redis-operator 5.1.1 之后的版本中，RedisShake 才支持 Redis 7.0 和 7.2 的 RDB 格式。起决定作用的是创建 `RedisShake` 资源的那个集群中的 redis-operator，因为迁移 pod 使用的是该 operator 自带的 RedisShake 镜像。如果那里的 redis-operator 版本更早，从 Redis 7.x 源端发起的 `sync` 迁移会立即失败，目标端保持为空，`redis-shake` 容器日志中会出现：

```text
[PANIC] parse rdb header error
[error]: verify version, invalid RDB version number 11, 9
```

遇到这种情况，可以升级 redis-operator，也可以删除该资源，再以 `modelType: rump` 重新创建。

## 前提条件

1. **容量。** 目标端的内存必须能容纳源端的数据集：
   - 目标端为 Sentinel：至少为**源端数据集大小的 5/4**。
   - 目标端为集群、源端为单节点或 Sentinel：至少为**源端数据集大小的 5/4**。
   - 目标端为集群、源端也为集群：至少为**源端最大分片数据集大小的 5/4**。
2. **迁移的运行位置。** 在安装了 redis-operator 的集群中创建 `RedisShake` 资源，通常是目标端所在的集群。迁移 pod 必须能通过稳定的 IPv4 网络访问两个实例。
3. **外部访问。** 如果实例与 `RedisShake` 资源不在同一个集群中，该实例必须开启 NodePort 或 LoadBalancer 访问：
   - 集群实例：RedisShake 按每个分片对外宣告的地址连接各个分片，因此集群内地址在其他集群中无法使用。
   - Sentinel 实例：数据节点（`spec.expose.type`）和 Sentinel 节点（`spec.sentinel.expose.type`）都要开启外部访问。RedisShake 先向 Sentinel 查询主节点的地址，再连接该主节点。
4. **数据库。** Redis Cluster 只有 0 号数据库。目标端为集群时，源端其他数据库中的 key 会被**跳过，且不报任何错误**。迁移到集群之前，请在源端执行 `INFO keyspace`，确认所有 key 都在 `db0` 中。
5. **Redis 函数。** 函数库（Redis 7 的 `FUNCTION LOAD`）不会被迁移。请在目标端单独加载，例如在源端执行 `FUNCTION DUMP`，再在目标端执行 `FUNCTION RESTORE`。
6. **写入。** 减少源端的写入，以降低复制压力。使用 `rump` 时，整个复制期间都要停止写入。

## 迁移步骤

### 1. 创建密码 Secret

如果某一端设置了密码，请在创建 `RedisShake` 资源的命名空间中为它创建一个 Secret，数据键为 `password`：

```bash
kubectl -n <namespace> create secret generic <secret-name> \
  --from-literal=password=<password>
```

### 2. 查找地址

在 **数据服务 > 实例详情 > 访问方式 > 集群内访问 / 外部访问** 中找到访问端点，再按架构和角色把每个地址写成对应的格式：

| 架构 | 作为源端 | 作为目标端 |
| --- | --- | --- |
| `standalone` | `<host>:<port>` | `<host>:<port>` |
| `sentinel` | `mymaster@<sentinel-host>:<sentinel-port>` | `mymaster@<sentinel-host>:<sentinel-port>` |
| `cluster` | `master@<host>:<port>` | `<host>:<port>` |

- Sentinel 实例使用 **Sentinel** 端点。`mymaster` 是平台为每个 Sentinel 实例设置的主节点名称。
- 集群实例只需填写任意一个节点的端点，RedisShake 会自动发现其他分片。只有作为**源端**的集群才需要 `master@` 前缀。

:::warning
如果实例的 Sentinel 节点设置了独立的密码（`spec.sentinel.passwordSecret`），无论用作源端还是目标端，`mymaster@` 地址都无法使用：RedisShake 无法通过 Sentinel 的认证，日志中会出现 `no sentinels available; last error: NOAUTH Authentication required.`。此时请直接连接数据节点：设置 `type: standalone`，使用**数据节点**密码的 Secret，并使用读写 Service `rfr-<instance-name>-read-write` 的外部地址。查看它的 NodePort：

```bash
kubectl -n <instance-namespace> get svc rfr-<instance-name>-read-write \
  -o jsonpath='{.spec.ports[0].nodePort}'
```
:::

### 3. 创建 RedisShake 资源

```yaml
apiVersion: middle.alauda.cn/v1alpha1
kind: RedisShake
metadata:
  name: <migration-name>
  namespace: <namespace>
spec:
  modelType: sync            # 或 rump，参见“选择迁移模式”
  keyExists: rewrite         # 覆盖目标端已存在的 key
  source:
    type: sentinel           # standalone、sentinel 或 cluster
    address:
      - "mymaster@<source-sentinel-host>:<source-sentinel-port>"
    passwordSecret: <source-password-secret>
  target:
    type: cluster            # standalone、sentinel 或 cluster
    address:
      - "<target-host>:<target-port>"
    passwordSecret: <target-password-secret>
  resources:                 # 可选
    requests:
      cpu: "2"
      memory: 2Gi
    limits:
      cpu: "4"
      memory: 4Gi
```

- 按实际场景修改 `source` 和 `target`，地址格式见第 2 步。
- 不要设置 `image`：redis-operator 5.1 及更高版本会使用该 operator 自带的 RedisShake 镜像。
- `keyExists` 还可以取 `ignore`，即保留目标端的值；或取 `none`，即遇到第一个在目标端已存在的 key 时停止迁移。默认值为 `none`。
- 不设置 `resources` 时，迁移 pod 的请求为 500m CPU 和 500Mi 内存，上限为 1 CPU 和 1Gi。数据集较大时，请分配 2–8 个 CPU，可以从 4 个开始。

使用 `kubectl apply -f` 应用该文件，或在平台界面中创建该资源。随后 redis-operator 会创建工作负载 `<migration-name>-shake`：`sync` 模式为 Deployment，`rump` 模式为 Job。

### 4. 监控迁移

查看迁移 pod 及其日志：

```bash
kubectl -n <namespace> get pods | grep <migration-name>-shake
kubectl -n <namespace> logs deploy/<migration-name>-shake -c redis-shake --tail=50   # sync
kubectl -n <namespace> logs job/<migration-name>-shake -c redis-shake --tail=50      # rump
```

- **`sync`**：日志中出现 `DbSyncer[0] sync rdb done`，表示全量复制已完成，增量同步已开始。源端为集群时，每个源端分片对应一个 `DbSyncer`。
- **`rump`**：Job 完成，日志以 `all rumpers finish!` 结尾。

`sync` 迁移还会在 9320 端口提供 Prometheus 指标：

```bash
kubectl get --raw "/api/v1/namespaces/<namespace>/pods/<pod-name>:9320/proxy/metrics" \
  | grep -E 'redisshake_(full_sync_process_percent|fake_slave_delay_offset)'
```

| 指标 | 含义 |
| --- | --- |
| `redisshake_full_sync_process_percent` | 全量复制的进度，完成时为 `100`。每个源端分片一条时间序列，标签为 `db_syncer`。 |
| `redisshake_fake_slave_delay_offset` | 目标端落后于源端的字节数。即使没有写入，复制心跳也会让它在 `0` 到 150 左右之间变化；暂停写入后，如果它反复回到 `0`，说明目标端已经追上源端。 |

redis-operator 还会在它自己所在的命名空间中创建名为 `redis-shake` 的 ServiceMonitor，供平台的 Prometheus 采集这些指标。平台没有为这些指标提供 Grafana 仪表板。

### 5. 校验数据

暂停源端写入后，比较两端的 key 数量。请通过 `REDISCLI_AUTH` 环境变量传入密码，以免密码出现在命令行中：

```bash
# 单节点或 Sentinel：在主节点上执行
REDISCLI_AUTH=<password> redis-cli -h <host> -p <port> dbsize

# 集群：每个主节点输出一行，把它们相加
REDISCLI_AUTH=<password> redis-cli --cluster call <host>:<port> dbsize --cluster-only-masters
```

设置了过期时间的 key 可能使两端的数量略有差异，因为两端各自按自己的节奏让 key 过期。

### 6. 切换与清理

1. 暂停源端写入。
2. 对于 `sync`，等待 `redisshake_fake_slave_delay_offset` 稳定在 `0`，再次比较 key 数量。
3. 把应用切换到目标端。
4. 删除该资源。这会同时删除 Deployment 或 Job，以及它的 ConfigMap 和 Service：

   ```bash
   kubectl -n <namespace> delete redisshake <migration-name>
   ```

5. 如果不再需要密码 Secret，将它们删除。

## 修改运行中的迁移

对运行中的 `RedisShake` 资源所做的修改，只有一部分会生效：

- **会生效**：迁移 pod 的字段，例如 `resources`、`nodeSelector`、`tolerations` 和 `affinity`。redis-operator 会更新 Deployment，pod 随之重启。
- **不会生效**：`source`、`target`、`filter`、`keyExists`、`parallel` 以及其他迁移设置。这些设置只在创建资源时写入 ConfigMap。

要修改迁移设置，请删除该资源后重新创建。`rump` 的 Job 从不更新；要再次执行，请删除并重新创建该资源。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `redis-shake` 日志中出现 `invalid RDB version number 11, 9`（或 `10, 9`），容器随之重启 | RedisShake 镜像早于支持 Redis 7.x 的版本 | 把 redis-operator 升级到晚于 5.1.1 的版本，或使用 `modelType: rump` |
| `no sentinels available; last error: NOAUTH Authentication required.` | Sentinel 节点设置了独立的密码 | 按第 2 步的说明，直接连接数据节点 |
| 出现 `target key name is busy`，容器随之重启 | `keyExists` 为 `none`，且该 key 已存在于目标端 | 设置 `keyExists: rewrite` 或 `ignore`，或先清空目标端 |
| operator 日志中出现 `spec.template.spec.containers[0].image: Required value`，且没有迁移 pod | 早于 5.1 的 redis-operator 不会自动填写镜像 | 把 `spec.image` 设置为对应版本的 RedisShake 镜像 |
| `shake-init` 容器日志显示 `Could not connect to Redis at mymaster@...: Name does not resolve` | 初始化脚本也会把 Sentinel 格式的地址当作主机名尝试连接 | 无需处理，该信息无害 |
| 集群目标端缺少源端 0 号以外数据库中的 key | Redis Cluster 只有 0 号数据库 | 迁移前在源端把这些 key 移到 0 号数据库 |

## 重要注意事项

- **复制不会自动停止。** `sync` 迁移会一直运行，直到删除该资源。切换之前务必先校验数据。
- **集群目标端上的消费组。** 迁移开始时源端已有的消费组会随 stream 一起复制。但迁移到集群目标端*期间*，在源端执行的 `XGROUP` 命令可能被发往错误的分片，因此这期间创建的消费组可能在目标端缺失，且没有任何报错。请在开始迁移之前创建消费组，或在切换后到目标端重新创建。
- **不支持 Redis 7.4 及更高版本。** 它们的 RDB 格式不受支持，迁移会立即停止。
- **不支持迁移到更低版本的 Redis。** Redis 7.x 源端不能迁移到 5.x 或 6.x 目标端。
- **网络稳定性。** 两端之间持续的网络不稳定会导致复制反复重启、延迟不断增大。开始迁移之前，请确保连接稳定。

## 附录：平台 3.x {#appendix-platform-3x}

在平台 3.8.x – 3.16.x 上，上述步骤同样适用，区别如下。

**设置镜像。** 在资源中添加 `spec.image`，使用与平台版本对应的镜像：

| ACP 版本 | RedisShake 镜像 |
| --- | --- |
| 3.8.1 - 3.8.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2` |
| 3.10.1 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2` |
| 3.10.2, 3.10.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.3` |
| 3.12.1 - 3.12.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-5ad6d091` |
| 3.14.1, 3.14.2 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-063e3b5d` |
| 3.16.1 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-9bb65a7b` |
| 3.16.2 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-3777a73b` |

**Redis 版本。** 源端和目标端都只支持 Redis 5.x 和 6.x。

**监控。** 从 3.10.2 起，可以在 **平台管理 > 操作中心 > 监控 > Grafana > 仪表板** 下使用 Grafana 仪表板 **"Redis Shake Dashboard"**。全量复制完成时，其面板 `SyncProcessPercent` 达到 `100`；目标端追上源端时，`SlaveDelayOffset` 回到 `0`。3.10.2 之前没有该仪表板，请改为比较 key 数量。

**已知问题。** 在 3.16.0 和 3.16.1 上，源端为 Sentinel 实例时，即使实例运行正常，源实例的状态也可能显示为 `Processing`。该问题已在 3.16.2 中修复。
