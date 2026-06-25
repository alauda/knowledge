---
title: ACP OpenTelemetry v2 Installation and Instrumentation FAQ
type: faq
status: active
domain: observability
product: acp
tags: [acp, observability, opentelemetry, instrumentation, collector, faq]
updated: 2026-05-16
source: [official-docs]
related:
  - ../learning-progress.md
  - ../notes/observability.md
  - ../notes/observability-jaeger-otel-spm-metrics-quick-card.md
  - ../notes/observability-tracing-jaeger-backend-runbook.md
  - ./observability-faq.md
---

# ACP OpenTelemetry v2 安装与 Instrumentation FAQ

## OpenTelemetry v2 和旧版 OpenTelemetry 能同装吗？
不能。

官方文档明确写了：
- `Alauda Build of OpenTelemetry`
- `Alauda Build of OpenTelemetry v2`

不要在同一个 Kubernetes 集群里同时安装，否则会产生功能冲突。

## OpenTelemetry v2 和 Service Mesh 能同装吗？
要分版本看。

官方文档明确写了：
- `Alauda Service Mesh` 和 `Alauda Build of OpenTelemetry v2` 不能同装
- 但 `Alauda Service Mesh v2` 支持与 OTel v2 集成

所以现场不要把“mesh 能不能一起用”一概而论。

## OpenTelemetry Operator 和 Collector 能放同一个 namespace 吗？
不建议，也不符合文档推荐。

文档明确要求：
- **不要把 OpenTelemetry Collector 部署在 Operator 同一个 namespace**
- 应该单独创建 Collector namespace

这是一个很实用的边界：
- Operator namespace 管控制面
- Collector namespace 管实例

## OTel Collector 支持哪些部署模式？
官方示例里明确支持：
- `deployment`
- `daemonset`
- `statefulset`
- `sidecar`

如果只是做集中式前置接入，最常见还是 `deployment`。

## Collector 最小可用配置里通常包含什么？
最小骨架通常包括三段：
1. **receivers**：如 `otlp`、`jaeger`、`zipkin`
2. **processors**：如 `batch`、`memory_limiter`
3. **exporters**：如 `debug` 或 `otlp`

这三段都缺一不可。

## 为什么文档总强调 `memory_limiter` 和 `batch`？
因为这两个几乎是最常见的通用处理器：
- `batch`：提高发送效率
- `memory_limiter`：在 collector 过载时提供背压和内存保护

所以看到高流量丢 span / queue 异常时，不要只查 exporter，也要回头看处理器配置。

## instrumentation 没有注入进 Pod，先查什么？
建议按这个顺序：
1. `Instrumentation` 对象在不在
2. Pod 里有没有 `opentelemetry-auto-instrumentation` init-container
3. Instrumentation 是否先于 workload 部署
4. Operator 日志里有没有 admission / validation / permission 报错
5. workload 的 annotation 是否写对

最容易漏的一步其实是：
- **先创建 Instrumentation，再重启 workload**

如果 Pod 早于 Instrumentation 创建，通常需要手工 `rollout restart`。

## 怎么确认注入真的发生了？
最小验证动作有 4 个：
1. `kubectl describe pod` 看 init-container 段
2. `kubectl get events` 看 init-container 是否报错
3. `kubectl exec ... env | grep OTEL` 看环境变量有没有注入
4. `kubectl exec ... -- sh -c 'ls -lh /otel-auto-instrumentation-*'` 看注入目录和库文件是否存在

如果这几步都没有证据，先别跳到后端排查。

## 注入成功了，但还是没 trace / metric / log，先查什么？
先查两件事：
1. **endpoint 是否真的对**
2. **collector 是否真的收到数据**

高频检查点：
- `OTEL_EXPORTER_OTLP_ENDPOINT` 是否正确
- 用的是 `4317` gRPC 还是 `4318` HTTP
- application log 里有没有 OTel 连接错误
- collector log / debug exporter 里有没有收到数据
- collector metrics 里 `otelcol_receiver_accepted_*` 是否增长

## 默认 exporter endpoint 是什么？
文档里明确写到：
- 默认 endpoint 是 `http://localhost:4317`

