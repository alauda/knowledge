---
title: ACP DevOps Integration FAQ
type: faq
status: active
domain: devops
product: acp
tags: [acp, devops, gitops, gitlab, connectors, pipelines, faq, ticket-derived]
updated: 2026-05-15
source: [official-docs, experience, ticket-cases]
related:
  - ../notes/devops-taxonomy-quick-card.md
  - ../notes/devops-connectors-secretless-boundary-quick-card.md
  - ../notes/devops-pac-trigger-runbook.md
  - ../notes/gitops-argocd-sync-health-quick-card.md
  - ../../../knowledge_base/troubleshooting/devops-integration-symptom-runbook.md
  - ../../../ticket-documents/indexes/problem-clusters.md
---

# ACP DevOps FAQ（按 taxonomy 重排）

这份 FAQ 不再把所有问题都混成“DevOps 集成问题”，而是先按 ACP 官方 taxonomy 分层：

- `devops/`：平台化 DevOps 主线
  - 工具本体层
  - 工具接入层（Connectors）
  - 执行层（Pipelines）
- `gitops/`：声明式发布与持续收敛主线

最短使用方法：
- 先判断问题属于 **平台/工具本体、Connectors、Pipelines、GitOps** 哪一层
- 再看对应 FAQ，而不是从一个表面报错一路乱钻

---

## 1. 总体分诊

### 1.1 遇到“DevOps 有问题”，第一步先怎么分层？
先不要笼统接成一类，先分四层：

1. **平台 / 工具本体层**
   - GitLab / Harbor / Nexus / SonarQube / DevOps 平台自身能力或权限问题
2. **Connectors 接入层**
   - 平台怎么连接外部工具、怎么管凭据、协议是否支持
3. **Pipelines 执行层**
   - 流水线有没有触发、执行卡在哪、结果有没有落下来
4. **GitOps 发布治理层**
   - 目标状态有没有同步、环境有没有收敛、回滚与多环境分发有没有异常

最常见误区就是把这四层混成“一个 DevOps 问题”。

### 1.2 平台页面能打开，为什么不能说明工具链全链路正常？
因为 DevOps 故障经常是分层断的：
- 页面入口正常，不代表 SSO 回调正常
- SSO 正常，不代表外部工具接入正常
- 接入正常，不代表流水线执行正常
- 流水线执行正常，不代表 GitOps 目标环境已经收敛成功

所以“能打开页面”最多说明**入口层可能没完全坏**，不代表整条链路没问题。

---

## 2. `devops/`：平台 / 工具本体层

### 2.1 ACP DevOps 到底承接什么，不是什么？
ACP `devops/` 主线更偏：
- 平台化 DevOps 工具链
- 从 code → artifact → CI/CD → quality control 的统一能力
- Kubernetes-native 的交付与自动化工作流

它不是只等于：
- 一个 Git 仓库
- 一个流水线按钮
- 一个第三方工具接入页

也就是说，后续要继续往下分：
- 工具本体问题
- 接入问题
- 执行问题
- 发布治理问题

### 2.2 分配了 DevOps 相关权限，为什么还是报无权限？
先不要只看“角色里有没有勾权限”，而要区分：
- 项目权限
- 集群级权限
- 某类动作的实际执行权限边界
- 工具本体权限 vs 平台侧整合权限

很多“看起来都勾了”的情况，本质上是：
- 缺了另一层级权限
- 权限模型理解错了
- 页面可见 ≠ 动作可执行

关联案例：
- [TICKET-1298959034](../../../ticket-documents/cases/TICKET-1298959034%20分配自定义项目角色后，katanomi报无权限错误.md)

### 2.3 GitLab 问题、DevOps 平台问题、Connectors 问题，怎么快速区分？
先看问题落点：

- **GitLab 本体问题**
  - 仓库、项目、成员、Webhook、容器仓库、GitLab 自己的 CI/CD 能力异常
- **Connectors 问题**
  - 平台如何连接 GitLab、怎么认证、怎么枚举 repo/branch/tag、怎么传递凭据
- **Pipelines 问题**
  - 流水线是否被触发、Task/Run 是否失败、结果是否落库

最短判断：
- 如果 GitLab 自己页面和能力就不对，先看 GitLab 本体
- 如果 GitLab 本身正常，但平台侧拉不到资源或认证异常，优先看 Connectors
- 如果资源能接进来，但自动化流程不跑或跑挂，优先看 Pipelines

---

## 3. `devops/`：Connectors 接入层

### 3.1 Connectors 本质上解决什么问题？
Connectors 解决的不是“再录一遍外部工具账号”，而是：
- 统一接入 Git / OCI / Kubernetes / Harbor / Maven / SonarQube 等工具
- 统一管理凭据
- 统一暴露 API 风格
- 让流水线或作业以 Secretless 的方式访问外部资源

所以它的核心价值是：
- **接入抽象**
- **凭据安全**
- **统一资源访问**

### 3.2 为什么平台加了域名访问后，DevOps/DP/SSO 反而出问题？
这类问题经常不是“平台主页不能访问”，而是**平台能访问，但工具链的认证回调链路没跟着对齐**。

