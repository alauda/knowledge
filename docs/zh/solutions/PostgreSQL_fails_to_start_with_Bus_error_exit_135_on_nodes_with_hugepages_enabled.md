---
kind:
  - Troubleshooting
products:
  - Alauda Application Services
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB261100005
sourceSHA: de54eee6c394229c7d0e608ebc9c8eca663a2a04b0fdf3bc31ecd6899f5af4d7
---

# PostgreSQL 在启用 hugepages 的节点上以“总线错误”（退出代码 135）失败启动

## 问题

在节点上保留 hugepages 后（`vm.nr_hugepages` 设置为非零值），调度到该节点的 PostgreSQL 实例停止启动。 Pod 日志显示：

```text
运行引导脚本 ... 总线错误（核心已转储）
子进程以退出代码 135 退出
```

退出代码 `135` 是 `128 + 7` = **SIGBUS**。两个细节使得这一点难以识别：

- **这两行“小默认”是症状，而不是设置。** 日志中包含 `selecting default "max_connections" ... 20` 和 `selecting default "shared_buffers" ... 400kB` 意味着 `initdb` 在每个候选大小上尝试了一个 `postgres --boot` 子进程，**所有子进程都崩溃了**，因此它保持了底线值。 PostgreSQL 并没有选择一个小的配置。
- **使用 Zalando 操作员时，故障在 Kubernetes 层面上是不可见的。** Pod 报告 `1/1 Running`，而 Patroni 循环：`removing initialize key after failed attempt to bootstrap the cluster` → `PatroniFatalException: Failed to bootstrap cluster`，并且 runit 每大约 30 秒重启一次。不要仅仅通过 Pod 的就绪状态得出实例健康的结论 — 请使用 `psql` 连接。使用 CloudNativePG 时，`-initdb` 作业会变为 `Error` 并可见地重试。

这个问题并不特定于 PostgreSQL。任何机会性使用 hugepages 的容器化工作负载 — MySQL、MongoDB、使用 `-XX:+UseLargePages` 的 JVM 应用程序 — 在同一节点上都会暴露出这个问题。

## 环境

在以下环境中重现并修复：

- Alauda 容器平台 4.2，Kubernetes v1.33.7，containerd 1.7.29，**cgroup v1**
- 工作节点：amd64，内核 3.10，**单 NUMA 节点**，未启用 `cpuManagerPolicy`
- CloudNativePG 操作员 v1.29.1-acp.1，PostgreSQL 18.4，以及使用 `spilo v4.3.0-beta.36` 的 Zalando 操作员

以下所有断言均在该环境中观察到。底层机制是 kubelet 和 hugetlb cgroup 控制器的属性，而不是这些特定版本的属性，因此预计会普遍适用 — 但这里的具体路径、文件名和数字是经过测试的，特别是 cgroup 布局依赖于 **systemd** cgroup 驱动程序（`cgroupDriver: systemd`）和默认的 kubelet cgroup 根。在 cgroup v2 中，相应的文件是 `hugetlb.<size>.max`；文件名是正确的，但统一层次结构意味着挂载点不同，这种组合在这里没有经过测试。

## 根本原因

两个独立的事实结合在一起：

1. **kubelet 对未请求 hugepages 的 Pod 将其限制为零。** 对于每个没有 `hugepages-<size>` 资源请求的 Pod，kubelet 在 **pod-level** cgroup 上写入 `hugetlb.<size>.limit_in_bytes = 0`（`kubepods-<qos>-pod<uid>.slice`）。
2. **hugetlb 的保留和分配发生在不同的时间。** 使用 `mmap()` 和 `MAP_HUGETLB` 检查保留情况与 **全局** 池，并成功。只有在页面被 **faulted in** 时，cgroup 限制才会被收取。在页面故障内部的拒绝没有 errno 返回，因此内核会发送 **SIGBUS**。

PostgreSQL 的默认 `huge_pages=try` 仅在 `mmap()` *返回错误* 时回退到普通页面。在这里，`mmap()` 成功，因此 PostgreSQL 承诺使用 hugepages，并在首次访问时崩溃。

