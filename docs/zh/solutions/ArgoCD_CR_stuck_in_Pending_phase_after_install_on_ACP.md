---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500710
sourceSHA: e51706680062f3fa71d395543e2d086672d25ea8e4513384e2c1838137ced6fe
---

# ArgoCD CR 安装后卡在 ACP 的 Pending 阶段

## 问题

在 Alauda 容器平台上，`argocd` ModulePlugin（目录 `gitops`）将一个名为 `argocd-gitops` 的 `ArgoCD` 自定义资源部署到 `argocd` 命名空间，由 `argocd-operator-controller-manager` 进行协调（镜像 `build-harbor.alauda.cn/3rdparty/argoprojlabs/argocd-operator:v4.2.0`，未分叉的上游 argoproj-labs 操作员）。安装后，读取 CR 有时会显示 `.status.phase` 卡在 `Pending`，而每个组件的状态字段（`applicationController`、`applicationSetController`、`server`、`repo`、`redis`、`sso`）均报告为 `Running`，且 `.status.conditions[]` 包含 `type: Reconciled / status: "True" / reason: Success` 条目。

在 `argoproj.io/v1beta1` 提供的 CR 中，正好暴露了这种字段的混合：一个聚合的 `.status.phase` 加上每个组件的摘要以及一个 `conditions[]` 数组——在 `argocd-gitops` 实例上实时验证，该 CR 当前读取阶段为 `Available`，所有每个组件字段均为 `Running`，且 `Reconciled=True`。CRD 在独立的 ACP 集群上完全相同（CRD `argocds.argoproj.io`，提供版本 `v1alpha1` + `v1beta1`，`olm.managed=true`），因此字段形状是平台范围的，而非集群特定的。

```bash
kubectl -n argocd get argocd argocd-gitops -o jsonpath='{.status.phase}{"\n"}'
kubectl -n argocd get argocd argocd-gitops -o yaml | sed -n '/^status:/,$p'
```

## 根本原因

`.status.phase` 字段是由操作员计算并在协调期间设置的，而不是直接由实时 Pod 健康状态驱动的。`kubectl explain argocd.status.phase` 将其描述为“ArgoCD 在其生命周期中的简单、高级摘要”，并且只有四个值——`Pending`、`Available`、`Failed`、`Unknown`——显著没有 `Running` 值（`Running` 令牌是每个组件的，而不是每个阶段的）。操作员在每次协调结束时写入该摘要；如果协调与工作负载就绪状态的转换发生竞争，存储的值可能会滞后于现实。一旦所有必需的组件资源准备就绪，下一个协调将阶段切换为 `Available`；然而，在没有触发事件的情况下，暂时不正确的 `Pending` 可能会在 CR 上持续存在，直到操作员再次协调。

每个组件字段和 `.status.conditions[]` 反映了相同的协调时间快照。推论是，聚合阶段为 `Pending` 与每个组件字段为 `Running` 之间的不一致与操作员的记账模型内部一致——这仅意味着最后的摘要写入是在组件达到稳定状态之前进行的，并且没有进一步的协调来刷新它。

## 解决方案

这种表面上的不一致并不影响 Argo CD：工作负载 Pods 是独立协调的，并且无论存储的摘要值如何，都能提供流量，经过验证的实时捕获显示 `argocd-gitops-*` 组件 Pods（`application-controller-0/1`、`applicationset-controller`、`repo-server`、`server`、`redis-ha-*`）均为 `1/1` 或 `2/2` `Running`，而 `argocd-operator-controller-manager` 协调 Pod 本身为 `1/1` `Running`。首先确认组件健康——如果每个组件状态字段均为 `Running`，每个相关的 `argocd-gitops-*` 工作负载 Pod 均处于 `Running` / `Ready`，且 `.status.conditions[]` 包含 `Reconciled=True / reason=Success`，则安装是正常的，陈旧的 `Pending` 是一次协调后的摘要，下一次协调将覆盖它。

要刷新摘要值，可以通过以下任一方式触发 `ArgoCD` CR 的新协调：

重启 `argocd-operator-controller-manager` 部署，以便控制器在启动时重新评估每个被监视的 CR；该控制器是负责 `.status.phase` 写入的，实时镜像是未分叉的上游 argoproj-labs `argocd-operator` v4.2.0，因此重启时的协调语义与上游操作员匹配：

```bash
kubectl -n argocd rollout restart deploy/argocd-operator-controller-manager
```

或者将操作员部署缩减然后再增大：

```bash
kubectl -n argocd scale deploy/argocd-operator-controller-manager --replicas=0
kubectl -n argocd scale deploy/argocd-operator-controller-manager --replicas=1
```

或者，在操作员运行的情况下，对 `ArgoCD` CR 本身应用一个微小的变更——添加或删除标签或注释，或调整并恢复一个无害的字段——以便为该特定对象排队协调；更新注释会增加 `.metadata.generation`，这是 argocd-operator 已经监视的标准控制器运行时事件触发模式：

```bash
kubectl -n argocd annotate argocd argocd-gitops reconcile-nudge=$(date +%s) --overwrite
kubectl -n argocd annotate argocd argocd-gitops reconcile-nudge- --overwrite
```

在协调完成后，重新读取 `.status.phase`；在健康的安装中，所有必需的组件资源都已准备就绪，操作员将根据 CRD 文档的枚举语义用 `Available` 覆盖摘要。

## 诊断步骤

确认 CR 是上游 argoproj.io 形状，控制器是预期的未分叉操作员——两者均通过 CRD 和部署元数据交叉检查，以排除安装了不同的操作员分发。

```bash
kubectl get crd argocds.argoproj.io -o jsonpath='{.spec.versions[*].name}{"\n"}'
kubectl -n argocd get deploy argocd-operator-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
```

一次性读取完整的 `.status` 块和工作负载 Pods；诊断是聚合 `phase`（由操作员计算）与每个组件字段加上 Pod 就绪状态（反映真实工作负载状态）之间的不一致。

```bash
kubectl -n argocd get argocd argocd-gitops -o yaml | sed -n '/^status:/,$p'
kubectl -n argocd get pods -l app.kubernetes.io/part-of=argocd
```

在 ACP 上，健康的稳定状态读取为 `phase: Available`，每个组件字段均为 `Running`（如果在安装时未配置 SSO/Dex，`sso` 字段可以读取为 `Unknown`——这与阶段问题无关，并不是陈旧的 Pending 症状）。如果 `phase` 读取为 `Pending` 而组件为 `Running` 且工作负载 Pods 为 `Ready`，请应用上述任一协调触发步骤；如果 `phase` 读取为 `Failed`，则表示存在实际的协调错误，应从 `.status.conditions[]` 和 `argocd-operator-controller-manager` 容器日志中进行诊断，而不是将其视为表面案例。
