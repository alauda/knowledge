---
products:
  - Alauda Application Services
kind:
  - Solution
---

# aKafka 性能测试指南

## 1. 目的和适用范围

本文用于在 Alauda Container Platform（ACP）上对 aKafka 实例执行可重复、可审计的性能测试，并回答以下问题：

本文沿用 Apache Kafka 官方术语：服务端代理节点（Broker）、主题（Topic）、控制器（Controller）和同步副本集合（in-sync replicas，ISR）。

- 在给定副本、确认和压缩策略下，实例可持续处理的生产、消费吞吐量是多少；
- 在延迟、错误率、副本同步和资源水位满足约束时，实例的可用容量是多少；
- 瓶颈位于客户端、Broker 的 CPU/内存/网络、持久卷，还是分区与副本布局；
- 调整实例或客户端参数后，结果是否可比，收益是否可复现。

本文的命令按 Apache Kafka 4.2.0 的脚本接口编写。其他版本必须先保存 `--version` 和 `--help` 输出，再按该版本支持的参数调整。特别是，Kafka 4.2 的 `kafka-consumer-perf-test.sh` 没有旧版本的 `--threads` 参数；需要并发时，应增加独立进程或 Pod。

本文不提供跨环境通用的“最佳吞吐量”或“最佳参数”。硬件、存储、网络、消息大小、压缩率、可靠性策略和业务负载任一项变化，结果都可能失去可比性。

> **风险提示**：压测会大量写入数据，并可能耗尽磁盘、网络或节点资源。只在获得授权的隔离实例、命名空间和时间窗口内执行。不要在承载生产流量的实例上寻找饱和点。

## 2. 结果口径

测试前必须选择一种负载模式和一种可靠性配置。不同配置的结果不得合并比较。

### 2.1 负载模式

| 模式 | 目的 | 执行方式 | 主要结果 |
| --- | --- | --- | --- |
| 生产者单测 | 测量写入能力 | 只运行生产者 | records/s、MiB/s、生产确认延迟 |
| 消费者单测 | 测量读取能力 | 先准备足量存量数据，再运行消费者 | records/s、MiB/s、消费组积压 |
| 生产与消费并发 | 模拟持续流转 | 先启动消费者，再启动生产者 | 两端吞吐量、积压增长、Broker 资源和稳定性 |

生产者脚本报告的延迟是生产请求确认延迟，不是业务端到端延迟。消费者脚本报告吞吐量，但不提供消息从生产到消费的端到端延迟。端到端延迟必须在消息中写入发送时间戳，并由业务压测程序在消费端计算；不要用两段脚本输出相减代替。

### 2.2 可靠性配置

| 配置 | Topic | 生产者 | 用途 |
| --- | --- | --- | --- |
| 生产可靠性基线 | `replication.factor=3`、`min.insync.replicas=2` | `acks=all`、`enable.idempotence=true` | 容量规划和生产验收的默认配置 |
| Leader 确认上限 | `replication.factor=3`，其余参数与被测基线一致 | `acks=1`、`enable.idempotence=false` | 估算降低确认强度后的吞吐上限 |

`acks=1` 只等待 Leader 确认；Leader 随后立即故障时，尚未复制的数据可能丢失。Kafka 的幂等生产要求 `acks=all`，因此执行 `acks=1` 测试时必须显式设置 `enable.idempotence=false`，避免客户端配置冲突。容量结论必须标注可靠性配置，不能把 Leader 确认上限作为生产可靠性容量。

### 2.3 访问路径

外部连接可能使用传输层安全性（Transport Layer Security，TLS）和简单认证与安全层（Simple Authentication and Security Layer，SASL）；测试必须使用与业务计划相同的安全配置。

| 访问路径 | 客户端位置 | 结果包含的约束 | 使用场景 |
| --- | --- | --- | --- |
| 集群内容量 | 业务集群内的专用压测节点，通过内部 Bootstrap Service 连接 | Kafka、集群网络和存储 | 实例容量和调参，本文命令默认使用该路径 |
| 外部端到端 | 客户指定的源集群或主机，通过实际外部监听器连接 | 以上约束，加上负载均衡器、广域网、防火墙、TLS/SASL 和客户端出口 | 业务接入验收 |

两种路径的结果不能合并。外部端到端测试必须保存客户端位置、监听器、往返时延、丢包和网络路径，并确认客户端不仅能访问 Bootstrap 地址，还能访问 Kafka 元数据中公布的每个 Broker 地址。完成 4.3 节的变量初始化后，从当前资源状态读取监听器地址，不应按命名规则推测：

```bash
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{range .status.listeners[*]}{.name}{"\t"}{.bootstrapServers}{"\n"}{end}'
```

## 3. 标准测试矩阵

先执行标准矩阵以获得横向可比的数据，再补充与真实业务一致的消息模型、连接安全和并发模式。

### 3.1 实例和消息矩阵

| Broker 资源规格 | Broker 数量 | Topic 分区 | 副本数 | 消息大小 |
| --- | ---: | ---: | ---: | --- |
| 1 vCPU / 2 GiB | 3 | 30 | 3 | 100 B、500 B、1000 B |
| 2 vCPU / 4 GiB | 3 | 30 | 3 | 100 B、500 B、1000 B |
| 4 vCPU / 8 GiB | 3 | 30 | 3 | 100 B、500 B、1000 B |
| 8 vCPU / 16 GiB | 3 | 30 | 3 | 100 B、500 B、1000 B |

标准点位使用以下记录数：

- 1、2、4 vCPU：每个消息大小发送 50,000,000 条；
- 8 vCPU：100 B 和 500 B 各发送 100,000,000 条，1000 B 发送 50,000,000 条。

标准生产者点先使用 1 个生产者进程；如果第 12 节证明客户端先达到上限，则增加进程并把聚合结果单独标记。标准消费者点的目标并发为 20 个消费者。Kafka 4.2 不再提供旧版脚本的 `--threads 20`，因此应运行 20 个独立进程，并让它们使用同一消费组；这些进程可分布到多个资源充足的 Pod，但必须记录每个 Pod 的进程数和资源。

如果测试窗口或磁盘容量不足，可以减少记录数，但每个稳态点应持续至少 10 分钟，并在报告中记录实际记录数和持续时间。短时突发结果不能替代稳态容量。

### 3.2 业务补充矩阵

标准矩阵之外，至少增加一组与生产计划一致的配置：

- 消息大小分布，而不是只使用平均值；
- 消息键（record key）分布和分区策略；
- `compression.type`；
- TLS、SASL 等连接安全；
- 生产者和消费者实例数；
- Topic 数量、分区数、副本数和保留时间；
- 实际的突发与空闲周期。

如果没有业务分布数据，应将结论标记为“合成负载结果”，不能推断为业务容量。

## 4. 测试前置条件

### 4.1 环境隔离

