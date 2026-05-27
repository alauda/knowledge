---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500143
sourceSHA: 8b1f819ddf1ca3fb88277d4720cd49aacde777c69b34ec0668a706ad4706781f
---

# Pods 在内存不足时保持 Pending，而 kubectl top 显示 ACP 上有可用的 RAM

## 问题

在运行上游 Kubernetes v1.34.5 的 Alauda Container Platform 上，新 Pods 可能会处于 `Pending` 状态，并出现 `FailedScheduling` 事件，报告 `0/N nodes are available: N Insufficient memory`，即使 `kubectl top node` 显示每个节点上都有健康的可用 RAM。ACP 上的调度组件是上游的 `kube-scheduler` 二进制文件，作为静态 Pod `kube-scheduler-<node-ip>` 部署在 `kube-system` 命名空间中，使用的镜像为 `registry.alauda.cn:60080/tkestack/kube-scheduler:v1.34.5`，因此适配逻辑和 `Insufficient <resource>` 原因字符串直接来自上游 kube-scheduler 代码。调度程序通过将每个 Pod 的 `spec.containers[*].resources.requests` 与每个节点的 `status.allocatable` 减去已调度 Pods 的请求总和进行比较（这是在调度程序的内存缓存中计算的残差，并未在节点对象上重新发布），如果一个 Pod 无法适应任何节点的剩余空间，则会保持 Pending 状态，并出现 `0/N nodes are available: N Insufficient <resource>` 的 `FailedScheduling` 事件。

## 根本原因

`status.allocatable` 严格小于 `status.capacity`，因为 kubelet 在发布 Allocatable 之前从 Capacity 中减去了 `kubeReserved`、`systemReserved` 和硬驱逐阈值。在受影响的 ACP 集群中，kubelet 配置设置为 `kubeReserved={cpu:100m, memory:902Mi}`、`systemReserved={cpu:100m, memory:902Mi}`，并且在控制平面节点和三个工作节点上均匀设置了 `evictionHard.memory.available=100Mi`；结果节点状态显示 Capacity 内存为 `16384568Ki`，Allocatable 内存为 `14434872Ki`，二者之间的差值为 `1904Mi`，与保留计算完全一致（`902Mi + 902Mi + 100Mi = 1904Mi`）。

调度是对 `requests` 的记账，而不是对实际利用率的记账。一旦 Pod 被调度，完整的 `requests` 值就会从节点的 Allocatable 中减去以用于调度，即使 Pod 在运行时消耗的 RAM 远低于此值，因此调度程序在 Pod 请求的总和达到 Allocatable 时将节点视为已满。`kubectl top node` 从 `metrics.k8s.io/v1beta1` `NodeMetrics` API 读取（由 `cpaas-monitor-prometheus-adapter` 在 ACP 上提供），报告当前瞬时 CPU 和内存 **利用率**，这是通过指标管道采样的 — 它不报告已调度的 `requests`。由于 top 测量的是利用率，而调度程序考虑的是请求，因此在 `kubectl top node` 中，节点可能看起来有很多可用内存，而调度程序仍然拒绝新的 Pods，原因是 `Insufficient memory`；这两个表面测量的是不同的内容。

## 解决方案

首要的补救措施是将每个 Pod 的 `resources.requests` 调整到与实际应用内存使用情况相匹配，以便调度程序的记账反映现实，并释放现有节点上的 Allocatable 头部空间。当调整请求的大小不可行时，另一种选择是为现有工作节点添加内存或添加更多工作节点；这两种方式都会增加集群的总 Allocatable，并为调度程序提供更多空间，而无需更改 Pod 规格。

编辑工作负载的 Pod 模板以降低过高的请求。该机制是固定的（调度程序逐字读取 `.spec.containers[*].resources.requests`，因此降低请求会释放 Allocatable 头部空间）；下面的具体 Mi / cpu 数字是示例占位符，应替换为反映工作负载实际使用情况的值：

```yaml
spec:
  containers:
    - name: app
      resources:
        requests:
          memory: 256Mi
          cpu: 100m
        limits:
          memory: 512Mi
          cpu: 500m
```

更改后，调度程序将在下一个周期重新评估待处理的 Pods，一旦节点有足够的剩余 Allocatable 来适应新的请求，`FailedScheduling` 事件将被清除。

## 诊断步骤

首先检查节点的账目。`kubectl describe node <name>` 打印出一个 `Allocated resources` 块，列出每种资源的请求和限制占节点 **Allocatable**（而不是 Capacity）的百分比；这是与调度程序看到的内容相匹配的列，也是当 Pod 因 `Insufficient memory` 而卡在 Pending 状态时应该查看的正确位置，而 top 显示有可用 RAM。在受影响的 ACP 集群中的一个节点上，该块显示的条目形状为 `cpu 6120m (78%) ... memory 7728Mi (54%) ... limits 32928m (422%) / 51174Mi (363%)` — 百分比是针对 Allocatable 计算的，限制列超过 100% 是因为限制并不限制调度：

```bash
kubectl describe node <node-name>
```

比较 Capacity 和 Allocatable 以确认保留计算：

```bash
kubectl get node <node-name> -o jsonpath='{.status.capacity}{"\n"}{.status.allocatable}{"\n"}'
```

Capacity 减去 Allocatable 的差值等于 `kubeReserved + systemReserved + evictionHard.memory.available`；在受影响的集群中，这个值是 `1904Mi`（`902Mi + 902Mi + 100Mi`），在所有四个节点上是一致的。

交叉检查利用率与已调度请求。`kubectl top node` 从 `metrics.k8s.io/v1beta1` `NodeMetrics` API 报告瞬时利用率，并且当工作负载请求的资源超过实际使用时，通常会显示比 `describe node` 请求列低得多的数字：

```bash
kubectl top node <node-name>
```

top 读取与 `describe node` 请求百分比之间的较大差距是导致此症状的利用率与请求混淆的典型特征；在调度决策中应信任请求列。