这就是为什么故障仅在存在 hugepages 的节点上出现的原因。在没有任何池的节点上，`mmap(MAP_HUGETLB)` 会立即失败并返回 `ENOMEM`，PostgreSQL 会静默回退。**一个宣称有 hugepages 的节点，而 Pod 实际上无法获取这些页面，比没有 hugepages 的节点更危险。**

## 诊断

### 确认是 hugepages

在容器内几秒钟内重现，而无需等待操作员重试：

```bash
kubectl -n <ns> exec <pod> -- initdb -D /tmp/hugetlb-check -U postgres
```

`总线错误（核心已转储）` 确认了这一点。（之后清理 `/tmp/hugetlb-check`。）

`<pod>` 可以是 **任何** 在可疑节点上包含 PostgreSQL 二进制文件的 Pod — 它不必是失败的 Pod，通常也不能是。使用 CloudNativePG 时，崩溃的实体是 `-initdb` 作业 Pod，该 Pod 以 `restartPolicy: Never` 运行，并且在你查看时可能已经 `Terminated`，因此 `exec` 返回 `container not running`。相反，启动一个固定在该节点的临时 Pod，使用相同的镜像。

### 在正确的级别读取 cgroup 计数器

> **这是容易出错的步骤。** Pod 内的 `/sys/fs/cgroup` 视图是 **容器** 范围，这 *不是* kubelet 写入限制的地方。它读取 `unlimited`，并且 `failcnt` 永久为 `0`，因为子 cgroup 无法看到其父级记录的拒绝。 Pod 内读取零并 **不** 免除 cgroup 的责任。

从主机读取 **pod slice**：

```bash
set -o pipefail
POD_UID=$(kubectl -n <ns> get pod <pod> -o jsonpath='{.metadata.uid}' | tr - _) \
  || { echo "kubectl 失败"; exit 1; }
[ -n "$POD_UID" ] || { echo "pod 未找到"; exit 1; }
D=/sys/fs/cgroup/hugetlb/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${POD_UID}.slice
cat "$D/hugetlb.2MB.limit_in_bytes" "$D/hugetlb.2MB.failcnt"
```

`set -o pipefail` 很重要：没有它，赋值将采用 `tr` 的退出状态，因此失败的 `kubectl` 返回状态 0 和空 UID，你将继续读取一个由空字符串构建的路径。

> 这个路径是 **systemd** cgroup 驱动程序的布局，这是测试集群使用的（`cgroupDriver: systemd` 在 `/var/lib/kubelet/config.yaml` 中）和常见的默认值。在 `cgroupfs` 驱动程序下，形状不同 — `/sys/fs/cgroup/hugetlb/kubepods/burstable/pod<uid>/`，其中 UID 保持其连字符且没有 `.slice` 后缀。在假设之前，请检查节点上的 `cgroupDriver`。非默认的 `--cgroup-root` 也会改变前缀。

将 `burstable` 调整为 `besteffort`，或者对于 Guaranteed Pods 完全删除该路径元素 — 只有 Burstable 和 BestEffort 才获得 QoS 级别的 cgroup。用节点的默认 hugepage 大小替换文件名：在 x86_64 上为 `hugetlb.2MB.*`，在默认使用 512 MiB 页面（`grep Hugepagesize /proc/meminfo`）的 arm64 构建上为 `hugetlb.512MB.*`。

`limit` 为 `0` 且 `failcnt` 在每次崩溃时递增确认了诊断。
围绕单个失败的 `initdb` 测量的值：

| cgroup 级别                             | `limit_in_bytes` | `failcnt` 之前 → 之后 |
| ---------------------------------------- | ---------------- | ---------------------- |
| pod slice                                | `0`              | `0` → `25`             |
| 容器范围（在 Pod 内可见）               | unlimited        | `0` → `0`              |

`/proc/meminfo` 中的 `HugePages_Free` 在故障期间没有变化：页面已被保留，在故障时被拒绝，且从未分配。

### 检查节点是否实际宣称 hugepages

