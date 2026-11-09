---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB261100001
sourceSHA: f0e0df706732be42926ce410ba4f9b1a89fa827ecf0623c98644275a54a5d288
---

# Redis 集群与哨兵性能测试指南

## 目的与范围

本指南定义了一种可重复的、客户可执行的方法，用于测量 Kubernetes 上 Redis 数据平面的吞吐量、延迟和资源使用情况。内容包括：

- **Redis 集群模式**：三个或更多主分片，选配从分片。负载生成器必须使用 `redis-benchmark --cluster`，以确保请求覆盖所有哈希槽。
- **Redis 哨兵模式**：一个可写主节点和从节点及哨兵进程。基准测试应在端口 `6379` 上对读写数据服务进行，而不是在端口 `26379` 上对哨兵服务进行。

仅在专用测试实例上运行此操作步骤。它会发出写入请求，并可能消耗所有分配的 CPU、内存、网络和存储带宽。它不测试故障转移；故障转移应作为单独的工作负载运行，因为拓扑变化会使稳定状态的吞吐量结果失效。

没有硬件无关的“最佳”结果。在测试之前定义工作负载、耐久性策略、拓扑和延迟目标。仅比较这些输入相同的运行，符合 [Redis 基准测试指导](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/) 的要求。

使用两种访问路径配置文件之一，且绝不合并它们的结果：

- **集群内容量配置文件（推荐）**：在 Redis 集群中运行负载 Pod，并通过 ClusterIP 服务连接。这将消除外部负载均衡器/广域网（WAN）容量对 Redis 结果的影响。
- **外部端到端配置文件**：通过 NodePort 或 LoadBalancer 从客户选择的源集群或主机运行相同的开源客户端镜像。记录客户端位置、访问类型、往返延迟、数据包丢失和每个网络跳数。对于集群模式，负载生成器必须能够访问集群发现宣布的每个节点地址；仅访问种子端点是不够的。

## 测试设计

使用以下工作负载矩阵进行集群和哨兵的测试。

Redis 数据库（RDB）持久化、仅追加文件（AOF）持久化和非持久性缓存是三种配置文件。首先选择产品参数模板，在基线运行中保持不变，然后一次只更改一个调优轴。

| 轴                     | 标准值                                                                                          | 目的                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 参数模板               | RDB 持久化；AOF 持久化；无持久化（缓存）                                                        | 分别量化耐久性和复制成本，使用已发布的产品基线                                             |
| 值大小 (`-d`)         | `512` 字节；`4096` 字节（4 KiB）                                                                | 标准的小型和中型值大小，以便进行可比较的基线结果                                           |
| 管道 (`-P`)           | `1`，`16`                                                                                        | `1` 测量非管道行为；`16` 测量面向吞吐量的工作负载                                           |
| 命令 (`-t`)           | `set,get`                                                                                        | 产生单独的写入和读取结果                                                                    |
| 随机键空间 (`-r`)     | `100000`                                                                                         | 避免基准测试单个热点键                                                                        |
| Redis I/O 线程        | 选择的模板基线（`io-threads=4`，禁用线程读取），随后进行 CPU 特定的扫描                      | 量化套接字 I/O 和协议处理的可扩展性，而不与其他调优混合                                     |

### 选择产品参数模板

此操作步骤使用已发布的 Redis 7.2 模板作为唯一的参数基线。在 Redis 创建表单中，首先选择 Redis 7.2 和拓扑。在英文界面的 **Parameter Templates** 或中文界面的 **参数模板** 下，选择与两者完全匹配的确切标识符。选择器中显示的标识符是模板的唯一名称，在两种语言中相同；只有描述是本地化的。下面的双语配置文件名称描述了意图，并不是替代资源名称。

| 配置文件名称 (中文 / English)       | Redis 7.2 Sentinel                   | Redis 7.2 Cluster                   |
| --------------------------------- | ------------------------------------ | ----------------------------------- |
| RDB 持久化 / RDB persistence         | `system-rdb-redis-7.2-sentinel`      | `system-rdb-redis-7.2-cluster`      |
| 无持久化（缓存） / No persistence (cache) | `system-diskless-redis-7.2-sentinel` | `system-diskless-redis-7.2-cluster` |
| AOF 持久化 / AOF persistence         | `system-aof-redis-7.2-sentinel`      | `system-aof-redis-7.2-cluster`      |

产品默认选择相应的 RDB 模板。当预期场景为 AOF 或无持久化模板时，请明确选择。某些软件包版本在本地化 RDB 描述中包含 `RBD`；这是描述错误。请使用上面显示的 `...rdb...` 标识符。本指南使用规范术语 **RDB**。

已发布的 Redis 7.2 模板建立了这些测试基线：

| 配置文件                | 有效持久化设置                                                 | 预期用途                                                                     |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| RDB 持久化            | `appendonly=no`；`save="60 10000 300 100 600 1"`             | 基于快照的持久化；自上次完成快照以来可能会丢失数据                           |
| AOF 持久化            | `appendonly=yes`；`appendfsync=everysec`；`save=""`          | AOF 耐久性/吞吐量平衡                                                          |
| 无持久化（缓存）      | `appendonly=no`；`save=""`；`repl-diskless-sync=yes`；`repl-backlog-size=50mb` | 可以容忍数据丢失的缓存工作负载                                                |

所有列出的模板都将 `maxmemory` 设置为未定义，并设置 `maxmemory-policy=noeviction`、`repl-diskless-sync=yes`、`io-threads=4` 和 `io-threads-do-reads=no`。使用此组合，操作员生成的 `maxmemory` 为 Redis 数据容器内存限制的 80%。这是操作员行为，而不是原生 Redis 默认值。由于已安装的软件包版本可能不同，请在产品控制台中查看所选模板的参数，并验证正在运行的实例上的有效配置，而不是手动复制这些值。

对于哨兵拓扑，模板选择还提供哨兵进程参数。在数据平面吞吐量比较期间保持不变；哨兵进程不处理基准流量，故障转移测试超出此稳定状态程序。

无持久化配置文件并不是“无盘持久化”：它禁用本地持久化，仅使用无盘同步进行复制。仅在应用程序可以容忍数据丢失时使用。Redis 在 [Redis 持久化](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) 中记录了 RDB、AOF 和无持久化的耐久性和性能权衡。

