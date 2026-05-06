---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.0,4.2.x
---

# Windows 虚拟机通过 VNC 控制台访问时鼠标错位 — 添加 USB tablet 输入设备

## 问题

通过 ACP 虚拟化创建的 Windows 客户机可以正常打开 Web VNC 控制台，但鼠标无法准确定位到界面元素。常见症状：

- 主机端光标与客户机端光标偏移 — 点击屏幕上看到的按钮，实际点击落在其他位置。
- 光标"卡"在某个角落，或每次移动相对主机被放大 / 反向。
- 拖拽、滚轮、右键行为不一致；在安装向导、对话框、Windows 登录界面中几乎无法完成精确操作。

同一台 VM 通过 RDP 或支持 SPICE 的客户端连接时一切正常。鼠标错位仅出现在 VNC 通道上。

## 根本原因

KubeVirt VirtualMachine 默认向客户机暴露一个 **PS/2 模拟鼠标**。PS/2 鼠标发送的是 *相对* 偏移量（Δx, Δy），客户机操作系统负责跟踪绝对指针位置。VNC 客户端发送的始终是 *绝对* 坐标（用户在帧缓冲区中点击的位置），因此宿主机必须先把绝对坐标转换成一连串相对偏移再交给客户机。客户机再从这些偏移中重新推导出绝对位置。

这条链路在 Windows 上有两处会出问题：

1. **缺少双向指针同步。** Linux 客户机由 X / Wayland 输入层在每次移动事件时重新同步光标，掩盖了偏移问题。Windows 指针子系统信任自己的内部坐标，只是周期性地校正，因此移动几次后客户机认为的"光标位置"就和 VNC 客户端的认知背离。
2. **Windows 默认开启"提高指针精确度"指针加速。** 这条非线性加速曲线会作用于 hypervisor 注入的相对偏移量，于是宿主机移动 10 像素并不会变成客户机的 10 像素。误差会累积，产生用户看到的发散性偏移。

切换为 **USB tablet** 输入设备可以绕开整条链路。tablet 原生上报 *绝对* 坐标，VNC 客户端的"用户点击在 (x, y)"会被直接传递给客户机为"指针在 (x, y)" — 不再需要相对偏移转换、不再有加速曲线、不再产生偏移。Windows 内置 HID 兼容 tablet 驱动，无需额外安装即可识别该设备。

