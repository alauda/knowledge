---
kind:
  - How To
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - 4.2.x
id: KB260600102
sourceSHA: df50df7121edfbe8e516d3788f080b096f8db607b747763e2980f6f3b214916e
---

# 如何部署带有嵌入式 ClickHouse Keeper 的复制 ClickHouse 集群

## 目的

本文档解释了如何部署一个使用 ClickHouse Keeper 而不是外部 ZooKeeper 集群的复制 ClickHouse 集群，使用 Alauda 容器平台上的 ClickHouse Operator。Keeper 嵌入在每个 ClickHouse Pod 内部，因此无需部署或操作单独的协调工作负载。

这种拓扑非常适合日志存储场景，其中小型复制集群和最小操作负载是优先考虑的。

操作步骤包括：

- 选择协调拓扑（外部 ZooKeeper 或嵌入式 Keeper）。
- 部署带有嵌入式 Keeper 的 `ClickHouseInstallation`。
- 验证 Keeper 的法定人数和表复制。
- 日志存储工作负载的推荐 ClickHouse 设置。

## 环境

- Alauda 容器平台 4.2 或更高版本
- 随平台提供的 ClickHouse Operator — `clickhouse-operator` 组件（在 ACP 4.2 上验证的镜像为 `clickhouse-operator:v4.2.3`）
- ClickHouse Server 23.x 或更高版本（ClickHouse Keeper 已捆绑在服务器镜像中；在 25.x 上验证）
- 通过 `kubectl` 访问集群

## 解决方案

### 1. 概述

复制表（`ReplicatedMergeTree` 系列）和 ClickHouse 中的 `ON CLUSTER` DDL 需要一个协调服务。ClickHouse Keeper 是在 ClickHouse 内部实现的与 ZooKeeper 兼容的替代品：它使用 ZooKeeper 客户端协议，使用 Raft 而不是 ZAB，并且可以与 ClickHouse 服务器在同一进程或 Pod 中运行。

在 Kubernetes 上可以使用两种拓扑：

| 拓扑                          | 描述                                                                                                           | 权衡                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 外部 ZooKeeper                | 一个单独的 ZooKeeper StatefulSet（3 个节点）；`ClickHouseInstallation` 指向 `zookeeper:2181`                | 成熟且经过实战检验，但需要操作一个额外的有状态工作负载                                          |
| 嵌入式 Keeper（本文档）      | 每个 ClickHouse Pod 还运行一个 Keeper Raft 成员；`ClickHouseInstallation` 指向其自己的 Keeper 服务       | 仅一个工作负载；Keeper 与 ClickHouse 共享 Pod 资源，二者的扩展是耦合的                         |

操作员消耗一个与 Keeper 相关的字段 `spec.configuration.zookeeper`，并通过它将 ClickHouse 指向协调端点。这在 ClickHouse Keeper 上保持不变，因为客户端协议是与 ZooKeeper 兼容的。

嵌入式拓扑的工作原理：

- 集群布局为 1 个分片 × 3 个副本，因此 3 个 ClickHouse Pods 形成一个 3 成员的 Keeper 法定人数（奇数成员数量可以容忍一个节点的丢失）。
- 通过 `ClickHouseInstallation` 的 `files` 机制，将静态的 `keeper_config.xml` 片段注入到每个分片中。
- Keeper 配置的动态部分 — `server_id` 和 `raft_configuration` 成员列表 — 依赖于 Pod 身份，因此由初始化容器在 Pod 启动时生成，并通过 `include_from` 引入。
- 一个专用的无头服务暴露 Keeper 客户端端口（9181），并且 `spec.configuration.zookeeper.nodes` 指向该服务。

### 2. 先决条件和所需环境变量

ClickHouse Operator 必须已经安装并监视目标命名空间。

本操作步骤中的每个清单和命令都使用以下环境变量进行参数化。首先设置所有变量；清单在应用之前通过 `envsubst` 渲染（步骤 4），因此每个变量必须被导出。

