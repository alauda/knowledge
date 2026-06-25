---
tags: [runbook]
domain: 创建集群
component: kubeadm/containerd
fault_type: 创建集群/kubeadm init/镜像拉取与主机解析异常
symptom: 创建集群时卡在 kubeadm init，节点初始化失败
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 创建集群-kubeadm-init卡住-排查手册

## 适用现象
- 创建集群卡在 `kubeadm init`
- 节点初始化失败
- 同时伴随镜像拉取慢或认证异常

## 标准排查路径
1. 先查镜像拉取链路，重点看 `/etc/containerd/certs.d/.../hosts.toml`。
2. 确认 `http` / `https` 的优先顺序。
3. 核对 `global vip:80` 是否可达并干扰回退逻辑。
4. 再查 `master` 节点 `/etc/hosts` 是否缺少本机解析。
5. 若长时间卡住导致环境污染，再评估重装。

## 分支判断
- 如果镜像拉取先走 `80` 超时，进入 **hosts.toml 优先级分支**。
- 如果日志提示 host 解析失败，进入 **本机 hosts 缺失分支**。

## 标准处置步骤
1. 检查 `hosts.toml` 并调整为优先 `https`。
2. 检查并补充 `/etc/hosts`。
3. 如流程已严重污染，重装后重新创建。
4. 在关键阶段再次确认配置未被回退。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| kubeadm init 卡住 | `hosts.toml` 中 `http` 优先，镜像拉取走 `80` 超时 | 调整为优先 `https` | [[2026-06-26-创建集群时卡在kubeadm-init]] |
| kubeadm init 卡住 | `master` 节点缺少本机 `hosts` 解析 | 补充本机 IP 与主机名映射 | [[2026-06-26-创建集群时卡在kubeadm-init]] |

## 不适用场景
- marketplace ChartDownloading 问题
- 节点添加校验失败问题

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
