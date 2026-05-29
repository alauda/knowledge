---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500848
sourceSHA: 5469414e7e04182bafa297b93b2c52a0cde761d523c3cc68a158afa25e7c6a46
---

# OpenTelemetry Collector 日志 "Instrument description conflict" 对于 JVM 内存指标

## 问题

在集群中运行的 `OpenTelemetryCollector`，配置了 OTLP 接收器和 `prometheus` 导出器，每当两个上游源以不同的 OpenTelemetry 仪器描述发布相同的仪器名称时，都会重复记录 `jvm_memory_used_bytes` 指标的 `info` 级别冲突日志。日志行包含保留的描述和丢弃的描述，原样输出，来源于收集器的 `prometheusexporter` 组件，并在收集器每次摄取批次时重复出现。

```text
info  prometheusexporter@v0.147.0/collector.go:656  Instrument description conflict, using existing
  {"otelcol.component.id": "prometheus",
   "otelcol.component.kind": "exporter",
   "otelcol.signal": "metrics",
   "instrument": "jvm_memory_used_bytes",
   "existing": "The amount of used memory",
   "dropped":  "Measure of memory used."}
```

消息中的两个描述对应于两个独立的 JVM 指标源，它们在相同的 OTel 仪器名称 `jvm_memory_used_bytes` 下发布——OpenTelemetry Java 代理的内置 `runtime-telemetry` 模块以描述 `Measure of memory used.` 发出仪器，而 Micrometer-to-OTel 桥接（由 Spring Boot 的 actuator JVM 指标使用）以描述 `The amount of used memory` 发出。

## 根本原因

OpenTelemetry Collector 内部的 Prometheus 导出器通过仪器名称去重。当第二个注册到达时，如果名称相同但描述不同，导出器会保留第一个注册的描述，并发出 `Instrument description conflict, using existing` 日志行；冲突记录一次，并在后续批次重新确认冲突描述时重新发出。

该冲突是表面现象——收集器继续抓取并导出两个源的数据点，使用单个保留的仪器。在发送两个具有相同仪器名称和不同标签集的 OTLP 有效负载后（一个来自标记为 `job=app-a` 的 `micrometer` 范围，值为 `1024`；一个来自标记为 `job=app-b` 的 `runtime-telemetry` 范围，值为 `2048`），然后抓取导出器的 `/metrics` 端点，两个样本都在输出中以单个 `# HELP` 行出现，首个注册的描述赢得共享的 HELP 文本。

```text
# HELP jvm_memory_used_bytes The amount of used memory
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes{job="app-a",otel_scope_name="micrometer",...} 1024
jvm_memory_used_bytes{job="app-b",otel_scope_name="runtime-telemetry",...} 2048
```

重复发送这两个有效负载会继续更新两个样本；没有数据点被丢弃。因此，日志噪声是两个独立源在一个名称下写入的表面症状，而不是指标丢失的错误。

## 解决方案

有四种补救措施，均针对上述两个 `jvm_memory_used_bytes` 注册的根本重复。只有前三种通过移除两个源中的一个来消除日志行；第四种则接受日志噪声为表面现象，因为指标继续导出。

**选项 1 — 禁用 Java 代理中的 Micrometer-to-OTel 桥接。** 如果不特别需要 Micrometer 桥接的指标（OTel Java 代理已经开箱即用地发布等效的 JVM 指标），则通过将代理的功能标志设置为 `false` 来禁用桥接，可以在工作负载级别或通过自动注入的 `Instrumentation` CR 中进行。关闭桥接后，Micrometer 源的描述（`The amount of used memory`）不再到达收集器，仅保留代理的 `runtime-telemetry` 源的仪器，从而消除冲突。`Instrumentation` CR 的 `spec.java.env` 字段是用于 `OTEL_INSTRUMENTATION_*` 环境变量的上游形状载体；操作员将其注入到自动注入的容器中。CR 形状在集群中得到了确认——`spec.java.env` 是 `[]Object`，具有 `name`/`value`/`valueFrom`，与上游 OpenTelemetry Operator 架构匹配。

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-inst
  namespace: <your-app-namespace>
