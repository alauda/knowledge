---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500699
sourceSHA: a646a366b9367f1b843c0d7a919bccef0d2ed3190abf9fec82dfdd4e20508c4a
---

# 通过 RBAC 实现对 KubeVirt 虚拟机的控制台仅访问

## 问题

非管理员用户需要打开一个命名空间中 `VirtualMachine` 对象的串行控制台或 VNC 显示，列出这些虚拟机及其后端的 `VirtualMachineInstance` Pod，并查看支持的工作负载资源——但不能启动、停止、编辑或删除任何虚拟机，并且在任何其他命名空间中没有访问权限。

内置的聚合角色 `kubevirt.io:view` 授予对 `kubevirt.io` API 组中的 `virtualmachines` 和 `virtualmachineinstances` 的 `get`/`list`/`watch` 权限，但故意省略了控制台和 VNC 子资源，因此绑定该角色的用户可以看到虚拟机对象，但无法打开其控制台。一个自定义的命名空间范围的 `Role`，添加这两个子资源，解决了这个问题，而不授予任何变更动词。

## 解决方案

在目标命名空间中应用两个对象：一个定义控制台仅权限集的 `Role`，以及一个将其授予单个用户（或服务账户）的 `RoleBinding`。这两个都是标准的 `rbac.authorization.k8s.io/v1` 资源；底层的授权机制是上游 Kubernetes RBAC 机制，其中每个 `PolicyRule` 是一个附加的允许列表——未列出的动词被拒绝。

可选地，首先绑定标准的集群范围 `view` 角色，以便用户具有通常的命名空间范围的基本可见性（configmaps、pods、services、events 等，具有 `get`/`list`/`watch` 权限）。`view` ClusterRole 在 Alauda Container Platform 上存在，并覆盖核心 API 组中的 `pods`、`pods/log`、`services`、`endpoints`、`events`：

```bash
kubectl create rolebinding view-baseline \
  --clusterrole=view \
  --user=<username> \
  -n <namespace>
```

然后创建控制台仅的 `Role` 和 `RoleBinding`。第一个规则授予对虚拟机和 VMI 对象本身的读取动词。第二个规则授予来自聚合 `subresources.kubevirt.io` 组的两个控制台子资源——`virtualmachineinstances/console`（串行控制台）和 `virtualmachineinstances/vnc`（VNC）。第三个规则授予对支持的核心资源的读取动词：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: kubevirt-console-access
  namespace: <namespace>
