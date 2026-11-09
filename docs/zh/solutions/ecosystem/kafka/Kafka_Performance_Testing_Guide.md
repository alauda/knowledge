---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB261100002
sourceSHA: 92008b55db9a13c0f2357c2306bc8f74545500b3d48a3fa18a38989a6ceffb27
---

# Kafka 性能测试指南

## 1. 目的和范围

本指南描述了如何在 Alauda 容器平台 (ACP) 上对 Kafka 实例进行可重复和可审计的性能测试。其目的是回答以下问题：

- 在指定的复制、确认和压缩策略下，实例能够提供什么持续的生产者和消费者吞吐量？
- 在延迟、错误率、复制同步和资源利用率保持在其限制内的情况下，实例能够提供什么可用容量？
- 瓶颈是在客户端、代理 CPU、内存、网络、持久卷，还是分区和副本放置？
- 在更改实例或客户端参数后，结果是否可比，改进是否可重复？

本指南使用 Apache Kafka 的术语来描述代理、主题和控制器。

同步副本 (ISR) 的术语遵循 Apache Kafka 文档。

本指南涵盖 Kafka Raft 元数据模式 (KRaft) 和传统的基于 ZooKeeper 的实例。将元数据模式视为测试配置的一部分。不要在不同的元数据模式之间比较或合并结果。

主要命令使用 Apache Kafka 4.2.0 脚本接口。这些选项中的一些仅在 Kafka 4.2 中标准化，并且在早期客户端中不存在：基于 Strimzi 0.48 的操作员发布提供 Kafka 4.0 或 4.1 镜像，而基于 ZooKeeper 的操作员线提供传统的 Kafka 2.x 镜像。第 8.5 节列出了早于 Kafka 4.2 的客户端的等效命令。对于任何已安装的版本，首先保存 `--version` 和 `--help` 输出，并仅使用该版本显示的选项。

本指南不提供普遍适用的“最佳吞吐量”或“最佳配置”。硬件、存储、网络、消息大小、压缩比、可靠性策略或工作负载的变化可能使结果不可比。

> **风险通知：** 性能测试会写入大量数据，可能会耗尽磁盘、网络或节点资源。仅在授权的、隔离的实例、命名空间和测试窗口中运行它们。不要在服务生产流量的实例上寻找饱和点。

## 2. 结果配置

在测试之前选择一个工作负载模式和一个可靠性配置。不要将不同配置的结果合并。

### 2.1 工作负载模式

| 模式                           | 目的                       | 执行                               | 主要结果                                                       |
| ------------------------------ | ----------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| 仅生产者                      | 测量写入容量                | 仅运行生产者                      | records/s, MiB/s, 生产确认延迟                      |
| 仅消费者                      | 测量读取容量                | 预加载足够的数据，然后运行消费者 | records/s, MiB/s, 消费者组堆积量                                  |
| 同时生产和消费                | 模拟持续数据流              | 启动消费者，然后启动生产者   | 双方的吞吐量、堆积增长、代理资源和稳定性 |

生产者脚本报告生产请求确认延迟，而不是应用程序的端到端延迟。消费者脚本报告吞吐量，但不报告从消息生产到消费的时间。要测量端到端延迟，请在每条消息中写入发送时间戳，并在消费者的应用程序特定负载生成器中计算延迟。不要减去两个脚本的输出。

### 2.2 可靠性配置

| 配置                         | 主题                                                                | 生产者                              | 目的                                                    |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| 生产可靠性基线 | `replication.factor=3`, `min.insync.replicas=2`                      | `acks=all`, `enable.idempotence=true` | 容量规划和生产接受的默认值    |
| 领导确认上限   | `replication.factor=3`; 所有其他设置与测试基线匹配 | `acks=1`, `enable.idempotence=false`  | 估算较弱确认下的吞吐量上限 |

`acks=1` 仅等待领导者确认请求。如果领导者在此后立即失败，则未复制的数据可能会丢失。Kafka 的幂等生产需要 `acks=all`，因此 `acks=1` 测试必须显式设置 `enable.idempotence=false` 以避免冲突的客户端配置。每个容量结果必须标识其可靠性配置。不要将领导确认上限报告为生产可靠性容量。

### 2.3 访问路径

外部连接可以使用传输层安全性 (TLS) 和简单身份验证和安全层 (SASL)。使用与应用程序计划的相同安全配置进行测试。

| 访问路径         | 客户端位置                                                                                     | 包含在结果中的约束                                                                                | 用例                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 集群内容量 | 专用负载测试节点在业务集群中，通过内部引导服务连接 | Kafka、集群网络和存储                                                                               | 实例容量和调优；这是本指南中的默认路径 |
| 外部端到端 | 客户选择的源集群或主机，通过实际外部监听器连接            | 所有集群内约束加上负载均衡器、广域网 (WAN)、防火墙、TLS/SASL 和客户端出口 | 应用程序连接接受                                  |

不要将两个路径的结果合并。对于外部端到端测试，保存客户端位置、监听器、往返延迟、数据包丢失和网络路径。确认客户端可以访问 Kafka 元数据中宣传的每个代理地址，而不仅仅是引导地址。在第 4.3 节初始化变量后，从当前资源状态读取监听器地址，而不是根据命名规则推断它们：

```bash
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{range .status.listeners[*]}{.name}{"\t"}{.bootstrapServers}{"\n"}{end}'
```

### 2.4 元数据模式

| 区域                                | KRaft 实例                                                             | 基于 ZooKeeper 的实例                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 元数据法定人数                     | KRaft 控制器法定人数                                                    | ZooKeeper 集群                                                                              |
| 控制器角色                     | 根据部署情况，专用或组合控制器/代理角色 | 一个代理被选为活动 Kafka 控制器；ZooKeeper 节点不是 Kafka 控制器 |
| 生成的工作负载                 | Kafka Pods 和（在支持的情况下）`KafkaNodePool` 资源                 | Kafka 和 ZooKeeper StatefulSets                                                                |
| 主要健康证据             | `kafka-metadata-quorum.sh`、控制器指标和代理健康          | ZooKeeper 集群指标、恰好一个活动 Kafka 控制器和代理健康              |
| 代理数据卷外的存储 | 控制器元数据存储，取决于角色布局                      | 每个 ZooKeeper 节点的单独持久卷声明 (PVC)                                |

根据最终生成的资源和已安装的操作员架构确定模式，而不仅仅是根据 Kafka 版本。记录每个结果的模式、操作员版本、Kafka 版本和生成的资源形状。

## 3. 标准测试矩阵

首先运行标准矩阵以生成可比较的数据，然后添加与实际消息模型、连接安全性和并发模式匹配的工作负载。分别为 KRaft 和基于 ZooKeeper 的实例运行完整矩阵；在比较系列中，元数据模式不得更改。

### 3.1 实例和消息矩阵

| 代理资源 | 代理 | 主题分区 | 复制因子 | 消息大小        |
| ---------------- | ------: | ---------------: | -----------------: | -------------------- |
| 1 vCPU / 2 GiB   |       3 |               30 |                  3 | 100 B, 500 B, 1000 B |
| 2 vCPU / 4 GiB   |       3 |               30 |                  3 | 100 B, 500 B, 1000 B |
| 4 vCPU / 8 GiB   |       3 |               30 |                  3 | 100 B, 500 B, 1000 B |
| 8 vCPU / 16 GiB  |       3 |               30 |                  3 | 100 B, 500 B, 1000 B |

使用这些记录计数作为标准点：

- 对于 1、2 和 4 vCPU，发送每个消息大小 50,000,000 条记录。
- 对于 8 vCPU，发送 100 B 和 500 B 的 100,000,000 条记录，以及 1000 B 的 50,000,000 条记录。

每个标准生产者点以一个生产者进程开始。如果第 12 节显示客户端首先达到其限制，请添加进程并单独报告聚合结果。标准消费者点的目标是 20 个消费者。在每个元数据模式中在同一消费者组中运行 20 个独立进程。不要依赖 `--threads`：Kafka 4.2 不提供它，而一些传统的 Kafka 2.x 脚本接受它但忽略它。进程可以分布在多个资源充足的 Pods 中，但记录每个 Pod 中的进程和资源数量。

如果测试窗口或磁盘容量无法支持这些记录计数，请减少它们，但保持每个稳定状态点运行至少 10 分钟，并记录实际计数和持续时间。短暂的突发结果不能替代稳定状态容量。

### 3.2 应用程序特定矩阵

除了标准矩阵外，至少测试一个与生产计划匹配的配置：

- 消息大小分布，而不仅仅是平均大小；
- 记录键分布和分区策略；
- `compression.type`；
- 连接安全性，如 TLS 和 SASL；
- 生产者和消费者实例的数量；
- 主题数量、分区数量、复制因子和保留时间；
- 实际突发和空闲周期。

如果没有可用的生产工作负载分布，请将结论标记为合成工作负载结果。不要将其呈现为应用程序容量。

## 4. 先决条件

### 4.1 环境隔离