```bash
kubectl get node <node> -o jsonpath='{.status.allocatable.hugepages-2Mi}{"\n"}'
```

（使用与节点默认页面大小匹配的资源名称 — 在默认使用 512 MiB 页面上为 `hugepages-512Mi`。）**空输出意味着节点没有宣称该 hugepage 大小** — 该命令仍然返回 0，因此空行是结果，而不是失败。

kubelet 缓存机器信息，因此运行时 `sysctl -w vm.nr_hugepages=N` **在 kubelet 重启之前不可见**。一个具有活动池但 `hugepages-2Mi: 0` 的节点是最糟糕的状态：Pods 被限制为零 **并且** 无法请求 hugepages，因为调度程序不相信该资源存在。如果池在线启用，请在使用下面的“请求 hugepages”选项之前重启该节点上的 kubelet。

## 解决方案

选择一行。**不要** 在首次操作时禁用节点的 hugepage 池 — 在共享节点上，这些页面通常属于其他工作负载，移除它们会导致应用程序崩溃。

| 情况                                              | 操作                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 实例已引导，仅在重启时失败                       | 设置 `huge_pages: "off"` 参数。适用于这里所有主要版本（13-18）。                                                            |
| 需要新的引导，PostgreSQL **16 或更高版本**       | 设置参数 **并且** 将 `huge_pages=off` 传递给 `initdb`。                                                                      |
| 需要新的引导，PostgreSQL **15 或更早版本**       | 不存在 `initdb` 选项。请求 hugepages，或者在没有池的节点上引导实例，然后再移动实例。                                       |
| PostgreSQL 应该真正使用 hugepages                | 在 `resources` 中请求 `hugepages-<size>` 并设置 `huge_pages: "on"`。                                                      |

### 为什么仅参数不足以进行新的引导

两个操作员在 `initdb` 完成 **后** 写入 `postgresql.conf`。崩溃发生在 `initdb` 的引导子进程中，在该文件存在之前。仅使用 `huge_pages: "off"` 创建的集群仍然无法引导 — 已验证。PostgreSQL 16 添加了 `initdb -c NAME=VALUE`（`--set`），并且它被引导子进程所尊重，这为 16 及以上版本提供了仅配置的路径。

### Zalando 操作员

```yaml
spec:
  postgresql:
    parameters:
      huge_pages: "off"
  patroni:
    initdb:
      set: "huge_pages=off"
```

Patroni 将每个 `{key: value}` 条目呈现为 `--key=value`，而 PostgreSQL 16 的选项是 `-c, --set`。因此，键必须是 `set`；写入 `c` 会产生无效的 `--c=...` 标志。

### CloudNativePG 操作员

```yaml
spec:
  postgresql:
    parameters:
      huge_pages: "off"
  bootstrap:
    initdb:
      options: ["-c", "huge_pages=off"]
```

> **注意。** `bootstrap.initdb.options` 是一个已弃用的字段。设置它会使 `buildInitDBFlags` 提前返回，因此操作员会忽略 **每个** 显式的 `initdb` 设置：`dataChecksums`、`encoding`、`locale`、`localeCollate`、`localeCType`、`localeProvider`、`icuLocale`、`icuRules`、`builtinLocale` 和 `walSegmentSize`。集群级别的 `logLevel` → `-d` 副作用也会被跳过。在添加 `options` 之前，请对比当前的 `bootstrap.initdb` 块，并在同一列表中重新声明您依赖的所有内容作为原始标志：

> ```yaml
> options: ["-c", "huge_pages=off", "--encoding=UTF8", "--lc-collate=C", "--lc-ctype=C", "-k"]
> ```

> 在该 argv 顺序中验证：`initdb` 退出 0，`postgresql.conf` 包含 `huge_pages = off`，并且生成的集群报告 UTF8 / C / C，`data_checksums=on`。使用 ICU 区域设置的集群最容易在这里发生静默丢失。

### 如果 CloudNativePG 引导已经失败了一段时间

