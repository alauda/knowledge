---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500548
sourceSHA: 1105290d373ecdedb1c393df6d02ba16ab27a600d7b3464d246e81be2ce0ded4
---

# ACP 上 Prometheus WAL 重放缓慢或在重放完成之前 pod 重启

## 问题

在 Alauda 容器平台（安装包 `v4.3.4`，kube-prometheus chart `v4.3.3`，容器镜像 `registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4`）上，统一的 Prometheus 作为 `cpaas-system/prometheus-kube-prometheus-0-0` 运行（StatefulSet `prometheus-kube-prometheus-0`，容器 `prometheus`）。Prometheus 将最近约 2 小时的内存 HEAD 样本持久化到磁盘作为写前日志，并在容器启动时重放该 WAL 以重建内存中的 HEAD，然后才能提供查询服务。

在 WAL 重放期间，Prometheus 进程会发出 `head.go` 日志行，报告重放进度：`Replaying WAL, this may take a while`，然后是每个段的形式为 `WAL segment loaded segment=<N> maxSegment=<M> duration=<d>` 的日志行，最后在所有磁盘段应用完成后会出现 `WAL replay completed`。

当 WAL 重放所需时间超过容器的启动探针预算时，kubelet 会在重放完成之前重启容器。此时 pod 会保持在未完全就绪状态，重启计数不断增加，并且 WAL 重放完成的日志行永远不会到达。Prometheus 容器的 ACP 默认启动探针是 `httpGet /-/ready`，在 `web` 端口上，`failureThreshold=60` 和 `periodSeconds=15`，大约提供 15 分钟的缓冲时间，然后 kubelet 会重启容器。

## 根本原因

WAL 重放必须分配足够的堆内存以在扫描磁盘段时在内存中生成 HEAD。当 prometheus 容器的 `memory.limit` 设置得太低以适应数据集时，重放无法完成，因为在重建 HEAD 之前堆内存压力会增加。当容器超过其 `memory.limit` 时，内核 cgroup OOM 杀手会以 `exitCode: 137` 终止该进程，而在 `memory.requests` 低于 `memory.limit`（Burstable QoS）的 pod 上，这是典型的故障特征。将 `memory.requests` 和 `memory.limit` 设置为相同的值可以将 pod 升级为 Guaranteed QoS 类。

WAL 段计数与摄取的指标的基数成正比。更大的段计数使重放变慢，因为 Prometheus 在启动时必须读取和应用更多的磁盘段，因此基数的突然跳升（标签爆炸、新的嘈杂导出器或引入额外标签的升级）会成比例地延长重放时间。

WAL 存储在专用的 RWO PVC `prometheus-kube-prometheus-0-db-...` 上（StorageClass `topolvm-hdd`，30Gi），通过 `subPath=prometheus-db` 挂载到 `/prometheus`。`wal/` 目录包含编号的段文件以及一个 `checkpoint.<N>` 目录。重放吞吐量受限于来自该卷的顺序读取性能，因此后端设备上的磁盘 I/O 饱和会导致 WAL 重放缓慢。

## 解决方案

提高 prometheus 容器的 `memory.limit`，以便 WAL 重放的工作集适合堆内存，从而使 pod 能够完成启动。此构建中的 `ClusterPluginInstance/prometheus` `spec.config.components.prometheus` 表面暴露了 `retention`、`scrapeInterval`、`scrapeTimeout` 以及一个顶级 `size` 枚举和一个 `storage` 块；它并未直接暴露 `resources` / `memory.limit` 子字段。因此，容器内存限制通过覆盖 `prometheus` 容器的 `resources.limits.memory`，或通过修补 StatefulSet `prometheus-kube-prometheus-0` 的 `prometheus` 容器资源进行调整：

```bash
kubectl -n cpaas-system get prometheus.monitoring.coreos.com
kubectl -n cpaas-system edit prometheus.monitoring.coreos.com <name>
```

减少高基数源以降低摄取量并缩短后续 WAL 重放时间。删除不需要的标签，并缩减嘈杂的 `ServiceMonitor` / `PodMonitor` 范围；`cpaas-system` 中的 `prometheus-operator` 通过重新渲染 Prometheus 配置 Secret 来协调更改，Prometheus 进程在下次重载时会获取减少的目标集。

暂时禁用嘈杂的 `ServiceMonitor` 或 `PodMonitor` 对象，以减少抓取摄取量，让 Prometheus 在 WAL 重放和压缩上赶上；删除或重新标记相关的 `monitoring.coreos.com/v1` `ServiceMonitor` / `PodMonitor` 会触发操作员重新渲染配置并在重载时缩小抓取目标列表。

```bash
kubectl -n cpaas-system get servicemonitor,podmonitor
kubectl -n cpaas-system label servicemonitor <noisy-sm> alauda.io/disabled=true --overwrite
```