1. 创建专用命名空间、Kafka 实例、主题、消费者组和负载测试客户端。
2. 将代理分布在 Kubernetes 节点上。对于基于 ZooKeeper 的实例，将 ZooKeeper 副本也分布在节点和故障域上。保留生产计划，以确定一个代理和一个 ZooKeeper Pod 是否可以共享一个节点。
3. 不要将负载测试客户端放置在任何代理、控制器或 ZooKeeper 节点上，因为客户端资源争用会扭曲结果。
4. 在测试期间不要进行扩展、升级、节点维护、存储迁移、ZooKeeper 重新配置或其他高负载任务。
5. 使用与目标环境相同的节点和持久卷类型。优先选择本地块存储或合格的块存储进行生产容量测试。不要将不合格的共享文件存储的结果推断到块存储环境。
6. 对于每个实例参数测试使用新的实例，或删除测试主题并等待实例稳定。在更改需要重启的参数后，等待所有 Pods 准备就绪、所有副本同步，并且 KRaft 法定人数或 ZooKeeper 集群稳定后再开始下一次运行。

### 4.2 所需工具和权限

- 对业务集群的 `kubectl` 访问；
- 对 Kafka 和（对于传统部署）ZooKeeper 资源的所需权限，以及测试命名空间中的 Pods、StatefulSets、ConfigMaps、Secrets、Services 和持久卷声明 (PVC) 的权限；
- 对平台监控或 Prometheus 时间序列数据的读取权限；
- 读取已部署代理 Pod 的 Kafka 镜像名称的权限。本指南重用由操作员管理的 Kafka 镜像，不需要私有镜像名称；
- 用于 SASL/TLS 的客户端配置 Secret。报告中不要包含密码、令牌、私钥或完整的 Secrets。

### 4.3 创建证据目录

在一个 Bash 会话中运行以下初始化。后续代码块使用这些变量和错误处理选项：

```bash
set -euo pipefail

export KUBECONFIG=/path/to/business-cluster.kubeconfig
export NS=kafka-perf
export CLUSTER=perf-kafka
export TOPIC=perf-rf3-p30
export METADATA_MODE=kraft
export GROUP="perf-$(date -u +%Y%m%dT%H%M%SZ)"
export RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${CLUSTER}"
export OUT="$(pwd)/kafka-perf-${RUN_ID}"
mkdir -p "$OUT"

kubectl version -o yaml >"$OUT/kubectl-version.yaml"
kubectl cluster-info >"$OUT/cluster-info.txt"
kubectl get nodes -o wide >"$OUT/nodes.txt"
kubectl get storageclass -o yaml >"$OUT/storageclasses.yaml"
```

对于基于 ZooKeeper 的实例，将 `METADATA_MODE` 设置为 `zookeeper`。在完整比较系列中保持此变量不变。

仅导出非敏感元数据。不要将 kubeconfig 文件、Secret 数据、注册表凭据或客户端密码写入证据目录。

## 5. 导出和冻结实例参数

一般 Kafka 参数模板通常命名为 `general-kafka`。参数模板是存储在 global 集群中的产品配置，而不是在业务集群中，因此不要从测试环境中使用 `kubectl` 读取它们。在产品控制台中选择并查看模板；业务集群中的 `RdsKafka` 资源存储最终有效的实例配置。模板可能会在产品版本之间发生变化，因此在每次测试中冻结从创建的实例获取的基线，而不是依赖本指南中的表格。

创建实例时，在产品控制台中选择一般 Kafka 参数模板，并记录模板名称、描述和显示的参数值。实例创建后，将第 7.2 节中导出的最终 `spec.config` 视为冻结基线。不要从模板名称推断值。

在当前标准通用模板中至少查看以下参数。示例基线仅标识参数；它不替代已安装的模板。

| 代理参数                    | 示例基线 | 效果和测试解释                                                                                 |
| ----------------------------------- | ---------------: | -------------------------------------------------------------------------------------------------------------- |
| `auto.create.topics.enable`         |          `false` | 防止因拼写错误而意外创建主题；显式创建测试主题               |
| `default.replication.factor`        |              `3` | 省略时的默认值；测试仍然明确指定 `3`                            |
| `min.insync.replicas`               |              `1` | 模板基线；在主题或实例级别显式设置为 `2` 以进行生产可靠性测试 |
| `num.network.threads`               |              `3` | 处理网络请求的线程数量                                                                |
| `num.io.threads`                    |              `8` | 处理请求和磁盘相关工作的线程数量                                                  |
| `num.replica.fetchers`              |              `1` | 每个源代理的副本提取线程数量                                                            |
| `num.recovery.threads.per.data.dir` |              `1` | 启动恢复和关闭刷新时每个数据目录的线程数量                                           |
| `background.threads`                |             `10` | 后台任务线程池大小                                                                               |
| `message.max.bytes`                 |        `1048588` | 代理接受的最大记录批大小；不是单个记录的大小                                     |
| `compression.type`                  |       `producer` | 保留生产者选择的压缩类型                                                          |
| `log.segment.bytes`                 |     `1073741824` | 日志段大小                                                                                               |
| `log.retention.hours`               |            `168` | 基于时间的保留期                                                                                    |
| `log.roll.hours`                    |            `168` | 日志段滚动前的最大时间                                                                        |
| `delete.topic.enable`               |           `true` | 允许删除测试主题                                                                               |
| `unclean.leader.election.enable`    |          `false` | 防止 ISR 外的副本成为领导者                                                        |

当前产品版本决定如何应用参数更改。在更改参数之前，请在控制台参数编辑器中检查该更改是否标记为需要重启，并在报告中记录该分类。如果应用更改执行滚动重启，请将滚动重启间隔排除在测量窗口之外。

### 5.1 针对基于 ZooKeeper 的实例的附加快照

面向产品的 `RdsKafka` API 和生成的 Strimzi `Kafka` 资源是不同的层。在测试之前保存两者。第一个快照记录请求的模式和 ZooKeeper 尺寸；第二个记录操作员生成的内容：

```bash
kubectl -n "$NS" get rdskafka "$CLUSTER" \
  -o jsonpath='{.spec.mode}{"\n"}{.spec.version}{"\n"}{.spec.zookeeper}{"\n"}' \
  >"$OUT/rdskafka-zookeeper-requested.txt"
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.version}{"\n"}' \
  >"$OUT/kafka-version.txt"
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.config}' \
  >"$OUT/kafka-broker-config.json"
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.zookeeper}' \
  >"$OUT/zookeeper-spec.json"
```

记录 `log.message.format.version` 和 `inter.broker.protocol.version`（如果存在）。不匹配代理主版本和次版本的值可能表示升级不完整。在性能比较期间不要更改这两个值。

`RdsKafka` API 显示 ZooKeeper 副本、资源、存储、JVM 选项、Pod 模板和日志。它不显示任意的 ZooKeeper 配置或 `metricsConfig`。产品操作员注入生成的 Strimzi `Kafka.spec.zookeeper.metricsConfig` 和相应的指标 ConfigMap。不要修补生成的 `Kafka` 资源以绕过 `RdsKafka` API；协调可能会覆盖该更改。除非其中一个是测试中的单一变量，否则保持暴露的 ZooKeeper 字段和生成的指标映射不变。

## 6. 持久卷容量和存储资格

### 6.1 有界合成测试的容量公式

对于一个主题，估算每个代理存储的消息有效负载如下：

```text
每个代理的有效负载字节 ≈ 记录计数 × 记录字节 × 复制因子 ÷ 代理计数 ÷ 测量的压缩比
推荐的最小 PVC = 每个代理的有效负载字节 × 安全系数 + 其他主题、索引和操作保留
```

压缩比是未压缩字节除以存储字节。在没有可用的测量比率时，估算时使用 `1`；不要假设压缩收益。本指南对新的单主题有界合成测试使用的工程安全系数为 `1.5`。该系数不是 Kafka 默认值，并且不适用于生产容量规划。在数据可能偏斜、副本可能重新分配、存在多个主题或在保留期内继续写入时，根据测量峰值增加它。单独保留迁移空间。

对于 3 个代理、复制因子 3 和压缩比 1，平均在每个代理上存储每条记录的一个副本。有效负载和推荐的最小值为：

|     记录 | 消息大小 | 每个代理的有效负载 | 乘以 1.5 后向上取整的最小值 |
| ----------: | -----------: | -----------------: | ------------------------------------------: |
|  50,000,000 |        100 B |           4.66 GiB |                                       7 GiB |
|  50,000,000 |        500 B |          23.28 GiB |                                      35 GiB |
|  50,000,000 |       1000 B |          46.57 GiB |                                      70 GiB |
| 100,000,000 |        100 B |           9.31 GiB |                                      14 GiB |
| 100,000,000 |        500 B |          46.57 GiB |                                      70 GiB |

该表未单独考虑键、记录头、批处理开销、索引、控制记录、其他主题或临时重新分配空间。因此，50 GiB 的 PVC 对于安全运行 50,000,000 条 1000 B 记录或 100,000,000 条 500 B 记录的完整标准点是不够的。不要将此有界公式用于无限持续时间或未知写入量的测试。根据写入速率、保留时间和目标磁盘利用率计算这些情况。