参数模板存储在 global 集群中，无法从业务集群中查看，因此请通过产品控制台进行验证，而不是通过 `kubectl`。在测试之前，请在控制台中打开参数模板列表，确认所选 Redis 版本和拓扑的标识符是否存在，并记录每个选定模板的显示参数以供报告。在实例创建后，使用 `CONFIG GET` 验证有效值，如本指南后面所述。

### 其他 Redis 版本

模板标识符、支持的参数、默认值、持久化行为和应用策略可能因 Redis 和产品包版本而异。对于除 7.2 以外的任何版本，请选择控制台为该确切版本和拓扑提供的模板，记录其显示参数，并根据实例的有效值构建一个单独命名的测试矩阵。不要重用 Redis 7.2 的标识符或假设其资源、存储、持久化或 I/O 线程的默认值适用。

## 先决条件

在测试窗口之前准备以下内容：

- 安装了 Redis 操作员的 Kubernetes 集群，以及适用于 RDB 和 AOF 配置文件的合格 `StorageClass`。

- Redis 创建表单中可用的 Redis 7.2 系统参数模板，适用于正在测试的拓扑。

- 一个专用于测试的命名空间，例如 `redis-perf`。

- 创建 Redis 实例和选择参数模板的产品控制台权限，以及可以创建负载 Pod 和读取 Redis 资源和指标的 `kubectl` 访问权限。安装 `jq` 以生成允许的证据导出。

- 一个包含键 `password` 的 Redis 密码 Secret。重用实例 Secret 或从受保护的文件中创建；绝不要将密码放入清单或报告中：

  ```bash
  kubectl -n redis-perf create secret generic redis-perf-auth \
    --from-file=password=/secure/path/redis-password
  ```

  受保护的文件必须仅包含密码字节，不得有意外的尾随换行符。当前的 Redis 录取政策要求 8-32 个允许字符，并拒绝不包含字母、数字和特殊字符的密码。通过 `kubectl explain redis.spec.passwordSecret --api-version=middleware.alauda.io/v1` 确认已安装的规则，因为软件包版本可能不同。

  为每个新的 Redis 实例使用不同的密码 Secret。当前的操作员可以将提供的 Secret 附加到实例拥有的 `RedisUser`；删除实例后将通过 Kubernetes 所有权删除该 Secret。在创建下一个矩阵实例之前，创建其新的 Secret，并重新创建负载生成器 Pod，以便其投影卷引用新名称。不要假设与已删除实例共享的 Secret 将保持可用。

