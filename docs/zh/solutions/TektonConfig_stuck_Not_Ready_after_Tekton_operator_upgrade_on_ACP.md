---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500759
sourceSHA: ac12d2274ccc1d1280304b506cd26c5f55e6f87a72166b95b72467543f1a433b
---

# TektonConfig 在 ACP 上升级 Tekton operator 后卡在 Not Ready 状态

## 问题

在安装了 Alauda DevOps Pipelines operator（平台目录中的 `tektoncd-operator` 包，版本 `v4.2.0`，显示名称为 "Alauda DevOps Pipelines"）的 Alauda Container Platform 上，一个名为 `config` 的单个集群范围的 `TektonConfig` 驱动着 operator 的组件协调。其 READY 列是 operator 的整体健康信号：`kubectl get tektonconfig` 返回 `NAME / VERSION / READY / REASON`，在成功安装后，行显示为 `config / v0.76.0-c46274a / True`。在 operator 升级后（或协调未能收敛时），`TektonConfig` 可能会变为 `READY=False`，其 `REASON` 行的形式为 `Components not in ready state: <Component>: <message>` — 例如，当 Pipelines-as-Code 组件未能稳定时，原因是 `OpenShiftPipelinesAsCode: reconcile again and proceed`，并且 `kubectl get tektonconfig` 显示 `False`，直到 operator 能够将组件协调到就绪状态。

## 根本原因

`TektonConfig.status` 将每个组件的就绪状态聚合为顶级的 `Ready` 条件。在运行的 operator 上，状态形状为：

```
status:
  conditions:
  - type: PreInstall        status: "True"
  - type: PreUpgrade        status: "True"
  - type: ComponentsReady   status: "True"
  - type: PostInstall       status: "True"
  - type: PostUpgrade       status: "True"
  - type: Ready             status: "True"
```

一个卡住的组件会将 `ComponentsReady`（因此 `Ready`）翻转为 `False`，而 `kubectl get tektonconfig` 上可读的 `REASON` 列则携带失败组件的名称和消息。operator 管理的每个组件 — Pipelines、Triggers、Chains、Hub、Pruner、验证/变更 webhook 和 Pipelines-as-Code 组件 — 都以一小组 `TektonInstallerSet` 资源的形式体现，这些资源由每个组件的 CR（`TektonPipeline`、`TektonTrigger`、`TektonChain`、`OpenShiftPipelinesAsCode` 等）拥有。在健康的安装中，库存看起来像这样：

```
$ kubectl get tektoninstallersets
NAME                                READY   REASON
chain-config-llr4g                  True
chain-kk7dg                         True
chain-secret-t69kk                  True
pipeline-main-deployment-brfzx      True
pipeline-main-static-65bjt          True
tekton-hub-api-fsx8g                True
tekton-hub-db-gj427                 True
tekton-hub-db-migration-pqj66       True
tekton-hub-ui-j6dc9                 True
tektoncd-pruner-p4wml               True
trigger-main-deployment-hbpmc       True
trigger-main-static-jjtxz           True
validating-mutating-webhook-m475r   True
```

每个 `TektonInstallerSet` 都携带 `ownerReferences` 指向其组件 CR，operator 的 webhook 在创建时注入一个单一的最终处理器 `tektoninstallersets.operator.tekton.dev`。组件 CR（以及 `TektonConfig` 的聚合）在其 `TektonInstallerSet` 不就绪时无法变为就绪 — 因此，一个卡住的安装集，operator 无法继续处理，直接在 `TektonConfig` 上表面化为文章中的 `Components not in ready state` 原因。

Pipelines-as-Code 组件特别作为集群范围的 CR `openshiftpipelinesascodes.operator.tekton.dev`（简称 `opac` / `pac`）暴露；operator 包在平台安装时提供此 CRD，但 `OpenShiftPipelinesAsCode` 操作数并不会作为默认 `TektonConfig` 配置的一部分自动实例化。当创建了 `pac` 操作数并且其安装集卡住时，删除这些安装集可以让 operator 重新创建它们并重新协调组件到就绪状态。

## 解决方案

根据卡住的情况是通用的（一个无法被其所有者移除最终处理器的安装集）还是特定于组件的（operator 的协调循环对于一个组件失败），有两条恢复路径适用。

**首先重新创建卡住的安装集（首选）。** 重新创建安装集是 operator 识别的路径：当其拥有的组件控制器健康时，它将根据其嵌入的清单再次放置该资源。在修补最终处理器之前尝试此操作，因为强制移除仍在积极协调的资源的最终处理器可能会孤立 operator 管理的子资源。

