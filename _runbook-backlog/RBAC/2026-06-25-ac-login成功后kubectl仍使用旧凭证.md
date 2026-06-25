---
tags: [incident]
date: 2026-06-25
component: "RBAC"
fault_type: "RBAC/kubeconfig/旧凭证未刷新"
symptom: "执行 ac login 认证成功后，kubectl 访问集群仍提示 the server has asked for the client to provide credentials"
root_cause: "kubeconfig 中已存在同名 session/context，导致 ac login 虽认证通过但新 token 未正确写入，kubectl 仍继续使用旧凭证"
runbook: ""
branch: ""
source_path: ""
affected_versions: []
---
# ac login 成功后 kubectl 仍使用旧凭证

## 现象
- 执行 `ac login` 认证成功后，继续使用 `kubectl` 访问集群仍提示凭证异常。
- 报错信息包含 `the server has asked for the client to provide credentials`，表现为 `kubectl` 仍在使用旧凭证。
- 在执行登录成功后，节点上的 kubeconfig 并未同步切换到新的认证上下文，因此集群访问仍然失败。

## 排查过程与命令
- 首先查看报错信息，确认问题发生在 `kubectl` 获取 API group list 阶段，错误指向客户端未提供有效凭证。
- 随后执行 `ac login --idp='ncbank' ...`，虽然命令提示登录成功，但同时出现 `session already exists`，说明节点 kubeconfig 中已经存在同名 session/context，新 token 未正确写入。
- 为确认当前 kubeconfig 的实际内容，检查现有 `context` 与 `user`：
  ```bash
  kubectl config get-contexts
  kubectl config get-users
  ```
- 根据实际名称删除冲突配置，清理旧的 `user` 与 `context`。操作时注意不要删除 `kubernetes-admin`：
  ```bash
  kubectl config delete-user <user-name>
  kubectl config delete-context <context-name>
  ```
- 清理冲突项后，重新执行登录：
  ```bash
  ac login --idp='ncbank' ...
  ```
- 再通过以下命令确认当前上下文：
  ```bash
  kubectl config current-context
  ```
- 如当前上下文仍未切换到预期值，则手动切换到正确的 `context`：
  ```bash
  kubectl config use-context <context-name>
  ```
- 完成上述处理后，`kubectl` 可正常使用新凭证访问集群，说明故障根因确实是 kubeconfig 中的同名 session/context 冲突。

## 根因与修复方案
- **根因**
  - 节点 kubeconfig 中已存在同名 `session/context`。
  - `ac login` 虽然认证成功，但新 token 未正确写入，`kubectl` 仍继续使用旧凭证。
- **临时缓解方案**
  - 删除冲突的 `user` 与 `context` 配置。
  - 重新执行 `ac login`。
  - 必要时通过 `kubectl config use-context` 切换到正确的上下文。
- **根本解决方案**
  - 在登录前或登录流程中增加对同名 `session/context` 的检测与清理机制，避免新 token 被旧 kubeconfig 配置覆盖。
  - 对 kubeconfig 的 context/user 命名与刷新流程做规范化，减少凭证残留导致的认证异常。