1. 创建专用命名空间、aKafka 实例、Topic、消费组和压测客户端。
2. Broker 应分散到不同 Kubernetes 节点；压测客户端不要与 Broker 共用节点，否则客户端争抢资源会污染结果。
3. 测试期间不得运行扩缩容、版本升级、节点维护、存储迁移或其他高负载任务。
4. 节点和持久卷类型必须与目标环境一致。生产容量测试优先使用本地块存储或经验证的块存储；不要把未经验证的共享文件存储结果外推到块存储环境。
5. 每组实例参数测试使用新实例，或在清理 Topic 后等待实例恢复稳定。修改需要重启的参数后，必须等待所有 Pod Ready、副本同步完成，再开始下一轮。

### 4.2 必需工具和权限

- 可访问业务集群的 `kubectl`；
- 对测试命名空间内 aKafka、Pod、ConfigMap、Secret、Service 和持久卷声明（PersistentVolumeClaim，PVC）的必要权限；
- 可读取平台监控或 Prometheus 时序数据；
- 可从已部署 Broker Pod 读取其 Kafka 镜像名称。本文复用 Operator 管理的 Kafka 镜像，不要求任何私有镜像名称；
- 用于 SASL/TLS 的客户端配置 Secret。报告不得包含密码、令牌、私钥或完整 Secret。

### 4.3 建立证据目录

在同一个 Bash 会话中执行以下初始化；后续代码块沿用这些变量和错误处理选项：

```bash
set -euo pipefail

export KUBECONFIG=/path/to/business-cluster.kubeconfig
export NS=akafka-perf
export CLUSTER=perf-kafka
export TOPIC=perf-rf3-p30
export GROUP="perf-$(date -u +%Y%m%dT%H%M%SZ)"
export RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${CLUSTER}"
export OUT="$(pwd)/akafka-perf-${RUN_ID}"
mkdir -p "$OUT"

kubectl version -o yaml >"$OUT/kubectl-version.yaml"
kubectl cluster-info >"$OUT/cluster-info.txt"
kubectl get nodes -o wide >"$OUT/nodes.txt"
kubectl get storageclass -o yaml >"$OUT/storageclasses.yaml"
```

只导出非敏感元数据。不要把 kubeconfig、Secret 数据、仓库登录信息或客户端密码写入证据目录。

## 5. 导出并冻结实例参数

aKafka 的通用参数模板名称通常为 `general-kafka`。模板属于管理集群的产品配置，业务集群中的 `RdsKafka` 只保存最终生效的实例配置。不同产品版本的模板可能变化，因此每次测试都应导出当前安装版本，而不是依赖本文表格。

如果具备管理集群只读权限，执行：

```bash
export MGMT_KUBECONFIG=/path/to/management-cluster.kubeconfig

kubectl --kubeconfig "$MGMT_KUBECONFIG" get paramtemplate -A \
  -l component=kafka

export TEMPLATE_NS="$(kubectl --kubeconfig "$MGMT_KUBECONFIG" \
  get paramtemplate -A -l component=kafka \
  -o jsonpath='{range .items[?(@.metadata.name=="general-kafka")]}{.metadata.namespace}{"\n"}{end}')"
test -n "$TEMPLATE_NS"
kubectl --kubeconfig "$MGMT_KUBECONFIG" -n "$TEMPLATE_NS" \
  get paramtemplate general-kafka -o yaml \
  >"$OUT/general-kafka-paramtemplate.yaml"
```

没有管理集群权限时，在产品控制台选择通用 Kafka 参数模板，并从实例导出最终 `spec.config`。不要根据模板名称推测值。

当前标准通用模板应重点核对以下参数；“示例基线”仅用于识别参数，不替代已安装模板：

| Broker 参数 | 示例基线 | 作用与测试解释 |
| --- | ---: | --- |
| `auto.create.topics.enable` | `false` | 禁止因拼写错误自动建 Topic；测试 Topic 必须显式创建 |
| `default.replication.factor` | `3` | 未显式指定副本数时的默认值；测试仍显式传入 `3` |
| `min.insync.replicas` | `1` | 模板基线；生产可靠性测试应在 Topic 或实例层显式设为 `2` |
| `num.network.threads` | `3` | 处理网络请求的线程数 |
| `num.io.threads` | `8` | 处理请求和磁盘相关工作的线程数 |
| `num.replica.fetchers` | `1` | 每个源 Broker 的副本拉取线程数 |
| `num.recovery.threads.per.data.dir` | `1` | 每个数据目录用于启动恢复和关闭刷新的线程数 |
| `background.threads` | `10` | 后台任务线程池大小 |
| `message.max.bytes` | `1048588` | Broker 接受的最大记录批次大小，不等同于单条消息大小 |
| `compression.type` | `producer` | Broker 保留生产者选择的压缩类型 |
| `log.segment.bytes` | `1073741824` | 日志段大小 |
| `log.retention.hours` | `168` | 基于时间的保留期 |
| `log.roll.hours` | `168` | 日志段最长滚动时间 |
| `delete.topic.enable` | `true` | 允许删除测试 Topic |
| `unclean.leader.election.enable` | `false` | 禁止非 ISR 副本被选为 Leader |

参数模板的变更应用策略由当前产品版本决定。测试前查询当前版本的参数定义，记录其 `applyStrategy`；如果是 `RestartApply`，把滚动重启时间排除在测量窗口之外。

```bash
kubectl --kubeconfig "$MGMT_KUBECONFIG" get paramdefinition kafka-general -o yaml \
  >"$OUT/kafka-general-paramdefinition.yaml"
```

## 6. 持久卷容量和存储验证

### 6.1 有界合成测试的容量公式

对单个 Topic，可先用下式估算每个 Broker 的消息载荷占用：

```text
每 Broker 载荷字节 ≈ 记录数 × 单条记录字节 × 副本数 ÷ Broker 数 ÷ 实测压缩比
建议 PVC 下限 = 每 Broker 载荷字节 × 安全系数 + 其他 Topic、索引和运维预留
```

压缩比定义为“未压缩字节 / 落盘字节”。预估阶段没有实测值时取 `1`，不要假设压缩收益。本文对全新、单 Topic、有界合成测试采用 `1.5` 的工程安全系数；该系数不是 Kafka 产品默认值，也不适用于生产容量规划。存在数据倾斜、重分配、多个 Topic 或保留期内持续写入时，应根据实测峰值提高系数，并单独预留迁移空间。

在 3 Broker、3 副本、压缩比为 1 的标准矩阵中，每条记录的一个副本平均落在每个 Broker，因此载荷和建议下限如下：

| 记录数 | 消息大小 | 每 Broker 载荷 | 乘 1.5 后的最低取整值 |
| ---: | ---: | ---: | ---: |
| 50,000,000 | 100 B | 4.66 GiB | 7 GiB |
| 50,000,000 | 500 B | 23.28 GiB | 35 GiB |
| 50,000,000 | 1000 B | 46.57 GiB | 70 GiB |
| 100,000,000 | 100 B | 9.31 GiB | 14 GiB |
| 100,000,000 | 500 B | 46.57 GiB | 70 GiB |

