---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500602
sourceSHA: 468af0be0be9b221cbd54db87eb2cc59f5df1f73eee9e4dfab3f6aa795952687
---

# Argo CD 应用程序在 ACP 上因注释跟踪冲突而漂移

## 问题

在 Alauda 容器平台上，Argo CD 实例通过 `argocd` ModulePlugin 安装，并作为上游 `argocds.argoproj.io` CR `argocd-gitops` 显示在 `argocd` 命名空间中，`applications.argoproj.io` 由同一 operator 进行协调；平台的 `argocd-cm` ConfigMap 也位于该命名空间中，并且是 operator 跟踪的（标签 `operator.argoproj.io/tracked-by=argocd`）。在安装或升级到 chart `chart-argocd-installer` v4.2.0（应用控制器镜像 `argocd:v3.1.9-2`）后，管理员观察到之前健康的 `Application` 资源开始报告 `OutOfSync`，尽管 Git 中的清单没有变化，并且对目标对象的 `kubectl diff` 仅显示其他控制器在集群上所做的标签添加。

## 根本原因

Argo CD 支持两种资源跟踪方法。基于标签的跟踪仅比较 `app.kubernetes.io/instance` 标签以确定所有权，并忽略对实时对象上其他标签的更改。相比之下，基于注释的跟踪使用 `argocd.argoproj.io/tracking-id` 注释作为所有权标记，并计算与整个资源清单的漂移，包括完整的标签和元数据集。在基于注释的跟踪下，当集群上的其他控制器 — OLM、cert-manager、入站 webhook 或拥有相同目标对象的 operators — 在部署后添加或修改标签时，实时清单不再与 Git 中的期望清单匹配，拥有的 `Application` 被报告为 `OutOfSync`，即使该更改并非由 Argo CD 用户发起。

在此 ACP 安装中，实时的 `argocd-cm` ConfigMap 同时携带这两个键。对该集群的 `argocd-gitops` 实例的 `argocd-cm.data` 进行检查显示同时存在 `application.resourceTrackingMethod: annotation` 和 `application.instanceLabelKey: app.kubernetes.io/instance`。在两个键都设置的情况下，Argo CD 被要求通过注释跟踪资源，同时又被告知 `app.kubernetes.io/instance` 标签键携带实例身份；即使在它们上应用了跟踪注释，资源仍然继续显示为 `OutOfSync`。ACP 上的 `argocd-cm` ConfigMap 是 operator 所有 — 其 `ownerReferences` 指向 `ArgoCD/argocd-gitops` CR，且 `controller=true` 和 `blockOwnerDeletion=true`，因此 operator 从 CR 中协调其 `.data`；直接执行 `kubectl edit configmap argocd-cm` 删除 `application.instanceLabelKey` 的操作将在下一个协调循环中被还原，除非 CR 或 chart 源也被更新。

## 解决方案

有两条路径汇聚到一个稳定状态；选择其中一条并通过 `argocd-gitops` CR 或 chart 值应用，以便更改在 operator 协调 `argocd-cm` 时得以保留。

路径 A — 保持基于注释的跟踪并移除冲突的 `instanceLabelKey` 覆盖。在此安装中，`argocd-gitops` CR 上的 `spec.extraConfig` 为空 (`{}`)，而 `application.instanceLabelKey` 覆盖则存在于 `argocd-cm.data` 中，而不是在 `spec.extraConfig` 下。持久的修复是确保在下一个协调中，chart 值或 `spec.extraConfig` 不会重新注入 `application.instanceLabelKey` 到 `argocd-cm` 中；一旦该键不再出现在 `argocd-cm.data` 中，使用 `ApplyOutOfSyncOnly=true` 同步选项同步受影响的应用程序，以便 Argo CD 仅逐步将跟踪注释添加到当前标记为 `OutOfSync` 的资源，而不是重新部署整个应用程序。

`ApplyOutOfSyncOnly=true` 同步选项在 `Application.spec.syncPolicy.syncOptions` 列表中声明（这是一个应用控制器识别的自由格式 `[]string`），并使控制器仅对当前 `OutOfSync` 的资源采取行动，这样可以在不完全重新部署应用程序健康资源的情况下添加跟踪注释：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  syncPolicy:
    syncOptions:
      - ApplyOutOfSyncOnly=true
```

路径 B — 在 CR 上恢复到基于标签的跟踪。在 `argocd-gitops` `ArgoCD` CR 上设置 `spec.resourceTrackingMethod: label`（当前 chart 将该字段设置为 `annotation`）；在基于标签的跟踪下，控制器仅比较 `app.kubernetes.io/instance`，并忽略其他控制器所做的标签添加：

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: argocd-gitops
  namespace: argocd
spec:
  resourceTrackingMethod: label
```

在任一路径中，持久化更改到 CR / chart 层，而不是直接编辑 `argocd-cm` — ConfigMap 是从 `argocd-gitops` CR 中协调的，因此直接编辑 ConfigMap 的操作会被还原。

## 诊断步骤

确认平台 `argocd-cm` ConfigMap 上的实时跟踪配置。相同的上游 YAML 键（`application.resourceTrackingMethod`，`application.instanceLabelKey`）在 ACP 的 ConfigMap 的 `.data` 顶层下出现，因此在替换 ACP 命名空间后，标准的 grep 语法可以逐字使用：

```bash
kubectl get configmap argocd-cm -n argocd -o yaml | grep resourceTrackingMethod
kubectl get configmap argocd-cm -n argocd -o yaml | grep instanceLabelKey
```

如果响应中包含 `application.resourceTrackingMethod: annotation` 和 `application.instanceLabelKey: app.kubernetes.io/instance`，则与冲突形状匹配，并表明漂移是由默认配置冲突驱动的，而不是由 Git 中的真实更改驱动。在尝试直接编辑 ConfigMap 之前，交叉检查所有权 — 如果 `argocd-cm` 上的 `metadata.ownerReferences` 列出 `ArgoCD/argocd-gitops` 且 `controller=true`，则持久的修复必须在 CR 或 chart 值上进行，而不是在 ConfigMap 本身上进行。
