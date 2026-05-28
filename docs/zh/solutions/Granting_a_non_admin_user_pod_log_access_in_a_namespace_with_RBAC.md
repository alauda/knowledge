---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500332
sourceSHA: d81db45c731660c01260da600b878f62f9c5c751a180697fc1778e858b023b61
---

# 在命名空间中通过 RBAC 授予非管理员用户 Pod 日志访问权限

## 问题

在 Alauda Container Platform (kube-apiserver v1.34.5) 中，非管理员用户需要在命名空间中读取容器日志，但在其身份被授予正确的 Kubernetes RBAC 权限之前，无法执行此操作。读取容器日志的权限由核心 API 组的 `pods/log` 子资源上的 `get` 动词控制（`pods` 是命名空间的 `v1` 资源），因此没有该动词的身份无法获取日志。

## 根本原因

日志读取是一种独立的、子资源范围的权限，而不是能够列出 Pods 的副作用。检索容器输出的操作是核心 API 组中 `pods/log` 的 `get`。在 RBAC 模型下，访问权限默认拒绝并且是累加的：只有通过授予 `pods/log` 上的 `get` 的绑定，主体才能获得日志访问权限，因此没有此类授予的身份将无法获得日志访问权限。

## 解决方案

有两条实际路径，可以在便利性与最小权限之间进行权衡。**快速选项 — 绑定内置的 `view` ClusterRole。** bootstrap-default 的 `view` ClusterRole 已经具有相关权限：它在核心 API 组的 `pods/log` 子资源上授予 `get`、`list` 和 `watch`，以及其他读取动词（该角色被标记为 Kubernetes RBAC 启动默认）。因此，授予非管理员用户日志访问权限实际上简化为将此现有 ClusterRole 绑定到目标命名空间中的该用户。然而，请注意，`view` 授予广泛的命名空间读取访问权限 — 在广泛的核心读取资源（事件、限制范围、pods/status、资源配额等）上具有 `get`/`list`/`watch` 权限，而不仅仅是日志访问。将 `view` 绑定以读取日志会过度授予几乎所有命名空间资源的读取权限。

**最小权限替代方案 — 一个最小化的自定义 Role。** 当日志查看是唯一的意图时，定义一个命名空间 Role，仅授予 `pods` 上的 `get`/`list` 和经过验证的 `pods/log` 子资源上的 `get`，然后进行绑定。这将授予日志查看所需的权限，而不是 `view` 所暴露的广泛读取权限。为了简洁起见，本节其余部分使用 `view` 绑定；要应用最小权限形式，请替换指向最小 Role 的 `roleRef` 类型为 `Role`。

RoleBinding 将引用的 ClusterRole 的权限授予其主体，范围限制在 RoleBinding 自身的命名空间内 — ClusterRole 提供权限集，而 RoleBinding 限制其适用范围。清单遵循标准的 RBAC 结构：`apiVersion: rbac.authorization.k8s.io/v1`，`kind: RoleBinding`，一个类型为 `ClusterRole` 的 `roleRef` 通过名称引用全局角色，以及一个类型为 `User` 的 `subjects` 条目（`name` 是必需的，用户的 `apiGroup` 是 `rbac.authorization.k8s.io`）。

在需要日志访问的命名空间中创建 RoleBinding，引用 `view` ClusterRole 和目标用户：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: log-viewer
  namespace: team-a
subjects:
- kind: User
  name: jane
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

使用 kubectl 应用它：

```bash
kubectl apply -f log-viewer-rolebinding.yaml
```

由于 RoleBinding 的授予是命名空间范围的，因此此绑定仅授权用户在其所在命名空间中读取 Pod 日志；需要跨多个命名空间访问日志的用户需要在每个命名空间中创建单独的 RoleBinding。相同的 RoleBinding 到 ClusterRole 的模式是如何在集群内将 ClusterRole 的作用域限制到单个命名空间。

## 诊断步骤

确认绑定存在并在目标命名空间中引用预期的 ClusterRole 和主体：

```bash
kubectl get rolebinding -n team-a log-viewer -o yaml
```

输出应显示 `roleRef.kind: ClusterRole`，`name: view` 和预期的类型为 `User` 的 `subjects` 条目，所有内容均在创建绑定的命名空间内。要将授权扩展到其他命名空间，请在每个命名空间中重复 RoleBinding，因为授权不会从单个绑定跨越命名空间。