专用 KRaft 控制器不存储主题消息有效负载，必须不使用代理有效负载公式。其 PVC 必须满足已安装产品版本的最小值，并根据主题和分区数量、元数据日志增长和保留进行校准。当控制器和代理在组合角色中共享数据卷时，PVC 必须容纳代理有效负载的最小值加上元数据、索引和操作保留。

ZooKeeper PVC 也不存储主题有效负载，必须不使用代理有效负载公式。根据观察到的 ZooKeeper 数据和快照增长、恢复要求和显式的空闲空间保留进行大小调整。使用持久的、低延迟的块存储，并将 ZooKeeper 卷与 Kafka 代理数据卷分开。不要使用临时 ZooKeeper 存储进行容量结果：使用临时存储的单副本集群在重启后会丢失集群元数据，任何临时集群都会引入不代表生产的恢复条件。

对于此传统操作员模型，存储类型和类别不是一般调优变量。持久卷扩展仅限于增加，取决于 StorageClass，并导致操作员重新启动使用调整大小的卷的 Pods。在测量窗口之前完成任何扩展，并等待完整集群和所有代理会话稳定。

### 6.2 存储检查

```bash
kubectl -n "$NS" get pvc -o wide >"$OUT/pvc-before.txt"
kubectl -n "$NS" get pod -o wide >"$OUT/pods-before.txt"

# 使用当前实例的标签进行过滤；不要假设 Pod 名称。
kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-kafka" \
  -o wide
```

确认：

- 每个 PVC 都是 `Bound`，并且至少与计算的要求一样大；
- 持久卷和节点按测试设计的要求分布；
- StorageClass、卷类型、文件系统和节点磁盘与目标环境匹配；
- 没有节点持续的磁盘压力，Kafka 没有副本等待恢复。

存储延迟是 Kafka 的主要约束。仅凭 StorageClass 名称无法证明存储等效性。在测试期间还要保存提供者、介质类型、拓扑以及 I/O 延迟和利用率。

## 7. 创建或更新 Kafka 实例

在产品控制台中创建专用实例，或更新现有的专用测试实例。控制台字段可能会在产品版本之间发生变化。将 `RdsKafka` 资源和业务集群中生成的 Strimzi 资源视为最终状态。

### 7.1 拓扑

- 使用至少 3 个代理。
- 将代理分布在节点和故障域中，并使用 Pod 反亲和性。
- 使用与生产相同的元数据模式和角色布局。
- 在第 3 节中测试代理 CPU 和内存大小，同时保持元数据服务资源固定，以便代理和元数据服务的大小不会同时变化。
- 不要允许 Java 虚拟机 (JVM) 堆限制消耗所有容器内存。为页面缓存和容器中的非堆内存保留内存。

> Kafka 依赖于操作系统页面缓存。增加 JVM 堆不会增加 Kafka 可用的缓存。配置得过于接近容器限制的堆可能会减少页面缓存容量。内存不足 (OOM) 也可能终止容器。

对于 KRaft，匹配专用控制器或组合控制器/代理角色的生产使用，并在报告中说明角色布局。在测试代理大小时保持控制器数量、资源和存储固定。

对于 ZooKeeper 模式：

- 使用奇数数量的 ZooKeeper 副本，生产代表性测试至少使用 3 个；
- 将 ZooKeeper 副本分布在节点和故障域中，并使用 Pod 反亲和性；
- 使用持久的、低延迟的块存储，并保持 ZooKeeper 资源、JVM 选项、存储和配置固定；
- 记录哪个代理是活动的 Kafka 控制器，但不要将 ZooKeeper Pod 描述为 Kafka 控制器；
- 保留代理和 ZooKeeper Pods 之间的生产共置策略。

提交控制台表单后，验证以下 KRaft 字段与当前的 `RdsKafka` 自定义资源定义 (CRD) 进行比较。不要从显示的控制台值推断有效配置：

| `RdsKafka` 字段                 | 标准测试要求                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `spec.mode`                      | `KRaft`                                                                                                               |
| `spec.replicas`                  | 3 个代理                                                                                                             |
| `spec.resources.requests/limits` | 当前矩阵大小；记录请求和限制                                                                  |
| `spec.storage.class`             | 客户选择的合格 StorageClass                                                                          |
| `spec.storage.size`              | 至少是第 6 节中计算的值                                                                            |
| `spec.storage.deleteClaim`       | 根据数据保留和销毁要求进行选择；不要仅将其设置为 `true` 以简化清理     |
| `spec.controller`                | 角色、数量、资源和存储与生产计划匹配；对于专用控制器使用至少 3 个投票节点 |
| `spec.config`                    | 从所选一般模板记录的基线加上本次运行中更改的一个参数                       |
| `spec.kafka.listeners`           | 与本次运行的集群内或外部访问路径匹配                                                           |
| `spec.kafkaExporter`             | 当需要消费者组堆积时启用，主题和组的正则表达式限制在测试范围内       |

```bash
kubectl explain rdskafka.spec --recursive \
  >"$OUT/rdskafka-spec-schema.txt"
```

对于基于 ZooKeeper 的实例，验证以下面向产品的字段与已安装的 `RdsKafka` CRD 进行比较：

```bash
kubectl explain rdskafka.spec.zookeeper --recursive \
  >"$OUT/rdskafka-zookeeper-schema.txt"
kubectl get imageversion \
  -l 'middleware.instance/type=kafka,middleware.instance/current=true' \
  -o jsonpath='{range .items[*].spec.components.kafka.versions[*]}{.displayVersion}{"\t"}{.version}{"\n"}{end}' \
  >"$OUT/kafka-supported-versions.txt"
test -s "$OUT/kafka-supported-versions.txt"
```

| `RdsKafka` 字段                 | 标准测试要求                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.mode`                      | 明确设置为 API 枚举值 `Zookeeper`                                                                                          |
| `spec.version`                   | 安装产品宣传的支持 ZooKeeper 的版本；对于已部署的操作员 2.x 路径，选择支持的 Kafka 2.x 版本 |
| `spec.replicas`                  | 3 个代理                                                                                                                                 |
| `spec.resources.requests/limits` | 当前代理矩阵大小；记录请求和限制                                                                               |
| `spec.storage`                   | 根据第 6 节大小的合格代理持久存储                                                                                    |
| `spec.config`                    | 冻结的代理基线；当存在时记录 `inter.broker.protocol.version` 和 `log.message.format.version`                              |
| `spec.kafka`                     | 代理的监听器、授权、Pod 模板、JVM 和日志设置                                                              |
| `spec.zookeeper.replicas`        | 奇数计数，生产代表性测试至少使用 3 个                                                                           |
| `spec.zookeeper.resources`       | 固定请求和限制；当 `spec.zookeeper` 存在时是必需的                                                                      |
| `spec.zookeeper.storage`         | 持久的、低延迟的块存储，具有固定的类型、类别和大小                                        |
| `spec.zookeeper.jvmOptions`      | 固定的堆设置，当显式配置时                                                                                           |
| `spec.zookeeper.template`        | 固定的 Pod 安全性、亲和性和容忍设置，当显式配置时                                                         |
| `spec.zookeeper.logging`         | 固定的内联日志设置，当显式配置时                                                                                 |
| `spec.kafkaExporter`             | 当需要消费者组堆积时启用，主题和组的正则表达式限制在测试范围内                           |

操作员 2.x 实现是从 `spec.version` 中选择的，而不是从 `spec.mode` 中选择的。对于已安装版本支持的传统 Kafka 2.x 版本，`RdsKafka` 协调器始终构建基于 ZooKeeper 的 Strimzi 资源。仍然显式设置 `spec.mode: Zookeeper`，以便声明的 API 状态与生成的拓扑匹配，并保持对自动化的明确性。

如果省略 `spec.zookeeper`，当前实现将代理副本、资源和存储设置复制到 ZooKeeper 默认值。不要依赖该回退作为性能基线：指定 `spec.zookeeper`，以便元数据服务的大小是明确的，并且在代理大小变化时可以保持不变。

还要验证生成的 Strimzi `Kafka` 资源中的这些只读结果。字段的可用性由已安装的 Strimzi CRD 决定：

| 生成的 `Kafka` 字段        | 标准测试要求                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `spec.kafka.version`           | 安装和支持的 Kafka 版本；保持固定                                                               |
| `spec.kafka.replicas`          | 3 个代理                                                                                                       |
| `spec.kafka.resources`         | 当前矩阵大小；记录请求和限制                                                                 |
| `spec.kafka.storage`           | 根据第 6 节大小的合格持久块存储                                                           |
| `spec.kafka.config`            | 冻结的代理基线；当存在时记录 `inter.broker.protocol.version` 和 `log.message.format.version`    |
| `spec.zookeeper.replicas`      | 奇数计数，生产代表性测试至少使用 3 个                                                 |
| `spec.zookeeper.resources`     | 固定请求和限制                                                                                       |
| `spec.zookeeper.storage`       | 持久的、低延迟的块存储，具有固定的类型、类别和大小                                        |
| `spec.zookeeper.jvmOptions`    | 固定的堆和 JVM 设置                                                                                     |
| `spec.zookeeper.metricsConfig` | 自动生成的 Java 管理扩展 (JMX) Prometheus 导出器映射存在                 |
| `spec.kafkaExporter`           | 当需要消费者组堆积时启用，主题和组的正则表达式限制在测试范围内 |

不要为基于 ZooKeeper 的实例设置仅限 KRaft 的 `RdsKafka.spec.controller` 字段或创建 `KafkaNodePool` 资源。

### 7.2 固定变量

在每个测试周期中仅更改一个评估变量。保持以下内容固定并在报告中记录：

- Kafka 和操作员版本以及元数据模式；
- KRaft 角色放置和代理/控制器计数，或 ZooKeeper 副本计数和活动代理控制器状态；
- 代理、控制器和 ZooKeeper 的 CPU、内存、JVM 堆、节点选择和反亲和性（如适用）；
- StorageClass、PVC 大小和存储介质；
- 完整的代理配置快照；
- 主题分区、复制因子和 `min.insync.replicas`；
- 客户端镜像版本、资源、节点位置和连接安全性；
- 消息大小、记录计数、压缩、键分布、确认和消费者参数。

保存最终实例状态：

```bash
kubectl -n "$NS" get rdskafka "$CLUSTER" -o yaml \
  >"$OUT/rdskafka.yaml"