rules:
- apiGroups: ["kubevirt.io"]
  resources: ["virtualmachines", "virtualmachineinstances"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["subresources.kubevirt.io"]
  resources:
  - virtualmachineinstances/console
  - virtualmachineinstances/vnc
  verbs: ["get", "update"]
- apiGroups: [""]
  resources: ["pods", "pods/log", "services", "endpoints", "events"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: kubevirt-console-access-binding
  namespace: <namespace>
subjects:
- kind: User
  name: <username>
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: kubevirt-console-access
  apiGroup: rbac.authorization.k8s.io
```

要绑定到 `ServiceAccount` 而不是用户，请将 `subjects` 条目替换为 `{kind: ServiceAccount, name: <sa>, namespace: <namespace>}`（去掉 `apiGroup`）。

该配置的两个属性值得强调。首先，第二个规则的 `apiGroups: ["subresources.kubevirt.io"]` 是必需的——`virtualmachineinstances/console` 和 `virtualmachineinstances/vnc` 是由 KubeVirt 聚合 API 服务器在该组下提供的，而不是在 `kubevirt.io` 下；列出这些子资源路径的规则在 `kubevirt.io` 下将无法授权。其次，由于 `Role` 仅列出对 `virtualmachines`/`virtualmachineinstances` 的 `get`/`list`/`watch` 和对两个控制台子资源的 `get`/`update`，因此每个其他动词——对 VM/VMI 对象的 `create`、`update`、`patch`、`delete`，以及变更子资源 `virtualmachines/start`、`virtualmachines/stop`、`virtualmachineinstances/pause`、`virtualmachineinstances/addvolume` 等——默认情况下都被拒绝。

## 诊断步骤

确认绑定的主体确实具有授予的权限，并被拒绝省略的权限。询问授权者“该动词是否允许该主体”的可靠方法是以主体身份进行身份验证（真实令牌）并运行 `kubectl auth can-i`，这会发出一个 `SelfSubjectAccessReview`。通过 `--as=<user>` 从管理员上下文进行的模拟 `SubjectAccessReview` 在该平台上不是可靠的探测——它可能会返回 `yes`，而目标主体实际上并没有该权限。

将 `Role` 绑定到 `ServiceAccount`（或重写现有 `RoleBinding` 的 `subjects` 指向一个），然后为其生成一个令牌，并使用该令牌对 API 服务器进行检查。预期结果是文章中 `Role` 定义的矩阵：

```bash
NS=<namespace>
TOK=$(kubectl -n $NS create token <sa-name>)
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')

# 授予的读取权限——每个都期望 'yes'
for v in get list watch; do
  echo -n "$v vm: "
  kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
    -n $NS auth can-i $v virtualmachines.kubevirt.io
done

# 省略的动词——每个都期望 'no'
for v in create update patch delete; do
  echo -n "$v vm: "
  kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
    -n $NS auth can-i $v virtualmachines.kubevirt.io
done

# 变更 VM 子资源——期望 'no'
kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
  -n $NS auth can-i update virtualmachines --subresource=start

# 跨命名空间——期望 'no'
kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
  -n default auth can-i get virtualmachines.kubevirt.io
```

`console` 和 `vnc` 子资源位于 `subresources.kubevirt.io` 下，而不是 `kubevirt.io`，因此使用资源短名称形式的 `kubectl auth can-i` 可能会探测到错误的 API 组。通过原始 API 直接发出 `SelfSubjectAccessReview` 以明确指定组：

```bash
for sub in console vnc; do
  echo -n "get vmi/$sub in $NS: "
  cat <<EOF | kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
    create -f - --validate=false -o jsonpath='{.status.allowed}'
apiVersion: authorization.k8s.io/v1
kind: SelfSubjectAccessReview
spec:
  resourceAttributes:
    namespace: $NS
    group: subresources.kubevirt.io
    resource: virtualmachineinstances
    subresource: $sub
    verb: get
EOF
  echo
done
```

在正确绑定的主体上预期的输出：

```text
get vmi/console in <namespace>: true
get vmi/vnc in <namespace>: true
```

为了进行端到端检查，使用主体的令牌访问实时 VNC 子资源端点。RBAC 拒绝和缺少对象之间的区别在 HTTP 状态中可见：`403 Forbidden` 是授权者拒绝请求，`404 NotFound` 意味着请求已被授权，但 `VirtualMachineInstance` 根本不存在：

```bash
curl -k -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOK" \
  "$SERVER/apis/subresources.kubevirt.io/v1/namespaces/$NS/virtualmachineinstances/<vmi>/console"
```

响应 `403`，消息为 `virtualmachineinstances.subresources.kubevirt.io ".." is forbidden: User ".." cannot get resource "virtualmachineinstances/console"` 表示绑定缺失（或请求在错误的命名空间中进行）；响应 `404`，消息为 `virtualmachineinstance.kubevirt.io ".." not found` 确认 RBAC 路径是清晰的，只有 VMI 名称需要关注。

在不同命名空间中的相同探测将返回 `403`，即使对于绑定的主体，也确认了 `RoleBinding` 是命名空间范围的：

```bash
curl -k -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOK" \
  "$SERVER/apis/subresources.kubevirt.io/v1/namespaces/default/virtualmachineinstances/<vmi>/console"
```
