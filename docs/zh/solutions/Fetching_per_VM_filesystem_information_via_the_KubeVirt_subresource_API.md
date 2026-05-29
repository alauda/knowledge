---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500690
sourceSHA: 06fa10d82da8503a8898c792ee9e39b48f41e7e617eba8e2da7eea3c30fed7da
---

# 通过 KubeVirt 子资源 API 获取每个虚拟机的文件系统信息

## 问题

在 Alauda 容器平台虚拟化上，虚拟机的操作员需要一种编程方式来读取每个虚拟机的内部文件系统清单——挂载点、文件系统类型、总字节数、已用字节数——而无需登录到虚拟机内部。KubeVirt 子资源 API 将这些数据暴露为一个专用端点，后端由内部的 qemu-guest-agent (qga) 支持；本文将展示确切的端点、认证方式、响应负载以及返回有用数据的先决条件。

## 解决方案

在此平台上，KubeVirt 在以下聚合子资源路径下提供每个 VMI 的文件系统清单：

```text
GET /apis/subresources.kubevirt.io/v1/namespaces/<namespace>/virtualmachineinstances/<vmi-name>/filesystemlist
```

该路径位于 `subresources.kubevirt.io/v1` API 组下，该组注册为聚合 APIService (`v1.subresources.kubevirt.io`, `Available=True`)，并由 kube-apiserver 路由到 `kubevirt` 命名空间中的 `virt-api` 服务。执行 `kubectl api-resources --api-group=subresources.kubevirt.io` 将返回一个空表，因为聚合子资源没有 `kind`；真实来源是 `/apis/subresources.kubevirt.io/v1` 的发现 JSON，其中列出了 `virtualmachineinstances/filesystemlist` 以及其兄弟 guest-agent 子资源 `virtualmachineinstances/userlist` 和 `virtualmachineinstances/guestosinfo`。

将调用作为经过身份验证的 HTTPS 请求发送到集群 API 服务器，在 `Authorization` 头中提供 Bearer 令牌——这是标准的聚合 API 身份验证路径；API 服务器检查 `subresources.kubevirt.io/virtualmachineinstances/filesystemlist` 上的 `get` 动作的 RBAC，然后将请求代理到 `virt-api`，后者将请求转发到每个 VMI 的 `virt-launcher`，通过 virtio-serial 通道与 qga 通信。

```bash
API_URL=<api-host>:<port>          # 例如集群 API 服务器的主机:端口
TOKEN=<bearer-token>
NAMESPACE=<vm-namespace>
VM_NAME=<vmi-name>

curl --insecure \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://${API_URL}/apis/subresources.kubevirt.io/v1/namespaces/${NAMESPACE}/virtualmachineinstances/${VM_NAME}/filesystemlist"
```

响应是一个 JSON 对象，形状为 `{ "items": [...], "metadata": {} }`。`items` 中的每个条目描述一个内部文件系统：`disk`（一个 `{ "busType": ... }` 对象的列表）、`diskName`（例如 `vda1`）、`fileSystemType`（例如 `ext4`、`vfat`）、`mountPoint`（例如 `/`、`/boot/efi`）、`totalBytes` 和 `usedBytes`。该字段集在不同的客户操作系统中是相同的；只有值不同。来自 Ubuntu 20.04 客户的示例响应：

```text
{
  "items": [
    {
      "disk": [{"busType": "virtio"}],
      "diskName": "vda15",
      "fileSystemType": "vfat",
      "mountPoint": "/boot/efi",
      "totalBytes": 109422592,
      "usedBytes": 5448704
    },
    {
      "disk": [{"busType": "virtio"}],
      "diskName": "vda1",
      "fileSystemType": "ext4",
      "mountPoint": "/",
      "totalBytes": 9343795200,
      "usedBytes": 1620111360
    }
  ],
  "metadata": {}
}
```

集群内的调用者可以使用 `kubectl get --raw` 访问相同的端点（该命令使用 kubeconfig 凭证而不是显式的 Bearer 头，但通过相同的聚合路径路由）：

