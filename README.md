# runbook 目录说明

根据 `使用手册.md` 和当前目录中的文件内容，这个目录本质上是一个面向运维 / SRE 的故障知识库，主要围绕 incident 与 runbook 两类 Markdown 文档组织。

## 目录整体关系

- `_runbook-backlog/`：待沉淀案例区，存放已经整理完成、但还没有归并成标准排查手册的 incident。
- `_runbook-master/`：标准手册区，存放已经抽象沉淀完成的 runbook，是日常优先检索和复用的知识。
- `_runbook-archive/`：历史归档区，存放已经被 runbook 吸收过的 incident 原件，用于留痕、追溯和补充证据。

可以把它理解成一条知识流转链路：

`backlog incident -> master runbook -> archive incident`

## `_runbook-backlog` 里的 md 是干嘛用的

这里的 Markdown 主要是“待归并 incident”，也就是单次故障记录。

这些文件的作用是：

- 记录一次已经排查清楚的问题现场、现象、原因和处理方式。
- 暂时保留细节，等待后续与同类案例一起抽象成 runbook。
- 作为 `/runbook-scan` 和 `/runbook` 的输入材料，用来判断是否可以沉淀成标准手册。

从当前文件看，这里主要还是“尚未成册”的问题，例如：

- `RBAC/` 下记录权限与凭证相关问题。
- `operator/` 下记录 OperatorHub、升级过程中的模块状态异常等案例。
- `日志系统/` 下记录日志查询异常、请求体过大等案例。
- `容器网络/` 下记录 `calico-node` 未就绪或反复重启问题。
- `etcd/` 下记录容量预警、备份配置、数据库空间超限等案例。
- `监控系统/` 下当前有 `prometheus-pod定时重建` 这类尚未沉淀为手册的案例。

简而言之，`_runbook-backlog` 中的 md 用来保存“已解决，但还没抽象成通用手册”的原始案例。

## `_runbook-master` 里的 md 是干嘛用的

这里的 Markdown 是“标准排查手册”，也就是 runbook。

这些文件的作用是：

- 把多篇相似 incident 抽象成一份稳定、可复用的排查方法。
- 在遇到同类问题时，优先作为标准答案被查询和使用。
- 给出统一的适用现象、排查路径、分支判断和处置步骤。

从当前文件名可以看出，这里已经沉淀出多个稳定问题域的手册，例如：

- `容器引擎/容器镜像拉取失败-排查手册.md`
- `Kubernetes API/Pod访问apiserver-证书校验失败-排查手册.md`
- `容器网络/容器网络-PodSandbox创建失败-排查手册.md`
- `监控系统/监控系统-巡检指标采集失败与10254端口拦截-排查手册.md`
- `创建集群/创建集群-kubeadm-init卡住-排查手册.md`
- `GitOps/GitOps-argocd单点登录失败与页面空白-排查手册.md`

简而言之，`_runbook-master` 中的 md 用来保存“已经总结好的标准做法”，是知识库里最核心、最适合直接拿来排障复用的内容。

## `_runbook-archive` 里的 md 是干嘛用的

这里的 Markdown 是“已归档 incident”，也就是已经被某份 runbook 吸收过的历史案例原件。

这些文件的作用是：

- 保留原始故障现场与处理细节，作为 runbook 背后的证据材料。
- 在需要追溯历史上下文时，提供完整案例参考。
- 避免 backlog 持续堆积，同时又不丢失历史记录。

从当前目录看，archive 中已经有大量与 master 中手册相对应的历史案例，例如：

- `容器引擎/2026-04-09-containerd-镜像拉取失败.md` 对应镜像拉取失败类手册。
- `Kubernetes API/2026-04-12-升级到v4.0-Jenkins-apiserver证书校验失败.md` 对应 apiserver 证书校验失败手册。
- `监控系统/`、`日志系统/`、`容器存储/`、`创建集群/` 等目录下都有已被沉淀过的历史案例。

简而言之，`_runbook-archive` 中的 md 用来保存“已经被总结进手册的旧案例原件”，主要用于归档和追溯，而不是作为日常优先检索入口。

## 当前目录现状总结

结合现在这三个目录里的 Markdown，可以把它们理解为三种不同层次的知识：

- backlog：还在等待归并的单次故障案例。
- master：已经提炼好的标准排查手册。
- archive：已经完成沉淀后的历史案例留档。

这说明当前目录已经具备比较完整的知识闭环：

- 有新增案例持续进入 backlog。
- 有成熟经验沉淀进 master。
- 有旧案例从 backlog 迁移到 archive 做长期留存。

如果后续继续维护，通常就是按这个顺序流转：先记录 incident，再抽象成 runbook，最后把来源 incident 归档。
