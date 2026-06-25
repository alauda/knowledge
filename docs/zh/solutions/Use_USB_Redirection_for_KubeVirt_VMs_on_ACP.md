---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
id: KB260600125
sourceSHA: 858c6b7b62415c73ede739754c7257e143d03cc7040a23ff4ee796e09a967b72
---

# 在 ACP 上为 KubeVirt 虚拟机使用 USB 重定向

## 概述

ACP 虚拟化可以通过两种不同方式将 USB 设备暴露给 KubeVirt 虚拟机：

- **USB 主机直通** 连接到工作节点的物理 USB 设备。这更适合固定的、长期使用的设备和对性能敏感的工作负载。
- **USB 重定向**，也称为客户端直通，从运行 `virtctl usbredir` 的工作站重定向 USB 设备到正在运行的虚拟机实例 (VMI)。这更适合临时的、用户持有的、低吞吐量的设备。

USB 重定向不是硬件直通。流量通过客户端、Kubernetes 和 KubeVirt 子资源连接、`virt-handler`、`virt-launcher` 和 QEMU usbredir 通道流动，才到达客户操作系统。将其用于对临时 USB 外设的灵活访问，而不是作为高吞吐量存储或低延迟控制路径。

推荐的使用案例：

| 使用案例                                                                  | 推荐机制                                                               | 原因                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| USB 设备固定在工作节点上，并应保持连接到一个虚拟机                       | USB 主机直通                                                          | 路径更短，设备所有权更清晰，性能更好                       |
| 用户或操作员需要临时将本地 USB 设备重定向到虚拟机                       | USB 重定向                                                           | 设备不需要在工作节点上存在                                  |
| 用于长时间数据传输的 USB 闪存驱动器或外部磁盘                           | 优先使用 PVC、镜像导入、SCP/SSH、对象存储或主机直通                  | USB 重定向增加了网络和用户空间转发的开销                   |
| USB 令牌、智能卡读卡器、串行适配器、条形码扫描仪                       | USB 重定向，经过设备级验证                                           | 低吞吐量交互通常适合此模型                                   |
| 工业控制、音频/视频捕获或严格时序工作负载                               | 主机直通或专用硬件设计                                               | USB 重定向对延迟和抖动敏感                                   |

## 先决条件

集群端必须满足以下条件：

- 已安装并正常运行 ACP 虚拟化。
- 使用 ACP 4.3.x 或更高版本的虚拟化。这些 ACP KubeVirt 构建包括 USB 重定向子资源和 `clientPassthrough` API 字段。
- 正在运行的 VMI 已配置 `spec.domain.devices.clientPassthrough`。更新虚拟机模板对正在运行的 VMI 不够；需要重启虚拟机，以便创建新的 `virt-launcher` pod 和带有 usbredir 插槽的 QEMU 域。

客户端是物理连接 USB 设备并运行 `virtctl usbredir` 的机器。对于 Linux 客户端，安装：

- 与 ACP 虚拟化版本兼容的 `virtctl`。
- `usbredirect`。
- `lsusb`，通常来自 `usbutils` 包。

客户端必须能够访问目标集群的 Kubernetes API 端点，并保持 `virtctl usbredir` 流连接打开。它不需要直接网络访问工作节点、`virt-launcher` pod、虚拟机 IP 地址或客户操作系统的 SSH 端口。只有在您想从操作系统内部验证重定向设备时，才需要对客户操作系统的 SSH 或控制台访问。

在基于 Debian 或 Ubuntu 的客户端上：

```bash
sudo apt-get install -y usbredirect usbutils
```

管理本地 USB 设备通常需要特权访问，因此请使用 `sudo` 运行 `virtctl usbredir`，除非站点特定的 udev 规则授予所需的访问权限。

Windows 客户端需要 Windows 版本的 `usbredirect` 和 UsbDk，并且 `usbredirect` 必须在 `PATH` 中。在将 Windows 用作受支持的交付工作流之前，请验证 Windows 环境中的完整客户端设置：确认 `usbredirect` 可以从终端发现，UsbDk 可以访问目标 USB 设备，并且试用的 `virtctl usbredir` 会话可以干净地附加和分离设备。