kubectl -n "$NS" get kafka "$CLUSTER" -o yaml \
  >"$OUT/kafka.yaml"
kubectl -n "$NS" get pod,pvc,service -o wide \
  >"$OUT/workloads-before.txt"
```

对于 KRaft，还要保存节点池：

```bash
kubectl -n "$NS" get kafkanodepool \
  -l "strimzi.io/cluster=${CLUSTER}" -o yaml \
  >"$OUT/kafkanodepools.yaml"
```

对于 ZooKeeper 模式，保存生成的 StatefulSets 和 ZooKeeper Pods：

```bash
kubectl -n "$NS" get statefulset \
  "${CLUSTER}-kafka" "${CLUSTER}-zookeeper" -o yaml \
  >"$OUT/kafka-zookeeper-statefulsets.yaml"
kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-zookeeper" -o wide \
  >"$OUT/zookeeper-pods-before.txt"
```

如果任何收集命令失败，请停止并检查权限、资源名称或实例状态。不要用 `|| true` 隐藏错误。

### 7.3 监控选项

在创建实例时启用平台提供的 Kafka 指标收集。如果需要消费者组堆积，还要启用 Kafka 导出器，并将其主题和消费者组的正则表达式限制在此测试范围内。在开始负载测试之前，检查最终资源和导出器 Pod：

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

对于 ZooKeeper 模式，还要保存其指标配置，并确认所有集群 Pods 存在：

```bash
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.zookeeper.metricsConfig}' \
  >"$OUT/zookeeper-metrics-config.json"
kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-zookeeper" -o wide
```

如果 Kafka 导出器查询未找到任何 Pod，则 Kafka 导出器已禁用或当前版本使用不同的标签。不要将该空结果解释为零堆积。如果 ZooKeeper 查询未找到任何 Pod，请停止 ZooKeeper 模式测试并检查 `RdsKafka` 状态、生成的 `Kafka` 资源和实际 Pod 标签。

## 8. 部署负载测试客户端

### 8.1 重用实例 Kafka 镜像

从代理 Pod 中读取操作员使用的 Kafka 镜像。这使得脚本版本与服务器版本保持一致，而无需在外部文档中暴露镜像注册表地址。此镜像的 Kafka 版本还决定了哪些脚本选项存在；在第 8.4 节中记录它，并在镜像早于 Kafka 4.2 时使用第 8.5 节的表单。

```bash
export KAFKA_IMAGE="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-kafka" \
  -o jsonpath='{.items[0].spec.containers[?(@.name=="kafka")].image}')"

test -n "$KAFKA_IMAGE"
export BOOTSTRAP="${CLUSTER}-kafka-bootstrap.${NS}.svc:9092"
```

服务名称遵循 Strimzi 内部引导服务约定，但查询当前实例以验证监听器、端口和身份验证方法：

```bash
kubectl -n "$NS" get service -l "strimzi.io/cluster=${CLUSTER}" -o wide
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.listeners}' >"$OUT/listeners.json"
```

以下示例使用隔离命名空间中的明文内部监听器。对于 TLS/SASL，将所有客户端属性放入受访问控制的 Secret 中，并将其作为只读卷挂载。不要将密码作为命令行参数传递。

### 8.2 创建客户端属性

```bash
kubectl -n "$NS" create configmap kafka-perf-client-config \
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

当启用身份验证时，准备包含性能和连接属性的完整 `producer.properties` 和 `consumer.properties` 文件，存放在受控的本地目录中。使用 Secret 而不是 ConfigMap：

```bash
kubectl -n "$NS" create secret generic kafka-perf-client-config \
  --from-file=admin.properties=/secure/path/admin.properties \
  --from-file=producer.properties=/secure/path/producer.properties \
  --from-file=consumer.properties=/secure/path/consumer.properties \
  --dry-run=client -o yaml | kubectl apply -f -
```

还要将第 8.3 节中两个 Pods 的 `configMap` 卷源替换为：

```yaml
secret:
  secretName: kafka-perf-client-config
```

`admin.properties` 仅包含管理脚本所需的连接安全属性。生产者和消费者文件分别包含其性能属性。`security.protocol`、SASL 和 SSL 设置必须与实例监听器匹配。报告和证据目录中仅存储已编辑的副本。不要导出 Secrets、密码、令牌、私钥或未编辑的 Java 身份验证和授权服务 (JAAS) 配置。

### 8.3 创建客户端 Pods

```bash
kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: kafka-producer-perf
  labels:
    app: kafka-perf
    role: producer
spec:
  restartPolicy: Never
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: strimzi.io/cluster
                operator: In
                values: ["${CLUSTER}"]
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
        name: kafka-perf-client-config
---
apiVersion: v1
kind: Pod
metadata:
  name: kafka-consumer-perf
  labels:
    app: kafka-perf
    role: consumer
spec:
  restartPolicy: Never
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: strimzi.io/cluster
                operator: In
                values: ["${CLUSTER}"]
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
        name: kafka-perf-client-config
EOF

kubectl -n "$NS" wait --for=condition=Ready \
  pod/kafka-producer-perf pod/kafka-consumer-perf --timeout=300s
kubectl -n "$NS" get pod -l app=kafka-perf -o wide
```

如果集群没有与所有代理分开的节点，`required` 反亲和性会使客户端 Pods 处于待定状态。添加专用负载测试节点。仅在无法添加节点且明确接受资源争用偏差时，将规则更改为 `preferred`，然后在报告中记录该限制。

如果 Pod 报告 `ImagePullBackOff`，请使用 `kubectl describe pod` 检查原因，然后检查代理 Pod 的 `spec.imagePullSecrets` 和服务帐户。如果需要拉取 Secret，请在客户端 Pod 的 `spec.imagePullSecrets` 中引用已批准的 Secret。不要在文档、命令行或测试报告中放置注册表密码。

初始客户端限制为 1 vCPU / 2 GiB 并不是容量限制。如果客户端 CPU 接近限制、节点网络接口达到容量、CPU 限制发生或垃圾回收变得异常，请增加客户端资源或客户端 Pods，然后再将瓶颈归因于 Kafka。

### 8.4 记录脚本版本和接口

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh --version \
  | tee "$OUT/kafka-client-version.txt"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh --help \
  >"$OUT/producer-perf-help.txt" 2>&1

kubectl -n "$NS" exec kafka-consumer-perf -- \
  /opt/kafka/bin/kafka-consumer-perf-test.sh --help \
  >"$OUT/consumer-perf-help.txt" 2>&1