表中未单独计算 Key、Record Header、批次开销、索引、控制记录、其他 Topic 和重分配临时空间。因此 50 GiB PVC 不足以安全执行 50,000,000 条 1000 B 或 100,000,000 条 500 B 的完整标准点位。无限时长或未知写入量的测试不能用该有界公式，应按写入速率、保留时间和目标磁盘水位计算。

独立 KRaft Controller 不保存 Topic 消息载荷，不能套用 Broker 载荷公式。其 PVC 应满足当前产品版本的最小值，并根据 Topic/分区数量变化、元数据日志增长和保留策略实测校准。Controller/Broker 混合角色共用数据卷时，PVC 必须同时满足 Broker 载荷下限和元数据、索引及运维预留。

### 6.2 存储检查

```bash
kubectl -n "$NS" get pvc -o wide >"$OUT/pvc-before.txt"
kubectl -n "$NS" get pod -o wide >"$OUT/pods-before.txt"

# 用当前实例实际标签筛选；不要假设 Pod 名称。
kubectl -n "$NS" get pod \
  -l "strimzi.io/cluster=${CLUSTER},strimzi.io/broker-role=true" \
  -o wide
```

确认：

- PVC 全部为 `Bound`，容量不小于计算值；
- 每个 Broker 的持久卷和节点分布符合测试设计；
- StorageClass、卷类型、文件系统和节点磁盘与目标环境一致；
- 节点不存在持续磁盘压力，且压测前 Kafka 没有待恢复副本。

存储延迟是 Kafka 性能的主要约束之一。只报告 StorageClass 名称不足以证明存储等价，应同时保存供应器、介质类型、拓扑和测试期间的 I/O 延迟/利用率证据。

## 7. 创建或调整 aKafka 实例

通过产品控制台创建专用实例，或修改已有的专用测试实例。控制台字段随产品版本可能变化，最终以业务集群中的 `RdsKafka` 对象和生成的 Strimzi 资源为准。

### 7.1 拓扑

- 使用 Kafka Raft 元数据模式（KRaft）；
- 至少 3 个 Broker；
- 生产形态使用独立 Controller 时，性能测试也应使用相同拓扑；生产形态使用 Controller/Broker 混合角色时，必须在报告中明确；
- Broker 通过 Pod 反亲和性分散到不同节点和故障域；
- Broker CPU/内存按第 3 节矩阵逐档测试；Controller 资源固定，避免与 Broker 规格同时变化；
- Java 虚拟机（Java Virtual Machine，JVM）堆上限不能占满容器内存，必须为页缓存和容器内的非堆内存留出空间。

> Kafka 依赖操作系统页缓存。增大 JVM 堆不等于增大 Kafka 可用缓存；如果堆设置与容器限制过近，可能导致容器内存不足或压缩页缓存空间。

控制台提交后，应按当前 `RdsKafka` 自定义资源定义（CustomResourceDefinition，CRD）核对以下字段，不根据控制台显示值推测最终配置：

| `RdsKafka` 字段 | 标准测试要求 |
| --- | --- |
| `spec.mode` | `KRaft` |
| `spec.replicas` | 3 个 Broker |
| `spec.resources.requests/limits` | 当前矩阵档位；requests 和 limits 均需记录 |
| `spec.storage.class` | 客户选定并已验证的 StorageClass |
| `spec.storage.size` | 不小于第 6 节计算值 |
| `spec.storage.deleteClaim` | 按数据保留和销毁要求选择；不得仅为方便清理而改为 `true` |
| `spec.controller` | 与生产计划一致的角色、数量、资源和存储；独立 Controller 使用不少于 3 个投票节点 |
| `spec.config` | 已导出的 `general-kafka` 基线，加上本轮唯一的参数变更 |
| `spec.kafka.listeners` | 与本轮集群内或外部访问路径一致 |
| `spec.kafkaExporter` | 需要消费组积压时启用，并限制 Topic/消费组正则范围 |

```bash
kubectl explain rdskafka.spec --recursive \
  >"$OUT/rdskafka-spec-schema.txt"
```

### 7.2 固定变量

每轮测试只改变一个待评估变量。以下配置必须固定并写入报告：

- Kafka 与 Operator 版本；
- KRaft 角色布局、Broker/Controller 数量；
- Broker/Controller 的 CPU、内存、JVM 堆、节点选择和反亲和性；
- StorageClass、PVC 容量和存储介质；
- Broker 配置完整快照；
- Topic 分区、副本和 `min.insync.replicas`；
- 客户端镜像版本、资源、节点位置和连接安全；
- 消息大小、记录数、压缩、消息键分布、确认和消费参数。

保存实例最终状态：

```bash
kubectl -n "$NS" get rdskafka "$CLUSTER" -o yaml \
  >"$OUT/rdskafka.yaml"
kubectl -n "$NS" get kafka "$CLUSTER" -o yaml \
  >"$OUT/kafka.yaml"
kubectl -n "$NS" get kafkanodepool -l "strimzi.io/cluster=${CLUSTER}" -o yaml \
  >"$OUT/kafkanodepools.yaml"
kubectl -n "$NS" get pod,pvc,service -o wide \
  >"$OUT/workloads-before.txt"
```

任一采集命令失败都应停止并排查权限、资源名称或实例状态，不能用 `|| true` 掩盖错误。

### 7.3 监控开关

创建实例时启用平台提供的 Kafka 指标采集；需要消费组积压时同时启用 Kafka Exporter，并把 Topic 和消费组正则限制在本次测试范围。开始压测前核对最终资源和 Exporter Pod：

```bash
kubectl -n "$NS" get rdskafka "$CLUSTER" \
  -o jsonpath='{.spec.kafkaExporter}' \
  >"$OUT/rdskafka-kafka-exporter.json"
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.metricsConfig}' \
  >"$OUT/kafka-metrics-config.json"
kubectl -n "$NS" get pod \
  -l "strimzi.io/cluster=${CLUSTER},strimzi.io/name=${CLUSTER}-kafka-exporter" \
  -o wide
```

如果最后一条命令没有找到 Pod，说明 Kafka Exporter 未启用或标签与当前版本不同。先检查 `RdsKafka`、生成的 `Kafka` 资源和实际 Pod 标签，不要把空结果解释为“积压为 0”。

## 8. 部署压测客户端

### 8.1 复用实例的 Kafka 镜像

从 Broker Pod 读取 Operator 实际使用的 Kafka 镜像。这样可保证脚本版本与服务端版本一致，也不需要在外部文档中固化镜像仓库地址。

```bash
export KAFKA_IMAGE="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/cluster=${CLUSTER},strimzi.io/broker-role=true" \
  -o jsonpath='{.items[0].spec.containers[?(@.name=="kafka")].image}')"

test -n "$KAFKA_IMAGE"
export BOOTSTRAP="${CLUSTER}-kafka-bootstrap.${NS}.svc:9092"
```

上面的 Service 名称符合 Strimzi 内部 Bootstrap Service 规则，但仍应查询当前实例验证监听器、端口和认证方式：

