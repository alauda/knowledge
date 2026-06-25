---
tags: [runbook]
domain: 容器存储
component: topolvm/lvm
fault_type: 容器存储/topolvm/PV回收未自动释放
symptom: topolvm 的 StorageClass 配置 reclaimPolicy: Retain 后，PV Released 且空间未释放
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 容器存储-topolvm-PVReleased后不自动释放-排查手册

## 适用现象
- `PVC` 删除后 `PV` 仍为 `Released`
- 底层存储空间未释放
- `StorageClass` 使用 `reclaimPolicy: Retain`

## 标准排查路径
1. 先确认 `StorageClass.reclaimPolicy`。
2. 若为 `Retain`，判断是否为预期行为而非组件故障。
3. 定位对应 `PV`。
4. 检查 `logicalvolume`。
5. 在节点上核查底层 `LV/VG` 是否仍存在。

## 分支判断
- 如果 `reclaimPolicy: Delete`，应排查自动回收异常。
- 如果 `reclaimPolicy: Retain`，进入 **手动清理分支**。

## 标准处置步骤
1. 记录 `PV` 名称。
2. 执行 `kubectl get logicalvolume -A | grep <pv名>`。
3. 删除对应 `logicalvolume`。
4. 在平台删除对应 `PV`。
5. 在节点执行 `lvs` 检查底层资源是否释放。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| PV Released 后未自动释放 | `reclaimPolicy: Retain` 不自动回收底层卷 | 手动删除 `logicalvolume` 与 `PV` | [[2026-06-26-topolvm-reclaimPolicy-Retain-PV未自动删除]] |

## 不适用场景
- Ceph 容量展示问题
- diskmaker-discovery Pod 异常

## 全量历史案例

```dataview
TABLE WITHOUT ID
  file.link AS 案例,
  branch AS 分支,
  date AS 日期,
  join(affected_versions, ", ") AS 版本,
  root_cause AS 根因
FROM "Troubleshooting/_runbook-archive"
WHERE econtains(tags, "incident") AND econtains(file.outlinks, this.file.link)
SORT branch ASC, date DESC
```