这是 KubeVirt 的一个已知设计问题，上游跟踪在 [kubevirt/kubevirt#2392](https://github.com/kubevirt/kubevirt/issues/2392)。OpenShift Virtualization 的 Windows 模板基于同样的原因默认带 USB tablet；ACP 的模板目前还没有，这就是新创建的 Windows VM 会遇到此问题的原因。

## 解决方案

在 VM 的 `spec.template.spec.domain.devices.inputs` 列表中添加一个 USB tablet，然后重启 VM 让新设备在下次启动时挂入。

### 修补已存在的 VM

```bash
export VM_NS=<vm-namespace>
export VM_NAME=<vm-name>

kubectl patch vm "$VM_NAME" -n "$VM_NS" --type=json -p='[
  {
    "op": "add",
    "path": "/spec/template/spec/domain/devices/inputs",
    "value": [
      {
        "name": "tablet",
        "bus": "usb",
        "type": "tablet"
      }
    ]
  }
]'
```

如果 VM 已经存在 `inputs` 数组（例如此前的 tablet 被移除但字段保留为空），上面的 JSON-patch `add` 会整体替换该字段。如果想追加而不是替换，请把 path 改为 `/spec/template/spec/domain/devices/inputs/-`。

重启 VM，让新设备被呈现给客户机：

```bash
virtctl restart "$VM_NAME" -n "$VM_NS"
```

客户机重新启动后，Windows 会自动安装 HID 兼容 tablet 驱动。重新连接 VNC 控制台 — 光标应当与主机指针一比一同步。

### 为新建 VM 默认带上

对于通过 YAML 清单创建的 VM，把 tablet 与已有的 disks、interfaces 一起声明。完整的 `devices` 段如下（`inputs` 条目即为新增项）：

```yaml
spec:
  template:
    spec:
      domain:
        devices:
          disks:
            - disk:
                bus: sata
              name: rootdisk
          inputs:
            - bus: usb
              name: tablet
              type: tablet
          interfaces:
            - masquerade: {}
              model: e1000e
              name: default
```

对于基于共享模板克隆的 VM，建议直接修改一次模板，使后续所有 Windows VM 都继承 tablet — 这样与 OCP 的默认行为对齐，也避免每次新建 VM 都重新踩坑。

### 为什么使用 USB 而不是 virtio

KubeVirt 输入设备也接受 `bus: virtio`，但 Windows 内置驱动集 **不包含** virtio-input 驱动 — 需要先安装 virtio-win 客户机工具才能识别，而这恰好就是用户因为鼠标不可用而无法完成的引导步骤。`bus: usb` 使用标准 HID 类，在干净安装的 Windows 上即可工作。

## 诊断步骤

1. 确认正在运行的 domain 是否已有 tablet。检查 VMI（运行实例），而不仅是 VM 模板：

   ```bash
   kubectl get vmi "$VM_NAME" -n "$VM_NS" -o jsonpath='{.spec.domain.devices.inputs}'
   ```

   输出为空（或字段不存在）表示当前只挂载了默认的 PS/2 鼠标。如果输出中已有 `"type":"tablet"` 条目，说明设备已声明，鼠标错位另有原因（参见步骤 4）。

2. 检查 virt-launcher Pod 中的 libvirt domain XML，查看实际呈现给 QEMU 的 `<input>` 元素：

   ```bash
   POD=$(kubectl get pod -n "$VM_NS" -l kubevirt.io/domain="$VM_NAME" -o name | head -1)
   kubectl exec -n "$VM_NS" "$POD" -c compute -- virsh dumpxml 1 \
     | grep -A1 '<input'
   ```

   补丁生效后应当看到类似 `<input type='tablet' bus='usb'/>` 的条目。如果只有 `<input type='mouse' bus='ps2'/>`，则仍然是默认配置 — VNC 下会错位。

3. 按"解决方案"中的步骤打补丁并重启 VM。重新执行步骤 2 — 必须先看到 tablet 那一行，再去重新连接 VNC 控制台。

4. 重新连接控制台后如果指针仍然漂移，则原因 *不在* 输入设备：

   - 检查 VNC 客户端是否对帧缓冲做了缩放（浏览器缩放级别非 100% 会再次引入错位）。
   - 在客户机里打开 **设置 → 设备 → 鼠标 → 其他鼠标选项 → 指针选项**，关闭 **提高指针精确度** — 即使挂上了 tablet，操作系统层面的加速偏好仍可能作用于某些代码路径。
   - 确认 Windows 已识别 tablet：**设备管理器 → 人体学输入设备 → 符合 HID 标准的笔**（或"符合 HID 标准的触摸屏"）应当存在且没有黄色感叹号。如果设备缺失，VM 可能从缓存的配置启动；用 `virtctl stop` 后再 `virtctl start` 强制干净重启。

5. 对于在此修复之前就已存在的存量 VM，列出所有缺少 tablet 输入设备、需要补丁的 Windows VM：

   ```bash
   kubectl get vm -A -o json \
     | jq -r '.items[]
              | select(.spec.template.spec.domain.machine.type? // "" | test("q35"))
              | select((.spec.template.spec.domain.devices.inputs // [])
                       | map(.type) | index("tablet") | not)
              | "\(.metadata.namespace)\t\(.metadata.name)"'
   ```

   如果环境里 Windows VM 带有 OS 标签（例如 `os.template.kubevirt.io/windows*`），可与该 label selector 组合，进一步缩小范围。

## 相关信息

- 上游 issue：[kubevirt/kubevirt#2392 — Windows 客户机 VNC 鼠标位置不同步](https://github.com/kubevirt/kubevirt/issues/2392)
- KubeVirt API 参考：`VirtualMachineInstanceSpec` 上的 `Devices.Inputs` 字段。
- OpenShift Virtualization 的 Windows 模板默认就带 `inputs: [{type: tablet, bus: usb}]`，是 ACP 管理的模板应当对齐的参考行为。