| 环境变量              | 描述                                             | 示例                  |
| --------------------- | ------------------------------------------------ | --------------------- |
| `NAMESPACE`           | ClickHouse 集群的命名空间                       | `<namespace>`         |
| `CHI_NAME`            | `ClickHouseInstallation` 资源的名称             | `<chi-name>`          |
| `CLUSTER_NAME`        | CHI 规范中的集群名称                           | `<cluster-name>`      |
| `CLICKHOUSE_IMAGE`    | ClickHouse 服务器镜像（Keeper 已捆绑在其中）   | `<clickhouse-image>`  |
| `STORAGE_CLASS`       | 数据卷的 StorageClass                           | `<storage-class>`     |
| `STORAGE_SIZE`        | 每个副本的 PVC 大小                             | `<storage-size>`      |

```bash
export NAMESPACE="<namespace>"
export CHI_NAME="<chi-name>"
export CLUSTER_NAME="<cluster-name>"
export CLICKHOUSE_IMAGE="<clickhouse-image>"
export STORAGE_CLASS="<storage-class>"
export STORAGE_SIZE="<storage-size>"
```

### 3. 创建 Keeper 客户端服务

副本通过一个无头服务访问 Keeper 法定人数，该服务选择此安装的所有就绪 ClickHouse Pods。`clickhouse.altinity.com/role: keeper` 标签由下一步的 Pod 模板添加到 Pods 中。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ${CHI_NAME}-keeper
  namespace: ${NAMESPACE}
spec:
  clusterIP: None
  type: ClusterIP
  ports:
    - name: keeper
      port: 9181
      protocol: TCP
      targetPort: 9181
  selector:
    clickhouse.altinity.com/chi: ${CHI_NAME}
    clickhouse.altinity.com/namespace: ${NAMESPACE}
    clickhouse.altinity.com/ready: "yes"
    clickhouse.altinity.com/role: keeper
```

### 4. 部署 ClickHouseInstallation

下面的清单部署 1 个分片 × 3 个副本，带有嵌入式 Keeper。关键点在清单后进行解释。

```yaml
apiVersion: "clickhouse.altinity.com/v1"
kind: "ClickHouseInstallation"
metadata:
  name: ${CHI_NAME}
  namespace: ${NAMESPACE}
