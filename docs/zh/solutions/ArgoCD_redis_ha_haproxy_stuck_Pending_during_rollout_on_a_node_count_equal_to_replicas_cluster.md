---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500231
sourceSHA: 16c6f63826f9b4d7f2aa072e93d787893437799e5afb17345942a98bc64ff36e
---

# ArgoCD redis-ha-haproxy 在节点数等于副本数的集群中在滚动更新期间卡在 Pending 状态

## 问题

在 Alauda 容器平台上，`argocd` ModulePlugin 在 `argocd` 命名空间中应用一个名为 `argocd-gitops` 的标准 ArgoCD CR（图表 `chart-argocd-installer v4.2.0`）。当 CR 的 `.spec.ha.enabled=true` 时，操作员会生成一个 `argocd-gitops-redis-ha-haproxy` 部署，副本数为 `3`，前端是 `argocd-gitops-redis-ha-server` redis StatefulSet。在一个工作节点数等于副本数的集群中，该部署的滚动更新期间，观察到一个新创建的 surge pod 处于 `0/1 Pending` 状态，旁边有三个 `Running` 副本，遵循上游 `<deployment>-<rs-hash>-<suffix>` 命名方案。

## 根本原因

`argocd-gitops-redis-ha-haproxy` pod 模板设置了一个硬性主机名分布规则：`podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution`，其 `labelSelector.matchLabels.app.kubernetes.io/name=argocd-gitops-redis-ha-haproxy` 的 `topologyKey: kubernetes.io/hostname`，加上一个软性 `preferredDuringSchedulingIgnoredDuringExecution` 条件，`failure-domain.beta.kubernetes.io/zone` 权重为 100；硬性主机名条件强制每个副本分配到不同的节点。该部署使用 `strategy.type: RollingUpdate`，并设置 `rollingUpdate.maxSurge: 25%` 和 `rollingUpdate.maxUnavailable: 25%`。

Kubernetes 部署合同对于 `maxSurge` 的计算是通过向上取整来获得绝对数值，因此 3 个副本的 25% 允许在任何现有副本被拆除之前创建 1 个额外的 surge pod。所需的 pod 反亲和性合同规定，如果在调度时未满足反亲和性要求，则该 pod 将无法调度到节点上。由于三个现有副本已经通过 `kubernetes.io/hostname` 条件固定在每个节点上，因此携带相同 `app.kubernetes.io/name` 标签的第 4 个 surge pod 没有满足所需条件的节点可供调度，因此保持 Pending 状态，直到滚动更新中止或第四个节点变得可用。

## 解决方案

这种冲突是当 `.spec.ha.enabled=true` 与工作节点数等于 redis-ha-haproxy 副本数的集群交互时，部署形状的一个特性。有两种操作员表面上的解决方法可以避免此问题；两者都需要编辑 `argocd` 命名空间中的 `argocd-gitops` ArgoCD CR（haproxy 容器镜像 `build-harbor.alauda.cn/3rdparty/haproxy:2.0.34-alpine-2`，图表 `chart-argocd-installer v4.2.0`），并让操作员将更改协调到 `argocd-gitops-redis-ha-haproxy` 部署中。

选项 A — 在 ArgoCD CR 上禁用 HA。这将合并 3 副本的 redis-ha-haproxy 部署，从而避免 surge 与反亲和性冲突的再次发生。设置 `.spec.ha.enabled=false`，并让操作员拆除 redis-ha-haproxy 部署和 redis-ha StatefulSet：

```bash
kubectl patch argocd -n argocd argocd-gitops \
 --type merge \
 -p '{"spec":{"ha":{"enabled":false}}}'
```

选项 B — 覆盖 redis-ha-haproxy pod 模板的反亲和性，使硬性主机名条件变为软性。将所需条件放宽为 `preferredDuringSchedulingIgnoredDuringExecution` 规则，保持分布偏好，但允许 surge pod 在已经托管匹配副本的节点上调度，从而打破死锁。覆盖必须通过 `argocd-gitops` ArgoCD CR 的 `.spec.ha` 块（该块通过操作员协调链拥有 redis-ha-haproxy 部署）来表达，而不是直接编辑部署，因为操作员管理的部署将在下一个协调循环中被还原。

在任一更改后，监视部署直到 surge pod 清除：

```bash
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy
kubectl get pod -n argocd -l app.kubernetes.io/name=argocd-gitops-redis-ha-haproxy -o wide
```

## 诊断步骤

确认操作员从 `argocd-gitops` 渲染的部署形状和副本数：

```bash
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy \
 -o jsonpath='{.spec.replicas}{"\n"}'
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy \
 -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}{"\n"}'
```

查看部署的滚动更新策略 — `maxSurge: 25%` 加上 `maxUnavailable: 25%` 是驱动 3 副本部署上 1 个额外 pod surge 数学的形状：

```bash
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy \
 -o jsonpath='{.spec.strategy}{"\n"}'
```

查看 pod 模板的亲和性，以确认所需的 `kubernetes.io/hostname` 条件携带 `labelSelector.matchLabels.app.kubernetes.io/name=argocd-gitops-redis-ha-haproxy`（自身 ReplicaSet 匹配是使 surge pod 无法调度的原因，因为每个节点已经托管了一个副本）：

```bash
kubectl get deploy -n argocd argocd-gitops-redis-ha-haproxy \
 -o jsonpath='{.spec.template.spec.affinity.podAntiAffinity}{"\n"}'
```

列出 haproxy pods 及其节点位置；冲突的前提是在每个工作节点上都有一个匹配的 pod — 即没有节点可以托管第 4 个副本：

```bash
kubectl get pod -n argocd \
 -l app.kubernetes.io/name=argocd-gitops-redis-ha-haproxy \
 -o wide
```

如果存在 Pending pod，`kubectl describe pod` 将显示所需条件的标准调度事件 — 节点数和匹配的 pods 列举 — 这与未满足的所需反亲和性条件保持一致，导致 pod 无法在每个节点上调度：

```bash
kubectl describe pod -n argocd <pending-haproxy-pod-name>
```
