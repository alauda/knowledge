---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.1.x
id: KB261000012
sourceSHA: 315f7c3bc1c074b01d8c9ed85979d79855f084ddf40e0d323624203e46565468
---

# 在 ACP 上重新安装节点操作系统时保留 KubeVirt 虚拟机的 TopoLVM 数据

## 问题

业务集群的节点必须迁移到不同的操作系统，例如因为 CentOS 7 不再在支持的基线中。集群中的 KubeVirt 虚拟机将其磁盘存储在 TopoLVM 本地存储上。TopoLVM 卷是本地于节点的，因此这些虚拟机无法进行在线迁移，必须在处理节点时停止。

此解决方案逐个处理节点：

- **主要路径：仅重新安装系统磁盘并保留数据。** TopoLVM 卷是数据磁盘上的卷组（VG）中的逻辑卷（LV），LVM 元数据存储在数据磁盘上。如果重新安装不影响数据磁盘，并且节点以其原始主机名和 IP 地址重新加入集群，则 Kubernetes 中的 PVC、PV 和 LogicalVolume 对象仍指向原始 LV，虚拟机可以在其原始 PVC 上启动。
- **安全网：在重新安装之前将虚拟机磁盘克隆到 Ceph RBD。** 如果数据磁盘被错误擦除，可以恢复 Ceph 副本。
- **后备方案：如果数据磁盘丢失，从 Ceph 克隆磁盘回到 TopoLVM。**

对于每个节点，停机时间主要包括将磁盘克隆到 Ceph 的时间和重新安装节点及将其添加回的时间。在主要路径上，无需克隆数据。

## 环境

此解决方案适用于带有 TopoLVM 和 KubeVirt 的 Alauda Container Platform 4.1.x。通过将节点从 CentOS 7.9 移动到 RHEL 9.6，已在 ACP 4.1.7 上进行了端到端验证，涵盖了主要路径和后备路径。

## 先决条件

在开始之前，请确认以下每一项：

1. **要重新安装的节点角色。** 如果包含任何控制平面节点，您还必须恢复 Kube-OVN 控制平面成员资格（步骤 9），并且必须一次只处理一个控制平面节点。工作节点不需要此步骤。
2. **目标操作系统及版本受当前 ACP 版本支持。** 首先更改当前 ACP 版本上所有节点的操作系统，然后再升级 ACP。
3. **安装方法可以仅重新安装系统磁盘。** 安装程序、安装模板或虚拟化平台的“重新安装”功能不得擦除、重新创建或替换数据磁盘。如果只能进行完整机器重建，则主要路径不可用，您必须使用后备路径。
4. **TopoLVM 数据磁盘布局。** 记录每个节点上构成 VG 的磁盘。VG 跨多个磁盘的节点在设备名称更改时风险更高（见步骤 6）。
5. **Ceph RBD 备份容量。** 可用容量（复制后）必须至少等于一个节点上 TopoLVM 虚拟机磁盘的总大小。一次备份一个节点，并在接受后释放空间。
6. **停机窗口。** 一个节点的停机时间大致为：备份克隆时间 + 移除、重新安装和添加节点的时间 + 验证时间。在后备路径上，增加一次克隆回到 TopoLVM 的时间。克隆速度取决于 TopoLVM 磁盘和 Ceph 的性能，因此首先用一个虚拟机进行测量，并根据每个节点上的数据量进行估算。
7. **节点上未设置 TopoLVM 节点终结器。** 否则，删除 Node 对象也会删除该节点上的 TopoLVM PVC：

   ```bash
   kubectl get node -o custom-columns=NAME:.metadata.name,FINALIZERS:.metadata.finalizers
   ```

   输出中不得包含 `topolvm.cybozu.com/node`。

## 解决方案

以下步骤适用于单个节点，称为 `<node>`。完成并接受一个节点后再开始下一个。

### 1. 记录节点状态

在重新安装之前，将以下信息保存到节点外部的位置：