## 授予最小 RBAC

用户需要对 VMI 的读取访问权限和对 `virtualmachineinstances/usbredir` 子资源的 `get` 访问权限。ACP 内置的 KubeVirt `admin` 和 `edit` 角色通常包括此权限；`view` 角色不包括 USB 重定向访问。

对于最小特权的命名空间范围角色，创建一个 Role 和 RoleBinding，如下所示：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: vm-usbredir
  namespace: <vm-namespace>
rules:
  - apiGroups: ["kubevirt.io"]
    resources: ["virtualmachineinstances"]
    verbs: ["get"]
  - apiGroups: ["subresources.kubevirt.io"]
    resources: ["virtualmachineinstances/usbredir"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: vm-usbredir
  namespace: <vm-namespace>
subjects:
  - kind: User
    apiGroup: rbac.authorization.k8s.io
    name: <user-name>
roleRef:
  kind: Role
  apiGroup: rbac.authorization.k8s.io
  name: vm-usbredir
```

验证权限：

```bash
kubectl auth can-i get virtualmachineinstances/usbredir.subresources.kubevirt.io \
  -n <vm-namespace>
```

预期结果是：

```text
yes
```

## 在虚拟机上启用 USB 重定向

在虚拟机模板的 `spec.template.spec.domain.devices` 下添加 `clientPassthrough: {}`。

对于新的虚拟机清单，包含以下字段。仅显示与 USB 重定向相关的字段：

```yaml
spec:
  template:
    spec:
      domain:
        devices:
          clientPassthrough: {}
```

对于现有虚拟机，修补模板：

```bash
kubectl patch vm <vm-name> -n <vm-namespace> --type=merge \
  -p '{"spec":{"template":{"spec":{"domain":{"devices":{"clientPassthrough":{}}}}}}}'
```

重启虚拟机，以便正在运行的 VMI 接收新的设备配置：

```bash
virtctl restart <vm-name> -n <vm-namespace>
```

确认正在运行的 VMI 包含该字段：

```bash
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.domain.devices.clientPassthrough}{"\n"}'
```

预期输出：

```text
{}
```

当 `clientPassthrough` 被设置时，KubeVirt 为 VMI 创建四个 QEMU usbredir 插槽。要检查实时域：

```bash
POD=$(kubectl get pod -n <vm-namespace> -l kubevirt.io/domain=<vm-name> \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n <vm-namespace> "$POD" -c compute -- \
  virsh dumpxml 1 | grep -A4 '<redirdev'
```

域 XML 应包含由类似 `virt-usbredir-0` 到 `virt-usbredir-3` 的路径支持的重定向设备。

## 重定向客户端 USB 设备

在客户端机器上，列出 USB 设备：

```bash
lsusb
```

示例输出：

```text
Bus 002 Device 003: ID 0951:1666 Kingston Technology DataTraveler 100 G3
```

通过供应商和产品 ID 重定向：

```bash
sudo virtctl -n <vm-namespace> usbredir 0951:1666 <vm-name>
```

或者，通过总线和设备地址重定向：

```bash
sudo virtctl -n <vm-namespace> usbredir 02-03 <vm-name>
```

保持 `virtctl usbredir` 进程运行，直到设备应保持连接。按 `Ctrl+C` 断开连接。如果客户端进程退出、客户端网络断开、USB 设备被拔出、虚拟机重启或 `virt-launcher` pod 被重新创建，客户将失去重定向设备，您必须再次运行 `virtctl usbredir`。

## 在客户操作系统中验证

登录到客户操作系统并确认 USB 设备可见：

```bash
lsusb
```

对于仅用于验证的 USB 存储设备，还应检查块设备：

```bash
lsblk -f
blkid
```

请勿同时在客户端和客户操作系统上挂载同一存储设备。如果您必须验证 USB 闪存驱动器或读卡器，请先在客户端上卸载它，并优先在客户操作系统中以只读方式访问：

```bash
sudo mkdir -p /mnt/usb
sudo mount -o ro /dev/sdX1 /mnt/usb
ls -la /mnt/usb
sudo umount /mnt/usb
```

将 `/dev/sdX1` 替换为客户操作系统内部显示的分区名称。

## 限制和风险

USB 重定向依赖于 `usbredirect`、客户端操作系统 USB 堆栈、KubeVirt 子资源流、QEMU usbredir 支持和客户操作系统驱动程序。设备可能成功枚举，但由于驱动程序、协议、延迟或时序要求，仍可能在业务应用层失败。

重要限制：

- 一个 VMI 获得四个 USB 重定向插槽。
- 重定向会话与正在运行的客户端进程和当前 VMI/`virt-launcher` 生命周期绑定。
- 客户网络中断会将设备从客户操作系统中移除。
- API 服务器、负载均衡器或代理的空闲超时可能会影响长期会话。
- 高吞吐量存储、实时控制和音频/视频设备不适合。
- 如果客户端和客户操作系统同时挂载 USB 存储设备，可能会导致设备损坏。

验证每个敏感设备模型，特别是 USB 令牌、智能卡读卡器、串行适配器和具有严格时序行为的设备。

## 故障排除

### `未配置 USB 重定向`

正在运行的 VMI 不包含 `clientPassthrough`。

检查实时 VMI：

```bash
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.domain.devices.clientPassthrough}{"\n"}'
```

如果输出为空，请修补虚拟机模板并重启虚拟机。

### `VMI 未运行`

目标 VMI 不在 `Running` 状态。

```bash
virtctl start <vm-name> -n <vm-namespace>
kubectl wait vmi/<vm-name> -n <vm-namespace> --for=condition=Ready --timeout=180s
```

### `在 $PATH 中找不到 usbredirect 的错误`

客户端无法找到 `usbredirect` 二进制文件。

```bash
sudo apt-get install -y usbredirect
which usbredirect
```

### `无法初始化 libusb` 或权限被拒绝

本地用户无法控制 USB 设备。

```bash
sudo virtctl -n <vm-namespace> usbredir <vendor>:<product> <vm-name>
```

对于长期的 Linux 客户端设置，为设备创建站点批准的 udev 规则。

### 没有可用的 USB 重定向插槽

VMI 可能已经有四个活动的 USB 重定向会话，或者旧的本地客户端进程可能仍在运行。

在客户端机器上：

```bash
pgrep -af 'virtctl.*usbredir|usbredirect'
```

仅停止拥有旧会话的过时进程，然后重试。

### 客户存储设备在断开连接后未返回为 `/dev/sdX`

某些 USB 存储设备在重定向会话结束后可能仍未从客户端存储驱动程序中解除绑定。首先尝试物理拔出并重新插入。如果物理重新插入不可行，请检查本地 USB 树：

```bash
lsusb -t
```

如果相关接口显示 `Driver=[none]`，请使用客户端上显示的接口 ID 重新绑定到 `usb-storage`：

```bash
sudo modprobe usb-storage
echo -n '<usb-interface-id>' | sudo tee /sys/bus/usb/drivers/usb-storage/bind
```

接口 ID 看起来像 `3-4:1.0`，但必须从实际客户端主机中获取。

## 相关信息

- KubeVirt 客户端直通: <https://github.com/kubevirt/user-guide/blob/main/docs/compute/client_passthrough.md>
- KubeVirt v1.7.0 USB 重定向验证: <https://github.com/kubevirt/kubevirt/blob/v1.7.0/pkg/virt-api/rest/usbredir.go>
- KubeVirt v1.7.0 `clientPassthrough` API 字段: <https://github.com/kubevirt/kubevirt/blob/v1.7.0/staging/src/kubevirt.io/api/core/v1/schema.go>
- usbredir 项目: <https://gitlab.freedesktop.org/spice/usbredir/>