```bash
kubectl -n "$NS" get service -l "strimzi.io/cluster=${CLUSTER}" -o wide
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.listeners}' >"$OUT/listeners.json"
```

以下示例使用隔离命名空间内的明文内部监听器。启用 TLS/SASL 时，应把完整客户端属性放入受控 Secret，并以只读卷挂载；不要通过命令行参数传递密码。

### 8.2 创建客户端属性

```bash
kubectl -n "$NS" create configmap akafka-perf-client-config \
  --from-literal=admin.properties='' \
  --from-literal=producer.properties='acks=all
enable.idempotence=true
batch.size=50000
linger.ms=5
compression.type=none
buffer.memory=134217728' \
  --from-literal=consumer.properties='auto.offset.reset=earliest
fetch.min.bytes=1
fetch.max.wait.ms=500
max.partition.fetch.bytes=1048576
fetch.max.bytes=52428800' \
  --dry-run=client -o yaml | kubectl apply -f -
```

如果使用认证，在本地受控目录中准备包含性能参数和连接参数的完整 `producer.properties`、`consumer.properties`，以 Secret 替代上面的 ConfigMap：

```bash
kubectl -n "$NS" create secret generic akafka-perf-client-config \
  --from-file=admin.properties=/secure/path/admin.properties \
  --from-file=producer.properties=/secure/path/producer.properties \
  --from-file=consumer.properties=/secure/path/consumer.properties \
  --dry-run=client -o yaml | kubectl apply -f -
```

同时把 8.3 节两个 Pod 的卷源从 `configMap` 改为：

```yaml
secret:
  secretName: akafka-perf-client-config
```

`admin.properties` 只保存管理脚本所需的连接安全属性；生产者和消费者文件另外保存各自性能参数。属性中的 `security.protocol`、SASL 或 SSL 设置必须与实例监听器一致。报告和证据目录只保存脱敏副本，不得导出 Secret、密码、令牌、私钥或未脱敏的 Java 身份验证和授权服务（Java Authentication and Authorization Service，JAAS）配置。

### 8.3 创建客户端 Pod

```bash
kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: akafka-producer-perf
  labels:
    app: akafka-perf
    role: producer
spec:
  restartPolicy: Never
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: strimzi.io/broker-role
                operator: In
                values: ["true"]
          topologyKey: kubernetes.io/hostname
  containers:
    - name: kafka
      image: ${KAFKA_IMAGE}
      command: ["sh", "-c", "sleep infinity"]
      resources:
        requests: {cpu: "1", memory: 2Gi}
        limits: {cpu: "1", memory: 2Gi}
      volumeMounts:
        - name: config
          mountPath: /opt/perf-config
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: akafka-perf-client-config
---
apiVersion: v1
kind: Pod
metadata:
  name: akafka-consumer-perf
  labels:
    app: akafka-perf
    role: consumer
spec:
  restartPolicy: Never
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: strimzi.io/broker-role
                operator: In
                values: ["true"]
          topologyKey: kubernetes.io/hostname
  containers:
    - name: kafka
      image: ${KAFKA_IMAGE}
      command: ["sh", "-c", "sleep infinity"]
      resources:
        requests: {cpu: "1", memory: 2Gi}
        limits: {cpu: "1", memory: 2Gi}
      volumeMounts:
        - name: config
          mountPath: /opt/perf-config
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: akafka-perf-client-config
EOF

kubectl -n "$NS" wait --for=condition=Ready \
  pod/akafka-producer-perf pod/akafka-consumer-perf --timeout=300s
kubectl -n "$NS" get pod -l app=akafka-perf -o wide
```

如果集群没有可与全部 Broker 分离的节点，`required` 反亲和性会使 Pod 保持 Pending。应增加专用压测节点；只有在无法增加节点且明确接受资源争用偏差时，才将其改为 `preferred`，并在报告中标记该限制。

如果 Pod 为 `ImagePullBackOff`，先用 `kubectl describe pod` 检查原因，再核对 Broker Pod 的 `spec.imagePullSecrets` 和服务账号（ServiceAccount）。确需拉取 Secret 时，在客户端 Pod 的 `spec.imagePullSecrets` 中引用当前命名空间内已批准的 Secret；不要在文档、命令行或测试报告中写入仓库密码。

客户端的 1 vCPU / 2 GiB 只是起始值，不是容量上限。发现客户端 CPU 接近限制、网络达到节点上限、发生 CPU 节流或垃圾回收异常时，应先增加客户端资源或并发 Pod，不能把客户端瓶颈归因于 Kafka。

### 8.4 固化脚本版本和接口

```bash
kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh --version \
  | tee "$OUT/kafka-client-version.txt"

kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh --help \
  >"$OUT/producer-perf-help.txt" 2>&1

kubectl -n "$NS" exec akafka-consumer-perf -- \
  /opt/kafka/bin/kafka-consumer-perf-test.sh --help \
  >"$OUT/consumer-perf-help.txt" 2>&1
```

如果镜像中的 Kafka 安装目录不是 `/opt/kafka`，先在镜像说明或 Broker 容器环境中确认实际路径，再替换命令。不要下载另一个未知版本的脚本混用。

## 9. 创建和验证测试 Topic

```bash
kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --create --if-not-exists \
  --topic "$TOPIC" \
  --partitions 30 \
  --replication-factor 3 \
  --config min.insync.replicas=2

kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --topic "$TOPIC" \
  | tee "$OUT/topic-before.txt"

kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --entity-type topics --entity-name "$TOPIC" --describe \
  | tee "$OUT/topic-config.txt"
```

开始前逐项确认：

- `PartitionCount=30`、`ReplicationFactor=3`；
- 每个分区有 3 个副本，ISR 数量为 3；
- Leader 在 Broker 间没有明显失衡；
- 动态 Topic 配置中 `min.insync.replicas=2`；
- Topic 是本轮新建或已按测试设计清理，消费组名称没有复用。

## 10. 执行单个测试点

### 10.1 生产可靠性基线

先记录参数，再执行。示例为 1,000,000 条、每条 500 B 的功能验证；正式标准点位替换 `--num-records`，并确保 PVC 容量足够。

```bash
export NUM_RECORDS=1000000
export RECORD_SIZE=500

kubectl -n "$NS" exec akafka-producer-perf -- sh -c \
  "cat /opt/perf-config/producer.properties" \
  >"$OUT/producer.properties"

kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --num-records "$NUM_RECORDS" \
  --record-size "$RECORD_SIZE" \
  --throughput -1 \
  --warmup-records 100000 \
  --reporting-interval 5000 \
  --command-config /opt/perf-config/producer.properties \
  --print-metrics \
  | tee "$OUT/producer-${RECORD_SIZE}B.txt"
```

`--throughput -1` 表示客户端不主动限速，用于寻找该客户端并发下的上限。它不保证 Broker 已饱和；必须结合客户端和 Broker 指标判断。正式对比中应固定 `--warmup-records`，并只使用脚本的稳态汇总结果，不把预热阶段混入结果。