- 一个经过批准的 [Redis Docker 官方镜像](https://hub.docker.com/_/redis/)，其中包含 `redis-benchmark` 和 `redis-cli`。在可行的情况下匹配服务器的主/次版本，将确切的镜像镜像到客户注册表以供隔离集群使用，并记录其不可变摘要。不要依赖私有供应商注册表来获取负载生成器镜像。

- 用于采样 Pod CPU/内存的 Metrics Server，或用于时间序列 CPU、内存、网络、存储和 Redis 导出器指标的 Prometheus。

在应用示例之前，确认已安装的模式：

```bash
kubectl explain redis.spec --api-version=middleware.alauda.io/v1
```

### 验证 StorageClass

使用以下存储配置文件之一，并明确报告：

- **性能上限配置文件**：优先选择由专用 SSD 或 NVMe 媒体支持的低延迟本地块存储。已安装的 TopoLVM 支持类，例如 `sc-topolvm` 是合适的候选者，但仅凭名称并不能保证性能：[TopoLVM](https://github.com/topolvm/topolvm) 提供本地逻辑卷管理器（LVM）卷，因此请验证其设备类和物理媒体。对于拓扑受限的本地存储，使用 `volumeBindingMode: WaitForFirstConsumer`，以便卷的配置遵循 Pod 调度约束，如 [Kubernetes 存储类](https://kubernetes.io/docs/concepts/storage/storage-classes/) 中所述。由于本地卷与节点绑定，因此此配置文件并不能证明跨节点恢复行为；请单独测试恢复，以确保使用预期的生产存储。

- **生产代表性配置文件**：使用确切的生产 `StorageClass`，即使它速度较慢，并将结果报告为端到端生产存储性能，而不是 Redis 上限。绝不要将此结果直接与本地块配置文件进行比较。

不要将网络文件系统（NFS）、其他网络附加存储或 CephFS 用于性能上限配置文件。Redis 明确警告不要将 RDB 或 AOF 文件放在 NFS 或网络附加存储上，因为存储路径可能会增加不可控的网络延迟和带宽争用。不要将所有 Ceph 存储归为同一规则：Ceph 块存储是分布式块存储，而不是共享文件系统。其网络、复制、恢复和服务质量设置仍然可能主导延迟，因此仅在生产代表性配置文件中使用 Ceph 块存储，或在存储资格证明显示有足够的余量后使用。请参阅 [Redis 基准测试因素](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/) 和 [Ceph 架构](https://docs.ceph.com/en/latest/architecture/)。

在部署 Redis 之前，使用相同的 `StorageClass`、容量、文件系统和节点类型对一次性卷进行资格验证。记录 4 KiB 随机写入操作速率、顺序写入吞吐量和同步写入延迟百分位数。没有通用的通过阈值：卷必须满足客户的存储服务目标，并在 Redis 峰值时保留余量，而不发生节流、长时间排队、恢复流量或无关的 I/O。存储饱和的运行测量的是存储路径，而不是 Redis 性能上限。

## 在测试之前记录环境

创建运行目录并捕获影响可比性的事实。不要导出 Secrets。

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="redis-perf-${RUN_ID}"
mkdir -p "${OUT}"

kubectl version -o yaml > "${OUT}/kubernetes-version.yaml"
kubectl get nodes -o wide > "${OUT}/nodes.txt"
kubectl get nodes -o json > "${OUT}/nodes.json"
kubectl get storageclass -o yaml > "${OUT}/storageclasses.yaml"
kubectl -n redis-perf get redis,pod,svc,pvc -o wide > "${OUT}/placement.txt"
kubectl -n redis-perf get pvc -o yaml > "${OUT}/persistent-volume-claims.yaml"

SC_NAME=sc-topolvm  # 示例；用所选 StorageClass 替换。
kubectl get storageclass "${SC_NAME}" -o yaml \
  > "${OUT}/storageclass-${SC_NAME}.yaml"

```

还要记录所选参数模板标识符及其显示参数、Redis 操作员版本、Redis 服务器版本、镜像 ID、节点 CPU 型号和频率策略、网络链路速度、StorageClass/容器存储接口（CSI）实现、卷性能类、服务网格状态和测试时区。Redis 建议使用隔离硬件、稳定的 CPU 频率、已知的客户端/服务器网络延迟，以及没有无关的存储 I/O，以获得可重复的结果。根据 [Redis 管理指导](https://redis.io/docs/latest/operate/oss_and_stack/management/admin/) 验证 Redis 节点上的 `vm.overcommit_memory=1` 和透明大页已禁用；平台管理员必须通过支持的节点管理流程应用主机更改。

## 配置 Redis 实例

通过产品控制台创建每个测试实例，以便所选系统模板通过受支持的工作流应用：

1. 选择 Redis 7.2，并选择 **Cluster** 或 **Sentinel** 拓扑。
2. 从上表中选择确切的 **Parameter Templates / 参数模板** 标识符。在手动更改 Redis 参数之前执行此操作。
3. 列出的系统模板为每个 Redis 服务器分配 `4` CPU 和 `8Gi` 内存的限制，符合标准容量配置文件。确认选择后的这些值，并在表单中暴露两者时将请求设置为等于限制。为集群配置三个主分片和每个主分片一个从分片，或为哨兵配置一个主节点、一个从节点和三个哨兵进程。将任何资源或拓扑更改视为单独命名的配置文件。
4. 对于 RDB 或 AOF，选择合格的 `StorageClass`，以声明性能上限或生产代表性配置文件。对于这两种拓扑，已发布的模板预填充 RDB 的 `24Gi` 和 AOF 的 `32Gi`。将这些值视为最小起始容量，按下面描述的方式计算需求，并使用较大的值。无持久化模板不需要持久数据存储。
5. 启用 Redis 导出器。展开 **Parameters / 参数配置**，并根据所选模板显示的参数验证 `appendonly`、`appendfsync`、`save`、`maxmemory`、`maxmemory-policy`、`repl-diskless-sync`、`io-threads` 和 `io-threads-do-reads`。`maxmemory` 的空模板值是故意的；在创建后验证操作员派生的有效值。
6. 在针对目标数据集纠正资源和存储容量后，创建基线，保持 Redis 参数不变。对于调优比较，从相同模板重新开始，仅更改记录的目标参数。如果已安装的平台支持客户拥有的模板，则将调优副本保存为新名称；绝不要在原地编辑已发布的系统模板。

模板选择将模板值具体化到 Redis 实例配置中；Redis 自定义资源不保留模板名称引用。因此，报告必须记录在控制台中选择的确切模板标识符、其显示参数值以及生成的 Redis 自定义资源。不要为自动化发明 `spec.paramTemplate` 字段。

### 为标准矩阵设置持久卷容量

不要求测试操作员根据观察到的持久卷声明（PVC）使用情况推断容量。在部署之前根据测试矩阵进行计算。对哨兵和集群使用相同的每 Pod 计算：哨兵数据节点持有完整数据集，而将完整工作负载配额应用于每个集群数据 Pod 避免依赖完美均匀的槽或键分布。

设 `N` 为每个测量点的 `SET` 请求数，`K` 为随机键空间，`D` 为字节中的值大小，`S` 为自上次成功 AOF 重写以来保留的 `SET` 通过数。`GET` 和管道深度不会增加持久数据卷。

```text
RDB 计算的峰值 = 2 * K * D
  # 现有 RDB 加上 BGSAVE 创建的临时 RDB。

AOF 计算的峰值 = (S * N + 2 * K) * D
  # 保留的 SET 通过、现有的压缩数据集，
  # 以及 BGREWRITEAOF 创建的新基础文件。

所需容量 = ceil_Gi(max(template capacity, calculated peak * safety factor))
```

`ceil_Gi` 意味着向上舍入到下一个完整的 GiB，以 Kubernetes `Gi` 值表示。

当命令组合为 `SET,GET`、`S` 已知且 AOF 维护在点之间完成时，对于有界标准矩阵使用安全因子 `1.5`。当键长度或命令框架有实质性差异、保留写入的数量不太可预测，或测试故意在持久化工作期间继续写入时，使用 `2.0`。对于除 `SET` 以外的写入命令，首先将 `S * N * D` 替换为该工作负载的最大序列化写入量；仅增加因子并不能纠正无效的有效负载模型。这些因子是本指南的工程安全政策，而不是 Redis 定义的常量。如果写入量无法界定，请停止并定义最大持续时间或请求计数；没有有限的百分比可以防止无限增长的 AOF 填满其卷。

对于标准矩阵（`N=1,000,000`，`K=100,000`，`S=1`），计算如下：

| 持久化      | 值大小 | 计算的峰值 | 峰值 × `1.5` | 模板最小值 | 每个数据 Pod 的配置 |
| ----------- | ---------: | --------------: | -----------: | ---------------: | ---------------------: |
| RDB         |      512 B |       0.095 GiB |    0.143 GiB |             24Gi |               **24Gi** |
| RDB         |     4096 B |       0.763 GiB |    1.144 GiB |             24Gi |               **24Gi** |
| AOF         |      512 B |       0.572 GiB |    0.858 GiB |             32Gi |               **32Gi** |
| AOF         |     4096 B |       4.578 GiB |    6.867 GiB |             32Gi |               **32Gi** |

标准拓扑的 Kubernetes 请求容量为：

| 拓扑                                           | Redis 数据 Pods | RDB 总计 | AOF 总计 |
| -------------------------------------------------- | --------------: | --------: | --------: |
| 哨兵：一个主节点 + 一个从节点                |               2 |  **48Gi** |  **64Gi** |
| 集群：三个主节点 + 每个主节点一个从节点 |               6 | **144Gi** | **192Gi** |

标准矩阵适合模板容量，因为它具有有界键空间、一百万个请求和一个保留的 AOF 通过。这并不意味着 `24Gi` 或 `32Gi` 通常是足够的。例如，使用 `N=10,000,000`、`K=100,000`、`D=4096` 和 `S=1`，AOF 计算的峰值为 `38.910 GiB`；应用 `1.5` 后需要 `59Gi`，并向上舍入。当存储类仅支持固定分配增量时，进一步舍入。

Redis 序列化、AOF 协议框架、键名和其他文件不包括在有效负载峰值中。安全因子为这些项目和围绕有界测试的变化提供空间。Redis 在替换旧文件之前会写入临时 RDB。Redis 7.2 多部分 AOF 在重写创建新基础时保留当前文件集，并继续接受写入，这就是为什么在应用因子之前包括这两个生成。

对于每个参数模板、值大小、管道和 Redis I/O 线程场景使用新实例。在 AOF 实例上进行客户端并发扫描时，必须为每个测量点重新创建实例，或者在预热后和每个点之后运行 `BGREWRITEAOF`，等待 `aof_rewrite_in_progress:0`，并在继续之前要求 `aof_last_bgrewrite_status:ok`。在测量间隔之外运行此维护工作。

如果 `-n`、`-r`、`-d` 或 `S` 发生变化，请在创建实例之前重新计算容量。不要在较大的请求计数（例如，500 万到 3000 万请求）或客户工作负载中重用标准值，而不进行重新计算。将每个 Pod 的结果乘以二，以获得标准哨兵拓扑的总 Kubernetes 请求容量，或乘以六，以获得标准的三个主节点、每个主节点一个从节点的集群拓扑。存储系统的复制、薄配置保留和文件系统开销是额外的。对于本地块存储，每个合格节点必须具有足够的可分配本地容量，以便在其中调度的 Redis 数据 Pods。请在测试之前配置计算出的容量；在测量运行期间不要调整 PVC 的大小。

等待 `.status.phase` 变为 `Ready`，然后验证 Pod 放置：

```bash
kubectl -n redis-perf wait --for=jsonpath='{.status.phase}'=Ready \
  redis/replace-with-instance-name --timeout=30m
kubectl -n redis-perf get pod -o wide
```

为了获得有效结果，将负载生成器放置在不托管 Redis 服务器的节点上。将哨兵数据节点分散在主机上。集群放置是分片感知的，因此始终记录每个主节点和从节点的实际节点，而不是假设分离。

### Redis 配置规则

- 对于未更改的 Redis 7.2 模板基线，保持 `maxmemory` 为空。由于模板设置了 `maxmemory-policy=noeviction`，操作员写入的有效 `maxmemory` 等于 Redis 数据容器内存限制的 80%。标准的 `8Gi` 限制因此大约产生 `6.4Gi` 的 `maxmemory`。在每个数据 Pod 上使用 `CONFIG GET maxmemory` 确认确切的字节值；不要将空模板字段报告为无限制的 Redis 配置。
- 剩余的 20% 是进程余量，而不是额外的数据集容量。它必须吸收复制/AOF 缓冲区、分配器碎片、客户端缓冲区和在 RDB 保存或 AOF 重写期间的写时复制页面。Redis 警告说，写入密集的后台保存可能会暂时需要大大更多的内存。如果在目标工作负载下此余量不足，请增加容器限制，并重新运行资源配置文件，而不是在没有证据的情况下将 `maxmemory` 提高到限制。
- 显式的 `maxmemory` 会覆盖操作员派生的值，并且是单独命名的调优配置文件。在当前的操作员实现中，保持 `maxmemory` 为空且配置的策略不是 `noeviction` 会派生出 70% 的内存限制，而不是 80%。因此，`maxmemory-policy` 比较必须在每个候选中固定相同的显式 `maxmemory`，或者报告可用数据集容量也发生了变化。
- 在容量测试中保持 `maxmemory-policy: noeviction`。内存不足的写入将明显失败，而不是静默替换键并使工作负载不可比。如果生产使用驱逐，则运行一个额外的配置文件，使用生产策略。
- 不要仅仅为了提高吞吐量而删除从节点。零个从节点的哨兵不再代表其高可用性目的；每个集群分片/从节点计数必须与生产匹配。
- 在基线中保持所选模板不变：列出的 Redis 7.2 模板使用 `io-threads=4` 和 `io-threads-do-reads=no`。在同一比较中不要更改 `hz`、backlog、持久化或内核设置；一次更改一个设置，并保留前后证据。
- 在比较中保持所选的 `StorageClass` 和存储配置文件不变。不要将来自 NFS、其他网络附加存储或 CephFS 的结果呈现为 Redis 性能上限。将 Ceph 块存储或其他网络块存储视为生产代表性，除非其资格证据显示在整个运行过程中保留了余量。

### 调优 Redis I/O 线程

Redis 7.2 可以使用 I/O 线程进行客户端套接字工作，而命令执行仍然主要在主线程上。`io-threads` 计算主线程：`1` 表示正常的单线程 I/O 路径。大于 `1` 的值会卸载套接字写入。仅作为单独的配置文件设置 `io-threads-do-reads=yes` 以卸载套接字读取和协议解析；Redis 7.2 参考配置表示线程读取通常提供的好处不大。Redis 7.2 还指出，线程 I/O 不适用于 TLS。对于 TLS 配置文件，将模板覆盖为 `io-threads=1`，并记录该偏差。

使用可用于 Redis 容器的 CPU，而不是 Kubernetes 节点的总 CPU 数。始终首先测量未更改的产品模板值 `4`。以下受控扫描包括产品基线和上游比较点；它们不是通用的最佳值：

| Redis 版本 | Redis 容器 CPU | 产品基线               | 受控 `io-threads` 扫描 | `io-threads-do-reads`             |
| ------------- | ------------------: | ------------------------------ | ----------------------------- | --------------------------------- |
| 7.2           |              4 vCPU | `4`                            | `1`、`2`、`3`、`4`            | `no` 首先；单独测试 `yes`         |
| 7.2           |              8 vCPU | `4` 在复制模板后 | `1`、`4`、`6`                 | `no` 首先；单独测试 `yes`         |

对于其他 CPU 分配，保留 `4` 作为模板基线结果，然后比较 `1` 和逐渐增加的值，以保持 CPU 余量。将 CPU 从 4 增加到 8 vCPU 是单独的资源配置文件；不要合并这些结果。不要设置超过 Redis 容器可以在没有持续 CPU 节流的情况下运行的 I/O 线程。保证服务质量（QoS）要求每个 Pod 中的每个容器具有相等的 CPU 和内存请求及限制。专用 CPU 还需要集群的 CPU 管理器静态策略和整数保证 CPU 请求；记录该策略是否处于活动状态。

使用参数编辑器将一个候选项应用于所选模板的新副本。例如，保留第一对作为基线，仅将第二对用于单独命名的 4 vCPU 比较：

```text
# 未更改的产品模板基线
io-threads 4
io-threads-do-reads no

# 示例比较配置文件；所有其他模板值保持不变
io-threads 3
io-threads-do-reads no
```

产品通过重启将更改应用于两个键。使用新实例进行最干净的比较，或者允许托管重启完成，等待 `Ready`，并确认所有预期的主节点和从节点已返回，然后加载数据。使用下面的收集助手验证每个 Redis 数据 Pod 上的有效值；跨节点的混合值会使运行无效。

在比较服务器候选项之前，校准负载生成器。Redis 7.2 建议在评估 I/O 线程时以线程模式运行 `redis-benchmark`。设置客户端 `--threads` 足够高，以便在最大的服务器候选项上保持 CPU 和网络余量，然后在 `io-threads` 比较中保持客户端设置不变。负载生成器线程数和服务器 I/O 线程数是不同的参数，必须单独报告。

对于每个候选项，重复客户端并发扫描。选择具有最高可重复吞吐量的设置，同时仍满足商定的 p99 延迟、错误率、复制延迟和 CPU 节流限制。当吞吐量不再显著提高或延迟/节流恶化时停止增加线程；仅保留最高的一次性结果不是有效的调优决策。

## 准备开源负载生成器

在专用负载生成器节点上使用官方 Redis 镜像。以下可重用 Pod 从 Secret 卷中读取密码。用确切的镜像替换镜像，并为每个拓扑更新反亲和实例名称。如果没有专用节点，请删除选择器/容忍，但将任何客户端/服务器共存视为无效运行。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: redis-perf-client
  namespace: redis-perf
  labels:
    app.kubernetes.io/name: redis-perf-client
spec:
  restartPolicy: Never
  nodeSelector:
    redis-perf/loadgen: "true"
  tolerations:
    - key: redis-perf/loadgen
      operator: Equal
      value: "true"
      effect: NoSchedule
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              middleware.instance/name: redis-perf-cluster
          topologyKey: kubernetes.io/hostname
  containers:
    - name: client
      image: redis:7.2.15
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "while true; do sleep 3600; done"]
      resources:
        requests: {cpu: "8", memory: 8Gi}
        limits: {cpu: "8", memory: 8Gi}
      volumeMounts:
        - name: auth
          mountPath: /auth
          readOnly: true
  volumes:
    - name: auth
      secret:
        secretName: redis-perf-auth
```

在隔离的测试集群中，在应用 Pod 之前保留一个节点：

```bash
kubectl label node replace-with-loadgen-node redis-perf/loadgen=true
kubectl taint node replace-with-loadgen-node redis-perf/loadgen=true:NoSchedule
kubectl apply -f redis-perf-client.yaml
kubectl -n redis-perf wait --for=condition=Ready pod/redis-perf-client --timeout=10m
kubectl -n redis-perf exec redis-perf-client -- redis-benchmark --version \
  | tee "${OUT}/redis-benchmark-version.txt"
kubectl -n redis-perf exec redis-perf-client -- redis-benchmark --help \
  > "${OUT}/redis-benchmark-help.txt"
```

仅使用确切客户端二进制文件显示的选项。特别是，Redis 7.2.15
二进制文件不暴露 `-e`；保留基准测试标准错误并收集 Redis
`INFO errorstats` 和拒绝连接计数器，而不是从不同客户端版本的文档中复制该选项。

## 验证连接性和拓扑

使用 Redis 自定义资源报告的服务名称。数据端口在两种拓扑中均为 `6379`。

```bash
NS=redis-perf
REDIS_NAME=redis-perf-cluster
SERVICE="$(kubectl -n "${NS}" get redis "${REDIS_NAME}" \
  -o jsonpath='{.status.serviceName}')"
HOST="${SERVICE}.${NS}.svc"

kubectl -n "${NS}" exec redis-perf-client -- sh -eu -c '
  redis-cli -h "$1" -p 6379 -a "$(cat /auth/password)" PING
' sh "${HOST}"
```

预期结果：`PONG`。对于集群，还要求 `cluster_state:ok`、所有 `16384` 个槽已分配，以及零个 `cluster_slots_pfail`/`cluster_slots_fail`：

```bash
kubectl -n "${NS}" exec redis-perf-client -- sh -eu -c '
  redis-cli -h "$1" -p 6379 -a "$(cat /auth/password)" CLUSTER INFO
' sh "${HOST}" | tee "${OUT}/cluster-info-before.txt"
```

在负载之前，还要求预期的从节点已连接，没有初始同步正在进行，并且没有 RDB 保存或 AOF 重写正在进行。将有意的后台持久化操作记录为场景的一部分，而不是仅允许它在仅一个比较运行中发生。

对于哨兵，使用 Redis 读写服务进行负载。单独查询哨兵服务并记录 `SENTINEL MASTER`、`SENTINEL REPLICAS`、`SENTINEL SENTINELS` 和 `SENTINEL CKQUORUM` 输出。监控的主节点名称和哨兵服务是特定于部署的；从实例状态/服务中获取它们，而不是假设名称。 [Redis 哨兵文档](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/) 定义了这些命令和健康字段。

## 运行基准测试

以下命令接受拓扑和负载参数作为位置参数。密码在 Pod 内读取，不存储在清单或报告中。由于 `redis-benchmark` 通过 `-a` 接受身份验证，因此在测试运行时，该过程的参数中存在密码；限制 Pod exec/debug 权限，不要启用 shell 跟踪，并在收集证据后删除客户端 Pod。

```bash
ARCH=cluster          # cluster 或 sentinel
CLIENTS=100
REQUESTS=1000000
DATA_SIZE=512
PIPELINE=1
THREADS=4            # redis-benchmark 客户端线程，而不是 Redis io-threads
KEYSPACE=100000
RESULT_ID="${ARCH}-d${DATA_SIZE}-p${PIPELINE}-c${CLIENTS}"
RAW_OUTPUT="${OUT}/${RESULT_ID}.raw.txt"
CSV_OUTPUT="${OUT}/${RESULT_ID}.csv"

set -o pipefail
kubectl -n "${NS}" exec redis-perf-client -- sh -eu -c '
  arch="$1"; host="$2"; clients="$3"; requests="$4"
  data_size="$5"; pipeline="$6"; threads="$7"; keyspace="$8"
  set -- redis-benchmark -h "$host" -p 6379 \
    -a "$(cat /auth/password)" \
    -c "$clients" -n "$requests" -d "$data_size" \
    -P "$pipeline" --threads "$threads" -r "$keyspace" \
    -t set,get --csv
  if [ "$arch" = cluster ]; then set -- "$@" --cluster; fi
  "$@"
' sh "${ARCH}" "${HOST}" "${CLIENTS}" "${REQUESTS}" \
  "${DATA_SIZE}" "${PIPELINE}" "${THREADS}" "${KEYSPACE}" \
  | tee "${RAW_OUTPUT}"

# Redis 7.2.15 集群模式在引用的 CSV 行之前打印节点发现行。
# 保留原始证据并创建仅包含这些行的机器可读 CSV。
awk '/^"/ {print}' "${RAW_OUTPUT}" > "${CSV_OUTPUT}"
test "$(wc -l < "${CSV_OUTPUT}")" -ge 3
```

`redis-benchmark` 参数：

| 参数       | 含义和选择规则                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-c`        | 并行连接。以 `50`（社区默认值）或 `100` 开始，然后增加，直到吞吐量停止扩展或达到其他测量限制。                                                                                                                                               |
| `-n`        | 每个选定操作的请求数。使用 `1,000,000` 进行快速测量运行。增加它，直到测量包含足够的监控样本并达到稳定状态。                                                                                                                              |
| `-d`        | `SET`/`GET` 值大小（以字节为单位）。使用 `512` 和 `4096`（4 KiB）作为标准矩阵。添加单独命名的大小，当应用程序的有效负载分布不同时。                                                                                                                                 |
| `-P`        | 管道深度。`1` 表示没有管道；`16` 是标准的面向吞吐量的点。使用应用程序的平均管道深度进行生产现实测试。绝不要将 `P=1` 和 `P=16` 作为相同工作负载进行比较。                                                                  |
| `--threads` | 负载生成器线程，与 Redis `io-threads` 无关。首先设置为 `4`；仅在客户端 Pod 在 Redis 之前 CPU 受限时增加。进行服务器 I/O 线程扫描时，为最大候选项提供足够的客户端线程，然后在此值上保持不变。                                   |
| `-r`        | 随机键空间。`100000` 是已实现的基线；当真实数据集具有更大的工作集时，增大它。                                                                                                                                                                                      |
| `-t`        | 要测试的命令。`set,get` 是标准比较。为应用程序的实际命令组合添加单独的场景；不要在一个结果表中混合不可比的命令集。                                                                                                                    |
| `--cluster` | Redis 集群所需，以便工具发现并路由到集群节点。对于哨兵省略。所有宣布的集群节点地址必须从客户端 Pod 可访问。                                                                                                                       |
| `--csv`     | 请求 CSV 格式的结果行。Redis 7.2.15 集群模式还将节点发现文本写入标准输出，因此保留原始文件并提取引用的行，如上所示。输出字段可能因客户端版本而异；将不可用的延迟百分位数标记为 `N/A`，而不是零。 |

如果需要访问控制列表（ACL）用户名，请在继续从 Secret 中读取密码时添加 `--user <username>`。对于启用 TLS 的实例，挂载经过批准的证书颁发机构（CA）和客户端证书 Secrets，并使用确切的 `redis-benchmark --help` 输出支持的 TLS 标志；将 TLS 记录为单独的测试配置文件，因为它会改变 CPU 和延迟。

## 找到饱和点

使用受控扫描；不要直接跳到最大客户端计数。

1. 运行短暂的连接性/预热传递。不要将其包含在报告中。
2. 使用 `P=1` 测量 `c=50`，然后 `100`、`200`、`400`，继续向上，直到吞吐量上升且负载生成器具有多余的 CPU/网络容量。
3. 在每个点，检查 `SET`/`GET` 每秒请求数、p99 延迟、错误、Redis CPU、客户端 CPU、CPU 节流、网络吞吐量、内存和持久化活动。
4. 当更多客户端不再产生显著的吞吐量增加，或延迟/错误迅速增长时，重复最后一个稳定点和第一个过载点。满足商定延迟/错误目标的最后可重复点是可用容量；无论延迟如何，最高可重复的无错误吞吐量是吞吐量上限。当它们不同的时候报告两者。
5. 如果客户端 Pod 达到其 CPU 限制或网络限制，而 Redis 仍有余量，请提高客户端资源或使用多个客户端 Pod。Redis 明确警告，基准测试客户端可能在服务器之前成为瓶颈。
6. 仅在应用程序可以管道时，使用 `P=16` 重复扫描，或记录协议吞吐量上限。将其与非管道结果分开。
7. 对于集群，检查每个分片。单个热点分片、不均匀的键分布、无法访问的宣布地址或客户端侧瓶颈并不是集群饱和。对于哨兵，额外的从节点不会增加写入容量；它们增加复制工作，必须保持在生产代表性拓扑中。

重复运行，直到结果可重复，并保留所有运行。不要仅报告最佳样本。

## 收集监控数据

### Kubernetes 资源指标

对于短基准测试阶段，每五秒采样标准 `metrics.k8s.io` API，并计算最大和平均 CPU 和内存。Metrics Server 不提供网络、存储或历史系列；使用 Prometheus 获取这些指标。

```bash
kubectl -n redis-perf top pod --containers
kubectl get --raw '/apis/metrics.k8s.io/v1beta1/namespaces/redis-perf/pods' \
  > "${OUT}/pod-metrics.json"
```

导出覆盖基准测试开始/结束时间的范围数据。根据已安装的监控堆栈调整标签选择器：

```text
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="redis-perf",container!=""}[5m]))
sum by (pod) (container_memory_working_set_bytes{namespace="redis-perf",container!=""})
sum by (pod) (rate(container_network_receive_bytes_total{namespace="redis-perf"}[5m]))
sum by (pod) (rate(container_network_transmit_bytes_total{namespace="redis-perf"}[5m]))
```

`rate()` 范围必须包含多个抓取样本。当已安装的监控间隔为 60 秒时，使用 `[5m]`；`[1m]` 范围可能不会返回数据。
当已安装的间隔不同时，调整范围，并在报告中记录这两个值。

使用声明的容器限制的总和计算利用率：

```text
100 *
sum(rate(container_cpu_usage_seconds_total{namespace="redis-perf",container="redis"}[5m]))
/
sum(max by (namespace,pod,container,resource,unit) (
  kube_pod_container_resource_limits{namespace="redis-perf",container="redis",resource="cpu",unit="core"}
))

