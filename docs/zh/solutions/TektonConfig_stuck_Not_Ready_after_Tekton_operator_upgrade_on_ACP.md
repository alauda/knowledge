---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500759
sourceSHA: c5f61d558f5d6458896649c8134b9ef024866e69f770e19084124c7c0b0f5e95
---

# TektonConfig 在 ACP 上升级 Tekton operator 后卡住 Not Ready

## 问题

在安装了 Alauda DevOps Pipelines operator（平台目录 `tektoncd-operator` 包，版本 `v4.2.0`，显示名称 "Alauda DevOps Pipelines"）的 Alauda 容器平台上，一个名为 `config` 的单个集群范围的 `TektonConfig` 驱动着 operator 的组件协调。其 READY 列是 operator 的整体健康信号：`kubectl get tektonconfig` 返回 `NAME / VERSION / READY / REASON`，在成功安装后，行显示为 `config / v0.76.0-c46274a / True`。在 operator 升级后（或协调未能收敛时），`TektonConfig` 可以切换为 `READY=False`，其 `REASON` 行的形式为 `Components not in ready state: <Component>: <message>` — 例如，当 Pipelines-as-Code 组件未能稳定时，原因是 `OpenShiftPipelinesAsCode: reconcile again and proceed`，并且 `kubectl get tektonconfig` 显示 `False`，直到 operator 能够将组件协调到就绪状态。

## 根本原因

`TektonConfig.status` 将每个组件的就绪状态聚合到一个顶级的 `Ready` 条件。在运行的 operator 上，状态形状为：

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

一个卡住的组件将 `ComponentsReady`（因此 `Ready`）切换为 `False`，而 `kubectl get tektonconfig` 上的人类可读的 `REASON` 列携带失败组件的名称和消息。operator 管理的每个组件 — Pipelines、Triggers、Chains、Hub、Pruner、验证/变更 webhook 和 Pipelines-as-Code 组件 — 都以一小组 `TektonInstallerSet` 资源的形式体现，这些资源由每个组件的 CR（`TektonPipeline`、`TektonTrigger`、`TektonChain`、`OpenShiftPipelinesAsCode` 等）拥有。在健康的安装中，库存看起来像这样：

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

每个 `TektonInstallerSet` 都携带 `ownerReferences` 回到其组件 CR，operator 的 webhook 在创建时注入一个单一的最终处理器 `tektoninstallersets.operator.tekton.dev`。当其 `TektonInstallerSet` 不就绪时，组件 CR（和 `TektonConfig` 的聚合）无法变为就绪状态 — 因此，一个卡住的安装程序集，operator 无法继续处理，直接在 `TektonConfig` 上表面化为文章中的 `Components not in ready state` 原因。

Pipelines-as-Code 组件特别作为集群范围的 CR `openshiftpipelinesascodes.operator.tekton.dev`（简称 `opac` / `pac`）暴露；operator 包在平台安装时提供此 CRD，但 `OpenShiftPipelinesAsCode` 操作数并不会作为默认 `TektonConfig` 配置的一部分自动实例化。当创建了 `pac` 操作数并且其安装程序集卡住时，删除这些安装程序集可以让 operator 重新创建它们并重新协调组件到就绪状态。

## 解决方案

根据卡住的情况是通用的（一个无法被其所有者删除最终处理器的安装程序集）还是特定于组件的（operator 对一个组件的协调循环失败），有两条恢复路径适用。

**强制删除卡住的 `TektonInstallerSet` 最终处理器。** 当一个 `TektonInstallerSet` 被标记为删除，但拥有该组件的控制器无法删除其最终处理器时，该资源将保持 `deletionTimestamp` 设置，并且有一个最终处理器条目 `tektoninstallersets.operator.tekton.dev`。将最终处理器列表修补为 `null` 会释放 API 服务器端的删除：

```bash
kubectl patch tektoninstallerset <name> \
  --type=merge -p '{"metadata":{"finalizers":null}}'
```

在运行的 operator 上，最终处理器模式正是这样 — 一个条目，控制器通常会在干净删除时自行删除；当控制器无法执行时，`null` 修补是手动覆盖。

**重新协调卡住的 Pipelines-as-Code 组件。** 当失败的组件是 Pipelines-as-Code 时，列出属于 `pac` 操作数的 `TektonInstallerSet`（它们的名称以组件为前缀，例如 `openshiftpipelinesascode-main-deployment-*`、`openshiftpipelinesascode-main-static-*`、`openshiftpipelinesascode-post-*`）并删除它们；operator 的组件控制器会从其嵌入的清单中重新创建它们，组件返回到就绪状态：

```bash
kubectl get tektoninstallerset \
  -l operator.tekton.dev/created-by=OpenShiftPipelinesAsCode
kubectl delete tektoninstallerset <pac-installerset-names>
```

如果任何删除操作卡住，请应用上述最终处理器-null 修补。安装程序集重新创建后，`TektonConfig` 一旦 `ComponentsReady` 反转回 `READY=True`，就会恢复，最初导致此问题的诊断 — `kubectl get tektonconfig` — 应该显示该行没有 `Components not in ready state` 原因。

## 诊断步骤

检查 `TektonConfig` 的整体健康状况和失败组件名称：

```bash
kubectl get tektonconfig
```

`READY` 列是整体 `Ready` 条件；当 `READY=False` 时，`REASON` 列携带第一个失败组件的名称和消息（例如 `OpenShiftPipelinesAsCode: reconcile again and proceed`）。

要获取完整的条件细分 — `ComponentsReady`、`PreInstall`、`PreUpgrade`、`PostInstall`、`PostUpgrade`、`Ready` — 直接读取 `TektonConfig.status.conditions`：

```bash
kubectl get tektonconfig config -o jsonpath='{.status.conditions}' | jq .
```

`ComponentsReady` 为 `False` 将故障定位到一个特定的组件安装程序集。

列出安装程序集并检查支持失败组件的那个：

```bash
kubectl get tektoninstallerset
kubectl describe tektoninstallerset <name>
```

查找 `metadata.deletionTimestamp`（资源卡在终止状态）和单个 `tektoninstallersets.operator.tekton.dev` 最终处理器条目 — 该组合就是 `--type=merge -p '{"metadata":{"finalizers":null}}'` 修补旨在清除的内容。

当失败组件是 Pipelines-as-Code 时，还要确认 `OpenShiftPipelinesAsCode` 操作数存在并检查其安装程序集：

```bash
kubectl get openshiftpipelinesascodes
kubectl get tektoninstallerset \
  -l operator.tekton.dev/created-by=OpenShiftPipelinesAsCode
```

如果 `openshiftpipelinesascodes` 返回 `No resources found`，则 `pac` 组件从未在此集群上实例化，`OpenShiftPipelinesAsCode: reconcile again and proceed` 症状只能在创建操作数后出现 — operator 在平台安装时提供 CRD，但不会在默认 `TektonConfig` 配置下创建操作数。