### 10.2 Leader 确认上限

保持其他属性不变，只覆盖确认和幂等配置：

```properties
acks=1
enable.idempotence=false
batch.size=50000
linger.ms=5
compression.type=none
buffer.memory=134217728
```

Kafka 4.2 可通过 `--command-property` 覆盖配置文件中的这两个值，避免无意改变其他参数：

```bash
kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --num-records "$NUM_RECORDS" \
  --record-size "$RECORD_SIZE" \
  --throughput -1 \
  --warmup-records 100000 \
  --reporting-interval 5000 \
  --command-config /opt/perf-config/producer.properties \
  --command-property acks=1 \
  --command-property enable.idempotence=false \
  --print-metrics \
  | tee "$OUT/producer-leader-ack-${RECORD_SIZE}B.txt"
```

结果必须标记为 `leader-ack`，且不得与 `acks=all` 的容量直接比较。

### 10.3 消费者单测

消费者单测前先准备不小于 `NUM_RECORDS` 的存量数据，然后使用新的消费组：

```bash
export NUM_RECORDS=1000000
export RECORD_SIZE=500
export GROUP="perf-consumer-$(date -u +%Y%m%dT%H%M%SZ)"

kubectl -n "$NS" exec akafka-consumer-perf -- sh -c \
  "cat /opt/perf-config/consumer.properties" \
  >"$OUT/consumer.properties"

kubectl -n "$NS" exec akafka-consumer-perf -- \
  /opt/kafka/bin/kafka-consumer-perf-test.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --group "$GROUP" \
  --num-records "$NUM_RECORDS" \
  --fetch-size 200000 \
  --timeout 60000 \
  --show-detailed-stats \
  --reporting-interval 5000 \
  --command-config /opt/perf-config/consumer.properties \
  --print-metrics \
  | tee "$OUT/consumer-${RECORD_SIZE}B.txt"
```

Kafka 4.2 中 `--messages` 已弃用，应使用 `--num-records`。`--fetch-size` 限制每次从单个分区获取的数据量；客户端属性中的 `max.partition.fetch.bytes` 也参与限制。必须保存 `--print-metrics` 输出中的 `records-consumed-total`，确认实际消费量达到目标。超时、Topic 数据不足或权限错误都可能使脚本提前结束，不能只看最后一行吞吐量。

### 10.4 生产和消费并发

1. 使用新消费组启动消费者，并确认其已加入组；
2. 启动生产者；
3. 在整个稳态窗口采集指标；
4. 生产者停止后继续运行消费者，直到积压归零或达到预定义超时；
5. 保存最终消费位点和日志末端偏移量（log end offset，LEO）。

并发测试不能直接把单次消费者命令放在前台后再启动生产者。应在两个终端运行，或通过 Job/测试编排器同时启动并分别保存标准输出。任何后台执行方式都必须保存进程退出码；仅有日志文件不足以证明命令成功。

### 10.5 Kafka 4.2 的 20 消费者执行示例

以下示例在一个客户端 Pod 中启动 20 个独立消费者进程，并检查每个 `kubectl exec` 的退出码。正式测试前必须根据 12.1 节确认该 Pod 的 CPU、内存和网络不会成为瓶颈；资源不足时，复制 8.3 节的消费者 Pod 并把进程分散到多个压测节点。

```bash
export CONSUMER_COUNT=20
export CONSUMER_POD=akafka-consumer-perf
export GROUP="perf-consumer-20-$(date -u +%Y%m%dT%H%M%SZ)"
test "$NUM_RECORDS" -ge "$CONSUMER_COUNT"

q=$((NUM_RECORDS / CONSUMER_COUNT))
r=$((NUM_RECORDS % CONSUMER_COUNT))
pids=()

for ((i = 1; i <= CONSUMER_COUNT; i++)); do
  process_records="$q"
  if ((i <= r)); then
    process_records=$((q + 1))
  fi

  kubectl -n "$NS" exec "$CONSUMER_POD" -- \
    /opt/kafka/bin/kafka-consumer-perf-test.sh \
    --bootstrap-server "$BOOTSTRAP" \
    --topic "$TOPIC" \
    --group "$GROUP" \
    --num-records "$process_records" \
    --fetch-size 200000 \
    --timeout 60000 \
    --reporting-interval 5000 \
    --command-config /opt/perf-config/consumer.properties \
    --command-property "client.id=perf-consumer-${i}" \
    --print-metrics \
    >"$OUT/consumer-${i}-${RECORD_SIZE}B.txt" 2>&1 &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
test "$failed" -eq 0
```

把 20 个文件中的实际消费记录数相加，并核对总数等于 `NUM_RECORDS`。聚合吞吐量按公共测量窗口中的总记录数/总字节数计算；各进程起止时间不一致时，不能直接相加各自打印的平均速率。任一进程超时、退出非零或记录数不符，都应使该测试点无效。

## 11. 客户端参数说明

### 11.1 生产者

| 参数 | 标准值 | 机制和边界 |
| --- | ---: | --- |
| `--num-records` | 见矩阵 | 实际发送条数；总载荷约为该值乘 `--record-size` |
| `--record-size` | 100/500/1000 | 合成记录 Value 的字节数；只可与消息载荷（payload）文件模式二选一 |
| `--throughput` | `-1` | 不限速上探；受控负载测试时填写目标 records/s |
| `--warmup-records` | 固定值 | 排除连接建立、元数据和 JVM 预热影响；不计入稳态结果 |
| `acks` | `all` 或 `1` | 确认强度；改变后可靠性和性能口径同时变化 |
| `enable.idempotence` | `true` | 防止重试导致重复；要求兼容的 `acks`、重试和在途请求设置 |
| `batch.size` | `50000` | 每分区批次的目标上限；过大可能增加内存和等待时间 |
| `linger.ms` | `5` | 等待合批的最长时间；Kafka 4.x 默认值与早期版本不同，测试应显式设置 |
| `compression.type` | `none` | 标准矩阵关闭压缩；业务矩阵使用真实算法并记录 CPU 与实测压缩比 |
| `buffer.memory` | `134217728` | 生产者可用于缓冲待发送记录的总内存；不是容器内存需求的全部 |

每个分区有独立批次，增加生产者数量、分区数、批次或 `linger.ms` 可能提高合批效率，但也可能增加内存和延迟。只有在报告中保持其余变量不变时，参数前后结果才可归因。

### 11.2 消费者

