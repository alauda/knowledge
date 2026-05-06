---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500048
sourceSHA: 2ae2eaaddbc12628294aa90241653fe781f4a2c181c9d770977cdae56579bf01
---

# Windows 虚拟机在 VNC 控制台中的鼠标指针不对齐 — 添加 USB 平板输入设备

## 问题

通过 ACP 虚拟化创建的 Windows 客户端在 Web VNC 控制台中正常打开，但鼠标指针无法准确对准 UI 元素。通常观察到的症状包括：

- 主机光标和客户机光标之间漂移 — 点击屏幕上的按钮实际上落在其他地方。
- 指针“卡住”在一个角落，或者每次移动相对于主机都被放大/反转。
- 拖动、滚动和右键单击行为不一致；在安装程序、RDP 风格的对话框或 Windows 登录屏幕中的精确操作几乎不可能。

当通过 RDP 或 SPICE 兼容客户端连接时，同一虚拟机表现正常。此不对齐问题特定于 VNC 通道。

## 根本原因

默认情况下，KubeVirt 虚拟机向客户机暴露一个 **PS/2 风格的模拟鼠标**。PS/2 鼠标发送 *相对* 增量 (Δx, Δy)，客户操作系统负责跟踪绝对指针位置。在 VNC 上，客户端仅发送 *绝对* 坐标（用户在帧缓冲区上点击的位置），因此主机必须将这些转换为一系列相对增量，然后再交给客户机。客户机随后从这些增量重新推导出绝对位置。

在 Windows 上，这个链条出现了两个问题：

1. **没有双向指针同步。** Linux 客户机运行一个 X/Wayland 输入层，在每个运动事件上重新同步光标，掩盖了漂移。Windows 指针子系统信任其内部坐标，并且仅定期进行协调，因此客户机对“光标位置”的理解与 VNC 客户端的理解在几次移动后就会偏离。
2. **指针加速（“增强指针精度”）在 Windows 中默认开启。** 非线性加速曲线应用于虚拟机监控程序注入的相对增量，因此 10 像素的主机移动并不会变成 10 像素的客户机移动。错误累积，导致用户看到的漂移。

切换到 **USB 平板** 输入设备可以绕过整个链条。平板本地报告 *绝对* 坐标，因此 VNC 客户端的“用户点击了 (x, y)”将作为“指针位于 (x, y)”传递给客户机 — 无需相对增量转换，无需加速曲线，无需漂移。Windows 自带一个符合 HID 的平板驱动程序，因此该设备在没有额外安装的情况下被识别。

