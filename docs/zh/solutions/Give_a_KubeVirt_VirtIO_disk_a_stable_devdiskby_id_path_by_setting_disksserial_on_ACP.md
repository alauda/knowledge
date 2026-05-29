---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500717
sourceSHA: 6d0a5bb01647a8142a63777d73e486f467971517a7e7e42c41f4389349a73486
---

# 通过设置 disks[].serial 在 ACP 上为 KubeVirt VirtIO 磁盘提供稳定的 /dev/disk/by-id 路径

## 问题

一个通过其 `/dev/disk/by-id/` 路径固定磁盘的客户应用程序或虚拟机内配置无法找到附加到 `virtualmachines.kubevirt.io` 的 VirtIO 磁盘。块设备在内核级别存在（例如 `/dev/vdb`），但 `/dev/disk/by-id/` 目录没有 `virtio-*` 的符号链接 — 有时该目录完全为空。因此，固定文件系统挂载、LVM PV、数据库数据目录或 Kubernetes CSI 原始块消费者到 by-id 路径在虚拟机重启后或设备字母顺序发生变化后会立即失败。

## 根本原因

默认情况下，KubeVirt VirtIO 磁盘模型不会向客户机提供硬件序列号。客户机的 udev 从磁盘的硬件级标识符构建 `/dev/disk/by-id/virtio-<serial>` 符号链接，因此当设备未暴露序列号时，udev 没有任何内容可以作为 `by-id` 条目的锚点，即使块设备本身是完全可用的。

这一点在 Alauda Container Platform 上通过 `kubevirt-operator` 直接观察到（KubeVirt `v1.7.0-alauda.2`，在 `kubevirt` 命名空间中的 HyperConverged 单例 `kubevirt-kubevirt-hyperconverged`，`PHASE=Deployed`，Kubernetes `v1.34.5-1`）。一台带有三个 VirtIO 磁盘的 CentOS 7.9 客户机，其中只有数据磁盘携带 `disks[].serial=my-stable-disk-01`，在 `/dev/disk/by-id/` 下显示了确切的一个条目 — 具有序列号的磁盘，而没有序列号的两个磁盘仅出现在 `/dev/disk/by-path/` 下。

## 解决方案

在每个客户机需要通过稳定名称访问的 VirtIO 磁盘上，将 `spec.template.spec.domain.devices.disks[].serial` 设置为唯一的字母数字字符串，然后重启虚拟机。序列号通过 libvirt 域 XML 传播到 QEMU，客户机的 udev 在 `/dev/disk/by-id/virtio-<serial>` 处暴露该磁盘。

`serial` 字段在 ACP 上的上游 KubeVirt VirtualMachine CRD 中定义，位于 `spec.template.spec.domain.devices.disks[].serial <string>`，其描述为 `Serial provides the ability to specify a serial number for the disk device.`。周围的结构是上游的：`disks <[]Object>`（磁盘、光盘和 LUN）和 `disk.bus <string>`，支持的值为 `virtio`、`sata`、`scsi`、`usb`。

修补虚拟机模板，使每个需要稳定路径的磁盘都携带唯一的序列号：

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: <vm-name>
  namespace: <vm-namespace>
spec:
  template:
    spec:
      domain:
        devices:
          disks:
          - name: rootdisk
            disk:
              bus: virtio
          - name: data-disk
            disk:
              bus: virtio
            serial: my-stable-disk-01
```

如果虚拟机已经存在，则使用 `kubectl patch` 应用相同的字段：

```bash
kubectl -n <vm-namespace> patch vm <vm-name> --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/domain/devices/disks/1/serial","value":"my-stable-disk-01"}]'
```

然后重启虚拟机，以便新模板在新的 VMI 中生效：

```bash
kubectl -n <vm-namespace> delete vmi <vm-name>
```

（`runStrategy: Always` 会自动重新创建 VMI。）客户机重新启动后，新路径可见：

```text
/dev/disk/by-id/virtio-my-stable-disk-01 -> ../../vdb
```

客户应用程序、`/etc/fstab` 条目、LVM 过滤器和类似消费者现在可以通过该路径访问磁盘，并且该路径在重启和设备字母重新排序中保持不变。

## 诊断步骤

确认集群上的 CRD 结构 — `serial` 字段必须存在于上游的 `kubevirt.io/v1` VirtualMachine CRD 中：

```bash
kubectl explain virtualmachine.spec.template.spec.domain.devices.disks.serial
```

预期输出描述 `FIELD: serial <string>`，其描述为 `Serial provides the ability to specify a serial number for the disk device.`。

对于缺少 by-id 符号链接的运行中的虚拟机，读取当前的 VMI 以查看哪些磁盘实际上携带序列号：

```bash
kubectl -n <vm-namespace> get vmi <vm-name> \
  -o jsonpath='{range .spec.domain.devices.disks[*]}{.name}{"  serial="}{.serial}{"\n"}{end}'
```

列出带有空 `serial=` 值的磁盘将在客户机内部没有 `/dev/disk/by-id/virtio-*` 条目，无论客户机操作系统如何配置。

从客户机内部，确认 udev 属性。具有序列号的磁盘携带 `ID_SERIAL` 属性和 `/dev/disk/by-id/` 下的 `DEVLINKS` 条目；没有序列号的磁盘则没有这些，仅显示 `by-path` 设备链接：

```bash
udevadm info --query=property --name=/dev/vdb | grep -E 'ID_SERIAL|DEVLINKS'
```

序列号的更改不会传播到活动的 VMI。KubeVirt API 拒绝直接更新 VMI（`update of VMI object is restricted`），修补虚拟机模板仅更新暂存模板 — 运行中的 VMI 保持之前的序列号，直到下次重启。更改磁盘序列号时始终计划虚拟机重启。

```bash
kubectl -n <vm-namespace> get vm  <vm-name> -o jsonpath='{.spec.template.spec.domain.devices.disks[*].serial}{"\n"}'
kubectl -n <vm-namespace> get vmi <vm-name> -o jsonpath='{.spec.domain.devices.disks[*].serial}{"\n"}'
```

如果两个输出不同，则虚拟机模板领先于活动 VMI，需要重启才能在客户机中出现新的 `/dev/disk/by-id/virtio-<serial>` 路径。