| 参数 | 标准值 | 机制和边界 |
| --- | ---: | --- |
| `--group` | 每轮唯一 | 同组消费者共同分配分区；复用组可能从旧位点开始 |
| `--num-records` | 与存量数据匹配 | 计划读取的总记录数；必须用客户端指标核对实际值 |
| `--fetch-size` | `200000` | 脚本传入的单分区抓取大小 |
| `--timeout` | `60000` | 两次返回记录之间允许的最长时间，不是整个测试的总时长；超时会使工具提前退出并打印警告 |
| `fetch.min.bytes` | `1` | Broker 返回 Fetch 的最小数据量；增大可提高批量效率，但可能增加等待延迟 |
| `fetch.max.wait.ms` | `500` | 未达到 `fetch.min.bytes` 时的最长等待时间 |
| `max.partition.fetch.bytes` | `1048576` | 每分区每次 Fetch 的返回上限；要能容纳 Broker 允许的最大记录批次 |
| `fetch.max.bytes` | `52428800` | 单次 Fetch 的总体返回上限，仍受服务端和分区级限制 |

同一消费组的有效并行度不超过可分配分区数。Kafka 4.2 的脚本每次调用运行一个消费者；需要 2、4、8 个消费者时，创建相同配置的独立 Pod 或进程，并使用同一个消费组。消费者数超过分区数时，多出的消费者不会获得分区。

矩阵中的 `NUM_RECORDS` 是全部进程的聚合目标，不是每个进程的目标。并发数为 `C` 时，令 `q=NUM_RECORDS/C`、`r=NUM_RECORDS%C`：前 `r` 个进程使用 `q+1`，其余进程使用 `q`，保证各进程目标之和等于 `NUM_RECORDS`。多生产者测试也使用相同分配方法。若每个进程都发送或消费完整的 `NUM_RECORDS`，总数据量已经改变，该结果不能与单进程点直接比较。

## 12. 寻找饱和点和可用容量

### 12.1 先排除客户端上限

对生产者和消费者分别使用 1、2、4、8 个独立客户端进程上探；标准消费者点继续增加到 12、16、20，或在此之前已达到分区并行度/资源上限时停止。客户端应尽量分布在不同压测节点，每个进程使用相同属性，并聚合所有进程的吞吐量。每增加一次并发，至少核对：

- 客户端 Pod CPU、内存、CPU 节流、网络和重启次数；
- Broker CPU、内存、网络、磁盘延迟/利用率；
- 请求错误、超时、重试和生产确认延迟；
- `UnderReplicatedPartitions`、`UnderMinIsrPartitionCount` 和消费组积压；
- 各 Broker 的分区 Leader、日志字节和流量是否失衡。

如果增加客户端资源或进程后吞吐量仍显著增长，前一个结果是客户端上限，不能报告为 Kafka 上限。如果单个压测节点网卡已饱和，应增加客户端节点，而不是继续增加同节点进程。

### 12.2 两阶段负载阶梯

1. **无节流上探**：使用 `--throughput -1`，逐步增加客户端进程，得到可达吞吐量范围。
2. **受控负载验证**：以无节流结果为基准，依次施加约 25%、50%、75%、90%、100%、110% 的目标吞吐量。所有生产者的 `--throughput` 之和等于该点目标值。
3. 每个点先预热，再保持至少 10 分钟稳态；结束后等待积压归零并确认副本健康。
4. 90% 附近加密测试点；对最后一个稳定点和第一个不稳定点各重复至少 3 次。
5. 打乱重复测试顺序或重新运行基线点，以识别硬件温度、缓存、邻居负载和时间漂移。

百分比只是寻找区间的起始策略，不是产品阈值。如果第一轮已违反健康条件，应降低负载重新建立区间。

### 12.3 预先定义判定规则

测试开始前由客户根据业务服务等级目标（Service Level Objective，SLO）确定以下阈值：

- 生产确认 p95/p99 延迟上限；
- 错误、超时和重试率上限；
- 允许的最大消费积压及清空时间；
- Broker、客户端、节点和 PVC 的资源水位；
- 允许的 `UnderReplicatedPartitions` 和 `UnderMinIsrPartitionCount`，通常应始终为 0；
- 稳态窗口和重复次数。

如果客户尚无阈值，可把以下规则作为本次测试的工程判定方法，但必须在报告中标记为“测试规则”，不能称为 Kafka 官方阈值：

- 增加一档负载或并发后，聚合吞吐量增幅连续两档小于 5%；且
- p99 延迟、错误/超时、积压或资源水位持续恶化；或
- 出现 `UnderReplicatedPartitions>0`、`UnderMinIsrPartitionCount>0`、离线日志目录、Pod 重启或磁盘压力。

满足上述组合条件的第一个点记为**饱和点**。饱和前最后一个满足全部 SLO、重复结果稳定且无健康异常的点记为**可用容量**。不要用瞬时最大值代替可用容量。

重复结果的离散程度也要报告。默认可用中位数作为中心值，并同时给出最小值、最大值和变异系数；如果同一测试点吞吐量变异系数超过 5%，应调查环境漂移并增加重复次数。5% 同样是本文的测试规则，不是 Kafka 产品保证。

## 13. 实例参数调优

先用模板基线完成一轮，再根据监控证据一次只调整一个参数。以下建议是诊断方向，不是固定最优值。

| 参数/资源 | 何时考虑调整 | 验证方法 | 风险和停止条件 |
| --- | --- | --- | --- |
| Broker CPU | 请求处理线程忙、CPU 持续接近约束、客户端未饱和 | 增加 CPU 后重复相同负载 | 若吞吐不增而磁盘/网络已满，继续加 CPU 无益 |
| Broker 内存/JVM 堆 | 容器内存压力、频繁垃圾回收（garbage collection，GC），或页缓存不足 | 同时观察堆、GC、常驻内存集（resident set size，RSS）、工作集和磁盘读取 | 堆过大挤压页缓存；堆与容器限制过近可能发生内存不足（out of memory，OOM） |
| `num.network.threads` | `NetworkProcessorAvgIdlePercent` 持续偏低且 CPU 尚有余量 | 小步增加并重复同一点 | 增加线程会增加调度和内存开销；不能修复网卡饱和 |
| `num.io.threads` | `RequestHandlerAvgIdlePercent` 持续偏低，且磁盘/CPU 尚有余量 | 小步增加并比较请求等待和吞吐 | 至少覆盖数据卷数量；过多线程可能增加上下文切换和 I/O 竞争 |
| `num.replica.fetchers` | 副本追赶慢、复制流量未用满资源 | 在故障恢复或高复制负载下验证 | 增加后会提高网络、磁盘和 CPU 消耗 |
| `num.recovery.threads.per.data.dir` | 启动或恢复过慢 | 在受控恢复测试中验证 | 恢复速度提高会加重前台 I/O 干扰 |
| Topic 分区数 | 单分区吞吐成为限制，且有足够消费者并发 | 新建不同分区数的 Topic 对比 | 增加分区改变 Key 顺序范围、元数据和副本开销；不能随意减少 |
| Broker 数量 | 单机资源已接近约束，需要横向扩展 | 扩容并等待副本重分配完成后重测 | 只增加 Broker 不会自动均衡已有分区数据；重分配期间结果无效 |
| `message.max.bytes` | 业务最大记录批次超过默认限制 | 同步核对 Topic、生产者和消费者抓取上限 | 增大后提高内存和网络突发，配置不一致会产生发送或消费失败 |
| 保留与日志段参数 | 磁盘占用、删除粒度或恢复时间不满足需求 | 长时间测试保留和删除行为 | 不应仅为短时跑分改变生产保留策略 |

