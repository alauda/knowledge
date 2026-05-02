---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 9f2b1c73596ce0cf9ec5f8e238c1145f7315ca19bd1fe1b8ed57c21bf95f23bd
---

## 概述

多租户集群的标准规则是命名空间默认是隔离的——没有明确权限的经过身份验证的用户无法列出他们不拥有的命名空间中的资源。基于 KubeVirt 的虚拟化堆栈故意打破了这一规则，针对一个特定的命名空间：存放经过策划的操作系统启动源镜像的命名空间（克隆到支持新虚拟机的 DataVolumes / DataSources / PVCs）。

当普通集群用户运行 `kubectl get datasource -n <kubevirt-os-images-namespace>` 并获得填充的列表时，这是预期的行为，而不是 RBAC 配置错误。该平台提供了一个 ClusterRole 和一个 ClusterRoleBinding，授予每个 `system:authenticated` 实体对启动源镜像命名空间的 `view` 权限——如果没有它，命名空间范围的用户在创建虚拟机时无法选择基础镜像，因为虚拟机创建流程需要读取源 DataVolume 的清单以将其克隆到用户自己的命名空间中。

## 解决方案

该授权是故意的，由两个上游 KubeVirt 资源提供：

- **ClusterRole `os-images.kubevirt.io:view`** — 允许在启动源命名空间中对 `datavolume`、`datasource`、`persistentvolumeclaim` 执行 `get`、`list`、`watch` 操作。
- **ClusterRoleBinding `os-images.kubevirt.io:view`** — 将上述 ClusterRole 绑定到 `system:authenticated` 组，因此每个持有有效令牌的用户自动继承对 OS-images 命名空间的读取访问权限。

检查绑定以直接查看：

```bash
kubectl get clusterrole os-images.kubevirt.io:view -o yaml
kubectl get clusterrolebinding os-images.kubevirt.io:view -o yaml
```

这两个引用命名空间时根据标签和硬编码名称，具体取决于 operator 版本。

### “view” 实际上允许的操作

具有此绑定的经过身份验证的用户可以：

- 在 OS-images 命名空间中 `get`、`list`、`watch` DataVolume / DataSource / PVC 对象（源清单）。
- 查看这些资源的 `status`，包括哪些基础镜像卷已导入并准备就绪。

他们 **不能**：

- 修改、删除或替换该命名空间中的任何对象（无 `update`、`patch`、`delete`、`create`）。
- 通过集群 API 读取基础镜像数据。读取卷的字节仍然需要正常的 `kubectl exec` 进入挂载 PVC 的 pod，而查看者在这里无法创建。
- 读取其他命名空间的 KubeVirt 资源，除非单独授予。

如果安全审查将广泛的读取访问标记为不需要，可以收紧绑定——但权衡是虚拟机创建向导需要明确的每用户绑定（或“按名称选择”用户体验），才能让用户克隆黄金镜像。两个 ClusterRoles `os-images.kubevirt.io:edit` 和 `os-images.kubevirt.io:admin` 涵盖了更高权限的情况（修改镜像，管理命名空间）。

### 收紧授权（可选）

当广泛的 `system:authenticated` 授权与集群的租户模型不兼容时，用更窄的绑定替换上游绑定。请注意，operator 会在每次协调时重新创建原始绑定，因此覆盖需要位于控制器感知的位置（自定义 Kustomize 补丁、GitOps 覆盖或 operator 的 CR，如果它为此提供了调节选项）。

一个可行的模式是将现有的 `os-images.kubevirt.io:view` ClusterRole 仅绑定到一个较小的组，然后通过 operator CR 禁用默认的 `system:authenticated` 绑定（请查阅平台的 KubeVirt operator CR 以获取字段名称）。对于无法禁用上游绑定的环境，接受广泛的读取并将 OS-images 命名空间视为公共目录。

## 诊断步骤

要查看特定用户在 OS-images 命名空间中被允许执行的操作，请使用 `kubectl auth can-i`：

```bash
NS=cpaas-virtualization-os-images   # 此集群上的实际命名空间名称
USER=alice@example.com

kubectl --as="$USER" -n "$NS" auth can-i list datasource
kubectl --as="$USER" -n "$NS" auth can-i create datasource
kubectl --as="$USER" -n "$NS" auth can-i delete persistentvolumeclaim
```

对于普通用户，`list` 的结果应为 `yes`，而 `create`/`delete` 的结果应为 `no`。

要列举授予对该命名空间访问权限的所有绑定：

```bash
kubectl get clusterrolebinding -o json \
  | jq '.items[]
        | select(.roleRef.name | test("^os-images.kubevirt.io"))
        | {name: .metadata.name, role: .roleRef.name,
           subjects: [.subjects[]?.kind + ":" + .subjects[]?.name]}'
```

该列表中任何带有 `Group:system:authenticated` 的项都是广泛的上游授权。

要检查当前作为启动源发布的 DataSources 和 DataVolumes，请以任何经过身份验证的用户身份查看 OS-images 命名空间：

```bash
kubectl -n "$NS" get datasource
kubectl -n "$NS" get datavolume
```

每个 `DataSource` 都携带一个指向 `DataVolume` 的 `spec.source`（可导入的镜像清单）；基础 PVC 是虚拟机创建流程使用的可克隆工件。