100 *
sum(container_memory_working_set_bytes{namespace="redis-perf",container="redis"})
/
sum(max by (namespace,pod,container,resource,unit) (
  kube_pod_container_resource_limits{namespace="redis-perf",container="redis",resource="memory",unit="byte"}
))
```

在单独的查询中使用负载生成器容器选择器。不要平均每个 Pod 的百分比，因为不同大小的 Pods 将获得相等的权重。将这些结果标记为 **CPU 限制利用率** 和 **内存限制利用率**；它们不是节点利用率、CPU 请求利用率、Redis `maxmemory` 利用率或 Redis 常驻集大小（RSS）。如果 Redis 限制未显式配置，则产品将 `maxmemory` 作为容器内存限制的 80% 派生，但 Kubernetes 工作集仍可能与 Redis `used_memory` 和 `maxmemory` 不同，因为它包括进程和分配器开销。

单独导出客户端和 Redis 服务器 Pods。如果暴露了 CPU 节流、卷延迟、存储输入/输出操作速率、吞吐量、队列深度和来自 CSI、存储平台或节点导出的节流，也要包括。对于 Ceph 块存储，还要记录恢复、重新平衡或客户端服务质量限制是否处于活动状态。包括节点 CPU 利用率/频率、节点内存压力、数据包丢失/重传和 Pod 重启/内存不足事件。计数器指标需要 `rate()`/`increase()` 而不是直接减法，如 [Prometheus 指标指导](https://prometheus.io/docs/practices/instrumentation/) 所述。

### Redis 指标

在每次测量运行之前和之后捕获 `INFO`。对于集群，从每个主节点和从节点收集，而不仅仅是种子服务。Redis `INFO` 字段因版本而异；保留未知字段，并将不可用字段标记为 `N/A`。

以下助手仅发现包含 Redis 服务器容器的 Pods，并为每个节点写入一个文件。运行一次 `PHASE=before`，再运行一次 `PHASE=after`：

```bash
PHASE=before
kubectl -n "${NS}" get pod -o json \
  | jq -r --arg name "${REDIS_NAME}" '
      .items[]
      | select(.metadata.labels["middleware.instance/name"] == $name)
      | select(any(.spec.containers[]; .name == "redis"))
      | [.metadata.name, .status.podIP]
      | @tsv
    ' \
  | while IFS=$'\t' read -r NODE_NAME NODE_IP; do
      kubectl -n "${NS}" exec redis-perf-client -- sh -eu -c '
        for section in server clients memory stats persistence replication cpu commandstats latencystats errorstats keyspace; do
          echo "INFO ${section}"
          redis-cli -h "$1" -p 6379 -a "$(cat /auth/password)" INFO "${section}"
        done
        for key in save appendonly appendfsync maxmemory maxmemory-policy repl-diskless-sync io-threads io-threads-do-reads hz; do
          echo "CONFIG GET ${key}"
          redis-cli -h "$1" -p 6379 -a "$(cat /auth/password)" CONFIG GET "${key}"
        done
      ' sh "${NODE_IP}" \
        > "${OUT}/redis-info-${PHASE}-${NODE_NAME}.txt"
    done
