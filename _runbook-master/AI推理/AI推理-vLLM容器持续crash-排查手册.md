---
tags: [runbook]
domain: AI推理
component: vllm/nccl
fault_type: AI推理/vLLM/NCCL通信与custom-all-reduce初始化失败
symptom: vLLM 容器持续 crash，TP worker 报 Parent process exited
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# AI推理-vLLM容器持续crash-排查手册

## 适用现象
- `vLLM` 容器持续 `crash`
- 日志显示 `vLLM EngineCore v1` 多进程初始化失败
- 所有 `TP worker` 报 `Parent process exited`
- 常见报错包含 `NCCL error: unhandled system error` 或 `CUDA error: invalid argument`

## 标准排查路径
1. 先查看容器日志，定位父进程退出前的首个致命报错。
2. 若出现 `NCCL error: unhandled system error`，先检查是否过度禁用了 NCCL 通信方式。
3. 若 NCCL 恢复后出现 `CUDA error: invalid argument`，继续检查 `custom-all-reduce` 初始化路径。
4. 若日志出现 `orionpool.cc` 或 `INITNCCLFUNCTION failed`，确认是否运行在 `Orion` 虚拟 GPU 环境。
5. 在虚拟 GPU 场景下评估是否需要使用 `--disable-custom-all-reduce` 让 NCCL 接管 AllReduce。

## 分支判断
- 如果日志直接报 `NCCL error: unhandled system error`，优先进入 **分支 A：NCCL 通信配置异常**。
- 如果 NCCL 恢复后继续报 `CUDA error: invalid argument`，进入 **分支 B：custom-all-reduce 与虚拟 GPU 不兼容**。

## 标准处置步骤
1. 核对并恢复必要的 NCCL 通信方式，避免同时禁用 `P2P`、`SHM`、`IB`。
2. 重启容器，确认是否仍在初始化阶段失败。
3. 如果确认运行在 `Orion` 虚拟 GPU 且 `custom-all-reduce` 失败，在启动参数中增加 `--disable-custom-all-reduce`。
4. 再次启动并确认 `TP worker` 不再退出、服务恢复正常。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| 分支 A：NCCL 初始化失败 | 同时禁用了多种 NCCL 通信方式，初始化阶段无法建立正常通信链路 | 恢复必要 NCCL 通信配置 | [[2026-06-26-vLLM容器持续crash且TPworker退出]] |
| 分支 B：custom-all-reduce 初始化失败 | Orion 虚拟 GPU 对 CUDA IPC 透传支持不完整，导致 custom-all-reduce 无法初始化 | 增加 `--disable-custom-all-reduce`，让 NCCL 接管 AllReduce | [[2026-06-26-vLLM容器持续crash且TPworker退出]] |

## 不适用场景
- 非 `vLLM` 推理容器问题
- 纯镜像拉取或调度失败类问题

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