将 Prometheus 存储移动到更快的存储类以加速 WAL 重放，因为重放主要受后端卷的顺序读取影响。存储类在 `ClusterPluginInstance/prometheus` `spec.config.storage` 中配置，这会渲染到 Prometheus CR 的存储部分。存储类的更改适用于新创建的 PVC；已经绑定的 `prometheus-kube-prometheus-0-db-...` PVC 保留其原始存储类，并且不会自动迁移，因此完成交换需要重新创建 PVC（并接受 WAL / 最近块的损失）或进行明确的数据迁移步骤。

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  name: prometheus
spec:
  pluginName: prometheus
  config:
    storage:
      storageClass: <faster-storage-class>
      capacity: 40
```

作为最后的恢复措施，当重放无法完成且可以牺牲历史最近样本时，删除 Prometheus pod 内 `/prometheus/wal/` 的内容。此时 pod 启动时不会进行重放，代价是丢失大约最后 2 小时的尚未刷新到 TSDB 块的内存样本。prometheus 容器的 busybox 构建包括 `/bin/sh` 和 `rm`，因此此方法在机械上是有效的：

```bash
kubectl -n cpaas-system exec prometheus-kube-prometheus-0-0 -c prometheus -- \
  sh -c 'rm -rf /prometheus/wal/*'
kubectl -n cpaas-system delete pod prometheus-kube-prometheus-0-0
```

## 诊断步骤

跟踪 prometheus 容器日志中的 WAL 重放标记，以确认重放是活动阶段，并观察在任何重启之前它的进展程度。`head.go` 发射器是标准的上游 Prometheus `v3.11.3` 源，因此日志行与标准形式匹配：

```bash
kubectl -n cpaas-system logs prometheus-kube-prometheus-0-0 -c prometheus \
  --tail=200 | grep -E 'head.go|tsdb|Replaying WAL|WAL segment loaded|TSDB started'
```

通过检查 pod 重启计数和容器状态，确认容器是否因启动探针而被重启。非零的重启计数与缺少 WAL 重放完成日志行的结合表明重放超出了启动探针预算：

```bash
kubectl -n cpaas-system get pod prometheus-kube-prometheus-0-0 \
  -o jsonpath='{.status.containerStatuses[?(@.name=="prometheus")].restartCount}{"\n"}'
kubectl -n cpaas-system describe pod prometheus-kube-prometheus-0-0
```

检查 prometheus 容器的 QoS 类和资源块，以确定容器当前是 Guaranteed 还是 Burstable，以及 OOMKills 是否与重放或稳定状态操作相关，且 `exitCode: 137` 是否相关：

```bash
kubectl -n cpaas-system get pod prometheus-kube-prometheus-0-0 \
  -o jsonpath='{.status.qosClass}{"\n"}'
kubectl -n cpaas-system get pod prometheus-kube-prometheus-0-0 \
  -o jsonpath='{.spec.containers[?(@.name=="prometheus")].resources}{"\n"}'
```

检查磁盘上的 WAL 段计数以评估重放成本。prometheus 容器是一个 busybox 风格的无发行版镜像，包含 `/bin/sh`、`ls` 和 `rm`，但不包含 `du`、`wc`、`head` 或 `df`，因此段计数必须使用避免这些缺失二进制文件的 shell 管道：

```bash
kubectl -n cpaas-system exec prometheus-kube-prometheus-0-0 -c prometheus \
  -- ls /prometheus/wal/ | wc -l
kubectl -n cpaas-system exec prometheus-kube-prometheus-0-0 -c prometheus \
  -- ls /prometheus/wal/
```

使用 `promtool tsdb analyze` 确定驱动段增长的高基数标签和指标名称。`promtool` `v3.11.3` 与相同的上游 Prometheus 二进制分发一起提供，并包含在容器镜像中，可以通过 `kubectl exec` 调用：

```bash
kubectl -n cpaas-system exec prometheus-kube-prometheus-0-0 -c prometheus -- \
  promtool tsdb analyze /prometheus --limit=10
```

通过检查底层节点的 `vmstat` 输出，确定 pod 在 WAL 重放期间是否受 I/O 限制。高 `wa`（CPU I/O 等待 %）结合低 `id`（CPU 空闲 %）表明系统在等待磁盘；`bi`（块输入 KB/s）低于预期设备吞吐量表明从后端卷读取缓慢。在 ACP 上，节点级的 `vmstat` 视图使用 `kubectl debug node/<node>` 通过 `container-debug` 镜像和 `chroot /host` 获取，以便 `vmstat` 读取节点的 `/proc` 而不是调试 pod 的 `/proc`：

```bash
kubectl get pod prometheus-kube-prometheus-0-0 -n cpaas-system \
  -o jsonpath='{.spec.nodeName}{"\n"}'
kubectl debug node/<node> -it \
  --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- chroot /host vmstat -t 5 10
```

将 `ServiceMonitor` / `PodMonitor` 清单与基数发现进行交叉参考，以选择缩减哪些抓取目标。`cpaas-system` 中的 `prometheus-operator` 将对这些对象的每个更改协调到渲染的 Prometheus 配置 Secret 中：

```bash
kubectl -n cpaas-system get servicemonitor,podmonitor -o wide
```
