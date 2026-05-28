---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500372
sourceSHA: dace1af5253a5db9646e51b1eaf7b5d8b909121287d3198c3c7b127bebc68882
---

# 使用 Kubernetes API 和 jq 在 ACP 上将 RoleBindings 扁平化为用户与角色报告

## 问题

在 Alauda Container Platform (kube-apiserver `v1.34.5`, ACP v4.3.x) 上，审计员和平台管理员经常需要一个扁平的每个主体报告，将每个用户、组或服务账户与其绑定的角色或集群角色配对。原生的 `kubectl get rolebindings` 列表无法生成该连接：它为每个 RoleBinding 打印一行，并将绑定的所有主体聚合到共享的 `USERS` / `GROUPS` / `SERVICEACCOUNTS` 列中，因此无法在一次操作中回答“这个主体在所有命名空间中持有什么角色”。

解决方法是直接从 ACP 的 Kubernetes API 读取 RBAC 对象，并使用 `jq` 扁平化 `.subjects[]` 数组，利用 RBAC API (`rbac.authorization.k8s.io/v1`) 在 ACP 上保持不变的事实。

## 根本原因

从 `kubectl get` 获取扁平报告的形状与 RoleBinding 对象本身固有：每个 RoleBinding 都携带一个 `.subjects[]` 数组，其中每个元素为 `{kind, name}`（对于 `kind: ServiceAccount` 还包含一个额外的 `namespace`），以及一个兄弟属性 `.roleRef.name` 命名单个绑定的角色或集群角色。因此，具有三个主体的绑定表示三个（主体，角色）对合并为一个对象，任何每个主体视图必须在客户端扩展该数组。

## 解决方案

查询 ACP 上的 RBAC v1 API — 同样的 `rbac.authorization.k8s.io/v1` 组/版本 Kubernetes 在上游提供 — 并使用 `jq` 和 `column` 进行后处理 JSON。

Bearer 令牌通过 HTTP `Authorization` 头以 `Authorization: Bearer <token>` 的形式提供。从活动的 kubeconfig 中获取 API 服务器 URL，并为审计身份生成一个 ServiceAccount 令牌：

```bash
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
TOKEN=$(kubectl create token <service-account> -n <sa-namespace>)
```

审计 ServiceAccount 必须持有一个 ClusterRoleBinding，授予 `namespaces` 和 `rolebindings`/`clusterrolebindings` 在 `rbac.authorization.k8s.io` 上的集群范围 `get,list` 权限；没有该 RBAC，下面的 API 调用将返回 HTTP 403 `Status` 对象，而不是预期的列表类型。在一个代表性的 ACP 集群中，示例服务器解析为 `https://192.168.135.152/kubernetes/global` 形式的 URL，并且在该端点接受相同的 Bearer 头模式。

对于单个命名空间，命名空间范围的列表端点返回一个带有 `.items[]` 数组的 `RoleBindingList`：

```bash
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER}/apis/rbac.authorization.k8s.io/v1/namespaces/kube-system/rolebindings"
```

对于集群范围的视图，去掉命名空间部分；返回相同类型的 (`RoleBindingList`)，`.items[]` 包含来自每个命名空间的 RoleBindings 的响应：

```bash
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER}/apis/rbac.authorization.k8s.io/v1/rolebindings"
```

使用 `jq` 将结果扁平化为每个（主体，角色）对的一行。该表达式将每个主体与其绑定的 `roleRef.name` 和绑定的命名空间一起投影，当 `.metadata.namespace` 缺失时（如集群范围的 RoleBindings 返回时），回退到字面字符串 `cluster-scope`：

```bash
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER}/apis/rbac.authorization.k8s.io/v1/rolebindings" \
| jq -r '.items[] as $rb
         | $rb.subjects[]?
         | "\(.kind)\t\(.name)\t\($rb.roleRef.name)\t\($rb.metadata.namespace // "cluster-scope")"' \
| column -t -s $'\t'
```

`jq` 输出为制表符分隔，每个（主体，角色）对一行，列包括 `Kind`、`Name`、`roleRef.name` 和绑定的命名空间。通过 `column -t -s $'\t'` 管道对齐行，形成一个无标题、列对齐的表格，便于在终端中扫描。

在扁平化报告中出现的主体 `kind` 值来自上游 Kubernetes RBAC 模式定义的三种类型 — `User`、`Group` 和 `ServiceAccount` — 因此相同的投影适用于绑定目标是人类身份、组或工作负载身份的情况。

## 诊断步骤

在运行完整的扁平化之前，对 `/api/v1/namespaces` 发出轻量级探测，以确认 Bearer 令牌、服务器 URL 和审计身份的 RBAC 正确连接：

```bash
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER}/api/v1/namespaces" \
| jq '.kind, (.items | length)'
```

通过 `.kind` 解释响应。对于一个 ServiceAccount 绑定到授予 `list` 权限的 ClusterRole 的令牌，响应是一个 `NamespaceList`，其 `.items[]` 长度为正，且相同的 `Authorization: Bearer` 头模式将在上述 `/apis/rbac.authorization.k8s.io/v1/...` 端点上成功。如果响应为 `kind: Status`，且 `code: 403` 和 `reason: Forbidden`，则意味着令牌格式正确并到达 API 服务器，但审计 ServiceAccount 缺少所需的集群范围 `list` 权限 — 附加所需的 ClusterRoleBinding，并重试。

如果 rolebindings 端点对于应该包含绑定的命名空间返回空的 `.items[]`，请重复调用而不带命名空间部分，以检索集群范围的列表，并验证预期的绑定是否存在于集群中的某处。如果相同的端点返回 `Status` 对象，且 `code: 403`，则令牌缺少对 `rolebindings.rbac.authorization.k8s.io` 的集群范围 `list` 权限；在重新运行扁平化之前，授予审计 ServiceAccount 该权限。
