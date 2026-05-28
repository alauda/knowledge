---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500262
sourceSHA: a3be3eaec3d90679960b3d068be089bb77ca4c50f51c8e0a6a099a1603a675b4
---

# 区分容器内存指标中的JVM堆增长与页面缓存

## 问题

在一个pod中运行的JVM工作负载可能会显示 `container_memory_usage_bytes` 的值远高于配置的堆大小，这很容易被误认为是堆泄漏。在Alauda Container Platform v4.3.4中，捆绑的Prometheus堆栈（prometheus镜像 `v3.11.3-v4.3.4`，prometheus-operator/config-reloader `v0.91.0-v4.3.4`，在 `cpaas-system` 命名空间中的统一Prometheus）会全局抓取kubelet cAdvisor指标，而一个容器的内存cgroup的 `container_memory_usage_bytes` 包括了文件支持的可回收页面缓存，而不仅仅是进程的匿名堆内存——因此报告的值可以大幅超过堆，而没有任何匿名内存的增长。

## 根本原因

容器cgroup的使用数字将两种非常不同的内存类型合并在一起。匿名内存——JVM堆，由 `-Xmx` 限制——计入进程工作集，并且是与内存不足杀死相关的内存，因为它不能被内核按需回收。相比之下，页面缓存是文件支持的内存，内核可以在内存压力下回收，因此由页面缓存驱动的 `container_memory_usage_bytes` 的增长本身并不表示JVM堆泄漏。由于两者都计入同一个cgroup使用计数器，读取大量文件数据的容器似乎“使用”了远超其堆占用的内存，而额外的内存是可回收的缓存，而不是泄漏的堆。

## 解决方案

要区分这两者，可以将同一容器的 `container_memory_usage_bytes` 与 `container_memory_working_set_bytes` 进行比较。工作集指标是通过使用量减去可回收的非活动页面缓存得出的，因此它比原始使用量指标更紧密地跟踪无法在压力下简单回收的内存。对于一个容器，如果两者之间存在较大差距，则表示页面缓存占据了差异；在观察到的Prometheus容器中，使用值超过工作集约1.38 GB，而该差距归因于文件缓存而不是堆。匿名堆类内存仍然包含在工作集数字中，并且从未被减去，因此工作集是观察真正的堆或OOM问题的值。

PromQL比较显示每个容器的差距：

```text
container_memory_usage_bytes{namespace="<ns>", pod="<pod>"}
  - container_memory_working_set_bytes{namespace="<ns>", pod="<pod>"}
```

请注意，在ACP的cAdvisor中，未公开每个容器的RSS指标，因此匿名（堆类）部分不可作为可抓取的Prometheus系列；该部分必须从容器内的cgroup统计文件中读取，如下所述。

## 诊断步骤

从容器内部读取cgroup内存统计信息，以精确归因差距。节点运行cgroup v2（统一的 `cgroup2fs` 层次结构），其中 `/sys/fs/cgroup/memory.stat` 显示一个 `inactive_file` 字段，报告归属于容器cgroup的可回收文件支持页面缓存的数量。读取该文件直接确认了关系——使用量减去工作集的差距等于 `inactive_file` 值（在观察到的情况下，两者匹配在约0.4%以内），这表明非活动页面缓存正是工作集指标减少的内存。

```bash
kubectl exec -n <ns> <pod> -c <container> -- cat /sys/fs/cgroup/memory.stat
```

在cgroup v2下，同一文件将匿名内存分隔到一个 `anon` 字段，与 `inactive_file` 页面缓存字段不同。这种分离使诊断变得明确：当 `inactive_file` 大约等于观察到的超出JVM堆大小的内存增长时，页面缓存是该增长的原因，而不是堆泄漏。只有非活动文件缓存被回收并从工作集中排除；`anon` 堆类内存计入工作集且不被减去，因此将 `anon` 与堆边界进行比较，并将 `inactive_file` 与超出堆的增长进行比较，可以清晰地区分可回收缓存与真正的堆占用。

如果 `anon` 跟踪配置的堆，而多余部分位于 `inactive_file` 中，则增长是可回收的页面缓存，内核将在压力下释放它，因此无需进行堆修复。
