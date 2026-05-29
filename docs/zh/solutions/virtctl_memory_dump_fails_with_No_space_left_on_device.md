---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500747
sourceSHA: eac7933de0e6deec006969ddcab42e39df049fb60eed8de9e7f186e8852d667c
---

# virtctl memory-dump 失败，提示 "设备上没有剩余空间"

## 问题

对在 Alauda 容器平台虚拟化（KubeVirt）上运行的虚拟机执行 `virtctl memory-dump <vm> --create-claim` 返回失败，并且 VMI 显示的事件负载以 `Memory dump to pvc <name> failed: Domain memory dump failed: virError(Code=9, ...) ... Unable to write /var/run/kubevirt/hotplug-disks/<pvc>/<...>.memory.dump: No space left on device` 开头。转储从未完成；`--create-claim` 标志自动创建的 PVC 已被正在进行的转储填满，libvirt 的 `libvirt_iohelper` 由于 `ENOSPC` 中止了写入。

## 根本原因

`virtctl memory-dump --create-claim` 将其目标记录在 `VirtualMachine.status.memoryDumpRequest` 中，该 CRD 形状在此平台上为 `{claimName, phase, fileName, message, remove, startTimestamp, endTimestamp}`；`claimName` 是自动创建的 PVC，`message` 携带上述失败文本。PVC 被热插拔到 VMI 中，其进度在 `VirtualMachineInstance.status.volumeStatus[].memoryDumpVolume{claimName, targetFileName, startTimestamp, endTimestamp}` 中反映 — `targetFileName` 是 `ENOSPC` 事件命名的 `.memory.dump` 路径。

自动创建的 PVC 的大小基于客户机声明的内存。KubeVirt 从 `VirtualMachine.spec.template.spec.domain.memory.guest` 中读取该值，当未明确设置时，它默认使用 `spec.template.spec.domain.resources.requests.memory`。当虚拟机规格既不包含 — 即客户机的内存大小未声明 — 控制器回退到一个不限制 libvirt 域将转储的实际 RAM 的值，因此 PVC 的大小小于转储负载，第一次写入超出 PVC 的文件系统可用大小时会遇到 `ENOSPC`。

第二个因素使可用大小低于 PVC 请求的大小。当转储 PVC 以 `volumeMode: Filesystem`（`topolvm-hdd` 和其他支持文件系统的 StorageClass 的默认值）进行配置时，CDI 会保留请求容量的一部分作为文件系统开销。该部分为 `CDI.spec.config.filesystemOverhead`（在 `CDIConfig.status.filesystemOverhead` 中显示的有效值），定义为 0 到 1 之间的值；CDI CRD 文档中未设置时的默认值为 `0.06`（6%），在此平台上默认 StorageClass 的有效值为 `0.06`。因此，要求恰好等于客户机内存大小的 PVC 仅对 libvirt 可用 `requested * (1 - overhead)`，这不足以满足转储文件的开销边际加上 libvirt 头字节。

## 解决方案

不要依赖 `--create-claim`。预先创建一个考虑到客户机内存和文件系统开销保留的大小的 memory-dump PVC，然后将其名称传递给 `virtctl memory-dump`，以完全绕过自动调整路径。

根据以下公式确定 PVC 的大小。`MEMORY` 是在 `spec.template.spec.domain.memory.guest` 中声明的值（如果 `memory.guest` 未设置，则为 `spec.template.spec.domain.resources.requests.memory`）；`OVERHEAD` 是转储 PVC 将落在的 StorageClass 的有效 `CDIConfig.status.filesystemOverhead`：

```text
PVC size = (MEMORY + 100 MiB) * (1 + OVERHEAD)
```

在 `CDI` 的 `filesystemOverhead` 为默认值 `0.06`（6%）的集群中，8 GiB 的客户机需要：

```text
PVC size = (8 GiB + 100 MiB) * (1 + 0.06)
        = 8.1 GiB * 1.06
        ≈ 8.586 GiB   → 向上取整到 8.6 GiB
```

如果集群已根据每个 StorageClass 自定义了非默认的 `filesystemOverhead` — 或者如果转储 PVC 将为 `volumeMode: Block`，在这种情况下不保留开销 — 请将相应值（或 `0`）替换到相同的公式中。