Apache Kafka 的线程空闲指标越接近 0 表示越忙。`NetworkProcessorAvgIdlePercent` 或 `RequestHandlerAvgIdlePercent` 长时间低于约 0.3 时，应结合 CPU、网络和存储判断是否出现处理能力不足；该值是诊断信号，不是单独的扩容触发器。

每次变更后：

1. 保存变更前后完整配置差异；
2. 按当前产品版本的应用策略完成滚动重启或动态更新；
3. 等待 Kafka 和 NodePool Ready、ISR 完整、KRaft 控制器仲裁状态稳定；
4. 以相同 Topic 数据状态、客户端并发和负载重新执行至少 3 次；
5. 收益不稳定或健康指标恶化时回到前一个已验证配置。

## 14. 监控和证据采集

### 14.1 Kafka 健康检查

在测前、稳态窗口和测后执行。Broker Pod 名称通过标签发现：

```bash
export BROKER_POD="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/cluster=${CLUSTER},strimzi.io/broker-role=true" \
  -o jsonpath='{.items[0].metadata.name}')"

kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-metadata-quorum.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  describe --status \
  | tee "$OUT/metadata-quorum-after.txt"

kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --under-replicated-partitions \
  | tee "$OUT/under-replicated-after.txt"

kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --group "$GROUP" \
  | tee "$OUT/consumer-group-after.txt"

kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-log-dirs.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --topic-list "$TOPIC" \
  >"$OUT/log-dirs-after.txt"
```

`--under-replicated-partitions` 在健康状态下可以没有输出。应同时保存命令退出码或由编排器记录成功状态，避免把连接失败误判为“没有异常分区”。

`kafka-log-dirs.sh` 会在 JSON 数据前输出状态文本，因此上例按原始文本保存；需要程序化解析时，应先验证并移除非 JSON 前缀，不要直接把整个文件交给 JSON 解析器。

### 14.2 必采 Kafka 指标

以下 Java 管理扩展（Java Management Extensions，JMX）管理型 Bean（MBean）或其 Prometheus 映射必须覆盖完整稳态窗口：

| 类别 | 指标或 JMX MBean | 用途 |
| --- | --- | --- |
| 写入/读取 | `BytesInPerSec`、`BytesOutPerSec`、`MessagesInPerSec` | 与客户端吞吐交叉验证 |
| 副本健康 | `UnderReplicatedPartitions`、`UnderMinIsrPartitionCount` | 前者表示 ISR 数量小于配置副本数，后者表示 ISR 数量小于 `min.insync.replicas` |
| 日志目录 | `OfflineLogDirectoryCount` | 识别不可用存储目录 |
| 网络线程 | `NetworkProcessorAvgIdlePercent` | 判断网络处理线程繁忙程度 |
| 请求线程 | `RequestHandlerAvgIdlePercent` | 判断请求处理线程繁忙程度 |
| 请求延迟 | Produce/Fetch 请求的 `TotalTimeMs`、`RequestQueueTimeMs`、`LocalTimeMs`、`RemoteTimeMs`、`ResponseQueueTimeMs` 和 `ResponseSendTimeMs` | 定位等待发生在哪个阶段 |
| 消费组 | 当前位点、LEO、每分区和总积压（lag） | 判断消费者能否跟上生产流量 |

JMX Exporter 的 Prometheus 指标名称由实例的指标映射规则决定。不要假设所有环境使用同一名称。先从 Broker 暴露的 `/metrics` 端点保存原始指标并确认名称：

```bash
kubectl -n "$NS" exec "$BROKER_POD" -- \
  curl -fsS http://127.0.0.1:9404/metrics \
  >"$OUT/broker-jmx-metrics.txt"

grep -m 100 -E 'bytesin|bytesout|messagesin|underreplicated|underminisr|avgidle' \
  "$OUT/broker-jmx-metrics.txt"
```

如果实例启用了 Kafka Exporter，先发现 Pod，再保存其原始指标：

```bash
export EXPORTER_PODS="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/cluster=${CLUSTER},strimzi.io/name=${CLUSTER}-kafka-exporter" \
  -o jsonpath='{.items[*].metadata.name}')"

if test -n "$EXPORTER_PODS"; then
  export EXPORTER_POD="${EXPORTER_PODS%% *}"
  kubectl -n "$NS" exec "$EXPORTER_POD" -- \
    curl -fsS http://127.0.0.1:9404/metrics \
    >"$OUT/kafka-exporter-metrics.txt"
else
  printf '%s\n' 'Kafka Exporter Pod not found' \
    >"$OUT/kafka-exporter-not-found.txt"
fi
```

原始端点有数据只证明 Exporter 正常暴露指标，不证明平台已经抓取时序数据。正式测试前，应在平台监控或 Prometheus 中查询最近 15 分钟的 Broker 指标，确认每个 Broker 都有连续样本。如果查询为空或存在采集空洞，应停止测试，按当前平台监控配置补齐 ServiceMonitor/PodMonitor 和指标映射；其选择标签由当前 Prometheus 配置决定，不能照抄其他集群的标签。

### 14.3 Kubernetes 和基础设施指标

至少采集以下时序数据，而不是只保存测后瞬时值：

- Broker、Controller 和客户端 Pod：CPU 使用、CPU 节流、内存工作集、网络收发、重启和 OOM；
- 节点：CPU、内存、网络带宽/丢包、磁盘吞吐、每秒输入/输出操作数（input/output operations per second，IOPS）、平均和高分位延迟、利用率、队列深度；
- PVC：已用字节、容量、使用率和增长速率；
- Kubernetes 事件、Pod 调度节点和资源 requests/limits。

`kubectl top` 只提供近实时快照，可用于快速检查，但不能替代 Prometheus 范围查询：

```bash
kubectl -n "$NS" top pod --containers \
  | tee "$OUT/top-pods-after.txt"
kubectl -n "$NS" get events --sort-by=.lastTimestamp \
  >"$OUT/events.txt"
kubectl -n "$NS" get pod -o wide \
  >"$OUT/pods-after.txt"
kubectl -n "$NS" get pvc -o wide \
  >"$OUT/pvc-after.txt"
```

以下 PromQL 仅表示计算意图。先在当前 Prometheus 中检查实际指标名和标签，再替换 `$NS`、`$TOPIC`、`$GROUP` 和集群标签；保存查询表达式、时间范围、步长和原始响应。

