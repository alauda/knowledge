---
kind:
  - BestPractices
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500205
sourceSHA: 89da82857641be4d46abccce62a41e64cc69bcd8c5929c1ef6f2457f5a079080
---

# 限制 ACP 上 TokenReview 和 SubjectAccessReview API 的创建权限

## 问题

在 Alauda 容器平台 v4.3.13（Kubernetes v1.34.5）上，三个 Kubernetes 审核 API — `tokenreviews.authentication.k8s.io`、`subjectaccessreviews.authorization.k8s.io` 和 `localsubjectaccessreviews.authorization.k8s.io` — 由 kube-apiserver 原样提供。`TokenReview` 是集群范围内的仅创建 API，用于验证任意的承载令牌与集群的身份验证器；它是 `authentication.k8s.io/v1` 中唯一执行任意令牌验证的 API（其兄弟 `SelfSubjectReview` 仅反映调用者的自身身份）。`SubjectAccessReview` 是集群范围的，而 `LocalSubjectAccessReview` 是命名空间范围的；两者都允许调用者询问“主体 U 是否可以在资源 R 上执行动词 V？”并且两者都与更安全的 `selfsubjectaccessreviews` / `selfsubjectrulesreviews` 自我专用变体一起提供。

`system:authenticated` 虚拟组由 kube-apiserver 附加到每个成功认证的请求，因此每个用户、每个 ServiceAccount 和每个对集群进行身份验证的系统组件都是该组的成员。任何授予 `system:authenticated` 在审核 API 上的 `create` 的 ClusterRoleBinding，因此将该能力授予集群信任的每个身份，这是本文所讨论的安全态势。

## 根本原因

将 `create` 授予 `tokenreviews` 给 `system:authenticated` 允许任何经过身份验证的身份通过 TokenReview API 验证任意的承载令牌，这是集群中唯一的任意令牌验证器。将 `create` 授予 `subjectaccessreviews` 给 `system:authenticated` 允许任何经过身份验证的身份探测集群范围内的授权决策，而将 `create` 授予 `localsubjectaccessreviews` 则将相同的探测扩展到各个命名空间。任何一种授予都通过允许任何经过身份验证的身份枚举哪些主体可以执行哪些操作而暴露了集群的授权边界，而同样的侦察表面让攻击者能够识别具有提升权限的 ServiceAccounts 或用户，并相应地计划横向移动或权限提升。

同样的暴露也可以通过第二条路径到达：聚合到默认的 `admin` ClusterRole。`admin` ClusterRole 由 kube-apiserver 启动（标签 `kubernetes.io/bootstrapping=rbac-defaults`）并携带一个 `aggregationRule`，其 `clusterRoleSelectors` 匹配标签 `rbac.authorization.k8s.io/aggregate-to-admin=true`；任何带有该标签的 ClusterRole 的规则都会自动折叠到 `admin` 中。`admin` ClusterRole 旨在进行命名空间范围的资源管理，并不打算作为集群范围的安全审查角色，因此将审核 API 聚合到其中将把这些能力授予在任何命名空间中持有 `admin` 的每个主体。

## 解决方案

将 `tokenreviews` / `subjectaccessreviews` / `localsubjectaccessreviews` 的 `create` 限制为系统级组件和受信任的控制器；不要将这些动词绑定到 `system:authenticated`，也不要将它们聚合到默认的 `admin` ClusterRole。在 ACP v4.3.13 中，默认的态势已经符合：没有 11 个绑定到 `system:authenticated` 的 ClusterRoleBindings 授予 `tokenreviews`、`subjectaccessreviews` 或 `localsubjectaccessreviews` 的 `create`；唯一到达 `system:authenticated` 的审核 API 动词是 `selfsubjectaccessreviews` 和 `selfsubjectrulesreviews` 上的 `create`（通过 `system:basic-user`），它们是自我专用的，并且不会透露其他主体的任何信息。

在同一集群中，默认的 `admin` ClusterRole 已经聚合了 `localsubjectaccessreviews` 上的 `create`（通过引导 ClusterRole `system:aggregate-to-admin`，该角色带有 `aggregate-to-admin=true` 标签），而 `tokenreviews`（集群范围）和 `subjectaccessreviews`（集群范围）则没有聚合到 `admin` 中。LSAR 聚合与上游 Kubernetes 默认值匹配，并且按设计是命名空间范围的 — 在命名空间 N 中持有 `admin` 的主体只能询问 `spec.resourceAttributes.namespace` 等于 N 的 LSAR 问题 — 因此它不会像 `admin` 聚合的 SAR 或 TokenReview 规则那样提供集群范围的侦察。

集群中携带审核 API 规则的 28 个 ClusterRoles 都是引导角色（`system:*` 和聚合提供的 `admin`）或范围操作角色（例如 `capi-*`、`cdi-*`、`cert-manager-*`、`kubevirt-*`）；它们都没有绑定到 `system:authenticated`，因此默认保持推荐的态势。通过拒绝添加授予 `system:authenticated` 在三个审核 API 上的 `create` 的新 ClusterRoleBindings，以及拒绝将 `rbac.authorization.k8s.io/aggregate-to-admin=true` 标签附加到任何包含 `tokenreviews/create` 或 `subjectaccessreviews/create` 规则的 ClusterRole 来保持这一态势。

## 诊断步骤

列举引用 `system:authenticated` 组的 ClusterRoleBindings，以便操作员可以查看每个经过身份验证的身份在集群范围内绑定的每个 ClusterRole：

```bash
kubectl get clusterrolebinding -o wide | grep system:authenticated
```

在 ACP v4.3.13 中，该命令返回 11 个默认的 ClusterRoleBindings — 上游 Kubernetes 集合（`system:basic-user`、`system:discovery`、`system:public-info-viewer`）加上 ACP、KubeVirt 和 CDI 附加组件（`cpaas-*`、`productentry`、`cdi.kubevirt.io:config-reader`、`kubevirt.io:*`）；该诊断是通用 Kubernetes，并且在 ACP 上保持不变。

检查审核 API 是否已聚合到默认的 `admin` ClusterRole：

```bash
kubectl get clusterrole admin -o yaml | grep -E 'tokenreviews|subjectaccessreviews'
```

在 ACP v4.3.13 中，`admin` 的有效规则仅包括 `{authorization.k8s.io, [localsubjectaccessreviews], [create]}` — `tokenreviews` 和 `subjectaccessreviews` 没有聚合到 `admin` 中，这与推荐的态势相匹配。

列出每个授予访问审核资源的规则的 ClusterRole，以便任何允许其创建的角色在一次操作中显现出来：

```bash
kubectl get clusterroles -o yaml | grep -E 'TokenReview|SubjectAccessReview|LocalSubjectAccessReview'
```

在 ACP v4.3.13 中，此 grep 的枚举形式返回 28 个携带审核 API 规则的 ClusterRoles；所有 28 个都是引导角色或范围操作角色，并且没有绑定到 `system:authenticated`，因此诊断形状可移植到 ACP，并确认集群默认符合推荐的态势。