```

如果 Kafka 安装在镜像中的路径不是 `/opt/kafka`，请从镜像文档或代理容器环境确认路径并更新命令。不要混合使用从未知版本下载的脚本。

### 8.5 适用于早于 Kafka 4.2 的客户端的脚本兼容性

本指南中使用的标准化选项是在 Apache Kafka 4.2 中引入的，早期客户端中不存在。这影响了两个已发布的客户端代：基于 Strimzi 0.48 的操作员发布提供 Kafka 4.0 或 4.1 镜像，而基于 ZooKeeper 的操作员线提供传统的 Kafka 2.x 镜像。将两个代的受影响选项替换如下：

| 操作                            | 本指南中的 Kafka 4.2 示例             | Kafka 2.x、4.0 和 4.1 的形式                                                                          |
| ------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 生产者引导和属性文件 | `--bootstrap-server` 和 `--command-config` | 将 `bootstrap.servers=$BOOTSTRAP` 放入属性文件中，并使用 `--producer.config`                       |
| 生产者预热                      | `--warmup-records`                          | 没有等效选项（`--warmup-records` 是在 Kafka 4.2 中添加的）；运行单独的预定义预热周期 |
| 生产者间隔选项             | `--reporting-interval`                      | 在 Kafka 4.2 之前未公开；保留脚本的原始间隔输出                                   |
| 生产者属性覆盖           | `--command-property`                        | 使用单独的完整 `--producer.config` 文件                                                          |
| 消费者记录目标               | `--num-records`                             | `--messages`                                                                                              |
| 消费者属性文件               | `--command-config`                          | `--consumer.config`                                                                                       |
| 消费者并发                 | 每个消费者一个进程                    | 使用每个消费者一个进程以保持跨版本一致性                                                |

一些早期的 Kafka 2.x 脚本实现了 `--threads`，而较新的 Kafka 2.x 脚本接受它但忽略它。永远不要使用 `--threads` 来建立标准并发点。使用独立的进程或 Pods，并验证实际的消费者组成员资格。

对于预 4.2 的生产者测试，在创建 ConfigMap 或 Secret 之前将解析的引导地址添加到生产者属性文件中：

```properties
bootstrap.servers=perf-kafka-kafka-bootstrap.kafka-perf.svc:9092
```

将示例值替换为 `$BOOTSTRAP` 的解析值；属性文件不会扩展 shell 变量。当启用身份验证时，将连接安全属性存储在同一受保护文件中。

## 9. 创建和验证测试主题

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --create --if-not-exists \
  --topic "$TOPIC" \
  --partitions 30 \
  --replication-factor 3 \
  --config min.insync.replicas=2

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --topic "$TOPIC" \
  | tee "$OUT/topic-before.txt"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --entity-type topics --entity-name "$TOPIC" --describe \
  | tee "$OUT/topic-config.txt"
```

在开始之前确认：

- `PartitionCount=30` 和 `ReplicationFactor=3`；
- 每个分区都有 3 个副本，ISR 计数为 3；
- 领导者在代理之间没有实质性不平衡；
- 动态主题配置包含 `min.insync.replicas=2`；
- 该主题是本次运行的新主题或已根据测试设计进行清理，并且消费者组名称未被重用。

## 10. 运行一个测试点

### 10.1 生产可靠性基线

在执行之前记录参数。示例是使用 1,000,000 条 500 B 的记录进行功能检查。对于正式的标准点，替换 `--num-records` 并确保 PVC 足够大。

```bash
export NUM_RECORDS=1000000
export RECORD_SIZE=500

kubectl -n "$NS" exec kafka-producer-perf -- sh -c \
  "cat /opt/perf-config/producer.properties" \
  >"$OUT/producer.properties"

kubectl -n "$NS" exec kafka-producer-perf -- \
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

`--throughput -1` 禁用客户端侧限流，并在当前客户端并发下寻找限制。它并不能证明代理已饱和；同时评估客户端和代理指标。保持 `--warmup-records` 在正式比较中固定，仅使用脚本的稳定状态摘要。不要将预热包含在结果中。

对于预 4.2 客户端（Kafka 4.0/4.1 镜像或传统的基于 ZooKeeper 的实例），使用相同的有效负载和生产者属性与早期接口：

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh \
  --topic "$TOPIC" \
  --num-records "$NUM_RECORDS" \
  --record-size "$RECORD_SIZE" \
  --throughput -1 \
  --producer.config /opt/perf-config/producer.properties \
  --print-metrics \
  | tee "$OUT/producer-${RECORD_SIZE}B.txt"
```

在测量预 4.2 命令之前，运行单独的固定预热周期。不要将其记录计入测试目标，并在消费者仅测试之前使用新主题或显式为预热数据进行计数。

### 10.2 领导确认上限

保持所有其他属性不变，仅覆盖确认和幂等性：

```properties
acks=1
enable.idempotence=false
batch.size=50000
linger.ms=5
compression.type=none
buffer.memory=134217728
```

Kafka 4.2 可以通过 `--command-property` 从属性文件覆盖这两个值，从而避免意外更改其他参数：

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
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

将结果标记为 `leader-ack`。不要直接将其与 `acks=all` 容量进行比较。

对于预 4.2 客户端，创建一个单独的 `producer-leader-ack.properties` 文件，包含与基线相同的属性，除了 `acks=1` 和 `enable.idempotence=false`，然后通过 `--producer.config` 传递它。保存两个文件之间的已编辑差异。不要使用不受支持的 `--command-property` 选项。

### 10.3 仅消费者测试

在仅消费者测试之前，加载至少 `NUM_RECORDS` 条记录并使用新的消费者组：

```bash
export NUM_RECORDS=1000000
export RECORD_SIZE=500
export GROUP="perf-consumer-$(date -u +%Y%m%dT%H%M%SZ)"

kubectl -n "$NS" exec kafka-consumer-perf -- sh -c \
  "cat /opt/perf-config/consumer.properties" \
  >"$OUT/consumer.properties"

kubectl -n "$NS" exec kafka-consumer-perf -- \
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

在 Kafka 4.2 中，`--messages` 被弃用；使用 `--num-records`。`--fetch-size` 限制从一个分区在一个请求中获取的数据，`max.partition.fetch.bytes` 客户端属性也适用。从 `--print-metrics` 输出中保存 `records-consumed-total`，并确认消费者读取了目标计数。超时、主题数据不足或授权错误可能导致脚本提前退出，因此不要仅依赖最终的吞吐量行。

对于预 4.2 客户端，使用 `--messages` 和 `--consumer.config`：

```bash
kubectl -n "$NS" exec kafka-consumer-perf -- \
  /opt/kafka/bin/kafka-consumer-perf-test.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --group "$GROUP" \
  --messages "$NUM_RECORDS" \
  --fetch-size 200000 \
  --timeout 60000 \
  --show-detailed-stats \
  --reporting-interval 5000 \
  --consumer.config /opt/perf-config/consumer.properties \
  --print-metrics \
  | tee "$OUT/consumer-${RECORD_SIZE}B.txt"
```

传统的 Kafka 2.x 脚本在某些标题中报告消息而不是记录。保留其原始输出标签，仅在单独的报告字段中进行规范化。

### 10.4 同时生产和消费

1. 启动消费者并确认他们已加入组。
2. 启动生产者。
3. 在稳定状态窗口中收集指标。
4. 在生产者停止后，保持消费者运行，直到堆积达到零或预定义超时到期。
5. 保存最终消费者位置和日志结束偏移量 (LEO)。

不要在同一终端中运行一个消费者命令，然后尝试在同一终端中启动生产者。使用两个终端，或通过作业或测试调度器启动两者，并单独保存它们的标准输出。任何后台执行方法都必须保留进程退出代码。仅依赖日志文件不能证明命令成功。

### 10.5 Kafka 4.2 上的 20 个消费者示例

此示例在一个客户端 Pod 中启动 20 个独立的消费者进程，并检查每个 `kubectl exec` 的退出代码。第 8.3 节中的消费者 Pod 不能不变地运行它：每个脚本进程启动一个 JVM，其默认最大堆为 512 MiB，因此 20 个进程可能会需求几倍于 Pod 的 2Gi 限制，并且 20 个消费者共享 1 vCPU 会使客户端成为瓶颈，而不是 Kafka。增加消费者 Pod 的资源，或从第 8.3 节复制 Pod，并将进程分散到负载测试节点，例如四个 Pods，每个 Pod 五个进程；然后使用第 12.1 节确认客户端 CPU、内存和网络不是瓶颈。还要考虑分区算术：对于 30 个分区和 20 个消费者，十个消费者接收两个分区，十个接收一个，因此每个进程的记录目标仅在完成的消费者离开组并重新平衡重新分配其分区时完成。预计在测试点结束时会有重新平衡，并验证汇总的记录计数，如下所述。

```bash
export CONSUMER_COUNT=20
export CONSUMER_POD=kafka-consumer-perf
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

将所有 20 个文件中实际消费的记录总和，并确认总和等于 `NUM_RECORDS`。计算总吞吐量为总记录或字节除以公共测量窗口。如果进程的开始和结束时间不同，则不要将各自的平均速率相加。任何进程中的超时、非零退出或记录计数不匹配都会使测试点无效。

对于预 4.2 客户端，使用相同的 20 进程分配，但将 `--num-records` 替换为 `--messages`，将 `--command-config` 替换为 `--consumer.config`，并省略 `--command-property`；如果需要每个进程的 `client.id`，则为每个进程使用单独的属性文件。不要添加 `--threads`；在较新的 Kafka 2.x 脚本中它已被弃用并被忽略。

## 11. 客户端参数参考

### 11.1 生产者

