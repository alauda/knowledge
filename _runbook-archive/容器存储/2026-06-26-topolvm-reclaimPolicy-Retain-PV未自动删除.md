---
tags: [incident]
date: 2026-06-26
component: "容器存储"
fault_type: "容器存储/topolvm/PV回收未自动释放"
symptom: "topolvm 的 StorageClass 配置 reclaimPolicy: Retain 后，Pod 和 PVC 删除后 PV 未自动删除，仍以 Released 状态留存在集群中"
root_cause: "StorageClass 采用 reclaimPolicy: Retain，导致 PVC 删除后 PV 保留为 Released 状态，底层 logicalvolume 和节点 LV 不会自动释放"
runbook: "[[容器存储-topolvm-PVReleased后不自动释放-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# topolvm 的 StorageClass 配置 reclaimPolicy: Retain 后 PV 未自动删除

## 现象
- `topolvm` 的 `StorageClass` 配置 `reclaimPolicy: Retain` 后，`Pod` 和 `PVC` 删除后 `PV` 未自动删除。
- 相关 `PV` 仍以 `Released` 状态留存在集群中，存储空间未释放。
- 现场确认：`reclaimPolicy: Delete` 的资源会由后台自动回收，而 `reclaimPolicy: Retain` 的资源需要手动清理。

## 排查过程与命令
- 首先核对 `StorageClass` 的回收策略，确认 `reclaimPolicy: Delete` 与 `reclaimPolicy: Retain` 的行为差异，判断当前 `PV` 未释放并非异常，而是回收策略本身决定的结果。
- 找到需要释放的 `PV` 后，记录其名称，作为后续定位底层资源的关键输入。
- 通过以下命令检查是否存在对应的 `logicalvolume` 资源：
  ```bash
  kubectl get logicalvolume -A | grep <pv名>
  ```
- 若存在对应 `logicalvolume`，则执行删除：
  ```bash
  kubectl delete logicalvolume <资源名（一般也就是pv名称）>
  ```
- 随后在平台上删除对应 `PV`，使集群侧对象与底层存储资源的清理动作保持一致。
- 如需验证底层空间是否真正释放，可在 `PV` 的 YAML 中查看 `volumeHandle` 和 `nodeAffinity`，确认节点上的 `LV` 名称及所在节点。
- 登录对应节点后执行：
  ```bash
  lvs -o lvname,lvpath,lv_size | grep <volumeHandle的值>
  ```
  若无输出，则表示 `LV` 已释放；若仍有输出，则表示底层空间尚未释放。
- 如仍需继续核查，可通过以下命令检查 `VG`、`LV` 状态及残留情况：
  ```bash
  lvs -o lvname,vgname | grep <lv名>
  lvs -o lvname,vgname | grep <vg名>
  lvs -o lvname,lvattr,devices <vg_name>
  ```
- 综合排查结果可以确认：`PV` 保留在 `Released` 状态时，不会自动回收底层 `logicalvolume` 和节点 `LV`，需要按资源链路逐层手动清理。

## 根因与修复方案
- **根因**
  - `topolvm` 的 `StorageClass` 使用 `reclaimPolicy: Retain`。
  - `PVC` 删除后，`PV` 保留为 `Released` 状态，不会自动释放底层 `logicalvolume` 和节点 `LV`。
- **临时缓解方案**
  - 手动删除对应的 `logicalvolume`。
  - 在平台上删除对应 `PV`。
- **根本解决方案**
  - 对 `reclaimPolicy: Retain` 的存储资源建立标准化清理流程，确保 `PV`、`logicalvolume` 与节点 `LV` 能按预期同步释放。
  - 在存储回收操作中增加底层资源核查步骤，避免仅删除 `PVC/PV` 后造成空间残留。
