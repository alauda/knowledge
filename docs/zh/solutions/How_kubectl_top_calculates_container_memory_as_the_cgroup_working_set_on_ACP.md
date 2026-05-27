---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500217
sourceSHA: 739e802ba1b99cffecfc3f1cb699d5c3ea35f52295f338d5a94bc0a8cc214bb3
---

# 如何在 ACP 上通过 kubectl top 计算容器内存作为 cgroup 工作集

## 问题

在 Alauda Container Platform (Kubernetes v1.34.5) 上，`kubectl top pods` 和 `kubectl top nodes` 显示的每个 pod 和每个节点的内存数据是容器的 *工作集*，而不是容器所触及的总内存量。ACP 上的 `metrics.k8s.io/v1beta1` API 由 `cpaas-monitor-prometheus-adapter` 在 `cpaas-system` 命名空间中提供（helm chart `prometheus-adapter-1.4.2`），APIService 报告 `Available=True`；适配器的内存 `containerQuery` 是 `cAdvisor` 系列 `container_memory_working_set_bytes` 的总和，因此到达 CLI 的值是工作集本身，而不是任何平台特定的计算。在一个测量的 pod 中，kubelet 的 `PodMetrics` 值对于 `prometheus` 容器为 `memory=530544Ki`，而在同一抓取时的 cAdvisor 样本为 `container_memory_working_set_bytes=532905984` 字节——在两个收集路径之间的样本偏差中是相同的数字。

由于工作集是一个较小的、去除缓存的数字，它与 `free` 等节点范围工具或容器运行时工具对同一工作负载的报告不一致；在同一时刻，同一容器的总 cgroup 使用量为 `container_memory_usage_bytes=1895079936`（约 1.895 GB），而工作集为约 533 MB，差距大约为 3.5 倍，完全由工作集视图剔除的页面缓存驱动。

## 根本原因

工作集遵循标准的 cgroup 派生形式：它是容器的总内存使用量减去当前不活动（可回收）的文件缓存。通过 kubelet 的 `/stats/summary` 端点可以观察到相同的形状——一个采样的节点报告 `usageBytes=15259226112`，`workingSetBytes=5915795456`，和 `rssBytes=3337379840`，因此严格地说 `usage > workingSet > rss`，使用量和工作集之间约 9.3 GB 的差距归因于已经被降级到不活动列表的缓存，因此未被计入。相同的 `/stats/summary` 负载还显示了每个 cgroup 的 PSI（`pressure stall`）完整/部分 `{avg10, avg60, avg300}` 字段，填充了节点，这要求使用统一层次的 cgroup 栈，因此这些节点上 kubelet 暴露的工作集值是统一层次的形式，而不是任何遗留的统计布局。

总 cgroup 使用量分解为常驻匿名内存加上页面缓存，这一身份在该集群中保持一致。对于 `prometheus` 容器，cAdvisor 报告 `container_memory_rss=530235392` 和 `container_memory_cache=1352925184`，总和为 1883160576 字节——在同一抓取时与 `container_memory_usage_bytes=1895079936` 相差约 12 MB。工作集约为 533 MB，基本上等于该容器的 `rss`，因此使用量和工作集之间约 1.36 GB 的差距是缓存部分（主要是非活动文件页面），这是工作集定义剔除的部分——这也是 `free` 和运行时工具报告的数字高于 `kubectl top` 的原因。

## 解决方案

使用标准内存视图读取工作集。这些命令返回的值由 `cpaas-monitor-prometheus-adapter` 从 `container_memory_working_set_bytes` 填充，因此它们是构造上的工作集，而不是派生的近似值：

```bash
kubectl top pods -n <namespace>
kubectl top nodes
```

将报告的数字视为工作集：这是一个比总内存使用量更小、更独特的值，差异由可回收的页面缓存占据。相同的抓取同时暴露工作集和总使用量以进行直接比较——在同一容器上查询 `container_memory_working_set_bytes` 和 `container_memory_usage_bytes` 通常会显示使用量远高于工作集，且差距与页面缓存系列在十几 MB 之内匹配。

不要将工作集与测量不同范围或以不同方式的工具进行交叉比较。通过 `container_memory_usage_bytes` 暴露的总 cgroup 使用量（在上述示例中约为 1.9 GB）包括工作集视图剔除的缓存，因此在任何报告总使用量的工具中，相同的工作负载看起来要大几倍。容器自身的使用量和工作集是 `kubectl top` 和指标 API 显示的较小的 cgroup 范围值；节点范围的工具回答的是不同的问题，结果不会匹配。

## 诊断步骤

要在监控查询中检查工作集，请使用 cAdvisor 导出的 Prometheus 系列。这两个指标都是从 `job=kubelet` 在端口 `10250` 上抓取的（cAdvisor 嵌入在 kubelet 中），并且在此构建的集群内 Prometheus 的 `/api/v1/label/__name__/values` 列表中存在（镜像 `registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4`）。工作集发布为 `container_memory_working_set_bytes`，总 cgroup 使用量发布为 `container_memory_usage_bytes`：

```text
container_memory_working_set_bytes   # kubectl top 报告的内容
container_memory_usage_bytes         # 总 cgroup 使用量 (>= 工作集)
container_memory_rss                 # 常驻匿名部分
container_memory_cache               # 页面缓存；使用量与工作集之间的松弛
```

要在节点上直接确认工作集身份，而不离开 Kubernetes API 表面，请通过 `kubectl get --raw` 读取 kubelet 的摘要端点；同样的 `usageBytes` / `workingSetBytes` / `rssBytes` 字段在每个容器和每个节点上都可以显示，并可以与同一时刻的 Prometheus 系列进行交叉检查：

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/stats/summary" \
  | grep -E '"(usageBytes|workingSetBytes|rssBytes)"'
```

在同一容器上，`usage` 数字明显高于 `workingSet` 是预期的，并确认了缓存剔除的形状，而不是指示泄漏；差异与健康节点上的 `container_memory_cache` 匹配，存在抓取抖动。