spec:
  configuration:
    zookeeper:
      nodes:
        - host: ${CHI_NAME}-keeper
          port: 9181
    clusters:
      - name: ${CLUSTER_NAME}
        templates:
          podTemplate: pod-template
          dataVolumeClaimTemplate: data-volumeclaim-template
        layout:
          shardsCount: 1
          replicasCount: 3
          shards:
            - files:
                keeper_config.xml: |
                  <clickhouse>
                      <include_from>/tmp/clickhouse/keeper_dynamic_configuration.xml</include_from>
                      <keeper_server incl="keeper_server">
                          <path>/var/lib/clickhouse-keeper</path>
                          <tcp_port>9181</tcp_port>
                          <four_letter_word_white_list>*</four_letter_word_white_list>
                          <coordination_settings>
                              <raft_logs_level>information</raft_logs_level>
                          </coordination_settings>
                      </keeper_server>
                  </clickhouse>
    settings:
      # 保持系统表的边界；没有 TTL 时它们会无限增长。
      asynchronous_metric_log/database: system
      asynchronous_metric_log/table: asynchronous_metric_log
      asynchronous_metric_log/ttl: "event_date + INTERVAL 7 DAY DELETE"
      metric_log/database: system
      metric_log/table: metric_log
      metric_log/ttl: "event_date + INTERVAL 7 DAY DELETE"
      trace_log/database: system
      trace_log/table: trace_log
      trace_log/ttl: "event_date + INTERVAL 7 DAY DELETE"
    profiles:
      default/max_execution_time: 120
      default/allow_unrestricted_reads_from_keeper: "1"
  defaults:
    templates:
      podTemplate: pod-template
      dataVolumeClaimTemplate: data-volumeclaim-template
  templates:
    podTemplates:
      - name: pod-template
        podDistribution:
          - scope: Shard
            topologyKey: kubernetes.io/hostname
            type: ShardAntiAffinity
        metadata:
          labels:
            clickhouse.altinity.com/role: keeper
        spec:
          containers:
            - name: clickhouse
              image: ${CLICKHOUSE_IMAGE}
              env:
                - name: RAFT_PORT
                  value: "9444"
              ports:
                - name: http
                  containerPort: 8123
                - name: client
                  containerPort: 9000
                - name: interserver
                  containerPort: 9009
                - name: ch-keeper
                  containerPort: 9181
                - name: raft
                  containerPort: 9444
              volumeMounts:
                - name: data-volumeclaim-template
                  mountPath: /var/lib/clickhouse
                - name: keeper-dynamic-config
                  mountPath: /tmp/clickhouse
              readinessProbe:
                tcpSocket:
                  port: 9444
                initialDelaySeconds: 10
                timeoutSeconds: 5
                periodSeconds: 10
                failureThreshold: 3
          initContainers:
            - name: keeper-config-initializer
              image: ${CLICKHOUSE_IMAGE}
              env:
                - name: RAFT_PORT
                  value: "9444"
                - name: SHARDS_COUNT
                  value: "1"
                - name: REPLICAS_COUNT
                  value: "3"
              command:
                - /bin/bash
                - -c
                - |
                  set -euo pipefail
                  OUT="/tmp/config/keeper_dynamic_configuration.xml"

                  HOST=$(hostname -s)
                  DOMAIN=$(hostname -d)
                  # StatefulSet Pod 主机名：<chi>-<cluster>-<shard>-<replica>-<ordinal>
                  if [[ $HOST =~ (.*)-([0-9]+)-([0-9]+)-([0-9]+)$ ]]; then
                      SHARD=${BASH_REMATCH[2]}
                      REPLICA=${BASH_REMATCH[3]}
                  else
                      echo "无法从主机名 $HOST 解析分片/副本"; exit 1
                  fi
                  # Pod FQDN 域名：<chi>-<cluster>-<shard>-<replica>.<namespace>.svc.<zone>
                  if [[ $DOMAIN =~ ^(.*)-([0-9]+)-([0-9]+)\.(.*)$ ]]; then
                      DOMAIN_NAME=${BASH_REMATCH[1]}
                      DOMAIN_SUFFIX=.${BASH_REMATCH[4]}
                  else
                      echo "无法解析域名 $DOMAIN"; exit 1
                  fi

                  MY_ID=$((SHARD * REPLICAS_COUNT + REPLICA + 1))
                  KEEPER_ID=1
                  {
                    echo "<clickhouse>"
                    echo "  <keeper_server>"
                    echo "    <server_id>${MY_ID}</server_id>"
                    echo "    <raft_configuration>"
                    for (( i=0; i<SHARDS_COUNT; i++ )); do
                        for (( j=0; j<REPLICAS_COUNT; j++ )); do
                            echo "      <server>"
                            echo "        <id>${KEEPER_ID}</id>"
                            echo "        <hostname>${DOMAIN_NAME}-${i}-${j}${DOMAIN_SUFFIX}</hostname>"
                            echo "        <port>${RAFT_PORT}</port>"
                            echo "      </server>"
                            KEEPER_ID=$((KEEPER_ID + 1))
                        done
                    done
                    echo "    </raft_configuration>"
                    echo "  </keeper_server>"
                    echo "</clickhouse>"
                  } > "$OUT"
                  echo "为 server_id=${MY_ID} 生成了 Keeper 动态配置"
              volumeMounts:
                - name: keeper-dynamic-config
                  mountPath: /tmp/config
          volumes:
            - name: keeper-dynamic-config
              emptyDir:
                medium: Memory
    serviceTemplates:
      - name: replica-service-template
        spec:
          type: ClusterIP
          ports:
            - name: http
              port: 8123
            - name: tcp
              port: 9000
            - name: interserver
              port: 9009
            - name: clickhouse-keeper
              port: 9181
            - name: raft
              port: 9444
    volumeClaimTemplates:
      - name: data-volumeclaim-template
        spec:
          accessModes:
            - ReadWriteOnce
          storageClassName: ${STORAGE_CLASS}
          resources:
            requests:
              storage: ${STORAGE_SIZE}