这是一个已知的 KubeVirt 设计怪癖，在 [kubevirt/kubevirt#2392](https://github.com/kubevirt/kubevirt/issues/2392) 中进行了跟踪。OpenShift 虚拟化的 Windows 虚拟机模板已经默认声明了 USB 平板，原因相同；而 ACP 的模板尚未这样做，这就是新创建的 Windows 虚拟机遇到此问题的原因。

## 解决方案

将 USB 平板添加到虚拟机的 `spec.template.spec.domain.devices.inputs` 列表中，然后重启虚拟机，以便在下次启动时热插拔新设备。

### 修补现有虚拟机

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

如果虚拟机已经有一个 `inputs` 数组（例如，之前的平板被移除并且键被留空），上述 JSON 补丁 `add` 将替换它。要追加而不是替换，请针对 `/spec/template/spec/domain/devices/inputs/-`。

重启虚拟机，以便将新设备呈现给客户机：

```bash
virtctl restart "$VM_NAME" -n "$VM_NS"
```

客户机重新启动后，Windows 会自动安装 HID 兼容的平板驱动程序。重新连接 VNC 控制台 — 光标应与主机指针一对一跟踪。

### 将其集成到新虚拟机中

对于从 YAML 清单创建的虚拟机，在现有磁盘和接口旁边声明平板。完整的 `devices` 块如下所示（`inputs` 条目是新增的）：

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

对于从共享模板克隆的虚拟机，编辑模板一次，以便每个后续的 Windows 虚拟机继承平板 — 这与 OCP 默认值匹配，并防止每个新虚拟机上重复出现此问题。

### 为什么选择 USB 而不是 virtio

KubeVirt 接受 `bus: virtio` 作为输入设备，但 Windows 自带的驱动程序集中 **不** 包含 virtio-input 驱动程序 — 这需要先安装 virtio-win 客户工具，而这正是用户无法完成的引导步骤，因为鼠标尚未工作。`bus: usb` 使用标准 HID 类，并在干净的 Windows 安装上工作。

## 诊断步骤

1. 确认正在运行的域未暴露平板。检查 VMI（实时实例），而不仅仅是虚拟机模板：

   ```bash
   kubectl get vmi "$VM_NAME" -n "$VM_NS" -o jsonpath='{.spec.domain.devices.inputs}'
   ```

   空输出（或缺少键）确认仅附加了默认的 PS/2 鼠标。填充的数组中有 `"type":"tablet"` 表示设备已经声明，且不对齐的原因不同（见第 4 步）。

2. 检查 virt-launcher pod 内的 libvirt 域 XML，以获取实际呈现给 QEMU 的 `<input>` 元素：

   ```bash
   POD=$(kubectl get pod -n "$VM_NS" -l kubevirt.io/domain="$VM_NAME" -o name | head -1)
   kubectl exec -n "$VM_NS" "$POD" -c compute -- virsh dumpxml 1 \
     | grep -A1 '<input'
   ```

   应该在应用补丁后看到类似 `<input type='tablet' bus='usb'/>` 的行。仅有 `<input type='mouse' bus='ps2'/>` 是默认的、针对 VNC 的破损状态。

3. 应用解决方案部分中的补丁并重启虚拟机。重新运行第 2 步 — 在重新连接 VNC 控制台之前，平板行必须出现。

4. 重新连接控制台后，如果指针仍然漂移，原因 *不是* 输入设备：

   - 检查 VNC 客户端是否在缩放帧缓冲区（浏览器缩放级别不是 100% 可能会重新引入不对齐）。
   - 在客户机内部，打开 **设置 → 设备 → 鼠标 → 附加鼠标选项 → 指针选项**，并关闭 **增强指针精度** — 即使连接了平板，操作系统偏好仍可能对某些代码路径应用加速。
   - 确认 Windows 识别了平板：**设备管理器 → 人机接口设备 → HID 兼容笔**（或“HID 兼容触摸屏”）应存在且没有警告图标。如果设备缺失，虚拟机可能正在从缓存配置启动；使用 `virtctl stop` 然后 `virtctl start` 强制进行干净重启。

5. 对于在此修复之前的虚拟机集，列出所有缺少平板输入且需要修补的 Windows 虚拟机：

   ```bash
   kubectl get vm -A -o json \
     | jq -r '.items[]
              | select(.spec.template.spec.domain.machine.type? // "" | test("q35"))
              | select((.spec.template.spec.domain.devices.inputs // [])
                       | map(.type) | index("tablet") | not)
              | "\(.metadata.namespace)\t\(.metadata.name)"'
   ```

   如果 Windows 虚拟机在您的环境中携带操作系统系列标签，可以结合使用标签选择器（例如，`os.template.kubevirt.io/windows*`）。

## 相关信息

- 上游问题：[kubevirt/kubevirt#2392 — Windows 客户机的 VNC 鼠标位置未同步](https://github.com/kubevirt/kubevirt/issues/2392)
- KubeVirt API 参考：`Devices.Inputs` 字段在 `VirtualMachineInstanceSpec` 中。
- OpenShift 虚拟化 Windows 模板默认提供相同的 `inputs: [{type: tablet, bus: usb}]` 块，这是 ACP 管理模板应趋同的参考行为。