| 参数            | 标准值 | 机制和边界                                                                                                                         |
| -------------------- | -------------: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--num-records`      | See the matrix | 发送的记录；总有效负载大约是此值乘以 `--record-size`                                                          |
| `--record-size`      |   100/500/1000 | 合成记录值中的字节；与消息有效负载文件互斥                                                            |
| `--throughput`       |           `-1` | 不限流的限制搜索；对于受控负载，设置目标记录/s                                                                        |
| `--warmup-records`   |    固定值 | 在 Kafka 4.2 中添加；将连接设置、元数据和 JVM 预热排除在摘要之外；在预 4.2 客户端上使用单独的固定预热周期 |
| `acks`               |   `all` 或 `1` | 确认强度；更改它会更改可靠性和性能语义                                                             |
| `enable.idempotence` |         `true` | 防止因重试而导致的重复；需要兼容的确认、重试和在途请求设置                            |
| `batch.size`         |        `50000` | 每个分区的目标最大批量大小；较大的值可能会增加内存使用和等待时间                                                   |
| `linger.ms`          |            `5` | 批处理的最大等待时间；Kafka 4.x 的默认值与早期版本不同，因此显式设置                                               |
| `compression.type`   |         `none` | 标准矩阵禁用压缩；在应用程序矩阵中使用生产算法并记录 CPU 和测量的压缩比 |
| `buffer.memory`      |    `134217728` | 可用于等待发送的记录的总生产者内存；不是完整的容器内存要求                                  |

每个分区都有一个独立的批次。更多的生产者、分区、批量容量或等待时间可以改善批处理，但也可能增加内存使用和延迟。仅当所有其他变量保持固定时，才将结果归因于参数。

### 11.2 消费者

| 参数                               |         标准值 | 机制和边界                                                                                               |
| --------------------------------------- | ---------------------: | -------------------------------------------------------------------------------------------------------------------- |
| `--group`                               |         每次运行唯一 | 同一组中的消费者共享分区；重用组可以从旧偏移量开始                                |
| `--num-records` 或预 4.2 `--messages` | 与预加载数据匹配 | 计划的总记录；选择版本支持的选项并通过客户端指标验证实际值           |
| `--fetch-size`                          |               `200000` | 脚本传递的每个分区的获取大小                                                                        |
| `--timeout`                             |                `60000` | 返回记录之间的最大时间，而不是总测试持续时间；超时会使工具提前退出并发出警告   |
| `fetch.min.bytes`                       |                    `1` | 代理返回获取响应之前的最小数据；增加它可以改善批处理但可能会增加等待延迟 |
| `fetch.max.wait.ms`                     |                  `500` | 当 `fetch.min.bytes` 未达到时的最大等待时间                                                             |
| `max.partition.fetch.bytes`             |              `1048576` | 每个分区的 Fetch 响应的限制；必须能够容纳代理允许的最大记录批次       |
| `fetch.max.bytes`                       |             `52428800` | 单个 Fetch 响应的总体限制，仍然受服务器和分区限制                                   |

一个消费者组中的有效并行性不能超过可分配的分区数量。本指南在每个 Kafka 版本中使用每个脚本进程一个消费者。要运行 2、4 或 8 个消费者，请创建具有相同属性和相同消费者组的独立 Pod 或进程。超出分区数量的消费者将不会接收分区。

矩阵中的 `NUM_RECORDS` 是所有进程的总目标，而不是每个进程的目标。设定并发性 `C`，则 `q=NUM_RECORDS/C` 和 `r=NUM_RECORDS%C`。将 `q+1` 条记录分配给前 `r` 个进程，其余进程分配 `q` 条记录，以使目标总和为 `NUM_RECORDS`。对多生产者测试使用相同的分配。如果每个进程都生产或消费所有 `NUM_RECORDS`，则总数据量已更改，结果不能与单进程点直接比较。

## 12. 找到饱和点和可用容量

### 12.1 首先排除客户端限制

分别使用 1、2、4 和 8 个独立客户端进程探测生产者和消费者。对于标准消费者点，继续到 12、16 和 20，除非首先达到分区并行性或资源限制。尽可能将客户端分布在负载测试节点上，为每个进程使用相同的属性，并聚合进程吞吐量。在每次增加并发性时，至少检查：

- 客户端 Pod CPU、内存、CPU 限制、网络和重启次数；
- 代理 CPU、内存、网络、磁盘延迟和磁盘利用率；
- 请求错误、超时、重试和生产确认延迟；
- `UnderReplicatedPartitions`、`UnderMinIsrPartitionCount` 和消费者组堆积量；
- 分区领导者、日志字节和代理之间的流量平衡；
- 对于 ZooKeeper 模式，ZooKeeper Pod CPU、内存、磁盘延迟和利用率、请求延迟、未完成请求、法定人数和代理 ZooKeeper 会话状态。

如果在添加客户端资源或进程后吞吐量继续显著增加，则之前的结果是客户端限制，不能报告为 Kafka 限制。如果一个负载测试节点上的网络接口饱和，则应添加客户端节点，而不是在该节点上添加更多进程。

### 12.2 两阶段负载阶梯

1. **无节流探测：** 使用 `--throughput -1` 并增加客户端进程以建立可实现的吞吐量范围。
2. **受控负载验证：** 从无节流结果开始，应用大约 25%、50%、75%、90%、100% 和 110% 的目标吞吐量。所有生产者的 `--throughput` 总和等于该点的目标。
3. 热身每个点，然后保持稳定状态至少 10 分钟。之后，等待堆积量达到零并验证副本健康。
4. 在 90% 附近添加更密集的测试点。至少重复最后一个稳定点和第一个不稳定点三次。
5. 随机化重复顺序或重新运行基线以检测热效应、缓存状态、噪声邻居和时间漂移。

这些百分比仅是寻找范围的起始策略；它们不是产品阈值。如果第一个负载点违反健康条件，则降低负载并重新建立范围。

### 12.3 预先定义接受标准

在测试之前，客户必须根据应用程序的服务水平目标 (SLO) 设置这些阈值：

- p95 和 p99 生产确认延迟；
- 错误、超时和重试率；
- 最大消费者堆积量和排空时间；
- 代理、客户端、节点和 PVC 的资源利用限制；
- 允许的 `UnderReplicatedPartitions` 和 `UnderMinIsrPartitionCount`，通常这两个值始终为零；
- 对于 ZooKeeper 模式，稳定的合奏成员资格、恰好一个活动的 Kafka 控制器、可接受的 ZooKeeper 请求延迟、未持续增长的未完成请求和没有代理 ZooKeeper 会话丢失；
- 稳态窗口和重复计数。

如果客户没有阈值，则使用以下作为本测试的工程规则，并将其标记为测试规则，而不是官方 Kafka 阈值：

- 在负载或并发性增加后，聚合吞吐量在两个连续步骤中改善少于 5%；并且
- p99 延迟、错误/超时、堆积量或资源利用继续恶化；或者
- `UnderReplicatedPartitions>0`、`UnderMinIsrPartitionCount>0`、离线日志目录、Pod 重启或磁盘压力发生；或者
- 在 ZooKeeper 模式下，合奏成员资格发生变化，代理的 `ActiveControllerCount` 总和与 1 不同，代理丢失其 ZooKeeper 会话，或者 ZooKeeper 请求延迟或未完成请求突破预定义的测试阈值。

满足组合条件的第一个点是 **饱和点**。在满足所有 SLO 的情况下，最后一个饱和前的点，具有稳定的重复结果且没有健康异常的是 **可用容量**。不要用瞬时最大值替代可用容量。

报告重复变异性。默认情况下，使用中位数作为中心，同时报告最小值、最大值和变异系数。如果一个测试点的吞吐量变异系数大于 5%，则调查环境漂移并增加重复次数。5% 的值也是本测试的规则，而不是 Kafka 的保证。

## 13. 实例参数调优

使用模板基线完成一次运行，然后根据监控证据逐个更改参数。以下条目是诊断方向，而不是固定的最佳值。

| 参数或资源                | 何时考虑更改                                                                           | 验证                                                                      | 风险和停止条件                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代理 CPU                   | 请求处理线程繁忙，CPU 保持在其限制附近，且客户端未饱和                             | 添加 CPU 并重复相同负载                                                | 如果在磁盘或网络满时吞吐量没有改善，则更多的 CPU 将无济于事                                                                                        |
| 代理内存/JVM 堆           | 容器内存压力、频繁的垃圾回收 (GC) 或不足的页面缓存                               | 观察堆、GC、常驻集大小 (RSS)、工作集和磁盘读取情况                     | 过大的堆会取代页面缓存；堆太接近容器限制可能导致内存不足 (OOM) 事件                                                      |
| `num.network.threads`      | `NetworkProcessorAvgIdlePercent` 保持低且 CPU 头部空间存在                         | 小步增加并重复相同点                                                   | 更多线程增加调度和内存开销，无法修复饱和的网络接口                                                                                |
| `num.io.threads`           | `RequestHandlerAvgIdlePercent` 保持低且磁盘和 CPU 头部空间存在                     | 小步增加并比较请求等待和吞吐量                                         | 至少覆盖数据卷的数量；线程过多可能增加上下文切换和 I/O 争用                                                               |
| `num.replica.fetchers`     | 副本缓慢赶上且复制流量有未使用的资源                                               | 在受控恢复或高复制负载期间验证                                        | 更多的提取器增加网络、磁盘和 CPU 使用                                                                                                                           |
| `num.recovery.threads.per.data.dir` | 启动或恢复太慢                                                                     | 在受控恢复测试中验证                                                  | 更快的恢复增加了与前台 I/O 的干扰                                                                                                                  |
| 主题分区数量              | 每个分区的吞吐量限制且存在足够的消费者并发性                                     | 将新主题与不同分区数量进行比较                                        | 更多分区更改键排序范围并增加元数据和副本开销；分区不能随意减少                                                   |
| 代理数量                  | 代理已达到其资源限制，需要水平扩展                                               | 扩展，等待副本重新分配完成，然后重新测试                               | 单独添加代理不会重新平衡现有的分区数据；重新分配期间的结果无效                                                                    |
| `message.max.bytes`        | 最大的应用记录批次超过默认值                                                      | 一起检查主题、生产者和消费者提取限制                                 | 更大的值增加内存和网络突发；不一致的设置会导致生产或消费失败                                                                 |
| 保留和日志段参数         | 磁盘使用、删除粒度或恢复时间不符合要求                                            | 在较长时间间隔内测试保留和删除行为                                     | 不要仅仅为了改善短基准而更改生产保留                                                                                                        |
| ZooKeeper CPU、内存或 JVM 堆 | ZooKeeper 请求延迟或未完成请求上升，而存储有头部空间                               | 更改一个资源维度并重复相同的元数据和流量负载                         | 过大的堆可能增加暂停时间；资源变化使直接比较无效，除非它们是被测试的变量                                                   |
| ZooKeeper 存储            | 请求延迟与磁盘延迟、队列深度或同步写入压力相关                                     | 在单独实例中验证更低延迟的持久块存储                                   | 存储类别或介质的变化会创建新的环境基线；不要将其作为仅限代理的调优增益呈现                                                          |
| ZooKeeper 副本数量        | 可用性要求或生产拓扑需要不同的奇数大小合奏                                         | 在测量容量窗口之外验证法定人数健康和故障转移                          | 副本数量不是常规吞吐量旋钮；偶数数量不会比前面的奇数数量增加故障容忍度，重新配置使测量窗口无效 |

对于 Apache Kafka 线程空闲指标，值越接近零表示线程越忙。如果 `NetworkProcessorAvgIdlePercent` 或 `RequestHandlerAvgIdlePercent` 保持在大约 0.3 以下，则应一起评估 CPU、网络和存储，以确定处理能力不足。该值是诊断信号，而不是独立的扩展触发器。

在每次更改后：

1. 在更改前后保存完整的配置差异。
2. 根据已安装的产品版本应用滚动重启或动态更新。
3. 等待 Kafka 资源准备就绪且 ISR 完成。对于 KRaft，等待稳定的控制器法定人数和 NodePool 状态。对于 ZooKeeper 模式，等待所有 ZooKeeper Pods、稳定的合奏成员资格、连接的代理会话和恰好一个活动的 Kafka 控制器。
4. 在相同主题数据状态、客户端并发性和负载下至少重复测试三次。
5. 如果增益不稳定或健康指标恶化，则返回到先前验证的配置。

## 14. 监控和证据收集

### 14.1 Kafka 健康检查

在测试之前、在稳态窗口期间和测试之后运行这些检查。通过标签发现代理 Pod：

```bash
export BROKER_POD="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-kafka" \
  -o jsonpath='{.items[0].metadata.name}')"