```

所需的部分和字段包括：

- `server`：Redis 版本、模式、运行时间、分配器、输入/输出线程状态。
- `clients`：连接/阻塞的客户端和 `maxclients`。
- `memory`：`used_memory`、`used_memory_rss`、峰值内存、碎片、`maxmemory`、策略和不可驱逐的缓冲区内存。
- `stats`：瞬时/总操作、输入/输出字节、拒绝的连接、驱逐/过期的键、键空间命中/未命中、复制同步计数器、`total_reads_processed`、`total_writes_processed`、`io_threaded_reads_processed` 和 `io_threaded_writes_processed`。
- `persistence`：`rdb_bgsave_in_progress`、`rdb_last_bgsave_status`、`rdb_last_bgsave_time_sec`、`aof_current_size`、`aof_base_size`、`aof_rewrite_in_progress`、`aof_last_bgrewrite_status`、`aof_last_rewrite_time_sec`（如果存在）。
- `replication`：角色、连接的从节点、复制偏移、回溯和链接状态。
- `cpu`、`commandstats`、`latencystats`、`errorstats` 和 `keyspace`。
- 集群：来自每个节点的 `CLUSTER INFO` 和 `CLUSTER NODES`。
- 哨兵：`SENTINEL MASTER`、`REPLICAS`、`SENTINELS` 和 `CKQUORUM`。

当产品 Redis 导出器启用时，导出已由已发布的仪表板使用的指标，包括：

```text
redis_commands_processed_total
redis_commands_duration_seconds_total
redis_connected_clients
redis_blocked_clients
redis_memory_used_bytes
redis_memory_used_rss_bytes
redis_memory_used_peak_bytes
redis_keyspace_hits_total
redis_keyspace_misses_total
redis_evicted_keys_total
redis_net_input_bytes_total
redis_net_output_bytes_total
redis_rdb_bgsave_in_progress
redis_rdb_last_bgsave_duration_sec
redis_aof_rewrite_in_progress
redis_aof_last_rewrite_duration_sec
redis_slowlog_length
```

记录原始导出器输出或 Prometheus 范围查询结果，而不是仅仅截图。 [Redis `INFO` 参考](https://redis.io/docs/latest/commands/info/) 定义了服务器端字段及其版本边界。

已发布的 Redis `ServiceMonitor` 应用指标重标记允许列表。因此，像 `redis_up` 这样的指标可能存在于原始导出器端点上，但不会被 Prometheus 存储。使用 Prometheus 目标健康或其生成的 `up` 系列来验证抓取，并查询上述允许列表中的 Redis 指标以验证数据保留。不要假设每个原始导出器指标都被保留。

### Kubernetes 证据

在每个场景之后，附加以下内容，而不收集 Secret 对象：

```bash
kubectl -n redis-perf get redis "${REDIS_NAME}" -o json \
  | jq '{
      apiVersion, kind,
      metadata: {name: .metadata.name, namespace: .metadata.namespace},
      spec: (.spec | {
        version, arch, resources, persistent, persistentSize, replicas,
        affinityPolicy, nodeSelector, tolerations, enableTLS, customConfig
      }),
      status: (.status | {phase, serviceName, lastShardCount, lastVersion})
    }' \
  > "${OUT}/${REDIS_NAME}.json"