所以如果你使用自定义 Collector Service，但没有显式覆盖 endpoint，应用可能会把数据发到本地而不是平台 Collector。

## 4317 和 4318 怎么区分？
最短记法：
- `4317` → OTLP gRPC
- `4318` → OTLP HTTP

现场常见问题不是 collector 坏了，而是应用和 collector 协议 / 端口没对齐。

## 怎么最快确认 Collector 到底有没有收到数据？
两条线最好一起看：

### 1. 看日志
如果开了 debug exporter：
- `kubectl logs <collector-pod> -n <ns> -f`

### 2. 看指标
重点看：
- `otelcol_receiver_accepted_spans`
- `otelcol_receiver_refused_spans`
- `otelcol_exporter_sent_spans`
- `otelcol_exporter_enqueue_failed_spans`

最短判断：
- accepted 增长 → receiver 收到了
- sent 不增长 → exporter / 下游链路更可疑

## debug exporter 适合什么时候用？
适合临时诊断：
- 验证 Collector 是否收到数据
- 看数据内容和格式是否符合预期
- 判断 pipeline 是否走通

但不建议长期用于生产，因为：
- 它会把遥测内容大量输出到 stdout
- 日志量会很大

## 怎么暴露 Collector 自己的 metrics？
最短做法：
1. 在 `service.telemetry.metrics.readers.pull.exporter.prometheus` 下暴露 `8888`
2. 在 CR 里加：

```yaml
spec:
  observability:
    metrics:
      enableMetrics: true
```

这样 Operator 会自动创建 `ServiceMonitor` 或 `PodMonitor`。

## 自动创建 ServiceMonitor / PodMonitor 的前提是什么？
前提是：
- `spec.observability.metrics.enableMetrics: true`

一旦开启：
- deployment / daemonset 等不同模式下，Operator 会按实例形态自动生成对应监控对象
- 一般不需要手工补 scrape target

## 为什么 targets 里没看到 Collector 指标？
先别直接怪 Prometheus。

建议先查：
1. `enableMetrics` 是否打开
2. metrics endpoint 是否真的监听在 `0.0.0.0:8888`
3. Operator 是否成功创建了 `ServiceMonitor/PodMonitor`
4. Prometheus Targets 里 `<instance_name>-collector` 是否 Up

## 哪些 Collector 组件最容易额外触发 cluster-level RBAC 需求？
文档点得比较明确的包括：
- `k8sattributes`
- `k8sobjects`
- `kubeletstats`
- `resourcedetection`

这些组件常常需要跨 namespace / cluster 访问 K8s 资源。

## Operator 会自动创建这些 RBAC 吗？
可以，但有前提。

要先给 Operator 自己授权，让它能创建：
- `ClusterRole`
- `ClusterRoleBinding`

否则会出现一种很烦的现象：
- Collector CR 创建成功
- 但某些 processor / receiver 实际跑不起来

## Collector 可以放到 infra 节点吗？
可以。

做法是在 `OpenTelemetryCollector` CR 里配：
- `spec.nodeSelector`
- `spec.tolerations`

最常见的做法是把它调度到 `node-role.kubernetes.io/infra` 节点上。

## 为什么已经加了 infra selector，Pod 还是没过去？
高频原因有两个：
1. node label 没配对
2. taint / toleration 没配对

最短检查：
- `kubectl get nodes -l node-role.kubernetes.io/infra=`
- `kubectl get pods -o wide -n <collector-ns>`
- `kubectl describe pod <pod>` 看调度事件

## OTel Collector 能保证数据不丢吗？
不能这么理解。

OTel 文档明确有个重要限制：
- **OpenTelemetry 不提供遥测数据交付保证**
- 也不自带存储能力或查询能力

所以如果用户问“装了 OTel 是不是就一定不丢且可查”，答案要回到后端和整体链路设计，不要把 OTel 说成存储系统。

## 什么时候该优先查应用，不该先查平台？
这几类情况优先回应用侧：
- endpoint 配成了默认 `localhost:4317`
- annotation 写错或没重启 workload
- application log 里已经明确报连接失败 / 配置错误
- 注入完成但 `OTEL_*` 环境变量不对

也就是说：
- **没证据表明数据进入 collector 前，不要太早怀疑 Jaeger / ES / UI**