spec:
  java:
    env:
      - name: OTEL_INSTRUMENTATION_MICROMETER_ENABLED
        value: "false"
```

**选项 2 — 禁用代理的 runtime-telemetry。** 如果 Micrometer 桥接是应用程序指标的战略源，并且还应拥有 JVM 指标，则保持桥接启用并禁用代理的内置 runtime-telemetry 模块，以便 Micrometer 成为 `jvm_memory_used_bytes` 的唯一源——代理源的描述（`Measure of memory used.`）将不会与导出器注册。两个环境变量名称都被 OpenTelemetry Java 自动注入代理识别，并通过与选项 1 相同的 `Instrumentation` CR `spec.java.env` 字段传递。

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-inst
  namespace: <your-app-namespace>
spec:
  java:
    env:
      - name: OTEL_INSTRUMENTATION_MICROMETER_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_RUNTIME_TELEMETRY_ENABLED
        value: "false"
```

**选项 3 — 在应用程序级别（Spring Boot）禁用 Micrometer JVM 绑定。** 如果应用程序代码已经使用 Spring Boot actuator + Micrometer，但只希望静音 JVM 计量器（让 Micrometer 自由发布业务指标），则通过 actuator 切换从应用程序侧排除 JVM 绑定，以便 Micrometer 源的 JVM 仪器不再与桥接注册；OTel 代理的 runtime-telemetry 仍然是 JVM 指标源，Micrometer 继续发布其他所有内容。将以下属性添加到 Spring Boot 应用程序的 `application.properties` 或 `application.yaml` 中。

```text
management.metrics.enable.jvm=false
```

**选项 4 — 容忍日志噪声。** 如果管道的任一端都无法更改且两个源都是必需的，则可以安全地忽略日志行。冲突是 `info` 级别，指标正确导出，两个源都在贡献——两个样本仍然可以从 Prometheus 导出器在一个 `# HELP` 行下查询，并且收集器的 Prometheus 导出器当前没有暴露配置旋钮来抑制此特定日志行。

## 诊断步骤

阅读收集器日志并 grep 查找冲突行——其存在将源固定到 `prometheusexporter` 组件，并通过名称识别出有问题的仪器。

```bash
kubectl logs -n <otel-collector-namespace> deploy/<collector-deployment-name> \
  | grep -iE 'Instrument description conflict|prometheusexporter'
```

匹配的日志行显示保留的（`existing`）和丢弃的（`dropped`）描述字符串以及有问题的 `instrument` 名称。重复出现意味着两个上游源不断重新确认相同的仪器，使用不同的描述。

通过抓取收集器的 Prometheus 导出器端点并检查两个源的数据点是否存在，验证数据仍在流动，尽管存在日志噪声。

```bash
kubectl exec -n <otel-collector-namespace> <client-pod> -- \
  curl -s http://<collector-svc>:8889/metrics | grep '^jvm_memory_used_bytes'
```

每个唯一的标签组合（通常通过 `otel_scope_name` 和作业自己的标签区分）作为单个 `# HELP` 行下的单独样本出现。如果两个样本都存在，则冲突纯粹是表面现象，没有丢失任何指标数据——只有一个描述被选择用于共享的 `# HELP` 文本。

确认 `Instrumentation` 和 `OpenTelemetryCollector` CRD 存在并由实时控制器协调，这是选项 1 或 2 生效的前提。

```bash
kubectl api-resources --api-group=opentelemetry.io
kubectl get instrumentation,opentelemetrycollector -A
```

预期的组是 `instrumentations.opentelemetry.io`（`v1alpha1`）和 `opentelemetrycollectors.opentelemetry.io`（当前构建的 `v1beta1`；仍然为向后兼容提供 `v1alpha1`）。操作员 CSV 必须为 `Succeeded`，其控制器 Pod 必须为 `Running`，以便将 `Instrumentation` 环境变量更改注入到自动注入的工作负载中。
