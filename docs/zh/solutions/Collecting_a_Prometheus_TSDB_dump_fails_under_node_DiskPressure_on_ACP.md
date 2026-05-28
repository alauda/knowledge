---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500347
sourceSHA: 4f119b46ab0c884521a8faaeb8629ded9bf1881af1ec8b96f496c847c736dd62
---

# 在 ACP 上收集 Prometheus TSDB 转储时因节点 DiskPressure 失败

## 问题

在 Alauda 容器平台上，当承载监控堆栈的节点接近满时，收集 Prometheus TSDB 转储变得困难，kubelet 将其置于 DiskPressure 状态。默认情况下，当 `imagefs.available` 低于 15%（大约 85% 的 imagefs 被使用）或 `nodefs.available` 低于 10% 时，kubelet 会标记为 DiskPressure；在 ACP 节点上，这些驱逐阈值正好配置为这些值。TSDB 本身位于专用卷上，而不是节点的通用文件系统：引擎以 `--storage.tsdb.path=/prometheus` 运行，标准的 Prometheus 块布局位于 `/prometheus` 下，该路径是由专用 PVC 支持的挂载 `prometheus-kube-prometheus-0-db`。由于转储必须在接近阈值的节点或卷上进行暂存和读取，因此操作可能会因缺乏头部空间而受到限制或失败——这是经过验证的接近满的 DiskPressure 状态的可见症状，而不是 Prometheus 写入其块方式的任何变化。平台监控堆栈在 `cpaas-system` 命名空间中以 StatefulSet pod `prometheus-kube-prometheus-0-0` 运行单个统一的 Prometheus，支持的 Prometheus CR 为 `kube-prometheus-0`，其 TSDB 位于专用的 30Gi RWO `topolvm-hdd` PVC 上，而不是节点的临时文件系统。

## 根本原因

TSDB 引擎是 ACP 上提供的上游 Prometheus 3.x，镜像为 `prometheus:v3.11.3-v4.3.4`，标准块布局位于 `/prometheus` 下：每个块目录包含一个 `meta.json`、一个 `index` 和一个与头 WAL 一起的 `chunks/` 目录。缺少 `meta.json` 文件的 TSDB 块变得不可读——这是通用的、与版本无关的 Prometheus 行为。存储的占用空间与基于时间的保留窗口成比例：容器以 `--storage.tsdb.retention.time=7d` 运行，由于保留是基于时间的，减半保留窗口会相应减少存储块的时间跨度，从而降低磁盘利用率。独立地，kubelet 的镜像垃圾回收机制在 ACP 节点上存在，`imageGCHighThresholdPercent=85` 和 `imageGCLowThresholdPercent=80`；当镜像 GC 无法取得进展时，节点无法通过该路径回收空间，从而为节点上的工作负载留下更少的头部空间。

## 解决方案

释放节点上的空间，并在 Prometheus 占用空间占主导时，缩短保留窗口以使 TSDB 成比例缩小。在 ACP 上，Prometheus 的保留期通过 prometheus 插件设置：`ClusterPluginInstance/prometheus` 将 `spec.config.components.prometheus.retention` 公开为整数天数（默认 7），该值被呈现为 Prometheus CR `spec.retention`，并在运行的容器中显示为 `--storage.tsdb.retention.time=7d` 参数。

在插件实例上设置更短的保留窗口（示例将其从 7 天降低到 3 天，大约减半存储块的时间跨度）：

```bash
kubectl patch clusterplugininstance prometheus \
  --type merge \
  -p '{"spec":{"config":{"components":{"prometheus":{"retention":3}}}}}'
```

新保留设置生效后，`cpaas-system` 中的 Prometheus CR `kube-prometheus-0` 将携带更新的 `spec.retention`，运行的容器将反映为更短的 `--storage.tsdb.retention.time` 值。

如果节点因镜像垃圾回收停滞而空间不足，则相同的 `imageGCHighThresholdPercent=85` / `imageGCLowThresholdPercent=80` 回收机制应释放镜像存储；清除底层磁盘消费者以便镜像 GC 可以恢复回收，将恢复节点上的头部空间。

## 诊断步骤

在不进入容器的情况下识别和确定 Prometheus 数据库卷的大小——ACP 的 `prometheus` 容器是无发行版的，不包含 `df`/`cat`/`ls` 二进制文件，因此容器内的 `df` 无法运行。根据 pod 规格解析挂载及其支持的 PVC，然后直接从 API 读取 PVC 的请求和绑定容量：

```bash
kubectl get pod -n cpaas-system prometheus-kube-prometheus-0-0 \
  -o jsonpath='{range .spec.containers[?(@.name=="prometheus")].volumeMounts[*]}{.name}{" -> "}{.mountPath}{"\n"}{end}'
kubectl get pvc -n cpaas-system prometheus-kube-prometheus-0-db-prometheus-kube-prometheus-0-0
kubectl describe pvc -n cpaas-system prometheus-kube-prometheus-0-db-prometheus-kube-prometheus-0-0
```

检查节点是否处于 DiskPressure 状态；`kubectl describe node` 显示 DiskPressure 状态（当清晰时报告 `KubeletHasNoDiskPressure`），以及节点的可分配和容量，包括临时存储容量，且同一状态可以通过 jsonpath 在不完全描述的情况下读取：

```bash
kubectl describe node <node-name>
kubectl get node <node-name> \
  -o jsonpath='{range .status.conditions[?(@.type=="DiskPressure")]}{.type}{"="}{.status}{" ("}{.reason}{")\n"}{end}'
```

检查 kubelet 日志以获取镜像 GC 失败的记录；日志行如 `Image garbage collection failed` 和 `wanted to free` 表明节点处于失败的回收循环中，产生相同的 `ImageGCFailed` 表面，由上游 kubelet (v1.34.5) 生成。该表面背后的驱逐信号和镜像 GC 回收机制是标准的 kubelet 镜像 GC 循环，受 `imageGCHighThresholdPercent=85` / `imageGCLowThresholdPercent=80` 阈值的限制。
