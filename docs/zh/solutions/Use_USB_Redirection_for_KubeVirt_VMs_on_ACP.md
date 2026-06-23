---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
---

# 在 ACP 上为 KubeVirt 虚拟机使用 USB Redirection

## 概述

ACP 虚拟化可以通过两种方式把 USB 设备暴露给 KubeVirt VirtualMachine：

- **USB host passthrough** 将物理连接在 worker 节点上的 USB 设备透传给虚拟机。它更适合固定、长期绑定、性能敏感的设备。
- **USB Redirection** 也称 client passthrough，将运行 `virtctl usbredir` 的客户端机器上的 USB 设备重定向到正在运行的 VirtualMachineInstance (VMI)。它更适合临时接入、由用户本地持有、低吞吐的 USB 设备。

USB Redirection 不是硬件级直通。数据会经过客户端、Kubernetes 和 KubeVirt subresource 连接、`virt-handler`、`virt-launcher` 以及 QEMU usbredir 通道，然后到达 guest OS。它适合临时外设接入，不适合作为高吞吐存储路径或低延迟控制链路。

推荐选型如下：

| 场景 | 推荐机制 | 原因 |
| --- | --- | --- |
| USB 设备固定插在 worker 节点上，并长期绑定某台 VM | USB host passthrough | 链路更短，设备归属清晰，性能更好 |
| 用户或运维需要临时把本地 USB 设备接入 VM | USB Redirection | 设备不需要存在于 worker 节点上 |
| U 盘或移动硬盘用于长时间数据传输 | 优先使用 PVC、镜像导入、SCP/SSH、对象存储或 host passthrough | USB Redirection 引入网络和用户态转发开销 |
| UKey、智能卡读卡器、USB 串口、条码枪 | 设备级验证通过后使用 USB Redirection | 低吞吐交互通常适合该模式 |
| 工业控制、音视频采集或严格时序业务 | Host passthrough 或专用硬件方案 | USB Redirection 对延迟和抖动敏感 |

## 前提条件

集群侧需要满足以下条件：

- ACP 虚拟化已安装并处于健康状态。
- 使用 ACP 4.3.x 及更高版本的虚拟化。这些 ACP KubeVirt 构建包含 USB Redirection subresource 和 `clientPassthrough` API 字段。
- 运行态 VMI 已配置 `spec.domain.devices.clientPassthrough`。只更新 VM 模板不会改变正在运行的 VMI；需要重启 VM，使新的 `virt-launcher` Pod 和 QEMU domain 带上 usbredir 槽位。

客户端是 USB 设备实际插入并运行 `virtctl usbredir` 的机器。Linux 客户端需要安装：

- 与 ACP 虚拟化版本兼容的 `virtctl`。
- `usbredirect`。
- `lsusb`，通常由 `usbutils` 软件包提供。

客户端必须能够访问目标集群的 Kubernetes API 入口，并保持 `virtctl usbredir` 的流式连接。客户端不需要直连 worker 节点、`virt-launcher` Pod、VM IP 地址或 guest 的 SSH 端口。只有需要在 guest OS 内验证重定向设备时，才需要 SSH、控制台或其他 guest 访问方式。

在 Debian 或 Ubuntu 类客户端上：

```bash
sudo apt-get install -y usbredirect usbutils
```

操作本地 USB 设备通常需要特权访问，因此除非已经通过现场 udev 规则授予了对应权限，否则建议使用 `sudo` 运行 `virtctl usbredir`。

Windows 客户端需要 Windows 版本的 `usbredirect` 和 UsbDk，并且 `usbredirect` 必须在 `PATH` 中。将 Windows 客户端作为正式交付路径前，需要在 Windows 环境中验证完整客户端配置：确认终端能够找到 `usbredirect`、UsbDk 能够访问目标 USB 设备，并通过一次试验性的 `virtctl usbredir` 会话确认设备可以正常连接和断开。

## 授予最小 RBAC

用户需要读取 VMI，并对 `virtualmachineinstances/usbredir` subresource 具备 `get` 权限。ACP 内置的 KubeVirt `admin` 和 `edit` 角色通常包含该权限；`view` 角色不包含 USB Redirection 权限。

如果需要按 namespace 授予最小权限，可创建如下 Role 和 RoleBinding：

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

预期结果为：

```text
yes
```

## 为 VM 启用 USB Redirection

在 VM 模板的 `spec.template.spec.domain.devices` 下添加 `clientPassthrough: {}`。

新建 VM 清单中加入以下字段。这里只展示与 USB Redirection 相关的字段：

```yaml
spec:
  template:
    spec:
      domain:
        devices:
          clientPassthrough: {}
```

对已有 VM，可 patch 模板：

```bash
kubectl patch vm <vm-name> -n <vm-namespace> --type=merge \
  -p '{"spec":{"template":{"spec":{"domain":{"devices":{"clientPassthrough":{}}}}}}}'
```

重启 VM，使运行态 VMI 获取新的设备配置：

```bash
virtctl restart <vm-name> -n <vm-namespace>
```

确认运行态 VMI 包含该字段：

```bash
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.domain.devices.clientPassthrough}{"\n"}'
```

预期输出：

```text
{}
```

设置 `clientPassthrough` 后，KubeVirt 会为 VMI 创建 4 个 QEMU usbredir 槽位。可通过 live domain 检查：

