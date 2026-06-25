---
tags: [runbook]
domain: GitOps
component: argocd/gitops
fault_type: GitOps/版本兼容性/插件包不匹配
symptom: argocd 单点登录失败，GitOps 应用页面空白
last_updated: 2026-06-26
source_incidents: 1
affected_versions: [v4.1]
---
# GitOps-argocd单点登录失败与页面空白-排查手册

## 适用现象
- `argocd` 单点登录失败
- 容器平台 `GitOps 应用` 创建页面前端空白
- 同一问题在特定 ACP 版本复现，而高版本环境正常

## 标准排查路径
1. 确认平台版本与 `argocd/gitops` 组件版本组合。
2. 对比可复现环境与正常环境，判断是否为兼容性问题。
3. 核对上传到 `ac` 的安装包版本是否匹配平台版本。
4. 按兼容矩阵回退或重装 GitOps 组件。

## 分支判断
- 如果 `argocd` 单点登录失败且页面也异常，优先考虑 **统一的版本兼容性问题**。
- 如果只有页面异常、SSO 正常，再单独排查前端渲染或 API 问题。

## 标准处置步骤
1. 确认当前 ACP 版本。
2. 核对当前安装的 `gitops` 插件版本与 `argocd-operator` 版本。
3. 如版本不兼容，回退到平台支持的组合。
4. 验证 `argocd` 单点登录与 `GitOps 应用` 页面均恢复正常。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| 单点登录失败且页面空白 | `argocd + gitops` 包版本与 ACP 平台版本不匹配 | 回退并重装兼容版本组合 | [[2026-06-26-argocd-单点登录失败且GitOps应用页面空白]] |

## 不适用场景
- 单独的 SSO 配置错误
- 前端静态资源损坏问题

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