```

关键点：

- **法定人数和布局。** `shardsCount: 1` 和 `replicasCount: 3` 生成 3 个 Pods，每个都是 Keeper Raft 成员。保持奇数成员数量；3 个成员可以容忍一次故障。初始化容器通过循环遍历 **SHARDS_COUNT** 和 **REPLICAS_COUNT** 来构建成员列表，因此如果更改布局，必须更新两个环境值以匹配 `shardsCount`/`replicasCount` — 否则生成的 `raft_configuration` 将被截断。`server_id` 公式 `SHARD * REPLICAS_COUNT + REPLICA + 1` 只要两个值与实际布局匹配就保持唯一。
- **嵌入式 Keeper 适合小型集群。** 每个分片副本都成为 Keeper 投票者，因此 2 个分片 × 3 个副本的布局意味着 6 个成员的法定人数。Keeper 在小型奇数法定人数（3 或 5）下表现最佳。对于具有多个分片的集群，运行一个专用的 3 或 5 节点外部 ZooKeeper 集群，并将 `spec.configuration.zookeeper.nodes` 指向它，而不是随着每个数据 Pod 增加法定人数。
- **静态与动态 Keeper 配置。** 静态部分（`tcp_port`、数据 `path`、协调设置）通过 `layout.shards[].files` 每个分片注入。身份相关的部分（`server_id`、`raft_configuration`）由初始化容器生成到内存中的 `emptyDir` 中，并通过 `include_from` 合并。因此，布局更改只需更新 `SHARDS_COUNT`/`REPLICAS_COUNT` 环境值，而无需编辑静态片段。
- **协调端点。** `spec.configuration.zookeeper.nodes` 指向 Keeper 服务的 9181 端口。操作员将其渲染到服务器的 `zookeeper` 配置中；ClickHouse 不需要知道后端是 ZooKeeper 还是 Keeper。
- **反亲和性。** 在 `kubernetes.io/hostname` 上的 `ShardAntiAffinity` 将副本（因此 Keeper 成员）分散到节点上，因此单个节点故障不会破坏法定人数。
- **就绪性。** 就绪探针检查 Raft 端口（9444），因此 Pod 仅在其 Keeper 成员启动后才变为就绪。
- **每副本服务端口。** 副本服务模板除了 ClickHouse 端口外，还暴露 9181 和 9444，因此法定成员可以通过其每个副本的 DNS 名称相互访问。

将步骤 3 中的服务保存为 `keeper-service.yaml`，将上述 `ClickHouseInstallation` 保存为 `chi.yaml`，然后渲染并应用它们。将显式变量列表传递给 `envsubst`，以便它仅替换配置变量，并保持初始化容器的运行时 shell 变量（如 `${MY_ID}`、`${SHARD}` 和 `${RAFT_PORT}`）不变：

```bash
RENDER_VARS='${NAMESPACE} ${CHI_NAME} ${CLUSTER_NAME} ${CLICKHOUSE_IMAGE} ${STORAGE_CLASS} ${STORAGE_SIZE}'
envsubst "$RENDER_VARS" < keeper-service.yaml | kubectl apply -n "$NAMESPACE" -f -
envsubst "$RENDER_VARS" < chi.yaml | kubectl apply -n "$NAMESPACE" -f -
```

### 5. 验证 Keeper 法定人数

等待 CHI 达到 `Completed` 状态：

```bash
kubectl -n "$NAMESPACE" get clickhouseinstallation "$CHI_NAME" -w
```

使用专用的 `clickhouse-keeper-client` CLI（捆绑在 ClickHouse 服务器镜像中）确认嵌入式 Keeper 在 Pod 上的响应：

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-keeper-client -h localhost -p 9181 -q "ls /"
```

健康的 Keeper 返回其根 znodes（例如 `keeper clickhouse`）。

