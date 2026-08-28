---
products:
  - Alauda Container Platform
  - Alauda DevOps
kind:
  - Solution
ProductsVersion:
  - 4.3.x
id: KB260800021
sourceSHA: 32cdbf0c2930400cac1878695c0c30b1cf532fc3e7803538b5e2858fa3310476
---

# 基于 Tekton 与 Kyverno 的流水线策略约束

:::info 适用版本

**适用于：Alauda DevOps Pipelines v4.14.x 及更高版本** —— 判断标准是该版本，而不是 ACP 版本（本文档依赖 Alauda DevOps Pipelines 附带的 Tekton API 与特性；ACP 版本只决定能否安装 Kyverno 插件）。在更早版本上这些特性并不完整：本文档中的策略资产与示例无法原样套用（硬性前置条件见 [§3.2](#s3-2)），但其中的机制与设计取舍仍值得一读。本文档中所有机制讲解、策略资产与量化数据均基于以下版本组合产出：

| 组件 | 版本 | 角色 |
|---|---|---|
| Alauda DevOps Pipelines（Tekton Pipelines 的 ACP 发行版） | v4.14.x | **适用性判断标准** —— 低于该版本时，策略资产不适用 |
| Alauda Artifact Hub Shim（ACP 内置 hub：供 Tekton hub resolver 消费的 Artifact Hub 兼容 API；本文档所引用的 catalog Task / Pipeline 定义的发布来源） | v1.0.0 | [§3.2](#s3-2) 契约矩阵中的模板 / Task 定义随其一同发布 |
| Kyverno（ACP 合规管理插件） | v1.15.9-v4.3.2 | 策略引擎；由 ACP 的合规管理插件交付 |
| Alauda Container Platform | 4.3 | 承载上述两者的平台（本文档的验证环境） |

**每当变更版本都要重新测试。** 这些机制通常向后兼容，但 result 与参数契约会随 Task 与模板版本变化（见 [§3.2](#s3-2) 中的矩阵），跨版本套用会以**静默不匹配**的方式失败——失败形态不是报错：策略仍是 `Ready`，报告仍然干净，而你关心的路径只是不再被看住了。本文档中的具体数字同样依赖运行环境（规模、网络、负载）；写入变更单之前请先在目标环境重新实测。对于此表之外的任何组合，切换到 Enforce 之前先按 [§3.4](#s3-4) 跑正/负探针回归；上线后，每当 Kyverno / Tekton / 模板 / Task / ACP 任一升级，用 [§3.6](#s3-6) 定位受影响的判据，并按 [§3.8](#s3-8) 跑最小回归集。

:::

## 1. 概述 {#s1}

在平台工程实践中，CI/CD 流水线是每个变更进入生产的必经之路——这使它成为落实组织工程规范的关键抓手。常见的治理诉求包括：

- **模板失控蔓延**：业务团队绕过平台认可的流水线模板，自行拼装缺少质量步骤的流水线；
- **门禁被关掉**：模板中的代码扫描与质量门禁被一个参数就禁用（例如把扫描开关设为 false）——流水线“看起来在跑模板”，而关键步骤从未执行；
- **未授权的来源与目标**：制品从未经批准的仓库拉取，应用被部署到未授权的 namespace；
- **不达标的结果照样发布**：覆盖率或漏洞数没达标，流水线却照样走完发布阶段。

本文档介绍如何在 Alauda Container Platform (ACP) 上使用 **Kyverno** 对基于 **Tekton** 的流水线实施策略约束。它不是逐条规则的操作指南，而是聚焦**机制**：Kyverno 在流水线生命周期各处能看到什么、何时看到、能做什么动作（拦截、审计、注入、取消）——以及如何基于这些机制点，结合自定义 Task 与 Task results，构建适合你所在组织的策略体系。

### 1.0 读完之后你将能做什么 {#s1-0}

按 [§3](#s3) 准备好环境后，你应当能够：

- **判定某项治理诉求该归哪一层负责**——哪些 Kyverno 能在 admission 阶段拦截、哪些只有可信模板的构建方式才能保证、哪些必须交给 RBAC 或事后审计（[§1.4](#s1-4) 边界、[§2.3](#s2-3) 七条契约）；
- **锁定模板与 Task 身份**，让业务团队无法改动“用哪个模板、哪个版本”（[§4.1](#s4-1)）；
- **校验门禁参数的生效值**，让“把扫描开关设为 false”或“把阈值降到 0”这类改动在门禁 TaskRun 创建的那一刻就被拒绝（[§4.2](#s4-2)）；
- **约束来源与发布目标**——只允许从批准的仓库/镜像仓库拉取物料，只允许发布到授权的 namespace（[§4.5](#s4-5)）；
- **封住绕过流水线的入口**——裸 TaskRun、未经批准的内联定义与 resolver 类型（[§4.5.4](#s4-5-4)）；
- **消费自定义 Task results** 用于审计、报表与自动取消，把你的自研检查纳入同一套治理体系（[§2.4](#s2-4)、[§4.4](#s4-4)、[§4.6](#s4-6)）；
- **安全地做差异化与豁免**——平台基线加项目收紧的两层模型、经由 PolicyException 的受控豁免，并确保作用域本身不会被绕过（[§5](#s5)）；
- **运营整套体系**——分阶段上线顺序、变更与升级触发点、规模与失败预算，以及升级后要跑的最小回归集（[§3.5](#s3-5)–[§3.8](#s3-8)）。

**不在本文范围内**：镜像签名与供应链证明（见配套文档 *Software Supply Chain Security of ACP with Tekton and Kyverno*）、Kyverno 自身的安装与运维（见 ACP 合规管理文档），以及如何编写流水线模板——本文档只陈述模板必须满足的契约。

**最短评估路径**：如果你只想确认这套机制能否拦住你关心的场景，读 [§1.4](#s1-4) + [§2.3](#s2-3)。要动手实践，按 [§1.1](#s1-1) 中按角色划分的路径走。

### 1.1 目标读者与阅读路径 {#s1-1}

| 角色 | 关注点 | 建议路径 |
|---|---|---|
| 平台管理员（编写策略、管理作用域） | 完整机制图景、作用域安全、策略资产 | [§2](#s2) 机制总览（先弄清能看到什么、能做什么）→ [§3](#s3) 通用配置（安装、验证、构建夹具）→ [§5](#s5) 作用域控制 → [§4](#s4) Cookbook → [§6](#s6) FAQ |
| 项目管理员（维护项目级约束） | Namespaced `Policy`、项目级收紧、权限边界 | [§1.3](#s1-3) 项目差异化与作用域安全（两层模型）→ [§5.1](#s5-1)–[§5.2](#s5-2) 作用域与 RBAC → [§4](#s4) Cookbook（按需取用；记得把示例中的跨 namespace 作用域改写成你自己 namespace 里的 `Policy`） |
| 模板 / Task 作者（提供被治理的流水线） | 硬门禁契约、扩展契约 | [§2.3](#s2-3) 硬门禁契约 → [§2.4](#s2-4) 扩展模型 → [§3.2](#s3-2) 版本与依赖特性 → [§3.3](#s3-3) 夹具 → [§4.3](#s4-3) 真实门禁失败 → [§4.1](#s4-1)–[§4.2](#s4-2) 中的相关部分 |
| 流水线用户（运行流水线、被策略拦截） | 失败形态速查、豁免路径 | [§1.5](#s1-5) 结果形态速查 → [§6.2](#s6-2) 用户侧 FAQ（只有当你的 run 被自动取消时才需要读 [§6.2.3](#s6-2-3)） |
| Walkthrough 操作者（把整篇文档当实验跑一遍） | 策略与运行清单可直接复制粘贴；探针需自己基于 [§3.4.1](#s3-4-1) 骨架组装（九个小节只给出期望表）；并且在共享集群上不留残留 | [§3.1](#s3-1) 验证 → **[§3.2](#s3-2) 先确认 object results 已启用**（`enable-api-fields`；可接受取值见 [§3.2](#s3-2)——若未开启，第一个夹具创建就会被拒绝，报错看起来像 Kyverno 的问题）→ **[§4.0.3](#s4-0-3) 占位符 + [§4.0.4](#s4-0-4) 清理纪律（创建任何东西之前先读：自建 namespace 加上对集群级资源名冲突的预检查，才能保证事后删得掉）** → [§3.3](#s3-3) 构建夹具并**随手记好你的 walkthrough id** → [§4.0.1](#s4-0-1) 安装顺序 + **[§4.0.5](#s4-0-5) 各示例之间的跨小节干扰**（“探针跑不起来”的头号原因）→ 你的目标小节（**每做完一节立刻执行该节的“清理”**——不要攒到最后一起做）→ [§3.3](#s3-3) 的“最终清理”删除两个共享 namespace；如果你做了 [§5.3](#s5-3)，最后再回到 [§3.1.1](#s3-1-1) 还原平台配置 |

**[§3.1](#s3-1) 检查清单中有几项是前向引用**（[§3.1.1](#s3-1-1) 中的 `--exceptionNamespace`、[§4.6](#s4-6) 引言中的 mutate-existing RBAC、[§6.1.8](#s6-1-8) 中的副本规划）：那份清单是一份**能力盘点**，不是“全部通过才能继续”的闸门——第 1、2 项是共享前置条件；其余各项按你实际用到哪一章的能力再回头处理。

### 1.2 Kyverno 简介 {#s1-2}

Kyverno 是 Kubernetes 原生的策略引擎（CNCF 项目），在 ACP 上通过合规管理（Kyverno 插件）交付。与流水线治理相关的核心概念：

- **架构**：admission 控制器（admission webhook——执行 validate / mutate / 镜像校验）、background 控制器（扫描既有资源、执行 mutate-existing / generate）、reports 控制器（产出合规报告）、cleanup 控制器（周期性清理）。
- **策略资源**：`ClusterPolicy` 是集群级资源，由平台管理员维护，既能匹配整个集群范围内的 namespaced 资源，也能匹配集群级资源；`Policy` 是 namespaced 资源，只作用于其自身 `metadata.namespace` 内的资源——是让项目管理员自维护本项目约束的合适载体。规则（rule）不是独立的 Kubernetes 资源；它内嵌在策略的 `spec.rules` 中，每条规则 = `match/exclude`（选择哪些资源与操作）+ 可选的 `preconditions`（进一步过滤）+ 一个动作。
- **动作类型**：
  - `validate`：校验资源。`Enforce` 模式下在 admission 阶段拒绝；`Audit` 模式下放行请求，但把结果记录到 **PolicyReport**；
  - `mutate`：在 admission 阶段修改资源（注入默认值）；其 **mutate-existing** 变体可以在触发事件发生时，修改集群中**已经存在**的其他资源；
  - `generate`：在被触发时创建新资源；
  - `verifyImages`：镜像签名校验（本文不涉及——见配套文档 *Software Supply Chain Security of ACP with Tekton and Kyverno*）。
- **PolicyException**：受控豁免机制——把“谁可以绕过哪条规则”变成一个由 RBAC 管辖的独立资源（[§5.3](#s5-3)）。
- **工作原理**：策略加载后被注册为 admission webhook；每个匹配的 API 请求（CREATE/UPDATE/……）都会经过策略评估。Audit 结果与后台扫描结果都会落入 PolicyReport。

Kyverno 的完整能力见 ACP 合规管理文档与上游 Kyverno 文档（[§8.2](#s8-2) 参考资料）；本文档只展开与流水线治理相关的用法。

**贯穿全文的术语**（这些词分属不同层面；混为一谈会让你误判策略在哪里起作用）：

| 术语 | 含义 | 不是什么 |
|---|---|---|
| **policy（策略）** | 一个 Kyverno `ClusterPolicy` / `Policy` 资源 | 不是流水线里的某个门禁步骤 |
| **rule（规则）** | 策略 `spec.rules` 中的一个条目（`match` + 可选 `preconditions` + 一个动作） | 不是独立的 Kubernetes 资源 |
| **criterion（判据）** | 规则内部判定合规/不合规的布尔表达式（通常写成 `context` 中的 JMESPath 变量） | 不是某个 YAML 结构的名字 |
| **`deny.conditions`** | 承载判据的 YAML 结构；`any:` 之下命中一条即拒绝，`all:` 之下所有条件都必须成立 | — |
| **guard（precondition，守卫）** | 决定规则是否对当前请求生效的条件：身份、终态、列表唯一性等。不匹配意味着**跳过（放行）**，而不是拒绝 | 不是判据；把判据写成守卫等于放行一切 |
| **gate / gate Task（门禁 Task）** | 流水线中给出质量裁决的 Tekton Task（不达标时 `exit 1`），例如 `sonarqube-scanner`、`trivy-scanner` | 不是 Kyverno 的动作 |
| **DAG**（有向无环图） | 流水线各 task 之间的依赖图。Tekton 由 `runAfter` 加上 task 之间的 result 引用推导出它：有依赖的 task 按序执行，相互独立的并行执行，且不允许出现环。“门禁的 DAG 后继”指直接或传递依赖门禁的那些 task；门禁失败时它们会被**跳过**——根本不会被创建 | 不包含 finally task——finally 不属于 DAG；它只在整个 DAG 结束后才被调度（这一区别是 [§2.3](#s2-3) 结果形态表的关键） |
| **profile** | 针对某个真实模板 / Task 的**特定版本**编写的一组判据 | 不是通用模板 |

一句话串起来：**门禁 Task 的职责是拦住不合格的构建；Kyverno 的职责是确保门禁 Task 该在的时候在、且参数没有被篡改**（[§1.4](#s1-4)）——并注意“该在的时候在”不等于“保证会运行”：被 `when` / matrix 整体跳过的门禁从不产生 TaskRun，admission 根本看不到它，只有事后审计才能抓住（[§4.1.5](#s4-1-5)）。

### 1.3 项目差异化与作用域安全 {#s1-3}

不同项目几乎必然需要不同的约束：项目 A 把覆盖率线定在 80，项目 B 定在 60；同时平台还有一组任何人都不得逾越的红线。**差异化是硬需求——但其实现方式绝不能给策略开出绕行漏洞。**本文档中的每条策略都遵循两层模型（细节与验证见 [§5](#s5)）：

- **平台基线**：一个覆盖**所有业务 namespace** 的 `ClusterPolicy`，用**否定式 `exclude`** 剔除平台自身的系统 namespace。基线**不得**依赖“该 namespace 带有某个标签”——否则新建的无标签 namespace，或标签被改掉的 namespace，会天然逃出基线之外。
- **项目级收紧**：项目管理员的主路径是在自己的项目 namespace 内维护 namespaced `Policy` 资源——他们不需要、也不应被授予 `ClusterPolicy` 权限。若由平台团队为多个项目集中管理策略，可用 `ClusterPolicy` + `namespaceSelector`（例如基于 `cpaas.io/project` 标签）圈选目标项目。

**本节描述的是目标治理模型，不是本文档演示资产的现状**：[§4](#s4) 中的每条策略都把作用域硬编码到演示 namespace `policy-poc`，以便统一安装与清理（[§4](#s4) 引言、[§4.0.2](#s4-0-2)）。**“覆盖所有业务 namespace”是你在生产部署时要自己修改的**——原样照抄演示 YAML 不会覆盖任何真实项目，新建的 namespace 当然也不会被自动纳入（这正是 [§3.6](#s3-6) 列出的第一个触发点）。

与之配套的语义（同样只有在按上述目标模型部署后才成立）：未归类的 namespace 必然落入基线；多条策略匹配同一资源时其关系是 **AND**（全部通过才行；不存在项目 `Policy` 覆盖或削弱平台基线的优先级语义）；改动作用域标签本身的权限也必须受控（[§5.0](#s5-0)）。注意 `Policy` 的作用域是单个 Kubernetes namespace；若一个 ACP 项目横跨多个 namespace，就在每个 namespace 里各部署一份对应的 `Policy`，或由平台通过受控的集中机制统一分发。

### 1.4 角色与边界：Kyverno 管什么、不管什么 {#s1-4}

一句话说清分工：**硬门禁由流水线内的门禁 Task 实现（不达标 → `exit 1` → 流水线原生失败）；Kyverno 的角色是收窄门禁被移除、被篡改、被从侧面绕过的路径——并提供审计与响应动作。**

**这里刻意没有说“不可能绕过”**——那个属性只能由**策略 + RBAC + 模板设计三者合力**产生；单靠 Kyverno 给不出来。下文“做不到”清单中的**最后三项**对应**不由 Kyverno 承担**的两类职责——“门禁与发布之间的接线”属于**模板设计**，而“绕开 Tekton 的路径”与“保护策略体系自身”属于 **RBAC**。全文的条件式表述见 [§4.0.1](#s4-0-1) “最小可用集的保证是有条件的”；逐项暴露面见 [§2.5](#s2-5)。

Kyverno 能做什么：

- **在 admission 阶段做硬校验**：在 PipelineRun / TaskRun / Pod 创建时拦截——模板身份不合规、门禁参数被关掉、镜像来源未授权；对象根本创建不出来，流水线以清晰的失败形态终止（[§2.1](#s2-1)、[§4](#s4)）；
- **审计可见性**：在资源 status 更新时读取运行结果（覆盖率、漏洞数、扫描裁决），把不达标记录进 PolicyReport（[§4.4](#s4-4)）；
- **注入默认值**：在 admission 阶段 mutate（默认超时、标签等，[§4.2](#s4-2)）；
- **响应动作**：对运行中的流水线执行受控取消（以 mutate-existing 补丁写 `spec.status`，[§4.6](#s4-6)）。

Kyverno 明确做不到的（边界）：

- **它无法把运行中的流水线变成 Failed**：PipelineRun/TaskRun 的终态由 Tekton 控制器决定。想要“结果不达标 → 失败”，正确答案是让门禁 Task 自己 `exit 1`；Kyverno 能做的是**取消**（终态 Cancelled，[§4.6](#s4-6)）。
- **绝不要用 Enforce 拦截对 `*/status` 子资源的写入**：你拦下的将是 Tekton 控制器的状态回写。结果是资源卡在 Running、控制器无限重试（wedge 卡死）——而不是失败（[§2.2](#s2-2)、[§6.1.4](#s6-1-4)）。
- **远程引用的定义（hub / git resolver）永远不经过集群 admission**：Kyverno 只能锁定**身份**（哪个 catalog 条目、哪个 commit）；对内容的信任来自外部治理（catalog 发布流程、仓库权限）。三档强度见 [§2.1](#s2-1)。
- **它看不见被跳过的门禁**：当 `when` 表达式为假、或 matrix 展开为空时，该门禁**从不产生 TaskRun**，admission 没有可拒绝的对象——“门禁必须运行”只能靠模板设计（不要给门禁一个业务团队能关掉的 `when`）加上 [§4.1.5](#s4-1-5) 对 `status.skippedTasks` 的**事后 Audit** 来保证。它不是 admission 时的硬拦截。
- **它看不见门禁与发布之间的接线是否正确**：门禁消费的是不是**预期那个 task** 的 result（[§2.3](#s2-3) 契约 4）、发布类 task 是否排在门禁之后（契约 5）、finally 里是否藏着受门禁保护的副作用（契约 6）——这三项是**模板设计的职责**。契约 4 / 5 / 6 在 admission 侧连现成的事后 Audit 都没有（在 [§2.3](#s2-3) 的表中它们唯一的保证者是 `T`；[§4.1.4](#s4-1-4) 只审计门禁的**身份**，既不读 `runAfter` 也不读 `finally`——它所挂靠的已解析定义快照是你想自建这种 Audit 时的抓手，取舍见 [§4.1](#s4-1) 引言末尾）。**“门禁在、参数没被关掉”不等于“门禁真正管住了发布”**——这就是上文“三者合力”那句话里**模板设计**的份额。
- **它无法拦截完全绕开 Tekton 的路径**：拥有工作负载 API 权限的身份可以直接创建 Pod / Job / Deployment，或把部署凭证用在别处，全程不产生一个 PipelineRun。**只有 RBAC 能封住这一层**（[§4.5.4](#s4-5-4)）——本文档的入口封堵策略封的是裸 `TaskRun` / `CustomRun`，不是所有能跑容器的 API。
- **它无法保护自己**：本文档的每个结论都建立在“策略体系与 Kyverno 自身配置受控”之上。能改 `ClusterPolicy` / `PolicyException` 的人就能改门禁（[§5.3](#s5-3) / [§5.0](#s5-0)）；能改 Kyverno 的 `resourceFilters` 或其 webhook 的人能让一整章策略**静默失效**（[§3.1](#s3-1) 清单第 7 项 / [§5.0](#s5-0)）；能改 Tekton 平台配置的人能换掉模板解析源（[§4.1.1](#s4-1-1)）或破坏镜像策略依赖的作用域标签（[§3.6](#s3-6)）。**这些身份在本文档的威胁模型之外**——靠 RBAC 职责分离、变更审计与策略体系的自我保护（[§5.0](#s5-0)）来封堵，而不是再写一条策略。

### 1.5 结果形态速查（面向流水线用户） {#s1-5}

当策略作用到你的流水线时，你会看到以下六种形态之一（机制见 [§2](#s2)，排障见 [§6](#s6)）——**注意最后一种是“你什么都看不到”**：

| 你看到什么 | 它意味着什么 | 去哪里找原因 |
|---|---|---|
| 创建 PipelineRun 被直接拒绝（kubectl / UI 显示 admission 报错） | Admission 拦截：模板 / 参数 / 入口不合规 | 报错信息本身就是策略消息（策略名、规则名、原因） |
| PipelineRun 以 reason `CreateRunFailed` 失败；流水线中途某个 Task 从未被创建 | 运行中段的 admission 拦截：某个门禁 Task 的生效参数不合规 | `kubectl describe pipelinerun`；condition 消息中携带完整的策略消息 |
| PipelineRun 以 reason `Failed` 失败；门禁 Task 是红的 | 真实的质量门禁失败（覆盖率 / 漏洞不达标）。**例外**：`spec.status` 若持有**取消值**（`Cancelled` / `CancelledRunFinally` / `StoppedRunFinally`），意味着**确有某人——或某条策略——请求过取消**，只是 task 自身的失败抢在了它前面；仅凭 `spec.status` 无法判断是谁写入的 | 门禁 Task 的日志；若 `spec.status` 持有取消值，按 [§6.2.3](#s6-2-3) 查找 `cancel-reason` / `statusMessage`——这些标记只指向策略取消（确认写入者需要审计日志，见该节）；没有这些标记则来源未知（手工取消看起来一模一样）。**不要把“非空”等同于“被取消”**：该字段还有一个与取消无关的合法取值 `PipelineRunPending`（见 [§6.2.3](#s6-2-3)） |
| TaskRun 以 reason `PodCreationFailed` 失败；Pod 从未出现 | Pod 层的 admission 拦截：该步骤的容器镜像不在批准列表内（[§4.5.3](#s4-5-3)） | `kubectl describe taskrun`；消息中携带完整的策略消息 |
| PipelineRun 变成 `Cancelled`（而你并没有取消它） | **头号嫌疑是策略取消——但不要急着下结论**：取消字段是 Tekton 的公共字段，另一位用户、某个运维工具或其他自动化写入的方式完全相同；[§6.2.3](#s6-2-3) 的标记只指向策略取消（确认写入者需要审计日志——见该节）。策略侧**有四种可能来源**，按 [§6.2.3](#s6-2-3) 的排障顺序列出：门禁 TaskRun 被取消（[§4.2.3](#s4-2-3)）、父 run 被取消（[§4.2.2](#s4-2-2)）、定义漂移（[§4.6.2](#s4-6-2)）、结果不达标（[§4.6.1](#s4-6-1)） | 证据只存在于两处：第一种在那个门禁 TaskRun 上；后三种共用父 run 的 `cancel-reason` 注解，靠其文本区分。按 [§6.2.3](#s6-2-3) 给出的顺序逐一排查（机制差异汇总在 [§4.6](#s4-6) 引言的表中） |
| **流水线完全正常、全绿——却仍然记录了一条违规** | Audit 模式的策略只记录不拦截（[§4.4](#s4-4)）。**“跑过了”不等于“合规”**：[§4](#s4) 中有多条纯 Audit 策略，[§4.2.4](#s4-2-4) 还有一条策略带 Audit 规则——它们对你完全不可见（哪些是 Audit 见 [§4.0.2](#s4-0-2) 的策略速查） | 只在 PolicyReport 里：`kubectl get policyreport -n <your-namespace>`，查找 `result: fail` 的条目（[§6.1.5](#s6-1-5)） |

## 2. 理解机制 {#s2}

本章是全文的核心。贯穿后文的有两个模型：

- **模型 1：生命周期观察/动作矩阵（[§2.1](#s2-1)–[§2.2](#s2-2)）**——Kyverno 沿流水线生命周期能看到什么、何时看到、能做什么；
- **模型 2：信任与硬门禁契约（[§2.3](#s2-3)）**——构成“不可绕过的质量门禁”的七条契约，以及每一条由谁保证。

Cookbook（[§4](#s4)）的每一节都是这两个模型在具体场景下的实例化。

### 2.1 生命周期观察/动作矩阵 {#s2-1}

引用式流水线（`pipelineRef` 指向模板）的典型生命周期，以及 Kyverno 的介入点：

```text
Pipeline/Task definition stored (CREATE/UPDATE)  ← observation point 1 (in-cluster definitions only)
        │
PipelineRun CREATE ── admission ─────────────── ← observation point 2 (the primary hard blocking point)
        │ resolver resolution (cluster/hub/git)
PipelineRun status UPDATE (resolution written) ── ← observation point 3 (the only place a referenced definition can be introspected)
        │ TaskRuns created one by one
TaskRun CREATE ── admission ─────────────────── ← observation point 4 (hard blocking point after parameter expansion)
        │ execution Pod created
Pod CREATE ── admission ─────────────────────── ← observation point 5 (hard blocking point for the images that actually run)
        │ execute, write back results
TaskRun status UPDATE (results written) ──────── ← observation point 6 (the only source of results)
        │
PipelineRun status UPDATE (terminal state, pipelineResults)
```

| # | 观察点 | 能看到什么 | 能做什么 / 注意事项 |
|---|---|---|---|
| 1 | Pipeline / Task 定义资源 CREATE/UPDATE（**仅限集群内定义**） | 完整定义 spec 可审视：tasks、finally、参数默认值、标签 | 理论上这里能做两件事：对存储内容做 Enforce validate（必须包含门禁 task 等）+ 锁定变更权限。**本文档只用了后者**，且交给标准 RBAC 而不是策略（[§4.1.2](#s4-1-2)）——**本文档没有任何一条策略匹配 `Pipeline` / `Task` 定义资源**；原因见 [§4.1](#s4-1) 引言（包括“什么样的场景值得自建”）。**覆盖分三档**：① 内联 / 集群内直接引用——admission 阶段可审视、可锁定；② hub / git **不可变引用**（钉住版本 / commit SHA）——集群内只能锁定**身份**；对内容的信任来自外部 catalog / 仓库治理；③ hub / git **可变引用**（分支 / tag）——远端一动内容就自动生效；Kyverno 只能锁定“引用了哪个分支 / tag”。使用这一档需要仓库侧权限控制（受保护分支 / tag）；否则就应当拒绝 |
| 2 | `PipelineRun` CREATE admission | `pipelineRef`（resolver 类型 + 全部 resolver 参数）、**带值的 `spec.params`**、workspaces、标签、**`request.userInfo`**（创建者身份） | Enforce：模板身份白名单、PipelineRun 级参数契约、入口身份约束；mutate：注入默认值（超时 / 标签，[§4.2.6](#s4-2-6)）。⚠️ 对引用式流水线，此刻 `spec.pipelineSpec` 是**空的**——定义内容不可见，task 级参数同样不可见 |
| 3 | `PipelineRun/status` UPDATE（子资源） | resolver 解析出的 **`status.pipelineSpec`**（集群内唯一能审视被引用定义的地方）、`status.childReferences`、**`status.skippedTasks`**（每个被跳过 task 的 `name` + `reason` + `whenExpressions`；`reason` 取值来自 Tekton 的 `SkippingReason` 枚举）、`status.pipelineResults`（仅在完成后才出现——对 admission 而言为时已晚） | 过了 admission = 事后视角。**绝不要 Enforce 拒绝**（wedge 卡死，[§2.2](#s2-2)）。正确用法：**作为纵深防御的 Audit**（解析出的定义缺少门禁 task → 记入 PolicyReport，[§4.1.4](#s4-1-4)；门禁被 `when` / 空 matrix 跳过 → 读 `status.skippedTasks` 并记录，[§4.1.5](#s4-1-5)）；**响应动作**：触发自取消（[§4.6.2](#s4-6-2)） |
| 4 | `TaskRun` CREATE admission | `spec.taskRef`（resolver + kind/catalog/name/version/namespace）、标签（可见但**不可信**：`tekton.dev/pipeline` / `tekton.dev/pipelineTask` / `tekton.dev/pipelineRun` 可通过 `taskRunSpecs` 覆盖——可作排障线索，绝不可用来定位可信 profile 或父 run）、`request.userInfo`、控制器 ownerReference，以及 **`spec.params` = 展开后的生效参数值**（`$(params.x)` 已解析为具体值——**task 级门禁参数无需上提到 PipelineRun 层即可校验**）；step 镜像仅对内联 taskSpec 可见。⚠️ `tekton.dev/task` 在最终的 TaskRun 上可见，但在真正的 CREATE admission 时刻可能尚未存在，因此同样不能在这一阶段充当身份 precondition；父身份必须由控制器 ownerReference + 对在线父资源 UID/`spec.pipelineRef` 的 `apiCall` 推导 | Enforce：**门禁 task 生效参数的校验**（deny → 父 run 以 `CreateRunFailed` 干净失败，策略消息原样透传进 run condition，[§4.2](#s4-2)）、裸 TaskRun 封堵（[§4.5.4](#s4-5-4)）、taskRef 白名单。⚠️ 流水线未绑定的参数**不会出现**在 `spec.params` 中（生效的是 task 定义的默认值）——只有当 `spec.taskRef` 已锁定到默认值可信的确切 Task 版本时，策略才可以把“缺席”解释为该可信默认值；身份不可信或默认值未知时必须失败关闭（fail closed） |
| 5 | **Pod CREATE / 普通 UPDATE / `Pod/ephemeralcontainers` UPDATE admission**（Tekton 执行 Pod、运行中的镜像更新、事后注入的调试容器） | CREATE 与普通 UPDATE 暴露实际的 step / sidecar / init 容器镜像、securityContext、标签（`tekton.dev/taskRun` 等）、volumes；子资源 UPDATE 暴露 `spec.ephemeralContainers` | **对实际运行镜像的可靠硬拦截点**（执行镜像不合规 → TaskRun `PodCreationFailed`；普通 UPDATE 上不合规的主/init 镜像与不合规的 ephemeral 镜像补丁以同样方式被拒绝，[§4.5.3](#s4-5-3)）。**这一层能做的**：镜像仓库白名单、digest 要求、禁止特权、镜像签名校验（verifyImages）；**本文档只提供仓库前缀白名单**（[§4.5.3](#s4-5-3)）——digest / 特权 / 签名各需单独的策略；verifyImages 见配套文档 |
| 6 | `TaskRun/status` UPDATE（子资源） | **Task results**（object result 逐层下钻 / 聚合字符串解析）与终态——**results 的唯一来源** | 一次运行会触发多次 UPDATE，因此必须有终态守卫（[§4.4](#s4-4)）；只能用于 **Audit** 或作为 **mutate-existing 触发器**（取消，[§4.6](#s4-6)）——**绝不要 Enforce**（wedge 卡死）；这些策略还必须声明 `failurePolicy: Ignore`——否则在 Kyverno 故障期间，API server 会替它们拒绝状态回写（[§3.7](#s3-7) 分级） |
| 7 | Pod status / 事件 | 运行时的失败现场 | 仅用于排障观察（[§6](#s6)）；不承载策略动作 |
| 8 | 外部数据源 | `context.apiCall`（admission 期间查询集群内其他资源：Pipeline 定义、父 PipelineRun……）、`context.imageRegistry`（读取镜像配置；用法见 [§4.5.2](#s4-5-2)） | apiCall 的 JMESPath 语法很严格（[§6.1.7](#s6-1-7)）；imageRegistry 只能读取镜像仓库中已存在的镜像，且会把外部网络调用放到 admission 路径上（延迟与超时风险见 [§4.5.2](#s4-5-2)）。**apiCall 失败后走哪个方向由它所在的规则决定，而不是机制本身**：在同步 `validate` 规则上（[§4.2.1](#s4-2-1)），无法完成的查询——目标不可达、不存在或被禁止——会让规则报错、请求被拒绝（fail-closed）；在 mutate-existing 规则上（[§4.2.2](#s4-2-2) / [§4.6.1](#s4-6-1)），它运行在 background-controller 里、完全处于 admission 裁决之外，查询失败只会让补丁静默消失而原请求被放行（fail-open）——见 [§3.7](#s3-7) “异步交付链”一行 |
### 2.2 执行与动作模式 {#s2-2}

| 模式 | 适用场景 | 关键边界 |
|---|---|---|
| `validate` + **Enforce** | 模板 / 参数 / 定义 / Pod 约束（观测点 1/2/4 上的 CREATE，加上观测点 5 上的 Pod CREATE / 普通 UPDATE / `Pod/ephemeralcontainers` UPDATE）——不合规请求被直接拒绝 | 用于主资源的 CREATE/UPDATE，或显式纳入治理的**非 status 子资源**（如 `Pod/ephemeralcontainers`）；绝不用于 `*/status` UPDATE。运维边界：webhook 的 `failurePolicy` 决定 Kyverno 不可用时是全放行（Ignore）还是全拒绝（Fail）——在 [§3.1](#s3-1) 验证，并在 [§6.1](#s6-1) 备好处置手册 |
| `validate` + **Audit** | 结果约束（观测点 3/6 上的 status UPDATE）——予以放行，但记录进 PolicyReport | **读取 status 只能用 Audit。** ⚠️ 子资源匹配与 `background: true` 互斥——结果类 Audit 只有 admission 这一个时机，没有后台扫描兜底 |
| `mutate`（admission 注入） | 注入默认超时 / 标签 / SA 等（观测点 2） | `+(field)` 锚点 = 缺失才添加：绝不覆盖用户显式设置的值（[§4.2.6](#s4-2-6)） |
| **mutate-existing** | 响应动作：在触发事件发生时，修补集群中**已存在**的其他资源——本文用它取消流水线（[§4.6](#s4-6)） | 要求 background controller 持有目标资源的 update RBAC（**Kyverno 在策略创建时校验该 RBAC；缺失则策略安装失败**，[§3.1](#s3-1)）。由 admission 事件触发且使用 `subjects` / `request.userInfo` 时，必须设置 `background: false`；只有当你确实需要策略更新时扫描已存在的触发资源、且规则不使用任何上述请求变量时，才启用 `background: true` |
| `generate` | 为新项目 namespace 自动下发 namespace 级 Policy 等 | 生命周期管理复杂；本文不展开（进阶） |
| `verifyImages` | 镜像签名 / attestation | 见配套文档；[§2.3](#s2-3) 中「身份」契约的信任前提之一 |

**反机制（务必牢记）**：把 `validate + Enforce` 挂到 `tekton.dev/v1/TaskRun/status` 或 `PipelineRun/status` 的 UPDATE 上，会阻断 **Tekton 控制器的完成状态回写**——TaskRun 卡在 Running，控制器无限重试 `UpdateFailed`，流水线既不失败也不结束，直到人工介入（复现与恢复步骤见 [§6.1.4](#s6-1-4)）。这是通往「我想让流水线失败」路上最容易踩中的陷阱：**拒绝 status 写入 ≠ 让它失败**。

### 2.3 信任与硬门禁契约 {#s2-3}

**定位**：硬门禁（覆盖率红线、漏洞阈值——「低于红线不得通过」）由**流水线内部的门禁 Task** 实现——门禁读取前序任务的结果，未达标即以 1 退出；流水线原生失败（`Failed`），排在门禁之后（`runAfter`）的发布任务被 DAG 跳过，**根本不会被创建**。Kyverno 的职责是**校验这套契约中可静态校验的部分**；其余由可信模板的构造方式（by construction）与外部治理保证。

「不可绕过的硬门禁」= 以下七条契约同时成立。担保方分三类：**K** = 可由 Kyverno 静态校验，**T** = 由可信模板构造承诺（由模板的构建方式天然成立，而非运行时检查），**E** = 外部治理。先看骨架：

| # | 契约 | 一句话 | 担保方 | 详见 |
|---|---|---|---|---|
| 1 | 身份 | 门禁使用带不可变引用（固定版本 / digest）的可信 Task | K + E | [§4.1](#s4-1) |
| 2 | 参数生效值 | 开关 / 阈值在展开后的生效值上校验 | K | [§4.2.1](#s4-2-1) |
| 3 | 必执行 | 门禁不会经 `when` / matrix / 默认值被跳过 | T + K 事后 Audit | [§4.1.5](#s4-1-5) |
| 4 | 数据绑定 | 门禁消费的是预期任务的结果 | T | ——（模板职责） |
| 5 | DAG 支配 | 发布类副作用任务必须排在门禁之后 | T | ——（模板职责；自建 Audit 的挂钩点与权衡：见 [§4.1](#s4-1) 引言末尾） |
| 6 | finally 安全 | finally 内不得有受门禁保护的副作用 | T | ——（模板职责；finally 执行语义：[§4.2.2](#s4-2-2)） |
| 7 | 入口闭合 | 不得经裸 TaskRun / 内联定义 / 未批准的 resolver 绕过流水线 | K + RBAC | [§4.5](#s4-5) |

逐条展开：

1. **身份**（K + E）：门禁使用带不可变引用（固定版本 / digest）的可信 Task。K 锁定引用身份（[§4.1](#s4-1)）；step 镜像的完整性（digest / 签名）、镜像仓库推送权限、外部扫描服务的凭证安全属于外部信任面（E；镜像签名即 verifyImages / 配套文档）。
2. **参数生效值**（K）：门禁开关、阈值、目标分支等在**展开后的生效值**上校验。校验点 = **门禁 TaskRun CREATE**——此刻 `$(params.x)` 已解析为具体值；身份由控制器 `ownerReference` + 在线父 run + `spec.taskRef` 推导（子对象标签可被调用方伪造，不可用），且模板作者无需任何改动。响应方式：Enforce 拒绝（门禁 TaskRun 无法创建 → 父 run 以 `CreateRunFailed` 干净地失败）或取消父 run（[§4.6](#s4-6)）；当模板已在 PipelineRun 层暴露这些参数时，在 PipelineRun CREATE **提前拦截**是一项可选优化。完整推导与策略见 [§4.2.1](#s4-2-1)。
3. **必执行**（T + K 事后 Audit）：门禁不会被 `when` 表达式 / matrix / 条件分支 / 参数默认值跳过。经典陷阱：扫描 URL 参数默认为空 + `when: sonarURL != ''` ⇒ 默认情况下扫描被整体跳过，门禁变成「自愿加入」。⚠️ **被跳过的门禁不会产生 TaskRun**——契约 2 的 admission 校验对「缺席」视而不见（admission 无法拦截从未发生的事）。因此必执行的根基在 T（模板不提供跳过路径）；K 侧则用对 **`status.skippedTasks`** 的事后 Audit（控制器把每次跳过连同其 `reason` 记入 PipelineRun status）判定门禁是否被规避——仍是 Audit，无法阻止当前这次 run。reason 如何分类、策略怎么写：[§4.1.5](#s4-1-5)。
4. **数据绑定**（T）：门禁确实消费指定生产者任务的结果（`$(tasks.scan.results.x)` 接线正确）。admission 看不到表达式级绑定；由模板保证。
5. **DAG 支配**（T）：**每一个**发布 / 推送 / 晋级类副作用任务都必须传递性地依赖门禁（`runAfter`，直接或间接）。门禁只能拦住它的 DAG 后继——**排在门禁之前或与之并行的任务可能已经执行完，失败不会回滚已经发生的副作用**。让副作用受门禁支配是模板设计职责；本文不提供现成的 DAG 支配 Audit（判定传递依赖意味着计算闭包——权衡见 [§4.1](#s4-1) 引言末尾），[§4.1.4](#s4-1-4) 的已解析定义快照（其中含 `runAfter`）是你自建这类判据的挂钩点。
6. **finally 安全**（T）：finally 任务在流水线失败、或以 **`CancelledRunFinally`** 取消时执行（deny 与 cancel 下 finally 是否运行的对比见 [§4.2.2](#s4-2-2) 的表格；三种响应形态的完整权衡见 [§4.2.3](#s4-2-3)）；普通的 `spec.status: Cancelled` 不保证尚未启动的 finally 任务会被调度——因此 finally 内不得包含任何受门禁保护的副作用（发布、推送）。finally 内容同样没有现成的 Audit（[§4.1.4](#s4-1-4) 的快照含 `finally` 列表；可以自建——权衡同上）。
7. **入口闭合**（K + RBAC）：业务身份不得通过创建裸 TaskRun 绕过流水线，不得使用未批准的内联定义，不得使用未批准的 resolver 类型；`CustomRun` 默认拒绝或显式声明不支持（[§4.5.4](#s4-5-4)）。

**Kyverno 可校验的三件事**（本文所有 Enforce 策略的分类法）：模板身份白名单（按 [§2.1](#s2-1) 的三个层级；集群内定义的**变更权限**由标准 RBAC 另行封死，见 [§4.1.2](#s4-1-2)——那一项不算 Kyverno 可校验）；参数契约（TaskRun 层的生效值为主路径，PipelineRun 层的提前拦截为辅路径）；入口闭合。**Audit / PolicyReport 是事后的第二道防线——用于发现漂移与兜底告警；不计入硬门禁的保证。** Audit 不拦截任何东西。

**失败 / 终止形态对比**（流水线使用者的速查表见 [§1.5](#s1-5)）：

| 形态 | 触发条件 | run 终态原因 | 下游发布任务 | finally | 失败如何呈现 |
|---|---|---|---|---|---|
| admission 拒绝门禁 TaskRun 的创建（契约 2 的响应） | 门禁生效参数不合规 | `CreateRunFailed`（终态；这里的「不重试」指**不会无限重试**，并不承诺只尝试一次；它还**有前提条件**——见下方 info 块的最后一条） | 从未被创建（`skippedTasks` 为空） | **不运行** | Kyverno 策略消息被逐字透传进 PipelineRun condition |
| 门禁任务以 1 退出（主线硬门禁） | 结果未达标 | `Failed` | 被 DAG 跳过；列入 `skippedTasks`（reason 为 `PipelineRun was stopping`） | **运行** | 门禁任务的日志 + "Tasks Completed: N (Failed: 1)" |
| mutate-existing 取消（[§4.6.1](#s4-6-1)） | 结果未达标（由 status 事件触发）；结果缺失 / 格式异常同样触发，fail-closed（**判据方向 fail-closed ≠ 送达保证**：取消在后台异步送达，链路断裂时会静默不发生——见 [§3.7](#s3-7) 的「异步送达链路」行） | 通常为 `Cancelled`；当产出结果的任务自身先失败时为 `Failed`（失败裁定优先于取消；`spec.status` 仍显示 `CancelledRunFinally`） | 进行中的任务以 `TaskRunCancelled` 停止 | **运行** | 父 run 的 `cancel-reason` 注解（由同一个 patch 写入；文本注明触发的 TaskRun 与越界的结果值）+ 事件；配合配套的 Audit 规则还会有 PolicyReport 记录 |
| mutate-existing 自取消（[§4.6.2](#s4-6-2)） | 已解析定义漂移（回写进 `status` 的 `pipelineSpec` 与批准的身份不符） | `Cancelled` | 同上 | **运行** | 父 run 的 `cancel-reason` 注解（说明漂移情况）+ 事件 |
| **用 mutate-existing 取消（RunFinally）替代对门禁参数不合规的 deny（[§4.2.2](#s4-2-2)）** | 在门禁 TaskRun 上检测到生效参数不合规 | 通常为 `Cancelled`；当取消与任务失败竞态时为 `Failed`（裁定规则与上面第二行相同：失败裁定优先于取消，`spec.status` 仍显示 `CancelledRunFinally`；[§4.6.1](#s4-6-1) 的初始化窗口同样适用于此路径） | 门禁之前的任务已执行；从门禁起被取消 | **运行** | 通用取消文本 + `cancel-reason` 注解 |
| **admission mutate 取消门禁 TaskRun 自身（deny 的同步替代方案，[§4.2.3](#s4-2-3)）** | 门禁生效参数不合规 | `Cancelled` | 被 DAG 跳过；列入 `skippedTasks`（reason 为 `PipelineRun was stopping`） | **运行** | TaskRun condition 逐字携带策略写入的 `statusMessage`（在 tkn / UI 中可见）；PolicyReport 中无违规记录 |

:::info 为什么「admission 拒绝门禁 TaskRun」会跳过 finally（社区已知问题）

该行为已上报上游：https://github.com/tektoncd/pipeline/issues/10514 （*finally tasks are not executed when a child run creation is permanently rejected*；截至本文撰写仍为 open）。当前 ACP 版本所用的社区 Pipelines 版本带有此问题；在上游修复落地之前，适用下面的选型指引。机制如下：

- **机制**：finally 只在整个 DAG 结束后才被调度，而「结束」要求每个 DAG 任务落入 succeeded / failed / **skipped** 三者之一。在 admission 被拒绝的门禁 TaskRun **从未被创建**，该节点永远到不了这三种状态中的任何一种——DAG 永远不算结束，finally 永远不会被调度，控制器随即把 run 置为 `CreateRunFailed` 终态。
- **对比**：门禁任务以 1 退出时，TaskRun 被创建、运行并失败——该节点有终态，DAG 可以结束，finally 照常运行。分界线是**门禁节点是否到达终态**，而不是 run 是否失败。
- **如何识别这种形态**：run 为 `CreateRunFailed`，没有子 TaskRun，finally 从未被创建，且 `skippedTasks` 为空。
- **为什么是终态而不是无限重试**：创建子 run 失败时，控制器先对错误分类（上游 `pkg/reconciler/pipelinerun/pipelinerun.go` 中的 `handleRunCreationError`），**只有被判定为「永久」的错误才写为 `CreateRunFailed`**——其余一律按可重试处理。admission 拒绝落入永久桶，是因为对「webhook 拒绝但未提供状态码」的响应，API server 统一返回 400。**因此还存在一种形态**：如果你的拒绝响应携带已知的失败 reason（如 `Forbidden`），错误可能被归为可重试——症状变成 run **卡在 Running、控制器一遍遍重试创建同一个子 run**，而不是直接失败。看到这种卡住的形态时，别去查 DAG；去看拒绝响应的状态码和 reason。
- **「永久」不等于「恰好尝试一次」**：错误一旦落入永久桶，run 随即终止，但控制器**不保证只发出了一次创建请求**——单个 run 的 `TaskRunsCreationFailed` 事件的 `count` 可能大于 1（`Failed` / `InternalError` 合并计数）。所以本节承诺的是 run **快速到达终态**，而不是只发送一次请求：排障时**不要把 `count > 1` 当成异常**——需要警惕的形态是上一条所说的、run **卡在 Running、控制器一遍遍重试创建同一个子 run**。要按 run 精确计数，用 `kubectl get events -n <ns> --field-selector involvedObject.uid=<pipelinerun-uid>`；按名称查询会把同名旧 run 留下的陈旧事件也算进来。

:::

:::warning 选型提示：依赖 finally 做通知 / 清理的团队请注意

- 在 admission 拒绝形态（`CreateRunFailed`）下，finally **不运行**；只有门禁任务已落地后失败、或 run 被显式以 `CancelledRunFinally` 取消时，finally 才按上面的对比表运行。
- 如果你的通知 / 清理在门禁参数被拦截时也必须触发，不要只挂在 finally 上——用**取消（RunFinally）**替代 deny，两条路线任选其一：
  - **[§4.2.2](#s4-2-2)（取消父 run）**：在扫描 TaskRun CREATE 时触发 mutate-existing，把父 PipelineRun 的 `spec.status=CancelledRunFinally` patch 上去并打上原因注解；run 以 `Cancelled` 终止，但 finally 照常运行（由未达标结果触发的取消见 [§4.6](#s4-6)）。
  - **[§4.2.3](#s4-2-3)（另一种同步形态：取消门禁 TaskRun 自身）**：不动父 run，改为在 admission 期间把门禁 TaskRun 自身 mutate 为 `spec.status=TaskRunCancelled`——在同一次 admission 内完成，没有竞态窗口，也不需要额外的 background controller RBAC。
- 三种形态的权衡见 [§4.2.3](#s4-2-3) 的对比表。

:::

### 2.4 扩展模型：从自定义 Task 与结果生长出策略 {#s2-4}

在平台内置的扫描 / 门禁能力之外，每个组织都有自己的检查项（自研 linter、许可证扫描、安全基线、制品规范……）。扩展路径分三步：

1. **Task 产出声明式结果**：自定义 Task 把结论写成**可判定的结果**——一个数字（`error-count`）、一个枚举裁定（`verdict: pass|fail`）或一个结构化对象——而不是「报告文件的路径」。Tekton 结果有三种声明类型——`string` / `array` / `object`——策略侧三种都能消费：`status.results[].value` 按声明类型序列化（string → 字符串，array → 字符串数组，object → 字符串映射），因此 JMESPath 拿到的是对应的原生结构：
   - **`type: object`（多字段结构用它）**：Task 声明 `type: object` + `properties`，策略用 JMESPath `.value.xxx` 直接下钻——字段有名字、有 schema，策略完全不解析任何文本格式。注意 `properties` 下的值只能是 `string`（不支持嵌套对象 / 数组）；需要层级时把字段名拍平；
   - **`type: array`（同质列表用它）**：值是字符串数组；策略用 `[?...]`、`contains(...)`、`length(...)` 过滤——例如「未修复的严重 CVE 列表必须为空」。它解决的是「值多」，不是「字段多」——语义不同的字段仍应放进 object；
   - **`type: string`（默认）**：单值最直接——每个结果放一个数字或一个枚举裁定；策略用 `to_number` 转换或直接比较，零解析风险。
     - **聚合字符串（叠加在 `type: string` 之上的约定；兼容性手段，不推荐）**：把多个字段以 `key=value` 拼接塞进一个字符串结果，策略侧用 `split` + 正则 + `to_number` 拆开（[§4.4.2](#s4-4-2)）。**确实可行**——但只在消费**暂时无法改动的既有 Task 契约**时才这么做：文本格式不是稳定契约；字段顺序、分隔符、新增字段、「数量不可知」哨兵值都会导致静默失配——而失配通常表现为**被误判为通过**。当契约在你手里、又有多个字段要聚合时，用 `type: object`。
2. **要做硬门禁**：Task 自行裁定并以 1 退出（或紧随其后接一个读取结果的门禁任务）——进入 [§2.3](#s2-3) 的契约体系，接受身份锁定与参数校验；
3. **要做可见性 / 兜底**：Audit 策略把结果读进 PolicyReport（[§4.4](#s4-4)）；未达标结果还可以额外触发自动取消（[§4.6](#s4-6)）。

**两层参数校验**（与契约 2 相同）：主路径 = 在 TaskRun CREATE 时校验展开后的生效值（对任何模板开箱即用，模板作者零设计义务）；可选优化 = 当模板已把开关 / 阈值作为 PipelineRun 级参数暴露时，在 PipelineRun CREATE 提前拦截。

**信任前提**：自定义 Task 与其他一切同样落在契约 1 之下——不可变引用 + 可信镜像。否则「推一个永远打印 pass 的脚本版本」就是成本最低的绕过手段。

[§4](#s4)（Cookbook）用一个虚构的、自包含的扫描任务（`policy-demo-scanner`）把这条扩展路径贯穿始终；平台目录中的真实 Task（如 sonarqube / trivy）以 profile 小节的形式出现，并附带它们真实的结果契约。

### 2.5 残余风险台账（装完最小可用集之后，还剩哪些路径） {#s2-5}

[§1.4](#s1-4) 讲了 Kyverno 管什么、不管什么，[§2.3](#s2-3) 讲了七条契约各由谁担保，每一节还各自带着「本节不覆盖什么」的说明。本节把它们合并成一张表：**假设你已按 [§4.0.1](#s4-0-1) 安装最小可用集并固定了作用域，这就是你手中实际持有的保证与暴露面的集合。** 这张表同时也是本文的范围声明——标 ❌ 的行是本文**明确不覆盖**的内容，不是遗漏。

图例：✅ = admission Enforce 硬拦截（各白名单类型共同的前提是名单填写完整，见 [§4.0.7](#s4-0-7)——下文不再逐行重复）；🟡 = 仅事后 Audit / 异步响应，或拦截依赖模板设计等 Kyverno 之外的条件；❌ = 本文不覆盖。

| # | 绕过或失效路径 | 覆盖度 | 靠什么封堵 |
|---|---|---|---|
| 1 | 不走 Tekton：直接创建 Pod / Job / Deployment，或在别处使用部署凭证 | ❌ | 对工作负载 API 与凭证做 RBAC 收窄（[§1.4](#s1-4) / [§4.5.4](#s4-5-4)）——本文无法封住这一层 |
| 2 | 裸 `TaskRun` / `CustomRun` 绕过流水线 | ✅ | [§4.5.4](#s4-5-4)；本行的「名单」指**合法的自动化创建者身份**——漏掉一个就会把一条合法路径直接堵死 |
| 3 | 引用未批准的模板，或使用内联定义 | ✅ | [§4.1.1](#s4-1-1) 的三通道白名单——内联被它**天然拒绝**（不在三个通道中的任何一个）。要做集群级一刀切禁止还有 [§4.1.2](#s4-1-2) 的 `disable-inline-spec`，但那是 **Tekton 自己的 webhook，不是 Kyverno**；[§4.1.3](#s4-1-3) 讲的是反向操作（审慎地开例外），不是本行的拦截手段 |
| 4 | 引用坐标未变，但**远端定义的内容**被换掉 | 🟡 | 仅有身份锁定；内容信任来自目录 / 仓库治理（[§2.1](#s2-1) 的三个层级），叠加 [§4.1.4](#s4-1-4) 的事后漂移 Audit |
| 5 | 门禁经 `when` / 空 matrix 被跳过（完全不产生 TaskRun） | 🟡 | admission 没有可拒绝的对象；依靠模板不提供跳过路径 + [§4.1.5](#s4-1-5) 中读取 `skippedTasks` 的事后 Audit |
| 6 | 门禁开关被关闭、阈值被调低、覆盖注入（`taskRunSpecs` / `taskRunTemplate`） | ✅ | 官方模板走 [§4.2.5](#s4-2-5) / [§4.2.4](#s4-2-4) 的真实 profile，**改好作用域和占位符即可使用**；自建模板走 [§4.2.1](#s4-2-1)，但那**是一个模板，不是现成实现**——其身份与参数契约必须按你的门禁重写（[§4.0.1](#s4-0-1) 阶段 3） |
| 7 | 发布类任务不受门禁支配，或受门禁保护的副作用被放进 finally | 🟡 | 契约 5 / 6 是模板设计职责；K 侧不提供现成判据（[§4.1.4](#s4-1-4) 只审计门禁的身份；其快照是自建这类 Audit 的挂钩点）。**本文没有走定义侧 admission 这条路**；其形态与成本见 [§4.1](#s4-1) 引言末尾 |
| 8 | 门禁消费的结果不是预期任务的（接错线，或被改线） | ❌ | 契约 4：admission 看不到表达式级绑定；只有模板能保证 |
| 9 | 执行镜像被换成**已批准仓库内**的另一个镜像，或可变 tag 的内容被替换 | 🟡 | [§4.5.3](#s4-5-3) 只判前缀；要更强就固定 digest 或加 `verifyImages`（配套文档） |
| 10 | 其他 Pod 级面：privileged / `securityContext` / `automountServiceAccountToken` / 挂载 | ❌ | 同一观测点本可以做到（[§2.1](#s2-1) 第 5 行），但**本文只提供镜像仓库前缀白名单**；治理这些需要额外的策略 |
| 11 | workspace 绑定：除 [§4.5.5](#s4-5-5) kubeconfig 之外的 Secret / PVC 被挂进流水线 | ❌ | 本文只治理「发布步骤的 kubeconfig 从哪来」这一个绑定；凭证面整体由 RBAC 与 Secret 治理承担 |
| 12 | 伪造结果（扫描步骤自己写一个 `pass`） | 🟡 | 落在契约 1 之下：不可变引用 + 可信镜像；[§4.6.1](#s4-6-1) 额外有一道身份防伪检查 |
| 13 | 该发生的取消没有发生（mutate-existing 的异步送达链路断裂） | 🟡 | Fail-open；按 [§3.7](#s3-7) 的「异步送达链路」行做监控；要同步硬保证就换成 [§4.2.1](#s4-2-1) / [§4.2.3](#s4-2-3) |
| 14 | 修改 Kyverno 自身配置、策略对象或 PolicyException | ❌ | 在本文威胁模型之外；由 RBAC 职责分离与变更审计封堵（[§5.0](#s5-0) / [§5.3](#s5-3)） |
| 15 | 新 namespace / 新集群未纳入治理 | 🟡 | 两者都会被**静默放行**：按 [§3.6](#s3-6) 第一行更新作用域；不存在跨集群分发机制（[§7.3](#s7-3)） |
| 16 | 以 `v1beta1` 提交 `PipelineRun` / `TaskRun`（且环境仍在提供该版本服务） | ✅ | **本行不是暴露面；列在这里是因为它经常被误当成暴露面**：Kyverno 生成的 webhook 是 `matchPolicy: Equivalent` 且只注册 `v1`，API server 会先把 `v1beta1` 请求转换为 `v1` 再送审——`kinds` 里只写 `tekton.dev/v1` 就已覆盖。**真正开洞的是「为保险起见往 `kinds` 里加 `v1beta1`」**——从那之后转换不再发生，**跨版本改名的字段路径**读出来为空，依赖它们的判据静默跳过（两个版本共有的路径仍可解析，所以是**部分**失效——更难察觉）。详见 [§3.2](#s3-2) 的「API 组版本前提」；`CustomRun` 是例外——它只有 v1beta1 |
| 17 | `StepAction`（step 级远程引用）、Tekton Chains / provenance、资源配额与并发滥用 | ❌ | 在本文范围之外；未做分析、未给判据——需要时各自用其对应机制治理 |
| 18 | 判据依赖的「生效值」有请求之外的来源（sonar 的 properties 文件可能来自被扫描仓库或 workspace） | 🟡 | admission 只能看到请求。对分支值 [§4.2.4](#s4-2-4) 已对文件来源免疫（参数非空时 Task 用它覆盖文件值；参数缺失时判据按保护范围处理）；剩下的路径是文件中注入非空的 `sonar.pullrequest.key` 把分析静默切换到 PR 模式——由仓库治理（[§2.1](#s2-1)）与受评审对象的内容控制（[§2.3](#s2-3) 契约 1）承担 |
| 19 | [§4.2.4](#s4-2-4) 契约收窄的已知误拒面：① 契约外形态一律拒绝——`sonarProperties` 内出现受治理的键（即使参数本会覆盖它们）、注释行、行首空白、单个元素内嵌换行、重复的 PR 声明或含空白的值；② `sonarBranchName` 缺失 + 仓库 properties 文件把分析指向 feature 分支 + 门禁被显式关闭的组合 | 🟡 | 方向 fail-closed：① 按拒绝消息与 [§4.2.4](#s4-2-4) 第一个 warning 中的对照表改写为推荐形态，即可放行；② 为该次 run 显式传入 feature 分支值。确实在契约之外的存量形态走 [§5.3](#s5-3) 的显式豁免 |

**这张表怎么用**：① 上线前逐行走一遍标 ❌ / 🟡 的行，确认「在我的组织里这一条归谁负责」——没有负责人的行就是真实暴露面；② 汇报「这套策略集保证了什么」时，引用标 ✅ 的行，绝不把 🟡 说成 ✅；③ 每次升级或作用域变更后回来重读（[§3.6](#s3-6)）。

## 3. 通用配置与运维纪律 {#s3}

本章一次性完成后续所有章节依赖的环境验证与共享资源（[§3.1](#s3-1)–[§3.4](#s3-4)），并确立这些策略上线后需要持续遵守的运维纪律（[§3.5](#s3-5)–[§3.8](#s3-8)：分阶段灰度、变更触发条件、规模与失败预算、升级回归集）。**起步只需要前半部分；后半部分是策略进入生产后你会反复回来查阅的内容。**

:::warning 命令在哪个集群上执行

**本文的 `kubectl` 命令默认在承载 Kyverno 与 Tekton 的业务集群上执行**（下文称目标集群）——包括本章的验证清单与基础资源，以及 [§4](#s4)–[§6](#s6) 的所有策略与探针。

**唯一的例外是 [§3.1.1](#s3-1-1)**：修改平台托管组件的配置要经由 global 管理集群上的 `ModuleInfo`；该节的命令显式携带 `--kubeconfig <path-to-global-kubeconfig>`——请按原样书写，不要复用当前 context。

动手之前，先确认当前 context 指向目标集群；不要在 global 集群上创建演示资源：

```bash
kubectl config current-context
# Expect the context of the cluster that runs Kyverno and Tekton. If it points
# anywhere else, switch first: kubectl config use-context <target-context>
kubectl get deploy -n kyverno kyverno-admission-controller
# Expect the controller to exist here. NotFound means you are on the wrong
# cluster (or Kyverno is not installed yet -- see the checklist below).
```

:::

### 3.1 安装与能力验证清单 {#s3-1}

两个组件都通过 ACP 的模块化机制安装，且都支持离线（air-gapped）环境：

- **Kyverno**：管理员视图 → **Marketplace → Cluster Plugins** → 搜索 `kyverno` → 安装 **"Alauda Container Platform Compliance for Kyverno"**。安装后 Kyverno 由平台以 Helm / AppRelease 方式托管，四个控制器部署在 `kyverno` namespace。
- **Tekton Pipelines**：管理员视图 → **Marketplace → OperatorHub** → 安装 **"Alauda DevOps Pipelines"**；此后由 `TektonConfig` 管理 Pipelines / Triggers / Chains 与 resolver 开关。

产品文档：合规管理（Kyverno）的安装与配置、DevOps（Tekton）的安装——见 [§8.2](#s8-2) 中的 ACP 官方文档链接。

:::warning 不要直接在 Deployment 上修改托管配置

ACP 的 Kyverno 由平台模块（Helm / AppRelease）托管并**周期性 reconcile**——任何通过直接 `kubectl patch` 控制器 Deployment 做出的参数修改（例如手动添加 `--exceptionNamespace`）**都会被下一次 reconcile 还原**。所有控制器级配置必须通过平台模块的配置入口持久化（操作方法见 [§3.1.1](#s3-1-1)）。

:::

**先确认三个前提，否则下面的命令会给出误导性结果**：

```bash
# 1) Tekton's namespace: this document (including the checklist below) writes the
#    literal tekton-pipelines for readability, but on ACP the operator decides it
#    and it may be something else. TektonConfig is authoritative. Every later code
#    block that uses it starts with a fallback line : "${TEKTON_NS:=tekton-pipelines}",
#    so the blocks run even when read out of order; but **tekton-pipelines inside
#    policy YAML is a literal** (controller ServiceAccount subjects,
#    system:serviceaccount:tekton-pipelines:... and the like) -- a shell variable
#    cannot be substituted in. When targetNamespace is not that name, every
#    occurrence must be edited by hand; a missed one means the rule silently skips.
TEKTON_NS=$(kubectl get tektonconfig config -o jsonpath='{.spec.targetNamespace}')
# Exported so the commands you run from this shell (including subshells and scripts)
# see it. It does NOT survive a new terminal, which is why later blocks re-assert the
# default on their first line instead of trusting the variable to be there.
export TEKTON_NS=${TEKTON_NS:-tekton-pipelines}
echo "Tekton namespace: $TEKTON_NS"

# 2) Checklist items 3 and 4 use --as to query someone else's permissions, which
#    requires impersonate permission; without it the command itself reports
#    forbidden (which is NOT a "permission missing" verdict). If you lack
#    impersonate permission, inspect the ClusterRoleBindings directly instead:
#    kubectl get clusterrolebinding -o json | jq '…kyverno…'
echo "can impersonate serviceaccounts: $(kubectl auth can-i impersonate serviceaccounts)"

# 3) Client tools: besides kubectl, the commands in this document use jq (parsing
#    childReferences / PolicyReport / result JSON) and python3 (generating the
#    regex in §4.5.3). Install whichever is missing -- you can read without them,
#    but the corresponding steps cannot be followed along.
for tool in kubectl jq python3; do
  command -v "$tool" >/dev/null 2>&1 && echo "$tool: ok" || echo "$tool: MISSING"
done
# §4.5.2 reads image labels, and for that EITHER skopeo OR crane is enough -- so this
# one is an either-or, not a per-tool requirement. Missing both only blocks §4.5.2.
if command -v skopeo >/dev/null 2>&1 || command -v crane >/dev/null 2>&1; then
  echo "skopeo/crane: ok (at least one)"
else
  echo "skopeo/crane: BOTH MISSING -- only §4.5.2 needs them"
fi
# The kyverno CLI is a LOCAL binary, separate from the in-cluster Kyverno install --
# having Kyverno running does not give you this command. Only §6.1.6's offline
# evaluation uses it, so missing it blocks nothing on the walkthrough path.
# Probed by running it rather than by resolving its path, so a broken install is
# reported as missing instead of as "ok".
kyverno version >/dev/null 2>&1 \
  && echo "kyverno (CLI): ok" \
  || echo "kyverno (CLI): MISSING or not runnable -- optional, only §6.1.6 uses it"
```

安装完成后，逐项验证本方案依赖的各项能力。这份清单是**能力盘点，不是「全绿才许继续」的关卡**：第 1、2 项是共享前提；第 3、4、5 项只在使用对应章节能力时才需要成立；第 6 项的**层级选择**没有对错——那部分属于规划输入——但其**声明与生成的分组必须一致**（不一致按修复表处理）；第 7 项是**唯一一处「不符合预期」意味着整章策略失效的检查**。**每一项不符合预期时去哪修，见代码块之后的修复表。**

```bash
# 1. All four controllers must be Ready
#    Expect kyverno-admission-controller / background-controller / cleanup-controller /
#    reports-controller with all replicas Ready. A single replica is not acceptable
#    long term in production; size the replica count per your HA plan (§6.1.8).
#    Every item below prints an "== N) ... ==" banner first, so the combined output of
#    this block reads back against the checklist numbers without guessing.
echo "== 1) Kyverno controllers =="
kubectl get deploy -n kyverno

# 2. Tekton controllers and resolver feature flags
#    TEKTON_NS is set by the prerequisite block above; this line only fills it in if you
#    copied this block alone. It is not cosmetic: with the variable unset, `-n ""` reads
#    the CURRENT namespace and still exits 0, so the three checks would report an empty
#    Tekton namespace instead of failing loudly.
: "${TEKTON_NS:=tekton-pipelines}"
echo "== 2) Tekton controllers and resolver flags (ns: $TEKTON_NS) =="
kubectl get deploy -n "$TEKTON_NS"
echo "resolver feature flags:"
kubectl get cm -n "$TEKTON_NS" resolvers-feature-flags -o jsonpath='{.data}{"\n"}'
#    Expect enable-cluster-resolver / enable-hub-resolver / enable-git-resolver to be
#    "true" as required by the resolvers you actually use
echo "hub default-type: $(kubectl get cm -n "$TEKTON_NS" hubresolver-config -o jsonpath='{.data.default-type}')"
HUB_API=$(kubectl get cm -n "$TEKTON_NS" hubresolver-config -o jsonpath='{.data.artifact-hub-api}')
echo "artifact-hub-api: $HUB_API"
#    Expect the in-cluster Artifact Hub (the Shim service) here. A public https://artifacthub.io/
#    means every hub reference in this document resolves against the public hub and 404s --
#    and the flags above stay green while it happens, which is why the next probe exists.

# 2b. Hub endpoint smoke test: the flags only say the resolver is ON, never that its endpoint
#     can actually serve the coordinates this document pins. Resolve-side failures surface far
#     later as CouldntGetPipeline / CouldntGetTask, so probe the five coordinates up front.
#     Pass criterion: every exact version detail endpoint returns HTTP 200 AND a non-empty
#     data.manifestRaw. A package-list 200 is insufficient: the pinned version or its
#     manifest can still be absent. Any failed coordinate makes the whole block exit non-zero.
echo "== 2b) hub endpoint smoke (expect five usable exact-version manifests) =="
kubectl -n '<your-pipeline-namespace>' run hub-smoke-$$ --rm -i --restart=Never \
  --image='<registry>/busybox:latest' --env="HUB_API=$HUB_API" --command -- sh -c '
failed=0
for coordinate in \
  tekton-task/catalog/sonarqube-scanner/0.7 \
  tekton-task/catalog/trivy-scanner/0.6 \
  tekton-task/catalog/skopeo-copy/0.1 \
  tekton-pipeline/catalog/java-image-build-scan-deploy/0.3 \
  tekton-pipeline/catalog/python-image-build-scan-deploy/0.3; do
  body=/tmp/hub-detail.json
  headers=$(wget -S -O "$body" "${HUB_API%/}/api/v1/packages/$coordinate" 2>&1) || true
  code=$(printf "%s\n" "$headers" | awk "/^  HTTP\// { code=\$2 } END { print code }")
  if [ "$code" != 200 ]; then
    echo "$coordinate -> ${code:-UNREACHABLE}"
    failed=1
  elif ! grep -Eq "\"manifestRaw\"[[:space:]]*:[[:space:]]*\"[^\"].*\"" "$body"; then
    echo "$coordinate -> 200 but data.manifestRaw is empty or absent"
    failed=1
  else
    echo "$coordinate -> 200 + non-empty data.manifestRaw"
  fi
done
exit "$failed"'
#     The detail path is
#     <hub-api>/api/v1/packages/<package-type>/<catalog>/<name>/<exact-version>: package type
#     is tekton-task / tekton-pipeline, and <catalog> is the value pinned by taskRef /
#     pipelineRef (this document pins `catalog`) -- NOT the default-*-catalog keys, which only
#     apply when the reference omits the catalog param. The Shim accepts normalized exact
#     SemVer forms (for example 0.1 and 0.1.0), but the probe should use the exact coordinates
#     present in your Run references. Adjust catalog, name and version together.

# 3. RBAC prerequisite for mutate-existing (required by the three mutate-existing
#    cancellation policies: §4.2.2 / §4.6.1 / §4.6.2. §4.2.3 is an ADMISSION mutate
#    on the incoming object and needs no extra RBAC)
echo "== 3) mutate-existing RBAC (only needed for §4.2.2 / §4.6) =="
echo "background-controller can update pipelineruns: $(kubectl auth can-i update pipelineruns.tekton.dev \
  --as=system:serviceaccount:kyverno:kyverno-background-controller -A)"
#    "no" means you must grant it as described in the §4.6 preamble; without the grant Kyverno
#    rejects those policies at creation time

# 4. Effective reports-controller permissions on the Tekton /status subresource
#    (all three verbs: get / list / watch). "no" is usually fine -- see the notes below
echo "== 4) reports-controller perms on /status (no is usually fine) =="
for resource in pipelineruns.tekton.dev taskruns.tekton.dev; do
  for verb in get list watch; do
    echo "  $resource status/$verb: $(kubectl auth can-i "$verb" "$resource" \
      --subresource=status \
      --as=system:serviceaccount:kyverno:kyverno-reports-controller -A)"
  done
done

# 5. PolicyException feature flags (required by §5.3)
echo "== 5) PolicyException flags =="
kubectl get deploy -n kyverno kyverno-admission-controller \
  -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep -i exception
#    Expect BOTH --enablePolicyException=true and --exceptionNamespace=<trusted-namespace>.
#    Only the first one present is the ACP default -- configure the second per §3.1.1

# 6. Webhook failure policy (fail-open or fail-closed while Kyverno is unavailable)
#    and the per-request timeout every rule -- including its external calls (§3.7) -- must fit inside.
#    Read BOTH layers: the per-policy intent declared in spec.webhookConfiguration,
#    then the generated webhook groups (-fail / -ignore) it must land in
echo "== 6) webhook failurePolicy / timeout (declared intent vs generated grouping) =="
kubectl get clusterpolicy -o \
  custom-columns='NAME:.metadata.name,FAILURE_POLICY:.spec.webhookConfiguration.failurePolicy,TIMEOUT:.spec.webhookConfiguration.timeoutSeconds'
# Namespaced Policy objects (§5 project autonomy) carry the same field and are
# NOT in the clusterpolicy listing -- read them too when §5 is in use
kubectl get policy -A -o \
  custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,FAILURE_POLICY:.spec.webhookConfiguration.failurePolicy,TIMEOUT:.spec.webhookConfiguration.timeoutSeconds'
kubectl get validatingwebhookconfiguration -o \
  custom-columns='NAME:.metadata.name,WEBHOOK:.webhooks[*].name,POLICY:.webhooks[*].failurePolicy,TIMEOUT:.webhooks[*].timeoutSeconds' \
  | grep kyverno

# 7. Which resources Kyverno ignores outright, BEFORE any policy is consulted
echo "== 7) Kyverno resourceFilters (silent, pre-policy exemptions) =="
kubectl get cm -n kyverno kyverno -o jsonpath='{.data.resourceFilters}' | tr ' ' '\n' | grep -n ','
#    Expect no entry covering a namespace where pipelines run, and none covering
#    PipelineRun / TaskRun / Pod. A match here produces no denial and no report at all
```

**每一项的预期值，以及结果不符时去哪里处理**（先读这张表，再看表下方三条容易误判的解读）：

| 检查项 | 预期 | 不符合预期时 |
|---|---|---|
| 1 控制器就绪 | 四个控制器全部 Ready | 先查插件安装状态（Marketplace → Cluster Plugins）与 Pod 事件定位故障；副本数按 [§6.1.8](#s6-1-8) 的高可用方案确定，且该变更同样走 [§3.1.1](#s3-1-1) 的 `ModuleInfo.spec.valuesOverride` 入口——对应的 chart values 键为 `admissionController.replicas` / `backgroundController.replicas` / `cleanupController.replicas` / `reportsController.replicas`（四个键都可以直接在已部署 `AppRelease` 的 values 中核对；写入前按 [§3.1.1](#s3-1-1) 同样的方式确认你环境中该 chart 的实际键名）——**不要直接改 Deployment**（平台 reconcile 会还原） |
| 2 resolver 开关与 hub 端点 | 你实际使用的 resolver 均为 `true`；Hub 的 `default-type` 为 `artifact`；`artifact-hub-api` 指向集群内的 Artifact Hub（Shim）服务；**2b 冒烟测试的五个坐标全部返回 200** | 这两个 ConfigMap 由 Tekton operator 托管，直接编辑会被还原——改 `TektonConfig.spec.pipeline`：按需把 `enable-cluster-resolver` / `enable-hub-resolver` / `enable-git-resolver` 设为 `true`；Hub 端点与输出类型都在**同一个位置** `TektonConfig.spec.pipeline.hub-resolver-config`（一个字符串映射，键与 ConfigMap 一致：`artifact-hub-api` / `default-type` / `default-artifact-hub-task-catalog` / `default-artifact-hub-pipeline-catalog`），由 operator reconcile 进 `tekton-pipelines/hubresolver-config`。**不要走 `spec.hub`**——那一节配置的是 Tekton Hub 组件本身，不是 hub resolver。如果不想动平台配置，就让每个 Hub 引用都显式携带 `type=artifact`（[§4.5.1](#s4-5-1)）。**2b 冒烟测试出现 404**：先检查 `artifact-hub-api` 是否为集群内 Shim 地址（指向公网 hub 时，本文的每个 hub 引用都会以 `CouldntGetPipeline` / `CouldntGetTask` 失败，而上面三个开关仍然全绿），再检查坐标中的 catalog 与包名是否与你环境实际发布的内容一致；若端点指向公网 Artifact Hub，按环境配置问题处理——请平台管理员把它指回集群内 Shim 后再继续。**冒烟测试出现 UNREACHABLE**：探针 Pod 到该地址没有网络 / DNS 通路；先修好连通性，再谈策略 |
| 3 mutate-existing RBAC | 若使用 mutate-existing 取消能力（[§4.2.2](#s4-2-2) 与 [§4.6](#s4-6)，共三条策略），应返回 `yes` | 为 `no` 时，授予 [§4.6](#s4-6) 序言给出的聚合 ClusterRole（其 labels 中的 `rbac.kyverno.io/aggregate-to-background-controller: "true"` 标签会把它聚合进 background controller 的权限）。**若想改用 namespace 级 Role，必须同时把 `mutate.targets[].namespace` 从 `{{ request.namespace }}` 改为 namespace 字面量**——否则 Kyverno 创建时的鉴权检查解析不了该变量，只认集群级权限，策略仍会安装失败（见 [§4.6](#s4-6) 序言）。**如果不安装 [§4.2.2](#s4-2-2) / [§4.6](#s4-6) 的 mutate-existing 取消策略，则不需要此权限——[§4.2.3](#s4-2-3) 的 admission mutate 修改的是进入的请求对象，不需要它** |
| 4 reports-controller 读取 status | 六项全为 `yes`（可选，非必需） | 出现 `no` **通常无需处理**（理由见下方第三条解读）。只有当其他特性确实需要 reports-controller 直接读取 status 时，才按第 3 项同样的聚合方式再加一个最小权限 ClusterRole，聚合标签换成 `rbac.kyverno.io/aggregate-to-reports-controller: "true"` |
| 5 PolicyException 开关 | `--enablePolicyException=true` 与 `--exceptionNamespace=<trusted-namespace>` 两者都存在 | 只看到前者是 ACP 的默认状态——按 [§3.1.1](#s3-1-1)，把 `features.policyExceptions` 的 `enabled` / `namespace` 写进 kyverno `ModuleInfo` 的 `spec.valuesOverride["ait/chart-kyverno"]`（**`ModuleInfo` 只存在于 global 管理集群**，见 [§3.1.1](#s3-1-1) 的 warning）；**不要 patch Deployment 参数**。[§3.1.1](#s3-1-1) 提供可直接复制的原子 patch 与回滚命令。**如果不打算使用 PolicyException 豁免（[§5.3](#s5-3)），可以不配置此项** |
| 6 webhook 失败策略与超时 | **先读策略体中声明的意图，再核对生成结果**（字段语义、生成侧的 ⚠️ 时序陷阱、平台级覆盖开关的影响见 [§3.1.2](#s3-1-2)——那是该机制的完整版本）：声明意图用 `kubectl get clusterpolicy -o custom-columns='NAME:.metadata.name,FAILURE_POLICY:.spec.webhookConfiguration.failurePolicy,TIMEOUT:.spec.webhookConfiguration.timeoutSeconds'` 查看（在使用 [§5](#s5) 的 namespace 级 `Policy` 对象时，还要用相同的列读 `kubectl get policy -A`——它们绝不会出现在 clusterpolicy 列表中，跳过它们就漏检了它们的声明），再看生成的 webhook，它们**按值分组生效**（`validate.kyverno.svc-fail` / `validate.kyverno.svc-ignore`，各自携带自己的 `failurePolicy` / `timeoutSeconds`）。本文所有策略资产都显式声明该项（分层理由见 [§3.7](#s3-7)） | 声明与分组不一致、或某条策略需要不同层级时：**修改该策略体的 `spec.webhookConfiguration` 并用 GitOps 管理**——这是唯一能表达按策略分层的入口；三个陷阱（`ModuleInfo` 只能平台级覆盖、`timeoutSeconds` 是单请求总预算、绝不手改 `ValidatingWebhookConfiguration`）见 [§3.1.2](#s3-1-2) |
| 7 Kyverno 直接忽略的资源 | 过滤列表中**没有**覆盖流水线所在 namespace 的条目，也没有覆盖 `PipelineRun` / `TaskRun` / `Pod` 的条目 | `kyverno` ConfigMap 中的 `resourceFilters` 在**任何策略之前**生效：命中的请求既不被拒绝，也不记入 PolicyReport，也不留日志——一条**完全静默**的豁免通道。出厂值一般排除四个 namespace（**以上面命令实际读到的值为准**）——`kyverno` / `kube-system` / `kube-public` / `kube-node-lease`：同一个违规 Pod 在 `policy-poc` 被拒绝，在 `kube-system` 却一路放行。因此 ① 不要在被排除的 namespace 里跑流水线；② 要清楚以 `namespaces: ["*"]` 写的策略天生带着这个洞；③ 这份配置的写权限必须与 `ClusterPolicy` 同级管控（[§5.0](#s5-0)） |

上面的解读中有三条容易出错：

- **第 2 项的 `default-type`**：本文允许 Hub 引用省略 `type` 参数，前提是该平台设置输出 `artifact`。若不是，要么先治理好该平台设置，要么要求每个 Hub 引用都显式写 `type=artifact`（[§4.5.1](#s4-5-1)）。
- **第 4 项必须带 `--subresource=status`**：把 `taskruns.tekton.dev/status` 作为位置参数传给 `kubectl auth can-i` 会被解析为 `TYPE/NAME`——你查的不是 status 子资源权限，而是一个名为 `status` 的对象。
- **第 4 项返回 `no` 不代表要立刻放宽权限**：`background: false` 的 status Audit 经 admission report 链路聚合，不要求 reports-controller 直接读取 TaskRun / PipelineRun 的 status；即使六项权限全为 `no`，[§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2) 依然会产出终态 PolicyReport。因此**不要仅因策略创建时出现权限告警就扩大 ClusterRole**——先跑一次真实的受控请求，确认 PolicyReport 是否从早期的 skip 收敛为终态 pass/fail；只有当其他特性确实需要 reports-controller 直接读取 status 时，才单独按最小权限授予。
#### 3.1.1 启用 PolicyException（可选；§5.3 必需） {#s3-1-1}

ACP 的 “Compliance for Kyverno” 插件**默认交付时只带 `--enablePolicyException=true`，不带 `--exceptionNamespace`**。这个默认状态最具迷惑性：PolicyException 对象**可以创建成功**，仅有一条警告 `The exceptionNamespace flag is not set` —— 但它**完全不生效**：豁免已经就位，目标资源仍然被拒绝。这两个 flag 必须一起配置，Kyverno 只认 `--exceptionNamespace` 指向的那个 namespace 中的 PolicyException（这正是豁免权限被收口的地方，[§5.3](#s5-3)）。该 flag **接受单个 namespace 名称，或 `*`**（表示任意 namespace 中的 PolicyException 都生效）——**不支持多个 namespace**（在 Kyverno 1.15 线上已确认；多 namespace 列表的需求已在上游提出 —— [kyverno#6980](https://github.com/kyverno/kyverno/issues/6980) —— 并于 2026-01 以 not-planned 关闭，因为 informer 只有“单 namespace / 整集群”两种形态，实现复杂）。在多项目 / 多租户环境中，这一单值约束会落到以下两种方式之一：

- **集中审批（本文档采用）**：受信 namespace **归属于审批方（平台）**；项目成员从不进入它 —— 豁免走申请-审批流程，由审批者身份代申请方签发（这正是 [§5.3](#s5-3) 演示的模型）。项目之间的天然隔离不受影响：这个 namespace 不是各项目共享的空间，而是审批流程的落点。**不要**让多个项目共用一个受信 namespace 并自助签发豁免 —— RBAC 只能管“谁可以创建 PolicyException”，管不了“豁免内容是否越界”（`spec.match` 可以写任意 namespace），因此项目 A 可以创建一条豁免项目 B 流水线的例外。
- **项目自治（`*`）**：各项目在自己的 namespace 中创建 PolicyException，签发权限跟随项目 RBAC。此模式下**必须**追加一条元策略，把 PolicyException 限制为**只能豁免其所在 namespace 内的资源** —— 否则上文“内容越界”问题在每个 namespace 中都成立；并且每个项目中 `policyexceptions` 的写权限都必须显式收紧 —— 默认角色不应携带该权限。

:::warning ModuleInfo 仅存在于 global 管理集群；业务集群没有该资源

`ModulePlugin` / `ModuleConfig` / `ModuleInfo` 都是平台管理面对象，**只存在于 global 管理集群**。在运行 Kyverno 的业务集群上执行 `kubectl get moduleinfo` 什么也查不到 —— 那个集群甚至没有这个 CRD。因此**本节的定位与 patch 命令必须用 global 集群的 kubeconfig 执行**；而第 4 点三处确认中的 ② Deployment args 与 ③ rollout 及 Pod 实际参数，必须在 **Kyverno 所在的集群**上执行。

另外注意，在 global 上，一个插件**每个安装目标集群各有一个 `ModuleInfo`**，所以在断言“恰好一条匹配”之前必须先按目标集群收窄 —— 平台用 `cpaas.io/cluster-name` 标记交付目标；安装在 global 集群自身上的实例可能不带该标签，此时通过指向其 `Cluster` 对象的 ownerReference 来识别。

下面的命令按 Kyverno 与 Tekton 同集群的场景编写，因此不存在跨集群切换；如果你的环境将两者分开部署，请按上文所述把命令拆到两侧执行。

:::

正确的启用路径有四个要点：

1. **绝不要直接 patch controller Deployment 的 args** —— 平台 reconcile 会把它改回去（见上方警告）。
2. **覆盖入口是插件 `ModuleInfo` 的 `spec.valuesOverride`**，不是 `spec.config`。kyverno 的 `ModuleInfo` 默认 spec 中只有 `version`；`spec.config` 是模块实例的用户配置，不是 chart values 的覆盖面 —— 改错字段则什么都不会生效。`valuesOverride` 按 **chart 名称**分层（与 `ModuleConfig.spec.valuesTemplates` 同构），chart 名称是 `ait/chart-kyverno`。
3. **定位 ModuleInfo 必须断言唯一性**：在 global 集群上，按模块标签精确查询，再按目标集群标签收窄，然后硬性断言恰好 1 条匹配；不要靠版本或 `global-` 前缀去猜，也不要默默取 `items[0]`。
4. **改完后在三处确认 —— 一处都不能少**：① `AppRelease` 已合入这些 values；② Deployment 模板 args 携带该 flag；③ rollout 已完成且**每个 Ready 的 admission Pod** 实际运行着新参数。只看 Deployment 模板、或只命中一个新 Pod，不足以证明 HA 滚动更新期间每个在役实例都已切换。

:::warning 单节点 / CPU 紧张的集群：配置可能是对的，flag 却仍未生效

admission-controller 的 rollout **先起 surge pod，再退旧 pod**（`maxUnavailable` 实际为 0）；在 CPU 不足的节点上 surge pod 会 Pending，rollout 卡死，旧 pod 继续提供服务，症状是 PolicyException 仍然报 `exceptionNamespace flag is not set` —— 这不是配置错误。**判据只有一条：在役 pod 实际运行着什么参数**（第 4 点的 ③）；flag 出现在 Deployment 模板上不代表它出现在在役 pod 上。卡住时，释放节点资源、让 rollout 自行完成 —— 不要指望删掉某个旧 pod 就够了（新 pod 的实际资源请求未必等于模板值）。

:::

⚠️ **先看它当前指向哪里**：`--exceptionNamespace` **只接受一个值**。如果集群已经启用了它、并指向另一个承载着真实豁免的 namespace，把它改成演示值会让**那些豁免全部立即失效**（并且在你改回去之前一直失效）。这种情况下不要改 —— 复用既有的受信 namespace 来跑 [§5.3](#s5-3)（[§5.3](#s5-3) 开头读取的正是该值；文中的 `policy-exceptions` 只是本文档 [§3.1.1](#s3-1-1) 配置出来的值，不是必须匹配的常量）。这项更改是一个**在目标集群上全局唯一**的开关；任一时刻只应有一个人在动它。

**本节需要你提供的所有取值都汇总在下面的输入块里** —— 后续所有块（a)–g) 各块、落盘块、回读块）都只引用这里设置的变量，不再携带任何 `<...>` 占位符，所以此块必须最先执行：

```bash
# The ONLY user-supplied inputs of this section, gathered in one place so a pasted
# block never hides a <placeholder> in its middle; later blocks validate these
# variables instead of re-declaring them.
GLOBAL_KUBECONFIG='<path-to-global-kubeconfig>'  # kubeconfig of the GLOBAL management cluster
TARGET_CLUSTER='<cluster-name>'                  # the cluster Kyverno runs on; a) narrows its query by it
TRUSTED_EXCEPTION_NS='<trusted-namespace>'       # namespace that will hold PolicyExceptions (§5.3)
# ModuleInfo lives only on the global management cluster, so every command in this
# section goes through this one wrapper. A shell FUNCTION, not a KGLOBAL="kubectl ..."
# string: zsh keeps an unquoted expansion as one word, so the string form pasted into
# an interactive zsh looks for a command literally named "kubectl --kubeconfig ...".
# The :? inside makes every call refuse by name in a shell that never ran this block.
KGLOBAL() {
  kubectl --kubeconfig "${GLOBAL_KUBECONFIG:?run the inputs block at the top of §3.1.1 in this shell first}" "$@"
}
KGLOBAL config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
```

最后那条命令打印出的 API server 地址必须是**你打算修改的 global 集群**；如果不是，先修正 kubeconfig 再继续。

**执行顺序总览** —— a)–g) 全部位于下方的可折叠块中；顺序不可改变，且**不要把整个可折叠块一次性粘贴执行**（e) 是回滚 —— 一次跑完等于启用后立刻回退）：

1. **开始前先检查旧账本**：如果 `ls moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json 2>/dev/null` 有任何输出，说明上一轮启用从未回滚 —— 先用“在新终端中恢复回滚状态”块重新加载该状态，执行 e)–g) 收尾那一轮，然后再开始新的一轮。此步骤必须在 a) 之前进行：一旦 c) 执行过，那个全局唯一的开关就已经被改掉了。
2. **启用**：a) 定位并断言唯一性 → b) 保存原始值 → **落盘**（把回滚状态持久化到上面三个文件；这一步必须在 c) 之前 —— c) 不可逆，而在状态落盘之前“原始值”只存在于当前 shell：此刻关掉终端它就永远丢了，事后重跑 b) 只会把已修改的值记录成原始值）→ c) 原子写入 → d) 三处确认。
3. **使用**：去执行 [§5.3](#s5-3)；等它全部完成并清理干净后再回来做回滚。
4. **回滚**：e) 原子恢复 → f) 按 d) 的方式确认已生效 → g) 删除回滚文件。若中途切换过终端，先用“在新终端中恢复回滚状态”块从文件重建状态 —— **绝不要重跑 b)**。此恢复属于平台侧配置；它不属于任何小节的“清理”小节，只能在这里手工执行。

:::details 启用与回滚命令（原子 JSON Patch，可直接复制粘贴）

```bash
# a) Locate the ModuleInfo on the GLOBAL management cluster and assert the match is unique.
#    ModuleInfo exists only there -- the cluster running Kyverno has no such resource.
#    KGLOBAL and TARGET_CLUSTER come from the inputs block at the top of §3.1.1; stop
#    here if this shell never ran it, rather than query the wrong cluster.
: "${GLOBAL_KUBECONFIG:?run the inputs block at the top of §3.1.1 in this shell first}"
# Presetting GLOBAL_KUBECONFIG by hand is not enough -- the KGLOBAL wrapper
# function must exist too, or every call below dies as "command not found".
command -v KGLOBAL >/dev/null || : "${KGLOBAL:?run the inputs block at the top of §3.1.1 in this shell first}"
: "${TARGET_CLUSTER:?run the inputs block at the top of §3.1.1 in this shell first}"
#    One plugin gets one ModuleInfo per target cluster, so narrow the query to the cluster
#    Kyverno runs on before asserting uniqueness. An instance installed onto the global
#    cluster itself may carry no cpaas.io/cluster-name label -- identify that one by the
#    ownerReference pointing at its Cluster object instead of by this selector.
#    ModuleInfo is CLUSTER-SCOPED -- it has no namespace, so nothing here passes -n.
MODULES=$(KGLOBAL get moduleinfo -o json \
  -l cpaas.io/module-name=kyverno,cpaas.io/cluster-name="$TARGET_CLUSTER")
#    `test ... -eq 1` on its own line does NOT stop an interactive shell: it only sets $?,
#    and the next line would take items[0] anyway -- the very thing point 3 above forbids.
#    Branch instead, so a non-unique match leaves MODULE unset and c) cannot run.
if [ "$(jq '.items | length' <<<"$MODULES")" -ne 1 ]; then
  echo "expected exactly ONE ModuleInfo, got $(jq '.items | length' <<<"$MODULES") --"
  echo "narrow the selector by target cluster first; do NOT continue to b)/c)."
  unset MODULE
else
  MODULE=$(jq -r '.items[0].metadata.name' <<<"$MODULES")
  echo "target ModuleInfo: $MODULE"
fi

# b) Save the complete original spec and compute the target spec to write.
#    Keeping the original verbatim is what lets the rollback restore an absent field,
#    an explicit null, or an arbitrary non-empty object exactly as it was.
: "${TRUSTED_EXCEPTION_NS:?run the inputs block at the top of §3.1.1 in this shell first}"
#    a) prints "do NOT continue to b)/c)" when the match is not unique -- but printing is not
#    stopping, and the whole block is pasted in one go, so b) has to refuse for itself. A bare
#    `: "${MODULE:?...}"` would not do it either: in an INTERACTIVE shell that fails only that
#    one command and the next line still runs. Branch, exactly as a) does.
if [ -z "${MODULE:-}" ]; then
  echo "a) did not settle on exactly one ModuleInfo -- fix a) first; b) and c) are skipped."
else
  ORIGINAL_MODULEINFO_SPEC=$(KGLOBAL get moduleinfo "$MODULE" -o json | jq -c '.spec')
  TEST_MODULEINFO_SPEC=$(jq -c --arg ns "$TRUSTED_EXCEPTION_NS" '
    .valuesOverride = (.valuesOverride // {}) |
    .valuesOverride["ait/chart-kyverno"].features.policyExceptions = {
      enabled: true,
      namespace: $ns
    }
  ' <<<"$ORIGINAL_MODULEINFO_SPEC")
fi
```

**b) 完成后、动 c) 之前先落盘** —— e) 所依赖的状态（`GLOBAL_KUBECONFIG`、`MODULE`、两份 spec）此刻只存在于当前 shell；先把它写入三个回滚文件，看到 `saved:` 后再继续：

```bash
# Everything here comes from earlier blocks IN THIS SHELL: GLOBAL_KUBECONFIG (which
# the KGLOBAL wrapper reads) from the inputs block at the top of §3.1.1, the rest
# from a)-b). Checked first and by name -- a bare "command not found: KGLOBAL"
# further down would not say which piece of state is missing.
if [ -z "$GLOBAL_KUBECONFIG" ] || ! command -v KGLOBAL >/dev/null \
   || [ -z "$MODULE" ] \
   || [ -z "$ORIGINAL_MODULEINFO_SPEC" ] || [ -z "$TEST_MODULEINFO_SPEC" ]; then
  echo "missing state in this shell -- run the inputs block (GLOBAL_KUBECONFIG +"
  echo "the KGLOBAL wrapper) and a)+b)"
  echo "(MODULE / the two specs) here first, then this block."
  # Refuse to overwrite: if these files are already here, an earlier enable was never
  # rolled back, and b) has just captured the ALREADY-MODIFIED spec as "the original".
  # Overwriting would destroy the only record of the true original value.
elif [ -e moduleinfo-target.txt ] || [ -e moduleinfo-original.json ] \
   || [ -e moduleinfo-expected.json ]; then
  # Any of the three still here means an earlier enable was never rolled back -- and
  # b) has just captured the ALREADY-MODIFIED spec as "the original". Overwriting
  # would destroy the only record of the true original value.
  echo "rollback files from an earlier run are still here, so what this shell is"
  echo "holding as 'the original' is really the PREVIOUS round's modified spec."
  echo "Do NOT run c). The true original is in moduleinfo-original.json: load it with"
  echo "the read-back block below, run e)+f)+g) to finish THAT round, then start over."
  # Not just a printed refusal: e) reads these variables, and running it with
  # what this shell currently holds would write the previous round's change back as
  # if it were the original. Clearing them makes e) fail until the read-back block
  # has reloaded the real values from the files.
  unset MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC
  # The API server URL goes in too: a name alone does not identify a CLUSTER, and
  # e)'s test would happily pass against a same-named ModuleInfo on another global
  # cluster whose current spec matches -- writing this cluster's original onto it.
  # The uid is the tie-breaker: one kubeconfig can spell the same API server several
  # ways (DNS alias, load balancer, :443 written out, a tunnel), so a URL mismatch on
  # the way back is not proof of a different cluster -- the uid settles it.
  # Each value is read and checked separately: inside `printf "$(...)"` a failed
  # command substitution is invisible, and an empty field would still print "saved".
elif ! saved_api=$(KGLOBAL config view --minify \
       -o jsonpath='{.clusters[0].cluster.server}') || [ -z "$saved_api" ]; then
  echo "could not read the API server URL out of this kubeconfig -- fix that first."
elif ! saved_uid=$(KGLOBAL get moduleinfo "$MODULE" \
       -o jsonpath='{.metadata.uid}' 2>&1) || [ -z "$saved_uid" ]; then
  echo "could not read the ModuleInfo uid ($saved_uid)."
  echo "Do NOT run c) yet: with no uid there is nothing to bind the rollback files to,"
  echo "and c) is the step that makes this shell's variables irreplaceable."
elif ! printf '%s %s %s\n' "$MODULE" "$saved_api" "$saved_uid" \
        > moduleinfo-target.txt \
     || ! printf '%s' "$ORIGINAL_MODULEINFO_SPEC" > moduleinfo-original.json \
     || ! printf '%s' "$TEST_MODULEINFO_SPEC"     > moduleinfo-expected.json; then
  # "Run this block again" is not enough on its own: a partial write can leave one or
  # two of the three files behind, and the guard at the top would then read them as an
  # earlier round's rollback and refuse -- with the true values still only in this
  # shell. They came from THIS block, seconds ago, so deleting them is safe here and
  # nowhere else; say so explicitly rather than leaving the reader in that deadlock.
  echo "writing the rollback files failed -- do NOT run c), and do NOT close this shell:"
  echo "its variables are the only copy. Free space / fix permissions, then delete"
  echo "whatever this attempt left behind and run this block again:"
  echo "  rm -f moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json"
  echo "(safe ONLY right here: at the top of this block none of the three existed.)"
else
  echo "saved: rollback for $MODULE (uid $saved_uid)"
fi
```

```bash
# Same-shell state from the inputs block, a)-b) and the save block; fail by name here
# instead of feeding jq an empty --argjson or patching a nameless object.
# Collected and branched, not `: "${VAR:?msg}"` -- see block b) for why that shape does
# not guard a block that writes.
#
# `$MODULE` is also checked against the name the save block recorded. An unset variable is
# caught by the emptiness test; a STALE one -- left in a reused shell by an earlier attempt
# -- is not, and it is the dangerous case, because the patch would then rewrite a DIFFERENT
# ModuleInfo that the rollback files do not describe.
missing=
for v in GLOBAL_KUBECONFIG TRUSTED_EXCEPTION_NS MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC; do
  eval "[ -n \"\${$v:-}\" ]" || missing="$missing $v"
done
command -v KGLOBAL >/dev/null || missing="$missing KGLOBAL(the wrapper function)"
# The rollback files are inputs here too: this is a block that CHANGES the cluster, and
# it must not run unless the on-disk record to roll back from exists. The target file
# carries three fields (name, API server URL, uid) -- the recovery block needs all
# three -- so the stale-shell comparison reads only the first field, not the whole line.
for f in moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json; do
  [ -s "$f" ] || missing="$missing $f(missing or empty -- the save block has not written it)"
done
if [ -z "$missing" ]; then
  read -r saved_name _ < moduleinfo-target.txt
  if [ "$MODULE" != "$saved_name" ]; then
    missing="$missing MODULE(='$MODULE' but the save block recorded '$saved_name' -- stale shell?)"
  fi
fi
if [ -n "$missing" ]; then
  echo "NOT RUN -- missing or inconsistent state from earlier blocks IN THIS SHELL:$missing"
  echo "Run the inputs block at the top of §3.1.1, then a), b) and the save block, then paste this block again."
else
  # c) Atomic write (still on the global cluster): the test op guarantees no concurrent
  #    modification happened -- on conflict the whole patch fails instead of silently overwriting
  KGLOBAL patch moduleinfo "$MODULE" --type json -p \
    "$(jq -cn \
      --argjson expected "$ORIGINAL_MODULEINFO_SPEC" \
      --argjson replacement "$TEST_MODULEINFO_SPEC" '
      [
        {op:"test",path:"/spec",value:$expected},
        {op:"replace",path:"/spec",value:$replacement}
      ]
    ')"

  # d) Confirm in three places -- after waiting out the reconcile. The platform
  #    propagates asynchronously (ModuleInfo -> AppRelease -> Deployment -> rollout), and
  #    until the Deployment TEMPLATE has actually changed, (3)'s `rollout status` returns
  #    success for the PREVIOUS, already-finished rollout and the closing jq prints false:
  #    pasted in one go straight after c), every check below races the operator and
  #    proves nothing (live run on the validation environment: apprelease empty, args unchanged,
  #    "successfully rolled out", `false` -- and 30s later all four converged). So first
  #    wait, bounded, for the observable precondition: the template carrying the flag.
  #    Steps (2) and (3) inspect the workloads, so run them against the cluster Kyverno runs
  #    on -- that is the global cluster only when Kyverno is installed there.
  EXPECTED_ARG="--exceptionNamespace=$TRUSTED_EXCEPTION_NS"
  elapsed=0
  #    `--` before the pattern is required, not tidiness: the pattern itself starts with
  #    `--`, and without the separator grep parses it as an option and dies with
  #    "unrecognized option" on every iteration. The loop would then never succeed --
  #    it burns the full timeout and reports the reconcile as stuck on an enable that
  #    actually worked, sending you off to debug an operator that is fine.
  until kubectl get deploy -n kyverno kyverno-admission-controller \
          -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -qF -- "$EXPECTED_ARG"; do
    if [ "$elapsed" -ge 120 ]; then
      echo "no $EXPECTED_ARG on the Deployment template after ${elapsed}s -- the reconcile"
      echo "is stuck, not merely slow. Check the kyverno AppRelease/operator, then re-run d)."
      break
    fi
    sleep 5; elapsed=$((elapsed + 5))
  done

  #    (1) AppRelease has merged the values; expect {"enabled":true,"namespace":"<trusted-namespace>"}
  kubectl get apprelease -n cpaas-system kyverno \
    -o jsonpath='{.spec.values.features.policyExceptions}'

  #    (2) The Deployment template args now carry the flag (re-run item 5 of the checklist)
  kubectl get deploy -n kyverno kyverno-admission-controller \
    -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep -i exception

  #    (3) Rollout finished AND every Ready admission Pod actually runs the new arg
  kubectl rollout status deployment/kyverno-admission-controller -n kyverno --timeout=5m
  #    rollout status can return in the brief window before the new admission Pod flaps
  #    NotReady to reload config with the changed arg; for that instant there are zero
  #    Ready Pods and the jq below (which requires `($ready|length)>0`) would print false
  #    on an enable that in fact succeeded. Wait for a Ready Pod first so the check reads
  #    steady state, not the flap. Best-effort: on timeout the jq still runs and prints
  #    the real verdict.
  kubectl wait --for=condition=Ready pod -n kyverno \
    -l app.kubernetes.io/component=admission-controller --timeout=120s
  kubectl get pod -n kyverno -l app.kubernetes.io/component=admission-controller -o json | \
    jq -e --arg expected "$EXPECTED_ARG" '
      [.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] as $ready
      | ($ready | length) > 0
        and all($ready[];
          any(.spec.containers[]?;
            .name == "kyverno" and any(.args[]?; . == $expected)))
    '
fi
```

d) 的三处确认通过后，去执行 [§5.3](#s5-3)；等 **[§5.3](#s5-3) 的全部步骤**完成并清理干净后再回来执行 e)–g)。若已切换过终端，先用下方“在新终端中恢复回滚状态”可折叠块重建状态。

```bash
# Same-shell state again -- from the shell that ran a)-d), or rebuilt by the recovery
# block below. Refuse by name rather than patch a nameless object as the admin user.
# Collected and branched, not `: "${VAR:?msg}"` -- see block b) for why that shape does
# not guard a block that writes.
#
# `$MODULE` is also checked against the name the save block recorded. An unset variable is
# caught by the emptiness test; a STALE one -- left in a reused shell by an earlier attempt
# -- is not, and it is the dangerous case, because the patch would then rewrite a DIFFERENT
# ModuleInfo that the rollback files do not describe.
missing=
for v in GLOBAL_KUBECONFIG MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC; do
  eval "[ -n \"\${$v:-}\" ]" || missing="$missing $v"
done
command -v KGLOBAL >/dev/null || missing="$missing KGLOBAL(the wrapper function)"
# The rollback files are inputs here too: this is a block that CHANGES the cluster, and
# it must not run unless the on-disk record to roll back from exists. The target file
# carries three fields (name, API server URL, uid) -- the recovery block needs all
# three -- so the stale-shell comparison reads only the first field, not the whole line.
for f in moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json; do
  [ -s "$f" ] || missing="$missing $f(missing or empty -- the save block has not written it)"
done
if [ -z "$missing" ]; then
  read -r saved_name _ < moduleinfo-target.txt
  if [ "$MODULE" != "$saved_name" ]; then
    missing="$missing MODULE(='$MODULE' but the save block recorded '$saved_name' -- stale shell?)"
  fi
fi
if [ -n "$missing" ]; then
  echo "NOT RUN -- the rollback would target the wrong object or fail halfway:$missing"
  echo "Rebuild state with the 'Recovering rollback state in a new terminal' block below, then paste this block again."
else
  # e) Rollback (global cluster again): test that the current spec still equals what we wrote,
  #    then replace it with the complete original spec. A failing test means someone else
  #    changed the ModuleInfo meanwhile -- do a manual three-way merge and revert only the
  #    policyExceptions change.
  KGLOBAL patch moduleinfo "$MODULE" --type json -p \
    "$(jq -cn \
      --argjson expected "$TEST_MODULEINFO_SPEC" \
      --argjson original "$ORIGINAL_MODULEINFO_SPEC" '
      [
        {op:"test",path:"/spec",value:$expected},
        {op:"replace",path:"/spec",value:$original}
      ]
    ')"

  # f) Confirm the rollback the same way d) confirmed the enable -- a patched ModuleInfo is
  #    not a withdrawn flag. Until the platform has reconciled and the Pods have rolled,
  #    `--exceptionNamespace` is still live on the admission controllers actually serving
  #    requests, which means every PolicyException in that namespace is still in force.
  #    The asymmetry is the trap: enabling has three confirmations, and a rollback that
  #    just ends looks equally finished while leaving the exemption entrance open.
  #    Expect: an empty/absent policyExceptions value, no exception flag in the args, and
  #    the jq below printing true (every Ready admission Pod is free of the flag).
  #    (1)-(3) inspect workloads, so like d) they run against the cluster Kyverno runs on,
  #    not the global one -- plain kubectl, not the KGLOBAL wrapper.
  #    Same operator race as d), mirrored: until the Deployment template has dropped the
  #    flag, `rollout status` blesses the PREVIOUS rollout and the jq below prints false
  #    while the exemption entrance is still open. Wait, bounded, for the drop first.
  elapsed=0
  until ! kubectl get deploy -n kyverno kyverno-admission-controller \
          -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q 'exceptionNamespace'; do
    if [ "$elapsed" -ge 120 ]; then
      echo "the Deployment template still carries --exceptionNamespace after ${elapsed}s --"
      echo "the reconcile is stuck and the exemption entrance is STILL OPEN. Check the"
      echo "kyverno AppRelease/operator, then re-run f); do not proceed to g)."
      break
    fi
    sleep 5; elapsed=$((elapsed + 5))
  done
  # Re-check once, explicitly: the loop above exits BOTH when the flag dropped and when
  # the timeout branch broke out of it, and g) below must not have to guess which. A
  # failed read answers "no match" too, so capture the read and require it to succeed
  # before interpreting emptiness as absence.
  if ARGS_NOW=$(kubectl get deploy -n kyverno kyverno-admission-controller \
        -o jsonpath='{.spec.template.spec.containers[0].args}' 2>&1) \
     && ! printf '%s' "$ARGS_NOW" | grep -q 'exceptionNamespace'; then
    flag_dropped=yes
  else
    flag_dropped=no
  fi
  kubectl get apprelease -n cpaas-system kyverno \
    -o jsonpath='{.spec.values.features.policyExceptions}{"\n"}'
  kubectl get deploy -n kyverno kyverno-admission-controller \
    -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep -i exception
  kubectl rollout status deployment/kyverno-admission-controller -n kyverno --timeout=5m
  # Same readiness flap as d): rollout status can return just before the admission Pod
  # flaps NotReady to reload config, and the jq below requires at least one Ready Pod, so
  # a single shot would print false on a rollback that in fact completed. Wait for a Ready
  # Pod first; best-effort, the jq still runs and prints the real verdict on timeout.
  kubectl wait --for=condition=Ready pod -n kyverno \
    -l app.kubernetes.io/component=admission-controller --timeout=120s
  kubectl get pod -n kyverno -l app.kubernetes.io/component=admission-controller -o json | \
    jq -e '
      [.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] as $ready
      | ($ready | length) > 0
        and all($ready[];
          all(.spec.containers[]?;
            .name != "kyverno" or all(.args[]?; (. | test("exceptionNamespace")) | not)))
    '

  # g) Only now retire the rollback files. Leaving them behind is not harmless: the check
  #    you are told to run before the NEXT enable ("ls moduleinfo-*") reads any of them as
  #    "the previous round was never rolled back", and the save block then refuses to
  #    record the new round and clears its variables. Delete them only after f) came back
  #    clean -- while any of it is unconfirmed, these three files are still the record.
  if [ "$flag_dropped" = yes ]; then
    rm -f moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json
  else
    echo "KEEPING the rollback files: the Deployment template still carries (or could not"
    echo "be confirmed free of) --exceptionNamespace, so the withdrawal is unconfirmed and"
    echo "these three files are still the only record. Re-run f); delete only when it is clean."
  fi
  unset flag_dropped
fi
```


:::

:::details 在新终端中恢复回滚状态（按需，在执行 e) 之前）

**从文件读取目标；不要靠重新查询来选定**：

```bash
# A new terminal has none of the variables, so re-declare the wrapper here (this is the
# one place it is re-declared on purpose -- everywhere else it comes from the block at
# the top of this section).
GLOBAL_KUBECONFIG='<path-to-global-kubeconfig>'
KGLOBAL() {
  kubectl --kubeconfig "${GLOBAL_KUBECONFIG:?fill GLOBAL_KUBECONFIG in this block first}" "$@"
}
# The saved target is the authority. Re-running a) would pick an object by querying
# again -- point it at the wrong cluster and e)'s test could pass against a DIFFERENT
# ModuleInfo whose current spec happens to equal the saved one, writing this cluster's
# original spec onto somebody else's object.
# Guarded on purpose: a missing or empty file must stop you here, not leave MODULE
# empty and let the patch below run against a name the API server fills in for you.
if [ -s moduleinfo-target.txt ] && [ -s moduleinfo-original.json ] \
   && [ -s moduleinfo-expected.json ] \
   && read -r MODULE SAVED_API SAVED_UID < moduleinfo-target.txt \
   && [ -n "$SAVED_UID" ]; then
  # The read is kept OUT of the condition above and its exit status kept: an
  # unreachable API server, a missing token and a deleted object all answer "empty"
  # to a `2>/dev/null` query, and only one of those means "wrong cluster".
  if ! live_uid=$(KGLOBAL get moduleinfo "$MODULE" \
       -o jsonpath='{.metadata.uid}' 2>&1); then
    echo "could not read $MODULE ($live_uid)."
    echo "NotFound means wrong cluster or a deleted object; anything else (Forbidden,"
    echo "connection refused, timeout) says nothing at all about what is there."
    echo "Fix the kubeconfig / RBAC / connectivity and run this block again."
    # Cleared AFTER the message, so the message can still name the target.
    unset MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC
  elif [ "$live_uid" != "$SAVED_UID" ]; then
    echo "same name, DIFFERENT object (live $live_uid vs saved $SAVED_UID): the"
    echo "ModuleInfo was recreated, or this is another cluster. The saved spec belongs"
    echo "to an object that no longer exists -- do a manual three-way merge instead."
    unset MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC
  else
    # The uid is what binds this file to an OBJECT; the URL below is only a hint about
    # which cluster you were on. Same uid = same object, whatever the URL says.
    ORIGINAL_MODULEINFO_SPEC=$(cat moduleinfo-original.json)
    TEST_MODULEINFO_SPEC=$(cat moduleinfo-expected.json)
    echo "rollback target: $MODULE (uid $SAVED_UID)"
    [ "$SAVED_API" = "$(KGLOBAL config view --minify \
        -o jsonpath='{.clusters[0].cluster.server}')" ] \
      || echo "note: the API server is spelled differently than when saved ($SAVED_API) -- same object though"
  fi
else
  # A printed refusal is only a refusal if something downstream reads it. Nothing
  # stops you from pasting e) anyway, and stale values left in this shell from an
  # earlier session would let it patch the WRONG ModuleInfo -- successfully. So
  # clear them: e) then stops at its state guard, which is the intended outcome.
  unset MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC
  echo "the three saved files are not all here (or the target line has no uid) --"
  echo "do NOT run e) from memory. Recover them from the shell that ran a)-d), or do"
  echo "a manual three-way merge: read the live spec, remove only the policyExceptions"
  echo "change, write it back."
fi
```

重跑 a) 做交叉核对没有问题，但**查询结果必须与 `moduleinfo-target.txt` 逐字一致 —— 如有出入，停下来排查**。**绝不要重跑 b)** —— 此时集群上的 spec 已经是修改后的了，b) 会把“原始值”记录成改过的值，回滚就永远丢失了；除了目标与这两份 spec，e) 不依赖 b) 的任何东西。

:::
#### 3.1.2 Webhook 失败策略与超时：字段语义、读取时机与分层调整方式 {#s3-1-2}

本小节展开检查清单第 6 项，并且是本文档中 `failurePolicy` 机制的**唯一事实来源** —— [§3.7](#s3-7) 的分层权衡、[§4.0.7](#s4-0-7) 第 1 步的部署检查、[§6.1.8](#s6-1-8) 的控制平面观察都回指这里；机制层面的修订只落在本小节。

- **字段语义**：策略级入口是每条策略自己的 `spec.webhookConfiguration.failurePolicy` / `.timeoutSeconds`（同一策略内所有规则共享；允许值 `Ignore` / `Fail`，默认 `Fail`；超时默认 `10`，范围 1–30 —— 依 1.15 CRD）。旧的顶层 `spec.failurePolicy` / `spec.webhookTimeoutSeconds` 已弃用，新旧同时声明会在安装时被拒绝。`timeoutSeconds` 是**单个请求的总预算**，不是每条规则各自的额度 —— [§3.7](#s3-7) 的外部调用必须装进这个数字之内。
- ⚠️ **读取生成侧对时机敏感**：`kyverno-resource-validating-webhook-cfg`（真正管辖 `PipelineRun` / `TaskRun` / `Pod` 的那一个）是 **Kyverno 根据已安装策略动态生成的** —— 在未安装本文档任何策略时它的 `webhooks` 为空；那时你能读到的 `Fail/10` 行全部属于 Kyverno **自身 CR**（policy / exception / cleanup / ttl）的 webhook。**装上任一 [§4](#s4) 策略之后再回来读生成侧。**
- **平台级覆盖开关无法表达分层**：对这项设置而言，[§3.1.1](#s3-1-1) 的 `ModuleInfo` 入口**只用于平台级覆盖** —— 例如打开 `features.forceFailurePolicyIgnore.enabled` 后，所有策略都按 `Ignore` 生效，所有声明的 `Fail` 都被压掉。**不要拿它代替策略体内的声明**；反过来，检查时**只读声明同样不够**：只有生成侧的分组才反映覆盖之后的实际生效值 —— 一条声明 `Fail` 的策略，其 webhook 落进 `-ignore` 分组，就是被平台强制覆盖了；先解决覆盖，再谈分层。各集群此开关的状态必须作为集群级条目纳入基线漂移检查的对比（[§3.6](#s3-6) 的新集群行；范围与 [§7.3](#s7-3) 相同）。
- **绝不要手工编辑 `ValidatingWebhookConfiguration`**：它是 Kyverno 自己维护的对象（带有 `webhook.kyverno.io/managed-by=kyverno`），手工编辑会在按策略分组重算时被覆盖。切换分层的唯一正确路径是策略体内的 `spec.webhookConfiguration`，用 GitOps 管理 —— 这也是唯一能表达 [§3.7](#s3-7) 按策略分层（“硬门禁 `Fail`，记账类 Audit 可 `Ignore`”）的入口。

### 3.2 适用版本与依赖特性 {#s3-2}

适用范围已在本文档顶部的“适用版本”框中说明：判据是 **Alauda DevOps Pipelines v4.14.x 及以后**，而不是 ACP 版本。在更早的版本上，下列依赖特性不完整，策略可能静默失效而不是报错 —— 机制章节在那些版本上照样读得通，但不要把本文档的策略资产与示例原样套用。

具体依赖的特性（也是你在旧版本上的降级检查清单）：

- **Tekton**：`tekton.dev/v1` API、object 结果（`enable-api-fields: beta`）、`status.pipelineSpec` 回写、`status.childReferences`、`spec.status: CancelledRunFinally`、cluster / hub / git resolver；
- **Kyverno**：子资源匹配（`kind/subresource` 形式）、mutate-existing（`targets`）、`context.apiCall`、`foreach` + `element`、PolicyException v2（`--enablePolicyException` + `--exceptionNamespace`）。

**API group-version 前提**：本文档各策略的 `match` 块对 `PipelineRun` / `TaskRun` 及其 `/status` 子资源一律写 `tekton.dev/v1`，依据是在适用版本内 Tekton 已把三者的 storage 与 served 版本都定为 `v1`。**唯一的例外是 `CustomRun`**（[§4.5.4](#s4-5-4) 与 [§5.3](#s5-3) 的入口封口策略）：Tekton 只在 `v1beta1` 中定义并注册该类型 —— 它在 `v1` 中根本不存在 —— 所以那两处写 `tekton.dev/v1beta1/CustomRun` 不是疏漏，也绝不能顺手“统一成 v1” —— 一改，规则就会**静默失配**。

**它们的 `v1beta1` 通常也仍在被 serve**：在上游 Tekton Pipelines 各版本随附的 CRD 中，`pipelineruns.tekton.dev` 与 `taskruns.tekton.dev` 的 **`v1beta1` 与 `v1` 都是 `served: true`**（只有 `v1` 是 `storage: true`）——“两个版本同时可提交”是默认形态，不是什么异常配置。**但这并不构成绕过** —— 下方的警告解释了原因（一句话概括：请求在到达 Kyverno 之前已被 API server 转换为 `v1`，**所以不要**因此往 `kinds` 里加 `v1beta1`）。上游 CRD 的证据不等于你环境里的那一份；安装后仍建议确认一次 served 版本：

```bash
# Which tekton.dev versions this cluster actually serves. A v1beta1 row for
# PipelineRun / TaskRun is NORMAL and does not bypass these policies -- see the
# warning below for why (the API server converts such requests to v1 first).
kubectl get crd pipelineruns.tekton.dev taskruns.tekton.dev customruns.tekton.dev \
  -o jsonpath='{range .items[*]}{.metadata.name}{": "}{range .spec.versions[*]}{.name}{"(served="}{.served}{",storage="}{.storage}{") "}{end}{"\n"}{end}'
```

:::warning 提交 `v1beta1` 不会绕过这些策略 —— 把 `v1beta1` 写进 `kinds` 才会

**结论：什么都不要加** —— `kinds` 里只写 `tekton.dev/v1`。Kyverno 生成的资源 webhook 是 `matchPolicy: Equivalent` 且只注册 `v1`，因此 API server 会**先把 `v1beta1` 请求转换为 `v1` 再送去 admission**，此时字段名已经归一化（`spec.serviceAccountName` → `spec.taskRunTemplate.serviceAccountName`、`taskPodTemplate` → `podTemplate` 等等）。**反之，`kinds` 里一旦出现 `v1beta1`，这次转换就不再发生**，送进 admission 的是原始的 `v1beta1` 对象 —— **在两个版本间搬过家的字段路径**从此读到的都是空，依赖它们的判据静默跳过，这才是真正的放行漏洞。

**注意这里的失效是“部分的”，不是“整体的”** —— 不要指望整条规则在你看得见的地方塌掉：两个版本在相同路径下共有的字段（`spec.taskRef` 及其 resolver 参数、`spec.params` 等）在 `v1beta1` 对象上仍能正常读取，建立在它们之上的判据照常拒绝。真正读空的是那些搬过家的字段 —— `spec.serviceAccountName` → `spec.taskRunTemplate.serviceAccountName`、`taskPodTemplate` → `podTemplate` 之类。因此症状是**同一条规则内的部分判据失灵**，比整条规则跳过更难察觉。

对于只声明 `tekton.dev/v1/PipelineRun` 的策略，两种写法的实际行为如下（适用版本以本文档顶部的表格为准）：

| 以 `v1beta1` 提交时，策略的 `kinds` 为 | Kyverno 看到的对象 | 判据读到的值 |
|---|---|---|
| 仅 `v1`（本文档写法） | `apiVersion: tekton.dev/v1`（`requestKind` 仍为 `v1beta1`） | 一切正常读取 |
| `v1` **加** `v1beta1` | `apiVersion: tekton.dev/v1beta1` | 共有路径照常读取；**跨版本改名的路径**返回 `ABSENT`，依赖它们的判据跳过 |

安装后自检一次（该对象**只有装了策略之后才有内容**；输出为空只说明尚未安装任何策略）：

```bash
# matchPolicy must be Equivalent, and apiVersions must NOT list v1beta1.
kubectl get validatingwebhookconfiguration kyverno-resource-validating-webhook-cfg \
  -o jsonpath='{range .webhooks[*]}{.name}{" matchPolicy="}{.matchPolicy}{" apiVersions="}{range .rules[*]}{.apiVersions}{end}{"\n"}{end}'
```

**`CustomRun` 不受本段影响**：它只有 `v1beta1` 这一个版本，没有可被转换的对应版本；在 [§4.5.4](#s4-5-4) / [§5.3](#s5-3) 中写 `tekton.dev/v1beta1/CustomRun` 是必须的。

:::



其中，**只有 `enable-api-fields` 会在一开始就拦住你**：[§3.3](#s3-3) 的夹具 Task 声明了一个 `type: object` 的 result，当这个开关不是 `beta`（或 `alpha`）时，Tekton 自身的 admission 会直接拒绝 `kubectl apply -f public-fixtures.yaml` —— **拦截点在共享夹具，不在任何策略上**，很容易被误诊为 Kyverno 的问题。所以先读它（`TEKTON_NS` 见 [§3.1](#s3-1)）：

```bash
# Either read is fine; they must agree. Expect: beta (alpha also enables object
# results). Anything else -- including empty output -- means object results are off.
: "${TEKTON_NS:=tekton-pipelines}"   # §3.1 sets it; this only covers a fresh shell
kubectl -n "$TEKTON_NS" get configmap feature-flags \
  -o jsonpath='{.data.enable-api-fields}{"\n"}'
kubectl get tektonconfig config \
  -o jsonpath='{.spec.pipeline.enable-api-fields}{"\n"}'
```

当它不是 `beta` 时，**改 `TektonConfig` —— 不要直接编辑 ConfigMap**：operator 的下一次 reconcile 会把手工编辑的 ConfigMap 改回去（与 [§3.1.1](#s3-1-1) 相同的纪律）。在验证环境上两处读取都返回 `beta`。

**模板 → Task → result 契约版本矩阵。** Cookbook 中的每个真实 profile 都按版本钉死：不同版本可能携带不同的 result 契约，跨版本套用会以**静默失配**的方式失败。

**下表是本文档唯一的契约基线**：参数名、类型、默认值与 result 形态以此处为权威。**升级这些版本的行动项在 [§3.6](#s3-6)（哪些判据受影响）与 [§3.8](#s3-8)（升级后要跑什么）。**后续各节会就地重复与自身判据相关的一两行（方便你边读边写策略），但**升级模板 / Task 版本时只需回到本表逐行复核** —— 不必去各节翻找零散注记。矩阵中的模板与 Task 定义随 **Alauda Artifact Hub Shim v1.0.0** 交付（ACP 内置 hub：一个供 Tekton hub resolver 消费的 Artifact Hub 兼容 API）；**后续 Shim 版本可能改变这些定义** —— 升级 Shim 的处理方式与升级模板 / Task 版本相同，按 [§3.6](#s3-6) / [§3.8](#s3-8) 执行。

| 模板 / 场景 | 包含的关键 Task（版本） | 消费的 result / 参数契约 |
|---|---|---|
| 官方 `java-image-build-scan-deploy` 0.3、`python-image-build-scan-deploy` 0.3 | `sonarqube-scanner` 0.7 | `code-scan-results`（object：result/reportURL/taskID/projectID）、`code-scan-metrics` |
| 同上 | `trivy-scanner` **0.6**（两个模板都钉死此版本） | `trivy-summary-metadata`（object，11 个键，**推荐的消费形态**）+ `trivy-summary`（array，其首元素是同一聚合的字符串镜像）；门禁参数是结构化的 `trivyExitCode`（string，**默认 `"1"`**）与 `trivySeverity`（array）；`trivyExtraArgs`（array）只承载其余原生参数 |
| 同上 | `deploy-or-upgrade` 别名 → `kubectl` 0.1 | 发布开关与目标来自 PipelineRun 的 `workloadName` / `workloadNamespace` / `kubeconfig` workspace；解析出的 TaskRun 只携带 `args` / `script` |
| **独立 profile**（不包含在上述模板中） | `skopeo-copy` 0.1 | 参数 `srcImage` / `srcTransport` / `imageMappings`（在 [§4.5.1](#s4-5-1) 中校验） |

:::warning 四个容易搞错的点

1. **漏洞门禁由结构化参数控制 —— 不要去比对 `trivyExtraArgs` 字面量**：门禁开关是 `trivyExitCode`（string，默认 `"1"`）与 `trivySeverity`（array），模板将它们原样透传给 `trivy-scanner` 的 `exitCode` / `severity`。`trivyExtraArgs` 是一个**数组**（每个元素一个完整参数），只承载其余原生参数 —— 判据应要求它为空，而不是等于某个已批准列表（见 [§4.2.5](#s4-2-5)）。
2. **参数是结构化传给 Task 的，不再拼接进 shell 命令字符串**：`scanType` / `scanTargets` / `severity` / `exitCode` / `extraArgs` 各走各的槽位。因此扫描侧的主要风险不是命令注入，而是“门禁是否被关掉”；仍然真正需要注入防护的是同一批模板中 string 类型的 `buildExtraArgs` / `pushExtraArgs`（本文档不治理 build/push 侧，见 [§4.2.5](#s4-2-5)）。
3. **java 0.3 与 python 0.3 的 DAG 形态不同**：java 0.3 中 `deploy-or-upgrade` 只有 `runAfter: [trivy-scanner]`；python 0.3 中则是 `runAfter: [sonarqube-scanner, trivy-scanner]` ——“Sonar 结论支配发布”只在 python 的 DAG 中成立（详见 [§4.3](#s4-3)）。把一边的结论搬到另一边正好搞反。两者的**参数面**也不同（python 用 `preBuildScript` / `pythonImage` 一组替换了 maven 组；workspace 数量为 **12**，java 为 **16**；`trivy-config` 两边都有）；但 **trivy 门禁相关参数两边逐字段一致**（sonar 侧参数名也相同；只有 `sonarProperties` 默认值不同，不影响判据），因此 [§4.2.5](#s4-2-5) 的门禁判据用一条规则即可覆盖两个模板 —— 只有构建输入与 workspace 允许清单需要按模板拆分。
4. **这两条流水线都不包含 `skopeo-copy`**：[§4.5.1](#s4-5-1) 是制品搬运场景的独立 profile。

上表中的 Task 版本以**你环境中模板实际钉住的版本**为准；策略中的字段名必须匹配目标版本的真实契约。

:::

旧版本上的降级：仅当 object 结果不可用时才回退到聚合字符串结果（[§4.4.2](#s4-4-2) 的解析模式正是那个兜底形态）——**这是降级路径，不是目标形态**。自 0.6 起，`trivy-scanner` 也发布 object 结果，所以 **trivy 结果请直接用 [§4.4.1](#s4-4-1) 的下钻模式消费**；[§4.4.2](#s4-4-2) 留给“只给你字符串、短期内改不了”的第三方 / 自研 Task。理由见 [§2.4](#s2-4)。

### 3.3 共享夹具 {#s3-3}

:::info 演练会留下什么（复制粘贴之前先看清东西会落在哪里）

- **本地工作目录**：[§3.1.1](#s3-1-1) 的回滚文件 —— `moduleinfo-target.txt` / `moduleinfo-original.json` / `moduleinfo-expected.json`（**只有回滚步骤 g) 才删除；如果它们还在，说明那一轮从未收尾**）；[§4.0.4](#s4-0-4) 的 `cluster-scoped-ownership.tsv`；[§5.3](#s5-3) 六个步骤沿途写下的快照与结论文件（`gate-snapshot.txt`、`step*-verdict.txt`、`exemption-id.txt` / `exemption-uid.txt` 之类 —— 以各步骤实际写出的为准）；用于分离 stderr 的旁路文件 `*.err`（**成功时为空，但同样会留在目录里**）；再加上你在各节复制出来的 YAML / JSON。集群清理从不触碰这些本地文件 —— 是否留作证据由你自行决定。
- **集群上**：本节创建的两个共享 namespace，`policy-poc` / `tekton-templates`；[§5.2](#s5-2) 探针块创建的 namespace（`proj-a` / `proj-b` / `rogue-ns` —— 以该节的创建循环为准）；以及 [§5.3](#s5-3) 的 `policy-exempt-runs` / `policy-exceptions`（**只有本次演练亲手创建它们时才会打上 walkthrough-id 标签** —— 既有的从不打标签、清理也从不触碰）。namespace 级的演示对象 —— `PipelineRun` / `TaskRun`、夹具 `Task` / `Pipeline` 对象、允许清单型 `ConfigMap`、[§4.2.2](#s4-2-2) 与 [§5.3](#s5-3) 的 `Role` / `RoleBinding`、`PolicyException` —— 全部位于这些 namespace 内。除此之外，个别小节还会创建**集群级对象**：`ClusterPolicy` 与 [§4.6](#s4-6) 的聚合 `ClusterRole` —— **删除 namespace 不会连带删除它们**。
- **清理如何落地（[§4.0.4](#s4-0-4) 的两条规则）**：集群级对象在各节收尾的“清理”中，按创建时账本里的 UID 逐一删除；namespace 在检查 walkthrough-id 标签后删除，把其中的一切级联清掉（[§5.2](#s5-2) / [§5.3](#s5-3) 的 namespace 由各自的清理段落处理；`policy-poc` / `tekton-templates` 由本节末尾的“最终清理”处理）。因此**每节结束就清理 —— 不要攒到最后一起做**。还有一件事**任何清理段落都不会替你做**：为 [§5.3](#s5-3) 按 [§3.1.1](#s3-1-1) 修改的平台配置（`ModuleInfo` 中的 PolicyException 开关）—— 完成 [§5.3](#s5-3) 后，自己回到 [§3.1.1](#s3-1-1) 执行其回滚步骤。

:::

后续所有章节共享的资源。先创建两个 namespace：`policy-poc` 承载业务侧的 run 与探针，`tekton-templates` 承载受信的模板与 Task 定义。

```bash
# Record which namespaces THIS walkthrough created, so the final cleanup never
# deletes one that was already there (§4.0.4 keeps the same discipline per object).
# The marker is a LABEL on the namespace carrying an id UNIQUE TO THIS RUN. A fixed
# value like "created-here" would not do: on a shared cluster an earlier unfinished
# walkthrough may have left its own marked namespaces behind, and a fixed marker
# cannot tell the two apart -- the cleanup would delete somebody else's work.
# WRITE THE ID DOWN. Without it the cleanup refuses to delete anything, which is the
# safe direction, but you then have to compare the label by hand.
# date+PID alone is not unique across machines (same second, same PID happens);
# $RANDOM makes an accidental collision between two parallel walkthroughs unlikely.
# Any unique string works -- what matters is that it is not a constant.
WALKTHROUGH_ID=$(date +%Y%m%d-%H%M%S)-$$-$RANDOM
export WALKTHROUGH_ID
echo "walkthrough id: $WALKTHROUGH_ID"

for ns in policy-poc tekton-templates; do
  # --ignore-not-found gives three distinguishable outcomes without matching any error
  # text: exit 0 + a name = it exists, exit 0 + empty = it does not, non-zero = the
  # query itself failed (no RBAC, API server down) and you must not create anything.
  if ! out=$(kubectl get namespace "$ns" -o name --ignore-not-found 2>&1); then
    echo "$ns: CHECK FAILED ($out)"
  elif [ -n "$out" ]; then
    # §4.0.4's premise: every demo object lives in a namespace THIS walkthrough
    # created, because cleanup is a namespace cascade. A pre-existing namespace has
    # no removal path here, so going on inside it would strand everything you make.
    echo "$ns: pre-existing -- STOP: this walkthrough must own its namespaces (§4.0.4)."
    echo "  Pick your own names and substitute them throughout, or finish the earlier"
    echo "  walkthrough that left this one behind."
  elif ! kubectl create namespace "$ns" >/dev/null 2>&1; then
    # Somebody created it between the check and the create: it is theirs, not yours.
    echo "$ns: create failed -- do NOT label it, and treat it as pre-existing (STOP)"
  elif ! kubectl label namespace "$ns" "policy.alauda.io/walkthrough=$WALKTHROUGH_ID" >/dev/null; then
    # Created but unlabelled: the cleanup loop keys on that label and would skip it
    # forever. The namespace is seconds old, empty, and certainly yours -- delete it
    # by hand and re-run this loop rather than going on without the marker.
    echo "$ns: created but LABEL FAILED -- the cleanup loop will not touch it."
    echo "  Run: kubectl delete namespace $ns   # then re-run this loop"
  else
    echo "$ns: created"
  fi
done
```

夹具的核心是一个 **SonarQube Scanner 0.7 契约夹具**（`policy-demo-scanner`）。它不是真实的扫描器，但它**完整镜像了本文档所依赖的 0.7 对外契约面**，因此 Cookbook 针对该契约写下的每条策略表达式在真实 Task 上同样成立：

- `enableScanQualityGate` / `enableAnalyzeQualityGate` 均为 `string`，默认 `"true"`；
- `analyzeQualityGateRules` 为 `array`，默认 `[]`；`sonarBranchName` 为 `string`，默认为空；
- `code-scan-results` 是只声明 `result` / `reportURL` / `taskID` / `projectID` 的 object result；四个属性的真实 schema 都是空 map `{}`，没有额外的 `type: string`；
- `code-scan-metrics` 是一个 object result，其 schema 只声明真实 0.7 一定会有的那个属性 `bugs: {}`（真实 Task 可以通过其 `metrics` 参数动态收集更多字段，但**策略不得假设未声明的字段必然存在**）；
- `code-scan-results.result` 使用真实取值范围 `Succeeded` / `Failed` / `Skipped` / `Canceled`。

夹具还用 `demoCoverage` / `demoBugs` / `demoDelaySeconds` / `demoResult` 驱动可复现的通过 / 失败 / 取消与四值范围审计测试，模板层再加一个 `demoSkipScan`（默认 `"false"`；设为 `"true"` 时通过 `when` 整体跳过 `scan`，让 [§4.1.5](#s4-1-5) 能复现“门禁被选择退出”）。这些 `demo*` 参数**明确不属于产品化的 Task 契约** —— 替换为真实 Task 时不要保留。没有单独的门禁 task：夹具自身失败即挡住其后的 `release`。

:::warning 替换占位符

把夹具中的 `<registry>` 替换为你环境中能拉取 busybox 的 registry 前缀。生产环境应把 step 镜像钉到 digest —— 否则任何拥有 registry 推送权限的人都能整个换掉扫描逻辑（契约 1，[§2.3](#s2-3)）。

**不知道该填什么时，先看平台自己从哪里拉取** —— 在离线环境中这是最容易的起点：

```bash
# Where the platform itself pulls from. Output shape: <host>[:port]/<path prefix>/...
: "${TEKTON_NS:=tekton-pipelines}"   # §3.1 sets it; this only covers a fresh shell
kubectl -n "$TEKTON_NS" get deploy tekton-pipelines-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# Wider sample: every distinct prefix in use in that namespace.
kubectl -n "$TEKTON_NS" get pods \
  -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' \
  | sed 's#/[^/]*$##' | sort -u
```

⚠️ **这些是候选项，不是答案**：平台 namespace 能拉不代表 `policy-poc` 也能拉（拉取凭证按 namespace 授予），而且这两条命令打印的都是**平台镜像**路径，可能根本没有 `busybox`。**唯一算数的验证是夹具真的跑起来** —— 按 [§3.3](#s3-3) 建好夹具后运行 `demo-run-pass`；若 Pod 起不来，在 `kubectl -n policy-poc describe pod` 中找 `ImagePullBackOff` / `ErrImagePull` 事件。那不是 Tekton 或 Kyverno 的问题 —— 是前缀不对或凭证缺失。

:::

:::details 完整共享夹具 YAML（Task、模板、反面模板 —— 可直接复制粘贴）

一个 YAML 文件包含五个对象；后续章节按需引用：

- `Task/policy-demo-scanner`（`tekton-templates`）—— 契约夹具本体；
- `Pipeline/gated-build` —— 标准受治理模板：scan → release，finally 只做通知；
- `Pipeline/gated-build-with-prep` —— 供 [§4.2.2](#s4-2-2) 证明“scan 之前已完成的工作 + RunFinally 取消 + finally 仍然执行”；
- `Task/policy-demo-scanner`（`policy-poc`）—— **同名不同源**的 Task，[§4.6.2](#s4-6-2) 的定义漂移标的；
- `Pipeline/gated-build-rogue` —— 反面模板：`scan` 别名保留受信名称，却从 `policy-poc` 解析。

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-scanner
  namespace: tekton-templates
spec:
  # This fixture mirrors the sonarqube-scanner 0.7 contract surface consumed by
  # this document. Parameters prefixed with demo are test drivers, not product
  # task parameters.
  params:
    - name: enableScanQualityGate
      type: string
      default: "true"
    - name: enableAnalyzeQualityGate
      type: string
      default: "true"
    - name: analyzeQualityGateRules
      type: array
      default: []
    - name: sonarBranchName
      type: string
      default: ""
    - name: demoCoverage
      type: string
      default: "85"
    - name: demoBugs
      type: string
      default: "0"
    - name: demoDelaySeconds
      type: string
      default: "0"
    - name: demoResult
      type: string
      default: Auto
  results:
    - name: code-scan-results
      description: quality-gate verdict object (result/reportURL/taskID/projectID)
      type: object
      properties:
        # Empty property schemas exactly match the catalog 0.7 Task.
        result: {}
        reportURL: {}
        taskID: {}
        projectID: {}
    - name: code-scan-metrics
      description: metrics collected after the scan; real 0.7 always declares bugs
      type: object
      properties:
        bugs: {}
  steps:
    - name: scan
      # pin to a digest in production so a registry pusher cannot swap the scan logic
      image: <registry>/busybox:latest
      # params passed via env (NOT text-substituted into the script body) to avoid
      # Tekton parameter injection; the script reads shell variables only
      env:
        - name: ENABLE_SCAN_QG
          value: $(params.enableScanQualityGate)
        - name: ENABLE_ANALYZE_QG
          value: $(params.enableAnalyzeQualityGate)
        - name: DEMO_COVERAGE
          value: $(params.demoCoverage)
        - name: BUGS
          value: $(params.demoBugs)
        - name: DEMO_DELAY_SECONDS
          value: $(params.demoDelaySeconds)
        - name: DEMO_RESULT
          value: $(params.demoResult)
      script: |
        #!/bin/sh
        set -eu
        case "$ENABLE_SCAN_QG" in true|false) ;; *) exit 1 ;; esac
        case "$ENABLE_ANALYZE_QG" in true|false) ;; *) exit 1 ;; esac
        case "$DEMO_COVERAGE" in ''|*[!0-9]*) exit 1 ;; esac
        case "$BUGS" in ''|*[!0-9]*) exit 1 ;; esac
        case "$DEMO_DELAY_SECONDS" in ''|*[!0-9]*) exit 1 ;; esac
        # The numeric-looking "1" is an intentional invalid-contract probe. It
        # does not extend the scanner 0.7 result enum.
        case "$DEMO_RESULT" in Auto|Succeeded|Failed|Skipped|Canceled|1) ;; *) exit 1 ;; esac
        [ "$DEMO_DELAY_SECONDS" -le 300 ] || exit 1
        sleep "$DEMO_DELAY_SECONDS"

        RESULT="$DEMO_RESULT"
        if [ "$RESULT" = Auto ]; then
          RESULT=Succeeded
          if [ "$DEMO_COVERAGE" -lt 80 ]; then RESULT=Failed; fi
        fi

        # The fixture self-gates whenever either 0.7 quality-gate phase is enabled.
        # Setting both switches false is reserved for the explicit negative fixture
        # that proves §4.2 rejects a fully disabled gate.
        FAIL=0
        if [ "$RESULT" != "Succeeded" ] && { [ "$ENABLE_SCAN_QG" = "true" ] || [ "$ENABLE_ANALYZE_QG" = "true" ]; }; then
          FAIL=1
        fi

        printf '{"result":"%s","reportURL":"https://sonar.example/dashboard?id=demo","taskID":"demo-task-001","projectID":"demo-proj"}' "$RESULT" > "$(results.code-scan-results.path)"
        printf '{"bugs":"%s"}' "$BUGS" > "$(results.code-scan-metrics.path)"
        echo "scan: demoCoverage=$DEMO_COVERAGE result=$RESULT fail=$FAIL"
        if [ "$FAIL" = 1 ]; then
          echo "task-side quality gate FAILED"; exit 1
        fi
        echo "quality gate not enforced or passed"
---
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: gated-build
  namespace: tekton-templates
spec:
  params:
    - name: coverage
      type: string
      default: "85"
    - name: enableScanQualityGate
      type: string
      default: "true"
    - name: enableAnalyzeQualityGate
      type: string
      default: "true"
    - name: analyzeQualityGateRules
      type: array
      default: []
    - name: demoDelaySeconds
      type: string
      default: "0"
    - name: demoResult
      type: string
      default: Auto
    # §4.1.5 needs a run where the gate is skipped BY CONFIGURATION. The default keeps
    # `scan` running, so every other section behaves exactly as before; passing "true"
    # is the opt-out that section's Audit is supposed to catch.
    - name: demoSkipScan
      type: string
      default: "false"
  tasks:
    - name: scan
      # the scanner self-gates; failing it blocks `release` (no separate gate task)
      when:
        - input: $(params.demoSkipScan)
          operator: notin
          values:
            - "true"
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: policy-demo-scanner
          - name: namespace
            value: tekton-templates
      params:
        - name: demoCoverage
          value: $(params.coverage)
        - name: enableScanQualityGate
          value: $(params.enableScanQualityGate)
        - name: enableAnalyzeQualityGate
          value: $(params.enableAnalyzeQualityGate)
        - name: analyzeQualityGateRules
          value:
            - $(params.analyzeQualityGateRules[*])
        - name: demoDelaySeconds
          value: $(params.demoDelaySeconds)
        - name: demoResult
          value: $(params.demoResult)
    - name: release
      runAfter:
        - scan
      taskSpec:
        steps:
          - name: release
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "releasing..."
  finally:
    - name: notify
      taskSpec:
        steps:
          - name: notify
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "notify: run finished"
---
# 4.2.2 uses this profile to prove that work completed before `scan` can be
# followed by a RunFinally cancellation and still execute the final notifier.
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: gated-build-with-prep
  namespace: tekton-templates
spec:
  params:
    - name: coverage
      type: string
      default: "85"
    - name: enableScanQualityGate
      type: string
      default: "true"
    - name: enableAnalyzeQualityGate
      type: string
      default: "true"
    - name: demoDelaySeconds
      type: string
      default: "0"
  tasks:
    - name: prep
      taskSpec:
        steps:
          - name: prep
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "prep completed"
    - name: scan
      runAfter:
        - prep
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: policy-demo-scanner
          - name: namespace
            value: tekton-templates
      params:
        - name: demoCoverage
          value: $(params.coverage)
        - name: enableScanQualityGate
          value: $(params.enableScanQualityGate)
        - name: enableAnalyzeQualityGate
          value: $(params.enableAnalyzeQualityGate)
        - name: demoDelaySeconds
          value: $(params.demoDelaySeconds)
    - name: release
      runAfter:
        - scan
      taskSpec:
        steps:
          - name: release
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "release completed"
  finally:
    - name: notify
      taskSpec:
        steps:
          - name: notify
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "finally notification completed"
---
# 4.6.2 uses a same-name Task from another namespace as the resolved-definition
# drift target. The name still looks trusted, but the complete source does not.
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-scanner
  namespace: policy-poc
spec:
  steps:
    - name: wait
      image: <registry>/busybox:latest
      script: |
        #!/bin/sh
        sleep 30
---
# Negative fixture for 4.6.2: the scan alias keeps the trusted Task name but
# resolves it from policy-poc instead of tekton-templates.
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: gated-build-rogue
  namespace: tekton-templates
spec:
  tasks:
    - name: prep
      taskSpec:
        steps:
          - name: prep
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              sleep 30
    - name: scan
      runAfter:
        - prep
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: policy-demo-scanner
          - name: namespace
            value: policy-poc
    - name: release
      runAfter:
        - scan
      taskSpec:
        steps:
          - name: release
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "release must not complete after self-cancel"
  finally:
    - name: notify
      taskSpec:
        steps:
          - name: notify
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "finally notification completed"
```

:::

把上面的 YAML 保存为 `public-fixtures.yaml`（`<registry>` 已替换）并在目标集群上创建 —— **后续每一节的探针都假设这五个对象存在**：

```bash
# If either namespace pre-existed, check for same-named objects FIRST: `apply` would
# overwrite somebody else's Task or Pipeline with this document's fixture, and the
# cleanup at the end of §3.3 would then delete what you overwrote (§4.0.4).
# Fail-closed on purpose: a query that ERRORS (no RBAC, API server hiccup, CRD not
# installed) must stop you too -- silencing stderr and reading "empty" as "absent" is
# how a guard turns into decoration.
FIXTURES_SAFE=yes
# Heredoc + read, not `set -- $spec`: zsh keeps an unquoted expansion as ONE word, so
# a splitting-based loop pasted into an interactive zsh queries an empty resource type.
# `read` splits on IFS in bash and zsh alike, and the redirect (no pipe) keeps the
# FIXTURES_SAFE assignment in the current shell.
while read -r ns kind name; do
  # Same three-way outcome as the namespace check: exists / absent / query failed --
  # decided by the exit code and whether anything was printed, not by error text.
  if ! out=$(kubectl get "$kind" -n "$ns" "$name" -o name --ignore-not-found 2>&1); then
    echo "CHECK FAILED for $ns/$kind/$name: $out"; FIXTURES_SAFE=no
  elif [ -n "$out" ]; then
    echo "COLLISION: $ns/$out already exists -- stop, and use namespaces of your own"; FIXTURES_SAFE=no
  fi
done <<'FIXTURE_LIST'
tekton-templates task policy-demo-scanner
policy-poc task policy-demo-scanner
tekton-templates pipeline gated-build
tekton-templates pipeline gated-build-with-prep
tekton-templates pipeline gated-build-rogue
FIXTURE_LIST
echo "FIXTURES_SAFE=$FIXTURES_SAFE"
# Expect FIXTURES_SAFE=yes and nothing else. COLLISION means the name is taken (change
# the two namespace names in the block above and in every later probe). CHECK FAILED
# means you do not know yet -- fix that query before applying anything.
```

**这个探针按首次安装编写：它分不清“别人的同名对象”与“你上次建的同一批夹具”** —— 两者都报 `COLLISION`。因此：

- **首次安装**：探针应当什么都不打印；若有输出，按上文指引更换 namespace。
- **重跑同一演练**：那五个对象就是你上次建的。核实它们确实是你的（`kubectl get -o yaml` —— 内容是否为本夹具、namespace 的演练标签是否是你上次的 id），然后**手工设置 `FIXTURES_SAFE=yes`** 再运行下一块 —— 对同一份 YAML 执行 `apply` 是幂等的。或者先删掉上次那批再重来。
- **要求“绝不覆盖”时**：把下一块中的 `kubectl apply -f` 换成 `kubectl create -f`；存在同名对象时它会以 `AlreadyExists` 失败而不是覆盖。探针与创建之间仍有一段窗口（可能恰好有人在其间创建同名对象）—— `create` 的价值恰恰在于那种情况下它会失败，而不是静默覆盖。

**探针与下面的 apply 有意拆成两块**：若在同一块里，整体粘贴会让 `apply` 无论如何都执行，探针沦为事后通知。下一块会再检查一次 `FIXTURES_SAFE` —— 两道防线并存是因为**拆块只能拦“顺手一路粘贴下来”，拦不住“跳过上一块直接粘贴这一块”**：

```bash
# Refuse to run if the check above did not pass (or was never run at all).
if [ "${FIXTURES_SAFE:-no}" != yes ]; then
  echo "run the collision check above first, and fix what it reported"
else

  # `apply` on purpose, so that re-running the whole walkthrough is idempotent. It is
  # NOT collision-proof: the check above and this line are separate requests, and a
  # same-named object created in between would be overwritten rather than reported. On
  # a shared cluster prefer `kubectl create -f public-fixtures.yaml` -- it fails with
  # AlreadyExists instead, which is the answer you want there (see the bullet above).
  kubectl apply -f public-fixtures.yaml
  # Expect five objects created. Verify all five before going on: a missing template
  # makes the cluster resolver fail later, and the run will report a resolution error
  # instead of the gate behaviour this document describes.
  kubectl get task -n tekton-templates policy-demo-scanner
  kubectl get task -n policy-poc policy-demo-scanner
  kubectl get pipeline -n tekton-templates gated-build gated-build-with-prep gated-build-rogue

fi
```

如果有任何一行报 `NotFound`，回到那份 YAML 找到对应对象 —— 最常见的原因是未替换的 `<registry>` 导致整个 apply 中途失败，或者两个 namespace 还没创建（本节开头的循环）。

⚠️ **两个共享 namespace 必须由本次演练创建**（[§4.0.4](#s4-0-4) 的前提纪律 —— 清理依赖 namespace 删除的级联，而级联的前提是里面没有任何别人的东西）。当上面的创建循环打印 `pre-existing` 时，这个集群上已有人占用该 namespace 名称 —— **不要在里面做演示**：全程用你自己的名字替换 `policy-poc` / `tekton-templates`（最终清理也在你的名字下执行）；或者先确认那是你自己上一轮演练留下的（标签里的演练 id 是你记下的那个），把那一轮收尾后再重新开始。

该模板体现了 [§2.3](#s2-3) 契约中模板侧的职责：门禁由 scanner 自身承载（契约 3“必须执行”+ 契约 4“消费真实生效值”在同一个 task 内融为一体），`release` 排在 scanner 之后（契约 5，DAG 支配），finally 只做通知（契约 6）。

标准的业务侧用法通过 cluster resolver 引用该模板：

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: demo-run-pass
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
```

保存为 `demo-run-pass.yaml` 并创建（在目标集群上；下面的观察命令需要它真实存在）：

```bash
kubectl create -n policy-poc -f demo-run-pass.yaml
kubectl wait -n policy-poc pipelinerun/demo-run-pass \
  --for=condition=Succeeded --timeout=5m
```

下表最后一列的 `code-scan-results.result` 是**由 scan task 产出的 Tekton task result** —— 既不是 Pipeline 级字段，也不是 Kyverno 概念。先把它弄清楚；接下来各章的“result 型”策略全都取决于它：

- **谁产出它**：`scan` task（夹具中的 `policy-demo-scanner`）在其 step 脚本里向 `$(results.code-scan-results.path)` 写入一段 JSON；
- **落在哪里**：Tekton 把它记录在**该 task 对应的 TaskRun** 的 `status.results` 上。PipelineRun 自身不持有这份数据 —— 要看子 TaskRun（[§2.1](#s2-1) 观察点 6）；
- **`.result` 是什么**：这个 result 的类型是 `object`（[§2.4](#s2-4)），其 `result` 字段是**扫描结论**，真实取值范围为 `Succeeded` / `Failed` / `Skipped` / `Canceled`；
- **本文档为何反复回到它**：[§4.4](#s4-4) 的结果审计与 [§4.6.1](#s4-6-1) 的自动取消都读取该字段。表中列出它，方便你确认夹具环境产出的结论符合预期。

亲眼看一看（用上面的 `demo-run-pass`）：

```bash
# The verdict lives on the scan TaskRun, not on the PipelineRun.
# childReferences is the API-level mapping from pipeline task name to TaskRun name --
# unlike the tekton.dev/pipelineTask label, it cannot be overridden by the submitter.
TR=$(kubectl get pipelinerun -n policy-poc demo-run-pass -o json \
  | jq -r '.status.childReferences[] | select(.pipelineTaskName == "scan") | .name')
kubectl get taskrun -n policy-poc "$TR" -o jsonpath='{.status.results}{"\n"}'
```

三个 run 覆盖门禁的三种形态，同时兼作环境就绪检查：

| run | 输入 | scan | release | finally notify | 扫描结论（scan 的 task result `code-scan-results.result`） |
|---|---|---|---|---|---|
| pass | `coverage=85` | ✅ 成功 | ✅ 执行 | ✅ 执行 | `Succeeded` |
| gate-fail | `coverage=30`（两个门禁开关均为 `true`） | ❌ 自身失败 | ⏭ 跳过（原因 `PipelineRun was stopping`） | ✅ 执行 | `Failed` |
| gates-off | `coverage=30` + 两个门禁开关均为 `false` | ✅ 夹具成功 | ✅ 执行（**刻意暴露的绕过**） | ✅ 执行 | `Failed` |

后两个 run 与 `demo-run-pass` **只有 params 不同**（除模板身份外，仅 `metadata.name` 与 params 有差异）。保存为 `demo-runs-negative.yaml`：

```yaml
# gate-fail: coverage below the bar; both gate switches keep the template default "true"
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: demo-run-gate-fail
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
---
# gates-off: below the bar as well, but both gate switches explicitly off (the deliberately exposed bypass)
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: demo-run-gates-off
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
    - name: enableScanQualityGate
      value: "false"
    - name: enableAnalyzeQualityGate
      value: "false"
```

两个一起创建并等待各自的终态 —— **注意二者的结局相反**，因此等待条件也相反：

```bash
kubectl create -n policy-poc -f demo-runs-negative.yaml

# gate-fail must end NOT Succeeded (the scanner fails itself and stops the run)
kubectl wait -n policy-poc pipelinerun/demo-run-gate-fail \
  --for=condition=Succeeded=false --timeout=5m
# gates-off must end Succeeded -- that "green" run is the exposed bypass, not a pass
kubectl wait -n policy-poc pipelinerun/demo-run-gates-off \
  --for=condition=Succeeded --timeout=5m

# Then read the scan verdict of each: expect Failed for BOTH (the table's last column)
for run in demo-run-gate-fail demo-run-gates-off; do
  TR=$(kubectl get pipelinerun -n policy-poc "$run" -o json \
    | jq -r '.status.childReferences[] | select(.pipelineTaskName == "scan") | .name')
  printf '%s -> %s\n' "$run" \
    "$(kubectl get taskrun -n policy-poc "$TR" -o jsonpath='{.status.results}')"
done
```

`wait` 超时而不是及时返回，通常意味着 run 卡在解析上（模板从未建好 —— 回到上面的五对象验证）；当任一 run 的终态与表不符时，先确认夹具的 `demo*` 参数没有被改动。

前两行是硬门禁的基线形态（扫描器自身失败 → `release` 被跳过 → finally 照常执行 —— 正是 [§2.3](#s2-3) 对比表的第二行）。

第三行是**仅限夹具的反面测试**，它的 `Failed` 不是笔误 —— 这一行刻意把两件事拆开：**结论**仍计算为 `Failed`（`demoResult` 默认 `Auto`；coverage 30 < 80 判为 `Failed`），但夹具只有在**至少一个门禁开关为 `true`** 时才把失败结论转换为 `exit 1`。两个开关都关掉后，scan 成功退出、`release` 照跑 —— 而 scan TaskRun 的 `code-scan-results.result` 明晃晃写着 `Failed`。**结论说不合规，流水线却一路绿灯** —— 正是“门禁开关被关掉”的危害形态，也正是 [§4.2.1](#s4-2-1) 必须在 TaskRun CREATE 时拦下不合规开关值的原因：等结果出来时，发布已经跑完了。本行只描述夹具的确定性行为；并不主张真实 SonarQube 服务在双门禁关闭时必然产生同样的组合。

#### 最终清理（走完整个文档之后）

各节收尾的“清理”只删除该节自己的策略与 run 对象；**这两个共享 namespace 在整个文档完成后单独删除** —— 否则夹具会永远留在集群上：

```bash
# First LOOK: which namespaces carry a walkthrough marker at all, and whose?
kubectl get namespace -l policy.alauda.io/walkthrough \
  -o custom-columns='NAME:.metadata.name,WALKTHROUGH:.metadata.labels.policy\.alauda\.io/walkthrough'
# Expect your own id (printed when you created them) on the namespaces you created.
# A DIFFERENT id belongs to another run of this document -- leave it alone and go ask
# its owner.
#
# Then delete BY NAME, with your own id as the precondition. Deliberately not
# `kubectl delete namespace -l <label>`: a selector cannot express "mine". And never
# `kubectl delete namespace policy-poc tekton-templates` with no check at all -- that
# takes every unrelated object in them along.
for ns in policy-poc tekton-templates; do
  if ! json=$(kubectl get namespace "$ns" -o json 2>&1); then
    case "$json" in
      *NotFound*) echo "$ns: gone already -- nothing to do" ;;
      # Forbidden and a connection error must not read as "gone": an unreadable
      # namespace is not a deleted one, and walking away here would leave it (and
      # everything in it) behind while the output reads like a finished pass.
      *) echo "$ns: could not be read -- $json"
         echo "  Left alone. Resolve the read error and run this loop again." ;;
    esac
    continue
  fi
  # jq's exit code too: a parse failure would produce an empty marker, and the branch
  # below would then report a labelling mistake that never happened.
  if ! marker=$(printf '%s' "$json" | jq -r '.metadata.labels."policy.alauda.io/walkthrough" // ""'); then
    echo "$ns: could not parse the namespace JSON -- left alone"
    continue
  fi
  if [ -n "${WALKTHROUGH_ID:-}" ] && [ "$marker" = "$WALKTHROUGH_ID" ]; then
    # The label check right above is the ownership evidence (§4.0.4): only a namespace
    # THIS run created and marked gets deleted, cascade and all.
    kubectl delete namespace "$ns"
  else
    echo "$ns: label '${marker:-<none>}' is not this run's id '${WALKTHROUGH_ID:-<unset>}' -- left alone"
  fi
done
# An <unset> id means you are in a different shell than the one that created them:
# re-export WALKTHROUGH_ID with the value you wrote down, then run this again.
```

删除 namespace 会级联清掉其中的 Pipeline / Task / run 及其派生的 Pod；`PolicyReport` 随其所属对象一并消失（[§4.4.4](#s4-4-4)）。**删除 namespace 不会连带删除集群级对象** —— 它们必须按各节清理清单逐项删除：其一，各节的 `ClusterPolicy`；其二，[§4.6](#s4-6) 引言为 mutate-existing 创建的 `ClusterRole kyverno-background-update-pipelineruns`（该节自带“先看创建时间再删除”的清理块 —— 不要跳过：把这个角色留在原地，就会一直授予 background-controller 对 PipelineRun 的集群级 update 权限）。
### 3.4 策略验证方法（三类，按场景严格区分） {#s3-4}

策略写好之后，用哪种方法验证取决于它挂在哪个观测点上。三类方法互不替代：

- **准入策略**（匹配主资源的 CREATE/UPDATE）：使用 `kubectl create --dry-run=server -f probe.yaml` 探针——它会完整执行 webhook 评估但不落盘任何内容，零副作用。注意对于使用 `generateName` 的资源，`--dry-run=server` 必须用 `create` 而不是 `apply`。正反两个方向都要跑：策略必须拒绝违规探针，且不得命中合规探针。
- **结果类策略**（匹配 `*/status`）：运行结果在准入阶段拿不到，因此有两条路线——在本机用 `kyverno apply <policy> --resource <fixture>` 做离线评估（局限见 [§6.1.6](#s6-1-6)），或在**实验 namespace** 里用真实的发射器任务产出目标结果形态（例如 [§3.3](#s3-3) 中的扫描器 fixture）。
- **端到端验证**：真正跑一条最小流水线，验证完整的失败 / 跳过 / 取消形态以及父子时序。准入探针**无法证明**运行期时序；任何涉及 `CreateRunFailed`、finally 是否运行、或取消语义的结论都必须走这一层。

这三类的**命令形态**在 [§3.4.1](#s3-4-1) 中按同样顺序给出（类型 1 / 2 / 3 与上面三条一一对应；取消类是端到端层内最常用的取证形态）。

**生产环境排障是只读的**：只看 status / events / PolicyReport（[§6](#s6)）。**绝不**在生产环境手改运行中对象的 status。

#### 3.4.1 把“期望表”变成命令（通用配方） {#s3-4-1}

后续章节以三种方式之一提供探针：有的直接给出完整 manifest 和命令（[§3.3](#s3-3)、[§4.4.1](#s4-4-1)、[§4.4.2](#s4-4-2)）；[§4.2.2](#s4-2-2)、[§4.6.1](#s4-6-1) 和 [§4.6.2](#s4-6-2) 给出完整的运行 manifest，但取证命令在 [§6.2.3](#s6-2-3)（取消类读取的是对象上的 `spec.status` 和注解，而不是准入返回值）；其余章节只给出**期望表**（列出哪些输入应当被允许 / 拒绝 / 跳过），命令留给本节——因为这三类命令是机械性的，逐节重复只会让文档更长，而不是更清晰。

**九个章节只给期望表，需要你自己把它变成命令**：[§4.1.1](#s4-1-1)、[§4.2.4](#s4-2-4)、[§4.2.5](#s4-2-5)、[§4.5.1](#s4-5-1)、[§4.5.3](#s4-5-3)、[§4.5.4](#s4-5-4)、[§4.5.5](#s4-5-5)、[§5.2](#s5-2)、[§5.3](#s5-3)。（[§4.5.3](#s4-5-3)、[§5.2](#s5-2)、[§5.3](#s5-3) 中已有的 `kubectl apply` 命令创建的是**前置对象**（ConfigMap、namespace），并非探针本身。）

另有三组章节不在上面的清单里，它们的探针来自别处：[§4.1.4](#s4-1-4) 和 [§4.1.5](#s4-1-5) 没有期望表——它们是 `*/status` 上的 Audit 纵深防御，判据写在正文里，期望形态是“报告中应出现哪条 fail 条目”——按下面的**类型 2** 执行；[§4.2.1](#s4-2-1) 和 [§4.2.3](#s4-2-3) 判断的是同一组门禁开关，因此直接复用 [§3.3](#s3-3) 的负向 fixture（开关关闭的 `demo-run-gates-off`，以 `demo-run-pass` 作为正向对照——换一个 `metadata.name` 重新创建即可）。这两个章节**不能用类型 1 的 `--dry-run` 探针**：判据落在 Tekton 控制器创建的子 TaskRun 上，且必须沿 ownerReference 回查一个**真实存在**的父 run——dry-run 的 PipelineRun 既不会被持久化也不会派生子对象。唯一的办法是按 [§3.4](#s3-4) 的第三类真正跑一条流水线：[§4.2.1](#s4-2-1) 观察父 run 是否进入 `CreateRunFailed`；[§4.2.3](#s4-2-3) 的取消形态按**类型 3**，读取的是**门禁 TaskRun 自身**（它是准入 mutate，这正是它 patch 的对象——父 run 上没有可看的 `spec.status`）；[§4.2.2](#s4-2-2)、[§4.6.1](#s4-6-1) 和 [§4.6.2](#s4-6-2) 自带完整的运行 manifest——按**类型 3** 检查结果。

跟随操作时，套用下面三种类型之一：

```bash
# Type 1 - Admission (the table says "allow / deny"; the policy matches CREATE/UPDATE on main resources)
#   Take the matching one of the three skeletons below, edit the fields per that table row, then:
kubectl create --dry-run=server -n policy-poc --as='<probe-identity>' -f probe.yaml
#   ALLOW  = the object is echoed back (ending with "(server dry run)")
#   DENY   = admission webhook "validate.kyverno.svc-fail" denied the request,
#            and the message carries <policy-name>: <rule-name>: <message>
#   Neither (e.g. a resolver / validation error) = the request never reached the policy; fix the manifest first

# Type 2 - Result (the table says "pass / fail / skip"; the policy matches */status and is Audit)
#   An Audit policy denies no request; the verdict lives only in the report. You must really run it and wait for the terminal state:
kubectl create -n policy-poc --as='<probe-identity>' -f probe.yaml
kubectl get taskrun,pipelinerun -n policy-poc \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.conditions[0].status,REASON:.status.conditions[0].reason'
PROBE_KIND='<TaskRun-or-PipelineRun>'
PROBE_NAME='<probe-object-name>'
EXPECTED_POLICY='<expected-policy-name>'
EXPECTED_RULE='<expected-rule-name>'
case "$PROBE_KIND/$PROBE_NAME/$EXPECTED_POLICY/$EXPECTED_RULE" in
  *'<'*'>'*) echo "fill in PROBE_KIND, PROBE_NAME, EXPECTED_POLICY and EXPECTED_RULE first"; false;;
esac &&
if ! PROBE_UID=$(kubectl get "${PROBE_KIND,,}" "$PROBE_NAME" -n policy-poc \
  -o jsonpath='{.metadata.uid}'); then
  echo "$PROBE_KIND/$PROBE_NAME: read failed or object gone; no result verdict is possible" >&2
  false
fi &&
if ! matches=$(kubectl get policyreport -n policy-poc -o json | jq -r \
  --arg kind "$PROBE_KIND" --arg uid "$PROBE_UID" \
  --arg policy "$EXPECTED_POLICY" --arg rule "$EXPECTED_RULE" '
  [.items[]
   | select(.scope.kind == $kind and .scope.uid == $uid)
   | .results[]
   | select(.policy == $policy and .rule == $rule)
   | [.policy, .rule, .result, .message]
   | @tsv][]'); then
  echo "PolicyReport read or parse failed; no result verdict is possible" >&2
  false
fi &&
if [ -z "$matches" ]; then
  echo "$PROBE_KIND/$PROBE_NAME ($PROBE_UID): zero matching PolicyReport results -- not pass; wait for convergence or debug policy scope" >&2
  false
else
  printf '%s\n' "$matches"
fi
#   A zero-row result is non-convergence / non-match, never pass.
#   Before the terminal state the report records skip; do not read once and conclude (the closing paragraph of §4.4.2)

# Type 3 - Cancellation (the table says "cancelled / unaffected") -- the evidence-collection shape of §3.4's third kind, "end-to-end"
#   Always read spec.status and the terminal reason off the object itself, but WHICH
#   object depends on the cancellation path (full table in the §4.6 intro). Query the
#   wrong one and you read an empty value and call a working policy broken:
#     * §4.2.2 / §4.6.1 / §4.6.2 are mutate-existing -- they patch the PARENT run;
#     * §4.2.3 is an admission mutate -- it patches the gate TaskRun itself, and the
#       parent run carries no spec.status at all.
#   The run name is the only thing to fill in -- set it first, on its own line:
PROBE_RUN='<probe-pipelinerun-name>'
#   Quoting makes the line parse; this makes it MEAN something. Without the guard the
#   placeholder flows into the query as a literal name and you get a confusing NotFound.
case "$PROBE_RUN" in '<'*'>') echo "fill in PROBE_RUN first"; false;; esac &&
kubectl get pipelinerun -n policy-poc "$PROBE_RUN" \
  -o jsonpath='{.spec.status} {.status.conditions[0].reason}{"\n"}'
#   §4.2.3 only: the verdict lives on the gate TaskRun, together with the reason
#   text the policy wrote (the parent run merely ends up Cancelled).
kubectl get taskrun -n policy-poc -l tekton.dev/pipelineRun="$PROBE_RUN" \
  -o custom-columns='NAME:.metadata.name,STATUS:.spec.status,MSG:.spec.statusMessage'
```

**上面提到的“该章节的示例 manifest”正是那九个章节没有提供的东西**——所以先从下面三个骨架中选一个，再按期望表的行修改字段。三个骨架都能通过 `kubectl create --dry-run=server` 准入检查（`<registry>` / `<catalog>` 的获取方式见 [§4.0.3](#s4-0-3)）：

```yaml
# Skeleton A - PipelineRun entry (used by §4.1.1, §4.2.5, §4.5.5, §5.2, §5.3)
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: probe-
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
```

```yaml
# Skeleton B - TaskRun entry (used by §4.2.4, §4.5.1, §4.5.4). Written here in the hub shape:
# these sections' policies pin the hub identity, so running with the §3.3 fixture's
# cluster resolver leaves the precondition unmet and the whole rule skips — that is
# a cell in the expectation table, not an "allow".
# Remote resolution happens after admission, so even if the referenced object does not
# exist in the hub, the dry-run still passes admission — enough to verify the policy criteria.
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  generateName: probe-
  namespace: policy-poc
spec:
  taskRef:
    resolver: hub
    params:
      - name: catalog
        value: <catalog>
      - name: type
        value: artifact
      - name: kind
        value: task
      - name: name
        value: sonarqube-scanner
      - name: version
        value: "0.7"
  params:
    # The parameter NAME is part of the contract, not a placeholder: §4.2.4's rule
    # reads `sonarBranchName` out of spec.params. Naming it `branch` would make even a
    # compliant branch look like "parameter absent" -- and that row of the table is
    # then indistinguishable from the illegal-branch row.
    - name: sonarBranchName
      value: main
```

```yaml
# Skeleton C - Pod entry (used by §4.5.3 — that section's policy governs Pod-level images, not the TaskRun)
apiVersion: v1
kind: Pod
metadata:
  generateName: probe-
  namespace: policy-poc
  labels:
    # REQUIRED: §4.5.3's rules select Pods by this label (that is how they scope to
    # Tekton-created Pods). Without it every probe cell skips at match time -- all
    # images "pass", indistinguishable from the policy being broken. Substitute the
    # placeholder per §4.0.3 (read from config-defaults).
    app.kubernetes.io/managed-by: <tekton-managed-by-label-value>
spec:
  restartPolicy: Never
  containers:
    - name: probe
      image: <registry>/busybox:latest
      command:
        - "true"
```

九个章节各自要改的内容：

| 章节 | 用哪个骨架 | 期望表的每一行在改什么 |
|---|---|---|
| [§4.1.1](#s4-1-1) 模板白名单 | A | 整个 `pipelineRef` 块：改 `name` / `namespace`，改 `resolver`（cluster → git），把 git 引用写成可变引用 |
| [§4.2.4](#s4-2-4) 保护分支门禁 | B | `taskRef.params` 中的五个 hub 项严格按该节正文所列保持不变；变化 `spec.params` 的组合：`sonarBranchName` 的取值（保护分支 / 特性分支 / 整个删掉——缺省时会作为默认分支进入保护范围）× 门禁开关（缺省 / `"true"` / `"false"` / 空字符串）× `sonarProperties` 条目（规范 / 非规范形态、被治理的键、`sonar.pullrequest.key=` 为空和非空、`sonar.pullrequest.base=`）——期望见该节的探针表 |
| [§4.2.5](#s4-2-5) 官方模板前置拦截 | A | 把 `pipelineRef` 改成该节正文中的官方模板坐标（java / python 0.3），然后按自检表逐行修改 `spec.params`（门禁开关、`sonarProperties` 条目、`trivyExitCode` / `trivySeverity` / `images` 等）以及 `workspaces` 绑定的对象——**判据位于 PipelineRun 层，因此用骨架 A 而不是 B** |
| [§4.5.1](#s4-5-1) 来源白名单 | B | 把 `taskRef.params` 中的 `name` / `version` 改成该节的 `skopeo-copy` 条目，然后变化 `spec.params` 的 `srcTransport` / `srcImage` / `imageMappings`，以及是否挂载 workspace |
| [§4.5.3](#s4-5-3) 镜像白名单 | C | `containers[].image`；`initContainers` 同理，作为额外的块；`ephemeralcontainers` 那一格改用 `kubectl patch pod <name> --subresource=ephemeralcontainers`（它是子资源 UPDATE，不是 CREATE）。**骨架 C 的 `managed-by` 标签必须按 [§4.0.3](#s4-0-3) 替换成真实值**——该节每条规则都靠这个标签把范围限定到 Tekton Pod；标签缺失或错误时，每一格都会在匹配阶段跳过，“已批准镜像”和“未批准镜像”两格结果完全相同，整个探针作废 |
| [§4.5.4](#s4-5-4) 裸入口封闭 | B | manifest 几乎不变；**变化的是身份**：同一请求分别用 `--as=<platform-admin-identity>` 和 `--as=<business-identity>` 各跑一次——只有两格结果相反时，这条策略才算被命中。⚠️ **这组 allow/deny 对只验证了 break-glass 分支**——allow 侧还必须覆盖 [§4.5.4](#s4-5-4) 验证清单中“控制器身份 + 控制器 owner ref 放行”与“正常端到端 PipelineRun `Succeeded`”两格：如果策略里控制器 + ownerReference 的正常路径被写坏（恒为 false），管理员分支仍然放行、业务身份仍然被拒，于是这套配方会假性通过，而真实流水线已经无法创建子 TaskRun；CustomRun 那一格要把 `kind` 改为 `CustomRun`、`taskRef` 改为 `customRef`，**并把 `apiVersion` 改为 `tekton.dev/v1beta1`**——CustomRun 只存在于 v1beta1，`tekton.dev/v1` 没有它（[§3.2](#s3-2) “API group-version 前提”中的例外）；照抄骨架 B 的 v1 会在到达准入之前就被 API server 拒绝 |
| [§4.5.5](#s4-5-5) 发布目标 | A | `spec.params` 中的部署开关和目标 namespace、通过 `taskRunSpecs` 指定的 ServiceAccount，以及 workspace 引用的 Secret |
| [§5.2](#s5-2) namespace 分层 | A | 把 `metadata.namespace` 和 `-n` **一起**改成目标 namespace（`proj-a` / `proj-b` / `rogue-ns`——两者必须一致：只改 `-n` 而 manifest 仍写 `policy-poc` 会让 kubectl 在**到达准入之前**就失败，报 `the namespace from the provided object "policy-poc" does not match the namespace "proj-a"`——探针根本没碰到策略），然后按该节正文加入违反基线 / 项目策略的字段 |
| [§5.3](#s5-3) 豁免边界 | A | 把 `metadata.namespace` 和 `-n` **同步**在 `policy-exempt-runs` 和普通 namespace 之间切换（不一致会在准入之前就被拒，同上一行），把 `spec.params` 中两个门禁开关都设为 `"false"`，并全程带上 `--as` |

**每条命令都必须带显式身份**（即上面配方中的 `--as=<probe-identity>`，替换成期望表那一行想要测试的身份——例如 `--as=<business-identity>` 或 `--as=<platform-admin-identity>`）：不带的话就是用你自己 kubeconfig 的身份在跑，而它多半是管理员——被 `exclude` 刨除的身份永远不会触发策略，你会把“没有被拒”记成“策略放行了”。

**验收判据只有一条**：只有看到 `<policy>: <rule>: <message>`（准入类）或报告中该策略名下的 `pass`/`fail`（结果类），才算这条策略被命中。**“没有被拒”不等于“策略放行了”**——它同样可能意味着策略没匹配上、preconditions 短路了、或者另一条策略先拒了别的东西。拿不准时按 [§6.1.2](#s6-1-2)（“装了但没生效”的三步检查）和 [§6.1.3](#s6-1-3)（定位误拦）排查；被其他章节的策略先拦住的情况见 [§4.0.5](#s4-0-5)。

### 3.5 上线安全流程（Audit 先行） {#s3-5}

不同动作类型必须遵循不同的上线节奏，不要机械地把每条策略都切到 Enforce：

1. **主资源上的准入 validate**（PipelineRun / TaskRun / Pod 的 CREATE/UPDATE）：先把每条规则的 `validate.failureAction` 设为 `Audit`，观察 PolicyReport 并修正 match / preconditions；误报清零后才切到 `Enforce`，切换前用 dry-run 正反探针回归一遍（[§3.4](#s3-4)）。
2. **`*/status` 结果类策略**：永久保持 `Audit`，只观察真实终态的 pass/fail。**绝不切到 Enforce**——那会拦住 Tekton 控制器的状态回写，造成卡死（[§2.2](#s2-2)、[§4.4.3](#s4-4-3)）。
3. **mutate-existing / generate**：先在隔离 namespace 里授予最小 RBAC，验证目标选择器和幂等条件，再扩大范围；它们不是 validate 策略，Audit → Enforce 的切换模型不适用于它们。

**“误报清零再 Enforce”仍然不够——切换本身必须分三个阶段灰度，且回滚要先演练过。**一条配置错误的大范围策略（首当其冲是 [§4.5.3](#s4-5-3) 的 Pod 级镜像白名单）可以一次性拒绝所有业务 namespace 里的 Pod 创建——**那是平台级的流水线全面停摆**：

| 阶段 | 范围 | 该阶段要观察什么 |
|---|---|---|
| 1 金丝雀 | 自己可控的**一个** namespace | 正反探针（[§3.4](#s3-4)）行为都符合预期；该 namespace 里一条真实流水线跑到终态 |
| 2 小批量 | 少数真实业务 namespace（选流水线频率高的） | 准入拒绝率、PipelineRun 创建失败率、`PodCreationFailed` 事件、webhook 延迟的任何变化 |
| 3 全量 | 整个目标范围 | 同上，并覆盖**至少一个完整业务周期**（含定时任务和升级窗口） |

**回滚必须是一步到位且已演练过的操作**，而不是临场决定：把策略切回 `Audit`（或删除它）会当场恢复放行——切换之前，**在金丝雀阶段实际执行一次回滚并确认恢复**，把命令和预期输出写进变更单。同时写下自己的恢复时间目标：当 Pod 级策略配置出错时，平台是几分钟内恢复还是等人上线，取决于这一步有没有提前准备。

:::warning 失败动作写在哪里：本文所有资产都使用规则级 validate.failureAction（顶层 spec.validationFailureAction 已 Deprecated）

依据：`kubectl explain clusterpolicy.spec.validationFailureAction` 本身就写着 `Deprecated, use validationFailureAction under the validate rule instead`（规则级路径 `rules[].validate.failureAction`，枚举值 `Audit` / `Enforce`）。这条记录留在这里，是因为**存量集群上仍有大量策略在用顶层形式**，而这个弃用属于升级时最危险的漂移之一：

| 形式 | 提交一个必然违规的请求 | 备注 |
|---|---|---|
| 只有规则级 `validate.failureAction: Enforce`，无顶层字段（本文所有资产） | **被拒** | 适用版本下的实际行为；见本文顶部“适用版本”框 |
| 顶层 `spec.validationFailureAction: Enforce`（常见的存量形式） | **被拒** | 今天仍然生效，但已 Deprecated |
| **两者都没设** | **被放行**（策略仍显示 `Ready=True`） | 默认等同于 Audit |

第三行就是风险所在：**当顶层字段最终被移除时，CRD 字段裁剪会静默丢掉它**——策略仍然安装成功、显示 `Ready=True`、`kubectl get clusterpolicy` 看起来完全正常，但它**已经拦不住任何东西**。这正是本文反复警告的最坏形态——静默放行。

因此：

- 如果你手里还有顶层形式的存量策略，**在升级前把它们迁移到规则级**：删掉顶层那一行，在每条 validate 规则的 `validate:` 下写 `failureAction`（语义等价；本文的资产就是迁移后的形式）。注意是**每一条**规则——规则级字段不会继承，漏掉的任何一条规则都会回落到默认的 Audit（上表第三行）；
- **升级 Kyverno 之后，不要只检查策略是否 Ready**——重新跑一遍各节“违规请求必须被拒”的探针（[§3.4](#s3-4) 的 `--dry-run=server` 正反两格）。规则级形式躲过了这一个点名的弃用，但“升级后语义漂移”本身并没有消失（[§3.6](#s3-6) 的 Kyverno 升级行）；
- 对**保持 Audit** 的 `*/status` 策略，唯一不受影响的是“它们不会突然开始拦人”；它们的漂移风险在别处（见 [§4.4.1](#s4-4-1) 的结果契约和 [§4.0.1](#s4-0-1) 的版本错配约束）。

:::

### 3.6 变更与升级触发点（环境一变，先回到这张表） {#s3-6}

本文策略的判据高度依赖三类**外部事实**：模板 / Task 的版本与契约、Tekton 的 `config-defaults`，以及你自己维护的审批清单。其中任何一项变化而策略没有跟上时，后果就是本文通篇警告的两种形态之一——**静默放行**（策略还在但不再拦截）或**静默误拒**（所有合规请求都被拒，报错指向某条判据）。

| 触发动作 | 受影响判据 | 后果 | 变更必须包含什么 |
|---|---|---|---|
| 新增业务 namespace，或把流水线迁移到新 namespace | [§4](#s4) 中**每一条**策略的 `namespaces:` 枚举（示例值 `policy-poc`） | **静默放行**：新 namespace 不匹配任何规则 | 先把新 namespace 加进每个作用域（或按 [§5](#s5) 改用 namespace 级 `Policy`；要“默认覆盖”则改成平台级 ClusterPolicy 并用负向 `exclude` 排除系统 namespace，而不是逐个枚举），对新 namespace 跑正反探针，**然后**才让业务迁入 |
| **新增业务集群**，或把流水线迁移到另一个集群 | **全文档的每一条策略**（[§4](#s4) 与 [§5](#s5) 皆然）——`ClusterPolicy` / `Policy` 是集群内对象，**不会跨集群同步** | **静默放行**：新集群一条策略都没有，而旧集群的报告看起来一切正常——从旧集群侧完全不可见 | 集群接入按 [§4.0.7](#s4-0-7) 的五步转换与验收执行（含正反探针）——不要简化成“装个最小集”；策略清单通过 GitOps / 平台模块分发而不是手工安装；定期做跨集群基线比对——**基线 = 每条 `ClusterPolicy` 加上各受治理项目 namespace 里的 `Policy` 对象**（[§5](#s5) 的项目自治对象永远不会出现在 `kubectl get clusterpolicy` 列表里），**比对至少要覆盖名称 + 每条规则的 `validate.failureAction` + `match`/`exclude`（含 namespaceSelector）+ `spec.webhookConfiguration`（`failurePolicy` / `timeoutSeconds`）**——只比名称的话，同一条策略在一个集群是 Audit、另一个集群是 Enforce 也会被报成“基线一致”；漏掉最后一项的话，即使某个集群的声明正在被强制成 `Ignore` 也会被报成一致，所以**各集群平台级 `forceFailurePolicyIgnore` 开关状态也要作为集群级条目一并比对**（与 [§7.3](#s7-3) 同一把尺子）；最稳的形态是把每个集群与 GitOps 期望状态做结构化 diff |
| 模板版本升级（如 0.3 → 0.4） | 每条固定 `refVersion` 的策略 | **静默放行**（身份不匹配 = 跳过） | 见 [§4.0.1](#s4-0-1) 的顺序约束 3；唯一能拦住“新版本溜进来”的层是 `pipeline-template-allowlist` |
| **Task 版本升级**（与模板解耦，会独立发生） | [§4.4](#s4-4).x 的结果读取策略，以及完整画像里的 Task 身份判据 | **静默放行**（旧版本身份不再匹配 → PolicyReport 看起来“干净”）；只改版本不改结果路径则变成**误报** | 三处一起改：Task 身份版本、结果**名称**、属性**路径**。改完后用**一次真实失败的扫描**确认 PolicyReport 里出现 fail——这是 Audit 策略的正向对照：**如果没有 fail 出现，先怀疑身份没匹配上，而不是“没有违规”** |
| 修改 `config-defaults` 里的 `default-service-account` | [§4.5.5](#s4-5-5) 的 run 级 SA 审批清单 | **两个方向都会发生，取决于改成什么**：改成**另一个非空值** → **静默误拒**（所有开启部署的合规请求都被拒）；改成**空值** → Tekton 不再填充该字段，判据的 `!= ''` precondition 不再成立、整条规则跳过 ⇒ **静默放行**（fail-open；见 [§4.0.3](#s4-0-3) 中该占位符所在行） | 同一变更里更新清单，并跑三个探针格（新默认 SA / 站点批准的 SA / 清单外 SA）；**外加一格**：用 [§3.3](#s3-3) 的 fixture 读一次实际生效值并确认它**非空**——空值必须先改回真实 SA 名，清单才有讨论的意义 |
| 修改 `config-defaults` 里的 `default-pod-template`，**尤其是添加 `env`** | [§4.2.5](#s4-2-5) 和 [§4.5.5](#s4-5-5) 里的 `runWideEnvCount` | **静默误拒**：平台默认注入 env 之后，每个 run 的计数都 > 0，**所有**流水线都被拒 | 把平台注入的 env 条目**名称**加入允许清单（下面给出可用形式）——不要删判据 |
| 修改 `default-managed-by-label-value` | [§4.5.3](#s4-5-3) 的 Pod 范围限定标签 | **静默放行**：Pod 规则不再命中任何 Tekton Pod | 同一变更里改占位符，用真实 Tekton Pod 验证 match 命中，再验证批准 registry 之外的镜像仍被拒 |
| 已批准对象的**内容**变化（`approved-*` ConfigMap / Secret 的内容、`pipeline-image-allowlist` 的正则被放宽） | 所有只比对**对象名称**的判据（[§4.2.5](#s4-2-5) 的 workspace 系列、[§4.5.3](#s4-5-3) 的 ConfigMap 形态） | **静默放行**：名称仍是批准值，内容已被放宽 | 把“对象轮换”（改名）和“对象内容变更”分开管理：内容必须纳入 GitOps / RBAC 管控与评审——**策略只能锁住“绑定的是哪个对象”** |
| Kyverno 升级 | 所有策略（本文资产已使用规则级 `validate.failureAction`，躲过顶层字段的弃用；存量顶层策略风险最大） | 可能**静默放行** | 见 [§3.5](#s3-5) 的警告块；升级后不要只查 `Ready`——按 [§3.8](#s3-8) 重跑最小回归集。**除失败动作之外，以下语义每一条都要自己验证**（不是“某个版本一定改了”——而是“不验证就不知道”）：`context.apiCall` 的失败方向、JMESPath 函数行为、`foreach` 是否仍遍历全部三种容器类型、子资源 match 语法、PolicyException 的匹配与删除传播，以及 PolicyReport 的 API 版本 |
| **Tekton Pipelines 升级** | 所有策略，首当其冲是“枚举已知字段”的那些（见下文“两种判据形态”） | **静默放行**：新字段 / 新覆盖入口 / 新 resolver 参数不在判据里，默认落在放行侧 | 重新枚举字段面并逐条核对判据：`PipelineRun` / `TaskRun` 的 spec、`spec.taskRunSpecs` 的可覆盖项、resolver 参数、Pod 的容器类字段，以及任何新出现的 run 类资源（[§4.5.4](#s4-5-4) 的入口封闭按 kind 枚举）。**枚举方法**：对一次真实运行的对象取 `kubectl get -o yaml`，与升级前的存档做 diff，只看新增字段。**取消语义还要单独重新验证**：`spec.status` 的可接受值、`CancelledRunFinally` 与 finally 的关系，以及“取消 vs. 任务失败”谁赢得终态判定——[§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6](#s4-6) 全都建立在这套状态机上。**还有两个封闭枚举必须重查**（它们恰恰是升级最容易悄悄扩大的部分，且都是黑名单形态——新条目默认落在放行侧）：① `skippedTasks[].reason` 的取值集合（[§4.1.5](#s4-1-5) 给出了重新获取取值的位置）；② `PipelineRun` / `TaskRun` / `CustomRun`——**各自实际服务的 group-version**（[§3.2](#s3-2) 的“API group-version 前提”——一条 `kubectl api-resources --api-group=tekton.dev` 命令即可；增加或下线一个版本都会改变 `match` 的命中面） |
| **ACP 升级 / 平台模块 reconcile** | 依赖平台配置的策略（[§4.5.3](#s4-5-3) 的范围限定标签、[§4.5.5](#s4-5-5) 的 SA 清单、[§4.1.1](#s4-1-1) 的 hub 端点、Kyverno 自身配置） | **静默放行或静默误拒**，取决于哪一项被重置 | 平台升级会按模块模板重新 reconcile 配置，**你此前的手工修改可能被回退**：升级后重跑 [§3.1](#s3-1) 的 7 项清单（尤其第 6、7 项，`failurePolicy` 和 `resourceFilters`），并复查 `config-defaults` / `feature-flags` / `hubresolver-config` / kyverno ConfigMap 四份配置。**如果你在用 PolicyException，还要复查 [§3.1.1](#s3-1-1) 的管理面路径本身**——`ModuleInfo` 定位条件、`valuesOverride` 的 chart 键、配置向业务集群的传播链路都是平台实现，升级后可能已经变化：命令还能跑但找不到对象，或写入不生效，回滚路径也会以同样方式失效。**平台配置被重置期间，策略的 `Ready=True` 不代表它仍在生效** |
| PolicyException 过期未清理 | [§5.3](#s5-3) 的豁免范围 | **静默放行**：旧豁免持续匹配同类的后续运行 | 每个 exception 必须带审批单号 / 生效与过期时间 / 责任人；定期扫描过期对象；删除后用一次违规运行确认拒绝已恢复（Kyverno 没有原生 TTL） |
| 身份清单上的某个 SA 被删除重建 | 按 `request.userInfo.username` 比对的判据，如 [§4.5.4](#s4-5-4) / [§4.2.1](#s4-2-1) | 名称比对仍然通过，**但权限已是另一套** | 名称不变不等于身份等价：重建后复查该 SA 的 RoleBinding 和 Secret，并用 `--as` 探针把放行侧和拒绝侧都重新验证一遍 |

**平台默认注入 env 时的放宽形式**（本文环境的 `default-pod-template` 里只有 `securityContext`，所以正文保留“出现任何 env → 拒绝”的判据；平台一旦加入默认 env，就切换为按名称放行）：

```yaml
- name: nonDefaultEnvCount
  variable:
    # Count only env entries the platform default did not put there. Verified on
    # cluster: two platform names -> 0, one extra business name -> 1.
    jmesPath: >-
      length((request.object.spec.taskRunTemplate.podTemplate.env || `[]`)[?contains(['<platform-default-env-name>'], name) == `false`])
    default: 0
```

**把这张表接进你自己的变更流程**：任何触及模板、Task、`config-defaults`、已批准对象、或 Kyverno / Tekton / ACP 版本的变更单，都应带一个检查项“策略侧是否也需要变更？”——上面每一行都对应一次“别的东西变了而策略没跟上”。

#### 两种判据形态决定“新字段”落在哪一侧

升级之所以从根上危险，是因为判据有两种形态，而这两种形态对**判据未曾预料的任何东西**给出相反的默认答案：

- **白名单形态**（“必须命中批准集合，否则拒绝”）——例如 [§4.1.1](#s4-1-1) 的三通道并集、[§4.5.3](#s4-5-3) 的 registry 前缀、[§4.5.4](#s4-5-4) 的入口身份、[§4.5.5](#s4-5-5) 的目标清单。**新出现的形态自动落在拒绝侧**；升级后表现为“看得见的停摆”：合规请求被拒。痛但安全——而且你一定会注意到。
- **黑名单形态**（“出现已知坏值 / 坏字段时拒绝”）——例如各门禁参数契约（[§4.2](#s4-2)）、结果读取 Audit（[§4.4](#s4-4)）、`skippedTasks` 审计（[§4.1.5](#s4-1-5)）。**新字段、新覆盖入口、新枚举值自动落在放行侧**；升级后表现为“静默放行”：策略仍然 Ready、报告一尘不染，而那条路径已经无人盯守。

**分类的单位是“一条判据 + 一个字段面”，不是“一条策略”**——两种形态经常共存于同一条策略之内：[§4.2.5](#s4-2-5) 用白名单锁模板身份，同时用黑名单枚举坏参数；[§4.5.3](#s4-5-3) 的镜像前缀是白名单，但它“只遍历三个已知容器字段”这件事是黑名单。所以升级回归必须**逐字段面测试**（未知 resolver / 未知参数 / 未知枚举值 / 未知容器路径各一个探针）——不要按策略条数打勾。

**判断一条判据的形态只问一个问题：递给它一个它从未见过的形态的输入——它是拒还是放？**拒 = 白名单，放 = 黑名单。**每条黑名单形态的判据在升级后都必须重新枚举其字段面**——这就是上表中 Tekton / 模板 / Task 各行要求“重新枚举”的原因，也是 [§3.8](#s3-8) 回归集必须包含“未知覆盖字段”类负向探针的原因。

### 3.7 规模与失败预算（上生产前把这些数字算一遍） {#s3-7}

前面各节保证的是判据正确。本节是另一回事：**这套策略在真实规模和真实故障下会不会把平台拖垮，或者在压力下以另一种方式失效**。对下面六项预算，本文只能给出机制和数量级——**具体数字必须在你的环境里压测出来并写进变更单**。

| 预算什么 | 机制事实 | 你必须定下的预算 / 动作 |
|---|---|---|
| **准入路径上的外部调用（同步准入）** | 三条判据会在准入请求内部等待一次外部往返：`context.imageRegistry`（[§4.5.2](#s4-5-2)）、[§4.2.1](#s4-2-1) 的 validate `context.apiCall`，以及 [§4.2.3](#s4-2-3) 的准入 mutate `context.apiCall`（它去获取父 PipelineRun——**虽然挂在 mutate 规则上，但它在 TaskRun CREATE 的 webhook 请求内部同步执行，同样占用本行预算；不要漏算**）。**三条都是 fail closed**：registry 不可达 → 请求被拒（约 5 秒；可达时约 3 秒，见 [§4.5.2](#s4-5-2) 的局限 4）；[§4.2.1](#s4-2-1) / [§4.2.3](#s4-2-3) 的 apiCall 取不到目标 → 规则报错、请求被拒（准入 mutate 规则失败与 validate 失败一样按策略的 `failurePolicy` 被拦——机制来源：release-1.15 `pkg/webhooks/resource/mutation/mutation.go` 的 `BlockRequest` 分支；[§4.2.1](#s4-2-1) 的报错形态见该节警告）。**“报错即拒”的前提是策略实际生效的 `failurePolicy` 为 `Fail`**（本文的同步拦截资产都显式声明 `Fail`；完整分层见下方“`failurePolicy` 取舍”行）；切成 `Ignore`、或平台级 `forceFailurePolicyIgnore` 生效时，同样的报错就变成放行。**[§4.2.2](#s4-2-2) / [§4.6.1](#s4-6-1) 的 apiCall 不算在本行**——它们挂在 mutate-existing 上，失败方向相反；见下一行 | 明确决定“哪些请求路径可以携带外部调用”；把这类规则的 match 收窄到**真正需要它们的 Task**；压测 p95 / p99 和超时占比，并确认低于 webhook 超时——**这个上限作用于整个请求，不是每条规则各算一份**（默认 `timeoutSeconds=10`，见 [§3.1](#s3-1) 清单第 6 项；一次 5 秒的 registry 往返装得下，同一请求上叠两次未必装得下）。**Registry / API server 抖动会直接转化为流水线创建失败**——把对应的告警和处置手册准备好 |
| **异步投递链路（mutate-existing 取消是 fail-open）** | 本文四条取消路径中有三条是 mutate-existing（[§4.2.2](#s4-2-2) / [§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2)），它们位于**准入裁决之外**：命中后由 background-controller 通过 UpdateRequest 异步 patch 目标对象。因此当这条链路上任何一环失败——规则的 `context.apiCall` 取不到目标、UpdateRequest 根本没被创建、background-controller 宕机或积压、目标资源的 update RBAC 被收回——**原请求照常放行，取消 patch 静默消失**：流水线一路跑到底，集群里任何地方都没有拒绝消息，PolicyReport 也没有违规记录（mutate 类型不产生违规记录——[§4.2.3](#s4-2-3) 的警告），至多在控制器日志里留几行报错（评估与写入层在 background-controller，UpdateRequest 的**创建层在 admission-controller**——三层的签名见 [§3.7.1](#s3-7-1) ③；**控制器自身不可用的那类故障连这些行都不会留下**——只有 [§3.7.1](#s3-7-1) ① 的存活监控覆盖它）。**判据方向的 fail-closed ≠ 投递保证**：判据说“结果缺失/非法也照样取消”，但取消能不能落地取决于这条后台链路的健康 | **要硬保证零竞态、零静默失败，只有同步路径合格**：[§4.2.1](#s4-2-1) 的拒绝或 [§4.2.3](#s4-2-3) 的准入 mutate（两者都在准入内部给出同步裁决）。如果继续留在 mutate-existing 上，就必须把这条链路当作**带 SLA 的投递系统**来监控：可用的信号面（控制器存活 / 指标 / 日志与事件）、每个信号的语义边界、归因方法、以及受控故障注入流程见 [§3.7.1](#s3-7-1)——这份监控契约的**唯一完整版本**（[§3.8](#s3-8) 第 9 步和 [§6.2.3](#s6-2-3) 排障都只引用它、从不复述）；把选定的信号和告警分诊 SOP 写进变更单 |
| **单个请求命中多少条规则** | 一次 CREATE 可能同时命中多条策略（多条策略按 AND 组合，[§1.3](#s1-3)），每条策略又可能有多条规则；[§4.5.3](#s4-5-3) 的镜像白名单就是三条规则，每条都对容器列表跑 `foreach` | 按资源类型为“单请求最大命中规则数 / 最大外部调用数”设上限；超限时合并判据或收窄 match——不要拿单条策略的孤立压测下结论 |
| **`*/status` 策略的评估频率** | 一条流水线的 status 会被**回写很多次**（观测点 3 / 6，[§2.1](#s2-1)）；读 status 的策略**每次回写都重新评估**，且请求体携带整个 `status.pipelineSpec`（模板大时它可以很大） | 昂贵判据（外部调用、长列表遍历）**放在门禁任务或事后链路里**，绝不放进 `*/status` 策略；上线前实测一次“单请求体大小 × status 更新次数” |
| **后台扫描与 PolicyReport 体量** | 全文档只有一条 `background: true` 策略（[§4.4.4](#s4-4-4)）；它周期性重评估**所有**匹配对象；报告按被评估对象生成、随对象一起被 GC，**没有 TTL / 保留语义**（[§4.4.4](#s4-4-4) 的边界） | 按 PipelineRun 量估算报告对象数量与增长；需要留痕就做**外部归档**（不要把 PolicyReport 当历史存储）；对 reports-controller 积压设告警 |
| **`failurePolicy` 取舍** | **分层落在每条策略自己的 `spec.webhookConfiguration.failurePolicy` 上**（字段语义、两层读取方式和检查命令见 [§3.1](#s3-1) 清单第 6 项和 [§3.1.2](#s3-1-2)；两个取值的后果见 [§6.1.8](#s6-1-8)——此处不复述）。⚠️ **`validate.failureAction: Audit` 挡不住这件事**：它只决定评估成功的规则是否拦截；**策略的匹配面无论如何都会注册进 webhook**——Kyverno 不可用期间，API server 按该策略的 `failurePolicy` 处置所有匹配请求；一条声明 `Fail` 的 Audit 策略照样会拒掉匹配的 `*/status` 回写，Kyverno 宕多久流水线就卡多久，而这本是一条正常运行时从不拦任何东西的策略。本文资产已按此分层并显式声明：**17 条声明 `Fail`，8 条声明 `Ignore`**。`Fail` 层 = 准入拦截策略（Enforce / mutate 注入）**加上 [§4.2.2](#s4-2-2) 的取消触发器**——它虽是 mutate-existing，但其触发面是主资源 TaskRun 的 CREATE，守的正是 [§4.2.1](#s4-2-1) 守的那道门（三种响应形态之一——见 [§4.2.3](#s4-2-3) 的对比表）；若取 `Ignore`，Kyverno 故障期间违规会**既不被拦也不被取消地永久放过**（`background: false`，无回溯扫描）。`Ignore` 层共 8 条——其中 7 条匹配 `*/status`（状态回写绝不能被 Kyverno 故障拦住——[§2.2](#s2-2) 的红线在故障场景同样成立），1 条是 [§4.4.4](#s4-4-4) 的盘点扫描（匹配 PipelineRun 主资源的后台 Audit：正常运行时它不拦任何东西，但若取 `Fail`，Kyverno 故障会拒掉所有匹配的 PipelineRun CREATE——零拦截收益、纯可用性代价；按 [§4.4.4](#s4-4-4) 升级为 Enforce 时重新评估分层） | 按策略风险分层，写进策略体并用 GitOps 管理：**平台基线和 Pod 级镜像白名单保持 `Fail`**，前提是四个控制器跨节点 HA 且滚动升级期间保持可用；纯记账的 Audit 策略和匹配 `*/status` 的取消触发器（[§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2)）取 `Ignore`（本文 8 条资产：7 条 `*/status` 匹配 + [§4.4.4](#s4-4-4) 盘点扫描；**[§4.2.2](#s4-2-2) 的取消触发器不在此层**——它与 [§4.2.1](#s4-2-1) 守同一道准入门，跟它一起保持 `Fail`，理由见左格）——代价是 Kyverno 不可用期间这些记账和取消触发会缺失，所以把接受的真空边界写下来。**两件事不要混为一谈**：① 在 mutate-existing 取消策略上，这个字段只决定 Kyverno webhook 不可用期间**触发请求**是否被拦——`Fail` 并不能关掉异步投递本身的 fail-open（上一行）；② 平台级 `forceFailurePolicyIgnore` 一旦开启，所有声明的 `Fail` 都会被击穿——那是平台级覆盖开关，不是分层工具（机制与检查方法见 [§3.1.2](#s3-1-2)）。对每个集群，写下“选了哪一层 + 为什么 + 最小副本数 + Kyverno 维护窗口期间会发生什么”，并演练一个故障场景 |

**一句话判据**：任何“等别人答复”的判据（外部 registry、API server）都是可用性风险；任何“每次 status 回写都要跑”的判据都是成本风险。**没有预算，两者都不许上主路径。**

#### 3.7.1 异步投递链路的监控契约（信号面、归因与故障注入） {#s3-7-1}

本小节展开上文“异步投递链路”行中“当作投递系统来监控”的要求，是 [§3.8](#s3-8) 第 9 步（升级回归）与 [§6.2.3](#s6-2-3)（单 run 排障）共享的**唯一事实来源**——那两处只引用本小节、从不复述；信号语义的修订只落在这里。

先排除最常被误当证据的动作：**事后一次性的 `kubectl get updaterequests` 不是数据源**——失败的 UpdateRequest 只在其重试窗口内可见，重试结束即被删除（通常一两分钟内），此后查询为空，而**空输出对链路健康什么都证明不了**。可用的数据源是下面的 ①–③（⚠️ ③ 横跨 **admission 和 background 两个控制器**——链路的第一环“创建 UpdateRequest”发生在 admission 侧，只盯 background 侧会漏掉整整一层），④ 是它们的受控验证；**这些信号没有任何一个能单独证明“patch 落进了目标”——链路健康的最终仲裁永远是目标对象的最终状态**（[§3.8](#s3-8) 第 9 步的首要判据）：

- ① **background-controller 的存活、重启次数与队列积压。**这一项是其余各项的前提：**控制器挂了时，② 和 ③ 都不会产生任何新记录**——“控制器死了”在 ② 和 ③ 里看起来与“一切安静”一模一样。
- ② **指标（持久计数器——⚠️ 只覆盖规则评估层）**：在 background-controller 的指标端口（`kyverno-background-controller-metrics:8000`）上，`kyverno_policy_results_total{rule_type="mutate",rule_execution_cause="background_scan"}`，带 `policy_name` / `rule_name` 标签，在 UpdateRequest 删除后仍持久存在（作为计数器它会在控制器重启时归零——先接入抓取系统再基于它做告警）。
  - **这个计数器记录的是规则评估结果，在 patch 写入目标之前就已计数**：`rule_result="pass"` = 评估成功、算出了 patch——**并不证明 patch 已写入目标对象**；`rule_result="error"` = 评估失败（含 apiCall 取不到目标）。如果后续对目标的写入因 RBAC、resourceVersion 冲突或 API 报错而失败，**`pass` 已经计入而 `error` 永远不会增加——写入层失败在这个计数器里完全不可见**；只有 ③ 的第二条日志签名和事件覆盖它们。
  - 它还**计的是尝试次数而非事故次数**（首次投递和每次重试各加一），且 `error` 有良性来源：父对象已被删除时，apiCall 404 是正常的清理竞态（[§4.6.1](#s4-6-1) 的 404 说明），照样计入 `error`。所以这个计数器**是评估层的分诊线索，绝不是直接告警条件**——“任何增量 > 0 就告警”会被正常清理竞态持续误报——**也绝不能当作“命中数减落地数”的对账**。
  - `error` 增加时，**按目标对象归因**：找到一条“本该被取消却仍在运行”的 run（查 `spec.status` / `cancel-reason`——[§6.2.3](#s6-2-3) 的单 run 命令）；只有这样的 run 才是真正的投递失败。**归因有保质期**：目标对象一旦被 GC 或清理，“报错发生时对象已被删除（良性 404）”与“投递真失败了、对象随后消失”留下的现场完全相同（[§6.2.3](#s6-2-3) 也提到注解 / 事件 / 报告都随对象一起消失），再也无法区分——所以把后续核查写进告警 SOP 并**及时执行**（在对象保留窗口内），无法归因的增量记为“未知、待查”——**绝不默认按良性处理**。
- ③ **日志与事件（确定性签名——创建 / 评估 / 写入，每层各有归属）**：
  - **创建层**失败（UpdateRequest 根本没被创建）的日志**在 admission-controller，不在 background-controller**：创建在准入时启动的异步 goroutine 中执行（`Apply()` 立即返回；错误永远不会进入准入裁决），约 3 秒退避重试后失败记 ERR `failed to update request CR`；当集群的 UpdateRequest 数达到 `updateRequestThreshold`（Kyverno ConfigMap）时，创建被**直接跳过**并记 ERR `UpdateRequest creation skipped`。这一层失败时，① 和 ② 以及 background 侧日志**全部安静**，提前启动的 watch 也看不到任何东西（对象从未被创建过）——机制来源：release-1.15 `pkg/webhooks/updaterequest/generator.go`（`Apply()` / `applyResource()`）与 `pkg/utils/generator/updaterequests.go` 的阈值分支。
  - **评估层**失败记 ERR `failed to mutate existing resource, rule <rule-name>, ...`（apiCall 取不到目标时错误串包含 `failed to fetch data for APICall`），带结构化的 `policy=` / `resource=` 字段。这一行**不适合裸告警**（父对象已删的正常竞态记的是同一行）；按 `resource=` 查目标对象，再按 ② 的归因判据分类。这条路径上目标对象从未被解析出来，因此**不会产生 Kubernetes 事件**（Kyverno 日志原话：`cannot generate events for empty target resource`）。
  - **写入层**失败（评估通过、把 patch 写进目标失败）记的是**另一条** ERR 签名 `failed to update target resource`（带目标的 `namespace=` / `name=` 字段）——要**跨两个控制器搜全所有签名**；只搜第一条会把整个写入层失败类漏掉。此处目标对象已被解析出来，因此 Kyverno 会在目标对象上发出 `BackgroundFailed`（成功侧：`BackgroundSuccess`）事件，在目标 namespace 里用 `kubectl get events` 可见——写入层唯一的对象级信号（机制来源：release-1.15 `pkg/background/mutate/mutate.go` 的 Pass 分支与 `report()`）。
- ④ **受控故障注入（上线前一次、每次升级后一次）**：**触发之前先启动 `kubectl get updaterequests -n kyverno -w`**（UpdateRequest 的生命周期只有提前启动的 watch 才看得到——失败侧显示 `Pending → Failed` 重试后消失，健康侧显示 `Pending → Completed`；**确认已触发但 watch 里始终什么都没出现 = 创建层失败**——去 admission-controller 日志找 ③ 的两条创建层签名）；在共享 / 生产集群上使用**专用测试策略 + 测试 namespace + 指向一个确知不存在对象的无害 apiCall**（不碰任何真实策略和业务对象），确认 ② 和 ③ 的信号确实出现、归因步骤能定位到注入的目标对象，并把结果写进变更单。“临时停掉 background-controller”是集群级故障（它会同时中断该集群上所有其他 mutate-existing / generate 投递）——留给专用验收集群或维护窗口，事前记录副本数，事后验证 Ready 和积压清空。
### 3.8 升级与回滚：最小回归集（每次升级后必须执行——不要只看 `Ready`） {#s3-8}

[§3.6](#s3-6) 告诉你"升级会影响什么"；本节回答"那么具体要跑哪些"。**没有这份清单，实践中回归根本不会发生**——因为策略升级后最常见的故障形态就是 `Ready=True` 且报告干净（即 [§3.6](#s3-6) 的两种判据形态）。

按顺序执行。**"一个应当放行的探针 + 一个应当拒绝的探针"这一要求只对 admission-Enforce 类步骤成立**——步骤 **2 / 3 / 7 / 8 / 10** 必须两侧都跑，只跑一半发现不了方向性错误（推理过程即 [§4.0.3](#s4-0-3) 的两步自检）。其余五类没有**"admission 放行"**侧，各有自己的通过判据——不要把该模式硬套上去：步骤 **1** 是配置比对（不提交任何对象）；步骤 **5 / 6** 是 Audit——Audit 不拦截任何请求，所以每个请求都会被"放行"，但**这不代表它们没有健康侧**：健康侧体现在 PolicyReport 里（正常输入必须得到 `pass` / `skip`，而不是 `fail`），所以这两步同样要跑两侧——只跑违规侧，一个把**所有**输入都记为 `fail` 的坏策略（身份判据接反的典型形态）会原封不动地通过回归；步骤 **4** 验证"响应形态与你所选的一致"（三选一，且 deny 与两种取消的检查位置不同）；步骤 **9** 验证取消**是否真正落到了对象上**（mutate-existing 是异步的；admission 侧不会 deny）；步骤 **11** 是端到端合规基线（只有放行侧——它证明的是合规的东西没有被误伤）。

| # | 要跑什么 | 通过判据（看行为，不看 `Ready`） |
|---|---|---|
| 1 | [§3.1](#s3-1) 的 7 项检查清单 + 四份配置 `config-defaults` / `feature-flags` / `hubresolver-config` / kyverno ConfigMap | 各值与升级前状态一致；任何不一致先按 [§3.6](#s3-6) 定位受影响的策略 |
| 2 | [§4.1.1](#s4-1-1) 的模板允许列表 | 批准的模板被放行；旧版本号、未知 resolver、请求级 `url` 三者全部被拒绝 |
| 3 | [§4.2](#s4-2) 的门禁参数契约（用你实际选择的那种响应形态） | 合规参数被放行；关闭门禁开关与显式空值都被拦截。**新增的覆盖入口要走两个阶段——不要要求拒绝列表天然拦住一个它从未见过的字段**（[§3.6](#s3-6) 已说明：任何没见过的东西默认落在放行侧；把已知旧字段当作"未知"来展示而得到的"拦住了"，是假的回归通过）：**先枚举**——通过 API schema / `kubectl explain` / 用真实对象与升级前存档做 diff，找出本次升级新增的覆盖入口，逐一探测以确认旧判据的实际方向，并**把探测通过的记为待处理缺口——此时回归并未通过**；**再治理**——判断该入口是否能影响被保护行为；能影响的，先更新判据，再验证更新后的策略能拦住它（同时保留一个正常输入仍被放行的正例，防止过度拦截）。本步骤的通过判据："每个影响被保护行为的新增入口在**判据更新后**都被拦截" |
| 4 | 一次真实的门禁 TaskRun | 非合规参数以你所选的**那一种**响应形态终止，且三种形态的检查位置各不相同（[§6.2.3](#s6-2-3)）：[§4.2.1](#s4-2-1) deny → 父运行 `CreateRunFailed`；[§4.2.2](#s4-2-2) 取消父运行 → **首要判据是父运行的 `spec.status=CancelledRunFinally` 加 `cancel-reason` 注解**——终态通常是 `Cancelled`，但当取消与任务失败发生竞态（result 无法写入，或取消落在子 TaskRun 的初始化窗口内）时终态会是 `Failed`，而 `spec.status` 与注解依然齐全（[§2.3](#s2-3) 主表；[§4.6.1](#s4-6-1) 的两条竞态说明）——**这不是回归失败；不要把健康的取消判成事故**；[§4.2.3](#s4-2-3) 取消门禁 TaskRun 本身 → **该 TaskRun** `Cancelled` + `spec.statusMessage`（父运行上没有 `cancel-reason`；不要以它判定失败） |
| 5 | 一次**真实失败**的扫描（sonar 与 trivy 各一）+ **一次干净扫描作为健康侧对照** | 失败侧：PolicyReport 里出现对应的 `fail`。**没有 `fail` 一律判"验收未通过"——绝不判"扫描通过了"，也绝不直接判"策略没匹配上"**——策略身份未匹配、`resourceFilters` 跳过、报告尚未收敛、对象已被 GC，产生的空结果一模一样；按 [§4.4.4](#s4-4-4) 的五种含义逐一排查。健康侧：干净扫描在该策略下被记为 `pass`（[§4.4.1](#s4-4-1) 的正常形态），**且没有意外的 `fail`**——没有这一侧，一个把所有终态都记为 `fail` 的坏策略（升级后身份判据接反）对本步骤完全不可见 |
| 6 | 通过 `when` / 空 matrix 让门禁被跳过 + **一次门禁正常执行的运行作为健康侧对照** | 违规侧：出现在 `status.skippedTasks` 中，且 [§4.1.5](#s4-1-5) 的 Audit 记录到该违规。健康侧：门禁执行过的那次运行在该策略下**没有** `fail`（[§4.1.5](#s4-1-5) 的正常形态是 `skip`——前置条件不成立）——否则一个把**所有**受治理运行都判成"门禁被跳过"的坏策略会原封不动地通过本步骤 |
| 7 | [§4.5.3](#s4-5-3) 的 Pod 镜像允许列表 | 批准的镜像仓库被放行；未批准的在三条路径上——**普通容器 / init 容器 / `ephemeralcontainers` 子资源**——都被拒绝，且消息中列出违规镜像 |
| 8 | [§4.5.5](#s4-5-5) 的发布目标 | 批准的 namespace / 凭证被放行；列表之外的一律拒绝 |
| 9 | 安装了 [§4.6](#s4-6) 的取消类策略时：一次结果不达标的运行（[§4.6.1](#s4-6-1)）+ 一次定义漂移的运行（[§4.6.2](#s4-6-2)）+ **一次与受治理档位相同的合规运行作为健康侧对照**（即 [§4.6.1](#s4-6-1) 检查清单里的 `coverage-lines=85` 反向对照——第 11 步的合规基线是 `gated-build` 夹具，不是本步骤的受治理档位，不能替代） | **首要判据是目标运行的最终状态**。健康侧：合规运行既没有被取消也不带 `cancel-reason`——没有这一侧，一个判据方向翻成"无条件取消"的策略无论如何都能通过本步骤。违规侧：`spec.status` 被写入 `CancelledRunFinally` 且 `cancel-reason` 措辞正确（metrics 的 `rule_result="pass"` 只证明评估层算出了 patch，绝不证明 patch 落到了目标上——[§3.7.1](#s3-7-1) 的 ② 语义）。**同时，要以可证伪的方式确认异步链路本身完好**（信号语义按 [§3.7.1](#s3-7-1)；本步骤只补充回归特有的判断）：要么**在触发前先启动 `kubectl get updaterequests -n kyverno -w`**，在 watch 中看到本次运行的 UpdateRequest 到达 `Completed`（反复 `Pending → Failed` 然后消失 = 链路已断；事后一次性 get 的空输出什么也证明不了——[§3.7.1](#s3-7-1) 开头）；要么按 [§3.7.1](#s3-7-1) ② 与 ③ 检查信号面：把窗口期内每一次 `"error"` 增量和每一条评估层 ERR 行按其 `resource=` 归因——回归窗口内的目标全部是**你**创建的对象，所以 [§3.7.1](#s3-7-1) ② 的"归因保质期"在这里天然可满足：把 ERR 行的时间戳与对象删除时间对上（删除是你执行的，或 `kubectl get events` 有记录）——**只有时间线对得上的才算良性竞态；任何建立不起时间线的信号一律判失败**；并确认写入层的两个信号**不存在**（`failed to update target resource` 的 ERR 行，以及目标 namespace 中该策略的 `BackgroundFailed` 事件——[§3.7.1](#s3-7-1) ③）。任何无法归因的信号、或一次从未被取消的验收运行，都是失败。这条链路恰恰是升级最容易悄无声息破坏的（RBAC 聚合规则变更、UpdateRequest API 版本变更），而它断掉时不会出现任何拒绝消息 |
| 10 | 启用 PolicyException 时（[§5.3](#s5-3)） | 无豁免时被拒绝 → 受控豁免下被放行 → 删除后再次被拒绝（三个状态都要查；缓存吊销需要片刻） |
| 11 | 一条完整业务流水线跑到终态（手头没有就用 [§3.3](#s3-3) 的 `demo-run-pass`，即全文通用的合规夹具） | 逐项核对而不是"跑完了就行"：父运行终态与升级前一致；`status.childReferences` 里每个子 TaskRun 都到达预期终态；finally 执行了；PolicyReport 里应有的每条 Audit 记录都在，**且没有意外的 `fail`**（用 [§6.2.3](#s6-2-3) 的命令按运行 UID 拉取——合规运行下冒出 `fail` 意味着某条 Audit 策略的判据在升级中被接反；第 5 / 6 步的健康侧对照正是为抓这个而存在）；并且没有任何 `cancel-reason` 或 `statusMessage` 意外出现 |

**Task / 模板升级的特殊要求**（最容易只留下"看起来没问题"的升级类型）：读取 result 的策略必须**先**改判据（身份、result 名、属性路径——三者一起，[§3.6](#s3-6)），再切换生产 Task；只有当第 5 步验证过"失败样本会产生 `fail`"之后，这次修改才算正确。

**回滚按发布的逆序执行：先策略契约，后运行对象。** 先重新部署与目标 Task / 模板版本匹配的策略版本，并用上表第 2、3、5 步验证，再把模板 / Task 切回旧版本。**在策略与模板身份不匹配的窗口期内，门禁不承载任何保证**：该窗口里的"PolicyReport 无违规"只说明策略没匹配上，绝不能当作通过（与 [§4.4.4](#s4-4-4) 相同）。窗口无法避免时，把那段时间显式标注为"门禁未生效"——不要让它进入事后的合规结论。
## 4. 策略手册 {#s4}

本章按治理场景组织，每一节都遵循固定结构：

**引言**（治理什么 / 为什么难 / 策略如何分层 / 治理不了什么）→ **关键判据**（策略最核心的几行，在正文中展开）→ **完整策略资产**（折叠，可直接复制）→ **验证探针与预期结果**（折叠）→ **清理**。

**这些策略不使用折叠**：[§4.2.5](#s4-2-5) 的 `trivy-gate-must-stay-on`（"先读最小版本"的过渡形态；同一节还带有折叠的完整版本 `official-template-gates-on`）、[§4.2.6](#s4-2-6) 的 `pipeline-run-defaults`，以及 [§4.4.4](#s4-4-4) 的 `inventory-ungated-runs`——这些小节把完整 YAML **直接放在正文里**（那一份清单本身就是该节的全部要点）。因此要一次性收集本章全部可安装资产时，**请全文搜索 `kind: ClusterPolicy`，而不是只收割折叠块**——只看折叠块会悄悄漏掉它们，[§5.2](#s5-2) 的两个演示策略同样位于正文中。

为了让同一套演示资产能够统一安装、验证、清理，本章使用 `ClusterPolicy`，但每条 Enforce 规则都限定在演示 namespace `policy-poc`。**这是演示选择，不是给项目管理员的生产权限建议**：项目管理员应把同样的规则逻辑放进自己 namespace 里的 `Policy`，设置 `metadata.namespace`，并去掉演示用的跨 namespace 限定（如 `resources.namespaces` 或 `namespaceSelector`）。只有平台基线、或由平台集中管理的跨 namespace 策略才使用 `ClusterPolicy`。具体转换方法与 RBAC 边界见 [§5](#s5)。

本章**大多数** admission 类策略用 `kubectl create --dry-run=server -f probe.yaml` 探针验证——完整的 webhook 评估、零副作用（[§3.4](#s3-4)）。**两个例外是 [§4.2.1](#s4-2-1) 和 [§4.2.3](#s4-2-3)**：它们判定的是 Tekton 控制器创建的子 TaskRun，还要沿 ownerReference 回看一个**已经持久化**的父运行——dry-run 的 PipelineRun 既不持久化也不产生子对象，所以**唯一的办法是真正跑一条流水线**（[§3.4.1](#s3-4-1) 有解释）。策略与探针都在**目标集群**（运行 Kyverno 和 Tekton 的那个集群）上执行；见 [§3](#s3) 开头的说明。

### 4.0 开始之前：装哪些策略、按什么顺序 {#s4-0}

本章策略见下方总览表（`pod-image-registry-allowlist` 附带两份可互换的 YAML，在表中占相邻两行）。**不要从头到尾顺序安装。** 下面给出"最小可用集"及其安装顺序；其余按需取用。

#### 4.0.1 最小可用集及其安装顺序 {#s4-0-1}

| 阶段 | 装什么 | 前置条件 | 拦什么 | 建议模式 |
|---|---|---|---|---|
| 0 | 不装任何东西（仅验证与夹具） | [§3.1](#s3-1) 检查清单第 1 项（Kyverno 四个控制器全部 Ready）是必须的；第 2 项——**按你实际要用的 resolver 验证**：[§4.1.1](#s4-1-1) 的三条通道分别依赖 cluster / hub / git resolver 开关，只启用你需要的那个。要跑演示，还需构建 [§3.3](#s3-3) 的夹具 | — | — |
| 1 | `pipeline-template-allowlist`（[§4.1.1](#s4-1-1)） | 决定三条通道取哪条（集群内模板 / 不可变远程引用 / 默认拒绝可变引用）；远程引用需先敲定 `<approved-git-repo>` 与 `<catalog>` | 绕开受治理模板、自行拼装流水线 | 先在 Audit 观察一轮，再切 Enforce |
| 2 | `pipeline-entry-lockdown`（[§4.5.4](#s4-5-4)） | `<platform-admin-identity>`（逐一枚举；不用通配符） | 绕开 PipelineRun、直接创建裸 `TaskRun` / `CustomRun`，从而跳过上一条策略 | Enforce（没有这条，策略 1 可被绕过） |
| 3 | 按你的流水线来源二选一（也可并存）：官方 java / python 0.3 模板 → `trivy-gate-must-stay-on`（[§4.2.5](#s4-2-5) 最小版本，PipelineRun 级——**改完作用域即可安装；身份判据无需修改**）；自建模板 → 把 `gate-param-contract`（[§4.2.1](#s4-2-1)，TaskRun 级）当作**模板来改写** | `trivy-gate-must-stay-on` 可直接使用；`gate-param-contract` **不是现成实现**——其前置条件钉死了演示的 `gated-build` / `policy-demo-scanner`，只有换成你真实的父 Pipeline 身份、Task 身份和参数契约后才会生效 | 门禁参数被关闭（`trivy-gate-must-stay-on` 还拦截显式跳过开关 `skipTrivyScan`，以及两条 `podTemplate.env` 注入路径：按任务的 `taskRunSpecs[].podTemplate` / `serviceAccountName`，和按运行的 `taskRunTemplate.podTemplate.env`——环境变量会进入 step 容器，能在所有参数看起来正常的情况下改变扫描行为）。**但它拦不住任意的 `when` / matrix 跳过**——被跳过的门禁根本不产生 TaskRun，admission 什么也看不到，只有 [§4.1.5](#s4-1-5) 的 `skippedTasks` 事后 Audit 能发现 | Enforce；**必须与模板版本同步上线**（见 [§4.2.5](#s4-2-5) 的升级顺序警告） |
| 4 | `scan-verdict-audit` / `vuln-summary-audit`（[§4.4.1](#s4-4-1)）、`inventory-ungated-runs`（[§4.4.4](#s4-4-4)） | 各 Task 的 result 契约（[§3.2](#s3-2) 版本矩阵）。**三者就绪程度不同**：`vuln-summary-audit` 钉的是 hub `trivy-scanner` 0.6，与官方模板一致——改完作用域即可用；`scan-verdict-audit` 钉的是演示的 `policy-demo-scanner`，**必须先按 [§4.4.1](#s4-4-1) 为 hub `sonarqube-scanner` 0.7 改写**之后才能审计官方模板 | 不拦任何东西；把结果记入 PolicyReport：漏洞聚合与总体状态（可直接用）、扫描裁决（改写后可用），以及**缺少平台标记的存量运行**——注意最后这一项**并不能证明门禁跑过**（该标签流水线用户自己也能写；[§4.4.4](#s4-4-4) 有专门说明） | 前两条**必须保持 Audit**——它们读 `*/status`，Enforce 会卡死流水线（[§4.4.3](#s4-4-3)、[§6.1.4](#s6-1-4)）。`inventory-ungated-runs` 匹配的是 PipelineRun 主资源：**先 Audit 盘点；存量整改完成后，按 [§4.4.4](#s4-4-4) 评估是否切 Enforce** |
| 5 | `pod-image-registry-allowlist`（[§4.5.3](#s4-5-3)） | 三个值：`<approved-registry-regex>`、`<tekton-infra-image-regex>`（都用 [§4.5.3](#s4-5-3) 的方法生成）、`<tekton-managed-by-label-value>`（从 `config-defaults` 读取；用于圈定 Tekton 的 Pod）。**然后二选一**：正则写进策略体，或——[§4.5.3](#s4-5-3) 的跨环境形态——先创建 `pipeline-image-allowlist` ConfigMap（策略经 `context.configMap` 读取它，**ConfigMap 缺失时 fail-closed**，所以必须先创建并纳入变更管控） | 把实际执行的镜像换成**批准仓库之外**的镜像（覆盖 Tekton Pod 的全部三类容器——**steps / init / 临时调试容器**——以及三条进入路径：CREATE、修改镜像的普通 UPDATE、`ephemeralcontainers` 子资源注入）。**注意这是"前缀允许列表"，不是"镜像身份允许列表"**：换成批准仓库**之内**的另一个镜像、或内容被替换的可变 tag，都不会被拦——要达到这种强度就钉 digest 或加 `verifyImages`（[§4.5.3](#s4-5-3)） | **务必先 Audit**：该策略作用在 Pod 层，正则漏掉任何一类基础设施镜像都会让整个 Tekton 起不来 |

**最小集中有四条策略需要的不止是占位符替换**：三条把身份钉在演示夹具上（`pipeline-template-allowlist`、`gate-param-contract`、`scan-verdict-audit`——`tekton-templates` / `gated-build` / `policy-demo-scanner`；安装前替换为你真实的模板 namespace、模板名和 Task 名），第四条 `pipeline-entry-lockdown` 必须补全你环境中每个合法的自动化创建者身份（[§4.5.4](#s4-5-4)）。**原样照抄会朝两个相反方向失败**：允许列表类会**拒绝你全部**真实流水线，而 Audit 类会**静默地什么也不做**。逐策略的标注见 [§4.0.2](#s4-0-2) 的"照抄可用？"列。

**阶段 5 完成后即得到最小可用集**——但它给出的是**有条件的保证**；不要读成"流水线再也绕不过去了"：

- PipelineRun 所引用的**定义身份**受允许列表约束——但集群内模板的**内容与修改权限**仍要靠 [§4.1.2](#s4-1-2) 的 RBAC 关死（策略只管"引用了哪个模板"，不管"谁改过那个模板"）；
- **裸 TaskRun / CustomRun** 入口受策略约束——但持有工作负载 API 权限的身份仍可直接创建 Pod / Job / Deployment，或把部署凭证用在别处。**"流水线绕不过去"是 RBAC + 策略的共同结果**（[§4.5.4](#s4-5-4)）；
- 门禁参数保证覆盖什么，**取决于你在阶段 3 选了哪条策略**：选 `trivy-gate-must-stay-on` → **官方 0.3 模板**的门禁参数关不掉、不能经 `skipTrivyScan` 跳过、也不能经 `podTemplate.env`（按任务或按运行）从侧面改变扫描行为；选 `gate-param-contract` → 只覆盖**你已改写成真实档位并锁定身份**的自建门禁——原样照抄它只匹配演示夹具。两者都不覆盖"门禁经 `when` / matrix 被整体跳过"——那属于 [§4.1.5](#s4-1-5) 的事后 Audit，在最小集的硬拦截之外；
- step 容器的**运行时镜像**被限制在批准的仓库前缀内——**但这不等于"扫描器换不掉"**：同仓库内换镜像、或内容被替换的可变 tag，都在该策略之外（[§4.5.3](#s4-5-3) 建议钉 digest / 加 `verifyImages`）。
- 结果**部分可观测**（Audit；不拦截）：**漏洞**侧开箱即用（`vuln-summary-audit` 与官方模板身份一致）；**Sonar 裁决**侧需先把 `scan-verdict-audit` 改写为真实扫描器身份——否则它只审计演示夹具，PolicyReport 里不会有任何一条记录；而"缺少平台标记"的盘点**不等于**"门禁没跑"。

**明确不在最小集内**（按需追加；各有额外前置条件）：

- [§4.1.4](#s4-1-4) / [§4.1.5](#s4-1-5) 的事后内省与"门禁必须执行"审计——纵深防御，Audit 类；
- [§4.2.4](#s4-2-4) 受保护分支门禁、[§4.5.1](#s4-5-1) 制品搬运来源、[§4.5.5](#s4-5-5) 发布目标、[§4.5.2](#s4-5-2) 源镜像属性——**场景档位**，只在你确实使用那些模板 / Task 时安装；
- [§4.2.5](#s4-2-5) 的**完整档位**——最小版本只保证"门禁没被关掉"；完整档位再加上"配置入口与构建输入受控"，条目很多，且与模板版本强耦合；按 [§4.2.5](#s4-2-5) 的分组表按需取用；
- [§4.4.2](#s4-4-2) 的字符串形态 result 兼容判据——**兼容层**，只服务契约无法更改的存量 Task，其支持面已冻结（见该节）；
- [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6](#s4-6) 的**取消类**策略——响应动作，不是 admission 拦截；其中 [§4.2.2](#s4-2-2) 和 [§4.6](#s4-6) 是 mutate-existing，需要额外 RBAC（[§4.6](#s4-6) 引言），而 [§4.2.3](#s4-2-3) 是 admission mutate，**不需要**额外 RBAC；
- [§5.3](#s5-3) 的 PolicyException——需先按 [§3.1.1](#s3-1-1) 启用两个开关并指定 `<trusted-namespace>`。

**三条硬性顺序约束**：

1. **先 Audit 后 Enforce**（[§3.5](#s3-5)）：每条 Enforce 上线前，先用同样的规则跑 Audit，检查 PolicyReport 里是否存在会被拦截的存量运行。
2. **允许列表与参数类策略必须成对安装；单装任何一个都作废**：`pipeline-template-allowlist` 之外的多数判据把身份（模板 namespace / Pipeline / Task 名）钉进了前置条件，而在 Kyverno 里**身份不匹配不是拒绝——是跳过（放行）**。所以只装参数类策略、不装允许列表时，想绕过的人根本不用碰门禁参数——提交一个自写 `pipelineSpec` 的运行（或引用一个不受治理的模板）：身份匹配不上任何参数策略 → 全部跳过 → 直接通过，扫描步骤甚至不需要存在。两层各管一半：允许列表把每次运行都逼上受治理模板这条路，参数策略锁死这条路上的门禁开关；只装允许列表 → 模板绕不过但门禁参数可以被关掉；只装参数策略 → 给不受治理的模板留了一扇后门。
3. **保持策略与模板版本同步——并区分两个后果相反的失配方向**：
   - 模板**改了版本号**而策略仍钉着旧 `refVersion`：身份前置条件不再匹配，规则直接**跳过（放行）**——它**悄悄停止生效**。唯一能兜住这种情况的是约束 2：`pipeline-template-allowlist` 只放行批准的版本，所以新版本在允许列表层被拦下，而不是被参数策略自己发现。
   - 模板**在身份不变的情况下，改了本策略所判定的那些参数**——这里有两个**方向相反**的后果；不要当成一回事：
     - **参数被改名或删除**（旧字段整个消失）：方向**取决于该判据如何处理"缺席"**，同一个小节内两种都存在，必须逐字段核对——
       - 判据把"缺席"当作"继承 Task 的可信默认值"（门禁**开关**类，可通过那对 `<switch>Present` 变量识别：[§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)，以及 [§4.2.5](#s4-2-5) 的开关部分）→ 旧判据既不报错也不拒绝；它**悄悄地 fail-open**：策略保持 `Ready`，报告保持干净，再没有人盯着那个被改名的开关。**这是最难被发现的一类**——只有 [§3.8](#s3-8) 的升级回归集能主动抓到它。
       - 判据要求"必须存在且非空"（[§4.2.5](#s4-2-5) 里的 `sonarURL`、`images` 之类，以及 [§4.5.1](#s4-5-1) 的 `noVisibleSource` 兜底）→ 字段一消失就命中拒绝条件——**fail-closed**，升级后当场炸在你面前。
     - **参数还在但形态变了**（类型改了，或值语义变了，导致旧判据读到的值不再满足其形态）：多数情况下判据会开始**拒绝所有合规请求**（fail-closed）——症状是升级后每条流水线都卡在 admission，拒绝消息来自你自己的策略。**但这不是必然**——凡是本文对"参数以数组 / 对象传入"做过归一化加固的地方（[§4.2.4](#s4-2-4) 探针 34），形态变化会变成跳过而不是拒绝，重新落回 fail-open；该节的 `sonarProperties` 侧是例外——其规范形态门禁会直接拒绝类型回退（探针 26-27）。

     **仅仅新增与本策略无关的参数不会触发任何一种后果**——足够窄的判据在这里是优势。**判别方法有且只有一个**：打开判据，看"读不到字段 / 读到奇怪的值"落在哪里——落在 deny 上，还是落在前置条件跳过上。升级顺序与排障见 [§4.2.5](#s4-2-5) 的升级顺序警告。

#### 4.0.2 本章策略速查（按名字找小节） {#s4-0-2}

被拦时，报错消息会给你**策略名**；下表把名字映射回它出自哪一节、治理什么、以什么模式安装。`min` 列标 ✅ 的行即上文的最小可用集。**计数口径**：表中共有 **8 个 ✅**，但那是**跨 5 个安装阶段（1–5；阶段 0 不装任何东西）的候选**——阶段 3 是二选一，所以**一次安装通常是 7 条策略**；只有官方与自建模板**并存**且都需要时才是 8 条。（阶段 4 的三条 Audit 策略一次装齐。）

表中每行一个策略名。`pod-image-registry-allowlist` 附带两份可互换的 YAML，所以**紧挨它下面的那一行**描述的是同名的替代形态——不是另一条策略。

**先说一件对每条策略都成立的事**：本章每条策略都限定在演示 namespace `policy-poc`（[§4](#s4) 引言已注明这是演示选择；两条门禁策略的 `namespaces` 列表里还额外带着演示豁免 namespace `policy-exempt-runs`——见 [§4.0.7](#s4-0-7) 第 1 步的警告）。所以**无论某行标的是 ✅ 还是 🔧，复制到生产前都必须改作用域**——改成你实际治理的 namespace，或按 [§5](#s5) 转成 namespace 级的 `Policy`。下面这一列回答的是另一个问题：**除了作用域和占位符之外，策略内部的身份判据是否也需要改？**

21 条中有 **11 条需要的不止是占位符替换**：10 条把身份钉在演示夹具上（`gated-build` / `policy-demo-scanner` / `policy-demo-trivy-summary` / `tekton-templates` / 演示任务别名 `scan` 等）——复制进你的环境后它们**不会报错，但也不会按你预期的方式行事**，且两个失败方向相反：

- **允许列表 / 契约类**（如 `pipeline-template-allowlist`）：批准列表里写的还是演示模板 → 你的真实流水线**全部被拒绝**（fail-closed——响亮，不沉默）；
- **Audit / 取消类**（如 `scan-verdict-audit`、[§4.6](#s4-6) 的两条）：身份不匹配 → **跳过，什么也不发生**（静默失效；PolicyReport 里一条记录都没有）。

`pipeline-entry-lockdown` 是第三种情况：它不钉任何演示对象，但**必须枚举你环境中每个合法的自动化创建者身份**——漏一个就等于拒绝了那套自动化的全部流水线。

所以标 🔧 的行需要身份改写或身份列表补全；标 ✅ 的只需按 [§4.0.3](#s4-0-3) 替换占位符（作用域仍要改——见上一段）。**这两件事，加上安装后的验收检查，共同构成 [§4.0.7](#s4-0-7) 的五步转换——把本章任何策略复制到生产之前，先过一遍那一节。**

| 策略名 | 小节 | 治理什么 | 模式 | min | 照抄可用？ |
|---|---|---|---|---|---|
| `pipeline-template-allowlist` | [§4.1.1](#s4-1-1) | PipelineRun 只能引用受治理的流水线定义（三条通道） | Enforce | ✅ | 🔧 演示身份：`tekton-templates` + 批准模板名列表 |
| `pipeline-resolved-definition-audit` | [§4.1.4](#s4-1-4) | 对允许列表已放行的模板，**解析出的内容是否被破坏**（如门禁任务被换成另一来源的同名任务） | Audit | | 🔧 演示身份：模板 namespace / 模板名 / Task 名 |
| `pipeline-gate-must-execute-audit` | [§4.1.5](#s4-1-5) | 门禁 Task 是否经 `when` 被跳过（`skippedTasks`） | Audit | | 🔧 演示身份：父 Pipeline 与门禁任务名 |
| `gate-param-contract` | [§4.2.1](#s4-2-1) | 门禁 Task 的生效参数（TaskRun 级）；以**演示档位**发布——用于自建模板时需改写身份 | Enforce | ✅ | 🔧 演示身份：`gated-build` + `policy-demo-scanner` |
| `gate-param-cancel-existing` | [§4.2.2](#s4-2-2) | 参数不合规时取消父运行而不是拒绝创建（让 finally 得以执行） | mutate-existing | | 🔧 演示身份：两个演示模板 + 演示 Task |
| `gate-param-mutate-to-cancel` | [§4.2.3](#s4-2-3) | 参数不合规时同步取消门禁 TaskRun 本身 | mutate | | 🔧 演示身份：`policy-demo-scanner` |
| `sonar-branch-analysis-branch-contract` | [§4.2.4](#s4-2-4) | 受保护分支（`main` / `release-*`，含分支参数缺席的默认分支形态）的分析不得显式关闭门禁或更改扫描源，且输入必须是规范形态（契约之外的一律拒绝）；PR / feature 构建放行（真实 sonarqube-scanner 档位；3 条 Enforce 规则 + 1 条可选 Audit） | Enforce + Audit | | ✅ 仅占位符 |
| `trivy-gate-must-stay-on` | [§4.2.5](#s4-2-5) 最小版本 | 官方 0.3 模板的漏洞门禁不得被显式关闭：四条参数旁路（`skipTrivyScan`、`trivyExitCode` 置空 / `"0"`、severity 收窄、`trivyExtraArgs` 非空）+ 两条 `podTemplate.env` 注入路径（按任务 `taskRunSpecs`、按运行 `taskRunTemplate`），PipelineRun 级；**不拦任意 `when` / matrix 跳过**，也**不限制 `images` 的元素个数**（模板会构建并推送每个元素却只扫 `images[0]`，多镜像时其余不被扫描——那条判据在完整档位里） | Enforce | ✅ | ✅ 仅占位符 |
| `official-template-gates-on` | [§4.2.5](#s4-2-5) 完整档位 | 上一行 + 配置入口与构建输入的允许列表（按组取用） | Enforce | | ✅ 仅占位符 |
| `pipeline-run-defaults` | [§4.2.6](#s4-2-6) | 注入默认值（超时、标签） | mutate | | ✅ 仅占位符 |
| `scan-verdict-audit` | [§4.4.1](#s4-4-1) sonar 形态 | 不达标的扫描裁决记入 PolicyReport | Audit | ✅ | 🔧 演示身份：`policy-demo-scanner` |
| `vuln-summary-audit` | [§4.4.1](#s4-4-1) trivy 形态 | 不达标的漏洞聚合与总体状态记入 PolicyReport | Audit | ✅ | ✅ 仅占位符 |
| `vuln-threshold-audit` | [§4.4.2](#s4-4-2) | **字符串形态** result 内的漏洞数超阈值时记一笔（演示切分范式——兼容措施，不是推荐形态） | Audit | | 🔧 演示身份：无 resolver 的 `taskRef.name` = `policy-demo-trivy-summary` |
| `inventory-ungated-runs` | [§4.4.4](#s4-4-4) | 盘点：哪些 PipelineRun 缺少平台标记（**并不能证明门禁跑过**，[§4.4.4](#s4-4-4)） | Audit（background） | ✅ | ✅ 仅占位符 |
| `artifact-source-allowlist` | [§4.5.1](#s4-5-1) | 制品搬运来源的允许列表（真实 skopeo-copy 档位） | Enforce | | ✅ 仅占位符 |
| `promotion-source-image-labels` | [§4.5.2](#s4-5-2) | 读取源镜像 config 并校验其属性 | Enforce | | ✅ 仅占位符 |
| `pod-image-registry-allowlist` | [§4.5.3](#s4-5-3) | Tekton Pod 实际运行镜像的**前缀**允许列表，覆盖全部三类——steps / init / 临时容器（Pod 级硬拦截）；**拦不住批准前缀内的镜像替换或可变 tag 的内容替换** | Enforce | ✅ | ✅ 仅占位符 |
| （上一行的同名替代形态——**不是另一条策略**） | [§4.5.3](#s4-5-3) | `pod-image-registry-allowlist` 附带**两份可互换的完整 YAML**：正则写进策略体，或正则集中在 `pipeline-image-allowlist` **ConfigMap** 里（该节称之为"形态 A"；可跨环境移植）。另有两个**放宽的正则变体**（形态 B / C——只是正则片段加强度对比，不是独立策略） | Enforce | | 同上一行 |
| `pipeline-entry-lockdown` | [§4.5.4](#s4-5-4) | 关死裸 `TaskRun` / `CustomRun` 入口（契约 7） | Enforce | ✅ | 🔧 除替换 `<platform-admin-identity>` 外，还必须**补全你环境中的合法自动化创建者列表**（triggers / GitOps 控制器等，[§4.5.4](#s4-5-4) 结尾）——漏一个就等于拒绝它的全部流水线 |
| `release-target-allowlist` | [§4.5.5](#s4-5-5) | hub 来源身份（**无论是否启用部署都会校验**）+ 启用部署时：目标 namespace、kubeconfig 来源、shell 安全的参数与容器名（`workloadContainers`），以及执行面覆盖（任何对部署任务的 `taskRunSpecs` 覆盖和任何运行级 `podTemplate.env` 一律拒绝；运行级 `serviceAccountName` 按批准列表）。**以上全部约束的是"请求怎么说"**：manifest 自身的 `metadata.namespace`、集群级资源、kubeconfig Secret 的**内容**、以及"该更新哪个容器"这类业务语义都在其外——见 [§4.5.5](#s4-5-5) 的边界说明。身份**同时**覆盖 java **与** python 0.3 模板 | Enforce | | ✅ 仅占位符（**五处**；SA 与 namespace 条目是有多少列多少的列表，且 SA 列表必须包含 Tekton 默认填入的那个） |
| `cancel-on-failed-verdict` | [§4.6.1](#s4-6-1) | 结果不达标时取消运行中的流水线 | mutate-existing | | 🔧 演示身份：模板 namespace |
| `cancel-run-without-gate` | [§4.6.2](#s4-6-2) | 定义漂移时自我取消 | mutate-existing | | 🔧 演示身份：演示模板与门禁任务名 |

[§5](#s5) 还有三条与作用域 / 豁免相关的策略：`pipeline-baseline` 与 `project-alpha-tightening`（[§5.2](#s5-2) 两级治理），以及 `exempt-namespace-approver-only`（[§5.3](#s5-3) PolicyException 的 RBAC 闭环）。

#### 4.0.3 占位符对照表（复制策略前逐一替换） {#s4-0-3}

本章的策略资产中有一类**环境配置值**：它们决定策略实际匹配什么，漏替换或替换错**不会报任何错**——策略会转而朝两个相反方向之一失败：

- **fail-open（多数）**：策略装上了、看着没问题、什么也不拦（如允许列表前缀写的是别人家的仓库）；
- **fail-closed**：所有**合规**请求被拒绝（如批准的 Sonar URL 或部署目标 namespace 还是样例值，真实参数永远不会等于它）。

标 ⚠️ 的行是**失败方向异常或后果最重**的那些；方向以各行自己的说明为准：多数 ⚠️ 行是 fail-closed，但 `catalog` 字面量行按策略类型**两个方向都有**，而 Tekton 控制器身份行是**纯 fail-open**（跳过——静默放行）。不要把 ⚠️ 读成"⚠️ = 误拒，至少能被发现"。

下表穷举这一类值，每条都给出取值方法与自检方法。**注意有三行不是尖括号形态**（hub catalog 名 `catalog`、Tekton 控制器身份、以及那批 `approved-*` 对象名）：它们以裸字面量写在策略里，搜尖括号找不到——但同样必须核实并替换（`catalog` 那行还有 11 处参数键出现位置**不能**替换；见该行说明）。

⚠️ **有两个占位符你搜索时可能一处都找不到——这不代表它们不需要填**：`<approved-registry-regex>` 与 `<tekton-infra-image-regex>` 只出现在 [§4.5.3](#s4-5-3) 的**内联策略体形态**里；如果你选了该节的 **ConfigMap 形态**，策略里只剩一个占位符 `<tekton-managed-by-label-value>`，两个正则改为落进 `pipeline-image-allowlist` ConfigMap 的 `data.approvedRegistryRegex` 与 `data.tektonInfraRepoRegex`——**值仍然必须按下面两行的方法生成并自检**；变的只是落点从策略移进 ConfigMap（[§4.0.1](#s4-0-1) 阶段 5 的"三个值"在两种形态下都成立）。**把"策略里没搜到"当成"没什么可填" = 一个空的或过宽的允许列表，而且不会报任何错。**

⚠️ **替换动作是"在整份策略文本里搜索该占位符并替换每一处"，不是"改掉眼前那一处"**。本文的策略资产刻意把每个占位符收敛到**单一位置**（[§4.5.3](#s4-5-3) 把正则提进一个 `variable`，判据和消息都引用它，正是为此）——但你一旦自行扩展判据，就很容易复制出第二处，而**两处不一致不会报任何错**；只会让裁决和消息各说各话（[§4.5.3](#s4-5-3) 记录了两个方向）。替换完再搜一次 `<` 确认没有漏网——**策略 YAML 注释里的示例尖括号除外**（如 [§4.5.5](#s4-5-5) 策略注释中的 `<kind>` / `<name>`：它们在注释里，不参与评估，留着无害）。

**命令行里漏掉的占位符与 YAML 里漏掉的症状完全不同**：本文的命令也带 `<...>`（如 `--as=<probe-identity>`、`-n <your-pipeline-namespace>`），而 shell 把 `<` 和 `>` 当作重定向操作符——占位符未替换时命令**根本不会执行**，只报一条 `No such file or directory`（`kubectl -n <your-ns> get pods` 报 `your-ns: No such file or directory`）。看到这一行不要去查集群——它在告诉你你留了个占位符没换。**唯一的例外**：当占位符名恰好与当前目录下某个文件重名时，重定向会成功，命令**静默执行**且输出被写进那个文件——所以照着本文的命令操作时，工作目录里不要放与占位符同名的文件。

对 **Enforce validate 策略**，装后自检永远是两步：先用 `--dry-run=server` 跑一个真正合规的请求确认被**放行**（抓 fail-closed），再故意改坏一个字段确认被**拒绝**（抓 fail-open）。只做第二步永远发现不了漏替换。

:::warning 两步自检不适用于一类策略：带身份前置条件的策略

上面两步对 **PipelineRun 级**策略直接可用。但对任何把 `request.userInfo` 或"由控制器创建"作为前置条件的策略——[§4.2.1](#s4-2-1) 的 `gate-param-contract`（要求创建者是 Tekton 控制器 SA + 对父运行做 owner 查询）、[§4.5.4](#s4-5-4) 的 `pipeline-entry-lockdown`、[§5.3](#s5-3) 的 PolicyException RBAC 闭环——**你手工提交的对象不会命中它们的前置条件**：你的身份既不是控制器也不是被批准者，规则**跳过、请求被放行**。看起来"第一步通过了"，实际上**什么也没验证**（这是经典的假通过）。

两种正确做法；任选其一：

1. **带身份提交**：`kubectl create --dry-run=server --as=<that-identity> -f <object>.yaml`。同一个 TaskRun、同一条策略：以你自己的身份提交 → **放行**（规则没触发）；以 `--as=system:serviceaccount:tekton-pipelines:tekton-pipelines-controller` 提交 → **拒绝，且消息里打印 `creator=…tekton-pipelines-controller`**。这需要 impersonate 权限（`kubectl auth can-i impersonate serviceaccounts`），且对 [§4.2.1](#s4-2-1) 这类策略而言**父运行必须真实存在**——策略用 `context.apiCall` 沿 ownerReference 查询它并核对其 UID。
2. **跑一条真实流水线当 E2E**：观察子 TaskRun 是否在 admission 被拒、父运行是否进入 `CreateRunFailed`、finally 是否执行（[§4.2.1](#s4-2-1) 的"治理不了什么"部分解释了三者的关系）。

同理，`<platform-admin-identity>` / `<approver-identity>` 占位符的自检必须用 `--as`——否则你只验证了"普通身份被拒绝"，没有验证"被批准的身份能通过"。

:::

还有两类策略跳过"确认被拒绝"这一步；它们的自检对象不同：**Audit 策略**（包括读 `*/status` 的）照常确认请求被**放行**，然后到 PolicyReport 查记录下来的违规；**mutate / mutate-existing 策略**则检查被 patch 后的对象或被触发的响应动作（如运行是否真的进入了 `Cancelled`）。

| 占位符 | 是什么 | 取值方法 | 自检方法 |
|---|---|---|---|
| `<registry>` | 夹具拉取 busybox 所用的镜像仓库前缀 | 用 [§3.3](#s3-3) 的两条命令把平台自身正在拉取的前缀读出来作为候选（控制器镜像 / 该 namespace 全部镜像前缀去重），再确认该前缀从 `policy-poc` 也能拉取且带有 `busybox`；生产应钉 digest（[§3.3](#s3-3)） | 夹具 Pod 正常启动。起不来时先 `describe pod` 查 `ImagePullBackOff`——那是前缀或拉取凭证问题，不是策略问题 |
| `<approved-git-repo>` | 批准的流水线定义 git 仓库 URL | 取 git resolver 实际使用的 `url` 参数的**逐字字符串**（含协议与 `.git` 后缀差异）；用 `==` 精确比较，不做前缀匹配 | 用真实 PipelineRun 做 dry-run 确认放行；URL 改动一个字符就应被拒绝 |
| `<approved-registry>` | 批准的制品仓库前缀（[§4.5.1](#s4-5-1)） | 仓库主机（可带端口）+ 项目路径前缀。这一个是 `starts_with` 的**字符串**比较，**不是正则**——不要填正则片段 | 批准前缀下的 `srcImage` 被放行；换成 `docker.io/...` 被拒绝 |
| `<approved-registry-regex>` | 批准的业务仓库前缀，**正则片段**形态（[§4.5.3](#s4-5-3)） | 取 `<approved-registry>` 的主机部分，按 [§4.5.3](#s4-5-3) 的规则逐字符转义 RE2 元字符（`.` → `[.]` 等） | 跑 [§4.5.3](#s4-5-3) 的 9 个自检探针；"相邻主机 / 相邻端口 / 未转义 `.`"三个探针必须被**拒绝** |
| `<tekton-infra-image-regex>` | Tekton 五类基础设施镜像的**完整仓库**正则片段（[§4.5.3](#s4-5-3)） | [§4.5.3](#s4-5-3) 的命令 A（控制器启动参数）给出**完整候选清单**；命令 A2 把地址前缀替换为**平台私有仓库地址**（从 `kube-public` 的 `global-info` ConfigMap 读 `registryAddress`）——admission 看到的是平台镜像重写**之后**的地址，重写前的形态不属于允许列表；命令 B（抽样真实 Pod）**只做交叉验证**，绝不作为清单来源（抽样只能看到恰好运行过的类别，可能为空）。把 tag / digest 剥到仓库层，再逐字符转义。**即使命令 A 也只是起点，不是"清单完整"的证明**：启动参数并不包含所有辅助镜像（GC / results / affinity assistant / 未来版本）。所以除命令 B 外，再用一份**装机态盘点**——operator 的 `TektonConfig` / `TektonPipeline` CR 加上 `tekton-pipelines` namespace 里每个 Deployment 的镜像字段——作为第二道交叉验证：任一道发现命令 A 输出之外的仓库时，先确认它是否属于新类别；确认后加入清单并同样过一遍 A2 前缀替换（生成来源永远是经 A2 替换后的 A 清单，与 [§4.5.3](#s4-5-3) 正文措辞一致） | 五类镜像全部放行；同主机的 `…-evil` 被拒绝。**且必须先在 Audit 跑满一个完整周期**（含一次升级和一次 GC），确认 PolicyReport 没有基础设施镜像违规后再切 Enforce——漏一类就会让整个 Tekton 起不来 |
| `<project-path>` | 放宽形态 B 钉住的项目路径段（[§4.5.3](#s4-5-3)） | 从上面同一份仓库清单中截取主机与镜像名之间的那一段 | 逐行复核形态 B 的对比表；注意该形态**不锁主机**，弱于形态 A |
| `<tekton-managed-by-label-value>` | 圈定 Tekton Pod 的标签值 | 从 `tekton-pipelines/config-defaults` 读 `default-managed-by-label-value`；只有**键缺失**才回退到默认值 `tekton-pipelines`——键存在但值为空是部署阻断项，必须先改成非空值 | 用该标签实际选取一次真实的 Tekton Pod；只有能选出来才算正确 |
| `<platform-admin-identity>` | 允许绕过入口封锁的平台管理员身份（[§4.5.4](#s4-5-4)） | 写成完整的 `system:serviceaccount:<ns>:<sa>` 字符串或用户名，取自你的平台运维账号，**逐一枚举——不用通配符**。**还必须枚举环境中每个合法的自动化创建者**，且"补全"要靠方法、不靠记忆：① **RBAC 反查**——遍历 `RoleBinding` / `ClusterRoleBinding`，找绑定到带有 `taskruns` / `pipelineruns` 上 `create` 权限的角色的 subject（在 `kubectl get clusterrole,role -A -o json` 里过滤 `rules[].resources`，再查绑定）；② **trigger 与 GitOps 侧**——EventListener / TriggerTemplate 使用的 SA、ArgoCD / Flux 控制器 SA、平台自身调度组件的 SA；③ **先在 Audit 装一轮**，从 PolicyReport 和 API server 审计日志收集真实创建者，补全清单后再切 Enforce。三件事做完再 Enforce | 用该身份 `--dry-run=server --as=<identity>` 创建裸 TaskRun 应被放行；普通业务身份应被拒绝（**`--as` 是必须的**——见上文身份类自检说明） |
| `<approver-identity>` | 有权签发豁免的审批人身份（[§5.3](#s5-3)） | 取你豁免审批流程的实际负责人 / service account，同样写完整身份字符串 | 该身份能在受信 namespace 创建 PolicyException；其他身份被 RBAC 拒绝 |
| `<business-identity>` | 一个普通业务身份，用于验证"没有签发豁免权力"这一侧（[§5.3](#s5-3)） | 取一个真实的业务 ServiceAccount，完整身份字符串 | 该身份的 `kubectl auth can-i create policyexceptions` 应为 `no`；在 `policy-exempt-runs` 创建运行应在 admission 被拒绝 |
| `<catalog>` | hub 引用的 catalog 名（**路标行**：**尖括号形态只出现在 [§3.4](#s3-4) 的探针骨架与报错样例里**——在策略资产中它是裸字面量，见下一行；本行留在表里是因为你多半会去搜 `<catalog>`） | 从你实际引用的 hub 条目取：真实运行 `taskRef.params` / `pipelineRef.params` 中 `catalog` 参数的值 | 与真实运行的 `catalog` 参数值逐字一致 |
| `catalog` 字面量（出现在这些策略的可安装 YAML 中：`pipeline-template-allowlist` / `sonar-branch-analysis-branch-contract` / `trivy-gate-must-stay-on` / `official-template-gates-on` / `vuln-summary-audit` / `artifact-source-allowlist` / `release-target-allowlist`。**替换范围 = 可安装 YAML 的有效行**，注释除外；"关键判据"摘录与探针 / 夹具里的同名字面量在你复制那些块时同样替换） | 钉进策略身份判据的 hub catalog 名——**不是尖括号形态；搜 `<` 找不到**。**且本行是引言"全文搜索、逐处替换"纪律的唯一例外**：写成 `[?name=='catalog']` 的那些出现位置是 hub resolver 的**参数键**（由 Tekton API 固定，与你的 catalog 叫什么无关），**绝不能**替换——替换了它们，`refCatalog` 就永远求值为空字符串：允许列表类拒绝一切合规请求，身份前置类全部跳过 | 与上一行方法相同。ACP 内置 hub 的官方 catalog 通常就叫 `catalog`，所以内置 hub + 官方模板通常不用改——**但安装前逐字核实一次** | ⚠️ 钉错了两个方向都无声：对**身份前置类**（Audit / 门禁类，catalog 是身份链的一环）规则跳过——**静默放行**，PolicyReport 一条记录都没有；对**允许列表类**（[§4.1.1](#s4-1-1) hub 通道、[§4.5.1](#s4-5-1)）**所有合规请求被拒绝**。自检用本节开头的两步 dry-run（放行 + 改坏后拒绝）跑一次真实运行 |
| Tekton 控制器身份字面量（出现在这些策略中：[§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2) 的 `match.subjects`（`namespace: tekton-pipelines` + `name: tekton-pipelines-controller`）、[§4.5.4](#s4-5-4) 的全串比较 `creator=='system:serviceaccount:tekton-pipelines:tekton-pipelines-controller'`，以及 [§5.3](#s5-3) 的受信身份列表——后者还额外带 `tekton-chains-controller`） | 每个"由 Tekton 控制器创建"前置条件背后的身份钉——**同样不是尖括号形态**。在 Tekton 装在非默认 namespace（[§4.1.2](#s4-1-2) 提到的 `TektonConfig.spec.targetNamespace`）或 SA 名不同的环境里，这些身份**全部匹配不上** | 读真实值，不要手拼：用 [§5.3](#s5-3) "身份核实"段落的两条 `kubectl get deploy … -o jsonpath` 命令打印精确的身份字符串（控制器必读；Results watcher 仅在启用时读）；`TEKTON_NS` 的获取方法在 [§3.1](#s3-1) | ⚠️ 钉错 = 身份前置条件永不成立 → 规则**跳过、静默放行**：门禁 / 取消类策略等于没装，PolicyReport 不会有任何一条记录。自检必须包含一次带 `--as=<that-identity>` 的拒绝探针（见上文"身份前置"警告）——普通身份下的探针对这些规则永远是假通过 |
| `<approved-sonar-url>` | 批准的 Sonar 服务器 URL（[§4.2.5](#s4-2-5)） | 取你环境中真实的 `sonarURL` 参数值，**逐字字符串**（含协议、端口、尾斜杠差异），用 `!=` 精确比较 | ⚠️ **这里漏替换的表现与上面各行相反**：不是"什么都拦不住"，而是**所有合规请求被拒绝**——`sonarURL` 永远不会等于样例值。装完先用 `--dry-run=server` 跑一个真正合规的 PipelineRun 确认放行 |
| `<approved-maven-mirror-url>` | 批准的 Maven 镜像仓库 URL（[§4.2.5](#s4-2-5)，仅 java 模板） | 取你环境中真实的 `mavenMirrorURL` 参数值，逐字字符串 | ⚠️ 方向同上，但**只波及显式传入非空值的请求**：判据是 `mavenMirrorURLPresent && mavenMirrorURL != '' && != placeholder`，不传 / 传空串仍放行（模板默认 `""`）。**每个显式配置了镜像的合规请求都会被拒绝** |
| `<approved-maven-cert-path>` | 批准的 Maven 证书文件名（[§4.2.5](#s4-2-5)，仅 java 模板） | 取你环境中真实的 `mavenCertPath` 参数值（样例是 `ca.cert`） | ⚠️ 同上，**只波及显式传该参数的请求**：判据是 `mavenCertPathPresent && != placeholder`；缺席时继承模板默认值 `ca.cert`，仍放行 |
| `<approved-deploy-namespace-a>` / `<approved-deploy-namespace-b>` | 允许部署进入的目标 namespace（[§4.5.5](#s4-5-5)） | 枚举你批准的每个部署目标 namespace——样例给了两个；在 `contains([...])` 里有多少列多少 | ⚠️ 方向同上，**只波及启用部署的请求**（判据挂在 `deploymentEnabled` 之下；不启用部署的请求仍放行）：**每个真正发布的合规请求都会被拒绝**。装完先用 `--dry-run=server` 跑一个真实部署 PipelineRun 确认放行，再把 namespace 改成列表外的值确认拒绝 |
| `<approved-deploy-kubeconfig-secret>` | 允许作为 `kubeconfig` workspace 来源的 Secret 名（[§4.5.5](#s4-5-5)） | 取你环境中真实的部署凭证 Secret 名。**该判据同样是单值 `!=`，只支持一个 Secret**；要批准多个，把它改写成 `contains([...], kubeconfigSecret)` 形式——不要用通配符 | ⚠️ 同上：**漏替换 = 每个显式绑定 kubeconfig 的合规请求都被拒绝**（不绑定 kubeconfig = 部署到当前集群，本来就放行，不受影响） |
| `<tekton-default-service-account>` | Tekton 默认化填入运行级 `spec.taskRunTemplate.serviceAccountName` 的 SA 名（[§4.5.5](#s4-5-5) 批准列表的第一项——**这一项不是可选的**：默认化 webhook 先于 Kyverno 运行，不把它列进去等于拒绝批准"普通请求"） | 不要从 `config-defaults` 猜（键缺失与显式空值含义不同——见 [§4.5.5](#s4-5-5) "生效值为空"一段）；改读默认化之后的**生效值**（用 [§3.3](#s3-3) 的夹具运行；`--dry-run=server` 无副作用；出厂状态打印 `default`）：`kubectl create --dry-run=server -n policy-poc -f demo-run-pass.yaml -o jsonpath='{.spec.taskRunTemplate.serviceAccountName}{"\n"}'`——它读的正是策略所比较的那个字段；打印出什么就填什么。⚠️ **输出为空必须处理**：那说明键存在但值为空、Tekton 跳过了填入——[§4.5.5](#s4-5-5) 的 `runWideSa != ''` 判据随之整体跳过（一个 fail-open）；机制与修复见该节"生效值为空"一段 | ⚠️ **漏掉 = 100% 启用部署的合规请求被拒绝**。自检就是那个放行探针：一次真实的发布运行必须被放行。**另外把生效值命令跑一次并确认输出非空**——输出为空 = 上一列所述的 fail-open |
| `<approved-deploy-service-account>` | 你自行批准的部署 ServiceAccount 名（[§4.5.5](#s4-5-5) 批准列表的其余各项） | 枚举你的发布流水线实际使用的 SA——判据是 `contains([...], runWideSa)`；有多少列多少。它必须与你授予部署凭证的 RBAC 一起维护：**新增部署 SA → 同一变更里把它加进本列表**，否则那条流水线会被拒绝 | ⚠️ 方向同上，**只波及启用部署且运行级 SA 不是上一行默认值的请求**；不部署的请求不受影响。自检：确认使用真实 SA 的发布运行被放行，再把 SA 改成列表外的名字确认拒绝 |
| `approved-*` **对象名**一批（[§4.2.5](#s4-2-5) 完整档位里有 12 个：`approved-sonar-credentials` / `approved-sonar-settings` / `approved-registry-config` / `approved-sonar-certificate` / `approved-trivy-config` / `approved-ca-bundle` / `approved-maven-settings` / `approved-maven-cert` / `approved-maven-server` / `approved-maven-local-repo` / `approved-maven-trust-store` / `approved-pip-conf`；[§4.5](#s4-5).x 各节用的是尖括号占位符，不在此批） | 以字面量直接写进策略的批准 Secret / ConfigMap 名——**不是尖括号形态，但同样必须改** | 替换为你环境中真正被批准的对象。**"哪个才是批准的那个"需要权威来源**——不要在 namespace 里按名字猜：取平台配置仓库 / GitOps manifest 里声明的那一份，或给批准对象打统一标签（如 `policy.alauda.io/approved=true`）并用 `kubectl get cm,secret -n <ns> -l policy.alauda.io/approved=true` 列出，再与配置负责人确认；列表变更（新增 / 轮换对象）必须走与策略变更相同的流程，否则策略会拒绝你刚轮换进去的对象。**注意判据是单值 `!=` 比较——每个 workspace 只允许恰好一个批准对象。**要允许多个来源必须改判据本身，写成 `count > `1` \|\| (count == `1` && !contains(['approved-a','approved-b'], name))`——只在这里多列几个名字没有任何作用。（此处的 `count` 是**请求中该 workspace 的绑定条数**，不是批准对象的个数；Tekton 保证 workspace 名不重复，所以通常是 0 或 1，`count > 1` 分支是与其他判据保持同形的纵深防御。） | ⚠️ 方向同上，**只波及显式绑定该 workspace 的请求**：判据形态是 `count > 1 \|\| (count == 1 && name != approved-value)`，**不绑定这个可选 workspace 的请求按缺席语义仍放行**。自检同法：先确认真正绑定这些对象的合规请求被放行，再换成未批准的对象确认拒绝 |
| `<trusted-namespace>` | 受信 namespace——Kyverno 唯一接受 PolicyException 的来源（[§3.1.1](#s3-1-1) / [§5.3](#s5-3)） | 由你指定并写入 `--exceptionNamespace`；它应是一个**只有豁免审批人可写**的专用 namespace——不要复用业务或演示 namespace | [§3.1](#s3-1) 检查清单第 5 项读回 `--exceptionNamespace=<that value>`；在其他任何 namespace 创建的 PolicyException 应不产生任何效果 |

文档中其余的尖括号都不属于这一类；不要到上表里找它们：

- **命令与报错样例里的对象名**——`<policy>`、`<fixture>`、`<producer>`、`<gate>`、`<kind>`、`<name>`、`<seq>`、`<yyyymmdd>` 之类，含义随其所在示例而定（如 [§4.4](#s4-4) 排障命令里的 `<policy>` 就是你正在检查的那条策略，PolicyException 样例里的 `<yyyymmdd>-<seq>` 只是建议的命名约定）；[§3.1.1](#s3-1-1) 命令里的 `<path-to-global-kubeconfig>`（global 集群 kubeconfig 路径）与 `<cluster-name>`（运行 Kyverno 的目标集群）、[§3](#s3) 开头的 `<target-context>`（目标集群的 kubectl context 名）、排障命令里的 `<your-pipeline-namespace>` / `<one-real-run>` / `<terminal-taskrun>` / `<measurement-copy-name>`、以及 [§3.4.1](#s3-4-1) 探针配方里的 `<probe-identity>`（提交该探针所用的身份）也属此类；`<configured-hub-endpoint>`（集群配置的 hub 服务地址）同样——它只出现在一条报错消息样例里，没有写进任何策略；要核实它，读 `tekton-pipelines/hubresolver-config`，应与 [§3.1](#s3-1) 检查清单第 2 项读到的一致；
- **只出现在"放宽变体"里的占位符**——如 [§3.6](#s3-6) 的 `<platform-default-env-name>`，或 [§4.2.5](#s4-2-5) 讲把 `serviceAccountName` 判据提成批准列表那一段里的 `<approved-scanner-service-account>`：它们属于只有当你环境出现某种情况时才需要的可选形态，不属于本文发布的策略资产，所以不在表里；若你确实采用那些形态，取值与自检方法写在相应段落里；
- **用尖括号表示"填你自己的值"的行文**——如上表身份格式说明里的 `system:serviceaccount:<ns>:<sa>` 与 `<that value>`，或 [§4.2.3](#s4-2-3) 的 `spec.statusMessage: <reason>`。

这两类写错只会让某条命令找不到东西、或改变消息的措辞；不可能让策略悄悄停止生效——所以不在上表中逐条列出。
#### 4.0.4 如何清理演示资源（自建 namespace 级联删除；集群级对象按 UID 删除） {#s4-0-4}

本章每一节的结尾都有一段“清理”内容。**前置纪律（[§3.3](#s3-3)）：所有 namespace 级演示对象只创建在演练自己创建的 namespace 内——绝不操作既有 namespace。** 因此清理归结为两条规则：

1. **namespace 级对象不逐个删除**：`PipelineRun` / `TaskRun` 对象、fixture `Task` / `Pipeline`、ConfigMap、RBAC 等全部随其 namespace 一并回收——这些 namespace 在各节的清理段落或 [§3.3](#s3-3) 的最终清理中、检查 walkthrough-id 标签后被删除，级联删除会带走其中的一切（控制器派生的子 TaskRun / Pod 也无需单独删除；owner 级联会回收它们）。级联正是前置纪律必须成立的原因：**你删除的 namespace 里必须不包含任何别人的东西**——因此创建循环只在自己新建的 namespace 上打 walkthrough id 标签，清理循环只删除标签值等于本次运行 id 的 namespace；该 id 必须每次演练唯一（由 [§3.3](#s3-3) 生成）——固定值无法区分“本次创建的”与“上一次未完成演练遗留的”。
2. **集群级对象（`ClusterPolicy`、[§4.6](#s4-6) 的 `ClusterRole`）不会随 namespace 删除被带走**；它们必须逐个删除，并按**创建时记录的 UID** 删除。`creationTimestamp` 只能帮人做判断——它证明不了归属，更拦不住同名对象在 `get` 与 `delete` 之间被调包。本文档用本地的 `cluster-scoped-ownership.tsv` 作为归属台账：创建成功后立即追加 `resource<TAB>name<TAB>uid`；清理时先重新读取实际 UID，逐字一致才允许删除；读取失败、台账缺行、同名替换一律 fail-safe 跳过。**台账不是可选证据**：旧终端的变量丢了没关系，但台账一旦丢失，不要靠猜名字或按时间戳补删——应结合实际 UID 与 API server 审计/变更记录人工归属这些对象，再行处理。

```bash
# Run this once before creating ANY cluster-scoped walkthrough object. Keep the file
# until the whole walkthrough has been cleaned up; a new terminal reuses the same file.
OWNERSHIP_LEDGER=${OWNERSHIP_LEDGER:-cluster-scoped-ownership.tsv}
OWNERSHIP_PENDING=${OWNERSHIP_PENDING:-cluster-scoped-ownership.pending.tsv}
if touch "$OWNERSHIP_LEDGER"; then
  OWNERSHIP_LEDGER_READY=yes
else
  OWNERSHIP_LEDGER_READY=no
  echo "cannot write $OWNERSHIP_LEDGER -- no create/delete helper will run"
fi

reconcile_pending_cluster_create() {
  [ -s "$OWNERSHIP_PENDING" ] || return 0
  IFS=$'\t' read -r pending_resource pending_name pending_token < "$OWNERSHIP_PENDING"
  case "$pending_resource" in clusterpolicy|clusterrole) :;;
    *) echo "invalid pending ownership intent -- reconcile it manually"; return 1;; esac
  if ! pending_live=$(kubectl get "$pending_resource" "$pending_name" \
      -o json --ignore-not-found 2>&1); then
    echo "$pending_resource/$pending_name: pending create read failed -- $pending_live"
    return 1
  fi
  if [ -z "$pending_live" ]; then
    rm -f "$OWNERSHIP_PENDING"
    echo "$pending_resource/$pending_name: pending create never landed"
    return 0
  fi
  if ! pending_live_token=$(printf '%s' "$pending_live" | jq -er \
       '.metadata.annotations."policy.alauda.io/walkthrough-owner"') \
     || [ "$pending_live_token" != "$pending_token" ]; then
    echo "$pending_resource/$pending_name: live object does not carry the pending token"
    echo "  It is not adopted or deleted. Reconcile ownership manually."
    return 1
  fi
  pending_uid=$(printf '%s' "$pending_live" | jq -er '.metadata.uid') || return 1
  pending_rows=$(awk -F '\t' -v r="$pending_resource" -v n="$pending_name" \
    '$1==r && $2==n {print $3}' "$OWNERSHIP_LEDGER") || return 1
  pending_count=$(printf '%s\n' "$pending_rows" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "$pending_count" = 1 ] && [ "$pending_rows" = "$pending_uid" ]; then
    rm -f "$OWNERSHIP_PENDING"
    echo "$pending_resource/$pending_name: UID was already committed; pending intent cleared"
    return 0
  elif [ "$pending_count" != 0 ]; then
    echo "$pending_resource/$pending_name: ledger conflicts with pending UID -- left pending"
    return 1
  fi
  if ! printf '%s\t%s\t%s\n' "$pending_resource" "$pending_name" "$pending_uid" \
      >> "$OWNERSHIP_LEDGER"; then
    echo "could not commit recovered UID $pending_uid -- pending intent retained"
    return 1
  fi
  rm -f "$OWNERSHIP_PENDING"
  echo "$pending_resource/$pending_name: recovered create and recorded UID $pending_uid"
}

# Cluster-scoped objects: `apply` would silently overwrite an existing same-named
# object. Always create through this helper: it lets the API server reject collisions
# and records the returned UID. Paste these helpers into every fresh terminal used by
# the walkthrough; the ledger file is the state that survives terminal changes.
create_owned_cluster_object() {  # <manifest> <resource: clusterpolicy|clusterrole>
  manifest=$1; resource=$2
  [ "${OWNERSHIP_LEDGER_READY:-no}" = yes ] \
    || { echo "ownership ledger is not writable -- nothing created"; return 1; }
  reconcile_pending_cluster_create || return 1
  [ ! -s "$OWNERSHIP_PENDING" ] \
    || { echo "another create intent is pending -- nothing created"; return 1; }
  case "$resource" in clusterpolicy|clusterrole) :;;
    *) echo "$resource: unsupported resource -- nothing created"; return 1;; esac
  # Check the ledger BEFORE the live create. Discovering a stale row afterwards would
  # leave a new live object that this helper deliberately refuses to record twice.
  if ! intended=$(kubectl create --dry-run=client -f "$manifest" -o json) \
     || ! intended_name=$(printf '%s' "$intended" | jq -er '.metadata.name'); then
    echo "$manifest: cannot derive metadata.name -- nothing created"; return 1
  fi
  if awk -F '\t' -v r="$resource" -v n="$intended_name" \
      '$1==r && $2==n {found=1} END {exit !found}' "$OWNERSHIP_LEDGER"; then
    echo "$resource/$intended_name: ledger already has this name -- reconcile it first"
    return 1
  fi
  owner_token="${WALKTHROUGH_ID:-walkthrough}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  intended=$(printf '%s' "$intended" | jq -c --arg t "$owner_token" \
    '.metadata.annotations."policy.alauda.io/walkthrough-owner" = $t') || return 1
  pending_tmp=$(mktemp "${OWNERSHIP_PENDING}.XXXXXX") || return 1
  if ! printf '%s\t%s\t%s\n' "$resource" "$intended_name" "$owner_token" \
      > "$pending_tmp" || ! mv "$pending_tmp" "$OWNERSHIP_PENDING"; then
    rm -f "$pending_tmp"
    echo "could not persist create intent -- nothing created"; return 1
  fi
  if ! created=$(printf '%s' "$intended" | kubectl create -f - -o json); then
    echo "create did not return success; reconciling the persisted intent"
    reconcile_pending_cluster_create
    return 1
  fi
  if ! created_name=$(printf '%s' "$created" | jq -er '.metadata.name') \
     || ! created_uid=$(printf '%s' "$created" | jq -er '.metadata.uid'); then
    echo "created an object but could not parse its name/UID -- STOP and recover it"
    return 1
  fi
  [ "$created_name" = "$intended_name" ] || {
    echo "created name $created_name differs from dry-run name $intended_name -- STOP"
    return 1
  }
  if ! printf '%s\t%s\t%s\n' "$resource" "$created_name" "$created_uid" \
      >> "$OWNERSHIP_LEDGER"; then
    echo "created $resource/$created_name but could not record UID $created_uid -- STOP"
    echo "pending intent retained; the next helper call can recover it by token"
    return 1
  fi
  rm -f "$OWNERSHIP_PENDING"
  echo "$resource/$created_name: created and recorded UID $created_uid"
}

# Minimal example for one policy. The helper's `kubectl create` already performs the
# collision check atomically, so no separate get/create race is needed.
POLICY_NAME='<policy-name>'
# Reject the unreplaced placeholder BEFORE the helper tries to open its manifest: a
# literal <policy-name> would otherwise be treated as a shell redirection-looking filename.
case "$POLICY_NAME" in '<'*'>') echo "fill in POLICY_NAME first"; POLICY_NAME='';; esac
if [ -z "$POLICY_NAME" ]; then
  echo "no policy name set -- nothing to create"
else
  create_owned_cluster_object "$POLICY_NAME.yaml" clusterpolicy
fi

# Cleanup helper: read/parse failures, missing ledger rows, duplicate ledger rows and
# UID replacement all refuse deletion. DELETE is sent to the canonical API path with
# a Kubernetes DeleteOptions UID precondition, closing the final read/delete race too.
delete_owned_cluster_object() {  # <resource> <name>
  resource=$1; name=$2
  [ "${OWNERSHIP_LEDGER_READY:-no}" = yes ] \
    || { echo "ownership ledger is not writable -- nothing deleted"; return 1; }
  case "$resource" in
    clusterpolicy) api_path="/apis/kyverno.io/v1/clusterpolicies/$name" ;;
    clusterrole) api_path="/apis/rbac.authorization.k8s.io/v1/clusterroles/$name" ;;
    *) echo "$resource/$name: unsupported resource -- left alone"; return 1 ;;
  esac
  if ! ledger_rows=$(awk -F '\t' -v r="$resource" -v n="$name" \
      '$1==r && $2==n {print $3}' "$OWNERSHIP_LEDGER"); then
    echo "$resource/$name: could not read ownership ledger -- left alone"; return 1
  fi
  if [ "$(printf '%s\n' "$ledger_rows" | sed '/^$/d' | wc -l | tr -d ' ')" != 1 ]; then
    echo "$resource/$name: ownership ledger must contain exactly one UID -- left alone"; return 1
  fi
  expected_uid=$ledger_rows
  if ! live=$(kubectl get "$resource" "$name" -o json 2>&1); then
    case "$live" in
      *NotFound*)
        tmp_ledger=$(mktemp) || return 1
        if awk -F '\t' -v r="$resource" -v n="$name" -v u="$expected_uid" \
             '!($1==r && $2==n && $3==u)' "$OWNERSHIP_LEDGER" > "$tmp_ledger" \
           && mv "$tmp_ledger" "$OWNERSHIP_LEDGER"; then
          echo "$resource/$name: already absent; reconciled its ledger row"; return 0
        fi
        echo "$resource/$name: absent but ledger row could not be reconciled"; return 1 ;;
      *) echo "$resource/$name: read failed -- left alone: $live"; return 1 ;;
    esac
  fi
  if ! live_uid=$(printf '%s' "$live" | jq -er '.metadata.uid'); then
    echo "$resource/$name: live UID could not be parsed -- left alone"; return 1
  fi
  if [ "$live_uid" != "$expected_uid" ]; then
    echo "$resource/$name: UID changed ($live_uid != $expected_uid) -- replacement left alone"; return 1
  fi
  body=$(jq -cn --arg uid "$expected_uid" \
    '{apiVersion:"v1",kind:"DeleteOptions",preconditions:{uid:$uid}}') || return 1
  if printf '%s' "$body" | kubectl delete --raw "$api_path" -f - >/dev/null; then
    echo "$resource/$name: delete accepted with UID precondition $expected_uid"
    echo "  Re-run this helper after the object is absent to reconcile the ledger row."
    return 0
  else
    echo "$resource/$name: UID-preconditioned delete failed -- left in ledger"
    return 1
  fi
}

# Each section passes only names it actually created. A successful first call sends
# the preconditioned delete; run it once more after deletion is observed to remove the
# matching ledger row. It never treats a read error as absence.
if [ -n "$POLICY_NAME" ]; then
  delete_owned_cluster_object clusterpolicy "$POLICY_NAME"
fi
# Keep the ledger itself until every row has been reconciled; it is recovery material.
```

如果确实必须与既有策略并存运行演示，请给你的副本起一个带独特前缀的名字（本文档各节的探针脚本正是这么做的）；不要复用已发布的名字。

#### 4.0.5 按节演练时的跨节干扰（探针跑不起来的头号原因） {#s4-0-5}

[§4.0.1](#s4-0-1) 中的表给出的是**生产上线顺序**，不是逐节演练本文档的顺序。**各节演示相互独立**：每节自行安装策略、运行探针、完成清理。在同一集群上叠加多节的 Enforce 策略再跑演示，就会出现“请求在本节策略还没被评估之前就已被其他策略拒绝”——你看到的拒绝原因与本节结论毫无关系。

**机械判据**：Kyverno 的拒绝消息一定带有**策略名**。名字 ≠ 你正在验证的策略 = 你被别的策略拦了；不要据此下任何结论（遗留的调试策略会让整套探针成批地假性失败——运行前按 [§4.0.4](#s4-0-4) 清理）。

有两处会真正互锁（下表是本文档自身策略资产之间的互锁结果，可用 `--dry-run=server` 复核）：

| 已安装策略 | 被阻断的演示 | 结果 |
|---|---|---|
| [§4.1.1](#s4-1-1) `pipeline-template-allowlist`（Enforce） | [§4.2.2](#s4-2-2) 的 `gated-build-with-prep`、[§4.6.2](#s4-6-2) 的 `gated-build-rogue` | 两个演示运行都会被**允许清单**拒绝（消息中给出 `pipeline-template-allowlist`）——那些章节自己的策略根本不会被评估。[§3.3](#s3-3) 的三个 `gated-build` 变体（通过 / 门禁失败 / 门禁关闭）不受影响，照常通过 |
| [§4.5.4](#s4-5-4) `pipeline-entry-lockdown`（Enforce） | [§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4) / [§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2) / [§4.5.1](#s4-5-1) / [§4.5.2](#s4-5-2) 中**你手工提交的裸 TaskRun 探针** | 以普通身份提交时全部被它拒绝（消息中给出 `pipeline-entry-lockdown`）；用 `--as` 以获批的 `<platform-admin-identity>` 提交则通过 |

演练时二选一：

- **逐节隔离**（推荐）：在运行某节探针之前，先 `kubectl get clusterpolicy` 确认集群上没有其他节的 Enforce 策略；
- **临时放宽**：把 `gated-build-with-prep` / `gated-build-rogue` 临时加入 [§4.1.1](#s4-1-1) 的获批名字清单（演示结束后还原），并用 `--as=<platform-admin-identity>` 提交所有裸 TaskRun 探针。

另外，[§4.1.1](#s4-1-1) 获批清单中的 `official-gated-build` 只是“你的第二个获批模板”的示例名——**本文档的 fixtures 并不会创建它**；复制清单时请按 [§4.0.2](#s4-0-2) 的说明将其替换为你的真实模板名。

#### 4.0.6 拒绝消息的最低标准（被拦的人能否自行修复） {#s4-0-6}

**“策略能拦” ≠ “上线成功”。** 被拒绝的流水线用户手里只有一样东西——API 返回的那句话；他们既看不到完整的 `ClusterPolicy`，也不应该看到。这句话写得差，每一次拦截都会变成一次找平台团队的沟通。复制本文档的策略时，请对每条策略过一遍三个问题：

| 要素 | 判据 | 责任方 |
|---|---|---|
| **① 是哪条策略拦的** | 拒绝消息必须能揭示策略/规则名 | **Kyverno 内置**：API 错误自带 `<policy>: <rule>: ...` 前缀；不必在消息里重复 |
| **② 哪个字段的值不合规** | 消息必须点名**字段**，并尽可能回显**实际读到的值**（缺失也必须能被识别为缺失） | **写消息的你**——最常被漏掉的一项 |
| **③ 合规长什么样 / 找谁要清单** | 如果取值集合小且不敏感（如 `"true"`、`main` / `release-*`），直接写进消息；**如果是获批清单（registry 前缀、获批的 namespace / Secret / 身份名），则不要**——改写为“清单由平台维护；请向 X 索取” | **写消息的你**，按环境自行决定什么算敏感 |

要素 ② 与 ③ 并不冲突，因为它们说的是两码事：**回显的是“请求里的值”**（提交者自己写进去的；他们本来就知道），**不回显的是“获批集合”**（他们不知道、也不应能从一条错误里推导出来）。所以“你的 `srcImage` 不在获批来源之列”是对的，而“获批来源是 A / B / C”是错的。**不要把两者混为“实际值也不能回显”**——那就退化成只会说“不合规”的无用消息了。

三个实践要点（每一条在本章策略中都有现成实例）：

- **`deny.conditions.any` 下的多个判据共用一条消息**：用户无从得知触发的是哪一条。要么把判据拆成独立规则（各配一条消息），要么**在消息里回显若干关键字段的实际值**（本文档多数策略选择后者——如 [§4.2.1](#s4-2-1) 打印两个门禁参数的实际值）。检验标准是：**读完消息后，你知道该改哪个字段吗？**
- **`foreach` 的消息里不能用 `element.*`**（Kyverno 会在策略创建时拒绝）；要点名具体元素，必须用 `context` 变量重新计算——写法模式及其两个坑见 [§4.5.3](#s4-5-3) 的设计说明。
- **取消类（mutate-existing / admission mutate）没有拒绝消息**：用户只能看到 `Cancelled`。**原因必须由你写进对象**（`cancel-reason` 注解或 `spec.statusMessage`）——否则对象上连一点“这是策略干的”的线索都不会留下（[§6.2.3](#s6-2-3)）。

反方向还有一条边界：**不要把消息当审计记录**。它只存在于那一次 API 响应和 PipelineRun 的 condition 中；对象一旦被清理就没了（[§4.4.4](#s4-4-4)）。

#### 4.0.7 从演示资产到生产资产（复制前的五步转换与验收） {#s4-0-7}

本章交付的是**演示资产**：所有 scope 都钉死在 `policy-poc`，且 21 条策略中有 11 条**只改 scope 和占位符还不够**（即 [§4.0.2](#s4-0-2) “可否照抄使用”列中标 🔧 的那些——其中 10 条把身份判据钉在演示 fixtures 上，剩下那条 `pipeline-entry-lockdown` 需要你补全环境中合法自动化创建者的清单）。**原样照抄进生产不会报错，但也不会按你的预期工作**，而且两类的失败方向相反：允许清单/契约类会**拒绝所有**真实流水线（噪声大、一眼就能发现），而 Audit/取消/身份前置类会**静默跳过**（PolicyReport 里一条记录都没有——看起来和“没有违规”一模一样）。下面五步是从演示资产到生产资产的完整迁移；**第 4 步是唯一能暴露静默失效的一步，绝不可跳过**。

1. **换 scope**：把每条策略 `namespaces` 下列出的 `policy-poc` 替换为你实际治理的范围。这一步同时发生三件事：
   - **四种 scope 形态选其一**（[§5.1](#s5-1)）：逐个**枚举** namespace、按 Namespace 标签选择的 `namespaceSelector`、“平台级 `ClusterPolicy` + **反向 `exclude`** 挖掉系统 namespace”、或者干脆**转换为 namespace 级 `Policy`** 供项目自助（[§5.2](#s5-2) 的第二层）。要做到“默认覆盖、新建 namespace 自动纳入”，必须用反向 `exclude` 形态——枚举和标签选择天然都会漏掉后来创建的 namespace（[§3.6](#s3-6) 第一行）。
   - ⚠️ **有两条策略在 `namespaces` 下列的不止 `policy-poc`**：`gate-param-contract`（[§4.2.1](#s4-2-1)）和 `gate-param-mutate-to-cancel`（[§4.2.3](#s4-2-3)）还带着演示豁免 namespace `policy-exempt-runs`（服务于 [§5.3](#s5-3) 的豁免演示）——只替换 `policy-poc` 会把这条演示豁免项原封不动带进生产；转换时请删掉它，或替换为你按 [§5.3](#s5-3) 治理流程建立的生产豁免 namespace。
   - ⚠️ **演示 namespace 不只钉在 `match` 里——还有三处必须随之修改**（`match` / `targets` / RBAC 是三个互不联动的独立设置——[§4.2.2](#s4-2-2) 警告 ① 解释了这一点；此处说明它们在转换中落在哪里）：① [§4.2.2](#s4-2-2) 与 [§4.6.2](#s4-6-2) 中的 `mutate.targets[].namespace: policy-poc` **字面量**（[§4.6.1](#s4-6-1) 用的是 `{{ request.namespace }}` 变量，无需修改）——替换为你的目标 namespace 字面量，或按 [§4.6](#s4-6) 引言改用变量 + 聚合 ClusterRole；② 配套的 namespace 级 `Role` / `RoleBinding` 的 `namespace`（[§4.2.2](#s4-2-2) 的 RBAC details 块）随之修改；③ [§4.5.3](#s4-5-3) 的 ConfigMap 形态中，`context.configMap.namespace: policy-poc`、`pipeline-image-allowlist` ConfigMap 对象本身、以及其检查命令的 `-n`——漏掉这一处，演示 namespace 一被清理，策略就会在整个生产范围内 fail-close（ConfigMap 缺失的失效方向见 [§4.5.3](#s4-5-3)）。只改 `match`，取消类策略会命中生产请求却去演示 namespace 里找目标（或缺少目标 namespace 的 update 权限）——预期的取消静默地永远不会发生。对目标集群执行 [§3.1](#s3-1) 第 6 项的**两层检查**——只看声明还不够：声明为 `Fail` 但 webhook 落在 `-ignore` 组的策略正被平台级开关强制覆盖；先解决覆盖再谈分层（机制见 [§3.1.2](#s3-1-2)）。确认每条策略的层级符合本集群的可用性方案（[§3.7](#s3-7) 的分层；本文档资产的出厂分层为“拦截类以及 [§4.2.2](#s4-2-2) 的门禁取消触发器 `Fail`；记账类和 `*/status` 取消触发器——含 [§4.4.4](#s4-4-4) 的后台盘点——`Ignore`”）；本集群方案要求不同层级的策略在此处改掉，并把接受的真空边界写进变更申请。
2. **换身份判据**：对 [§4.0.2](#s4-0-2) 中标 🔧 的 11 条策略，把演示身份（`gated-build` / `policy-demo-scanner` / `tekton-templates` / 演示任务别名等）逐条替换为你的真实模板名、Task 名和 namespace；`pipeline-entry-lockdown` 是另一种——你必须**穷举环境中所有合法的自动化创建者**（盘点方法见 [§4.0.3](#s4-0-3) 中该占位符所在的行）。
3. **替换占位符**：逐条过 [§4.0.3](#s4-0-3)。**不要只搜尖括号**：该节点名的三行（hub catalog 名 `catalog`、Tekton 控制器身份、一批 `approved-*` 对象名）在策略里是裸字面量——搜 `<` 找不到它们；反过来，`catalog` 那一行还带有 11 处**参数键**出现，绝不能被替换。
4. **验收**（**强制**）：每条策略至少跑两格——一次**真实违规输入必须产生其类别预期的失败/审计/取消结果**，一次**真实合规输入不得被误拒**。只有 Enforce admission 类表现为“违规请求被拒、合规请求放行”；Audit 类与取消类的通过判据见下表，命令骨架见 [§3.4.1](#s3-4-1)。
5. **渐进上线**：按 [§3.5](#s3-5)，先在 `Audit` 下观察，误报清零后再切 `Enforce`；上线后按 [§3.6](#s3-6) 盯变更触发点，每次升级后按 [§3.8](#s3-8) 跑最小回归集。

**第 4 步的判据（不要把“没报错”当通过）**：

| 策略类别 | 什么算通过 | 假通过长什么样 |
|---|---|---|
| 允许清单/参数契约类（Enforce） | 违规请求被拒，且**拒绝消息里的策略名正是这条策略**；合规请求放行 | 被**另一条**策略拦截看起来也是“被拒”（[§4.0.5](#s4-0-5)）——不核对策略名就会把它记成通过 |
| Audit 类 | 违规输入之后，PolicyReport 中**出现**这条策略的 `fail` 条目；合规输入得到 `pass` / `skip`，且**不得**产生这条策略的 `fail`（把每个输入都记成 `fail` 的策略单靠违规侧也能通过——健康侧对照同 [§3.8](#s3-8) 第 5 / 6 步） | 身份判据钉错 → 规则 skip → 报告干净，与“没有违规”无法区分 |
| 取消类（mutate-existing / admission mutate） | 目标对象真实呈现**取消类** `spec.status`（父运行为 `CancelledRunFinally`，门禁 TaskRun 为 `TaskRunCancelled`）以及对应的策略标记——**父运行上的 `cancel-reason` 注解；门禁 TaskRun 上的 `spec.statusMessage`（[§4.2.3](#s4-2-3)）**（[§6.2.3](#s6-2-3)）——按**值**判断，不按“非空”判断 | 请求照常放行是**正常的**（取消类不拒绝请求），所以“提交成功了”说明不了策略是否生效 |
| 身份前置规则（[§4.0.3](#s4-0-3) 点名的三处：`gate-param-contract` / `pipeline-entry-lockdown` / [§5.3](#s5-3) 的 RBAC 闭环） | 只有以**该身份**（`--as=<identity>`）提交的才算数 | 用普通身份跑探针，规则永远不会被评估——永恒的假通过 |

**成本集中在第 2 步**；其余四步都是机械操作。如果你的模板与本文档的 profile 一致（官方 java / python 0.3、sonarqube-scanner、trivy-scanner、skopeo-copy），[§4.0.2](#s4-0-2) 中标 ✅ 的 10 条策略可以跳过第 2 步——**第 4、5 步对每条策略无一例外**：验收和渐进上线不会因为“只改了占位符”而免除。

### 4.1 模板与定义约束（契约 1“身份”/契约 7“入口闭环”的定义侧） {#s4-1}

**总契约**：业务 namespace 中的 PipelineRun 只能引用受治理的流水线定义。“受治理”沿 [§2.1](#s2-1) 的三个强度层级展开：

1. 集群内模板 namespace（cluster resolver → `tekton-templates`）：内容与变更权限都在集群内受控（变更权限由标准 RBAC 封死，见 [§4.1.2](#s4-1-2)）——最强；
2. hub / git **不可变引用**（catalog 条目 + 显式版本 / commit SHA）：身份在集群内锁定，内容信任来自 catalog 发布流程/仓库治理——身份强，内容依赖外部治理；
3. hub / git **可变引用**（branch / tag / 默认版本）：远端一动，内容变更自动生效——不动集群配置就能跟踪模板更新，这本身是常见且正当的用法；但 Kyverno 在这一层锁不住内容，任何强约束只能来自仓库侧权限控制（受保护分支 / tag、收紧写权限）。仓库侧缺这层控制的，一律拒绝。

**本文档不走的一条路：在定义对象的 admission 处做结构校验。** `Pipeline` / `Task` 定义本身的 CREATE / UPDATE 同样经过 admission，理论上契约 3 / 5 / 6 的一部分可以在那里静态判断——门禁任务是否带 `when`、发布类任务是否（传递地）`runAfter` 到门禁、发布类任务是否出现在 `finally` 中。本文档选择不发布此类策略，原因有三，写在这里供有需要的人自行判断是否值得做：

- **它只对集群内定义有效**。经 hub / git 引用的定义根本不会进入本集群的 admission，同一判据在最常见的引用形态上就落了空——[§4.1.4](#s4-1-4) 的事后 Audit 之所以挂在 `status.pipelineSpec` 上，正是因为那是**唯一**能同时看到三条通道解析结果的地方。
- **“传递依赖”在 JMESPath 里代价很高**。`runAfter` 只给直接前驱；判断“发布任务是否被门禁支配”需要计算传递闭包。单层展开写得出来，但在多层依赖的模板上会得出错误结论——这是**有判据比没判据更危险**的经典案例（漏判是静默放行；错判会拒绝所有正常模板）。
- **判据必须逐模板配置**：哪个任务是门禁、哪些是发布类，是模板语义而非 API 字段——和 [§4.2.1](#s4-2-1) 的身份契约一样，只能按模板逐个编写。

所以本文档明确把契约 3 / 5 / 6 留在模板设计责任侧：契约 3 在 [§4.1.5](#s4-1-5) 有读 `skippedTasks` 的现成事后 Audit（[§2.3](#s2-3) 表中担保方写着 `T + K post-hoc Audit` 的那一行），而契约 5 / 6 **没有现成 Audit**——若要自建，[§4.1.4](#s4-1-4) 的已解析定义快照（含 `runAfter` 与 `finally`）是运行时侧的挂载点，下述定义侧路线是另一个落点。**如果你的模板全是集群内定义且数量可控**，在定义侧加一条“门禁不得带 `when`；发布类任务不得出现在 `finally`”的 Enforce 策略是值得的：那两条判据只读 `spec.tasks[].when` 和 `spec.finally[]`，不涉及传递闭包，成本落在上面第三条（逐模板配置门禁名与发布类任务名）。它拦的是**定义进入集群**——与读运行时 `status.skippedTasks` 的 [§4.1.5](#s4-1-5) 是**互补而非替代**关系：远程引用的模板仍只能依赖后者。按 [§3.5](#s3-5) 上线：先 Audit，后 Enforce。

#### 4.1.1 模板允许清单（三条通道，fail-closed） {#s4-1-1}

- **它治理什么**：业务 namespace 中的 PipelineRun **只能引用受治理的流水线定义**——未知模板在“引用形态”这一层就被拦下。
- **难在哪里**：合法引用来自三条通道（cluster / hub / git），且每条通道上**只校验部分字段就会留下绕过路径**：cluster 只查 namespace，就放过该 namespace 里任何无门禁的 Pipeline；hub 只查资源元组，后端可被请求级 `url` 或 `type` 切换调包；git 只查 url + SHA，就放过同一 commit 里的任何其他文件。
- **策略如何分层**：① 三条通道各计算一个布尔值（`clusterOK` / `hubOK` / `gitOK`），各自锁定**完整的**规范身份 → ② 取三者并集 → ③ **并集为假 ⇒ 拒绝**——内联 `pipelineSpec`、裸名字引用、未钉版本、以及未来出现的任何引用形态默认都落在拒绝侧。
- **它治理不了什么**：它只知道“引用的是谁”——看不到**被引用定义的内容**（CREATE 时定义尚未解析，[§2.1](#s2-1) 观察点 2）——内容漂移由 [§4.1.4](#s4-1-4) 的事后 Audit 兜底；通道 1 的强度还依赖 `tekton-templates` 的写权限被 RBAC 封死（[§4.1.2](#s4-1-2)）；确有内联需求的场景见 [§4.1.3](#s4-1-3) 的例外。

**关键判据**——三条通道各自锁定完整身份，并集为假即拒绝（**这是片段，不是可直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
        # EXCERPT -- key conditions only, NOT a standalone manifest; the
        # indentation is kept from the full policy, so this block alone does
        # not parse. Apply the complete YAML from the details block below.
        # channel 1: cluster resolver — FULL identity: kind + namespace + an approved name
        - name: clusterOK
          variable:
            jmesPath: "resolver=='cluster' && refKind=='pipeline' && refNamespace=='tekton-templates' && contains(['gated-build','official-gated-build'], refName)"
        # channel 2: governed Artifact Hub endpoint + complete resource tuple
        - name: hubOK
          variable:
            jmesPath: >-
              resolver=='hub'
              && refKind=='pipeline'
              && refCatalog=='catalog'
              && refName=='java-image-build-scan-deploy'
              && refVersion=='0.3'
              && length(p[?name=='url']) == `0`
              && (length(p[?name=='type']) == `0`
              || (length(p[?name=='type']) == `1`
              && refType=='artifact'))
        # channel 3: approved git repo + full commit SHA + EXACT path (a repo pins
        # content only with url+sha+path) + no other git param (gitExtraCount is
        # declared in the full YAML: it counts params outside that triple)
        - name: gitOK
          variable:
            jmesPath: "resolver=='git' && refUrl=='<approved-git-repo>' && regex_match('^[0-9a-f]{40}$', refRevision) && refPath=='pipeline/gated-build.yaml' && gitExtraCount == `0`"
        # ...(validate.message omitted; see the full YAML below)
        deny:
          conditions:
            all:
              - key: "{{ clusterOK || hubOK || gitOK }}"
                operator: Equals
                value: false
```

三条通道的字段选择并非随手挑的——每少一个字段就多一条绕过路径：

- **cluster** = `kind + namespace + name`。只查 namespace，就放过该 namespace 里任何无门禁的 Pipeline。
- **hub** = `governed type + no request-level url + kind + catalog + name + exact version`。只查资源元组，仍会漏掉后端覆盖与 type 切换（见下方警告）。
- **git** = `url + 40-char SHA + exact pathInRepo`，**且这三个参数之外一个都不许多**。只查 url + SHA，就放过同一 commit 里的任何其他文件；而 `configKey` / `serverURL` 会整套换掉 git resolver 的配置档（包括它用哪个 api-token Secret），`token` / `tokenKey` 则直接指名凭证——在引用已钉死的前提下它们改变不了取到的内容，但它们没有任何正当理由出现在模板引用里。

另有两个结构性设计点：

- **Fail-closed**：判据是“获批通道并集为假即拒绝”，因此新出现的引用形态（新的 resolver、配错的字段、未知的名字）默认落在拒绝侧；
- **可变引用默认拒绝**：默认/未获批版本的 hub 引用、以及 git branch / tag，都属于 [§2.1](#s2-1) 三层中的第三层——放行它们等于把内容控制权交给任何能挪动该引用的人。如果团队有意用 branch / tag 让模板更新自动生效，先确认仓库侧有相应权限控制（受保护分支 / tag、收紧写权限），再把该引用加入允许清单——此时内容约束由仓库承担，本策略只锁“引用的是哪个 branch / tag”。内联定义（`pipelineSpec`）没有 `pipelineRef`，三条通道全为假，自然被拒（例外见 [§4.1.3](#s4-1-3)）。

**hub 通道省略 `type` 有平台前提**：本文档允许调用方省略 `type`，前提是 `tekton-pipelines/hubresolver-config` 中的 `default-type` 为 `artifact`（[§3.1](#s3-1) 检查清单第 2 项）；显式写出 `type` 时只允许 `artifact`。请用 RBAC 限制该 ConfigMap 的修改并监控漂移；无法保证默认值的环境，每条引用都应显式写 `type: artifact`。

**这条通道的信任根是集群配置的 hub 端点本身**：下方警告解释了为何必须拒绝请求级 `url`——但一旦拒绝了 `url`，“获批坐标 ⇒ 受治理内容”这个结论就**完全押在那一个配置的端点上**。换句话说，**能改 `hubresolver-config` 的身份根本不需要绕过本策略**：同样一组获批坐标照样通过允许清单，解析出来的却是那个身份自己 hub 上的定义——可能根本没有任何门禁——而 [§4.1.4](#s4-1-4) 的事后 Audit 只在解析后才看得到，拦不下那次运行。所以这块平台配置的写权限必须按与 `ClusterPolicy` 同级的方式管控（[§5.0](#s5-0)），端点变更必须留下审计痕迹；做不到时，不要把 hub 通道当作“内容可信”的通道——只当作“来源已登记”。

:::warning 为什么必须拒绝请求级 url——一个极易被忽视的完整绕过

`catalog` + `name` + `version` + `kind` 元组只是**“某个 hub 上的坐标”，不是内容**。hub resolver 接受调用方在 `params` 里额外传入的 `url`，并且**它会覆盖集群配置的 hub 端点**。攻击者因此可以用**一模一样的坐标**，从**自己的 hub** 拉取**自己的 Task / Pipeline**：名字、版本、catalog 全都对得上，内容却是任意的。漏掉这一个条件，上面所有“锁身份”的字段校验都会被掏空。

对比两个只差一个 `url` 参数的 TaskRun（两者引用的都是不存在的任务，所以都不会真正执行），看 resolver 实际请求的是哪个地址：

```text
# Without url: the cluster-configured endpoint is used
requested resource 'http://<configured-hub-endpoint>/api/v1/packages/tekton-task/<catalog>/no-such-task-xyz' not found on hub

# With url: http://127.0.0.1:1/definitely-not-a-hub -- the caller-supplied address is used verbatim
requesting resource from Hub: Get "http://127.0.0.1:1/definitely-not-a-hub/api/v1/packages/tekton-task/<catalog>/no-such-task-xyz":
dial tcp 127.0.0.1:1: connect: connection refused
```

锁死 `type` 的理由相同：切到另一个 type 就是切到另一组端点和另一套治理假设。**该判据的 `type` 一半可直接在上游源码中验证**：hub resolver 的 `Resolve` 按 `type` 在 artifact / tekton 两组端点之间切换，两者的 URL 路径形态也不同。

**`url` 一半是上游的既定行为，不是本环境的怪癖**：常量在 `pkg/resolution/resource/name.go` 中定义为 `ParamURL = "url"`，hub resolver 在 `pkg/remoteresolution/resolver/hub/` 中读取它——注释原文写着 "a custom hub API endpoint to use **instead of the cluster-configured default**"，它覆盖的正是 `ARTIFACT_HUB_API` / `TEKTON_HUB_API`。**但它有版本下限**：这段处理只存在于新的 `remoteresolution` 包中——在本机可查的版本里，v0.55.0 / v1.6.1 / v1.6.2 **没有**，v1.11.1 / v1.12.0 / v1.12.1 **有**（旧的 `pkg/resolution/resolver/hub/` 任何版本都没有——只查那里会得出“上游不支持”的错误结论）。

**该行为是完整替换**：同一组 hub 参数多加一个 `url`，resolver 就改为请求那个地址——解析失败时错误里回显的也是它，而不是集群配置的 `artifact-hub-api`。

**所以这条判据必须保留**：它拦下的是上游设计中真实存在的绕过通道。低于上述版本下限的构建会忽略 `url`——但**引用里多出一个未知参数本身就是引用被篡改的证据**，拒绝它没有任何代价；`type` 一半在所有版本上都成立。

:::

:::details 完整策略 YAML：pipeline-template-allowlist

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-template-allowlist
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: only-approved-templates
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: p
          variable:
            jmesPath: "request.object.spec.pipelineRef.params || `[]`"
        - name: refKind
          variable:
            jmesPath: "p[?name=='kind'].value | [0] || ''"
        - name: refName
          variable:
            jmesPath: "p[?name=='name'].value | [0] || ''"
        - name: refNamespace
          variable:
            jmesPath: "p[?name=='namespace'].value | [0] || ''"
        - name: refCatalog
          variable:
            jmesPath: "p[?name=='catalog'].value | [0] || ''"
        - name: refVersion
          variable:
            jmesPath: "p[?name=='version'].value | [0] || ''"
        - name: refType
          variable:
            jmesPath: "p[?name=='type'].value | [0] || ''"
        - name: refUrl
          variable:
            jmesPath: "p[?name=='url'].value | [0] || ''"
        - name: refRevision
          variable:
            jmesPath: "p[?name=='revision'].value | [0] || ''"
        - name: refPath
          variable:
            jmesPath: "p[?name=='pathInRepo'].value | [0] || ''"
        # Any git param beyond the pinned triple is refused. configKey and
        # serverURL select a whole git-resolver profile -- including which
        # api-token Secret the resolver uses -- and token / tokenKey name a
        # credential outright. If your approved repo genuinely needs one of
        # them, add that exact key to the exclusion list below, not a blanket
        # allowance.
        - name: gitExtraCount
          variable:
            jmesPath: "length(p[?name!='url' && name!='revision' && name!='pathInRepo'])"
            default: 0
        # channel 1: cluster resolver — FULL identity: kind + namespace + an approved name
        - name: clusterOK
          variable:
            jmesPath: "resolver=='cluster' && refKind=='pipeline' && refNamespace=='tekton-templates' && contains(['gated-build','official-gated-build'], refName)"
        # channel 2: governed Artifact Hub endpoint + complete resource tuple
        - name: hubOK
          variable:
            jmesPath: >-
              resolver=='hub'
              && refKind=='pipeline'
              && refCatalog=='catalog'
              && refName=='java-image-build-scan-deploy'
              && refVersion=='0.3'
              && length(p[?name=='url']) == `0`
              && (length(p[?name=='type']) == `0`
              || (length(p[?name=='type']) == `1`
              && refType=='artifact'))
        # channel 3: approved git repo + full commit SHA + EXACT path (a repo pins
        # content only with url+sha+path) + no other git param (gitExtraCount is
        # declared in the full YAML: it counts params outside that triple)
        - name: gitOK
          variable:
            jmesPath: "resolver=='git' && refUrl=='<approved-git-repo>' && regex_match('^[0-9a-f]{40}$', refRevision) && refPath=='pipeline/gated-build.yaml' && gitExtraCount == `0`"
      validate:
        failureAction: Enforce
        message: >-
          only approved pipeline templates may run: cluster resolver
          (kind=pipeline, namespace=tekton-templates, an approved name),
          hub resolver (type omitted under the governed artifact default, or
          type=artifact; no request-level url; kind=pipeline;
          catalog/java-image-build-scan-deploy pinned to version 0.3), or the
          approved git repo pinned to a full commit SHA and exact path, carrying
          no other git param (configKey / serverURL / token select a resolver
          profile or a credential and are never needed by a template ref). Inline
          pipelineSpec, plain name refs, unpinned or unknown identities are rejected.
        deny:
          conditions:
            all:
              - key: "{{ clusterOK || hubOK || gitOK }}"
                operator: Equals
                value: false
```

:::

:::details 验证探针（15 个，--dry-run=server）

| 探针 | 预期 |
|---|---|
| 内联 pipelineSpec | 拒绝 |
| 裸 `pipelineRef.name` | 拒绝 |
| cluster：kind + ns + 获批名字 | 放行 |
| cluster：获批 ns 但**未获批名字** | 拒绝 |
| cluster resolver → 另一个 ns | 拒绝 |
| hub：catalog + **精确版本 0.3** | 放行 |
| hub：获批元组 + 单个显式 `type=artifact` | 放行 |
| hub：同名但 `version=9.9`（未获批） | 拒绝 |
| hub：获批元组 + 请求级 `url` | 拒绝 |
| hub：获批元组 + `type=tekton` | 拒绝 |
| git：获批仓库 + SHA + **精确路径** | 放行 |
| git：获批仓库 + SHA + **错误路径** | 拒绝 |
| git：获批仓库 + `revision: main`（不是 SHA） | 拒绝 |
| git：获批仓库 + SHA + 精确路径，**多带一个 `configKey`** | 拒绝 |
| git：获批仓库 + SHA + 精确路径，**多带一个 `serverURL`** | 拒绝 |

:::

#### 4.1.2 治理定义资源（用 RBAC 封死） {#s4-1-2}

通道 1 的强度来自“集群内内容受控”，其前提是 `tekton-templates` 中的定义**只能由平台身份修改**。这是**标准 Kubernetes RBAC 的活——不需要单独的 Kyverno 策略**：把 `tekton-templates` namespace 中 `Pipeline` / `Task` 的 `create` / `update` / `patch` / `delete` 只授予平台管理员的 Role / ClusterRole，普通项目身份不给任何写权限。RBAC 是“谁可以改某 namespace 里的资源”的原生控制平面；用 Kyverno 的 `userInfo` 允许清单再做一遍只会更弱、更绕（而且拦不住 `system:masters`），所以本文档不为此单列策略。

**平台级开关（禁用内联定义）**：Tekton 自身在 `feature-flags` ConfigMap 中提供 `disable-inline-spec` 字段，可**全集群**禁用内联定义；Tekton 自己的 validating webhook 会在 admission 处以 `must not set the field(s): ...` 拒绝。这是全集群的大锤；需要按 namespace 区分时，用 [§4.1.1](#s4-1-1) 的 Kyverno 允许清单。

取值是 `pipeline` / `pipelinerun` / `taskrun` 的逗号分隔组合，三个值治理的是**三个不同的内联位置**——不是同一件事的三个强度层级：

| 取值 | 它禁用的内联位置 | 被拒绝的字段 |
| --- | --- | --- |
| `pipelinerun` | PipelineRun 直接内联整条流水线 | `spec.pipelineSpec` |
| `taskrun` | TaskRun 直接内联任务定义 | `spec.taskSpec` |
| `pipeline` | Pipeline 内（或任何内联 pipelineSpec 内）**单个任务的内联**定义 | `spec.tasks[].taskSpec` / `spec.tasks[].pipelineSpec` |

要彻底封死内联，三个值必须同时在场——只有 `pipelinerun` 时，`PipelineRun.spec.pipelineRef` 引用一条任务是内联的集群内 Pipeline 照样能过。

**如何配置（在 ACP 上必须改 TektonConfig，而不是直接改 ConfigMap）**：`feature-flags` ConfigMap 由 tektoncd-operator 从 `TektonConfig.spec.pipeline` 渲染而来；手改的 ConfigMap 会在下一次 reconcile 时被覆盖回去。在这里改：

```bash
# Run against the cluster where Tekton/the pipelines run -- NOT the global management cluster.
# TektonConfig is a cluster-scoped singleton named "config".
kubectl patch tektonconfig config --type merge \
  -p '{"spec":{"pipeline":{"disable-inline-spec":"pipeline,pipelinerun,taskrun"}}}'

# Verify the operator has propagated it into the ConfigMap the pipeline webhook
# actually reads. NOT a single read: the operator reconciles asynchronously (10-20s
# live-measured on the validation environment), and pasted in one go the read lands BEFORE the render
# and prints an empty line -- which looks exactly like "the switch did nothing".
: "${TEKTON_NS:=tekton-pipelines}"   # §3.1 sets it; this only covers a fresh shell
elapsed=0
# The exit condition compares against the value just written, not merely "non-empty":
# a cluster that ALREADY had a different value (say only `taskrun`) would satisfy a
# non-empty test on the very first read, and the propagation this loop exists to observe
# would never be observed at all.
until v=$(kubectl get configmap feature-flags -n "$TEKTON_NS" \
        -o jsonpath='{.data.disable-inline-spec}') \
      && [ "$v" = 'pipeline,pipelinerun,taskrun' ]; do
  if [ "$elapsed" -ge 60 ]; then
    echo "feature-flags still does not carry disable-inline-spec='pipeline,pipelinerun,taskrun'"
    echo "after ${elapsed}s (current value: '${v:-<empty>}') -- check the operator"
    break
  fi
  sleep 5; elapsed=$((elapsed + 5))
done
echo "disable-inline-spec now: '${v:-}'"
```

要**关掉这个开关**（例如为了放开 [§4.1.3](#s4-1-3) 的内联例外），把值改回空字符串：

```bash
kubectl patch tektonconfig config --type merge \
  -p '{"spec":{"pipeline":{"disable-inline-spec":""}}}'

# The revert propagates on the same asynchronous terms as the enable did -- and the
# window cuts the OTHER way: until the ConfigMap has actually dropped the value,
# inline specs are still rejected cluster-wide. Expect the final line to print ''.
: "${TEKTON_NS:=tekton-pipelines}"
elapsed=0
until v=$(kubectl get configmap feature-flags -n "$TEKTON_NS" \
        -o jsonpath='{.data.disable-inline-spec}') && [ -z "$v" ]; do
  if [ "$elapsed" -ge 60 ]; then
    echo "feature-flags still carries disable-inline-spec after ${elapsed}s -- check the operator"
    break
  fi
  sleep 5; elapsed=$((elapsed + 5))
done
echo "disable-inline-spec now: '${v:-}'"
```

> 如果 ACP 的 Tekton namespace 不是 `tekton-pipelines`，以 `TektonConfig.spec.targetNamespace` 为准。

#### 4.1.3 内联例外（默认禁止，谨慎放开） {#s4-1-3}

**默认立场：硬门禁 namespace 中不允许内联**（[§4.1.1](#s4-1-1) 的三条通道天然拒绝内联定义；需要全集群一刀切时，叠加 [§4.1.2](#s4-1-2) 的 `disable-inline-spec`）。只在确有需要的地方放开内联例外——实验 namespace、平台自动化之类。

:::warning 前提：本节与 §4.1.2 的 disable-inline-spec 互斥——两者不能同时开启

`disable-inline-spec` 是 **Tekton 自己的 validating webhook**，是独立于 Kyverno 的 admission webhook——**任何一方拒绝，请求就被拒绝**。Kyverno 放行内联定义并不能让 Tekton 放行。

因此要让本节的内联例外生效，`TektonConfig.spec.pipeline.disable-inline-spec` **必须不包含相应的值**：要放开 PipelineRun 内联，去掉 `pipelinerun`；如果内联的 pipelineSpec 还要内嵌 `taskSpec`，把 `pipeline` 也去掉。[§4.1.2](#s4-1-2) 的第二个 patch 演示了如何清空。

换句话说，全集群一刀切（[§4.1.2](#s4-1-2)）与按 namespace 例外（本节）是**两条互斥的路线**：一旦选择按 namespace 区分，全集群开关就必须关掉，整个闭环落在 [§4.1.1](#s4-1-1) 的 Kyverno 允许清单上。

:::

:::warning 放开内联时，只查任务名远远不够

只要求“内联定义中存在名为 `scan` 的任务”是一个**不充分**的安全检查——攻击者可以塞进一个空壳的无操作扫描器、给它挂一个永假的 `when` 让它被跳过、把门禁开关设为 `false`，或者把发布排在它之前/与它并行。

要安全地放开内联，必须校验 [§2.3](#s2-3) 的完整契约集（扫描器身份、门禁开关的实际生效值、必然执行、DAG 支配、finally 安全）。**只有名字在场，构不成任何门禁保证。**

:::

因此下面的 `inlineOK` 片段只是在 [§4.1.1](#s4-1-1) 之上增加受限内联通道的**结构示例**——不得原样当作安全门禁使用：

```yaml
        # ILLUSTRATIVE ONLY — name presence is NOT a gate guarantee (see §2.3).
        # A real inline channel must also constrain identity/params/when/DAG/finally,
        # and should be restricted to a trusted userInfo or an experimental namespace.
        - name: inlineOK
          variable:
            jmesPath: "length(request.object.spec.pipelineSpec.tasks || `[]`) > `0` && length((request.object.spec.pipelineSpec.tasks || `[]`)[?name=='scan']) > `0`"
```

#### 4.1.4 已引用定义的事后内省（Audit 纵深防御） {#s4-1-4}

- **它治理什么**：允许清单已经放行的模板**内容是否被破坏**——例如门禁任务被悄悄换成另一来源的同名任务。
- **难在哪里**：引用式流水线的定义内容在 CREATE 时不可见（[§2.1](#s2-1) 观察点 2 的盲窗）；内容要等 resolver 完成后才落到 `status.pipelineSpec`（观察点 3），而那个观察点**只能 Audit**——Enforce 会卡死（[§2.2](#s2-2)）。
- **策略如何分层**：① 用 `preconditions` 把规则精确圈定到一个模板 profile（从父 `PipelineRun.spec.pipelineRef` 推导，而非运行时标签）→ ② 仅在 `status.pipelineSpec` 出现后才评估 → ③ 从解析结果中取出门禁任务的完整 `taskRef`，逐字段断言其身份 → ④ 不匹配则记录一条 PolicyReport 违规。
- **它治理不了什么**：它是**事后的**——拦不下本次运行；也检测不出“门禁还在但被 `when` / 空 matrix 跳过”（那属于契约 3，由 [§4.1.5](#s4-1-5) 处理）。**它读的是 `status.pipelineSpec`，所以其证据力止步于“谁能写 `pipelineruns/status`”**——持有该子资源写权限的身份可以直接写入一份“看起来合规”的 `pipelineSpec`，让漂移审计给出合规结论（与 [§4.4.1](#s4-4-1) 同一条信任边界）；越过这一点，本节只剩“观察请求写了什么”的能力，不再是门禁被执行的证据。

**关键判据**——锁的是完整来源而非名字；并且**先数数、再读取**（**这是片段，不是可直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
      # EXCERPT -- key conditions only, NOT a standalone manifest; the
      # indentation is kept from the full policy, so this block alone does
      # not parse. Apply the complete YAML from the details block below.
        - name: scanTaskCount
          variable:
            jmesPath: "length((request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'])"
            default: 0
        - name: scanIdentityValid
          variable:
            # The count is folded in here rather than added as a separate deny
            # condition: both deny blocks below use `all:`, so an extra condition
            # would relax the rule instead of tightening it.
            jmesPath: >-
              scanTaskCount == `1` &&
              scanResolver == 'cluster' && scanKind == 'task' &&
              scanName == 'policy-demo-scanner' &&
              scanNamespace == 'tekton-templates'
      # ...
      validate:
        deny:
          conditions:
            all:
              - key: "{{ scanIdentityValid }}"
                operator: Equals
                value: false
```

:::warning 门禁形态因 profile 而异——不要跨模板移植

在本文档的 fixture 模板 `gated-build` 中，门禁**内置在 `scan`（sonar 扫描器）自身**（自门禁，没有独立门禁任务）。官方模板 `java-image-build-scan-deploy` 同样把门禁内置在 `sonarqube-scanner` / `trivy-scanner` 中，但任务别名和引用形态不同。把一个具体任务契约移植到另一个模板上**会产生误报**——再叠加 [§4.6.2](#s4-6-2)，甚至可能错误取消合法运行。

因此漂移 Audit 必须**按模板 profile 配置**：从父 `PipelineRun.spec.pipelineRef`（`taskRunSpecs` 无法覆盖它）推导 resolver / kind / name / namespace，再断言该 profile 自己的门禁任务契约。**不要把 `tekton.dev/pipeline` 标签当可信身份**——Tekton v1.12 允许 PipelineRun 通过 `spec.taskRunSpecs[].metadata.labels` 覆盖子 TaskRun 标签；即便本规则处理的是父 PipelineRun，也应一贯以 API spec 作为第一手身份来源。

下面的示例只适用于 fixture profile（`gated-build`）。

:::

:::details 完整策略 YAML：pipeline-resolved-definition-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-resolved-definition-audit
spec:
  webhookConfiguration:
    # Ignore, not Fail: this policy matches */status — a Kyverno outage must never
    # block the Tekton controller's status write-back (§2.2 red line; §3.7 tiering)
    failurePolicy: Ignore
  background: false
  rules:
    - name: resolved-definition-must-keep-scanner
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        - name: pipelineResolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: pipelineKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: tplName
          variable:
            jmesPath: "request.object.spec.pipelineRef.name || ((request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: pipelineNamespace
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        - name: pipelineSpecPresent
          variable:
            # Key presence avoids evaluating the rule before resolution. Tekton
            # rejects a valid Pipeline with no ordinary tasks, so an empty list
            # here is only a defensive malformed/synthetic-status boundary.
            jmesPath: "contains(keys(request.object.status || `{}`), 'pipelineSpec')"
        # status.pipelineSpec keeps the complete taskRef. Lock every identity field;
        # comparing only `name` would accept a same-name Task from another source.
        # Nothing in the CRD dedupes this list by name, so two tasks named scan
        # survive admission and [0] would only see the first. Count, then read.
        - name: scanTaskCount
          variable:
            jmesPath: "length((request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'])"
            default: 0
        - name: scanTaskRef
          variable:
            jmesPath: "(request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'] | [0].taskRef || `{}`"
        - name: scanResolver
          variable:
            jmesPath: "scanTaskRef.resolver || ''"
            default: ""
        - name: scanKind
          variable:
            jmesPath: "(scanTaskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: scanName
          variable:
            jmesPath: "scanTaskRef.name || ((scanTaskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: scanNamespace
          variable:
            jmesPath: "(scanTaskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # The same "count first, then read" rule applies one level down: inside a
        # resolver taskRef, `params` is an ordinary list in status, so a decoy
        # entry in front of the real one would win every [0] above. (In `spec`
        # Tekton's own webhook rejects two params sharing a name -- status carries
        # no such guarantee, which is why only the status reads need this.)
        - name: scanRefParamsUnique
          variable:
            jmesPath: >-
              length((scanTaskRef.params || `[]`)[?name=='kind']) == `1` &&
              length((scanTaskRef.params || `[]`)[?name=='name']) == `1` &&
              length((scanTaskRef.params || `[]`)[?name=='namespace']) == `1`
        - name: scanIdentityValid
          variable:
            # The counts are folded in here rather than added as separate deny
            # conditions: the deny block below uses `all:`, so an extra condition
            # would relax the rule instead of tightening it.
            jmesPath: >-
              scanTaskCount == `1` && scanRefParamsUnique &&
              scanResolver == 'cluster' && scanKind == 'task' &&
              scanName == 'policy-demo-scanner' &&
              scanNamespace == 'tekton-templates'
        # HUB-RESOLVER GUIDANCE (this fixture uses cluster resolver -> policy-demo-scanner;
        # production usually references the catalog task via the hub resolver, e.g.
        #   taskRef:
        #     resolver: hub
        #     params:
        #       - name: catalog
        #         value: catalog
        #       - name: kind
        #         value: task
        #       - name: name
        #         value: sonarqube-scanner
        #       - name: version
        #         value: "0.7"
        # To govern the hub form, build scanIdentityValid from the complete tuple:
        # resolver=hub, catalog=catalog, kind=task, name=sonarqube-scanner,
        # version=0.7. Omitting catalog/kind/version would re-open source drift.
      preconditions:
        all:
          # Evaluate only after resolution materialized pipelineSpec. The gate
          # check itself is scanIdentityValid; do not infer it from task count.
          - key: "{{ pipelineSpecPresent }}"
            operator: Equals
            value: true
          - key: "{{ pipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ pipelineKind }}"
            operator: Equals
            value: pipeline
          # PROFILE SCOPE: only the fixture template
          - key: "{{ tplName }}"
            operator: Equals
            value: gated-build
          - key: "{{ pipelineNamespace }}"
            operator: Equals
            value: tekton-templates
      validate:
        failureAction: Audit
        message: >-
          resolved gated-build must keep scan ->
          cluster/task/tekton-templates/policy-demo-scanner; got
          '{{ scanResolver }}/{{ scanKind }}/{{ scanNamespace }}/{{ scanName }}'.
        deny:
          conditions:
            all:
              - key: "{{ scanIdentityValid }}"
                operator: Equals
                value: false
```

策略中的 **HUB-RESOLVER GUIDANCE 注释**很重要：fixture 用的是 cluster resolver，但生产中门禁任务通常经 hub resolver 引用 catalog 的 `sonarqube-scanner`。切换到 hub 形态时，`scanIdentityValid` 必须由**完整元组**（`resolver=hub` + `catalog` + `kind` + `name` + `version`）构建——catalog / kind / version 少任何一个，来源漂移的口子就重新打开。

:::

**这条 Audit 的位置**：允许清单拦的是“未获批身份”；这条 Audit 盯的是“获批后被破坏的获批模板”——生产中两者叠加使用。它兜底的是**门禁被从定义中移除**（契约 1 身份漂移）；`status.pipelineSpec` 中门禁仍在但带了 `when` 的能通过在场检查——那属于契约 3“必然执行”，由下一节接手。

**验证要点**：正常 `gated-build` 运行记 pass；把 `policy-demo-scanner` 的 namespace 改成 `policy-poc`（同名不同源）仍记 **fail**，证明锁的是完整来源；去掉 `scan` 的变体同样记 fail；其他 `pipelineRef` profile 记 skip——无误报。注意 PolicyReport 的聚合有数秒到数分钟的滞后（[§6.1.5](#s6-1-5)）。

还有一条值得点出的平台边界：**只有“有 finally 任务而普通任务为空”的 Pipeline 会被 Tekton admission 直接拒绝**（`spec.tasks is empty but spec.finally has 1 tasks`），因此这样的定义不能用作“resolver 会解析出定义”的测试用例。
#### 4.1.5 门禁必须执行的审计（`skippedTasks`，契约 3「必须执行」） {#s4-1-5}

- **管什么**：门禁仍在定义里，但**这一次运行把它跳过了**——某个 `when` 表达式求值为 false，或某个 matrix 参数是空数组。
- **为什么难**：被跳过的门禁**不会产生任何 TaskRun**，因此契约 2 的 TaskRun 层校验对「缺席」完全失明（admission 拦不住从未发生的事）；[§4.1.4](#s4-1-4) 的存在性 Audit 也看不见它，因为门禁确实还在定义里。
- **策略怎么分层**：① 与之前一样，先按画像收敛到具体模板 → ② 从 `status.skippedTasks` 中取出门禁的跳过条目 → ③ 判断其 `reason` 是否属于**配置驱动的主动跳过**集合 → ④ 命中则记录一条 PolicyReport 违规。
- **管不住什么**：仍然是子资源，所以**只能 Audit**——拦不下这一次运行；也覆盖不了「门禁跑了但结果被无视」（那在契约 4/5 下属于模板的职责）。同样，它信任 `status.skippedTasks` 由可信的 Tekton 控制器写入——**能写 `pipelineruns/status` 的身份可以抹掉主动跳过的记录，或替换成一个合法的级联跳过原因**，让本节完全留不下违规记录（与 [§4.4.1](#s4-4-1) 相同的信任边界）。

判据的关键在于**区分两类跳过**；`skippedTasks[].reason` 的取值来自 Tekton 的 `SkippingReason` 枚举：

- **配置驱动的「主动跳过」= 门禁被主动绕开——违规**：`When Expressions evaluated to false`（when 跳过）与 `Matrix Parameters have an empty array`（空 matrix 跳过）。
  两者的下游行为并不相同：`when=false` 之后，仅通过 `runAfter` 依赖门禁的 release **会继续执行**；而空 matrix 会让 release 级联记录 `Parent Tasks were skipped` 且不创建 TaskRun。**无论下游是否恰好被级联捕获，被配置跳过的门禁都必须留下 Audit 记录。**
- **级联 / 终止驱动的「被动跳过」= 合法，不算违规**：`Parent Tasks were skipped` / `PipelineRun was stopping` / `PipelineRun was gracefully cancelled` / `PipelineRun was gracefully stopped` / `PipelineRun timeout has been reached` / `PipelineRun Tasks timeout has been reached` / `PipelineRun Finally timeout has been reached`（三个超时变体，取值逐字全量列出——若这一档日后被改写成白名单的形状，就需要这些精确字符串）。它们意味着流水线本已在以失败、取消或超时收场；门禁随之被跳过并不是门禁绕过。
- `Results were missing` 介于两者之间——门禁的输入 result 从未被产出，这主要是契约 4 的数据绑定问题；按需将其并入违规集合。

上面三档合起来就是该枚举的全部取值（还有一个 `None`——表示「未跳过」的哨兵值，永远不会出现在 `skippedTasks` 里）。**但这是一份黑名单（[§3.6](#s3-6)）**：Tekton 新增 `SkippingReason` 时，默认落在「不算违规」一侧——若新原因恰好也是配置驱动的，被配置跳过的门禁就不再留下 Audit 记录，而且**不会报任何错**。所以每次 Tekton 升级后都要复核取值表：该枚举定义在上游 `pkg/apis/pipeline/v1/pipelinerun_types.go` 的 `SkippingReason` 常量块中；比对之后，把每个新增值归入上面三档之一，再调整判据。

**关键判据**——只有「主动跳过」才算违规，且**要数条目数，不要取 `[0]`**（**片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
        # EXCERPT -- key conditions only, NOT a standalone manifest; the
        # indentation is kept from the full policy, so this block alone does
        # not parse. Apply the complete YAML from the details block below.
        - name: gateSkipCount
          variable:
            jmesPath: "length((request.object.status.skippedTasks || `[]`)[?name=='scan'])"
            default: 0
        - name: gateSkipViolatingCount
          variable:
            jmesPath: >-
              length((request.object.status.skippedTasks || `[]`)[?name=='scan'
              && (reason=='When Expressions evaluated to false'
              || reason=='Matrix Parameters have an empty array')])
            default: 0
        preconditions:
          all:
            # ...profile-scope preconditions omitted here (full YAML below); the one
            # that matters for reading the deny block: only evaluate once the scanner
            # actually shows up in skippedTasks. A normal run (gate executed, no scan
            # entry) never reaches the deny conditions -- the rule skips.
            - key: "{{ gateSkipCount }}"
              operator: NotEquals
              value: 0
        deny:
          conditions:
            any:
              # Deliberate, config-driven skip = the gate was opted out. Downstream
              # behavior differs by skip type; cascade/terminal reasons are excluded.
              # Counted, not [0]-indexed: a decoy scan entry carrying a cascade reason
              # placed ahead of the real one would otherwise hide the opt-out.
              - key: "{{ gateSkipViolatingCount }}"
                operator: NotEquals
                value: 0
              # more than one scan entry is itself malformed -> fail closed. With the
              # precondition above holding count >= 1, NotEquals 1 here means ">= 2":
              # the controller writes at most one skip entry per task, and skippedTasks
              # is an atomic list (no dedupe key), so duplicates = hand-crafted status.
              - key: "{{ gateSkipCount }}"
                operator: NotEquals
                value: 1
```

更稳健的强化判据是「门禁被主动跳过**且**下游的 release 任务确实执行了」（按模板已知的 DAG，对 release 的 `childReferences` 增加一个存在性检查）。本示例采用前者，这已足以抓住主动绕开。

:::warning 与 §4.1.4 相同：门禁任务名是按画像配置的

这里的门禁任务是夹具模板的 `scan`（[§4.1.4](#s4-1-4) 中的同名说明同样适用）。其他模板给门禁任务起的别名各不相同，把本策略原样套用会**漏掉违规**——为每个模板画像配置各自的门禁任务名，并从父 `PipelineRun.spec.pipelineRef` 精确推导画像；不要用用户输入能影响的运行时标签去顶替 API spec 层的身份。

:::

:::details 完整策略 YAML：pipeline-gate-must-execute-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-gate-must-execute-audit
spec:
  webhookConfiguration:
    # Ignore, not Fail: this policy matches */status — a Kyverno outage must never
    # block the Tekton controller's status write-back (§2.2 red line; §3.7 tiering)
    failurePolicy: Ignore
  background: false
  rules:
    - name: gate-must-not-be-skipped-by-config
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        - name: pipelineResolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: pipelineKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: tplName
          variable:
            jmesPath: "request.object.spec.pipelineRef.name || ((request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: pipelineNamespace
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # the scanner's skip entry for THIS profile (scan is the fixture gate task —
        # per-profile, see warning above). Kyverno treats a nil context result as an
        # evaluation error, so provide an explicit empty object for the normal case.
        # Nothing in the CRD dedupes skippedTasks by name, so two entries named
        # scan survive admission. Decide on the counts, and keep gateSkip only
        # for the message.
        - name: gateSkipCount
          variable:
            jmesPath: "length((request.object.status.skippedTasks || `[]`)[?name=='scan'])"
            default: 0
        - name: gateSkipViolatingCount
          variable:
            jmesPath: >-
              length((request.object.status.skippedTasks || `[]`)[?name=='scan'
              && (reason=='When Expressions evaluated to false'
              || reason=='Matrix Parameters have an empty array')])
            default: 0
        - name: gateSkip
          variable:
            jmesPath: "(request.object.status.skippedTasks || `[]`)[?name=='scan'] | [0]"
            default:
              name: ""
              reason: ""
        - name: gateSkipReason
          variable:
            jmesPath: "gateSkip.reason || ''"
            default: ""
      preconditions:
        all:
          - key: "{{ pipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ pipelineKind }}"
            operator: Equals
            value: pipeline
          # PROFILE SCOPE: only the fixture template
          - key: "{{ tplName }}"
            operator: Equals
            value: gated-build
          - key: "{{ pipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          # only evaluate once the scanner actually shows up in skippedTasks
          - key: "{{ gateSkipCount }}"
            operator: NotEquals
            value: 0
      validate:
        failureAction: Audit
        message: >-
          mandatory scanner task `scan` was opted out this run
          (skippedTasks reason: {{ gateSkipReason }}); downstream release tasks
          may run ungated. Config-driven skips (when / empty-matrix) are
          violations; cascade skips (stopping / cancelled / timeout) are not.
        deny:
          conditions:
            any:
              # Deliberate, config-driven skip = the gate was opted out. Downstream
              # behavior differs by skip type; cascade/terminal reasons are excluded.
              # Counted, not [0]-indexed: a decoy scan entry carrying a cascade reason
              # placed ahead of the real one would otherwise hide the opt-out.
              - key: "{{ gateSkipViolatingCount }}"
                operator: NotEquals
                value: 0
              # more than one scan entry is itself malformed -> fail closed (the
              # precondition holds count >= 1, so NotEquals 1 here means ">= 2")
              - key: "{{ gateSkipCount }}"
                operator: NotEquals
                value: 1
```

:::

**如何复现「门禁被跳过」**（在运行着 Tekton 与 Kyverno 的集群上）：[§3.3](#s3-3) 的 `gated-build` 带有一个 `demoSkipScan` 参数；把它设为 `"true"`，`scan` 就会被 `when` 跳过——正是本节要抓的形状。保存为 `skip-gate-probe.yaml`：

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: doc-gate-skipped
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: demoSkipScan
      value: "true"
```

```bash
kubectl create -f skip-gate-probe.yaml
kubectl wait -n policy-poc pipelinerun/doc-gate-skipped \
  --for=condition=Succeeded --timeout=5m

# 1) The skip itself: expect one entry, name=scan, reason "When Expressions evaluated to false"
kubectl get pipelinerun -n policy-poc doc-gate-skipped \
  -o jsonpath='{.status.skippedTasks}{"\n"}'
# 2) release ran anyway -- that is the point: the gate was opted out, not the pipeline
kubectl get pipelinerun -n policy-poc doc-gate-skipped -o json \
  | jq -r '[.status.childReferences[]?.pipelineTaskName] | join(",")'
# 3) The Audit verdict (wait for the report to catch up, §4.4.2's note applies here too)
kubectl get policyreport -n policy-poc -o json | jq -r '
  .items[] | select(.scope.name=="doc-gate-skipped") | .results[]
  | select(.policy=="pipeline-gate-must-execute-audit") | "\(.rule) \(.result)"'
```

预期：命令 1 给出 `scan` + `When Expressions evaluated to false`；命令 2 的输出里**没有** `scan` 但**有** `release`；命令 3 显示 `fail`。**命令 3 的第一次读取多半会显示 `skip`**——报告行是在第一次 status UPDATE 时写入的，那时运行还没到达终态；**反复重读该 PolicyReport 结果**，直到它**从 `skip` 变成终态结果**再下结论（只读一次的话，两次完全相同的操作可能分别得到 `fail` 和 `skip`）。**再跑一个普通的 `demo-run-pass` 作为阴性对照**——它的 `skippedTasks` 为空，本规则对它记录的是 `skip`（不是 pass：前置条件 `gateSkipCount != 0` 不成立，规则根本没有进入求值）。如果一直不出现 `fail`，先按 [§6.1.2](#s6-1-2) 排查——策略是否 Ready、四个画像字段是否匹配——再去怀疑判据。

**与 [§4.1.4](#s4-1-4) 的分工**：[§4.1.4](#s4-1-4) 抓「门禁被删掉」（定义漂移）；[§4.1.5](#s4-1-5) 抓「门禁被跳过」（运行时主动绕开）——只有两个 Audit 合在一起，才覆盖契约 3「必须执行」的完整事后检测面。生产上两者叠加使用，与 [§4.2](#s4-2) 的参数契约（防门禁参数被关掉）和 [§4.1.1](#s4-1-1) 的白名单（防模板被调包）互为补充。

#### 清理（§4.1）

按 [§4.0.4](#s4-0-4) 的两条规则执行：三个集群级策略在 UID 台账保护下删除；运行时对象全部位于自建 namespace 中，随 namespace 级联回收——但 `PipelineRun/doc-gate-skipped` 最好现在就删掉：下一节在「每节独立」模式下重跑时，`kubectl get policyreport` 会多出一行属于上一节的 `doc-gate-skipped`，很容易被误读成当前节的结论。

```bash
# The helper refuses missing/duplicate ledger rows, read errors and UID replacements.
for pol in pipeline-template-allowlist pipeline-resolved-definition-audit \
  pipeline-gate-must-execute-audit; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
# Its TaskRuns / Pods cascade via ownerReference, and the PolicyReport rows go with it.
kubectl delete pipelinerun -n policy-poc doc-gate-skipped --ignore-not-found
```
### 4.2 参数约束：校验实际生效值（契约 2） {#s4-2}

**总契约**：门禁相关参数（开关、阈值、目标分支）的**实际生效值**必须合规。两条路径：

- **主路径（参数已展开的观测点；普适）**：在**门禁 TaskRun CREATE** 时校验。那一刻 `spec.params` 已携带展开后的生效值——`$(params.x)` 已被解析，连对上游任务 result 的引用也已解析成具体值。身份链必须从 API server 提供的 `request.userInfo`（创建者是 Tekton 控制器 SA）和控制器 `ownerReference` 出发，用 `apiCall` 读取父 PipelineRun，核对 owner UID 与父级的 `spec.pipelineRef`，再从当前 `spec.taskRef` 锁定 resolver、kind、catalog / name / version / namespace。这条路径对模板作者**零迁移义务**——不要求把任务级参数上提到 PipelineRun 层。是哪个画像、解析到哪个 Task、校验哪些参数，**必须按模板版本逐一配置**（见 [§3.2](#s3-2) 的版本矩阵）。
- **辅路径（模板已暴露参数时的提前拦截）**：当官方模板把关键开关放在 PipelineRun 层参数时，可以直接在 **PipelineRun CREATE** 拦截——一个任务都不跑，用户当场得到反馈。体验更好，但依赖模板的参数设计，只作为可选优化。这里还有一个陷阱：同名的 PipelineRun 层参数**是否真的接到了门禁上**由模板的接线决定——没接上时，这层校验就是摆设（值合规，门禁却根本不用它），这正是主路径按展开后的生效值来判断的原因。

**本节地图**（全文最大的一节——不要从头读到尾）：

- **[§4.2.1](#s4-2-1) 主路径**——门禁参数契约，在参数已展开的观测点执行 deny。**先读它**；后面的小节要么是同一件事的另一种响应形态，要么是互补面。
- **[§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3)**——**同一判据**的另外两种响应形态：拦截后 finally 仍须运行时，用取消代替 deny（这两条加上 [§4.6](#s4-6) 的取消共四条路径；总表在 [§4.6](#s4-6) 引言）。
- **[§4.2.4](#s4-2-4)**——受保护分支门禁契约（真实的 `sonarqube-scanner` 画像）；它管「受保护分支的分析必须保持严格门禁」；PR / feature 构建不带分支 admission 约束。
- **[§4.2.5](#s4-2-5) 辅路径**——官方模板已把开关暴露在 PipelineRun 层时的提前拦截：**篇幅最长的小节，但不是必装项**——只有当你在用那批官方模板、又希望用户当场得到反馈时才需要它。
- **[§4.2.6](#s4-2-6)**——mutate 注入默认值：不拦截，而是把缺失的补上。

:::warning 两条纪律——违反任何一条，整节都可能被绕过

**① 绝不信任子 TaskRun 的 `tekton.dev/pipeline` / `pipelineTask` / `pipelineRun` 标签。** Tekton 允许 PipelineRun 通过 `spec.taskRunSpecs[].metadata.labels` 覆盖这些控制器标签，也就是说这些「身份」可以被调用方伪造。**机制是「先写者赢，而用户先写」**：控制器合成子 TaskRun 的标签时，先合并 `taskRunSpecs[].metadata.labels`，再合并自己的 `tekton.dev/*` 一组——而合并函数**只在键尚不存在时才写入**——用户已写入的同名键既不会被控制器覆盖，也不会报错。所以这不是一个可以指望被修复的缺陷，而是既定的合并顺序。身份必须从控制器 `ownerReference` + 存活的父运行 + `spec.taskRef` 推导。

**② 参数缺失必须失败关闭（fail closed）。** 流水线没有绑定的参数**不会出现**在 TaskRun 的 `spec.params` 里（Task 定义的默认值生效）。只有当 `spec.taskRef` 已锁定到「默认值可信的精确 Task 版本」时，策略才可以把缺失映射为那个可信默认值；身份未锁定或默认值未知时，缺失一律算违规。

另请注意：被 `when` 跳过的门禁根本不产生 TaskRun（契约 3），所以这条路径对「门禁缺席」是失明的——那由 [§4.1.5](#s4-1-5) 的 `skippedTasks` Audit 兜住。

:::

#### 4.2.1 门禁参数契约（主路径） {#s4-2-1}

- **管什么**：**门禁开关不得被关掉**——在 `gated-build` 中，`scan` 的 `enableScanQualityGate` / `enableAnalyzeQualityGate` 必须恰好是字符串 `"true"`。
- **为什么难**：PipelineRun CREATE 时只能看到调用方**显式写入**的内容，看不到模板默认值展开后的**最终生效值**（[§2.1](#s2-1) 观测点 2）；生效值可见的时刻是**扫描器自己的 TaskRun CREATE**。但那一刻也有自己的陷阱——TaskRun 上 `tekton.dev/pipelineTask` 之类的标签可以经父运行的 `taskRunSpecs` 覆盖伪造，所以**绝不能用标签判断「这是不是门禁任务」**。
- **策略怎么分层**：① 先证来源——创建者必须是 Tekton 控制器 SA，携带控制器 ownerReference，并按 owner 查到**存活的**父运行核对 UID；② 再锁身份——父运行的 `pipelineRef` 必须恰好是 `tekton-templates/gated-build`，当前 `taskRef` 必须恰好是可信的扫描器；③ 然后才判断参数值，把**「缺失」与「显式空字符串」分开处理**——只有缺失才继承可信 Task 的默认值 `"true"`；显式的 `false` / 空字符串 / `TRUE` / `1` 全都过不了线。
- **覆盖不了什么**：deny 意味着门禁 TaskRun 干脆创建不出来；父运行的终态是 `CreateRunFailed`，且 **finally 不会运行**；若 finally 仍须运行，改用 [§4.2.2](#s4-2-2)（取消父运行）或 [§4.2.3](#s4-2-3)（把门禁 TaskRun 自身 mutate 成已取消状态）。

**关键判据**——先建立身份链，再判断值；用一个专门的存在性变量把「缺失」与「显式空字符串」分开（**片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
      # EXCERPT -- key conditions only, NOT a standalone manifest; the
      # indentation is kept from the full policy, so this block alone does
      # not parse. Apply the complete YAML from the details block below.
        # Only an absent param inherits the trusted Task default "true";
        # an explicit empty string is NOT absence
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: gateInvalid
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          # Identity chain: the parent run referenced by ownerReferences must be the
          # same live object
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ parentRun.metadata.uid }}"
          # Profile scope: both the parent template and the current Task must match
          # exactly (remaining identity fields are in the full YAML)
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: gated-build
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-scanner
      validate:
        deny:
          conditions:
            all:
              - key: "{{ gateInvalid }}"
                operator: Equals
                value: true
```

:::warning context.apiCall 够不到目标时会失败关闭——而且报错指向 APICall，不指向你的判据

本规则用 `apiCall` 按 ownerReference 查找父 PipelineRun 并核对其 UID。**查找失败（父对象缺失、API server 不可达、权限不足）不会降级成「skip」——整条规则报错，请求被拒绝。** 以 Tekton 控制器 SA 的身份提交一个 ownerReference 指向不存在父运行的 TaskRun，会得到：

```text
failed to evaluate preconditions: failed to substitute variables in condition value:
failed to resolve parentRun.metadata.uid at path : failed to fetch data for APICall:
failed to GET resource with raw url
```

两个后果都要清楚：① **方向是安全的**——查找完不成就什么都不放行；无主的门禁 TaskRun 绝不会被悄悄放进来；② **排障时不要被报错信息带偏**——它报的是 `APICall` 失败，不是「参数不合规」；看到它先检查 API server 可达性和 Kyverno 的读权限，而不是去改参数。当父运行已被删除时（例如级联清理进行到一半），本规则会让残留的子 TaskRun 无法创建——这正是预期行为。

:::

**预期形状**：用 `enableAnalyzeQualityGate: "false"` 运行 `gated-build`——控制器创建 `scan` TaskRun 的尝试在 admission 被拒，该错误被判为**永久性**，运行直接跌入终态（**不会无限重试**；但「永久」不等于「恰好一次尝试」——见 [§2.3](#s2-3) info 块的最后一条）；PipelineRun 很快到达终态 **`CreateRunFailed`**（从提交到终态通常在几十秒量级，取决于控制器的调度与重试节奏——不要当成固定值），condition 消息携带**完整策略消息**（策略名 / 规则名 / 带实际值的自定义文本）；`release` 永远不会被创建，finally 也不运行（[§2.3](#s2-3) 对比表第一行）。显式 `false`、显式空字符串、无法识别的值 `TRUE` 都会被拦；只有两个开关都缺失（继承可信默认值 `"true"`）或都显式为 `"true"` 的运行才被放行。

:::details 完整策略 YAML：gate-param-contract

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: gate-param-contract
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: scan-quality-gate-must-stay-on
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
                - policy-exempt-runs
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        # taskRunSpecs metadata can override Tekton's child labels. Derive the
        # parent from the controller ownerReference and verify the live UID.
        - name: parentRef
          variable:
            jmesPath: "request.object.metadata.ownerReferences[?kind=='PipelineRun' && controller==`true`] | [0]"
            default:
              name: ""
              uid: ""
        - name: parentName
          variable:
            jmesPath: "parentRef.name || ''"
            default: ""
        - name: parentUID
          variable:
            jmesPath: "parentRef.uid || ''"
            default: ""
        - name: parentRun
          apiCall:
            urlPath: "/apis/tekton.dev/v1/namespaces/{{ request.namespace }}/pipelineruns/{{ parentName }}"
        - name: parentPipelineResolver
          variable:
            jmesPath: "parentRun.spec.pipelineRef.resolver || ''"
            default: ""
        - name: parentPipelineKind
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: parentPipelineName
          variable:
            jmesPath: "parentRun.spec.pipelineRef.name || ((parentRun.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: parentPipelineNamespace
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Task identity comes from spec.taskRef, never from user-overridable labels.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # This exact Task identity is trusted and defaults both switches to "true".
        # Track presence separately so explicit "" is not mistaken for absence.
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        # Absence uses the pinned Task default. Any explicit value must equal true;
        # false, empty, TRUE and 1 are all invalid.
        - name: gateInvalid
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ parentRun.metadata.uid }}"
          - key: "{{ parentPipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ parentPipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: gated-build
          - key: "{{ parentPipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-scanner
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
      validate:
        failureAction: Enforce
        message: "every policy-demo-scanner child of gated-build must keep both quality-gate switches exactly equal to 'true' (got enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}')."
        deny:
          conditions:
            all:
              - key: "{{ gateInvalid }}"
                operator: Equals
                value: true
```

:::

**如何验证**：本节不附带单独的探针清单——复用 [§3.3](#s3-3) 的两个夹具，并按 [§3.4](#s3-4) 的第三类**真正跑一条流水线**（`--dry-run` 探针不行：deny 发生在 Tekton 控制器创建子 TaskRun 的那一刻，而不是你提交 PipelineRun 的那一刻——推理见 [§3.4.1](#s3-4-1)）：换一个 `metadata.name` 重建 `demo-run-gates-off`；策略未安装时它一路绿灯（[§3.3](#s3-3) 刻意暴露的绕过），策略安装后 `scan` TaskRun 必须创建失败，父运行以 `CreateRunFailed` 收场且 finally 不运行。也换个新名字重建 `demo-run-pass` 作为阳性对照——它的三个任务必须全部跑完，不受影响。**两个都要跑**——只跑阴性那个证明不了策略没有误伤。

本示例聚焦最关键的「开关不得被关掉」。扫描器的门禁**阈值 / 规则**（`analyzeQualityGateRules`）可以用同样的方式再加一条规则校验基线（例如必须包含一条阈值 ≥ 50 的覆盖率规则），写法参照 [§4.4.2](#s4-4-2) 的数值失败关闭模式（先用正则把值约束在 0–100，确认有界后才 `to_number`，避开 [§6.1.7](#s6-1-7) 的溢出与强制转换陷阱）。另外，参数展开覆盖的不止 `$(params.x)`——**上游 result 引用也会被解析**，所以「被绑定为下游参数的 result 值」同样可以在下游 TaskRun 的 CREATE 时由 admission 校验。

#### 4.2.2 用取消代替 deny：门禁拦截后 finally 仍须运行时（RunFinally） {#s4-2-2}

- **管什么**：与 [§4.2.1](#s4-2-1) **完全相同的事**（门禁开关不得被关掉），但响应不同——不拒绝创建；取消父 PipelineRun，让 finally 照常运行。
- **为什么难**：[§4.2.1](#s4-2-1) 的 deny 是硬拦截，代价是 `scan` TaskRun 创建不出来 → DAG 永远走不完 → **finally 不运行**（机制在 [§2.3](#s2-3) 有解释）。依赖 finally 做通知 / 资源清理的团队会撞上「门禁拦截时 finally 悄悄不运行」。
- **策略怎么分层**：① 检测点与 [§4.2.1](#s4-2-1) 完全一致（scan TaskRun CREATE + 同一条身份链）→ ② 命中时不 deny——用 **mutate-existing** 去修补 owner 所指的**同一个父 PipelineRun** → ③ 写入 `spec.status: CancelledRunFinally`（「取消 DAG、仍跑 finally」的语义）+ 一个携带原因的 annotation。
- **覆盖不了什么**：mutate-existing 是**异步的**，存在竞态窗口（见下方警告）；而且取消形态下的 condition 只带通用的 `was cancelled` 文本——不像 deny 那样把完整策略消息透传出来——所以原因必须自己写进 annotation。

**这是本文若干取消路径之一**（还有两条机制相同、判据不同：[§4.6.1](#s4-6-1) 的 result 不达标、[§4.6.2](#s4-6-2) 的定义漂移）；「何时检测、动到什么、同步还是异步、证据去哪收」的总表在 [§4.6](#s4-6) 引言——**那张表才是取消路径的权威清单**。

:::warning 三个前提与边界——安装前必读

**① RBAC 前提**：mutate-existing 需要 background-controller 持有对 `pipelineruns` 的 update 权限，且 **Kyverno 在策略创建时就校验这份 RBAC；没有它策略会直接安装失败**——ClusterRole、先授权后安装的顺序及其传播检查、示例报错都在 [§4.6](#s4-6) 引言（由三条 mutate-existing 取消路径共享——本节与 [§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2)；[§4.2.3](#s4-2-3) 的 admission mutate 不需要它；此处不再重复配置）。本节需要专门记住的一点：**创建时的授权检查不会对 `{{ request.namespace }}` 求值**——当 `mutate.targets[].namespace` 写成变量时，Kyverno 只认**集群级**的 update 权限；因此「用 namespace 级 Role 只治理单个固定 namespace」这条捷径要求把 `targets[].namespace` 也写成**字面量**（本节正文中的清单正是这么写的；`targets` 注释给出跨 namespace 变体）——只加 Role 是不够的，而且报错看起来与「完全没授权」一模一样。**不要混淆两件事**：`match.resources.namespaces` 决定**哪些请求触发规则**；`targets[].namespace` 决定**修补哪个 namespace 的对象**；要「装一次但只在部分 namespace 生效」，收窄前者（或用 `namespaceSelector`）。

**①b 安装本节策略时 Kyverno 会打印一条无关警告** `Warning: You are matching on status but not including the status subresource...`——它由补丁中的 `spec.status`（Tekton 的取消字段）触发；本规则匹配的是 TaskRun **CREATE**，从不触碰 status 子资源；忽略即可。

**② 竞态**：mutate-existing 由 background controller **异步**执行——彼时 `scan` TaskRun 已被准入，甚至可能已开始运行；取消补丁要晚一拍才落地。如果扫描器很快跑完（例如门禁关掉后它自己不再失败、直奔 Succeeded），后面的 release 可能在取消落地前就被调度。**这不是「零竞态硬拦截」，而是「一经检测立即取消」**——要零竞态，用 [§4.2.1](#s4-2-1) 的 deny 或 [§4.2.3](#s4-2-3) 的 admission mutate。

**③ 防伪造 DoS**：由于 `taskRunSpecs[].metadata.labels` 能覆盖子 TaskRun 的 `tekton.dev/pipelineRun`，仅靠「禁止裸 TaskRun」（[§4.5.4](#s4-5-4)）并不够——否则攻击者可以把标签指向别人的 Pending 运行，让策略替他把那条运行取消。本策略完全无视该标签：只接受 Tekton 控制器 SA 创建的 TaskRun，读取控制器 ownerReference，用 `apiCall` 回查父运行并核对 UID，再从父级的 `spec.pipelineRef` 和当前 `spec.taskRef` 判断画像。带伪造标签的攻击运行只能取消它自己；它指向的受害运行不受影响。

:::

**关键判据**——命中时，补丁瞄准 owner 所指的父运行，`targets` 用 name + uid 双重锁定：

```yaml
      mutate:
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ parentName }}"
            uid: "{{ parentUID }}"
            namespace: policy-poc
        patchStrategicMerge:
          metadata:
            annotations:
              policy.alauda.io/cancel-reason: >-
                scan quality-gate switches were not exactly true
                (enableScanQualityGate='{{ scanQG }}',
                enableAnalyzeQualityGate='{{ analyzeQG }}'); cancelled in
                RunFinally mode so finally tasks still run
          spec:
            status: CancelledRunFinally
```

:::details 前置 RBAC：namespace 级 Role + RoleBinding

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: kyverno-background-pipelineruns
  namespace: policy-poc
rules:
  - apiGroups:
      - tekton.dev
    resources:
      - pipelineruns
    verbs:
      - get
      - list
      - watch
      - update
      - patch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: kyverno-background-pipelineruns
  namespace: policy-poc
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: kyverno-background-pipelineruns
subjects:
  - kind: ServiceAccount
    name: kyverno-background-controller
    namespace: kyverno
```

:::

:::details 完整策略 YAML：gate-param-cancel-existing

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: gate-param-cancel-existing
spec:
  webhookConfiguration:
    # Fail, unlike the other two cancellation triggers (§4.6.1 / §4.6.2, Ignore on
    # their */status match): this trigger sits on main-resource TaskRun CREATE and
    # guards the same admission gate as §4.2.1's deny. With Ignore, a Kyverno
    # outage would let non-compliant gate TaskRuns through with no cancel and no
    # retro-scan (background: false) -- a permanent silent bypass. The
    # availability cost is the one already accepted for §4.2.1 (§3.7 tiering).
    failurePolicy: Fail
  background: false
  rules:
    - name: cancel-parent-on-invalid-scan-gate
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        # Child labels are user-overridable through taskRunSpecs metadata.
        - name: parentRef
          variable:
            jmesPath: "request.object.metadata.ownerReferences[?kind=='PipelineRun' && controller==`true`] | [0]"
            default:
              name: ""
              uid: ""
        - name: parentName
          variable:
            jmesPath: "parentRef.name || ''"
            default: ""
        - name: parentUID
          variable:
            jmesPath: "parentRef.uid || ''"
            default: ""
        - name: parentRun
          apiCall:
            urlPath: "/apis/tekton.dev/v1/namespaces/{{ request.namespace }}/pipelineruns/{{ parentName }}"
        - name: parentPipelineResolver
          variable:
            jmesPath: "parentRun.spec.pipelineRef.resolver || ''"
            default: ""
        - name: parentPipelineKind
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: parentPipelineName
          variable:
            jmesPath: "parentRun.spec.pipelineRef.name || ((parentRun.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: parentPipelineNamespace
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Materialized switches on the scan TaskRun. The pinned Task defaults to true,
        # but explicit empty values are not absence and must remain invalid.
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        - name: gateInvalid
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ parentRun.metadata.uid }}"
          - key: "{{ parentPipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ parentPipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: gated-build-with-prep
          - key: "{{ parentPipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-scanner
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ parentName }}"
            operator: NotEquals
            value: ""
          # Fire only when either switch is not exactly the trusted value true.
          - key: "{{ gateInvalid }}"
            operator: Equals
            value: true
      mutate:
        # mutate-existing: patch a DIFFERENT resource (the parent PipelineRun) in
        # response to this TaskRun CREATE event. A literal namespace keeps the
        # create-time auth check satisfied by a namespaced Role; switch it to
        # "{{ request.namespace }}" plus the aggregated ClusterRole to govern
        # every namespace with one policy -- see the discussion above.
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ parentName }}"
            uid: "{{ parentUID }}"
            namespace: policy-poc
        patchStrategicMerge:
          metadata:
            annotations:
              policy.alauda.io/cancel-reason: >-
                scan quality-gate switches were not exactly true
                (enableScanQualityGate='{{ scanQG }}',
                enableAnalyzeQualityGate='{{ analyzeQG }}'); cancelled in
                RunFinally mode so finally tasks still run
          spec:
            status: CancelledRunFinally
```

:::

:::details 用于验证的阳性与阴性 PipelineRun

```yaml
# Negative case: prep completes, then the invalid scan switches trigger
# CancelledRunFinally. release is skipped and notify still runs.
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: gate-cancel-invalid
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build-with-prep
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
    - name: enableScanQualityGate
      value: "false"
    - name: enableAnalyzeQualityGate
      value: "false"
    - name: demoDelaySeconds
      value: "30"
---
# Positive case: the same profile keeps both trusted defaults and completes.
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: gate-cancel-compliant
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build-with-prep
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
    - name: demoDelaySeconds
      value: "1"
```

:::

**预期形状**：违规运行中（显式 `false` 或显式空字符串），`prep` 成功，`scan` 被取消，`release` 以 `PipelineRun was stopping` 被跳过，父运行带上 `spec.status=CancelledRunFinally`、终态为 `Cancelled`（当取消与任务失败竞速时也可能是 `Failed`——策略是否生效以 `spec.status` 和 `cancel-reason` 为准，[§2.3](#s2-3) / [§4.6.1](#s4-6-1)），`cancel-reason` annotation 存在，且 **finally 的 `notify` 正常成功**；合规运行中，`prep / scan / release / notify` 全部成功，父运行为 `Succeeded`。

注意这只证明触发接线与 finally 行为是对的；**它并不消除竞态窗口**。还有一个与成本相关的边界：TaskRun 可能已被标记 `TaskRunCancelled`，而它的 Pod 在并发创建路径上已经启动、并会一直跑到进程退出——所以这不是「立即杀掉计算」的强保证；在成本敏感的场景里，仍要给任务设置合理超时，并对照实际的 Pod 终止行为做验证。

**为什么不干脆在 PipelineRun CREATE 就取消？** 这里其实是两个问题。**第一，CREATE 时到底能不能判**：那一刻只能看到显式写进 PipelineRun 的参数（那部分属于提前 deny 的辅路径；[§4.2.5](#s4-2-5) 是真实模板实例）；本节要管的**生效值**——缺失参数所继承的默认值发生漂移、或被覆盖——要到控制器创建 `scan` TaskRun 时才可见；CREATE 时根本没有可判的东西。**第二，取消是不是正确的选择**：不是——deny 才是；取消的价值**恰恰在于门禁之前已经跑过真实工作**，finally 才有东西可通知 / 可清理；CREATE 时什么都没跑，「空的 finally」只是一个更绕的 deny。在 [§3.3](#s3-3) 基线模板 `gated-build` 里，`scan` 是**第一个任务**——正好落在「什么都没跑」一侧——所以那里用 [§4.2.1](#s4-2-1) 的同步 deny 更干净；本节刻意使用 `gated-build-with-prep`，先让 `prep` 完成，再在 scan CREATE 时触发取消。选择规则因此很简单：**扫描器是第一个任务 → 用 deny；扫描器之前有需要 finally 收尾的真实工作 → 才用取消。**

| 维度 | deny（[§4.2.1](#s4-2-1)） | 取消 · mutate-existing @ scan TaskRun（[§4.2.2](#s4-2-2)） |
|---|---|---|
| 运行终态 | `CreateRunFailed` | `Cancelled` |
| 扫描器之前的任务（如 `build` / `test`） | 已经跑过的照跑 | 已经跑过的照跑（在扫描器之前已完成） |
| **finally** | **不运行** | **运行**（为已跑过的真实任务做通知 / 清理） |
| 门禁原因可见性 | condition 中携带完整策略消息 | 通用文本 + `cancel-reason` annotation |
| 是否要求门禁开关暴露在 PipelineRun 层？ | 否 | **否**（读取 scan TaskRun 上展开后的生效值） |
| 同步 / 竞态 | 同步硬拦截 | 异步，存在竞态窗口 |
| 前提 | 无 | background-controller 的 `pipelineruns` update RBAC |
| 适用 | 扫描器是第一个任务，不需要 finally 收尾，想要立即硬拦截 + 完整原因 | 扫描器之前有真实工作且 finally 必须通知 / 清理；接受「取消略晚于检测」 |

#### 4.2.3 admission-mutate 取消：deny 的同步替代（取消门禁 TaskRun 自身） {#s4-2-3}

- **管什么**：使用与 [§4.2.1](#s4-2-1) **完全相同的完整身份链与同一组判据**（父 Pipeline 画像、存活父运行 UID、当前 Task 画像、以及两个门禁开关——一个都不能省），以第三种响应形态——**不拒绝门禁 TaskRun 的创建；在同一次 admission 中把它 mutate 成「已取消」**。
- **为什么难**：deny 会让这个 DAG 节点**根本不存在**——DAG 永远到不了完成态，finally 被饿死；[§4.2.2](#s4-2-2) 能让 finally 运行，代价却是异步竞态和额外 RBAC。两者都不理想。
- **策略怎么分层**：① 同样锁定 Tekton 控制器为创建者、以及 Task 的 resolver 坐标 → ② 命中不合规开关时，执行一次 admission `mutate` → ③ 把 `spec.status: TaskRunCancelled` 和 `spec.statusMessage: <reason>` 写到该 TaskRun 上。
- **本文取消路径中唯一同步的一条**——其余几条（[§4.2.2](#s4-2-2) 取消父运行、[§4.6.1](#s4-6-1) 的 result 不达标、[§4.6.2](#s4-6-2) 的定义漂移）都是事后异步动作；完整表格在 [§4.6](#s4-6) 引言。
- **管不住什么**：它**不产生 PolicyReport 违规记录**（见下方警告）；也**不适用于裸 TaskRun 入口**——本节的三种响应形态（[§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3)）都用 `subjects` 只匹配 Tekton 控制器创建的子 TaskRun，**没有一个能拦住用户手工创建的裸 TaskRun**；那条路径完全归 [§4.5.4](#s4-5-4) 的入口收口负责。

让它成立的是 Tekton 的状态机：mutate 成取消让这个节点**以失败姿态存在**——TaskRun 调和器在构建 Pod 之前就判定它已被取消并直接收尾；节点到达完成态，DAG 走完，finally 照常被调度。治理效果等同 deny（门禁的容器一秒都没跑过），但状态机保持完整：

- **不启动任何容器**：取消判定发生在 reconcile 的最前端——`podName` 保持为空，不会创建 Pod，也就不会拉取镜像；
- **不消耗重试次数**：Tekton 的重试分支明确排除已取消的 TaskRun——甚至比门禁任务 `exit 1` 更干净（后者会消耗 `retries`）；
- **原因可见**：`statusMessage` 被逐字拼接进 TaskRun 的失败 condition——`tkn` 和控制台直接展示它，不依赖 webhook 返回什么 HTTP 码；
- **需要你适配的**：父运行的终态 reason 是 `Cancelled`，**不是** `Failed`——按 `Failed` 过滤的告警 / 监控面板必须把 `Cancelled` 加上。

**关键判据**——命中时写入两个字段；取消原因随对象一起走：

```yaml
      mutate:
        patchStrategicMerge:
          metadata:
            annotations:
              # Machine-readable trail: the TaskRun condition carries the human
              # message, this annotation carries the policy verdict.
              policy.alauda.io/cancel-reason: "a quality-gate switch was explicitly set to a non-'true' value (enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}'); an ABSENT switch is not a violation -- it inherits the trusted Task default"
          spec:
            status: TaskRunCancelled
            statusMessage: "Cancelled by policy gate-param-mutate-to-cancel: a quality-gate switch was explicitly set to a non-'true' value (enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}'); the values above show which."
```

:::warning 审计盲区：mutate 规则不产生 PolicyReport 违规记录

在 PolicyReport 里，被取消的 TaskRun 显示为 `result=skip`、消息为 `no patches applied`（等 reports-controller 重新求值时，对象已处于目标状态）——**不是 `fail`**。所以「哪些运行被策略取消了」只能通过 TaskRun 的 `statusMessage` / annotation 追溯，或由一条专为此事设置的 [§4.4](#s4-4) Audit 规则单独记账。

安装本策略时，Kyverno 会打印 `You are matching on status but not including the status subresource in the policy`（因为补丁触碰了 `spec.status`）——这是一个启发式提示；不影响执行。

**不要把它当成裸 TaskRun 入口的防线**：本规则的 `subjects` 只匹配 Tekton 控制器创建的子 TaskRun；用户手工创建的裸 TaskRun **永远进不了这条规则**——收口裸入口是 [§4.5.4](#s4-5-4) 的活。

即使你把 `subjects` 去掉、让它也匹配用户创建的 TaskRun，也不该那么用：mutate 成取消**不抛任何同步错误**——创建者只会得到一个「创建成功却在下一瞬间被取消」的对象，排障成本远超一条 deny 消息。裸入口要的是 deny，不是无声的取消。

:::

:::details 完整策略 YAML：gate-param-mutate-to-cancel

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: gate-param-mutate-to-cancel
spec:
  webhookConfiguration:
    failurePolicy: Fail
  # Admission-time mutation only. The subjects selector below is not allowed in
  # background mode, and no background scanning is needed for this response.
  background: false
  rules:
    - name: cancel-scan-taskrun-on-invalid-gate
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
                - policy-exempt-runs
            # Only TaskRuns materialized by the Tekton controller are in scope.
            # A bare TaskRun created by a user never reaches this rule -- closing that
            # entry point is §4.5.4's job, not this policy's.
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        # Keep the same parent identity chain as §4.2.1. Pinning only the current
        # Task would widen this response to every Pipeline that happens to reuse it,
        # so it would no longer be an interchangeable response to the same profile.
        - name: parentRef
          variable:
            jmesPath: "request.object.metadata.ownerReferences[?kind=='PipelineRun' && controller==`true`] | [0]"
            default:
              name: ""
              uid: ""
        - name: parentName
          variable:
            jmesPath: "parentRef.name || ''"
            default: ""
        - name: parentUID
          variable:
            jmesPath: "parentRef.uid || ''"
            default: ""
        - name: parentRun
          apiCall:
            urlPath: "/apis/tekton.dev/v1/namespaces/{{ request.namespace }}/pipelineruns/{{ parentName }}"
        - name: parentPipelineResolver
          variable:
            jmesPath: "parentRun.spec.pipelineRef.resolver || ''"
            default: ""
        - name: parentPipelineKind
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: parentPipelineName
          variable:
            jmesPath: "parentRun.spec.pipelineRef.name || ((parentRun.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: parentPipelineNamespace
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Identify the resolved Task by its resolver coordinates, never by child
        # labels: a PipelineRun can override those through taskRunSpecs.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Absence inherits the trusted Task default ("true"); an explicit empty
        # string is not absence and must stay invalid.
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        # Exact string comparison, computed in JMESPath so no Kyverno operator
        # coercion can touch it. BOTH switches are covered here, exactly as in §4.2.1:
        # this section is one of three interchangeable RESPONSES to the same criterion,
        # so it must judge the same criterion -- covering only one switch would let a run
        # that disables the OTHER one through, and the response-form table would be
        # comparing options that do not govern the same thing.
        - name: gateInvalid
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ parentRun.metadata.uid }}"
          - key: "{{ parentPipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ parentPipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: gated-build
          - key: "{{ parentPipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-scanner
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
          # Do NOT write `key: {{ scanQG }} / operator: NotEquals / value: "true"`.
          # Kyverno operators coerce numeric-looking strings, so a forged value such
          # as "1" makes NotEquals return false and the cancellation never fires --
          # a fail-open. Compute the comparison as a JMESPath boolean instead (§6.1.7).
          # Absence is NOT a violation: an absent switch inherits the trusted Task
          # default "true" (§2.1 observation 4), so only an explicit non-true value
          # reaches this condition -- that is what the two `*Present` guards inside
          # gateInvalid are for.
          - key: "{{ gateInvalid }}"
            operator: Equals
            value: true
      mutate:
        patchStrategicMerge:
          metadata:
            annotations:
              # Machine-readable trail: the TaskRun condition carries the human
              # message, this annotation carries the policy verdict.
              policy.alauda.io/cancel-reason: "a quality-gate switch was explicitly set to a non-'true' value (enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}'); an ABSENT switch is not a violation -- it inherits the trusted Task default"
          spec:
            status: TaskRunCancelled
            statusMessage: "Cancelled by policy gate-param-mutate-to-cancel: a quality-gate switch was explicitly set to a non-'true' value (enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}'); the values above show which."
```

:::

**跑本节演示前先卸载 [§4.2.1](#s4-2-1) 的策略**（三个响应策略为何是互斥选择，完整说明在本章清理段落之前的警告里；这里把它提前到你最容易绊倒的确切位置）：`gate-param-contract` 还装着时，同一个违规 scan TaskRun 会先被它拒掉——mutate 确实在 admission 链中更早执行、也已把 `spec.status` 写成 `TaskRunCancelled`，但 validate 阶段读到的参数原封未动，照样 deny——运行的终态是 [§4.2.1](#s4-2-1) 的 `CreateRunFailed`，本节的取消形态**完全不可见**。继续之前用 [§4.0.4](#s4-0-4) 的 UID 辅助命令删除 `gate-param-contract`；[§4.2.2](#s4-2-2) 的策略不冲突——它锁的父级是 `gated-build-with-prep`。

**拿什么来跑**：本节同样不附带单独的运行清单——再次复用 [§3.3](#s3-3) 的 `demo-run-gates-off`（两个开关都是 `"false"`；换个 `metadata.name` 重建即可）；下文的「单独验证第二个开关」是指把该夹具再复制一份，只保留 `enableAnalyzeQualityGate` 为 `"false"`，把 `enableScanQualityGate` 写成 `"true"`。阳性对照仍是 `demo-run-pass`。按 [§3.4.1](#s3-4-1) 的**第 3 类**收集证据——读对象自身的 `spec.status` 和 annotation（命令在 [§6.2.3](#s6-2-3)），而不是 admission 响应。

**预期形状**：不合规运行（`enableScanQualityGate="false"`）——`scan` TaskRun 落进集群，带着 `spec.status=TaskRunCancelled` 且 `spec.statusMessage` 被保留；其终态 condition 为 `False / TaskRunCancelled`，消息为 `TaskRun "<name>" was cancelled. <statusMessage verbatim>`；`podName` 为空，运行之下唯一的 Pod 属于 finally（门禁容器从未启动）；`release` 以 `PipelineRun was stopping` 被跳过；finally 的 `notify` 正常到达 `Succeeded`；父运行以 `False / Cancelled` 收场，消息类似 `Tasks Completed: 2 (Failed: 0, Cancelled 1), Skipped: 1`。合规运行中三个任务全部跑完、无跳过——策略没有误伤。**单独验证第二个开关**——只把 `enableAnalyzeQualityGate` 设为 `"false"`、另一个保持 `"true"` 的运行同样被取消（父运行 `False / Cancelled`，门禁 TaskRun `spec.status=TaskRunCancelled`，且 `statusMessage` 打印两个开关的实际值）；如果只验证过第一个开关，「本节与 [§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) 判的是同一件事」这个说法就从未被验证过。

**三种响应形态的取舍**：下表比较的是把三种响应映射到**同一套可信父 Pipeline + 门禁 Task 画像**之后的机制差异。本文 [§4.2.2](#s4-2-2) 的演示夹具为了展示 finally 用了单独的父 Pipeline 名 `gated-build-with-prep`；生产选型时必须把三个策略的父 / 子画像指向同一组真实身份——不要把三份演示 YAML 原样当成可互换的资产。

| 维度 | deny（[§4.2.1](#s4-2-1)） | mutate-existing 取消父运行（[§4.2.2](#s4-2-2)） | admission-mutate 取消门禁 TaskRun（[§4.2.3](#s4-2-3)） |
|---|---|---|---|
| 运行终态 | `CreateRunFailed` | `Cancelled` | `Cancelled` |
| **finally** | **不运行** | **运行** | **运行** |
| 同步 / 竞态 | 同步硬拦截 | 异步，存在竞态窗口 | **同步硬拦截，无竞态窗口** |
| 额外 RBAC | 无 | background-controller 的 `pipelineruns` update | **无** |
| 门禁原因可见性 | condition 中携带完整策略消息 | 通用文本 + `cancel-reason` annotation | `statusMessage` 逐字出现在 TaskRun condition 中 |
| PolicyReport 违规记录 | 有（Audit 模式下） | 无 | 无 |
| 对裸 TaskRun 入口 | **不适用**（同样被 `subjects` 限定） | 不适用 | 不适用 |
| 裸入口归谁管 | [§4.5.4](#s4-5-4) 入口收口 | [§4.5.4](#s4-5-4) 入口收口 | [§4.5.4](#s4-5-4) 入口收口 |
| 适用 | 不需要 finally 收尾；立即硬拦截 + 完整原因 | 已有 mutate-existing 体系；可接受「取消略晚于检测」 | finally 必须照常运行、同步零竞态、且不想要额外 RBAC |

#### 4.2.4 受保护分支门禁契约（真实画像：sonarqube-scanner） {#s4-2-4}

- **管什么**：**合入受保护分支之后的构建，其代码扫描必须保持严格门禁**——`main` / `release-*` 的分支分析不得显式关掉门禁开关，也不得调包扫描源。**PR / feature 分支构建不带分支 admission 约束**：PR 阶段的门禁是尽力而为（本节规则 ④，选装）；合入之后，规则 ③ 在**请求参数层**提供严格约束，只有当仓库、`sonar-settings`、`sonar-credentials` 的内容治理同样成立时，它才上升为端到端保证（见下方信任边界警告）。**输入必须是规范形态**——契约之外的形状（注释行、行首空白、经 `sonarProperties` 走的受管键等）一律拒绝而不解释；见规则 ②。
- **为什么难**：admission 层**没有可信的「PR 目标分支」信号**——平台没有独立的 targetBranch 字段；一切都搭在 PipelineRun 参数上。而在 PR 分析模式下，分支参数本身是**惰性的**（Task 检测到非空 `sonar.pullrequest.key` 时会移除 `sonar.branch.name`）。对一个在某些场景根本不生效的参数做无条件断言，必然把那些场景整体拦死——所以门禁判据必须是**有条件的**：只适用于分支分析目标为受保护分支（或参数缺失时为默认分支）的运行。另一个难点是 `sonarProperties` 这类数组参数的自由度：注释行、行首空白、重复声明、藏在一个元素里的换行……每种形状在 Task 内部都有自己的解释，逐一建模是一条永不收敛的路（教训在下方第一个警告里）。本节的答案是**先用规范形态门把输入面收窄**；其余所有判据只对规范形态成立。判定点仍在 TaskRun 层（参数以展开后的值写进扫描器 TaskRun——零模板改动），身份仍锁定真实 taskRef（子级标签可经 `taskRunSpecs` 伪造）。
- **策略怎么分层**：① `hub-source-integrity`——对 `catalog/sonarqube-scanner/0.7` 的**每一个** TaskRun 验证 Hub 来源未被调包（拒绝请求级 `url`、拒绝多个 `type`、显式 `type` 只能是 `artifact`）；**场景无关**，Enforce → ② `sonar-props-normative-form`——**规范形态门**，同样场景无关，Enforce：每个 `sonarProperties` 元素必须恰好是一条规范的 `key=value`（键以字母开头、无行首空白、无 `#`、无换行）；受管键（`sonar.branch.name` / `sonar.host.url` / `sonar.projectKey` / 凭证类键 / `sonar.qualitygate.*`）不得经 `sonarProperties` 传递，只能走各自的专用参数；`sonar.pullrequest.key` / `.base` 允许出现（push 事件上平台会以空 key 注入整组，且官方模板没有它们的专用参数），但各至多一条，值中不得含空白。**契约之外的形状一律直接拒绝、绝不解释**——这是本节从「复刻 Task 的解析语义」收敛到「收窄受支持面」之后的落点（见下方第一个警告）→ ③ `protected-branch-gates-strict`——生效分支只从 `sonarBranchName` 参数读取（规则 ② 已把**请求参数之内**的其他入口全部拒绝）：只有当该值匹配 `^(main|release-.*)$` **或缺失 / 为空**（此时扫描器分析项目的默认分支——正是受保护对象；SonarQube Community Edition 不支持分支分析、只能省略该参数，这一处理把它纳入治理而不是误拒），且请求参数不携带非空 PR key 声明时才进入规则；任一门禁开关**显式传入且 ≠ `"true"` 即 deny**（缺失 = 继承 Task 的可信默认值 `"true"`，放行），Enforce；PR / feature 构建在前置条件处就跳过 → ④ `pr-target-protected-gates-audit`（选装）——当声明了**非空 `sonar.pullrequest.key`**（真实 PR 分析；空 key 的 push 注入形状不进入）且 `sonar.pullrequest.base=` 指向受保护分支时，要求 PR 也不得显式关掉门禁开关，Audit。**漏传 / 传错就只是跳过——方向天然 fail-open**——一旦承认「PR 目标分支只能来自用户提供的参数、不可信」，这就是明确接受的取舍。
- **管不住什么**：ⓐ「受保护分支的构建必须**真的跑**扫描」——`sonarURL` 为空时扫描任务被模板的 `when` 整体跳过，根本不产生 TaskRun，admission 什么也看不见（PipelineRun 层判据在 [§4.2.5](#s4-2-5)，跳过审计在 [§4.1.5](#s4-1-5)）；ⓑ PR 门禁的可信度——`sonar.pullrequest.base` 是用户可控参数；规则 ④ 只能尽力而为；ⓒ「合入受保护分支必然触发构建」属于平台的触发配置，是本节的**信任根**（与 [§5.0](#s5-0) 同级治理）；ⓓ **仓库 / workspace / 凭证中的属性文件**——admission 看不见 `sonar-project.properties`、`sonar-settings`、`sonar-credentials` 的内容：分支值一侧已经闭合（参数非空时 Task 用参数覆盖文件值；参数缺失时判据直接把该运行视为受保护范围——文件里写什么都改变不了 admission 结论）；剩下的路径是这些内容源之一注入**非空 `sonar.pullrequest.key`**、把 Task 翻转进 PR 模式——见下方信任边界警告。

**模板接线事实（判据锚点的依据，取自 catalog 源码：`task/sonarqube-scanner/0.7/sonarqube-scanner.yaml` 中的 `apply_branch_name_property` 函数，以及 `pipeline/java-image-build-scan-deploy/0.3` 的 sonar 参数透传块——两者都在你环境的 catalog 仓库里，可逐行核对）**：官方 0.3 模板把 `sonarBranchName` 硬接到 **`$(params.gitRevision)`**——构建哪个 revision 就传哪个；调用方无法独立指定分析目标。两个门禁开关 `enableScanQualityGate` / `enableAnalyzeQualityGate` **没有被透传**（模板只透传 `sonarHostURL` / `sonarProjectKey` / `sonarBranchName` / `sonarProperties` 四个参数），因此它们停留在 Task 侧默认值 `"true"`。所以对官方模板的运行而言，规则 ③ 是**纵深防御**：缺失的开关总是放行；它真正拦的是绕开模板接线、显式关掉开关的自建 / 改装形状。而「这是不是受保护分支的构建」锚定在 `sonarBranchName` 的取值上。

**平台触发链的参数映射（规则 ③ 锚点背后的前提）**：

- **合入后触发（push）**：revision 类参数是**分支名**（如 `release-4.10`），不是 commit SHA——commit SHA 走单独的 `git-commit` 参数，`pull-request-number` 是空占位。→ 规则 ③ 的「分支名锚点」在平台的 PaC 触发链上（携带 `pipelinesascode.tekton.dev/*` 标签的运行）**成立**。
- **PR 触发**：revision 是**源分支名**，伴随 `target-branch`（目标分支）和非空的 `pull-request-number`。→ 源分支名不匹配受保护正则 → 规则 ③ 跳过，PR 构建不被拦——正是设计行为。
- **切换环境 / 触发绑定时必须成立的唯一前提**：revision 类参数映射到分支名，而不是 SHA；若某环境的绑定把它映射成 SHA，规则 ③ 的锚点就失效——修触发绑定或换锚点。**这是本节唯一无法从策略自身验证的信任前提；怎么核查**：取一条真实的平台触发运行，看 revision 类参数的值是分支名还是 40 位十六进制字符（`kubectl -n <ns> get pipelinerun <run> -o jsonpath='{.spec.params}'`），或直接读触发绑定里的变量映射（PaC 在 `.tekton/*.yaml` 中用 `{{revision}}` / `{{source_branch}}` / `{{target_branch}}`）。
- **顺路的一个升级机会**：PR 事件在触发层已携带 `target-branch`（比 `sonar.pullrequest.base` 更靠近事件源，由触发器注入而非用户手敲）。官方模板目前没有把它透传给扫描器；哪天模板把 target-branch 透传了，规则 ④ 就应把锚点切过去，并可评估升格为 Enforce——信任根仍是「由平台触发链创建的运行」；手工构造的运行仍可伪造该参数，那一层由 [§4.5.4](#s4-5-4) 的入口收口兜底。

**关键判据**（规则 ② 规范形态门 + 规则 ③ 门禁）——先整体拒绝契约之外的形状，再按分支参数把「对受保护分支（或默认分支）的分析」圈进来，最后对「门禁被显式关掉」执行 deny；PR / feature 构建在规则 ③ 的前置条件处就跳过（**片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
      # EXCERPT -- key conditions only, NOT a standalone manifest; the
      # indentation is kept from the full policy, so this block alone does
      # not parse. Apply the complete YAML from the details block below.
        # Rule 2 (normative-form gate): pin the INPUT SHAPE instead of
        # modelling how the Task would parse arbitrary shapes. Anything
        # outside this form is rejected, not interpreted. The branch param is
        # a SEPARATE entrance -- it is written into the properties file
        # verbatim, so a line break in it smuggles a second sonar.branch.name
        # line; ban CR/LF there too.
        - name: branchParamBad
          variable:
            jmesPath: "regex_match('^[^\\r\\n]*$', branchParam) == `false`"
        - name: propsNonCanonical
          variable:
            jmesPath: "length(sonarPropsItems[?regex_match('^[A-Za-z][A-Za-z0-9._-]*=[^\\r\\n]*$', @) == `false`]) > `0`"
        - name: propsGovernedKey
          variable:
            jmesPath: >-
              length(sonarPropsItems[?starts_with(@, 'sonar.branch.name=')
                || starts_with(@, 'sonar.host.url=')
                || starts_with(@, 'sonar.projectKey=')
                || starts_with(@, 'sonar.login=')
                || starts_with(@, 'sonar.token=')
                || starts_with(@, 'sonar.password=')
                || starts_with(@, 'sonar.qualitygate.')]) > `0`
        - name: prClaimBad
          variable:
            jmesPath: "prKeyClaimCount > `1` || prBaseClaimCount > `1` || prClaimWhitespace"
      # ...(deny when any of the four is true)
        # Rule 3 (the request-parameter guarantee), judged on the NARROWED input only: the
        # branch anchor is the sonarBranchName param -- rule 2 has made it the
        # only entrance -- and "claims PR analysis" is one equality test.
        - name: prKeyNonEmpty
          variable:
            jmesPath: "prKeyClaim != '' && prKeyClaim != 'sonar.pullrequest.key='"
      preconditions:
        all:
          # ...(identity preconditions omitted: resolver=hub / kind=task / catalog / name / version=0.7)
          # Scope gate: only branch-mode analyses of a protected branch enter.
          # An ABSENT / blank sonarBranchName is IN scope: the scanner then
          # analyses the project's DEFAULT branch -- the protected mainline.
          # A PR / feature build fails one of the two tests and SKIPS.
          - key: "{{ (regex_match('^(main|release-.*)$', branchParam) || regex_match('^[[:space:]]*$', branchParam)) && !prKeyNonEmpty }}"
            operator: Equals
            value: true
      validate:
        deny:
          conditions:
            any:
              - key: "{{ gateWeakened }}"
                operator: Equals
                value: true
```

**本节里「缺失」的语义一分为三**——`sonarBranchName` 缺失或为空：**落入规则 ③ 的受保护范围**（没有分支值时扫描器分析项目的默认分支——正是受保护对象；SonarQube Community Edition 不支持分支分析、只能省略该参数，这一处理把它纳入治理而不是误拒或豁免）；门禁开关缺失：继承 Task 的可信默认值 `"true"` 并放行（官方模板本来就不透传这两个参数）；`sonarBranchName` 非空但不匹配受保护正则：规则 ③ **跳过**并放行——PR / feature 构建不带分支 admission 约束。真正无条件失败关闭的是规则 ①（hub 来源被调包）和规则 ②（规范形态），它们在所有场景下都 deny。

:::warning 为什么不复刻 Task 的解析语义：那条路永不收敛——收窄输入面才会收敛

`sonarProperties` 是一个**数组**参数，Task 把它逐元素合并进 `sonar-project.properties`（`writePropertiesBatch` → `replaceValues`，同键后值覆盖前值），随后这个文件被**两拨代码**消费：中段那几个 `^[#]*\s*<key>=` grep（决定 PR 还是分支模式、哪些行被删除），以及最终真正决定「扫哪个分支」的 `java.util.Properties`（`#` 行是注释、行首空白被丢弃、`tr -d ' '` 删空格但不删 Tab……）。本节曾沿着「转写消费方语义」这条路迭代判据——每一轮修掉一批绕过 / 误拒，每一轮又暴露下一批：注释掩护、行首换页符、Tab 值的 PR key、一个元素内嵌换行变成两条属性行。根因不是某个正则不够严，而是**这个承诺本身闭合不了**：Task 合并的属性来源除了请求，还有仓库和 workspace 里的文件（见信任边界警告），admission 永远只看得见其中一部分——而精度每加一格，判据就与 Task 的私有实现深耦合一格，Task 一升级就是一次错配。

于是本节改为**收窄受支持面**：规则 ② 只允许规范形态——`sonarBranchName` 不含换行、每个 `sonarProperties` 元素恰好是一条规范 `key=value`、受管键走专用参数、PR 声明唯一且值不含空白——**其余一切都被拒绝，而不是被解释**。判据随之塌缩——生效分支就是 `sonarBranchName` 参数（缺失即默认分支），「是不是 PR 分析」就是那唯一一条 key 声明是否非空；「最后一条生效」「注释算不算声明」这类问题**在被放行的输入上根本无从产生**。

**代价，直说**（全部在失败关闭方向，且拒绝消息直接给出修法）：

| 被拒绝的形状 | 推荐的形状 |
|---|---|
| `sonar.branch.name=` / `sonar.host.url=` / `sonar.projectKey=` / 凭证类键 / `sonar.qualitygate.*` 写进 `sonarProperties` | 使用专用参数 `sonarBranchName` / `sonarHostURL` / `sonarProjectKey` 等——即使注入值会被参数覆盖也照样拒绝，判据从此不必回答「哪个入口生效」 |
| 注释行（`#…`）、行首空白、一个元素内的换行 | 一个数组元素恰好一条 `key=value`；不要把注释写进参数 |
| `sonarBranchName` 参数值内的换行（`\n` / `\r`）——sed 写文件时会把它拆成两行，第二行可以冒充 `sonar.branch.name=<protected-branch>` | 分支名本来就不含换行；去掉即可 |
| `sonar.pullrequest.key` / `.base` 重复声明，或值中含空白 | 各恰好写一条，值中不含空白（平台注入的空 key 整组属规范形态，照常放行） |

缺失的 `sonarBranchName` **不在被拒清单上**——它落入规则 ③ 的受保护范围、按默认分支处理（Community Edition 场景照常合规；见上文「缺失」段落）；代价是「参数缺失 + 仓库属性文件把分析指向 feature 分支 + 门禁被显式关掉」这一组合会被误拒——仍在失败关闭方向，记为 [§2.5](#s2-5) 第 19 条。

**这条教训比那些正则本身更值钱**：一条判据要么复刻**最终消费方**的解析语义，要么**让复刻变得不必要**。只有把输入面收窄到消费方没有发挥余地的程度，复刻才是可维护的；输入的自由度越高，复刻就越像别人解析器的影子实现——任何一侧改一行，两边就分叉，而分叉不报任何错。先问「这种形状能不能禁掉」，再问「这种形状怎么建模」。

**这也不是 sonar 特有的**：Tekton 的校验 webhook 只保证 `spec.params` 中的**参数名**唯一（[§4.2.5](#s4-2-5)）；它管不到**单个数组参数内部的元素**。对任何把数组参数当「配置列表」消费的 Task，判据都应先为元素固定一个规范形态、拒绝契约之外的一切，而不是假定第一条（或最后一条）就是生效值。

:::

:::warning 为什么不能写成「分支必须在受保护集合里」

最直觉的写法是无条件断言：deny 一切不匹配 `^(main|release-.*)$` 的 `sonarBranchName`。在官方模板下那是**全量误伤**：模板把该参数硬接到 `$(params.gitRevision)`，于是 **feature 分支构建和 PR 触发的构建全部在 admission 被拒**——PR 永远过不了 CI，也就永远合不进去。与此同时它想防的事——「把分析指向别的分支来刷结果」——在官方模板画像下早已闭合（参数无法独立指定 + [§4.1.1](#s4-1-1) 锁模板 + 本节规则 ② / [§4.2.5](#s4-2-5) 禁止 `sonarProperties` 覆盖）。

连同语义边界一起记住：`sonarBranchName` 是**分支分析**的目标，**不是 PR 分析的目标**。当最终配置携带非空 `sonar.pullrequest.key`（PR 分析模式）时，Task 会**移除** `sonar.branch.name`——对这样一个**场景惰性参数**做无条件断言，是「只在一个场景成立的判据被 Enforce 到所有场景」的教科书式失败形状。PR 分析的目标分支在 `sonar.pullrequest.base` 里，而那是用户可控参数——规则 ④ 用「仅当声明了**非空** `sonar.pullrequest.key`（真实 PR 分析）且目标受保护时才校验」的尽力而为语义处理它；**规则 ④ 不装，PR 阶段就干脆没有门禁**——两种形态都是被接受的设计；合入之后，规则 ③ 在请求参数层提供严格约束，端到端保证还额外要求下文列出的内容治理前提成立。

:::

:::warning 信任边界：属性来源里仍有一条 admission 看不见的路径

Task 合并属性的来源不止请求。按 `sonarqube-scanner` 0.7 的实际顺序（`sonarqube-scanner.yaml` 中 `src_props_file` / `ws_props_file` 那一段）：被扫描仓库自己的 `sonar-project.properties` → `sonar-settings` workspace 中的同名文件 → 普通 Task 参数与 `sonarProperties` → `sonar-credentials` 的连接器属性 → 最后由 `apply_branch_name_property` 选定分支还是 PR 模式。**admission 只看得见参数这一步。** 本节的 37 个探针也全是参数形状：它们证明的是请求参数契约，不能证明文件 / 连接器内容没有注入同名属性。

在分支值一侧，判据已对文件来源免疫：参数非空时，`apply_branch_name_property` 会用参数**覆盖**从文件合并来的 `sonar.branch.name`；参数缺失时，规则 ③ 直接把该运行视为受保护范围——任何文件里写的分支值都改变不了 admission 结论，最坏情况是失败关闭方向的一次误拒（[§2.5](#s2-5) 第 19 条）。剩下**一条** admission 堵不上的路径：仓库、`sonar-settings` 或 `sonar-credentials` 中的内容注入**非空 `sonar.pullrequest.key`**，把 Task 翻转进 PR 模式（`sonar.branch.name` 被删除），本来的「受保护分支分析」就悄悄变成了 PR 分析——门禁开关一下都没碰，受保护分支的分析却从未发生。这是内容治理边界，不是 Kyverno 参数判据能闭合的：仓库内容由 [§2.1](#s2-1) 的仓库治理与代码评审兜底；`sonar-settings` / `sonar-credentials` 必须是受评审对象、不可变引用且内容受控，其漂移属于 [§2.3](#s2-3) 的契约 1。**生产验收必须加一道内容侧检查**：确认这三个来源都不携带非空 `sonar.pullrequest.key`，且每次变更后复查；只有这一点成立，规则 ③ 才从「请求参数保证」上升为本文声称的合入后保证。这条残余路径记为 [§2.5](#s2-5) 第 18 条。

:::

:::warning 把本节当范式复用之前，先对「场景选择字段」做一次充分性检查

本节演示的通用形状是「**把判据条件化到场景，而不是无条件 Enforce**」。把它移植到另一个参数 / 另一个 Task 之前，先确认你选的「场景选择字段」**真的决定最终语义**——三个问题，一个都不能跳：

1. **它是唯一入口吗？** 一个语义常常有多个配置入口。本节的 `sonarBranchName` 就是历史反例：它看起来是分析目标的唯一来源，但请求里的 `sonarProperties` 也能注入一条 `sonar.branch.name=`；更外圈还有 admission 看不见的属性文件。**能收窄就收窄，别去建模**：现行规则 ② 直接禁掉请求侧多余的入口，规则 ③ 只读保留下来的那一个参数入口；admission 看不见的文件 / 连接器来源被明确列为内容治理前提，而不是在 Kyverno 里继续复刻解析器。**同一入口出现多次也算多个入口**——数组参数内同键条目重复时，生效的是熬过消费方合并的那条，取 `[0]` 的判据等于把「哪条生效」的选择权又交还给请求方。
2. **会不会有某个场景让消费方无视它？** 本节的 `sonar.branch.name` 在 PR 模式下被 Task 删除（惰性参数）——对它无条件断言就是全量误伤（见上一个警告）。
3. **你的判据算出的值与 Task 实际使用的值是同一个吗？** 判定方法只有一个：**读消费方的源码**（本节读的是 `apply_branch_name_property` 的合并顺序）；靠参数名和文档行文去推断是不够的。

三问全过之后才谈得上「条件化」。漏掉第 1 问是更危险的情形：条件化会产出一条看似有保证、实则有洞的判据——比无条件 Enforce 更难被发现。

:::

**扩展 / 升级时必须联动修改的内容**（四条规则各自持有一份判据副本；漏改任何一处的后果都是**静默跳过**——策略还在、报告干净，实际却什么都没锁住）：

| 你要做的变更 | 必须同步联动的位置 | 漏改的后果 |
|---|---|---|
| 扫描器版本升级（0.7 → 0.8） | **四条规则各自的 `taskVersion` 前置条件**（每条规则一处，共 4 处）；同时对新版本复核四个契约事实：门禁开关的参数名与默认值；「非空 `sonar.pullrequest.key` ⇒ 切入 PR 模式」的行为；规范形态门里的受管键清单是否仍与新版本的参数面对齐；以及 `apply_branch_name_property` 是否仍把 `sonarBranchName` 逐字写进属性文件（这决定参数内的换行是否仍需要禁） | 四条规则全部不再按身份匹配 → 一切静默跳过；来源完整性、规范门、门禁保证一起消失 |
| 增删受保护分支模式（如加上 `hotfix-*`） | **两个正则字面量必须同时改**：规则 ③ 前置条件里的 `^(main|release-.*)$`，以及规则 ④ 的 `prBaseProtected` 正则 `^sonar[.]pullrequest[.]base=(main|release-.*)$`——保留两份副本而不抽取共享变量，因为它们锚定不同字段（分支参数 / PR base 声明） | 只改一处 → 另一处仍按旧分支集合求值；分支侧与 PR 侧的结论静默分叉，且不报任何错 |
| 新增第三个门禁开关 | 规则 ③ 与 ④ 中的 `<switch>Present` / `<switch>` 变量对加上 `gateWeakened` 表达式（每条规则一处，共 2 处），以及两条 `message` 中的回显 | 新开关可以随意被关掉；判据看不见它 |
| 放宽 / 收紧规范形态（如允许某个受管键改走 `sonarProperties`） | 规则 ② 的 `propsGovernedKey` 清单及其 `message`；若该键参与场景选择，规则 ③ / ④ 的取值变量必须跟着改 | 漏改清单 → 该键持续被拒（失败关闭方向的全量误拒）；或未经评估后果就把键从清单里删掉 → 一次静默的放开 |
| 更换 hub catalog 名 | 四条规则的 `taskCatalog` 前置条件 + [§4.0.3](#s4-0-3) 的占位符替换表（该表相应行还注明**参数键 `[?name=='catalog']` 不得被替换**） | 与版本升级相同：一切静默跳过 |

:::details 完整策略 YAML：sonar-branch-analysis-branch-contract（四条规则）

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: sonar-branch-analysis-branch-contract
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    # Rule 1 -- scenario-neutral source integrity: the scanner's hub source must
    # not be swapped, no matter which branch or trigger produced the run.
    - name: hub-source-integrity
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: hubTypeCount
          variable:
            jmesPath: "length((request.object.spec.taskRef.params || `[]`)[?name=='type'])"
        - name: hubType
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='type'].value | [0] || ''"
            default: ""
        - name: hubURLCount
          variable:
            jmesPath: "length((request.object.spec.taskRef.params || `[]`)[?name=='url'])"
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: sonarqube-scanner
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.7"
      validate:
        failureAction: Enforce
        # Name the three offending shapes separately: a single boolean tells the
        # blocked user WHAT rule fired but not WHICH taskRef param to fix.
        message: >-
          quality analysis must use the governed Artifact Hub source -- fix the
          taskRef params: request-level 'url' present={{ hubURLCount }}
          (must be 0), 'type' param count={{ hubTypeCount }} (must be 0 or 1),
          'type' value='{{ hubType }}' (must be empty or 'artifact').
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"
                operator: Equals
                value: true
    # Rule 2 -- the NORMATIVE-FORM gate, scenario-neutral like rule 1: it does
    # not judge which branch is analysed, it pins the INPUT SHAPE every other
    # judgment relies on. Anything outside the supported form is rejected
    # outright instead of being interpreted -- the earlier approach of
    # mirroring the Task's own parsing (last-entry-wins, '#' comments, leading
    # whitespace, tr -d ' ') could never converge, because admission cannot see
    # the repository- and workspace-sourced property files that join the same
    # merge. Narrowing the accepted input makes that mirroring unnecessary.
    - name: sonar-props-normative-form
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        # to_array + [0] normalizes an array-typed param to its first element,
        # and to_string JSON-encodes an object-typed ParamValue, so the checks
        # below always receive strings and never make the rule ERROR out.
        - name: branchParam
          variable:
            jmesPath: "to_string(to_array((request.object.spec.params || `[]`)[?name=='sonarBranchName'].value | [0] || '') | [0] || '')"
            default: ""
        - name: sonarPropsItems
          variable:
            jmesPath: "to_array((request.object.spec.params || `[]`)[?name=='sonarProperties'].value | [0] || `[]`)[].to_string(@)"
            default: []
        # The branch param is written into the properties file verbatim by
        # apply_branch_name_property -> replaceValues (sed). A value carrying a
        # line break therefore becomes TWO property lines, and a second
        # 'sonar.branch.name=main' line makes java.util.Properties analyse main
        # while the scope gate (which reads the raw param) sees a non-protected
        # first line and skips. Ban CR/LF in the param -- a branch name never
        # contains one, so this is zero-cost and closes the smuggling that the
        # sonarProperties grammar alone did not (the param is a separate
        # entrance).
        - name: branchParamBad
          variable:
            jmesPath: "regex_match('^[^\\r\\n]*$', branchParam) == `false`"
        # Canonical entry form: one 'key=value' per array item -- key starts
        # with a letter, no leading whitespace, no '#', no embedded line break.
        # Everything the Task's merge chain could reinterpret (comment lines,
        # indented keys, one item becoming two property lines) fails this
        # grammar and is rejected, not modelled.
        - name: propsNonCanonical
          variable:
            jmesPath: "length(sonarPropsItems[?regex_match('^[A-Za-z][A-Za-z0-9._-]*=[^\\r\\n]*$', @) == `false`]) > `0`"
        # Governed keys have dedicated, judgeable entrances (params) or are
        # pinned elsewhere -- they must not travel inside sonarProperties at
        # all. With the grammar above enforced, a plain prefix match is
        # sufficient: no evasive spelling of these keys can reach this check.
        # sonar.qualitygate.* is normalised last by the Task today, but is
        # listed anyway so a future reordering cannot silently open it.
        - name: propsGovernedKey
          variable:
            jmesPath: >-
              length(sonarPropsItems[?starts_with(@, 'sonar.branch.name=')
                || starts_with(@, 'sonar.host.url=')
                || starts_with(@, 'sonar.projectKey=')
                || starts_with(@, 'sonar.login=')
                || starts_with(@, 'sonar.token=')
                || starts_with(@, 'sonar.password=')
                || starts_with(@, 'sonar.qualitygate.')]) > `0`
        # PR claims stay allowed (the platform injects the group on push events
        # and the official template has no dedicated params for them), but only
        # in unambiguous form: at most one claim per key, and no whitespace in
        # the key / base values -- so "empty vs non-empty" needs no tr -d ' '
        # emulation downstream.
        - name: prKeyClaimCount
          variable:
            jmesPath: "length(sonarPropsItems[?starts_with(@, 'sonar.pullrequest.key=')])"
            default: 0
        - name: prBaseClaimCount
          variable:
            jmesPath: "length(sonarPropsItems[?starts_with(@, 'sonar.pullrequest.base=')])"
            default: 0
        - name: prClaimWhitespace
          variable:
            jmesPath: "length(sonarPropsItems[?regex_match('^sonar[.]pullrequest[.](key|base)=[^\\r\\n]*[[:space:]]', @)]) > `0`"
        - name: prClaimBad
          variable:
            jmesPath: "prKeyClaimCount > `1` || prBaseClaimCount > `1` || prClaimWhitespace"
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: sonarqube-scanner
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.7"
      validate:
        failureAction: Enforce
        message: >-
          sonarqube-scanner inputs must use the supported form:
          sonarBranchName must not contain a line break (bad={{ branchParamBad }});
          every sonarProperties item must be a single 'key=value' line with no
          leading whitespace, '#' or line break (non-canonical present={{ propsNonCanonical }});
          governed keys (sonar.branch.name / sonar.host.url / sonar.projectKey /
          sonar.login / sonar.token / sonar.password / sonar.qualitygate.*) must
          use their dedicated params instead of sonarProperties
          (present={{ propsGovernedKey }}); sonar.pullrequest.key / .base may be
          declared at most once each and without whitespace in the value
          (key claims={{ prKeyClaimCount }}, base claims={{ prBaseClaimCount }}).
          Requests outside this form are rejected instead of interpreted.
        deny:
          conditions:
            any:
              - key: "{{ branchParamBad }}"
                operator: Equals
                value: true
              - key: "{{ propsNonCanonical }}"
                operator: Equals
                value: true
              - key: "{{ propsGovernedKey }}"
                operator: Equals
                value: true
              - key: "{{ prClaimBad }}"
                operator: Equals
                value: true
    # Rule 3 -- the request-parameter guarantee, judged on the narrowed input only: an
    # analysis whose branch anchor (the sonarBranchName param -- rule 2 makes
    # it the only entrance) targets a protected branch must not have its
    # quality-gate switches explicitly disabled. PR / feature builds carry a
    # non-protected value here and SKIP -- out of scope, not violations.
    # SOUNDNESS PREMISE: rule 2 (same policy, Enforce) has already rejected
    # every non-canonical shape, so a plain prefix match and a plain equality
    # test are exact here -- do not install this rule without rule 2.
    - name: protected-branch-gates-strict
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: branchParam
          variable:
            jmesPath: "to_string(to_array((request.object.spec.params || `[]`)[?name=='sonarBranchName'].value | [0] || '') | [0] || '')"
            default: ""
        - name: sonarPropsItems
          variable:
            jmesPath: "to_array((request.object.spec.params || `[]`)[?name=='sonarProperties'].value | [0] || `[]`)[].to_string(@)"
            default: []
        # A non-empty PR key claim flips the Task into PR analysis (it deletes
        # sonar.branch.name; the branch param is inert there) -- the PR stage
        # is rule 4's business. Canonical form is guaranteed by rule 2, so
        # "non-empty" is one equality test against the bare token.
        - name: prKeyClaim
          variable:
            jmesPath: "sonarPropsItems[?starts_with(@, 'sonar.pullrequest.key=')] | [0] || ''"
            default: ""
        - name: prKeyNonEmpty
          variable:
            jmesPath: "prKeyClaim != '' && prKeyClaim != 'sonar.pullrequest.key='"
        # Presence is tracked separately from the value: only an absent param
        # inherits the trusted Task default "true"; an explicit empty string or
        # any other non-true value is a weakened gate (same pattern as §4.2.1).
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        - name: gateWeakened
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: sonarqube-scanner
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.7"
          # Scope gate: only branch-mode analyses of a protected branch enter.
          # An ABSENT / blank sonarBranchName is IN scope: with no branch value
          # from anywhere (rule 2 bans the sonarProperties entrance), the
          # scanner analyses the project's DEFAULT branch -- which is exactly
          # the protected mainline (this also keeps Community Edition callers,
          # which cannot pass a branch at all, governed instead of exempted).
          # A PR / feature build fails one of the two tests and SKIPS -- the
          # inverse of a branch allowlist: out of scope, not violations.
          - key: "{{ (regex_match('^(main|release-.*)$', branchParam) || regex_match('^[[:space:]]*$', branchParam)) && !prKeyNonEmpty }}"
            operator: Equals
            value: true
      validate:
        failureAction: Enforce
        message: >-
          analysis of protected branch '{{ branchParam }}' (an empty value
          means the default branch) must keep the quality gates on:
          enableScanQualityGate='{{ scanQG }}',
          enableAnalyzeQualityGate='{{ analyzeQG }}' (an absent switch inherits
          the trusted default "true"; an explicit non-true value is rejected).
        deny:
          conditions:
            any:
              - key: "{{ gateWeakened }}"
                operator: Equals
                value: true
    # Rule 4 (OPTIONAL, best-effort BY DESIGN) -- when the caller claims REAL
    # PR analysis (a non-empty sonar.pullrequest.key; the platform injects the
    # group with an empty key on plain push events, which must not enter) and
    # names a protected target via sonar.pullrequest.base=..., hold the same
    # gate strictness. The claims are user-supplied and absent by default:
    # omission or a non-protected value simply skips. That fail-open direction
    # is the accepted trade-off for the PR stage (the strict post-merge parameter
    # check lives in rule 3), which is also why this rule audits instead of
    # enforcing. Ambiguous / malformed claims are already REJECTED by rule 2,
    # so this rule only ever sees at most one canonical claim per key.
    - name: pr-target-protected-gates-audit
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: sonarPropsItems
          variable:
            jmesPath: "to_array((request.object.spec.params || `[]`)[?name=='sonarProperties'].value | [0] || `[]`)[].to_string(@)"
            default: []
        - name: prKeyClaim
          variable:
            jmesPath: "sonarPropsItems[?starts_with(@, 'sonar.pullrequest.key=')] | [0] || ''"
            default: ""
        - name: prKeyNonEmpty
          variable:
            jmesPath: "prKeyClaim != '' && prKeyClaim != 'sonar.pullrequest.key='"
        - name: prBaseClaim
          variable:
            jmesPath: "sonarPropsItems[?starts_with(@, 'sonar.pullrequest.base=')] | [0] || ''"
            default: ""
        # Match the WHOLE token so 'sonar.pullrequest.base=main;x=y' cannot
        # pose as a protected claim (rule 2 already keeps the token canonical).
        - name: prBaseProtected
          variable:
            jmesPath: "regex_match('^sonar[.]pullrequest[.]base=(main|release-.*)$', prBaseClaim)"
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        - name: gateWeakened
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: sonarqube-scanner
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.7"
          # Only runs that CLAIM PR analysis (non-empty pullrequest.key) AND
          # name a target base enter. A plain push build carrying the
          # platform-injected group with an EMPTY key skips, and so does a PR
          # run with no base claim -- accepted fail-open for the PR stage.
          - key: "{{ prKeyNonEmpty }}"
            operator: Equals
            value: true
          - key: "{{ prBaseClaim }}"
            operator: NotEquals
            value: ""
      validate:
        failureAction: Audit
        message: >-
          PR analysis (non-empty sonar.pullrequest.key) claims target
          '{{ prBaseClaim }}' -- a protected target must keep the quality
          gates on (enableScanQualityGate='{{ scanQG }}',
          enableAnalyzeQualityGate='{{ analyzeQG }}').
        deny:
          conditions:
            any:
              - key: "{{ prBaseProtected && gateWeakened }}"
                operator: Equals
                value: true
```

:::

:::details 验证探针（共 37 个；每个真实触发场景都有放行用例）

怎么跑：1-4 与 7-37 用 `kubectl create --dry-run=server`（Enforce 结论同步可见）；5 和 6 是 Audit 规则的观察项——**真正创建**它们，然后在 PolicyReport 中对账 `fail` / `pass`；结束后按 [§4.0.4](#s4-0-4) 清理探针对象。部署之后，按 [§3.5](#s3-5) 的上线流程、用 [§3.4.1](#s3-4-1) 的骨架 B 重跑本表复验。

| 探针 # | 场景 / 构造 | 预期 |
|---|---|---|
| 1 | 受保护分支，官方模板形状：`sonarBranchName: main` + `sonarProperties` 只含合法条目（如 `sonar.java.binaries=target/classes`），门禁开关**缺失** | 放行（开关缺失 = 可信默认值） |
| 2 | 受保护分支，显式合规：`sonarBranchName: release-1.2` + `enableScanQualityGate: "true"` | 放行 |
| 3 | **feature 构建，门禁关闭**：`sonarBranchName: feature-x` + `enableScanQualityGate: "false"` | **放行**（规则 ③ 跳过——该场景的放行用例，证明 PR / feature 构建不会被整体拦死） |
| 4 | **push 注入形状**：`sonarBranchName: main` + `sonarProperties` 含整组 `sonar.pullrequest.*`（**空 key**），开关缺失 | 放行（空 key 的整组注入属规范形态；分支模式照常判定，门禁未被削弱） |
| 5 | PR 尽力而为的阳性用例：`sonarBranchName: feature-x` + `sonar.pullrequest.key=1770` + `sonar.pullrequest.base=main` + `enableScanQualityGate: "false"` | 放行 + PolicyReport **fail**（`pr-target-protected-gates-audit`；Audit 不拦截） |
| 6 | PR 尽力而为的阴性用例：`key=1770` + `base=feature-y` + 门禁关闭 | 放行，无 fail（目标不受保护；被接受的 fail-open） |
| 7 | 合法设置：`sonarBranchName: feature-x` + `sonarProperties` 只含 `sonar.exclusions=**/vendor/**` + 门禁关闭 | 放行 |
| 8 | **值中含受管键的合法属性**：`sonar.exclusions=**/sonar.branch.name=main/**` + feature 构建，门禁关闭 | 放行（前缀锚定在条目开头；值内子串不算声明） |
| 9 | PR 模式无误报：`sonarBranchName: main` + `sonar.pullrequest.key=1770` + 门禁关闭 | 放行（非空 key ⇒ Task 不做分支分析，规则 ③ 跳过；PR 阶段归规则 ④，无 base 声明不触发） |
| 10 | 非受管键值中含空格：`sonar.projectName=My App`，开关缺失 | 放行（规范形态只约束键形状与受管键；不禁止值内空格） |
| 11 | **Community Edition 形状**：`sonarBranchName` 缺失 + `sonarProperties` 只含合法条目，开关**缺失** | 放行（分支缺失按默认分支进入受保护范围，但门禁未被削弱——合规的 Community Edition 用法不被误拒） |
| 12 | 注入分支键：`sonarBranchName: feature-x` + `sonarProperties` 含 `sonar.branch.name=main` + 门禁关闭 | **拒绝**（`sonar-props-normative-form`——受管键不得经 `sonarProperties` 传递；即使参数会覆盖它也照样拒绝） |
| 13 | 注入分支键、门禁全开：`sonarBranchName: main` + `sonar.branch.name=release-1.2`，开关缺失 | **拒绝**（规范形态门与场景无关：即使没有削弱门禁也拒绝） |
| 14 | 夹带后缀：`sonar.branch.name=main;sonar.foo=bar` + 门禁关闭 | **拒绝**（受管键前缀命中） |
| 15 | 注释行：`sonarProperties` 只含 `#sonar.branch.name=main` + feature 构建，门禁关闭 | **拒绝**（行首 `#` 不是规范 `key=value`——不要把注释写进参数） |
| 16 | 行首空白：` sonar.branch.name=main`（行首一个空格；Tab 同理）+ 门禁关闭 | **拒绝**（非规范形态——正是宽松前缀匹配从前留下的绕过洞；整类拒绝） |
| 17 | 行首换页符 `\f` + 门禁关闭 | **拒绝**（同上） |
| 18 | 行首垂直制表符 `\v` + 门禁关闭 | **拒绝**（同上；契约不去解释消费方会不会接受——见 [§2.5](#s2-5) 第 19 条） |
| 19 | 两条 exclusion 行借内嵌换行挤在一个元素里 + feature 构建，门禁关闭 | **拒绝**（一个元素必须恰好一条 `key=value` 行——拆成两个数组元素即可放行） |
| 20 | 换行走私：`sonar.exclusions=x` + 换行 + `sonar.branch.name=main` + 门禁关闭 | **拒绝**（非规范形态 + 受管键，双重命中） |
| 21 | **重复 PR key**：一条 `sonar.pullrequest.key=1770` 加一条 `sonar.pullrequest.key=` + 门禁关闭 | **拒绝**（声明有歧义——重复直接拒绝；不再建模「最后一条生效」） |
| 22 | **空白值 PR key**：`sonar.pullrequest.key= `（等号后一个空格）+ 门禁关闭 | **拒绝**（key / base 值中禁止空白——不再建模 `tr -d ' '` 的置空语义） |
| 23 | **Tab 值 PR key**：`sonar.pullrequest.key=` 后跟一个 Tab + 门禁关闭 | **拒绝**（同上） |
| 24 | **重复注入分支**：一条 `sonar.branch.name=feature-x` 加一条 `sonar.branch.name=main` + 门禁关闭 | **拒绝**（受管键命中；声明重复时，连「哪条生效」都不用再回答） |
| 25 | **endpoint 注入**：`sonarProperties` 含 `sonar.host.url=http://evil.example` | **拒绝**（受管键——endpoint 在 TaskRun 层也被钉死，而不只在 [§4.2.5](#s4-2-5) 的 PipelineRun 层） |
| 26 | 类型回归：`sonarProperties` 以**对象**传入 | **拒绝**（JSON 编码后不匹配规范 `key=value` 形态——契约之外的形状，不再「跳过并放行」） |
| 27 | 类型回归：`sonarProperties` 以**裸字符串** `sonar.branch.name=main` 传入 | **拒绝**（归一化为单元素后按规范形态判定：受管键命中） |
| 28 | **分支缺失 + 门禁关闭**：`sonarBranchName` 缺失 + `enableScanQualityGate: "false"` | **拒绝**（`protected-branch-gates-strict`——缺失 = 默认分支分析，落在受保护范围内；正是旧判据静默跳过的缺口） |
| 29 | **空分支 + 门禁关闭**：`sonarBranchName: ""` + `enableScanQualityGate: "false"` | **拒绝**（同上；空值按缺失处理） |
| 30 | 受保护分支，门禁显式关闭：`sonarBranchName: main` + `enableScanQualityGate: "false"` | **拒绝**（`protected-branch-gates-strict`） |
| 31 | 受保护分支，开关显式空字符串：`sonarBranchName: main` + `enableAnalyzeQualityGate: ""` | **拒绝**（显式空字符串 ≠ 缺失） |
| 32 | hub 来源被调包（请求级 `url`）+ `sonarBranchName: feature-x` | **拒绝**（`hub-source-integrity`——与场景无关；feature 分支照样拒绝） |
| 33 | 伪造完全相同的标签，但真实 Task 身份不是 `catalog/sonarqube-scanner/0.7` | 四条规则全部跳过；无误报 |
| 34 | 回归用例：`sonarBranchName` 以**数组**传入（`[feature-a, feature-b]`）+ 门禁关闭 | 放行（归一化取第一个元素，非空且不匹配受保护正则 → 规则 ③ 跳过；**不产生规则报错**——类型错误由 Tekton 自身的参数校验兜底） |
| 35 | **经参数的换行走私**：`sonarBranchName` 取值 `feature-x` + 换行 + `sonar.branch.name=main` + 门禁关闭 | **拒绝**（`sonar-props-normative-form`——`replaceValues` 用 sed 写文件时值被拆成两行，Java 取最后一行 `main`；判据禁止 `sonarBranchName` 中的换行，把这条与 `sonarProperties` 并行的入口关掉） |
| 36 | **经参数的回车走私**：同上，但用 `\r` 代替 `\n` | **拒绝**（`\r` 同样是 Java properties 的行终止符；一并禁止） |
| 37 | 阴性对照：带斜杠 / 点的合法分支名（`release-1.2/hotfix`）+ 门禁开启 | 放行（只禁换行；正常分支名不受影响——无误报） |

:::
#### 4.2.5 官方模板的前置拦截（辅助路径、真实 profile） {#s4-2-5}

- **管什么**：当使用官方模板 `java-image-build-scan-deploy` 0.3 **或** `python-image-build-scan-deploy` 0.3 时，**在 PipelineRun 创建的那一刻**就拦截把门禁关掉、或把门禁架空成走过场的调用。
- **难在哪**：这两个模板的门禁藏着三个层层递进的陷阱，只对齐 `when` 值的朴素做法必然漏掉——① **默认情况下根本什么都不扫**：`sonarURL` 默认为空且 sonar 任务由 `when` 守护，整个代码扫描被跳过（opt-in 陷阱，契约 3 的真实实例）；② **排上了 ≠ 真的扫了**：把 `trivyExtraArgs` 设成 `--help`，trivy 退出码为 0 却不产出任何报告，**TaskRun 照样是绿的**；③ **就算扫描跑了也可能是假的**：`sonarProperties` 可以覆盖已审批的配置，`tlsVerify=false` 会打开 `--insecure`，`images` 含多个元素时 buildah 会全部推送而 trivy 只扫第一个，workspace 还可以被换成未经评审的来源。
- **策略怎么分层**：① 锁定 Hub 来源身份（拒绝请求级 `url`；显式 `type` 只允许为 `artifact`）→ ② 强制门禁真正开启（`sonarURL` 非空、`skipTrivyScan` 严格等于 `"false"`、`trivyExitCode` 不得设成只报告不拦截的 `""` / `"0"`、`trivySeverity` 覆盖要求的严重级别、`trivyExtraArgs` 为空）→ ③ 强制生效配置不被架空（不得有覆盖受管键的 `sonarProperties` 条目、不得覆盖 `sonarProjectKey`、`tlsVerify` 只允许可信默认值或严格等于 `true`、`images` 非空且 shell 安全、严格 profile 限定单个镜像）→ ④ 把门禁相关 workspace 的来源限定为已评审对象——**共享的 6 个**（`sonar-settings` / `sonar-credentials` / `sonar-certificate` / `registry-config` / `ca-bundle` / `trivy-config`），再加语言特有部分：java 另加 5 个 maven 的（共 11 个），python 另加 `pip-conf`（共 7 个）。
- **管不了什么**：这是**辅助路径**——它只能看到 PipelineRun 上**显式写出**的内容；最终生效值仍由 TaskRun 层决定（[§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)）；且本节**看不到运行结果**——扫描到底报了什么是 [§4.4.1](#s4-4-1) 的职责。

:::info 上线前先核对模板实际声明的 workspace

本节的 workspace 白名单是按 `java-image-build-scan-deploy` 0.3 的 **16** 个 workspace 和 `python-image-build-scan-deploy` 0.3 的 **12** 个写的。**白名单逐一枚举名字；模板改了 workspace，白名单必须跟着改**——所以上线前请对照实际解析到的定义核对，而不是照抄本文的数字：

```bash
# On the cluster running Tekton, list the workspaces the template actually declares and verify them. The two fill-in values come first:
PIPELINE_NS='<your-pipeline-namespace>'
REAL_RUN='<one-real-run>'
kubectl -n "$PIPELINE_NS" get pipelinerun "$REAL_RUN" \
  -o jsonpath='{.status.pipelineSpec.workspaces[*].name}'
```

对不上就按你自己的副本重新枚举。特别注意**某个 workspace 消失了**的情况：对应判据会恒为 false——看着是绿的，实际什么都没锁。

:::

本节的完整 profile 拆成**三条规则**，因为两个官方模板之间真正不同的只有那一小块构建输入：

| 规则 | 覆盖的模板 | 管什么 |
|---|---|---|
| `quality-gates-must-stay-enabled` | java 0.3 **与** python 0.3 | Hub 来源身份、Sonar 门禁、Trivy 门禁、TLS、`images`，以及 **6 个扫描 / 配置 workspace**（`sonar-settings`、`sonar-credentials`、`sonar-certificate`、`registry-config`、`ca-bundle`、`trivy-config`） |
| `java-build-inputs-must-stay-approved` | 仅 java 0.3 | 5 个 maven 参数 + 5 个 maven workspace |
| `python-build-inputs-must-stay-approved` | 仅 python 0.3 | 5 个 `preBuild*` / `pythonImage` 参数 + `pip-conf` workspace |

门禁面之所以能共用一条规则，是因为两个模板在**门禁判据触及的所有参数上名称和类型完全一致**——trivy 侧（`skipTrivyScan` / `trivyExitCode` / `trivySeverity` / `trivyExtraArgs`）连默认值都逐字段相同；sonar 侧参数名相同（**但 `sonarProperties` 的默认值不同**：java 多带一条 `sonar.java.binaries=target/classes`；本节判据只要求“不被请求侧覆盖”、从不与默认值比较，所以这点无关紧要）。差异集中在语言特有的构建输入（java 的 maven 组 ↔ python 的 `preBuild*` 组，workspace 数 16 ↔ 12）。采纳方式也按同样方式分层：最小化的 `trivy-gate-must-stay-on` 属于最小硬保证，而本表的完整 profile 是**可选的环境 profile**——按模板和环境选择性安装（最小集清单见 [§4.0.2](#s4-0-2)）；不是每个部署都必须照抄。

**两个模板共享 11 个同名 workspace；本节只管其中 6 个。**其余 5 个——`source`、`git-basic-auth`、`git-ssh-directory`、`git-ssl-ca-directory`、`kubeconfig`——**不在这三条规则的判据里**；它们分别归 Git / 源码类策略和 [§4.5.5](#s4-5-5) 的发布目标策略负责（各 workspace 的分工见下方的 workspace 职责表）。照抄本节规则并不意味着 11 个全被锁住。

模板 0.3 的真实形态是：`sonarURL` 默认为空，sonar 任务由 `when: sonarURL notin ["", " "]` 守护——**默认情况下代码扫描被整个跳过**；trivy 任务由 `when: skipTrivyScan in ["false"]` 守护，即**只有取值严格为 `"false"` 时才会被调度**。

但“任务被调度了”仍不等于“真的扫了”。漏洞门禁由 `trivyExitCode` 控制，**默认 `"1"`，即默认开启**（参数契约基线见 [§3.2](#s3-2) 的版本矩阵）——所以策略要防的不是“忘了开”，而是**被显式关掉**（设成 `"0"` 或空字符串）。另外，`trivySeverity` 决定哪些严重级别计入门禁；把它收窄到只剩 `LOW` 同样等于放行高危发现。往 `trivyExtraArgs` 里塞 `--help` 一类参数会让 trivy 退出码为 0 且不产出任何报告，TaskRun 照样成功。`tlsVerify=false` 会让 Task 带 `--insecure` 运行。Buildah 会推送 `images` 的**每一个**元素，而 Trivy 只扫**第一个**，所以严格 profile 必须把它限定为单个镜像。Sonar 0.7 会在已审批的 URL / project key 之后继续应用 `sonarProperties` 和凭证；Maven 0.6 的工作目录、goals、运行镜像及其实际消费的 workspace 同样会改变构建及其信任来源。

:::warning 本节管的是扫描门禁，不管构建与推送

模板以结构化形式（`scanType` / `scanTargets` / `severity` / `exitCode` / `extraArgs`）把 `trivyExtraArgs` 传给 `trivy-scanner` 0.6，所以这一侧已不存在“参数拼进 shell 命令字符串”的注入面。

**但不要把这读成“模板已经没有注入面了”**：同一个模板里，`buildExtraArgs` 和 `pushExtraArgs` **仍然是字符串类型**，其参数文档明明白白写着“必须由调用方消毒以避免命令注入”；`containerfilePath` / `buildContext` 也仍会流入后续脚本的数据路径。本节策略**不**管构建与推送侧——即使每个扫描门禁参数都写对了，构建也可能早已被篡改。

:::

:::warning 要对齐的是最终生效配置，而不只是 when 值

朴素做法——“只拒绝 `sonarURL==''`、只拒绝 `skipTrivyScan=='true'`”——存在直接的绕过取值；再进一步、只保证任务被调度，仍会漏掉三类：把 `trivyExitCode` 显式关成 `"0"`、把 `trivySeverity` 收窄到只剩低严重级别、以及 `trivyExtraArgs: ["--help"]` 这类“退出码 0 却不产报告”的调用——外加后续参数 / workspace 对已审批配置的覆盖。

因此完整 profile 禁止 PipelineRun 显式覆盖 `sonarProjectKey`，**禁止任何覆盖受管配置的 `sonarProperties` 条目**（见下一段），要求 `tlsVerify` 使用可信默认值或严格等于 `true`、`images` 非空且 shell 安全，并把可选的 Sonar / Maven / registry / pip workspace 限定为已评审对象。

**`sonarProperties` 按内容判定，而不是按是否出现判定**（与 [§4.2.4](#s4-2-4) 共用的判据形态）：该参数是传递合法分析设置（排除目录、覆盖率报告路径等）的**唯一通道**，触发路径上平台还会额外通过它注入整组 `sonar.pullrequest.*`——**“出现即拒绝”会拦掉这一整类正常请求**。按 scanner 0.7 的合并顺序（task 参数 → `sonarProjectKey` → **`sonarProperties`** → 凭证 → 分支名 → 质量门归一化），真正能在这里被覆盖的受管键只有三类：分析端点 `sonar.host.url`、项目身份 `sonar.projectKey`，以及 `sonarBranchName` 缺席时的 `sonar.branch.name`；凭证键（`sonar.login` / `sonar.token` / `sonar.password`）会被后面的凭证步骤覆写，`sonar.qualitygate.*` 会被最后的归一化覆写——当前都覆盖不了，但判据仍把它们列上，**以免将来合并顺序调整时悄悄开出口子**。**每一条目的形态也要判**（与 [§4.2.4](#s4-2-4) 规则 ② 相同的规范化闸门）：受管键的前缀匹配只有在条目是规范的 `key=value` 时才可靠——带前导空白的写法能躲过前缀比较，却仍被 Task 原样写进 properties 文件并在 Java 侧生效，所以非规范条目（前导空白、`#` 注释、单条目内嵌换行）一律拒绝。

**示例中的对象名必须替换成你环境里实际批准的 Secret / ConfigMap**（`approved-*` 一批），**且 `<approved-sonar-url>` / `<approved-maven-mirror-url>` / `<approved-maven-cert-path>` 这三个值也必须换成你自己的**——它们不是对象名，最容易漏改，漏改的后果是**合规请求被拒**：`sonarURL` 判据是无条件比较（**每一个**请求都会被拒），而两条 maven 判据带“仅在显式传入时才判”的前置条件（只有显式配置了镜像源 / 证书的请求会被拒）。各占位项的作用范围见 [§4.0.3](#s4-0-3) 的占位符表。模板升级时，重新评审每个字段与合并顺序。

:::

:::info Sonar 0.7 analyze 阶段的传输层校验

`sonar-scanner` 步骤会把 `sonar-certificate` 导入 Java truststore；随后的 `sonar-analyze` 步骤调用 CLI 时带上了 `--insecure-skip-tls-verify`。

**这不影响门禁本身的有效性**——质量阈值仍由 Sonar 服务端裁决，策略读取的 `code-scan-results` 仍是服务端的结论。受影响的只是 analyze 阶段到 Sonar 服务端这段传输链路上的证书校验。多数部署中 Sonar 位于集群内网、`sonarURL` 已被本节白名单钉死，实际暴露面收窄为内网上可路由的路径中间人；如果你的威胁模型包含这一类，这是 admission 策略改变不了的 Task 侧属性——请与 Task 维护者跟进。

:::

两个模板共享 11 个同名 workspace；java 另有 5 个 maven 的，python 另有 1 个 `pip-conf`（java 16 / python 12）。职责必须完全拆开——不要把“本节锁住了这些门禁 workspace”误说成“所有 workspace 都被管住了”：

| workspace | java / python | 职责边界 |
|---|---|---|
| `sonar-settings`、`sonar-credentials`、`sonar-certificate`、`registry-config`、`ca-bundle`、`trivy-config` | 6 / 6 | 由共享规则锁定：admission 可见的来源类型与对象名；这些 workspace 会被 Task 读取，但策略不读 Secret / ConfigMap / PVC 的内部内容。其中 `trivy-config` 承载 trivy 的集中配置（`trivy.yaml`）和忽略规则——**它是骑在扫描门禁上的 workspace：绑一个你控制的对象，就能在所有参数判据全绿的同时放宽扫描**——所以判据对“绑了、但不是那个 ConfigMap”（含 PVC / Secret 来源）按失败关闭处理 |
| `maven-settings`、`maven-server-secret`、`maven-local-repo`、`maven-cert` | 4 / — | 由 java 规则锁定；边界同上 |
| `pip-conf` | — / 1 | 由 python 规则锁定；`pip.conf` 决定包从哪里解析，未评审的绑定就是一条供应链输入。允许不绑定 |
| `maven-trust-store` | 1 / — | Pipeline 0.3 把它绑到 Maven 0.6 的同名 workspace，但 Maven 0.6 的执行逻辑从不读它；这里的来源限制是**针对升级漂移的保守防御**，不是“当前版本已经会改动 Maven 信任”的证据 |
| `source` | 1 / 1 | 共享的源码与部署清单；源码身份、内容完整性、源码到镜像的关联由可信 checkout 模板、Git / 源码类策略和供应链证明负责——不归本节 |
| `git-basic-auth`、`git-ssh-directory`、`git-ssl-ca-directory` | 3 / 3 | Git 凭证 / SSH / CA；须由单独的 Git URL / revision 与 workspace 来源策略审批；本节不检查 |
| `kubeconfig` | 1 / 1 | 发布身份与目标；workspace 来源由 [§4.5.5](#s4-5-5) 精确审批，并结合 RBAC 控制 |

`trivy-config` 判据已经**写进下方的完整策略**（`trivyConfigCount` / `trivyConfigWorkspace` / `trivyConfigConfigMap` / `trivyConfigBad` 四个变量，加上 `deny.conditions.any` 里对应的条目）；正反两个用例都在本节末尾的探针表里。当你自行扩展其他 workspace 时记住：**只声明变量而不接进 `deny.conditions.any`，等于没加**。

**这些判据同时锁定了“来源类型”**：其形态是 `xxxConfigMap != '<approved-object>'`，读的是 `.configMap.name`，因此以 **Secret / PVC / CSI / projected** 来源绑同一个 workspace 时该字段为空——恒被拒。模板本身**不**限制来源类型（这些只是可选 workspace）；**这是本文 profile 额外收紧的一层**。**如果你的站点确实把某些配置放在 Secret 里**（例如携带凭证的 `sonar-settings`），不要删判据；改成读对应字段、同时保持“若绑定则必须是已批准对象”的形态——例如 `(sonarSettingsWorkspace.configMap.name || sonarSettingsWorkspace.secret.secretName) != '<approved-object>'`，或用 `contains([...], ...)` 同时批准两种来源类型的对象名；改完后照常跑正反探针对（合规来源放行 / 换个对象拒绝）。

:::warning 为什么这里取 [0] 是安全的：三条 spec 侧唯一性保证来自 Tekton

本节判据到处使用 `[?name=='x'] | [0]`——参数、resolver 参数、workspace 都是。面对“同名写两次、策略只看到第一个”它安全吗？**安全——因为 Tekton 的 validating webhook 会先拒绝该请求**，策略根本见不到这样的对象：

| 构造方式 | Tekton 的原样报错 |
|---|---|
| `trivyExtraArgs` 在 `spec.params` 里写两次（第一次合规、第二次 `["--help"]`） | `expected exactly one, got both: spec.params[trivyExtraArgs].name` |
| `version` 在 `pipelineRef.params` 里写两次（第一次 `0.3`、第二次 `attacker-version`） | `expected exactly one, got both: spec.pipelineRef[version].name` |
| `trivy-config` 在 `spec.workspaces` 里绑两次（第一次是批准的 ConfigMap、第二次是恶意 PVC） | `workspace "trivy-config" provided by pipelinerun more than once, at index 0 and 1: spec.workspaces[1].name` |

所以 `spec` 侧唯一性由 Tekton 保证，策略不必再数一遍（本节的 `trivyConfigCount > 1` 之类只是与其他 workspace 判据保持同形的纵深防御，并非必需）。

**⚠️ 这条保证只覆盖 `spec`，绝不能外推到 `status`。**`status.results`、`status.conditions`、`status.skippedTasks`、`status.pipelineSpec.tasks` 都由控制器写入，且 **CRD 对它们没有任何按名去重约束**：**admission 时同名条目可以出现两次，这就足以绕过照抄 `[0]` 模式的策略**。所以每条读 `status` 的策略都必须显式要求“目标 result / condition 恰好一条”，终态守卫同样要数条目而不是取 `[0]`——构造方式、A/B 证据与修复见 [§4.4.1](#s4-4-1) 的“读 status 绝不取 `[0]`”警告。

**而且这条规则必须一路数到底，不只数最外层。**`status.pipelineSpec.tasks[].taskRef.params` 是**嵌在 status 里的 params 列表**：即使外层已经数过“名为 `scan` 的任务恰好一个”，内层的 `kind` / `name` / `namespace` 若仍照抄 `[0]`，前面插一个诱饵参数就能让身份判据读到“干净”的值。[§4.1.4](#s4-1-4) 与 [§4.6.2](#s4-6-2) 里的 `scanRefParamsUnique` 正是那一层的计数守卫；**你自己每往 status 里钻一层，就要按层问一次：“这个列表有唯一性保证吗？”**

:::

##### 先上最小版：只保证漏洞门禁不被关掉

如果你的需求只是“任何人都不得关掉 trivy 门禁”，那么**整条策略只需六条判据**（四条参数 + 两个覆盖面），同时覆盖两个官方模板：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: trivy-gate-must-stay-on
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: trivy-gate-must-stay-on
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        # Pin the whole template identity, not just its name: a same-named
        # pipeline resolved through another resolver or catalog is a different
        # object with different defaults.
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: refKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: refCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: refName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: refVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        # The scan task is guarded by `when: skipTrivyScan in ["false"]`, so this
        # switch turns the gate off by never creating the task at all -- the
        # parameter checks below would all be vacuously true.
        - name: skipTrivyPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='skipTrivyScan']) > `0`"
        - name: skipTrivy
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='skipTrivyScan'].value | [0] || ''"
            default: ""
        # A per-task override travels in the same request and is invisible to
        # every parameter judgment: podTemplate.env reaches every step container
        # (so it can narrow trivy's severity filter without touching a param),
        # and serviceAccountName changes what the gate step may do. stepSpecs /
        # sidecarSpecs carry computeResources only, so resource tuning stays
        # allowed -- rejecting that would be stricter than the gate needs.
        # The run-wide equivalent: taskRunTemplate.podTemplate applies to every
        # TaskRun of this run, so env set here reaches the governed task too.
        # Only env is judged. Besides nodeSelector / imagePullSecrets being
        # ordinary configuration, "deny any run-wide podTemplate" would deny
        # everything: Tekton's defaulting webhook merges config-defaults'
        # default-pod-template in before Kyverno sees the request, so this field
        # is never actually absent. Residual fields are in the boundary note.
        - name: runWideEnvCount
          variable:
            jmesPath: "length(request.object.spec.taskRunTemplate.podTemplate.env || `[]`)"
            default: 0
        # Scheduling a scanner onto dedicated nodes is ordinary operations, so the
        # per-task podTemplate is judged by *key*: anything outside the scheduling
        # allowlist (env, volumes, dnsConfig, securityContext, ...) is denied, and
        # unknown future keys stay denied by default. Measured: a per-task
        # podTemplate is NOT filled in by Tekton's defaulting webhook, so an absent
        # one really is absent here (unlike the run-wide one).
        - name: gateOverrideCount
          variable:
            jmesPath: >-
              length((request.object.spec.taskRunSpecs || `[]`)[?pipelineTaskName=='trivy-scanner'
              && (serviceAccountName
              || length(keys(podTemplate || `{}`)) != length(keys(podTemplate || `{}`)[?contains(['nodeSelector','tolerations','affinity','imagePullSecrets','priorityClassName'], @)]))])
            default: 0
        - name: trivySkipped
          variable:
            # Absence inherits the template default "false". An explicitly supplied
            # value, including empty, must equal the exact when value "false".
            jmesPath: "skipTrivyPresent && skipTrivy != 'false'"
        # Structured gate parameters. Absence is meaningful here: the template
        # default already turns the gate on, so only an explicitly supplied value
        # can weaken it.
        - name: trivyExitCodeCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='trivyExitCode'])"
            default: 0
        - name: trivyExitCode
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivyExitCode'].value | [0] || ''"
            default: ""
        - name: trivySeverity
          variable:
            # array-typed; the default must be an empty list, not '', or every
            # comparison below silently changes meaning
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivySeverity'].value | [0] || `[]`"
        - name: trivyExtraArgs
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivyExtraArgs'].value | [0] || `[]`"
        - name: trivyGateOff
          variable:
            # Report-only mode is exactly what the parameter contract calls "" or
            # "0"; any other non-zero code still fails the run, so it is not a way
            # to turn the gate off. A garbage value is fail-closed too -- trivy
            # errors out and the task fails. Sites that want one fixed code can
            # tighten this to `trivyExitCode != '1'`.
            jmesPath: >-
              trivyExitCodeCount > `0`
              && (trivyExitCode == '' || trivyExitCode == '0')
        - name: trivySeverityBad
          variable:
            # An empty list means trivy evaluates its own default severity set,
            # which is wider than CRITICAL+HIGH -- stricter, so it passes. A pinned
            # list must still cover both.
            jmesPath: >-
              length(trivySeverity) > `0`
              && !(contains(trivySeverity, 'CRITICAL') && contains(trivySeverity, 'HIGH'))
        - name: trivyExtraArgsBad
          variable:
            # The structured parameters are the gate interface. Anything left in
            # extraArgs either duplicates them, making the effective gate depend on
            # flag order, or disables scanning outright -- --help makes trivy print
            # usage and exit 0 without scanning anything.
            jmesPath: "length(trivyExtraArgs) > `0`"
      preconditions:
        all:
          - key: "{{ resolver }}"
            operator: Equals
            value: hub
          - key: "{{ refKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ refCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ refName }}"
            operator: AnyIn
            value:
              - java-image-build-scan-deploy
              - python-image-build-scan-deploy
          - key: "{{ refVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          the Trivy vulnerability gate must stay enabled: keep skipTrivyScan at
          "false", keep trivyExitCode off report-only mode ("" or "0"), keep
          trivySeverity either empty or covering CRITICAL and HIGH, do not pass
          gate switches through trivyExtraArgs, and do not attach a podTemplate
          or serviceAccountName override to the scanner task.
        deny:
          conditions:
            any:
              - key: "{{ trivySkipped }}"
                operator: Equals
                value: true
              - key: "{{ gateOverrideCount }}"
                operator: NotEquals
                value: 0
              - key: "{{ runWideEnvCount }}"
                operator: NotEquals
                value: 0
              - key: "{{ trivyGateOff }}"
                operator: Equals
                value: true
              - key: "{{ trivySeverityBad }}"
                operator: Equals
                value: true
              - key: "{{ trivyExtraArgsBad }}"
                operator: Equals
                value: true
```

**第五条判据 `gateOverrideCount` 守的是一条完全绕开参数面的路径**：PipelineRun 可以通过 `spec.taskRunSpecs` 给单个任务附加覆盖，而 **`podTemplate.env` 会被注入该任务的每一个 step 容器**。于是一个参数全绿的请求，只要带上

```yaml
  taskRunSpecs:
    - pipelineTaskName: trivy-scanner
      podTemplate:
        env:
          - name: TRIVY_SEVERITY
            value: LOW
```

就把扫描的实际生效严重级别收窄到只剩 `LOW`——而不传 `trivySeverity` 参数本身是**合规**的（空表示用 trivy 自己的默认集合），四条参数判据一条都不会命中。`serviceAccountName` 同理：它改变门禁 step 被允许做的事。**`stepSpecs` / `sidecarSpecs` 只承载 `computeResources`，所以资源调优仍然放行**——这一类覆盖改变不了扫描行为，拒绝它属于过度收紧。

**这条判据按 podTemplate 的“键”来判，而不是“附加即拒绝”**：**调度类键**这一组——`nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName`——是放行的：把扫描任务调度到有缓存或专属污点的节点是日常运维，拒绝它就是误报；其余所有键（`env`、`volumes`、`dnsConfig`、`securityContext`、`automountServiceAccountToken` 等，加上**将来新增的任何键**）一律拒绝。写成白名单而非黑名单是有意的：新字段默认落在拒绝一侧，比漏掉它们更安全。`serviceAccountName` 仍然直接拒绝——**如果你的站点确实想给扫描器用专用 SA**，把它从这条判据里拆出来，按 [§4.5.5](#s4-5-5) 的样式改成批准清单（`contains(['<approved-scanner-service-account>'], serviceAccountName)`）；不要删除整个条件。

**一个容易绊倒的差异**：任务级 `podTemplate` **不会**被 Tekton 的 defaulting 填充（没有就真的是没有），而 run 级的 `taskRunTemplate.podTemplate` **从不为空**（defaulting 会把 `default-pod-template` 合并进来）。所以同样的“按键判”模式只在任务级一侧可行；run 级只能单独判 `env` 一项。

**第六条判据 `runWideEnvCount` 堵的是同一件事的 run 级入口**：`spec.taskRunTemplate.podTemplate` 作用于本次运行的**每一个** TaskRun，在那里设 env 等价于在 `taskRunSpecs` 里瞄准门禁任务——而只看 `taskRunSpecs` 的判据对它完全失明。这一条**只判 `env`**：run 级 podTemplate 里的 `nodeSelector` / `imagePullSecrets` / `tolerations` 是正常配置，连坐会造成大面积误拒。

**四条参数判据里，`trivySkipped` 最容易被漏掉**：`skipTrivyScan` 不是“扫描的一个选项”——它是 `trivy-scanner` 任务的 `when` 守卫。设成 `"true"`，该任务根本不会被创建，于是其余三条参数判据**全部空转为 false**，策略照样放行。**只判扫描参数、不判“扫描到底跑不跑”，等于没判。**

其余三条判据的取舍写在注释里；这里只强调“不传”的语义——与多数白名单判据正相反：

| 判据 | 参数不传时 | 为什么这样定义 |
|---|---|---|
| `trivySkipped` | **放行** | 模板默认 `skipTrivyScan: "false"`——不传即扫描；显式取值必须严格等于 `"false"`（任何其他值，包括空字符串，都拒绝） |
| `trivyGateOff` | **放行** | 模板默认 `trivyExitCode: "1"`——不传即门禁开启。按参数契约，**只有 `""` 和 `"0"` 是只报告不拦截**，所以判据只拒这两个值——像 `"2"` 这样的非零码仍会让运行失败，关不掉门禁 |
| `trivySeverityBad` | **放行** | 空列表表示 trivy 用自己的默认严重级别集合，比 `CRITICAL`+`HIGH` 更宽——更严而不是更松 |
| `trivyExtraArgsBad` | **放行** | 空数组只表示“没有额外参数”；非空一律拒绝，见注释 |
| `gateOverrideCount` | **放行** | 没有 `taskRunSpecs` 就没有覆盖；被拒的只有“**瞄准门禁任务**、且调度类键之外的 `podTemplate`”和任何 `serviceAccountName`——覆盖其他任务、`computeResources` 类覆盖、门禁任务上纯调度类的 `podTemplate` 都不受影响 |
| `runWideEnvCount` | **放行** | 没有 run 级 `taskRunTemplate.podTemplate.env` 就没有注入；**只判 `env` 一项**——run 级 `nodeSelector` / `imagePullSecrets` 等仍然放行 |

**前置条件锁定的是完整模板身份**（`resolver` + `kind` + `catalog` + `name` + `version`），而不只是名字。少锁任何一项，“来自其他来源的同名 Pipeline”就会落进本规则的判定范围——那是一个默认值完全不同的对象。反过来也要说清：**身份不匹配的请求会跳过——也就是放行**。“只允许使用批准过的模板”是另一件事，归 [§4.1.1](#s4-1-1) 的模板白名单管；两层必须一起装。

:::warning 本策略的承诺边界：只管请求显式写出的内容

精确的表述是：它保证**没有人能通过 PipelineRun 的参数或任务级覆盖把漏洞门禁关掉**——`skipTrivyScan` 跳不掉扫描，`trivyExitCode` 设不成只报告不拦截的 `""` / `"0"`，`trivySeverity` 收窄不到漏掉高危级别，`trivyExtraArgs` 夹带不了绕过标志，门禁任务带不了**调度类键之外**的 `podTemplate` 覆盖或任何 `serviceAccountName` 覆盖（调度类键放行，见上文“按键判”说明），也没法经 run 级 `taskRunTemplate.podTemplate.env` 注入环境变量。

**有一处值得明说的、有意保留的残余风险**：run 级 podTemplate 只判 `env`，但它还有 `dnsConfig` / `securityContext` / `volumes` / `automountServiceAccountToken` 等字段——理论上这些同样能改变门禁 step 的解析、运行身份或可读文件。判据不对它们连坐，因为那也会拒掉 `nodeSelector` / `imagePullSecrets` 这类日常配置；更严的站点可以按同样形态把这些字段收进来，**但先想清楚这会拒掉哪些正常请求**。**另外，有一个机制事实让“拒绝任何 run 级 podTemplate”彻底行不通**：Tekton 的 defaulting webhook 先于 Kyverno 运行，会把 `config-defaults` 的 `default-pod-template` 合并进每一次运行（本文环境里是 `securityContext.fsGroup=65532`），所以 admission 看到的 `taskRunTemplate.podTemplate` **从不为空**——只判 `env` 一项是唯一既有效又无误报的形态。

**run 级的 `spec.taskRunTemplate.serviceAccountName` 同样不判**——有其理由，读者需要知道边界在哪。`taskRunTemplate` 恰好只有 `podTemplate` 和 `serviceAccountName` 两个字段（已用 `kubectl explain` 验证），而本策略管的是**扫描裁决**：门禁 step 跑的是 Task 自带的固定脚本，不使用集群凭证，所以更宽的运行身份**不会改变扫描结论**——真正在乎身份的任务是**拿凭证操作集群的那些**，即 [§4.5.5](#s4-5-5) 的部署阶段，那里 run 级 SA 由批准清单管。相应地，“谁可以创建运行、一次运行能拿到什么权限”属于 [§4.5.4](#s4-5-4) 的入口收敛与 RBAC，不在本策略的承诺之内。**一个相邻的陷阱**：admission 时该字段总是显式的（defaulting webhook 会填上 SA——取自 `config-defaults` 的 `default-service-account`，该键缺失时用 Tekton 内建默认值 `default`），所以“非空即拒”的模式会拒掉**所有**请求；要真正管它，就按 [§4.5.5](#s4-5-5) 用批准清单，并把默认值放进清单。

顺带说明 `gateOverrideCount` 的**严格性边界**：它拒绝“瞄准门禁任务、调度类键之外的 `podTemplate`”（`dnsConfig` 能改 registry 解析，`volumes` 能遮蔽挂载点，`env` 直接改变扫描行为）加上任何 `serviceAccountName`；**调度类键（`nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName`）是显式放行的**。剩下的唯一代价是“给扫描器配专用 SA”会被拒——**当这个合理需求出现时，把 `serviceAccountName` 从这条判据里拆出来，按 [§4.5.5](#s4-5-5) 改成批准清单**；不要删除整个条件。

以下这些它一概**不**保证：

- **扫描范围没有被放宽。**`trivy-config` workspace 可以绑一个你控制的 ConfigMap，经 `trivy.yaml` 或忽略规则把发现过滤掉——参数全绿、门禁“开着”，结果却不再代表完整的漏洞面。堵住它需要叠加 `trivy-config` workspace 白名单（在完整 profile 里；判据是 `trivyConfigBad`），而白名单只管“绑的是哪个对象”——**对象的内容仍依赖配置对象自身的 admission 与评审**。
- **扫描真的跑完了。**`--help` 一类参数会让 trivy 退出码为 0 且不产报告；这一类只有 [§4.4.1](#s4-4-1) 读 `trivy-summary-metadata` 的 `status` 才看得见。
- **平台侧留下了证据。**同样是 [§4.4.1](#s4-4-1) 那一层的事。
- **构建的每个镜像都被扫过。**模板把**整个 `images` 数组**交给 build-image（`$(params.images[*])`），却只把 **`images[0]`** 交给 trivy（`scanTargets: [$(params.images[0])]`），部署也只用 `images[0]`。于是 `images` 含多个元素的请求会**构建并推送若干未扫描的镜像**——而最小版**不判 `images` 的元素个数**。“门禁开着”仍然成立；“进 registry 的每个镜像都过了门禁”不成立。因此完整 profile 的 `imagesBad` 要求**恰好一个**元素（这不是过度收紧——它堵的就是这个缺口）；要真正支持多镜像，要么让模板逐个扫描，要么另加一条“每个镜像都必须有匹配扫描记录”的审计策略。

换句话说：最小版拦住“开关被扳”；完整 profile 补上“不受控的配置入口”；[§4.4.1](#s4-4-1) 再补“到底跑没跑、报了什么”。三层各管一段。

:::

##### 再上完整 profile：按组取用——不必全盘照抄

上面那条策略只管一件事：漏洞门禁。完整 profile 把同一模板的其他治理面也焊死，**判据划分成互不依赖的组**——按你的实际治理范围取用；删掉一组不影响其他组：

| 判据组 | 包含 | 删掉会失去什么 |
|---|---|---|
| **Trivy 门禁** | `trivySkipped` / `trivyGateOff` / `trivySeverityBad` / `trivyExtraArgsBad` / `gateOverrideCount` / `runWideEnvCount` | 正是最小版的**六**条判据——**六条一条都不能少**：没有 `trivySkipped`，一个 `skipTrivyScan: "true"` 就让其余三条空转；没有 `gateOverrideCount` 或 `runWideEnvCount`，一条 `podTemplate.env`（按任务或按 run 附加）就能在参数全绿的同时改变扫描行为 |
| **Sonar 门禁** | `sonarBad` / `sonarPropertiesBad` / `sonarProjectKeyBad` | 代码扫描可被空 `sonarURL` 整个跳过，或被覆盖受管键（端点 / 项目身份 / 分支锚点）的 `sonarProperties` 条目架空；非规范条目（前导空白 / `#` / 内嵌换行）一律拒绝——前缀匹配这才可靠 |
| **Hub 来源身份** | `hubSourceBad` | 请求可以自带 `url` 从外部拉取同名模板；白名单沦为摆设 |
| **扫描目标与传输** | `imagesBad` / `tlsVerifyBad` / `trivySkipped` | 可以推送多个镜像却只扫第一个；可以打开 `--insecure`；trivy 任务可以被整个跳过 |
| **构建输入** | `mavenExecutionInputsBad` 等 / `pythonBuildInputsBad` | 构建期执行什么由请求方决定（改 goals、换构建镜像、注入 pre-build 脚本） |
| **可选 workspace 白名单** | `sonarCredentialsBad` / `trivyConfigBad` / `pipConfBad` 等 | 配置入口失控；尤其 `trivy-config` 直接影响扫描范围——删掉它意味着即使门禁参数全绿，扫描也能被放宽 |

**最可能需要按环境裁剪的是最后一组**——白名单里的对象名必须换成你自己批准的 Secret / ConfigMap；你环境里不存在的 workspace，直接删掉对应判据即可。

**关键判据**——每组各自计算自己的布尔值，`deny.conditions.any` 任一命中即拒（**片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块里）：

```yaml
      # EXCERPT -- key conditions only, NOT a standalone manifest; the
      # indentation is kept from the full policy, so this block alone does
      # not parse. Apply the complete YAML from the details block below.
        # (1) Source identity: request-level url / multiple type params / a non-artifact type
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
      validate:
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"          # (1) source was swapped
                operator: Equals
                value: true
              # (2) a gate is not actually enabled
              #     (empty sonarURL / skipTrivyScan != "false" / trivyExitCode turned off)
              # (3) the effective configuration was hollowed out
              #     (governed-key entries in sonarProperties / tlsVerify / images
              #      / trivySeverity / trivyExtraArgs)
              # (4) a workspace source is not in the approved list
              # ...every condition is in the full YAML below
```

:::details 完整策略 YAML：official-template-gates-on

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: official-template-gates-on
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: quality-gates-must-stay-enabled
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: refKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: refCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: refName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: refVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: hubTypeCount
          variable:
            jmesPath: "length((request.object.spec.pipelineRef.params || `[]`)[?name=='type'])"
        - name: hubType
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='type'].value | [0] || ''"
            default: ""
        - name: hubURLCount
          variable:
            jmesPath: "length((request.object.spec.pipelineRef.params || `[]`)[?name=='url'])"
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
        - name: sonarURL
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='sonarURL'].value | [0] || ''"
            default: ""
        - name: sonarProjectKeyCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='sonarProjectKey'])"
        - name: tlsVerifyCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='tlsVerify'])"
        - name: tlsVerify
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='tlsVerify'].value | [0] || ''"
            default: ""
        - name: imagesCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='images'])"
        - name: scanImages
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='images'].value | [0] || `[]`"
        - name: skipTrivy
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='skipTrivyScan'].value | [0] || ''"
            default: ""
        - name: skipTrivyPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='skipTrivyScan']) > `0`"
        - name: sonarCredentialsCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='sonar-credentials'])"
        - name: sonarCredentialsWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='sonar-credentials'] | [0] || `{}`"
        - name: sonarCredentialsSecret
          variable:
            jmesPath: "sonarCredentialsWorkspace.secret.secretName || ''"
            default: ""
        - name: sonarSettingsCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='sonar-settings'])"
        - name: sonarSettingsWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='sonar-settings'] | [0] || `{}`"
        - name: sonarSettingsConfigMap
          variable:
            jmesPath: "sonarSettingsWorkspace.configMap.name || ''"
            default: ""
        - name: registryConfigCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='registry-config'])"
        - name: registryConfigWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='registry-config'] | [0] || `{}`"
        - name: registryConfigSecret
          variable:
            jmesPath: "registryConfigWorkspace.secret.secretName || ''"
            default: ""
        - name: sonarCertificateCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='sonar-certificate'])"
        - name: sonarCertificateWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='sonar-certificate'] | [0] || `{}`"
        - name: sonarCertificateConfigMap
          variable:
            jmesPath: "sonarCertificateWorkspace.configMap.name || ''"
            default: ""
        - name: caBundleCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='ca-bundle'])"
        - name: caBundleWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='ca-bundle'] | [0] || `{}`"
        - name: trivyConfigCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='trivy-config'])"
        - name: trivyConfigWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='trivy-config'] | [0] || `{}`"
        - name: trivyConfigConfigMap
          variable:
            jmesPath: "trivyConfigWorkspace.configMap.name || ''"
            default: ""
        - name: caBundleConfigMap
          variable:
            jmesPath: "caBundleWorkspace.configMap.name || ''"
            default: ""
        # compute verdicts INSIDE JMESPath (exact string compare) to avoid the Kyverno
        # operator type-coercion gotcha where NotEquals treats "1" as if it equalled "false"
        - name: sonarBad
          variable:
            # Non-empty is insufficient: use the approved quality-gate endpoint.
            jmesPath: "sonarURL != '<approved-sonar-url>'"
        # Content, not presence: sonarProperties is the ONLY way to pass legitimate
        # analysis settings (exclusions, coverage report paths), and the platform
        # injects the sonar.pullrequest.* group through it on every triggered run --
        # banning the param outright would deny that whole class (the §4.2.4 lesson).
        # Scanner 0.7 merges these entries AFTER sonarHostURL / sonarProjectKey and
        # BEFORE the quality-gate normalisation, so exactly three governed keys can be
        # overridden here; sonar.qualitygate.* cannot (normalised last) but is listed
        # anyway so a future reordering cannot silently open it.
        # Canonical form FIRST (same normative gate as the TaskRun layer,
        # section 4.2.4 rule 2): a prefix match alone is evadable -- a leading
        # blank in ' sonar.branch.name=x' misses every starts_with below, yet
        # the Task writes the line into the properties file verbatim and
        # java.util.Properties drops the leading blank, so the governed key
        # still takes effect. Rejecting non-canonical items closes that whole
        # class before the prefix list runs.
        - name: sonarPropsItems
          variable:
            jmesPath: "to_array((request.object.spec.params || `[]`)[?name=='sonarProperties'].value | [0] || `[]`)[].to_string(@)"
            default: []
        - name: sonarPropsNonCanonical
          variable:
            jmesPath: "length(sonarPropsItems[?regex_match('^[A-Za-z][A-Za-z0-9._-]*=[^\\r\\n]*$', @) == `false`]) > `0`"
        - name: sonarPropertiesBad
          variable:
            jmesPath: >-
              sonarPropsNonCanonical
              || length(sonarPropsItems[?starts_with(@, 'sonar.host.url=')
                || starts_with(@, 'sonar.projectKey=')
                || starts_with(@, 'sonar.branch.name=')
                || starts_with(@, 'sonar.login=')
                || starts_with(@, 'sonar.token=')
                || starts_with(@, 'sonar.password=')
                || starts_with(@, 'sonar.qualitygate.')]) > `0`
        - name: sonarProjectKeyBad
          variable:
            # Absence uses the Pipeline's repository-derived default.
            jmesPath: "sonarProjectKeyCount > `0`"
        # A per-task override travels in the same request and is invisible to
        # every parameter judgment: podTemplate.env reaches every step container
        # (so it can narrow trivy's severity filter without touching a param),
        # and serviceAccountName changes what the gate step may do. stepSpecs /
        # sidecarSpecs carry computeResources only, so resource tuning stays
        # allowed -- rejecting that would be stricter than the gate needs.
        # The run-wide equivalent: taskRunTemplate.podTemplate applies to every
        # TaskRun of this run, so env set here reaches the governed task too.
        # Only env is judged. Besides nodeSelector / imagePullSecrets being
        # ordinary configuration, "deny any run-wide podTemplate" would deny
        # everything: Tekton's defaulting webhook merges config-defaults'
        # default-pod-template in before Kyverno sees the request, so this field
        # is never actually absent. Residual fields are in the boundary note.
        - name: runWideEnvCount
          variable:
            jmesPath: "length(request.object.spec.taskRunTemplate.podTemplate.env || `[]`)"
            default: 0
        - name: gateOverrideCount
          variable:
            jmesPath: >-
              length((request.object.spec.taskRunSpecs || `[]`)[?contains(['trivy-scanner','sonarqube-scanner'], pipelineTaskName)
              && (serviceAccountName
              || length(keys(podTemplate || `{}`)) != length(keys(podTemplate || `{}`)[?contains(['nodeSelector','tolerations','affinity','imagePullSecrets','priorityClassName'], @)]))])
            default: 0
        - name: trivySkipped
          variable:
            # Absence uses the Pipeline default "false". An explicitly supplied
            # value, including empty, must equal the exact when value "false".
            jmesPath: "skipTrivyPresent && skipTrivy != 'false'"
        - name: tlsVerifyBad
          variable:
            # Absence inherits true; explicit values must be exactly true.
            jmesPath: "tlsVerifyCount > `1` || (tlsVerifyCount == `1` && tlsVerify != 'true')"
        - name: imagesBad
          variable:
            # Buildah pushes every element but Trivy scans only images[0].
            jmesPath: >-
              imagesCount != `1`
              || length(scanImages) != `1`
              || length(scanImages[?regex_match('^[-A-Za-z0-9._:/@+]+$', @) == `false`]) > `0`
        - name: sonarCredentialsBad
          variable:
            jmesPath: >-
              sonarCredentialsCount > `1`
              || (sonarCredentialsCount == `1`
              && sonarCredentialsSecret != 'approved-sonar-credentials')
        - name: sonarSettingsBad
          variable:
            jmesPath: >-
              sonarSettingsCount > `1`
              || (sonarSettingsCount == `1`
              && sonarSettingsConfigMap != 'approved-sonar-settings')
        - name: registryConfigBad
          variable:
            jmesPath: >-
              registryConfigCount > `1`
              || (registryConfigCount == `1`
              && registryConfigSecret != 'approved-registry-config')
        - name: sonarCertificateBad
          variable:
            jmesPath: >-
              sonarCertificateCount > `1`
              || (sonarCertificateCount == `1`
              && sonarCertificateConfigMap != 'approved-sonar-certificate')
        - name: trivyConfigBad
          variable:
            # Absence is fine: without the workspace the Task falls back to its own
            # defaults. Bound to anything other than the reviewed ConfigMap -- including
            # a PVC or Secret, where configMap.name resolves to '' -- is a violation,
            # because trivy.yaml and the ignore file both relax the scan.
            jmesPath: >-
              trivyConfigCount > `1`
              || (trivyConfigCount == `1`
              && trivyConfigConfigMap != 'approved-trivy-config')
        - name: caBundleBad
          variable:
            jmesPath: >-
              caBundleCount > `1`
              || (caBundleCount == `1`
              && caBundleConfigMap != 'approved-ca-bundle')
        # Structured Trivy gate parameters. Absence is meaningful: the template
        # default already turns the gate on, so only an explicit value can weaken it.
        - name: trivyExitCodeCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='trivyExitCode'])"
            default: 0
        - name: trivyExitCode
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivyExitCode'].value | [0] || ''"
            default: ""
        - name: trivySeverity
          variable:
            # array-typed; the default must be an empty list, not '', or every
            # comparison below silently changes meaning
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivySeverity'].value | [0] || `[]`"
        - name: trivyExtraArgs
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivyExtraArgs'].value | [0] || `[]`"
        - name: trivyGateOff
          variable:
            # Report-only mode is exactly what the parameter contract calls "" or
            # "0"; any other non-zero code still fails the run, so it is not a way
            # to turn the gate off. A garbage value is fail-closed too -- trivy
            # errors out and the task fails. Sites that want one fixed code can
            # tighten this to `trivyExitCode != '1'`.
            jmesPath: >-
              trivyExitCodeCount > `0`
              && (trivyExitCode == '' || trivyExitCode == '0')
        - name: trivySeverityBad
          variable:
            # An empty list means trivy evaluates its own default severity set,
            # which is wider than CRITICAL+HIGH -- stricter, so it passes. A pinned
            # list must still cover both.
            jmesPath: >-
              length(trivySeverity) > `0`
              && !(contains(trivySeverity, 'CRITICAL') && contains(trivySeverity, 'HIGH'))
        - name: trivyExtraArgsBad
          variable:
            # The structured parameters are the gate interface. Anything left in
            # extraArgs either duplicates them, making the effective gate depend on
            # flag order, or disables scanning outright -- --help makes trivy print
            # usage and exit 0 without scanning anything.
            jmesPath: "length(trivyExtraArgs) > `0`"
      preconditions:
        all:
          - key: "{{ resolver }}"
            operator: Equals
            value: hub
          - key: "{{ refKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ refCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ refName }}"
            operator: AnyIn
            value:
              - java-image-build-scan-deploy
              - python-image-build-scan-deploy
          - key: "{{ refVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          the official template must keep its quality gates enabled: an approved
          Sonar endpoint, every sonarProperties item a canonical single-line
          'key=value', no entry overriding a governed key
          (sonar.host.url / sonar.projectKey / sonar.branch.name / credentials
          / sonar.qualitygate.*), no sonarProjectKey override, skipTrivyScan
          exactly "false", the Trivy gate kept out of report-only mode
          (trivyExitCode neither empty nor "0"), trivySeverity empty or covering
          CRITICAL and HIGH, no gate switches in trivyExtraArgs,
          TLS verification on, exactly one shell-safe image, and reviewed objects
          behind every optional workspace.
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarPropertiesBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarProjectKeyBad }}"
                operator: Equals
                value: true
              - key: "{{ trivySkipped }}"
                operator: Equals
                value: true
              - key: "{{ gateOverrideCount }}"
                operator: NotEquals
                value: 0
              - key: "{{ runWideEnvCount }}"
                operator: NotEquals
                value: 0
              - key: "{{ trivyGateOff }}"
                operator: Equals
                value: true
              - key: "{{ trivySeverityBad }}"
                operator: Equals
                value: true
              - key: "{{ trivyExtraArgsBad }}"
                operator: Equals
                value: true
              - key: "{{ tlsVerifyBad }}"
                operator: Equals
                value: true
              - key: "{{ imagesBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarCredentialsBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarSettingsBad }}"
                operator: Equals
                value: true
              - key: "{{ registryConfigBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarCertificateBad }}"
                operator: Equals
                value: true
              - key: "{{ trivyConfigBad }}"
                operator: Equals
                value: true
              - key: "{{ caBundleBad }}"
                operator: Equals
                value: true
    - name: java-build-inputs-must-stay-approved
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: refKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: refCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: refName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: refVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: mavenSubdirectoryCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenSubdirectory'])"
        - name: mavenGoalsCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenGoals'])"
        - name: mavenImageCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenImage'])"
        - name: mavenMirrorURLPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenMirrorURL']) > `0`"
        - name: mavenMirrorURL
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='mavenMirrorURL'].value | [0] || ''"
            default: ""
        - name: mavenCertPathPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenCertPath']) > `0`"
        - name: mavenCertPath
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='mavenCertPath'].value | [0] || ''"
            default: ""
        - name: mavenSettingsCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-settings'])"
        - name: mavenSettingsWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-settings'] | [0] || `{}`"
        - name: mavenSettingsConfigMap
          variable:
            jmesPath: "mavenSettingsWorkspace.configMap.name || ''"
            default: ""
        - name: mavenCertCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-cert'])"
        - name: mavenCertWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-cert'] | [0] || `{}`"
        - name: mavenCertConfigMap
          variable:
            jmesPath: "mavenCertWorkspace.configMap.name || ''"
            default: ""
        - name: mavenServerSecretCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-server-secret'])"
        - name: mavenServerSecretWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-server-secret'] | [0] || `{}`"
        - name: mavenServerSecret
          variable:
            jmesPath: "mavenServerSecretWorkspace.secret.secretName || ''"
            default: ""
        - name: mavenLocalRepoCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-local-repo'])"
        - name: mavenLocalRepoWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-local-repo'] | [0] || `{}`"
        - name: mavenLocalRepoPVC
          variable:
            jmesPath: "mavenLocalRepoWorkspace.persistentVolumeClaim.claimName || ''"
            default: ""
        - name: mavenTrustStoreCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-trust-store'])"
        - name: mavenTrustStoreWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-trust-store'] | [0] || `{}`"
        - name: mavenTrustStoreSecret
          variable:
            jmesPath: "mavenTrustStoreWorkspace.secret.secretName || ''"
            default: ""
        - name: mavenExecutionInputsBad
          variable:
            # Absence preserves the pinned root/package/image defaults.
            jmesPath: >-
              mavenSubdirectoryCount > `0`
              || mavenGoalsCount > `0`
              || mavenImageCount > `0`
        - name: mavenMirrorURLBad
          variable:
            # Missing/empty uses the trusted default; explicit endpoints are allowlisted.
            jmesPath: "mavenMirrorURLPresent && mavenMirrorURL != '' && mavenMirrorURL != '<approved-maven-mirror-url>'"
        - name: mavenCertPathBad
          variable:
            # Missing inherits the pinned default ca.cert; explicit values are exact.
            jmesPath: "mavenCertPathPresent && mavenCertPath != '<approved-maven-cert-path>'"
        - name: mavenSettingsBad
          variable:
            # Maven copies a bound settings.xml before generated mirror handling.
            jmesPath: >-
              mavenSettingsCount > `1`
              || (mavenSettingsCount == `1`
              && mavenSettingsConfigMap != 'approved-maven-settings')
        - name: mavenCertBad
          variable:
            jmesPath: >-
              mavenCertCount > `1`
              || (mavenCertCount == `1`
              && mavenCertConfigMap != 'approved-maven-cert')
        - name: mavenServerSecretBad
          variable:
            jmesPath: >-
              mavenServerSecretCount > `1`
              || (mavenServerSecretCount == `1`
              && mavenServerSecret != 'approved-maven-server')
        - name: mavenLocalRepoBad
          variable:
            jmesPath: >-
              mavenLocalRepoCount > `1`
              || (mavenLocalRepoCount == `1`
              && mavenLocalRepoPVC != 'approved-maven-local-repo')
        - name: mavenTrustStoreBad
          variable:
            jmesPath: >-
              mavenTrustStoreCount > `1`
              || (mavenTrustStoreCount == `1`
              && mavenTrustStoreSecret != 'approved-maven-trust-store')
      preconditions:
        all:
          - key: "{{ resolver }}"
            operator: Equals
            value: hub
          - key: "{{ refKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ refCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ refName }}"
            operator: Equals
            value: java-image-build-scan-deploy
          - key: "{{ refVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          the java template must not override Maven execution inputs and must bind
          only reviewed objects to the Maven workspaces.
        deny:
          conditions:
            any:
              - key: "{{ mavenExecutionInputsBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenMirrorURLBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenCertPathBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenSettingsBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenCertBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenServerSecretBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenLocalRepoBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenTrustStoreBad }}"
                operator: Equals
                value: true
    - name: python-build-inputs-must-stay-approved
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: refKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: refCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: refName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: refVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: preBuildScriptCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='preBuildScript'])"
        - name: pythonImageCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='pythonImage'])"
        - name: preBuildArgsCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='preBuildArgs'])"
        - name: preBuildRequirementsFileCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='preBuildRequirementsFile'])"
        - name: preBuildPipConfFileCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='preBuildPipConfFile'])"
        - name: pipConfCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='pip-conf'])"
        - name: pipConfWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='pip-conf'] | [0] || `{}`"
        - name: pipConfConfigMap
          variable:
            jmesPath: "pipConfWorkspace.configMap.name || ''"
            default: ""
        - name: pythonBuildInputsBad
          variable:
            # The pre-build script and its interpreter image decide what actually
            # runs before the image is built, so the approved profile forbids
            # overriding them at request time.
            jmesPath: >-
              preBuildScriptCount > `0`
              || pythonImageCount > `0`
              || preBuildArgsCount > `0`
              || preBuildRequirementsFileCount > `0`
              || preBuildPipConfFileCount > `0`
        - name: pipConfBad
          variable:
            # pip.conf redirects package resolution, so an unreviewed binding is a
            # supply-chain input. Not binding it at all is fine.
            jmesPath: >-
              pipConfCount > `1`
              || (pipConfCount == `1`
              && pipConfConfigMap != 'approved-pip-conf')
      preconditions:
        all:
          - key: "{{ resolver }}"
            operator: Equals
            value: hub
          - key: "{{ refKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ refCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ refName }}"
            operator: Equals
            value: python-image-build-scan-deploy
          - key: "{{ refVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          the python template must not override pre-build execution inputs and must
          bind only the reviewed ConfigMap to pip-conf.
        deny:
          conditions:
            any:
              - key: "{{ pythonBuildInputsBad }}"
                operator: Equals
                value: true
              - key: "{{ pipConfBad }}"
                operator: Equals
                value: true
```

:::

:::details 自检用例：装好策略后用 --dry-run=server 逐条过一遍

按每一行构造一个 PipelineRun，用 `kubectl create --dry-run=server` 提交；核对结果是否与“预期”一致。不一致就说明你的策略和本节的有差异——沿最后一列排查。

| 提交什么 | 预期 |
|---|---|
| 完全合规的 profile + 全部批准的 workspace；以及同一 profile 显式带单个 `type=artifact` | 放行 |
| `trivyExitCode` / `trivySeverity` 不传（继承模板默认值，门禁开启） | 放行 |
| 批准的四元组之外再带请求级 `url`，或显式 `type=tekton` | 拒绝 |
| 空白 / 未批准的 Sonar 端点；显式覆盖 `sonarProjectKey` | 拒绝 |
| `sonarProperties` 含覆盖受管键的条目（`sonar.host.url=` / `sonar.projectKey=` / `sonar.branch.name=` / 凭证键 / `sonar.qualitygate.` 前缀，命中任意一个） | 拒绝 |
| `sonarProperties` 只含合法分析设置（如 `sonar.exclusions=**/vendor/**`）或平台注入的 `sonar.pullrequest.*` 组 | 放行 |
| `sonarProperties` 含非规范条目（前导空白 / `#` 注释 / 单条目内嵌换行） | 拒绝（规范化闸门——带前导空白的写法曾能溜过纯前缀匹配） |
| `sonarProperties` 以**对象**形式传入（类型回退） | 拒绝——JSON 编码不匹配规范的 `key=value` 形态（与 [§4.2.4](#s4-2-4) 探针 26 同一判定）；不会产生策略错误 |
| 非法的 `skipTrivyScan` | 拒绝 |
| `trivyExitCode` 显式设为 `"0"` 或空字符串（只报告不拦截，即门禁关闭） | 拒绝 |
| `trivyExitCode` 设为其他非零码（如 `"2"`） | 放行——按契约它仍会让运行失败 |
| `trivySeverity` 非空但未同时覆盖 `CRITICAL` 和 `HIGH` | 拒绝 |
| `trivyExtraArgs` 非空——无论是 `["--help"]` 这类不产报告的调用，还是重复的 `--exit-code` / `--severity` | 拒绝 |
| `tlsVerify=false`，或 `tlsVerify` 为 shell 文本 | 拒绝 |
| `images` 缺失 / 不安全 / 多元素 | 拒绝 |
| 覆盖构建输入参数（java 的 `mavenSubdirectory` / `mavenGoals` / `mavenImage`；python 的 `preBuildScript` / `pythonImage`） | 拒绝 |
| 未批准或来源类型不对的 Sonar 凭证 / 设置 / 证书，Maven settings / 证书 / server / 本地仓库，registry 配置、CA bundle，以及保守限制的 `maven-trust-store` | 拒绝 |
| `trivy-config` 不绑定；或绑定到批准的 ConfigMap | 放行 |
| `trivy-config` 绑定到别的 ConfigMap；或以 PVC 绑定（`configMap.name` 读回为空） | 拒绝 |
| 附加到门禁任务（`trivy-scanner` / `sonarqube-scanner`）的 `taskRunSpecs[].podTemplate` **只含调度类键**（`nodeSelector` / `tolerations` 等） | 放行 |
| 同一位置出现 `env` / `volumes` / `dnsConfig`（哪怕和调度类键混在一起），或出现 `serviceAccountName` | 一律拒绝 |
| 同样的覆盖附加到**其他**任务；或在门禁任务上经 `stepSpecs` 设 `computeResources` | 放行 |
| run 级 `taskRunTemplate.podTemplate.env`；对比只有 run 级 `nodeSelector` | 拒绝 / 放行 |

**结果对不上时先看哪里**：全部放行 → 多半是前置条件根本没匹配上；先检查 `pipelineRef` 四元组（catalog / kind / name / version）与你提交的是否一致。该放行的被拒 → 看拒绝消息点名的是哪条判据；多半是 workspace 白名单里的对象名和你环境里的不一样。

这套用例验证的是 **admission 可见的契约**；它不证明 Task 运行时真的消费这些 workspace（例如，不证明 Maven 会去读 `maven-trust-store`）。

:::

:::warning 升级顺序：策略必须与模板一起升级，否则合规请求会被你自己的策略拒掉

这条判据钉住了模板的参数面。一旦模板引入新的门禁参数（比如从“把开关塞进 `trivyExtraArgs`”改为结构化的 `trivyExitCode` / `trivySeverity`），**按旧参数面写的策略不会“放跑东西”——它会开始拒绝每一个合规请求**：旧判据要求 `trivyExtraArgs` 严格等于某个列表，而新约定下该参数本应为空。

症状是升级后流水线**在 admission 处全面卡死**，拒绝消息来自你自己的 ClusterPolicy。所以升级模板时按这个顺序来：

1. 先查看新模板版本的参数面。**取哪份副本取决于模板是怎么被引用的**：
   - 集群内的 `Pipeline` 对象（`resolver: cluster`）——在**运行 Tekton 的那个集群**上执行 `kubectl -n <ns> get pipeline <name> -o yaml`；
   - 经 hub / git resolver 引用的模板——它**不是集群里的 `Pipeline` 资源**，`kubectl get pipeline` 会直接返回 `NotFound`。要么从 hub / catalog 侧获取，要么用一次真实运行的解析结果：`kubectl -n <ns> get pipelinerun <one-real-run> -o jsonpath='{.status.pipelineSpec}'`——那份副本才是**实际生效**的定义；
2. 更新策略判据，并用 `--dry-run=server` 确认新版本的合规形态能被放行；
3. 然后才切换模板版本，更新步骤里钉住的 `refVersion` 值。

反过来做——先切模板、后修策略——会让过渡窗口变成**全拒**而不是全放：爆炸半径大，但不是静默的，因此是更安全的失败方向。

:::

:::warning 本节的能力边界

策略只能约束 **PipelineRun admission 时可见的参数与 workspace 引用**。源码 workspace 里的 `sonar-project.properties`、已批准 Secret / ConfigMap / PVC 的实际内容、镜像是否真由预期源码构建，须分别由可信模板、配置对象 admission 和供应链证明来约束——**不要把“引用了已批准对象”误当成“对象内容已被审计”**。

:::

**与 [§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4) 的关系**：前置拦截管“参数在 PipelineRun 层的取值”；主路径管“最终展开进任务的生效值”。两者叠加——前置拦截改善体验，TaskRun 层为每一种模板形态兜底。

#### 4.2.6 注入默认值（mutate） {#s4-2-6}

- **管什么**：给没有显式设置的 PipelineRun 注入平台默认值（治理标签、默认超时）。
- **难在哪**：注入不得覆盖调用方的显式选择——否则就从“补默认值”变成“强行改写用户输入”。
- **策略怎么分层**：每个注入字段无一例外使用 `+()` 锚（不存在才添加）——标签键和 `timeouts` 字段**都**需要它；裸写标签键会强行覆盖调用方的显式取值。
- **管不了什么**：mutate 不产生 PolicyReport 违规记录（同 [§4.2.3](#s4-2-3)）；它是补全，不是校验。

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-run-defaults
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: inject-label-and-default-timeout
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(policy.alauda.io/gated): "true"
          spec:
            +(timeouts):
              pipeline: 1h0m0s
```

**预期形态**（用 `--dry-run=server -o yaml` 直接观察 mutation 结果）：没写 `timeouts` 的运行，输出对象里会带上 `policy.alauda.io/gated: "true"` 和 `timeouts.pipeline: 1h0m0s`；显式写了 `timeouts.pipeline: 30m0s` 的运行保持 `30m0s`；显式写了 `policy.alauda.io/gated: "false"` 的运行保持 `"false"`。对 resolver 引用的运行同样适用。
#### 清理（§4.2）

按照 [§4.0.4](#s4-0-4) 中的两条规则进行清理：

:::warning 前三个策略是互斥的替代方案——不要在同时安装它们的情况下进行验证

`gate-param-contract`（deny，[§4.2.1](#s4-2-1)）、`gate-param-cancel-existing`（mutate-existing 取消父运行，[§4.2.2](#s4-2-2)）与 `gate-param-mutate-to-cancel`（admission mutate 取消门禁 TaskRun，[§4.2.3](#s4-2-3)）是**对同一不合规输入的三种响应**；在生产环境中，请按 [§4.2.3](#s4-2-3) 的对比表**只选其一**。三者同时安装时，deny 会先拦截门禁 TaskRun 的 CREATE，另外两个策略所期待的 `Cancelled` 终态**永远不会出现**——逐节验证时，请安装一个、验证一个、删除一个，否则你会错误地得出另外两个"不生效"的结论。

:::

通过所有权台账按记录的 UID 删除七个集群级策略（**注意上面的互斥提示**——逐节验证意味着一次只安装并删除一个，因此到这一步只会剩下你仍保持安装的那些）。

⚠️ 下面的列表只能包含**本演练中实际创建并记录在 UID 所有权台账中**的策略。不要添加你从未创建过的名称；如果同名对象已被替换，辅助脚本会因 UID 不匹配而跳过它——不要为了"全部清干净"而退回到仅按名称的手动删除。

```bash
for pol in gate-param-contract gate-param-cancel-existing \
  gate-param-mutate-to-cancel sonar-branch-analysis-branch-contract \
  trivy-gate-must-stay-on official-template-gates-on pipeline-run-defaults; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
# The two runtime fixtures: their PolicyReport rows would otherwise read as this
# section's verdicts on a later section's re-run (§4.0.5).
kubectl delete pipelinerun -n policy-poc gate-cancel-invalid gate-cancel-compliant \
  --ignore-not-found
```

`policy-poc` 中的 `Role/kyverno-background-pipelineruns` 及同名 RoleBinding 会由 namespace 的级联删除回收；无需单独删除。

### 4.3 真实的质量门禁失败（契约 3–6 落在模板侧） {#s4-3}

**通用契约**：硬门禁的"失败"发生在流水线内部——门禁任务读取前置 results，未达标时 exit 1，Tekton 原生将该运行标记为 `Failed`，DAG 会跳过排在门禁之后的任务。本节 Kyverno **不贡献任何新策略**：它的贡献在 [§4.1](#s4-1)（保证模板身份）与 [§4.2](#s4-2)（保证门禁参数）；失败本身不需要——也绝不能——由 admission 系统制造（[§2.2](#s2-2) 的反机制）。

模板设计检查清单（[§2.3](#s2-3) 契约落在模板作者身上的形态）：

- **数据绑定 / 门禁内聚**（契约 4）：自带门禁的扫描器（如 `sonarqube-scanner`，或 [§3.3](#s3-3) 的 fixture）把"读取被测数据 + 按规则判定 + 未达标时自我失败"内聚在**单个任务**内——门禁开关 `enableScanQualityGate` / `enableAnalyzeQualityGate` 加上规则 `analyzeQualityGateRules` 就是它的契约。如果你的门禁是**独立的门禁任务**（消费上游 results），则改为用 `$(tasks.<producer>.results.<name>)` 把生效值显式接入门禁；
- **DAG 支配**（契约 5）：每个发布 / 推送 / 晋级任务都（直接或传递地）`runAfter` 门禁任务（自带门禁的扫描器或独立门禁）。门禁只能拦住它的后继——**排在门禁之前或与门禁并行的任务已经执行的部分不会被回滚**。所有副作用必须排在门禁之后；这是模板设计责任，admission 无法事后补救；
- **必须运行**（契约 3）：不给门禁留任何跳过路径。自带门禁扫描器的退出面是"把开关设为 `false`"（由 [§4.2.1](#s4-2-1) 焊死）和"在 `scan` 上挂 `when` / 空 matrix 来跳过它"（由 [§4.1.5](#s4-1-5) 的 `skippedTasks` Audit 兜底）；引用式模板还多一种"参数触发整体跳过"的反模式（例如 `sonarURL` 默认为空 + `when: sonarURL notin ["", " "]` ⇒ 省略该参数则整个扫描阶段被跳过）——修法思路相同：在策略侧把参数焊死，在模板侧收紧默认值，再叠加一条漂移 Audit；
- **finally 安全**（契约 6）：finally 在失败时执行，或在通过 `CancelledRunFinally` 取消时执行；纯粹的 `Cancelled` 不保证尚未启动的 finally 任务会被调度。不要把任何受门禁保护的副作用放进 finally。（`spec.status` 还有第三个同样会运行 finally 的值 `StoppedRunFinally`，其语义是**让已在运行的任务自行跑完**再停止；本文所有取消路径均使用 `CancelledRunFinally`——门禁不合规时的重点就是立即切断在途步骤，等它们跑完与取消的目的背道而驰。只有在想要"让当前步骤收尾后再停"的场景才切换到该值。另外，`spec.status` 还有**第四个**合法值 `PipelineRunPending`，与停止 / 取消毫无关系——其语义是"先不要启动"——因此判定"该运行已被取消"必须看**值**，绝不能看"非空"；见 [§6.2.3](#s6-2-3)。）

**基线形态**：用 `coverage: "30"` 运行 [§3.3](#s3-3) 的自带门禁 fixture（规则 `coverage>=80`，`enableAnalyzeQualityGate=true`）——

- `scan` 的任务侧质量门禁未达标 → **任务自身执行 `exit 1`**，写出 `code-scan-results.result=Failed`（真实的 0.7 Task 内部检查 SonarQube 的 `alert_status`，但该内部字段不属于输出契约）；
- PipelineRun 的终态是 **`Failed`**；
- `skippedTasks: [{name: release, reason: PipelineRun was stopping}]`——release 物理上从未被创建；
- finally 的 `notify` 照常成功执行。

这就是"自带门禁的扫描器支配发布"的基线形态：门禁与被测数据内聚在单个 `scan` 任务中，`release` 传递地 `runAfter` 它。平台目录 Task 的原生门禁能力工作方式相同——使用 `sonarqube-scanner`（0.7）时，`enableScanQualityGate` / `enableAnalyzeQualityGate` 未达标意味着任务自我失败。**注意这两个开关的治理层**：两个官方 0.3 模板都没有**把它们暴露为 Pipeline 参数**——Task 侧默认值 `"true"` 生效——因此像 [§4.2.5](#s4-2-5) 那样的 PipelineRun 层策略**既看不见也钉不住它们**；只有在 TaskRun 层（[§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)）才可能钉住——并注意控制器创建的 TaskRun 的 `spec.params` 同样只包含 Pipeline 显式传递的参数，因此未透传的开关在 admission 时表现为**缺失**（Task 默认值只在运行时填充），TaskRun 层判据因此写成"仅在显式传递且 ≠ `true` 时 deny；缺失放行"（[§4.2.4](#s4-2-4) 规则 ③ 的形态）。模板暴露它们的那一天，PipelineRun 层必须补上相应判据；`trivy-scanner`（0.6）通过退出码在漏洞超阈值时失败——官方模板通过 `trivyExitCode` 参数控制它，**其默认值为 `"1"`，即门禁默认开启**；策略要防的是它被显式关成 `"0"` 或空值（见 [§4.2.5](#s4-2-5)）。

:::info 两个官方模板的 DAG 形状不同：哪些阶段排在门禁之后

**漏洞门禁本身默认开启**：模板的 `trivyExitCode` 默认为 `"1"`，因此当发现匹配 `trivySeverity` 的漏洞时，`trivy-scanner` 失败，流水线也随之失败。所以这里担心的不是"漏洞溜过去了没人知道"——担心的是**排在门禁之前、已经产生副作用的阶段**。

对比两个模板的真实 DAG：

| | `sonarqube-scanner` | `build-image` | `deploy-or-upgrade` |
|---|---|---|---|
| java 0.3 | `runAfter: [maven]` | `runAfter: [maven]`（与 sonar **并行**） | `runAfter: [trivy-scanner]` |
| python 0.3 | `runAfter: [git-clone]` | `runAfter: [git-clone, pre-build]` | `runAfter: [sonarqube-scanner, trivy-scanner]` |

差异在于**"Sonar 判定支配发布"是否表达在 DAG 中**：python 0.3 表达了，java 0.3 没有。此外，两个模板中的 `build-image` 都与 Sonar 并行——也就是说，**镜像推送并没有排在 Sonar 判定之后**。

这算不算问题取决于你持哪种需求：

- 如果需求是**"质量问题必须被及时看到并处理"**——官方模板已经足够：门禁失败会使整条流水线失败，早在 PR 阶段就能拦住；再叠加 [§4.4.1](#s4-4-1) 的结果 Audit 留下平台侧证据。
- 如果需求是**"Sonar 判定必须严格支配镜像推送 / 发布"**（契约 5 的强形式）——那么要么选一个 DAG 已表达该次序的模板（python 0.3 的发布侧已表达），要么在模板侧补 `runAfter`，要么采用 [§3.3](#s3-3) fixture 的形态，把门禁与被测数据打包进同一个任务。

:::

#### 清理（§4.3）

本节**不创建任何 Kyverno 对象**——它是模板设计检查清单，不是策略资产。落进集群的只有上面"基线形态"里 `coverage: "30"` 的 PipelineRun——它位于你自建的 `policy-poc` 中、名字是你创建时起的：namespace 级联删除会回收它；若要继续后面的章节，请先按你使用的名字删除它，以免其 PolicyReport 行干扰下一节（[§4.0.5](#s4-0-5)）。`gated-build` 模板与 fixture Task 本身属于 [§3.3](#s3-3)——若后续章节仍需要它们，请勿删除。

### 4.4 结果 Audit 与 PolicyReport（事后防线） {#s4-4}

**本章共同契约**：任务的运行结果（覆盖率、漏洞数、扫描判定）只存在于 `TaskRun/status` 的 `results` 中（[§2.1](#s2-1)，观察点 6）。该观察点是**仅限 Audit 的**——它的价值在于把"哪些流水线的结果未达标"变成集群内可查询、可上报的 PolicyReport 记录，与 [§4.3](#s4-3) 的硬失败互补：**硬失败负责拦，Audit 负责看**。

贯穿本章的两点：

- **终态守卫**：一次运行会触发多次 status UPDATE，而结果只在接近完成时才出现。用"目标结果非空"跳过早期事件读起来很省事，但那**不是真正的终态判定**——如果某个 Task 已达终态却**没有写出结果**（崩溃了、写了垃圾、被跳过了），非空判定会**静默跳过**它，恰好漏掉最值得关注的对象。正确形态是**先由 `status.conditions` 的 `Succeeded` 条目确认 Task 已终态**，再三路分支：结果合规 = pass，结果未达标 = fail，**结果缺失 / 格式非法 = fail**（fail-closed）。
- **本章演示两种消费形态**（三种已声明的结果类型见 [§2.4](#s2-4)）：对象结果，用 JMESPath 下钻消费（[§4.4.1](#s4-4-1)，**推荐**——目录中的两个扫描 Task，sonar 与 trivy，都已提供）；以及聚合字符串（叠在 `type: string` 之上的约定），用 `split` + `to_number` 解析（[§4.4.2](#s4-4-2)，**兼容性措施**，仅用于目标 Task 短期内无法修改时）。

**本节地图**：

- **[§4.4.1](#s4-4-1) 主形态**——对象结果判定审计（sonar 与 trivy 两种真实形态），**推荐形式**；请先读它。
- **[§4.4.2](#s4-4-2)**——聚合字符串结果的切分范式：**兼容性措施，不推荐**——仅用于目标 Task 短期内无法修改时。
- **[§4.4.3](#s4-4-3)**——反例：为什么绝不能对 status 做 Enforce（运行会卡死——既不失败也不结束，只有人工介入才能解脱；见 [§6.1.4](#s6-1-4)）。
- **[§4.4.4](#s4-4-4)**——盘点已有的东西（后台扫描），以及如何确认证据在集群中可查询多久。

#### 4.4.1 对象结果判定审计（sonar 与 trivy 两种真实形态） {#s4-4-1}

目录中最常被消费的两个扫描 Task 都已发布对象结果，消费方式看起来相同：**用 JMESPath 直接下钻到属性**——不切字符串、不用正则、不用 `to_number`。二者需要审计的内容不同——sonar 交给你一个**判定**（通过与否），trivy 交给你一组**计数加总体状态**（扫描是否成功、发现了多少）——因此判定的分层也不同；下面分别介绍。

##### sonar 形态：扫描判定（`code-scan-results.result`）

- **它治理什么**：**扫描判定是否真的通过**——逐次运行记录扫描器产出的判定（对象结果 `code-scan-results.result`）；任何 `code-scan-results.result` 不为 `Succeeded` 的运行都算违规。这是 Audit 类策略：只产生 PolicyReport 条目，不拦截任何请求（对 status 做 Enforce 会卡死，见 [§4.4.3](#s4-4-3)）。
- **它难在哪**：被判定的对象是 **status**，而 status 会被写很多次；朴素的"仅在结果非空时判定"会放过"已终态却从未写出结果"——恰恰是最值得抓的对象。此外，Kyverno 的比较操作符会强制转换看起来像数字的字符串——`NotEquals Succeeded` 形式会静默放过格式非法的判定值 `"1"`（[§6.1.7](#s6-1-7)）。
- **策略如何分层**：① 用完整的 `taskRef` 坐标锁定受信扫描器（不匹配 → 跳过；无误伤）→ ② 仅在 **`status.conditions[Succeeded]` ∈ {True, False}**、即已终态时评估 → ③ 用**精确正则** `^Succeeded$` 判定——非 `Succeeded` 值、非法值、**以及已终态但结果缺失的运行**都算 fail。
- **它治不了什么**：它只回答"这次运行的判定是什么"，不回答"扫描本身是否真的做了事"（那依赖 [§4.2](#s4-2) 的门禁参数契约）；并且切换到 hub 的 `sonarqube-scanner` 时，必须连同名字一起锁定版本——0.5 发布大写的 `CODE_SCAN_RESULTS`，0.7 发布小写的；不锁版本，正常的 0.5 结果会被当作"0.7 的结果缺失"而误报为 fail。

`sonarqube-scanner`（0.7）声明的对象结果 `code-scan-results` 携带四个属性——`result` / `reportURL` / `taskID` / `projectID`——其中 `result` 是扫描判定，真实取值范围为 `Succeeded`（通过）/ `Failed` / `Skipped` / `Canceled`。

**关键判据**——终态守卫加精确字符串判定；二者缺一不可（**片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
      # EXCERPT -- key conditions only, NOT a standalone manifest; the
      # indentation is kept from the full policy, so this block alone does
      # not parse. Apply the complete YAML from the details block below.
        # Terminal test as a JMESPath boolean (a comparison returns a real boolean).
        # Do NOT hand the strings "True"/"False" to a Kyverno operator -- operator
        # coercion swallows those (§6.1.7). Count the terminal conditions instead of
        # reading [0]: a decoy Unknown entry ahead of the real one would otherwise
        # make the whole rule skip (§4.4.1).
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # Compare the exact string inside JMESPath. Kyverno condition operators coerce
        # numeric-looking strings, so `NotEquals Succeeded` would fail open on the
        # malformed verdict "1"
        # Every lookup below takes [0] of a filtered list, and status.results has no
        # uniqueness guarantee (the CRD declares it atomic, not a keyed list), so a
        # decoy entry carrying the same name in front of the real one would be read
        # instead. Require exactly one of each; anything else is malformed.
        - name: verdictResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='code-scan-results'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: verdictIsSucceeded
          variable:
            jmesPath: >-
              regex_match(
                '^Succeeded$',
                (request.object.status.results || `[]`)[?name=='code-scan-results'].value.result | [0] || ''
              )
      preconditions:
        all:
          # ...(full taskRef identity omitted)
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        deny:
          conditions:
            any:
              # Once terminal, only Succeeded passes; malformed values and a missing
              # result (verdict == '') both fail closed
              # the verdict or the terminal condition is not unambiguous
              - key: "{{ verdictResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ verdictIsSucceeded }}"
                operator: Equals
                value: false
```

:::details 完整策略 YAML：scan-verdict-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: scan-verdict-audit
spec:
  webhookConfiguration:
    # Ignore, not Fail: this policy matches */status — a Kyverno outage must never
    # block the Tekton controller's status write-back (§2.2 red line; §3.7 tiering)
    failurePolicy: Ignore
  background: false
  rules:
    - name: sonar-verdict-must-pass
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        # Scope only by the complete taskRef identity. Controller-owned-looking labels are
        # not trusted because PipelineRun taskRunSpecs can override child TaskRun labels.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskRefName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Terminal-guarded fail-closed: decide whether the TaskRun already reached a
        # terminal state (Succeeded condition True/False, not Unknown) BEFORE reading
        # the verdict, so "terminal but no result written" is never silently skipped.
        # Terminal test as a JMESPath boolean (a comparison returns a real boolean)
        # instead of handing the strings "True"/"False" to a Kyverno operator; operator
        # coercion swallows the latter (see FAQ on JMESPath pitfalls). Count terminal
        # conditions rather than reading [0] -- see the duplicate-condition warning
        # in §4.4.1.
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        - name: verdict
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='code-scan-results'].value.result | [0] || ''"
            default: ""
        # Compare the exact string inside JMESPath. Kyverno condition operators
        # coerce numeric-looking strings, so `NotEquals Succeeded` can fail-open
        # for an invalid verdict such as "1" (§6.1.7).
        # Every lookup below takes [0] of a filtered list, and status.results has no
        # uniqueness guarantee (the CRD declares it atomic, not a keyed list), so a
        # decoy entry carrying the same name in front of the real one would be read
        # instead. Require exactly one of each; anything else is malformed.
        - name: verdictResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='code-scan-results'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: verdictIsSucceeded
          variable:
            jmesPath: >-
              regex_match(
                '^Succeeded$',
                (request.object.status.results || `[]`)[?name=='code-scan-results'].value.result | [0] || ''
              )
      preconditions:
        all:
          # DEMO PROFILE: exact cluster-resolver fixture identity.
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskRefName }}"
            operator: Equals
            value: policy-demo-scanner
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
          # evaluate ONLY on a terminal TaskRun. Earlier writes (Succeeded=Unknown / Running)
          # are skipped; a terminal run is always judged.
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        failureAction: Audit
        message: "SonarQube scan verdict is '{{ verdict }}' on a terminal TaskRun (expected Succeeded); missing / illegal verdict is fail-closed."
        deny:
          conditions:
            any:
              # real sonarqube-scanner ScanResult.Result = Succeeded (pass) / Failed / Skipped /
              # Canceled. Anything but Succeeded — INCLUDING a missing '' verdict on a terminal
              # TaskRun — is a violation. This is the fail-closed core: no silent skip.
              # the verdict or the terminal condition is not unambiguous
              - key: "{{ verdictResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ verdictIsSucceeded }}"
                operator: Equals
                value: false
```

:::

**切换到生产 hub 引用时**，完整的 `taskRef` 画像必须随之改变——`resolver=hub`、`catalog=catalog`、`kind=task`、`name=sonarqube-scanner`、`version=0.7`——并且必须完全忽略子 TaskRun 的标签。0.5 与 0.7 共用同一个 Task 名，但 0.5 发布大写的 `CODE_SCAN_RESULTS`，0.7 发布小写的 `code-scan-results`——不锁版本，正常的 0.5 结果会被当作"0.7 的结果缺失"而误报为 fail。

:::warning 取值范围更正：alert_status 不是 code-scan-results.result

SonarQube 内部的 `alert_status=OK/ERROR` **不是** `sonarqube-scanner` 0.7 发出的 `code-scan-results.result`。真实的 `ScanResult.Result` 取值范围是 `Succeeded` / `Failed` / `Skipped` / `Canceled`（可在控制台 **Pipelines → Tasks** 下打开该 Task 的 README，"ScanResult Output" 一节验证）。

用 `!= "OK"` 判定会把**每一次**真实的 0.7 运行都误判为 fail。

:::

##### trivy 形态：漏洞聚合与总体状态（`trivy-summary-metadata`）

- **它治理什么**：镜像 / 文件系统扫描的结果必须被记录在案——本例把"存在任何 CRITICAL"判为未达标，**同时**把**根本从未成功扫描**的运行也算作未达标。
- **它难在哪**：在这个 Task 的结果里，"有没有漏洞"和"扫描是否成功"是**两个独立维度**——只读其中一个必然 fail-open。三个陷阱：① **扫描失败时，计数字段仍然是 `0`**（不是空、不是短横线）——只判 `critical > 0` 会把"根本没扫"当成"零漏洞"放行；② **有发现不代表 Task 失败**：0.6 默认使用 trivy 自身的 `--exit-code 0`，因此发现 CRITICAL 的运行仍显示绿色 TaskRun——漏洞超标在流水线层面**不可见**，只能从结果里读出；③ **像 `--help` 这样的调用——退出码 0 但未产出报告——会让 TaskRun 变绿**，而结果的 `status` 却被写成 `failed`——这正是本节能抓到、而只看 TaskRun 终态抓不到的原因。
- **策略如何分层**：① 用完整的 hub `taskRef` 坐标锁定受信 Task → ② 终态守卫（同上一小节）→ ③ **先检验 `status` 是否属于"产出了可用报告"的取值** → ④ 交叉核对 `failed` 必须为 `0`（它与 `status` 互相印证）→ ⑤ 再用正则确认计数是有界非负整数 → ⑥ 只有在有界性确认之后才用 `to_number` 与阈值比较。任何"读不出来"的情况都判为未达标。
- **它治不了什么**：它只回答"这次扫描报了什么"，不回答"扫描目标对不对"（`scanTargets` 是否真的指向本次构建产出的镜像属于 [§4.2](#s4-2) 的参数契约）；也不回答"这个漏洞该不该豁免"（那属于 `.trivyignore` 与安全评审）。它同样是 Audit 类策略：只产生 PolicyReport 条目，不拦截任何请求（对 status 做 Enforce 会卡死，见 [§4.4.3](#s4-4-3)）。

`trivy-scanner`（0.6）声明的对象结果 `trivy-summary-metadata` 携带 11 个属性，全部为 **string** 类型：

| 属性 | 含义 | 策略如何使用它 |
|---|---|---|
| `status` | 本次扫描的总体状态；取值范围 `passed` / `findings` / `failed` / `unknown` | **第一层判据**：只有 `passed` / `findings` 表示"产出了可用报告"；`failed`（至少一个目标无法扫描）与 `unknown`（**一个目标都没扫，或计数无法获得**）必须判为未达标 |
| `critical` / `high` / `medium` / `low` / `unknown` | 按严重级别的**全量聚合**计数 | 阈值判据；先用正则把它们界定为非负整数，再 `to_number` |
| `total` | 各级别之和 | 同上；可用作粗粒度的"是否有任何发现"判定 |
| `scanType` | `image` / `fs` / `config` / `sbom` / 透传的自定义子命令 | 阈值需按扫描类型区分时的路由键 |
| `targets` / `scanned` / `failed` | 目标总数 / 已扫描数 / 失败数 | 需要比 `status` 更细地区分"部分失败"时使用 |

同名的 `trivy-summary`（数组）的第一个元素是**同一份聚合**的字符串镜像，供 Overview 渲染使用；二者由同一内部状态生成，不可能漂移。**策略侧永远用对象那个**——不要解析字符串那个（那是 [§4.4.2](#s4-4-2) 的兼容路径）。

:::warning status 与计数必须一起判定

`trivy-scanner` 0.6 的五种典型运行形态，以及各自留下的痕迹：

| 场景 | TaskRun 终态 | `status` | `critical` |
|---|---|---|---|
| 扫描完成，零发现 | Succeeded | `passed` | `0` |
| 扫描完成且有发现，门禁未启用 | **Succeeded** | `findings` | `1` |
| 扫描完成且有发现，`extraArgs` 带 `--exit-code 1` | Failed | `findings` | `1` |
| `extraArgs` 传入 `--help`（退出码 0 但未产出报告） | **Succeeded** | **`failed`** | `0` |
| trivy 自身出错（拉不到漏洞库 / 镜像不存在） | Failed | `failed` | `0` |

三条推论：① **`critical=0` 不代表安全**——最后两行的 `critical` 都是 `0`；只按计数判定会把它们直接放行；② **绿色的 TaskRun 不代表发生过扫描**——第二行和第四行都是绿的；③ 让漏洞真正**拦停**流水线依赖模板上的门禁参数——两个官方 0.3 模板的 `trivyExitCode` 都默认 `"1"`，因此默认确实会拦停；要防的是它被显式改成 `"0"` / 空字符串，或 `skipTrivyScan` 跳过整个扫描（见 [§4.2.5](#s4-2-5)）。本节的 Audit 只负责**看**。

四个 `status` 值分工明确——不要混为一谈：`passed` 是"所有目标都扫了，零发现"；`findings` 是"扫了，存在漏洞"；`failed` 是"至少一个目标无法扫描"；`unknown` 有**两个**成因——一个目标都没扫，**或者计数根本无法获得**（Task 的 `compute_scan_status` 对两者返回同一个值）。要比 `status` 更细地区分"部分失败"，读 `targets` / `scanned` / `failed` 三个计数——按契约 `scanned` 包含失败的目标，可用报告数为 `scanned - failed`。

**短横线（`-`）确实会出现在计数字段里。** 当计数无法获得时（例如自定义 `toolImage` 缺少 JSON 解析器），Task 会把 `total` / `critical` / `high` / `medium` / `low` / `unknown` **全部写成 `"-"`** 而不是 `0`——代码注释写明这是**有意为之**：写 `0` 会被误读为"干净、零发现"。`trivy-summary` 数组的逐目标行同样用短横线标记该行报告缺失。

**因此下面的正则守卫不是可选的纵深防御——它是必需的**：它把短横线和空值挡在 `to_number` 之外，正对应这条真实路径。它也解释了为什么 `status` 与计数**必须一起判定**——在计数不可得的路径上，`status` 是 `unknown` 而计数是 `-`；这两个信号成对出现。

:::

**关键判据**——status 守卫在前，正则守卫居中，`to_number` 在最后（**片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
      # EXCERPT -- key conditions only, NOT a standalone manifest; the
      # indentation is kept from the full policy, so this block alone does
      # not parse. Apply the complete YAML from the details block below.
        # Terminal guard first, same shape as the sonar excerpt above: counted, not
        # [0]-indexed, so a decoy Unknown condition cannot disarm it (see the
        # warning after this policy)
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # Every lookup below takes [0] of a filtered list, so a second entry with the
        # same name or type would be invisible. Require exactly one of each.
        - name: summaryResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='trivy-summary-metadata'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        # The raw counter, kept as a variable so the deny message and the threshold
        # comparison both read the same value.
        - name: criticalRaw
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.critical | [0] || ''"
            default: ""
        # Only these two states mean "trivy produced a usable report". failed / unknown /
        # a missing result must never be read as a clean scan.
        - name: scanStatusUsable
          variable:
            jmesPath: >-
              regex_match(
                '^(passed|findings)$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.status | [0] || ''
              )
        # Cross-check the per-target failure counter against status: defence in depth
        # against a summary that claims "findings" while admitting a failed target.
        - name: noTargetFailed
          variable:
            jmesPath: >-
              regex_match(
                '^0$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.failed | [0] || ''
              )
        # Bounded non-negative integer only; the task writes '-' when counts are
        # unavailable, and '-' must stay out of to_number.
        - name: criticalIsNumeric
          variable:
            jmesPath: >-
              regex_match(
                '^[0-9]{1,9}$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.critical | [0] || ''
              )
      preconditions:
        all:
          # ...(full hub taskRef identity omitted -- catalog / trivy-scanner / 0.6;
          # this is the precondition the warning below points at)
          # Terminal guard: while the run is still executing (results not written
          # yet) this precondition fails and the rule SKIPS -- the NotEquals-1
          # counts below never fire on an in-flight status write
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        deny:
          conditions:
            any:
              # (1) every lookup below takes [0] of a filtered list, so a duplicate
              #     entry would be invisible -- require exactly one of each
              - key: "{{ summaryResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              # (2) the scan never produced a usable report, or wrote no result at all
              - key: "{{ scanStatusUsable }}"
                operator: Equals
                value: false
              # (3) at least one target failed to produce a report
              - key: "{{ noTargetFailed }}"
                operator: Equals
                value: false
              # (4) counts unreadable ('-', empty, malformed) -> never treated as zero
              - key: "{{ criticalIsNumeric }}"
                operator: Equals
                value: false
              # (5) only a validated numeric value reaches to_number
              - key: "{{ criticalIsNumeric && to_number(criticalRaw) > `0` }}"
                operator: Equals
                value: true
```

:::warning 这个策略信任的是"控制器写进 status 的任何内容"

它从 TaskRun status 中读结果，因此它的强度止于"谁能写这个 status"。策略本身分不清结果是扫描真实产出的还是被伪造进去的——所以必须配套两件事：

- **RBAC 中不要授予业务身份对 `taskruns/status` 的写权限**（正常情况下只有 Tekton 控制器写它）；
- **把 Task 身份锁定到版本**（上面的前置条件已锁定 `catalog/trivy-scanner/0.6`）；否则同名替身 Task 可以产出自己的"合规"结果。

`failed` 与 `status` 的交叉核对是这条线上的**纵深防御**，不是替代品：它能拦住只改 `status` 字段的粗糙伪造，但拦不住把整份 summary 改写得自洽的对手。要更严格，可以再加 `scanned == targets` 并钉住 `scanType`——但**每新增一项都必须在你自己的环境里把正反用例走一遍**——本节给出的是上述判据的行为。

:::

:::details 完整策略 YAML：vuln-summary-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: vuln-summary-audit
spec:
  webhookConfiguration:
    # Ignore, not Fail: this policy matches */status — a Kyverno outage must never
    # block the Tekton controller's status write-back (§2.2 red line; §3.7 tiering)
    failurePolicy: Ignore
  background: false
  rules:
    - name: trivy-summary-metadata-must-pass
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        # Scope by the complete hub taskRef identity; child labels are not trusted.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: hubCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: hubKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: hubName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: hubVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        # Terminal guard first: reading the result before the TaskRun settles would
        # silently skip the runs that finished without writing any result at all.
        # It counts terminal conditions instead of reading [0], because a precondition
        # that reads [0] can be disarmed by a duplicate condition (see the warning
        # right after this policy).
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # Every lookup below takes [0] of a filtered list, so a second entry with the
        # same name or type would be invisible. Require exactly one of each and treat
        # anything else as malformed rather than reading the first one and moving on.
        - name: summaryResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='trivy-summary-metadata'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        # Object result: drill straight into the property, no split/regex parsing.
        - name: scanStatus
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.status | [0] || ''"
            default: ""
        - name: criticalRaw
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.critical | [0] || ''"
            default: ""
        - name: failedRaw
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.failed | [0] || ''"
            default: ""
        # Only these two states mean "trivy produced a usable report". failed / unknown /
        # a missing result must never be read as a clean scan.
        - name: scanStatusUsable
          variable:
            jmesPath: >-
              regex_match(
                '^(passed|findings)$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.status | [0] || ''
              )
        # Cross-check the per-target failure counter against status. The two are
        # written from one internal state today, so this is defence in depth: it
        # keeps a hand-written or tampered summary from claiming "findings" while
        # admitting that a target never produced a report.
        - name: noTargetFailed
          variable:
            jmesPath: >-
              regex_match(
                '^0$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.failed | [0] || ''
              )
        # Bounded non-negative integer only; the task writes '-' when counts are
        # unavailable, and '-' must stay out of to_number.
        - name: criticalIsNumeric
          variable:
            jmesPath: >-
              regex_match(
                '^[0-9]{1,9}$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.critical | [0] || ''
              )
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ hubCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ hubKind }}"
            operator: Equals
            value: task
          - key: "{{ hubName }}"
            operator: Equals
            value: trivy-scanner
          - key: "{{ hubVersion }}"
            operator: Equals
            value: "0.6"
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        failureAction: Audit
        message: "trivy-summary-metadata on a terminal TaskRun reports status='{{ scanStatus }}' failed='{{ failedRaw }}' critical='{{ criticalRaw }}' (expected status passed/findings, failed 0 and critical 0); an unusable or missing summary is fail-closed."
        deny:
          conditions:
            any:
              # (1) the summary or the terminal condition is not unambiguous
              - key: "{{ summaryResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              # (2) the scan never produced a usable report, or wrote no result at all
              - key: "{{ scanStatusUsable }}"
                operator: Equals
                value: false
              # (3) at least one target failed to produce a report
              - key: "{{ noTargetFailed }}"
                operator: Equals
                value: false
              # (4) counts unreadable ('-', empty, malformed) -> never treated as zero
              - key: "{{ criticalIsNumeric }}"
                operator: Equals
                value: false
              # (5) only a validated numeric value reaches to_number
              - key: "{{ criticalIsNumeric && to_number(criticalRaw) > `0` }}"
                operator: Equals
                value: true
```

:::

:::warning 读 status 时绝不要取 [0]：一条伪造的同名条目就能废掉整条规则

**`status.conditions` 与 `status.results` 都由控制器写入，Kubernetes 对二者都没有按名去重的约束**（`taskruns.tekton.dev` 的 schema 中没有任何东西让 API server 保证这两个列表按键唯一）。因此同名条目完全可能出现两次：`kubectl patch --subresource=status --dry-run=server` 的回显会显示两条条目，API server 原样接受（后续控制器 reconcile 会将其归一化，但**在 admission 时刻**看到的就是那两条——而 admission 恰恰是策略评估的时刻）。

这是 [§4.2.5](#s4-2-5) 中"对 `spec.params` 取 `[0]` 是安全的"的对照面：`spec.params`、`pipelineRef.params`、`spec.workspaces` 中的同名重复都会被 **Tekton 自己的 validation webhook** 拒绝（逐字错误信息在 [§4.2.5](#s4-2-5)）；status 侧没有等价保证。**"在 `spec` 上验证过"绝不能外推为"在 `status` 上也安全"。**

因此如果终态判据写成 `[?type=='Succeeded'].status | [0]`，在真实条目**前面**插入一条 `status: Unknown` 的假 condition 就会让 `isTerminal` 为 `false`——前置条件不满足 → **整条规则跳过**，后面的 `succeededConditionCount != 1` 守卫根本没有机会运行。这就是 fail-open。

**下面的 A/B 表是加固调查的一次性记录（历史对比），不是当前部署需要重跑的步骤**——当前部署只需验证加固后的判据（这正是本节 Cookbook 步骤所测的）。当时的构造：取一个会被 deny 的终态 TaskRun，把它的 status 逐字重放作为对照组，然后只加一条诱饵——其余不动——作为实验组。三个策略的表现如下：

| 被攻击的策略 | 诱饵构造 | 对照组 | 实验组（旧形式） | 实验组（加固后） |
|---|---|---|---|---|
| [§4.4.1](#s4-4-1) trivy 形态（一次 `critical=1` 的运行） | 在 `conditions` 最前插入 `Succeeded=Unknown` | Denied | **Allowed** | Denied |
| [§4.4.1](#s4-4-1) sonar 形态（一次 `result=Failed` 的运行） | 在 `results` 最前插入 `result=Succeeded` 的同名条目 | Denied | **Allowed** | Denied |
| [§4.4.2](#s4-4-2) 字符串形态（一次 `critical=9` 的运行） | 在 `results` 最前插入同名的 `critical=0` 字符串 | Denied | **Allowed** | Denied |

加固不会误伤正常运行：干净运行逐字重放仍被放行；往里插一条诱饵就会被 deny——"重复条目"本身就是违规。

这就是为什么上面的 `isTerminal` **对终态 condition 计数**而不是取 `[0]`：

```yaml
length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`
```

这样 `[Unknown, True]` 仍判为已终态并进入 `deny`，随后 `succeededConditionCount != 1` 把重复的 condition 本身判为违规。**残余边界**：两条都是 `Unknown` 时仍会跳过——那确实还未终态，等它落定后会被抓住；能把 status 长期钉在 `Unknown` 的攻击者已经握有 status 写权限，那是 RBAC 的边界，不是本策略的（见本小节前面的警告"这个策略信任的是'控制器写进 status 的任何内容'"）。

**读 results 需要同样的守卫。** 本文有四个读 `status.results` 的策略，**每一个都要求"目标结果恰好一条"**——但守卫接线的位置因策略类型而异：

- 三个 Audit（[§4.4.1](#s4-4-1) 中 trivy 形态的 `summaryResultCount` 与 sonar 形态的 `verdictResultCount`，以及 [§4.4.2](#s4-4-2) 的 `summaryResultCount`），连同各自的 `succeededConditionCount`，都接进 `deny.conditions.any`——计数不为 1 即记一条 fail；
- 唯一的取消策略（[§4.6.1](#s4-6-1) 的 `coverageResultCount`）没有 `deny` 块；它的守卫接进中间变量 `coverageViolates`，因此**计数歧义会直接触发取消**。

两条路的方向都是 fail-closed；只是落点不同。**声明了变量却不接线等于没加**——而这条守卫恰恰最容易被漏接，因为缺了它所有正常样本照样通过。

**同样的修复必须应用到每一个把 `isTerminal` 用作前置条件的策略**——本文的 [§4.4.1](#s4-4-1)（两种形态）、[§4.4.2](#s4-4-2) 与 [§4.6.1](#s4-6-1) 都已切换为计数形式。

:::

:::details 如何复现该构造（以及为什么不能用 PolicyReport 读结论）

**在运行 Tekton 与 Kyverno 的集群上执行。** PolicyReport 是最终一致的：某次 status UPDATE 的判定何时写进报告没有保证，因此**结论无法归因到某个特定请求**。要获得同步、可归因的判定，请临时安装一个**仅用于测量的 Enforce 副本**，用标签把它钉在探针对象上，直接读 `--dry-run=server` 的返回——不落任何持久化：

```bash
# 1. Derive the measurement copy from the live Audit policy -- do NOT hand-edit a
#    second copy of that YAML, or the thing you measure stops being the thing you run.
#    Exactly three edits: rename, flip every rule to Enforce, and pin EVERY rule to
#    the probe label so the Enforce copy can only ever see the object you labelled.
#    The flip writes rule-level validate.failureAction and drops the deprecated
#    top-level field if the live object still carries one (rule-level wins, but a
#    stale top-level line would only confuse whoever reads the copy).
#    ⚠️ A measurement device, not a deployment recommendation -- the §4.4 red line
#    (never Enforce on */status) still stands, so it matches only labelled probe objects and is deleted right after use.
MEASUREMENT_POLICY_NAME=vuln-summary-audit-probe-enforce
kubectl get clusterpolicy vuln-summary-audit -o json \
  | jq --arg n "$MEASUREMENT_POLICY_NAME" '
      {apiVersion, kind, metadata: {name: $n}, spec}
      | del(.spec.validationFailureAction)
      | .spec.rules |= map(.validate.failureAction = "Enforce")
      | .spec.rules |= map(.match.any[0].resources.selector.matchLabels.probe = "dupcond")
    ' > "$MEASUREMENT_POLICY_NAME.json"
# `create`, not `apply` (§4.0.4): a same-named policy already on the cluster is somebody
# else's Enforce rule on */status, and overwriting it is exactly the accident this
# section warns about -- an AlreadyExists here means STOP, not retry.
create_owned_cluster_object "$MEASUREMENT_POLICY_NAME.json" clusterpolicy
# It is not installed until it is Ready -- an unready policy simply does not evaluate,
# and step 3 would then be "not denied" for a reason that has nothing to do with the rule.
kubectl wait --for=condition=Ready "clusterpolicy/$MEASUREMENT_POLICY_NAME" --timeout=60s

# 2. Pick a terminal TaskRun with critical=1; its name is set only here (steps 3, 4, 5 all reference it)
TERMINAL_TASKRUN='<terminal-taskrun>'
kubectl -n policy-poc label taskrun "$TERMINAL_TASKRUN" probe=dupcond --overwrite

# 3. Replay its status verbatim (control group)
kubectl -n policy-poc get taskrun "$TERMINAL_TASKRUN" -o json   | jq '{status}' > normal.json
kubectl -n policy-poc patch taskrun "$TERMINAL_TASKRUN"   --subresource=status --type=merge --patch-file normal.json --dry-run=server

# 4. Insert a single decoy Unknown at the front of conditions (experiment group)
jq '.status.conditions = ([.status.conditions[0] | .status="Unknown" | .reason="Running"] + .status.conditions)'   normal.json > dup.json
kubectl -n policy-poc patch taskrun "$TERMINAL_TASKRUN"   --subresource=status --type=merge --patch-file dup.json --dry-run=server

# 5. Delete the measurement copy when done, by the UID recorded at creation, and remove the label.
delete_owned_cluster_object clusterpolicy "$MEASUREMENT_POLICY_NAME"
kubectl -n policy-poc label taskrun "$TERMINAL_TASKRUN" probe-
```

**这些步骤测试的是本文现在交付的（加固后）判据**——第 1 步从**现行策略**派生副本，它已经是计数形式，因此上表中"实验组（旧形式）"一列**不会**从这些步骤复现。要亲眼看到那个 fail-open，你得手工再造一个把 `isTerminal` 回退成 `[?type=='Succeeded'].status | [0]` 的副本；如果你只想确认"现在能拦住"，按下表原样执行即可。

| 步骤 | 期望（交付的计数形式） | 不符时先看哪里 |
|---|---|---|
| 3 对照组 | Denied（deny 触发） | 未被 deny = 这个 TaskRun 的 `critical` 不是 `>0`，或策略没匹配上：先 `kubectl get clusterpolicy "$MEASUREMENT_POLICY_NAME" -o yaml` 检查 `match` 的 namespace / selector 与五项 hub 身份 |
| 4 实验组 | Denied（诱饵本身就是违规） | 若被放行：先 `kubectl get clusterpolicy "$MEASUREMENT_POLICY_NAME" -o jsonpath='{.spec.rules[0].context[?(@.name=="isTerminal")]}'` 确认生效的那一行确实是计数形式（只有第 1 步的 `kubectl wait` 通过后才算安装完成）；再确认诱饵条目确实排在**前面**（放在后面时它对 `[0]` 形式本来就无效，构不成对照） |
| 5 收尾 | — | 忘删测量副本 = 一条留在 `*/status` 上的 Enforce 规则，会卡死带该标签的对象：用 `kubectl get clusterpolicy` 确认它已删除 |

加固不改变正常形态的判定：把下一个 details 块的七种标准形态用同样的"逐字重放 + `--dry-run=server`"跑一遍，计数形式的判定按表中顺序为（allow / allow / deny / deny / deny / deny / allow (skip)）——**与 `[0]` 形式在这七种形态上逐一相同**，即加固不会误伤正常运行。**两种形式只在伪造 condition 的构造上分道扬镳**：诱饵条目排在最前时，`[0]` 形式读到伪造条目、把违规运行判为未终态而放行（fail-open），计数形式则因"重复条目本身就是违规"而 deny。换句话说，它**只**封死了伪造 condition 这条路。

:::

:::details 自检用例：七种运行形态各自应被判为什么

| 探针 | 产出的 `status` / `critical` | 期望 PolicyReport |
|---|---|---|
| 扫描一个干净镜像 | `passed` / `0` | pass |
| 有发现，但 CRITICAL 被 severity 过滤掉 | `findings` / `0` | pass |
| 发现 CRITICAL | `findings` / `1` | fail |
| 发现 CRITICAL 且 `extraArgs` 带 `--exit-code 1`（TaskRun 失败） | `findings` / `1` | fail |
| `extraArgs` 传入 `--help`（TaskRun 成功但未产出报告） | `failed` / `0` | fail |
| trivy 自身出错（拉不到漏洞库） | `failed` / `0` | fail |
| 同 namespace 中一个无关的 TaskRun（不是 trivy 身份） | 无此结果 | skip（无误伤） |

**如何复现**（所有操作都在**运行 Tekton 与 Kyverno 的集群**上执行；两者分开部署时指业务集群，而不是 global 管理集群）：

下面的 details 块"复现用的两份最小 YAML"给出了源码 fixture 与一个探针的完整 YAML。前六个探针在其之上**只改 `params`**；最后一个——无误伤对照——是例外：必须换成一个**使用内联 `taskSpec` 的无关 TaskRun**（其 `taskRef` 不再指向 `trivy-scanner`；否则身份仍然匹配，证明不了无误伤）。把上面的完整策略存为 `vuln-summary-audit.yaml`，fixture 与探针分别存为 `trivy-source-fixture-cm.yaml` 与 `probe-findings-critical.yaml`，然后：

```bash
# 1. Install the policy (Audit; blocks no request)
# `create`, not `apply` (§4.0.4): a same-named ClusterPolicy is somebody else's
# governance rule, and an AlreadyExists here means STOP, not overwrite.
create_owned_cluster_object vuln-summary-audit.yaml clusterpolicy

# 2. Every probe except "clean image" needs no vulnerability DB: scanType=fs + scanners=[secret]
#    on a source ConfigMap holding fake keys finishes in seconds. Per probe, change only these params:
#      findings + CRITICAL      -> scanners=[secret]
#      findings, no CRITICAL    -> scanners=[secret] + severity=[HIGH]
#      gate takes effect        -> also add extraArgs=["--exit-code","1"]
#      no-scan bypass           -> extraArgs=["--help"]
#      scan failure             -> scanType=image pointing at an unpullable image
#      no-collateral control    -> an unrelated TaskRun with inline taskSpec
kubectl apply -n policy-poc -f trivy-source-fixture-cm.yaml
kubectl create -n policy-poc -f probe-findings-critical.yaml

# 3. The "clean image" probe really scans an image: explicitly set your environment's
#    vulnerability-DB image address, or the default pulls from the public internet and
#    is guaranteed to time out in an air-gapped environment (add the dbRepository / javaDbRepository params to the TaskRun)

# 4. Read the verdicts
kubectl get policyreport -n policy-poc \
  -o custom-columns=SUBJECT:.scope.name,RESULT:.results[*].result
```

:::

:::details 复现用的两份最小 YAML（源码 fixture + 一个探针）

`trivy-source-fixture-cm.yaml`——一个存放假密钥的源码目录，用于在无网络访问、不拉漏洞库的情况下可靠地产生发现：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: trivy-source-fixture
  namespace: policy-poc
data:
  source-a.txt: |
    GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD
    SLACK_BOT_TOKEN=xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx
  source-b.txt: |
    hello catalog
```

`probe-findings-critical.yaml`——"发现 CRITICAL"探针；其余探针在其之上只改 `params`：

```yaml
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  generateName: probe-findings-critical-
  namespace: policy-poc
spec:
  timeout: 15m
  taskRef:
    resolver: hub
    params:
      - name: catalog
        value: catalog
      - name: kind
        value: task
      - name: name
        value: trivy-scanner
      - name: version
        value: "0.6"
  params:
    - name: scanType
      value: fs
    - name: scanTargets
      value:
        - .
    - name: scanners
      value:
        - secret
  workspaces:
    - name: source
      configMap:
        name: trivy-source-fixture
```

:::

**结果不符时先看哪里**：所有记录都是 `skip` → 最可能是 `taskRef` 身份没匹配上（本策略锁定 `catalog/trivy-scanner/0.6`；换版本或换成 cluster resolver 都会产生 skip）；期望 `fail` 却得到 `pass` → 先跑 `kubectl -n <ns> get taskrun <name> -o jsonpath='{.status.results}'` 看 `trivy-summary-metadata` 实际包含什么，再对照上面的判据比对；TaskRun 还在 `Running` 时卡在 `skip` → 终态守卫正在履职——等到终态再读一次。

顺带一提，这就是终态守卫实际生效的样子：`trivy` 出错的用例在运行**仍处于 `Running`** 时被记录为 `skip`（`preconditions not met`），落入终态后才翻成 `fail`。这正是期望的行为——不对中间状态下判定，"结果还没写出来"既不会造成误报，也不会造成永久沉默。

:::warning PolicyReport 是尽力而为的，不是完整台账

偶尔你会看到这样的条目：TaskRun 已达终态、`trivy-summary-metadata` 已完整写出，但在 PolicyReport 里它**停在 `skip`**（`preconditions not met`），时间戳恰好落在运行转为终态的那一秒——终态时刻的那次评估没能落进报告。完全相同的运行形态绝大多数时候都被记录为 `fail`，所以这是低频漏记，不是判据错误。

原因：`*/status` 策略只在 admission 时刻评估，而 `background: false` 意味着**没有后台兜底**（[§4.4.4](#s4-4-4)）——一旦某次评估在上报路径上丢失，就没有补偿机会。

**这决定了 PolicyReport 的正确用法**：它适合**发现**问题（`fail` 一定意味着真实问题），但**不能反过来当作合规证明**——"没有 fail 条目"不等于"没有违规运行"。任何"发布前必须全部合规"的决策，请回到 TaskRun / PipelineRun 本身，或使用流水线内的硬门禁（[§4.3](#s4-3)）。

:::

要改为按 `high` 或 `total` 判定，把 `criticalRaw` / `criticalIsNumeric` 换成对应属性即可；决策结构不变。

**与 [§4.2.5](#s4-2-5) 的分工**：本节读**运行结果**，回答"这次扫描发现了什么"；[§4.2.5](#s4-2-5) 读**模板参数**，回答"门禁有没有被关掉或架空"。两者互补且都必要——只有前者时，超阈值的镜像照样发出去（TaskRun 是绿的）；只有后者时，参数正确但中途失败的扫描仍无人察觉。

#### 4.4.2 非结构化字符串结果的解析模式（兼容性措施，非推荐风格） {#s4-4-2}

:::warning 看示例前先读这里：本节不是推荐风格

本节演示的——先把聚合字符串拆开再判定——**不是本文推荐的扩展风格**；它是消费**既有 Task 契约**的兼容性措施。推荐做法仍是 [§2.4](#s2-4) 第 1 条：让 Task 发出**结构化结果**（对象结果 + `properties`），策略直接下钻字段——不需要正则，也不可能出现解析错位。

**特别对于 trivy：不要再用本节的风格。** `trivy-scanner` 0.6 已经同时发布对象结果 `trivy-summary-metadata`；直接用 [§4.4.1](#s4-4-1) 的下钻风格。本节作为**通用模式**保留——当你面对一个只发聚合字符串、短期内无法修改的第三方或自研 Task 时，可以照抄这里的切分与 fail-closed 结构。下文仍以漏洞计数为题材，因为它踩中了每一个陷阱，但**它演示的是形态，不是使用 trivy 的推荐方式**。

那为什么还保留本节？两个现实原因：① 只发聚合字符串的 Task 与 Task 版本在生产中依然存在，治理不能等；② 这里的 **fail-closed 解析模式**（先锁终态与 Task 身份 → 再用正则确认有界非负整数 → 最后才与阈值比较，所有"读不出来"的情况都判为未达标）是一个可以逐字照抄的安全基线。

**如果你在设计新 Task，请直接用对象结果——不要照抄本节。**

**兼容面已冻结**：本节判据的支持面到此为止——它只服务既有的聚合字符串契约，不会为新字段、新格式、新调用方生长新的解析判据；需要新的判定能力时，走对象结果（[§4.4.1](#s4-4-1)），而不是在本节之上再叠一层正则。

:::

- **它治理什么**：只发布字符串结果的 Task——当它报告的计数超过阈值时必须记录在案；本例判定 `critical > 0`。
- **它难在哪**：计数被打包在聚合字符串里（形如 `"scanType=image;…;critical=3;high=10;…"`），三类陷阱层层叠加——① 这类 Task 普遍用**哨兵值**表示"计数不可知"（本例用 `critical=-`，短横线）；把 `-` 读成 0 等于把"扫描什么都没产出"当成"没有漏洞"放行；② **"取第一个匹配的 token"是陷阱**：`critical=0;critical=9` 与 `critical=0=9` 都会被朴素解析器读成干净的 `0`；③ Kyverno 操作符会强制转换数字样式的字符串，很容易把"读不出来"变成"判为通过"。整条解析路径处处 fail-open。
- **策略如何分层**：① 锁定终态 + Task 身份 → ② 从聚合字符串中切出 `critical=` token 并要求**恰好一个** → ③ **对整个 token 做正则匹配**（`^critical=[0-9]{1,9}$`，而不是只匹配切出来的值）→ ④ 只有在有界性确认之后才 `to_number` 并与阈值比较。所有读不出值、或读出多个值的情况都按违规处理。
- **它治不了什么**：字符串不是稳定契约——字段顺序、分隔符、新增字段都可能让解析**静默错位**，而错位通常表现为**被误判为通过**。所以这只是过渡形态。此外，聚合字符串通常**不携带**"扫描总体状态"这一维度（[§4.4.1](#s4-4-1) 的 `status` 正是补上这一点的），因此本节判据只能覆盖"计数读不出来"——覆盖不了"报告从未产出但计数被写成 0"。

**关键判据**——正则守卫最先，`to_number` 其次，`-` 与缺失都 fail closed（**片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
      # EXCERPT -- key conditions only, NOT a standalone manifest; the
      # indentation is kept from the full policy, so this block alone does
      # not parse. Apply the complete YAML from the details block below.
        # Terminal guard, counted not [0]-indexed (§4.4.1): only terminal TaskRuns
        # are judged, so the counts below never fire on an in-flight status write
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # exactly one token may claim the count: zero means it is missing, two or
        # more means a second value was smuggled in behind a benign first one
        # status.results carries no uniqueness guarantee either, so a decoy entry with
        # the same name in front of the real one would win the [0] below. Same for the
        # Succeeded condition. Require exactly one of each.
        - name: summaryResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='trivy-summary'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: criticalTokenCount
          variable:
            jmesPath: "length(split(aggregate, ';')[?starts_with(@, 'critical=')])"
            default: 0
        - name: criticalField
          variable:
            # isolate the critical= token; this shape uses 'critical=-' as the sentinel
            # for "counts unavailable", so the token may not be a number at all
            jmesPath: "split(aggregate, ';')[?starts_with(@, 'critical=')] | [0] || 'critical='"
            default: "critical="
        - name: criticalValue
          variable:
            jmesPath: "split(criticalField, '=')[1] || ''"
            default: ""
        - name: criticalIsNumeric
          variable:
            # match the WHOLE token, not just the value read out of it; a prefix-only
            # test reads 'critical=0;critical=9' and 'critical=0=9' as a clean zero
            jmesPath: >-
              criticalTokenCount == `1`
              && regex_match('^critical=[0-9]{1,9}$', criticalField)
      preconditions:
        all:
          # ...(taskRef identity omitted -- same-namespace policy-demo-trivy-summary,
          # no resolver; see the full YAML)
          # Terminal guard: in-flight status writes SKIP here instead of tripping
          # the NotEquals-1 counts below with a not-yet-written result
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        deny:
          conditions:
            any:
              # the summary or the terminal condition is not unambiguous
              - key: "{{ summaryResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              # counts unavailable / missing / duplicated / malformed → fail closed;
              # never read '-' as zero, never trust the first of several tokens
              - key: "{{ criticalIsNumeric }}"
                operator: Equals
                value: false
              # validated numeric value only → to_number runs after the regex guard
              - key: "{{ criticalIsNumeric && to_number(criticalValue) > `0` }}"
                operator: Equals
                value: true
```

下面的 fixture 画像使用 `policy-poc` 中 namespace 本地的 `taskRef.name: policy-demo-trivy-summary`（无 resolver）。名字里的 `trivy` 只是**沿用它所模拟的聚合字符串形态**——它是为本文构建的发射器 fixture，**不是**目录里的 `trivy-scanner`；后者已发布对象结果，请走 [§4.4.1](#s4-4-1)。把这套用到你自己的目标 Task 时，必须改成该 Task 的完整 `taskRef` 身份（hub 引用的话包括 catalog / name / version）——**不得**用 `tekton.dev/task` 之类的子级标签来识别它。

:::details 完整策略 YAML：vuln-threshold-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: vuln-threshold-audit
spec:
  webhookConfiguration:
    # Ignore, not Fail: this policy matches */status — a Kyverno outage must never
    # block the Tekton controller's status write-back (§2.2 red line; §3.7 tiering)
    failurePolicy: Ignore
  background: false
  rules:
    - name: no-critical-vulns
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        # This fixture uses a direct, namespace-local Task reference. Lock both
        # the absence of a resolver and the Task name; child labels are untrusted.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskRefName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ''"
            default: ""
        # Judge every terminal TaskRun, including terminal runs that failed to write
        # the declared result. Earlier status updates remain out of scope. Counting
        # terminal conditions (rather than reading [0]) keeps a duplicate Succeeded
        # entry from disarming the guard -- see §4.4.1.
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        - name: summary
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary'].value | [0] || `[]`"
        - name: aggregate
          variable:
            jmesPath: "summary[0] || ''"
            default: ""
        # Count the tokens that claim to carry the critical count. A well-formed
        # summary has exactly one; zero means the field is missing and two or more
        # means the producer (or an attacker) smuggled a second value in.
        # status.results carries no uniqueness guarantee either, so a decoy entry with
        # the same name in front of the real one would win the [0] below. Same for the
        # Succeeded condition. Require exactly one of each.
        - name: summaryResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='trivy-summary'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: criticalTokenCount
          variable:
            jmesPath: "length(split(aggregate, ';')[?starts_with(@, 'critical=')])"
            default: 0
        - name: criticalField
          variable:
            # isolate the critical= token; this shape uses 'critical=-' as the sentinel
            # for "counts unavailable", so the token may not be a number at all
            jmesPath: "split(aggregate, ';')[?starts_with(@, 'critical=')] | [0] || 'critical='"
            default: "critical="
        - name: criticalValue
          variable:
            jmesPath: "split(criticalField, '=')[1] || ''"
            default: ""
        - name: criticalIsNumeric
          variable:
            # Match the WHOLE token, not just the value read out of it, and require
            # exactly one such token. Taking the first match of a leading-prefix test
            # would read 'critical=0;critical=9' and 'critical=0=9' as a clean 0.
            jmesPath: >-
              criticalTokenCount == `1`
              && regex_match('^critical=[0-9]{1,9}$', criticalField)
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: ""
          - key: "{{ taskRefName }}"
            operator: Equals
            value: policy-demo-trivy-summary
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        failureAction: Audit
        message: "image scan critical count is '{{ criticalValue }}' — unknown/non-numeric (e.g. '-') or above threshold 0; fail-closed on unknown counts."
        deny:
          conditions:
            any:
              # the summary or the terminal condition is not unambiguous
              - key: "{{ summaryResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              # counts unavailable / missing / malformed → fail closed, never read '-' as zero
              - key: "{{ criticalIsNumeric }}"
                operator: Equals
                value: false
              # validated numeric value only → apply the real threshold (to_number runs after the regex guard)
              - key: "{{ criticalIsNumeric && to_number(criticalValue) > `0` }}"
                operator: Equals
                value: true
```

:::

:::details 复现 fixture 与探针：字符串形态发射器（policy-demo-trivy-summary）

下表中的 `trivy-*` 行用的正是这个 fixture——它**不需要网络访问、不拉任何漏洞库**；只是把几种聚合字符串形态逐字写进结果。两个对象都必须创建：`policy-poc` 中的那个是策略的目标，`tekton-templates` 中的**同名** Task 是最后一行"同名不同源——必须 skip"的对照。

```yaml
# String-shape emitter fixture for the generic parsing pattern (§4.4.2). The dup
# and smuggled modes reproduce the bypasses a leading-token-only parser reads as
# a clean zero.
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-trivy-summary
  namespace: policy-poc
spec:
  params:
    - name: mode
      type: string
  results:
    - name: trivy-summary
      type: array
  steps:
    - name: emit
      image: <registry>/busybox:latest
      env:
        - name: MODE
          value: $(params.mode)
      script: |
        #!/bin/sh
        set -eu
        case "$MODE" in
          clean)
            printf '["scanType=image;critical=0;high=0"]' > "$(results.trivy-summary.path)"
            ;;
          vuln)
            printf '["scanType=image;critical=3;high=10"]' > "$(results.trivy-summary.path)"
            ;;
          unknown)
            printf '["scanType=image;critical=-;high=-"]' > "$(results.trivy-summary.path)"
            ;;
          dup)
            # A second critical= token hides the real count behind a benign first one.
            printf '["scanType=image;critical=0;critical=9;high=0"]' > "$(results.trivy-summary.path)"
            ;;
          smuggled)
            # An extra '=' makes a naive split read only the leading zero.
            printf '["scanType=image;critical=0=9;high=0"]' > "$(results.trivy-summary.path)"
            ;;
          missing)
            # A successful terminal TaskRun without the declared result must fail closed.
            ;;
          *)
            exit 1
            ;;
        esac
---
# Same Task name, another namespace and resolver source. The policy pins the
# namespace-local taskRef.name shape, so this one must be skipped even though it
# emits a violating count.
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-trivy-summary
  namespace: tekton-templates
spec:
  results:
    - name: trivy-summary
      type: array
  steps:
    - name: emit
      image: <registry>/busybox:latest
      script: |
        #!/bin/sh
        printf '%s' '["scanType=image;critical=9;high=9"]' > "$(results.trivy-summary.path)"
```

把上面两个 Task 存为 `trivy-summary-emitters.yaml`（替换 `<registry>`）并先创建——下面六个探针按名字引用它们：

```bash
# Both Tasks land in walkthrough-owned namespaces (§4.0.4): the namespace cascade
# takes them at cleanup, so a plain apply is fine here.
kubectl apply -f trivy-summary-emitters.yaml
# Expect both. NotFound on either one makes every probe below fail with
# `tasks.tekton.dev "policy-demo-trivy-summary" not found`, which looks like a
# broken probe rather than a missing fixture.
kubectl get task -n policy-poc policy-demo-trivy-summary
kubectl get task -n tekton-templates policy-demo-trivy-summary
```

六个 `trivy-*` 探针只有 `mode` 不同（`clean` / `vuln` / `unknown` / `dup` / `smuggled` / `missing`）；形态是：

```yaml
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: trivy-dup
  namespace: policy-poc
spec:
  taskRef:
    name: policy-demo-trivy-summary
  params:
    - name: mode
      value: dup
```

一次性创建全部六个（每个名字与它的 mode 对应，报告行一眼就能对上）：

```bash
for mode in clean vuln unknown dup smuggled missing; do
  kubectl create -f - <<YAML
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: trivy-$mode
  namespace: policy-poc
spec:
  taskRef:
    name: policy-demo-trivy-summary
  params:
    - name: mode
      value: $mode
YAML
done

# All six must be TERMINAL before the report means anything (see the note at the end of
# §4.4.2). `kubectl get` alone does not wait -- read it after this loop, not instead of it.
for mode in clean vuln unknown dup smuggled missing; do
  kubectl wait -n policy-poc "taskrun/trivy-$mode" \
    --for=condition=Succeeded --timeout=5m
done

kubectl get taskrun -n policy-poc \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.conditions[0].status,REASON:.status.conditions[0].reason' \
  | grep '^trivy-'
# Expect ALL SIX Succeeded -- trivy-missing included. Measured on this environment:
# Tekton does NOT fail a TaskRun that skips writing a result it declared, so the run
# is green and nothing but the policy can catch it. That is exactly the case the
# fail-closed branch exists for; a "False" here instead means the fixture failed for
# some other reason (usually the image could not be pulled), so fix that first.
```

最后一行的对照探针改用 cluster resolver 指向另一 namespace 中的同名 Task（它没有 `mode` 参数）：

```yaml
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: trivy-same-name-other-source
  namespace: policy-poc
spec:
  taskRef:
    resolver: cluster
    params:
      - name: kind
        value: task
      - name: name
        value: policy-demo-trivy-summary
      - name: namespace
        value: tekton-templates
```

存为 `trivy-same-name-other-source.yaml` 并创建：

```bash
kubectl create -f trivy-same-name-other-source.yaml
```

运行结束后，等 TaskRun 到达终态，再读判定（该策略是 Audit——所有请求都被放行；结论只存在于报告中）：

```bash
# On the cluster that runs Tekton and Kyverno.
kubectl get policyreport -n policy-poc \
  -o custom-columns=SUBJECT:.scope.name,RESULT:.results[*].result
```

**读报告需要耐心**：一个 TaskRun 会经历多次非终态 status 更新，每次都因 `isTerminal` 前置条件被记录为 `skip`；运行刚转终态时你通常仍会读到那个 `skip`，终态判定要等上报链路跟上后才出现（通常在数十秒量级）。**读一次就下结论，你测到的是竞态——不是策略。**

还有一个更微妙的形态：**应被判为 `skip` 的对象可能根本还没有报告行**。表格最底部的"同名不同源——必须 skip"一行正是这种情况——它的判定永远是 `skip`，所以你无法用"它是否已变成 fail"来判断它的报告是否已写出；你可能得到"六个判定全对、第七行完全缺失"的局面，看起来像"无误伤对照没生效"，其实只是报告还没到。把等待条件写成"**七个对象都有报告行**，且其中六个已离开 `skip`"——不要只等前一半。

**注意这些探针是你手工提交的裸 TaskRun**：装有 [§4.5.4](#s4-5-4) 的 `pipeline-entry-lockdown` 的集群会在入口处直接拒绝它们（[§4.0.5](#s4-0-5)）。

:::

:::details 两个策略的期望 PolicyReport（sonar 的四值域 + 六个字符串 fixture 场景 + 两个无误伤对照）

| TaskRun | 结果输入 | PolicyReport |
|---|---|---|
| `audit-sonar-terminal-pass` | `Succeeded` | pass |
| `audit-sonar-terminal-failed-verdict` | `Failed` | fail |
| `audit-sonar-terminal-skipped` | `Skipped` | fail |
| `audit-sonar-terminal-canceled` | `Canceled` | fail |
| `audit-sonar-terminal-numeric-invalid` | 非法的数字样式值 `"1"` | fail |
| `audit-sonar-terminal-missing-result` | 已终态，`code-scan-results` 缺失 | fail |
| `audit-sonar-terminal-non-scanner` | 不同的 Task 身份 | skip |
| `trivy-clean` | `critical=0` | pass |
| `trivy-vuln` | `critical=3` | fail |
| `trivy-unknown` | `critical=-` | fail |
| `trivy-dup` | `critical=0;critical=9`（重复 token） | fail |
| `trivy-smuggled` | `critical=0=9`（token 内多出一个 `=`） | fail |
| `trivy-missing` | 已终态，`trivy-summary` 缺失 | fail |
| `trivy-same-name-other-source` | 同名 Task，但 `resolver=cluster` 且 namespace 为 `tekton-templates` | skip |

以 `trivy-*` 开头的行使用 [§4.4.2](#s4-4-2) 的**字符串形态发射器**，不是目录里的 `trivy-scanner`（后者见 [§4.4.1](#s4-4-1) 的用例表）。

五个关键结论：① 在 sonar 的真实四值域中只有 `Succeeded` 得 pass，已终态但结果缺失的运行同样 fail closed，非扫描器的运行因完整 Task 身份不匹配而 skip；② `critical=-`（表示"计数不可知"的短横线哨兵值）得 **fail**——而且是干净的 `fail`，`error=0`：正则守卫加短路表达式从未对 `-` 执行 `to_number`；③ **`trivy-dup` / `trivy-smuggled` 正是整 token 匹配加计数必须为 1 这两道守卫存在的原因**：把守卫换回"只匹配切出的值、取第一个 token"，这两个输入都会被**误判为通过**；④ 已终态却缺失目标结果的 TaskRun 仍得 fail 而不是静默 skip；⑤ 从另一 namespace 解析出的同名 Task 记为 skip，证明该画像同时锁定了 resolver 形态与 namespace 本地名，而非只比名字。

:::
#### 4.4.3 反面演示：为什么绝不能对 status 使用 Enforce {#s4-4-3}

:::warning 本节是反面演示 — 请勿在任何环境中模仿

当把 [§4.4.1](#s4-4-1) 风格的策略切换为 `Enforce` 时会发生什么（下文将这个仅用于演示的策略称为 `scan-verdict-enforce-wedge-demo` — 与清理清单中的名称相同）：emitter 的 Pod 已经 `Completed`（所有工作都已完成），但控制器写入完成状态的请求被拒绝 — TaskRun 永远停留在 `Running`、没有 `completionTime`，事件还在不断重复：

```text
Warning  UpdateFailed  taskrun/…  Failed to update status for "…": admission webhook "validate.kyverno.svc-fail" denied the request: …
```

这个 run 既不失败也不结束；只有人工干预才能解开它：一旦策略被删除或放宽，控制器会按其退避节奏重试，并自行恢复到正常的终态。恢复时间取决于控制器当时的重试节奏和负载 — 通常在 1 分钟以内，但**无法承诺固定值**。识别与解除步骤见 [§6.1.4](#s6-1-4)。

:::

作为附加内容，一个能证伪「标签是否是罪魁祸首」的对照：`scan-verdict-enforce-wedge-demo` 只匹配完整的 fixture TaskRef（`resolver=cluster`、`kind=task`、`name=policy-demo-scanner`、`namespace=tekton-templates`），从不读取 `tekton.dev/task` 标签。一个独立的对照 TaskRun — 即使它伪造了该标签并写出同名的 `code-scan-results.result=Failed` — 只要其真实 TaskRef 不匹配，就会到达正常终态、不会被卡住。

#### 4.4.4 盘点已存在的资源（后台扫描） {#s4-4-4}

- **它治理什么**：策略**新安装**时集群中**已经存在**的那批对象 — admission 只在发生新的 CREATE/UPDATE 事件时求值，而已存在的对象不会产生新事件，所以 admission 一个都看不到。
- **它为什么难**：直接上 Enforce 会不分青红皂白地拦截对旧 run 的后续操作 — 而你根本不知道存量里有多少违规。
- **策略如何分层**：① `background: true` 让 reports-controller **周期性地 reconcile 并扫描已存在的主资源** → ② `Audit` 模式把每个对象的求值结果写入 PolicyReport → ③ 由此获得违规基线并确定治理节奏（先修复存量，再切换到 Enforce）。
- **它治理不了什么**：后台扫描**只作用于主资源** — `*/status` 子资源策略（[§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2)）没有后台兜底，只在 admission 时刻被求值（[§2.2](#s2-2)）。

下面的示例盘点「哪些 PipelineRun 没有携带 `policy.alauda.io/gated` 标记」（即在 [§4.2.6](#s4-2-6) 注入策略生效之前创建的旧 run）：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: inventory-ungated-runs
spec:
  webhookConfiguration:
    # Ignore, not Fail: this policy is bookkeeping-only (background Audit), yet its
    # match surface still registers in the resource webhook (§3.7) -- with Fail, a
    # Kyverno outage would reject every matching PipelineRun CREATE for zero
    # enforcement benefit. Re-evaluate the tier if this policy is later promoted to
    # Enforce (§4.4.4's remediation path).
    failurePolicy: Ignore
  background: true
  rules:
    - name: pipelinerun-should-carry-gated-label
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              namespaces:
                - policy-poc
      validate:
        failureAction: Audit
        message: "PipelineRun does not carry the policy.alauda.io/gated label (created before the defaults policy?)."
        pattern:
          metadata:
            labels:
              policy.alauda.io/gated: "true"
```

**两个已存在 run 的完整清单**（保存为 `doc-inventory-runs.yaml`）— 它们恰好只差一个标签，都使用 [§3.3](#s3-3) 的可信模板，而且运行很快：

```yaml
# Carries the platform marker -> background scan must record pass
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: doc-inventory-gated
  namespace: policy-poc
  labels:
    policy.alauda.io/gated: "true"
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
---
# No marker: this is the shape the inventory sweep is meant to surface
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: doc-inventory-ungated
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
```

把上面的策略保存为 `inventory-ungated-runs.yaml`。**顺序绝不能颠倒** — 先创建 run 并等待它们到达终态，**然后**再安装策略；反过来的话，这两个 run 会经过正常的 admission 求值，你测到的就不再是对已存在资源的盘点了：

```bash
kubectl create -f doc-inventory-runs.yaml
kubectl wait -n policy-poc pipelinerun/doc-inventory-gated \
  --for=condition=Succeeded --timeout=5m
kubectl wait -n policy-poc pipelinerun/doc-inventory-ungated \
  --for=condition=Succeeded --timeout=5m

# Only now install the policy above, then wait for the background scan to reach them.
# `create`, not `apply`: on a shared cluster an AlreadyExists error here is the answer
# you want -- somebody else already owns that policy name, so stop and pick your own
# rather than overwriting theirs (§4.0.4).
create_owned_cluster_object inventory-ungated-runs.yaml clusterpolicy
kubectl wait --for=condition=Ready clusterpolicy/inventory-ungated-runs --timeout=60s

# Read the two verdicts (background scan is periodic -- repeat until both rows appear).
# The kind filter is not decoration: each run also produces reports scoped to its
# TaskRuns (doc-inventory-gated-scan, ...), and those match the name prefix while
# carrying no verdict for this policy -- without it you get five blank rows.
kubectl get policyreport -n policy-poc -o json | jq -r '
  .items[]
  | select(.scope.kind=="PipelineRun")
  | select(.scope.name | startswith("doc-inventory-"))
  | "\(.scope.name)\t\([.results[] | select(.policy=="inventory-ungated-runs")
      | "\(.result) process=\(.properties.process // "-")"] | join(","))"'
```

**预期形态**：两个 PipelineRun 先创建并到达终态，策略在**之后**安装（Policy 的创建时间晚于被测资源）。在**完全没有任何新资源事件**的情况下，PolicyReport 为携带 `policy.alauda.io/gated: "true"` 的已存在 run 记录 `pass`，为缺少该标签的已存在 run 记录 `fail`，并且结果属性中明确写着 `results[].properties.process: background scan`。

:::warning policy.alauda.io/gated 标签并不是门禁真正跑过的证据

本示例只用它来演示「清出缺少平台标记的旧 run」。[§4.2.6](#s4-2-6) 的 mutation 会为没有显式设置该标签的请求注入 `"true"`，但**流水线用户自己也可以在 PipelineRun 上写一个同名标签** — 所以它能证明的只是扫描时对象上存在该标签值；既不能证明 mutation 曾经执行过，也不能证明该 run 真正通过了硬门禁。

要盘点「是否真正处于门禁约束之下」，请核验真实的门禁事实（门禁任务是否存在及其结果；[§4.1.4](#s4-1-4) 的漂移 Audit），或者让可信入口写入业务用户无法伪造的策略版本 / 配置哈希标记。

:::

##### PolicyReport 是干什么用的（怎么读、怎么消费、以及不该对它期待什么）

PolicyReport 是由 Kyverno 写入的**标准 Kubernetes 资源**（`wgpolicyk8s.io`）— 每个被求值的资源一份，以该资源的 UID 命名：`summary` 给出 pass / fail / warn / error / skip 计数，`results[]` 逐条列出「哪个策略的哪条规则、判定为什么、消息是什么」。它把策略求值结果变成集群中**可查询、可聚合、可编程消费**的数据 — 而这正是 Audit 策略唯一的输出形式。

三种最常见的读取方式：

```bash
# 1) Overall violation surface of one namespace: one row per resource, read the FAIL column
kubectl -n policy-poc get policyreport

# 2) Violation list for one policy (resource name + reason) -- feed it straight into remediation tickets
kubectl -n policy-poc get policyreport -o json | jq -r '
  .items[] | .scope as $s | .results[]
  | select(.policy=="inventory-ungated-runs")
  | "\(.result)\t\($s.kind)/\($s.name)\t\(.message)"'

# 3) How many violations of THIS policy are left before switching it to Enforce.
#    Filtered by policy on purpose: an unfiltered count sums every policy in the cluster, so
#    the number this procedure tells you to drive to zero would never be about the policy you
#    are deciding on -- other Audit policies' violations would keep it above zero forever.
kubectl get policyreport -A -o json | jq -r '
  [.items[].results[] | select(.policy=="inventory-ungated-runs" and .result=="fail")] | length'
#    (Drop the .policy filter only when you deliberately want the cluster-wide violation
#     surface across ALL policies -- that is a different question from this one.)
```

与 [§3.5](#s3-5) 的「先 Audit」上线流程配合，它的价值在于把治理变成一个**可度量的过程**：先用 Audit + `background: true` 盘点基线（读法 3 给你一个数字），把清单交给各团队修复（读法 2），数字降到 0 或可接受水平后再切换到 Enforce — 并且**在同一次变更中重新评估 `failurePolicy` 档位**：该策略以 `Ignore` 交付（纯记账没有拦截收益；见资产注释和 [§3.7](#s3-7) 的分档），但切换到 Enforce 后它就加入了拦截类 — 按集群的可用性方案决定是否改回 `Fail`。修复之后报告会自行收敛 — 给违规 run 补上标签，其报告在下一次求值时就从 `fail: 1` 翻转为 `pass: 1`；不需要手工清理报告。

同时也要认清它的**边界**，否则你最终会把它当成它承担不了的证据：

- **它不是审计日志。** 报告以资源 UID 命名，并随资源一起被垃圾回收：删掉 run，它的报告也就没了。长期留存需要外部采集（把报告导出到日志 / 指标系统）；不要指望在集群里翻挖历史。
- **被 Enforce 拒绝的请求不会留下报告。** 在 admission 被拒的对象根本没有被持久化过，所以没有资源可以挂报告；那条路径上的证据是 Kyverno 事件加上调用方收到的错误消息（[§6.2](#s6-2)）。
- **`mutate` 规则不产生违规记录。** 被 [§4.2.3](#s4-2-3) 取消的 TaskRun 在报告中显示为 `result=skip`、消息为 `no patches applied`（后台重新求值时对象已处于目标状态）— 而不是 `fail`。要让「哪些 run 被策略动过」可查询，请另加一条 Audit 规则做记账，或依赖对象上的注解 / `statusMessage`。
- **它只回答「求值得出了什么结论」— 不回答「这条流水线是否真正跑了质量检查」。** 判定的强度取决于策略自身读了什么（[§2.3](#s2-3) 的契约）；报告只是把结论带出来而已。
- **没有发现 `fail` 不等于合规** — 这是审计场景里最容易出错的一步。空结果至少有五种含义，而它们看起来一模一样：① 真正合规；② 策略**没有匹配上**（模板 / Task 版本变更把一切变成了 `skip`，[§3.6](#s3-6)）；③ 请求被 `resourceFilters` **整体跳过**（既不是拒绝也没有报告，[§3.1](#s3-1) 检查单第 7 项）；④ 报告**尚未收敛**（[§6.1.5](#s6-1-5)）；⑤ 对象 — 连同报告 — **已经被 GC 了**。所以审计结论只能陈述为「**没有可用的违规记录**」，除非你能同时给出：匹配到的策略与规则名（读法 2 的 `policy` 字段）、当时 `resourceFilters` 的快照、报告已过收敛窗口的确认，以及对象本身仍然存在。

:::warning 要事后证明某次发布经过了门禁，只归档 PolicyReport 是不够的

报告随其对象一起被 GC，而**被 Enforce 拒绝的请求根本没有对象** — 所以证据分散在四个地方、有四种不同的生命周期：**PipelineRun / 门禁 TaskRun 的终态和 `status.results`**（证明「跑过了、结论是什么」）、**PolicyReport**（证明「策略如何判定」）、**Events**（证明发生过取消 / 拒绝）、以及 **admission 拒绝消息**（只存在于调用方和 Kyverno 的日志里）。长期留存意味着在**对象还活着的时候**把四者全部采集下来，用 PipelineRun UID 作为键串起来（对象名会重复；UID 不会）。

本文档不为你环境中这些对象规定留存期限 — **但你不必去猜**：跑一次下面的命令，就能得到**仍然存在的最老 `PipelineRun`** 的时间戳。⚠️ **这只是四类证据之一的地平线，不是整条证据链的**：如刚才所说，四者生命周期不同 — `PolicyReport` 随其对象一起被 GC（对已删除的 run 只会更近），而 Events 和 admission 拒绝消息各有自己的留存策略（两者可能相差很远：曾见过最老的 `PipelineRun` 与最老的 Event 相差 43 天、方向还与直觉相反的案例）。要回答「那次发布还能不能查到」，请**对四类各查一次**，取其中最近的那个地平线。（在运行 Tekton 的集群上执行。）

```bash
# The oldest row is the horizon of THIS evidence class only. PolicyReport, Event and
# admission-denial messages each have their own retention, so query all four and take
# the most recent -- see the paragraph above.
kubectl get pipelinerun -A --sort-by=.metadata.creationTimestamp \
  -o custom-columns='CREATED:.metadata.creationTimestamp,NS:.metadata.namespace,NAME:.metadata.name,UID:.metadata.uid,VERDICT:.status.conditions[0].reason' \
  | head -5
```

:::

#### 清理（§4.4）

按 [§4.0.4](#s4-0-4) 的两条规则清理。通过归属台账按记录的 UID 删除四个集群级策略；如果你按 [§4.4.3](#s4-4-3) 的描述**自己**搭建了反面演示策略（本文档刻意不提供它的可安装 YAML），它在创建时也必须已写入同一台账 — 然后按你实际使用的名字删除它，并**先确认没有 TaskRun 因它而卡在 `Running`**：

```bash
for pol in scan-verdict-audit vuln-summary-audit vuln-threshold-audit \
  inventory-ungated-runs; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
```

namespace 级对象（上表的 14 个 TaskRun、真实 `trivy-scanner` 0.6 TaskRun 及其源码 fixture ConfigMap、两个盘点用 PipelineRun、以及 [§4.4.2](#s4-4-2) 的两个 emitter fixture Task）全部位于自建 namespace 中，由级联删除回收；如果你要继续后面的章节，请先按名字删除 run 类对象 — 否则它们的 PolicyReport 行会出现在下一节的 `kubectl get policyreport` 中（[§4.0.5](#s4-0-5)）：

```bash
# A read loop, not `kubectl delete $(...)`: with no match the substitution would leave
# a delete with no names (an error), and an unquoted expansion is a paste trap anyway.
kubectl get taskrun -n policy-poc -o name \
  | grep -E '/(audit-sonar-terminal-|trivy-)' \
  | while read -r tr; do kubectl delete -n policy-poc "$tr"; done
kubectl delete pipelinerun -n policy-poc doc-inventory-gated doc-inventory-ungated \
  --ignore-not-found
```

### 4.5 来源、镜像与发布目标（契约 1「身份」/ 契约 7「入口封闭」的运行时侧） {#s4-5}

本章覆盖三个未授权面：制品从哪里来（拷贝输入）、实际运行的是什么镜像（执行镜像）、发布到哪里去（发布目标）— 外加入口封闭。

**本节地图**（按流水线的物料流向排序）：

- **[§4.5.1](#s4-5-1)** — 制品拷贝来源白名单（真实的 `skopeo-copy` 画像）：输入从哪些 registry 拉取。
- **[§4.5.2](#s4-5-2)** — 来源镜像属性校验：用 `context.imageRegistry` 读取镜像配置并判断镜像自身的属性，而不只是它的名字。
- **[§4.5.3](#s4-5-3)** — 执行镜像白名单：**Pod 层的硬拦截**，全文档中唯一能治理「这个 step 实际运行什么镜像」的观测点。
- **[§4.5.4](#s4-5-4)** — 封闭裸 `TaskRun` / `CustomRun` 入口（契约 7）：[§4.2](#s4-2) 那些从父 run 推导身份的判据只对控制器创建的子 TaskRun 成立；本节封住的是绕开任何父 run、直接创建 Run 的入口（Pod 层的 [§4.5.3](#s4-5-3) 不受入口影响 — 两者互补）。
- **[§4.5.5](#s4-5-5)** — 发布目标白名单（真实的 `-image-build-scan-deploy` 0.3 画像）：产出可以发布到哪些 namespace / 可以使用哪一组凭证。

#### 4.5.1 制品拷贝来源白名单（真实画像：skopeo-copy） {#s4-5-1}

- **它治理什么**：**制品只能从已批准的 registry 拷贝进来**。场景是用平台目录的 `skopeo-copy` 做镜像拷贝 / 晋级；来源不受控时，任何人都能把外部镜像「拷贝」进内部 registry — 从此它就算「内部镜像」了。这是供应链投毒最廉价的入口。注意被治理的是**这次拷贝的输入参数**，不是这个 TaskRun 自己跑在什么镜像上（那是 [§4.5.3](#s4-5-3) 的事）。
- **它为什么难**：`skopeo-copy` 允许**三种方式**指定来源，漏掉任何一种都是绕过漏洞 — ① 简单模式，`srcTransport` + `srcImage`（裸引用，**没有** `docker://` 前缀）；② 内联模式，`imageMappings`（数组，每项 `"SRC DST"`，**带** `docker://` 前缀）；③ 文件模式，`copy-mappings` workspace（其内容在 admission 时**完全不可见**）。三者连前缀写法都不一样 — 这就是下面的策略带这么多 context 变量的原因。
- **策略如何分层**：① 先锁定「是不是那个 Task」（`taskRef` 中的完整 resolver 坐标 — **绝不用节点别名或子级标签**，它们可以经 `taskRunSpecs` 覆盖和伪造）→ ② 再锁定「Task 有没有被换掉」（拒绝请求级 `url`；显式 `type` 只允许是 `artifact` — 针对「名字照旧、内容换成我的」）→ ③ 然后才是来源白名单（每种模式各自的前缀 + `srcTransport` 只允许 `registry`；显式空字符串不算缺席、不得继承默认值）→ ④ 三个 fail-closed 兜底：**换行走私**、**文件模式直接拒绝**、**以及一个来源都识别不出时拒绝**。
- **它治理不了什么**：它只在「**这个 Task 真的被使用**」的场景下有效。谁要是绕开 `skopeo-copy`、创建一个跑 skopeo / crane 镜像的裸 TaskRun 手工推镜像，就完全不在这条规则的射程内 — 它只有与 [§4.5.4](#s4-5-4)（封闭裸 Tekton Run 入口）和 [§4.5.3](#s4-5-3)（Pod 层执行镜像白名单）配合才成立。

**通用契约**：约束「拷贝类任务的输入参数」。参数校验只在「该任务被使用」的场景下有效 — 必须与入口封闭（[§4.5.4](#s4-5-4)）配套；否则绕开该任务直接推镜像就能击穿它。

`skopeo-copy`（0.1）的三种来源模式都必须覆盖（字段取自真实 Task 定义）：① 简单模式，`srcTransport`（默认 `registry`）+ `srcImage`（**裸镜像引用，没有 `docker://` 前缀**）；② 内联模式，`imageMappings`（数组，每项 `"SRC DST"`，**带 `docker://` transport 前缀**）；③ 文件模式，`copy-mappings` workspace（其内容在 admission 时**不可见**）。

**关键判据** — 每种模式各自计算一个布尔值，`any` 之下任一命中即拒绝；注意 `mappingsMalformed` 这一项不是凑数的：

```yaml
        - name: mappingsMalformed
          variable:
            # The catalog parser consumes one SRC DST mapping per line. Reject
            # embedded line breaks before source allowlisting, otherwise one
            # array item can smuggle a second mapping past mappingSources.
            jmesPath: "length(mappings[?regex_match('^[^\\r\\n]*$', @) == `false`]) > `0`"
        - name: simpleBad
          variable:
            jmesPath: "srcImage != '' && !starts_with(srcImage, '<approved-registry>/')"
        - name: mappingsBad
          variable:
            jmesPath: "length(mappingSources[?!starts_with(@, 'docker://<approved-registry>/')]) > `0`"
        - name: noVisibleSource
          variable:
            jmesPath: "srcImage == '' && length(mappings) == `0` && !hasFileWorkspace"
```

**为什么换行走私需要单独的判定**：目录里的脚本是**逐行**读取 mappings 的。往某个数组项里塞一个 `\r\n` — 第一段是已批准来源、第二段走私一个未授权来源 — 白名单永远只看到第一段，第二个来源就溜过去了。所以两种模式都必须先断言「单行」，然后才应用前缀白名单。

:::details 完整策略 YAML：artifact-source-allowlist

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: artifact-source-allowlist
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: skopeo-sources-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: hubTypeCount
          variable:
            jmesPath: "length((request.object.spec.taskRef.params || `[]`)[?name=='type'])"
        - name: hubType
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='type'].value | [0] || ''"
            default: ""
        - name: hubURLCount
          variable:
            jmesPath: "length((request.object.spec.taskRef.params || `[]`)[?name=='url'])"
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
        # simple mode: srcTransport (default registry) + srcImage (bare ref, NO docker:// prefix)
        - name: srcTransportPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='srcTransport']) > `0`"
        - name: srcTransport
          variable:
            # Only an omitted parameter may inherit the trusted Task default.
            jmesPath: "(request.object.spec.params || `[]`)[?name=='srcTransport'].value | [0] || ''"
            default: ""
        - name: srcImage
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='srcImage'].value | [0] || ''"
            default: ""
        # inline mode: imageMappings, each "SRC DST" with a docker:// transport prefix
        - name: mappings
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='imageMappings'].value | [0] || `[]`"
        - name: mappingSources
          variable:
            jmesPath: "map(&split(@, ' ') | [0], mappings)"
        - name: mappingsMalformed
          variable:
            # The catalog parser consumes one SRC DST mapping per line. Reject
            # embedded line breaks before source allowlisting, otherwise one
            # array item can smuggle a second mapping past mappingSources.
            jmesPath: "length(mappings[?regex_match('^[^\\r\\n]*$', @) == `false`]) > `0`"
        # file mode: a copy-mappings workspace whose content admission cannot inspect
        - name: hasFileWorkspace
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='copy-mappings']) > `0`"
        # verdicts computed inside JMESPath (exact string, no operator coercion)
        - name: simpleBad
          variable:
            jmesPath: "srcImage != '' && !starts_with(srcImage, '<approved-registry>/')"
        - name: simpleMalformed
          variable:
            # Simple mode writes srcImage into a line-oriented mapping file.
            # Reject CR/LF so an approved first line cannot smuggle a second source.
            jmesPath: "srcImage != '' && regex_match('^[^\\r\\n]*$', srcImage) == `false`"
        - name: transportBad
          variable:
            jmesPath: "srcImage != '' && srcTransportPresent && srcTransport != 'registry'"
        - name: mappingsBad
          variable:
            jmesPath: "length(mappingSources[?!starts_with(@, 'docker://<approved-registry>/')]) > `0`"
        - name: noVisibleSource
          variable:
            jmesPath: "srcImage == '' && length(mappings) == `0` && !hasFileWorkspace"
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: skopeo-copy
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.1"
      validate:
        failureAction: Enforce
        message: >-
          skopeo copy must use the governed Artifact Hub endpoint and sources
          from the approved registry. Simple mode: srcTransport must be
          'registry' and srcImage must start with the approved registry.
          Inline mode: every imageMappings source must be
          docker://<approved-registry>/... File mode (copy-mappings workspace)
          cannot be inspected at admission and is rejected. got srcImage='{{ srcImage }}',
          mappings sources {{ mappingSources }}, fileWorkspace={{ hasFileWorkspace }}.
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"
                operator: Equals
                value: true
              - key: "{{ simpleBad }}"
                operator: Equals
                value: true
              - key: "{{ simpleMalformed }}"
                operator: Equals
                value: true
              - key: "{{ transportBad }}"
                operator: Equals
                value: true
              - key: "{{ mappingsBad }}"
                operator: Equals
                value: true
              - key: "{{ mappingsMalformed }}"
                operator: Equals
                value: true
              # file mode is a blind spot at admission → reject (or gate via a dedicated approved workspace)
              - key: "{{ hasFileWorkspace }}"
                operator: Equals
                value: true
              - key: "{{ noVisibleSource }}"
                operator: Equals
                value: true
```

:::

:::details 验证探针（14 个，--dry-run=server）

| 探针 | 预期 |
|---|---|
| 简单模式：`srcImage` 来自已批准的 registry | 允许 |
| 简单模式：`srcImage` 来自 `docker.io` | 拒绝 |
| 简单模式：已批准的 `srcImage` 但 `srcTransport=oci-archive` | 拒绝 |
| 简单模式：显式置空的 `srcTransport` | 拒绝（空字符串不算缺席；不继承默认值） |
| 简单模式：`srcImage` 第一行已批准、第二行走私未授权来源 | 拒绝 |
| 内联模式：`imageMappings` 每一项都已批准 | 允许 |
| 内联模式：混入一个未授权来源 | 拒绝 |
| 内联模式：单条 mapping 中嵌入换行走私第二个来源 | 拒绝 |
| 文件模式：带 `copy-mappings` workspace | 拒绝（admission 盲区） |
| 完全没有可见来源 | 拒绝（fail-closed） |
| 同样的节点别名，但 Task 身份不是 `catalog/skopeo-copy/0.1` | 规则跳过 — 无误伤 |
| 单个显式 `type=artifact` | 允许 |
| 已批准元组 + 请求级 `url` | 拒绝 |
| 已批准元组 + 显式 `type=tekton` | 拒绝 |

:::

**文件模式的取舍**：`copy-mappings` workspace 里的 `SRC DST` 清单在 admission 时无法检查，所以本策略**直接拒绝该模式**。如果某个团队确实需要文件模式，正确答案是把清单内容的治理**上移**（治理产出该 workspace 的上游任务 / 制品），而不是指望这条 admission 策略来兜底。

**它判定的是「请求里出现了什么」，不是「Task 最终消费了什么」** — 一个刻意保守的超集；安装前先了解代价。`skopeo-copy` 有自己的输入优先级：`imageMappings` 非空时用它，`srcImage` / `dstImages` 和 `copy-mappings` workspace 被**忽略**；没有它才走简单模式；再没有才读文件模式。本策略**不复刻这个优先级** — 任何一种模式里出现未批准来源都会被拒绝。

- **为什么不复刻**：判据一旦跟随 Task 的内部优先级，当 Task 的下一个版本重排该优先级时，策略就会**静默**放行 — 这正是 [§4.2.4](#s4-2-4) 三问中第 3 问要防的形态。宁可多拒，也不要静默少拒。
- **代价（两种已知误拒）**：① 合规的 `imageMappings` 加上一个从没清理掉的、范围外的残留 `srcImage`；② 合规的简单模式加上一个随手绑定的 `copy-mappings` workspace — 上游对这种组合有正式用例，运行时简单模式胜出、该 workspace 永远不会被读取。这两种都会被本策略拒绝。
- **被拒绝时该怎么办**：先检查请求是否**携带了它并不使用的来源参数或 workspace 绑定** — 删掉即可通过。不要为了放行那条「反正不会被读」的条目而放松判据 — admission 看不到 Task 的运行时选择，也没人为那个「反正」担保。

#### 4.5.2 来源镜像属性校验（`context.imageRegistry` 读取镜像配置） {#s4-5-2}

- **它治理什么**：不只是「参数点名了哪个镜像」，而是**镜像自身的属性** — 例如「被晋级的基础镜像必须携带 `build=tekton` 标签」、「必须声明 `org.opencontainers.image.source`」。
- **它为什么难**：这些属性存在于 OCI 镜像的 config 里；**它们不是任何 Kubernetes 对象的字段**，`context.apiCall` 够不着它们。
- **策略如何分层**：① 收窄到拷贝 Task，且只在它确实携带来源镜像引用时 → ② 在 admission 期间用 `context.imageRegistry` 直接从 registry 拉取该镜像的 manifest / config → ③ 用 JMESPath 深入 `configData.config.Labels` 等字段做出判定 — **缺失的标签必须显式默认为一个永远不可能通过的值**，否则规则就 fail-open 了。
- **第 ① 层是最容易埋雷的地方**：Task 身份必须**同时**从 `taskRef.name` 和 resolver 的 `taskRef.params` 读取 — 集群内引用把名字放在 `.name`，而 hub / git / cluster resolver 形态下 `.name` 是**空的**、名字在 `params` 里。只匹配 `.name` 等于对所有 resolver 形态的 TaskRun **静默跳过**（策略装上了、看着没问题、什么都拦不住）。生产环境请进一步收紧到 [§4.5.1](#s4-5-1) 那样的完整 resolver 坐标。
- **它治理不了什么**：**它只能读取 admission 时已经存在的镜像**（所以只能校验 source、永远校验不了本次操作产出的 dest）；而且它把外部网络放上了 admission 路径 — 四条局限见下方警告；上线前先权衡。

针对这类需求，Kyverno 提供了另一种外部数据源 — **`context.imageRegistry`**：在 admission 期间，Kyverno 自己从 registry 拉取指定镜像的 manifest / config，把结果放进一个变量，JMESPath 再深入 `configData.config.Labels` / `.Env` 或 `configData.architecture` 等字段。

**关键判据** — 用 `|| 'MISSING'` 兜住缺失的标签，确保它落在拒绝一侧：

```yaml
      context:
        - name: srcRef
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='srcImage'].value | [0]"
        # Kyverno pulls the image config from the registry during admission.
        - name: imgdata
          imageRegistry:
            reference: "{{ srcRef }}"
        # A missing label must not fail open: default to MISSING so the comparison
        # below still denies. Compare inside JMESPath rather than with a Kyverno
        # NotEquals -- operator coercion would swallow a forged numeric-looking
        # label value such as "1" and let the image through (§6.1.7).
        - name: buildLabelBad
          variable:
            jmesPath: "(imgdata.configData.config.Labels.build || 'MISSING') != 'tekton'"
      preconditions:
        all:
          # ...(skopeo-copy taskRef identity omitted; see the full YAML)
          # A TaskRun WITHOUT srcImage fails this precondition -> the rule skips it
          # (allowed), the opposite of the fail-closed instinct. Deliberate scope
          # cut: this rule only judges a srcImage that is present; the "no visible
          # source" case is owned by §4.5.1's noVisibleSource deny
          - key: "{{ (request.object.spec.params || `[]`)[?name=='srcImage'].value | [0] || '' }}"
            operator: NotEquals
            value: ""
      validate:
        deny:
          conditions:
            all:
              - key: "{{ buildLabelBad }}"
                operator: Equals
                value: true
```

标签键里含点号时需要加引号才能在 JMESPath 中下钻 — 例如 `{{ imgdata.configData.config.Labels."org.opencontainers.image.source" || 'MISSING' }}` — 然后就能正常读出。

:::warning 四条局限 — 用之前先权衡

1. **它只能读取 admission 时已经存在的镜像。** 在拷贝 / 晋级场景中，dest 镜像由本次操作产出、admission 时还不存在 — **只有 source 能被校验**；dest 的属性要等它落到 registry 之后，由部署侧 admission（[§4.5.3](#s4-5-3)）或专门的门禁任务来校验。
2. **可变 tag 的竞态**：admission 读到的是 tag 此刻指向的 config；等拷贝真正运行时，tag 可能已被重新推送。要堵上这个缝，让上游先把 tag 解析成 digest，并让策略只校验 digest 形式的引用。
3. **私有 registry 需要凭证**：Kyverno 以**它自己的身份**拉取镜像，必须为其配置相应的 imagePullSecret / registry 凭证，否则规则会因拉取失败而报错。**方向是 fail-closed**：把 `srcImage` 指向一个不可达地址（`192.0.2.1/ops/nowhere:latest`），请求会被**拒绝**、拒绝消息里带着本策略的名字；同一策略对可达镜像放行。**所以一旦 registry 不可达或凭证过期，所有经过本策略的流水线会被整体拒绝** — 上线前先决定这是不是你要的方向（想要 fail-open 的话，唯一的选择就是不用这类判据；Kyverno 没有「外部数据取不到时放行」的开关）。**还有一个比凭证更早的失败点：认证可能根本不会被尝试。** 当 registry 的 `www-authenticate` 响应把 realm 指向**私有或 link-local 地址**时，Kyverno 使用的镜像库会拒绝向它获取令牌，规则报 `invalid realm in www-authenticate: realm host "<private-ip>" is a private or link-local address` — 最容易通过以集群 registry 的 IP 形式（`<private-ip>:<port>/...`）引用镜像踩中，再正确的凭证也无济于事；改用集群内 DNS 名（如 `registry.kube-system.svc.cluster.local`）引用同一镜像就能正常读取。方向仍是 fail-closed（规则报错、请求被拒），所以**看到这个报错时去检查镜像是怎么被引用的，而不是查凭证**。
4. **它把外部网络放上了 admission 路径。** 一次 admission 判定现在要等一趟 registry 往返，延迟可能从普通 admission 的几百毫秒**推高到秒级**，且方差很大（registry 距离、镜像大小、缓存命中）；**冷启动的首次调用甚至可能直接撞上 webhook 超时**：`failed calling webhook "validate.kyverno.svc-fail": context deadline exceeded`，重试才通过。当 registry 变慢、被限流或不可达时，该规则匹配到的**每个**请求都会变慢或失败 — 在离线和大规模环境上线前先做压测，并把匹配收窄到真正需要它的 Task。数量级参考：同一个 `--dry-run=server` 探针对可达镜像约 **3 秒**返回放行，指向不可达地址时约 **5 秒**后返回拒绝（含 `kubectl` 往返）— **两个数字都远高于任何不读外部数据的 admission 判定**。把它们当作「这条规则该不该放在主路径上」的参考，但你环境的实际数字要自己测。

:::

:::details 完整策略 YAML：promotion-source-image-labels

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: promotion-source-image-labels
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: src-image-must-carry-build-label
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      preconditions:
        all:
          # Narrow to the copy Task and require a source ref to exist.
          # Read the name from BOTH shapes: an in-cluster taskRef puts it in
          # .name, while a resolver-backed one (hub/git/cluster) leaves .name
          # empty and carries the name in .params. Matching only .name would
          # silently skip every resolver-backed TaskRun -- a fail-open.
          # For production, tighten this to the full resolver coordinates
          # (resolver + catalog + name + version) as shown in §4.5.1.
          - key: "{{ request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || '' }}"
            operator: Equals
            value: skopeo-copy
          - key: "{{ (request.object.spec.params || `[]`)[?name=='srcImage'].value | [0] || '' }}"
            operator: NotEquals
            value: ""
      context:
        - name: srcRef
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='srcImage'].value | [0]"
        # Kyverno pulls the image config from the registry during admission.
        - name: imgdata
          imageRegistry:
            reference: "{{ srcRef }}"
        # A missing label must not fail open: default to MISSING so the comparison
        # below still denies. Compare inside JMESPath rather than with a Kyverno
        # NotEquals -- operator coercion would swallow a forged numeric-looking
        # label value such as "1" and let the image through (§6.1.7).
        - name: buildLabelBad
          variable:
            jmesPath: "(imgdata.configData.config.Labels.build || 'MISSING') != 'tekton'"
      validate:
        failureAction: Enforce
        message: "source image must carry label build=tekton (read from the image config via imageRegistry)."
        deny:
          conditions:
            all:
              - key: "{{ buildLabelBad }}"
                operator: Equals
                value: true
```

:::

**先弄清你手上的镜像实际携带哪些标签** — 本节的判据断言的是**具体值**，而本文档无法替你的环境准备一个带标签的镜像。所以顺序是「先读镜像，再写判据」，而不是反过来：

```bash
# Any image your own registry serves. Run this from a client that can reach it --
# it is the same read the policy performs at admission time, just done by hand.
# Fill the reference once; both commands read it.
IMAGE_REF='<image>:<tag>'
# macOS clients need --override-os linux --override-arch amd64 here: manifest lists
# carry no darwin entry, and skopeo picks by the CLIENT platform (hit live during validation).
skopeo inspect "docker://$IMAGE_REF" | jq '.Labels'
# crane instead of skopeo:
crane config "$IMAGE_REF" | jq '.config.Labels'
```

用真实读回的键/值写正例，再用**同一个键配上镜像没有的值**写反例。**如果输出是 `null` 或 `{}`，或者你想断言的键不存在，这个镜像就不适合作为本节的正例**：这条规则预期的对象是**你自己流水线构建的、携带元数据的产品镜像**（`build` 和 `org.opencontainers.image.source` 都是构建时注入的）；对没有这些标签的第三方基础镜像，它只会拒绝一切。要么换成自建镜像，要么把这条规则的匹配收窄到只覆盖自建产品。

过程中有两个容易误读的现象：**① 这些标签是否存在完全取决于你环境的基础镜像构建流水线** — 不存在「内部镜像默认携带它们」的普遍规律。写判据之前，用上面的 `skopeo inspect`（或等价手段）确认目标镜像**实际**携带哪些标签：「读回来是空的」也许就是你环境的常态 — 那说明镜像构建时没有注入这类元数据，不是命令写错了（本文档示例所用的 fixture 镜像恰好携带 `build=tekton` 和 `org.opencontainers.image.source` — 那是构建它的流水线的产物，不是普遍规律）。**② 有标签不等于有你要的那个键**：同一集群上的不同镜像可以携带不同的标签集合，`build` 和 `org.opencontainers.image.source` **可能只存在其一**（例如同一集群上的某个 Tekton 组件镜像可能只带 `org.opencontainers.image.source` 而没有 `build`）；标签集合也会随构建流水线演进而变化，所以绝不要把任何一族标签当成有保证的。写判据前逐个键确认目标镜像**实际**携带哪些标签（`crane config <image> | jq '.config.Labels'`）；不要因为「标签非空」就动笔写判据 — 键缺失时这条规则会拒绝该镜像，而这不是配置错误。

**上面两份完整 YAML 都只断言 `build` 这一个标签**（即 `buildLabelBad` 那一行）— 不要以为它们顺带也治理了 `org.opencontainers.image.source`。要切换到（或增加）另一个键，需要改的就是 context 中那一行、形状完全相同 — 带点号的键必须加引号才能下钻：

```yaml
        - name: sourceLabelBad
          variable:
            jmesPath: "(imgdata.configData.config.Labels.\"org.opencontainers.image.source\" || 'MISSING') != 'ops/baseimage'"
```

增加它还意味着把 `sourceLabelBad` 接进 `deny.conditions`（作为 `buildLabelBad` 的同级项；`any` 表示任一缺失即拒绝，`all` 表示两者都缺失才拒绝）；**只在 context 里加变量、不接进 conditions，对判据毫无改变** — 这正是「策略装上了但没生效」里最难发现的变体（[§6.1.2](#s6-1-2)）。而且接进去的同时**要一并修改 `validate.message`**：把判据接好后，用一个「有 `build` 但没有 source 标签」的镜像去打它 — 它被拒绝了，可消息仍然只写着 `must carry label build=tekton`，被拦的人就会跑去排查一个本来就合规的标签（[§4.0.6](#s4-0-6) 的最低标准）。两个判据都就位后，消息要这样写（把两个键都点名，让人知道该检查哪两个）：

```yaml
        message: >-
          source image must carry an approved value for BOTH labels build and
          org.opencontainers.image.source; read the labels in the image config to
          see what this image actually has.
```

注意这条消息**只点名键、从不点名批准值**：写「批准值是 X」等于把白名单递给每个被拒的人（[§4.0.6](#s4-0-6) 第三条规则）。具体值 `build=tekton` 出现在本文档正文里，是因为它是示例判据要求的值 — 这不代表它适合写进拒绝消息。

**验证要点**：用 `kubectl create --dry-run=server` 跑同一个 `skopeo-copy` TaskRun — 判据填上镜像真实的标签值（本文档示例 fixture 是 `build=tekton`）时放行；把要求改成镜像没有的 `build=production` 时被拒绝、策略消息透传出来。反例是必做的：它证明值确实是从镜像 config 里读出来的，而不是因为什么都读不到而默认放行。如果你按上一段增加了 source 标签判据，也要同样跑它的正反两格 — **新增的判据必须独立验证；不要指望 `build` 那一格替它担保**。
#### 4.5.3 运行镜像白名单（Pod 层硬拦截） {#s4-5-3}

- **它治理什么**：**流水线中实际运行的容器镜像必须来自已批准的 registry**。前面各节治理的都是「参数里写了什么」；本节治理「最终执行的是哪个镜像」— 唯一能对**实际运行的镜像**做出硬判定的拦截点。
- **它为什么难**：① TaskRun 层**看不到**引用式任务的 step 镜像（[§2.1](#s2-1) 观测点 4）；只有在 Pod 上才有解析后的真实值；② 镜像有**三条进入路径**，漏掉任何一条都会留下绕过面 — Pod CREATE、普通 Pod UPDATE（Kubernetes 允许修改 `containers` / `initContainers` 的镜像）、以及事后注入调试容器的 `pods/ephemeralcontainers` 子资源 UPDATE；③ 范围必须限定在 Tekton 创建的 Pod 上，否则 namespace 里的所有业务 Pod 都会被误伤 — 然而那个 `managed-by` 标签的值是**平台可配置的**，硬编码就会静默失配。
- **策略如何分层**：① 通过 Tekton 的 `managed-by` 标签把范围圈定在 Tekton Pod 上，标签值真正从 `config-defaults` 解析（区分键缺失与显式空值）→ ② 三条规则分别覆盖 CREATE / 普通 UPDATE / `ephemeralcontainers` 子资源，用 `foreach` 逐个断言每个镜像 → ③ 白名单除了业务 registry，还必须包含 **Tekton 基础设施镜像**的五类仓库（entrypoint / nop / shell / sidecar log results / workingdirinit），否则合规流水线自己都起不来 → ④ 顺手把身份标签锁定为**不可变** — 否则攻击者可以先删标签、再从子资源溜进来。
- **它治理不了什么**：它保证的是「镜像来自已批准的仓库」— **不保证镜像内容可信**。签名 / attestation 校验（verifyImages）同样作用在 Pod 层，但属于配套文档。另外，`<approved-registry-regex>` 这类占位符是**正则片段，不是主机名**；替换时必须逐字符转义元字符（见下面的设计要点 2）— 原样照抄会扩大匹配面。

**关键判据** — 正则**只声明一次**，`foreach` 逐容器引用它；一条表达式同时容纳「业务 registry」和「Tekton 基础设施镜像」两类：

```yaml
      context:
        # The only place either placeholder appears in this policy.
        - name: allowedImageRe
          variable:
            value: "^((<approved-registry-regex>)/.*|(<tekton-infra-image-regex>)(:|@).*)$"
      validate:
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
```

这两个占位符的含义完全不同：`<approved-registry-regex>` 匹配的是 **registry 前缀**（后面跟 `/.*`），而 `<tekton-infra-image-regex>` 匹配的是**完整仓库**（后面跟 `(:|@)`，即 tag 或 digest）。如何生成它们在下面两个小节里讲。

必须理解的六个设计要点：

- **范围圈定在 Tekton Pod，但绝不硬编码标签值。** 读取 `tekton-pipelines/config-defaults` 的完整 JSON，并**区分键缺失与显式空值**：只有 `default-managed-by-label-value` **缺失**时，Tekton 的默认值 `tekton-pipelines` 才适用；键存在但值为空**不会**走默认分支 — 控制器会写出空的标签值，这属于部署阻断项：必须先改成非空值，策略渲染绝不能自行回退。把解析出的确切非空值替换进策略里的每一处 `<tekton-managed-by-label-value>`，并在普通 Pod UPDATE 上锁定该标签不可删除、不可修改 — 否则自定义值会让每条规则静默失配，或者攻击者可以先摘掉标签再躲过 `ephemeralcontainers` 子资源。对该 ConfigMap 的变更必须受 RBAC 管控，并与策略重渲染**原子地**一起发布。
- **占位符是正则片段，不是裸主机名。** 替换时逐字符转义 RE2 元字符；对 registry / 仓库的合法形状，至少要应用 `.` → `[.]`、`[` → `[[]`、`]` → `[]]`，这样 `[2001:db8::1]:5000` 渲染为 `[[]2001:db8::1[]]:5000`。这种不含反斜杠的形式也避开了 YAML 双引号的转义问题；把含 `.` 或 IPv6 方括号的主机名直接塞进 `regex_match`，要么扩大匹配、要么弄坏表达式。
- **白名单必须包含 Tekton 基础设施镜像五类仓库的当前配置。** 取值方法在下一小节 — **两种读取要合并使用**；只用其中一种，怎么都会出错。⚠️ **上游控制器实际声明了六个镜像 flag** — 第六个是 `-shell-image-win`（script 模式在 **Windows 节点**上使用的 PowerShell 镜像；上游仍默认指向一个公共 MCR 镜像）。本节的五类划分和取值命令**刻意排除了它**：纯 Linux 集群从不实例化它，把它拉进白名单只会平白扩大白名单。**集群会运行 Windows TaskRun 的站点必须把它也加上**，否则那些 Pod 会被拒绝 — 而且那个拒绝是**响亮的**（`PodCreationFailed`，白名单形状，见 [§3.6](#s3-6)），不是静默放行。
- **消息必须点名违规镜像**，并且**每条规则内正则只允许声明一次**。前半句是为了用户（只看到 `PodCreationFailed`、一个 Pod 里十几个容器，你根本不知道该修哪个）；后半句是为了维护者。三条真实约束决定了当前形状：① **`element.*` 不能出现在 `validate.message` 里** — Kyverno 会在创建时拒绝该策略（`variable 'element.name' present outside of foreach at path /validate/message`），而 `foreach` 条目也没有 `deny.message` 字段 — 所以唯一的选择是在 `context` 里用同一个正则重新计算一个 `badImages` 列表；② 这次重新计算**不许复制正则** — 把正则放进一个 `variable`，在该规则内处处引用它。两条判镜像的规则携带不同的契约：CREATE / UPDATE 规则的 `allowedImageRe` 同时包含 `<approved-registry-regex>` 和 `<tekton-infra-image-regex>`；`ephemeralcontainers` 规则的 `approvedRegistryRe` 只包含 `<approved-registry-regex>`，刻意不放行基础设施仓库。所以批准 registry 占位符出现在两处、必须保持一致，基础设施仓库占位符恰好出现在一处（context 变量不跨规则共享）；③ 在 `jmesPath` 里引用该变量必须写成**带引号的 `'{{ allowedImageRe }}'`** — 写成裸标识符 `regex_match(allowedImageRe, image)` 的话，JMESPath 会把它当作**资源的一个字段**去查、得到 null，整条消息渲染成空字符串（判定仍然正确，但用户什么信息都得不到）。还有两个坑：`[a, b][] | [?...]` 里的 `|` 是必需的（**没有它过滤器会静默返回 `[]`**，消息变成 "offending images: []" — 比什么都不说更误导）；而且只挑出不合规的镜像 — **不要把整个白名单打印进消息**（那会把批准清单泄露给流水线用户，[§4.0.6](#s4-0-6)）。

:::warning 坏正则可能走向的两个方向（方向相反 — 要学会识别这两种）

现在每条判镜像的规则内正则只声明一次；但整个策略有两条判镜像的规则，所以 `<approved-registry-regex>` 仍出现在两处、必须保持一致。正则本身也仍可能写错（漏了转义、括号不配对）。两种失败模式的表现完全不同；排障前先分清你遇到的是哪一种：

- **`deny` 判据使用的正则无效**（比如括号不配对）→ **每个请求都被拒绝**，包括合规的 Pod。**fail-closed，而且响亮** — 切到 Enforce 后的第一条流水线就失败；你不可能错过它。
- **只有 `badImages`（消息侧）的计算是错的**（正则无效，或与判据不同步）→ **判定完全正确，但消息把合规镜像也列了出来**。对于「合规 sidecar + 违规主容器」的 Pod，两个镜像都会出现在消息里。**fail-safe 但安静** — 没有人会怀疑一个正确拦截违规镜像的策略，于是用户照着消息去修那个本来就合规的镜像。

所以替换完 `<approved-registry-regex>` 之后，**正反两个探针都要跑**：违规 Pod 必须被拒绝、**且消息里只有那一个镜像**，合规 Pod 必须被放行（[§4.5.3](#s4-5-3) 的 9 个自检探针中的探针 1 和 2）。

:::
- **断言的是请求里的原始字符串 `element.image`，不是 Kyverno 解析出的 `images.*`。** 两者不是一回事：不带 registry 的镜像（`nginx:1`）在 `element.image` 中**原样保留**，因此匹配不上任何 `<registry>/...` 前缀、会被**拒绝**（fail-closed — 正是你想要的方向）；而 Kyverno 放进 `images` context 的 `registry` 是它**归一化**后的值（`nginx:1` 会被补全为 `registry=docker.io`）。切换到 `images.*` 等于把判据的信任根从「请求说了什么」换成「Kyverno 怎么归一化」— 平白多出一层可配置行为。**继续断言原始字段。**
- **`foreach` 显式遍历三个容器列表**（`containers` / `initContainers` / `ephemeralContainers`），逐个断言镜像 — 比 `pattern` 更清晰，而且能在消息里点名违规镜像。普通 Pod UPDATE 可以修改 `containers` / `initContainers` 的镜像，所以第一条规则必须**同时匹配 CREATE 和 UPDATE**；而 `ephemeralContainers` 是在 Pod CREATE **之后**通过 `pods/ephemeralcontainers` 子资源 UPDATE 注入的，需要单独的 `v1/Pod/ephemeralcontainers` 规则。**顺带说明本策略里 `kinds` 的两种写法**：第一条规则写 `Pod`，后两条写 `v1/Pod` 和 `v1/Pod/ephemeralcontainers` — **两者的匹配面完全相同**：Pod 属于 core 组，该组只有 `v1` 这一个 group version，所以带不带前缀都只会命中这一种请求。这与 [§3.2](#s3-2)「API group-version 前置条件」中的 Tekton 资源不是一回事：在 `tekton.dev` 下 `v1` 和 `v1beta1` **并存**，所以那里 group-version 前缀是必需的 — 省略或写错会真正改变匹配面。

:::details 完整策略 YAML：pod-image-registry-allowlist（三条规则）

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pod-image-registry-allowlist
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: tekton-step-images-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - Pod
              operations:
                - CREATE
                - UPDATE
              namespaces:
                - policy-poc
              # scope to Tekton-created pods ONLY — do not touch ordinary workloads
              selector:
                matchLabels:
                  app.kubernetes.io/managed-by: "<tekton-managed-by-label-value>"
      context:
        # The regex lives here ONCE; every judgment below references this
        # variable, so there is no second copy of the placeholders to forget.
        - name: allowedImageRe
          variable:
            value: "^((<approved-registry-regex>)/.*|(<tekton-infra-image-regex>)(:|@).*)$"
        # Name the offending image in the message: `element.*` is NOT allowed in
        # validate.message (Kyverno rejects the policy), so recompute the failing
        # images here. Two shapes matter: the `|` before the filter is required --
        # without it the flatten silently yields [] -- and the variable must be
        # written as a quoted '{{ ... }}', because a bare identifier inside
        # jmesPath resolves against the RESOURCE, not the context.
        - name: badImages
          variable:
            jmesPath: >-
              [request.object.spec.containers,
              request.object.spec.initContainers || `[]`][]
              | [?!regex_match('{{ allowedImageRe }}', image)].image
      validate:
        failureAction: Enforce
        message: "pod image is not in the approved registry / tekton infra allowlist: {{ badImages }}"
        # foreach explicitly iterates each container list; each image must match an approved registry
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
          - list: "request.object.spec.initContainers || `[]`"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
    - name: tekton-managed-by-label-is-immutable
      match:
        any:
          - resources:
              kinds:
                - v1/Pod
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        - name: oldManagedByMatches
          variable:
            jmesPath: >-
              (request.oldObject.metadata.labels."app.kubernetes.io/managed-by" || '') ==
              '<tekton-managed-by-label-value>'
        - name: newManagedByMatches
          variable:
            jmesPath: >-
              (request.object.metadata.labels."app.kubernetes.io/managed-by" || '') ==
              '<tekton-managed-by-label-value>'
      preconditions:
        all:
          # Once Tekton marks a Pod, keep that identity marker for every later
          # subresource gate, including ephemeralcontainers.
          - key: "{{ oldManagedByMatches }}"
            operator: Equals
            value: true
      validate:
        failureAction: Enforce
        message: The Tekton managed-by label is immutable for the lifetime of the Pod.
        deny:
          conditions:
            any:
              - key: "{{ newManagedByMatches }}"
                operator: Equals
                value: false
    - name: tekton-ephemeral-images-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - v1/Pod/ephemeralcontainers
              operations:
                - UPDATE
              namespaces:
                - policy-poc
              # Ephemeral containers are injected after Pod CREATE through a
              # dedicated subresource, so they need a separate admission rule.
              selector:
                matchLabels:
                  app.kubernetes.io/managed-by: "<tekton-managed-by-label-value>"
      context:
        # Same one-copy rule as the first rule: the prefix regex is declared once
        # (this rule allows no infra repositories -- debug containers have no
        # business coming from there).
        - name: approvedRegistryRe
          variable:
            value: "^(<approved-registry-regex>)/.*$"
        - name: badImages
          variable:
            jmesPath: >-
              (request.object.spec.ephemeralContainers || `[]`)
              [?!regex_match('{{ approvedRegistryRe }}', image)].image
      validate:
        failureAction: Enforce
        message: "Tekton Pod ephemeral containers must use an approved registry: {{ badImages }}"
        foreach:
          - list: "request.object.spec.ephemeralContainers || `[]`"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(approvedRegistryRe, element.image) }}"
                    operator: Equals
                    value: false
```

:::
##### 如何生成 `<tekton-infra-image-regex>`（完整实操示例）

上一节只说了“白名单必须包含五类基础设施镜像”；这里给出完整、可照做的操作步骤。**关键认知：admission 看到的镜像地址是经过平台镜像改写*之后*的形态**——控制器启动参数（命令 A）给出的是**改写前**的地址但清单完整；抽样真实 Pod（命令 B）给出的是改写后的形态但清单**必然不完整**（只能看到恰好运行过的类别）。因此白名单的正确来源是：**A 取清单 → A2 把地址前缀替换为平台私有 registry 地址 → B 只做交叉校验**：

```bash
# A. The five infrastructure image classes declared in the controller start-up args
#    (the complete candidate set)
# Derive it here, UNCONDITIONALLY: reusing whatever $TEKTON_NS the shell happens to
# hold would read another cluster's namespace, and an allowlist built from the wrong
# controller misses every real infrastructure image. Three outcomes again -- a failed
# query is not "the field is empty", so it must stop you rather than fall back.
# Clear it first: `infra` is only assigned inside the success path below, so in a REUSED
# interactive shell a failed A would leave the PREVIOUS run's value in place -- and A2's
# emptiness guard would happily build an allowlist from another controller's images.
unset infra
if ! ns=$(kubectl get tektonconfig config -o jsonpath='{.spec.targetNamespace}' 2>&1); then
  echo "cannot read TektonConfig ($ns) -- fix this before building the allowlist"
else
  TEKTON_NS=${ns:-tekton-pipelines}   # empty field = Tekton's own default
  echo "reading controller args from: $TEKTON_NS"
  # Capture before piping: a failed read piped into jq produces NO images and no error
  # of its own, which looks exactly like "this controller declares none" -- and an
  # allowlist built from that rejects every Tekton Pod.
  if ! controller=$(kubectl -n "$TEKTON_NS" get deploy tekton-pipelines-controller -o json 2>&1); then
    echo "cannot read the controller Deployment ($controller) -- stop here"
  else
    # The controller declares SIX image flags upstream, not five: the sixth is
    # -shell-image-win (the PowerShell image used only by script mode on Windows
    # nodes). The pattern below ends in -image$, so -shell-image-win is excluded
    # ON PURPOSE -- a Linux-only cluster never instantiates it, and pulling it into
    # the allowlist would widen the allowlist for nothing. If this cluster runs
    # Windows TaskRuns, drop the trailing $ (or add shell-image-win explicitly) and
    # allow that repository too, otherwise those Pods are rejected. That rejection
    # is loud (PodCreationFailed), not silent -- allowlist shape, see §3.6.
    infra=$(printf '%s' "$controller" \
      | jq -r '.spec.template.spec.containers[0].args as $a
               | range(0; $a|length) as $i
               | select($a[$i] | test("^-(entrypoint|nop|shell|sidecarlogresults|workingdirinit)-image$"))
               | $a[$i+1]')
    # Read succeeded but matched nothing: a different container order, renamed flags or
    # a new packaging all produce an EMPTY list here, which reads as "this controller
    # declares no infrastructure images". Say so instead of returning silence.
    if [ -z "$infra" ]; then
      echo "no infrastructure image flags matched -- inspect the args by hand:"
      printf '%s' "$controller" | jq -r '.spec.template.spec.containers[].args'
    else
      printf '%s\n' "$infra"
      echo "matched $(printf '%s\n' "$infra" | wc -l) of the 5 flag classes"
    fi
  fi
fi

# A2. Rewrite A's entries into the form admission ACTUALLY sees: swap the registry
#     host for the platform's private registry address, keep the repository path.
#     The platform records that address in the global-info ConfigMap (kube-public,
#     field registryAddress). Same three-outcome discipline: a failed read must stop
#     you -- allowlisting the PRE-rewrite addresses rejects every Tekton Pod.
#     A2 also refuses when A produced nothing: A's failure branches only PRINT, and this is
#     a separate `if`, so without this guard a failed A leaves $infra unset and the pipe below
#     emits an empty allowlist -- indistinguishable from "this controller declares no
#     infrastructure images", which is exactly the reading that gets every Tekton Pod rejected.
if [ -z "${infra:-}" ]; then
  echo "command A produced no infrastructure images -- fix A first; do NOT build the allowlist"
elif ! REG=$(kubectl get cm -n kube-public global-info -o jsonpath='{.data.registryAddress}' 2>&1); then
  echo "cannot read global-info ($REG) -- stop here, do NOT allowlist pre-rewrite addresses"
elif [ -z "$REG" ]; then
  echo "global-info carries no registryAddress -- find your platform's private registry address first"
else
  printf '%s\n' "$infra" | sed "s#^[^/]*/#${REG}/#" | sort -u
fi

# B. CROSS-CHECK ONLY -- sample the images admission actually saw on real Tekton
#    Pods. Every repository listed here must appear in A2's output; anything extra
#    means the prefix-rewrite rule is wrong or a sixth image class exists, so stop
#    and investigate. B is NOT a source for the allowlist: a sample only contains
#    the classes that happened to run (nop only appears when a step was skipped).
# The label value is install-specific -- read it off any Tekton-created Pod and fill
# it in here, on its own line, instead of digging it out of the query below.
TEKTON_MANAGED_BY='<tekton-managed-by-label-value>'
# Same reason as elsewhere: quoted-but-unreplaced selects zero Pods, and B's own
# "no Tekton Pods sampled" branch would then read as "nothing is running" instead of
# "you did not fill this in".
case "$TEKTON_MANAGED_BY" in '<'*'>') echo "fill in TEKTON_MANAGED_BY first"; TEKTON_MANAGED_BY='';; esac
# Capture first, same reason as command A: a failed query piped into jq yields an
# empty list and no error, which reads as "no Tekton Pods use any image".
if ! pods=$(kubectl get pods -A -l app.kubernetes.io/managed-by="$TEKTON_MANAGED_BY" -o json 2>&1); then
  echo "cannot list Tekton Pods ($pods) -- stop here"
elif [ "$(printf '%s' "$pods" | jq -r '.items | length')" = 0 ]; then
  # An empty sample is not an empty answer: it just means no Tekton Pod is running
  # right now. The allowlist still comes from A2; an empty B only means the
  # cross-check has nothing to compare against -- it blocks nothing.
  echo "no Tekton Pods sampled -- cross-check unavailable (allowlist still comes from A2)"
else
  printf '%s' "$pods" \
    | jq -r '.items[].spec | ((.initContainers // []) + .containers) | .[].image' | sort -u
fi
```

:::warning A 与 B 的输出很可能不一致——而这正是本节最容易踩的坑

- **照抄 A（跳过前缀改写）**：ACP 的镜像改写会更换 registry 主机。控制器参数里可能写的是 `registry.example.com/pipelines/...`，而 admission 实际看到的是 `192.0.2.10:11443/pipelines/...`。直接用启动参数生成正则 → **所有 Tekton Pod 当场被拒**，合规流水线也无法启动——这就是 A2 必不可少的原因。
- **把 B 当作清单**：任何一次抽样只能看到这批运行恰好实例化的类别。五类基础设施镜像并非每次运行都会全部用到——一次抽样很容易只包含其中两三类（`nop` 只在某个 step 被跳过时才注入，平时根本不出现）；**如果从未运行过任何 TaskRun Pod，抽样干脆就是空的**（代码块里的防护判断已直接说明这一点）。只凭 Pod 构建取值，等到某个未被抽到的类别真正被用到的那天，它就会被错误拦截。B 只有一个正确用途：**校验 A2 的改写结果**——出现在 B 但不在 A2 输出里的仓库，意味着改写规则有误、或存在第六类镜像；先查清楚再继续。

正确的操作步骤：**以 A 的清单经 A2 前缀改写后作为生成来源**，再由两条交叉校验路径兜底——B（抽样真实 Pod）和已安装状态对象（operator 的 `TektonConfig` / `TektonPipeline` CR，以及 `tekton-pipelines` namespace 下 Deployment 的镜像，与 [§4.0.3](#s4-0-3) 占位符表的读取口径相同）；任一路径发现 A 之外的仓库，先查清是否为新类别，再决定是否扩充清单。去掉 tag / digest、只保留仓库路径，然后逐字符转义。

:::

```bash
# C. Strip tag/digest, escape RE2 metacharacters, join into one alternation.
#    Escape . [ ] in a SINGLE pass: replacing one of them introduces new brackets, so
#    multiple sed passes corrupt each other -- the python below guarantees one pass.
python3 - <<'EOF'
import re
# paste A2's de-duplicated repository list (NO tag, NO digest) here
repos = [
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-entrypoint",
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-nop",
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-shell-image",
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-sidecarlogresults",
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-workingdirinit",
]
esc = lambda s: re.sub(r'[.\[\]]', lambda m: {'.': '[.]', '[': '[[]', ']': '[]]'}[m.group()], s)
print("|".join(esc(r) for r in repos))
EOF
```

生成结果（对应本示例）——把它替换到策略中的 `<tekton-infra-image-regex>`（**只有一处**：仅在 CREATE / UPDATE 规则的 `allowedImageRe` 里；`ephemeralcontainers` 规则刻意只放行业务侧的 `<approved-registry-regex>`，不把 Tekton 基础设施仓库当作临时调试容器的来源）：

```text
192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-entrypoint|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-nop|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-shell-image|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-sidecarlogresults|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-workingdirinit
```

当五个类别共享同一主机和路径时，可以手工压缩为等价形式（两种写法行为完全一致）：

```text
192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)
```

与业务 registry（示例：`registry[.]example[.]com|192[.]0[.]2[.]20:60070`）组合后，策略中的完整表达式渲染为：

```text
^((registry[.]example[.]com|192[.]0[.]2[.]20:60070)/.*|(192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit))(:|@).*)$
```

**替换后的自检**——用 `kubectl create --dry-run=server` 打到真实的 Kyverno 上，正例、反例各一组：

:::details 自检探针（共 9 条，含三条证明转义生效的近邻用例）

| 探针镜像 | 预期 |
|---|---|
| `…:11443/pipelines/tektoncd-pipeline-entrypoint:v1.12.0` | 放行 |
| `…:11443/pipelines/tektoncd-pipeline-sidecarlogresults@sha256:0000…` | 放行（digest 形式） |
| `…:11443/pipelines/tektoncd-pipeline-nop:v1.12.0` | 放行（通常不会出现在 B 的抽样里——`nop` 只在某个 step 被跳过时才注入；清单完整性由命令 A + A2 保证） |
| `192.0.2.**100**:11443/…/tektoncd-pipeline-entrypoint:v1.12.0` | 拒绝（近邻主机） |
| `192.0.2.10:**11444**/…/tektoncd-pipeline-entrypoint:v1.12.0` | 拒绝（近邻端口） |
| `…:11443/pipelines/tektoncd-pipeline-**evil**:v1.12.0` | 拒绝（同主机但不属于五类之一） |
| `192**X**0.2.10:11443/…/tektoncd-pipeline-entrypoint:v1.12.0` | 拒绝（**证明 `.` 已被转义**：若未转义，该主机会经由通配匹配命中） |
| `…/tektoncd-pipeline-entrypoint`（无 tag、无 digest） | 拒绝（表达式要求结尾带 `(:\|@)` 段） |
| `docker.io/library/busybox:latest` | 拒绝 |

:::

:::warning 别漏掉第六类：Windows 节点

除上述五个参数外，控制器还有 `-shell-image-win`，默认指向一个 Windows 基础镜像。如果集群中有运行 Tekton 的 Windows 节点，**它也必须加入白名单**，否则 Windows 上的 step 会被拒绝。纯 Linux 集群可以不加，但升级后建议重跑命令 A（及 A2 的前缀改写），重新确认参数集合是否发生了变化。

:::

##### 让同一份策略跨环境生效（策略里不硬编码任何前缀）

上面的示例把前缀直接渲染进了 YAML；问题在于**每个环境的 registry 主机和仓库路径都不同**，策略正文因此要按环境分叉。更好的做法是：**策略里完全不写前缀，把环境差异集中到一个 ConfigMap 里**——同一份 ClusterPolicy 原样下发到每个环境，各环境只需填这一处配置（取值仍按上面的方法生成：A 取清单 → A2 前缀改写，B 交叉校验）。

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pipeline-image-allowlist
  namespace: policy-poc
data:
  # Business registries allowed to provide step images (escaped RE2 alternation).
  approvedRegistryRegex: "<approved-registry-regex>"
  # Tekton infrastructure image repositories, WITHOUT tag or digest.
  # Generated from controller args after the platform registry-prefix rewrite;
  # real Tekton Pods and installed controller manifests are cross-checks, not union sources.
  tektonInfraRepoRegex: "<tekton-infra-image-regex>"
```

将其保存为 `pipeline-image-allowlist.yaml`。**这个 ConfigMap 必须先于策略存在**——ConfigMap 缺失时策略按失败关闭处理，也就是说安装顺序颠倒时，作用域内的所有 Tekton Pod 都会被拒绝。看起来像“白名单写错了”，实际上只是配置还没就位：

```bash
# The ConfigMap lands in a walkthrough-owned namespace (§4.0.4): the namespace
# cascade takes it at cleanup, so a plain apply is fine here.
kubectl apply -f pipeline-image-allowlist.yaml
# Verify BOTH keys are non-empty before installing the policy below.
kubectl get cm -n policy-poc pipeline-image-allowlist \
  -o jsonpath='{.data.approvedRegistryRegex}|{.data.tektonInfraRepoRegex}{"\n"}'
# Empty on either side means the placeholder was not substituted -- go back to
# commands A and B above. With an empty value the composed expression cannot match
# any normal image reference, so every Pod in scope gets denied.
```

策略侧用 `context.configMap` 引入它，并在 `regex_match` 里展开变量。**关键判据**就是这两行——正则不再是字面量，而是从 ConfigMap 变量展开：

```yaml
      context:
        # Environment-specific values live here, not in the policy body.
        - name: allowlist
          configMap:
            name: pipeline-image-allowlist
            namespace: policy-poc
        # Assembled once from the ConfigMap; the judgments below reference it.
        - name: allowedImageRe
          variable:
            value: "^(({{ allowlist.data.approvedRegistryRegex }})/.*|({{ allowlist.data.tektonInfraRepoRegex }})(:|@).*)$"
      validate:
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
```

:::warning 切换到这种形式时，三条规则必须一起切换

该策略与上面那份**同名**（`pod-image-registry-allowlist`），因此安装它是**整体替换**而非追加。三条规则也就必须一并带上：只保留第一条（容器镜像白名单）而丢掉 `tekton-managed-by-label-is-immutable` 和 `tekton-ephemeral-images-from-approved-registries`，等于亲手打开两条绕过路径——攻击者删掉作用域标签让规则失配，或直接通过 `pods/ephemeralcontainers` 子资源注入未获批镜像。下面是完整的三规则版本。

:::

:::details 完整策略 YAML：pod-image-registry-allowlist 的 ConfigMap 形式（三条规则）

与上面字面量版本的唯一差异：每条用到正则的规则都各自携带 `context.configMap`，正则从 `{{ allowlist.data.* }}` 展开。`<tekton-managed-by-label-value>` 仍留在策略正文中（本节末尾有解释）。

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pod-image-registry-allowlist
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: tekton-step-images-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - Pod
              operations:
                - CREATE
                - UPDATE
              namespaces:
                - policy-poc
              selector:
                matchLabels:
                  app.kubernetes.io/managed-by: "<tekton-managed-by-label-value>"
      context:
        # Environment-specific values live here, not in the policy body.
        - name: allowlist
          configMap:
            name: pipeline-image-allowlist
            namespace: policy-poc
        # Name the offending image in the message. The SAME regex as the deny
        # conditions below -- keep the two in sync. `[a, b][] | [?...]` needs the
        # pipe: without it the filter silently yields [] and the message lies.
        # Assembled once from the ConfigMap, then referenced everywhere below.
        - name: allowedImageRe
          variable:
            value: "^(({{ allowlist.data.approvedRegistryRegex }})/.*|({{ allowlist.data.tektonInfraRepoRegex }})(:|@).*)$"
        - name: badImages
          variable:
            jmesPath: >-
              [request.object.spec.containers,
              request.object.spec.initContainers || `[]`][]
              | [?!regex_match('{{ allowedImageRe }}', image)].image
      validate:
        failureAction: Enforce
        message: "pod image is not in the approved registry / tekton infra allowlist: {{ badImages }}"
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
          - list: "request.object.spec.initContainers || `[]`"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
    # Unchanged from the literal-prefix variant: this rule uses no registry regex,
    # so it needs no ConfigMap context.
    - name: tekton-managed-by-label-is-immutable
      match:
        any:
          - resources:
              kinds:
                - v1/Pod
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        - name: oldManagedByMatches
          variable:
            jmesPath: >-
              (request.oldObject.metadata.labels."app.kubernetes.io/managed-by" || '') ==
              '<tekton-managed-by-label-value>'
        - name: newManagedByMatches
          variable:
            jmesPath: >-
              (request.object.metadata.labels."app.kubernetes.io/managed-by" || '') ==
              '<tekton-managed-by-label-value>'
      preconditions:
        all:
          # Once Tekton marks a Pod, keep that identity marker for every later
          # subresource gate, including ephemeralcontainers.
          - key: "{{ oldManagedByMatches }}"
            operator: Equals
            value: true
      validate:
        failureAction: Enforce
        message: The Tekton managed-by label is immutable for the lifetime of the Pod.
        deny:
          conditions:
            any:
              - key: "{{ newManagedByMatches }}"
                operator: Equals
                value: false
    - name: tekton-ephemeral-images-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - v1/Pod/ephemeralcontainers
              operations:
                - UPDATE
              namespaces:
                - policy-poc
              # Ephemeral containers are injected after Pod CREATE through a
              # dedicated subresource, so they need a separate admission rule.
              selector:
                matchLabels:
                  app.kubernetes.io/managed-by: "<tekton-managed-by-label-value>"
      context:
        # Same ConfigMap, declared again: context is per-rule, not policy-wide.
        - name: allowlist
          configMap:
            name: pipeline-image-allowlist
            namespace: policy-poc
        - name: approvedRegistryRe
          variable:
            value: "^({{ allowlist.data.approvedRegistryRegex }})/.*$"
        - name: badImages
          variable:
            jmesPath: >-
              (request.object.spec.ephemeralContainers || `[]`)
              [?!regex_match('{{ approvedRegistryRe }}', image)].image
      validate:
        failureAction: Enforce
        message: "Tekton Pod ephemeral containers must use an approved registry: {{ badImages }}"
        foreach:
          - list: "request.object.spec.ephemeralContainers || `[]`"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(approvedRegistryRe, element.image) }}"
                    operator: Equals
                    value: false
```

:::

注意 `<tekton-managed-by-label-value>` **仍留在策略正文中**：这种形式收拢的是环境相关的 registry 前缀；作用域标签值属于另一类配置（取值方法见 [§4.0.3](#s4-0-3) 的占位符表），如果它也需要集中管理，可以挪进同一个 ConfigMap。

有三个值得了解的实际行为：

- **变量在 `regex_match` 里能正确展开**：合规的基础设施镜像（tag 形式与 digest 形式）被放行；同主机但不在五类之内的 `…/tektoncd-pipeline-evil`，以及 `docker.io/library/busybox`，都被拒绝；伪造的 `evil.example/anything/tektoncd-pipeline-entrypoint:v1` 同样被拒绝——主机锚定依然生效。
- **换环境只改 ConfigMap**：把 `tektonInfraRepoRegex` 从一个环境的前缀 patch 成另一个环境的即可生效（Kyverno 的 ConfigMap context 有短暂缓存——改完稍等片刻再验证）；策略 YAML 一个字符都不用改：新前缀被放行，旧前缀立即被拒绝。
- **ConfigMap 缺失是失败关闭而非失败放行**：删掉 ConfigMap 后，原本合规的 Pod 也会被拒绝，错误信息明确写着 `failed to retrieve config map for context entry allowlist`。安全方向是对的，但**要注意可用性**：部署顺序必须让 ConfigMap 先于策略，且 ConfigMap 必须纳入 GitOps 与 RBAC 保护——**能改它的人 == 能改镜像白名单的人**；权限门槛等同于改策略本身。

##### 不想维护主机时的两种放宽形式（附强度对比）

有些环境不愿为每个集群维护 registry 主机（镜像改写会更换主机，见上文），希望策略文本完全不携带环境信息。这种情况下，**不要直接退回“任意前缀”**——存在一个明显更安全的中间档：**主机放开，但只允许一段，项目路径和镜像名全部钉死**。

```text
# Form B (the recommended relaxation): host contains no '/', project path and image names are pinned
^[^/]+/<project-path>/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)(:|@).*$

# Form C (widest, not recommended as a default): the prefix is unconstrained
^(.*/)?tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)(:|@).*$
```

关键差异在 `[^/]+` 与 `.*`：前者只允许**一段**主机（形如 `registry.example.com:5000`），把“偷偷多塞一级路径”的空间整个封死；后者容忍任意深度。三种形式的强度对比如下（形式 A 即上面的 ConfigMap 形式）：

| 探针镜像 | A 钉死主机 | B `[^/]+` + 固定路径 | C 任意前缀 |
|---|:---:|:---:|:---:|
| `192.0.2.10:11443/pipelines/tektoncd-pipeline-entrypoint:v1.12.0` | ✅ 放行 | ✅ 放行 | ✅ 放行 |
| `harbor.example.net:5000/pipelines/tektoncd-pipeline-nop@sha256:…`（**另一环境的主机**） | ❌ 拒绝（需要改 ConfigMap） | ✅ 放行（这正是放宽的意义所在） | ✅ 放行 |
| `evil.example/**anything**/tektoncd-pipeline-entrypoint:v1` | ❌ 拒绝 | ❌ **拒绝** | ⚠️ **放行** |
| `192.0.2.10:11443/pipelines/**sub**/tektoncd-pipeline-entrypoint:v1`（多插了一级） | ❌ 拒绝 | ❌ **拒绝** | ⚠️ **放行** |
| `…/pipelines/tektoncd-pipeline-**evil**:v1` | ❌ 拒绝 | ❌ 拒绝 | ❌ 拒绝 |
| `docker.io/library/busybox:latest` | ❌ 拒绝 | ❌ 拒绝 | ❌ 拒绝 |
| `**evil.example**/pipelines/tektoncd-pipeline-entrypoint:v1` | ❌ 拒绝 | ⚠️ **放行** | ⚠️ 放行 |

:::warning 形式 B 封不住的那一格（对比表最后一行）

攻击者只要把镜像推成 `<their own host>/<project-path>/tektoncd-pipeline-entrypoint`，形式 B 仍会放行——**镜像名是调用方可控的字符串，不是身份**。

形式 B 的价值在于把绕过成本从“随便起名”提高到“必须一字不差复刻项目路径和镜像名、且一级目录都不能多”，同时**完全不含环境信息、可跨集群直接复用**；它挡不住蓄意绕过的人。要真正封死这一格，只能回到形式 A（钉死主机，并借上面的 ConfigMap 方案保持通用）。

**不要把形式 C 当默认**：它连“多一级路径”的情况都放行；实践中它只能挡住“随手写了个 `docker.io/library/busybox`”这类无意越界。

:::

:::details 完整验证清单（端到端 + 子资源 + 作用域无误伤）

- 使用违规镜像（`docker.io/library/busybox`）的 Tekton TaskRun → Pod 被拒绝，**TaskRun 终态为 `PodCreationFailed`**（消息中携带完整策略文本；Pod 从未被创建）；
- 同一 namespace 下的**普通非 Tekton Pod**（同样使用 `docker.io` 镜像）**照常创建、无误伤**——作用域生效；
- 带 Tekton 标签、伪造 `evil.example/<project-path>/tektoncd-pipeline-entrypoint:fake` 的 Pod 被拒绝，证明不会仅凭仓库路径就信任任意主机；
- 策略生效期间，使用合规镜像的完整流水线端到端跑到 `Succeeded`；
- 另建一个带 Tekton 标签的存量 Pod：删除该标签的 patch 被拒绝；随后用 `docker.io/library/busybox` 的 `pods/ephemeralcontainers` patch 被拒绝，而使用获批 registry 镜像的 patch 成功，且获批的临时容器在存量 Pod 中可见；使用获批主镜像的普通 Pod UPDATE 被放行，而未获批主镜像与未获批 init 镜像都被拒绝；
- 在合法 managed-by 字符串 `"false"` 下，试图把标签改成数字形字符串 `"1"` 的普通 UPDATE 被拒绝；之后未获批的临时镜像仍被拒绝——证明身份标签无法先经类型强转绕过、再逃出子资源选择器；
- 用带方括号 IPv6 registry 上的 workingdirinit 仓库做 server dry-run：完全一致的主机被放行，仅差一个字符的近邻主机被拒绝。

**参数化边界**：`"1"`、`"false"`、`"null"` 都是合法的非空 Kubernetes 标签字符串。策略与探针中的 `<tekton-managed-by-label-value>` 必须放在 YAML 引号内，否则会被解析成整数、布尔值或 null。标签不可变检查同样必须先在 JMESPath 里算出精确字符串相等的布尔值，再交给 Kyverno 做布尔比较——绝不能用 `NotEquals` 直接比较数字形字符串。

:::

镜像**签名 / 证明**验证（verifyImages）同样作用在 Pod 层——参见配套文档 *Software Supply Chain Security of ACP with Tekton and Kyverno*。
#### 4.5.4 封死裸建 Tekton Run 的入口（契约 7） {#s4-5-4}

- **它管什么**：**堵住“直接裸建 TaskRun / CustomRun 绕过流水线”这个缺口**。此前所有闸门都挂在流水线路径上；如果有人能自己裸建一个 TaskRun 去跑构建、推镜像或部署，这些闸门就被一次性全部绕过。
- **难在哪里**：如何区分“控制器创建的合法子 Run”与“用户手工裸建的 Run”？最直观的答案是看 `ownerReferences`——合法子 Run 从创建那一刻起就带着 `controller: true` 的 PipelineRun owner ref。**但这个字段是由创建对象的人写入的**：攻击者裸建 TaskRun 时可以伪造一个指向真实 PipelineRun 的 owner ref（uid 在其自己的 namespace 里可读），而 Kubernetes 默认不校验其真实性——信任它等于失败放行。
- **策略如何分层**：① 硬保证锚定在 **`request.userInfo`** 上——由 API server 根据已认证请求填入、客户端无法伪造；“创建者 == Tekton 控制器 SA”是不可伪造的来源证明；② `ownerReferences` 则用作**纵深防御的附加 AND 条件**——**只加在控制器 SA 路径上**（合法路径本来就带着它、零成本；即使伪造成功也仍会被 userInfo 检查拦下）；③ 平台管理员身份是一个**独立的 OR 分支**，**不要求 owner ref**——它是这个入口的 break-glass 条款：谁在名单上，谁就能绕过本节的封闭。
- **它管不了什么**：它封死的**只是裸建 Tekton Run 这条路径**——并不意味着“流水线之外不可能运行任何工作负载”：拥有相应 API 权限的人仍可直接创建 Pod / Job / Deployment，或把部署凭证用到别处。**“流水线无法被绕过”是 RBAC 加本策略共同作用的结果**：RBAC 收窄业务身份对工作负载 API 和部署凭证的直接权限；本策略只补上裸 Run 这一块。

**关键判据**——在 **Tekton 控制器路径**上，userInfo 是锚点、owner ref 是附加 AND；**平台管理员身份是不要求 owner ref 的独立 OR 分支**（break-glass 条款：在这份名单上的人，恰恰就是能绕过该入口封闭的人）（**片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的 details 块中）：

```yaml
      # EXCERPT -- key conditions only, NOT a standalone manifest; the
      # indentation is kept from the full policy, so this block alone does
      # not parse. Apply the complete YAML from the details block below.
        - name: allowed
          variable:
            jmesPath: "(creator=='system:serviceaccount:tekton-pipelines:tekton-pipelines-controller' && hasControllerOwner) || contains(['<platform-admin-identity>'], creator)"
      validate:
        deny:
          conditions:
            all:
              - key: "{{ allowed }}"
                operator: Equals
                value: false
```

:::warning ownerReference 是纵深防御，不是身份边界

不要把“伪造的 owner 会被垃圾回收清理”当成一道防线；它有两个缺口：

- **GC 是异步的。** TaskRun 一旦通过 admission，其 Pod 几乎立刻被调度并运行；等 GC 删除它时，那次未过闸的构建 / 发布可能早已完成——绕过已经发生。
- **owner 可以指向真实对象。** 只要伪造的 uid 指向一个确实存在的 PipelineRun，GC 根本不会触发。

所以**身份的硬保证在 `request.userInfo`**；`ownerReference` 只是叠在其上的一层。

:::

:::details 完整策略 YAML：pipeline-entry-lockdown

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-entry-lockdown
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: only-controller-creates-runs
      match:
        any:
          - resources:
              # CustomRun is v1beta1 on purpose: Tekton defines and registers that
              # type only in v1beta1, so tekton.dev/v1/CustomRun matches nothing --
              # "aligning" it with the TaskRun line above silently disables the rule.
              kinds:
                - tekton.dev/v1/TaskRun
                - tekton.dev/v1beta1/CustomRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: creator
          variable:
            jmesPath: "request.userInfo.username || ''"
            default: ""
        # defense-in-depth: does this Run carry a real controller PipelineRun
        # owner? the reconciler sets it via SetControllerReference on every child
        - name: hasControllerOwner
          variable:
            jmesPath: "length((request.object.metadata.ownerReferences || `[]`)[?controller==`true` && kind=='PipelineRun']) > `0`"
        # allowed iff: controller SA AND owned by a controller PipelineRun (the
        # governed path), OR an explicit break-glass admin identity. userInfo is
        # the unforgeable anchor. The owner ref is an added AND condition ON THE
        # CONTROLLER BRANCH ONLY -- the admin branch is a bare identity check, so
        # anyone on that list can create a bare TaskRun with no owner reference.
        - name: allowed
          variable:
            jmesPath: "(creator=='system:serviceaccount:tekton-pipelines:tekton-pipelines-controller' && hasControllerOwner) || contains(['<platform-admin-identity>'], creator)"
      validate:
        failureAction: Enforce
        message: >-
          TaskRun/CustomRun may only be created by the Tekton controller as part
          of a governed PipelineRun (controller SA AND a controller PipelineRun
          ownerReference), or by a break-glass platform admin identity — bare or
          orphan runs bypass the pipeline gates.
        deny:
          conditions:
            all:
              - key: "{{ allowed }}"
                operator: Equals
                value: false
```

:::

:::details 验证清单（探针 + 端到端）

| 场景 | 预期 |
|---|---|
| 非控制器身份裸建的 TaskRun | 拒绝 |
| 裸建的 CustomRun | 拒绝 |
| **伪造了 `ownerReferences`，但 userInfo 不是控制器** | **仍被拒绝**（owner ref 弥补不了 userInfo） |
| 控制器身份 + 指向控制器 PipelineRun 的 owner | 放行 |
| 控制器身份但**没有** owner ref（异常 / 伪装） | 拒绝 |
| 专用的 break-glass ServiceAccount（先在 RBAC 中授予最小的 TaskRun create 权限） | 被本策略显式放行 |
| 一次正常的 PipelineRun 端到端 | `Succeeded`；控制器创建的真实子 TaskRun 不受影响 |

break-glass 是**双层授权**：Kubernetes RBAC 与 Kyverno 白名单二者缺一不可。

:::

本策略与 RBAC 互补：RBAC 决定“谁有 API 权限——能否直接创建 Pod / Job / Deployment”；在确有权限的身份中，本策略进一步堵上裸建 Tekton Run 的缺口。生产环境中，白名单还应包含合法的平台自动化身份（triggers / GitOps 控制器等）——并注意**你加入白名单的每一个身份，都是你为其打开裸 Run 入口的身份**，所以要连同该身份自身的 RBAC 一起评估。

#### 4.5.5 发布目标白名单（真实画像：java / python `-image-build-scan-deploy` 0.3） {#s4-5-5}

- **它管什么**：**发布的目标参数和凭证来源只能是获批的那些**——约束两个官方 0.3 模板中部署阶段的目标参数（namespace / 工作负载 / 镜像等）与 `kubeconfig` 的来源。两个模板的 `deploy-or-upgrade` 都是同一个 hub `kubectl` 0.1、参数面相同，因此**一条规则必须同时钉住两个模板身份**；只钉一个，经另一个模板的发布就完全不受管。
- **难在哪里**：① **判断点必须放在 PipelineRun CREATE——不能下推到 TaskRun 层**：模板里的 `deploy-or-upgrade` 只是节点别名；解析后真正的 Task 是 hub 的 `catalog/kubectl/0.1`，其 TaskRun 只收到 `args` 和**已渲染完成的 `script`**——根本没有 `workloadNamespace` 参数可读；② 该版本把目标参数**以纯文本替换、不加引号地拼进 shell `script`**，所以“只检查 namespace 在白名单上”会留下**命令注入**的口子；③ 只看 `kubeconfig` workspace 的 `.secret.secretName` 可被绕过——用 PVC / CSI / configMap 绑定时该字段为空，幼稚的策略会直接放行，攻击者就能塞入任意 kubeconfig。
- **策略如何分层**：① hub 来源身份**无论是否启用部署**都要校验；② 镜像照抄模板的 `when`——`workloadName` 为空或单个空格表示未启用部署，此时跳过目标检查；③ 启用部署时，`workloadNamespace` 必须**显式**命中白名单——**缺省同样拒绝**。这是刻意为之：模板对缺省的语义是“使用该 run 所在的 namespace”，等于把“这次发布去哪”隐式交给 run 的位置来决定——审计者看请求根本看不出目标。**如果你的站点本来就设计为同 namespace 部署**，正确做法不是删掉这条判据，而是在与名单比较前先归一化缺省值（把 `targetNs == '' && contains([...], request.namespace)` 视为合规），并补一行“namespace 缺省 + 当前 namespace 在名单上 → 放行”的探针；④ 把所有会拼进 shell 的输入限制为**保守语法**（DNS-1123 标签、规范的工作负载 Kind、shell 安全的镜像引用、相对目录、整数秒超时）；④' `workloadContainers`——尽管它以 **args 数组**形式（`--containers <name>…`）交给 kubectl Task、每个使用点都加了引号、**不是注入面**——仍按容器名语法校验；原因不是注入，而是**只有真实存在的名字才会生效**，见下文“更新的是哪个容器”边界说明；⑤ **“绑定了但不是 Secret”的 kubeconfig workspace 一律失败关闭**；⑥ **拒绝对部署任务的任何超出调度键的 `taskRunSpecs` 覆盖**（判据同 [§4.2.5](#s4-2-5)：`nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName` 放行；任何其他键、以及任何 `serviceAccountName`，一律拒绝）——`podTemplate.env` 会注入到 step 容器里，而 kubectl Task **只有在 kubeconfig workspace 被绑定时才自己 `export` `KUBECONFIG`**，因此一个合规的“部署到当前集群”请求只需注入一个 `KUBECONFIG` 就能把整次发布改道别处，连带让 namespace 白名单失效；⑦ **两个 run 级入口分别处理**——`spec.taskRunTemplate` 恰好只有两个字段（已用 `kubectl explain` 核实）：`podTemplate` 和 `serviceAccountName`。前者的 `env` 与 ⑥ 完全等价（它作用于本次 run 的每个 TaskRun，包括部署 step）——**直接拒绝**；后者决定部署 step 以**谁的身份**执行 `kubectl apply`——未绑定 kubeconfig 时它用的正是这个身份，把它指向权限更大的 SA 就绕过了“约束落在部署凭证的 RBAC 上”这句话——因此它按**获批名单**管理而非直接拒绝：run 级 SA 是**正常配置**，一刀切拒绝会误杀大量合法请求。**名单必须包含 Tekton defaulting 填入的那个 SA**（判据中的第一个占位符 `<tekton-default-service-account>`）——这是既定机制而非推断：Tekton 的 defaulting webhook 先于 Kyverno 运行，所以**正常情况下** admission 不会看到 `taskRunTemplate` 缺失（唯一的例外及其导致的失败放行，见 [§4.0.3](#s4-0-3) 该占位符所在行）；它到达时已带着 defaulting 填好的 SA（取自 `config-defaults` 的 `default-service-account`，**该键缺失时回退到 Tekton 内置默认值**——本文档的环境正是缺失的情况，生效值为 `default`）和 `default-pod-template`（本文档环境中为 `securityContext.fsGroup=65532`）。**把这个默认填入的 SA 漏在名单外，所有合规请求都会被拒绝**——放行探针会立刻暴露这一点；见 [§4.0.3](#s4-0-3) 占位符表中的同名条目。
- **它管不了什么**：它约束的是**写在请求里的目标参数和凭证来源**——既不保证 manifest 内容只触及那个 namespace（见下文边界说明），也不保证发布产物本身可信（那属于 [§4.5.1](#s4-5-1) / [§4.5.3](#s4-5-3) 与供应链证明的范畴）；而且其强度依赖模板版本——本画像是针对 0.3 的真实替换行为写的（这段数据流在 0.2 与 0.3 完全相同：`deploy-or-upgrade` 仍是 `kubectl` 0.1，目标参数仍以不加引号的文本拼进 `script`），所以**模板升级时必须重新评审每个字段和合并顺序**。

**通用契约**：`workloadName`、`workloadKind`、`workloadNamespace`、`images`、`workloadManifestsDir`、`workloadRolloutTimeout` 以及 `kubeconfig` workspace 都属于 **PipelineRun** 契约。若把规则写在 TaskRun CREATE 上，它读不到目标 namespace，对真实形态永远不会生效。

**只管这一个 workspace 绑定是刻意的**：本节判断 `kubeconfig` workspace，因为它直接决定“这次发布落到哪个集群”——绑错了，目标白名单就形同虚设。**其他所有 workspace（源码、缓存、制品、各类凭证）在本文档全篇都不做管控**：它们的风险是“谁能把哪个 Secret / PVC 挂进流水线”，那是 namespace 级 RBAC 与 Secret 治理问题，不是流水线策略问题——能在该 namespace 创建 run 的身份通常本来就能读那些 Secret，在 admission 层拦截只是把边界画错了地方。确实想在策略侧收紧的站点，判据形态与本节相同（按 `workspaces[].name` 定位目标绑定，再判断 `secret.secretName` 是否在获批名单上）——但**先确认 RBAC 层已经收窄**，否则你拦住的只是名为“挂载”的那一种用法。

:::warning 为什么这些参数值得在 admission 再查一遍（“流水线自己会失败”还不够吗？）

因为它们**不是“写错了会报错”的参数——而是拼进 shell 的注入面**。像 `workloadName` 这样的值经文本替换、不加引号地进入 kubectl Task 的 `script`——形如 `x; <arbitrary command>` 的值不会“失败”，而是**被执行**，并且是在一个**已经挂载了部署 kubeconfig** 的容器里执行。等流水线报出失败时，注入的命令早已跑完：**流水线失败是可用性机制，不是对抗恶意输入的安全机制。**

相比之下，admission 拒绝发生在 PipelineRun CREATE 时、零副作用——什么都没构建、没有镜像被推送、没有凭证进入任何容器。

反过来，这也是本文档**挑选管哪些参数的判据**：只在 admission 管那些“admission 看得见、且失败代价不可接受”的输入（会进 shell、决定发布目标、或决定凭证来源的那些）。那些仅仅“格式错了会报错、没有注入面、不影响权限”的参数，就留给流水线自己去失败——在策略里重复校验只会增加策略与模板版本之间的耦合。

:::

还有一个更隐蔽的绕过：**不要只看 `kubeconfig` workspace 的 `.secret.secretName`**。如果该 workspace 用 **PVC / CSI / configMap** 或其他非 Secret 来源绑定，`secretName` 为空，幼稚的策略就会放行——攻击者随后就能用 PVC 塞入任意 kubeconfig。“绑定了但不是 Secret”的 kubeconfig workspace 必须**失败关闭**。

**关键判据**——两个布尔值：来源身份始终校验；部署画像只在启用部署时校验：

```yaml
      validate:
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"        # hub source swapped (checked whether or not deploy is enabled)
                operator: Equals
                value: true
              - key: "{{ deployProfileBad }}"    # target / parameter syntax / kubeconfig source / per-task and run-wide overrides
                operator: Equals
                value: true
```

:::details 完整策略 YAML：release-target-allowlist

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: release-target-allowlist
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: deploy-targets-must-be-approved
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        # Lock the exact official Pipeline identity. The deployment parameters
        # are visible here, before Tekton renders them into kubectl Task script.
        - name: pipelineResolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: pipelineKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: pipelineCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: pipelineName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: pipelineVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: hubTypeCount
          variable:
            jmesPath: "length((request.object.spec.pipelineRef.params || `[]`)[?name=='type'])"
        - name: hubType
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='type'].value | [0] || ''"
            default: ""
        - name: hubURLCount
          variable:
            jmesPath: "length((request.object.spec.pipelineRef.params || `[]`)[?name=='url'])"
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
        - name: workloadName
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadName'].value | [0] || ''"
            default: ""
        - name: deploymentEnabled
          variable:
            # Mirror the Pipeline when expression inside JMESPath so numeric-
            # looking names cannot trigger Kyverno condition coercion.
            jmesPath: "!contains(['', ' '], workloadName)"
        - name: workloadKindPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='workloadKind']) > `0`"
        - name: workloadKind
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadKind'].value | [0] || ''"
            default: ""
        - name: deployImages
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='images'].value | [0] || `[]`"
        - name: targetNs
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadNamespace'].value | [0] || ''"
            default: ""
        - name: workloadManifestsDir
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadManifestsDir'].value | [0] || ''"
            default: ""
        - name: workloadRolloutTimeoutPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='workloadRolloutTimeout']) > `0`"
        - name: workloadRolloutTimeout
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadRolloutTimeout'].value | [0] || ''"
            default: ""
        - name: workloadContainers
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadContainers'].value | [0] || `[]`"
        - name: kubeconfigWs
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='kubeconfig'] | [0] || `{}`"
        - name: kubeconfigSecret
          variable:
            jmesPath: "kubeconfigWs.secret.secretName || ''"
            default: ""
        # An absent workspace is allowed and means the current cluster. If a
        # kubeconfig binding exists, only an approved Secret is inspectable here.
        - name: kubeconfigNonSecret
          variable:
            jmesPath: "length(keys(kubeconfigWs)) > `0` && kubeconfigSecret == ''"
        - name: nsBad
          variable:
            # Site-specific allowlist: list every approved deployment namespace
            # here (two shown). An unreplaced value rejects all compliant runs.
            jmesPath: "!contains(['<approved-deploy-namespace-a>','<approved-deploy-namespace-b>'], targetNs)"
        - name: workloadNameBad
          variable:
            # This production profile deliberately narrows names to one DNS-1123
            # label before the Pipeline substitutes the value into shell text.
            jmesPath: "!regex_match('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$', workloadName) || length(workloadName) > `63`"
        - name: workloadKindBad
          variable:
            # Absence uses the trusted Pipeline default Deployment. Explicit
            # values use canonical casing because manifest kind matching is exact.
            jmesPath: "workloadKindPresent && !contains(['Deployment','StatefulSet','DaemonSet'], workloadKind)"
        - name: imagesBad
          variable:
            # images[0] is inserted unquoted into the deploy script. Validate the
            # complete array so malformed later entries cannot reach other tasks.
            jmesPath: "length(deployImages) == `0` || length(deployImages[?regex_match('^[-A-Za-z0-9._:/@+]+$', @) == `false`]) > `0`"
        - name: manifestsDirBad
          variable:
            # Empty means no manifests. Non-empty paths must be relative, contain
            # no parent traversal, and use only a shell-safe path alphabet.
            jmesPath: "workloadManifestsDir != '' && (!regex_match('^[-A-Za-z0-9._/]+$', workloadManifestsDir) || starts_with(workloadManifestsDir, '/') || contains(split(workloadManifestsDir, '/'), '..'))"
        # This array param is wired into the kubectl Task as
        # `args: [--containers, <name>...]` and used as
        # `kubectl set image <kind>/<name> "$container"="$NEW_IMAGE"` (and as a
        # yq strenv match on the manifest path). Every use site is quoted, so it
        # is not an injection surface -- it is judged because only a real
        # container name takes effect: a name that matches nothing leaves the
        # workload on its previous image while the run still reports success.
        # Leave the list empty to update every container; the Task substitutes
        # "*" itself, which is why an explicit "*" is rejected here.
        - name: workloadContainersBad
          variable:
            jmesPath: >-
              length(workloadContainers[?regex_match('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$', @) == `false`
              || length(@) > `63`]) > `0`
        - name: rolloutTimeoutBad
          variable:
            # The Pipeline appends "s" at the kubectl call site. Absence uses the
            # trusted default 0; explicit values are integer seconds only.
            jmesPath: "workloadRolloutTimeoutPresent && !regex_match('^(0|[1-9][0-9]*)$', workloadRolloutTimeout)"
        - name: secretBad
          variable:
            # Site-specific Secret name; absence means "deploy to the current
            # cluster" and stays allowed (see kubeconfigNonSecret above).
            jmesPath: "kubeconfigSecret != '' && kubeconfigSecret != '<approved-deploy-kubeconfig-secret>'"
        # A per-task override rides in the same request and no parameter judgment
        # can see it. podTemplate.env reaches the step container, and the kubectl
        # Task only exports KUBECONFIG itself when the kubeconfig workspace is
        # bound -- so on a compliant "deploy to the current cluster" request an
        # injected KUBECONFIG would silently redirect the whole deployment.
        # The run-wide equivalent: taskRunTemplate.podTemplate applies to every
        # TaskRun of this run, so env set here reaches the governed task too.
        # Only env is judged. Besides nodeSelector / imagePullSecrets being
        # ordinary configuration, "deny any run-wide podTemplate" would deny
        # everything: Tekton's defaulting webhook merges config-defaults'
        # default-pod-template in before Kyverno sees the request, so this field
        # is never actually absent. Residual fields are in the boundary note.
        - name: runWideEnvCount
          variable:
            jmesPath: "length(request.object.spec.taskRunTemplate.podTemplate.env || `[]`)"
            default: 0
        # taskRunTemplate carries exactly two fields (verified with kubectl
        # explain): podTemplate and serviceAccountName. The identity one bites
        # hardest on the compliant "deploy to the current cluster" path, where
        # the kubectl Task acts with this run's ServiceAccount -- a wider SA
        # defeats the deploy-credential RBAC the boundary note relies on.
        # Unlike env, a run-wide SA is ordinary configuration, so it is
        # allowlisted rather than denied outright.
        - name: runWideSa
          variable:
            jmesPath: "request.object.spec.taskRunTemplate.serviceAccountName || ''"
            default: ""
        - name: runWideSaBad
          variable:
            # Measured, not assumed: Tekton's defaulting webhook runs before
            # Kyverno, so admission normally sees this field already holding
            # config-defaults' default-service-account. The allowlist must
            # therefore carry that defaulted name as well, otherwise every
            # ordinary release run is rejected.
            # The one case where it DOES arrive absent: default-service-account
            # present but set to an empty string -- Tekton then skips the fill,
            # and the `!= ''` below makes this rule skip too (fail-open). §4.0.3
            # tells you to probe the effective value; empty output means fix the
            # ConfigMap rather than trust this rule.
            jmesPath: "runWideSa != '' && !contains(['<tekton-default-service-account>','<approved-deploy-service-account>'], runWideSa)"
        - name: deployOverrideBad
          variable:
            # Same key-level judgment as the gate policies: scheduling keys stay
            # allowed, every OTHER podTemplate key (env, volumes, dnsConfig, ...)
            # and any per-task serviceAccountName is denied.
            # Scope, stated exactly: PipelineTaskRunSpec carries eight fields, and
            # this expression inspects two of them (serviceAccountName, podTemplate).
            # The rest -- stepSpecs, sidecarSpecs, computeResources, timeout,
            # metadata -- are left alone on purpose: they carry only resource
            # limits, a deadline, or labels, none of which can move the deployment
            # to another namespace or cluster. Labels in particular are already
            # treated as untrusted everywhere in this document, so denying them
            # here would buy nothing.
            jmesPath: >-
              length((request.object.spec.taskRunSpecs || `[]`)[?pipelineTaskName=='deploy-or-upgrade'
              && (serviceAccountName
              || length(keys(podTemplate || `{}`)) != length(keys(podTemplate || `{}`)[?contains(['nodeSelector','tolerations','affinity','imagePullSecrets','priorityClassName'], @)]))]) > `0`
        - name: deployProfileBad
          variable:
            # The Hub source is always governed. Target checks apply only when
            # the Pipeline's deployment branch is enabled.
            jmesPath: >-
              deploymentEnabled
              && (deployOverrideBad
              || runWideEnvCount > `0`
              || runWideSaBad
              || nsBad
              || workloadNameBad
              || workloadKindBad
              || workloadContainersBad
              || imagesBad
              || manifestsDirBad
              || rolloutTimeoutBad
              || secretBad
              || kubeconfigNonSecret)
      preconditions:
        all:
          - key: "{{ pipelineResolver }}"
            operator: Equals
            value: hub
          - key: "{{ pipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ pipelineCatalog }}"
            operator: Equals
            value: catalog
          # Both official 0.3 templates carry the same deploy-or-upgrade task
          # with the same workload parameters, so pinning one of them would let
          # the other deploy with no target governance at all.
          - key: "{{ pipelineName }}"
            operator: AnyIn
            value:
              - java-image-build-scan-deploy
              - python-image-build-scan-deploy
          - key: "{{ pipelineVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          release Pipeline source or deployment target not approved:
          source={{ pipelineResolver }}/{{ pipelineKind }}/{{ pipelineCatalog }}/{{ pipelineName }}/{{ pipelineVersion }},
          hubSourceBad={{ hubSourceBad }}, deploymentEnabled={{ deploymentEnabled }},
          workloadName='{{ workloadName }}', workloadKind='{{ workloadKind }}',
          targetNamespace='{{ targetNs }}', deployProfileBad={{ deployProfileBad }},
          deployOverrideBad={{ deployOverrideBad }}, runWideEnvCount={{ runWideEnvCount }},
          runWideSaBad={{ runWideSaBad }}, namespaceBad={{ nsBad }},
          workloadNameBad={{ workloadNameBad }}, workloadKindBad={{ workloadKindBad }},
          workloadContainersBad={{ workloadContainersBad }}, imagesBad={{ imagesBad }},
          manifestsDirBad={{ manifestsDirBad }}, rolloutTimeoutBad={{ rolloutTimeoutBad }},
          kubeconfigSecretBad={{ secretBad }}, kubeconfigNonSecret={{ kubeconfigNonSecret }}.
          Correct the fields whose non-sensitive diagnostic flag is true; approved
          namespace, ServiceAccount and Secret allowlists are intentionally not disclosed.
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"
                operator: Equals
                value: true
              - key: "{{ deployProfileBad }}"
                operator: Equals
                value: true
```

:::

:::details 验证探针（37 条探针，真实 hub PipelineRun 形态，--dry-run=server）

下表把 **21 行 = 37 条探针**打包在一起：形态相同的探针合并为一行（例如“两者都拒绝”是两条探针，“拒绝 / 放行 / 放行”是三条）；逐条运行时，按各行内的枚举展开。

表中的“获批 namespace A / B”“获批 Secret”“获批 SA”均指策略五个占位符替换后的取值——**先替换、再跑探针**，否则连第一行的放行用例也会被拒绝（占位符本身永远不会等于真实参数值）。

| 探针 | 预期 |
|---|---|
| 启用部署 + 获批 namespace A（无 kubeconfig，显式 `timeout=1` 秒）；再加一条相同画像、仅显式 `type=artifact` 的 | 放行 |
| 获批四元组再加请求级 `url`，或显式 `type=tekton` | 拒绝 |
| 未启用部署的两种形态：`workloadName` 缺省 / 等于单个空格；再任取其一多跑两次，一次加请求级 `url`、一次加 `type=tekton` | 前两条跳过目标检查；后两条仍被拒绝（来源判据不看“是否启用部署”） |
| 启用部署但 namespace 缺省 | 拒绝 |
| namespace = `kube-system`（或任何不在白名单上的 namespace） | 拒绝 |
| 获批 namespace B + 获批 Secret | 放行 |
| 获批 namespace A + **PVC workspace** | 拒绝 |
| 获批 namespace A + 未授权的 Secret | 拒绝 |
| 合规请求 + 部署任务上的 `taskRunSpecs[].podTemplate.env`，或其上的 `serviceAccountName` | 两者都拒绝 |
| 部署任务上仅含**调度键**（`nodeSelector` / `tolerations`）的 `podTemplate` | 放行（判据同 [§4.2.5](#s4-2-5)） |
| 同样的按任务覆盖，但**未启用部署** | 放行（判据不越权——那个任务反正不会运行） |
| **python 0.3** 模板：白名单外的 namespace / 同样完全合规的画像 | 拒绝 / 放行（身份覆盖两个模板） |
| run 级 `taskRunTemplate.podTemplate.env`（启用部署） | 拒绝 |
| run 级 podTemplate 只设 `nodeSelector` | 放行（只判 `env`） |
| run 级 `serviceAccountName` 不在获批名单 / 在获批名单 / 等于 `config-defaults` 的默认值 | 拒绝 / 放行 / 放行 |
| run 级未获批 SA，但**未启用部署** | 放行 |
| `workloadContainers` 含非法容器名 / 显式 `*` | 两者都拒绝 |
| `workloadContainers` 含合法容器名 | 放行（“参数缺省 = 更新所有容器”的形态就是上面每一条合规探针） |
| 非目标 Pipeline 身份 | 不被误拒 |
| 向 `workloadName`、`workloadKind`、`images[0]`、`workloadManifestsDir`、`workloadRolloutTimeout` 各注入一段无副作用的 shell 片段 | 五条全部拒绝 |
| 小写 `deployment`（manifest kind 比较大小写敏感）、带单位的 `1s`（模板会拼成 `1ss`）、数字形 `workloadName: "1"` + 未获批 namespace | 全部拒绝 |

:::

:::warning 有损边界——必读

**`workloadNamespace` 只是 `kubectl apply -n` 的默认 namespace，不是“这次发布只会触及该 namespace”的保证。** 模板最终执行的是 `kubectl apply -f "$PATCHED_YAML" -n "$NAMESPACE"`——**manifest 内部携带的 `metadata.namespace` 会覆盖 `-n`，而集群级资源（`ClusterRole` / `ClusterRoleBinding` / `Namespace` 等）根本与 `-n` 无关**。换句话说：源码仓库里 `workloadManifestsDir` 下的内容声明了什么，就可能 apply 什么，而本策略在 admission 时看不见那些文件。**真正约束那一层的是部署凭证自身的 RBAC**（把部署 ServiceAccount 在目标 namespace 收窄到最小权限并拒绝集群级资源），外加对 manifest 内容本身的评审 / admission。

**还有一层与“发到哪”不同的“发了什么”：`workloadContainers` 决定新镜像写进哪个容器。** 模板把它以 `--containers <name>…` 传给 kubectl Task，Task 随后执行 `kubectl set image "$KIND"/"$NAME" "$container"="$NEW_IMAGE"`（在 manifest 分支上，`yq` 通过 `strenv(container)` 匹配容器名并改写镜像）；**留空时**，Task 自己填入 `*` = 更新所有容器。策略校验的是“每一项都是合法容器名”（这也是显式 `*` 被拒绝的原因——要更新所有容器就把列表留空），**但“该更新哪个容器”是 admission 无法判断的业务语义**：

- 在 `kubectl set image` 分支上，不存在的名字会让命令报错、流水线失败（失败关闭——吵但安全）；
- 在 **manifest 分支**上，`yq` 匹配不到任何东西时**什么都不改**——于是被 apply 的是 manifest **原本携带**的镜像，而不是刚构建并扫描过的那个，**且流水线照样成功**。也就是说，“闸门通过 ⇒ 集群跑的是通过闸门的镜像”这个推断在这条路径上不成立；
- 当名字指向**另一个容器**（比如某个 sidecar）时，业务容器继续跑旧镜像——同样是“看起来发布成功，实际什么都没换”。

要把这一层也锁住，只能在流水线之外补充：把容器名收窄为站点获批名单（形态同 `<approved-deploy-service-account>`），或对 manifest 内容做评审 / 在目标集群做 admission。

**而“用 RBAC 约束”本身有个前提：请求不能自己挑身份。** 未绑定 kubeconfig 时，`kubectl apply` 以本次 run 的 ServiceAccount 身份运行，而 PipelineRun 有两处可以设置它——`taskRunSpecs[].serviceAccountName`（针对部署任务；本策略直接拒绝）和 `spec.taskRunTemplate.serviceAccountName`（run 级；本策略要求命中 `<approved-deploy-service-account>` 名单）。**两处都不管，“部署 SA 已收窄到最小权限”就只是在描述某一个特定 SA——请求换个更宽的就行了。** 反过来，run 级 SA 是正常配置，直接拒绝会造成误拒，所以这里用获批名单而不是拒绝——把这份名单与你实际发放的部署凭证 RBAC 一起维护：新增 SA 时同步加进名单，并且**还必须把 Tekton 默认填入的那个 SA 列进去**（见上文机制说明）。

即便 workspace 来源已收窄，**目标集群的最终安全边界仍必须由目标集群自身的 admission / RBAC 承担**——本策略约束的是“用哪个 kubeconfig Secret、部署到哪个 namespace 参数”，但 kubeconfig Secret 的**内容**（它真正指向哪个集群、带什么权限）对 admission 不可见；只能通过“允许引用哪些 Secret”间接封闭。

**当 `<tekton-default-service-account>` 的生效值查出来为空时，先修 ConfigMap 再谈策略**（本段是该占位符失败放行机制的完整版本；[§4.0.3](#s4-0-3) 的取值行指向这里）：取值一律用 [§4.0.3](#s4-0-3) 的生效值命令，它读的是 defaulting **之后**的结果——不要从 `config-defaults` 去猜。`default-service-account` 键**缺失**时回退到 Tekton 内置默认值 `default`（多数 ACP 集群出厂即缺失该键：它只出现在不生效的 `_example` 注释块里，所以直接从 ConfigMap 读到空值是正常现象，不是命令坏了）。**键存在但值为空**是另一种情况：Tekton 读取该配置时只检查键是否**存在**——存在就原样取值，于是空字符串覆盖了内置默认值 `default`；而填充只在默认值非空时发生（PipelineRun 与 TaskRun 皆然）——因此 admission **真的会看到该字段缺失**，本节的 `runWideSa != ''` 判据整体跳过：**一个失败放行**。正确的修法是把 `config-defaults` 里的空值改成真实 SA 名（道理同 `<tekton-managed-by-label-value>`：空值本身就是部署阻断项）；不改，这条规则就形同虚设。

**复制前先替换五个站点值**（`<approved-deploy-namespace-a>` / `-b`、`<approved-deploy-kubeconfig-secret>`、`<tekton-default-service-account>`、`<approved-deploy-service-account>`）——取值方法、列表式语法、以及失败方向（全部反向：漏替换 = **所有合规部署请求被拒绝**），见 [§4.0.3](#s4-0-3) 参考表对应的四行；此处不再重复。

**就 `workloadRolloutTimeout` 给运维一个特别提醒：模板自己的参数描述是错的。** 它写着“其他值应带时间单位（如 `1s`、`2m`、`3h`）”，但调用点脚本拼的是 `--timeout=${ROLLOUT_TIMEOUT}s`——填 `1s` 会变成 `1ss`，执行时失败。**唯一正确的形式是整数秒（`0` = 永不超时）**，这也是本策略只接受整数的原因；落地时把这一行写进发给业务团队的填写说明，否则就会出现“按模板文档填 → 被策略拒绝 → 绕过策略 → 在 Task 里失败”的来回折腾。

此外，目标 namespace 与 shell 安全参数约束都依赖 Pipeline 0.3 的真实参数 / 脚本契约；**模板升级时，重新评审每一条 `$(params.*)` 到 shell 的数据流**。示例中的工作负载 Kind、名称、路径、整数秒超时和镜像语法是刻意保守的生产画像——业务团队需要更宽的合法集合时，**扩白名单并补对抗性探针**，而不是删掉校验。

:::

#### 清理（§4.5）

按 [§4.0.4](#s4-0-4) 的两条规则，通过归属台账按记录的 UID 删除五个集群级策略：

```bash
for pol in artifact-source-allowlist promotion-source-image-labels \
  pod-image-registry-allowlist pipeline-entry-lockdown release-target-allowlist; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
```

namespace 级对象随自建 namespace 的级联删除一并回收：`pipeline-image-allowlist` ConfigMap（**仅当你采用了 [§4.5.3](#s4-5-3) 的 ConfigMap 变体时它才存在**），以及本节运行过的 PipelineRun / 独立 TaskRun 及其派生对象。如果要继续后面的章节，先按名称删除 run 类对象，以免 PolicyReport 干扰（[§4.0.5](#s4-0-5)）。
### 4.6 （进阶）自动取消运行中的流水线 {#s4-6}

**总体契约**：硬门禁（[§4.3](#s4-3)）是"结果不达标 → 失败"的主线；但有些场景需要对已在运行的流水线**尽早发起取消**（例如提前停掉昂贵的后续步骤）。技术手段是 mutate-existing——在状态事件触发时，patch 目标 PipelineRun 的 `spec.status: CancelledRunFinally`（Tekton 原生的取消字段）。

本节给出**两种触发条件**：**[§4.6.1](#s4-6-1) 结果不达标**（读取 TaskRun 写出的 result）与 **[§4.6.2](#s4-6-2) 定义漂移**（读取写回 status 的 `pipelineSpec`，发现解析后的定义与获准的身份不符）。机制相同、判据不同——且**两者都在同一个 patch 里写入一条说明原因的 annotation**（[§4.6.1](#s4-6-1) 记录哪个 result 越界，[§4.6.2](#s4-6-2) 记录漂移在哪里）：不在对象上留下原因的取消，与手工取消无法区分——理由见 [§4.0.6](#s4-0-6)，排障时如何读取见 [§6.2.3](#s6-2-3)。

**先看全局：本文一共有四条会取消流水线的路径——两条在本节、两条在 [§4.2](#s4-2)**——它们的差别不在"取消"这个动作本身，而在**何时发现问题、动的是哪个对象**。选型与排障都用这张表（它是十字路口；每一行的完整策略仍在各自小节里）：

| 小节 | 何时发现、依据什么条件 | 作用对象 | 机制（同步 / 异步） | 证据在哪（[§6.2.3](#s6-2-3) 中的步骤号） |
|---|---|---|---|---|
| [§4.2.3](#s4-2-3) | 在门禁 TaskRun **准入**时：门禁开关 / 阈值参数不合规 | **门禁 TaskRun 自身** | 准入 `mutate` 写入 `spec.status: TaskRunCancelled` + `statusMessage`——**同步、无竞态、不需要额外 RBAC** | 该 TaskRun 的 `spec.statusMessage` 与终态 condition——**完整原因就在这里**（步骤 1） |
| [§4.2.2](#s4-2-2) | 同一时刻、同一判据（门禁参数不合规） | **父 PipelineRun** | mutate-existing patch `spec.status: CancelledRunFinally`——异步，需要后台控制器的 update RBAC | 父 run 的 `cancel-reason` annotation（步骤 2） |
| [§4.6.2](#s4-6-2) | PipelineRun 写入 status 时：解析后的定义里可信门禁已被**移除，或整个 Task 身份被换掉**（定义漂移——不同 namespace 下的同名也算） | **该 run 自身**（自我指向，无需跨 run 查找） | 与上相同的 patch，`CancelledRunFinally` | 父 run 的 `cancel-reason` annotation，其文本说明漂移所在（步骤 3） |
| [§4.6.1](#s4-6-1) | TaskRun 到达终态时：某个 result 越界（覆盖率 / 漏洞数等）；**result 缺失或格式错误同样命中**（fail-closed 指的是判据的方向；取消是否真正落地取决于后台链路——见本表下方第 ④ 点） | **父 PipelineRun**（用五环身份链防止认错父 run） | 与上相同的 patch，`CancelledRunFinally` | 父 run 的 `cancel-reason` annotation，写明触发的 TaskRun 与越界值（步骤 4） |

选型时最容易忽略的有四点：**① 前两行是同一判据的三种响应形态中的两种**（第三种是 [§4.2.1](#s4-2-1) 的直接 deny，代价是 finally 不会运行；三者的取舍见 [§4.2.3](#s4-2-3)）；**② 只有 [§4.2.3](#s4-2-3) 是同步的**——其余三条都只在事件之后才动作，已经发生的副作用不会被回滚；**③ 终态不一定是 `Cancelled`**——在 [§4.6.1](#s4-6-1) 中，当 result 根本没被写出时，Tekton 的失败裁决优先级高于取消，终态是 `Failed`；取消的证据只存在于 `spec.status` 与 annotation 中（见 [§4.6.1](#s4-6-1) 末尾）；**④ 后三行交付的是"发起取消"，而不是"取消一定会发生"**——判据命中后，patch 由后台控制器经 UpdateRequest 异步派发，而这条投递完全没有同步反馈：`context.apiCall` 取不到目标、UpdateRequest 根本没被创建、控制器不可用或积压、目标资源上的 update RBAC 被收回——上述任何一种情况下，原始请求都照常放行，patch 只是永远不出现，并且它**不产生任何拒绝信息，也不产生 PolicyReport 违规记录**（mutate 类规则本就不记录违规，[§4.2.3](#s4-2-3)）；现场只剩后台控制器的日志。所以这三行给出的是"尽力而为的投递"，只有 [§4.2.3](#s4-2-3) 那一行给出的是"当场、在准入内生效"；**凡是需要"发现即必然拦停"的地方，选同步路径**（[§4.2.1](#s4-2-1) 的 deny 或 [§4.2.3](#s4-2-3) 的准入 mutate）；如果继续使用这三条，请按 [§3.7](#s3-7) 的"异步投递链路"一行补齐监控与故障注入。

**后三行的共同前提（三条 mutate-existing 路径）**（[§4.2.3](#s4-2-3) 是作用于入站请求对象的准入 mutate，不需要这项权限；其余三条缺了它，策略要么装不上、要么永远不生效）：后台控制器需要对目标 `pipelineruns` 拥有 update RBAC，且 **Kyverno 会在策略创建时校验这项 RBAC——缺失时直接拒绝创建策略**，报错类似：

```text
admission webhook "validate-policy.kyverno.svc" denied the request:
path: spec.rules[0].mutate.targets.: auth check fails, additional privileges are
required for the service account 'system:serviceaccount:kyverno:kyverno-background-controller':
... requires permissions update for resource tekton.dev/v1/PipelineRun
in namespace {{ request.namespace }}
```

**注意末尾的 `in namespace {{ request.namespace }}` 从未被求值**——这次鉴权检查发生在策略创建时，那一刻 `request` 还不存在，所以当 `mutate.targets[].namespace` 写成**变量**时，Kyverno 只接受**集群级**的 update 权限；只有当 namespace 是**字面量**时，namespaced Role 才够用（这也是 [§4.2.2](#s4-2-2) 的单 namespace 变体必须把 `targets` 同样写成字面量的原因——只加 Role 是不够的）。本章的规则用到了 `subjects` / 请求上下文，所以策略必须设置 `background: false`（否则创建会被拒绝，报 `only select variables are allowed in background mode`）——但 mutate-existing 的目标仍由后台控制器执行。

当你只治理一个固定 namespace 时，可以复用 [§4.2.2](#s4-2-2) 的 namespaced Role，并把 mutate 目标 namespace 写成字面量；当需要动态跨 namespace 目标时，使用下面的聚合 ClusterRole——**并注意这是一次特权提升**：它把**整个集群范围**内 `pipelineruns` 的 update / patch 授予后台控制器，从这一刻起，规则自身的身份校验（`subjects` + owner-UID 回查 + 完整 TaskRef）就是这项权限仅剩的约束——其中任何一环都不能省：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kyverno-background-update-pipelineruns
  labels:
    # merge into the background-controller's aggregated ClusterRole
    rbac.kyverno.io/aggregate-to-background-controller: "true"
rules:
  - apiGroups:
      - tekton.dev
    resources:
      - pipelineruns
    verbs:
      - get
      - list
      - watch
      - update
      - patch
```

保存为 `kyverno-background-update-pipelineruns.yaml`，然后**先授权、确认聚合已生效，再安装本节的两条策略**——顺序反过来会得到与"根本没授权"一模一样的报错（[§6.1.1](#s6-1-1)）：

```bash
# `create`, not `apply` (§4.0.4): this ClusterRole is cluster-scoped, and a
# same-named one already on the cluster is somebody else's grant -- an
# AlreadyExists here means STOP, not overwrite.
create_owned_cluster_object kyverno-background-update-pipelineruns.yaml clusterrole

# Aggregation is asynchronous: this must print `yes` BEFORE you install either policy.
# It is the same check as §3.1's item 3; repeat it for a few seconds if it says no.
kubectl auth can-i update pipelineruns.tekton.dev \
  --as=system:serviceaccount:kyverno:kyverno-background-controller -A
```

输出 `no` 时先别急着改策略：先重跑上面的命令（聚合可能只是还没传播开），再检查 ClusterRole 上的 `rbac.kyverno.io/aggregate-to-background-controller: "true"` label 是否拼写正确。**安装策略时报的鉴权错误看起来与"根本没授权"完全一样**，因此这一步必须在安装任何策略之前单独确认。

**共同边界**：取消是事件驱动的响应动作，不是准入拒绝——它发生在结果已经产出**之后**；此前已执行的副作用不会被回滚，finally 仍会运行（[§2.3](#s2-3) 对比表的第三行）。因此它是 [§4.3](#s4-3) 门禁任务的**补充**，而不是替代。

:::warning 取消 ≠ 立即停止计算

在所有 mutate-existing 取消场景中，**TaskRun 被标记为已取消并不意味着它的 Pod 会同步终止**。已经走上并发创建路径的 Pod 可能一直运行到进程自行退出；即便把下游任务写成 `runAfter`，"下游 Pod CREATE"与"父 run 被取消"之间仍存在竞态。

成本敏感的场景不能把取消当作"算力立即回收"的保证：**给任务设置合理的超时**，并在你自己的目标容量与运行时上实测 Running Pod 的终止延迟。

:::

#### 4.6.1 结果触发的取消（主用法，含防伪造校验） {#s4-6-1}

- **它治理什么**：**结果已经出来、这时才发现不达标时，停掉这条流水线**——盯住 TaskRun 写入 status 的时刻，读取它产出的 result（示例中是覆盖率），值越界时取消**父 PipelineRun**，让后面的构建 / 发布步骤不再继续运行。
- **难点在哪**：必须先回答"这个 TaskRun 的父到底是哪个 run"，而且答案必须**不可伪造**——TaskRun 上的 `tekton.dev/pipelineRun` label 完全不可信：裸 TaskRun 可以自己写它，真实的 PipelineRun 也能通过 `taskRunSpecs[].metadata.labels` 覆盖子 Run 的 label。取消意味着**伸手去修改别人的对象**；认错父 run 等于交出一个"取消任意流水线"的按钮。
- **策略如何分层**：① 只匹配由 **Tekton 控制器 SA** 写入的 status 请求；② 从控制器的 `ownerReference` 取父 run 的名字/UID，再用 `apiCall` 获取**实时**的 PipelineRun 并核对 UID（击败同名重建）；③ 额外要求触发者确实出现在父 run 的 `status.childReferences` 中；④ 锁定完整的 Pipeline / Task 身份——否则任何产出同名 result 的流水线都能触发取消；⑤ 只有以上全部成立，`mutate-existing` 才把父 run 置为已取消。
- **它管不了什么**：这是**事后响应**，不是准入拒绝——result 产出**之前**已执行的副作用不会被回滚（镜像可能已经推出去了），finally 仍会运行。

本节用可信 namespace 中的 `coverage-cancel-demo` Pipeline 和 `policy-demo-coverage-emitter` Task（产出示例 result `coverage-lines`）来演示，**不依赖 [§3.3](#s3-3) 的 sonar 扫描器**。把定义放进受 RBAC 保护的 namespace、再锁定完整的 Pipeline / Task 身份，正是防止任意其他产出同名 result 的流水线触发取消的手段。适配 sonar 形态时，把触发条件改成读取 `code-scan-results.result == 'Failed'`（或 `code-scan-metrics` 中某个数值指标越界），身份锁定与防伪造部分原样保留。

:::warning apiCall 先于 preconditions 执行

`subjects` 只能证明写 status 的是 Tekton 控制器——**直接创建的（裸）TaskRun 的 status 也是由同一个控制器写入的**，所以裸 TaskRun 同样会进入 context 求值。没有父时 `parentName` 为空，`apiCall` 退化为查询 PipelineRun 集合；随后父 UID、精确父画像、当前 TaskRef、`childReferences` 上的 preconditions 全部不成立，请求被安全跳过。

这里要把因果理顺：**是"context 跑完之后被安全跳过"，不是"selector 在 apiCall 之前就把它排除了"**。真正的子 Run 则依靠 owner UID 等于实时父 UID，来排除同名重建或用户注入 label 造成的混淆。

:::

**关键判据**——五环身份链必须全部成立、且终态裁决确实是违规，才会动手（身份只挑选*对谁*动作；*何时*动作由 (3) 中的裁决 precondition 决定）：

```yaml
      preconditions:
        all:
          # (1) the parent run referenced by owner must be the same live object
          #     (defeats same-name recreation)
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ targetPlr.metadata.uid }}"
          # (2) parent profile and current TaskRef must both match exactly
          #     (omitted here; see the full YAML)
          # (3) the verdict itself -- identity alone never cancels anything: only a
          #     TERMINAL emitter TaskRun whose coverage-lines result violates the
          #     gate (out of range / malformed / missing / duplicated) triggers
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
          - key: "{{ coverageViolates }}"
            operator: Equals
            value: true
          # (4) the trigger must actually appear in the parent run's childReferences
          - key: "{{ request.object.metadata.name }}"
            operator: AnyIn
            value: "{{ childNames }}"
      mutate:
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ parentName }}"
            uid: "{{ parentUID }}"
            namespace: "{{ request.namespace }}"
        patchStrategicMerge:
          metadata:
            annotations:
              # A cancellation with no reason on the object cannot be told apart
              # from a manual one afterwards (§4.0.6 / §6.2.3). Echo the trigger
              # and the value that violated, both resolved from this request.
              policy.alauda.io/cancel-reason: >-
                coverage gate not met on TaskRun {{ request.object.metadata.name }}:
                coverage-lines='{{ coverage }}'
          spec:
            status: CancelledRunFinally
```

:::details 可信的演示 Task 与 Pipeline 定义

```yaml
# Trusted result producer. Keep this definition in an RBAC-protected namespace.
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-coverage-emitter
  namespace: tekton-templates
spec:
  params:
    - name: coverage
      type: string
    - name: omitResult
      type: string
      default: "false"
  results:
    - name: coverage-lines
  steps:
    - name: emit
      image: <registry>/busybox:latest
      env:
        - name: COVERAGE
          value: $(params.coverage)
        - name: OMIT_RESULT
          value: $(params.omitResult)
      script: |
        #!/bin/sh
        sleep 5
        # This switch demonstrates a terminal TaskRun which omits the declared
        # result entirely; an empty result value is a separate negative case.
        if [ "$OMIT_RESULT" != "true" ]; then
          printf '%s' "$COVERAGE" > "$(results.coverage-lines.path)"
        fi
---
# Trusted parent profile. The sleeper and notifier are part of this protected
# definition; the emitter is also locked independently by the policy below.
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: coverage-cancel-demo
  namespace: tekton-templates
spec:
  params:
    - name: coverage
      type: string
    - name: omitResult
      type: string
      default: "false"
  tasks:
    - name: emit
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: policy-demo-coverage-emitter
          - name: namespace
            value: tekton-templates
      params:
        - name: coverage
          value: $(params.coverage)
        - name: omitResult
          value: $(params.omitResult)
    - name: sleeper
      taskSpec:
        steps:
          - name: sleep
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              sleep 60
  finally:
    - name: notify
      taskSpec:
        steps:
          - name: notify
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "finally ran"
---
# The emit task publishes low coverage. The sleeper should be cancelled, while
# the final notifier must still execute under CancelledRunFinally.
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: cancel-low-coverage-demo
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: coverage-cancel-demo
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
---
# A terminal emitter which never writes coverage-lines is also a violation.
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: cancel-missing-coverage-demo
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: coverage-cancel-demo
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
    - name: omitResult
      value: "true"
```

:::

:::details 完整策略 YAML：cancel-on-failed-verdict

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: cancel-on-failed-verdict
spec:
  webhookConfiguration:
    # Ignore, not Fail: this policy matches */status — a Kyverno outage must never
    # block the Tekton controller's status write-back (§2.2 red line; §3.7 tiering)
    failurePolicy: Ignore
  background: false
  rules:
    - name: cancel-parent-on-low-coverage
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        - name: parentRef
          variable:
            jmesPath: "request.object.metadata.ownerReferences[?kind=='PipelineRun' && controller==`true`] | [0]"
            default:
              name: ""
              uid: ""
        - name: parentName
          variable:
            jmesPath: "parentRef.name || ''"
            default: ""
        - name: parentUID
          variable:
            jmesPath: "parentRef.uid || ''"
            default: ""
        - name: coverage
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='coverage-lines'].value | [0] || ''"
            default: ""
        # status.results has no uniqueness guarantee, so a decoy coverage-lines entry
        # ahead of the real one would win the [0] above. Here the count must feed the
        # violation itself, not a deny block: this rule drives mutate-existing, so a
        # malformed status has to reach the CANCEL path to stay fail-closed.
        - name: coverageResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='coverage-lines'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: coverageIsNumeric
          variable:
            jmesPath: "regex_match('^[0-9]{1,3}$', coverage)"
        - name: coverageViolates
          variable:
            jmesPath: >-
              coverageResultCount != `1`
              || succeededConditionCount != `1`
              || !coverageIsNumeric
              || to_number(coverage) > `100`
              || to_number(coverage) < `50`
        - name: isTerminal
          variable:
            # Wait for the terminal write so an early status without results does
            # not cancel, while terminal missing/empty results still fail closed.
            # Counted, not [0]-indexed, for the reason given in §4.4.1.
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # Lock the current TaskRef itself; labels can be overridden through
        # PipelineRun taskRunSpecs and are not an identity boundary.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # anti-forgery: fetch the owner parent, verify UID, and require this
        # TaskRun to be one of its genuine children
        - name: targetPlr
          apiCall:
            urlPath: "/apis/tekton.dev/v1/namespaces/{{ request.namespace }}/pipelineruns/{{ parentName }}"
        - name: parentPipelineResolver
          variable:
            jmesPath: "targetPlr.spec.pipelineRef.resolver || ''"
            default: ""
        - name: parentPipelineKind
          variable:
            jmesPath: "(targetPlr.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: parentPipelineName
          variable:
            jmesPath: "targetPlr.spec.pipelineRef.name || ((targetPlr.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: parentPipelineNamespace
          variable:
            jmesPath: "(targetPlr.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        - name: childNames
          variable:
            # Filter on apiVersion/kind: a childReference entry declares both, and a
            # bare name match would also accept e.g. a CustomRun sharing the name.
            # This API exposes no uid, so name + the parent UID check above + the
            # exact Pipeline/Task identity are the whole identity story here -- see
            # the trust-boundary note after this policy.
            jmesPath: "(targetPlr.status.childReferences || `[]`)[?apiVersion=='tekton.dev/v1' && kind=='TaskRun'].name"
      preconditions:
        all:
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ targetPlr.metadata.uid }}"
          - key: "{{ parentPipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ parentPipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: coverage-cancel-demo
          - key: "{{ parentPipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-coverage-emitter
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
          # At terminal status, missing/empty/non-numeric/out-of-range values all
          # fail closed. Unrelated tasks were already excluded by full TaskRef.
          - key: "{{ coverageViolates }}"
            operator: Equals
            value: true
          # the triggering TaskRun MUST be a real child of the target run
          - key: "{{ request.object.metadata.name }}"
            operator: AnyIn
            value: "{{ childNames }}"
      mutate:
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ parentName }}"
            uid: "{{ parentUID }}"
            namespace: "{{ request.namespace }}"
        patchStrategicMerge:
          metadata:
            annotations:
              # A cancellation with no reason on the object cannot be told apart
              # from a manual one afterwards (§4.0.6 / §6.2.3). Echo the trigger
              # and the value that violated, both resolved from this request.
              policy.alauda.io/cancel-reason: >-
                coverage gate not met on TaskRun {{ request.object.metadata.name }}:
                coverage-lines='{{ coverage }}'
          spec:
            status: CancelledRunFinally
```

:::

:::details 验证清单（六种违规形态 + 三个无误报对照）

**违规形态**（每种独立验证；每一种都必须在终态触发 fail-closed 取消）：`coverage-lines=30`（越界）、`not-a-number`（格式错误防护）、`101`（数值范围防护）、显式空字符串、以及到达终态却完全没写 `coverage-lines`。后两种分别证明"显式空值"与"缺失的 result"不会被当成早期 status 写入而静默跳过。

**第六种：同一 result 写两次**（由 `coverageResultCount` 防护拦住）。这一种**必须**由 `coverageViolates` 承载，不能塞进 `deny`——这条规则驱动的是 `mutate-existing`，格式错误的 status 必须走进**取消**路径才算 fail-closed：

| 注入的 `status.results` | 加防护之前 | 加防护之后 |
|---|---|---|
| 单个 `coverage-lines=30`（阳性对照） | 取消 | 取消 |
| `[coverage-lines=85, coverage-lines=30]`（干净诱饵在前） | **不取消** ← fail-open | 取消 |
| 单个 `coverage-lines=85`（无误报对照） | 不取消 | 不取消 |

**探针只有在冒充 Tekton 控制器时才有意义**：这条规则的 `match` 带着 `subjects: tekton-pipelines-controller`，用你自己的身份去 patch TaskRun status 意味着规则**根本不匹配**——连阳性对照都不会取消，很容易被误读成"策略没生效"。patch 之前加上 `--as=system:serviceaccount:tekton-pipelines:tekton-pipelines-controller`。（这顺带演示了 `subjects` 这道门确实挡住了业务身份直接伪造 status。）

**无误报对照**：

- 一个非数值 run 用 `taskRunSpecs` **伪造了全部**子 Run 的 pipeline / pipelineTask / pipelineRun label，但仍然只取消 owner 指向的它自己的父 run——证明策略不依赖这些 label；
- 另一个真正由控制器创建的子 Run 使用同一个可信 emitter，也产出 `coverage-lines=30`，但其父 Pipeline 的精确身份是 `coverage-cancel-unrelated`：它正常以 `Succeeded` 完成、未被取消，伴随的 Audit 记录了一次 skip——证明触发条件同时锁定了实时父画像与当前 TaskRef，而不是见到任何同名 result 就开火；
- 伪造 label 的 TaskRun 与无父的 TaskRun 由业务身份创建，但它们随后的 status 请求仍由 Tekton 控制器发出、确实会进入 context——最终因为 owner / 实时父 / 当前 TaskRef / childReferences 全部不成立而被安全跳过，各自正常完成。

**一次成功的取消长什么样**：目标父 run 的 `spec.status` 被 patch 成 `CancelledRunFinally` → 该 run 终态为 `Cancelled`，`sleeper` TaskRun 变为 `TaskRunCancelled`，finally 的 notify 照常运行。同一个 patch 还写入 `cancel-reason` annotation，**其变量从触发请求中解析而来**（读起来像 `coverage gate not met on TaskRun <emit TaskRun name>: coverage-lines='30'`）——这是事后**对象上**唯一能把策略取消与手工取消区分开的东西（[§6.2.3](#s6-2-3)；该 annotation 任何有写权限的人都能写——正向确认写入者要靠 API server 审计日志）。反向对照也要跑：**合规 run（`coverage-lines=85`）在 emit 到达终态后，必须既未被取消、也不带这条 annotation**——否则 annotation 就是在被无条件写入。

:::

:::warning annotation 内嵌不可信的原始文本，且终态不一定是 Cancelled

三个容易踩的坑：

- **`{{ coverage }}` 的内容不由策略决定**——由写 result 的那一方决定。把 `coverage-lines` 写成 `30' bad: injected` 或 `first\nsecond: value` 之类的内容后：patch 照常渲染，取消照常发生，而 annotation 里**逐字包含这段原始的惰性文本**（既不会变成 YAML 结构，也不会让 patch 失败）。**因此这条 annotation 是"策略生成的诊断信息 + 一段不可信的原始文本"**：前缀（哪条策略、为什么）是可信的；被引用的值只是证据材料——不要把它当成独立的审计结论，因为攻击者可以往里写任何看起来像结论的东西。
- **当 result 完全写不出来时，终态是 `Failed` 而不是 `Cancelled`**。把 result 撑到 4 KiB（超过 Tekton 的 result 容量）后：emit 步骤自身 `exited with code 1`，result 缺失 → 策略仍做出 fail-closed 裁决且 patch 成功（`spec.status=CancelledRunFinally`，annotation 也写了，值为空），但 **PipelineRun 的终态 reason 是 `Failed`**——因为在 Tekton 的裁决中，真实的任务失败优先级高于取消。**排障时不要只在终态 `Cancelled` 下找取消**：取消的证据是 `spec.status` 与 annotation；终态可能是 `Failed`（[§6.2.3](#s6-2-3)）。
- **落在子 TaskRun 初始化窗口内的取消同样以 `Failed` 收场**，而这一种与 result 是否写出无关。上面的 `sleeper` 在取消到达时通常刚被创建，Tekton 注入的 init 容器还在运行：如果取消打进这个窗口，TaskRun 的失败 reason 是 `InitContainerFailed`（不是 `TaskRunCancelled`），失败裁决再次优先于取消，父 run 终态为 `Failed`。**这并不代表策略没有动作**：`spec.status` 与 `cancel-reason` annotation 都在，判断方法仍按上一条。要稳定复现干净的 `Cancelled` 形态，用下面"关于并行形态"里的技巧——让 sleeper Pod 保持 Pending，这样就没有会失败的 init 容器，窗口也就不存在。

:::

**关于并行形态**：上面的 PipelineRun 保持了通用的并行形态。在容量受限的环境上（无法同时调度两个带 Tekton 注入 init 容器的 TaskRun Pod），可以用一个匹配不到任何节点的 `taskRunSpecs.podTemplate.nodeSelector` 让 sleeper Pod 保持 Pending，从而稳定验证"已创建的子 TaskRun 会被取消"——但要清楚**这并不能证明 Running 中的 Pod 会立即停止**。另外，把 `sleeper` 写成 `runAfter: emit` 会让"下游 Pod CREATE"与"父 run 被取消"竞速，你可能看到 TaskRun 已被取消而它并发创建的 Pod 仍在 Running。

:::warning 两条迁移边界

**① 父 run 已被删除时**，`apiCall` 会报 404 错误——对取消场景而言是 fail-safe（父都没了，本来也无可取消），但它会在后台控制器日志里留下错误行，**并同样推高指标 `rule_result="error"`**；排障时不必惊慌。也正因为这种正常竞态与真正的投递失败共享全部信号，[§3.7](#s3-7) 的监控项要求先按目标对象归因再分类——绝不能对裸的 `error` 增量直接告警（[§6.1](#s6-1)）。

**② 画像必须替换**：本例锁定的是来自 `targetPlr.spec.pipelineRef` 的精确画像与当前 `spec.taskRef`；迁移到真实模板时，换成该模板自己的完整身份——**不要改用 pipelineTask label 来收窄，`taskRunSpecs` 能覆盖它**。

:::

**一个姊妹变体（参数触发的取消）**：把 match 换成 `TaskRun` 的 **CREATE**、把覆盖率检查换成对展开后参数的检查，就得到"门禁参数不合规时取消父 run"——但 [§2.3](#s2-3) 契约 2 的主路径是直接对门禁 TaskRun 的 CREATE 做 Enforce deny（更简单、同步、失败形态固定为 `CreateRunFailed`）；只有当已启动的前序任务必须走 finally 清理时，取消变体才有附加价值（也就是 [§4.2.2](#s4-2-2)）。
#### 4.6.2 定义漂移触发的自我取消（自我指向，控制器身份约束） {#s4-6-2}

- **它治理什么**：**run 已经在跑、这时才发现门禁被人从模板里移除时，停掉这个 run 自己**。[§4.1.1](#s4-1-1) 只能校验"引用的是谁"，永远看不到定义的内容；只有当 resolver 把定义解析进 `status.pipelineSpec` 之后，才第一次看得到"那个可信扫描器还在不在里面"——不在了，就取消这个 run 自己。
- **难点在哪**：检测信号与 [§4.1.4](#s4-1-4) 的漂移 Audit 完全相同；差别在于这里会**真正取消**，所以身份约束不能放松：status 请求必须锁定为 Tekton 控制器 ServiceAccount——否则任何能写 status 的人都可以**伪造一次漂移事件**去取消别人的流水线。
- **策略如何分层**：① 匹配 `PipelineRun/status`，且写入者必须是控制器 SA → ② 在解析后的 `status.pipelineSpec` 里检查可信扫描器是否还在（**被移除或被换成别的 task** 都算漂移）→ ③ 命中即取消——目标直接取自当前请求对象（**自我指向**，无需跨 run 查找，因此天然没有 [§4.6.1](#s4-6-1) 那种认错父 run 的风险）。
- **它管不了什么**：这同样是**事后响应**——漂移只有在 run 已经启动之后才被发现；此前的副作用不会被回滚。

:::warning scan + 可信扫描器身份是该夹具画像的门禁形态，不是普适身份

与 [§4.1.4](#s4-1-4) 的漂移 Audit 一样，这条自我取消**必须按模板画像逐一配置**（按父 `PipelineRun.spec.pipelineRef` 分支，每个画像有自己的扫描器身份）；绝不要在没有防护的情况下对所有 run 断言同一种门禁形态——那会把使用其他门禁形态模板的一切都**误取消**。不要用 `tekton.dev/pipeline` label 顶替 spec 身份。

:::

:::details 完整策略 YAML：cancel-run-without-gate

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: cancel-run-without-gate
spec:
  webhookConfiguration:
    # Ignore, not Fail: this policy matches */status — a Kyverno outage must never
    # block the Tekton controller's status write-back (§2.2 red line; §3.7 tiering)
    failurePolicy: Ignore
  background: false
  rules:
    - name: self-cancel-on-missing-gate
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        - name: pipelineResolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: pipelineKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: tplName
          variable:
            jmesPath: "request.object.spec.pipelineRef.name || ((request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: pipelineNamespace
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        - name: pipelineSpecPresent
          variable:
            # Key presence avoids evaluating the rule before resolution. Tekton
            # rejects a valid Pipeline with no ordinary tasks, so an empty list
            # here is only a defensive malformed/synthetic-status boundary.
            jmesPath: "contains(keys(request.object.status || `{}`), 'pipelineSpec')"
        # Same full resolved identity as §4.1.4; name-only comparison is fail-open.
        # Nothing in the CRD dedupes this list by name, so two tasks named scan
        # survive admission and [0] would only see the first. Count, then read.
        - name: scanTaskCount
          variable:
            jmesPath: "length((request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'])"
            default: 0
        - name: scanTaskRef
          variable:
            jmesPath: "(request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'] | [0].taskRef || `{}`"
        - name: scanResolver
          variable:
            jmesPath: "scanTaskRef.resolver || ''"
            default: ""
        - name: scanKind
          variable:
            jmesPath: "(scanTaskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: scanName
          variable:
            jmesPath: "scanTaskRef.name || ((scanTaskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: scanNamespace
          variable:
            jmesPath: "(scanTaskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Same one-level-down count guard as §4.1.4: inside the resolver taskRef,
        # `params` is an ordinary list in status, so a decoy entry in front of the
        # real one would win every [0] above. (In `spec` Tekton's own webhook
        # rejects two params sharing a name; status carries no such guarantee.)
        - name: scanRefParamsUnique
          variable:
            jmesPath: >-
              length((scanTaskRef.params || `[]`)[?name=='kind']) == `1` &&
              length((scanTaskRef.params || `[]`)[?name=='name']) == `1` &&
              length((scanTaskRef.params || `[]`)[?name=='namespace']) == `1`
        - name: scanIdentityValid
          variable:
            # The counts are folded in here rather than added as separate
            # conditions: the preconditions below use `all:`, so an extra condition
            # would relax the rule instead of tightening it.
            jmesPath: >-
              scanTaskCount == `1` && scanRefParamsUnique &&
              scanResolver == 'cluster' && scanKind == 'task' &&
              scanName == 'policy-demo-scanner' &&
              scanNamespace == 'tekton-templates'
        - name: governedProfile
          variable:
            # The second name is the deliberately drifted fixture used for the
            # negative test. Production should list only governed identities.
            jmesPath: "contains(['gated-build','gated-build-rogue'], tplName)"
      preconditions:
        all:
          # Evaluate only after resolution materialized pipelineSpec. The gate
          # check itself is scanIdentityValid; do not infer it from task count.
          - key: "{{ pipelineSpecPresent }}"
            operator: Equals
            value: true
          - key: "{{ pipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ pipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ pipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          # PROFILE guard: only the governed fixture profiles. Other templates use
          # their own gate shape and must be governed per-profile.
          - key: "{{ governedProfile }}"
            operator: Equals
            value: true
          # DRIFT = any field of the mandatory scanner identity changed.
          - key: "{{ scanIdentityValid }}"
            operator: Equals
            value: false
          # Idempotency: skip once spec.status is already set. Deliberately tests
          # for EMPTY rather than for the cancel values -- the field's other legal
          # value, PipelineRunPending, means "not started yet", and a run that has
          # not started has nothing to cancel. Either way the direction is skip
          # (fail-open); a pending run gets re-evaluated on the status update that
          # follows once it actually starts.
          - key: "{{ request.object.spec.status || '' }}"
            operator: Equals
            value: ""
      mutate:
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ request.object.metadata.name }}"
            uid: "{{ request.object.metadata.uid }}"
            # Single namespace: use a literal; cross-namespace: change to "{{ request.namespace }}"
            # and grant §4.6's aggregated ClusterRole instead (trade-offs in §4.2.2)
            namespace: policy-poc
        patchStrategicMerge:
          metadata:
            annotations:
              policy.alauda.io/cancel-reason: >-
                resolved scan task drifted from the approved full Task identity
          spec:
            status: CancelledRunFinally
```

:::

:::details 用于验证的阳性与阴性 PipelineRun

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: self-cancel-compliant
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
    - name: demoDelaySeconds
      value: "1"
---
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: self-cancel-rogue
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build-rogue
      - name: namespace
        value: tekton-templates
```

:::

**预期形态（多路对比）**：

- 正常的 `gated-build`（`scan` → `cluster/task/tekton-templates/policy-demo-scanner`）到达终态 `Succeeded`，`scan / release / notify` 全部成功；
- 漂移夹具 `gated-build-rogue` **保持完全相同的 Task 名字** `policy-demo-scanner`，只把 namespace 换成 `policy-poc`——解析之后完整身份检查仍能识破：父 run 被 patch 为 `CancelledRunFinally`，终态 `Cancelled`，运行中的 `prep` 得到 `TaskRunCancelled`，`scan / release` 被跳过，finally 的 `notify` 成功，cancel-reason annotation 在场；
- 整体移除夹具（删掉 `scan`，保留普通的 `prep`）同样被取消，finally 成功；
- 由**非控制器身份**提交的 status 子资源对照，既没有被设置 `spec.status`，也不带取消 annotation，更没有产生任何后台 mutation——证明 subject 约束成立；
- 只有**带 finally 段但普通 tasks 为空**的定义会被 Tekton 准入直接拒绝；那不是自我取消策略所能处理的正常运行路径。

**时序说明**：触发发生在**解析之后**，所以早期任务可能已经启动——这是"尽早取消"，不是"阻止启动"；要阻止启动，用 [§4.1](#s4-1) 的准入白名单。

#### 清理（§4.6）

按 [§4.0.4](#s4-0-4) 的两条规则，集群级对象按归属台账中记录的 UID 删除——本节除了两条策略之外还有一个 `ClusterRole`，删 namespace 同样带不走它：

```bash
for pol in cancel-on-failed-verdict cancel-run-without-gate; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
# The §4.2.2 alternative (namespaced Role / RoleBinding) belongs to §4.2's namespace and
# cascades with it -- do not delete twice.
delete_owned_cluster_object clusterrole kyverno-background-update-pipelineruns
```

namespaced 对象（四个演示 PipelineRun，加上 `tekton-templates` 里的 `Pipeline/coverage-cancel-demo` 与 `Task/policy-demo-coverage-emitter`）由自建 namespace 的级联回收；如果你还要继续后面的小节，先按名字删掉这四个 run，避免 PolicyReport 干扰（[§4.0.5](#s4-0-5)）：

```bash
kubectl delete pipelinerun -n policy-poc cancel-low-coverage-demo \
  cancel-missing-coverage-demo self-cancel-compliant self-cancel-rogue \
  --ignore-not-found
```
## 5. 范围控制 {#s5}

不同项目需要不同的约束，但**范围控制的实现方式决定了策略体系是否留下可被绕过的漏洞**。本章把 [§1.3](#s1-3) 的两层模型落成可运行的策略。

**先读 [§5.0](#s5-0)**：本章（乃至全文）的每一条保证都建立在"能修改策略体系的人是受控的"之上——范围写得再紧，任何能修改策略、签发豁免、改动范围标签或改动 Kyverno 自身配置的身份，都能整体绕过它。这正是这个信任根被放在本章开头、而不是埋在末尾的原因。

### 5.0 策略体系的自我保护（先读这一节） {#s5-0}

范围治理的根基是：能修改策略体系的人是受控的。这并不意味着每条策略都只能由平台管理员维护；权限应当按资源范围分层：

- **ClusterPolicy**：只有平台管理员可以创建、修改和删除。不应把这项权限授予项目管理员——否则他们可能影响其他项目，或拆掉平台基线；
- **Policy**：可以下放给指定的项目管理员，RBAC 只允许在自己的 namespace 内创建、修改和删除。普通业务开发者默认不应拥有这项权限——**能改项目 `Policy` 的人就能改项目的门禁**；
- **PolicyException**（**能创建 / 修改豁免对象 = 能放行**）——也就是对 [§5.3](#s5-3) 中 `--exceptionNamespace` 指向的 namespace 的写权限；
- **namespace 上的范围标签**（如 `cpaas.io/project`）——**能改标签 = 能把一次运行移入或移出某一层约束**。首选用 RBAC 封住谁能修改 `Namespace`；确实需要更细的按身份控制时，Kyverno 也可以校验 `Namespace` 的 UPDATE，锁住对这些标签的改动（userInfo / 创建者白名单，写法同 [§4.5.4](#s4-5-4)）。
- **Kyverno 自身的运行时配置**（`kyverno` namespace 里的 `kyverno` ConfigMap）——**它在链条上比任何策略都更靠前，也更安静**。它的 `resourceFilters` 在任何策略被查询之前就生效：被过滤的请求不会被拒绝、不落任何 PolicyReport、不留一行日志（见 [§3.1](#s3-1) 清单第 7 项）。加一条覆盖某个 namespace 或 `PipelineRun` 的过滤条目，等于**为整章策略开了一个豁免口子——没有 TTL、没有痕迹、也没有 [§5.3](#s5-3) 的审批流程**——所以对这个 ConfigMap 的写权限必须与 `ClusterPolicy` 同级看待，并纳入变更审计。
- **Kyverno 的 webhook 对象及其生成来源配置**——`ValidatingWebhookConfiguration` 由 Kyverno 自己维护（[§3.1](#s3-1) 清单第 6 项），但**能把它的 `failurePolicy` 翻成 `Ignore`、缩小其匹配面、或干脆删掉它的身份，实际上已经拿到了对本文全部准入保证的拆除权**：模板白名单（[§4.1.1](#s4-1-1)）、门禁参数契约（[§4.2.1](#s4-2-1)）、裸 Run 入口封闭（[§4.5.4](#s4-5-4)）、Pod 层镜像白名单（[§4.5.3](#s4-5-3)）会同时坠入策略真空，而表面上集群读起来是"策略都还在、都还 Ready"。所以不要只保护 `ClusterPolicy`——**Kyverno 的部署入口（[§3.1.1](#s3-1-1) 的 `ModuleInfo`）、它的 ConfigMap、它的 webhook 对象是同一条信任链上的三个环节，必须一起管控。**

**本节给出的是权限边界，不是变更历史**：上面各项保证的是"**现在**谁能改什么"，而审计通常要问的是"某次发布当时**实际生效**的是哪些策略、豁免和 Kyverno 配置"——这个问题**无法从集群里得到回答**：你查到的永远是当前对象，无法排除中间发生过短暂的放松、替换再改回。要能回答它，必须在部署时钉下两个锚点：① **所有策略与豁免都走 GitOps**（版本历史即变更历史——[§3.6](#s3-6) 已有此要求；PolicyException 用审批日期 / 工单号命名，[§5.3](#s5-3)）；② **Kubernetes API server 的审计日志**——唯一能证明"该对象在某时间窗口内被创建 / 修改 / 删除"的来源，但**它是否开启、保留多久取决于你的环境**——写进审计判据之前先确认。

**进阶（`generate`；本文不展开）**：`generate` 规则可以为每个新建的项目 namespace 自动铺设一条 namespaced `Policy`，让新项目自动继承一套基线。生命周期管理（同步、删除）较复杂；引入前先评估。

### 5.1 范围匹配方式 {#s5-1}

| 方式 | 匹配什么 | 典型用途 |
|---|---|---|
| namespaced `Policy` 的 `metadata.namespace` | 仅该 namespace 内的资源 | 项目管理员自助收紧；不需要 `ClusterPolicy` 权限 |
| `match.resources.namespaces` | namespace 名字（字面量 / 通配符） | 在少量固定 namespace 中精确圈定范围 |
| `namespaceSelector` | **Namespace 自身的 label** | 平台集中管理策略时，按项目 label 做每项目差异化 |
| `exclude.resources.namespaces` | namespace 名字 | 从"全部"中剜出系统 namespace（平台基线的主力） |
| `match.resources.selector` | **被校验资源自身的 label** | 按 PipelineRun / TaskRun 自己的 label 细分 |

### 5.2 两层治理模型 {#s5-2}

- **它治理什么**：让平台基线覆盖每一个业务 namespace，同时允许各项目在其上**收紧**。
- **难点在哪**：基线**不能**依赖"这个 namespace 带某个标签"——新建的、未打标签的、被改过标签的 namespace 会自然而然逃出基线。
- **策略如何分层**：① 基线 `match` 所有 namespace + 用**负向 `exclude`** 剜出系统 namespace → ② 收紧用**正向 `namespaceSelector`**（平台管理）或 namespaced `Policy`（项目自助）→ ③ 多条策略匹配同一资源时关系是 **AND**——收紧只能更紧，不能放松。
- **它管不了什么**：修改范围标签本身的权限不在这一层——那属于 RBAC，或 [§5.0](#s5-0) 的策略体系自我保护。

**基线**：匹配所有 namespace，并 `exclude` 系统 namespace。下面的规则体用一个 annotation 探针代替真实约束（做真实基线时，换成 [§4.1](#s4-1)–[§4.5](#s4-5) 中任意一条硬约束）：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-baseline
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: baseline-for-every-business-namespace
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
      exclude:
        any:
          - resources:
              namespaces:
                - kube-system
                - kube-public
                - kube-node-lease
                - kyverno
                - tekton-pipelines
                - tekton-operator
                - cpaas-system
      validate:
        failureAction: Enforce
        message: "baseline pipeline policy applies in every business namespace (labeled or not)."
        deny:
          conditions:
            all:
              - key: "{{ request.object.metadata.annotations.\"policy.test/violate-baseline\" || '' }}"
                operator: Equals
                value: "true"
```

**平台管理的每项目收紧**：当项目策略由平台团队集中维护时，可以用 `namespaceSelector` 只选中打了 `cpaas.io/project: alpha` 标签的 namespace，在其上叠加更严的规则：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: project-alpha-tightening
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: alpha-extra-restriction
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaceSelector:
                matchLabels:
                  cpaas.io/project: alpha
      validate:
        failureAction: Enforce
        message: "project alpha forbids this (per-project tightening on top of the baseline)."
        deny:
          conditions:
            all:
              - key: "{{ request.object.metadata.annotations.\"policy.test/violate-project\" || '' }}"
                operator: Equals
                value: "true"
```

**先创建三个探针 namespace**——本节的六个探针格子完全依赖它们的标签差异，`rogue-ns` 不带标签本身就是其中一个格子。防护与 [§3.3](#s3-3) 一致：已存在的 namespace 会被原样放过、不打标记，因此下面的清理不可能删到它：

```bash
# $WALKTHROUGH_ID comes from §3.3. In a fresh shell, re-export the value you wrote
# down there. This line stops the loop if it is unset -- otherwise the label would be
# written with an empty value and the cleanup would later refuse to touch it.
# Deliberately an if, not `: "${WALKTHROUGH_ID:?...}"` and not `exit 1`: pasted into
# an interactive shell the first only prints and lets the next line run anyway, and
# the second closes your terminal.
if [ -z "${WALKTHROUGH_ID:-}" ]; then
  echo "WALKTHROUGH_ID is unset -- run the namespace block in §3.3 first, or re-export the id it printed"
else
  for spec in proj-a:alpha proj-b:beta rogue-ns:; do
    name=${spec%%:*}; project=${spec#*:}
    if ! out=$(kubectl get namespace "$name" -o name --ignore-not-found 2>&1); then
      echo "$name: CHECK FAILED ($out)"
    elif [ -n "$out" ]; then
      # Same STOP as §3.3: the cleanup below is a namespace cascade, and a namespace
      # this run did not create has no removal path -- runs you create in it (if you
      # switch the probes from dry-run to real creates) would be stranded.
      echo "$name: pre-existing -- STOP: pick your own namespace names (§4.0.4) and"
      echo "  substitute them in the probes and the cleanup below."
    elif ! kubectl create namespace "$name" >/dev/null 2>&1; then
      echo "$name: create failed -- do NOT label it, and treat it as pre-existing (STOP)"
    elif ! kubectl label namespace "$name" "policy.alauda.io/walkthrough=$WALKTHROUGH_ID" >/dev/null; then
      # Same as §3.3: unlabelled means the cleanup loop below will skip it. The
      # namespace is seconds old, empty, and certainly yours -- delete it by hand
      # and re-run this loop rather than going on without the marker.
      echo "$name: created but LABEL FAILED -- the cleanup loop will not touch it."
      echo "  Run: kubectl delete namespace $name   # then re-run this loop"
    elif [ -n "$project" ] && ! kubectl label namespace "$name" cpaas.io/project="$project" >/dev/null; then
      # The project label is what the six probe cells below discriminate on: if it did
      # not land, the table's expectations no longer describe this namespace.
      echo "$name: created but PROJECT LABEL FAILED -- do not run this section's probes yet"
    else
      echo "$name: created project=${project:-<none, on purpose>}"
    fi
  done
fi

kubectl get namespace proj-a proj-b rogue-ns \
  -o custom-columns='NAME:.metadata.name,PROJECT:.metadata.labels.cpaas\.io/project'
# Expect alpha / beta / <none>. A project value on rogue-ns invalidates the last two
# rows of the table below -- the tightening would then legitimately apply to it, and
# "Allowed" would be the wrong expectation rather than a policy bug.
```
**如果上面的输出是 "WALKTHROUGH_ID is unset"**：本节后续每条命令都会报 namespace 不存在或探针失败——那是**准备工作没做完**，不是策略判错。回到 [§3.3](#s3-3)，把那个代码块跑一遍（或把你记下的 id 重新 `export`），再继续。我们刻意不给后续每条命令都包一层检查：那会把整节变成流程控制而不是可读的演练，而且这种失败是**吵闹的**（一眼可见的 NotFound），不是静默的。

**然后安装上面两条策略**——它们是本节的被测对象；不装它们就跑探针，六个格子会全部返回 **Allowed**，看起来和"策略写错了"一模一样：

```bash
# Save the two YAML blocks above as pipeline-baseline.yaml and
# project-alpha-tightening.yaml. `create`, not `apply` (§4.0.4): a same-named
# ClusterPolicy is somebody else's governance rule, and overwriting it is a
# cluster-wide change -- an AlreadyExists here means STOP, not retry.
create_owned_cluster_object pipeline-baseline.yaml clusterpolicy
create_owned_cluster_object project-alpha-tightening.yaml clusterpolicy

# A policy that is not Ready does not evaluate, so an unready one would make every
# probe cell below read "Allowed" for a reason that has nothing to do with scoping.
kubectl wait --for=condition=Ready clusterpolicy/pipeline-baseline --timeout=60s
kubectl wait --for=condition=Ready clusterpolicy/project-alpha-tightening --timeout=60s
```

**验证探针**（namespace：带 `cpaas.io/project=alpha` 的 `proj-a`、带 `=beta` 的 `proj-b`、不带标签的 `rogue-ns`）：

| 探针 | 预期 |
|---|---|
| 违反基线 @ `rogue-ns`（无标签） | 拒绝（基线不看标签） |
| 违反基线 @ `proj-a` | 拒绝 |
| 违反基线 @ `tekton-operator`（已被排除） | 放行 |
| 违反项目规则 @ `proj-a` | 拒绝（收紧生效） |
| 违反项目规则 @ `proj-b`（另一个项目） | 放行 |
| 违反项目规则 @ `rogue-ns`（无标签） | 放行 |

**关键结论**：基线建立在负向 `exclude` 上，未归类的 namespace **无处可逃**；收紧建立在正向 `namespaceSelector` 上，只作用于目标项目。多条策略匹配同一资源时关系是 AND——`proj-a` 里的一次运行同时受基线与收紧约束。

**项目管理员的自助治理**：上面的 `project-alpha-tightening` 只是平台管理的写法。在项目自治模型下，把同样的 `spec.rules` 放进 `kind: Policy`，把 `metadata.namespace` 设为项目 namespace，并从规则里去掉 `namespaceSelector`（namespaced `Policy` 天然只作用于所在 namespace）；`spec.webhookConfiguration` 的分层声明原样保留——namespaced `Policy` 支持同一字段，生成的 webhook 也按值同样分组。平台 RBAC 只授予指定项目管理员在其 namespace 内管理 `Policy` 的权利，**不授予 `ClusterPolicy` 权限**。前提是 Kyverno 已由平台安装、且项目角色已被授予本 namespace 内 `policies.kyverno.io` 的管理权限；这一次性的平台配置完成后，项目管理员日常调整规则不再需要平台管理员角色。

| 部署模式 | 策略资源 | 维护者 | 生效范围 |
|---|---|---|---|
| 平台基线 | `ClusterPolicy` | 平台管理员 | 所有业务 namespace，系统 namespace 以负向方式排除 |
| 平台管理的每项目收紧 | `ClusterPolicy` + `namespaceSelector` | 平台管理员 | selector 匹配到的 namespace |
| 项目自助收紧（推荐的项目管理员路径） | `Policy` | 项目管理员 | `metadata.namespace` 指定的单个 namespace |

`Policy` 对已匹配的 `ClusterPolicy` **只能收紧，不能覆盖或关闭**——每条匹配到的 validate 规则都必须通过。它也管不了 `Namespace` 这类集群级资源；本文的 PipelineRun、TaskRun、Pod 都是 namespaced 资源，所以主要的 validate / mutate 场景都可以用 `Policy` 实现。当规则用到 `mutate-existing` 或 `generate`、需要为 Kyverno 控制器追加 RBAC 时，这份控制器 RBAC 仍由平台管理员预先审批并授予——项目管理员不得借自助策略获得跨 namespace 或集群级权限。

**平台强制的要求不得只放在项目自己就能修改或删除的 `Policy` 里**——它们必须留在平台管理的 `ClusterPolicy` 资源中；项目 `Policy` 承载的是项目自己可自主调整的收紧规则。

#### 清理（§5.2）

按 [§4.0.4](#s4-0-4) 的两条规则清理。**六个探针格子没有留下任何要清理的对象**——按 [§3.4.1](#s3-4-1)，它们都是 `kubectl create --dry-run=server`，从不持久化任何东西；只有当你换成了真实 `create` 时才会留下 run，而那些会被下面的 namespace 级联回收。

先删两条集群级策略（两条都是 Enforce——漏删一条它就会继续裁决所有人的准入请求，所以读一下输出，别让失败静默滚过去）：

```bash
for pol in pipeline-baseline project-alpha-tightening; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
```

按创建循环打上的标记删除三个 namespace——**先前已存在的不带标记，这个循环碰不到它们**：

```bash
# Per namespace, with THIS run's id as the precondition -- §3.3's two carry the same
# label key and must NOT go yet, so a blanket label selector would be wrong here.
# (kubectl also refuses a label selector together with resource names.)
for ns in proj-a proj-b rogue-ns; do
  if ! json=$(kubectl get namespace "$ns" -o json 2>&1); then
    case "$json" in
      *NotFound*) echo "$ns: gone already -- nothing to do" ;;
      # Forbidden and a connection error must not read as "gone": an unreadable
      # namespace is not a deleted one, and walking away here would leave it (and
      # everything in it) behind while the output reads like a finished pass.
      *) echo "$ns: could not be read -- $json"
         echo "  Left alone. Resolve the read error and run this loop again." ;;
    esac
    continue
  fi
  # jq's exit code too: a parse failure would produce an empty marker, and the branch
  # below would then report a labelling mistake that never happened.
  if ! marker=$(printf '%s' "$json" | jq -r '.metadata.labels."policy.alauda.io/walkthrough" // ""'); then
    echo "$ns: could not parse the namespace JSON -- left alone"
    continue
  fi
  if [ -n "${WALKTHROUGH_ID:-}" ] && [ "$marker" = "$WALKTHROUGH_ID" ]; then
    # The label check is the ownership evidence (§4.0.4): only a namespace THIS run
    # created and marked gets deleted, cascade and all.
    kubectl delete namespace "$ns"
  else
    echo "$ns: label '${marker:-<none>}' is not this run's id '${WALKTHROUGH_ID:-<unset>}' -- left alone"
  fi
done
```
### 5.3 PolicyException 受控豁免 {#s5-3}

- **它治理什么**：当某条流水线确实需要在一段时间内绕过某个门禁（紧急发布、稍后补齐覆盖）时，使用**受控豁免**——不要把"见到某个 label 就放行"写进策略。
- **它为什么难**：**豁免的匹配键绝不能是任何业务可控的东西。** PipelineRun 的名称、它的 labels 以及 `spec.taskRunSpecs[].metadata.labels` 都是业务输入；而且 Tekton 还允许 `taskRunSpecs` 中的同名值覆盖并传播到子 TaskRun 的 labels 上。把这些字段当作审批凭证 = 自助绕过。
- **策略如何分层**：① 用一个**专用执行 namespace** 作为豁免边界——PolicyException 只匹配该 namespace 内的 TaskRun → ② 用 Enforce 策略锁住该 namespace 的**每一个运行入口**：谁可以创建 / 更新 PipelineRun、谁可以创建 TaskRun、以及**谁可以创建 CustomRun**（三类入口漏掉任何一类，就给自助绕过留了一扇门——推理同 [§4.5.4](#s4-5-4)）→ ③ PolicyException 精确到"某个策略的某一条规则"；其他每条规则照常拦截。
- **它治理不了什么**：PolicyException 原生**没有 TTL**——对象一旦创建就永久生效；"临时"这个词背后没有任何机械机制兜底。**到期清理要由你自己实现**，而三个可落点各有代价：① 在审批流程里挂一个到期任务（最直接，但依赖流程纪律）；② 用 Kyverno 的清理能力在到期时刻删除该对象（不需要人盯，但意味着要多安装并验证一条清理策略——**本文档既不提供也未验证该资产**）；③ 把到期日期硬编码进名称和 labels（本节签发命令中建议的 `<yyyymmdd>-<seq>` 命名正是为此而存在），再靠周期性审查把过期项翻出来（最轻量，但它只能发现——不会清理）。三个都不选 = 豁免就是永久的；[§3.6](#s3-6) 中"某个 PolicyException 到期未被清理"那一行描述的正是这种情形。

**分层使用**：上面四条要点是安全模型——只要你安装豁免，它们就必须作为整体成立；本节后文的签发命令，加上对传播延迟、吊销与清理的完整验证，属于**运维证据层**——首次启用和周期性审计时执行；日常签发只需要签发命令加到期清理。如果你不需要豁免，就不要打开平台开关（[§3.1.1](#s3-1-1)）——整节可以作为一个单元保持不安装。

:::warning RBAC 是叠加的——"没有显式 RoleBinding"不等于被拒绝

为审批者身份添加 Role **无法收回**业务身份从 ACP 基线 ClusterRole 已经持有的 PipelineRun 权限。真实环境中，业务 ServiceAccount 在新建的 namespace 里通常已经拥有 create 权限，所以下面的 Enforce 策略必须**叠加在** RBAC 之上——不能把"没有 RoleBinding"当作被拒绝的证据。

:::

本节使用两个 namespace：`policy-exempt-runs`（豁免执行边界）与 `policy-exceptions`（只存放 `PolicyException` 对象）。**后者通常在平台配置 `--exceptionNamespace` 时就已存在**，是别人的受信 namespace——所以照旧只创建不存在的那个，只给自己创建的打标签。

**先读出平台实际信任的是哪个 namespace**，再决定是否创建：读得太晚，你可能已经白建了一个 namespace——然后不得不回头改本节每一份 YAML 里的 `namespace`。

```bash
# The PolicyException below is only honoured inside the namespace Kyverno was told to
# trust. Read that first -- an exception outside the trusted namespace is created
# happily and then does nothing, and you would read "still denied" as a cache or
# policy problem. If it names something other than policy-exceptions, do NOT create
# your own. The rule: substitute it everywhere §5.3 uses `policy-exceptions` AS A
# VALUE -- in a command, a YAML field, or a resource path. Prose that merely talks
# about the default name (this comment, the Expect note below, the Chinese text)
# keeps the literal: it describes the name rather than acting on it. The value sites
# are
#   1. both `for ns in ...` loops (the creation one just below, and the cleanup one)
#      -- drop it from both lists, since the namespace already exists;
#   2. `metadata.namespace` in the PolicyException YAML and in the approver
#      Role / RoleBinding YAML;
#   3. every `-n policy-exceptions` in this section's commands (the six steps AND
#      the cleanup).
# `policy-exempt-runs` is a DIFFERENT namespace and is NOT affected -- that one is
# this document's own, and you do create it.
kubectl -n kyverno get deploy kyverno-admission-controller \
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}' | tr ',' '\n' | grep -i exception
# Expect TWO lines: --enablePolicyException=true, and --exceptionNamespace=<a name>.
# Whatever that second line prints IS the trusted namespace -- this document writes
# policy-exceptions throughout because that is what §3.1.1 configures, but do not
# expect that literal: the printed value is the answer, not a value to match against.
# Only the first line printed is the untouched ACP default (measured) -- then this
# whole section cannot work yet: go do §3.1.1 first.
```

确认之后再创建 namespace：

```bash
# $WALKTHROUGH_ID comes from §3.3; re-export the value you wrote down if this is a
# fresh shell. Same guard as §5.2: an empty id would produce a marker nobody can claim.
# Deliberately an if, not `: "${WALKTHROUGH_ID:?...}"` and not `exit 1`: pasted into
# an interactive shell the first only prints and lets the next line run anyway, and
# the second closes your terminal.
if [ -z "${WALKTHROUGH_ID:-}" ]; then
  echo "WALKTHROUGH_ID is unset -- run the namespace block in §3.3 first, or re-export the id it printed"
else
  for ns in policy-exempt-runs policy-exceptions; do
    if ! out=$(kubectl get namespace "$ns" -o name --ignore-not-found 2>&1); then
      echo "$ns: CHECK FAILED ($out)"
    elif [ -n "$out" ]; then
      # The two namespaces differ here. policy-exceptions pre-existing is the NORMAL
      # case (the platform's trusted namespace): it gets no label, the cleanup's
      # namespace loop leaves it alone, and the demo exception inside it is deleted
      # by name. policy-exempt-runs is this document's own execution boundary: the
      # cleanup cascades it, so a pre-existing one has no removal path -- STOP.
      if [ "$ns" = policy-exceptions ]; then
        echo "$ns: pre-existing -- fine (the platform's trusted namespace); it will not"
        echo "  be labelled, and the cleanup will not delete it"
      else
        echo "$ns: pre-existing -- STOP: this walkthrough must own $ns (§4.0.4)."
        echo "  Finish the earlier walkthrough that left it behind, or pick another name"
        echo "  and substitute it in this section's YAML and commands."
      fi
    elif ! kubectl create namespace "$ns" >/dev/null 2>&1; then
      echo "$ns: create failed -- do NOT label it, and treat it as pre-existing"
    elif ! kubectl label namespace "$ns" "policy.alauda.io/walkthrough=$WALKTHROUGH_ID" >/dev/null; then
      # Same as §3.3 and §5.2: unlabelled means the cleanup loop skips it, and a
      # re-run reads it as pre-existing and skips it again. It is seconds old, empty,
      # and certainly yours -- delete it by hand and re-run this loop.
      echo "$ns: created but LABEL FAILED -- the cleanup loop will not touch it."
      echo "  Run: kubectl delete namespace $ns   # then re-run this loop"
    else
      echo "$ns: created"
    fi
  done
fi
```
**如果上面的代码块打印了 "WALKTHROUGH_ID is unset"**：本节后面的每条命令都会报 namespace 缺失或探针失败——那是**准备工作未完成**，不是策略裁决出错。回到 [§3.3](#s3-3)，把那个代码块执行一次（或重新 `export` 你记下的 id），再继续。我们有意不给后续每条命令都套一层守卫：那会把整节变成流程控制而不是可读的演练，而且这种失败是**吵闹的**（NotFound 一眼可见），不是静默的。

:::details 完整策略 YAML：exempt-namespace-approver-only（四条规则）

```yaml
# The exception namespace is a trusted execution boundary. RBAC grants the
# approver's positive permission; this policy supplies the negative boundary
# even when platform baseline ClusterRoles already grant broader access.
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: exempt-namespace-approver-only
spec:
  webhookConfiguration:
    failurePolicy: Fail
  background: false
  rules:
    - name: only-approver-creates-exempt-runs
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-exempt-runs
      validate:
        failureAction: Enforce
        message: >-
          Only the designated policy approver may create PipelineRuns in the
          exception target namespace.
        deny:
          conditions:
            all:
              - key: "{{ request.userInfo.username }}"
                operator: AnyNotIn
                value:
                  - <approver-identity>
    - name: only-trusted-identities-update-exempt-runs
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - UPDATE
              namespaces:
                - policy-exempt-runs
      validate:
        failureAction: Enforce
        message: >-
          Only the approver or the required Tekton control-plane controllers may
          update PipelineRuns in the exception target namespace.
        deny:
          conditions:
            all:
              - key: "{{ request.userInfo.username }}"
                operator: AnyNotIn
                value:
                  - <approver-identity>
                  - system:serviceaccount:tekton-pipelines:tekton-pipelines-controller
                  - system:serviceaccount:tekton-pipelines:tekton-chains-controller
                  # When Tekton Results is enabled, append the exact live
                  # watcher identity discovered from its Deployment.
    - name: only-tekton-controller-creates-exempt-taskruns
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-exempt-runs
      validate:
        failureAction: Enforce
        message: >-
          Only the Tekton Pipelines controller may create TaskRuns in the
          exception target namespace.
        deny:
          conditions:
            all:
              - key: "{{ request.userInfo.username }}"
                operator: AnyNotIn
                value:
                  - system:serviceaccount:tekton-pipelines:tekton-pipelines-controller
    # CustomRun is a second, equivalent run entry point (§4.5.4). Leaving it out
    # here would let any identity that kept CustomRun create through cumulative
    # baseline RBAC walk into the trusted namespace without approver admission.
    # v1beta1 is the only group version Tekton registers for this type -- see the
    # note in §4.5.4; do not "align" it with the v1 kinds used elsewhere.
    - name: only-tekton-controller-creates-exempt-customruns
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1beta1/CustomRun
              operations:
                - CREATE
              namespaces:
                - policy-exempt-runs
      validate:
        failureAction: Enforce
        message: >-
          Only the Tekton Pipelines controller may create CustomRuns in the
          exception target namespace.
        deny:
          conditions:
            all:
              - key: "{{ request.userInfo.username }}"
                operator: AnyNotIn
                value:
                  - system:serviceaccount:tekton-pipelines:tekton-pipelines-controller
```

:::

:::warning 上面的 ServiceAccount 身份必须对照你的环境核实

如果你的安装 namespace 或控制器 SA 名称不同，请替换；**不要照抄未安装的可选组件的身份**。不要凭记忆检查——把两个身份都读出来：

```bash
# TEKTON_NS comes from §3.1; the line below only covers a fresh shell. Print the
# identity string in the exact form the policy wants, so it can be pasted verbatim
# instead of assembled by hand.
: "${TEKTON_NS:=tekton-pipelines}"
kubectl get deploy -n "$TEKTON_NS" tekton-pipelines-controller \
  -o jsonpath='system:serviceaccount:{.metadata.namespace}:{.spec.template.spec.serviceAccountName}{"\n"}'

# Results watcher: only if Tekton Results is enabled. NO OUTPUT means the Deployment
# does not exist -- then leave that identity OUT of the list rather than adding it
# "just in case" (an identity that exists nowhere still widens the exemption if the
# component is installed later under that name).
kubectl get deploy -n "$TEKTON_NS" tekton-results-watcher --ignore-not-found \
  -o jsonpath='system:serviceaccount:{.metadata.namespace}:{.spec.template.spec.serviceAccountName}{"\n"}'
```

第一条命令打印的正是要放进允许清单的完整身份（形如 `system:serviceaccount:tekton-pipelines:tekton-pipelines-controller`，namespace 取自实际部署）；第二条命令没有输出则说明 Tekton Results 未启用——正是下一段里"未启用时把该身份排除在清单之外"的情形。

`tekton-results-watcher` **仅在启用 Tekton Results 时适用**：它需要更新 PipelineRun 以管理 `results.tekton.dev/pipelinerun` finalizer，而**漏掉一个真实存在的 watcher 会阻塞归档后的 finalizer 清理，把正在删除的运行卡死**。启用时，把线上 Results watcher Deployment 的确切 ServiceAccount 追加到 `only-trusted-identities-update-exempt-runs` 的 `value` 列表；未启用时（`TektonConfig.spec.result.disabled=true`——Deployment 和 ServiceAccount 都不存在），把该身份排除在清单之外。

:::

本节六个步骤之间会写入几份**本地状态文件**（`gate-snapshot.txt`、`step3-verdict.txt`、`step4-verdict.txt`、`step6-delete.txt`、`step6-revocation.txt`、`exemption-id.txt`、`exemption-uid.txt`、`exemption-intent.txt`、`cleanup-exception-gone.txt`）——它们记录验证进行到了哪里、裁决是什么，方便你换一个终端接着做；**开始前把上一轮的文件全部删掉**（`rm -f` 即可），免得把上一轮的裁决或残留的 `yes` 当成本轮自己的读进来。

**身份核实无误后再安装这条入口锁策略**——它是本节步骤 ② 的被测对象。没有它，业务身份创建 PipelineRun 会**径直成功**，而正如 [§5.3](#s5-3) 开头的警告已经说过的，ACP 基线 RBAC 通常本来就允许这个创建——所以这个成功无法用"RBAC 配错了"来解释，你会白白去排查一个不存在的问题：

```bash
# Save the four-rule YAML above as exempt-namespace-approver-only.yaml, AFTER
# substituting <approver-identity> and the ServiceAccount identities you just read.
# `create`, not `apply` (§4.0.4). An AlreadyExists means the policy is somebody
# else's object: find out whose before going on, and do NOT let this section's
# cleanup delete it.
create_owned_cluster_object exempt-namespace-approver-only.yaml clusterpolicy
kubectl wait --for=condition=Ready clusterpolicy/exempt-namespace-approver-only --timeout=60s
```

:::warning 被豁免的规则此刻必须真实已安装，否则六步全是假通过

**`gate-param-contract`（[§4.2.1](#s4-2-1)）此刻必须已经安装，且作用范围同时覆盖正常执行 namespace 与 `policy-exempt-runs`。**在 [§4.0.5](#s4-0-5) 的逐节独立路径上，你在 [§4.2](#s4-2) 结尾把它删掉了，而本节到目前为止没有任何步骤重新安装它——目标规则缺席时，下面的步骤 ③ 和 ⑤ 都会径直成功，你会把"没有被拒"读成"豁免生效了"。所以先安装它，并读出两件事来确认：

```bash
# Save the §4.2.1 YAML as gate-param-contract.yaml first. `create`, not `apply`:
# an AlreadyExists just means it is still installed from §4.2 -- that is fine, it is
# this document's own demo policy either way.
create_owned_cluster_object gate-param-contract.yaml clusterpolicy

# Two things must hold, and neither is visible from "the policy exists":
kubectl get clusterpolicy gate-param-contract -o jsonpath='{range .spec.rules[*]}{.name}{" ns="}{.match.any[0].resources.namespaces}{"\n"}{end}'
kubectl get clusterpolicy gate-param-contract -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}{"\n"}'
# Expect the rule's namespace list to contain BOTH policy-poc and policy-exempt-runs
# (the §4.2.1 YAML ships that way -- if you narrowed it while adapting the policy to
# your own profile, widen it back), and Ready=True. A missing namespace or Ready!=True
# means step ③ below cannot fail for the reason you are about to attribute it to.
```

把这条策略保留**到本节最末**：清理末尾的 ⑤ 复检也依赖它（见 [§5.3](#s5-3) 清理）。

:::

该 PolicyException 只匹配专用执行 namespace 内的 TaskRun——不再依赖运行名称或 labels。**`kinds` 写成带 group 版本的 `tekton.dev/v1/TaskRun`，与被豁免策略（`gate-param-contract`）自身的匹配逐字一致**——豁免对象的原则是：越窄越好。不带 group 版本的裸写法 `TaskRun` 也能工作，但它更宽：在仍提供 `v1beta1` 服务的环境里，那种写法也会覆盖 `v1beta1` 的 TaskRun。今天两种写法的**实际效果**相同（豁免只能作用于策略本来就会命中的请求，而那条策略只看 `v1`）；差别在未来：如果那条策略哪天被放宽到也匹配 `v1beta1`，宽写法的豁免会**自动跟着放宽**，而且没有任何告警。切换到 group/版本限定的写法是一次收紧——上线前用 [§3.4](#s3-4) 的正/反探针重新验证：

```yaml
apiVersion: kyverno.io/v2
kind: PolicyException
metadata:
  # Treat each approval as immutable. Use a new name for a new approval instead
  # of deleting and immediately recreating the same name during cache propagation.
  # Encoding the approval date or ticket id in the name (e.g. <yyyymmdd>-<seq>)
  # makes the audit trail self-describing.
  name: approved-exemption-001
  namespace: policy-exceptions   # Must equal the trusted --exceptionNamespace.
  annotations:
    # Replaced with a high-entropy token before create; cleanup uses it to recover
    # interrupted creates without adopting somebody else's same-named object.
    policy.alauda.io/walkthrough-owner: approved-exemption-owner-token
spec:
  exceptions:
    # ruleNames must exactly match spec.rules[].name in the target policy.
    - policyName: gate-param-contract
      ruleNames:
        - scan-quality-gate-must-stay-on
  match:
    any:
      - resources:
          # Group/version-qualified, matching the exempted policy's own match exactly.
          # The bare `TaskRun` also works and would additionally cover v1beta1 --
          # which is wider than the policy being exempted, so it is not used here.
          kinds:
            - tekton.dev/v1/TaskRun
          namespaces:
            - policy-exempt-runs
```

⚠️ **本演练资产只携带清理归属令牌，不含 [§3.6](#s3-6) 要求的治理元数据**：生产签发时，还要把审批工单、生效起始 / 到期时间与责任人写进 `metadata.annotations`——机器可读的到期时间也正是让上文回收选项 ② / ③ 可操作的前提，而签发命令不会替你填这三项。

把上面的 YAML 保存为 `approved-exemption.yaml`。**创建之前先确认名称未被占用**——`policy-exceptions` 通常是**平台很久之前创建的受信 namespace**，可能已经存放着真实生效的豁免；而本节最后的清理是按名称删除的。所以：

```bash
# Fix the name ONCE, here. Everything below -- the collision probe and the create --
# reads it from this variable, so changing your mind later means editing one line
# instead of hunting for the literal. (The cleanup reads the name back from the
# exemption-id.txt file the create between ③ and ④ writes.)
EXC_NAME=approved-exemption-001

kubectl get policyexception -n policy-exceptions "$EXC_NAME" -o name --ignore-not-found
# Expect no output. Anything printed is somebody's real approval: DO NOT apply over it
# and DO NOT delete it -- pick your own name (the comment above suggests
# <yyyymmdd>-<ticket>) and set EXC_NAME to it. Only this variable needs editing.

# Generate the manifest FROM the variable rather than trusting yourself to edit the
# name in two places. That is what makes the "fix the name once" claim above true:
# the create below reads a generated file, not a second copy of the name. Editing
# only EXC_NAME and forgetting the YAML would otherwise create one name and clean up
# another -- and the leftover is a permanent bypass (see this section's cleanup).
# Add a high-entropy ownership token before either create path. The pending intent
# records name+token, so recovery never adopts a concurrent same-named exception.
EXC_OWNER_TOKEN=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
sed -e "s/^  name: approved-exemption-001\$/  name: $EXC_NAME/" \
  -e "s/approved-exemption-owner-token/$EXC_OWNER_TOKEN/" \
  approved-exemption.yaml > approved-exemption.generated.yaml
grep '^  name:' approved-exemption.generated.yaml   # must print your EXC_NAME
grep 'walkthrough-owner:' approved-exemption.generated.yaml \
  | grep -F "$EXC_OWNER_TOKEN" >/dev/null || { echo "owner token was not rendered"; false; }

# STOP HERE -- do NOT create it yet. Step ③ of the walkthrough below has to show that
# a violating run fails WITHOUT an exception; creating it now would destroy that
# baseline and make step ③ prove nothing. The create happens between ③ and ④.
```

`ruleNames` 必须与目标策略当前的 `spec.rules[].name` **逐字一致**：名称过期时对象照样创建成功，但它**静默地不豁免任何规则**。

三个关键性质：**双重入口控制**（创建 PolicyException 的权利由 `policy-exceptions` 的 RBAC 关死；运行入口由 RBAC + 准入策略共同关死，且准入侧必须**同时覆盖 PipelineRun / TaskRun / CustomRun 三类入口**：漏掉任何一类，这个性质就不再成立）、**精确到某个策略的某一条规则**（其他每条规则照常拦截）、以及**可审计**（豁免对象、审批者身份、专用 namespace 里的运行都可以查询）。

**启用它（ACP 特有）**：

1. PolicyException 需要控制器参数 `--enablePolicyException=true`（ACP 中默认已开启）**加上** `--exceptionNamespace=<trusted-namespace>`——**两者缺一不可**。只有前者时，PolicyException 对象可以创建（带警告）但**完全不起作用**；补上后者，同一个豁免立即生效。`--exceptionNamespace` 指定的 namespace 就是豁免权限被关死的地方；它只接受**单个** namespace 或 `*`——不支持列表。多项目环境的两种部署形态（集中审批 / `*` + 元策略）见 [§3.1.1](#s3-1-1)；本节演示**集中审批**模式——受信 namespace 属于审批方，项目成员永不进入。
2. **持久化启用必须走平台模块的 chart values 覆盖面**——直接用 `kubectl patch` 修改控制器 Deployment 会被下一次调和回滚。逐字步骤（含确认与回滚）见 **[§3.1.1](#s3-1-1)**。
3. `ClusterPolicy.status.conditions[].reason=Succeeded` **只证明策略编译通过；不证明 webhook informer 已经加载它**——而 PolicyException 的创建 / 删除也有自己的传播窗口。上线和自动化测试必须用**真实、受控的请求探测行为**：先证明"没有例外时，违规运行 = `CreateRunFailed`"，再用**全新名称**创建例外，直到一个获批运行真正达到 `Succeeded` 才宣布可用；删除之后，同样要等到同类获批运行重新变回 `CreateRunFailed`。**不要在传播窗口内删除后立即用同名重建对象**——那样得出的稳定性数字毫无意义。

**跑六步之前先准备好两个身份**——步骤 ① 要的是"业务身份被 RBAC 拒绝"，其前提是**审批者身份确实已被授权**；否则两个身份都被拒，你证明的只是谁都创建不了任何东西。审批授权只是一个 namespace 级 Role + RoleBinding（在下面代码块顶部的 `APPROVER_IDENTITY` / `BUSINESS_IDENTITY` 里，把两个真实身份**只填一次**，格式为 `system:serviceaccount:<ns>:<sa>` 或用户名；六个步骤和清理都引用这两个变量）：

```bash
# The two identities every later block of this section uses, filled ONCE here as
# full identity strings (system:serviceaccount:<ns>:<sa> or a username).
APPROVER_IDENTITY='<approver-identity>'
BUSINESS_IDENTITY='<business-identity>'
# Names carry the walkthrough id: nothing on the cluster can legitimately reference
# policy-exception-approver-<your id>, so a name collision -- and with it the whole
# "somebody's same-named RoleBinding suddenly points at YOUR new Role" capture that a
# fixed name invites -- is structurally impossible rather than checked for. This is
# §4.0.4's "give your demo copy its own prefixed name" discipline, applied to RBAC.
if [ -z "${WALKTHROUGH_ID:-}" ]; then
  echo "WALKTHROUGH_ID is unset -- run the namespace block in §3.3 first, or re-export the id it printed"
else
  APPROVER_RBAC_NAME="policy-exception-approver-$WALKTHROUGH_ID"
  cat > policy-exception-approver-role.yaml <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: $APPROVER_RBAC_NAME
  namespace: policy-exceptions
rules:
  - apiGroups:
      - kyverno.io
    resources:
      - policyexceptions
    verbs:
      - get
      - list
      - create
      - update
      - delete
YAML
  cat > policy-exception-approver-rolebinding.yaml <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $APPROVER_RBAC_NAME
  namespace: policy-exceptions
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: $APPROVER_RBAC_NAME
subjects:
  # Only the approval identity. Business identities are deliberately absent -- and
  # absence is the whole control here, so verify it rather than assume it.
  # Written as a User subject so the same full identity string this document uses
  # everywhere else works verbatim (system:serviceaccount:<ns>:<sa> is a valid User).
  - kind: User
    name: $APPROVER_IDENTITY
    apiGroup: rbac.authorization.k8s.io
YAML
  echo "generated Role + RoleBinding YAML under the name: $APPROVER_RBAC_NAME"
fi
```

**为什么名称必须唯一**：固定名称在这个受信 namespace 里有真实的碰撞对象——`policy-exceptions` 里很可能**已经存在**别人维护的同名审批授权，而 `apply` 会就地修改它；即便是"先 `kubectl get` 确认名称空闲、再 `create`"的变体，在 get 与 create 之间也留有窗口，别人仍可能创建同名对象。一旦名称携带演练 id，这一整类事故就失去了前提：集群上没有任何东西能合法引用这个名称——**这也是清理可以放心按名称删除这两个对象的原因**；唯一可能碰撞的是本次演练自己更早的尝试。

```bash
# `create`, not `apply`. Role first, so on the happy path the RoleBinding never
# points at a Role that does not exist yet. The name embeds this walkthrough's id,
# so an AlreadyExists can only be an earlier attempt of this same walkthrough:
# delete the pair by name and re-run --
#   kubectl delete rolebinding,role -n policy-exceptions "$APPROVER_RBAC_NAME"
# Guarded on the generation block above having run in THIS shell: without it,
# APPROVER_RBAC_NAME is unset and the yaml files -- if present at all -- are STALE
# leftovers of an earlier walkthrough, and pasting on would silently create objects
# under the old id.
if [ -z "${APPROVER_RBAC_NAME:-}" ]; then
  echo "APPROVER_RBAC_NAME is unset -- run the generation block above first."
else
  kubectl create -f policy-exception-approver-role.yaml \
  && kubectl create -f policy-exception-approver-rolebinding.yaml \
  || { echo "the approver grant is NOT in place -- fix the error above before the six"
       echo "steps: with no grant at all, step ①'s refusal would prove nothing (both"
       echo "identities would be refused, including the one meant to pass ③-⑥)."; }
fi

# Verify BOTH directions before running the six steps -- "no/no" proves nothing.
kubectl auth can-i create policyexceptions.kyverno.io -n policy-exceptions \
  --as="${APPROVER_IDENTITY:?fill it in the RBAC block above}"    # expect: yes
kubectl auth can-i create policyexceptions.kyverno.io -n policy-exceptions \
  --as="${BUSINESS_IDENTITY:?fill it in the RBAC block above}"    # expect: no
```

**六步中的每条 `kubectl create` 都必须带 `--as`**：① / ② 用 `$BUSINESS_IDENTITY`，③–⑥ 用 `$APPROVER_IDENTITY`。**不带 `--as` 你就是在以自己 kubeconfig 的身份操作**（多半是管理员）：六步全"通过"，但那什么也证明不了（[§4.0.3](#s4-0-3) 的身份自检说的是同一件事）。

**其余命令有意不带 `--as`**——下面的代码块就是这样写的——原因有两条，各不相同：

- **读操作（`kubectl wait` / `kubectl get`）**：被测的是"谁能写"；读只是取证。况且业务身份不一定持有 `get pipelineruns` 权限——以它的身份去读只会产生一个与结论无关的 `forbidden`。用你自己的身份读：读到的是同一个对象的同一份状态。
- **⑥ 里的删除**：⑥ 验证的是"吊销是否传播"，不是"谁可以吊销"（那是步骤 ① 的事），所以用你自己的身份删除是正确的。

:::details 端到端验证清单（六步；违规触发条件为两个门禁开关都设为 "false"）

| 步骤 | 预期 |
|---|---|
| ① 业务身份创建 PolicyException | **被 RBAC 拒绝** |
| ② 业务身份在 `policy-exempt-runs` 创建 PipelineRun | **被准入拒绝**（尽管 ACP 基线 RBAC 本来就允许这个创建） |
| ③ 没有例外时，审批者身份在专用 namespace 创建违规运行 | `CreateRunFailed` |
| ④ 新名称的例外经行为探针确认后，审批者身份创建同配置运行 | `Succeeded`，且 `scan / release / notify` 三个 TaskRun 全部成功 |
| ⑤ 在正常 namespace 的同配置违规运行 | 仍为 `CreateRunFailed`，子 TaskRun 为 0 个 |
| ⑥ 例外删除且缓存吊销稳定后，专用 namespace 里的同类获批运行 | 回到 `CreateRunFailed` |

六步使用**同一个违规运行**，只有 namespace 和名称不同——所以先定义一个生成它的函数，六步共用：

```bash
# Both gate switches explicitly "false" is the violation: gate-param-contract rejects
# the `scan` TaskRun when the controller tries to create it, and the parent run then
# ends CreateRunFailed. Same shape as §3.3's demo-run-gates-off, parameterised so the
# six steps below differ only in namespace and name.
exempt_run() {  # <namespace> <run-name>
  cat <<YAML
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: $2
  namespace: $1
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
    - name: enableScanQualityGate
      value: "false"
    - name: enableAnalyzeQualityGate
      value: "false"
YAML
}

# Two more helpers the six steps share. Both exist because of the same trap: a command
# that FAILED can look exactly like one that succeeded and had nothing to say.
# No per-run bookkeeping: every run created below lives in a walkthrough-owned
# namespace, and the cleanup deletes the namespaces -- cascade takes the runs.
create_run() {  # <namespace> <run-name> <identity>
  # Every step's conclusion hinges on WHO creates the run, so refuse to run without
  # an explicit identity instead of falling through to the kubeconfig identity.
  [ -n "$3" ] || { echo "create_run: empty identity -- fill APPROVER_IDENTITY / BUSINESS_IDENTITY (RBAC prep block) first" >&2; return 1; }
  exempt_run "$1" "$2" | kubectl create --as="$3" -f - -o name
}

run_denial() {  # <namespace> <run-name>; prints the Succeeded condition's message
  # CreateRunFailed on its own says "a child could not be created" -- it does not say
  # which policy said no. Any other Enforce policy in the cluster produces the same
  # terminal shape, so a step that checks only the reason can credit its own policy
  # with somebody else's refusal. Measured, the message carries both names:
  #   admission webhook "validate.kyverno.svc-fail" denied the request:
  #   resource TaskRun/policy-poc/<run>-scan was blocked due to the following policies
  #   gate-param-contract:
  #     scan-quality-gate-must-stay-on: every policy-demo-scanner child of gated-build ...
  kubectl get pipelinerun -n "$1" "$2" \
    -o jsonpath='{.status.conditions[?(@.type=="Succeeded")].message}' 2>/dev/null
}

run_verdict() {  # <namespace> <run-name>; prints the verdict, or why there is none
  if ! j=$(kubectl get pipelinerun -n "$1" "$2" -o json 2>&1); then
    case "$j" in
      # Same order and reasoning as §4.0.4's helper: a wrong API path also answers
      # NotFound, so it must be matched BEFORE the absent-object case.
      *'could not find the requested resource'*) echo "READ-FAILED (the API path is wrong)" ;;
      *NotFound*) echo "ABSENT (no such run -- the create was rejected)" ;;
      *) echo "READ-FAILED ($j)" ;;
    esac
    return 1
  fi
  # Measured on every degenerate shape a young run passes through -- {}, .status
  # missing, conditions empty -- all give rc 0 and "reason=<no Succeeded condition yet
  # -- still running> children=0", which is the honest answer. Only genuinely
  # unparseable input fails (rc 5), and that is what the fallback below reports. So a
  # run that has not started yet never masquerades as a verdict.
  printf '%s' "$j" | jq -er '"reason=\((.status.conditions[]?|select(.type=="Succeeded")|.reason)
      // "<no Succeeded condition yet -- still running>") children=\((.status.childReferences//[])|length)"' \
    || { echo "READ-FAILED (the run was read but its JSON could not be parsed)"; return 1; }
}
```

**开始六步之前，先确认前置条件真的成立。**上面的代码块全是"安装它然后读回来"，但读到的东西没有一个变成过控制流——即使两条策略从未安装、审批者身份从未真正授权，六步照样能跑完，给你一整套毫无意义的结论：

```bash
# Re-read the live state rather than remembering whether the earlier blocks looked ok.
# This is the difference between "I ran the install command" and "the thing is in force".
PREREQS_OK=yes
# Snapshot the gate policy as it is RIGHT NOW -- uid and generation. ④ compares
# against this, so "the gate ③ measured" and "the gate ④ ran under" are provably the
# same object whether it was installed by §4.2 or by this section's own create.
# generation, not resourceVersion: it bumps on spec changes and ignores status writes,
# so it catches "somebody edited the rule" without firing on ordinary reconciliation.
GPC_SNAPSHOT=$(kubectl get clusterpolicy gate-param-contract \
  -o jsonpath='{.metadata.uid}/{.metadata.generation}' 2>/dev/null)
echo "gate-param-contract snapshot: ${GPC_SNAPSHOT:-<absent>}"
printf '%s\n' "$GPC_SNAPSHOT" > gate-snapshot.txt
for pol in gate-param-contract exempt-namespace-approver-only; do
  ready=$(kubectl get clusterpolicy "$pol" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>&1)
  [ "$ready" = True ] || { echo "$pol: Ready=$ready -- not in force"; PREREQS_OK=no; }
done
can_approve=$(kubectl auth can-i create policyexceptions.kyverno.io -n policy-exceptions \
  --as="${APPROVER_IDENTITY:?fill it in the RBAC prep block}" 2>&1)
[ "$can_approve" = yes ] || { echo "approver cannot create exceptions ($can_approve)"; PREREQS_OK=no; }
echo "PREREQS_OK=$PREREQS_OK"
# Expect PREREQS_OK=yes. Anything else: go back and fix that block before step ①.
# Steps ③-⑥ read this variable, so a `no` here stops them rather than letting them
# produce confident answers about policies that are not actually installed.
```

**① 业务身份创建 PolicyException——预期被 RBAC 拒绝**

```bash
# On the branch where this does NOT fail you have just created a live exemption --
# a bypass nobody approved. Persist the intended unique name BEFORE the request, so
# even a committed request with a lost response remains discoverable by cleanup.
printf '%s\t%s\n' "$EXC_NAME" "$EXC_OWNER_TOKEN" > exemption-intent.txt
step1_out=$(kubectl create -f approved-exemption.generated.yaml \
  --as="${BUSINESS_IDENTITY:?fill it in the RBAC prep block}" -o json 2>&1)
step1_rc=$?
if [ "$step1_rc" -eq 0 ]; then
  step1_name=$(printf '%s' "$step1_out" | jq -er '.metadata.name') \
    && step1_uid=$(printf '%s' "$step1_out" | jq -er '.metadata.uid') \
    || { echo "① FAILED and the live exception identity could not be recorded -- STOP"; return 1; }
  printf '%s\n' "$step1_name" > exemption-id.txt
  printf '%s\n' "$step1_uid" > exemption-uid.txt
  rm -f exemption-intent.txt
  echo "① FAILED: the business identity CREATED an exemption -- a live bypass nobody"
  echo "approved. Its name is recorded in exemption-id.txt. Delete it NOW and fix RBAC"
  echo "before going on:"
  echo "  run the UID-preconditioned cleanup at the end of this section"
else
  # "It was refused" only counts if the refusal was a permission decision.
  # An unreachable API, a malformed manifest and an unknown resource type all fail
  # here too, and reading any of them as "RBAC did its job" confirms step ① on
  # evidence that has nothing to do with RBAC.
  case "$step1_out" in
    *impersonate*)
      # A Forbidden that names impersonation is about YOUR account, not about the
      # business identity: the request never reached the authorization check this
      # step is testing. Reading it as a pass confirms the wrong subject entirely.
      echo "① NOT CONFIRMED: YOU are not allowed to impersonate that identity, so the"
      echo "request never got as far as testing what the business identity may do:"
      echo "$step1_out" ;;
    *[Ff]orbidden*policyexception*|*policyexception*[Ff]orbidden*)
      rm -f exemption-intent.txt
      echo "① confirmed: refused by RBAC --"; echo "$step1_out" ;;
    *[Ff]orbidden*)
      echo "① NOT CONFIRMED: a permission error that does not name policyexceptions --"
      echo "read it before assuming it is the refusal this step is looking for:"
      echo "$step1_out" ;;
    *) echo "① NOT CONFIRMED: the create failed, but not with a permission error:"
       echo "$step1_out"
       echo "Fix that first -- this step proves nothing about RBAC otherwise." ;;
  esac
fi
# Expect: Error from server (Forbidden). If it SUCCEEDED, the approval Role is not
# the only way in: delete the stray exemption as printed above, then fix RBAC before
# going on -- do not continue with a bypass live in the trusted namespace.
```

**② 业务身份在专用 namespace 创建运行——预期被准入拒绝**

```bash
# This is supposed to be refused. The branch where it is NOT refused leaves a real
# run behind -- in the walkthrough-owned namespace, so the namespace cleanup will
# take it; what matters is fixing the policy, not the leftover.
step2_out=$(create_run policy-exempt-runs step2-business "$BUSINESS_IDENTITY" 2>&1)
step2_rc=$?
printf '%s\n' "$step2_out"
if [ "$step2_rc" -eq 0 ]; then
  echo "② FAILED: the run was CREATED. The admission lock is not stopping the business"
  echo "identity -- fix the policy before reading anything into ③-⑥."
else
  # "It was rejected" is not the claim this step makes -- the claim is "the admission
  # POLICY rejected it". An API outage, a bad manifest and a plain RBAC forbidden all
  # produce a non-zero return here, and each means something different.
  case "$step2_out" in
    *exempt-namespace-approver-only*)
      echo "② confirmed: rejected by the entrance-lock policy." ;;
    *[Ff]orbidden*)
      echo "② NOT CONFIRMED: this is a plain RBAC forbidden, not the admission policy."
      echo "Baseline RBAC happens to deny this identity here, so the lock is unproven." ;;
    *) echo "② NOT CONFIRMED: the create failed for some other reason -- read it above." ;;
  esac
fi
# Expect a denial naming exempt-namespace-approver-only / only-approver-creates-exempt-runs.
# A plain RBAC `forbidden` is a DIFFERENT answer: it means baseline RBAC happens to
# deny this identity here, so the admission lock is still unproven. Read the message.
```

**③ 没有例外时，审批者身份创建违规运行——预期 `CreateRunFailed`**

```bash
BASELINE_OK=no
if [ "$PREREQS_OK" != yes ]; then
  echo "SKIPPED: the prerequisites above are not in force, so a failure here would not"
  echo "mean what ③ claims it means."
elif ! create_run policy-exempt-runs step3-no-exception "$APPROVER_IDENTITY"; then
  echo "③ NOT CONFIRMED: the run could not even be created. That is an RBAC or"
  echo "admission answer about YOU, not the gate contract this step is testing."
else
  # Succeeded=false is the terminal-failure wait; a plain --for=condition=Succeeded
  # would sit here until the timeout and tell you nothing. Its exit code matters:
  # a timeout means the run never reached a terminal state, which is not a verdict.
  if ! kubectl wait -n policy-exempt-runs pipelinerun/step3-no-exception \
         --for=condition=Succeeded=false --timeout=5m; then
    echo "③ NOT CONFIRMED: the run never reached a terminal state within 5m."
  else
    v=$(run_verdict policy-exempt-runs step3-no-exception)
    echo "③: $v"
    msg=$(run_denial policy-exempt-runs step3-no-exception)
    case "$v" in
      "reason=CreateRunFailed children=0")
        case "$msg" in
          *gate-param-contract*) BASELINE_OK=yes; echo "③ confirmed -- denied by gate-param-contract" ;;
          *) echo "③ NOT CONFIRMED: the run failed as expected, but the denial does not"
             echo "  name gate-param-contract, so something ELSE rejected it and this"
             echo "  step credits the wrong policy. The message was:"
             echo "  $msg" ;;
        esac ;;
      *) echo "③ NOT CONFIRMED: expected reason=CreateRunFailed children=0."
         echo "  Especially if it says Succeeded: the target rule is not in force, and"
         echo "  every step after this would be measuring nothing. Re-read the"
         echo "  gate-param-contract install block above." ;;
    esac
  fi
fi

# Persist it for the same reason ④ persists its own verdict: a reader who takes a
# break between ③ and ④ comes back to an empty variable, ④ says SKIPPED, and the
# temptation is to set BASELINE_OK=yes by hand -- which throws away the proof.
printf '%s\n' "$BASELINE_OK" > step3-verdict.txt
echo "③ verdict recorded: $BASELINE_OK"
```

**创建例外（在 ③ 与 ④ 之间）**

```bash
# Write the created name to a file, then read it back out of it. Step ⑥ and the
# cleanup both delete this object by that name, and they may well run in a later
# shell -- a name that exists only as a shell variable is one you will not have when
# it matters. The file is written only by THIS create succeeding, which is what makes
# deleting by its content safe later: it can only ever name your own object.
if [ "$PREREQS_OK" != yes ] || [ "$BASELINE_OK" != yes ]; then
  echo "SKIPPED: creating an exemption while the prerequisites or ③'s baseline are"
  echo "unproven would put a live bypass on the cluster to observe nothing."
  echo "It would also have to be cleaned up. Fix those first."
  EXC_CREATED=
else
  # Persist intent BEFORE create. The unique name lets cleanup recover the UID after
  # an interrupted/lost response instead of concluding "no record means gone".
  printf '%s\t%s\n' "$EXC_NAME" "$EXC_OWNER_TOKEN" > exemption-intent.txt
  EXC_OBJECT=$(kubectl create -f approved-exemption.generated.yaml \
    --as="${APPROVER_IDENTITY:?fill it in the RBAC prep block}" -o json)
  EXC_CREATED=$(printf '%s' "$EXC_OBJECT" | jq -er '.metadata.name') \
    && EXC_UID=$(printf '%s' "$EXC_OBJECT" | jq -er '.metadata.uid') \
    || { echo "exception was created but name/UID could not be recorded -- STOP"; EXC_CREATED=; }
fi
[ -n "$EXC_CREATED" ] && printf '%s\n' "$EXC_CREATED" > exemption-id.txt
[ -n "${EXC_UID:-}" ] && printf '%s\n' "$EXC_UID" > exemption-uid.txt
[ -n "${EXC_UID:-}" ] && rm -f exemption-intent.txt
echo "created ${EXC_CREATED:-<none>}"
# Expect the name. An empty result means the create failed -- and ④ below guards on
# EXC_CREATED rather than trusting you to have read this comment, because ④ can only
# prove anything if this exception actually exists.
[ -n "${EXC_CREATED:-}" ] || echo "STOP: no exception was created. Re-read the errors above;
④ / ⑤ / ⑥ all assume it exists."
```

**④ 例外就位后，同配置运行——预期 `Succeeded`**

```bash
# Propagation is not instant, and there is NO synchronous way to observe it: the deny
# happens when the controller creates the gate TaskRun, so a --dry-run on the
# PipelineRun cannot see it either way. Probe by behaviour, with a NEW NAME each
# attempt -- reusing one name inside the propagation window is exactly the pattern
# this section warns against.
# Reload before the guard, not after: without this a reader who took a break between
# creating the exception and running ④ is told "no exception was created", ⑤ and ⑥
# lock too, and the exemption stays live on the cluster until they reach the cleanup.
if [ -z "${EXC_CREATED:-}" ] && [ -s exemption-id.txt ]; then
  read -r EXC_CREATED < exemption-id.txt
  echo "reloaded exception ${EXC_CREATED:-<none>} from exemption-id.txt"
fi
BASELINE_OK=${BASELINE_OK:-$(cat step3-verdict.txt 2>/dev/null)}

EXEMPTION_LIVE=no
if [ "$BASELINE_OK" != yes ]; then
  echo "SKIPPED: ③ did not establish that a violating run fails WITHOUT an exception."
  echo "Without that baseline a success here proves nothing -- it might always have"
  echo "succeeded. Fix ③ first."
elif [ -z "${EXC_CREATED:-}" ]; then
  echo "SKIPPED: no exception was created, so there is nothing here to observe. Five"
  echo "runs would fail and you would read that as 'propagation is slow'. Go back to"
  echo "the create block between ③ and ④."
else
  for i in 1 2 3 4 5; do
    if ! create_run policy-exempt-runs "step4-attempt-$i" "$APPROVER_IDENTITY"; then
      echo "attempt $i: the create itself was rejected -- that is an admission answer"
      echo "  about the PipelineRun, not about the gate TaskRun this step observes."
      sleep 10
      continue
    fi
    if kubectl wait -n policy-exempt-runs "pipelinerun/step4-attempt-$i" \
       --for=condition=Succeeded --timeout=5m; then
      EXEMPTION_LIVE=yes; LIVE_RUN=step4-attempt-$i
      echo "exemption is live (attempt $i)"; break
    fi
    # A non-zero `wait` is not by itself "the run was rejected": it also covers a plain
    # timeout and an object that was never created. Name what actually happened, because
    # the three call for different fixes.
    echo "attempt $i: $(run_verdict policy-exempt-runs "step4-attempt-$i")"
    # Expect Succeeded=False reason=CreateRunFailed while the exemption has not landed.
    # "still running" means 5m was not enough and the wait timed out -- that is a slow
    # cluster, not a policy verdict. "could not read" with a NotFound means the create
    # itself was rejected; with anything else it is your access to the cluster.
    sleep 10
  done

  # Exhausting the loop is a RESULT, not a quieter version of success. Without this
  # branch the read below would run against the last -- failed -- attempt and print an
  # empty task list, which reads exactly like "the pipeline was skipped".
  if [ "$EXEMPTION_LIVE" != yes ]; then
    echo "NOT CONFIRMED: five attempts, none reached Succeeded (up to ~25 minutes of"
    echo "waiting -- 5 attempts x the 5m timeout -- so this is not 'give it a moment')."
    echo "First re-read the per-attempt lines above: if they say 'still running' the"
    echo "cluster was just slow and nothing is proven either way. If they say"
    echo "CreateRunFailed, check in this order: does the"
    echo "PolicyException exist (kubectl get policyexception -n policy-exceptions);"
    echo "does its ruleNames match gate-param-contract's current spec.rules[].name"
    echo "verbatim; is --exceptionNamespace really set to policy-exceptions (§3.1.1)."
    echo "STOP here -- steps ⑤ and ⑥ both assume the exemption took effect."
  else
    # On the successful attempt, all three TaskRuns must be there -- the exemption is
    # supposed to let the run proceed, not to skip the pipeline. Compared, not printed:
    # a run that "succeeded" with an empty task list is the failure mode this check
    # exists for, and it looks like a pass to anyone skimming the output.
    if ! kids=$(kubectl get pipelinerun -n policy-exempt-runs "$LIVE_RUN" -o json 2>&1); then
      echo "④ NOT CONFIRMED: the successful run could not be read -- $kids"
      EXEMPTION_LIVE=no
    elif ! names=$(printf '%s' "$kids" \
      | jq -er '[.status.childReferences[]?.pipelineTaskName] | sort | join(",")'); then
      echo "④ NOT CONFIRMED: could not parse the run's childReferences"
      EXEMPTION_LIVE=no
    elif [ "$names" != "notify,release,scan" ]; then
      :   # handled below
    elif ! gpc_now=$(kubectl get clusterpolicy gate-param-contract \
        -o jsonpath='{.metadata.uid}/{.metadata.generation}' 2>&1) \
       || [ "$gpc_now" != "${GPC_SNAPSHOT:-$(cat gate-snapshot.txt 2>/dev/null)}" ]; then
      # ③ proved the gate rejects this run. That proof is only transferable to ④ if the
      # gate is STILL the same object and still Ready: if it was deleted, edited or
      # re-created between the two steps, ④ succeeds because the gate is gone, and
      # crediting that success to the PolicyException is the wrong conclusion entirely.
      echo "④ NOT CONFIRMED: gate-param-contract is no longer what the preflight saw"
      echo "  (now: '$gpc_now', then: '${GPC_SNAPSHOT:-$(cat gate-snapshot.txt 2>/dev/null)}')."
      echo "  A changed generation means the RULE was edited; a changed uid means the"
      echo "  policy was replaced. Either way ③'s baseline no longer applies here."
      echo "  This run may have succeeded because the gate went away. Re-run ③ first."
      EXEMPTION_LIVE=no
    else
      echo "④ confirmed: child TaskRuns = $names, and the gate is still the object ③ measured"
    fi
    if [ "$EXEMPTION_LIVE" = yes ] && [ "$names" != "notify,release,scan" ]; then
      echo "④ NOT CONFIRMED: child TaskRuns = '${names:-<none>}', expected notify,release,scan"
      echo "  (sorted). The run reached Succeeded WITHOUT running the pipeline, so the"
      echo "  exemption is not doing what this step claims. Do not go on to ⑤."
      EXEMPTION_LIVE=no
    fi
  fi
fi

# Persist the verdict. ⑤ and ⑥ guard on it, and a reader who takes a break between
# steps comes back to a shell where the variable is gone -- which would look exactly
# like "④ failed" and lock the rest of the walkthrough out for good.
printf '%s\n' "$EXEMPTION_LIVE" > step4-verdict.txt
echo "④ verdict recorded: $EXEMPTION_LIVE"
```

**⑤ 正常 namespace 里的同配置运行——预期仍为 `CreateRunFailed`**

```bash
# ⑤ and ⑥ both ask "compared with ④, what changed?" -- so if ④ never confirmed, they
# have nothing to compare against and their results mean nothing. The guard is the
# variable, not ④'s "do not go on to ⑤" sentence -- and it falls back to the file, so
# a new shell does not read as "④ failed".
EXEMPTION_LIVE=${EXEMPTION_LIVE:-$(cat step4-verdict.txt 2>/dev/null)}
if [ "${EXEMPTION_LIVE:-no}" != yes ]; then
  echo "SKIPPED: ④ was not confirmed, so there is no working exemption to bound."
  echo "⑤ would fail exactly as ③ did and prove nothing new. Fix ④ first."
elif ! create_run policy-poc step5-normal-ns "$APPROVER_IDENTITY"; then
  echo "⑤ NOT CONFIRMED: the run could not be created at all. ⑤ needs a run that is"
  echo "admitted and then fails at the gate -- a rejected create is a different answer."
elif ! kubectl wait -n policy-poc pipelinerun/step5-normal-ns \
        --for=condition=Succeeded=false --timeout=5m; then
  echo "⑤ NOT CONFIRMED: the run never reached a terminal state within 5m."
else
  v5=$(run_verdict policy-poc step5-normal-ns)
  echo "⑤: $v5"
  msg5=$(run_denial policy-poc step5-normal-ns)
  case "$v5" in
    "reason=CreateRunFailed children=0")
      case "$msg5" in
        *gate-param-contract*) echo "⑤ confirmed -- denied by gate-param-contract" ;;
        *) echo "⑤ NOT CONFIRMED: rejected, but not by gate-param-contract. ⑤ has to"
           echo "  show the SAME policy still applies outside the exempt namespace;"
           echo "  a different policy rejecting it proves nothing. Message:"
           echo "  $msg5" ;;
      esac ;;
    *) echo "⑤ NOT CONFIRMED: expected reason=CreateRunFailed children=0. A success"
       echo "  here would mean the exemption is NOT bounded by namespace." ;;
  esac
fi
# This is the step that proves the exemption is bounded by namespace rather than by
# the run's configuration.
```

**⑥ 删除例外之后——预期重新 `CreateRunFailed`**

```bash
# This is a GATE, not a step: if the delete did not happen the exemption is still
# live, and every attempt below would then legitimately succeed -- you would be
# measuring "the exemption works", read it as "revocation has not propagated yet",
# and run out of attempts without ever learning that nothing was deleted.
# Same reload as ⑤, plus the exception's name: both may have been set in a shell you
# have since closed.
EXEMPTION_LIVE=${EXEMPTION_LIVE:-$(cat step4-verdict.txt 2>/dev/null)}
if [ -z "${EXC_CREATED:-}" ] && [ -s exemption-id.txt ]; then
  read -r EXC_CREATED < exemption-id.txt
fi
if [ -z "${EXC_UID:-}" ] && [ -s exemption-uid.txt ]; then
  read -r EXC_UID < exemption-uid.txt
fi

EXC_DELETED=no
EXC_DELETE_CAUSAL=no
REVOCATION_LIVE=no
if [ "${EXEMPTION_LIVE:-no}" != yes ]; then
  echo "SKIPPED: ④ was not confirmed, so there is no established 'exemption works'"
  echo "baseline for ⑥ to observe going away. Deleting the exception here would just"
  echo "restore a state you never left. Fix ④ first."
elif [ -z "${EXC_CREATED:-}" ]; then
  echo "SKIPPED: no record that this walkthrough created the exception (exemption-id.txt"
  echo "is missing or empty), so there is nothing of yours to delete. Find that file."
else
  # Look first: "already gone" and "deleted by you just now" support different claims
  # about propagation, and the probe below needs to know which one it is observing.
  # Read and compare the recorded UID before sending a UID-preconditioned DELETE. The
  # API server enforces the same UID atomically, so a same-named replacement survives.
  if ! exc_seen=$(kubectl get policyexception -n policy-exceptions "$EXC_CREATED" \
        -o json --ignore-not-found 2>&1); then
    # A failed READ is not an absent object: denied permission and an API blip print
    # nothing on stdout too, and only the exit code tells them apart.
    case "$exc_seen" in
      *NotFound*)
        EXC_DELETED=yes
        echo "the exception was already gone -- current state can be probed, but"
        echo "  this is not evidence that YOUR deletion propagated" ;;
      *)
        echo "could not read the exception: $exc_seen"
        echo "STOP: an unreadable object is not a deleted one -- fix your access first." ;;
    esac
  elif [ -z "$exc_seen" ]; then
    EXC_DELETED=yes
    echo "the exception was already gone -- current state can be probed, but"
    echo "  this is not evidence that YOUR deletion propagated"
  elif [ -z "${EXC_UID:-}" ]; then
    echo "no recorded UID (exemption-uid.txt missing) -- refusing name-only deletion"
  elif ! exc_seen_uid=$(printf '%s' "$exc_seen" | jq -er '.metadata.uid'); then
    echo "could not parse the live exception UID -- refusing deletion"
  elif [ "$exc_seen_uid" != "$EXC_UID" ]; then
    echo "same-named exception was replaced ($exc_seen_uid != $EXC_UID) -- left alone"
  else
    exc_path="/apis/kyverno.io/v2/namespaces/policy-exceptions/policyexceptions/$EXC_CREATED"
    exc_delete_body=$(jq -cn --arg uid "$EXC_UID" \
      '{apiVersion:"v1",kind:"DeleteOptions",preconditions:{uid:$uid}}')
    if printf '%s' "$exc_delete_body" \
        | kubectl delete --raw "$exc_path" -f - >/dev/null; then
    EXC_DELETED=yes; EXC_DELETE_CAUSAL=yes
    echo "exception deleted -- go on to the probe below"
    else
      echo "The UID-preconditioned delete request failed. STOP: re-run this block."
    fi
  fi
fi
# Same reason as ③ and ④: the probe below is a separate block, and a reader who takes
# a break between them comes back to EXC_DELETED unset -- which reads as "the delete
# was refused" and skips the revocation check entirely.
printf '%s %s\n' "$EXC_DELETED" "$EXC_DELETE_CAUSAL" > step6-delete.txt
```

守卫是 `EXC_DELETED` 变量，不是那条 `STOP` 消息——一句"只执行一次……"的注释拦不住把整块粘贴执行的人：

```bash
# Revocation propagates on the same terms as the grant did, so probe it the same way.
REVOCATION_LIVE=no
if [ -z "${EXC_DELETED:-}" ] && [ -s step6-delete.txt ]; then
  read -r EXC_DELETED EXC_DELETE_CAUSAL < step6-delete.txt
fi
if [ "${EXC_DELETED:-no}" != yes ]; then
  echo "SKIPPED: the exception was not deleted, so there is no revocation to observe."
  echo "Every attempt below would legitimately succeed and you would read that as"
  echo "'revocation has not propagated yet' -- the exact misreading this gate prevents."
else
  for i in 1 2 3 4 5; do
    if ! create_run policy-exempt-runs "step6-attempt-$i" "$APPROVER_IDENTITY"; then
      echo "attempt $i: the create was rejected -- that is not the revocation this step"
      echo "  is looking for, which happens later, at the gate TaskRun."
      sleep 10
      continue
    fi
    if kubectl wait -n policy-exempt-runs "pipelinerun/step6-attempt-$i" \
         --for=condition=Succeeded=false --timeout=5m; then
      # Succeeded=False is NOT the same claim as "the gate rejected it": a task that
      # genuinely failed also ends Succeeded=False, and reading that as a revocation
      # would confirm the wrong thing. Only CreateRunFailed means the TaskRun never
      # got created, which is what admission denial looks like from here.
      if ! r=$(kubectl get pipelinerun -n policy-exempt-runs "step6-attempt-$i" \
                 -o jsonpath='{.status.conditions[?(@.type=="Succeeded")].reason}' 2>&1); then
        # An unreadable run is not a failed one -- without this the empty `r` would be
        # reported below as "a broken pipeline", which is a different diagnosis.
        echo "attempt $i: the wait said Succeeded=False but the run cannot be read -- $r"
        break
      fi
      if [ "$r" = CreateRunFailed ]; then
        REVOCATION_LIVE=yes
        if [ "${EXC_DELETE_CAUSAL:-no}" = yes ]; then
          echo "revocation is live (attempt $i)"
        else
          echo "the run is rejected again (attempt $i), but the exception was already"
          echo "  gone before ⑥ ran -- this shows the current state, NOT that a"
          echo "  revocation propagated. ⑥ is UNPROVEN on this path."
        fi
        break
      fi
      echo "attempt $i failed with reason=$r, not CreateRunFailed -- that is a broken"
      echo "  pipeline, not a revocation. Fix the run before reading anything into ⑥."
      break
    fi
    # Same caveat as ④, mirrored: a non-zero `--for=condition=Succeeded=false` is not
    # automatically "the run succeeded". Read the verdict instead of naming it.
    echo "attempt $i: $(run_verdict policy-exempt-runs "step6-attempt-$i")"
    # Expect Succeeded=True while the revocation has not landed. "still running" is a
    # timeout and "could not read" is a missing object or a broken connection -- none
    # of the three is a policy verdict.
    sleep 10
  done
  # Same rule as ④: running out of attempts is a result. Five consecutive successes
  # after the object is gone is not "slow" -- it means these runs were never being
  # exempted by that object, so ④'s pass was measuring something else.
  [ "$REVOCATION_LIVE" = yes ] || {
    echo "NOT CONFIRMED: the exception is gone, yet five attempts never came back"
    echo "CreateRunFailed (up to ~25 minutes of waiting, so not 'give it a moment')."
    echo "Read the per-attempt lines first: 'still running' is a timeout and proves"
    echo "nothing. Succeeded=True means re-read gate-param-contract -- rule Ready, and"
    echo "its namespace list still covering policy-exempt-runs. If both hold, then ④"
    echo "did not prove what it claimed."
  }
fi
if [ "${REVOCATION_LIVE:-no}" = yes ] && [ -n "${EXC_UID:-}" ]; then
  printf '%s\t%s\t%s\n' "${WALKTHROUGH_ID:-<unset>}" "$EXC_UID" yes \
    > step6-revocation.txt
else
  rm -f step6-revocation.txt
fi
```

**⑥ 正常跑完后例外已经不在了**；如果删除失败或循环被跳过，它就还在——这正是下面的清理写成"先确认、再决定是否删除"而不是无条件补删的原因。无论你走到了哪一步，六步创建的运行仍然留在两个 namespace 里——清理的 namespace 删除会级联回收它们。

附带说明为什么我们不退回到用 label 标记豁免的旧做法：label 的**写入路径**确实可以被保护——用策略禁止业务身份在 CREATE 时设置豁免 label、禁止经 `taskRunSpecs` 注入、禁止在 UPDATE 时补加、只允许审批者身份修改它。但"写入路径可以被保护"**不等于"label 可以充当豁免匹配键"**：匹配键必须是攻击者完全够不着的东西，而 label 的可写面会随模板能力（例如 `taskRunSpecs`）漂移——每多一条写入路径就要多一条禁令。所以本文档把边界定在受控的专用 namespace 上，而不是某个 label 上。

:::

#### 清理（§5.3）

按 [§4.0.4](#s4-0-4) 的两条规则清理，但**在本节里顺序很重要**。本节的残留也比其他节更危险：`PolicyException` 原生没有 TTL——忘了删它就是一个永久的绕过。

:::warning 即使中途放弃也要执行这一部分

如果六步中任何一步失败，或你决定停下，**也要把这一部分执行到底**——它对你从未做到的对象是安全的（读不到的会报为不可读；从未创建的没有东西可删）。中途停下不清理，集群会同时留着：`gate-param-contract`（Enforce——它会持续拒绝真实流水线）、`exempt-namespace-approver-only`（Enforce）、审批者身份的 `Role` + `RoleBinding`（**能签豁免 = 能放行**），可能还有一个已创建的 `PolicyException`（**没有 TTL**）。这四样没有一样会自己消失。

:::

**① 先确认豁免已经不在**。正常路径上步骤 ⑥ 已经删掉了它；而当 `policy-exceptions` 是平台预先存在的受信 namespace 时，下面的步骤 ④（删除 namespace）永远碰不到它——所以在这里单独确认，还在就删掉。这里的结果是后续步骤的**硬门**：只有当"归属台账没有记录本轮的例外"或"对象确认不存在"时才继续；读取 / 删除失败时，保留审批者 RBAC、入口锁和门禁策略——绝不在可能仍存在活跃绕过时拆除安全边界。

```bash
# The name comes from exemption-id.txt, written only by this walkthrough's own
# creates -- the approved one between ③ and ④, or step ①'s should-have-been-refused
# stray (its branch persists the name for exactly this moment). Its collision-freedom
# was checked before either create, so deleting by the file's content can only ever
# hit your own object. Nothing here deletes by a guessed name.
EXCEPTION_GONE=no
[ -z "${EXC_CREATED:-}" ] && [ -s exemption-id.txt ] && read -r EXC_CREATED < exemption-id.txt
if [ -z "${EXC_CREATED:-}" ] && [ -s exemption-intent.txt ]; then
  IFS=$'\t' read -r EXC_CREATED EXC_OWNER_TOKEN < exemption-intent.txt
fi
[ -z "${EXC_UID:-}" ] && [ -s exemption-uid.txt ] && read -r EXC_UID < exemption-uid.txt
if [ -z "${EXC_CREATED:-}" ]; then
  echo "no committed name or pending create intent -- ownership is unproven"
  echo "EXCEPTION_GONE stays no; inspect the trusted namespace before dismantling anything"
else
  # A pending intent may be the only surviving record after create succeeded but its
  # response was lost. Recover the UID only from that exact unique name.
  if [ -z "${EXC_UID:-}" ]; then
    pending_exc=$(kubectl get policyexception -n policy-exceptions "$EXC_CREATED" \
      -o json --ignore-not-found 2>&1)
    pending_exc_rc=$?
    if [ "$pending_exc_rc" -eq 0 ] && [ -n "$pending_exc" ] \
       && pending_owner=$(printf '%s' "$pending_exc" | jq -er \
            '.metadata.annotations."policy.alauda.io/walkthrough-owner"') \
       && [ -n "${EXC_OWNER_TOKEN:-}" ] \
       && [ "$pending_owner" = "$EXC_OWNER_TOKEN" ] \
       && EXC_UID=$(printf '%s' "$pending_exc" | jq -er '.metadata.uid'); then
      printf '%s\n' "$EXC_CREATED" > exemption-id.txt
      printf '%s\n' "$EXC_UID" > exemption-uid.txt
      rm -f exemption-intent.txt
      echo "$EXC_CREATED: recovered UID $EXC_UID from pending create intent"
    elif [ "$pending_exc_rc" -eq 0 ] && [ -z "$pending_exc" ]; then
      EXCEPTION_GONE=yes
      rm -f exemption-intent.txt
    else
      echo "$EXC_CREATED: pending intent read/parse failed (rc=$pending_exc_rc) -- safety boundary stays"
    fi
  fi
  if [ -z "${EXC_UID:-}" ]; then
    [ "$EXCEPTION_GONE" = yes ] \
      || echo "$EXC_CREATED has no recorded UID -- refusing name-only deletion"
  elif ! exc_live=$(kubectl get policyexception -n policy-exceptions "$EXC_CREATED" \
      -o json 2>&1); then
    case "$exc_live" in
      *NotFound*) EXCEPTION_GONE=yes ;;
      *) echo "could not read $EXC_CREATED -- safety boundary stays installed: $exc_live" ;;
    esac
  elif ! exc_live_uid=$(printf '%s' "$exc_live" | jq -er '.metadata.uid'); then
    echo "could not parse $EXC_CREATED UID -- safety boundary stays installed"
  elif [ "$exc_live_uid" != "$EXC_UID" ]; then
    echo "$EXC_CREATED was replaced ($exc_live_uid != $EXC_UID) -- left alone"
  else
    exc_path="/apis/kyverno.io/v2/namespaces/policy-exceptions/policyexceptions/$EXC_CREATED"
    exc_delete_body=$(jq -cn --arg uid "$EXC_UID" \
      '{apiVersion:"v1",kind:"DeleteOptions",preconditions:{uid:$uid}}')
    if ! printf '%s' "$exc_delete_body" \
        | kubectl delete --raw "$exc_path" -f - >/dev/null; then
      echo "UID-preconditioned delete failed -- safety boundary stays installed"
    elif ! exc_live=$(kubectl get policyexception -n policy-exceptions "$EXC_CREATED" \
        -o name --ignore-not-found 2>&1); then
      echo "delete returned success but absence could not be confirmed: $exc_live"
    elif [ -z "$exc_live" ]; then
      EXCEPTION_GONE=yes
    else
      echo "$EXC_CREATED still exists -- safety boundary stays installed"
    fi
  fi
fi
# Then LOOK: anything still listed is somebody's real approval -- leave it alone.
kubectl get policyexception -n policy-exceptions
# Expect no demo exception of yours in the output.
printf '%s\n' "$EXCEPTION_GONE" > cleanup-exception-gone.txt
echo "EXCEPTION_GONE=$EXCEPTION_GONE"
# Anything except yes: STOP. Do not run steps ②-⑤.
```

**② 吊销审批授权**（名称携带演练 id、只属于本轮，所以按名称删除没问题；先删 RoleBinding——先吊销授权，再删除它指向的 Role）：

```bash
# The name is derived, not random: the generation block built it from the walkthrough
# id, so a fresh shell that re-exported the id can rebuild it here without re-running
# that block.
EXCEPTION_GONE=$(cat cleanup-exception-gone.txt 2>/dev/null)
REVOCATION_LIVE=no
if IFS=$'\t' read -r verdict_walkthrough verdict_uid verdict_value \
    < step6-revocation.txt 2>/dev/null \
   && [ "$verdict_walkthrough" = "${WALKTHROUGH_ID:-<unset>}" ] \
   && [ "$verdict_uid" = "${EXC_UID:-}" ] \
   && [ "$verdict_value" = yes ]; then
  REVOCATION_LIVE=yes
fi
if [ "${EXCEPTION_GONE:-no}" != yes ] || [ "${REVOCATION_LIVE:-no}" != yes ]; then
  echo "exception absence or revocation propagation is unproven -- keeping approver RBAC and every policy installed"
elif [ -z "${APPROVER_RBAC_NAME:-}" ] && [ -n "${WALKTHROUGH_ID:-}" ]; then
  APPROVER_RBAC_NAME=policy-exception-approver-$WALKTHROUGH_ID
fi
if [ "${EXCEPTION_GONE:-no}" != yes ] || [ "${REVOCATION_LIVE:-no}" != yes ]; then
  : # The message above is the fail-safe outcome.
elif [ -z "${APPROVER_RBAC_NAME:-}" ]; then
  echo "APPROVER_RBAC_NAME is unset and so is WALKTHROUGH_ID -- re-export the id §3.3"
  echo "printed, or find the name with:"
  echo "  kubectl get role -n policy-exceptions | grep policy-exception-approver-"
else
  kubectl delete rolebinding -n policy-exceptions "$APPROVER_RBAC_NAME" --ignore-not-found
  kubectl delete role -n policy-exceptions "$APPROVER_RBAC_NAME" --ignore-not-found
fi
if [ "${EXCEPTION_GONE:-no}" = yes ] && [ "${REVOCATION_LIVE:-no}" = yes ]; then
  # Prove the grant is gone rather than assume it: this must go back to `no`.
  kubectl auth can-i create policyexceptions.kyverno.io -n policy-exceptions \
    --as="${APPROVER_IDENTITY:?set it again -- the cleanup may run in a fresh shell}"
fi
```

**③ 只有在豁免与授权都确认消失之后，才删除入口锁策略**——反过来会打开一个入口锁已经不在而豁免仍然存在的窗口：

```bash
EXCEPTION_GONE=$(cat cleanup-exception-gone.txt 2>/dev/null)
# Recompute freshness exactly as step ② did; never trust a shell variable from an old run.
REVOCATION_LIVE=no
if IFS=$'\t' read -r verdict_walkthrough verdict_uid verdict_value \
    < step6-revocation.txt 2>/dev/null \
   && [ "$verdict_walkthrough" = "${WALKTHROUGH_ID:-<unset>}" ] \
   && [ "$verdict_uid" = "${EXC_UID:-}" ] && [ "$verdict_value" = yes ]; then
  REVOCATION_LIVE=yes
fi
if [ "${EXCEPTION_GONE:-no}" != yes ] || [ "${REVOCATION_LIVE:-no}" != yes ]; then
  echo "exception absence or revocation propagation is unproven -- entry lock stays installed"
else
  delete_owned_cluster_object clusterpolicy exempt-namespace-approver-only
fi
```

**④ 删除两个 namespace**。六步创建的运行中，包括 ④ / ⑥ 的失败尝试在内的一切都由级联回收，唯一的例外是留在 `policy-poc` 里的步骤 ⑤ 运行；`policy-exceptions` 只有在**本轮创建了它**时才带演练标签——平台预先创建的永远不会被这个循环碰到：

```bash
EXCEPTION_GONE=$(cat cleanup-exception-gone.txt 2>/dev/null)
REVOCATION_LIVE=no
if IFS=$'\t' read -r verdict_walkthrough verdict_uid verdict_value \
    < step6-revocation.txt 2>/dev/null \
   && [ "$verdict_walkthrough" = "${WALKTHROUGH_ID:-<unset>}" ] \
   && [ "$verdict_uid" = "${EXC_UID:-}" ] && [ "$verdict_value" = yes ]; then
  REVOCATION_LIVE=yes
fi
if [ "${EXCEPTION_GONE:-no}" != yes ] || [ "${REVOCATION_LIVE:-no}" != yes ]; then
  echo "exception absence or revocation propagation is unproven -- both namespaces stay"
else
for ns in policy-exempt-runs policy-exceptions; do
  if ! json=$(kubectl get namespace "$ns" -o json 2>&1); then
    case "$json" in
      *NotFound*) echo "$ns: gone already -- nothing to do" ;;
      # Forbidden and a connection error must not read as "gone": an unreadable
      # namespace is not a deleted one.
      *) echo "$ns: could not be read -- $json"
         echo "  Left alone. Resolve the read error and run this loop again." ;;
    esac
    continue
  fi
  # jq's exit code too: a parse failure would produce an empty marker, and the branch
  # below would then report a labelling mistake that never happened.
  if ! marker=$(printf '%s' "$json" | jq -r '.metadata.labels."policy.alauda.io/walkthrough" // ""'); then
    echo "$ns: could not parse the namespace JSON -- left alone"
    continue
  fi
  if [ -n "${WALKTHROUGH_ID:-}" ] && [ "$marker" = "$WALKTHROUGH_ID" ]; then
    # The label check is the ownership evidence (§4.0.4): only a namespace THIS run
    # created and marked gets deleted, cascade and all.
    kubectl delete namespace "$ns"
  else
    # A pre-existing policy-exceptions legitimately carries no marker of ours, and
    # leaving it is the correct, finished outcome -- step ① already removed the demo
    # exception inside it.
    echo "$ns: label '${marker:-<none>}' is not this run's id '${WALKTHROUGH_ID:-<unset>}' -- left alone"
  fi
done
fi
```

留在 `policy-poc` 里的步骤 ⑤ 运行属于 [§3.3](#s3-3) 的共享 namespace，随其最终清理一起回收；要立刻重新验证，就先删掉它：`kubectl delete pipelinerun -n policy-poc step5-normal-ns --ignore-not-found`。

**⑤ 先复检，最后再删除 `gate-param-contract`**。先把上面六步表格的第 ⑤ 行再执行一次——正常 namespace 里的违规运行必须仍以 `CreateRunFailed` 结束；复检之所以有意义，正是因为这条策略还装着——先删它，剩下的就只是一个注定"成功"的运行，什么也证明不了。复检通过后：

```bash
EXCEPTION_GONE=$(cat cleanup-exception-gone.txt 2>/dev/null)
REVOCATION_LIVE=no
if IFS=$'\t' read -r verdict_walkthrough verdict_uid verdict_value \
    < step6-revocation.txt 2>/dev/null \
   && [ "$verdict_walkthrough" = "${WALKTHROUGH_ID:-<unset>}" ] \
   && [ "$verdict_uid" = "${EXC_UID:-}" ] && [ "$verdict_value" = yes ]; then
  REVOCATION_LIVE=yes
fi
if [ "${EXCEPTION_GONE:-no}" != yes ] || [ "${REVOCATION_LIVE:-no}" != yes ]; then
  echo "exception absence is unproven -- gate-param-contract stays installed"
else
  delete_owned_cluster_object clusterpolicy gate-param-contract
fi
```

留下的本地状态文件（`gate-snapshot.txt`、`step3-verdict.txt`、`step4-verdict.txt`、`step6-delete.txt`、`step6-revocation.txt`、`exemption-id.txt`、`exemption-uid.txt`、`exemption-intent.txt`、`cleanup-exception-gone.txt`、`*.err`）不受集群清理影响——是否留作证据由你决定；只要在下一轮演练开始前删掉即可（提醒在本节开头）。


## 6. FAQ 与故障排查 {#s6}

### 6.1 平台 / 项目管理员（策略侧） {#s6-1}

#### 6.1.1 策略安装失败（创建时被拒） {#s6-1-1}

- **mutate-existing 缺 RBAC**：报错说 background-controller 对目标资源缺少 update 权限。Kyverno 在策略准入时校验 mutate.targets 的 RBAC——按 [§4.6](#s4-6) 授予 `update pipelineruns`。
- **子资源 + background 冲突**：匹配 `*/status` 的 validate 规则不能带 `background: true`（结果类策略保持 `background: false`）。

#### 6.1.2 策略已安装但不生效 {#s6-1-2}

按顺序逐项排查：

```bash
# Is the policy Ready?
CLUSTER_POLICY_NAME=gate-param-contract
NAMESPACED_POLICY_NAME=project-pipeline-policy
NAMESPACED_POLICY_NAMESPACE=policy-poc
TARGET_NAMESPACE=policy-poc
kubectl get clusterpolicy "$CLUSTER_POLICY_NAME" \
  -o jsonpath='{.status.conditions}'
# A namespaced Policy must be queried in its own namespace
kubectl get policies.kyverno.io "$NAMESPACED_POLICY_NAME" \
  -n "$NAMESPACED_POLICY_NAMESPACE" -o jsonpath='{.status.conditions}'
# Does match hit? A subresource must be written as kind/subresource (tekton.dev/v1/TaskRun/status)
# Does namespaceSelector hit? Confirm the target namespace really carries the label
kubectl get ns "$TARGET_NAMESPACE" --show-labels
# Is there a matching PolicyReport entry? (aggregation lags by seconds to minutes)
kubectl get policyreport -n "$TARGET_NAMESPACE"
```

**如果上面四步全部通过而策略仍未生效，就只剩两个原因——它们的症状与"策略没有安装"完全相同**：

1. **规则的身份前置条件没有命中 → 规则跳过（本文档中最常见的一个）**。[§4](#s4) 的相当一部分策略把身份钉在演示夹具上（[§4.0.2](#s4-0-2) 中标 🔧 的那些）；照搬到生产而不换身份，规则每一次都跳过，PolicyReport 里一条记录也不留——**与"策略没有安装"无法区分**。怎么查：把该规则在 `preconditions` / `context` 里读取的字段，逐一与真实请求对象比对（`kubectl get pipelinerun <name> -o yaml`，逐字段），或按 [§4.0.3](#s4-0-3) 的警告用 `--as=<the identity the rule requires>` 重跑探针。**不要在普通身份下跑探针就断言"策略没有生效"**——以身份为前置条件的规则在错误身份下永远产生假通过。
2. **请求在任何策略被查询之前就被 `resourceFilters` 整体跳过**（[§3.1](#s3-1) 检查单第 7 项）：没有拒绝、没有 PolicyReport 记录、没有日志行——一条**完全静默**的通道。怎么查：`kubectl get cm -n kyverno kyverno -o jsonpath='{.data.resourceFilters}'`（与 [§3.1](#s3-1) 检查单第 7 项同一条命令），并确认没有条目覆盖流水线所在 namespace 或 `PipelineRun` / `TaskRun` / `Pod`。

#### 6.1.3 定位误拦截 {#s6-1-3}

用 `--dry-run=server` 复现被拦的请求，从 deny 消息里读出策略名 / 规则名，再回到该规则的前置条件和它的 context 变量取到的值。对 JMESPath 变量，用 `kubectl create --dry-run=server -o yaml` 观察 mutate 结果，或用 kyverno CLI 离线运行夹具（[§6.1.6](#s6-1-6)）。

#### 6.1.4 ⚠️ 识别并解除卡死的流水线 {#s6-1-4}

**症状**：TaskRun / PipelineRun 停在 `Running` 永不结束，Pod 已经 `Completed`，事件反复重复：

```text
Warning  UpdateFailed  taskrun/<name>  Failed to update status for "<name>": admission webhook "validate.kyverno.svc-fail" denied the request: ...
```

**根因**：某条策略把 `Enforce` 应用到了 `*/status` 子资源上，阻塞了 Tekton 控制器的状态回写（[§2.2](#s2-2) 的反机制）。

**解除**：找到把 `Enforce` 与 `*/status` 匹配组合在一起的策略，改成 `Audit` 或删除；控制器按当前退避节奏重试并自动写入终态——但不要把恢复时间说成固定承诺：通常 1 分钟内，取决于当时的重试节奏与负载。**长久之计**：结果类约束一律用 Audit（[§4.4](#s4-4)）或 mutate-existing（[§4.6](#s4-6)）；绝不在 status 上用 Enforce。

#### 6.1.5 PolicyReport 没有条目 / 滞后 {#s6-1-5}

- 后台盘点要求控制器能读取对应的**主资源**；但带 `background: false` 的 status Audit 是经准入报告链聚合的，并不要求 reports-controller 直接 get/list/watch `*/status`。看到权限警告时，把 SubjectAccessReview 做对——基础资源加 `--subresource=status`——并以真实 PolicyReport 是否收敛来判断；警告本身不足以证明"该功能缺 RBAC"。status 策略必须是 `background: false`；status 没有后台重扫兜底。
- PolicyReport 聚合有滞后；刚结束的运行，等一会儿再查询。
- **等过之后仍然为空就别再等了**：`*/status` 策略只在准入时刻求值，而 `background: false` 意味着没有后台补偿。**丢一次运行中途的求值无关紧要**（后面的每次 status UPDATE 都会重新求值，运行期间记下的 `skip` 在终态落地后会翻成 `pass` / `fail`）；但如果丢的是**终态那一次**，就没有下一次了——该条目**永久**停在 `skip`，永远不会自行收敛（低频；机制与解读边界见 [§4.4.1](#s4-4-1) 中"PolicyReport 是尽力而为，不是完整台账"的警告）。这也定下了报告的用法：`fail` 一定意味着有问题，但**"没有 fail"不能充当合规证明**——"全部合规"这类结论需要回到 TaskRun / PipelineRun 本身，或流水线内的硬门禁（[§4.3](#s4-3)）。

#### 6.1.6 用 kyverno CLI 离线测试及其局限 {#s6-1-6}

**本小节要求本机安装了 `kyverno` 命令行**（[§3.1](#s3-1) 的工具核验会打印它是否存在）——它与集群里运行的 Kyverno 是两码事；集群里装了不等于你机器上有这个命令。没有就跳过本小节；演练路径上没有其他步骤依赖它。

```bash
# This section does not otherwise produce these two files -- dump them first, or the
# command below fails with "stat ./fixture.yaml: no such file or directory".
POLICY_FILE=./policy.yaml
FIXTURE_FILE=./fixture.yaml
kubectl get clusterpolicy '<policy-name>' -o yaml > "$POLICY_FILE"
# Any already-expanded TaskRun works as the fixture; an existing run is the easiest
# source because its params are the values admission actually saw.
kubectl -n policy-poc get taskrun '<taskrun-name>' -o yaml > "$FIXTURE_FILE"
kyverno apply "$POLICY_FILE" --resource "$FIXTURE_FILE"
```

适合验证 JMESPath / 前置条件 / deny 逻辑（在已展开的 TaskRun 夹具上尤其有用）。**局限**：`request.userInfo` **可以**通过 `-u/--userinfo` 喂入手工构造的身份（username / groups / clusterRoles 都能到达表达式），但 CLI **对你给的东西照单全收——它不做任何真实的认证或鉴权**——所以你可以离线回归测试身份策略的判定逻辑，却无法验证"这个人在集群里实际持有什么身份"；`context.apiCall`（防伪造检查）离线会立刻报错，而 `*/status` 子资源更新的真实时序和 mutate-existing 的实际 patch 都必须在集群里端到端验证。

#### 6.1.7 常见 JMESPath 陷阱 {#s6-1-7}

- 变量可能不存在：一律加 `|| ''` / `|| \`[]\`` 兜底，否则 "Unknown key" 会把规则变成 error；
- 数值比较前先调用 `to_number()`；字符串用 `split(x, ';')` 解析；
- 引号转义：label 名称含 `/` 或 `.` 时，写成 `request.object.metadata.labels."policy.alauda.io/exemption"`；凡涉及身份判定，仍要先确认该 label 是否可被业务输入伪造；
- ⚠️ **管道 `|` 的结合优先级比 `||` 松；写"两种形态任一"时必须加括号**。想同时接受集群内形态（`taskRef.name`）和 resolver 形态（名字放在 `taskRef.params` 里）时，很容易写成：

  ```text
  spec.taskRef.name || (spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''
  ```

  它实际解析为 `(A || B) | ([0] || '')`：在集群内形态下 `A` 是**字符串**，对字符串取 `[0]` 得到 `null`，整个表达式落到 `''`——**本来要接受的那一半反而被判成空值，规则静默跳过（fail-open）**。resolver 形态工作正常，所以只测 hub 引用永远暴露不了它。正确写法**把管道锁进括号**，只作用于列表那一侧：

  ```text
  spec.taskRef.name || ((spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''
  ```

  **判据要精确——不要过度泛化。** **唯一**需要加括号的情形是"管道左侧存在顶层 `||`"：此时 `||` 先把一个**字符串**和一个**列表**合并，再对结果应用 `[0]`，而对字符串取下标得到 `null`。

  反过来，尾随形式 `list-expression | [0] || 'fallback-value'` **就括号而言已经正确——不要再加**：管道左侧没有顶层 `||`；`|| 'fallback-value'` 属于管道右侧，作用在被提取的元素上，列表为空时正常兜底。

  **但"括号写对了"不等于"这样读值是安全的"。**`[0]` 只取过滤结果的第一项，所以只有当**被读取的列表带有唯一性保证**时才可用：

  - `spec.params` / `pipelineRef.params` / `taskRef.params` / `spec.workspaces`——**`[0]` 可以用**：Tekton 的校验 webhook 本身会拒绝重名（确切报错文本见 [§4.2.5](#s4-2-5)；上游对应 `ValidateParameters` → `validateNoDuplicateNames`，resolver 的 `params` 走同一套校验，workspaces 另有单独的显式重名检查）。**但这份保证是借来的**：它由 **Tekton 的**校验 webhook 提供，不是 API server 的 schema 约束——当该 webhook 不可用且其 `failurePolicy` 为 `Ignore` 时，携带重名的请求可以进来，而 Kyverno 这边仍然只读 `[0]`。对需要硬保证的判据（尤其身份类），把"数量等于 1"折进判据仍是更稳妥的写法——[§4.2.4](#s4-2-4) 的规则 ① 正是这样写的。
  - `status.results` / `status.conditions` / `status.skippedTasks` / `status.pipelineSpec.tasks`——**绝不要用 `[0]`**：这些列表由控制器写入，且 **CRD 没有任何按名去重的约束**，所以准入时同名条目可以出现两次。**在真实 condition 前面插入一个 `Succeeded=Unknown`、在真实 result 前面插一个干净的同名 result、在真实 skip 记录前面插一个理由正当的同名 skip、或在被掏空的门禁 task 前面插一个合规的同名 task——任何一种都能绕过照抄 `[0]` 的策略**（构造方法、A/B 证据与修复见 [§4.4.1](#s4-4-1)、[§4.1.4](#s4-1-4)、[§4.1.5](#s4-1-5)）。
  - **写新的读列表策略时如何判断**：默认永远**数条目**。只有当 API server 自身保证列表按键唯一时才允许 `[0]`——检查方法是 `kubectl get crd <name> -o yaml`：看你要读的那个列表是否带按键唯一性约束（Tekton 的 `status` 侧，一个都没有）。**不要拿上游 Go 源码里的标记当依据**：源码标记不一定进得了 CRD；以 CRD 实际内容为准。
  - **数量检查怎么接入，取决于 `deny.conditions` 用的是 `any` 还是 `all`**：`any` 下数量可以作为独立条件加入；**`all` 下绝对不行**——再加一条 `all` 条件会**放宽**判据；数量必须折进布尔变量本身（本文档的 [§4.1.4](#s4-1-4) / [§4.6.2](#s4-6-2) 用 `all`，数量折在 `scanIdentityValid` 里）。

  所以不要把终态判据写成 `contains(['True','False'], (…)[?type=='Succeeded'].status | [0] || 'Unknown')`；改为数条目：`length((…)[?type=='Succeeded' && (status=='True' || status=='False')]) > \`0\``；读 result 时同样要配一条"目标 result 只允许出现一次"的守卫。

  一行判据：**看管道左侧有没有顶层 `||`**——有才加括号；没有就别动。
- ⚠️ **Kyverno 的比较操作符会对"长得像数字的字符串"做类型强转**——`NotEquals value: "false"` 对 `"1"` 给出错误裁决（把 `"1"` 当数字，与字符串 `"false"` 的比较返回"相等"而不是拒绝）。**精确字符串检查要在 JMESPath 里算出布尔值**（例如 `contains(['', ' '], x)`，或经 `variable.jmesPath` 把 `x != 'false'` 求值为 true/false），再用 `Equals true` 触发 deny——绕开操作符强转。本文档在 [§4.2.3](#s4-2-3) / [§4.2.5](#s4-2-5) / [§4.5.1](#s4-5-1) / [§4.5.2](#s4-5-2) / [§4.5.5](#s4-5-5) 使用该模式。

#### 6.1.8 观测控制平面 {#s6-1-8}

```bash
kubectl logs -n kyverno deploy/kyverno-admission-controller     # admission decisions
kubectl logs -n kyverno deploy/kyverno-background-controller    # mutate-existing / background scan
kubectl get validatingwebhookconfiguration -o custom-columns=\
'NAME:.metadata.name,FAIL:.webhooks[*].failurePolicy' | grep kyverno   # failure policy
```

`failurePolicy: Fail` = Kyverno 不可用期间拒绝相关请求（安全优先——但控制器副本太少、或处于滚动更新窗口内时，请求可能被短暂拒绝；Tekton 会重试）；`Ignore` = 放行（可用性优先，代价是短暂的策略真空）。适用版本下默认值为 `Fail` / `timeoutSeconds=10`（1.15 的 CRD），但**某条策略实际生效的值可能被两层改写**——策略体内的 `spec.webhookConfiguration`（本文档的资产显式声明它；分层见 [§3.7](#s3-7)）与平台级 `forceFailurePolicyIgnore` 覆盖——所以要通过读策略声明、再核查生成的 webhook 分组来判断行为（[§3.1](#s3-1) 检查单第 6 项的两层读法），而不是假设默认值；并据此规划控制器副本数与 HA（生产不应长期停留在单副本上）。
### 6.2 流水线用户（运行被拦截的一方） {#s6-2}

#### 6.2.1 如何读懂拒绝消息 {#s6-2-1}

`kubectl` / UI 上报的 admission 错误中直接包含：`<policy name>: <rule name>: <custom message>`。消息通常会写明具体要求（如 "threshold must be ≥ 50, got 10"）。

#### 6.2.2 我该改什么 {#s6-2-2}

- 模板类拒绝（[§4.1](#s4-1)）：改用被批准的模板引用形态（cluster/hub/git 通道之一，且固定版本）；
- 参数类拒绝（[§4.2](#s4-2)）：把门禁参数改回合规值（不要关闭扫描，也不要调低阈值）。**特别提醒 [§4.2.4](#s4-2-4)：它拦截的是“受保护分支的分析被显式关闭了质量门禁开关”；正确做法是把 `enableScanQualityGate` / `enableAnalyzeQualityGate` 改回 `"true"`，或干脆不传（继承可信默认值）——绝不是去改分支参数**；PR / 特性分支上的构建本来就不会被这条规则拦截，反而是把 `sonarBranchName` 改成 `main` 恰恰会撞上它；
- 如果确实需要临时绕过：走 PolicyException 审批流程（[§5.3](#s5-3)），由审批身份在受控执行 namespace 中创建运行；不要自己改标签，也不要直接跑进那个 namespace。

**按消息中的字段名对号入座**（一条规则往往同时校验多个字段，先认清字段——不要靠猜）：

| 消息中出现的字段 | 该改什么 |
|---|---|
| `pipelineRef` / `resolver` / `catalog` / `version` / `pathInRepo` | 模板引用形态（[§4.1.1](#s4-1-1)）——注意 `url` 参数本身就是被禁止的，不要再加 |
| `enableScanQualityGate` / `enableAnalyzeQualityGate` / `skipTrivyScan` / `trivyExtraArgs` / 阈值类参数 | 门禁开关与阈值（[§4.2.1](#s4-2-1) / [§4.2.5](#s4-2-5)）；恢复模板默认值 |
| `request-level 'url' present` / `'type' param count` / `'type' value` | **不是分支问题**：扫描 Task 的引用来源被篡改。消息中的三个计数各自对应 `taskRef.params` 中的一处——删掉请求级 `url`，把重复的 `type` 合并为一个，且 `type` 只能是 `artifact` 或干脆不写（[§4.2.4](#s4-2-4) 规则①） |
| `protected branch '...'` | 本次运行落在受保护范围内（分支参数是受保护分支，或**缺失 / 为空**——此时按默认分支处理，消息中的分支显示为空），且门禁开关被显式改动——把开关恢复为 `"true"` 或去掉显式覆盖（[§4.2.4](#s4-2-4) 规则③）。分支值只来自 `sonarBranchName` 参数：`sonarProperties` 里不再允许出现 `sonar.branch.name`（那是规则②的拒绝——见下一行） |
| `must use the supported form` | 输入不是规范形态（[§4.2.4](#s4-2-4) 规则②）：消息中的每个布尔值 / 计数各自对应一处——`sonarProperties` 中的非规范条目（前导空白 / `#` / 换行）、借 `sonarProperties` 夹带受管控键、或 PR 声明重复 / 其值含空白。按消息与 [§4.2.4](#s4-2-4) 第一条警告中的映射表改成推荐形态 |
| `PR analysis ... claims target '...'`（在 PolicyReport 中） | PR 分析声明了受保护目标且门禁开关被显式关闭（[§4.2.4](#s4-2-4) 规则④；Audit 不拦截请求）——恢复开关即可；重复声明 / 值中含空白不会出现在这里——它们已在 admission 阶段被规则②拒绝 |
| `srcImage` / `mappings` / 镜像仓库前缀 | 制品来源（[§4.5.1](#s4-5-1)）或运行镜像（[§4.5.3](#s4-5-3)）——消息中会列出**具体镜像** |
| namespace / Secret / ServiceAccount 名称 | 发布目标（[§4.5.5](#s4-5-5)）；这些白名单由平台维护——向平台询问当前批准的取值 |
| `ownerReference` / 控制器身份 | 你在手工创建裸 `TaskRun` / `CustomRun`（[§4.5.4](#s4-5-4)）——请改为提交 PipelineRun |

**Pod 级拒绝（`PodCreationFailed`）要多走一步**：该消息挂在 TaskRun 的 condition 上——先用 `kubectl describe taskrun <name>` 找到它；消息中会列出**不合规的镜像**（即 [§4.5.3](#s4-5-3) 的 `badImages`）；批准的前缀列表不在消息里——需要时向平台询问。

⚠️ **`--dry-run=server` 不一定是你能跑的自测**：[§3.4](#s3-4) 给出的是面向**策略维护者**的验证方法，它仍是一个携带 `create` 动词的 API 请求——只持有 `get` / `describe` 权限的人跑不了。没有该资源的 `create` 权限时，把错误消息和修好的 manifest 交给平台 / 流水线治理负责人代跑，或使用产品侧的预检入口（超出本文范围；见 [§7.1](#s7-1) 中“编排时‘适用策略预览’”一行）。

#### 6.2.3 我的流水线为什么被自动取消 {#s6-2-3}

如果运行变成了 `Cancelled` 而并非你所为，**第一嫌疑**是某条策略选择了“取消”而非“拒绝”——但“不是你干的”排除不了其他用户、运维工具或自动化（它们写的是同一个字段）；是否真是策略所为要看本节的标记，找不到任何标记就只能记为来源未知（详见下文）。**终态不是 `Cancelled` 也可能是策略取消**：当门禁任务自身先失败时，Tekton 的失败裁决优先于取消——运行终态是 `Failed`，但 `spec.status` 已被写为 `CancelledRunFinally`（见 [§4.6.1](#s4-6-1)）——所以看到 `Failed` 且 `spec.status` 里是取消类取值时，同样按下面这张表排查。**先把“非空”和“被取消”分开——它们不是一回事**：Tekton 对 `PipelineRun.spec.status` 只接受四个非空取值，其中三个带取消/停止语义（`Cancelled` / `CancelledRunFinally` / `StoppedRunFinally`）；第四个 **`PipelineRunPending` 与取消无关**——它的含义是“先不要启动”，是以挂起状态创建运行的正常方式（`TaskRun.spec.status` 同理；它的两个合法取值是 `TaskRunCancelled` 和 `TaskRunPending`）。因此判断“被取消了”要看**取值**，绝不能看“非空”。**注意即便是取消类取值也只证明“有人请求了取消”，不证明是谁请求的**（手工取消写的正是同一个字段）：要认定是策略取消，必须有下表中的标记；找不到任何标记，就只能记为来源未知。（标记本身是普通的对象字段——任何对该运行有写权限的人都能造出来；要**确凿地确认写入者**，需查 API server 审计日志，看这次运行的修改者是否为 Kyverno background-controller 的 ServiceAccount。）**本文中有四条路径会请求取消（终态通常是 `Cancelled`，但也可能是 `Failed`——见上一句与 [§4.6.1](#s4-6-1)），而证据只落在两个地方**：路径 1 把证据留在那个门禁 TaskRun 自己身上；路径 2 / 3 / 4 都在父 PipelineRun 上写同一个 `cancel-reason` 注解，靠**文本**区分。按下面的顺序检查；第一个命中的就是原因（四者在机制上的差异——何时检测、动了什么、同步还是异步——见 [§4.6](#s4-6) 引言中的汇总表）：

| 检查顺序 | 来源 | 触发条件 | 证据在哪里 |
|---|---|---|---|
| 1 | [§4.2.3](#s4-2-3) admission mutate 取消门禁 TaskRun | 门禁开关 / 阈值参数不合规 | 该门禁 TaskRun 的 `spec.statusMessage` 与终态 condition 消息——**完整原因就在这里**；最容易识别 |
| 2 | [§4.2.2](#s4-2-2) mutate-existing 取消父运行 | 同上，只是以取消父运行的形态出现 | 父 PipelineRun 的 `cancel-reason` 注解 |
| 3 | [§4.6.2](#s4-6-2) 定义漂移自取消 | 解析出的流水线定义与批准的身份不符 | 父 PipelineRun 的 `cancel-reason` 注解（文本会说明是漂移） |
| 4 | [§4.6.1](#s4-6-1) 结果触发的取消 | 结果不达标（覆盖率 / 漏洞数等）；**结果缺失或格式错误同样命中**（**fail-closed 是判据的方向，不是投递保证**——补丁由 background-controller 异步投递，链路断裂会静默丢失取消；见 [§4.6](#s4-6) 概览表下的第④点与 [§3.7](#s3-7) 的“异步投递链路”一行；此时注解中的取值可能为空） | 父 PipelineRun 的 `cancel-reason` 注解（文本会点名触发的 TaskRun 与越界值，如 `coverage-lines='30'`）+ 该结果本身；若部署了配套的 Audit 规则，PolicyReport 中也有一条 fail 记录 |

严格按该顺序排查：**先找携带 `statusMessage` 的 TaskRun**（存在即为形态 1），**再读父运行 `cancel-reason` 注解的文本**（形态 2 / 3 / 4 都写这个注解；靠文本区分：门禁参数 / 定义漂移 / 结果越界）。

⚠️ **以上一切都以策略确实写入了标记为前提**：`cancel-reason` 是策略在取消时**自己写进对象**的——不是 Tekton 提供的字段（本文四条取消策略都带那段 `metadata.annotations`）。复制策略时把它删掉的后果**按路径一分为二**：

- **形态 2 / 3 / 4（父运行只有这一个标记）**：删掉它就**没有任何东西能区分“策略取消”与“有人手工取消”**——两种情况下 `Cancelled` 终态一模一样。届时你能做的只剩从“某个结果明显越界”去**推断**——而推断不是证据；在审计语境下只能记为“原因未知”（[§4.0.6](#s4-0-6)、[§4.4.4](#s4-4-4)）。
- **形态 1（[§4.2.3](#s4-2-3)）有第二个标记**：同一个补丁还会写 `spec.statusMessage`，其文本以 `Cancelled by policy <policy-name>:` 开头，并被原样拼接进 TaskRun 的失败 condition。所以这条路径**即使注解丢了也仍可判定**；反过来，只保留注解而删掉 `statusMessage`，被拦的人在 `tkn` / 控制台上就看不到任何原因——**两个都不要删**。

⚠️ **还要留意反向情况：本该被取消，却没有被取消**。形态 2 / 3 / 4 都是 mutate-existing——取消由后台异步投递；当某个结果明显越界、流水线却一路跑完，父运行上既没有 `spec.status` 也没有 `cancel-reason` 时，原因通常不是判据漏判，而是投递链路断了（`context.apiCall` 够不到目标、UpdateRequest 根本没被创建、background-controller 挂了或积压、目标上的更新 RBAC 被收回）。这种失败**不产生任何拒绝消息，也不产生 PolicyReport 违规记录**。完整的信号语义（指标只覆盖评估层、三个 ERR 签名、写入层事件、归因判据及其保鲜期）以 [§3.7.1](#s3-7-1) 为准；本段只给排查**顺序**：**先确认 background-controller 本身活着**（[§3.7.1](#s3-7-1) ①——控制器挂了，其余信号都不会产生任何新记录，跳过这一步会把“控制器死了”看成“一切安静”）；然后搜日志——**三层签名、两个控制器都要搜**（background 侧：评估层的 `failed to mutate existing resource` 和写入层的 `failed to update target resource`；admission 侧：创建层的 `failed to update request CR` / `UpdateRequest creation skipped`——UpdateRequest 根本没被创建时，background 侧完全无声；各层的字段与事件见 [§3.7.1](#s3-7-1) ③），并按 `resource=` / 目标对象逐行归因（判据与保鲜期按 [§3.7.1](#s3-7-1) ②——评估层信号会混入正常的父对象已删除竞态，即 [§4.6.1](#s4-6-1) 的 404 说明）；只有“本该被取消却仍在跑”的运行才是真正的投递失败——不要把竞态噪声判成链路故障；**不要把事后的 `kubectl get updaterequests -n kyverno` 当证据**（输出为空对链路健康什么都证明不了——[§3.7.1](#s3-7-1) 开头；要看到 UpdateRequest，必须在复现前先开 `-w` watch）；最后才检查判据本身——不是因为它不会错，而是投递失败不留任何拒绝或报告痕迹、只有上述运行时信号能证伪它，而判据可以离线复核（[§3.4](#s3-4) 的探针骨架）。

下面的命令按表格自身的顺序拉取证据——**先打印归因标记字段**（父运行的 `spec.status` 与 `cancel-reason`、各子 TaskRun 的 `spec.status` / `spec.statusMessage`），再以 Events 与 PolicyReport 作旁证：

```bash
PIPELINERUN=cancel-low-coverage-demo
NAMESPACE=policy-poc
# Everything below runs inside a function so that a failed read REALLY stops the
# collection: in a pasted block a bare `false` only sets $? and execution
# continues, letting later steps print business-level conclusions (such as
# NO-MATCHING-AUDIT-RESULT) computed from empty JSON. `return 1` aborts for
# real and stays paste-safe (`exit 1` would close your interactive shell).
collect_cancel_evidence() {
  if ! run_json=$(kubectl get pipelinerun "$PIPELINERUN" -n "$NAMESPACE" -o json); then
    echo "OBJECT-GONE / READ-FAILED: cannot read PipelineRun $NAMESPACE/$PIPELINERUN; stop evidence collection" >&2
    return 1
  fi
  run_uid=$(printf '%s' "$run_json" | jq -r '.metadata.uid // empty')
  if [ -z "$run_uid" ]; then
    echo "READ-FAILED: PipelineRun response has no UID; stop evidence collection" >&2
    return 1
  fi
  # Attribution marker fields FIRST (the table's own order): the cancellation-class
  # spec.status value, then the policy marker annotation. "(absent)" is itself a
  # finding -- with no marker the cancellation cannot be pinned on a policy (origin
  # unknown, see the warning above); events and reports below are only corroboration,
  # and markers themselves are clues, not proof of the writer (audit log for that).
  printf 'PARENT %s spec.status=%s cancel-reason=%s\n' "$PIPELINERUN" \
    "$(printf '%s' "$run_json" | jq -r '.spec.status // "(empty)"')" \
    "$(printf '%s' "$run_json" | jq -r '.metadata.annotations["policy.alauda.io/cancel-reason"] // "(absent)"')"
  if ! kubectl get events -n "$NAMESPACE" \
    --field-selector involvedObject.uid="$run_uid"; then
    echo "READ-FAILED: events for PipelineRun UID $run_uid are unavailable; stop evidence collection" >&2
    return 1
  fi
  if ! reports_json=$(kubectl get policyreport -n "$NAMESPACE" -o json); then
    echo "READ-FAILED: PolicyReports in $NAMESPACE are unavailable; do not interpret an empty result as no violation" >&2
    return 1
  fi
  # Print any PipelineRun-scoped result first. Zero rows are explicit: cancellation-only
  # policies do not emit a report unless the companion Audit policy is installed.
  # A jq failure must NOT fall through to the zero-row message -- an unparseable
  # report is a broken evidence chain, not "no violation".
  if ! run_rows=$(printf '%s' "$reports_json" | jq -r --arg uid "$run_uid" --arg run "$PIPELINERUN" '
    .items[]
    | select(.scope.kind == "PipelineRun" and .scope.uid == $uid)
    | .results[]
    | [$run, .policy, .rule, .result, .message]
    | @tsv'); then
    echo "PARSE-FAILED: PolicyReport JSON did not parse; stop evidence collection" >&2
    return 1
  fi
  if [ -n "$run_rows" ]; then
    printf '%s\n' "$run_rows"
  else
    echo "NO-MATCHING-AUDIT-RESULT: PipelineRun $PIPELINERUN ($run_uid)"
  fi
  # First find which child TaskRuns have a fail/warn/error summary, then expand the
  # matching policy/rule/message.
  child_taskruns=$(printf '%s' "$run_json" | jq -r '
    .status.childReferences[]? | select(.kind == "TaskRun") | .name')
  while IFS= read -r taskrun; do
    [ -n "$taskrun" ] || continue
    if ! taskrun_json=$(kubectl get taskrun "$taskrun" -n "$NAMESPACE" -o json); then
      echo "OBJECT-GONE / READ-FAILED: TaskRun $NAMESPACE/$taskrun; its evidence cannot be classified" >&2
      continue
    fi
    taskrun_uid=$(printf '%s' "$taskrun_json" | jq -r '.metadata.uid // empty')
    if [ -z "$taskrun_uid" ]; then
      echo "READ-FAILED: TaskRun $taskrun response has no UID; skipping" >&2
      continue
    fi
    # §4.2.3's markers live on the gate TaskRun itself (table row 1): spec.status
    # carries the cancellation value, spec.statusMessage the full policy reason.
    printf 'TASKRUN %s spec.status=%s statusMessage=%s\n' "$taskrun" \
      "$(printf '%s' "$taskrun_json" | jq -r '.spec.status // "(empty)"')" \
      "$(printf '%s' "$taskrun_json" | jq -r '.spec.statusMessage // "(absent)"')"
    if ! task_rows=$(printf '%s' "$reports_json" | jq -r \
      --arg taskrun "$taskrun" --arg taskrun_uid "$taskrun_uid" '
      .items[]
      | select(.scope.kind == "TaskRun" and .scope.uid == $taskrun_uid)
      | .results[]
      | select(.result == "fail" or .result == "warn" or .result == "error")
      | [$taskrun, .policy, .rule, .result, .message]
      | @tsv'); then
      echo "PARSE-FAILED: PolicyReport JSON did not parse for TaskRun $taskrun; its evidence cannot be classified" >&2
      continue
    fi
    if [ -n "$task_rows" ]; then
      printf '%s\n' "$task_rows"
    else
      echo "NO-MATCHING-AUDIT-RESULT: TaskRun $taskrun ($taskrun_uid)"
    fi
  done <<EOF
$child_taskruns
EOF
}
collect_cancel_evidence
```

> ⚠️ **可追溯性前提**：[§4.6](#s4-6) 的取消是纯 mutate-existing 规则——它**不会产生**自己的“不达标”PolicyReport 记录。因此要让“为什么被取消”可追溯，必须**同时部署对应的 [§4.4](#s4-4) Audit 策略**（把触发取消的结果裁决记入 PolicyReport），或让取消动作在父运行上写受控注解 / 事件，记录触发的策略与证据。只装取消规则不装 Audit，PolicyReport 里就查不到任何取消原因。

> ⚠️ **本节是“排障”，不是“审计”**：上面每条命令都以**对象还活着**为前提。`cancel-reason` 注解、`spec.statusMessage`、Events、PolicyReport 全都挂在 PipelineRun / TaskRun 上——对象一旦被清理，一切随之消失。**不是“找到了但不可信”，而是根本找不到。**本文也不提供任何“按时间窗抽查历史发布”的入口：集群内 PolicyReport 随其对象一起被回收——它不是历史归档。要做真正的季度抽查，先跑 [§4.4.4](#s4-4-4) 的“最老记录”命令，弄清集群内证据实际能追溯多远；比这更早的发布只能去你的外部归档里查，以当时归档的 PipelineRun UID 为键。

## 7. 从旧版流水线策略迁移 {#s7}

v3 平台工程流水线策略作用于当年的专有资源模型（Build / Delivery 等）；v4 策略作用于原生 Tekton `PipelineRun` / `TaskRun` / `Pod`——**两代资源模型完全不同，因此本章不做资源字段的一一映射；只回答“旧版的每项治理能力在新方案里是否有等价物”**。正确的迁移方式：按 [§4](#s4) 逐场景用新机制重建等价约束——不要尝试逐字段转写。

### 7.1 能力等价对照表 {#s7-1}

图例：✅ 能力等价；🟡 存在等价实现，但有前提 / 语义不同；🔴 有损——需补充说明。

| 旧版治理能力 | v4 等价物 | 程度 |
|---|---|---|
| 强制使用官方 / 指定流水线模板 | [§4.1.1](#s4-1-1) 模板白名单（cluster / hub / git 通道，固定版本） | 🟡 身份等价；内容保障遵循 [§2.1](#s2-1) 的三档强度——集群内定义最强，远程引用需外部治理补位 |
| 模板必须携带指定标记 / 必须包含某类任务 | 经 RBAC 收紧集群内定义的修改权限（[§4.1.2](#s4-1-2)）+ [§4.1.4](#s4-1-4) 的 `status.pipelineSpec` Audit | 🟡 集群内定义靠 RBAC 锁写权限；远程引用只有事后 Audit 深度 + 依赖外部模板治理 |
| 模板必须来自指定 git 源 | [§4.1.1](#s4-1-1) git 通道白名单（固定 commit SHA） | 🟡 只有固定 SHA 能锁住内容；branch/tag 上的内容约束要靠仓库权限管控补位 |
| 质量门禁（覆盖率 / 漏洞阈值）——不达标即失败 | [§2.3](#s2-3) 门禁任务 `exit 1`（[§4.3](#s4-3)）+ [§4.2](#s4-2) 参数契约保证门禁没被关掉 | 🟡 两套方案都在扫描结果存在之后才裁决；变的是**由谁裁决、失败长什么样**——旧引擎在平台控制器中评估结果快照并**立即**取消底层运行（平台的显式裁定），而这里是 DAG 内门禁任务失败 / DAG 跳过，失败形态是任务失败（用 [§4.3](#s4-3) 与普通失败区分） |
| 覆盖率**不回退**（相对基线的增量） | **无等价实现**：本文只做覆盖率绝对下限（[§4.3](#s4-3)）；增量需要“上一次基线”——admission 侧看不到的输入 | 🔴 见 [§7.3](#s7-3) |
| 限制分析目标分支 | [§4.2.4](#s4-2-4) 受保护分支门禁契约（TaskRun 层） | 🟡 受保护分支分析的门禁可以钉死（`sonarBranchName` 已锚定），但 **PR 阶段的门禁只是尽力而为**（`sonar.pullrequest.base` 是用户提供的参数——fail-open、Audit；见 [§4.2.4](#s4-2-4) 规则④与“平台触发链路的参数映射”） |
| 门禁开关不得被业务团队关闭 | [§4.2.1](#s4-2-1) 主路径（TaskRun 层的生效值）+ [§4.2.5](#s4-2-5) 辅路径（PipelineRun 层的提前拦截） | 🟡 校验位置对模板作者零改动；但识别契约（哪个任务别名、哪个参数名）必须按模板版本逐一配置 |
| 制品来源白名单 | [§4.5.1](#s4-5-1) 复制任务参数白名单 | 🟡 覆盖指定复制任务的参数入口；只有与 [§4.5.4](#s4-5-4) 的入口封闭配合才不可绕过 |
| 运行镜像仓库 / 完整性约束 | [§4.5.3](#s4-5-3) Pod 级镜像白名单 + verifyImages（配套文档） | ✅ Pod 层是对实际运行镜像的可靠拦截点（旧方案通常够不到这一层） |
| 发布目标白名单 | [§4.5.5](#s4-5-5) 目标 ns 参数 + kubeconfig secret 白名单 | 🟡 可沿 namespace 维度治理；目标“集群”维度只能通过 kubeconfig secret 间接治理 |
| 按项目 / 按 namespace 差异化约束 | [§1.3](#s1-3) / [§5.2](#s5-2) 两层治理（负向排除基线 + 正向按项目收紧） | ✅ 并且新增了“未归类 namespace 必然落入基线”的负向覆盖语义 |
| 把报告型检查变成数值门禁（如 lint 计数） | [§2.4](#s2-4) 扩展模型：自定义任务输出声明式 results + [§4.3](#s4-3)/[§4.4](#s4-4) | 🟡 检查任务需要补数据契约（result 改造） |
| 制品属性（label / env / tag） | [§4.5.2](#s4-5-2) `context.imageRegistry` 从源镜像的 config 读取 `Labels` / `Env`；tag 在镜像引用字符串里，由 [§4.5.1](#s4-5-1) 参数白名单裁决 | 🟡 只能读取 **admission 时已存在**的镜像（校验的是来源，不是本次运行将要产出的目标制品）；而且把外部网络调用放上了 admission 路径（[§4.5.2](#s4-5-2) 的四条限制） |
| 规则表达式（旧方案评估事件快照） | Kyverno `match` + `preconditions` + JMESPath，在 **admission 请求对象**上评估；运行结果类判据移到读 `*/status`（[§4.4](#s4-4)） | 🟡 可见字段变了：只能看到请求中真实存在的字段——未绑定的参数**不会出现**在请求里，显式空字符串 ≠ 缺失（处理原则：[§4.2.1](#s4-2-1) 的“参数缺失必须 fail closed”——仅在锁定了确切 Task 版本时才有可信默认值例外）；事件快照的派生字段没有对应物；跨对象信息必须用 `context.apiCall` 实时查（[§4.2.1](#s4-2-1)） |
| 评估记录与可视化 | PolicyReport（[§4.4](#s4-4)） | 🟡 记录能力等价；但**报告随被评估对象一起被 GC，不带 TTL / 保留语义，且 Enforce 拒绝的请求完全不留报告**（[§4.4.4](#s4-4-4) 的边界）——长期留存需要外部采集，且**采集的不能只有报告**：证明“这次发布过了门禁”需要四类东西一起归档——PipelineRun / 门禁 TaskRun 的终态与 results、PolicyReport、Events、admission 拒绝消息（以运行 UID 串联；[§4.4.4](#s4-4-4) 的警告）。面向用户的可视化需产品侧对接 |
| 向多集群分发策略 | **无对应机制**：`ClusterPolicy` / `Policy` 都是**单集群对象**，必须逐集群安装（GitOps 或平台模块分发） | 🔴 新集群从零策略起步，且这种“策略真空”在旧集群上不可见——见 [§3.6](#s3-6) 的新集群一行 |
| 编排时“适用策略预览” | **无等价物**：`--dry-run=server` 只回答“这一个请求会不会被拒”；不会列出“哪些策略会命中” | 🔴 流水线用户仍要到创建运行时才看到拒绝消息；编排时提示需产品侧另行对接 |
| 分阶段生命周期评估（多阶段门禁） | 由三个时刻分层接管：admission（定义 / 参数）+ 执行（门禁任务）+ 事后（Audit / 取消） | 🔴 没有统一的“阶段”抽象；沿生命周期观测点（[§2.1](#s2-1)）分层重实现——语义有所弱化 |

### 7.2 本方案新增的能力（旧方案没有；不是迁移项） {#s7-2}

以下能力随原生资源模型加 Kyverno 自然获得；旧方案没有它们，列为迁移的净收益：

- **入口身份约束**（[§4.5.4](#s4-5-4) `request.userInfo`）：区分 PAC 机器人 / 人类 / 平台自动化；
- **运行镜像来源约束**（[§4.5.3](#s4-5-3) Pod 层）：被裁决的是**实际执行的镜像的仓库前缀**（旧方案通常够不到 Pod 层）；同一层还可以约束 `securityContext` / digest / 签名，但**本文不附带这些策略**；
- **注入默认值**（[§4.2.6](#s4-2-6) mutate）：统一超时 / 标签 / SA；
- **受控豁免**（[§5.3](#s5-3) PolicyException）：可审计、受 RBAC 治理的临时放行；
- **盘点存量资源**（[§4.4.4](#s4-4-4) background Audit）：在策略生效前扫描现状；
- **分阶段策略上线**（[§3.5](#s3-5) Audit→Enforce）：先观察，后执法。

### 7.3 有损项（🔴 / 关键 🟡）的补充说明 {#s7-3}

- **分阶段评估（🔴）**：如果旧方案有“逐阶段推进的门禁编排”，v4 没有对应的一等抽象。缓解：把各阶段拆解到三个时刻——定义 / 参数在 admission（[§4.1](#s4-1)/[§4.2](#s4-2)），质量门禁在流水线的门禁任务（[§4.3](#s4-3)），结果校验与响应在事后（[§4.4](#s4-4)/[§4.6](#s4-6)）；并用 [§2.3](#s2-3) 的契约保证三层合起来不可绕过。
- **质量门禁语义变化（🟡）**：裁决方从平台控制器移入 DAG。旧引擎同样是在扫描结果存在之后才判定（对结果快照做规则评估），但裁定发生在**流水线之外**，一旦违规控制器会**立即**取消底层运行——平台的显式裁定；这里的裁定是 DAG 内门禁任务失败，或事后取消（[§4.6](#s4-6)，Kyverno mutate-existing，**异步、秒级**），失败形态是任务失败——用 [§4.3](#s4-3) 与普通失败区分。已经启动的更早或并行任务的副作用在两套方案下都不会回滚（[§2.3](#s2-3) 契约 5）。缓解：模板设计上把所有副作用排在门禁之后（DAG 支配），必要时叠加 [§4.6](#s4-6) 的提前取消。
- **多集群分发（🔴）**：旧方案有平台同步组件把规则下发到各业务集群；v4 没有这一层——Kyverno 策略对象只存在于它所在的集群。缓解：把策略当作 GitOps / 平台模块管理下的**集群基线配置**；在新集群接入流程中加一步——“按 [§4.0.7](#s4-0-7) 安装最小集并把验收跑完”（[§3.6](#s3-6) 的新集群一行）——并定期比对各集群的策略状态，别让任何集群悄悄掉队。**比对不能只停在策略名**：同名策略可能在 A 集群是 `Enforce` 而在 B 集群还停在 `Audit`，或作用域少列了一个 namespace——这些都表现为“清单一致但保证不一致”，所以要比对的是四样东西——**名称 + 每条规则的 `validate.failureAction` + 作用域 + `spec.webhookConfiguration`（`failurePolicy` / `timeoutSeconds`）**——外加一个集群级状态：平台的 `forceFailurePolicyIgnore` 开关（在开着它的集群上，所有声明的 `Fail` 实际都按 `Ignore` 生效；[§3.1](#s3-1) 检查清单第 6 项）。
- **覆盖率不回退 / 相对基线的增量（🔴）**：admission 侧拿不到“上一次的基线覆盖率”——它不在请求对象里，也不是任何 Tekton 字段；Kyverno 只能看到本次运行上报的值。缓解：**把增量裁决整体移进门禁任务**（由它自己从 Sonar 或其他外部系统取基线、比较、不达标就 `exit 1`——[§2.4](#s2-4) 的扩展模型正是这个形态）；Kyverno 侧只承担“这个任务确实存在、且其门禁参数没被关掉”（契约 3 + [§4.2](#s4-2)）。**不要指望在 admission 时用 `context.apiCall` 取基线**：那会让每一次创建运行都挂在外部系统的可用性上，还必须塞进 webhook 单请求的超时预算（[§3.7](#s3-7)）——代价和风险都不划算。
- **编排时适用策略预览（🔴）**：旧方案能在流水线运行之前列出“哪些策略会命中”；v4 没有等价 API。缓解：把 [§6.2](#s6-2) 的“被拦时如何读消息”作为流水线用户的第一入口；需要事前提示的地方，让产品侧基于**已知模板画像**做前端提示——不要指望 Kyverno 产出适用性列表。
- **远程模板内容保障（🟡）**：hub / git 引用下 Kyverno 只能锁身份；对内容的信任来自外部治理。缓解：优先使用集群内模板 namespace（[§4.1.2](#s4-1-2)：修改权限经 RBAC 收紧）；远程引用一律固定不可变版本 + 依赖 catalog / 仓库的发布治理 + [§4.1.4](#s4-1-4) 的漂移 Audit。

## 8. 结语 {#s8}

### 8.1 决策树：我想拦下某个东西——该用哪种机制 {#s8-1}

```text
The thing you want to constrain
├─ Which pipeline template is used ………………… PipelineRun CREATE + allowlist (§4.1.1)
├─ The template definition's own content / change permission … change permission on in-cluster definitions closed off via RBAC (§4.1.2); remote references get after-the-fact Audit only (§4.1.4)
├─ Gate switches / thresholds / protected-branch gate … gate TaskRun CREATE expanded parameters (§4.2.1 switches and thresholds / §4.2.4 protected-branch gate, main path); if the template exposes them, block early at PipelineRun CREATE (§4.2.5)
├─ Fail when quality results miss the bar ………… in-pipeline gate task exit 1 (§4.3) — not Kyverno's job
├─ Gate skipped / opted out (when/matrix) ……… PipelineRun/status `skippedTasks` Audit (§4.1.5)
├─ Quality-result visibility / inventory ………… TaskRun/status Audit + PolicyReport (§4.4)
├─ Artifact sources ………………………………… copy-task parameter allowlist (§4.5.1)
├─ The artifact's own attributes (label / provenance declarations) … read the source image's config at admission (§4.5.2) — can only read a source image that **already exists**, and puts external network calls on the admission path; read that section's four limits first
├─ The images that actually run ……………………… Pod CREATE + plain UPDATE + `Pod/ephemeralcontainers` UPDATE allowlist / signatures (§4.5.3 + companion document)
├─ Closing the bare Tekton Run entrances ……… TaskRun/CustomRun entry closure (§4.5.4) + RBAC convergence on Pod/Job/Deployment and deployment credentials
├─ Release targets …………………………………… deployment parameters on official PipelineRun CREATE + kubeconfig workspace allowlist (§4.5.5)
├─ Cancel a running run on substandard results … TaskRun/status → mutate-existing cancellation (§4.6, supplementary measure)
├─ Gate parameters non-compliant, but finally must still run … cancel instead of deny: cancel the parent run (§4.2.2) or synchronously cancel the gate TaskRun (§4.2.3)
│                                     — the same criterion as "gate switches / thresholds" above in three response shapes; pick **only one**, per the §4.2.3 comparison table
└─ Per-project differentiation ………………………… platform-managed: ClusterPolicy + selector; project self-service: namespaced Policy (§5.2)
```

还有三种机制不在树里，因为它们是“放行”而非“拦截”：**统一默认注入**（超时 / 标签，mutate，[§4.2.6](#s4-2-6)）、**内联例外**（[§4.1.3](#s4-1-3)——在 [§4.1.1](#s4-1-1) 白名单之上开一条受限通道，且与 [§4.1.2](#s4-1-2) 的全集群一刀切禁令二选一），以及**受控放行**（临时 PolicyException 豁免，[§5.3](#s5-3)）。

一句话收尾：**硬门禁是流水线内门禁任务制造出来的失败；Kyverno 的价值在于确保这道门禁“确实存在、参数关不掉、来源与目标不越轨、裸 Tekton Run 入口被封死”——外加提供审计与受控取消。**两条边界必须一并说明：①“流水线不可绕过”是 **Kyverno + RBAC 的合力**——Kyverno 封死裸 Tekton Run，RBAC 收敛对 Pod/Job/Deployment 的直接权限与部署凭证；缺一不可；② Kyverno 保证的是“门禁在、参数没被关”；**它是否真正支配发布取决于可信模板的 DAG**（例如官方 java 0.3 模板中 `deploy-or-upgrade` 排在 `trivy-scanner` 之后，却不在 `sonarqube-scanner` 之后；两种模板形态的对比见 [§4.3](#s4-3)）。绝不要用 Enforce 拦 `*/status`（会卡死）；结果类约束一律用 Audit 或取消。

### 8.2 参考资料 {#s8-2}

- Kyverno 官方文档：`ClusterPolicy` 与 namespaced `Policy` 的作用域 — https://kyverno.io/docs/policy-types/cluster-policy/overview/
- Kyverno 官方文档：mutate-existing、PolicyException、JMESPath — https://kyverno.io/docs/introduction/
- Tekton Pipelines：resolver、results、`spec.status` 取消语义 — https://tekton.dev/docs/
- `sonarqube-scanner` 0.7 的参数与 results 契约：**以你环境中实际安装的版本为准**。Hub 提供的 Task 不是集群内的 Kubernetes 资源（`kubectl` 取不到）；请在 ACP 控制台查看：左侧导航 **Pipelines → Tasks**，在列表中按 `Source` 列（`catalog` / `Hub`）定位目标 Task，打开其详情页即可看到该版本声明的参数与 results。策略中的字段名必须与该页面展示的真实契约对齐；本文所用画像的契约矩阵见 [§3.2](#s3-2)。
- ACP 4.3 合规管理（Kyverno 插件）安装：https://docs.alauda.io/container_platform/4.3/security/security_and_compliance/compliance/install.html
- ACP 4.3 Kyverno 使用案例：https://docs.alauda.io/container_platform/4.3/security/security_and_compliance/compliance/howto/kyverno_use_cases.html
- Alauda DevOps Pipelines 安装与 `TektonConfig`：https://docs.alauda.io/alauda-devops-pipelines/4.14/install.html
- Kyverno 官方 PolicyException：https://kyverno.io/docs/guides/exceptions/
- Kyverno 官方 mutate-existing：https://kyverno.io/docs/policy-types/cluster-policy/mutate/

> 镜像签名 / 证明（verifyImages）与部署侧供应链验证超出本文范围——见配套文档 [Software Supply Chain Security of Alauda Container Platform with Tekton and Kyverno](./Software_Supply_Chain_Security_of_Alauda_Container_Platform_with_Tekton_and_Kyverno.md)；Kyverno 官方 verifyImages 文档：https://kyverno.io/docs/policy-types/cluster-policy/verify-images/overview/