仅修补集群规范在 `-initdb` 作业仍在重试时有效。一旦它耗尽了回退，**上述修复单独没有效果** — 集群几乎没有信号表明这种情况已经发生。在操作员 `v1.29.1-acp.1` 上观察到的序列：

1. `-initdb` 作业以默认的 `restartPolicy: Never` 运行，默认的 `backoffLimit: 6`，因此它在 7 个 Pod 尝试后停止（大约 10 分钟的指数回退），并被标记为 `Failed / BackoffLimitExceeded`。
2. **`status.phase` 始终保持 `Setting up primary`。** 调解器被卡住，记录 `Selected PVC is not ready yet, waiting for 1 second` 的紧密循环，因为来自失败尝试的 PVC 从未收到其就绪标记。请从作业而不是集群阶段进行诊断：

   ```bash
   kubectl -n <ns> get jobs -l cnpg.io/cluster=<cluster>
   kubectl -n <ns> get cluster <cluster> -o jsonpath='{.status.danglingPVC}{"\n"}'
   ```

   一个 `Failed` 作业加上一个非空的 `danglingPVC` 就是这种状态。（操作员 v1.29.2 及更高版本包括上游 #11035，“报告失败的实例创建作业，而不是永远等待”，这会在阶段中显示出来。`v1.29.1-acp.1` 不会。）
3. 修补规范没有任何作用 — 失败的作业不会被替换。
4. 删除作业也没有帮助；PVC 循环继续。
5. **不要单独删除 PVC。** 这会将集群移动到第二个更糟糕的状态：`一个或多个实例之前已创建，但不存在持久卷声明（PVC）。集群处于不可恢复状态。要解决此问题，请从最近的备份恢复集群。`

**恢复：删除集群并使用修复后的规范重新创建它。**

```bash
kubectl -n <ns> delete cluster <cluster>
kubectl -n <ns> apply -f cluster-with-huge-pages-off.yaml
```

这很安全 *特别是因为引导从未完成* — 在该 PVC 中没有数据可丢失。已验证：重新创建的集群在同一启用 hugepage 的节点上达到 `Running` 状态，`huge_pages=off`。**绝不要对成功引导后又失败重启的集群执行此操作** — 那个集群有数据，且上述表中的仅 GUC 修复适用。

实际结论是在任何可能拥有或将获得 hugepage 池的节点上，在首次应用之前将修复放入清单中。

### 选项：让 PostgreSQL 使用 hugepages

如果池是为数据库准备的，请为 Pod 提供一个真实的限制，而不是移除请求。这修复了引导和稳定状态：

```yaml
spec:
  postgresql:
    parameters:
      huge_pages: "on"
      shared_buffers: 256MB
  resources:
    requests: { cpu: 200m, memory: 1Gi, hugepages-2Mi: 512Mi }
    limits:   { cpu: "1",  memory: 1Gi, hugepages-2Mi: 512Mi }
```

**PostgreSQL 15 及更高版本** 可以为您估算需求。该参数需要一个数据目录 — 它无法在空容器上查询：

```bash
# 针对现有实例
kubectl -n <ns> exec <pod> -- bash -c \
  'postgres -D "$PGDATA" -c shared_buffers=256MB -C shared_memory_size_in_huge_pages'
```

**它返回的是页面计数，而不是大小。** 将其乘以节点的默认 hugepage 大小以获取资源数量。在具有 2 MiB 页面节点上，相同的默认 `shared_buffers` 返回 `75`，在具有 512 MiB 页面节点上返回 `1` — 将原始数字写入 `hugepages-2Mi: <count>Mi` 会因页面大小因素而低配。

在 PostgreSQL 18.4 上测量，使用 2 MiB 页面：在 128 MB 默认值下为 75 页，在 `shared_buffers=1GB` 下为 543 页，在 `8GB` 下为 4222 页 — 大约是 `shared_buffers` 加上 10-15% 的控制结构，因此预算余量而不是精确适配。精确适配的限制意味着任何后续的共享内存段增长都会导致 SIGBUS，而不是在启动时干净地失败。

