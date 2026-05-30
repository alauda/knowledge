---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500772
sourceSHA: 2d1d108a804b17ef9c325e238e77aca1dac7259e32dd3c06ea79de6916357cc0
---

# PipelineRun 在 ACP DevOps Pipelines 中卡在 PipelineRunPending 状态

## 问题

在使用 Alauda DevOps Pipelines operator 的 Alauda 容器平台上（platform-catalog `tektoncd-operator` 包，版本 `v4.2.0`，`TektonConfig config` 在 `v0.76.0-c46274a` 时就绪），一个以 `spec.status: PipelineRunPending` 创建的 `PipelineRun` 并未开始执行：其 `.status.conditions` 报告 `reason: PipelineRunPending`，消息为 `PipelineRun "<name>" is pending`，并且在门控存在的情况下，管道的任何任务都没有生成 `TaskRun`。待处理的 PipelineRun 的事件流仅限于控制器的记账（`Started`，`FinalizerUpdate`）——在待处理状态清除之前，没有调度、Pod 或 TaskRun 事件出现。

## 根本原因

`spec.status: PipelineRunPending` 是上游 Tekton 用于创建处于“暂停”状态的 PipelineRun 的机制。Tekton 控制器通过将 PipelineRun 保持在其初始的 `PipelineRunPending` 原因来尊重门控，并拒绝生成任何 `TaskRun`，直到 `spec.status` 被移除或用户重新提交一个没有门控的新的 PipelineRun。在 ACP DevOps Pipelines 中，门控的实现与上游完全相同——相同的控制器镜像包含在 operator 包中，`pipelineruns.tekton.dev` CRD 验证并存储该字段。

当其他东西（外部观察者、CI 集成或 Git 触发的控制器）以 `spec.status: PipelineRunPending` 创建了 PipelineRun，然后未能清除门控时，PipelineRun 可能会卡在此状态——例如，由于 API 超时或在创建调用和计划清除之间控制器重启。从 operator 的角度来看，没有任何需要调和的内容：PipelineRun 正处于 Tekton API 合同要求的 `PipelineRunPending` 状态，因此在手动移除门控之前不会出现任何 `TaskRun`。

## 解决方案

有两条可互换的恢复路径适用，均已在运行的 operator 上验证。

**修补受影响的 PipelineRun 以移除待处理门控。** 使用 JSON-patch 移除 `.spec.status` 会导致 Tekton 控制器在下次调和时拾取该 PipelineRun，将其 `Ready` 条件转换为 `Running`，并为其任务创建 `TaskRun`：

```bash
kubectl patch pipelinerun <name> -n <namespace> \
  --type=json -p='[{"op":"remove","path":"/spec/status"}]'
```

修补后，`kubectl get pipelinerun <name>` 显示 `spec.status` 为空，聚合条件从 `PipelineRunPending` 翻转为 `Running`，并且 `kubectl get taskrun -n <namespace>` 在几秒钟内列出每个任务的 TaskRun。该修补仅清除门控——不会影响管道定义、参数、工作区或 PipelineRun 上的任何拥有者引用，因此继续的运行与提交它的用户已经连接的历史相同。

**手动重新提交运行。** 如果无法在原地修补卡住的 PipelineRun（例如其 spec 已被下游工具观察），为同一管道创建一个新的 PipelineRun——没有 `spec.status: PipelineRunPending`——会立即开始执行：新的运行的 `TaskRun` 被创建，Pod 被调度，新的 PipelineRun 独立于原始的待处理 PipelineRun 进展到其终止条件，原始的待处理 PipelineRun 将保持暂停状态，直到它也被修补或删除。

在对 operator 的并行测试中，一个新的 PipelineRun 与仍处于待处理状态的 PipelineRun 一起提交，运行到终止的 `Ready=False`，而待处理的 PipelineRun 的 `.spec.status` 保持为 `PipelineRunPending`，并且从未为其创建任何 `TaskRun`。无论使用哪条路径，继续的运行都不需要对管道定义、集群或 operator 的配置进行任何更改——恢复完全依赖于 PipelineRun 资源。

## 诊断步骤

确认 PipelineRun 正处于上游的待处理门控，而不是其他 Tekton 条件：

```bash
kubectl get pipelinerun <name> -n <namespace> \
  -o jsonpath='{.spec.status}{" / "}{.status.conditions[*].reason}{" / "}{.status.conditions[*].message}{"\n"}'
```

门控的确切标志是 `spec.status: PipelineRunPending`，结合 `.status.conditions[*].reason` 为 `PipelineRunPending` 和消息形式为 `PipelineRun "<name>" is pending`。任何其他条件原因（`Running`、`Failed`、`TaskRunImagePullFailed`、`Cancelled` 等）都是不同的问题——下面的 JSON-patch 仅处理仍然暂停在待处理门控上的运行。

确认没有为管道的任务创建任何 `TaskRun`（问题的第二个症状）：一个暂停的 PipelineRun 从未调度其任务，因此按 PipelineRun 的标签过滤的 `get taskrun` 返回没有行：

```bash
kubectl get taskrun -n <namespace> \
  -l tekton.dev/pipelineRun=<pipelinerun-name>
```

当门控存在时，结果是 `No resources found in <namespace> namespace.`。检查相同范围的事件流以确认控制器没有放弃——对于待处理的 PipelineRun，仅应存在记账事件（`Started`，`FinalizerUpdate`）：

```bash
kubectl get events -n <namespace> \
  --field-selector involvedObject.kind=PipelineRun,involvedObject.name=<name>
```

在 JSON-patch 之后（或在手动重新提交之后），重新运行相同的 `get pipelinerun` 和 `get taskrun` 命令以确认门控已消失，`.status.conditions[*].reason` 已移动到 `Running`，并且每个任务的 `TaskRun` 已被创建。

## 注意事项

- 待处理门控机制（`spec.status: PipelineRunPending`）和 JSON-patch 恢复（`--type=json -p='[{"op":"remove","path":"/spec/status"}]'`）是上游 Tekton，并且在 ACP operator 包中工作相同——`tektoncd-operator.v4.2.0`，`TektonConfig` 在 `v0.76.0-c46274a` 时——与原生 Tekton 安装相同。
- 本文涵盖了通用的待处理 PipelineRun 恢复。它不涵盖 Git 事件触发观察者或每个存储库队列管理器，这些管理器代表用户提交带有待处理门控的 PipelineRuns——这些组件不属于在此测试的包中的默认 `TektonConfig` 安装配置，任何队列级别的“解除卡住”行为属于该组件的文档，而不是通用的 PipelineRun 门控。

## 验证

- 以 `spec.status: PipelineRunPending` 创建的 PipelineRun 保持暂停：`.spec.status` 保持为 `PipelineRunPending`；`.status.conditions[*].reason=PipelineRunPending`；`.status.conditions[*].message='PipelineRun "<name>" is pending'`。
- 当门控存在时，`kubectl get taskrun -n <ns>` 返回 `No resources found`，并且 PipelineRun 发出的唯一事件是 `Started` 和 `FinalizerUpdate`——没有调度或 Pod 事件。
- 重新提交的没有 `spec.status` 的 PipelineRun 运行到终止状态并产生一个 TaskRun，而并行的原始 PipelineRun 仍然保持暂停状态，且没有 TaskRun。
- 在执行 `kubectl patch pipelinerun <name> --type=json -p='[{"op":"remove","path":"/spec/status"}]'` 后，门控清除：`.spec.status` 变为空，`.status.conditions[*].reason` 翻转为 `Running`，并且在几秒钟内出现一个 TaskRun。