```text
sum(rate(kafka_server_brokertopicmetrics_messagesin_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(rate(kafka_server_brokertopicmetrics_bytesin_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(rate(kafka_server_brokertopicmetrics_bytesout_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(kafka_server_replicamanager_underreplicatedpartitions{namespace="$NS"})

sum(kafka_server_replicamanager_underminisrpartitioncount{namespace="$NS"})

min(kafka_network_socketserver_networkprocessoravgidle_percent{namespace="$NS"})

min(kafka_server_kafkarequesthandlerpool_requesthandleravgidle_percent{namespace="$NS"})

sum(kafka_consumergroup_lag{namespace="$NS",consumergroup="$GROUP",topic="$TOPIC"})

sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="$NS",container!="",image!=""}[5m])
)

max by (pod) (
  container_memory_working_set_bytes{namespace="$NS",container!="",image!=""}
)

sum by (pod) (
  rate(container_network_receive_bytes_total{namespace="$NS"}[5m])
)

sum by (pod) (
  rate(container_network_transmit_bytes_total{namespace="$NS"}[5m])
)

kubelet_volume_stats_used_bytes{namespace="$NS"}
/
kubelet_volume_stats_capacity_bytes{namespace="$NS"}
```

CPU 节流和节点磁盘指标在不同容器运行时、cgroup 版本和监控栈中的名称可能不同。如果平台没有对应时序指标，应在测试前补齐采集或从节点运行时、cgroup 和存储系统导出等价证据；不能把“查询为空”记为 0。

### 14.4 Redis 或其他关联组件

如果业务链路还包含 Redis，应为 Redis 使用相同的 `RUN_ID`、UTC 时间窗口和节点事件记录，并附独立的 Redis 性能报告。Kafka 和 Redis 的吞吐量、延迟及饱和点属于不同指标，不能合并，也不能仅凭时间相关性推断一个组件导致另一个组件变慢。Kafka 报告只保留关联报告链接、版本、测试窗口和经验证的依赖关系。

## 15. 结果汇总和有效性检查

### 15.1 每个测试点的记录字段

至少记录：

```text
run_id,start_utc,end_utc,measurement_seconds,test_mode,reliability_profile,
kafka_version,operator_version,kraft_roles,broker_count,controller_count,
broker_cpu,broker_memory,jvm_xms,jvm_xmx,storage_class,pvc_size,
topic,partitions,replication_factor,min_insync_replicas,
record_count_target,producer_records_sent,consumer_records_consumed,
record_size,compression,compression_ratio,key_distribution,
producer_processes,consumer_processes,acks,idempotence,batch_size,linger_ms,
throughput_target,fetch_min_bytes,fetch_max_wait_ms,max_partition_fetch_bytes,
producer_records_s,producer_mib_s,producer_avg_ms,producer_p50_ms,
producer_p95_ms,producer_p99_ms,producer_p999_ms,
consumer_records_s,consumer_mib_s,max_lag,final_lag,error_count,timeout_count,
broker_cpu_cores_max,broker_memory_bytes_max,broker_network_bps_max,pvc_used_bytes_max,
network_idle_min,request_idle_min,under_replicated_max,under_min_isr_max,
client_cpu_cores_max,client_cpu_throttling_ratio_max,result_valid,invalid_reason
```

Kafka 脚本输出使用 `MB/sec` 列名。报告应保留原始列名；需要统一为 MiB/s 时，另行使用 `实际载荷字节 ÷ 秒数 ÷ 2^20` 计算并记录公式，不要只修改列名。

资源峰值字段默认记录“单个 Pod 或 PVC 的最大值”；如果使用求和、平均或其他聚合方式，应在字段说明中记录聚合函数、单位、时间窗口和采样步长。

### 15.2 有效结果的必要条件

仅当以下条件全部满足时，结果才标记为 `valid`：

- 命令退出码为 0，生产和消费记录数达到目标；
- 预热和稳态窗口按计划完成，时钟范围明确；
- Kafka、Operator、配置、Topic、客户端和基础设施快照完整；
- 未发生 Pod 重启、OOM、节点压力、卷异常或计划外维护；
- `UnderReplicatedPartitions=0`、`UnderMinIsrPartitionCount=0`、`OfflineLogDirectoryCount=0`；
- 生产可靠性基线没有违反 `acks=all`、幂等和最小 ISR 要求；
- 客户端不是已确认的瓶颈，或结果已明确标记为“客户端上限”；
- 监控覆盖完整稳态窗口，并且没有采集空洞；
- 重复测试的差异已经解释，或结论保留不确定性。

以下任一情况应标记为 `invalid` 并重测：

- Topic 已有未知数据、消费组复用或实际记录数不足；
- 测试期间发生滚动重启、重分配、Leader 频繁切换或副本追赶；
- PVC 接近满、存储或节点出现压力；
- 客户端被 CPU 限流、网络饱和或异常退出；
- 不同测试点改变了两个以上关键变量；
- 仅有平均值，没有原始输出、分位延迟或时序监控。

### 15.3 报告结论写法

结论必须区分：

- **事实**：原始输出、配置快照和监控直接显示的结果；
- **推断**：由多个指标共同支持的瓶颈判断，并列出反证；
- **建议**：下一步调参、扩容或重测方案；
- **待验证事项**：缺少存储、网络、业务消息模型或长稳测试时尚不能确认的内容。

推荐同时报告：

1. 最后一个满足全部 SLO 的可用容量；
2. 第一个不稳定的饱和点及触发条件；
3. 3 次以上重复结果的中位数、范围和变异系数；
4. 与基线相比的相对变化，并保持可靠性和环境配置相同；
5. 适用边界，特别是消息模型、存储、网络、认证、保留策略和测试持续时间。

## 16. 清理

先归档并校验 `$OUT`，再删除本轮独立资源。不要使用模糊标签或通配符删除共享资源。

```bash
# 仅删除本文创建的专用 Topic；命令执行前再次核对名称。
kubectl -n "$NS" exec akafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --delete --topic "$TOPIC"

kubectl -n "$NS" delete pod \
  akafka-producer-perf akafka-consumer-perf --ignore-not-found
kubectl -n "$NS" delete configmap \
  akafka-perf-client-config --ignore-not-found
kubectl -n "$NS" delete secret \
  akafka-perf-client-config --ignore-not-found
```

如果整个命名空间都是本轮创建且已确认无共享资源，可以通过变更流程删除命名空间。删除实例或命名空间前，必须核对 PVC 的 `deleteClaim` 和 StorageClass 回收策略，确认数据保留或销毁符合要求。

## 17. 参考资料

- [Apache Kafka 4.2 Broker 配置](https://kafka.apache.org/42/configuration/broker-configs/)
- [Apache Kafka 4.2 Producer 配置](https://kafka.apache.org/42/configuration/producer-configs/)
- [Apache Kafka 4.2 Consumer 配置](https://kafka.apache.org/42/configuration/consumer-configs/)
- [Apache Kafka 4.2 监控](https://kafka.apache.org/42/operations/monitoring/)
- [Apache Kafka 4.2 硬件与操作系统](https://kafka.apache.org/42/operations/hardware-and-os/)
- [Strimzi 0.48 部署和运行指南](https://strimzi.io/docs/operators/0.48.0/deploying.html)
- [Prometheus Operator API 参考](https://prometheus-operator.dev/docs/api-reference/api/)
