---
tags: [runbook]
domain: 创建集群
component: marketplace/chart
fault_type: 创建集群/marketplace/chart下载失败
symptom: 创建业务集群时 marketplace 卡在 ChartDownloading
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 创建集群-marketplace卡在ChartDownloading-排查手册

## 适用现象
- 创建业务集群时 `marketplace` 卡在 `ChartDownloading`
- `olm/package/market` 相关 Pod 未拉起
- 事件中出现 chart 下载超时或域名解析失败

## 标准排查路径
1. 查看 `ars` 状态与事件。
2. 确认问题发生在 chart 下载阶段，而非 Pod 启动阶段。
3. 关注事件中是否出现 `lookup ... :53 i/o timeout`。
4. 对比正常节点与故障节点的域名解析表现。
5. 用 `nslookup`、`dig`、`telnet dns-ip 53` 验证 DNS 路径。

## 分支判断
- 如果域名解析失败，进入 **DNS 53 端口不通分支**。
- 如果域名解析正常，再排查仓库地址、证书或镜像源问题。

## 标准处置步骤
1. 查看 `ars` 事件确认下载失败原因。
2. 在故障节点执行域名解析验证。
3. 验证到 DNS 服务器 `53` 端口的连通性。
4. 放通网络后重新触发 chart 下载或继续创建流程。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| marketplace 卡在 ChartDownloading | 新建集群节点到 DNS 服务器 53 端口不通，无法解析 `acp.*` 域名 | 放通 DNS 网络后重新推进流程 | [[2026-06-26-创建业务集群时marketplace卡在ChartDownloading]] |

## 不适用场景
- 镜像拉取阶段 `kubeadm init` 卡住
- Chart 仓库认证失败外的其他问题

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