```bash
POD=$(kubectl get pod -n <vm-namespace> -l kubevirt.io/domain=<vm-name> \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n <vm-namespace> "$POD" -c compute -- \
  virsh dumpxml 1 | grep -A4 '<redirdev'
```

domain XML 中应包含类似 `virt-usbredir-0` 到 `virt-usbredir-3` 的 redirection device。

## 重定向客户端 USB 设备

在客户端机器上列出 USB 设备：

```bash
lsusb
```

示例输出：

```text
Bus 002 Device 003: ID 0951:1666 Kingston Technology DataTraveler 100 G3
```

按 vendor 和 product ID 重定向：

```bash
sudo virtctl -n <vm-namespace> usbredir 0951:1666 <vm-name>
```

也可以按 bus 和 device 地址重定向：

```bash
sudo virtctl -n <vm-namespace> usbredir 02-03 <vm-name>
```

只要设备需要保持接入，就需要保持 `virtctl usbredir` 进程运行。按 `Ctrl+C` 可断开连接。如果客户端进程退出、客户端网络中断、USB 设备被拔出、VM 重启，或 `virt-launcher` Pod 被重建，guest 内的重定向设备都会消失，需要重新执行 `virtctl usbredir`。

## 在 guest 内验证

登录 guest OS，确认 USB 设备可见：

```bash
lsusb
```

如果只是临时验证 USB 存储设备，还可以检查块设备：

```bash
lsblk -f
blkid
```

不要在客户端和 guest 中同时挂载同一个存储设备。如果必须验证 U 盘或读卡器，请先在客户端卸载该设备，并优先在 guest 内只读挂载：

```bash
sudo mkdir -p /mnt/usb
sudo mount -o ro /dev/sdX1 /mnt/usb
ls -la /mnt/usb
sudo umount /mnt/usb
```

将 `/dev/sdX1` 替换成 guest 内实际看到的分区名。

## 限制与风险

USB Redirection 依赖 `usbredirect`、客户端 OS 的 USB 栈、KubeVirt subresource streaming、QEMU usbredir 支持以及 guest OS 驱动。设备可能可以成功枚举，但由于驱动、协议、延迟或时序要求，在业务应用层仍不可用。

重要限制包括：

- 单个 VMI 最多有 4 个 USB Redirection 槽位。
- 重定向会话绑定客户端进程以及当前 VMI/`virt-launcher` 生命周期。
- 客户端网络中断会导致设备从 guest 中消失。
- API server、负载均衡或代理的 idle timeout 可能影响长连接。
- 高吞吐存储、实时控制、音视频设备不适合该机制。
- 存储类 USB 设备如果被客户端和 guest 同时挂载，可能造成数据损坏。

对于敏感设备型号，尤其是 UKey、智能卡读卡器、串口适配器以及有严格时序要求的设备，需要按型号验证。

## 故障排查

### `Not configured with USB Redirection`

运行态 VMI 未包含 `clientPassthrough`。

检查 live VMI：

```bash
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.domain.devices.clientPassthrough}{"\n"}'
```

如果输出为空，patch VM 模板并重启 VM。

### `VMI not running`

目标 VMI 不处于 `Running` 状态。

```bash
virtctl start <vm-name> -n <vm-namespace>
kubectl wait vmi/<vm-name> -n <vm-namespace> --for=condition=Ready --timeout=180s
```

### `Error on finding usbredirect in $PATH`

客户端找不到 `usbredirect` 二进制文件。

```bash
sudo apt-get install -y usbredirect
which usbredirect
```

### `Could not init libusb` 或权限不足

本地用户无权接管 USB 设备。

```bash
sudo virtctl -n <vm-namespace> usbredir <vendor>:<product> <vm-name>
```

对于长期使用的 Linux 客户端，可为该设备配置经过现场审批的 udev 规则。

### 没有可用 USB Redirection 槽位

VMI 可能已经存在 4 个活跃 USB Redirection 会话，或客户端上仍有旧进程占用会话。

在客户端机器上执行：

```bash
pgrep -af 'virtctl.*usbredir|usbredirect'
```

只停止确认已经失效的旧进程，然后重试。

### 断开后客户端存储设备未恢复为 `/dev/sdX`

部分 USB 存储设备在 redirection 会话结束后，可能没有重新绑定到客户端存储驱动。优先尝试物理拔插。如果无法物理拔插，检查本地 USB 树：

```bash
lsusb -t
```

如果对应接口显示 `Driver=[none]`，可使用客户端上显示的接口 ID 重新绑定到 `usb-storage`：

```bash
sudo modprobe usb-storage
echo -n '<usb-interface-id>' | sudo tee /sys/bus/usb/drivers/usb-storage/bind
```

接口 ID 类似 `3-4:1.0`，但必须以实际客户端主机上看到的值为准。

## 相关信息

- KubeVirt Client Passthrough: https://github.com/kubevirt/user-guide/blob/main/docs/compute/client_passthrough.md
- KubeVirt v1.7.0 USB Redirection 校验: https://github.com/kubevirt/kubevirt/blob/v1.7.0/pkg/virt-api/rest/usbredir.go
- KubeVirt v1.7.0 `clientPassthrough` API 字段: https://github.com/kubevirt/kubevirt/blob/v1.7.0/staging/src/kubevirt.io/api/core/v1/schema.go
- usbredir 项目: https://gitlab.freedesktop.org/spice/usbredir/
