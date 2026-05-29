---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500551
sourceSHA: 6687eb75bb9b0e18c195309220775765f866de2f4cb51acccaba24f21ece6365
---

# 在 ACP 上授予组对 KubeVirt 虚拟机的仅启动/停止/重启 RBAC 权限

## 问题

在 Alauda 容器平台上，KubeVirt（构建 `v1.7.0-alauda.2`，控制平面位于命名空间 `kubevirt`）实现了对 `VirtualMachine` 的生命周期操作，包括启动、停止和重启，作为聚合 apiGroup `subresources.kubevirt.io/v1` 下的子资源 `virtualmachines/start`、`virtualmachines/stop` 和 `virtualmachines/restart`（命名空间，未更改自上游）。期望的结果是让一部分用户能够通过 API（`kubectl`、`virtctl` 或任何驱动相同子资源的控制台）启动、停止和重启任何命名空间中的虚拟机，但不允许添加、删除或编辑虚拟机的磁盘或其他规格字段。

将 KubeVirt 提供的聚合 `kubevirt.io:edit` ClusterRole 绑定到这样的组过于宽泛：该角色授予对 apiGroup `kubevirt.io` 中父资源 `virtualmachines` 的写权限 `[get, delete, create, update, patch, list, watch]`（它携带聚合标签 `rbac.authorization.k8s.io/aggregate-to-edit=true` 和安装注释 `kubevirt.io/install-strategy-version=v1.7.0-alauda.2`），因此任何绑定到它的主体都可以修改虚拟机规格，包括磁盘。磁盘列表位于 `VirtualMachine` 规格的 `spec.template.spec.domain.devices.disks[]`（根据 `virtualmachines.kubevirt.io/v1` CRD），更改它需要对 `kubevirt.io/virtualmachines` 的 `update`/`patch` 权限——从生命周期子资源到该字段没有路径。

## 解决方案

定义一个自定义 ClusterRole，仅授予对 `subresources.kubevirt.io` 中三个生命周期子资源的 `update` 权限，以及对父资源 `virtualmachines` 的读取权限，以便主体可以列出和检查虚拟机以进行操作。这是上游提供的 `kubevirt.io:edit` ClusterRole 对生命周期子资源使用的标准动词模式（对 `virtualmachines/{start,stop,restart}` 的动词 `update`），而 `kubevirt.io:view` 确认对虚拟机的读取使用 `[get, list, watch]`，没有写权限。应用以下 ClusterRole：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubevirt-vm-lifecycle-only
rules:
  - apiGroups: ["subresources.kubevirt.io"]
    resources:
      - virtualmachines/start
      - virtualmachines/stop
      - virtualmachines/restart
    verbs: ["update"]
  - apiGroups: ["kubevirt.io"]
    resources: ["virtualmachines"]
    verbs: ["get", "list", "watch"]
```

通过 ClusterRoleBinding 将 ClusterRole 绑定到目标组。在 ACP 上，RBAC 主体类型保持与上游 Kubernetes 集合一致（`User`、`Group`、`ServiceAccount` — `rbac.authorization.k8s.io/v1` 未更改），`kind: Group` 主体匹配任何身份验证用户，其身份验证层组声明包含绑定的 `name`；组身份本身由集群集成的任何身份提供者（OIDC、LDAP 等）提供——该人群在此 RBAC 配方之外建立。将 `<group-name>` 替换为用户令牌中携带的组字符串：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubevirt-vm-lifecycle-only
subjects:
  - kind: Group
    name: <group-name>
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: kubevirt-vm-lifecycle-only
  apiGroup: rbac.authorization.k8s.io
```

应用这两个对象：

```bash
kubectl apply -f kubevirt-vm-lifecycle-only-clusterrole.yaml
kubectl apply -f kubevirt-vm-lifecycle-only-clusterrolebinding.yaml
```

由于绑定是集群范围的，每个身份验证用户，其组声明包含 `<group-name>`，都继承对每个命名空间中每个虚拟机的仅启动/停止/重启权限；通过绑定的权限无法访问其他虚拟机规格的变更。

## 诊断步骤

确认生命周期子资源在集群上可用，并且 ClusterRole 引用的资源字符串与集群提供的 API 匹配：

```bash
kubectl get --raw /apis/subresources.kubevirt.io/v1 \
  | python3 -m json.tool \
  | grep -E 'virtualmachines/(start|stop|restart)'
```

聚合 apiGroup `subresources.kubevirt.io/v1` 列出 `virtualmachines/start`、`virtualmachines/stop` 和 `virtualmachines/restart` 作为命名空间子资源——这些正是 ClusterRole 规则必须使用的确切资源字符串。

检查上游提供的 `kubevirt.io:edit` ClusterRole，以确认生命周期子资源上的标准动词是 `update`，并查看为何需要更窄的自定义角色（它也授予对父资源 `virtualmachines` 的写权限）：

```bash
kubectl get clusterrole kubevirt.io:edit -o yaml
kubectl get clusterrole kubevirt.io:view -o yaml
```

`kubevirt.io:edit` 将 `virtualmachines/{start,stop,restart}`（apiGroup `subresources.kubevirt.io`）分组在 `verbs: [update]` 下，携带 `rbac.authorization.k8s.io/aggregate-to-edit=true` 标签，并在 `kubevirt.io / virtualmachines` 上列出 `[get, delete, create, update, patch, list, watch]`——对于此需求来说过于宽泛。`kubevirt.io:view` 确认了只读部分（`[get, list, watch]` 在 `kubevirt.io / virtualmachines` 和 `virtualmachineinstances` 上），这与自定义子资源更新规则组合，以提供仅启动/停止/重启的行为，而没有磁盘编辑的可达性。

验证磁盘字段只能通过对父资源的写权限访问，而不能通过任何生命周期子资源访问：

```bash
kubectl explain virtualmachine.spec.template.spec.domain.devices.disks
```

输出将磁盘列表锚定在 `spec.template.spec.domain.devices.disks[]` 上的 `virtualmachines.kubevirt.io/v1`；更改它需要对 `kubevirt.io/virtualmachines` 的 `update`/`patch` 权限，而自定义角色故意省略了这一点。