test -n "$BROKER_POD"
```

对于 KRaft，记录控制器法定人数状态：

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-metadata-quorum.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  describe --status \
  | tee "$OUT/metadata-quorum-after.txt"
```

对于 ZooKeeper 模式，`kafka-metadata-quorum.sh` 不适用。记录生成的 StatefulSets、每个 ZooKeeper Pod 和当前资源状态：

```bash
kubectl -n "$NS" get statefulset \
  "${CLUSTER}-kafka" "${CLUSTER}-zookeeper" -o wide \
  | tee "$OUT/kafka-zookeeper-statefulsets-after.txt"
kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-zookeeper" -o wide \
  | tee "$OUT/zookeeper-pods-after.txt"
kubectl -n "$NS" get kafka "$CLUSTER" -o yaml \
  >"$OUT/kafka-resource-after.yaml"
```

在这两种元数据模式下运行这些代理和主题检查：

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --under-replicated-partitions \
  | tee "$OUT/under-replicated-after.txt"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --group "$GROUP" \
  | tee "$OUT/consumer-group-after.txt"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-log-dirs.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --topic-list "$TOPIC" \
  >"$OUT/log-dirs-after.txt"
```

`--under-replicated-partitions` 在健康状态下可能不会产生输出。还要保存其退出代码，或者让调度器记录成功完成，以便连接失败不会被错误分类为没有未复制的分区。

`kafka-log-dirs.sh` 在其 JSON 数据之前打印状态文本，因此示例保存原始文本。在以编程方式解析之前，验证并删除非 JSON 前缀。不要将整个文件直接传递给 JSON 解析器。

### 14.2 所需的 Kafka 指标

以下 Java 管理扩展 (JMX) 管理 Bean (MBeans)，或其 Prometheus 映射，必须覆盖完整的稳态窗口：

| 类别                      | 指标或 JMX MBean                                                                                                               | 目的                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 写入/读取                 | `BytesInPerSec`、`BytesOutPerSec`、`MessagesInPerSec`                                                                             | 交叉检查客户端吞吐量                                                                                                 |
| 副本健康                 | `UnderReplicatedPartitions`、`UnderMinIsrPartitionCount`                                                                          | 第一个显示 ISR 计数低于配置的复制因子；第二个显示 ISR 计数低于 `min.insync.replicas`                             |
| 日志目录                 | `OfflineLogDirectoryCount`                                                                                                        | 检测不可用的存储目录                                                                                                |
| 网络线程                 | `NetworkProcessorAvgIdlePercent`                                                                                                  | 确定网络处理器线程利用率                                                                                            |
| 请求线程                 | `RequestHandlerAvgIdlePercent`                                                                                                    | 确定请求处理程序线程利用率                                                                                          |
| 请求延迟                 | 生产/提取 `TotalTimeMs`、`RequestQueueTimeMs`、`LocalTimeMs`、`RemoteTimeMs`、`ResponseQueueTimeMs` 和 `ResponseSendTimeMs` | 确定时间花费在请求阶段的地方                                                                                       |
| 消费者组                 | 当前位置、LEO、每个分区的堆积量和总堆积量                                                                                       | 确定消费者是否跟上生产                                                                                               |
| ZooKeeper 模式控制器     | `ActiveControllerCount`、`OfflinePartitionsCount` 和领导选举指标                                                                | 确认恰好一个代理是活动控制器并检测控制器或分区不稳定                                                                |
| ZooKeeper 模式代理会话   | `SessionState`                                                                                                                    | 检测与 ZooKeeper 断开连接或会话过期的代理                                                                            |

Prometheus 指标名称来自 JMX Exporter 取决于实例指标映射规则。不要假设所有环境使用相同的名称。从代理 `/metrics` 端点保存原始指标并首先检查名称：

```bash
kubectl -n "$NS" exec "$BROKER_POD" -- \
  curl -fsS http://127.0.0.1:9404/metrics \
  >"$OUT/broker-jmx-metrics.txt"

grep -m 100 -E 'bytesin|bytesout|messagesin|underreplicated|underminisr|avgidle' \
  "$OUT/broker-jmx-metrics.txt"
```

如果启用了 Kafka Exporter，发现其 Pod 并保存其原始指标：

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
  printf '%s\n' '未找到 Kafka Exporter Pod' \
    >"$OUT/kafka-exporter-not-found.txt"
fi
```

原始端点输出仅证明导出器公开指标；它并不能证明平台正在收集时间序列数据。在正式测试之前，查询代理过去 15 分钟的指标，确认每个代理都有连续样本。如果查询为空或存在收集间隙，请停止测试并修正 ServiceMonitor 或 PodMonitor 和当前平台的指标映射。选择器标签取决于当前 Prometheus 配置；不要从其他集群复制标签。

对于 ZooKeeper 模式，验证产品操作员填充生成的 `Kafka.spec.zookeeper.metricsConfig` 映射。这是生成的输出，而不是 `RdsKafka.spec.zookeeper` 中的可配置字段。至少收集：

| ZooKeeper 证据                                                 | 目的                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `QuorumSize`                                                 | 确认观察到的合奏大小保持等于配置的副本数量                                      |
| `NumAliveConnections`                                        | 检测连接丢失或意外的连接增加                                                    |
| `OutstandingRequests`                                        | 检测到达速度快于服务器处理速度的工作                                            |
| `MinRequestLatency`、`AvgRequestLatency`、`MaxRequestLatency` | 将元数据服务延迟与 Kafka 控制器事件和存储延迟相关联                             |
| `NodeCount` 和 `WatchCount`                                 | 保留元数据和观察集规模以便进行比较                                            |
| ZooKeeper Pod CPU、内存、重启次数、JVM GC 和 PVC 使用情况    | 排除资源压力和重启                                                              |
| ZooKeeper 卷延迟、利用率、队列深度和可用空间                | 检测同步写入或存储容量限制                                                    |