```bash
# 确定失败的组件，然后删除其安装集
kubectl get tektoninstallerset \
  -l operator.tekton.dev/created-by=<ComponentName>
kubectl delete tektoninstallerset <names>
```

如果删除顺利完成，拥有者控制器将在几秒钟内重新创建该集。

**强制移除卡住的 `TektonInstallerSet` 最终处理器（最后手段）。** 仅在删除确实卡住时使用此方法 — 意味着资源的 `deletionTimestamp` 设置超过一分钟，拥有的组件协调失败（operator pod 日志显示对该组件的重复错误），并且根据前一步的操作重新创建未能解除卡住。

在修补之前确认前提条件：

- 资源具有 `deletionTimestamp` 设置：`kubectl get tektoninstallerset <name> -o jsonpath='{.metadata.deletionTimestamp}'` 返回非空时间戳。
- 唯一的最终处理器是控制器自己的 `tektoninstallersets.operator.tekton.dev`。如果存在额外的最终处理器，请先调查它们。
- 在修补之前捕获当前规格：`kubectl get tektoninstallerset <name> -o yaml > /tmp/<name>.yaml`，以便在 operator 未能自动放置时恢复任何 operator 管理的子资源。
- 确认与客户沟通，安装集的拥有清单可以丢失 — 拥有者控制器通常会重新创建它们，但仍在协调的拥有者可能不会。

然后发出修补；资源会立即离开 API 服务器：

```bash
kubectl patch tektoninstallerset <name> \
  --type=merge -p '{"metadata":{"finalizers":null}}'
```

在修补后，观察拥有的组件重新创建安装集（`kubectl get tektoninstallerset -l operator.tekton.dev/created-by=<ComponentName> -w`）。如果在一分钟内没有返回，拥有者仍在失败 — 在采取其他措施之前查看 operator pod 日志以获取底层错误。

**重新协调卡住的 Pipelines-as-Code 组件。** 当失败的组件是 Pipelines-as-Code 时，列出属于 `pac` 操作数的 `TektonInstallerSet`（它们的名称以组件为前缀，例如 `openshiftpipelinesascode-main-deployment-*`、`openshiftpipelinesascode-main-static-*`、`openshiftpipelinesascode-post-*`）并删除它们；operator 的组件控制器将根据其嵌入的清单重新创建它们，组件返回到就绪状态：

```bash
kubectl get tektoninstallerset \
  -l operator.tekton.dev/created-by=OpenShiftPipelinesAsCode
kubectl delete tektoninstallerset <pac-installerset-names>
```

如果其中任何删除卡住，应用上述最终处理器为空的修补。在安装集重新创建后，一旦 `ComponentsReady` 反转，`TektonConfig` 将返回 `READY=True`，并且导致此问题的诊断 — `kubectl get tektonconfig` — 应该显示该行没有 `Components not in ready state` 原因。

## 诊断步骤

检查 `TektonConfig` 的整体健康状况和失败组件名称：

```bash
kubectl get tektonconfig
```

`READY` 列是整体的 `Ready` 条件；当 `READY=False` 时，`REASON` 列携带第一个失败组件的名称和消息（例如 `OpenShiftPipelinesAsCode: reconcile again and proceed`）。

要获取完整的条件细分 — `ComponentsReady`、`PreInstall`、`PreUpgrade`、`PostInstall`、`PostUpgrade`、`Ready` — 直接读取 `TektonConfig.status.conditions`：

```bash
kubectl get tektonconfig config -o jsonpath='{.status.conditions}' | jq .
```

`ComponentsReady` 为 `False` 将故障定位到一个特定的组件安装集。

列出安装集并检查支持失败组件的那个：

```bash
kubectl get tektoninstallerset
kubectl describe tektoninstallerset <name>
```

查找 `metadata.deletionTimestamp`（资源正在终止）和单个 `tektoninstallersets.operator.tekton.dev` 最终处理器条目 — 该组合是 `--type=merge -p '{"metadata":{"finalizers":null}}'` 修补旨在清除的内容。

当失败的组件是 Pipelines-as-Code 时，还需确认 `OpenShiftPipelinesAsCode` 操作数存在并检查其安装集：

```bash
kubectl get openshiftpipelinesascodes
kubectl get tektoninstallerset \
  -l operator.tekton.dev/created-by=OpenShiftPipelinesAsCode
```

如果 `openshiftpipelinesascodes` 返回 `No resources found`，则 `pac` 组件从未在此集群上实例化，`OpenShiftPipelinesAsCode: reconcile again and proceed` 症状只能在创建操作数后出现 — operator 在平台安装时提供 CRD，但不会在默认 `TektonConfig` 配置下创建操作数。