检查 Raft 角色和法定人数。这里的 `mntr` 命令是 **ClickHouse Keeper 自己的** 四字词（4lw）实现 — 它由 Keeper Raft 引擎提供，而不是由任何 ZooKeeper 进程提供，并且是 `keeper_config.xml` 中的 `four_letter_word_white_list` 所启用的。以 `zk_` 开头的键仅保留，以便现有监控工具可以解析输出：

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  bash -c 'exec 3<>/dev/tcp/localhost/9181; printf mntr >&3; cat <&3' | egrep 'zk_server_state|zk_synced_followers'
```

预期输出：恰好一个 Pod 报告 `zk_server_state  leader` 和 `zk_synced_followers  2`；其他两个报告 `follower`。

确认 ClickHouse 服务器已连接到 Keeper 法定人数。客户端视图通过 `system.zookeeper_connection` 暴露 — 该表保留历史 `zookeeper` 名称，但报告 Keeper 端点，并且在 Keeper 上的工作方式不变：

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-client -q "SELECT * FROM system.zookeeper_connection FORMAT Vertical"
```

报告的 `host` 必须是 Keeper 服务（`${CHI_NAME}-keeper`）的 9181 端口。

### 6. 验证复制

在集群中创建一个复制表，在一个副本上写入，并在另一个副本上读取：

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- clickhouse-client -q "
CREATE TABLE default.keeper_smoke ON CLUSTER '${CLUSTER_NAME}'
(ts DateTime, msg String)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{cluster}/{shard}/default/keeper_smoke', '{replica}')
ORDER BY ts"

kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-client -q "INSERT INTO default.keeper_smoke VALUES (now(), 'hello')"

kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-1-0 -c clickhouse -- \
  clickhouse-client -q "SELECT count() FROM default.keeper_smoke"
```

第二个副本上的计数必须为 `1`。还要确认副本健康：

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-client -q "SELECT database, table, is_readonly, absolute_delay FROM system.replicas"
```

`is_readonly` 必须为 `0`，`absolute_delay` 接近 `0`。之后清理烟雾测试表：

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-client -q "DROP TABLE default.keeper_smoke ON CLUSTER '${CLUSTER_NAME}' SYNC"
```

### 7. 日志存储工作负载的推荐设置

上述清单已经包含了对日志存储最重要的设置。理由和其他选项：

| 设置                                                            | 推荐                                                         | 原因                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `asynchronous_metric_log/ttl`、`metric_log/ttl`、`trace_log/ttl` | 7 天 `DELETE` TTL                                            | 自观察系统表默认无限增长，最终会填满数据卷                                                          |
| `default/max_execution_time`                                   | 120 秒                                                      | 防止单个慢查询在小型集群上阻塞摄取                                                                    |
| `default/allow_unrestricted_reads_from_keeper`                 | `1`（可选）                                                 | 允许广泛的 `system.zookeeper` 读取以进行故障排除；风险较低                                          |
| `default/max_parallel_replicas`                                | 与副本数量匹配（可选）                                     | 可以加速单分片、多副本布局上的读取                                                                    |
| 日志表上的表 TTL                                             | 按类别保留（例如 `event_date + INTERVAL 7 DAY DELETE`）   | 保留是日志数据的主要容量控制                                                                         |
| 配额（`interval/duration`、`interval/queries`）               | 可选的保护措施                                             | 限制每个用户的查询量                                                                                 |

嵌入式拓扑的约束和权衡：

- Keeper 与 ClickHouse 服务器共享 CPU、内存和磁盘 I/O。为两者调整 Pod 资源，并将 Keeper 数据路径（`/var/lib/clickhouse-keeper`）放在同一持久卷上。
- 副本数量和法定人数大小是耦合的。不要将副本扩展到偶数或少于 3，并保持初始化容器中的 `REPLICAS_COUNT` 与布局同步。
- 滚动重启会与 ClickHouse 一起重启 Keeper 成员。操作员的默认 `maxUnavailable` 行为（一次一个主机）保持法定人数存活；不要强制并行重启。

如果您需要 Keeper 和 ClickHouse 独立扩展，或者您在共享协调服务上运行多个 ClickHouse 安装，请部署一个单独的 3 节点外部 ZooKeeper 集群，并将 `spec.configuration.zookeeper.nodes` 指向它；本文档中的其他内容保持不变。