显式创建 PVC，然后对其触发转储。将 `<dump-sc>` 替换为要配置的 StorageClass，将 `<ns>` 替换为 VM 的命名空间，将 `<vm>` 替换为虚拟机名称：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vm-memdump
  namespace: <ns>
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: <dump-sc>
  volumeMode: Filesystem
  resources:
    requests:
      storage: 8600Mi   # 根据上述公式进行调整
```

应用清单，然后使用 `--claim-name` 而不是 `--create-claim` 触发转储，以便控制器路由到预先创建的 PVC：

```bash
kubectl apply -f vm-memdump-pvc.yaml
virtctl memory-dump <vm> -n <ns> --claim-name vm-memdump
```

`--claim-name` 将 `VirtualMachine.status.memoryDumpRequest.claimName` 填充为预先存在的 PVC；不会调用 `--create-claim` 将采取的自动调整路径，因此 PVC 的容量为上述清单声明的容量。

在解决即时转储问题的同时，如果虚拟机缺少客户机内存声明，也要修复基础的虚拟机：设置 `spec.template.spec.domain.memory.guest`（或至少设置 `spec.template.spec.domain.resources.requests.memory`），以便将来任何 `--create-claim` 调用都有一个定义的 RAM 大小作为自动调整的基础。

## 诊断步骤

确认失败是这里描述的 `ENOSPC` 路径，而不是无关的转储错误。检查虚拟机上的失败消息和相应的 VMI 卷状态：

```bash
# 控制器在 libvirt 报告转储错误后写入的失败文本
kubectl get vm <vm> -n <ns> \
  -o jsonpath='{.status.memoryDumpRequest.message}{"\n"}'

# 每个 VMI 的热插拔转储卷及其目标文件名的视图
kubectl get vmi <vm> -n <ns> \
  -o jsonpath='{range .status.volumeStatus[?(@.memoryDumpVolume)]}{.name}{"\t"}{.memoryDumpVolume.targetFileName}{"\n"}{end}'
```

消息应与本文的签名匹配 — `Domain memory dump failed: virError(...) ... Unable to write ...memory.dump: No space left on device`。如果消息不同（例如，`AttachHotplugVolume` 失败、CDI 填充程序失败或 `permission denied`），则本文不适用。

检查虚拟机是否实际声明了客户机内存，因为这决定了 `--create-claim` 是否会在下次尝试时选择合理的自动大小：

```bash
kubectl get vm <vm> -n <ns> -o jsonpath='\
guest:    {.spec.template.spec.domain.memory.guest}{"\n"}\
requests: {.spec.template.spec.domain.resources.requests.memory}{"\n"}'
```

如果两个字段都为空，则 VM 没有声明的 RAM 大小，`--create-claim` 的大小回退是根本原因；在重新运行转储之前修正规格。

捕获转储 PVC 将受到的有效文件系统开销值。这是进入大小公式的 `(1 + OVERHEAD)` 项的常量，并不一定是 `0.07`；上游 CDI 默认值为 `0.06`，有效值可以按 StorageClass 重写：

```bash
# 每个 StorageClass 的有效值，加上全局默认值
kubectl get cdiconfig config \
  -o jsonpath='{.status.filesystemOverhead}{"\n"}'

# CRD 级别的默认值（文档“如果未定义，则为 0.06（6% 开销）”）
kubectl explain cdi.spec.config.filesystemOverhead | sed -n '1,20p'
```

在使用默认开销的集群中，使用 `topolvm-hdd` StorageClass 的示例输出：

```text
{"global":"0.06","storageClass":{"topolvm-hdd":"0.06"}}
```

如果转储 PVC 被配置为 `volumeMode: Block` 而不是 `Filesystem`，则不保留开销，大小公式简化为 `MEMORY + 100 MiB`。通过 StorageProfile 检查 StorageClass 的有效卷模式，以了解适用的情况：

```bash
kubectl get storageprofile <dump-sc> \
  -o jsonpath='{.status.claimPropertySets}{"\n"}'
```

`claimPropertySets` 条目为 `{"accessModes":["ReadWriteOnce"],"volumeMode":"Filesystem"}` 确认转储 PVC 采用开销路径；条目为 `"volumeMode":"Block"` 确认它不采用开销路径。