重点先看：
- 域名访问链路是否真的全量切换
- 代理 / Nginx 是否正确透传头信息
- SSO 回调地址、重定向地址是否和新域名一致
- 外部工具 / 插件保存的地址是否还停留在旧域名

关联案例：
- [TICKET-1310428344](../../../ticket-documents/cases/TICKET-1310428344%20dp和devops工具链使用sso登录无法正常通过acp的域名进行认证登录.md)

### 3.3 外部工具接入类问题，最常见的误区是什么？
最常见误区有几个：
- 以为“平台能打开 = 工具接入没问题”
- 以为“功能有按钮 = 外部工具配置一定完整”
- 以为“开源工具支持这个协议 / 插件 = ACP 平台接入一定完全支持”
- 以为“这是 GitLab / Nexus 的问题”，但其实是平台接入层的问题

### 3.4 Nexus / 禅道 / Gitea / Gitee 这类集成问题，先怎么分层？
可以先分成四层：
1. **接入支持边界**
   - 这个工具 / 协议 / 认证方式 ACP 到底支不支持
2. **域名 / 入口 / SSO**
   - 回调、重定向、代理头、入口地址是否一致
3. **权限与角色**
   - 平台权限、工具权限、组织/项目权限是否对齐
4. **数据迁移 / 配置生效**
   - 改了配置是否真正生效，旧地址 / 旧 token / 旧回调是否残留

这样比直接从某个页面报错往下钻更稳。

### 3.5 什么场景应该优先怀疑 Connectors，而不是工具本体？
优先怀疑 Connectors 的典型信号：
- 外部工具自己能正常用，但平台里拉不到 repo / branch / tag
- 凭据明明在工具里可用，但平台侧访问失败
- 某个流水线/作业里只要一接 Git / OCI 就报认证问题
- 不同工具在平台里表现出相似的“接入失败”症状

### 3.6 为什么能看到 Connector，却看不到 branch/tag 或不能 clone/push？
这是 Connectors 里最值得先分层的问题，至少要分三层：
1. **发现层**：能不能看到 `Connector / ConnectorClass`
2. **浏览层**：能不能通过 `Connectors API` 拉 branch / tag / repo / project
3. **运行时使用层**：workload 能不能通过 `Connectors Proxy` 真的 clone / pull / push

所以：
- 能看到 Connector，不代表一定能拉 branch/tag
- 能拉 branch/tag，也不代表 workload 一定能 clone / push
- feature flag 开启后，`Connector` 对象权限和 `connectors/apis`、`connectors/proxy` 能力权限会被拆开检查

### 3.7 Pod 里只有 `.error.json`，更像哪一层的问题？
优先怀疑 **Connectors Approval / Proxy 权限放行**，不是先怀疑业务脚本。

这通常说明：
- workload 是通过 CSI Driver 挂载 Connector 配置
- 但 approval-gated 的 proxy 使用没有被放行
- 因此系统只挂 `.error.json`，不会给可用的 proxy / token / config 文件

最稳的排法是：
- 先看是否启用了 approval 相关 feature flag
- 再看 `AccessPolicy / AccessRequest` 是否命中
- 最后再看 workload 自己脚本

---

## 4. `devops/`：Pipelines 执行层

### 4.1 Pipelines 层主要该问什么？
如果已经判断问题不在工具本体、也不在接入层，那就重点问：
- 流水线有没有被触发？
- 是触发失败，还是触发了但执行失败？
- 失败发生在 Task、PipelineRun、Trigger、Chains 还是 Results？
- 是构建逻辑问题，还是平台执行编排问题？

### 4.2 什么现象更像 Pipelines 问题，而不是 Connectors 问题？
更像 Pipelines 的信号：
- Webhook 进来了，但没生成预期的 Run
- Run 生成了，但某一步 Task 卡住或失败
- 同一套外部工具接入在别的作业里正常，这条流水线单独异常
- 执行过程有签名、结果、日志、工作空间相关报错

### 4.3 Triggers / Chains / Results 为什么要单独看，不要只盯“流水线失败”？
因为它们解决的是不同问题：
- **Triggers**：外部事件怎么把执行拉起来
- **Chains**：执行产物怎么做 provenance / 签名 / 供应链安全
- **Results**：执行完之后，结果和历史怎么存、怎么查

所以“流水线失败”这四个字里，可能实际上混着：
- 事件没接起来
- 执行起来了但签名失败
- 执行成功了但结果没落下来

### 4.4 流水线能跑，但结果不对，应该先看哪里？
先分三类：
1. **业务逻辑不对**：脚本、参数、镜像、依赖、工作空间
2. **平台执行编排不对**：Task / Pipeline / Trigger 配置
3. **结果沉淀不对**：Results / 历史记录 / 查询层

不要把“Run 结束了”和“结果可用”当成同一回事。

### 4.5 Git 事件来了却完全没起 `PipelineRun`，更像哪一层的问题？
这更像 **PAC 入口层**，不要先当成普通 Tekton Task 失败。