```bash
kubectl get --raw \
  "/apis/subresources.kubevirt.io/v1/namespaces/${NAMESPACE}/virtualmachineinstances/${VM_NAME}/filesystemlist"
```

调用者的令牌（或 ServiceAccount）必须在 `subresources.kubevirt.io/virtualmachineinstances/filesystemlist` 上持有 `get` 动作。上游命名的 ClusterRoles `kubevirt.io:view`、`kubevirt.io:edit` 和 `kubevirt.io:admin` 都包含此动作，聚合的 Kubernetes 角色 `view` / `edit` / `admin` 也携带此动作——授予其中任何一个给调用者即可。使用 `kubectl auth can-i get virtualmachineinstances/filesystemlist.subresources.kubevirt.io` 确认给定身份的授权（当被允许时返回 `yes`）。

## 根本原因

`filesystemlist` 子资源不从 VMI 自定义资源或任何集群侧状态读取。VMI CRD 的 OpenAPI 架构甚至不包含 `filesystemlist` 字段；响应形状存在于 `virt-api` 的 Go 处理程序中。当子资源调用到达时，`virt-api` 将其代理到承载目标 VMI 的 `virt-launcher` pod，`virt-launcher` 的 cmd-server 向内部的 qemu-guest-agent 通过 virtio-serial 通道 `org.qemu.guest_agent.0` 发出 QMP `guest-get-fsinfo` 命令。qga 收集实时挂载表并返回；`virt-launcher` 将结果编组为子资源发出的 JSON。这意味着该端点仅在安装、启动并与 `virt-launcher` 注册的 qemu-guest-agent 存在时返回有用数据——此时 VMI 在 `status.conditions` 中携带条件 `AgentConnected=True`。当 qga 缺失或未连接时，调用无法检索挂载点。

## 诊断步骤

在调用 `filesystemlist` 之前，确认集群中的三件事：子资源 API 可访问、目标 VMI 正在运行以及 qga 已连接。

验证聚合子资源 API 是否正常并提供 `filesystemlist` 资源：

```bash
# APIService 聚合：应报告 Available=True，由 kubevirt/virt-api 服务支持
kubectl get apiservice v1.subresources.kubevirt.io

# 发现列表：filesystemlist（及其兄弟 userlist、guestosinfo）应出现
kubectl get --raw /apis/subresources.kubevirt.io/v1
```

确认 VMI 正在运行并且 qga 已注册。相关信号是 VMI 的 `status.conditions` 数组中的 `AgentConnected` 条件；没有 `status=True`，`filesystemlist` 无法返回挂载数据：

```bash
kubectl get vmi <vmi-name> -n <namespace> \
  -o jsonpath='{.status.conditions[?(@.type=="AgentConnected")]}'
```

当 qga 连接时，预期输出：

```text
{"lastProbeTime":null,"lastTransitionTime":null,"status":"True","type":"AgentConnected"}
```

如果 `AgentConnected` 缺失或其 `status` 为 `False`，请在重试子资源调用之前在客户内部安装并启用 qemu-guest-agent。在 Debian/Ubuntu 客户中，这是 `qemu-guest-agent` 包加上 `systemctl enable --now qemu-guest-agent`；在 Fedora 系列客户中使用相同的包名；在 Windows 上，它作为 QEMU Guest Agent MSI 提供。KubeVirt 不会安装代理——它仅使用其结果。

确认调用者的身份可以调用该动作，以便不会将空响应 / 403 响应误认为缺少数据：

```bash
kubectl auth can-i get virtualmachineinstances/filesystemlist.subresources.kubevirt.io \
  -n <namespace>
```

然后发出实际的子资源调用并检查 JSON 负载：

```bash
kubectl get --raw \
  "/apis/subresources.kubevirt.io/v1/namespaces/<namespace>/virtualmachineinstances/<vmi-name>/filesystemlist"
```

如果 API 服务器返回形式为 `virtualmachineinstance.kubevirt.io "<name>" not found` 的错误，则聚合 APIService 已正确连接，请求已到达 `virt-api` 的处理程序——URL 中的 VMI 名称错误（或 VMI 不再存在）。如果 kube-apiserver 返回一个普通的 `404`，则表示 APIService 本身不可用。
