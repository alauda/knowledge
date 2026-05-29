---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500761
sourceSHA: 6b032ca87b5b782534c902032f4f07b10673fa778f49ab65742dd1db8125b000
---

# 通过 PVC 支持的 CD-ROM 将 ISO 镜像挂载到 ACP 上的 KubeVirt 虚拟机

## 概述

Alauda 容器平台通过 `kubevirt-operator` 提供基于 KubeVirt 的虚拟化；在经过验证的集群中，`kubevirts.kubevirt.io` 单例 `kubevirt-kubevirt-hyperconverged` 存在于 `kubevirt` 命名空间中，并报告 `status.observedKubeVirtVersion=v1.7.0-alauda.2`，`PHASE=Deployed`。数据平面工作负载（`virt-operator`、`virt-api`）携带匹配的 `build-harbor.alauda.cn/3rdparty/kubevirt/...:v1.7.0-alauda.2` 镜像标签。`virtualmachines.kubevirt.io` CRD 是上游 KubeVirt CRD（组 `kubevirt.io`，提供版本 `v1` 和 `v1alpha3`）—— 形状未修改，没有平台特定的重命名。

容器数据导入器（CDI）与 KubeVirt 一起由同一操作员交付；在经过验证的集群中，`cdis.cdi.kubevirt.io/cdi-kubevirt-hyperconverged` 状态为 `Deployed`，并且 CDI CRDs `datavolumes.cdi.kubevirt.io`、`volumeimportsources.cdi.kubevirt.io` 和 `volumeuploadsources.cdi.kubevirt.io` 均已提供。CDI 是填充 `persistentvolumeclaims`（core/v1）与 ISO 镜像的通用 KubeVirt 原生路径——通过 HTTP/注册表导入，通过 `virtctl image-upload`，或通过 `DataVolume` 源。

## 问题

用户希望将 ISO 镜像作为 CD-ROM 设备附加到在 ACP 上运行的 `virtualmachines.kubevirt.io`，无论是在创建时使虚拟机从 ISO 启动，还是为了使安装介质可供来宾使用。支持的路径使用通过 CDI 填充的 `persistentvolumeclaims`，并在虚拟机规格中作为 CD-ROM 磁盘引用。

## 解决方案

**步骤 1 — 用 ISO 填充 PVC。** 在与虚拟机相同的命名空间中创建一个 `persistentvolumeclaims` 并用 ISO 字节填充它。经过验证的集群中的默认 `topolvm-hdd` `StorageClass` 是 CDI ISO PVC 的绑定目标。最简单的路径是 `virtctl image-upload`，它驱动 `volumeuploadsources.cdi.kubevirt.io` 流：

```bash
virtctl image-upload pvc iso-disk \
  --namespace <vm-namespace> \
  --size 1Gi \
  --image-path /local/path/to/installer.iso \
  --storage-class topolvm-hdd \
  --access-mode ReadWriteOnce
```

或者，创建一个 `DataVolume`（`datavolumes.cdi.kubevirt.io`），使用 `http` / `registry` / `upload` 源，以便 CDI 将 ISO 导入到生成的 PVC 中。任一路径都会在虚拟机的命名空间中生成一个普通的 `persistentvolumeclaims`，其内容为 ISO 镜像。

**步骤 2 — 在 VirtualMachine 上声明 CD-ROM 磁盘和 PVC 卷。** 上游 KubeVirt CRD 上的 CD-ROM 磁盘声明为 `spec.template.spec.domain.devices.disks[]` 条目，带有 `cdrom` 对象。`cdrom` 对象包含三个字段：`bus`（允许值 `virtio`、`sata`、`scsi`）、`readonly`（布尔值，默认为 `true`）和 `tray`（`open` 或 `closed`，默认为 `closed`）。磁盘条目的 `name` 字段是设备名称，磁盘通过在 `spec.template.spec.volumes[]` 条目上的相同 `name` 与其后备卷匹配。

携带 ISO 的 PVC 从 `spec.template.spec.volumes[]` 条目中引用，类型为 `persistentVolumeClaim`。卷的 `persistentVolumeClaim.claimName`（必需）命名为与虚拟机相同命名空间中的 PVC。磁盘和卷上的匹配 `name=iso-cdrom` 将 CD-ROM 设备绑定到 ISO PVC：

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: <vm-name>
  namespace: <vm-namespace>
spec:
  runStrategy: Halted
  template:
    spec:
      domain:
        devices:
          disks:
          - name: iso-cdrom
            cdrom:
              bus: sata
              readonly: true
        resources:
          requests:
            memory: 2Gi
      volumes:
      - name: iso-cdrom
        persistentVolumeClaim:
          claimName: iso-disk
```

经过验证的集群接受了这个确切的 `disks[].cdrom` + `volumes[].persistentVolumeClaim` 形状未修改——API 原封不动地接受了上游 KubeVirt 配方。

**步骤 3 — 启动（或重启）虚拟机。** CD-ROM 卷仅在虚拟机（重新）启动后对来宾可见。经过验证的 KubeVirt 构建 `v1.7.0-alauda.2` 仅暴露运行虚拟机的热插拔子资源 `virtualmachineinstances/addvolume` 和 `virtualmachineinstances/removevolume`——没有由 `subresources.kubevirt.io/v1` 提供的 CD-ROM 特定插入/弹出子资源，并且在 `kubevirts.kubevirt.io` CR 上没有启用相应的功能门。经过验证的集群上活动的功能门集为 `CPUManager, Snapshot, ExpandDisks, HostDevices, VMExport, KubevirtSeccompProfile, WithHostModelCPU, HypervStrictCheck, VideoConfig, HotplugVolumes`；只有 `HotplugVolumes` 管理热插拔，并且它针对的是磁盘类卷而不是 CD-ROM。因此，在 `Running` 虚拟机上声明的 CD-ROM 直到虚拟机重启后才会生效，并且无法通过热插拔子资源将 CD-ROM 添加到已经运行的虚拟机中。

设置 `spec.runStrategy: Always`（或使用 `virtctl start <vm>`）以使虚拟机启动时挂载 CD-ROM。如果在添加 CD-ROM 磁盘时虚拟机已经处于 `Running` 状态，请重启它：

```bash
virtctl restart <vm-name> -n <vm-namespace>
```

重新创建的 `virt-launcher-<vm>-<hash>` pod 附加 ISO PVC，来宾在配置的总线中看到 CD-ROM 设备。

## 验证

在虚拟机达到 `Running` 状态后，CD-ROM 在 KubeVirt API 表面上作为命名磁盘可见：

```bash
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.domain.devices.disks[?(@.name=="iso-cdrom")]}{"\n"}'
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.volumes[?(@.name=="iso-cdrom")]}{"\n"}'
```

在来宾内部，CD-ROM 出现在 `cdrom.bus` 选择的总线上（通常为 `sata`/`scsi` 的 `/dev/sr0`）。PVC 是 ISO 字节的真实来源；更换介质意味着填充新的 PVC 并更新卷引用，然后重启虚拟机。