确切的 Prometheus 名称取决于已安装的映射。在审查的遗留映射中，它们是小写名称，例如 `zookeeper_quorumsize`、`zookeeper_numaliveconnections`、`zookeeper_outstandingrequests` 和 `zookeeper_avgrequestlatency`。在查询它们之前，确认每个 ZooKeeper Pod 的原始端点名称：

```bash
export ZOOKEEPER_PODS="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-zookeeper" \
  -o jsonpath='{.items[*].metadata.name}')"
test -n "$ZOOKEEPER_PODS"

for pod in $ZOOKEEPER_PODS; do
  kubectl -n "$NS" exec "$pod" -- \
    curl -fsS http://127.0.0.1:9404/metrics \
    >"$OUT/${pod}-jmx-metrics.txt"
done
```

不要将示例告警阈值复制到容量接受标准中。建立测试前基线并使用客户的 SLO。请求延迟增加、持续的未完成请求增长、法定人数变化、代理会话丢失或活动控制器计数不等于一都会使该点无效，即使生产吞吐量保持高。

### 14.3 Kubernetes 和基础设施指标

收集至少以下时间序列数据，而不仅仅是测试后的快照：

- 代理、控制器、ZooKeeper 和客户端 Pods（如适用）：CPU 使用、CPU 限制、内存工作集、网络发送和接收、重启和 OOM 事件；
- 节点：CPU、内存、网络带宽和丢包、磁盘吞吐量、输入/输出操作每秒 (IOPS)、平均和百分位延迟、利用率和队列深度；
- PVC：使用字节、容量、利用率和增长率；
- Kubernetes 事件、Pod 放置和资源请求与限制。

`kubectl top` 仅提供近实时快照。将其用于快速检查，而不是替代 Prometheus 范围查询：

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

以下 Prometheus 查询语言 (PromQL) 表达式仅显示计算意图。在替换 `$NS`、`$TOPIC`、`$GROUP` 和集群标签之前，请检查当前 Prometheus 实例中的实际指标名称和标签。保存每个表达式、时间范围、步骤和原始响应。

```text
sum(rate(kafka_server_brokertopicmetrics_messagesin_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(rate(kafka_server_brokertopicmetrics_bytesin_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(rate(kafka_server_brokertopicmetrics_bytesout_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(kafka_server_replicamanager_underreplicatedpartitions{namespace="$NS"})

sum(kafka_server_replicamanager_underminisrpartitioncount{namespace="$NS"})

sum(kafka_controller_kafkacontroller_activecontrollercount{namespace="$NS"})

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

max(zookeeper_quorumsize{namespace="$NS",strimzi_io_cluster="$CLUSTER"})

max(zookeeper_outstandingrequests{namespace="$NS",strimzi_io_cluster="$CLUSTER"})

max(zookeeper_avgrequestlatency{namespace="$NS",strimzi_io_cluster="$CLUSTER"})
```

CPU 限制和节点磁盘指标名称因容器运行时、cgroup 版本和监控堆栈而异。如果平台没有相应的时间序列，请在测试之前添加收集或从节点运行时、cgroup 和存储系统导出等效证据。不要将空查询记录为零。

### 14.4 Redis 或其他相关组件

如果应用路径还包括 Redis，请使用相同的 `RUN_ID`、UTC 间隔和节点事件记录，并附上单独的 Redis 性能报告。Kafka 和 Redis 的吞吐量、延迟和饱和点是不同的指标。不要将它们结合在一起或仅从时间相关性推断因果关系。Kafka 报告应仅保留相关报告链接、版本、测试间隔和验证的依赖项。

## 15. 结果摘要和有效性检查

### 15.1 每个测试点的字段

至少记录：

```text
run_id,start_utc,end_utc,measurement_seconds,test_mode,reliability_profile,
kafka_version,operator_version,metadata_mode,kraft_roles,broker_count,controller_count,
zookeeper_replicas,broker_cpu,broker_memory,jvm_xms,jvm_xmx,storage_class,pvc_size,
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
active_controller_count,zookeeper_quorum_size,zookeeper_request_latency_max,
zookeeper_outstanding_requests_max,zookeeper_pvc_used_bytes_max,
client_cpu_cores_max,client_cpu_throttling_ratio_max,result_valid,invalid_reason
```

Kafka 脚本输出使用列标签 `MB/sec`。在报告中保留原始标签。为了将值标准化为 MiB/s，计算实际有效负载字节除以秒和 `2^20`，记录公式并保留原始值。不要仅仅重命名列。

资源峰值字段默认记录单个 Pod 或 PVC 的最大值。如果使用总和、平均值或其他聚合，请在字段定义中记录聚合函数、单位、间隔和采样步骤。

### 15.2 有效结果的要求

仅当以下所有条件都为真时，结果标记为 `valid`：

- 命令退出代码为零，生产者和消费者记录计数达到其目标；
- 热身和稳态窗口按计划完成，其时钟间隔明确；
- Kafka、操作员、元数据模式、配置、主题、客户端和基础设施快照完整；
- 没有代理、控制器、ZooKeeper 或客户端 Pod 重启、OOM 事件、节点压力、卷异常或计划外维护发生；
- `UnderReplicatedPartitions=0`、`UnderMinIsrPartitionCount=0` 和 `OfflineLogDirectoryCount=0`；
- 生产可靠性基线保持 `acks=all`、幂等性和最小 ISR 要求；
- 客户端不是确认的瓶颈，或者结果明确标记为客户端限制；
- 监控覆盖完整的稳态窗口，没有收集间隙；
- 在 ZooKeeper 模式下，合奏大小稳定，`ActiveControllerCount` 的总和为 1，代理会话保持连接，ZooKeeper 请求延迟和未完成请求保持在预定义的测试标准内；
- 重复之间的变异性得到解释或不确定性保留在结论中。

如果发生以下任何情况，则标记结果为 `invalid` 并重复测试：

- 主题包含未知数据，消费者组被重用，或实际记录计数不足；
- 在测试期间发生滚动重启、重新分配、频繁的分区领导者更改、控制器选举、ZooKeeper 合奏重新配置或副本赶上；
- PVC 接近容量或存储或节点压力发生；
- 客户端 CPU 限制、网络饱和或异常退出；
- 测试点之间更改了多个关键变量；
- 仅提供平均值，而没有原始输出、百分位延迟或时间序列监控。

### 15.3 撰写结论

将结论分为：

- **事实：** 来自原始输出、配置快照和监控的直接观察。
- **推论：** 通过多个指标支持的瓶颈诊断，包括反对诊断的证据。
- **建议：** 下一步调优、扩展或重测行动。
- **待验证项：** 由于缺少存储、网络、生产消息模型或长期稳态证据而无法得出的结论。

还要报告：

1. 满足所有 SLO 的最后可用容量点；
2. 第一个不稳定的饱和点及其触发条件；
3. 至少三次重复的中位数、范围和变异系数；
4. 在保持可靠性和环境不变的情况下与基线的相对变化；
5. 适用边界，特别是消息模型、存储、网络、身份验证、保留策略和测试持续时间。

## 16. 清理

在删除专用于运行的资源之前，归档并验证 `$OUT`。不要删除具有模糊标签或通配符的共享资源。

```bash
# 仅删除本指南创建的专用主题。首先重新检查其名称。
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --delete --topic "$TOPIC"

kubectl -n "$NS" delete pod \
  kafka-producer-perf kafka-consumer-perf --ignore-not-found
kubectl -n "$NS" delete configmap \
  kafka-perf-client-config --ignore-not-found
kubectl -n "$NS" delete secret \
  kafka-perf-client-config --ignore-not-found
```

如果整个命名空间是为此运行创建的且不包含共享资源，则通过更改过程删除它。在删除实例或命名空间之前，检查 PVC 的 `deleteClaim` 和存储类的回收策略，并确认数据保留或销毁符合要求。

## 17. 参考文献

- [Apache Kafka 4.2 代理配置](https://kafka.apache.org/42/configuration/broker-configs/)
- [Apache Kafka 4.2 生产者配置](https://kafka.apache.org/42/configuration/producer-configs/)
- [Apache Kafka 4.2 消费者配置](https://kafka.apache.org/42/configuration/consumer-configs/)
- [Apache Kafka 4.2 监控](https://kafka.apache.org/42/operations/monitoring/)
- [Apache Kafka 4.2 硬件和操作系统](https://kafka.apache.org/42/operations/hardware-and-os/)
- [Apache Kafka 2.8 ZooKeeper 操作](https://kafka.apache.org/28/operations/zookeeper/)
- [Apache Kafka 2.8 监控](https://kafka.apache.org/28/operations/monitoring/)
- [Strimzi 0.25 部署和升级指南](https://strimzi.io/docs/operators/0.25.0/deploying)
- [Strimzi 0.48 部署和管理指南](https://strimzi.io/docs/operators/0.48.0/deploying.html)
- [Prometheus Operator API 参考](https://prometheus-operator.dev/docs/api-reference/api/)
