---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500774
sourceSHA: 43e8452227777c579e1109f8e5bb343f85ff0921d95fb2ed4ed18679ebb29e55
---

# 带有通配符 apiGroups 的 RBAC ClusterRole 在资源列表使用合格的 resource.group 字符串时仍然拒绝访问

## 问题

在 Alauda 容器平台（服务器 `v1.34.5-1`，RBAC 服务于 `rbac.authorization.k8s.io/v1`）上，编写的自定义 `ClusterRole` 模拟了标准的通配符角色 — 与用户或 `ServiceAccount` 的 `ClusterRoleBinding` 配对 — 当规则的 `resources` 字段使用合格的 `<resource>.<group>` 字符串而不是裸资源名称时，仍然可能返回 Forbidden。apiserver 授权者会发出形式为 `<resource>.<group> is forbidden: User "<subject>" cannot list resource "<bare-resource>" in API group "<group>" at the cluster scope` 的通用 Forbidden 响应，针对集群范围的资源，以及针对命名空间范围的变体 `... in the namespace "<ns>"`。在同一规则中存在 `apiGroups: ["*"]` 并不能拯救请求，因为资源匹配已经失败。

## 根本原因

嵌入在 `ClusterRole` 中的 `PolicyRule`（组 `rbac.authorization.k8s.io/v1`）有三个独立字段 — `apiGroups`、`resources` 和 `verbs` — 授权者分别将传入请求与每一个字段进行匹配。`apiGroups` 字段包含“包含资源的 APIGroup 的名称”，其中 `"*"` 代表所有 API 组；`resources` 是“此规则适用的资源列表”，其中 `"*"` 代表所有资源；`verbs` 是动词令牌列表，其中 `"*"` 代表所有动词。kube-apiserver 按裸名称索引每个提供的资源，组信息单独包含在 `APIVERSION` 中 — 例如 `kubectl api-resources` 列出 `NAME=servicemonitors APIVERSION=monitoring.coreos.com/v1`；没有资源的字面名称为 `servicemonitors.monitoring.coreos.com`。`resources` 字段是与裸名称进行字面匹配，因此像 `servicemonitors.monitoring.coreos.com` 这样的规则条目永远不等于裸令牌 `servicemonitors`，因此不匹配任何真实资源。对组维度的通配符匹配（`apiGroups: ["*"]`）并不会改变这一点 — 组匹配总是通过，但资源匹配仍然在合格字符串条目上失败，因此规则不提供任何授权。

同样的独立性适用于 `verbs`：如果规则的 `verbs` 字段为 `[""]`（空字符串），则不会授权 `get`/`list`/`watch`/`create`/`update`/`patch`/`delete`/`deletecollection` 这些动词 — 空字符串不是 apiserver 的动词令牌空间的成员，因此 `verbs:[""]` 对其列出的资源不授予任何权限。集群中的真实 `ClusterRole` 规则使用具体的令牌 — 例如 `system:basic-user` 使用 `verbs: [create]`，而标准的通配符角色 `cluster-admin` 使用 `apiGroups: ["*"]` 配对 `resources: ["*"]` 和 `verbs: ["*"]`，从不在 `resources` 中使用合格的 `<resource>.<group>` 字符串。现有平台的 `ClusterRole` 定义遵循相同的结构 — 它们的 `resources` 条目是裸名称（或 `name/subresource`），从不为 `name.group` — 组信息在规则的 `apiGroups` 字段中携带。

## 解决方案

重写规则，使 `resources` 下的每个条目都是裸资源名称，API 组则位于 `apiGroups` 中（可以是字面组名称或 `"*"`）。例如，将以下规则替换为：

```yaml
rules:
- apiGroups:
  - '*'
  resources:
  - servicemonitors.monitoring.coreos.com   # 合格字符串 — 不匹配
  verbs:
  - get
  - list
  - watch
```

替换为以下规则：

```yaml
rules:
- apiGroups:
  - '*'
  resources:
  - servicemonitors                          # 裸资源名称 — 匹配
  verbs:
  - get
  - list
  - watch
```

在裸名称重写后，绑定到修正后的 `ClusterRole` 的新 `ServiceAccount` 可以在集群范围内列出资源 — `kubectl auth can-i list servicemonitors.monitoring.coreos.com` 返回 `yes`，相应的 `kubectl get servicemonitors.monitoring.coreos.com -A` 成功。要将相同的规则限制为单个组，请将 `apiGroups: ["*"]` 替换为显式组名称（此处为 `monitoring.coreos.com`）；资源匹配仍然基于 `resources` 中的裸名称。

如果任何规则包含 `verbs: [""]`，请用绑定所需的具体动词令牌替换空字符串 — `get`、`list`、`watch`、`create`、`update`、`patch`、`delete`、`deletecollection`，或 `"*"` 代表所有动词。带有 `verbs: [""]` 的规则对其列出的资源不授权，因此必须删除或替换它以使绑定生效。

## 诊断步骤

确认集群中 `ClusterRole` CRD 本身的字段语义 — `apiGroups` 是组维度（`"*" `代表所有组），`resources` 是裸名称维度（`"*" `代表所有资源），`verbs` 是动词令牌维度（`"*" `代表所有动词）：

```bash
kubectl explain clusterrole.rules.apiGroups
kubectl explain clusterrole.rules.resources
kubectl explain clusterrole.rules.verbs
```

检查可疑的 `ClusterRole`，查找包含点后跟 API 组（`<resource>.<group>`）的 `resources` 条目。与真实平台的 `ClusterRole`（例如 `cluster-admin`）进行比较，以查看标准的通配符结构（裸 `"*" `，从不使用合格字符串）：

```bash
kubectl get clusterrole <name> -o yaml
kubectl get clusterrole cluster-admin -o yaml
```

确认 apiserver 在其裸名称下注册争议资源，组信息在 `APIVERSION` 中携带；这里的裸令牌是 `resources` 字段必须列出的内容：

```bash
kubectl api-resources -o wide | grep <resource>
```

通过为绑定中指定的 `ServiceAccount` 生成一个绑定令牌，并通过该令牌发出请求，重现作为绑定主体的授权决策，而不更改任何平台 RBAC。裸名称 `resources` 条目将成功，而合格字符串条目将返回用户报告的 Forbidden 消息：

```bash
TOKEN=$(kubectl create token <serviceaccount> -n <namespace> --duration=3600s)
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
kubectl --server="$SERVER" --token="$TOKEN" --insecure-skip-tls-verify get <resource> -A
```

通过 SubjectAccessReview 路径交叉检查同一主体的决策 — 两个 `auth can-i` 的答案必须与实时请求（以及彼此）一致，以确保规则形状正确：

```bash
kubectl --server="$SERVER" --token="$TOKEN" --insecure-skip-tls-verify auth can-i list <bare-resource>
kubectl --server="$SERVER" --token="$TOKEN" --insecure-skip-tls-verify auth can-i list <resource>.<group>
```

对于命名空间资源，同一授权者会发出命名空间范围的 Forbidden 消息变体 — `<resource> is forbidden: User "<subject>" cannot <verb> resource "<bare-resource>" in API group "<group>" in the namespace "<ns>"` — 因此在 `secrets` 上的规则如果 `verbs: [""]` 将拒绝 `list secrets` 并返回该确切消息：

```bash
kubectl --server="$SERVER" --token="$TOKEN" --insecure-skip-tls-verify get secrets -n <namespace>
```
