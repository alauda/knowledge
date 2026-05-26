---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500150
sourceSHA: 012ca691148dd7d51adac05421cba89bc2cc4b7e7a4ef712af9becf1791240ba
---

# 创建角色以管理 ACP 上的 InstallPlan 审批

## 问题

在 Alauda Container Platform（kube `v1.34.5`，`marketplace` chart `v4.3.7` 在 `cpaas-system` 中），Operator Lifecycle Manager v0 为每个 `Subscription` 在其自身的目标命名空间中发出一个 `InstallPlan`。当 `Subscription` 配置为 `spec.installPlanApproval: Manual` 时，OLM 会在待处理状态下创建 `InstallPlan`，并在应用捆绑的 CSV 之前等待明确的审批。集群管理员通常需要将此审批步骤委派给非集群管理员的主体，范围限制在单个 operator 的目标命名空间内，而不授予更广泛的集群 RBAC。由于 `installplans.operators.coreos.com`（v1alpha1）是一个命名空间资源，并且该集群上的 InstallPlans 被观察到分布在已安装的 Subscriptions 的目标命名空间中（例如 `argocd`、`kubevirt`、`istio-system`、`acp-storage`、`konveyor-tackle`、`nativestor-system`），所需的权限可以表示为命名空间的 `Role` 而不是 `ClusterRole` \[ev:c1]。

## 根本原因

该平台上的 OLM `InstallPlan` CRD 注册了一组标准的 Kubernetes 动词 — `get`、`list`、`watch`、`create`、`update`、`patch`、`delete`、`deletecollection` — 并且不暴露单独的 `approve` 子资源。因此，待处理的 `InstallPlan` 的审批是通过变更对象来执行的：在现有的 `InstallPlan` 资源上设置 `spec.approved=true`，然后 OLM 观察并使用该变更继续进行 CSV 安装。在该集群上调和的真实 `InstallPlan`（例如 `install-g2nzm` 在 `kubevirt` 命名空间中）显示出一旦持有适当 RBAC 的用户执行了该补丁后，结果为 `approval=Manual` / `approved=true` 状态 \[ev:c2_a]。授权变更的 RBAC 动词是 `patch`，适用于 `operators.coreos.com` API 组中的 `installplans`；在 `Role` 中列出 `approve` 以及 `patch` 被 API 服务器接受，但不是该 CRD 上的操作动词 \[ev:c2_b]。

## 解决方案

创建一个命名空间的 `Role`，授予 install-plan-approval 权限，然后通过 `RoleBinding` 将其绑定到应持有该权限的组，两个都限制在 operator 的目标命名空间内。该 Role 授予可见性的读取动词（`get`、`list`、`watch`）以及 `patch`（控制审批变更的操作动词）；同时列出 `approve` 是无害的，并且与规范的上游配方相匹配。以下 `Role` 的服务器端干运行在该集群的 API 服务器上被接受 \[ev:c3]：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: installplan-approver
  namespace: <operator-target-namespace>
rules:
  - apiGroups: ["operators.coreos.com"]
    resources: ["installplans"]
    verbs: ["get", "list", "watch", "approve", "patch"]
```

将 Role 绑定到同一命名空间中的审批组，使用标准的 `RoleBinding`，其 `subjects[].kind` 为 `Group`；该组的成员仅在该命名空间内持有 install-plan-approval 权限。以下 `RoleBinding` 的形式在集群的 API 服务器下通过服务器端干运行被接受，组的成员资格由集群的身份提供者集成提供 \[ev:c4]：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: installplan-approver
  namespace: <operator-target-namespace>
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: <approver-group-name>
roleRef:
  kind: Role
  apiGroup: rbac.authorization.k8s.io
  name: installplan-approver
```

使用 `kubectl` 在目标命名空间中应用这两个清单 \[ev:c4]：

```bash
kubectl apply -f role.yaml
kubectl apply -f rolebinding.yaml
```

绑定组的成员可以通过在该命名空间中的 `InstallPlan` 对象上补丁 `spec.approved=true` 来批准待处理的 `InstallPlan` \[ev:c2_a]：

```bash
kubectl -n <operator-target-namespace> patch installplan <installplan-name> \
  --type merge \
  -p '{"spec":{"approved":true}}'
```

## 诊断步骤

在 operator 的目标命名空间中列出待处理的 `InstallPlan` 对象，以确认资源的命名空间范围，并识别将被批准的对象 \[ev:c1]：

```bash
kubectl -n <operator-target-namespace> get installplans.operators.coreos.com
```

检查 `installplans` 资源上注册的动词，以确认 `patch` 是控制该集群上审批的动词，并且没有暴露单独的 `approve` 子资源 \[ev:c2_b]：

```bash
kubectl api-resources --api-group=operators.coreos.com -o wide | grep installplans
```

在绑定组后，请求成员执行补丁，读取 `InstallPlan` 并确认 `spec.approval=Manual` 以及 `spec.approved=true`，这是 OLM 观察到的状态，以继续进行 CSV 安装 \[ev:c2_a]：

```bash
kubectl -n <operator-target-namespace> get installplan <installplan-name> \
  -o jsonpath='{.spec.approval}{"\t"}{.spec.approved}{"\n"}'
```