最短判断路径：
- PAC 组件 pod 是否正常
- `OpenShiftPipelinesAsCode` CR 是否 `Ready`
- Repository CR 是否存在于预期 namespace
- Git provider webhook 是否真的打到了 PAC webhook
- 当前事件类型与仓库里的 pipeline code 是否匹配

一句话口径：
> 还没创建 `PipelineRun` 时，先看 PAC / webhook / Repository CR，不要直接钻 Task 日志。

### 4.6 为什么 PAC 明明正常，还是“找不到 Run”？
最常见不是没跑，而是**看错 namespace**。

要先分清：
- `pac-namespace`：PAC 组件部署在哪
- `pipeline namespace`：Repository CR 所在 namespace，也通常是 `PipelineRun` 实际创建位置

所以排查时，先 `get repository -A` 找对 namespace，再去查 `pipelinerun`。

---

## 5. `gitops/`：发布治理层

### 5.1 GitOps 和 DevOps 到底是什么关系？
在 ACP 官方 taxonomy 里：
- `devops/` 和 `gitops/` 是**并列一级目录**
- GitOps 不是 DevOps 里的一个小功能页

最短区别：
- **DevOps**：更偏构建与交付链
- **GitOps**：更偏目标状态声明、环境一致性、持续收敛、回滚恢复

### 5.2 什么问题更像 GitOps，而不是 Pipelines？
更像 GitOps 的信号：
- 代码 / 制品已经产出成功，但目标环境没有同步到预期状态
- 多环境分发顺序、环境差异、回滚策略有问题
- Git 仓已经变了，但集群实际状态没跟上
- 应用资源在目标环境长期 drift 或 sync 不一致

### 5.3 为什么“构建成功”不等于“发布成功”？
因为构建成功最多说明：
- 制品出来了
- 流水线某一段跑完了

但发布成功还取决于：
- GitOps 目标状态是否更新
- 目标环境是否同步
- 应用是否收敛
- 多环境策略、回滚策略是否正确

所以“流水线绿了但环境没变”，优先看 GitOps，而不是继续盯构建日志。

### 5.4 什么场景更适合放 GitOps，而不是普通流水线？
更适合 GitOps 的一般是：
- 多环境分发
- 环境一致性治理
- 长期持续收敛
- 回滚与审计要求更强的发布路径

也就是说，GitOps 更像“目标状态治理”，不是简单“执行一串命令”。

### 5.5 `Synced`、`Succeeded`、`Healthy` 为什么不能混着说？
因为它们分别回答三件不同的事：
- **Sync Status**：当前 live state 和 Git 目标状态是否一致
- **Sync Operation Status**：这次同步动作本身有没有成功
- **Health Status**：资源 / 应用现在是否健康

所以完全可能出现：
- `Synced + Degraded`
- `OutOfSync + Healthy`
- `Succeeded + Progressing`

最常见误区就是把它们都笼统说成“同步状态”。

### 5.6 `manifest generation error (cached)` 更像什么问题？
优先怀疑 **manifest 生成本身失败**，通常在 repo-server / 渲染链路，而不是先怀疑应用运行态。

更稳的理解是：
- 错误已经被缓存，避免系统无意义重试
- hard refresh 只能绕过瞬时缓存，不能修复真实渲染失败
- 真正该看的还是 chart 依赖、仓库可达性、模板本身、repo-server 日志

一句话口径：
> 这类问题先查“为什么 manifest 生成不出来”，而不是反复点 sync。

---

## 6. FAQ 该怎么搭配 Runbook 用？

### 更适合 FAQ 的
- 官方 taxonomy 与层次边界
- GitLab / Connectors / Pipelines / GitOps 的区别
- 域名 / SSO / 插件支持边界 / 权限模型常见误区

### 更适合 Runbook 的
- SSO 登录异常
- Connector 接入失败
- 流水线不触发 / Run 失败
- GitOps sync / drift / rollback 异常
- 外部工具迁移 / 接入 / 编译报错

### 当前可直接搭配看的入口
- [DevOps Connectors Secretless Boundary Quick Card](../notes/devops-connectors-secretless-boundary-quick-card.md)
- [DevOps PAC Trigger Runbook](../notes/devops-pac-trigger-runbook.md)
- [GitOps Argo CD Sync / Health Boundary Quick Card](../notes/gitops-argocd-sync-health-quick-card.md)

---

## 7. 当前一线最容易踩的坑

1. **把 GitOps 当成 DevOps 的一个按钮**
2. **把 GitLab 当成 Connectors**
3. **把 Pipelines 当成整条 DevOps 主线**
4. **把页面能打开当成工具链全链路正常**
5. **不先分层，就从一个表面报错一路往下追**

---

## 8. 一句话结论

接 DevOps 类问题时，最稳的顺序不是“先看哪个页面报错”，而是：

**先分清它是平台 / 工具本体、Connectors、Pipelines，还是 GitOps，再进入对应 FAQ / Runbook。**
