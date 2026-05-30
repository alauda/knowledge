---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500860
sourceSHA: 25d4a5136c40c3e0af7b2352409576175dd6c90a9860da349ebae52b83844dd5
---

# ResolutionRequest 每十小时进行一次协调的原因及其无害性

## 问题

在安装了 Alauda DevOps Pipelines operator 的 Alauda 容器平台 (kube `v1.34.5-1`) 上 (tektoncd-operator `v4.2.0`, TektonConfig `v0.76.0-c46274a` 已就绪)，一个几天或几周前完成的 `ResolutionRequest` (`resolution.tekton.dev/v1beta1`) 仍然出现在 remote-resolvers 控制器日志中，每十小时左右被协调一次，即使拥有它的 `PipelineRun` 已经完成。自然会产生一个问题：这种定期唤醒是否有任何作用——以及是否可以将间隔提高（例如到 24 小时）以减少其频率。

## 根本原因

十小时的节奏并不是 `ResolutionRequest` 特定的设置。Tekton remote-resolvers 控制器是基于 knative `controller` 框架构建的，其 `DefaultResyncPeriod` 是字面常量 `10 * time.Hour`；resolvers 二进制文件 `cmd/resolvers/main.go` 并没有调用 `controller.WithResyncPeriod`，因此其 informer 逐字继承了该框架的默认值，并在该间隔内重新列出每个 `ResolutionRequest`。由于该节奏存在于框架默认值中，并未作为环境变量、容器标志或 ConfigMap 键在 resolvers 的 `Deployment` 上暴露，因此控制器没有提供任何一流的调节器来按请求或全局更改该间隔——在 lab-base 上，实时的 `deploy/tekton-pipelines-remote-resolvers` 带有环境变量名称 `{ARTIFACT_HUB_API, CONFIG_FEATURE_FLAGS_NAME, CONFIG_LEADERELECTION_NAME, CONFIG_LOGGING_NAME, CONFIG_OBSERVABILITY_NAME, KUBERNETES_MIN_VERSION, METRICS_DOMAIN, PROBES_PORT, SYSTEM_NAMESPACE, TEKTON_HUB_API}`，并且 `args` 列表为空，均未命名 resync 周期。

已解决的 `ResolutionRequest` 的协调在结构上是一个无操作。上游的 `ReconcileKind` 在 `pkg/reconciler/resolutionrequest/resolutionrequest.go` 中，当 `rr.IsDone()` 为真时立即返回（即 `Succeeded` 条件不再为 `Unknown`），因此一旦请求被解决，定期唤醒就不会重新进入解析器代码路径——它仅作为一个安全措施存在，以便控制器可以恢复其 informer 可能错过的任何更新。

## 解决方案

保持十小时的节奏不变。由于已完成的 `ResolutionRequest` 的唤醒立即从 `ReconcileKind` 返回，因此定期协调的成本是微不足道的——在一个标准的 ACP 集群中，后解决的稳定协调和同一 `ResolutionRequest` 的注解触发的重新协调分别观察到 `duration=0.000030088` 和 `duration=0.000122599`（亚毫秒），且没有对对象的 API 服务器写入。这里没有值得调节的每个 `ResolutionRequest` 生命周期的调节器，并且将框架默认值提高到二十四小时的控制器端调节器并未被 resolvers 二进制文件暴露。

为了确认特定集群上的无操作形态，通过注解强制对已完成的 `ResolutionRequest` 进行新协调（以便工作队列在不等待十小时重新同步的情况下接收它），然后读取 resolvers 控制器日志中相同的 `knative.dev/key`；该键的 `Reconcile succeeded` 行应报告在第二次及后续协调中的亚毫秒 `duration` 字段，这是 `IsDone()` 短路的实时特征。

## 诊断步骤

列出集群上的 `ResolutionRequest` 对象，并选择一个其 `SUCCEEDED` 列为 `True` 的对象——即 `IsDone()` 为真且定期协调是无操作的：

```bash
kubectl get resolutionrequest -A
```

读取其 `Succeeded` 条件以确认解析器已完成处理：

```bash
kubectl -n <ns> get resolutionrequest <name> \
  -o jsonpath='{.status.conditions[*]}{"\n"}'
```

尾随该请求的 remote-resolvers 控制器日志以获取其协调条目；条目由 `knative.dev/key=<ns>/<rr-name>` 进行键控，并带有以秒为单位的 `duration` 字段：

```bash
kubectl -n tekton-pipelines logs deploy/tekton-pipelines-remote-resolvers --tail=200 \
  | grep '<ns>/<rr-name>'
```

通过注解请求强制进行新协调，而无需等待十小时（任何注解更改都会重新排队）；相同键的下一个日志条目应显示亚毫秒的 `duration`，这是 `IsDone()` 短路的实时可观察特征：

```bash
kubectl -n <ns> annotate resolutionrequest <name> \
  kb.resync/poke="$(date +%s)" --overwrite
```

如果该键的 `duration` 字段为亚毫秒，并且请求的 `resourceVersion` 和 `Succeeded` 条件在唤醒期间没有变化，则定期的十小时重新同步正如上游代码所规定的那样——运行框架的安全重新列出并在没有工作时退出——无需调节。