**PostgreSQL 14 及更早版本没有此参数** — `postgres -C shared_memory_size_in_huge_pages` 返回 `FATAL: unrecognized configuration parameter`（在 13 和 14 上验证；从 15 开始存在）。手动进行大小估算：`shared_buffers` 加上大约 15%，除以页面大小，向上取整。

在首次引导之前，任何版本上都没有数据目录，因此查询不可用 — 没有 `--config-file` 快捷方式，`postgres` 仍然要求 `-D`。要么将 `initdb` 运行到一个临时目录以纯粹进行测量，要么使用手动估算。

> **将页面大小与节点匹配。** 资源名称和页面计数都遵循节点的 *默认* hugepage 大小，这就是 `huge_pages=on` 消耗的内容（`huge_page_size = 0` 意味着“使用系统默认”）。首先检查它：

> ```bash
> grep Hugepagesize /proc/meminfo
> ```

> x86_64 节点通常为 `2048 kB` → 请求 `hugepages-2Mi`。某些 arm64 构建，包括在 64 KiB 页面上运行的 Kylin Linux Advanced Server V10，默认值为 `524288 kB` → 资源为 `hugepages-512Mi`，并且以上每个计数均以 512 MiB 为单位。在这样的节点上请求 `hugepages-2Mi` 会请求一个它没有宣称的资源，Pod 将保持 `Pending`。

节点还必须完全宣称该资源 — 请参见上面的 kubelet 重启说明。

## 验证

Pod 的就绪状态不是有效检查，因为 Zalando 操作员在整个故障期间报告 `1/1 Running`。请使用以下方法。

实例实际上正在提供服务，并使用预期的内存类型：

```bash
kubectl -n <ns> exec <pod> -- psql -U postgres -tAc \
  "select 'ALIVE', current_setting('huge_pages'), current_setting('shared_buffers')"
```

对于禁用路径，期望 `ALIVE|off|...`，对于请求路径，期望 `ALIVE|on|...`。

没有进一步的 cgroup 拒绝 — `failcnt` 在 pod slice 上停止递增（与诊断中的相同命令）。

仅对于请求路径，确认页面确实被占用，在节点上：

```bash
grep -iE 'hugepages_total|hugepages_free|hugepages_rsvd' /proc/meminfo
```

读取 **`HugePages_Rsvd`**，而不是 `HugePages_Free`。已保留但尚未触及的页面仍然算作可用，因此 `HugePages_Free` 低估了使用情况，并不是可靠的指标。

## 限制和权衡

- 设置 `huge_pages: "off"` 放弃了该实例的 hugepages 的 TLB 优势。对于大多数 ACP PostgreSQL 工作负载，这并不可测；如果数据库是保留 hugepages 的原因，请使用请求路径。
- 修复是每个集群的。每个可能落在启用 hugepage 的节点上的 PostgreSQL 实例都需要它，所有其他能够使用 hugepage 的工作负载也需要。
- 请求 hugepages 并 **不** 保护节点的空闲页面因其他原因无法访问，例如在多 NUMA 机器上具有不均匀分布池的限制性 `cpuset.mems`。在数据库中禁用 hugepages 是有效的，因为根本不创建 `MAP_HUGETLB` 映射。
- 节点上的 `vm.nr_hugepages=0` 是最后的手段。首先识别谁在消耗池；数据库是应该适应的工作负载，因为它是机会性地占用无法故障的页面。

## 相关

- `如何将 PostgreSQL 实例迁移到另一个节点.md` — 在没有就地选项的情况下将实例移出受影响的节点（PostgreSQL 15 及更早版本）。
- `CX_series_KubeVirt_VM_fails_to_start_with_FailedScheduling_on_dedicated_CPU_and_hugepages.md` — 针对同一资源的相反故障模式。请求 `hugepages-2Mi` 的工作负载无法获取它，保持 `Pending` 状态，显示 `Insufficient hugepages-2Mi`，这是一个诚实、可见的失败。这里描述的 SIGBUS 恰恰是因为工作负载从未请求该资源，因此没有任何东西阻止它被调度。