```bash
NODE=<node>
mkdir -p backup-$NODE && cd backup-$NODE

# 节点对象：标签和污点（在节点重新添加时会丢失）
kubectl get node $NODE -o yaml > node.yaml

# 该节点上 TopoLVM 卷与 PV 的映射
kubectl get pv -o json | jq -r --arg n "$NODE" '.items[]
  | select(.spec.csi.driver=="topolvm.cybozu.com")
  | select(.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]==$n)
  | [.spec.claimRef.namespace, .spec.claimRef.name, .metadata.name, .spec.csi.volumeHandle] | @tsv' > pv-lv-map.tsv
kubectl get logicalvolume -o yaml > logicalvolumes.yaml

# TopoLVM 和 Ceph 的设备配置
kubectl get topolvmcluster -A -o yaml > topolvmcluster.yaml
kubectl get cm -n nativestor-system lvmdconfig-$NODE -o yaml > lvmdconfig.yaml
kubectl get cephcluster -A -o yaml > cephcluster.yaml 2>/dev/null

# 在该节点上运行的虚拟机
kubectl get vmi -A -o wide | awk -v n="$NODE" 'NR==1 || $0 ~ n' > vmi-on-node.txt
```

在节点上运行以下命令并保存输出：

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE
blkid
ls -l /dev/disk/by-id/ /dev/disk/by-path/
pvs; vgs -o +vg_uuid; lvs -o +lv_uuid
# 导出每个 VG 的元数据备份
for vg in $(vgs --noheadings -o vg_name); do vgcfgbackup -f /root/$vg.vg $vg; done
```

将 `/root/*.vg` 复制到节点外部的位置。

### 2. 停止虚拟机并将其磁盘备份到 Ceph RBD

逐个停止该节点上的虚拟机。使用平台控制台的 **停止** 按钮，或使用 kubectl：

```bash
kubectl patch vm <vm> -n <namespace> --type=merge -p '{"spec":{"running":false}}'
kubectl wait vmi <vm> -n <namespace> --for=delete --timeout=10m
```

对于虚拟机的每个 TopoLVM 磁盘，创建一个 DataVolume，将其克隆到 Ceph RBD。使用与源磁盘相同的 `volumeMode`：

```yaml
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata:
  name: bak-<source-pvc>
  namespace: <namespace>
spec:
  source:
    pvc:
      namespace: <namespace>
      name: <source-pvc>
  storage:
    storageClassName: <ceph-rbd-storageclass>
    volumeMode: <Block-or-Filesystem>
    accessModes: [ReadWriteOnce]
    resources:
      requests:
        storage: <source-size>
```

等待所有克隆完成：

```bash
kubectl get dv -n <namespace> -w    # 每个 PHASE 都是 Succeeded
```

**保留原始的 TopoLVM PVC 和 PV。不要删除它们。**

建议进行抽查，以确认一个虚拟机的备份可用：将备份再克隆到临时磁盘，将其附加到另一个节点上的临时虚拟机，确认虚拟机可以启动，然后删除临时虚拟机。

### 3. 继续之前检查

仅在以下所有条件都为真时继续：

- 此节点上的所有虚拟机均已停止。
- 所有备份 DataVolumes 状态为 `Succeeded`。
- 步骤 1 中记录的节点状态已保存到节点外部。

### 4. 从平台中移除节点

按照标准程序从平台中移除 `<node>`。**先移除节点，然后再重新安装操作系统。** 不要反转此顺序。

在节点被移除后，`nativestor-system` 命名空间中的 PVC、PV 和 LogicalVolume 对象以及 `lvmdconfig-<node>` 会被保留。**不要手动删除它们。**

对于控制平面节点，移除后检查 Kube-OVN 控制平面是否仍然具有法定人数：

```bash
kubectl get pod -n kube-system -l app=ovn-central -o wide
kubectl get deploy -n kube-system ovn-central \
  -o jsonpath='{.spec.replicas} {.spec.template.spec.containers[0].env[?(@.name=="NODE_IPS")].value}{"\n"}'
```

### 5. 仅在系统磁盘上重新安装操作系统

- 仅在系统磁盘上安装新操作系统。
- 在安装程序中排除所有数据磁盘。如果可能，在安装期间分离数据磁盘。
- 保持原始主机名和 IP 地址。TopoLVM PV 通过节点亲和性绑定到节点名称，在 ACP 中，节点名称通常是节点 IP。如果节点名称更改，则原始 PV 将无法再调度到该节点。

### 6. 在添加节点之前：检查数据磁盘

在新操作系统上运行以下命令：

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE
blkid
pvs; vgs; lvs
```

检查每个项目：

1. **VG 和 LV 存在并与步骤 1 中的记录匹配。** 如果 `vgs` 不显示 TopoLVM VG，请检查 LVM 设备文件（`/etc/lvm/devices/system.devices`）是否启用。如果启用，请使用 `vgimportdevices <vg>` 导入 VG。

2. **设备名称是否更改。** 重新安装后，数据磁盘的设备名称可能会更改（例如，两个数据磁盘 `vdb` 和 `vdc` 被交换）。当磁盘没有序列号时，`by-path` 名称也会更改。**通过内容识别每个磁盘：** 对于 TopoLVM，PV 在 `pvs` 中持有 VG；对于 Ceph OSD，`blkid` 中的 `ceph_bluestore` 类型。

3. **如果设备名称更改，在添加节点之前更正存储配置：**

   ```bash
   # TopoLVM：在 deviceClasses 中将该节点的设备更改为新设备名称
   kubectl edit topolvmcluster -n nativestor-system <name>
   # Rook-Ceph（如果 Ceph 在该集群的节点上运行）：将该节点的 storage.nodes[].devices 更改为新设备名称
   kubectl edit cephcluster -n rook-ceph <name>
   ```

   > **警告**：如果在未更正此项的情况下添加节点，TopoLVM 操作员会检查 VG 是否与旧设备名称匹配。如果 VG 中没有 PV 在配置中，并且其数量与配置不同，操作员将删除整个 VG（`vgremove`）。特别注意 VG 跨多个磁盘的节点。

4. **数据磁盘被擦除**（`pvs` 为空且 `blkid` 不输出任何内容）：主要路径不可用。请转到 [后备方案：当数据磁盘丢失时从 Ceph 恢复](#fallback-restore-from-ceph-when-the-data-disks-are-lost)。

### 7. 以原始角色将节点添加回去

将节点以其原始主机名、原始 IP 地址和原始角色（控制平面或工作节点）添加回集群。

### 8. 恢复污点、虚拟化开关和自定义标签

当节点被添加回时，其 Node 对象会被重新创建。节点上设置的污点和标签会丢失，控制平面节点可能会获得默认污点。与步骤 1 中保存的 `node.yaml` 进行比较：

| 项目                                            | 操作                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 污点                                          | 恢复重新安装前的状态。例如，如果 `node-role.kubernetes.io/control-plane:NoSchedule` 在之前不存在，但在节点添加回后出现，则将其删除。否则，virt-handler 将无法调度到该节点，虚拟机无法启动。 |
| 虚拟化开关 (`vm.cpaas.io/baremetal`) | 在平台控制台的节点页面上再次启用虚拟化开关。                                                                                                                                                                                        |
| 自定义标签                                   | 如果虚拟机的 `nodeSelector` 或亲和性引用自定义节点标签，请将标签添加回。                                                                                                                                                                            |

以下标签由组件自动生成，**不需要**恢复：

- `topology.topolvm.cybozu.com/node`：在 TopoLVM CSI 驱动程序在节点上注册后生成。
- `kubevirt.io/schedulable`、`cpu-model.node.kubevirt.io/*` 和类似标签：在 virt-handler 启动后生成。

删除添加的污点的示例（仅当节点在重新安装前没有该污点时）：

```bash
kubectl taint node <node> node-role.kubernetes.io/control-plane:NoSchedule-
```

确认 virt-handler 在节点上运行，并且节点暴露 KVM 资源：

```bash
kubectl get pod -n kubevirt -o wide | grep <node>
kubectl get node <node> -o jsonpath='{.status.allocatable.devices\.kubevirt\.io/kvm}{"\n"}'
```

### 9. 仅控制平面节点：恢复 Kube-OVN 控制平面成员资格

**仅对控制平面节点执行此步骤。** 在 ACP 4.1 中，从平台中移除控制平面节点也会将其从 OVN 数据库集群（`ovn-central`）中移除，但 **将节点添加回并不会将其添加回 OVN 数据库集群**。如果没有此步骤，OVN 数据库集群每次都会失去一个成员。当第二个控制平面节点被处理时，集群失去法定人数，新的 Pod 将无法获取网络地址。

此步骤应由负责网络或 Kube-OVN 的人员执行或指导：

1. 将节点添加到 `ovn-central` 的 `NODE_IPS` 中，并将副本数恢复到控制平面节点的数量。
2. 更新以下组件的 `OVN_DB_IPS` 为所有控制平面节点的 IP：`kube-ovn-controller`、`ovn-ic-controller` 和 `ovs-ovn`。

这些工作负载由平台的 Kube-OVN 图表管理。当它们被手动修改时，平台会创建 ResourcePatch 以保持更改。**检查生成的 ResourcePatch 的内容**：它也可以固定其他字段，例如更改时的副本数。

> 更改 `ovs-ovn` 会以滚动方式重启每个节点上的 OVS，该节点的网络会短暂中断。此项未在验证环境中测试。

验证：

```bash
P=$(kubectl get pod -n kube-system -l app=ovn-central -o name | head -1)
kubectl exec -n kube-system $P -- ovs-appctl -t /var/run/ovn/ovnnb_db.ctl cluster/status OVN_Northbound
kubectl exec -n kube-system $P -- ovs-appctl -t /var/run/ovn/ovnsb_db.ctl cluster/status OVN_Southbound
```

`Servers` 必须列出所有控制平面节点，并且必须存在一个领导者。

### 10. 验证存储

```bash
# TopoLVM 节点组件正常运行，节点状态为 Ready
kubectl get pod -n nativestor-system -o wide | grep <node>
kubectl get topolvmcluster -n nativestor-system -o jsonpath='{range .items[*].status.nodeStorageState[*]}{.node} {.phase}{"\n"}{end}'

# 步骤 1 中记录的 LogicalVolumes 仍然存在
kubectl get logicalvolume -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,VOLID:.status.volumeID | grep <node>

# Ceph（如果在该集群中运行）：原始 OSD 再次启动且未创建新 OSD
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

### 11. 在原始 PVC 上启动虚拟机

在不更改其磁盘配置的情况下启动虚拟机。使用控制台中的 **启动**，或使用 kubectl：

```bash
kubectl patch vm <vm> -n <namespace> --type=merge -p '{"spec":{"running":true}}'
kubectl get vmi -n <namespace> -o wide
```

确认虚拟机在 `<node>` 上运行，并完成工作负载验证。

### 12. 删除备份

在工作负载被接受后，删除该节点虚拟机在 Ceph 上的备份 DataVolumes，以释放空间供下一个节点使用：

```bash
kubectl delete dv -n <namespace> bak-<source-pvc>
```

### 后备方案：当数据磁盘丢失时从 Ceph 恢复

如果步骤 6 显示数据磁盘被擦除，请使用以下步骤。

#### A. 恢复 TopoLVM

在节点添加回后，`lvmdconfig-<node>` 中的 `status.json` 仍记录旧 VG 为就绪。操作员不会重新创建 VG，topolvm-node 会持续崩溃循环。删除此记录，以便操作员在空磁盘上重新创建 VG：

```bash
kubectl get cm -n nativestor-system lvmdconfig-<node> -o yaml > lvmdconfig-before-fix.yaml
kubectl patch cm -n nativestor-system lvmdconfig-<node> --type=json \
  -p '[{"op":"remove","path":"/data/status.json"}]'
```

等待 `status.json` 再次出现，并且 `successClasses` 下的 VG 为 `Ready`。

如果 `status.json` 报告 `disk may has filesystem or is not raw disk`，并且节点上的 `pvs` 仅显示一个 PV 而没有 VG，则之前的创建停止在一半。确认 PV 不持有 VG 后，运行 `pvremove /dev/<disk>` 并再次删除 `status.json`。

#### B. 从 Ceph 克隆回 TopoLVM

对于每个备份，创建一个 DataVolume，将其克隆到 TopoLVM：

```yaml
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata:
  name: rst-<source-pvc>
  namespace: <namespace>
spec:
  source:
    pvc:
      namespace: <namespace>
      name: bak-<source-pvc>
  storage:
    storageClassName: <topolvm-storageclass>
    volumeMode: <Block-or-Filesystem>
    accessModes: [ReadWriteOnce]
    resources:
      requests:
        storage: <source-size>
```

TopoLVM StorageClass 使用 `WaitForFirstConsumer`，因此 DataVolume 在 Pod 或 VM 使用之前保持在 `PendingPopulation` 状态。

#### C. 将虚拟机切换到恢复的磁盘

更改虚拟机，使其磁盘引用 `rst-*` DataVolumes。如果虚拟机使用 `dataVolumeTemplates`，还需删除旧模板，以便磁盘不会从旧模板再次导入。使用 `nodeSelector` 将虚拟机固定到 `<node>`，以便其所有磁盘都在同一节点上创建：

```bash
kubectl patch vm <vm> -n <namespace> --type=json -p '[
 {"op":"replace","path":"/spec/dataVolumeTemplates","value":[]},
 {"op":"replace","path":"/spec/template/spec/volumes","value":[
   {"name":"<root-volume>","dataVolume":{"name":"rst-<root-pvc>"}},
   {"name":"<data-volume>","dataVolume":{"name":"rst-<data-pvc>"}}]}]'
```

然后按照步骤 11 中的描述启动虚拟机。

保留虚拟机的所有其他卷（cloud-init、Secrets 等）。在更改中不要删除它们。

#### D. 清理过时对象

在虚拟机正常运行后，删除指向不再存在的 LVs 的旧 PVC 及其旧 DataVolumes。PV 和 LogicalVolumes 会自动清理：

```bash
kubectl delete dv -n <namespace> <old-dv>
kubectl delete pvc -n <namespace> <old-pvc>
```

#### E. 当 Ceph 在该集群的节点上运行时

如果 Ceph OSD 磁盘也被擦除，Rook 会在空磁盘上创建新的 OSD，并重新创建该节点的 mon。在集群返回到 `HEALTH_OK` 后，删除过时的旧 OSD：

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd safe-to-destroy osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge <id> --yes-i-really-mean-it
kubectl -n rook-ceph delete deploy rook-ceph-osd-<id>
```

## 风险与回滚

| 风险                                                                                                           | 缓解措施                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 在重新安装期间数据磁盘被擦除                                                             | 步骤 2 中的 Ceph 备份；遵循后备路径                                                            |
| 重新安装后设备名称更改，操作员在错误磁盘上操作                            | 在添加节点之前检查并更正存储配置（步骤 6）                                 |
| 控制平面节点被移除后 OVN 数据库集群失去法定人数，集群网络失败 | 一次处理一个控制平面节点；在下一个节点之前恢复 OVN 成员资格（步骤 9）                |
| 添加节点后添加污点或虚拟化开关关闭，导致虚拟机无法调度  | 在步骤 1 中保存 `node.yaml` 并在步骤 8 中恢复                                                                 |
| 监控组件的本地卷在重新安装的节点上                                     | Prometheus 和 Alertmanager 的历史数据丢失，节点离线时监控不可用 |

回滚：如果任何步骤失败，Ceph 上的备份是可用的恢复点。在备份验证之前不要触碰节点，并且在工作负载被接受之前不要删除备份。
