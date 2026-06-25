---
tags: [incident]
date: 2026-06-25
component: "容器网络"
fault_type: "容器网络/Calico/xtables锁文件权限异常"
symptom: "calico-node 处于 Running (0/1) 状态，未成功就绪"
root_cause: "主机侧 /run/xtables.lock 被删除或重建后权限变为 0600，导致 calico-node 无法访问锁文件并持续启动失败"
runbook: ""
branch: ""
source_path: ""
affected_versions: []
---
# calico-node Running (0/1) 未就绪

## 现象
- `calico-node` 处于 `Running (0/1)` 状态，组件未成功就绪。
- 查看相关日志可见 `Failed to program iptables`，同时 `felix` 持续重试失败，导致 `readiness` 探针始终无法通过。
- 故障恢复后验证该节点 Pod 到其他节点 Pod 的跨节点流量正常，说明问题集中在 `calico-node` 启动阶段的 dataplane 初始化，而非业务流量本身长期异常。

## 排查过程与命令
- 首先查看 `calico-node` 日志，发现核心报错为 `Failed to program iptables`，并伴随 `felix` 持续重试失败。基于这一现象，可以判断问题位于 Calico dataplane 初始化阶段，而不是 Pod 调度或镜像拉取阶段。
- 继续排查后确认，异常节点无法正常访问主机侧 `/run/xtables.lock`，导致 `felix` 无法完成 dataplane sync，`readiness` 探针因此无法通过。
- 同时检查现场是否存在与 Calico 相关的 `rpch` 干扰因素，结果未发现相关异常，可排除该方向。
- 随后对比正常节点与异常节点的 `/run/xtables.lock` 文件状态，发现异常节点上的该文件为新生成文件，且权限不是 `640`；正常节点对应文件权限为 `640`。据此可以将问题进一步收敛到主机侧锁文件权限异常。
- 为恢复组件，在异常节点执行以下命令修正锁文件权限：
  ```bash
  chmod 640 /run/xtables.lock
  ```
- 随后在可执行 `kubectl` 的节点删除故障节点上的 `calico-node` Pod，使其重新拉起：
  ```bash
  kubectl delete pod -n kube-system calico-node-6qjp6
  ```
- `calico-node` 重建后恢复正常，且进一步验证该节点 Pod 到其他节点 Pod 的流量已恢复正常。由此可以确认，本次故障的直接触发点是 `/run/xtables.lock` 权限异常，而不是 Calico 配置本身或网络连通性缺陷。

## 根因与修复方案
- **根因**
  - 主机侧 `/run/xtables.lock` 文件被删除或重新生成后，权限变为默认 `0600`。
  - `calico-node` 无法正常访问该锁文件，导致 `felix` 不能完成 iptables 编程与 dataplane 同步。
  - 最终表现为 `calico-node` 处于 `Running (0/1)` 且持续未就绪。
- **临时缓解方案**
  - 将 `/run/xtables.lock` 权限调整为 `640`。
  - 删除并重建故障节点上的 `calico-node` Pod，使其重新完成初始化。
- **根本解决方案**
  - 排查并修复导致 `/run/xtables.lock` 被删除或以错误权限重建的宿主机侧机制，避免 Calico 锁文件再次出现权限漂移。
  - 将宿主机关键网络锁文件权限检查纳入节点巡检或 Calico 故障排查流程，提前发现并处理权限异常。