kubectl -n redis-perf get pod -o wide \
  > "${OUT}/pods-after.txt"
kubectl -n redis-perf get events --sort-by=.lastTimestamp \
  > "${OUT}/events.txt"
kubectl -n redis-perf get pod redis-perf-client \
  -o jsonpath='{.status.containerStatuses[0].imageID}{"\n"}' \
  > "${OUT}/loadgen-image-id.txt"
```

在失败时，还导出 Redis Pod 日志、`kubectl describe` 输出、卷和 `StorageClass` 详细信息，以及负载生成器输出。在共享捆绑包之前，删除客户标识符、地址和凭据。

## 报告格式和有效性检查

生成 JSON 或 CSV 以供自动化，并生成 Markdown/PDF 以供客户审阅。每一行报告代表一个拓扑 + Redis 版本 + 参数模板标识符 + 值大小 + 管道 + 客户端计数 + Redis I/O 线程设置 + 负载生成器线程计数。

使用稳定的机器可读标题，以便运行可以在不解析散文的情况下进行比较：

```text
topology,redis_version,parameter_template,persistence,storage_profile,storage_class,pvc_capacity_gib,value_size_bytes,pipeline,clients,redis_io_threads,redis_io_threads_do_reads,loadgen_threads,requests,keyspace,set_rps,set_p99_ms,get_rps,get_p99_ms,redis_cpu_max_millicores,redis_memory_max_mib,loadgen_cpu_max_millicores,loadgen_memory_max_mib,network_rx_mib_s,network_tx_mib_s,storage_iops,storage_latency_ms,valid,notes
```

| 类别            | 所需报告字段                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 环境         | 日期/时间、Kubernetes/Alauda 容器平台（ACP）/操作员/Redis 版本、节点计数/类型、CPU 型号、内存、网络、存储配置文件、`StorageClass`、提供程序、参数、`volumeBindingMode`、`allowVolumeExpansion`、文件系统/后端媒体、每个 Redis Pod 的 PVC 容量、资格结果、镜像名称和不可变摘要                             |
| 拓扑            | 集群分片/从节点计数或哨兵主节点/从节点/哨兵计数；Pod 到节点的放置；服务访问路径                                                                                                                                                                                                                                                            |
| Redis 配置 | 确切的参数模板标识符和控制台中显示的描述、生成的 Redis 自定义资源，以及通过 `CONFIG GET` 验证的允许的有效键（`save`、`appendonly`、`appendfsync`、`maxmemory`、`maxmemory-policy`、`repl-diskless-sync`、`io-threads`、`io-threads-do-reads`、`hz`）；批准的调优增量；TLS/ACL 状态，无凭据 |
| 负载                | 工具版本/镜像摘要、客户端位置、访问类型和往返延迟、命令、`-c`、`-n`、`-d`、`-P`、`--threads`、`-r`、预热方法、开始/结束/持续时间                                                                                                                                                                                                       |
| 结果             | `SET`/`GET` 每秒请求数；发出时的平均值、最小值、p50、p95、p99、最大延迟；原始 CSV                                                                                                                                                                                                                                                                               |
| 资源           | 客户端和服务器峰值/平均 CPU/内存、节流、网络接收/发送、存储操作速率/吞吐量/延迟/队列深度/节流、存储恢复或重新平衡活动、节点压力                                                                                                                                                                    |
| Redis 健康        | `INFO` 差异、集群槽/健康状态或哨兵法定人数/角色状态、错误、驱逐、拒绝连接、慢日志、AOF 大小字段、持久化状态和持续时间                                                                                                                                                                                                   |
| 裁定             | 满足/不满足预先商定的吞吐量、p99、错误和资源余量目标；瓶颈证据和无效运行原因                                                                                                                                                                                                                                      |

仅当基准测试成功退出并产生积极结果、负载生成器未与测量的 Redis 服务器共存、没有意外的故障转移、重启、内存不足杀死、磁盘满事件、PVC 扩展或失败的 RDB 保存/AOF 重写，并且拓扑健康保持正常时，运行才有效。负载生成器瓶颈、缺失的集群节点可达性、无关的节点/存储负载，或仅在一个比较运行中发生的持久化重写使比较无效。存储容量或存储性能饱和的运行仍然作为存储限制的生产路径结果是有用的，但必须不报告为 Redis 性能上限。性能是测量结果，而不是通用的通过/失败阈值；在执行之前定义客户接受标准。

## 清理

在导出证据后，仅删除专用测试资源：

```bash
kubectl -n redis-perf delete pod redis-perf-client
kubectl -n redis-perf delete redis redis-perf-cluster redis-perf-sentinel --ignore-not-found
kubectl -n redis-perf delete secret redis-perf-auth --ignore-not-found
kubectl taint node replace-with-loadgen-node redis-perf/loadgen=true:NoSchedule-
kubectl label node replace-with-loadgen-node redis-perf/loadgen-
```

在删除卷之前确认操作员的 PersistentVolumeClaim 保留行为。除非命名空间和卷专用于此测试，并且客户已批准删除，否则不要删除保留的数据。

## 社区参考

- [Redis 基准测试](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/)
- [Redis 7.2 参考配置](https://github.com/redis/redis/blob/7.2/redis.conf)
- [Redis `INFO`](https://redis.io/docs/latest/commands/info/)
- [Redis 持久化](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)、[`BGSAVE`](https://redis.io/docs/latest/commands/bgsave/) 和 [`BGREWRITEAOF`](https://redis.io/docs/latest/commands/bgrewriteaof/)
- [Redis 集群健康](https://redis.io/docs/latest/commands/cluster-info/) 和 [Redis 哨兵](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- [TopoLVM](https://github.com/topolvm/topolvm)、[Kubernetes 存储类](https://kubernetes.io/docs/concepts/storage/storage-classes/) 和 [Ceph 架构](https://docs.ceph.com/en/latest/architecture/)
- [Kubernetes 资源指标](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/) 和 [Kubernetes Pod QoS](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
