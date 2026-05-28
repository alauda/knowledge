---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500282
sourceSHA: 4bc889d17d7af6103c9de527c8790b53f6bf5e26c74d58ca079affa9c410ce92
---

# 识别从 kube-apiserver 审计日志中创建 CronJob 的主体

## 问题

在 Alauda 容器平台上，有时会发现一个意外的 `CronJob` 在某个命名空间中运行，团队需要确定是哪个用户或工作负载创建了它。CronJob 资源本身无法回答这个问题：`kubectl get cronjob` 输出中没有显示创建主体，资源 YAML 中也没有字段标明是谁创建的。CronJob（`cronjobs.batch/v1`，简称 `cj`）仅暴露 `metadata.annotations`、`metadata.creationTimestamp` 和 `metadata.ownerReferences` — 这些都没有记录发出创建请求的认证身份。创建 Kubernetes 对象的身份仅记录在 kube-apiserver 审计日志中，而不在对象本身中；对象的 `managedFields` 跟踪字段管理者和操作，但从不记录认证主体，因此只能从审计记录中恢复创建者。

## 根本原因

当 API 请求与活动审计策略匹配时，kube-apiserver 会将该请求记录为审计事件，而该事件 — 而不是存储的对象 — 是请求身份的权威来源。在此平台上，审计默认启用，apiserver 配置为 `--audit-log-format=json`，因此日志是一个 JSON 行记录流，每一行都是一个 `audit.k8s.io/v1` 的 `Event`，携带请求的 `user`、`verb` 和 `objectRef`。生成 CronJob 的创建请求可以从此日志中恢复，前提是活动审计策略在记录请求用户的级别（元数据级别或更高）上记录 `cronjobs` 的 `create` 事件；当满足此条件时，匹配事件的 `user.username` 字段标识了发出请求的主体。

## 解决方案

在访问 kube-apiserver 审计日志的情况下 — 这是一个 JSON 行流，每一行都是一个 `audit.k8s.io/v1` 的 `Event` — 通过隔离创建 CronJob 的事件并读取其 `user.username` 字段来恢复创建者。这一点已在运行镜像为 `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`（Kubernetes `v1.34.5`）的 kube-apiserver 上得到确认。

每个审计事件都包括一个 `verb` 字段，命名 API 操作，其中对象创建记录为 `verb=create`，而 `objectRef.resource` 字段命名目标资源类型，对于 CronJob 对象来说是 `cronjobs`。通过过滤事件流中的 `verb=create` 和 `objectRef.resource=cronjobs`，可以隔离出 CronJob 创建的审计记录。使用 `jq` 处理 JSON 行流，可以简化为选择匹配事件并打印身份、目标名称和时间戳：

```bash
jq -c 'select(.verb=="create" and .objectRef.resource=="cronjobs" and .objectRef.apiGroup=="batch")
  | {user: .user.username, name: .objectRef.name, ns: .objectRef.namespace, time: .requestReceivedTimestamp}' \
  audit.log
```

在匹配事件上读取 `user.username` 字段以识别创建者。该值的解释遵循标准的 Kubernetes 用户名约定。当 CronJob 是由作为 ServiceAccount 的自动化管道创建时，`user.username` 的形式为 `system:serviceaccount:<namespace>:<name>`。当它是由人以交互方式创建时，`user.username` 是该人类用户的用户名，而不是 ServiceAccount 形式。

此恢复依赖于创建事件已被记录并仍然存在于审计日志中。如果 kube-apiserver 审计被禁用，或者活动审计策略未在记录请求用户的级别上记录 `cronjobs` 的 `create` 事件（因此创建事件从未写入，或写入时没有 `user.username`），或者相关的审计日志段已被轮换，则无法获得创建事件，无法从审计日志中确定创建者。

## 诊断步骤

在依赖日志之前，确认审计是否生效。在此平台上，审计策略由平台本身管理（`base-central` 图表，`v4.3.5-cn`），该策略开箱即用地保持审计开启，并拥有策略生命周期；apiserver 以 `--audit-log-format=json` 启动，因此它写入的事件是 `audit.k8s.io/v1` JSON 记录，携带 `user.username`、`verb` 和 `objectRef`。审计日志在有限的保留期内进行轮换（限制备份数量、每个文件大小和最大年龄），因此超过保留窗口的事件不再存在，已过期的创建事件无法恢复。

当找到 CronJob 创建的审计事件时，验证查找所依赖的三个字段：`verb` 应为 `create`，`objectRef.resource` 应为 `cronjobs`，`user.username` 应携带主体 — 对于自动化工作负载为 `system:serviceaccount:<namespace>:<name>` 值，或对于交互式人类用户为普通用户名。
