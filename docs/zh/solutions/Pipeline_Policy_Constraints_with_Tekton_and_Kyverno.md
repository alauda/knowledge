---
products:
  - Alauda Container Platform
  - Alauda DevOps
kind:
  - Solution
ProductsVersion:
  - 4.3.x
id: KB260800021
---
# 使用 Tekton 与 Kyverno 实施流水线策略约束

:::info 适用版本

**适用于 Alauda DevOps Pipelines v4.14.x 及以上版本** —— 判定依据是该版本号，而不是 ACP 的版本（本文依赖 Alauda DevOps Pipelines 附带的 Tekton API 与特性；ACP 版本只决定 Kyverno 插件能否安装）。在更早的版本上这些特性并不完整：本文中的策略素材与示例无法直接套用（硬性前置条件见 [§3.2](#s3-2)），但其中的机制与设计权衡仍然值得一读。本文所有机制说明、策略素材与量化数据，都是在以下版本组合上产出的：

| 组件 | 版本 | 作用 |
|---|---|---|
| Alauda DevOps Pipelines（Tekton Pipelines 的 ACP 发行版） | v4.14.x | **适用性判定依据** —— 低于该版本，本文策略素材不适用 |
| Alauda Artifact Hub Shim（ACP 内置 hub：一个兼容 Artifact Hub 的 API，供 Tekton 的 hub resolver 使用；本文引用的 catalog Task / Pipeline 定义即由它发布） | v1.0.0 | [§3.2](#s3-2) 契约矩阵中的模板 / Task 定义随它一同发布 |
| Kyverno（ACP 合规管理插件） | v1.15.9-v4.3.2 | 策略引擎；由 ACP 的合规管理插件提供 |
| Alauda Container Platform | 4.3 | 承载上述两者的平台（本文的验证环境） |

**换版本就要重测。** 这些机制通常是向后兼容的，但 results 与参数契约会随 Task 和模板版本变化（见 [§3.2](#s3-2) 的矩阵），跨版本套用时的失败形态是**静默失配** —— 它不表现为报错：策略依然 `Ready`，报告依然干净，只是你在意的那条路径已经不再被监视了。本文中的具体数字同样取决于运行环境（规模、网络、负载）；在写进变更单之前，请在目标环境重新测量。对于该表格之外的任意组合，切到 Enforce 之前请按 [§3.4](#s3-4) 跑一遍正/负向探针回归；上线之后，只要 Kyverno / Tekton / 模板 / Task / ACP 中任何一个发生升级，就用 [§3.6](#s3-6) 定位受影响的判据，并按 [§3.8](#s3-8) 跑最小回归集。

:::

## 1. 概述 {#s1}

在平台工程实践中，CI/CD 流水线是每一次变更抵达生产环境的必经之路 —— 这也使它成为落实组织工程规范的关键抓手。常见的治理诉求包括：

- **模板失控**：业务团队绕开平台审定的流水线模板，自行拼装出缺少质量步骤的流水线；
- **闸门被关掉**：模板里的代码扫描与质量门禁被一个参数关闭（比如把扫描开关设为 false）—— 流水线"看起来在跑模板"，而关键步骤从未执行；
- **来源与目标越界**：从未审批的仓库拉取制品，把应用部署到未授权的命名空间；
- **不达标却照样发布**：覆盖率或漏洞数没达到门槛，流水线仍然一路走完发布阶段。

本文介绍如何在 Alauda Container Platform（ACP）上使用 **Kyverno** 对基于 **Tekton** 的流水线实施策略约束。它不是一份逐条规则的操作手册，而是聚焦于**机制**：Kyverno 在流水线生命周期中能看到什么、在什么时机看到、能采取哪些动作（拦截、审计、注入、取消）—— 以及如何在这些机制点之上，借助自定义 Task 与 Task results，搭建出贴合你所在组织的策略体系。

### 1.0 读完本文你将能够做什么 {#s1-0}

在按 [§3](#s3) 准备好环境之后，你应当能够：

- **判断某项治理诉求应当由哪一层承担** —— 哪些能在准入阶段被 Kyverno 拦截，哪些只能靠可信模板的构造来保证，哪些必须交给 RBAC 或事后审计（[§1.4](#s1-4) 边界、[§2.3](#s2-3) 七条契约）；
- **锁定模板与 Task 的身份**，使业务团队无法更改"用哪个模板、用哪个版本"（[§4.1](#s4-1)）；
- **校验门禁参数的实际取值**，让"把扫描开关设为 false""把阈值降到 0"这类改动在门禁 TaskRun 创建的那一刻就被拒绝（[§4.2](#s4-2)）；
- **约束来源与发布目标** —— 只从审批过的仓库/镜像仓库拉取材料，只向授权的命名空间发布（[§4.5](#s4-5)）；
- **堵住绕过流水线的入口** —— 裸 TaskRun、未审批的内联定义与 resolver 类型（[§4.5.4](#s4-5-4)）；
- **消费自定义 Task 的 results**，用于审计、报表与自动取消，把自研检查纳入同一套治理体系（[§2.4](#s2-4)、[§4.4](#s4-4)、[§4.6](#s4-6)）；
- **安全地做差异化与豁免** —— 平台基线加项目侧收紧的两层模型、通过 PolicyException 实施可控豁免，并确保作用域本身不会被绕过（[§5](#s5)）；
- **把整套体系运营起来** —— 分阶段上线的顺序、变更与升级的触发条件、规模与故障预算，以及升级后要跑的最小回归集（[§3.5](#s3-5)–[§3.8](#s3-8)）。

**不在本文范围内**：镜像签名与供应链证明（见配套文档《Software Supply Chain Security of ACP with Tekton and Kyverno》）、Kyverno 自身的安装与运维（见 ACP 合规管理文档），以及流水线模板怎么写 —— 本文只说明模板必须满足哪些契约。

**最短评估路径**：如果你只想确认这套机制能否拦住你关心的场景，读 [§1.4](#s1-4) + [§2.3](#s2-3)。想上手实操，按 [§1.1](#s1-1) 的角色路径走。

### 1.1 读者与阅读路径 {#s1-1}

| 角色 | 关注点 | 建议路径 |
|---|---|---|
| 平台管理员（编写策略、管理作用域） | 完整的机制全景、作用域安全、策略素材 | [§2](#s2) 机制总览（先搞清能看到什么、能做什么）→ [§3](#s3) 通用配置（安装、验证、搭建夹具）→ [§5](#s5) 作用域控制 → [§4](#s4) Cookbook → [§6](#s6) FAQ |
| 项目管理员（维护项目级约束） | 命名空间级 `Policy`、项目侧收紧、权限边界 | [§1.3](#s1-3) 项目差异化与作用域安全（两层模型）→ [§5.1](#s5-1)–[§5.2](#s5-2) 作用域与 RBAC → [§4](#s4) Cookbook（按需取用；注意把演示中的跨命名空间作用域改写成你自己命名空间里的 `Policy`） |
| 模板 / Task 作者（提供受治理的流水线） | 硬门禁契约、扩展契约 | [§2.3](#s2-3) 硬门禁契约 → [§2.4](#s2-4) 扩展模型 → [§3.2](#s3-2) 版本与依赖特性 → [§3.3](#s3-3) 夹具 → [§4.3](#s4-3) 真实门禁失败 → [§4.1](#s4-1)–[§4.2](#s4-2) 中的相关部分 |
| 流水线使用者（跑流水线、被策略拦住） | 失败形态速查、豁免路径 | [§1.5](#s1-5) 结果形态速查 → [§6.2](#s6-2) 使用者侧 FAQ（只有当你的运行被自动取消时才需要读 [§6.2.3](#s6-2-3)） |
| 通篇实操者（把整篇文档当实验来跑） | 策略与运行清单可直接复制粘贴；探针需要你自己按 [§3.4.1](#s3-4-1) 的骨架拼装（有九个小节只给了预期结果表）；以及不要在共享集群上留下残留 | [§3.1](#s3-1) 验证 → **[§3.2](#s3-2) 先确认 object results 已启用**（`enable-api-fields`；可接受的取值见 [§3.2](#s3-2) —— 如果没开，第一个夹具创建就会被拒，而且报错看上去像是 Kyverno 的问题）→ **[§4.0.3](#s4-0-3) 占位符 + [§4.0.4](#s4-0-4) 清理纪律（在创建任何东西之前先读：自建命名空间，加上对集群级名称冲突的预检查，才是事后能删干净的前提）** → [§3.3](#s3-3) 搭建夹具，并**随手记住你的实操 id** → [§4.0.1](#s4-0-1) 安装顺序 + **[§4.0.5](#s4-0-5) 各演示之间的相互干扰**（"探针跑不起来"的头号原因）→ 你的目标章节（**每做完一节就立刻执行该节的"清理"** —— 不要攒到最后一起做）→ [§3.3](#s3-3) 的"最终清理"，删掉那两个共享命名空间；如果你做过 [§5.3](#s5-3)，最后再回到 [§3.1.1](#s3-1-1) 还原平台配置 |

**[§3.1](#s3-1) 清单里有几项是前向引用**（[§3.1.1](#s3-1-1) 中的 `--exceptionNamespace`、[§4.6](#s4-6) 开头的 mutate-existing RBAC、[§6.1.8](#s6-1-8) 中的副本数规划）：那份清单是一份**能力清单**，而不是"全绿之后才允许往下走"的门禁 —— 第 1、2 项是共同前置条件；其余各项，等你实际用到对应章节的能力时再回头看。

### 1.2 Kyverno 简介 {#s1-2}

Kyverno 是一个 Kubernetes 原生的策略引擎（CNCF 项目），在 ACP 上通过合规管理（Kyverno 插件）交付。与流水线治理相关的核心概念：

- **架构**：admission controller（准入 webhook —— 执行 validate / mutate / 镜像验证）、background controller（扫描已有资源，执行 mutate-existing / generate）、reports controller（产出合规报告）、cleanup controller（周期性清理）。
- **策略资源**：`ClusterPolicy` 是集群级资源，由平台管理员维护，既能跨整个集群匹配命名空间级资源，也能匹配集群级资源；`Policy` 是命名空间级资源，只作用于自身 `metadata.namespace` 内的资源 —— 让项目管理员自行维护本项目约束的正确载体。rule 不是独立的 Kubernetes 资源，它内嵌在策略的 `spec.rules` 中，每条 rule = `match/exclude`（选中哪些资源与操作）+ 可选的 `preconditions`（进一步过滤）+ 一个动作。
- **动作类型**：
  - `validate`：校验资源。在 `Enforce` 模式下于准入阶段拒绝；在 `Audit` 模式下放行请求，但把结果记入 **PolicyReport**；
  - `mutate`：在准入阶段修改资源（注入默认值）；其 **mutate-existing** 变体可以在某个触发事件发生时，修改集群中**已经存在**的其他资源；
  - `generate`：在被触发时创建新资源；
  - `verifyImages`：镜像签名验证（本文不涉及 —— 见配套文档《Software Supply Chain Security of ACP with Tekton and Kyverno》）。
- **PolicyException**：可控豁免机制 —— 它把"谁可以绕过哪条规则"变成一个由 RBAC 管控的独立资源（[§5.3](#s5-3)）。
- **工作方式**：策略加载后会被注册为准入 webhook；每一个匹配的 API 请求（CREATE/UPDATE/…）都会经过策略求值。审计结果与后台扫描结果都会落到 PolicyReport 中。

Kyverno 的完整能力见 ACP 合规管理文档与 Kyverno 上游文档（[§8.2](#s8-2) 参考资料）；本文只展开与流水线治理相关的用法。

**全文使用的术语**（这些词分属不同层次，混淆它们会让你误判策略作用的位置）：

| 术语 | 含义 | 不是什么 |
|---|---|---|
| **策略（policy）** | 一个 Kyverno `ClusterPolicy` / `Policy` 资源 | 不是流水线内部的某个门禁步骤 |
| **规则（rule）** | 策略 `spec.rules` 中的一项（`match` + 可选的 `preconditions` + 一个动作） | 不是独立的 Kubernetes 资源 |
| **判据（criterion）** | 规则内部那个判定合规 / 不合规的布尔表达式（通常写成 `context` 中的 JMESPath 变量） | 不是某个 YAML 结构的名字 |
| **`deny.conditions`** | 承载判据的 YAML 结构；在 `any:` 下命中任意一条即拒绝，在 `all:` 下必须条条成立 | — |
| **守卫（guard，precondition）** | 决定这条规则是否适用于本次请求的条件：身份、终态、列表唯一性等等。不匹配意味着**跳过（放行）**，而不是拒绝 | 不是判据；把判据写成守卫等于放行一切 |
| **门禁 / 门禁 Task** | 流水线中给出质量结论的那个 Tekton Task（不达标就 `exit 1`），例如 `sonarqube-scanner`、`trivy-scanner` | 不是 Kyverno 的动作 |
| **DAG**（有向无环图） | 流水线各任务之间的依赖图。Tekton 依据 `runAfter` 以及任务之间的 result 引用推导出它：有依赖的任务按序执行，彼此独立的并行执行，且不允许成环。"门禁的 DAG 后继"指直接或间接依赖该门禁的那些任务；门禁失败时它们会被**跳过** —— 根本不会被创建 | 不包含 finally —— finally 不属于 DAG，它只在整个 DAG 结束之后才被调度（这个区别是 [§2.3](#s2-3) 结果形态表的关键） |
| **画像（profile）** | 针对某个**具体版本**的真实模板 / Task 所编写的一组判据 | 不是通用模板 |

一句话串起来：**门禁 Task 的职责是拦住不达标的构建；Kyverno 的职责是确保该有门禁 Task 的时候它在，而且它的参数没有被改动**（[§1.4](#s1-4)）—— 并且要注意，"该在的时候它在"并不等于"保证它会执行"：被 `when` / matrix 整体跳过的门禁根本不会产生 TaskRun，准入阶段看不到它，只有事后审计才能发现（[§4.1.5](#s4-1-5)）。

### 1.3 项目差异化与作用域安全 {#s1-3}

不同项目几乎必然需要不同的约束：项目 A 把覆盖率门槛定在 80，项目 B 定在 60；而平台有一批谁都不能越过的红线。**差异化是硬需求 —— 但它的实现方式绝不能给策略开出一个后门。** 本文中的每条策略都遵循两层模型（[§5](#s5) 中有详述与验证）：

- **平台基线**：一条覆盖**所有业务命名空间**的 `ClusterPolicy`，用**否定式的 `exclude`** 把平台自身的系统命名空间摘出去。基线**绝不能**依赖"这个命名空间带了某个标签" —— 否则新建的未打标命名空间、或者标签被改掉的命名空间，天然就逃出了基线。
- **项目侧收紧**：项目管理员的主路径是在自己的项目命名空间里维护命名空间级的 `Policy` —— 他们不需要、也不应该被授予 `ClusterPolicy` 权限。若由平台团队集中为多个项目管理策略，可以用 `ClusterPolicy` + `namespaceSelector`（例如基于 `cpaas.io/project` 标签）来选中目标项目。

**本节描述的是目标治理模型，而不是本文演示素材的现状**：[§4](#s4) 中每条策略的作用域都硬编码到演示命名空间 `policy-poc`，以便统一安装与清理（[§4](#s4) 引言、[§4.0.2](#s4-0-2)）。**"覆盖所有业务命名空间"是你在生产部署时自己要改的** —— 照抄演示 YAML 不会覆盖任何真实项目，新建的命名空间当然也不会被自动纳入（这正是 [§3.6](#s3-6) 列出的第一个触发条件）。

与之配套的语义（同样只有在你按上述目标模型部署之后才成立）：未分类的命名空间必然落入基线；当多条策略匹配到同一资源时，它们之间是**与（AND）**关系（必须条条通过；不存在"项目 `Policy` 覆盖或削弱平台基线"这样的优先级语义）；而修改作用域标签本身的权限也必须受控（[§5.0](#s5-0)）。注意 `Policy` 的作用域是单个 Kubernetes 命名空间；如果一个 ACP 项目横跨多个命名空间，就要在每个命名空间里各部署一份 `Policy`，或者由平台通过受控的集中机制统一下发。

### 1.4 角色与边界：Kyverno 管什么、不管什么 {#s1-4}

一句话概括分工：**硬门禁由流水线内部的门禁 Task 实现（不达标 → `exit 1` → 流水线原生失败）；Kyverno 的角色是收窄"门禁被移除、被篡改、被从侧面绕过"的路径 —— 并提供审计与响应动作。**

**这里刻意没有说"无法绕过"** —— 那个性质只有在**策略 + RBAC + 模板设计三者结合**之后才会浮现；单靠 Kyverno 做不到。下面"做不到"清单中的**最后三项**，对应着**不由 Kyverno 承担**的两项责任 —— "门禁与发布之间的接线"属于**模板设计**，而"绕开 Tekton 的路径"和"保护策略体系自身"属于 **RBAC**。全文统一的条件式措辞见 [§4.0.1](#s4-0-1)"最小可用集所保证的内容是有条件的"；逐项的暴露面见 [§2.5](#s2-5)。

Kyverno 能做到的：

- **准入阶段的硬校验**：在 PipelineRun / TaskRun / Pod 创建时拦截 —— 模板身份不合规、门禁参数被关掉、镜像来源未授权；对象根本创建不出来，流水线以清晰的失败形态终止（[§2.1](#s2-1)、[§4](#s4)）；
- **审计可见性**：在资源状态更新时读取运行结果（覆盖率、漏洞数、扫描结论），把未达标的情况记入 PolicyReport（[§4.4](#s4-4)）；
- **注入默认值**：在准入阶段做 mutate（默认超时、标签等，[§4.2](#s4-2)）；
- **响应动作**：对运行中的流水线执行一次可控的取消（mutate-existing 修改 `spec.status`，[§4.6](#s4-6)）。

Kyverno 明确做不到的（边界）：

- **它无法把运行中的流水线变成 Failed**：PipelineRun/TaskRun 的终态由 Tekton 控制器决定。如果你想要"结果不达标 → 失败"，正确答案是让门禁 Task 自己 `exit 1`；Kyverno 能做的是**取消**（终态为 Cancelled，[§4.6](#s4-6)）。
- **绝不要用 Enforce 拦截对 `*/status` 子资源的写入**：你拦下的其实是 Tekton 控制器的状态回写。结果是资源卡在 Running、控制器无限重试（卡死），而不是失败（[§2.2](#s2-2)、[§6.1.4](#s6-1-4)）。
- **远程引用的定义（hub / git resolver）根本不经过集群准入**：Kyverno 只能锁定其**身份**（哪个 catalog 条目、哪个 commit）；对内容的信任来自外部治理（catalog 发布流程、仓库权限）。三个强度层级见 [§2.1](#s2-1)。
- **它看不到被跳过的门禁**：当 `when` 表达式为假、或 matrix 展开为空时，该门禁**根本不会产生 TaskRun**，准入阶段没有对象可拒 —— "门禁必须执行"只能靠模板设计（不要给门禁加一个业务团队可以关掉的 `when`）加上 [§4.1.5](#s4-1-5) 中对 `status.skippedTasks` 的**事后 Audit** 来保证。它不是准入时刻的硬拦截。
- **它看不出门禁与发布之间的接线是否正确**：门禁消费的是不是**目标任务**的 result（[§2.3](#s2-3) 契约 4）、发布类任务是否排在门禁之后（契约 5）、finally 里是否藏了一个本应受门禁保护的副作用（契约 6）—— 这三条属于**模板设计的责任**。契约 4 / 5 / 6 在准入侧连现成的事后 Audit 都没有（在 [§2.3](#s2-3) 的表里它们唯一的担保者是 `T`；[§4.1.4](#s4-1-4) 只审计门禁的**身份**，既不读 `runAfter` 也不读 `finally`，它挂载的那份已解析定义快照，是你想自建这类 Audit 时的抓手，权衡见 [§4.1](#s4-1) 引言末尾）。**"门禁在、参数没被关掉"不等于"门禁真的管住了发布"** —— 这就是上面那句"三者结合"中属于**模板设计**的那一份。
- **它拦不住彻底绕开 Tekton 的路径**：一个拥有工作负载 API 权限的身份，可以直接创建 Pod / Job / Deployment，或者在别处使用部署凭据，全程不产生一个 PipelineRun。**这一层只有 RBAC 能封住**（[§4.5.4](#s4-5-4)）—— 本文的入口封堵策略封的是裸 `TaskRun` / `CustomRun`，而不是所有能跑容器的 API。
- **它保护不了自己**：本文的每一条结论都建立在"策略体系与 Kyverno 自身配置是受控的"之上。能改 `ClusterPolicy` / `PolicyException` 的人就能改门禁（[§5.3](#s5-3) / [§5.0](#s5-0)）；能改 Kyverno 的 `resourceFilters` 或其 webhook 的人，可以让整整一章的策略**静默地停止生效**（[§3.1](#s3-1) 清单第 7 项 / [§5.0](#s5-0)）；能改 Tekton 平台配置的人可以替换模板的解析来源（[§4.1.1](#s4-1-1)），或者破坏镜像策略所依赖的作用域标签（[§3.6](#s3-6)）。**这些身份不在本文的威胁模型之内** —— 封住它们靠的是 RBAC 职责分离、变更审计和策略体系的自我保护（[§5.0](#s5-0)），而不是再写一条策略。

### 1.5 结果形态速查（面向流水线使用者） {#s1-5}

当某条策略作用到你的流水线上时，你会看到下面六种形态之一（机制见 [§2](#s2)，排障见 [§6](#s6)）—— **注意最后一种是"你什么都看不到"**：

| 你看到的现象 | 含义 | 去哪里找原因 |
|---|---|---|
| 创建 PipelineRun 直接被拒（kubectl / UI 报准入错误） | 准入拦截：模板 / 参数 / 入口不合规 | 报错信息本身就是策略消息（策略名、规则名、原因） |
| PipelineRun 失败，reason 为 `CreateRunFailed`；中途某个 Task 从未被创建 | 运行中途的准入拦截：某个门禁 Task 的实际参数不合规 | `kubectl describe pipelinerun`；condition 消息里带有完整的策略消息 |
| PipelineRun 失败，reason 为 `Failed`；门禁 Task 是红的 | 一次真实的质量门禁失败（覆盖率 / 漏洞数不达标）。**例外**：如果 `spec.status` 里是**某个取消值**（`Cancelled` / `CancelledRunFinally` / `StoppedRunFinally`），说明**确实有人 —— 或某条策略 —— 请求过取消**，只是该任务自身的失败在优先级上盖过了它；单看 `spec.status` 无法告诉你是谁写的 | 门禁 Task 的日志；如果 `spec.status` 是取消值，按 [§6.2.3](#s6-2-3) 去找 `cancel-reason` / `statusMessage` —— 这些标记只指向策略取消（要确认写入者得查审计日志，见该节）；没有这些标记时来源不明（手动取消看起来完全一样）。**不要把"非空"等同于"已取消"**：该字段还有一个与取消无关的合法取值 `PipelineRunPending`（见 [§6.2.3](#s6-2-3)） |
| TaskRun 失败，reason 为 `PodCreationFailed`；Pod 从未出现 | Pod 层面的准入拦截：该步骤的容器镜像不在批准列表中（[§4.5.3](#s4-5-3)） | `kubectl describe taskrun`；消息里带有完整的策略消息 |
| PipelineRun 变成 `Cancelled`（而你并没有取消它） | **首要怀疑对象是策略取消 —— 但别急着下结论**：取消字段是 Tekton 的公开字段，其他用户、运维工具或别的自动化写进去的样子一模一样；[§6.2.3](#s6-2-3) 的标记只指向策略取消（要确认写入者得查审计日志 —— 见该节）。策略侧**共有四种可能来源**，按 [§6.2.3](#s6-2-3) 的排查顺序列出：门禁 TaskRun 被取消（[§4.2.3](#s4-2-3)）、父运行被取消（[§4.2.2](#s4-2-2)）、定义漂移（[§4.6.2](#s4-6-2)）、结果不达标（[§4.6.1](#s4-6-1)） | 证据只存在于两个地方：第一种在那个门禁 TaskRun 上；后三种共用父运行的 `cancel-reason` 注解，靠其文本区分。按 [§6.2.3](#s6-2-3) 给出的顺序逐一排查（机制差异汇总在 [§4.6](#s4-6) 引言的表里） |
| **流水线完全正常、全绿 —— 却照样被记了一条违规** | Audit 模式的策略只记录不拦截（[§4.4](#s4-4)）。**"跑通了"不等于"合规"**：[§4](#s4) 中有若干纯 Audit 策略，[§4.2.4](#s4-2-4) 里还有一条带 Audit 规则的策略 —— 它们对你完全不可见（哪些是 Audit 见 [§4.0.2](#s4-0-2) 的策略速查表） | 只能在 PolicyReport 里看：`kubectl get policyreport -n <your-namespace>`，找 `result: fail` 的条目（[§6.1.5](#s6-1-5)） |

## 2. 理解机制 {#s2}

本章是全文的核心。后续所有内容都贯穿两个模型：

- **模型一：生命周期的观测/动作矩阵（[§2.1](#s2-1)–[§2.2](#s2-2)）** —— Kyverno 在流水线生命周期中能看到什么、在什么时机看到、能做什么；
- **模型二：信任与硬门禁契约（[§2.3](#s2-3)）** —— 构成"无法绕过的质量门禁"的七条契约，以及每一条由谁担保。

Cookbook（[§4](#s4)）中的每一节，都是这两个模型在某个具体场景下的实例化。

### 2.1 生命周期的观测/动作矩阵 {#s2-1}

一条引用式流水线（`pipelineRef` 指向模板）的典型生命周期，以及 Kyverno 的介入点：
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

| # | 观测点 | 能看到什么 | 能做什么 / 注意事项 |
|---|---|---|---|
| 1 | Pipeline / Task 定义资源的 CREATE/UPDATE（**仅限集群内定义**） | 完整的定义 spec 可内省：tasks、finally、参数默认值、标签 | 理论上这里能做两件事：对存储内容做 Enforce 校验（必须包含门禁任务等）+ 锁定变更权限。**本文只用后者**，并且把它交给标准 RBAC 而不是策略（[§4.1.2](#s4-1-2)）—— **本文没有任何一条策略匹配 `Pipeline` / `Task` 定义资源**；为什么不做见 [§4.1](#s4-1) 引言（其中也包括"什么样的场景值得自建"）。**覆盖分三个层级**：① 内联 / 集群内直接引用 —— 准入阶段可内省、可锁定；② hub / git **不可变引用**（固定版本 / commit SHA）—— 在集群内你只能锁定其**身份**；对内容的信任来自外部的 catalog / 仓库治理；③ hub / git **可变引用**（分支 / tag）—— 远端一移动，内容变更就自动生效；Kyverno 只能锁定"引用了哪个分支 / tag"。使用这一层级需要仓库侧的权限控制（受保护分支 / tag）；否则就应当直接拒绝 |
| 2 | `PipelineRun` CREATE 准入 | `pipelineRef`（resolver 类型 + 全部 resolver 参数）、**带取值的 `spec.params`**、workspaces、标签、**`request.userInfo`**（创建者身份） | Enforce：模板身份白名单、PipelineRun 级参数契约、入口身份约束；mutate：注入默认值（超时 / 标签，[§4.2.6](#s4-2-6)）。⚠️ 对于引用式流水线，此刻 `spec.pipelineSpec` 是**空的** —— 定义内容不可见，任务级参数同样不可见 |
| 3 | `PipelineRun/status` UPDATE（子资源） | resolver 解析后的 **`status.pipelineSpec`**（集群内唯一能内省被引用定义的地方）、`status.childReferences`、**`status.skippedTasks`**（每个被跳过任务的 `name` + `reason` + `whenExpressions`；`reason` 取值来自 Tekton 的 `SkippingReason` 枚举）、`status.pipelineResults`（只有完成后才有 —— 对准入而言早已太迟） | 已过准入 = 事后视角。**绝不要用 Enforce 拒绝**（会卡死，[§2.2](#s2-2)）。正确用法：**作为纵深防御的 Audit**（已解析定义中缺少门禁任务 → 记入 PolicyReport，[§4.1.4](#s4-1-4)；门禁被 `when` / 空 matrix 跳过 → 读 `status.skippedTasks` 并记录，[§4.1.5](#s4-1-5)）；**响应动作**：触发自我取消（[§4.6.2](#s4-6-2)） |
| 4 | `TaskRun` CREATE 准入 | `spec.taskRef`（resolver + kind/catalog/name/version/namespace）、标签（可见但**不可信**：`tekton.dev/pipeline` / `tekton.dev/pipelineTask` / `tekton.dev/pipelineRun` 都能通过 `taskRunSpecs` 覆盖 —— 可用作排障线索，绝不可用来定位可信画像或父运行）、`request.userInfo`、控制器写入的 ownerReference，以及 **`spec.params` = 展开后的实际参数值**（`$(params.x)` 已解析为具体值 —— **任务级的门禁参数无需在 PipelineRun 层暴露即可校验**）；step 镜像仅在内联 taskSpec 时可见。⚠️ `tekton.dev/task` 在最终的 TaskRun 上可见，但在真正的 CREATE 准入时刻可能尚未写入，因此在这一阶段同样不能用作身份前置条件；父级身份必须由控制器 ownerReference + 一次 `apiCall` 查询实时父运行的 UID/`spec.pipelineRef` 推导得出 | Enforce：**门禁任务实际参数的校验**（拒绝 → 父运行以 `CreateRunFailed` 干净地失败，策略消息原样传递进运行 condition，[§4.2](#s4-2)）、裸 TaskRun 封堵（[§4.5.4](#s4-5-4)）、taskRef 白名单。⚠️ 流水线未绑定的参数**不会出现**在 `spec.params` 里（此时生效的是 Task 定义中的默认值）—— 只有当 `spec.taskRef` 已被锁定到某个确切的 Task 版本、且其默认值可信时，策略才可以把"缺失"解读为那个可信默认值；身份不可信或默认值未知时必须失败关闭 |
| 5 | **Pod CREATE / 普通 UPDATE / `Pod/ephemeralcontainers` UPDATE 准入**（Tekton 执行 Pod、运行中的镜像更新，以及事后注入的调试容器） | CREATE 与普通 UPDATE 暴露实际的 step / sidecar / init 容器镜像、securityContext、标签（`tekton.dev/taskRun` 等）、volumes；子资源 UPDATE 暴露 `spec.ephemeralContainers` | **针对真正运行的镜像，这是可靠的硬拦截点**（执行镜像不合规 → TaskRun `PodCreationFailed`；普通 UPDATE 中不合规的 main/init 镜像、以及不合规的 ephemeral 镜像补丁，都会被同样拒绝，[§4.5.3](#s4-5-3)）。**这一层能做的事**：镜像仓库白名单、要求使用 digest、禁止 privileged、镜像签名验证（verifyImages）；**本文只提供镜像仓库前缀白名单**（[§4.5.3](#s4-5-3)）—— digest / privileged / 签名各自需要单独的策略；verifyImages 见配套文档 |
| 6 | `TaskRun/status` UPDATE（子资源） | **Task results**（object result 下钻 / 聚合字符串解析）与终态 —— **结果的唯一来源** | 一次运行会触发多次 UPDATE，因此必须加终态守卫（[§4.4](#s4-4)）；只能用于 **Audit** 或作为 **mutate-existing 的触发器**（取消，[§4.6](#s4-6)）—— **绝不要 Enforce**（会卡死）；这类策略还必须声明 `failurePolicy: Ignore` —— 否则在 Kyverno 故障期间，API server 会代它拒绝这些状态回写（[§3.7](#s3-7) 的分级） |
| 7 | Pod 状态 / 事件 | 运行时的失败现场 | 仅用于排障观测（[§6](#s6)）；不承载任何策略动作 |
| 8 | 外部数据源 | `context.apiCall`（在准入期间查询集群内其他资源：Pipeline 定义、父 PipelineRun 等）、`context.imageRegistry`（读取镜像 config；用法见 [§4.5.2](#s4-5-2)） | apiCall 的 JMESPath 语法很严格（[§6.1.7](#s6-1-7)）；imageRegistry 只能读取镜像仓库中已存在的镜像，而且它把外部网络调用放到了准入路径上（延迟与超时风险见 [§4.5.2](#s4-5-2)）。**查询失败往哪个方向倒，由承载它的规则决定，而不是由机制本身决定**：在同步的 `validate` 规则上（[§4.2.1](#s4-2-1)），一次无法完成的查询 —— 目标不可达、不存在或无权限 —— 会让规则报错、请求被拒绝（失败关闭）；在 mutate-existing 规则上（[§4.2.2](#s4-2-2) / [§4.6.1](#s4-6-1)），它运行在 background-controller 中、完全在准入判决之外，因此查询失败只会让补丁静默消失，而原始请求照常放行（失败开放）—— 见 [§3.7](#s3-7) 的"异步投递链"一行 |

### 2.2 执行模式与动作模式 {#s2-2}

| 模式 | 用于 | 关键边界 |
|---|---|---|
| `validate` + **Enforce** | 模板 / 参数 / 定义 / Pod 约束（观测点 1/2/4 的 CREATE，以及观测点 5 的 Pod CREATE / 普通 UPDATE / `Pod/ephemeralcontainers` UPDATE）—— 不合规的请求被直接拒绝 | 用于主资源的 CREATE/UPDATE，或者明确纳入治理的**非 status 子资源**（如 `Pod/ephemeralcontainers`）；绝不要用于 `*/status` 的 UPDATE。运维边界：webhook 的 `failurePolicy` 决定了 Kyverno 不可用时是放行一切（Ignore）还是拒绝一切（Fail）—— 在 [§3.1](#s3-1) 中核实，并在 [§6.1](#s6-1) 中备好预案 |
| `validate` + **Audit** | 结果类约束（观测点 3/6 的 status UPDATE）—— 放行，但记入 PolicyReport | **读取 status 只能用 Audit。** ⚠️ 子资源匹配与 `background: true` 互斥 —— 结果类 Audit 只有准入这一个时刻，没有后台扫描兜底 |
| `mutate`（准入注入） | 注入默认超时 / 标签 / SA 等（观测点 2） | `+(field)` 锚点 = 缺失才添加：它绝不会覆盖用户显式给出的值（[§4.2.6](#s4-2-6)） |
| **mutate-existing** | 响应动作：在某个触发事件发生时，修改集群中**已经存在**的其他资源 —— 本文用它来取消流水线（[§4.6](#s4-6)） | 要求 background controller 对目标资源持有 update RBAC（**Kyverno 会在策略创建时校验该 RBAC；没有就装不上**，[§3.1](#s3-1)）。当由准入事件触发、并使用 `subjects` / `request.userInfo` 时，必须设置 `background: false`；只有当你确实需要策略更新时去扫描既有的触发资源、且规则未使用上述请求变量时，才启用 `background: true` |
| `generate` | 为新建的项目命名空间自动下发命名空间级 Policy 等 | 生命周期管理较复杂；本文不涉及（进阶内容） |
| `verifyImages` | 镜像签名 / 证明 | 见配套文档；它是 [§2.3](#s2-3) 中"身份"契约的信任前提之一 |

**反面机制（务必牢记）**：把 `validate + Enforce` 挂到 `tekton.dev/v1/TaskRun/status` 或 `PipelineRun/status` 的 UPDATE 上，拦住的是 **Tekton 控制器的完成态回写** —— TaskRun 卡在 Running，控制器无限重试 `UpdateFailed`，流水线既不失败也不结束，直到有人介入（复现与恢复步骤见 [§6.1.4](#s6-1-4)）。这是通往"我想让流水线失败"这条路上最容易踩的陷阱：**拒绝状态写入 ≠ 让它失败**。

### 2.3 信任与硬门禁契约 {#s2-3}

**定位**：硬门禁（覆盖率门槛、漏洞阈值 —— "不达标就不许过"）由**流水线内部的门禁 Task** 实现 —— 门禁读取前置任务的 results，不达标就 exit 1；流水线原生失败（`Failed`），而排在门禁之后（`runAfter`）的发布任务会被 DAG 跳过，**根本不会被创建**。Kyverno 的职责是**校验这组契约中可静态验证的部分**；其余部分由可信模板的构造（by construction）与外部治理来保证。

一个"无法绕过的硬门禁" = 以下七条契约同时成立。担保者分三类：**K** = Kyverno 可静态验证，**T** = 由可信模板的构造保证（成立于模板的构造方式，而非运行时检查），**E** = 外部治理。先看骨架：

| # | 契约 | 一句话 | 担保者 | 详见 |
|---|---|---|---|---|
| 1 | 身份 | 门禁使用可信 Task，且引用不可变（固定版本 / digest） | K + E | [§4.1](#s4-1) |
| 2 | 参数实际取值 | 开关 / 阈值按展开后的实际值校验 | K | [§4.2.1](#s4-2-1) |
| 3 | 必须执行 | 门禁不会被 `when` / matrix / 默认值跳过 | T + K 事后 Audit | [§4.1.5](#s4-1-5) |
| 4 | 数据绑定 | 门禁消费的是目标任务的 results | T | ——（模板责任） |
| 5 | DAG 支配 | 发布类副作用任务必须排在门禁之后 | T | ——（模板责任；自建 Audit 的抓手与权衡见 [§4.1](#s4-1) 引言末尾） |
| 6 | finally 安全 | finally 中不得存在受门禁保护的副作用 | T | ——（模板责任；finally 的执行语义见 [§4.2.2](#s4-2-2)） |
| 7 | 入口封闭 | 不能通过裸 TaskRun / 内联定义 / 未批准的 resolver 绕过流水线 | K + RBAC | [§4.5](#s4-5) |

逐条展开：

1. **身份**（K + E）：门禁使用可信 Task，且引用不可变（固定版本 / digest）。K 负责锁定引用身份（[§4.1](#s4-1)）；step 镜像的完整性（digest / 签名）、镜像仓库的推送权限、外部扫描服务的凭据安全，属于外部信任面（E；镜像签名见 verifyImages / 配套文档）。
2. **参数实际取值**（K）：门禁开关、阈值、目标分支等，按**展开后的实际值**校验。校验位置 = **门禁 TaskRun 的 CREATE** —— 那一刻 `$(params.x)` 已经解析为具体值；身份由控制器写入的 `ownerReference` + 实时父运行 + `spec.taskRef` 推导（子级标签可被调用方伪造，不可用），模板作者无需做任何改动。响应方式：Enforce 拒绝（门禁 TaskRun 创建不出来 → 父运行以 `CreateRunFailed` 干净地失败）或取消父运行（[§4.6](#s4-6)）；当模板已经在 PipelineRun 层暴露了这些参数时，在 PipelineRun CREATE 处**提前拦截**是一项可选的优化。完整推导与策略见 [§4.2.1](#s4-2-1)。
3. **必须执行**（T + K 事后 Audit）：门禁不会被 `when` 表达式 / matrix / 条件分支 / 参数默认值跳过。经典陷阱：扫描 URL 参数默认为空 + `when: sonarURL != ''` ⇒ 默认情况下扫描被整体跳过，门禁变成了可选项。⚠️ **被跳过的门禁不会产生 TaskRun** —— 契约 2 的准入校验对"不存在"是盲的（准入拦不住从未发生的事）。所以"必须执行"的根基在 T（模板不提供任何跳过路径）；在 K 这一侧，对 **`status.skippedTasks`** 的事后 Audit（控制器会把每一次跳过连同其 `reason` 记入 PipelineRun status）可以判定门禁是否被绕过 —— 但它仍然是 Audit，拦不住当前这次运行。原因如何分类以及策略怎么写见 [§4.1.5](#s4-1-5)。
4. **数据绑定**（T）：门禁真正消费的是指定产出任务的 results（`$(tasks.scan.results.x)` 这条线接对了）。准入看不到表达式层面的绑定关系；由模板保证。
5. **DAG 支配**（T）：**每一个**发布 / 推送 / 晋级类的副作用任务，都必须传递性地依赖于门禁（`runAfter`，直接或间接）。门禁只能拦住它的 DAG 后继 —— **排在门禁之前或与之并行的任务可能已经跑完，而失败并不会回滚已经发生的副作用**。让副作用受门禁支配是模板设计的责任；本文不提供现成的 DAG 支配 Audit（判定传递依赖意味着要算闭包 —— 权衡见 [§4.1](#s4-1) 引言末尾），而 [§4.1.4](#s4-1-4) 那份已解析定义快照（其中包含 `runAfter`）就是你自建此类判据的抓手。
6. **finally 安全**（T）：finally 任务会在流水线失败时执行，或在以 **`CancelledRunFinally`** 取消时执行（deny 与 cancel 下 finally 是否运行，对比见 [§4.2.2](#s4-2-2) 的表；三种响应形态的完整权衡见 [§4.2.3](#s4-2-3)）；而普通的 `spec.status: Cancelled` 并不保证尚未开始的 finally 任务会被调度 —— 因此 finally 中绝不能包含任何受门禁保护的副作用（发布、推送）。对 finally 内容同样没有现成的 Audit（[§4.1.4](#s4-1-4) 的快照中包含 `finally` 列表；你可以自建 —— 权衡同上）。
7. **入口封闭**（K + RBAC）：业务身份不得通过创建裸 TaskRun 绕过流水线，不得使用未批准的内联定义，不得使用未批准的 resolver 类型；`CustomRun` 默认拒绝或显式声明不支持（[§4.5.4](#s4-5-4)）。

**Kyverno 可验证的三件事**（本文所有 Enforce 策略的分类法）：模板身份白名单（按 [§2.1](#s2-1) 的三个层级；集群内定义的**变更权限**由标准 RBAC 单独封堵，见 [§4.1.2](#s4-1-2) —— 那一项不算在 Kyverno 可验证之列）；参数契约（以 TaskRun 层的实际取值为主路径，以 PipelineRun 层的提前拦截为辅路径）；入口封闭。**Audit / PolicyReport 是事后的第二道防线 —— 用于发现漂移和兜底告警；它不计入硬门禁的保证。** Audit 拦不住任何东西。

**失败 / 终止形态对照**（流水线使用者的速查表在 [§1.5](#s1-5)）：

| 形态 | 触发条件 | 运行终态 reason | 下游发布任务 | finally | 失败如何呈现 |
|---|---|---|---|---|---|
| 准入拒绝门禁 TaskRun 的创建（契约 2 的响应） | 门禁的实际参数不合规 | `CreateRunFailed`（终态；这里的"不重试"指的是**不会无限重试**，并不承诺只尝试一次；它**还有一个前提** —— 见下方 info 块的最后一项） | 从未被创建（`skippedTasks` 为空） | **不执行** | Kyverno 的策略消息原样传入 PipelineRun 的 condition |
| 门禁任务 exit 1（主线硬门禁） | 结果不达标 | `Failed` | 被 DAG 跳过；列在 `skippedTasks` 中（reason 为 `PipelineRun was stopping`） | **执行** | 门禁任务的日志 + "Tasks Completed: N (Failed: 1)" |
| mutate-existing 取消（[§4.6.1](#s4-6-1)） | 结果不达标（由 status 事件触发）；result 缺失或格式错误会以同样方式触发，失败关闭（**判据方向的失败关闭 ≠ 投递保证**：取消是在后台异步投递的，那条链路断掉时它会静默地不发生 —— 见 [§3.7](#s3-7) 的"异步投递链"一行） | 通常是 `Cancelled`；当产出 result 的任务本身先失败时则是 `Failed`（失败结论优先于取消；`spec.status` 仍然是 `CancelledRunFinally`） | 运行中的会以 `TaskRunCancelled` 停止 | **执行** | 父运行的 `cancel-reason` 注解（由同一个补丁写入；文本中会写明触发的 TaskRun 与越界的 result 值）+ 事件；配上配套的 Audit 规则时还会有一条 PolicyReport 记录 |
| mutate-existing 自我取消（[§4.6.2](#s4-6-2)） | 已解析定义发生漂移（回写进 `status` 的 `pipelineSpec` 与批准的身份不符） | `Cancelled` | 同上 | **执行** | 父运行的 `cancel-reason` 注解（说明漂移情况）+ 事件 |
| **用 mutate-existing 取消（RunFinally）替代对不合规门禁参数的 deny（[§4.2.2](#s4-2-2)）** | 在门禁 TaskRun 上检出不合规的实际参数 | 通常是 `Cancelled`；当取消与任务失败竞态时是 `Failed`（判定规则与上面两行相同：失败结论优先于取消，`spec.status` 仍然是 `CancelledRunFinally`；[§4.6.1](#s4-6-1) 的初始化窗口对这条路径同样适用） | 门禁之前的任务已经跑过；从门禁开始被取消 | **执行** | 通用的取消文本 + `cancel-reason` 注解 |
| **由准入 mutate 直接取消门禁 TaskRun 自身（deny 的同步替代方案，[§4.2.3](#s4-2-3)）** | 门禁的实际参数不合规 | `Cancelled` | 被 DAG 跳过；列在 `skippedTasks` 中（reason 为 `PipelineRun was stopping`） | **执行** | TaskRun 的 condition 原样带有策略写入的 `statusMessage`（在 tkn / UI 中可见）；PolicyReport 中没有违规记录 |

:::info 为什么"准入拒绝门禁 TaskRun"会跳过 finally（一个已知的社区问题）

该行为已在上游报告：https://github.com/tektoncd/pipeline/issues/10514 （*finally tasks are not executed when a child run creation is permanently rejected*；截至撰写时仍未关闭）。当前 ACP 版本所采用的社区 Pipelines 版本带有这个问题；在上游修复落地之前，下面的选型建议适用。机制如下：

- **机制**：finally 只有在整个 DAG 结束之后才被调度，而"结束"要求每一个 DAG 任务都落到 succeeded / failed / **skipped** 三者之一。被准入拒绝的门禁 TaskRun **从未被创建**，所以那个节点永远到不了这三种状态中的任何一种 —— DAG 永远不算结束，finally 永远不会被调度，而控制器很快就把该运行置为 `CreateRunFailed` 终态。
- **对比**：当门禁任务 exit 1 时，TaskRun 已被创建、已运行、已失败 —— 节点有了终态，DAG 可以结束，finally 照常执行。分界线是**门禁节点是否到达了终态**，而不是运行是否失败。
- **如何识别这种形态**：运行是 `CreateRunFailed`，没有任何子 TaskRun，finally 从未被创建，且 `skippedTasks` 为空。
- **为什么是终态而不是无限重试**：创建子运行失败时，控制器会先对错误做分类（上游 `pkg/reconciler/pipelinerun/pipelinerun.go` 中的 `handleRunCreationError`），**只有被判定为"永久性"的错误才会被写成 `CreateRunFailed`** —— 其余一律按可重试处理。准入拒绝之所以落进永久性这一类，是因为对于"webhook 拒绝但未给出状态码"的响应，API server 统一返回 400。**因此还存在另一种形态**：如果你的拒绝响应带上了已知的失败原因（例如 `Forbidden`），该错误可能被判为可重试 —— 症状就变成运行**卡在 Running、控制器反复重试创建同一个子运行**，而不是直接失败。看到这种卡住的形态时，别去查 DAG，去看拒绝响应的状态码和 reason。
- **"永久性"不等于"只尝试了一次"**：错误一旦落进永久性这一类，运行就会直接终止，但控制器**并不保证它只发出过一次创建请求** —— 单次运行的 `TaskRunsCreationFailed` 事件可能带有大于 1 的 `count`（`Failed` / `InternalError` 会合并计数）。所以本节承诺的是运行**会很快到达终态**，而不是只发过一次请求：排障时**不要把 `count > 1` 当成异常** —— 需要警惕的是上一条描述的那种形态，即运行**卡在 Running、控制器反复重试创建同一个子运行**。要按运行精确计数，用 `kubectl get events -n <ns> --field-selector involvedObject.uid=<pipelinerun-uid>`；按名字查询会把同名的历史运行遗留的旧事件一并算进来。

:::

:::warning 选型提示：依赖 finally 做通知 / 清理的团队请注意

- 在准入拒绝这种形态下（`CreateRunFailed`），finally **不会执行**；按上面的对照表，只有当门禁任务已经落地并随后失败、或者运行被显式以 `CancelledRunFinally` 取消时，finally 才会执行。
- 如果你的通知 / 清理必须在门禁参数被拦截时也照样触发，就不要把它单独挂在 finally 上 —— 改用**取消（RunFinally）**来替代 deny，有两条路线：
  - **[§4.2.2](#s4-2-2)（取消父运行）**：在扫描 TaskRun CREATE 时触发 mutate-existing，把父 PipelineRun 的 `spec.status` 补丁为 `CancelledRunFinally` 并打上原因注解；运行以 `Cancelled` 终止，但 finally 照常执行（由结果不达标触发的取消见 [§4.6](#s4-6)）。
  - **[§4.2.3](#s4-2-3)（另一种同步形态：取消门禁 TaskRun 自身）**：不动父运行，而是在准入期间把门禁 TaskRun 自身 mutate 为 `spec.status=TaskRunCancelled` —— 它在同一次准入过程中完成，没有竞态窗口，也不需要额外的 background-controller RBAC。
- 三种形态的权衡见 [§4.2.3](#s4-2-3) 的对照表。

:::

### 2.4 扩展模型：从自定义 Task 与 results 生长出策略 {#s2-4}

除了平台内置的扫描 / 门禁能力，每个组织都有自己的检查（自研 linter、许可证扫描、安全基线、制品规范……）。扩展路径分三步：

1. **让 Task 产出声明式的 results**：自定义 Task 把结论写成**可判定的 results** —— 一个数字（`error-count`）、一个枚举结论（`verdict: pass|fail`）、或一个结构化对象 —— 而不是"报告文件的路径"。Tekton 的 results 有三种声明类型 —— `string` / `array` / `object` —— 策略侧三种都能消费：`status.results[].value` 会按声明的类型序列化（string → 字符串，array → 字符串数组，object → 字符串映射），因此 JMESPath 拿到的是对应的原生结构：
   - **`type: object`（多字段结构用它）**：Task 声明 `type: object` + `properties`，策略用 JMESPath `.value.xxx` 直接下钻 —— 字段有名字、有 schema，策略永远不必解析任何文本格式。注意 `properties` 下的取值只能是 `string`（不支持嵌套的对象 / 数组）；需要层级时把字段名拍平；
   - **`type: array`（同构列表用它）**：取值是字符串数组；策略用 `[?...]`、`contains(...)`、`length(...)` 过滤 —— 例如"未修复的严重 CVE 列表必须为空"。它解决的是"多个值"，不是"多个字段"；语义不同的字段仍然应当放进 object；
   - **`type: string`（默认）**：单值最直接 —— 一个 result 放一个数字或一个枚举结论；策略用 `to_number` 转换或直接比较，零解析风险。
     - **聚合字符串（叠加在 `type: string` 之上的一种约定；属于兼容手段，不推荐）**：把若干字段以 `key=value` 拼接塞进一个 string result，策略侧再用 `split` + 正则 + `to_number` 拆开（[§4.4.2](#s4-4-2)）。**它确实能用** —— 但只在你要消费一份**暂时改不了的既有 Task 契约**时才这么做：文本格式不是稳定契约；字段顺序、分隔符、新增字段，以及"数量不可知"的哨兵值，都会造成静默失配 —— 而失配通常表现为**被误判为通过**。当契约由你掌控、且要聚合多个字段时，请用 `type: object`。
2. **用于硬门禁**：Task 自行给出结论并 exit 1（或者紧随其后放一个读取该 result 的门禁任务）—— 由此进入 [§2.3](#s2-3) 的契约体系，接受身份锁定与参数校验；
3. **用于可见性 / 兜底**：由 Audit 策略把 result 读进 PolicyReport（[§4.4](#s4-4)）；不达标的结果还可以额外触发自动取消（[§4.6](#s4-6)）。

**两层参数校验**（与契约 2 相同）：主路径 = 在 TaskRun CREATE 处校验展开后的实际取值（对任何模板开箱即用，模板作者零设计义务）；可选优化 = 当模板已经把开关 / 阈值暴露为 PipelineRun 级参数时，在 PipelineRun CREATE 处提前拦截。

**信任前提**：自定义 Task 与其他一切一样受契约 1 约束 —— 不可变引用 + 可信镜像。否则"推一个永远打印 pass 的脚本版本"就是成本最低的绕过方式。

Cookbook（[§4](#s4)）用一个虚构的、自包含的扫描任务（`policy-demo-scanner`）把这条扩展路径贯穿始终；来自平台 catalog 的真实 Task（如 sonarqube / trivy）则以画像小节的形式出现，配上它们真实的 result 契约。

### 2.5 残余风险台账（装完最小可用集之后，还剩哪些路径） {#s2-5}

[§1.4](#s1-4) 讲了 Kyverno 管什么、不管什么，[§2.3](#s2-3) 讲了七条契约各自由谁担保，而每一节都带有自己的"本节未覆盖什么"说明。本节把它们合并成一张表：**假设你已按 [§4.0.1](#s4-0-1) 装好最小可用集并修正了作用域，这就是你手上实际拥有的保证与暴露面。** 该表同时也是本文的范围声明 —— 标 ❌ 的行是本文**明确不覆盖**的内容，它们不是遗漏。

图例：✅ = 准入阶段的硬 Enforce 拦截（各类白名单共同的前提是名单填全，见 [§4.0.7](#s4-0-7) —— 下面不再逐行重复）；🟡 = 只有事后 Audit / 异步响应，或者能否拦截取决于 Kyverno 之外的条件（如模板设计）；❌ = 本文不覆盖。

| # | 绕过或失效路径 | 覆盖情况 | 靠什么封堵 |
|---|---|---|---|
| 1 | 完全不走 Tekton：直接创建 Pod / Job / Deployment，或在别处使用部署凭据 | ❌ | 用 RBAC 收窄工作负载 API 与凭据（[§1.4](#s1-4) / [§4.5.4](#s4-5-4)）—— 这一层本文封不住 |
| 2 | 用裸 `TaskRun` / `CustomRun` 绕过流水线 | ✅ | [§4.5.4](#s4-5-4)；这一行的"名单"指的是**合法的自动化创建者身份** —— 漏掉一个就会直接拦死一条合法路径 |
| 3 | 引用未批准的模板，或使用内联定义 | ✅ | [§4.1.1](#s4-1-1) 的三通道白名单 —— 内联会被它**天然拒绝**（不属于任何一个通道）。若要全集群一刀切禁止，还有 [§4.1.2](#s4-1-2) 中的 `disable-inline-spec`，但那是 **Tekton 自己的 webhook，不是 Kyverno**；[§4.1.3](#s4-1-3) 讲的是反向操作（谨慎地开一个例外），不是本行的拦截手段 |
| 4 | 引用坐标没变，但**远程定义的内容**被换掉了 | 🟡 | 只能锁定身份；对内容的信任来自 catalog / 仓库治理（[§2.1](#s2-1) 的三个层级），并叠加 [§4.1.4](#s4-1-4) 的事后漂移 Audit |
| 5 | 门禁被 `when` / 空 matrix 跳过（根本没产生 TaskRun） | 🟡 | 准入没有对象可拒；只能依靠模板不提供跳过路径 + [§4.1.5](#s4-1-5) 中读取 `skippedTasks` 的事后 Audit |
| 6 | 门禁开关被关掉、阈值被调、通过 override 注入（`taskRunSpecs` / `taskRunTemplate`） | ✅ | 官方模板用 [§4.2.5](#s4-2-5) / [§4.2.4](#s4-2-4) 的真实画像，**改好作用域与占位符即可用**；自建模板用 [§4.2.1](#s4-2-1)，但那一节**是模板而不是现成实现** —— 它的身份与参数契约必须针对你的门禁重写（[§4.0.1](#s4-0-1) 第 3 阶段） |
| 7 | 发布类任务不受门禁支配，或者把受门禁保护的副作用放进了 finally | 🟡 | 契约 5 / 6 属于模板设计责任；K 这一侧不提供现成判据（[§4.1.4](#s4-1-4) 只审计门禁身份；它的快照是你自建此类 Audit 的抓手）。**定义侧的准入路线本文没有采用**；其形态与代价见 [§4.1](#s4-1) 引言末尾 |
| 8 | 门禁消费的 result 不是目标任务的（接线接错，或被改接） | ❌ | 契约 4：准入看不到表达式层面的绑定；只有模板能保证 |
| 9 | 执行镜像被换成**同一个已批准仓库内**的另一个镜像，或者某个可变 tag 的内容被替换 | 🟡 | [§4.5.3](#s4-5-3) 判断的是前缀；要更强就固定 digest 或加上 `verifyImages`（见配套文档） |
| 10 | Pod 层面的其他面：privileged / `securityContext` / `automountServiceAccountToken` / 挂载 | ❌ | 同一个观测点本来可以做（[§2.1](#s2-1) 第 5 行），但**本文只提供镜像仓库前缀白名单**；治理这些需要额外的策略 |
| 11 | workspace 绑定：除 [§4.5.5](#s4-5-5) 的 kubeconfig 之外，被挂进流水线的其他 Secret / PVC | ❌ | 本文只治理"发布步骤的 kubeconfig 从哪来"这一处绑定；整个凭据面由 RBAC 与 Secret 治理承担 |
| 12 | 伪造的 result（扫描步骤自己写一个 `pass`） | 🟡 | 归入契约 1：不可变引用 + 可信镜像；[§4.6.1](#s4-6-1) 另有一处身份防伪检查 |
| 13 | 本该发生却没发生的取消（mutate-existing 的异步投递链断了） | 🟡 | 失败开放；按 [§3.7](#s3-7) 的"异步投递链"一行做监控；要同步的硬保证就改用 [§4.2.1](#s4-2-1) / [§4.2.3](#s4-2-3) |
| 14 | 修改 Kyverno 自身配置、策略对象或 PolicyException | ❌ | 不在本文威胁模型内；靠 RBAC 职责分离与变更审计封堵（[§5.0](#s5-0) / [§5.3](#s5-3)） |
| 15 | 新命名空间 / 新集群未被纳入治理 | 🟡 | 两者都会**被静默放行**：按 [§3.6](#s3-6) 第一行更新作用域；本文不提供跨集群下发机制（[§7.3](#s7-3)） |
| 16 | 以 `v1beta1` 提交 `PipelineRun` / `TaskRun`（在环境仍然提供该版本的情况下） | ✅ | **这一行不是暴露面，之所以列出来是因为它经常被误当成暴露面**：Kyverno 生成的 webhook 是 `matchPolicy: Equivalent` 且只注册 `v1`，所以 API server 会先把 `v1beta1` 请求转换成 `v1` 再送去评审 —— 在 `kinds` 里只写 `tekton.dev/v1` 就已经覆盖了。**真正会开口子的是"为保险起见把 `v1beta1` 也加进 `kinds`"** —— 从此转换不再发生，**跨版本被改名的字段路径**读出来是空的，依赖它们的判据会静默跳过（两个版本共有的路径仍能解析，所以这是**部分**失效 —— 更难被发现）。细节见 [§3.2](#s3-2)"API group-version 前提"；`CustomRun` 是例外 —— 它只有 v1beta1 |
| 17 | `StepAction`（step 级远程引用）、Tekton Chains / provenance、资源配额与并发滥用 | ❌ | 不在本文范围内；不做分析、不给判据 —— 需要时各自用对应机制治理 |
| 18 | 判据所依赖的"实际取值"还有请求之外的来源（sonar 的 properties 文件可能来自被扫描的仓库或某个 workspace） | 🟡 | 准入只能看到请求本身。对于分支取值，[§4.2.4](#s4-2-4) 已经对文件来源免疫（参数非空时 Task 会用它覆盖文件中的值；参数缺失时判据按保护范围处理）；剩下的路径是：在文件中注入一个非空的 `sonar.pullrequest.key`，静默地把分析切到 PR 模式 —— 这由仓库治理（[§2.1](#s2-1)）与受评审对象的内容管控（[§2.3](#s2-3) 契约 1）承担 |
| 19 | [§4.2.4](#s4-2-4) 契约收窄的已知误拒面：① 契约之外的形式一律被拒 —— `sonarProperties` 中出现受管键（即便参数会覆盖它们）、注释行、行首空白、单个元素内嵌换行、重复的 PR 声明或取值中含空白；② `sonarBranchName` 缺失 + 仓库 properties 文件把分析指向某个特性分支 + 门禁被显式关掉，这三者的组合 | 🟡 | 方向为失败关闭：① 按拒绝消息与 [§4.2.4](#s4-2-4) 第一个 warning 中的对照表改写成推荐形式即可放行；② 该次运行显式传入特性分支的取值。确实处于契约之外的历史形态，走 [§5.3](#s5-3) 的显式豁免 |

**这张表怎么用**：① 上线前，逐行走一遍标 ❌ / 🟡 的条目，确认"在我的组织里这一项归谁负责" —— 没有责任人的行就是真实暴露面；② 对外汇报"这套策略集保证了什么"时，只引用标 ✅ 的行，绝不要把 🟡 说成 ✅；③ 每次升级或作用域变更之后回来重读一遍（[§3.6](#s3-6)）。

## 3. 通用配置与运营纪律 {#s3}

本章一次性完成后续各章都依赖的环境验证与共享资源（[§3.1](#s3-1)–[§3.4](#s3-4)），并给出这些策略上线之后你要持续遵守的运营纪律（[§3.5](#s3-5)–[§3.8](#s3-8)：分阶段上线、变更触发条件、规模与故障预算、升级回归集）。**上手只需要前半部分；后半部分是策略进入生产之后，你会一次又一次回来查阅的内容。**

:::warning 这些命令在哪个集群上执行

**本文中的 `kubectl` 命令默认在承载 Kyverno 与 Tekton 的业务集群上执行**（下文称目标集群）—— 包括本章的验证清单与夹具，以及 [§4](#s4)–[§6](#s6) 中的每一条策略和探针。

**唯一的例外是 [§3.1.1](#s3-1-1)**：修改平台托管组件的配置要通过全局管理集群上的 `ModuleInfo`；该节的命令都显式带有 `--kubeconfig <path-to-global-kubeconfig>` —— 请照原样书写，不要复用当前 context。

动手之前，先确认你当前的 context 指向目标集群；不要在全局集群上创建演示资源：
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

两个组件都通过 ACP 的模块化机制安装，且都支持离网环境：

- **Kyverno**：管理员视图 → **应用市场 → 集群插件** → 搜索 `kyverno` → 安装 **"Alauda Container Platform Compliance for Kyverno"**。安装完成后，Kyverno 由平台以 Helm / AppRelease 方式纳管，四个控制器部署在 `kyverno` 命名空间中。
- **Tekton Pipelines**：管理员视图 → **应用市场 → OperatorHub** → 安装 **"Alauda DevOps Pipelines"**；此后由 `TektonConfig` 管理 Pipelines / Triggers / Chains 以及各 resolver 的开关。

产品文档：合规管理（Kyverno）的安装与配置、DevOps（Tekton）的安装 —— ACP 官方文档链接见 [§8.2](#s8-2)。

:::warning 不要直接在 Deployment 上改被纳管的配置

ACP 的 Kyverno 由平台模块（Helm / AppRelease）纳管，并且会被**周期性调和** —— 任何直接 `kubectl patch` 控制器 Deployment 所做的参数改动（例如手工加上 `--exceptionNamespace`），**都会在下一次调和时被还原**。所有控制器级别的配置，都必须通过平台模块的配置入口持久化（做法见 [§3.1.1](#s3-1-1)）。

:::

**先确认三个前提，否则下面的命令会给出误导性的结果**：
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

安装完成后，逐项验证本方案所依赖的每一项能力。这份清单是一份**能力清单，而不是"全绿之后才允许往下走"的门禁**：第 1、2 项是共同前提；第 3、4、5 项只有当你用到对应章节的能力时才需要成立；第 6 项的**层级选择**没有对错之分 —— 那属于规划输入 —— 但它的**声明与生成出来的分组必须一致**（不一致时按补救表处理）；而第 7 项是**唯一一项"与预期不符就意味着整整一章的策略形同虚设"的检查**。**每一项与预期不符时该去哪里修，见代码块之后的补救表。**
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
**每一项的预期值，以及结果不符时该去哪里**（先读这张表，再看表下面三条容易误判的解读）：

| 检查项 | 预期 | 与预期不符时 |
|---|---|---|
| 1 控制器就绪 | 四个控制器全部 Ready | 先看插件的安装状态（应用市场 → 集群插件）与 Pod 事件定位故障；副本数按 [§6.1.8](#s6-1-8) 的高可用规划来定，而且这项改动同样要走 [§3.1.1](#s3-1-1) 的 `ModuleInfo.spec.valuesOverride` 入口 —— 对应的 chart values 键是 `admissionController.replicas` / `backgroundController.replicas` / `cleanupController.replicas` / `reportsController.replicas`（四者都可以直接在已部署 `AppRelease` 的 values 里查到；写入之前，按 [§3.1.1](#s3-1-1) 同样的方法确认你环境中该 chart 的实际键名）—— **不要直接改 Deployment**（平台调和会把它还原） |
| 2 resolver 开关与 hub 端点 | 你实际使用的 resolver 为 `true`；Hub 的 `default-type` 为 `artifact`；`artifact-hub-api` 指向集群内的 Artifact Hub（Shim）服务；**2b 冒烟测试的五个坐标全部返回 200** | 这两个 ConfigMap 由 Tekton operator 纳管，直接编辑会被还原 —— 改 `TektonConfig.spec.pipeline`：按需把 `enable-cluster-resolver` / `enable-hub-resolver` / `enable-git-resolver` 设为 `true`；Hub 端点与输出类型都在**同一个位置** `TektonConfig.spec.pipeline.hub-resolver-config`（一个字符串映射，键名与 ConfigMap 一致：`artifact-hub-api` / `default-type` / `default-artifact-hub-task-catalog` / `default-artifact-hub-pipeline-catalog`），operator 会把它调和进 `tekton-pipelines/hubresolver-config`。**不要走 `spec.hub`** —— 那一节配置的是 Tekton Hub 组件本身，不是 hub resolver。如果你不想动平台配置，就让每一个 Hub 引用都显式带上 `type=artifact`（[§4.5.1](#s4-5-1)）。**2b 冒烟测试出现 404**：先看 `artifact-hub-api` 是不是集群内 Shim 的地址（若指向公共 hub，本文所有 hub 引用都会以 `CouldntGetPipeline` / `CouldntGetTask` 失败，而上面三个开关却一片绿），再看坐标中的 catalog 与 package 名称是否与你环境实际发布的一致；如果端点指向公共 Artifact Hub，就按环境配置问题处理 —— 请平台管理员把它改回集群内 Shim 之后再继续。**冒烟测试出现 UNREACHABLE**：探针 Pod 没有到该地址的网络 / DNS 通路；先修连通性，再谈策略 |
| 3 mutate-existing RBAC | 如果你要用 mutate-existing 取消能力（[§4.2.2](#s4-2-2) 与 [§4.6](#s4-6)，共三条策略），应返回 `yes` | 返回 `no` 时，授予 [§4.6](#s4-6) 引言中给出的聚合 ClusterRole（其 labels 中的 `rbac.kyverno.io/aggregate-to-background-controller: "true"` 会把它聚合进 background controller 的权限）。**如果你想改用命名空间级的 Role，还必须把 `mutate.targets[].namespace` 从 `{{ request.namespace }}` 改成命名空间字面量** —— 否则 Kyverno 创建时的鉴权检查无法解析该变量，只认集群级权限，策略照样装不上（见 [§4.6](#s4-6) 引言）。**如果你不安装 [§4.2.2](#s4-2-2) / [§4.6](#s4-6) 的 mutate-existing 取消策略，这个权限就不需要 —— [§4.2.3](#s4-2-3) 的准入 mutate 修改的是请求对象本身，用不到它** |
| 4 reports-controller 读取 status | 六项全部 `yes`（可选，非必需） | 出现 `no` **通常不需要处理**（理由见下面第三条解读）。只有当确实有别的功能需要 reports-controller 直接读取 status 时，才按第 3 项同样的聚合方式再加一个最小权限的 ClusterRole，把聚合标签换成 `rbac.kyverno.io/aggregate-to-reports-controller: "true"` |
| 5 PolicyException 开关 | `--enablePolicyException=true` 与 `--exceptionNamespace=<trusted-namespace>` 两者都在 | 只看到前者是 ACP 的默认状态 —— 按 [§3.1.1](#s3-1-1)，把 `features.policyExceptions` 的 `enabled` / `namespace` 写进 kyverno `ModuleInfo` 的 `spec.valuesOverride["ait/chart-kyverno"]`（**`ModuleInfo` 只存在于全局管理集群**，见 [§3.1.1](#s3-1-1) 的警告）；**不要 patch Deployment 的启动参数**。[§3.1.1](#s3-1-1) 提供了可直接复制的原子 patch 与回滚命令。**如果你不打算使用 PolicyException 豁免（[§5.3](#s5-3)），这一项无需配置** |
| 6 Webhook 失败策略与超时 | **先读策略正文中声明的意图，再看生成出来的结果**（字段语义、生成侧的 ⚠️ 时序陷阱，以及平台级覆盖开关的影响，都在 [§3.1.2](#s3-1-2) —— 那里才是这套机制的完整版）：用 `kubectl get clusterpolicy -o custom-columns='NAME:.metadata.name,FAILURE_POLICY:.spec.webhookConfiguration.failurePolicy,TIMEOUT:.spec.webhookConfiguration.timeoutSeconds'` 看声明意图（当 [§5](#s5) 的命名空间级 `Policy` 也在用时，还要用同样的列去读 `kubectl get policy -A` —— 它们不会出现在 clusterpolicy 列表里，漏掉就等于它们的声明没被检查过），然后看生成出来的 webhook，它们是**按取值分组生效**的（`validate.kyverno.svc-fail` / `validate.kyverno.svc-ignore`，各自带有自己的 `failurePolicy` / `timeoutSeconds`）。本文所有策略素材都显式声明了这两项（分级理由见 [§3.7](#s3-7)） | 若声明与分组不一致，或某条策略需要不同的层级：**改那条策略正文里的 `spec.webhookConfiguration` 并用 GitOps 管理** —— 这是唯一能表达按策略分级的入口；三个陷阱（`ModuleInfo` 只能做平台级覆盖、`timeoutSeconds` 是单次请求的总预算、绝不要手工编辑 `ValidatingWebhookConfiguration`）见 [§3.1.2](#s3-1-2) |
| 7 Kyverno 直接忽略的资源 | 过滤列表中**没有**任何一条覆盖到跑流水线的命名空间，也没有任何一条覆盖 `PipelineRun` / `TaskRun` / `Pod` | `kyverno` ConfigMap 中的 `resourceFilters` **先于任何策略**生效：被命中的请求既不会被拒绝，也不会进 PolicyReport，更不会有日志 —— 这是一条**完全静默**的豁免通道。出厂值通常会排除四个命名空间（**以上面命令实际读到的值为准**）—— `kyverno` / `kube-system` / `kube-public` / `kube-node-lease`：同一个违规 Pod 在 `policy-poc` 里被拒，在 `kube-system` 里却一路畅通。因此 ① 不要在被排除的命名空间里跑流水线；② 要清楚用 `namespaces: ["*"]` 写出来的策略天然带着这个洞；③ 对这份配置的写权限，必须与 `ClusterPolicy` 同级别地管控（[§5.0](#s5-0)） |

上面有三条解读特别容易搞错：

- **第 2 项的 `default-type`**：本文允许 Hub 引用省略 `type` 参数，前提是这项平台设置输出的是 `artifact`。如果不是，要么先治理那项平台设置，要么要求每个 Hub 引用都显式写上 `type=artifact`（[§4.5.1](#s4-5-1)）。
- **第 4 项必须带上 `--subresource=status`**：把 `taskruns.tekton.dev/status` 当作位置参数传给 `kubectl auth can-i`，会被解析成 `TYPE/NAME` —— 你查的其实不是 status 子资源权限，而是一个名叫 `status` 的对象。
- **第 4 项返回 `no` 并不意味着要马上放权**：`background: false` 的 status Audit 是通过 admission-report 链路聚合的，并不要求 reports-controller 直接读取 TaskRun / PipelineRun 的 status；即便六项权限全是 `no`，[§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2) 照样能产出终态的 PolicyReport。所以**不要仅仅因为策略创建时冒出一条权限告警就去扩大 ClusterRole** —— 先跑一次真实的受控请求，确认 PolicyReport 是否从早期的 skip 收敛到终态的 pass/fail；只有当确实有别的功能需要 reports-controller 直接读 status 时，才单独按最小权限授予。
#### 3.1.1 启用 PolicyException（可选；[§5.3](#s5-3) 需要） {#s3-1-1}

ACP 的 "Compliance for Kyverno" 插件**默认只带 `--enablePolicyException=true`，不带 `--exceptionNamespace`**。这个默认状态最具欺骗性：PolicyException 对象**能创建成功**，只会附带一条 `The exceptionNamespace flag is not set` 的告警 —— 但它**完全不起作用**：豁免已经放在那里了，目标资源却照样被拒。这两个参数必须一起配置，而且 Kyverno 只认 `--exceptionNamespace` 所指命名空间里的 PolicyException（这正是豁免权限被封闭起来的地方，[§5.3](#s5-3)）。该参数**接受单个命名空间名，或者 `*`**（表示任意命名空间中的 PolicyException 都生效）—— **不支持多个命名空间**（已在 Kyverno 1.15 系列上确认；多命名空间列表的需求曾在上游提出 —— [kyverno#6980](https://github.com/kyverno/kyverno/issues/6980) —— 并于 2026-01 以 not-planned 关闭，原因是 informer 只有"单命名空间 / 整个集群"两种形态，实现复杂）。在多项目 / 多租户环境中，这个单值约束会落成两种做法之一：

- **集中审批（本文采用）**：可信命名空间**属于审批方（平台）**；项目成员从不进入它 —— 豁免走申请-审批流程，由审批者身份代申请方签发（这正是 [§5.3](#s5-3) 演示的模型）。项目之间天然的隔离不受影响：这个命名空间不是项目共享的空间，而是审批流程的落点。**不要**让多个项目共用一个可信命名空间、各自自助签发豁免 —— RBAC 只能管住"谁可以创建 PolicyException"，管不住"豁免的内容是否越界"（`spec.match` 可以写任意命名空间），于是项目 A 能创建一个把项目 B 的流水线豁免掉的例外。
- **项目自治（`*`）**：各项目在自己的命名空间里创建 PolicyException，签发权限随项目 RBAC 走。这种模式下你**必须**再加一条元策略，限制 PolicyException **只能豁免其自身命名空间内的资源** —— 没有它，上面那个"内容越界"的问题在每个命名空间里都成立；同时每个项目里对 `policyexceptions` 的写权限都必须显式收紧 —— 默认角色不应带有它。

:::warning ModuleInfo 只存在于全局管理集群；业务集群上没有这个资源
`ModulePlugin` / `ModuleConfig` / `ModuleInfo` 都是平台管理面对象，**只存在于全局管理集群**。在跑 Kyverno 的业务集群上执行 `kubectl get moduleinfo` 什么都查不到 —— 那个集群上连这个 CRD 都没有。因此**本节的定位与 patch 命令必须用全局集群的 kubeconfig 执行**；而第 4 点的三处确认中，② Deployment 的 args 与 ③ rollout 及 Pod 上实际生效的参数，必须在 **Kyverno 所在的集群**上执行。

还要注意，在 global 上，一个插件**对每个安装目标集群各有一个 `ModuleInfo`**，所以在断言"恰好命中一条"之前，必须先按目标集群收窄 —— 平台用 `cpaas.io/cluster-name` 标记投放目标；安装在全局集群自身上的实例可能不带这个标签，此时改用指向其 `Cluster` 对象的 ownerReference 来识别。

下面的命令按 Kyverno 与 Tekton 在同一集群编写，因此不涉及跨集群切换；如果你的环境把两者分开部署，请按上面的说明把命令拆到两侧执行。

:::

正确的启用路径有四个要点：

1. **绝不要直接 patch 控制器 Deployment 的 args** —— 平台调和会把它还原（见上面的警告）。
2. **覆盖入口是插件 `ModuleInfo` 的 `spec.valuesOverride`**，不是 `spec.config`。kyverno 的 `ModuleInfo` 默认 spec 里只有 `version`；`spec.config` 是模块实例的用户配置，不是 chart values 的覆盖面 —— 改错字段就什么都不会生效。`valuesOverride` 按 **chart 名**分层（与 `ModuleConfig.spec.valuesTemplates` 同构），而 chart 名是 `ait/chart-kyverno`。
3. **定位 ModuleInfo 时必须断言唯一性**：在全局集群上，按模块标签精确查询，再按目标集群标签收窄，然后硬断言恰好命中 1 条；不要靠版本号或 `global-` 前缀去猜，也不要默默取 `items[0]`。
4. **改完之后，三处都要确认，一处都不能少**：① `AppRelease` 已经合并了 values；② Deployment 模板的 args 里带上了该参数；③ rollout 已经完成，而且**每一个 Ready 的 admission Pod** 实际运行的都是新参数。只看 Deployment 模板，或者只碰到一个新 Pod，都不足以证明高可用滚动更新期间所有在服务的实例都已经切换过来。

:::warning 单节点 / CPU 紧张的集群：配置对了，参数照样可能没生效

admission-controller 的 rollout 是**先起新 pod、再退旧 pod**（`maxUnavailable` 实际为 0）；在 CPU 不足的节点上，新起的 pod 会 Pending，rollout 卡住，旧 pod 继续提供服务，症状就是 PolicyException 依然报 `exceptionNamespace flag is not set` —— 这不是配置错误。**判据只有一个：在服务的 pod 实际跑的是什么参数**（第 4 点的 ③）；参数出现在 Deployment 模板上，不等于它出现在在服务的 pod 上。卡住时，腾出节点资源让 rollout 自行完成 —— 别指望删掉某一个旧 pod 就够了（新 pod 的实际资源请求未必等于模板中的值）。

:::

⚠️ **先看清它当前指向哪里**：`--exceptionNamespace` **只接受一个取值**。如果集群上已经启用了它、并且指向另一个承载着真实豁免的命名空间，那么把它改成演示用的取值，会让**那些豁免立刻全部失效**（并且一直失效到你改回去为止）。这种情况下就不要改 —— 直接复用既有的可信命名空间来做 [§5.3](#s5-3)（[§5.3](#s5-3) 开头读的正是这个值；正文中的 `policy-exceptions` 只是本文 [§3.1.1](#s3-1-1) 配置出来的取值，不是一个你必须对齐的常量）。这项改动是**目标集群上全局唯一**的开关；任一时刻都应该只有一个人在动它。

**本节需要你提供的所有取值都汇总在下面这个输入块里** —— 后续每个块（a)–g)、落盘块、回读块）都只引用这里设置的变量，不再出现任何 `<...>` 占位符，所以这个块必须先执行：
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

上一条命令打印出来的 API server 地址，必须是**你打算修改的那个全局集群**；如果不是，先修 kubeconfig 再继续。

**执行顺序总览** —— a)–g) 都放在下面的折叠块里，顺序不能变，而且**不要把整个折叠块一次性粘贴执行**（e) 是回滚 —— 一口气跑完等于刚启用就立刻还原）：

1. **开工前先查有没有旧账本**：如果 `ls moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json 2>/dev/null` 有输出，说明上一轮启用没有回滚过 —— 先用"在新终端中恢复回滚状态"那个块把状态载回来，跑 e)–g) 把那一轮收尾，再开始新的一轮。这一步必须发生在 a) 之前：一旦 c) 执行过，那个全局唯一的开关就已经被改掉了。
2. **启用**：a) 定位并断言唯一性 → b) 保存原值 → **落盘**（把回滚状态持久化进上面那三个文件；它必须在 c) 之前 —— c) 不可逆，而在状态落盘之前，"原值"只存在于当前 shell 里：那一刻关掉终端它就永远没了，事后再跑 b) 只会把改后的值记成原值）→ c) 原子写入 → d) 三处确认。
3. **使用**：去执行 [§5.3](#s5-3)；全部做完并清理干净之后再回来回滚。
4. **回滚**：e) 原子还原 → f) 用与 d) 相同的方式确认已生效 → g) 删除回滚文件。如果中途换过终端，先用"在新终端中恢复回滚状态"那个块从文件重建状态 —— **绝不要重跑 b)**。这次还原属于平台侧配置，它不归属于任何一节的"清理"小节，只能在这里手工执行。

:::details 启用与回滚命令（原子 JSON Patch，可直接复制）

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

**b) 执行完之后，先落盘再动 c)** —— e) 所依赖的状态（`GLOBAL_KUBECONFIG`、`MODULE`、两份 spec）此刻只存在于当前 shell 中；先把它写进那三个回滚文件，看到 `saved:` 之后再继续：

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

d) 的三处确认通过之后，就去执行 [§5.3](#s5-3)；只有当 **[§5.3](#s5-3) 的全部步骤**都做完并清理干净之后，才回来执行 e)–g)。如果你换过终端，先用下面"在新终端中恢复回滚状态"的折叠块重建状态。

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

**从文件里读取目标，不要靠重新查询来挑**：

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

把 a) 再跑一遍作为交叉核对是可以的，但**查询结果必须与 `moduleinfo-target.txt` 逐字一致 —— 不一致就停下来查清楚**。**绝不要重跑 b)** —— 到那时集群上的 spec 已经是改过的了，b) 会把"原值"记成改后的值，回滚就永远丢了；除了目标和这两份 spec 之外，e) 不依赖 b) 的任何东西。

:::
#### 3.1.2 Webhook 失败策略与超时：字段语义、读取时机，以及如何切换层级 {#s3-1-2}

本小节展开清单第 6 项，是本文中 `failurePolicy` 机制的**唯一事实来源** —— [§3.7](#s3-7) 的分级权衡、[§4.0.7](#s4-0-7) 第 1 步的部署检查、[§6.1.8](#s6-1-8) 的控制面观测，都回指到这里；机制层面的修订只落在本小节。

- **字段语义**：策略级的入口是每条策略自己的 `spec.webhookConfiguration.failurePolicy` / `.timeoutSeconds`（同一条策略内的所有 rule 共用；取值为 `Ignore` / `Fail`，默认 `Fail`；超时默认 `10`，范围 1–30 —— 依据 1.15 的 CRD）。旧的顶层 `spec.failurePolicy` / `spec.webhookTimeoutSeconds` 已废弃，新旧同时声明会在安装时被拒。`timeoutSeconds` 是**单次请求的总预算**，不是每条 rule 的配额 —— [§3.7](#s3-7) 中的外部调用必须塞进这个数字之内。
- ⚠️ **读取生成侧对时机很敏感**：`kyverno-resource-validating-webhook-cfg`（真正管着 `PipelineRun` / `TaskRun` / `Pod` 的那一个）是 **Kyverno 依据已安装策略动态生成的** —— 在本文的策略一条都没装时，它的 `webhooks` 是空的；那时你能读到的 `Fail/10` 都属于 Kyverno **自身 CR** 的 webhook（policy / exception / cleanup / ttl）。**装完 [§4](#s4) 的任意一条策略之后再回来读生成侧。**
- **平台级覆盖开关表达不了分级**：对这项设置而言，[§3.1.1](#s3-1-1) 的 `ModuleInfo` 入口**只服务于平台级覆盖** —— 例如开启 `features.forceFailurePolicyIgnore.enabled` 之后，每条策略都按 `Ignore` 生效，所有声明的 `Fail` 全部落空。**不要用它替代策略正文里的声明**；反过来，检查时**只读声明也不够**：只有生成出来的分组才反映覆盖之后的实际取值 —— 一条声明为 `Fail`、而其 webhook 却落在 `-ignore` 分组里的策略，就是被平台强制覆盖了；先解决覆盖问题，再谈分级。每个集群上这个开关的状态，都必须作为集群级项目纳入基线漂移检查（[§3.6](#s3-6) 的"新集群"一行；范围同 [§7.3](#s7-3)）。
- **绝不要手工编辑 `ValidatingWebhookConfiguration`**：它是 Kyverno 自己维护的对象（带有 `webhook.kyverno.io/managed-by=kyverno`），手工编辑会在按策略重算分组时被覆盖。切换层级唯一正确的路径，是策略正文中的 `spec.webhookConfiguration`，并用 GitOps 管理 —— 它也是唯一能表达 [§3.7](#s3-7) 那种按策略分级（"硬门禁 `Fail`，记账型 Audit 可以 `Ignore`"）的入口。

### 3.2 适用版本与依赖特性 {#s3-2}

适用范围写在本文开头的"适用版本"框里：判定依据是 **Alauda DevOps Pipelines v4.14.x 及以上**，而不是 ACP 的版本。在更早的版本上，下面这些依赖特性并不完整，策略可能不是报错而是静默地停止生效 —— 机制章节在那些版本上照样值得读，但不要直接套用本文的策略素材与示例。

具体依赖的特性（在旧版本上，这就是你的降级检查清单）：

- **Tekton**：`tekton.dev/v1` API、object results（`enable-api-fields: beta`）、`status.pipelineSpec` 回写、`status.childReferences`、`spec.status: CancelledRunFinally`、cluster / hub / git resolver；
- **Kyverno**：子资源匹配（`kind/subresource` 形式）、mutate-existing（`targets`）、`context.apiCall`、`foreach` + `element`、PolicyException v2（`--enablePolicyException` + `--exceptionNamespace`）。

**API group-version 前提**：本文策略的 `match` 块中，`PipelineRun` / `TaskRun` 及其 `/status` 子资源一律写 `tekton.dev/v1`，依据是在适用版本中 Tekton 把 `v1` 作为这三者的存储版本与提供版本。**唯一的例外是 `CustomRun`**（[§4.5.4](#s4-5-4) 与 [§5.3](#s5-3) 的入口封堵策略）：Tekton 只在 `v1beta1` 中定义并注册这个类型 —— 它在 `v1` 里根本不存在 —— 所以那两处写 `tekton.dev/v1beta1/CustomRun` 不是疏漏，也不能顺手"统一成 v1"—— 一改规则就会**静默失配**。

**它们的 `v1beta1` 通常也仍在提供服务**：在上游 Tekton Pipelines 各版本发布的 CRD 中，`pipelineruns.tekton.dev` 与 `taskruns.tekton.dev` 的 **`v1beta1` 与 `v1` 都是 `served: true`**（只有 `v1` 是 `storage: true`）—— "两个版本同时可提交"是默认形态，而不是什么特殊配置。**但这并不构成绕过** —— 下面的警告解释了为什么（一句话：请求在到达 Kyverno 之前，API server 已经把它转换成 `v1` 了，**所以不要**因此把 `v1beta1` 加进 `kinds`）。上游 CRD 的证据不等于你环境里的那一份；安装之后，仍然建议确认一次实际提供的版本：
```bash
# Which tekton.dev versions this cluster actually serves. A v1beta1 row for
# PipelineRun / TaskRun is NORMAL and does not bypass these policies -- see the
# warning below for why (the API server converts such requests to v1 first).
kubectl get crd pipelineruns.tekton.dev taskruns.tekton.dev customruns.tekton.dev \
  -o jsonpath='{range .items[*]}{.metadata.name}{": "}{range .spec.versions[*]}{.name}{"(served="}{.served}{",storage="}{.storage}{") "}{end}{"\n"}{end}'
```

:::warning 用 `v1beta1` 提交并不会绕过这些策略 —— 把 `v1beta1` 写进 `kinds` 才会

**结论：什么都别加** —— `kinds` 里只写 `tekton.dev/v1`。Kyverno 生成的资源 webhook 是 `matchPolicy: Equivalent` 且只注册 `v1`，因此 API server 会**先把 `v1beta1` 请求转换成 `v1`，再送去准入**，字段名已经规范化（`spec.serviceAccountName` → `spec.taskRunTemplate.serviceAccountName`、`taskPodTemplate` → `podTemplate`，等等）。**反过来，只要 `v1beta1` 出现在 `kinds` 里，这次转换就不再发生**，送到准入的是原始的 `v1beta1` 对象 —— **那些在两个版本之间搬过家的字段路径**从此读出来是空的，依赖它们的判据静默跳过，这才是真正的放行漏洞。

**注意这里的失效是"部分的"而不是"整体的"** —— 别指望规则会在你看得见的地方整个崩掉：两个版本路径未变的共有字段（`spec.taskRef` 及其 resolver 参数、`spec.params` 等）在 `v1beta1` 对象上照样读得到，基于它们的判据照常拒绝。真正读成空的，是那些搬过家的 —— `spec.serviceAccountName` → `spec.taskRunTemplate.serviceAccountName`、`taskPodTemplate` → `podTemplate` 之类。所以症状是**同一条规则里的部分判据失效**，比整条规则跳过更难被发现。

对于一条只声明了 `tekton.dev/v1/PipelineRun` 的策略，两种写法的实际行为如下（适用版本以本文开头的表格为准）：

| 以 `v1beta1` 提交，而策略的 `kinds` 为 | Kyverno 看到的对象 | 判据读到的值 |
|---|---|---|
| 只写 `v1`（本文的写法） | `apiVersion: tekton.dev/v1`（`requestKind` 仍是 `v1beta1`） | 全部正常读到 |
| `v1` **加上** `v1beta1` | `apiVersion: tekton.dev/v1beta1` | 共有路径照常读到；**跨版本改名的路径**返回 `ABSENT`，依赖它们的判据跳过 |

安装之后自查一次（该对象**只有在策略装上之后才有内容**；输出为空只说明还没装任何策略）：

```bash
# matchPolicy must be Equivalent, and apiVersions must NOT list v1beta1.
kubectl get validatingwebhookconfiguration kyverno-resource-validating-webhook-cfg \
  -o jsonpath='{range .webhooks[*]}{.name}{" matchPolicy="}{.matchPolicy}{" apiVersions="}{range .rules[*]}{.apiVersions}{end}{"\n"}{end}'
```

**`CustomRun` 不受本段影响**：它只有 `v1beta1` 一个版本，没有可供转换的对应版本；在 [§4.5.4](#s4-5-4) / [§5.3](#s5-3) 中写 `tekton.dev/v1beta1/CustomRun` 是必须的。

:::



其中，**只有 `enable-api-fields` 会在最开始就把你拦住**：[§3.3](#s3-3) 的夹具 Task 声明了一个 `type: object` 的 result，当这个开关不是 `beta`（或 `alpha`）时，Tekton 自身的准入会直接拒绝 `kubectl apply -f public-fixtures.yaml` —— **拦截点在共享夹具里，而不在任何策略里**，很容易被误判成 Kyverno 的问题。所以先读它（`TEKTON_NS` 按 [§3.1](#s3-1) 设置）：

```bash
# Either read is fine; they must agree. Expect: beta (alpha also enables object
# results). Anything else -- including empty output -- means object results are off.
: "${TEKTON_NS:=tekton-pipelines}"   # §3.1 sets it; this only covers a fresh shell
kubectl -n "$TEKTON_NS" get configmap feature-flags \
  -o jsonpath='{.data.enable-api-fields}{"\n"}'
kubectl get tektonconfig config \
  -o jsonpath='{.spec.pipeline.enable-api-fields}{"\n"}'
```

当它不是 `beta` 时，**改 `TektonConfig` —— 不要直接编辑 ConfigMap**：operator 的下一次调和会把手工编辑的 ConfigMap 还原（与 [§3.1.1](#s3-1-1) 同样的纪律）。在验证环境上，两次读取返回的都是 `beta`。

**模板 → Task → result 契约版本矩阵。** Cookbook 中每一个真实画像都按版本固定：不同版本可能带有不同的 result 契约，跨版本套用会以**静默失配**收场。

**下面这张表是本文唯一的契约基线**：参数名、类型、默认值与 result 形态，以此处为准。**升级这些版本时的行动项在 [§3.6](#s3-6)（哪些判据受影响）与 [§3.8](#s3-8)（升级后要跑什么）。** 后续各节会就地重复与自己判据相关的那一两行（这样你可以边读边写策略），但**升级模板 / Task 版本时，你只需要回到这张表逐行重新核对** —— 不必再去翻各节零散的注记。矩阵中的模板与 Task 定义随 **Alauda Artifact Hub Shim v1.0.0** 一同发布（ACP 内置 hub：一个兼容 Artifact Hub 的 API，供 Tekton 的 hub resolver 使用）；**更高版本的 Shim 可能会改动这些定义** —— 升级 Shim 与升级模板 / Task 版本按同样方式处理，见 [§3.6](#s3-6) / [§3.8](#s3-8)。

| 模板 / 场景 | 包含的关键 Task（版本） | 消费的 result / 参数契约 |
|---|---|---|
| 官方 `java-image-build-scan-deploy` 0.3、`python-image-build-scan-deploy` 0.3 | `sonarqube-scanner` 0.7 | `code-scan-results`（object：result/reportURL/taskID/projectID）、`code-scan-metrics` |
| 同上 | `trivy-scanner` **0.6**（两个模板都固定这个版本） | `trivy-summary-metadata`（object，11 个键，**推荐的消费形态**）+ `trivy-summary`（array，其首个元素是同一份聚合内容的字符串镜像）；门禁参数是结构化的 `trivyExitCode`（string，**默认 `"1"`**）与 `trivySeverity`（array）；`trivyExtraArgs`（array）只承载其余的原生参数 |
| 同上 | `deploy-or-upgrade` 别名 → `kubectl` 0.1 | 发布开关与目标来自 PipelineRun 的 `workloadName` / `workloadNamespace` / `kubeconfig` workspace；解析出来的 TaskRun 只带有 `args` / `script` |
| **独立画像**（不包含在上述模板中） | `skopeo-copy` 0.1 | 参数 `srcImage` / `srcTransport` / `imageMappings`（在 [§4.5.1](#s4-5-1) 中校验） |

:::warning 四个容易搞错的点

1. **漏洞门禁由结构化参数控制 —— 不要去比对 `trivyExtraArgs` 的字面量**：门禁开关是 `trivyExitCode`（string，默认 `"1"`）与 `trivySeverity`（array），模板会把它们直接透传给 `trivy-scanner` 的 `exitCode` / `severity`。`trivyExtraArgs` 是一个**数组**（每个元素是一个完整参数），只承载其余的原生参数 —— 判据应当要求它为空，而不是等于某份批准列表（见 [§4.2.5](#s4-2-5)）。
2. **参数是以结构化方式传给 Task 的，不再拼接成 shell 命令字符串**：`scanType` / `scanTargets` / `severity` / `exitCode` / `extraArgs` 各走各的位置。所以扫描侧的主要风险不是命令注入，而是"门禁有没有被关掉"；真正仍然需要防注入的，是同一批模板里 string 类型的 `buildExtraArgs` / `pushExtraArgs`（本文不治理构建/推送侧，见 [§4.2.5](#s4-2-5)）。
3. **java 0.3 与 python 0.3 的 DAG 形状不同**：在 java 0.3 中，`deploy-or-upgrade` 只有 `runAfter: [trivy-scanner]`；在 python 0.3 中则是 `runAfter: [sonarqube-scanner, trivy-scanner]` —— "Sonar 的结论支配发布"这件事只在 python 的 DAG 里表达出来（细节见 [§4.3](#s4-3)）。把一边的结论搬到另一边就正好搞反了。它们的**参数面**也不同（python 用 `preBuildScript` / `pythonImage` 这一组替换了 maven 那一组；workspaces 是 **12** 个而 java 是 16 个；`trivy-config` 两边都有）；但**与 trivy 门禁相关的参数在两边逐字段完全一致**（sonar 侧的参数名也相同，只有 `sonarProperties` 的默认值不同，而这不影响判据），所以 [§4.2.5](#s4-2-5) 的门禁判据用一条规则就能覆盖两个模板 —— 只有构建输入与 workspace 白名单需要按模板拆开。
4. **这两条流水线都不包含 `skopeo-copy`**：[§4.5.1](#s4-5-1) 是面向制品搬运场景的独立画像。

上表中的 Task 版本，以**你环境里模板实际固定的版本**为准；你策略里的字段名必须与目标版本的真实契约一致。

:::

在旧版本上的降级方案：只有在 object results 不可用时，才退回到聚合字符串 result（[§4.4.2](#s4-4-2) 的解析模式正是这种兜底形态）—— **这是降级路径，不是目标形态**。从 0.6 起，`trivy-scanner` 也发布了 object result，因此**请直接用 [§4.4.1](#s4-4-1) 的下钻模式消费 trivy 的 result**；[§4.4.2](#s4-4-2) 留给那些"只给你一个字符串、而且短期内改不了"的第三方 / 自研 Task。理由见 [§2.4](#s2-4)。

### 3.3 共享夹具 {#s3-3}

:::info 通篇实操会留下什么（复制粘贴之前，先看清东西会落在哪里）

- **本地工作目录**：[§3.1.1](#s3-1-1) 的回滚文件 —— `moduleinfo-target.txt` / `moduleinfo-original.json` / `moduleinfo-expected.json`（**只有回滚步骤 g) 会删除它们；它们还在，就说明那一轮没有收尾**）；[§4.0.4](#s4-0-4) 的 `cluster-scoped-ownership.tsv`；[§5.3](#s5-3) 六个步骤沿途写下的快照与判定文件（`gate-snapshot.txt`、`step*-verdict.txt`、`exemption-id.txt` / `exemption-uid.txt` 之类 —— 以各步骤实际写出的为准）；用于分离 stderr 的旁路文件 `*.err`（**成功时为空，但照样留在目录里**）；以及你在各节复制出来的 YAML / JSON。集群清理不会碰这些本地文件 —— 是否留作证据由你决定。
- **集群上**：本节创建的两个共享命名空间 `policy-poc` / `tekton-templates`；[§5.2](#s5-2) 探针块创建的命名空间（`proj-a` / `proj-b` / `rogue-ns` —— 以该节的创建循环为准）；以及 [§5.3](#s5-3) 的 `policy-exempt-runs` / `policy-exceptions`（**只有当它们确实是本次实操亲手创建的，才会被打上实操 id 标签** —— 原本就存在的既不打标，也不会被清理触碰）。命名空间级的演示对象 —— `PipelineRun` / `TaskRun`、夹具 `Task` / `Pipeline` 对象、白名单类 `ConfigMap`、[§4.2.2](#s4-2-2) 与 [§5.3](#s5-3) 的 `Role` / `RoleBinding`、`PolicyException` —— 全都位于这些命名空间之内。除此之外，个别小节还会创建**集群级对象**：`ClusterPolicy` 以及 [§4.6](#s4-6) 的聚合 `ClusterRole` —— **删除命名空间并不会把它们一并带走**。
- **清理落在哪里（[§4.0.4](#s4-0-4) 的两条规则）**：集群级对象按创建时账本里的 UID 逐个删除，在各节收尾的"清理"中完成；命名空间在核对实操 id 标签之后删除，级联带走其中的一切（[§5.2](#s5-2) / [§5.3](#s5-3) 的命名空间由它们各自的清理段落处理；`policy-poc` / `tekton-templates` 由本节末尾的"最终清理"处理）。因此**每做完一节就清理一节 —— 不要攒到最后**。还有一件事**没有任何清理段落会替你做**：为了 [§5.3](#s5-3) 而按 [§3.1.1](#s3-1-1) 改动的平台配置（`ModuleInfo` 里的 PolicyException 开关）—— 做完 [§5.3](#s5-3) 之后，请你自己回到 [§3.1.1](#s3-1-1) 执行它的回滚步骤。

:::

后续各章共享的资源。先创建两个命名空间：`policy-poc` 承载业务侧的运行与探针，`tekton-templates` 承载可信的模板与 Task 定义。
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

夹具的核心是一份 **SonarQube Scanner 0.7 契约夹具**（`policy-demo-scanner`）。它不是真正的扫描器，但它**完整镜像了本文所依赖的 0.7 对外契约面**，因此 Cookbook 针对该契约写出的每一条策略表达式，在真实 Task 上同样成立：

- `enableScanQualityGate` / `enableAnalyzeQualityGate` 都是 `string`，默认 `"true"`；
- `analyzeQualityGateRules` 是 `array`，默认 `[]`；`sonarBranchName` 是 `string`，默认为空；
- `code-scan-results` 是一个 object result，只声明 `result` / `reportURL` / `taskID` / `projectID`；这四个 property 的真实 schema 都是空映射 `{}`，并没有额外的 `type: string`；
- `code-scan-metrics` 是一个 object result，其 schema 只声明了真实 0.7 必定具备的那个 property：`bugs: {}`（真实 Task 可以通过它的 `metrics` 参数动态采集更多字段，但**策略绝不能假定未声明的字段必然存在**）；
- `code-scan-results.result` 使用真实的取值范围 `Succeeded` / `Failed` / `Skipped` / `Canceled`。

夹具还额外用 `demoCoverage` / `demoBugs` / `demoDelaySeconds` / `demoResult` 来驱动可重复的通过 / 失败 / 取消以及四种取值的审计测试，模板层再加一个 `demoSkipScan`（默认 `"false"`；设为 `"true"` 时通过 `when` 整体跳过 `scan`，供 [§4.1.5](#s4-1-5) 复现"门禁被绕过"）。这些 `demo*` 参数**明确不属于产品化的 Task 契约** —— 换成真实 Task 时不要保留它们。这里没有单独的门禁任务：夹具自身失败，就是拦住其后 `release` 的方式。

:::warning 替换占位符

把夹具中的 `<registry>` 替换成你的环境能拉到 busybox 的镜像仓库前缀。在生产环境中，请把 step 镜像固定到 digest —— 否则任何拥有镜像仓库推送权限的人，都能直接把扫描逻辑整个换掉（契约 1，[§2.3](#s2-3)）。

**如果你不知道该填什么，先看平台自己从哪里拉** —— 在离网环境里，这是最容易的起点：

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

⚠️ **这些只是候选，不是答案**：平台命名空间能拉，不代表 `policy-poc` 也能拉（拉取凭据是按命名空间授予的），而且两条命令打印出来的都是**平台镜像**路径，其中未必有 `busybox`。**唯一算数的验证是夹具真的跑起来** —— 按 [§3.3](#s3-3) 建好夹具之后跑一次 `demo-run-pass`；如果 Pod 起不来，去 `kubectl -n policy-poc describe pod` 里找 `ImagePullBackOff` / `ErrImagePull` 事件。那不是 Tekton 或 Kyverno 的问题 —— 是前缀写错了，或者凭据没给。

:::

:::details 共享夹具的完整 YAML（Task、模板、反面模板 —— 可直接复制）

一个 YAML 文件包含五个对象；后续各章按需引用：

- `Task/policy-demo-scanner`（`tekton-templates`）—— 契约夹具本身；
- `Pipeline/gated-build` —— 标准的受治理模板：scan → release，finally 只做通知；
- `Pipeline/gated-build-with-prep` —— 供 [§4.2.2](#s4-2-2) 证明"scan 之前已经完成的工作 + RunFinally 取消 + finally 照常执行"；
- `Task/policy-demo-scanner`（`policy-poc`）—— **同名不同源**的 Task，是 [§4.6.2](#s4-6-2) 定义漂移的目标；
- `Pipeline/gated-build-rogue` —— 反面模板：`scan` 别名保留了可信名称，但从 `policy-poc` 解析。

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

把上面的 YAML 存成 `public-fixtures.yaml`（替换掉 `<registry>`）并在目标集群上创建 —— **后续每一节的探针都假定这五个对象存在**：

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

**这个探针是按首次安装写的：它分不清"别人的同名对象"和"你上次建的同一批夹具"** —— 两者都会报 `COLLISION`。因此：

- **首次安装**：探针应当什么都不打印；如果有输出，按上面的提示换命名空间。
- **重跑同一份实操**：那五个对象就是你上次建的。先确认它们确实是你的（`kubectl get -o yaml` —— 内容是不是这份夹具，命名空间的实操标签是不是你上次的 id），然后**手工设置 `FIXTURES_SAFE=yes`** 再跑下一个块 —— 对同一份 YAML 执行 `apply` 是幂等的。或者先删掉上次那一批，重新来过。
- **想要"绝不覆盖"**：把下一个块里的 `kubectl apply -f` 换成 `kubectl create -f`；存在同名对象时它会以 `AlreadyExists` 失败而不是覆盖。探针与创建之间仍然存在一个窗口（可能恰好有人在这中间创建了同名对象）—— `create` 的价值正在于此：那种情况下它会失败，而不是静默覆盖。

**探针与下面的 apply 被刻意拆成两个块**：放在同一个块里，整段粘贴时 `apply` 无论如何都会执行，探针就退化成了事后通知。下一个块会再检查一次 `FIXTURES_SAFE` —— 两道守卫都有存在的必要，因为**拆开只能防住"顺手一并粘贴"，防不住"跳过上一个块、单独粘贴这一个"**：

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

如果有任何一行报 `NotFound`，回到那份 YAML 里找对应的对象 —— 最常见的原因是 `<registry>` 没替换导致整份 apply 中途失败，或者两个命名空间还没创建（本节开头的那个循环）。

⚠️ **这两个共享命名空间必须是本次实操创建的**（[§4.0.4](#s4-0-4) 的前置纪律 —— 清理依赖命名空间删除的级联，而级联的前提是里面没有别人的东西）。当上面的创建循环打印 `pre-existing` 时，说明这个集群上已经有人占用了该命名空间名 —— **不要在里面做演示**：把全文的 `policy-poc` / `tekton-templates` 换成你自己的名字（最终清理也用你的名字执行）；或者先确认它是你自己上一次实操留下的（标签里的实操 id 就是你记下的那个），把那一轮收尾，再重新开始。

这个模板体现了 [§2.3](#s2-3) 各契约中属于模板侧的责任：门禁由扫描器自身承载（契约 3"必须执行" + 契约 4"消费真实的实际取值"在同一个任务内自洽），`release` 排在扫描器之后（契约 5，DAG 支配），finally 只做通知（契约 6）。

业务侧的标准用法是通过 cluster resolver 引用该模板：

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

把它存成 `demo-run-pass.yaml` 并创建（在目标集群上；下面的观测命令需要它真实存在）：

```bash
kubectl create -n policy-poc -f demo-run-pass.yaml
kubectl wait -n policy-poc pipelinerun/demo-run-pass \
  --for=condition=Succeeded --timeout=5m
```

下表最后一列的 `code-scan-results.result` 是**由扫描任务产出的一个 Tekton task result** —— 它既不是 Pipeline 级的字段，也不是 Kyverno 的概念。先把这一点搞清楚；后面几章的"结果类"策略全都围绕它展开：

- **谁产出它**：`scan` 任务（夹具中的 `policy-demo-scanner`）在其 step 脚本中把一段 JSON 写入 `$(results.code-scan-results.path)`；
- **它落在哪里**：Tekton 把它记录在**该任务对应 TaskRun** 的 `status.results` 上。PipelineRun 自身并不持有这份数据 —— 要看子 TaskRun（[§2.1](#s2-1) 观测点 6）；
- **`.result` 是什么**：这个 result 的类型是 `object`（[§2.4](#s2-4)），其中的 `result` 字段就是**扫描结论**，真实取值范围为 `Succeeded` / `Failed` / `Skipped` / `Canceled`；
- **本文为什么反复回到它**：[§4.4](#s4-4) 的结果审计与 [§4.6.1](#s4-6-1) 的自动取消，读的都是这个字段。表中列出它，是为了让你确认夹具环境产出的结论与预期一致。

亲眼看一遍（用上面的 `demo-run-pass`）：
```bash
# The verdict lives on the scan TaskRun, not on the PipelineRun.
# childReferences is the API-level mapping from pipeline task name to TaskRun name --
# unlike the tekton.dev/pipelineTask label, it cannot be overridden by the submitter.
TR=$(kubectl get pipelinerun -n policy-poc demo-run-pass -o json \
  | jq -r '.status.childReferences[] | select(.pipelineTaskName == "scan") | .name')
kubectl get taskrun -n policy-poc "$TR" -o jsonpath='{.status.results}{"\n"}'
```

三次运行覆盖门禁的三种形态，同时充当环境就绪性检查：

| run | 输入 | scan | release | finally notify | 扫描结论（scan 的 task result `code-scan-results.result`） |
|---|---|---|---|---|---|
| pass | `coverage=85` | ✅ 成功 | ✅ 执行 | ✅ 执行 | `Succeeded` |
| gate-fail | `coverage=30`（两个门禁开关都是 `true`） | ❌ 自身失败 | ⏭ 被跳过（reason 为 `PipelineRun was stopping`） | ✅ 执行 | `Failed` |
| gates-off | `coverage=30` + 两个门禁开关都是 `false` | ✅ 夹具成功 | ✅ 执行（**刻意暴露出来的绕过**） | ✅ 执行 | `Failed` |

后两次运行与 `demo-run-pass` **只差在 params 上**（除模板身份外，只有 `metadata.name` 和 params 不同）。存成 `demo-runs-negative.yaml`：

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

两个一起创建并等待各自的终态 —— **注意这两者的结局相反**，所以等待条件也相反：

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

`wait` 迟迟不返回而是超时，通常说明运行卡在解析上（模板根本没建起来 —— 回到上面那五个对象的验证）；当任一运行的终态与表格不符时，先确认夹具的 `demo*` 参数没有被改动过。

前两行是硬门禁的基线形态（扫描器自身失败 → `release` 被跳过 → finally 照常执行 —— 正是 [§2.3](#s2-3) 对照表中的第二行）。

第三行是**仅存在于夹具中的反面测试**，它那个 `Failed` 不是笔误 —— 这一行刻意把两件事拆开了：**结论**依然算出 `Failed`（`demoResult` 默认为 `Auto`；覆盖率 30 < 80 判为 `Failed`），但夹具只有在**至少一个门禁开关为 `true`** 时，才把失败结论转换成 `exit 1`。两个开关都关掉时，scan 成功退出，`release` 照样执行 —— 而 scan TaskRun 的 `code-scan-results.result` 就明明白白写着 `Failed`。**结论说不合规，流水线却一路全绿** —— 这正是"门禁开关被关掉"的危害形态，也正是 [§4.2.1](#s4-2-1) 必须在 TaskRun CREATE 时就拦住不合规开关值的原因：等结果出来的时候，发布早就跑完了。这一行只描述夹具的确定性行为；它并不声称真实的 SonarQube 服务在两个门禁都禁用时必然产出同样的组合。

#### 最终清理（通篇走完之后）

各节收尾的"清理"只删除该节自己的策略与运行对象；**这两个共享命名空间要在整篇文档做完之后单独删除** —— 否则夹具会永远留在集群上：

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

删除命名空间会级联带走其中的 Pipelines / Tasks / 运行对象以及它们产生的 Pod；`PolicyReport` 会随其对象一同消失（[§4.4.4](#s4-4-4)）。**删除命名空间不会带走集群级对象** —— 它们必须按各节的清理清单逐项删除：其一是各节的 `ClusterPolicy`；其二是 [§4.6](#s4-6) 引言为 mutate-existing 创建的 `ClusterRole kyverno-background-update-pipelineruns`（该节自带"先看创建时间、再删除"的清理块 —— 别跳过：把这个角色留在那里，就等于持续授予 background-controller 对全集群 PipelineRun 的 update 权限）。

### 3.4 策略验证方法（三种，按场景严格区分） {#s3-4}

策略写完之后用哪种方法验证，取决于它挂在哪个观测点上。这三种方法彼此不能替代：

- **准入类策略**（匹配主资源的 CREATE/UPDATE）：用 `kubectl create --dry-run=server -f probe.yaml` 探针 —— 它会完整跑一遍 webhook 求值，但不持久化任何东西，零副作用。注意对使用 `generateName` 的资源，`--dry-run=server` 要配 `create` 而不是 `apply`。正反两个方向都要跑：策略必须拒绝违规探针，且不得命中合规探针。
- **结果类策略**（匹配 `*/status`）：运行结果在准入阶段拿不到，因此有两条路 —— 在本机用 `kyverno apply <policy> --resource <fixture>` 做离线求值（局限见 [§6.1.6](#s6-1-6)），或者在**实验命名空间**里用真实的产出任务造出目标 result 形态（例如 [§3.3](#s3-3) 的扫描器夹具）。
- **端到端验证**：真的跑一条最小流水线，验证完整的失败 / 跳过 / 取消形态以及父子时序。准入探针**证明不了**运行时时序；任何涉及 `CreateRunFailed`、finally 是否执行、取消语义的结论，都必须走这一层。

这三类的**命令形态**按同样顺序给在 [§3.4.1](#s3-4-1) 中（类型 1 / 2 / 3 与上面三条一一对应；取消类是端到端这一层里最常用的取证形态）。

**生产环境排障是只读的**：只看 status / 事件 / PolicyReport（[§6](#s6)）。**绝不要**在生产环境手工编辑运行中对象的 status。

#### 3.4.1 把"预期结果表"变成命令（通用配方） {#s3-4-1}

后续各节提供探针的方式有三种：有些直接给出完整的清单与命令（[§3.3](#s3-3)、[§4.4.1](#s4-4-1)、[§4.4.2](#s4-4-2)）；[§4.2.2](#s4-2-2)、[§4.6.1](#s4-6-1) 与 [§4.6.2](#s4-6-2) 给出完整的运行清单，但取证命令在 [§6.2.3](#s6-2-3)（取消类读的是对象上的 `spec.status` 与注解，而不是准入返回值）；其余各节只给一张**预期结果表**（列出哪些输入应当放行 / 拒绝 / 跳过），把命令留给本节 —— 因为这三类命令都是机械的，逐节重复只会让文档更长而不是更清楚。

**有九个小节只给了预期结果表，需要你自己把它变成命令**：[§4.1.1](#s4-1-1)、[§4.2.4](#s4-2-4)、[§4.2.5](#s4-2-5)、[§4.5.1](#s4-5-1)、[§4.5.3](#s4-5-3)、[§4.5.4](#s4-5-4)、[§4.5.5](#s4-5-5)、[§5.2](#s5-2)、[§5.3](#s5-3)。（[§4.5.3](#s4-5-3)、[§5.2](#s5-2)、[§5.3](#s5-3) 中已有的 `kubectl apply` 命令创建的是**前置对象**（ConfigMap、命名空间），而不是探针本身。）

另有三组小节不在上面的名单里，它们的探针来源不同：[§4.1.4](#s4-1-4) 与 [§4.1.5](#s4-1-5) 没有预期结果表 —— 它们是挂在 `*/status` 上的 Audit 纵深防御，判据写在正文里，预期形态是"报告里该出现哪一条 fail 记录" —— 按下面的**类型 2** 走；[§4.2.1](#s4-2-1) 与 [§4.2.3](#s4-2-3) 判定的是同一组门禁开关，所以直接复用 [§3.3](#s3-3) 的反面夹具（开关关掉的 `demo-run-gates-off`，以及作为正向对照的 `demo-run-pass` —— 换个 `metadata.name` 重建即可）。这两节**不能用类型 1 的 `--dry-run` 探针**：它们的判据落在 Tekton 控制器创建的子 TaskRun 上，而且必须沿 ownerReference 回溯到一个**活的**父运行 —— dry-run 的 PipelineRun 既不会被持久化，也不会派生出子对象。唯一的办法是按 [§3.4](#s3-4) 的第三类真跑一条流水线：[§4.2.1](#s4-2-1) 看父运行是否进入 `CreateRunFailed`；[§4.2.3](#s4-2-3) 的取消形态按**类型 3** 走，读的是**门禁 TaskRun 自身**（它是准入 mutate，被打补丁的正是这个对象 —— 父运行上没有可看的 `spec.status`）；[§4.2.2](#s4-2-2)、[§4.6.1](#s4-6-1) 与 [§4.6.2](#s4-6-2) 各自带有完整的运行清单 —— 按**类型 3** 检查结果。

跟着做的时候，从下面三种类型里选一种：

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

**上面提到的"该节的示例清单"，正是那九个小节没有提供的东西** —— 所以先从下面三个骨架里挑一个，再按预期结果表的行去改字段。三者都能通过 `kubectl create --dry-run=server` 的准入检查（`<registry>` / `<catalog>` 怎么获取见 [§4.0.3](#s4-0-3)）：

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
那九个小节各自要改什么：

| 小节 | 用哪个骨架 | 预期结果表的每一行在改什么 |
|---|---|---|
| [§4.1.1](#s4-1-1) 模板白名单 | A | 整个 `pipelineRef` 块：改 `name` / `namespace`，改 `resolver`（cluster → git），把 git 引用写成可变引用 |
| [§4.2.4](#s4-2-4) 受保护分支门禁 | B | `taskRef.params` 里的五个 hub 项照该节正文原样保留；变化的是 `spec.params` 的组合：`sonarBranchName` 的取值（受保护分支 / 特性分支 / 整个删掉 —— 缺失会作为默认分支进入受保护范围）×门禁开关（缺失 / `"true"` / `"false"` / 空字符串）×`sonarProperties` 的条目（规范 / 非规范形式、受管键、`sonar.pullrequest.key=` 为空与非空、`sonar.pullrequest.base=`）—— 预期见该节的探针表 |
| [§4.2.5](#s4-2-5) 官方模板提前拦截 | A | 把 `pipelineRef` 改成该节正文中官方模板的坐标（java / python 0.3），然后按自查表逐行修改 `spec.params`（门禁开关、`sonarProperties` 条目、`trivyExitCode` / `trivySeverity` / `images` 等）以及 `workspaces` 绑定的对象 —— **判据落在 PipelineRun 层，所以用骨架 A 而不是 B** |
| [§4.5.1](#s4-5-1) 来源白名单 | B | 把 `taskRef.params` 里的 `name` / `version` 改成该节的 `skopeo-copy` 条目，然后变化 `spec.params` 的 `srcTransport` / `srcImage` / `imageMappings`，以及是否挂载 workspace |
| [§4.5.3](#s4-5-3) 镜像白名单 | C | `containers[].image`；`initContainers` 同理，作为额外的一块；`ephemeralcontainers` 那一格改用 `kubectl patch pod <name> --subresource=ephemeralcontainers`（它是子资源 UPDATE，不是 CREATE）。**骨架 C 的 `managed-by` 标签必须按 [§4.0.3](#s4-0-3) 替换成真实取值** —— 该节的每条规则都靠这个标签把范围限定到 Tekton Pod；标签缺失或写错时，每一格都会在 match 阶段跳过，"已批准镜像"与"未批准镜像"两格结果一模一样，整个探针形同虚设 |
| [§4.5.4](#s4-5-4) 裸入口封堵 | B | 清单几乎不用改；**变化的是身份**：同一个请求分别用 `--as=<platform-admin-identity>` 和 `--as=<business-identity>` 各跑一次 —— 只有当两格结果相反时，才说明命中了这条策略。⚠️ **这一对放行/拒绝只演练了破窗分支** —— 放行侧还必须覆盖 [§4.5.4](#s4-5-4) 验证清单里的"控制器身份 + 控制器 owner ref 放行"与"正常端到端 PipelineRun `Succeeded`"两格：如果策略里控制器 + ownerReference 这条正常路径被写坏了（恒为假），管理员分支照样放行、业务身份照样被拒，于是这套配方误判为通过，而真实流水线已经创建不出子 TaskRun 了；CustomRun 那一格要把 `kind` 改成 `CustomRun`、`taskRef` 改成 `customRef`，**并把 `apiVersion` 改成 `tekton.dev/v1beta1`** —— CustomRun 只存在于 v1beta1，`tekton.dev/v1` 里没有它（[§3.2](#s3-2)"API group-version 前提"中的例外）；照抄骨架 B 的 v1 会在到达准入之前就被 API server 拒掉 |
| [§4.5.5](#s4-5-5) 发布目标 | A | `spec.params` 中的部署开关与目标命名空间、通过 `taskRunSpecs` 指定的 ServiceAccount，以及 workspace 引用的 Secret |
| [§5.2](#s5-2) 命名空间分层 | A | 把 `metadata.namespace` 与 `-n` **一起**改成目标命名空间（`proj-a` / `proj-b` / `rogue-ns` —— 两者必须一致：只改 `-n` 而清单里仍写 `policy-poc`，kubectl 会**在到达准入之前**就失败，报 `the namespace from the provided object "policy-poc" does not match the namespace "proj-a"` —— 探针根本没走到策略），然后按该节正文加上违反基线 / 项目策略的字段 |
| [§5.3](#s5-3) 豁免边界 | A | 让 `metadata.namespace` 与 `-n` **同步**在 `policy-exempt-runs` 与普通命名空间之间切换（不一致会像上一行那样在准入之前被拒），把 `spec.params` 里两个门禁开关都设为 `"false"`，并全程带上 `--as` |

**每条命令都必须显式带上身份**（上面配方中的 `--as=<probe-identity>`，换成该行预期结果表想测试的那个身份 —— 例如 `--as=<business-identity>` 或 `--as=<platform-admin-identity>`）：不带的话，你用的就是自己 kubeconfig 的身份，而那多半是管理员 —— 一个被 `exclude` 摘出去的身份根本不会触发策略，于是你会把"没被拒"记成"策略放行了"。

**验收标准只有一条**：只有看到 `<policy>: <rule>: <message>`（准入类）或报告中该策略名下的 `pass`/`fail`（结果类），才算命中了这条策略。**"没被拒"不等于"策略放行了"** —— 它同样可能意味着策略没匹配上、preconditions 短路了，或者另一条策略先拒绝了别的东西。拿不准时，按 [§6.1.2](#s6-1-2)（"装上了却没生效"的三步检查）与 [§6.1.3](#s6-1-3)（定位误拦）排查；被别节策略先拦住的情况见 [§4.0.5](#s4-0-5)。

### 3.5 上线安全流程（先 Audit） {#s3-5}

不同的动作类型必须遵循不同的上线节奏；不要机械地把每条策略都翻到 Enforce：

1. **主资源上的准入 validate**（PipelineRun / TaskRun / Pod 的 CREATE/UPDATE）：先把每条 rule 的 `validate.failureAction` 设为 `Audit`，观察 PolicyReport 并修正 match / preconditions；等误报归零之后再切到 `Enforce`，并在翻转前用 dry-run 的正反向探针做回归（[§3.4](#s3-4)）。
2. **`*/status` 结果类策略**：永久保持 `Audit`，只观察真实终态的 pass/fail。**绝不要切到 Enforce** —— 那会拦住 Tekton 控制器的状态回写，造成卡死（[§2.2](#s2-2)、[§4.4.3](#s4-4-3)）。
3. **mutate-existing / generate**：先在隔离的命名空间里授予最小 RBAC，验证目标选择器与幂等条件，再放大范围；它们不是 validate 策略，Audit → Enforce 的切换模型对它们不适用。

**"误报归零再 Enforce"仍然不够 —— 翻转本身也要分三阶段灰度，而且回滚要先演练过。** 一条作用域过宽又配错的策略（尤其是 [§4.5.3](#s4-5-3) 的 Pod 级镜像白名单），能一次性让所有业务命名空间都创建不出 Pod —— **那就是平台级的流水线中断**：

| 阶段 | 范围 | 本阶段要观察什么 |
|---|---|---|
| 1 金丝雀 | **一个**你自己掌控的命名空间 | 正反向探针（[§3.4](#s3-4)）行为都符合预期；该命名空间中一条真实流水线能跑到终态 |
| 2 小批量 | 几个真实业务命名空间（挑流水线频率高的） | 准入拒绝率、PipelineRun 创建失败率、`PodCreationFailed` 事件、webhook 延迟的变化 |
| 3 全量 | 整个目标范围 | 同上，且要覆盖**至少一个完整业务周期**（含定时任务与升级窗口） |

**回滚必须是一步到位、而且你已经演练过的动作**，而不是临场决策：把策略切回 `Audit`（或删掉它）会立刻恢复放行 —— 翻转之前，**在金丝雀阶段真的执行一次回滚并确认恢复**，并把命令与预期输出写进变更单。同时写下你自己的恢复时间目标：Pod 级策略配错时，平台是几分钟内恢复、还是要等人上线，取决于这一步有没有提前准备。

:::warning 失败动作写在哪里：本文所有素材都用 rule 级的 validate.failureAction（顶层的 spec.validationFailureAction 已 Deprecated）

依据：`kubectl explain clusterpolicy.spec.validationFailureAction` 自己就写着 `Deprecated, use validationFailureAction under the validate rule instead`（rule 级路径为 `rules[].validate.failureAction`，枚举值 `Audit` / `Enforce`）。之所以在这里留一笔，是因为**既有集群上仍有大量策略在用顶层写法**，而这项废弃属于升级时最危险的漂移之一：

| 写法 | 提交一个必然违规的请求 | 说明 |
|---|---|---|
| 只有 rule 级的 `validate.failureAction: Enforce`，没有顶层字段（本文所有素材） | **被拒绝** | 适用版本下的实际行为；见本文开头的"适用版本"框 |
| 顶层 `spec.validationFailureAction: Enforce`（常见的历史写法） | **被拒绝** | 目前仍然有效，但已 Deprecated |
| **两者都没设** | **放行**（策略照样显示 `Ready=True`） | 默认值等同于 Audit |

风险就在第三行：**当顶层字段最终被移除时，CRD 的字段裁剪会把它静默丢弃** —— 策略照样安装成功、照样显示 `Ready=True`、`kubectl get clusterpolicy` 看上去一切正常，但它**已经什么都拦不住了**。这正是本文反复警告的最坏形态 —— 静默放行。

因此：

- 如果你手上还有顶层写法的历史策略，**在升级之前把它们迁到 rule 级**：删掉顶层那一行，在每条 validate rule 的 `validate:` 之下写 `failureAction`（语义等价；本文素材就是迁移后的形态）。注意是**每一条** rule —— rule 级字段不会继承，漏掉哪条它就回落到默认的 Audit（即上表第三行）；
- **升级完 Kyverno 之后，不要只看策略是不是 Ready** —— 把各节"违规请求必须被拒"的探针重跑一遍（[§3.4](#s3-4) 中 `--dry-run=server` 的正反两格）。rule 级写法躲开的只是这一项被点名的废弃，"升级后语义漂移"这件事本身并没有消失（见 [§3.6](#s3-6) 的 Kyverno 升级一行）；
- 对于**保持 Audit** 的 `*/status` 策略，不受影响的只是"它们不会突然开始拦人"；它们的漂移风险在别处（见 [§4.4.1](#s4-4-1) 的 result 契约与 [§4.0.1](#s4-0-1) 的版本失配约束）。

:::

### 3.6 变更与升级触发条件（环境一有变动，先回到这张表） {#s3-6}

本文策略的判据大量依赖三类**外部事实**：模板 / Task 的版本与契约、Tekton 的 `config-defaults`，以及你自己维护的批准名单。其中任何一项发生变化而策略没有跟上，后果就是本文反复警告的两种形态之一 —— **静默放行**（策略还在，但已经拦不住了）或**静默误拒**（所有合规请求都被拒，报错却指向某条判据）。

| 触发动作 | 受影响的判据 | 后果 | 变更中必须包含什么 |
|---|---|---|---|
| 新增业务命名空间，或把流水线迁到新命名空间 | [§4](#s4) 中**每一条**策略的 `namespaces:` 枚举（演示值 `policy-poc`） | **静默放行**：新命名空间匹配不上任何规则 | 先把新命名空间加进所有作用域（或按 [§5](#s5) 改用命名空间级 `Policy`；想要"默认覆盖"，就改成平台级 ClusterPolicy + 对系统命名空间做否定式 `exclude`，而不是逐个枚举），针对新命名空间跑正反向探针，**然后**才让业务迁入 |
| **新增业务集群**，或把流水线迁到另一个集群 | **全文所有策略**（[§4](#s4) 与 [§5](#s5) 都算）—— `ClusterPolicy` / `Policy` 都是集群内对象，**不会跨集群同步** | **静默放行**：新集群上一条策略都没有，而旧集群的报告看上去完全正常 —— 从旧集群上完全看不见 | 集群纳管按 [§4.0.7](#s4-0-7) 的五步转换与验收走（含正反向探针）—— 不要简化成"装个最小集"；策略清单通过 GitOps / 平台模块下发，而不是手工安装；并定期做跨集群基线比对 —— **基线 = 全部 `ClusterPolicy` 加上每个受治理项目命名空间中的 `Policy` 对象**（[§5](#s5) 的项目自治对象不会出现在 `kubectl get clusterpolicy` 列表里），**至少要按 名称 + 每条 rule 的 `validate.failureAction` + `match`/`exclude`（含 namespaceSelector）+ `spec.webhookConfiguration`（`failurePolicy` / `timeoutSeconds`）比对** —— 只比名称的话，同一条策略在一个集群是 Audit、在另一个是 Enforce，也会被报成"基线一致"；漏掉最后一项，则一个集群的声明正在被强制改成 `Ignore` 也会被报成一致，所以**每个集群平台级 `forceFailurePolicyIgnore` 开关的状态也要作为集群级条目一并比对**（与 [§7.3](#s7-3) 同一把尺子）；最稳健的形态是把每个集群与 GitOps 的期望态做结构化 diff |
| 模板版本升级（例如 0.3 → 0.4） | 所有固定了 `refVersion` 的策略 | **静默放行**（身份对不上 = 跳过） | 见 [§4.0.1](#s4-0-1) 的顺序约束 3；唯一能拦住"新版本悄悄混进来"的层是 `pipeline-template-allowlist` |
| **Task 版本升级**（与模板解耦；会单独发生） | [§4.4](#s4-4).x 的结果读取策略，以及完整画像内部的 Task 身份判据 | **静默放行**（旧版本身份不再匹配 → PolicyReport 看上去"很干净"）；只改版本不改 result 路径则变成**误报** | 三处一起改：Task 身份的版本、result 的**名称**、property 的**路径**。改完之后，用**一次真正失败的扫描**确认 PolicyReport 里出现了 fail —— 这是 Audit 策略的正向对照：**如果没有 fail 冒出来，先怀疑身份没匹配上，而不是"没有违规"** |
| 修改 `config-defaults` 中的 `default-service-account` | [§4.5.5](#s4-5-5) 的运行级 SA 批准名单 | **两个方向都可能，取决于你改成了什么**：改成**另一个非空值** → **静默误拒**（所有开启部署的合规请求都被拒）；改成**空值** → Tekton 不再填充该字段，判据的 `!= ''` 前置条件不再成立、整条规则跳过 ⇒ **静默放行**（失败开放；见 [§4.0.3](#s4-0-3) 中该占位符那一行） | 在同一次变更里更新名单，并跑三格探针（新的默认 SA / 站点批准的 SA / 名单外的 SA）；**外加一格**：用 [§3.3](#s3-3) 的夹具读一次实际生效值，确认它**不为空** —— 值为空时，必须先把它设回一个真实的 SA 名，才谈得上讨论名单 |
| 修改 `config-defaults` 中的 `default-pod-template`，**尤其是新增 `env`** | [§4.2.5](#s4-2-5) 与 [§4.5.5](#s4-5-5) 中的 `runWideEnvCount` | **静默误拒**：一旦平台默认注入 env，每次运行的计数都 > 0，**所有**流水线都会被拒 | 把平台注入的 env 条目**名称**加进放行名单（下面给出可用的写法）—— 不要删掉判据 |
| 修改 `default-managed-by-label-value` | [§4.5.3](#s4-5-3) 的 Pod 作用域标签 | **静默放行**：Pod 规则不再命中任何 Tekton Pod | 在同一次变更里改掉占位符，用一个真实的 Tekton Pod 验证 match 命中，再验证已批准仓库之外的镜像仍然被拒 |
| 被批准对象的**内容**发生变化（`approved-*` ConfigMap / Secret 的内容、`pipeline-image-allowlist` 中的正则被放宽） | 所有只比对**对象名称**的判据（[§4.2.5](#s4-2-5) 的 workspace 系列、[§4.5.3](#s4-5-3) 的 ConfigMap 形态） | **静默放行**：名称还是那个批准值，内容已经被放宽了 | 把"对象轮换"（改名）与"对象内容变更"分开管理：内容必须纳入 GitOps / RBAC 管控与评审 —— **策略只能锁住"绑定的是哪个对象"** |
| Kyverno 升级 | 所有策略（本文素材已经使用 rule 级的 `validate.failureAction`，躲开了顶层字段的废弃；顶层写法的历史策略风险最大） | 可能**静默放行** | 见 [§3.5](#s3-5) 的警告块；升级之后不要只看 `Ready` —— 按 [§3.8](#s3-8) 重跑最小回归集。**除失败动作之外，下列语义都要自己验一遍**（不是"某个版本一定改了"，而是"不验就不知道"）：`context.apiCall` 的失败方向、JMESPath 函数行为、`foreach` 是否仍然遍历三类容器、子资源匹配语法、PolicyException 的匹配与删除传播，以及 PolicyReport 的 API 版本 |
| **Tekton Pipelines 升级** | 所有策略，尤其是那些"枚举已知字段"的（见下文"两种判据形态"） | **静默放行**：新字段 / 新的 override 入口 / 新的 resolver 参数不在判据里，默认落到放行侧 | 重新枚举字段面并逐条核对判据：`PipelineRun` / `TaskRun` 的 spec、`spec.taskRunSpecs` 可覆盖的条目、resolver 参数、Pod 的容器类字段，以及新出现的类运行资源（[§4.5.4](#s4-5-4) 的入口封堵是按 kind 枚举的）。**枚举方法**：取一次真实运行对象的 `kubectl get -o yaml`，与升级前的存档做 diff，只看新增字段。**另外还要单独重验取消语义**：`spec.status` 的可接受取值、`CancelledRunFinally` 与 finally 的关系，以及"取消 vs 任务失败"谁在终态判定中胜出 —— [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6](#s4-6) 全都骑在那台状态机上。**还有两处封闭枚举也必须重查**（它们恰恰是升级时最容易被悄悄扩充的，而且都是黑名单形态 —— 新增项默认落在放行侧）：① `skippedTasks[].reason` 的取值集合（[§4.1.5](#s4-1-5) 给出了在哪里重新获取这些取值）；② `PipelineRun` / `TaskRun` / `CustomRun` —— **它们各自实际提供的 group-version**（[§3.2](#s3-2) 的"API group-version 前提" —— 一条 `kubectl api-resources --api-group=tekton.dev` 就够；新增或下线一个版本都会改变 `match` 的命中面） |
| **ACP 升级 / 平台模块调和** | 依赖平台配置的策略（[§4.5.3](#s4-5-3) 的作用域标签、[§4.5.5](#s4-5-5) 的 SA 名单、[§4.1.1](#s4-1-1) 的 hub 端点、Kyverno 自身配置） | **静默放行或静默误拒**，取决于哪一项被重置了 | 平台升级会从模块模板重新调和配置，**你此前的手工改动可能被还原**：升级后重跑 [§3.1](#s3-1) 的 7 项清单（尤其第 6、7 项，`failurePolicy` 与 `resourceFilters`），并重查 `config-defaults` / `feature-flags` / `hubresolver-config` / kyverno ConfigMap 这四份配置。**如果你使用 PolicyException，还要重查 [§3.1.1](#s3-1-1) 那条管理面路径本身** —— `ModuleInfo` 的定位条件、`valuesOverride` 的 chart 键，以及配置向业务集群传播的链路，都属于平台实现，升级后可能已经变了：症状是命令照样能跑，却找不到对象、或者写入不生效，回滚路径也会同样失败。**在平台配置被重置的同时，策略的 `Ready=True` 并不代表它仍然在生效** |
| PolicyException 过期却没被清理 | [§5.3](#s5-3) 的豁免范围 | **静默放行**：旧豁免会继续匹配同类的后续运行 | 每个例外都必须带上审批单号 / 生效与过期时间 / 责任人；定期扫描过期对象；删除之后，用一次违规运行确认拒绝已经恢复（Kyverno 没有原生的 TTL） |
| 身份名单里的某个 SA 被删除后重建 | 按 `request.userInfo.username` 比对的判据，如 [§4.5.4](#s4-5-4) / [§4.2.1](#s4-2-1) | 名称比对照样通过，**但权限已经是另一套了** | 名称没变不等于身份等价：重建之后，重新核对该 SA 的 RoleBinding 与 Secret，并用 `--as` 探针把放行与拒绝两侧都重验一遍 |

**当平台默认注入 env 时的放宽写法**（本文环境的 `default-pod-template` 中只有 `securityContext`，所以正文保留"出现任何 env 即拒绝"的判据；一旦平台加了默认 env，就切换成按名称放行）：
```yaml
- name: nonDefaultEnvCount
  variable:
    # Count only env entries the platform default did not put there. Verified on
    # cluster: two platform names -> 0, one extra business name -> 1.
    jmesPath: >-
      length((request.object.spec.taskRunTemplate.podTemplate.env || `[]`)[?contains(['<platform-default-env-name>'], name) == `false`])
    default: 0
```
**把这张表接进你自己的变更流程**：任何涉及模板、Task、`config-defaults`、被批准对象，或 Kyverno / Tekton / ACP 版本的变更单，都应当带上一条检查项"策略侧是否也要改？" —— 上表每一行都对应着一次"别的东西变了，而策略没跟上"。

#### 两种判据形态决定了"新字段"落到哪一侧

升级之所以危险，根子在于判据分两种形态，而这两种形态对**判据没有预料到的东西**给出的默认答案正好相反：

- **白名单形态**（"必须命中批准集合，否则拒绝"）—— 例如 [§4.1.1](#s4-1-1) 的三通道并集、[§4.5.3](#s4-5-3) 的仓库前缀、[§4.5.4](#s4-5-4) 的入口身份、[§4.5.5](#s4-5-5) 的目标名单。**新出现的形态会自动落到拒绝侧**；升级之后表现为一次"看得见的中断"：合规请求被拒。难受，但安全 —— 而且你一定会发现。
- **黑名单形态**（"出现已知的坏值 / 坏字段就拒绝"）—— 例如各种门禁参数契约（[§4.2](#s4-2)）、结果读取的 Audit（[§4.4](#s4-4)）、`skippedTasks` 审计（[§4.1.5](#s4-1-5)）。**新字段、新的 override 入口、新的枚举值会自动落到放行侧**；升级之后表现为"静默放行"：策略照样 Ready，报告一尘不染，而那条路径已经不再被监视了。

**分类的单位是"一条判据 + 一个字段面"，而不是"一条策略"** —— 两种形态在同一条策略里共存是常态：[§4.2.5](#s4-2-5) 用白名单锁模板身份，同时用黑名单枚举坏参数；[§4.5.3](#s4-5-3) 的镜像前缀是白名单，但它"只遍历三个已知容器字段"这件事是黑名单。所以升级回归必须**逐个字段面**地测（未知 resolver / 未知参数 / 未知枚举值 / 未知容器路径各一个探针）—— 不要按策略条数打勾。

**给判据分类只需问一个问题：递给它一个它从没见过的形态的输入 —— 它是拒还是放？** 拒 = 白名单，放 = 黑名单。**每一条黑名单形态的判据，升级之后都必须重新枚举它的字段面** —— 这正是上表 Tekton / 模板 / Task 各行要求"重新枚举"的原因，也是 [§3.8](#s3-8) 的回归集必须包含"未知 override 字段"这类负向探针的原因。

### 3.7 规模与故障预算（上生产之前先把这些数算出来） {#s3-7}

前面各节保证的是判据正确。本节是另一回事：**这套策略集在真实规模与真实故障下，会不会把平台拖垮，或者在压力下以另一种方式失效**。下面六项预算，本文只能给出机制与量级 —— **具体数字必须在你的环境里压测出来，并写进变更单**。

| 要给什么定预算 | 机制事实 | 你必须设定的预算 / 动作 |
|---|---|---|
| **准入路径上的外部调用（同步准入）** | 有三条判据会在准入请求内部等待一次外部往返：`context.imageRegistry`（[§4.5.2](#s4-5-2)）、[§4.2.1](#s4-2-1) 的 validate `context.apiCall`，以及 [§4.2.3](#s4-2-3) 的准入 mutate `context.apiCall`（它去取父 PipelineRun —— **虽然挂在 mutate 规则上，但它在 TaskRun CREATE 的 webhook 请求内同步执行，同样消耗本行的预算；不要把它漏算**）。**三者都失败关闭**：镜像仓库不可达 → 请求被拒（大约 5 秒；可达时大约 3 秒，见 [§4.5.2](#s4-5-2) 的局限 4）；[§4.2.1](#s4-2-1) / [§4.2.3](#s4-2-3) 的 apiCall 取不到目标 → 规则报错、请求被拒（准入 mutate 规则失败，与 validate 失败一样按该策略的 `failurePolicy` 拦截 —— 机制出处：release-1.15 `pkg/webhooks/resource/mutation/mutation.go` 的 `BlockRequest` 分支；[§4.2.1](#s4-2-1) 的报错形态见该节的警告）。**"报错即拒绝"的前提是该策略实际生效的 `failurePolicy` 为 `Fail`**（本文的同步拦截素材都显式声明了 `Fail`；完整分级见下面"`failurePolicy` 权衡"一行）；一旦切成 `Ignore`，或者平台级的 `forceFailurePolicyIgnore` 生效，同样的报错就变成放行。**[§4.2.2](#s4-2-2) / [§4.6.1](#s4-6-1) 的 apiCall 不属于本行** —— 它们挂在 mutate-existing 上，失败方向相反；见下一行 | 明确决定"哪些请求路径允许带外部调用"；把这类规则的 match 收窄到**确实需要它们的那些 Task**；压测 p95 / p99 与超时比例，确认它低于 webhook 超时 —— **那个上限是针对整个请求的，不是每条规则各算一份**（默认 `timeoutSeconds=10`，见 [§3.1](#s3-1) 清单第 6 项；一次 5 秒的仓库往返塞得下，两次叠在同一个请求上就未必了）。**镜像仓库 / API server 的抖动会直接变成流水线创建失败** —— 相应的告警与预案要提前备好 |
| **异步投递链（mutate-existing 取消是失败开放的）** | 本文四条取消路径中有三条是 mutate-existing（[§4.2.2](#s4-2-2) / [§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2)），它们位于**准入判决之外**：命中之后，background-controller 通过 UpdateRequest 异步给目标对象打补丁。所以这条链上任何一环出问题 —— 规则的 `context.apiCall` 取不到目标、UpdateRequest 根本没被创建、background-controller 挂了或积压、目标资源的 update RBAC 被收回 —— **原始请求照常放行，而取消补丁静默消失**：流水线一路跑完，集群里没有任何拒绝消息，也没有 PolicyReport 违规记录（mutate 类不产生违规记录 —— 见 [§4.2.3](#s4-2-3) 的警告），顶多在控制器日志里留下几行错误（求值与写入层在 background-controller，UpdateRequest 的**创建层在 admission-controller** —— 三层的特征见 [§3.7.1](#s3-7-1) ③；**控制器自身不可用那一类故障连这几行都不会留** —— 只有 [§3.7.1](#s3-7-1) ① 的存活监控能覆盖它）。**判据方向失败关闭 ≠ 投递保证**：判据说的是"result 缺失/非法也照样取消"，但取消能不能落地，取决于这条后台链路是否健康 | **要硬保证零竞态、零静默失败，只有同步路径够格**：[§4.2.1](#s4-2-1) 的 deny 或 [§4.2.3](#s4-2-3) 的准入 mutate（两者都在准入内给出同步判决）。如果你坚持用 mutate-existing，就必须把这条链当作**一套有 SLA 的投递系统**来监控：可用的信号面（控制器存活 / 指标 / 日志与事件）、每个信号的语义边界、归因方法，以及受控的故障注入流程，都在 [§3.7.1](#s3-7-1) —— 这份监控契约的**唯一完整版本**（[§3.8](#s3-8) 第 9 步与 [§6.2.3](#s6-2-3) 的排障只引用它，绝不重述）；把选定的信号与告警分诊 SOP 写进变更单 |
| **单个请求命中多少条规则** | 一次 CREATE 可能同时命中多条策略（多条策略之间是与关系，[§1.3](#s1-3)），每条策略又可能有多条 rule；[§4.5.3](#s4-5-3) 的镜像白名单是三条 rule，每条都对容器列表跑 `foreach` | 按资源类型设定"单请求最多命中多少条规则 / 最多几次外部调用"的上限；超了就合并判据或收窄 match —— 不要拿单条策略的孤立压测下结论 |
| **`*/status` 策略的求值频率** | 一条流水线的 status 会被**回写很多次**（观测点 3 / 6，[§2.1](#s2-1)）；读取 status 的策略**每一次回写都会重新求值**，而请求体里带着整个 `status.pipelineSpec`（大模板时会很大） | 把昂贵的判据（外部调用、长列表遍历）**放在门禁任务或事后链路里**，绝不要放进 `*/status` 策略；上线前先测一次"单请求体大小 × status 更新次数" |
| **后台扫描与 PolicyReport 体量** | 全文只有一条 `background: true` 的策略（[§4.4.4](#s4-4-4)）；它会周期性地重新求值**所有**匹配对象；报告按被求值对象生成，随对象一起被 GC，且**没有 TTL / 保留语义**（[§4.4.4](#s4-4-4) 的边界） | 按 PipelineRun 体量估算报告对象数量与增长；如果需要留痕，就搭建**外部归档**（不要把 PolicyReport 当历史库用）；对 reports-controller 的积压设告警 |
| **`failurePolicy` 权衡** | **分级落在每条策略自己的 `spec.webhookConfiguration.failurePolicy` 上**（字段语义、两层读取与检查命令见 [§3.1](#s3-1) 清单第 6 项与 [§3.1.2](#s3-1-2)；两个取值的后果见 [§6.1.8](#s6-1-8) —— 这里不重述）。⚠️ **`validate.failureAction: Audit` 挡不住这件事**：它只决定一条成功求值的规则是否拦截；**策略的 match 面无论如何都会注册进 webhook** —— 在 Kyverno 不可用期间，API server 会按该策略的 `failurePolicy` 处置每一个匹配请求；一条声明了 `Fail` 的 Audit 策略照样会拒绝匹配的 `*/status` 回写，Kyverno 停多久流水线就卡多久，而这还是一条正常情况下什么都不拦的策略。本文素材据此分级并作了声明：**17 条声明 `Fail`，8 条声明 `Ignore`**。`Fail` 这一档 = 准入拦截类策略（Enforce / mutate 注入）**加上 [§4.2.2](#s4-2-2) 的取消触发器** —— 它虽然是 mutate-existing，但触发面是主资源 TaskRun 的 CREATE，守的正是 [§4.2.1](#s4-2-1) 守的那道门（三种响应形态之一 —— 见 [§4.2.3](#s4-2-3) 的对照表）；若用 `Ignore`，Kyverno 一旦故障，违规就会**既不被拦截也不被取消地永久放过**（`background: false`，没有回溯扫描）。`Ignore` 这一档有 8 条 —— 其中 7 条匹配 `*/status`（状态回写绝不能因为 Kyverno 故障而被拦住 —— [§2.2](#s2-2) 的红线在故障场景下同样成立），另 1 条是 [§4.4.4](#s4-4-4) 的清点扫描（匹配 PipelineRun 主资源的 background Audit：它正常情况下什么都不拦，可一旦用 `Fail`，Kyverno 故障就会拒绝所有匹配的 PipelineRun CREATE —— 零拦截收益，纯可用性代价；按 [§4.4.4](#s4-4-4) 把它提升为 Enforce 时要重新评估层级） | 按策略风险分级，写进策略正文并用 GitOps 管理：**平台基线与 Pod 级镜像白名单保持 `Fail`**，前提是四个控制器跨节点高可用、且在滚动升级期间保持可用；纯记账的 Audit 策略，以及匹配 `*/status` 的取消触发器（[§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2)）取 `Ignore`（本文有 8 条素材：7 条 `*/status` 匹配 + [§4.4.4](#s4-4-4) 的清点扫描；**[§4.2.2](#s4-2-2) 的取消触发器不在这一档** —— 它守的是与 [§4.2.1](#s4-2-1) 同一道准入门，随它一起保持 `Fail`，理由见左格）—— 代价是 Kyverno 不可用期间，这些记账与取消触发会缺失，所以要写下你接受的真空边界。**两件不要混为一谈的事**：① 在 mutate-existing 取消策略上，这个字段只决定 Kyverno webhook 不可用时**触发请求**是否被拦截 —— `Fail` 关不掉异步投递本身的失败开放（见上一行）；② 一旦平台级的 `forceFailurePolicyIgnore` 打开，所有声明的 `Fail` 全部落空 —— 那是平台级覆盖开关，不是分级工具（机制与检查方法见 [§3.1.2](#s3-1-2)）。每个集群都要写下"选了哪一档 + 为什么 + 最低副本数 + Kyverno 维护窗口期间会发生什么"，并演练一次故障场景 |

**一句话判据**：任何"要等别人回答"的判据（外部镜像仓库、API server）都是可用性风险；任何"每次状态回写都要跑一遍"的判据都是成本风险。**这两类都不该在没有预算的情况下上主路径。**

#### 3.7.1 异步投递链的监控契约（信号面、归因与故障注入） {#s3-7-1}

本小节展开上面"异步投递链"一行中"把它当投递系统来监控"的要求，是 [§3.8](#s3-8) 第 9 步（升级回归）与 [§6.2.3](#s6-2-3)（按运行排障）共用的**唯一事实来源** —— 那两处只引用本小节，绝不重述；信号语义的修订只落在这里。

先排除一个最常被误当成证据的动作：**事后单跑一次 `kubectl get updaterequests` 不是数据源** —— 失败的 UpdateRequest 只在其重试窗口内可见，重试结束就被删除（通常一两分钟内），此后查询结果为空，而**空输出对链路健康什么都证明不了**。可用的数据源是下面的 ①–③（⚠️ ③ 横跨 **admission 与 background 两个控制器** —— 链路第一环"创建 UpdateRequest"发生在 admission 侧，只盯 background 侧会漏掉整整一层），④ 是对它们的受控验证；**这些信号没有任何一个能单独证明"补丁落到了目标上" —— 链路健康的最终裁决者永远是目标对象的终态**（[§3.8](#s3-8) 第 9 步的首要判据）：

- ① **background-controller 的存活、重启次数与队列积压。** 这一项是其余各项的前提：**控制器一挂，② 和 ③ 都不会再产生任何新记录** —— "控制器死了"在 ② 和 ③ 里看起来与"一片平静"一模一样。
- ② **指标（持久计数器 —— ⚠️ 它只覆盖规则求值这一层）**：在 background-controller 的指标端口（`kyverno-background-controller-metrics:8000`）上，`kyverno_policy_results_total{rule_type="mutate",rule_execution_cause="background_scan"}`，按 `policy_name` / `rule_name` 打标签，在 UpdateRequest 被删除之后依然保留（它是计数器，控制器重启会归零 —— 接入采集系统之后再对它设告警）。
  - **这个计数器记录的是规则求值的结果，而且在补丁写入目标之前就已经累加了**：`rule_result="pass"` = 求值成功、算出了一个补丁 —— **它并不能证明补丁被写进了目标对象**；`rule_result="error"` = 求值失败（包括 apiCall 取不到目标）。如果随后写入目标时因 RBAC、resourceVersion 冲突或 API 报错而失败，**`pass` 已经计上了，而 `error` 永远不会增加 —— 写入层的失败在这个计数器里完全不可见**；只有 ③ 的第二个日志特征与事件能覆盖它。
  - 它统计的还是**尝试次数而不是事件数**（首次投递与每次重试各算一行），而且 `error` 有一个良性来源：当父对象已经被删除时，apiCall 的 404 属于正常的清理竞态（[§4.6.1](#s4-6-1) 的 404 注记），照样被计成 `error`。所以这个计数器**只能作为求值层的分诊线索，绝不能直接作为告警条件** —— "只要增长 > 0 就告警"会被正常的清理竞态持续误报 —— 也**绝不能拿它做"命中数减落地数"的对账**。
  - 当 `error` 增长时，**按目标对象归因**：找出那种"本该被取消却还在跑"的运行（查 `spec.status` / `cancel-reason` —— [§6.2.3](#s6-2-3) 的按运行命令）；只有这样的运行才是真正的投递失败。**归因是有保质期的**：目标对象一旦被 GC 或清理掉，"报错时对象已经被删除（良性 404）"与"投递真的失败、对象随后消失"留下的现场一模一样（[§6.2.3](#s6-2-3) 也提到注解 / 事件 / 报告都会随对象一起消失），此后再也分辨不出来 —— 所以要把这项后续检查写进告警 SOP 并**及时执行**（在对象保留窗口之内），无法归因的增长记为"未知，待查" —— **绝不要默认它是良性的**。
- ③ **日志与事件（确定性特征 —— 创建 / 求值 / 写入，各层各有归属）**：
  - **创建层**的失败（UpdateRequest 根本没被创建）记录在 **admission-controller，而不是 background-controller** 的日志里：创建发生在准入时启动的一个异步 goroutine 里（`Apply()` 立即返回；错误永远到不了准入判决），在大约 3 秒的退避重试之后，失败会打出 ERR `failed to update request CR`；当集群的 UpdateRequest 数量达到 `updateRequestThreshold`（Kyverno ConfigMap）时，创建会**被直接跳过**，打出 ERR `UpdateRequest creation skipped`。这一层失败时，① 与 ② 以及 background 侧的日志**统统是静默的**，事先启动的 watch 也什么都看不到（根本没有对象被创建过）—— 机制出处：release-1.15 `pkg/webhooks/updaterequest/generator.go`（`Apply()` / `applyResource()`）与 `pkg/utils/generator/updaterequests.go` 的阈值分支。
  - **求值层**的失败会打出 ERR `failed to mutate existing resource, rule <rule-name>, ...`（当 apiCall 取不到目标时，错误串中含有 `failed to fetch data for APICall`），并带有结构化的 `policy=` / `resource=` 字段。这一行**不适合直接拿来告警**（父对象已删除的正常竞态打的是同一行）；按 `resource=` 找到目标对象，再按 ② 的归因判据分类。这条路径上目标对象从未被解析出来，所以**不会产生 Kubernetes 事件**（Kyverno 的日志原话就是：`cannot generate events for empty target resource`）。
  - **写入层**的失败（求值通过了，把补丁写进目标时失败）打出的是**另一个** ERR 特征 `failed to update target resource`（带有目标的 `namespace=` / `name=` 字段）—— 搜索时要**把所有特征、跨两个控制器一起搜**；只搜第一个特征会把整类写入层失败漏掉。这时目标对象已经被解析出来，所以 Kyverno 会在目标对象上发出 `BackgroundFailed`（成功侧是 `BackgroundSuccess`）事件，可在目标命名空间用 `kubectl get events` 看到 —— 这是写入层唯一的对象级信号（机制出处：release-1.15 `pkg/background/mutate/mutate.go` 的 Pass 分支与 `report()`）。
- ④ **受控故障注入（上线前一次，每次升级之后一次）**：**在触发之前先起好 `kubectl get updaterequests -n kyverno -w`**（UpdateRequest 的生命周期只有事先启动的 watch 能看到 —— 失败侧表现为 `Pending → Failed` 重试之后消失，健康侧表现为 `Pending → Completed`；**确认触发过、而 watch 里始终什么都没出现 = 创建层失败** —— 去 admission-controller 日志里找 ③ 的那两个创建层特征）；在共享 / 生产集群上，请使用**一条专用测试策略 + 一个测试命名空间 + 一个指向已知不存在对象的无害 apiCall**（不碰任何真实策略、不碰任何业务对象），确认 ② 与 ③ 的信号确实出现、并且归因步骤能精确定位到被注入的那个目标对象，把结果写进变更单。"临时停掉 background-controller"是一次集群级中断（它会同时打断该集群上其他所有 mutate-existing / generate 的投递）—— 请把它留给专门的验收集群或维护窗口，事先记下副本数，事后验证 Ready 与积压已经排空。

### 3.8 升级与回滚：最小回归集（每次升级后必跑 —— 不要只看 `Ready`） {#s3-8}

[§3.6](#s3-6) 告诉你"升级会影响什么"；本节回答"那我到底要跑哪些"。**没有这份清单，实践中回归就不会发生** —— 因为策略升级之后最常见的失效形态就是 `Ready=True` 加上一尘不染的报告（[§3.6](#s3-6) 的两种判据形态）。

按顺序执行。**"一个应放行的探针 + 一个应拒绝的探针"这个要求只对准入 Enforce 的步骤成立** —— 第 **2 / 3 / 7 / 8 / 10** 步两个都要跑，只跑一半是抓不出方向错误的（理由见 [§4.0.3](#s4-0-3) 的两步自查）。其余五类没有**"准入放行"**这一侧，各有各的通过判据 —— 不要硬套这个模式：第 **1** 步是配置 diff（它不提交任何对象）；第 **5 / 6** 步是 Audit —— Audit 不拦截任何请求，所以每个请求都会"被放行"，但**这不等于它们没有健康侧**：健康侧在 PolicyReport 里（正常输入必须得到 `pass` / `skip` 而不是 `fail`），所以这两步同样要跑两侧 —— 只跑违规侧的话，一条把**所有**输入都记成 `fail` 的坏策略（身份判据接反了的典型形态）能毫发无伤地通过回归；第 **4** 步验证的是"响应形态与你选定的那一种一致"（三选一，deny 与两种取消要在不同地方检查），第 **9** 步验证的是取消**是否真的落到了对象上**（mutate-existing 是异步的；准入侧不会拒绝）；第 **11** 步是端到端的合规基线（只有放行侧 —— 它要证明的是没有伤到任何合规的东西）。

| # | 跑什么 | 通过判据（看行为，不看 `Ready`） |
|---|---|---|
| 1 | [§3.1](#s3-1) 的 7 项清单 + `config-defaults` / `feature-flags` / `hubresolver-config` / kyverno ConfigMap 这四份配置 | 取值与升级前一致；任何不一致都先按 [§3.6](#s3-6) 定位受影响的策略 |
| 2 | [§4.1.1](#s4-1-1) 的模板白名单 | 已批准模板放行；旧版本号、未知 resolver、请求级 `url` 三者全部被拒 |
| 3 | [§4.2](#s4-2) 的门禁参数契约（用你实际选定的那种响应形态） | 合规参数放行；关闭门禁与显式空值两者都被拦。**新增的 override 入口分两个阶段处理 —— 不要要求黑名单天然拦住它从没见过的字段**（[§3.6](#s3-6) 已经说明：没见过的默认落在放行侧；把一个已知的旧字段当成"未知"去测而得出的"它拦住了"，是一次假的回归通过）：**先枚举** —— 通过 API schema / `kubectl explain` / 真实对象与升级前存档的 diff，找出本次升级新增的 override 入口，逐个探针确认旧判据的实际方向，**凡是放行的都记为待办缺口 —— 此时回归尚未通过**；**再治理** —— 判断该入口能否影响受保护行为，能影响的先更新判据，再验证更新后的策略确实拦住它（同时保留一个正常输入仍被放行的正向用例，防止过度拦截）。本步的通过判据是："每一个影响受保护行为的新增入口，都在**判据更新之后**被拦住" |
| 4 | 一个真实的门禁 TaskRun | 不合规参数以**你选定的那一种**响应形态终止，而三种形态要在不同地方检查（[§6.2.3](#s6-2-3)）：[§4.2.1](#s4-2-1) deny → 父运行 `CreateRunFailed`；[§4.2.2](#s4-2-2) 取消父运行 → **首要判据是父运行的 `spec.status=CancelledRunFinally` 加上 `cancel-reason` 注解** —— 终态通常是 `Cancelled`，但当取消与任务失败竞态时（result 写不出来，或取消落在某个子 TaskRun 的初始化窗口内）终态会是 `Failed`，而 `spec.status` 与注解照样都在（[§2.3](#s2-3) 的主表；[§4.6.1](#s4-6-1) 的两处竞态注记）—— **那不是回归失败，别把一次健康的取消判成故障**；[§4.2.3](#s4-2-3) 取消门禁 TaskRun 自身 → **那个 TaskRun** `Cancelled` + `spec.statusMessage`（父运行上不会有 `cancel-reason`；不要拿它来判失败） |
| 5 | 一次**真正失败**的扫描（sonar 与 trivy 各一次）+ **一次干净的扫描作为健康侧对照** | 失败侧：PolicyReport 中出现对应的 `fail`。**没有 `fail` 一律判定为"验收未通过" —— 绝不能说成"扫描通过了"，也不能直接说成"策略没匹配上"** —— 策略身份没匹配、`resourceFilters` 跳过、报告尚未收敛、对象已被 GC，这四种情况产出的空结果一模一样；按 [§4.4.4](#s4-4-4) 的五种含义逐一排查。健康侧：干净的扫描在该策略名下被记为 `pass`（[§4.4.1](#s4-4-1) 的正常形态），**且没有意料之外的 `fail`** —— 没有这一侧，一条把所有终态都记成 `fail` 的坏策略（升级后身份判据接反了）在这一步是看不见的 |
| 6 | 用 `when` / 空 matrix 让门禁被跳过 + **一次门禁正常执行的运行作为健康侧对照** | 违规侧：它出现在 `status.skippedTasks` 中，且 [§4.1.5](#s4-1-5) 的 Audit 记录了违规。健康侧：门禁执行过的那次运行在该策略名下**不产生** `fail`（[§4.1.5](#s4-1-5) 的正常形态是 `skip` —— 前置条件不成立）—— 否则一条把**每一次**受治理运行都判成"门禁被跳过"的坏策略，能毫发无伤地通过这一步 |
| 7 | [§4.5.3](#s4-5-3) 的 Pod 镜像白名单 | 已批准仓库放行；未批准的在三条路径上都被拒 —— **普通容器 / init 容器 / `ephemeralcontainers` 子资源** —— 并且消息里列出了违规镜像 |
| 8 | [§4.5.5](#s4-5-5) 的发布目标 | 已批准的命名空间 / 凭据放行；名单之外的一律被拒 |
| 9 | 当 [§4.6](#s4-6) 的取消策略已安装时：一次结果不达标的运行（[§4.6.1](#s4-6-1)）+ 一次定义漂移的运行（[§4.6.2](#s4-6-2)）+ **一次同一受治理画像下的合规运行作为健康侧对照**（[§4.6.1](#s4-6-1) 检查清单里 `coverage-lines=85` 的反向对照 —— 第 11 步的合规基线用的是 `gated-build` 夹具，不是本步的受治理画像，不能替代） | **首要判据是目标运行的终态**。健康侧：合规运行既没有被取消，也不带 `cancel-reason` —— 没有这一侧，一条判据方向翻转成"无条件取消"的策略，照样能通过这一步。违规侧：`spec.status` 被写成 `CancelledRunFinally`，且 `cancel-reason` 的措辞正确（指标里的 `rule_result="pass"` 只能证明求值层算出了一个补丁，绝不能证明补丁落到了目标上 —— [§3.7.1](#s3-7-1) 的 ② 语义）。**同时还要以可证伪的方式确认异步链路本身是通的**（信号语义按 [§3.7.1](#s3-7-1)；本步只补充回归专属的判断）：要么**在触发之前先起好 `kubectl get updaterequests -n kyverno -w`**，在 watch 里看到本次运行的 UpdateRequest 到达 `Completed`（反复 `Pending → Failed` 然后消失 = 链路断了；事后单跑一次 get 得到的空输出什么都证明不了 —— [§3.7.1](#s3-7-1) 开头）；要么按 [§3.7.1](#s3-7-1) 的 ② 与 ③ 检查信号面：把窗口期内每一次 `"error"` 增长与每一行求值层 ERR，都按其 `resource=` 归因 —— 回归窗口内的目标都是**你自己**创建的对象，所以 [§3.7.1](#s3-7-1) ② 的"归因保质期"在这里天然可满足：把 ERR 行的时间戳与对象的删除时间对上（删除是你执行的，或者 `kubectl get events` 有记录）—— **只有时间线对得上才算良性竞态；任何建立不起时间线的信号一律判为失败**；并确认写入层的两个信号**不存在**（一行 `failed to update target resource` 的 ERR，以及目标命名空间中本策略的 `BackgroundFailed` 事件 —— [§3.7.1](#s3-7-1) ③）。任何无法归因的信号，或者任何一次没有被取消的验收运行，都算失败。这条链路正是升级时被悄悄破坏得最厉害的地方（RBAC 聚合规则变化、UpdateRequest API 版本变化），而它一旦断掉，任何拒绝消息都不会出现 |
| 10 | 当 PolicyException 已启用时（[§5.3](#s5-3)） | 没有例外时被拒 → 有受控例外时放行 → 删除之后再次被拒（三种状态都要查；缓存吊销需要一点时间） |
| 11 | 一条完整的业务流水线跑到终态（手边没有就用 [§3.3](#s3-3) 的 `demo-run-pass`，即本文通篇使用的合规夹具） | 逐项核对，而不是"跑起来了就行"：父运行的终态与升级前一致；`status.childReferences` 中每个子 TaskRun 都到达预期终态；finally 执行了；PolicyReport 中该有的 Audit 记录都在，**且没有意料之外的 `fail`**（用 [§6.2.3](#s6-2-3) 的命令按运行 UID 拉取 —— 一次合规运行下冒出 `fail`，说明某条 Audit 策略的判据在升级中被接反了；第 5 / 6 步的健康侧对照就是为了抓这个）；并且没有任何一处意外出现 `cancel-reason` 或 `statusMessage` |

**Task / 模板升级的特殊要求**（这类升级最容易只留下"看上去没问题"）：读取结果的策略必须**先**改判据（身份、result 名称、property 路径 —— 三者一起改，[§3.6](#s3-6)），再切换生产 Task；只有当第 5 步验证过"一个失败样本能产出 `fail`"，这次变更才算改对了。

**回滚按上线的相反顺序执行：先策略契约，后运行对象。** 先把与目标 Task / 模板版本匹配的策略版本重新部署好，并用上表的第 2、3、5 步验证，然后再把模板 / Task 切回旧版本。**在策略与模板身份不匹配的那个窗口内，门禁不提供任何保证**：该窗口内"PolicyReport 没有违规"只说明策略没匹配上，不能当作通过（与 [§4.4.4](#s4-4-4) 同理）。窗口无法避免时，就把那段时间显式标记为"门禁未生效" —— 不要让它进入事后的合规结论。
## 4. Policy Cookbook {#s4}

本章按治理场景组织，每一节都遵循固定结构：

**引言**（治理什么 / 难在哪里 / 策略怎么分层 / 治理不了什么）→ **关键判据**（策略最核心的那几行，就地展开）→ **完整策略素材**（折叠，可直接复制）→ **验证探针与预期结果**（折叠）→ **清理**。

**这几条策略没有折叠**：[§4.2.5](#s4-2-5) 的 `trivy-gate-must-stay-on`（"先读最小版本"的过渡形态；同一节还带有折叠的完整版 `official-template-gates-on`）、[§4.2.6](#s4-2-6) 的 `pipeline-run-defaults`，以及 [§4.4.4](#s4-4-4) 的 `inventory-ungated-runs` —— 这几节的完整 YAML **直接放在正文里**（那一份清单本身就是该节的全部要点）。所以当你要一次性收集本章所有可安装素材时，**请全文搜索 `kind: ClusterPolicy`，而不是只去采集折叠块** —— 只采集折叠块会静默漏掉它们，而 [§5.2](#s5-2) 的两条演示策略同样在正文里。

为了让同一批演示素材能被统一地安装、验证与清理，本章使用 `ClusterPolicy`，但每一条 Enforce 规则的作用域都限定在演示命名空间 `policy-poc`。**这是演示上的选择，而不是对项目管理员的生产权限建议**：项目管理员应当把同样的规则逻辑放进自己命名空间里的 `Policy`，设置 `metadata.namespace`，并移除演示中的跨命名空间作用域（例如 `resources.namespaces` 或 `namespaceSelector`）。只有平台基线，或者由平台集中管理的跨命名空间策略，才使用 `ClusterPolicy`。具体的转换方式与 RBAC 边界见 [§5](#s5)。

本章**大多数**准入类策略都用 `kubectl create --dry-run=server -f probe.yaml` 探针验证 —— 完整跑一遍 webhook 求值，零副作用（[§3.4](#s3-4)）。**两个例外是 [§4.2.1](#s4-2-1) 与 [§4.2.3](#s4-2-3)**：它们判定的是 Tekton 控制器创建的子 TaskRun，而且还要沿 ownerReference 回看一个**已经持久化**的父运行 —— dry-run 的 PipelineRun 既不会被持久化，也不会派生子对象，所以**唯一的办法是真跑一条流水线**（[§3.4.1](#s3-4-1) 有解释）。策略与探针都在**目标集群**（跑 Kyverno 与 Tekton 的那个）上执行；见 [§3](#s3) 开头的说明。

### 4.0 开始之前：装哪些策略、按什么顺序 {#s4-0}

本章的策略列在下面的总览表中（`pod-image-registry-allowlist` 提供两份可互换的 YAML，在表中占相邻两行）。**不要从头到尾顺序安装。** 下面给出一个"最小可用集"及其安装顺序；其余的按需取用。

#### 4.0.1 最小可用集及其安装顺序 {#s4-0-1}

| 阶段 | 装什么 | 前置条件 | 它拦住什么 | 建议模式 |
|---|---|---|---|---|
| 0 | 什么都不装（只做验证与夹具） | [§3.1](#s3-1) 清单第 1 项（四个 Kyverno 控制器全部 Ready）是必须的；第 2 项 —— **按你实际会用到的 resolver 来验证**：[§4.1.1](#s4-1-1) 的三个通道分别依赖 cluster / hub / git resolver 开关，只启用你需要的那一个。要跑演示的话，还要建好 [§3.3](#s3-3) 的夹具 | — | — |
| 1 | `pipeline-template-allowlist`（[§4.1.1](#s4-1-1)） | 先决定你走三个通道中的哪一个（集群内模板 / 不可变远程引用 / 默认拒绝可变引用）；远程引用需要先把 `<approved-git-repo>` 与 `<catalog>` 定下来 | 绕开受治理模板、自行拼装流水线 | 先用 Audit 观察一轮，再切 Enforce |
| 2 | `pipeline-entry-lockdown`（[§4.5.4](#s4-5-4)） | `<platform-admin-identity>`（逐个枚举；不要用通配） | 通过直接创建裸 `TaskRun` / `CustomRun` 绕过 PipelineRun，从而跳过上一条策略 | Enforce（没有它，第 1 条策略可以被绕过） |
| 3 | 按你的流水线来源二选一（也可以并存）：官方 java / python 0.3 模板 → `trivy-gate-must-stay-on`（[§4.2.5](#s4-2-5) 最小版本，PipelineRun 层 —— **改完作用域即可安装；身份判据无需改动**）；自建模板 → 把 `gate-param-contract`（[§4.2.1](#s4-2-1)，TaskRun 层）当作**待改写的模板**使用 | `trivy-gate-must-stay-on` 开箱可用；`gate-param-contract` **不是现成实现** —— 它的 preconditions 固定在演示的 `gated-build` / `policy-demo-scanner` 上，只有当你换成真实的父 Pipeline 身份、Task 身份与参数契约之后才会生效 | 门禁参数被关掉（`trivy-gate-must-stay-on` 还会拦住显式跳过开关 `skipTrivyScan`，以及两条 `podTemplate.env` 注入路径：按任务的 `taskRunSpecs[].podTemplate` / `serviceAccountName`，与按运行的 `taskRunTemplate.podTemplate.env` —— 环境变量会进到 step 容器里，能在所有参数都显示正常的同时改变扫描行为）。**但它拦不住任意的 `when` / matrix 跳过** —— 被跳过的门禁根本不产生 TaskRun，准入什么都看不到，只有 [§4.1.5](#s4-1-5) 的 `skippedTasks` 事后 Audit 能发现 | Enforce；**必须与模板版本同步上线**（见 [§4.2.5](#s4-2-5) 的升级顺序警告） |
| 4 | `scan-verdict-audit` / `vuln-summary-audit`（[§4.4.1](#s4-4-1)）、`inventory-ungated-runs`（[§4.4.4](#s4-4-4)） | 这些 Task 的 result 契约（[§3.2](#s3-2) 的版本矩阵）。**三者的就绪程度不同**：`vuln-summary-audit` 固定在 hub `trivy-scanner` 0.6 上，与官方模板匹配 —— 改完作用域即可用；`scan-verdict-audit` 固定在演示的 `policy-demo-scanner` 上，**必须先按 [§4.4.1](#s4-4-1) 改写成 hub `sonarqube-scanner` 0.7**，才能审计官方模板 | 什么都不拦；只把结果记入 PolicyReport：漏洞聚合与总体状态（可直接用）、扫描结论（改写后可用），以及**缺少平台标记的既有运行** —— 注意最后这一项**并不能证明门禁真的跑过**（标签可以由流水线使用者自己写上；[§4.4.4](#s4-4-4) 有专门说明） | 前两条**必须保持 Audit** —— 它们读的是 `*/status`，用 Enforce 会把流水线卡死（[§4.4.3](#s4-4-3)、[§6.1.4](#s6-1-4)）。`inventory-ungated-runs` 匹配的是 PipelineRun 主资源：**先用 Audit 清点；存量整改完之后，按 [§4.4.4](#s4-4-4) 评估是否切到 Enforce** |
| 5 | `pod-image-registry-allowlist`（[§4.5.3](#s4-5-3)） | 三个取值：`<approved-registry-regex>`、`<tekton-infra-image-regex>`（两者都用 [§4.5.3](#s4-5-3) 的方法生成）、`<tekton-managed-by-label-value>`（从 `config-defaults` 读取；用它把范围限定在 Tekton Pod 上）。**然后二选一**：把正则写进策略正文，或者采用 [§4.5.3](#s4-5-3) 的跨环境形态 —— 先创建 `pipeline-image-allowlist` ConfigMap（策略通过 `context.configMap` 读取它，**ConfigMap 缺失时失败关闭**，所以必须先创建并纳入变更管控） | 把实际执行的镜像换成**已批准仓库之外**的镜像（覆盖 Tekton Pod 的全部三类容器 —— **step / init / ephemeral 调试容器** —— 以及全部三条入口路径：CREATE、修改镜像的普通 UPDATE，以及 `ephemeralcontainers` 子资源注入）。**注意这是"前缀白名单"而不是"镜像身份白名单"**：换成同一个已批准仓库**内部**的另一个镜像，或者可变 tag 的内容被替换，都不会被拦 —— 要那种强度，就固定 digest 或加上 `verifyImages`（[§4.5.3](#s4-5-3)） | **务必先 Audit**：这条策略作用在 Pod 层，正则里漏掉一类基础设施镜像，就会让整个 Tekton 起不来 |

**最小集里有四条策略需要的不只是替换占位符**：其中三条把身份固定在演示夹具上（`pipeline-template-allowlist`、`gate-param-contract`、`scan-verdict-audit` —— `tekton-templates` / `gated-build` / `policy-demo-scanner`；安装之前请把它们换成你真实的模板命名空间、模板名与 Task 名），第四条 `pipeline-entry-lockdown` 必须补齐你环境中所有合法的自动化创建者身份（[§4.5.4](#s4-5-4)）。**照抄会朝两个相反的方向翻车**：白名单类会**拒绝掉你所有**真实流水线，而 Audit 类会**静默地什么都不做**。逐条策略的注记见 [§4.0.2](#s4-0-2)"能否照抄"那一列。

**第 5 阶段完成之后，最小可用集就齐了** —— 但它给出的是一份**有条件的保证**；不要把它读成"流水线再也绕不过去了"：

- PipelineRun 所引用**定义的身份**受白名单约束 —— 但集群内模板的**内容与变更权限**，仍然要靠 [§4.1.2](#s4-1-2) 的 RBAC 封堵（策略只管"引用了哪个模板"，不管"谁改过那个模板"）；
- **裸 TaskRun / CustomRun** 这两个入口受策略约束 —— 但一个持有工作负载 API 权限的身份，照样可以直接创建 Pod / Job / Deployment，或者在别处使用部署凭据。**"流水线绕不过去"是 RBAC + 策略共同作用的结果**（[§4.5.4](#s4-5-4)）；
- 门禁参数这项保证覆盖到哪里，**取决于你在第 3 阶段选了哪条策略**：选 `trivy-gate-must-stay-on` → **官方 0.3 模板**的门禁参数关不掉、无法用 `skipTrivyScan` 跳过、也无法通过 `podTemplate.env`（按任务或按运行）从侧面改变扫描行为；选 `gate-param-contract` → 它只覆盖那些**你已经改写成真实画像、并锁定了身份**的自建门禁 —— 原样照抄的话，它除了演示夹具什么都匹配不到。两者都不覆盖"用 `when` / matrix 把门禁整体跳过"—— 那属于 [§4.1.5](#s4-1-5) 的事后 Audit，不在最小集的硬拦截范围内；
- step 容器的**运行时镜像**被限制在已批准的仓库前缀内 —— **但这不等于"扫描器换不掉"**：在同一个仓库内换镜像，或者可变 tag 的内容被替换，都不在这条策略的覆盖范围内（[§4.5.3](#s4-5-3) 建议固定 digest / 加上 `verifyImages`）。
- 结果是**部分可观测**的（Audit；不拦截）：**漏洞**这一侧开箱可用（`vuln-summary-audit` 与官方模板共享身份）；**Sonar 结论**这一侧需要先把 `scan-verdict-audit` 改写成真实扫描器的身份 —— 否则它只审计演示夹具，PolicyReport 里一条记录都不会有；而"缺少平台标记"的清点**并不等于**"门禁没有执行"。

**明确不在最小集之内的**（按需添加；每一项都有额外前置条件）：

- [§4.1.4](#s4-1-4) / [§4.1.5](#s4-1-5) 的事后内省与"门禁必须执行"审计 —— 纵深防御，Audit 类型；
- [§4.2.4](#s4-2-4) 受保护分支门禁、[§4.5.1](#s4-5-1) 制品搬运来源、[§4.5.5](#s4-5-5) 发布目标、[§4.5.2](#s4-5-2) 源镜像属性 —— **场景画像**，只有当你确实使用那些模板 / Task 时才安装；
- [§4.2.5](#s4-2-5) 的**完整画像** —— 最小版本只保证"门禁没被关掉"；完整画像还要加上"配置入口与构建输入受控"，条目众多，而且与模板版本强耦合；按 [§4.2.5](#s4-2-5) 的分组表按需取用；
- [§4.4.2](#s4-4-2) 的字符串形态 result 兼容判据 —— 一个**兼容层**，只服务于契约改不动的既有 Task，其支持面已冻结（见该节）；
- [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6](#s4-6) 的**取消类**策略 —— 属于响应动作，不是准入拦截；其中 [§4.2.2](#s4-2-2) 与 [§4.6](#s4-6) 是 mutate-existing，需要额外 RBAC（[§4.6](#s4-6) 引言），而 [§4.2.3](#s4-2-3) 是准入 mutate，**不需要**额外 RBAC；
- [§5.3](#s5-3) 的 PolicyException —— 需要先按 [§3.1.1](#s3-1-1) 启用两个参数并指定 `<trusted-namespace>`。

**三条硬性顺序约束**：

1. **先 Audit 后 Enforce**（[§3.5](#s3-5)）：每条 Enforce 上线之前，先用 Audit 跑同一条规则，去 PolicyReport 里看有没有既有运行会被拦住。
2. **白名单类与参数类策略必须成对安装；单独一类都是形同虚设**：除 `pipeline-template-allowlist` 之外的大多数判据都会把身份（模板命名空间 / Pipeline / Task 名称）固定进 preconditions，而在 Kyverno 里**身份不匹配不是拒绝，而是跳过（放行）**。所以只装参数类策略、不装白名单的话，想绕过的人根本不必去动门禁参数：提交一个自己写 `pipelineSpec` 的运行（或者引用一个未受治理的模板）—— 身份与任何参数策略都不匹配 → 全部跳过 → 一路通过，扫描步骤甚至不必存在。这两层各担一半：白名单把每一次运行都逼上受治理模板这条路，参数策略则在这条路上锁住门禁开关；只有白名单 → 模板绕不过去，但门禁参数可以被关掉；只有参数策略 → 给未受治理的模板留了一扇敞开的后门。
3. **让策略与模板版本保持同步 —— 并且要区分两种失配方向，它们的后果正好相反**：
   - 模板**改了版本号**，而策略仍然固定在旧的 `refVersion` 上：身份前置条件不再匹配，规则直接**跳过（放行）** —— 它**静默地停止生效**。唯一能抓住这一点的是约束 2：`pipeline-template-allowlist` 只允许已批准的版本，于是新版本会在白名单这一层被拦住，而不是靠参数策略自己发现。
   - 模板**在同一身份下，改动了这条策略所判定的那些参数** —— 这里有两种**方向相反**的后果，别把它们当成一回事：
     - **参数被改名或删除**（旧字段整个消失）：方向**取决于那条判据如何对待"缺失"**，而且同一节内两种都有，必须逐个字段核对 ——
       - 判据把"缺失"当作"继承 Task 的可信默认值"（门禁**开关**那一类，靠那对 `<switch>Present` 变量识别：[§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)，以及 [§4.2.5](#s4-2-5) 的开关部分）→ 旧判据既不报错也不拒绝，而是**静默地失败开放**：策略照样 `Ready`，报告照样干净，只是那个被改名的开关再也没人看着了。**这是最难发现的一类** —— 只有 [§3.8](#s3-8) 的升级回归集能主动抓到它。
       - 判据要求"必须存在且非空"（[§4.2.5](#s4-2-5) 中的 `sonarURL`、`images` 之类，以及 [§4.5.1](#s4-5-1) 的 `noVisibleSource` 兜底）→ 字段一消失就命中拒绝条件 —— **失败关闭**，升级之后立刻当面炸给你看。
     - **参数还在，但形态变了**（改了类型，或者取值语义变了，使得旧判据读到的值不再满足其形态）：大多数情况下判据会开始**拒绝所有合规请求**（失败关闭）—— 症状是升级之后每条流水线都卡在准入，而拒绝消息来自你自己的策略。**但这不是必然的** —— 在本文对"参数以 array / object 形式传入"做过归一化加固的地方（[§4.2.4](#s4-2-4) 探针 34），形态变化会变成跳过而不是拒绝，于是又落回失败开放；该节的 `sonarProperties` 一侧是例外 —— 它的规范形态门禁会直接拒绝类型回退（探针 26-27）。

     **仅仅新增与本策略无关的参数，两种后果都不会触发** —— 判据足够窄，在这里反而是优势。**判断方法只有一个**：打开判据，看"读不到字段 / 读到奇怪的值"会落到哪里 —— 是落到拒绝，还是落到 precondition 跳过。升级顺序与排障见 [§4.2.5](#s4-2-5) 的升级顺序警告。
#### 4.0.2 本章策略速查（按名字找到对应小节） {#s4-0-2}

被拦住的时候，报错信息会给出**策略名**；下面这张表把名字映射回它来自哪一节、治理什么、以什么模式安装。`min` 列标 ✅ 的行，就是上面的最小可用集。**计数约定**：表中共有 **8 个 ✅**，但它们是**分布在 5 个安装阶段（1–5；阶段 0 什么都不装）中的候选** —— 第 3 阶段是二选一，所以**一次安装通常是 7 条策略**；只有当官方模板与自建模板**并存**、两者都需要时，才会变成 8 条。（第 4 阶段的三条 Audit 策略是一次装齐的。）

表中一行对应一个策略名。`pod-image-registry-allowlist` 提供两份可互换的 YAML，所以**紧接其下的那一行**描述的是同名策略的另一种形态 —— 不是另一条策略。

**先说一件对每条策略都成立的事**：本章每条策略的作用域都限定在演示命名空间 `policy-poc`（[§4](#s4) 引言已经说明这是演示选择；另有两条门禁策略的 `namespaces` 列表里还带着演示豁免命名空间 `policy-exempt-runs` —— 见 [§4.0.7](#s4-0-7) 第 1 步的警告）。所以**无论某一行标的是 ✅ 还是 🔧，把它复制到生产之前都必须改作用域** —— 改成你实际治理的命名空间，或者按 [§5](#s5) 改成命名空间级的 `Policy`。下面那一列回答的是另一个问题：**除了作用域与占位符，策略内部的身份判据是否也需要修改？**

21 条之中，**有 11 条需要的不只是替换占位符**：其中 10 条把身份固定在演示夹具上（`gated-build` / `policy-demo-scanner` / `policy-demo-trivy-summary` / `tekton-templates` / 演示任务别名 `scan` 等）—— 照抄进你的环境**不会报错，但也不会如你预期那样工作**，而且两种失效方向正好相反：

- **白名单 / 契约类**（例如 `pipeline-template-allowlist`）：批准名单里写的仍然是演示模板 → 你的真实流水线**全部被拒**（失败关闭 —— 动静很大，不是静默的）；
- **Audit / 取消类**（例如 `scan-verdict-audit`、[§4.6](#s4-6) 的那两条）：身份不匹配 → **跳过，什么都不发生**（静默失效；PolicyReport 里一条记录都没有）。

`pipeline-entry-lockdown` 属于第三种情况：它没有固定任何演示对象，但**必须枚举你环境中所有合法的自动化创建者身份** —— 漏掉一个，就等于把那套自动化的流水线全拒了。

所以标 🔧 的行需要改写身份或补齐身份名单；标 ✅ 的行只需按 [§4.0.3](#s4-0-3) 替换占位符（作用域仍然要改 —— 见上一段）。**这两件事，加上安装之后的验收检查，共同构成 [§4.0.7](#s4-0-7) 的五步转换 —— 把本章任何一条策略复制到生产之前，请先走一遍那一节。**

| 策略名 | 小节 | 治理什么 | 模式 | min | 能否照抄？ |
|---|---|---|---|---|---|
| `pipeline-template-allowlist` | [§4.1.1](#s4-1-1) | PipelineRun 只能引用受治理的流水线定义（三个通道） | Enforce | ✅ | 🔧 演示身份：`tekton-templates` + 已批准模板名单 |
| `pipeline-resolved-definition-audit` | [§4.1.4](#s4-1-4) | 对白名单已经放行的模板，**其解析出来的内容是否被做过手脚**（例如门禁任务被换成来自另一来源的同名任务） | Audit | | 🔧 演示身份：模板命名空间 / 模板名 / Task 名 |
| `pipeline-gate-must-execute-audit` | [§4.1.5](#s4-1-5) | 门禁 Task 是否被 `when` 跳过（`skippedTasks`） | Audit | | 🔧 演示身份：父 Pipeline 与门禁任务名 |
| `gate-param-contract` | [§4.2.1](#s4-2-1) | 门禁 Task 的实际参数（TaskRun 层）；作为**演示画像**提供 —— 用于自建模板时请改写身份 | Enforce | ✅ | 🔧 演示身份：`gated-build` + `policy-demo-scanner` |
| `gate-param-cancel-existing` | [§4.2.2](#s4-2-2) | 参数不合规时取消父运行，而不是拒绝创建（于是 finally 会执行） | mutate-existing | | 🔧 演示身份：两个演示模板 + 演示 Task |
| `gate-param-mutate-to-cancel` | [§4.2.3](#s4-2-3) | 参数不合规时同步取消门禁 TaskRun 自身 | mutate | | 🔧 演示身份：`policy-demo-scanner` |
| `sonar-branch-analysis-branch-contract` | [§4.2.4](#s4-2-4) | 分析受保护分支（`main` / `release-*`，包括分支参数缺失的默认分支形态）时，不得显式关闭门禁或更改扫描来源，且输入必须是规范形态（契约之外的一律拒绝）；PR / 特性分支构建放行（真实 sonarqube-scanner 画像；3 条 Enforce 规则 + 1 条可选 Audit） | Enforce + Audit | | ✅ 只需替换占位符 |
| `trivy-gate-must-stay-on` | [§4.2.5](#s4-2-5) 最小版本 | 官方 0.3 模板的漏洞门禁不能被显式关掉：四条参数绕过（`skipTrivyScan`、`trivyExitCode` 置空 / `"0"`、severity 收窄、`trivyExtraArgs` 非空）+ 两条 `podTemplate.env` 注入路径（按任务的 `taskRunSpecs`、按运行的 `taskRunTemplate`），PipelineRun 层；**拦不住任意的 `when` / matrix 跳过**，也**不限制 `images` 的元素个数**（模板会构建并推送每一个元素，却只扫描 `images[0]`，所以多镜像时其余的不会被扫 —— 该判据在完整画像里） | Enforce | ✅ | ✅ 只需替换占位符 |
| `official-template-gates-on` | [§4.2.5](#s4-2-5) 完整画像 | 上一行的内容 + 配置入口与构建输入的白名单（按分组取用） | Enforce | | ✅ 只需替换占位符 |
| `pipeline-run-defaults` | [§4.2.6](#s4-2-6) | 注入默认值（超时、标签） | mutate | | ✅ 只需替换占位符 |
| `scan-verdict-audit` | [§4.4.1](#s4-4-1) sonar 形态 | 把不达标的扫描结论记入 PolicyReport | Audit | ✅ | 🔧 演示身份：`policy-demo-scanner` |
| `vuln-summary-audit` | [§4.4.1](#s4-4-1) trivy 形态 | 把不达标的漏洞聚合与总体状态记入 PolicyReport | Audit | ✅ | ✅ 只需替换占位符 |
| `vuln-threshold-audit` | [§4.4.2](#s4-4-2) | 当**字符串形态** result 里的漏洞数超过阈值时记一笔（演示拆分范式 —— 属于兼容手段，不是推荐形态） | Audit | | 🔧 演示身份：不带 resolver 的 `taskRef.name` = `policy-demo-trivy-summary` |
| `inventory-ungated-runs` | [§4.4.4](#s4-4-4) | 清点：哪些 PipelineRun 缺少平台标记（**并不能证明门禁跑过**，[§4.4.4](#s4-4-4)） | Audit（background） | ✅ | ✅ 只需替换占位符 |
| `artifact-source-allowlist` | [§4.5.1](#s4-5-1) | 制品搬运来源白名单（真实 skopeo-copy 画像） | Enforce | | ✅ 只需替换占位符 |
| `promotion-source-image-labels` | [§4.5.2](#s4-5-2) | 读取源镜像的 config 并校验其属性 | Enforce | | ✅ 只需替换占位符 |
| `pod-image-registry-allowlist` | [§4.5.3](#s4-5-3) | 对 Tekton Pod 实际运行的镜像做**前缀**白名单，覆盖全部三类容器 —— step / init / ephemeral（Pod 级硬拦截）；**拦不住已批准前缀内部的镜像替换，也拦不住可变 tag 的内容替换** | Enforce | ✅ | ✅ 只需替换占位符 |
| （上一行同名策略的另一种形态 —— **不是另一条策略**） | [§4.5.3](#s4-5-3) | `pod-image-registry-allowlist` 提供**两份可互换的完整 YAML**：正则写进策略正文，或者把正则集中放在 `pipeline-image-allowlist` **ConfigMap** 里（该节称之为"形态 A"；便于跨环境移植）。另外还有两个**放宽的正则变体**（形态 B / C —— 只是正则片段加强度对比，不是独立策略） | Enforce | | 同上一行 |
| `pipeline-entry-lockdown` | [§4.5.4](#s4-5-4) | 封堵裸 `TaskRun` / `CustomRun` 入口（契约 7） | Enforce | ✅ | 🔧 除了替换 `<platform-admin-identity>`，还必须**补齐你环境中合法的自动化创建者名单**（触发器 / GitOps 控制器等，见 [§4.5.4](#s4-5-4) 末尾）—— 漏掉一个就等于拒绝它的全部流水线 |
| `release-target-allowlist` | [§4.5.5](#s4-5-5) | hub 来源身份（**无论是否启用部署都会校验**）+ 启用部署时：目标命名空间、kubeconfig 来源、shell 安全的参数与容器名（`workloadContainers`），以及执行面的覆盖（对 deploy 任务的任何 `taskRunSpecs` override 与任何运行级 `podTemplate.env` 一律拒绝；运行级 `serviceAccountName` 按批准名单）。**以上全都约束的是"请求里写了什么"**：清单自身的 `metadata.namespace`、集群级资源、kubeconfig Secret 的**内容**，以及"该更新哪个容器"这类业务语义，都在其外 —— 见 [§4.5.5](#s4-5-5) 的边界说明。其身份**同时**覆盖 java **与** python 0.3 两个模板 | Enforce | | ✅ 只需替换占位符（**五处**；SA 与命名空间那两项是"有多少列多少"的名单，而且 SA 名单必须包含 Tekton 默认填入的那一个） |
| `cancel-on-failed-verdict` | [§4.6.1](#s4-6-1) | 结果不达标时取消运行中的流水线 | mutate-existing | | 🔧 演示身份：模板命名空间 |
| `cancel-run-without-gate` | [§4.6.2](#s4-6-2) | 定义漂移时自我取消 | mutate-existing | | 🔧 演示身份：演示模板名与门禁任务名 |

[§5](#s5) 还有三条与作用域 / 豁免相关的策略：`pipeline-baseline` 与 `project-alpha-tightening`（[§5.2](#s5-2) 两层治理），以及 `exempt-namespace-approver-only`（[§5.3](#s5-3) PolicyException 的 RBAC 封闭）。

#### 4.0.3 占位符对照表（复制策略之前，逐个替换） {#s4-0-3}

本章的策略素材中含有一类**环境配置取值**：它们决定策略实际匹配什么，而漏替或替错**不会报错** —— 策略会朝两个相反的方向之一失效：

- **失败开放（多数情况）**：策略装上了、看起来没问题，却什么都拦不住（例如白名单前缀写的是别人家的镜像仓库）；
- **失败关闭**：所有**合规**请求都被拒绝（例如批准的 Sonar URL 或部署目标命名空间还留着示例值，而真实参数永远不会等于它）。

标 ⚠️ 的行，是那些**失效方向反常、或者后果最重**的；具体方向以各行自己的说明为准：多数 ⚠️ 行是失败关闭，但 `catalog` 字面量那一行按策略类型**两个方向都有**，而 Tekton 控制器身份那一行是**纯失败开放**（跳过 —— 静默放行）。不要把 ⚠️ 理解成"⚠️ = 误拒，至少能被发现"。

下表穷举了这一类取值，每一项都给出获取方法与自查方法。**注意有三行不是尖括号形式**（hub 的 catalog 名 `catalog`、Tekton 控制器身份，以及那一批 `approved-*` 对象名）：它们以裸字面量的形式写在策略里，所以搜尖括号是找不到的 —— 但它们照样必须核对与替换（`catalog` 那一行还有 11 处参数键的出现**不能**替换；见该行说明）。

⚠️ **有两个占位符，你搜的时候可能哪儿都找不到 —— 但那不代表它们不用填**：`<approved-registry-regex>` 与 `<tekton-infra-image-regex>` 只出现在 [§4.5.3](#s4-5-3) 的**正文内联形态**中；如果你选的是该节的 **ConfigMap 形态**，策略里就只剩 `<tekton-managed-by-label-value>` 一个占位符，而那两个正则改为写进 `pipeline-image-allowlist` ConfigMap 的 `data.approvedRegistryRegex` 与 `data.tektonInfraRepoRegex` —— **取值仍然必须按下面两行的方法生成并自查**；只是落点从策略挪到了 ConfigMap（[§4.0.1](#s4-0-1) 第 5 阶段的"三个取值"在两种形态下都成立）。**把"策略里搜不到"当成"没什么要填的" = 一份空的或过宽的白名单，而且它不会报错。**

⚠️ **替换这个动作是"在整份策略文本里搜索该占位符并替换每一处出现"，而不是"把眼前这一处改掉"**。本文的策略素材刻意把每个占位符收敛到**单一位置**（[§4.5.3](#s4-5-3) 把正则提取成一个 `variable`，供判据与消息共同引用，正是为此）—— 但你自己扩展判据时很容易复制出第二处，而**两处不一致不会报错**；它只会让判定与消息各说各话（[§4.5.3](#s4-5-3) 记录了两个方向）。替换完之后再搜一次 `<`，确认没有漏网的 —— **策略 YAML 注释里的示例尖括号除外**（例如 [§4.5.5](#s4-5-5) 策略注释中的 `<kind>` / `<name>`：它们位于注释中，不参与求值，留着无害）。

**命令行里漏替占位符，症状与 YAML 里漏替完全不同**：本文的命令里同样带 `<...>`（例如 `--as=<probe-identity>`、`-n <your-pipeline-namespace>`），而 shell 会把 `<` 和 `>` 当成重定向运算符 —— 占位符没替换时命令**根本不会执行**，只报一句 `No such file or directory`（`kubectl -n <your-ns> get pods` 会报 `your-ns: No such file or directory`）。看到这一行时别去查集群 —— 它是在告诉你占位符还留着。**唯一的例外**：当占位符的名字恰好与当前目录下的某个文件同名时，重定向会成功，命令会**静默执行**，输出被写进那个文件 —— 所以跟着本文敲命令时，工作目录里不要放与占位符同名的文件。

对于 **Enforce 的 validate 策略**，装完之后的自查永远是两步：先用一个真正合规的请求跑 `--dry-run=server`，确认它被**放行**（抓失败关闭），再故意破坏其中一个字段，确认它被**拒绝**（抓失败开放）。只做第二步，永远发现不了漏替。

:::warning 两步自查对一类策略不适用：带身份前置条件的那些

上面两步对 **PipelineRun 层**的策略可以直接用。但凡是把 `request.userInfo` 或"由控制器创建"作为前置条件的策略 —— [§4.2.1](#s4-2-1) 的 `gate-param-contract`（要求创建者是 Tekton 控制器 SA + 对父运行做 owner 查询）、[§4.5.4](#s4-5-4) 的 `pipeline-entry-lockdown`、[§5.3](#s5-3) 的 PolicyException RBAC 封闭 —— **你手工提交的对象命中不了它们的前置条件**：你的身份既不是控制器也不是批准身份，于是规则**跳过、请求被放行**。看起来像是"第一步通过了"，实际上**什么都没验证到**（这是最经典的假通过）。

两种正确做法，任选其一：

1. **带身份提交**：`kubectl create --dry-run=server --as=<that-identity> -f <object>.yaml`。同一个 TaskRun、同一条策略：以你自己的身份提交 → **放行**（规则没触发）；以 `--as=system:serviceaccount:tekton-pipelines:tekton-pipelines-controller` 提交 → **被拒，且消息里打印出 `creator=…tekton-pipelines-controller`**。这需要 impersonate 权限（`kubectl auth can-i impersonate serviceaccounts`），而且对 [§4.2.1](#s4-2-1) 这类策略，**父运行必须真实存在** —— 策略会用 `context.apiCall` 沿 ownerReference 去查它并核对 UID。
2. **跑一条真实流水线做端到端**：看子 TaskRun 是否在准入时被拒、父运行是否进入 `CreateRunFailed`、finally 是否执行（[§4.2.1](#s4-2-1) 的"治理不了什么"部分解释了三者的关系）。

同理，`<platform-admin-identity>` / `<approver-identity>` 这两个占位符的自查必须用 `--as` —— 否则你只验证了"普通身份被拒"，并没有验证"批准身份能通过"。

:::
另有两类策略不做"确认被拒"这一步，它们的自查对象不同：**Audit 策略**（包括读取 `*/status` 的那些）应当确认请求照常**放行**，然后去 PolicyReport 里查那条被记录的违规；**mutate / mutate-existing 策略**则应当检查被打了补丁的对象，或者被触发的响应动作（例如运行是否真的进入了 `Cancelled`）。

| 占位符 | 它是什么 | 如何取值 | 如何自查 |
|---|---|---|---|
| `<registry>` | 夹具拉取 busybox 所用的镜像仓库前缀 | 用 [§3.3](#s3-3) 的两条命令读出平台自身正在拉取的前缀作为候选（控制器镜像 / 该命名空间中所有镜像前缀，去重），然后确认该前缀在 `policy-poc` 里也拉得到、且带有 `busybox`；生产环境应固定 digest（[§3.3](#s3-3)） | 夹具 Pod 正常启动。起不来时，先在 `describe pod` 里查 `ImagePullBackOff` —— 那是前缀或拉取凭据的问题，不是策略问题 |
| `<approved-git-repo>` | 流水线定义所在的、已批准的 git 仓库 URL | 取 git resolver 实际使用的 `url` 参数的**逐字字符串**（含协议与 `.git` 后缀的差异）；用 `==` 精确比较，不做前缀匹配 | 对一个真实 PipelineRun 做 dry-run 并确认放行；把 URL 改动一个字符应当被拒 |
| `<approved-registry>` | 已批准的制品仓库前缀（[§4.5.1](#s4-5-1)） | 仓库主机（可带端口）+ 项目路径前缀。这一项是 `starts_with` 的**字符串**比较，**不是正则** —— 不要填正则片段 | 已批准前缀下的 `srcImage` 放行；换成 `docker.io/...` 被拒 |
| `<approved-registry-regex>` | 已批准的业务镜像仓库前缀，以**正则片段**形式（[§4.5.3](#s4-5-3)） | 取 `<approved-registry>` 的主机部分，按 [§4.5.3](#s4-5-3) 的规则逐字符转义 RE2 元字符（`.` → `[.]` 等） | 跑 [§4.5.3](#s4-5-3) 的 9 个自查探针；其中"邻近主机 / 邻近端口 / 未转义的 `.`"这三个必须被**拒绝** |
| `<tekton-infra-image-regex>` | Tekton 五类基础设施镜像的**完整仓库**正则片段（[§4.5.3](#s4-5-3)） | [§4.5.3](#s4-5-3) 的命令 A（控制器启动参数）给出**完整候选清单**；命令 A2 把其中的地址前缀替换成**平台私有镜像仓库地址**（从 `kube-public` 的 `global-info` ConfigMap 里读 `registryAddress`）—— 准入看到的是平台镜像改写**之后**的地址，改写前的形式不属于白名单；命令 B（采样真实 Pod）**只用于交叉验证**，绝不能作为名单来源（采样只能看到恰好跑过的那几类，而且可能返回空）。把 tag / digest 剥掉，只留仓库，再逐字符转义。**即便是命令 A 也只是起点，而不是"名单完整"的证明**：启动参数并不包含每一个辅助镜像（GC / results / affinity assistant / 未来版本）。所以除命令 B 之外，还要用**已安装状态清点** —— operator 的 `TektonConfig` / `TektonPipeline` CR，加上 `tekton-pipelines` 命名空间中所有 Deployment 的 image 字段 —— 作为第二条交叉验证线：只要任一条线冒出命令 A 输出之外的仓库，先判定它是不是新的一类；确认之后加进名单，并让它走同样的 A2 前缀替换（生成来源始终是经 A2 替换之后的 A 名单，与 [§4.5.3](#s4-5-3) 正文的措辞一致） | 五类镜像全部放行；同主机的 `…-evil` 被拒。**而且必须先用 Audit 跑满一个周期**（含一次升级与一次 GC），确认 PolicyReport 中没有基础设施镜像的违规，再切 Enforce —— 漏掉一类就会让整个 Tekton 起不来 |
| `<project-path>` | 放宽形态 B 中固定的项目路径段（[§4.5.3](#s4-5-3)） | 从上面那份仓库清单中，截取主机与镜像名之间的那一段 | 逐行重验形态 B 的对照表；注意该形态**不锁主机**，强度弱于形态 A |
| `<tekton-managed-by-label-value>` | 用来把范围限定在 Tekton Pod 上的标签取值 | 从 `tekton-pipelines/config-defaults` 读 `default-managed-by-label-value`；只有**键缺失**时才回落到默认值 `tekton-pipelines` —— 键存在但取值为空是部署层面的阻塞项，必须先改成非空值 | 用该标签选一次真实的 Tekton Pod；能选出来才算对 |
| `<platform-admin-identity>` | 允许绕过入口封堵的平台管理员身份（[§4.5.4](#s4-5-4)） | 写成完整的 `system:serviceaccount:<ns>:<sa>` 字符串或用户名，取自你的平台运维账号，**逐个枚举 —— 不要用通配**。**还必须枚举环境中所有合法的自动化创建者**，而"完整"需要方法而不是记忆：① **RBAC 反查** —— 遍历 `RoleBinding` / `ClusterRoleBinding`，找出那些绑定到含有 `taskruns` / `pipelineruns` 的 `create` 权限的角色上的 subject（在 `kubectl get clusterrole,role -A -o json` 中过滤 `rules[].resources`，再回查绑定）；② **触发器与 GitOps 侧** —— EventListener / TriggerTemplate 使用的 SA、ArgoCD / Flux 的控制器 SA、平台自身调度组件的 SA；③ **先用 Audit 装一轮**，从 PolicyReport 与 API server 审计日志里收集真实创建者，补齐名单之后再切 Enforce。切 Enforce 之前三条都要做 | 以该身份用 `--dry-run=server --as=<identity>` 创建裸 TaskRun 应当放行；普通业务身份应当被拒（**`--as` 是必须的** —— 见上面身份类自查的说明） |
| `<approver-identity>` | 有权签发豁免的批准者身份（[§5.3](#s5-3)） | 取你豁免审批流程的实际负责人 / 服务账号，同样写成完整身份字符串 | 该身份能在可信命名空间里创建 PolicyException；其他身份被 RBAC 拒绝 |
| `<business-identity>` | 一个普通业务身份，用于验证"没有豁免签发权"这一侧（[§5.3](#s5-3)） | 取一个真实的业务 ServiceAccount，完整身份字符串 | 对该身份执行 `kubectl auth can-i create policyexceptions` 应当返回 `no`；在 `policy-exempt-runs` 中创建运行应当在准入时被拒 |
| `<catalog>` | hub 引用的 catalog 名（**路标行**：**尖括号形式只出现在 [§3.4](#s3-4) 的探针骨架与报错样例中** —— 在策略素材里它是裸字面量，见下一行；这一行留在表中，是因为你多半会去搜 `<catalog>`） | 取自你实际引用的 hub 条目：真实运行的 `taskRef.params` / `pipelineRef.params` 中 `catalog` 参数的取值 | 与真实运行的 `catalog` 参数取值逐字一致 |
| `catalog` 字面量（出现在这些策略的可安装 YAML 中：`pipeline-template-allowlist` / `sonar-branch-analysis-branch-contract` / `trivy-gate-must-stay-on` / `official-template-gates-on` / `vuln-summary-audit` / `artifact-source-allowlist` / `release-target-allowlist`。**替换范围 = 可安装 YAML 的有效行**，不含注释；"关键判据"摘录以及探针 / 夹具中的同名字面量，在你复制那些块时同样要替换） | 固定在各策略身份判据里的 hub catalog 名 —— **不是尖括号形式；搜 `<` 找不到它**。**而且这一行是引言中"全文搜索、逐处替换"纪律的唯一例外**：写成 `[?name=='catalog']` 的那些出现，是 hub resolver 的**参数键**（由 Tekton API 固定，与你的 catalog 叫什么无关），**绝不能**替换 —— 一旦替换，`refCatalog` 永远求值为空字符串：白名单类会拒绝掉所有合规请求，身份前置条件类则全部跳过 | 取值方法同上一行。ACP 内置 hub 的官方 catalog 通常就叫 `catalog`，所以在内置 hub + 官方模板的组合下通常无需改动 —— **但安装之前请逐字核对一次** | ⚠️ 固定错了，两个方向都是静默的：对**身份前置条件类**（Audit / 门禁类，catalog 是身份链中的一环）规则会跳过 —— **静默放行**，PolicyReport 里一条记录都没有；对**白名单类**（[§4.1.1](#s4-1-1) 的 hub 通道、[§4.5.1](#s4-5-1)）则是**所有合规请求都被拒**。自查方法是用一次真实运行走本节开头的两步 dry-run（放行 + 故意破坏后被拒） |
| Tekton 控制器身份字面量（出现在这些策略中：[§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2) 的 `match.subjects`（`namespace: tekton-pipelines` + `name: tekton-pipelines-controller`）、[§4.5.4](#s4-5-4) 中的全串比较 `creator=='system:serviceaccount:tekton-pipelines:tekton-pipelines-controller'`，以及 [§5.3](#s5-3) 的可信身份名单 —— 后者还额外带有 `tekton-chains-controller`） | 每一处"由 Tekton 控制器创建"前置条件背后的身份固定值 —— **同样不是尖括号形式**。在 Tekton 位于非默认命名空间（[§4.1.2](#s4-1-2) 提到的 `TektonConfig.spec.targetNamespace`）或者 SA 名称不同的环境中，这些身份**全部匹配不上** | 去读真实值，不要手工拼：用 [§5.3](#s5-3)"身份验证"段落里那两条 `kubectl get deploy … -o jsonpath` 命令打印出确切的身份字符串（控制器是必读项；Results watcher 只有启用时才需要）；`TEKTON_NS` 的取法见 [§3.1](#s3-1) | ⚠️ 固定错了 = 身份前置条件永远不成立 → 规则**跳过、静默放行**：门禁 / 取消类策略形同未装，PolicyReport 里不会有任何记录。自查必须包含一次带 `--as=<that-identity>` 的拒绝探针（见上面"身份前置条件类"的警告）—— 对这些规则而言，普通身份下的探针永远是假通过 |
| `<approved-sonar-url>` | 已批准的 Sonar 服务器 URL（[§4.2.5](#s4-2-5)） | 取你环境中真实的 `sonarURL` 参数取值，作为**逐字字符串**（含协议、端口与结尾斜杠的差异），用 `!=` 精确比较 | ⚠️ **这一行漏替的表现与上面几行相反**：不是"什么都拦不住"，而是**所有合规请求都被拒** —— `sonarURL` 永远不会等于示例值。安装之后，先用一个真正合规的 PipelineRun 跑 `--dry-run=server` 确认放行 |
| `<approved-maven-mirror-url>` | 已批准的 Maven 镜像仓库 URL（[§4.2.5](#s4-2-5)，仅 java 模板） | 取你环境中真实的 `mavenMirrorURL` 参数取值，逐字字符串 | ⚠️ 方向同上，但**只作用于显式传了非空值的请求**：判据是 `mavenMirrorURLPresent && mavenMirrorURL != '' && != placeholder`，所以不传 / 传空串照样放行（模板默认值是 `""`）。**每一个显式配置了 mirror 的合规请求都会被拒** |
| `<approved-maven-cert-path>` | 已批准的 Maven 证书文件名（[§4.2.5](#s4-2-5)，仅 java 模板） | 取你环境中真实的 `mavenCertPath` 参数取值（示例是 `ca.cert`） | ⚠️ 同上，**只作用于显式传了该参数的请求**：判据是 `mavenCertPathPresent && != placeholder`；缺失时继承模板默认值 `ca.cert`，照样放行 |
| `<approved-deploy-namespace-a>` / `<approved-deploy-namespace-b>` | 允许部署进入的目标命名空间（[§4.5.5](#s4-5-5)） | 枚举你批准的每一个部署目标命名空间 —— 示例给了两个；实际有多少就在 `contains([...])` 里列多少 | ⚠️ 方向相同，**只作用于启用了部署的请求**（判据挂在 `deploymentEnabled` 之下；未启用部署的请求照样放行）：**每一个真正执行发布的合规请求都会被拒**。安装之后，用一个真实的部署 PipelineRun 跑 `--dry-run=server` 确认放行，再把命名空间改成名单外的取值确认被拒 |
| `<approved-deploy-kubeconfig-secret>` | 允许作为 `kubeconfig` workspace 来源的 Secret 名（[§4.5.5](#s4-5-5)） | 取你环境中真实的部署凭据 Secret 名。**该判据同样是单值 `!=`，只支持一个 Secret**；要批准多个，就把它改写成 `contains([...], kubeconfigSecret)` 的形式 —— 不要用通配 | ⚠️ 同上：**漏替 = 每一个显式绑定了 kubeconfig 的合规请求都被拒**（不绑定 kubeconfig = 部署到当前集群，本来就放行，不受影响） |
| `<tekton-default-service-account>` | Tekton 的默认填充逻辑写进运行级 `spec.taskRunTemplate.serviceAccountName` 的那个 SA 名（[§4.5.5](#s4-5-5) 批准名单的第一项 —— **这一项不是可选的**：默认填充 webhook 先于 Kyverno 执行，把它排除在名单之外，等于拒绝批准"普通请求"） | 不要从 `config-defaults` 去猜（键缺失与键存在但取值为空，含义并不相同 —— 见 [§4.5.5](#s4-5-5)"实际取值读出来是空"那一段）；而要读默认填充**之后的实际取值**（用 [§3.3](#s3-3) 的夹具运行；`--dry-run=server` 没有副作用；出厂状态会打印 `default`）：`kubectl create --dry-run=server -n policy-poc -f demo-run-pass.yaml -o jsonpath='{.spec.taskRunTemplate.serviceAccountName}{"\n"}'` —— 它读的正是策略比较的那个字段；它打印出什么，你就填什么。⚠️ **输出为空必须处理**：那说明键存在但取值为空，Tekton 跳过了填充 —— 此时 [§4.5.5](#s4-5-5) 的 `runWideSa != ''` 判据会整体跳过（一次失败开放）；机制与修法见该节"实际取值读出来是空"那一段 | ⚠️ **漏替 = 100% 的合规部署请求被拒**。自查就是那个放行探针：一次真实的发布运行必须被放行。**同时把那条取实际值的命令跑一次，确认输出非空** —— 输出为空 = 上一列所说的失败开放 |
| `<approved-deploy-service-account>` | 你自己批准的部署 ServiceAccount 名（[§4.5.5](#s4-5-5) 批准名单的其余项） | 枚举你的发布流水线实际使用的 SA —— 判据是 `contains([...], runWideSa)`；有多少列多少。它必须与你为部署凭据授予的 RBAC 一起维护：**新增一个部署 SA → 在同一次变更里把它加进这份名单**，否则那条流水线会被拒 | ⚠️ 方向相同，**只作用于启用了部署、且运行级 SA 不是上一行那个默认值的请求**；未启用部署的请求不受影响。自查：确认使用真实 SA 的发布运行被放行，再把 SA 改成名单外的名称确认被拒 |
| 那一批 `approved-*` **对象名**（[§4.2.5](#s4-2-5) 完整画像中共 12 个：`approved-sonar-credentials` / `approved-sonar-settings` / `approved-registry-config` / `approved-sonar-certificate` / `approved-trivy-config` / `approved-ca-bundle` / `approved-maven-settings` / `approved-maven-cert` / `approved-maven-server` / `approved-maven-local-repo` / `approved-maven-trust-store` / `approved-pip-conf`；[§4.5](#s4-5).x 各节用的是尖括号占位符，不属于这一批） | 以字面量形式直接写进策略的、已批准的 Secret / ConfigMap 名 —— **不是尖括号形式，但照样必须改** | 把它们替换成你环境中真正批准的对象。**"哪一个才是批准的那个"需要权威来源** —— 不要在命名空间里按名字猜：取平台配置仓库 / GitOps 清单中声明的那一份，或者给已批准对象统一打标签（例如 `policy.alauda.io/approved=true`）再用 `kubectl get cm,secret -n <ns> -l policy.alauda.io/approved=true` 列出，然后与配置负责人确认；名单变更（新增 / 轮换对象）必须与策略变更走同一套流程，否则策略会拒绝掉你刚刚轮换上去的那个对象。**注意判据是单值 `!=` 比较 —— 每个 workspace 只允许一个批准对象。** 要允许多个来源，必须把判据本身改成 `count > `1` \|\| (count == `1` && !contains(['approved-a','approved-b'], name))` —— 只在这里多列几个名字是不起作用的。（此处的 `count` 指的是**该 workspace 在本次请求中有几处绑定**，而不是批准对象的个数；Tekton 保证 workspace 名不重复，所以它通常是 0 或 1，`count > 1` 这一支是与其他判据保持同一形态的纵深防御。） | ⚠️ 方向相同，**只作用于显式绑定了该 workspace 的请求**：判据形态是 `count > 1 \|\| (count == 1 && name != approved-value)`，而**不绑定这个可选 workspace 的请求，按缺失语义照样放行**。自查方式相同：先确认一个真正绑定了这些对象的合规请求被放行，再换成未批准的对象确认被拒 |
| `<trusted-namespace>` | 可信命名空间 —— Kyverno 唯一接受 PolicyException 的那个（[§3.1.1](#s3-1-1) / [§5.3](#s5-3)） | 由你指定并写入 `--exceptionNamespace`；它应当是一个**只有豁免批准者可写**的专用命名空间 —— 不要复用业务或演示命名空间 | [§3.1](#s3-1) 清单第 5 项能回读到 `--exceptionNamespace=<该取值>`；在其他任何命名空间创建的 PolicyException 都应当不起作用 |

文档中其余的尖括号都不属于这一类，不要到上表里去找：

- **命令与报错样例中的对象名** —— `<policy>`、`<fixture>`、`<producer>`、`<gate>`、`<kind>`、`<name>`、`<seq>`、`<yyyymmdd>` 之类，其含义随所在示例而定（例如 [§4.4](#s4-4) 排障命令里的 `<policy>` 就是你正在查的那条策略，PolicyException 示例里的 `<yyyymmdd>-<seq>` 只是建议的命名约定）；[§3.1.1](#s3-1-1) 命令中的 `<path-to-global-kubeconfig>`（全局集群 kubeconfig 路径）与 `<cluster-name>`（跑 Kyverno 的目标集群）、[§3](#s3) 开头的 `<target-context>`（目标集群的 kubectl context 名）、排障命令里的 `<your-pipeline-namespace>` / `<one-real-run>` / `<terminal-taskrun>` / `<measurement-copy-name>`，以及 [§3.4.1](#s3-4-1) 探针配方里的 `<probe-identity>`（提交该探针所用的身份）都属于这一类；`<configured-hub-endpoint>`（集群配置的 hub 服务地址）也是 —— 它只出现在一条报错样例里，没有写进任何策略；要核对它就去读 `tekton-pipelines/hubresolver-config`，它应当与 [§3.1](#s3-1) 清单第 2 项读到的一致；
- **只出现在"放宽变体"里的占位符** —— 例如 [§3.6](#s3-6) 的 `<platform-default-env-name>`，或者 [§4.2.5](#s4-2-5) 中讲把 `serviceAccountName` 判据提取成批准名单那一段里的 `<approved-scanner-service-account>`：它们属于可选形态，只有当你环境中出现某个条件时才需要，不属于本文发布的策略素材，所以不在表里；如果你确实采用了那些形态，取值与自查方法就写在那些段落中；
- **正文里用尖括号表示"填你自己的值"** —— 例如上表身份格式说明中的 `system:serviceaccount:<ns>:<sa>` 与 `<该取值>`，或者 [§4.2.3](#s4-2-3) 里的 `spec.statusMessage: <reason>`。

这两类写错了，顶多是命令查不到东西，或者消息措辞有出入；它们不会让策略静默地停止生效 —— 所以上表没有逐项列出。

#### 4.0.4 演示资源如何清理（自建命名空间靠级联；集群级对象按 UID） {#s4-0-4}

本章每一节末尾都有一段"清理"。**前置纪律（[§3.3](#s3-3)）：所有命名空间级的演示对象，只在本次实操自己创建的命名空间里创建 —— 绝不对既有命名空间动手。** 于是清理就归结为两条规则：

1. **命名空间级对象不逐个删除**：`PipelineRun` / `TaskRun` 对象、夹具 `Task` / `Pipeline`、ConfigMap、RBAC 等等，都随其命名空间一并回收 —— 命名空间在各节的清理段落或 [§3.3](#s3-3) 的最终清理中，核对实操 id 标签之后删除，级联会带走其中的一切（控制器派生的子 TaskRun / Pod 也不需要单独删除；owner 级联会回收它们）。级联正是前置纪律必须成立的原因：**你删除的命名空间里不能有任何别人的东西** —— 所以创建循环只给新建的命名空间打上实操 id，清理循环也只删除标签等于本次 id 的那些；这个 id 必须每次实操唯一（[§3.3](#s3-3) 会生成它）—— 固定值分不清"这次创建的"与"上一次没做完留下的"。
2. **集群级对象（`ClusterPolicy`、[§4.6](#s4-6) 的 `ClusterRole`）不会被删除命名空间带走**；它们必须按**创建时记录的 UID** 逐个删除。`creationTimestamp` 只能供人判断 —— 它证明不了归属，更拦不住 `get` 与 `delete` 之间同名对象被掉包。本文用本地的 `cluster-scoped-ownership.tsv` 作为归属账本：创建成功之后立刻追加一行 `resource<TAB>name<TAB>uid`；清理时先重新读取实时 UID，逐字匹配才允许删除；读取失败、账本缺行、同名替换，一律安全跳过。**这份账本不是可有可无的证据**：旧终端的变量丢了没关系，但账本一旦丢失，不要去猜名字、也不要按时间戳倒推删除 —— 请用实时 UID 加上 API server 审计 / 变更记录手工归属之后再处理。
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
如果你确实必须在已有策略旁边跑演示，就给自己的副本起一个带前缀的独立名字（本文各节的探针脚本就是这么做的）；不要复用已发布的名称。

#### 4.0.5 通篇实操时的跨节干扰（"探针跑不起来"的头号原因） {#s4-0-5}

[§4.0.1](#s4-0-1) 的表给出的是**生产上线顺序**，而不是按节通读本文的顺序。**各节的演示彼此独立**：每一节各自安装自己的策略、跑自己的探针、然后清理。做演示时把好几节的 Enforce 策略堆在同一个集群上，你会遇到"本节策略还没被求值，请求就已经被另一条策略拒了" —— 你正在读的那条拒绝理由，与本节的结论毫无关系。

**机械判据**：Kyverno 的拒绝消息一定带有**策略名**。名字 ≠ 你正在验证的那条策略 = 你是被另一条策略拦住的；不要据此下任何结论（遗留的调试策略会成批地让整套探针假失败 —— 开跑之前先按 [§4.0.4](#s4-0-4) 清理干净）。

有两处确实会自锁（下表是本文自有策略素材之间的互锁结果，可用 `--dry-run=server` 复核）：

| 已安装的策略 | 被挡住的演示 | 结果 |
|---|---|---|
| [§4.1.1](#s4-1-1) `pipeline-template-allowlist`（Enforce） | [§4.2.2](#s4-2-2) 的 `gated-build-with-prep`、[§4.6.2](#s4-6-2) 的 `gated-build-rogue` | 两次演示运行都会被**白名单**拒绝（消息里写的是 `pipeline-template-allowlist`）—— 那两节自己的策略根本没被求值。[§3.3](#s3-3) 的三个 `gated-build` 变体（pass / gate-fail / gates-off）不受影响，照常通过 |
| [§4.5.4](#s4-5-4) `pipeline-entry-lockdown`（Enforce） | [§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4) / [§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2) / [§4.5.1](#s4-5-1) / [§4.5.2](#s4-5-2) 中**你手工提交的裸 TaskRun 探针** | 以普通身份提交时全部被它拒绝（消息里写的是 `pipeline-entry-lockdown`）；用 `--as` 以已批准的 `<platform-admin-identity>` 提交则通过 |

通篇实操时，二选一：

- **逐节隔离**（推荐）：跑某一节的探针之前，先 `kubectl get clusterpolicy` 确认集群上没有其他节的 Enforce 策略；
- **临时放宽**：把 `gated-build-with-prep` / `gated-build-rogue` 临时加进 [§4.1.1](#s4-1-1) 的批准名单（演示完还原），并且所有裸 TaskRun 探针都用 `--as=<platform-admin-identity>` 提交。

另外，[§4.1.1](#s4-1-1) 批准名单里的 `official-gated-build` 只是"你的第二个已批准模板"的示例名 —— **本文的夹具并不会创建它**；复制这份名单时，请按 [§4.0.2](#s4-0-2) 的说明换成你真实的模板名。

#### 4.0.6 拒绝消息的最低标准（被拦住的人能否自行修复） {#s4-0-6}
**"策略拦住了" ≠ "上线成功了"。** 被拒的流水线使用者手上只有一样东西 —— API 返回的那一句话；他们既看不到完整的 `ClusterPolicy`，也不该看到。这句话写得糟糕，每一次拦截都会变成一场找平台团队的对话。复制本文策略时，请让每一条都过一遍这三个问题：

| 要素 | 判据 | 由谁负责 |
|---|---|---|
| **① 是哪条策略拦的** | 拒绝消息必须显示策略 / 规则名 | **Kyverno 内置**：API 报错会带 `<policy>: <rule>: ...` 前缀；你不必在消息里重复 |
| **② 是哪个字段的取值不合规** | 消息必须点名**字段**，并尽可能回显**实际读到的取值**（缺失也必须能被识别为缺失） | **你写消息时负责** —— 这是最常被漏掉的一项 |
| **③ 合规长什么样 / 该找谁要名单** | 如果取值集合很小且不敏感（例如 `"true"`、`main` / `release-*`），就直接写进消息；**如果是批准名单（镜像仓库前缀、批准的命名空间 / Secret / 身份名），就不要写** —— 改成写"该名单由平台维护，请向 X 索取" | **你写消息时负责**，并按环境判断什么算敏感 |

要素 ② 与 ③ 并不冲突，因为它们说的是两件事：**回显的是"请求里的取值"**（提交者自己写的，他本来就知道），**不回显的是"批准集合"**（他不知道，也不该能从报错里推导出来）。所以"你的 `srcImage` 不在已批准来源之列"是对的，而"已批准来源是 A / B / C"是错的。**不要把两者合并成"实际取值也不要回显"** —— 那会退化成只说"不合规"的无用消息。

三点实务（本章策略中各有活例）：

- **`deny.conditions.any` 之下的多条判据共用一条消息**：使用者分不清自己踩中的是哪一条。要么把判据拆成各自独立的规则（一条一个消息），要么**在消息里回显几个关键字段的实际取值**（本文多数策略选的是后者 —— 例如 [§4.2.1](#s4-2-1) 会把两个门禁参数的实际取值都打出来）。检验标准是：**读完这条消息，你知不知道该改哪个字段？**
- **`foreach` 的消息里不能用 `element.*`**（Kyverno 在策略创建时就会拒绝）；要点名具体元素，必须用 `context` 变量重新算一遍 —— 写法与它的两个陷阱见 [§4.5.3](#s4-5-3) 的设计说明。
- **取消（mutate-existing / 准入 mutate）没有拒绝消息**：使用者只看到 `Cancelled`。**原因必须由你写进对象**（`cancel-reason` 注解或 `spec.statusMessage`）—— 否则对象上连"这是策略干的"这条线索都不会留下（[§6.2.3](#s6-2-3)）。

反方向还有一条边界：**不要把消息当成审计记录。** 它只存在于那一次 API 响应和 PipelineRun 的 condition 里；对象一旦被清理就没了（[§4.4.4](#s4-4-4)）。

#### 4.0.7 从演示素材到生产素材（复制之前的五步转换与验收） {#s4-0-7}

本章提供的是**演示素材**：所有作用域都固定在 `policy-poc`，而 21 条策略中有 11 条**光改作用域与占位符是不够的**（[§4.0.2](#s4-0-2)"能否照抄"列中标 🔧 的那些 —— 其中 10 条把身份判据固定在演示夹具上，剩下一条 `pipeline-entry-lockdown` 要求你补齐环境中合法的自动化创建者名单）。**照抄进生产不会报错，但也不会如你预期那样工作**，而且两类的失效方向相反：白名单 / 契约类会**拒绝掉你所有**真实流水线（动静大，一眼就能发现），而 Audit / 取消 / 带身份前置条件的那些会**静默跳过**（PolicyReport 里一条记录都没有 —— 看起来与"没有违规"一模一样）。下面五步是从演示素材到生产素材的完整过程；**第 4 步是唯一能揭出静默失效的一步，不能跳过**。

1. **换作用域**：把每条策略 `namespaces` 之下列出的 `policy-poc`，换成你实际治理的范围。这一步里同时发生三件事：
   - **在四种作用域形态中选一种**（[§5.1](#s5-1)）：逐个**枚举**命名空间、用 `namespaceSelector` 按 Namespace 标签选择、"平台级 `ClusterPolicy` + **否定式 `exclude`** 摘出系统命名空间"，或者干脆为项目自助**转换成命名空间级 `Policy`**（[§5.2](#s5-2) 的第二层）。想要"默认覆盖、新建命名空间自动纳入"，就必须用否定式 `exclude` 那一种 —— 枚举与标签选择都会天然漏掉之后创建的命名空间（[§3.6](#s3-6) 第一行）。
   - ⚠️ **有两条策略的 `namespaces` 里不止 `policy-poc`**：`gate-param-contract`（[§4.2.1](#s4-2-1)）与 `gate-param-mutate-to-cancel`（[§4.2.3](#s4-2-3)）还带着演示豁免命名空间 `policy-exempt-runs`（服务于 [§5.3](#s5-3) 的豁免演示）—— 只替换 `policy-poc` 会把那个演示豁免条目原样带进生产；转换时把它删掉，或者换成你按 [§5.3](#s5-3) 治理流程确立的生产豁免命名空间。
   - ⚠️ **演示命名空间被固定的地方不止 `match` —— 还有三处必须一起改**（`match` / `targets` / RBAC 是三项互不联动的独立设置 —— [§4.2.2](#s4-2-2) 警告 ① 解释了这一点；这里说的是它们在转换中的落点）：① [§4.2.2](#s4-2-2) 与 [§4.6.2](#s4-6-2) 中 `mutate.targets[].namespace: policy-poc` 这个**字面量**（[§4.6.1](#s4-6-1) 用的是 `{{ request.namespace }}` 变量，不用改）—— 换成你的目标命名空间字面量，或者按 [§4.6](#s4-6) 引言改成变量 + 聚合 ClusterRole；② 配套的命名空间级 `Role` / `RoleBinding` 的 `namespace`（[§4.2.2](#s4-2-2) 的 RBAC 详情块）随之改动；③ [§4.5.3](#s4-5-3) 的 ConfigMap 形态中，`context.configMap.namespace: policy-poc`、`pipeline-image-allowlist` ConfigMap 对象本身，以及其检查命令的 `-n` —— 漏掉这一处，演示命名空间一被清理，策略就会在整个生产范围内失败关闭（ConfigMap 缺失时的方向见 [§4.5.3](#s4-5-3)）。只改 `match` 的话，取消类策略会命中生产请求，却跑到演示命名空间里去找目标（或者对目标命名空间没有 update 权限）—— 预期中的取消就静默地不发生了。对目标集群跑一遍 [§3.1](#s3-1) 第 6 项的**两层检查** —— 只看声明是不够的：一条声明为 `Fail`、而 webhook 落在 `-ignore` 分组里的策略，正在被平台级开关强制覆盖；先解决覆盖再谈分级（机制见 [§3.1.2](#s3-1-2)）。确认每条策略的层级与本集群的可用性规划一致（[§3.7](#s3-7) 的分级；本文素材出厂时的分级是"拦截类，加上 [§4.2.2](#s4-2-2) 的门禁取消触发器，为 `Fail`；记账类与 `*/status` 取消触发器 —— 含 [§4.4.4](#s4-4-4) 的后台清点 —— 为 `Ignore`"）；本集群规划要求不同层级的策略，就在这一步改掉，并把接受的真空边界写进变更单。
2. **换身份判据**：对 [§4.0.2](#s4-0-2) 中标 🔧 的那 11 条策略，逐条把演示身份（`gated-build` / `policy-demo-scanner` / `tekton-templates` / 演示任务别名等）换成你真实的模板名、Task 名与命名空间；`pipeline-entry-lockdown` 属于另一类 —— 你必须**枚举环境中所有合法的自动化创建者**（清点方法见 [§4.0.3](#s4-0-3) 中该占位符那一行）。
3. **替换占位符**：按 [§4.0.3](#s4-0-3) 逐项处理。**不要只搜尖括号**：该节点名的三行（hub 的 catalog 名 `catalog`、Tekton 控制器身份、那一批 `approved-*` 对象名）在策略里是裸字面量 —— 搜 `<` 找不到；而反过来，`catalog` 那一行还有 11 处**参数键**的出现，绝不能替换。
4. **验收**（**必做**）：每条策略至少跑两格 —— 一个**真实的违规输入必须产出其类别所对应的失败 / 审计 / 取消结果**，一个**真实的合规输入必须不被误拒**。只有 Enforce 准入类才表现为"违规请求被拒、合规请求放行"；Audit 类与取消类的通过判据见下表，命令骨架见 [§3.4.1](#s3-4-1)。
5. **灰度上线**：按 [§3.5](#s3-5)，先用 `Audit` 观察，误报归零之后再切 `Enforce`；上线之后按 [§3.6](#s3-6) 盯变更触发条件，每次升级之后按 [§3.8](#s3-8) 跑最小回归集。

**第 4 步的判据（不要把"没报错"当成通过）**：

| 策略类别 | 什么算通过 | 假通过长什么样 |
|---|---|---|
| 白名单 / 参数契约类（Enforce） | 违规请求被拒，而且**拒绝消息里的策略名就是这条策略**；合规请求放行 | 被**另一条**策略拦住看起来同样是"被拒"（[§4.0.5](#s4-0-5)）—— 不核对策略名，你就会把它记成通过 |
| Audit 类 | 违规输入之后，PolicyReport 中**出现**该策略的 `fail` 条目；合规输入得到 `pass` / `skip`，且**不得**产生该策略的 `fail`（一条把所有输入都记成 `fail` 的策略，单看违规侧照样通过 —— 与 [§3.8](#s3-8) 第 5 / 6 步同样的健康侧对照） | 身份判据固定错了 → 规则跳过 → 报告干干净净，与"没有违规"无法区分 |
| 取消类（mutate-existing / 准入 mutate） | 目标对象上确实出现**取消类**的 `spec.status`（父运行是 `CancelledRunFinally`，门禁 TaskRun 是 `TaskRunCancelled`）以及配套的策略标记 —— **父运行上的 `cancel-reason` 注解；门禁 TaskRun 上的 `spec.statusMessage`（[§4.2.3](#s4-2-3)）**（[§6.2.3](#s6-2-3)）—— 判定看**取值**，而不是看"非空" | 请求照常放行是**正常的**（取消类不拒绝请求），所以"提交成功了"对策略是否生效什么都说明不了 |
| 带身份前置条件的规则（[§4.0.3](#s4-0-3) 点名的三条：`gate-param-contract` / `pipeline-entry-lockdown` / [§5.3](#s5-3) 的 RBAC 封闭） | 只有以**该身份**（`--as=<identity>`）提交才算数 | 用普通身份跑探针，规则根本不会被求值 —— 永远的假通过 |

**成本集中在第 2 步**；其余四步都是机械的。如果你的模板与本文画像吻合（官方 java / python 0.3、sonarqube-scanner、trivy-scanner、skopeo-copy），[§4.0.2](#s4-0-2) 中标 ✅ 的那 10 条策略可以跳过第 2 步 —— **第 4、5 步对每一条策略都无例外地适用**：不会因为"只改了占位符"就免去验收与灰度。

### 4.1 模板与定义约束（契约 1"身份" / 契约 7"入口封闭"的定义侧） {#s4-1}

**总契约**：业务命名空间中的 PipelineRun 只能引用受治理的流水线定义。"受治理"沿着 [§2.1](#s2-1) 的三个强度层级展开：

1. 集群内模板命名空间（cluster resolver → `tekton-templates`）：内容与变更权限都在集群内受控（变更权限由标准 RBAC 封堵，见 [§4.1.2](#s4-1-2)）—— 最强；
2. hub / git **不可变引用**（catalog 条目 + 显式版本 / commit SHA）：身份在集群内被锁定，内容信任来自 catalog 发布流程 / 仓库治理 —— 身份强，内容依赖外部治理；
3. hub / git **可变引用**（分支 / tag / 默认版本）：远端一移动，内容变更就自动生效 —— 不动集群配置就能跟随模板更新，这本身是常见且合法的用法；但 Kyverno 在这一层锁不住内容，任何强约束只能来自仓库侧的权限控制（受保护分支 / tag、收紧写权限）。仓库侧没有这层控制的，就拒绝它。

**有一条路本文没有走：在准入阶段对定义对象做结构校验。** `Pipeline` / `Task` 定义本身的 CREATE / UPDATE 同样会经过准入，理论上契约 3 / 5 / 6 的一部分可以在那里静态判定 —— 门禁任务是否带 `when`、发布类任务是否（传递地）`runAfter` 到门禁、`finally` 里是否出现了发布类任务。本文选择不发布这类策略，理由有三条，写在这里，供需要的人自行判断值不值得做：

- **它只对集群内定义有效**。通过 hub / git 引用的定义根本不进入本集群的准入，所以同样的判据在最常见的引用形态上落空 —— [§4.1.4](#s4-1-4) 的事后 Audit 之所以挂在 `status.pipelineSpec` 上，正是因为那里是**唯一**能同时看到三个通道解析结果的地方。
- **"传递依赖"在 JMESPath 里代价很高**。`runAfter` 只给出直接前驱；要判定"发布任务是否受门禁支配"，就得计算传递闭包。单层展开写得出来，但在多级依赖的模板上会得出错误结论 —— 这是**有判据比没判据更危险**的经典情形（漏判是静默放行；误判则会拒掉所有正常模板）。
- **判据必须按模板逐个配置**：哪个任务是门禁、哪些是发布类，属于模板语义而不是 API 字段 —— 与 [§4.2.1](#s4-2-1) 的身份契约一样，必须逐模板书写。

所以本文明确把契约 3 / 5 / 6 留在模板设计责任一侧：契约 3 在 [§4.1.5](#s4-1-5) 有一份读取 `skippedTasks` 的现成事后 Audit（[§2.3](#s2-3) 表中唯一一行 Guarantor 写作 `T + K 事后 Audit` 的），而契约 5 / 6 **没有现成的 Audit** —— 想自建的话，[§4.1.4](#s4-1-4) 那份已解析定义快照（包含 `runAfter` 与 `finally`）是运行时侧的抓手，而下面这条定义侧路线是另一个落点。**如果你的模板全是集群内定义、且数量可控**，那么在定义侧加一条 Enforce 策略，判定"门禁不得带 `when`；`finally` 中不得出现发布类任务"是值得的：这两条判据只读 `spec.tasks[].when` 与 `spec.finally[]`，不涉及传递闭包，代价落在上面第三条（逐模板配置门禁名与发布类任务名）。它拦的是**定义进入集群**这件事 —— 它与 [§4.1.5](#s4-1-5) 读取运行时 `status.skippedTasks` 是**互补关系，而非替代关系**：远程引用的模板仍然只能依靠后者。按 [§3.5](#s3-5) 灰度：先 Audit，再 Enforce。

#### 4.1.1 模板白名单（三通道，失败关闭） {#s4-1-1}

- **治理什么**：业务命名空间中的 PipelineRun **只能引用受治理的流水线定义** —— 未知模板在"引用形态"这一层就被拦下。
- **难在哪里**：合法引用有三条通道（cluster / hub / git），而在每条通道上，**只校验其中一部分字段就会留下绕过路径**：cluster 只按命名空间校验，会放行该命名空间里任何一个没有门禁的 Pipeline；hub 只按资源元组校验，可以通过请求级的 `url` 或切换 `type` 把后端换掉；git 只按 url + SHA 校验，会放行同一个 commit 里的任何其他文件。
- **策略怎么分层**：① 三条通道各算出一个布尔值（`clusterOK` / `hubOK` / `gitOK`），每个都锁定**完整的**规范身份 → ② 取三者的并集 → ③ **并集为假即拒绝** —— 内联 `pipelineSpec`、裸名引用、未固定版本，以及将来出现的任何引用形态，都默认落到拒绝侧。
- **治理不了什么**：它只知道"引用了谁" —— 看不到**被引用定义的内容**（CREATE 时定义尚未解析，[§2.1](#s2-1) 观测点 2）—— 内容漂移由 [§4.1.4](#s4-1-4) 的事后 Audit 兜底；通道 1 的强度还取决于对 `tekton-templates` 的写权限是否被 RBAC 封住（[§4.1.2](#s4-1-2)）；确实需要内联的情形，见 [§4.1.3](#s4-1-3) 的例外。

**关键判据** —— 三条通道各自锁定完整身份，并集为假即拒绝（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：
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

三条通道的字段选择不是随手挑的 —— 少一个字段就多一条绕过路径：

- **cluster** = `kind + namespace + name`。只校验命名空间，会放行该命名空间里任何一个没有门禁的 Pipeline。
- **hub** = `受治理的 type + 没有请求级 url + kind + catalog + name + 精确版本`。只校验资源元组，仍然漏掉了后端覆盖与 type 切换（见下面的警告）。
- **git** = `url + 40 位 SHA + 精确的 pathInRepo`，**而且这三项之外不允许出现任何参数**。只校验 url + SHA，会放行同一个 commit 里的任何其他文件；而 `configKey` / `serverURL` 会把 git resolver 的整套配置画像换掉（包括它使用哪个 api-token Secret），`token` / `tokenKey` 则直接指名凭据 —— 在引用已经固定的前提下，它们改变不了取到的内容，但它们出现在模板引用里没有任何正当理由。

另有两点结构上的设计：

- **失败关闭**：判据是"已批准通道的并集为假时拒绝"，所以新出现的引用形态（新 resolver、配错的字段、未知名称）默认落到拒绝侧；
- **可变引用默认拒绝**：版本默认 / 未批准的 hub 引用，以及 git 的分支 / tag，都属于 [§2.1](#s2-1) 三个层级中的第三级 —— 允许它们，等于把内容控制权交给任何能移动那个引用的人。如果某个团队刻意使用分支 / tag 以便模板更新自动生效，请先确认仓库侧有相应的权限控制（受保护分支 / tag、收紧写权限），再把该引用加进白名单 —— 那时内容约束由仓库承担，而这条策略只锁定"引用了哪个分支 / tag"。内联定义（`pipelineSpec`）没有 `pipelineRef`，所以三条通道全假，天然被拒（例外见 [§4.1.3](#s4-1-3)）。

**hub 通道省略 `type` 有一个平台前提**：本文允许调用方省略 `type`，前提是 `tekton-pipelines/hubresolver-config` 中的 `default-type` 为 `artifact`（[§3.1](#s3-1) 清单第 2 项）；当显式写出 `type` 时，只允许 `artifact`。请用 RBAC 限制对该 ConfigMap 的修改并监控漂移；无法保证该默认值的环境，应当让每一个引用都显式写上 `type: artifact`。

**这条通道的信任根，是集群配置的那个 hub 端点本身**：下面的警告解释了为什么必须拒绝请求级 `url` —— 但一旦拒绝了 `url`，"已批准坐标 ⇒ 受治理内容"这个结论就**完全依赖那一个配置端点**。换句话说，**一个能修改 `hubresolver-config` 的身份根本不需要绕过这条策略**：同样的已批准坐标照样通过白名单，而解析出来的却是那个身份自己 hub 上的定义 —— 可能压根没有门禁 —— 而 [§4.1.4](#s4-1-4) 的事后 Audit 只能在解析之后看到它，拦不住那一次运行。所以对这份平台配置的写权限，必须与 `ClusterPolicy` 同级别地管控（[§5.0](#s5-0)），端点变更必须留下审计痕迹；做不到这一点的环境，就不要把 hub 通道当作"内容可信"的通道 —— 只把它当作"来源已登记"。

:::warning 为什么必须拒绝请求级 url —— 一条容易被忽略的完整绕过

`catalog` + `name` + `version` + `kind` 这个元组只是**"某个 hub 上的坐标"，而不是内容**。hub resolver 接受调用方在 `params` 里额外传入的 `url`，而**它会覆盖集群配置的 hub 端点**。于是攻击者可以用**完全相同的坐标**，从**自己的 hub** 上取回**自己的 Task / Pipeline**：name、version、catalog 全都对得上，内容却是任意的。漏掉这一个条件，上面所有"锁定身份"的字段检查就全被架空了。

对比两个只差一个 `url` 参数的 TaskRun（两者都引用一个不存在的 task，所以都不会真的执行），看看 resolver 实际请求的是哪个地址：

```text
# Without url: the cluster-configured endpoint is used
requested resource 'http://<configured-hub-endpoint>/api/v1/packages/tekton-task/<catalog>/no-such-task-xyz' not found on hub

# With url: http://127.0.0.1:1/definitely-not-a-hub -- the caller-supplied address is used verbatim
requesting resource from Hub: Get "http://127.0.0.1:1/definitely-not-a-hub/api/v1/packages/tekton-task/<catalog>/no-such-task-xyz":
dial tcp 127.0.0.1:1: connect: connection refused
```

`type` 必须锁死，理由相同：切换到另一种 type，就是切换到另一组端点与另一组治理假设。**这条判据中 `type` 的那一半可以直接在上游源码中验证**：hub resolver 的 `Resolve` 会按 `type` 在 artifact / tekton 两组端点之间切换，而且两者的 URL 路径形态也不同。

**`url` 的那一半是上游既定行为，不是本环境的特例**：常量在 `pkg/resolution/resource/name.go` 中定义为 `ParamURL = "url"`，hub resolver 在 `pkg/remoteresolution/resolver/hub/` 中读取它 —— 注释原文写的是"a custom hub API endpoint to use **instead of the cluster-configured default**"，它覆盖的正是 `ARTIFACT_HUB_API` / `TEKTON_HUB_API`。**但它有版本下限**：这段处理只存在于新的 `remoteresolution` 包中 —— 在本机可查的版本里，v0.55.0 / v1.6.1 / v1.6.2 **没有**，v1.11.1 / v1.12.0 / v1.12.1 **有**（旧的 `pkg/resolution/resolver/hub/` 在任何版本里都没有 —— 只查那里会得出"上游不支持这个"的错误结论）。

**该行为是彻底的替换**：同一组 hub 参数再加一个 `url`，resolver 就转而去请求那个地址 —— 解析失败时报错里回显的也是它，而不是集群配置的 `artifact-hub-api`。

**所以这条判据必须保留**：它拦的是上游设计中真实存在的一条绕过通道。在低于上述版本下限的构建上，`url` 会被忽略 —— 但**引用里多出一个未知参数，本身就是该引用被做过手脚的证据**，拒绝它不花任何代价；而 `type` 的那一半在所有版本上都成立。

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
| cluster：kind + ns + 已批准名称 | 放行 |
| cluster：已批准的 ns，但名称**未批准** | 拒绝 |
| cluster resolver → 另一个 ns | 拒绝 |
| hub：catalog + **精确版本 0.3** | 放行 |
| hub：已批准元组 + 单独显式的 `type=artifact` | 放行 |
| hub：同名但 `version=9.9`（未批准） | 拒绝 |
| hub：已批准元组 + 请求级 `url` | 拒绝 |
| hub：已批准元组 + `type=tekton` | 拒绝 |
| git：已批准仓库 + SHA + **精确路径** | 放行 |
| git：已批准仓库 + SHA + **错误路径** | 拒绝 |
| git：已批准仓库 + `revision: main`（不是 SHA） | 拒绝 |
| git：已批准仓库 + SHA + 精确路径，**外加一个 `configKey`** | 拒绝 |
| git：已批准仓库 + SHA + 精确路径，**外加一个 `serverURL`** | 拒绝 |

:::

#### 4.1.2 治理定义资源（用 RBAC 封堵） {#s4-1-2}

通道 1 的强度来自"集群内内容受控"，而这以 `tekton-templates` 中的定义**只能由平台身份修改**为前提。这是**标准 Kubernetes RBAC 的活 —— 不需要单独的 Kyverno 策略**：只把 `tekton-templates` 命名空间中 `Pipeline` / `Task` 的 `create` / `update` / `patch` / `delete` 授予平台管理员的 Role / ClusterRole，普通项目身份不给写权限。RBAC 是"谁可以修改某个命名空间里的资源"的原生控制面；用 Kyverno 的 `userInfo` 白名单再做一遍同样的事，只会更弱更绕（而且拦不住 `system:masters`），所以本文不为此单列策略。

**平台级开关（禁用内联定义）**：Tekton 自身在 `feature-flags` ConfigMap 中提供了 `disable-inline-spec` 字段，可以**全集群**禁用内联定义；Tekton 自己的 validating webhook 会在准入阶段以 `must not set the field(s): ...` 拒绝。它是全集群一刀切的大锤；需要按命名空间差异化时，请用 [§4.1.1](#s4-1-1) 的 Kyverno 白名单。

其取值是 `pipeline` / `pipelinerun` / `taskrun` 的逗号分隔组合，而这三个取值治理的是**三个不同的内联位置** —— 它们不是同一件事的三个强度层级：

| 取值 | 它禁用的内联位置 | 被拒绝的字段 |
| --- | --- | --- |
| `pipelinerun` | PipelineRun 直接内联整条流水线 | `spec.pipelineSpec` |
| `taskrun` | TaskRun 直接内联一个 task 定义 | `spec.taskSpec` |
| `pipeline` | Pipeline 内部（或任何内联 pipelineSpec 内部）**单个 task 的内联**定义 | `spec.tasks[].taskSpec` / `spec.tasks[].pipelineSpec` |

要彻底封死内联，三个取值都必须写上 —— 只写 `pipelinerun` 的话，一个 `PipelineRun.spec.pipelineRef` 引用集群内 Pipeline、而该 Pipeline 的 task 是内联的，照样能过。

**如何配置（在 ACP 上必须改 TektonConfig，而不是直接改 ConfigMap）**：`feature-flags` ConfigMap 由 tektoncd-operator 从 `TektonConfig.spec.pipeline` 渲染而来；手工编辑的 ConfigMap 会在下一次调和时被覆盖回去。改这里：

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

要**关掉这个开关**（例如为了开放 [§4.1.3](#s4-1-3) 的内联例外），把取值设回空字符串：

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

> 如果 ACP 的 Tekton 命名空间不是 `tekton-pipelines`，以 `TektonConfig.spec.targetNamespace` 为准。

#### 4.1.3 内联例外（默认禁止，谨慎开放） {#s4-1-3}

**默认立场：硬门禁命名空间中不允许内联**（[§4.1.1](#s4-1-1) 的三条通道天然会拒绝内联定义；需要全集群一刀切时，再叠加 [§4.1.2](#s4-1-2) 的 `disable-inline-spec`）。只有在确有需要的地方才开放内联例外 —— 实验命名空间、平台自动化之类。

:::warning 前提：本节与 §4.1.2 的 disable-inline-spec 互斥 —— 两者不能同时开启

`disable-inline-spec` 是 **Tekton 自己的 validating webhook**，是一个独立于 Kyverno 的准入 webhook —— **两者任一拒绝，请求就被拒绝**。Kyverno 放行内联定义，并不会让 Tekton 也放行。

所以要让本节的内联例外生效，`TektonConfig.spec.pipeline.disable-inline-spec` 中**必须不包含对应的取值**：要开放 PipelineRun 内联，就去掉 `pipelinerun`；如果内联的 pipelineSpec 里还要嵌 `taskSpec`，那就连 `pipeline` 也一并去掉。[§4.1.2](#s4-1-2) 的第二个 patch 演示了如何清空它。

换句话说，全集群一刀切禁止（[§4.1.2](#s4-1-2)）与按命名空间开例外（本节）是**两条互斥的路线**：一旦选择按命名空间差异化，全集群开关就必须关掉，整个封闭性就落在 [§4.1.1](#s4-1-1) 的 Kyverno 白名单上。

:::

:::warning 开放内联时，只检查任务名是远远不够的

仅仅要求"内联定义里存在一个叫 `scan` 的任务"，是一项**不充分**的安全检查 —— 攻击者可以塞一个空壳的假扫描器进去、给它挂一个永远为假的 `when` 让它被跳过、把门禁开关设为 `false`，或者把 release 排在它之前 / 与它并行。

要安全地开放内联，你必须校验 [§2.3](#s2-3) 的完整契约集（扫描器身份、门禁开关的实际取值、必须执行、DAG 支配、finally 安全）。**光有名字存在，构不成任何门禁保证。**

:::

因此下面的 `inlineOK` 片段只是一个**结构示例**，演示如何在 [§4.1.1](#s4-1-1) 之上加一条受限的内联通道 —— 绝不能原样当作安全门禁使用：
```yaml
        # ILLUSTRATIVE ONLY — name presence is NOT a gate guarantee (see §2.3).
        # A real inline channel must also constrain identity/params/when/DAG/finally,
        # and should be restricted to a trusted userInfo or an experimental namespace.
        - name: inlineOK
          variable:
            jmesPath: "length(request.object.spec.pipelineSpec.tasks || `[]`) > `0` && length((request.object.spec.pipelineSpec.tasks || `[]`)[?name=='scan']) > `0`"
```

#### 4.1.4 被引用定义的事后内省（Audit 纵深防御） {#s4-1-4}

- **治理什么**：白名单已经放行的模板，其**内容是否被做过手脚** —— 例如门禁任务被悄悄换成了来自另一来源的同名任务。
- **难在哪里**：引用式流水线的定义内容在 CREATE 时是不可见的（[§2.1](#s2-1) 观测点 2 的盲窗）；内容要等 resolver 完成之后才落到 `status.pipelineSpec` 上（观测点 3），而那个观测点**只能 Audit** —— Enforce 会卡死（[§2.2](#s2-2)）。
- **策略怎么分层**：① 用 `preconditions` 把规则精确限定到某一个模板画像（从父 `PipelineRun.spec.pipelineRef` 推导，而不是从运行时标签）→ ② 只有当 `status.pipelineSpec` 出现之后才求值 → ③ 从解析结果中取出门禁任务完整的 `taskRef`，逐字段断言其身份 → ④ 不匹配就记一条 PolicyReport 违规。
- **治理不了什么**：它是**事后的** —— 拦不住这一次运行；也检测不到"门禁还在，但被 `when` / 空 matrix 跳过了"（那属于契约 3，由 [§4.1.5](#s4-1-5) 处理）。**它读的是 `status.pipelineSpec`，所以它的证据效力止步于"谁能写 `pipelineruns/status`"** —— 一个持有该子资源写权限的身份，可以直接写进一份"看起来合规"的 `pipelineSpec`，让漂移审计给出合规结论（与 [§4.4.1](#s4-4-1) 同一条信任边界）；越过那条边界之后，本节就只剩下"观察请求写了什么"的能力，不再是门禁生效的证据。

**关键判据** —— 锁的是完整来源而不是名字；而且**先计数，后读取**（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：

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

:::warning 门禁形态因画像而异 —— 不要在模板之间照搬

在本文的夹具模板 `gated-build` 中，门禁是**内建在 `scan`（sonar 扫描器）自身**里的（自带门禁，没有单独的门禁任务）。官方模板 `java-image-build-scan-deploy` 同样把门禁内建在 `sonarqube-scanner` / `trivy-scanner` 中，但任务别名与引用形态都不同。把某一份具体的任务契约移植到另一个模板上**会产生误报** —— 与 [§4.6.2](#s4-6-2) 组合起来，甚至会错误地取消掉合法运行。

因此漂移 Audit 必须**按模板画像逐个配置**：从父 `PipelineRun.spec.pipelineRef`（`taskRunSpecs` 覆盖不了它）推导出 resolver / kind / name / namespace，然后断言该画像自己的门禁任务契约。**不要把 `tekton.dev/pipeline` 标签当作可信身份** —— Tekton v1.12 允许 PipelineRun 通过 `spec.taskRunSpecs[].metadata.labels` 覆盖子 TaskRun 的标签；即便本规则处理的是父 PipelineRun，也应当始终以 API spec 作为一手身份来源。

下面的示例只适用于夹具画像（`gated-build`）。

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

策略中的 **HUB-RESOLVER GUIDANCE 注释**很重要：夹具用的是 cluster resolver，但在生产环境中，门禁任务通常通过 hub resolver 引用 catalog 里的 `sonarqube-scanner`。切换到 hub 形态时，`scanIdentityValid` 必须由**完整元组**构成（`resolver=hub` + `catalog` + `kind` + `name` + `version`）—— catalog / kind / version 少写任何一个，来源漂移的口子就又开了。

:::

**这条 Audit 的位置**：白名单拦的是"未批准的身份"；这条 Audit 盯的是"已批准的模板在批准之后被做了手脚" —— 生产环境中两者叠加使用。它兜底的是**门禁从定义中被移除**（契约 1 的身份漂移）；而门禁仍在 `status.pipelineSpec` 中、只是带了个 `when` 的情况，会通过存在性检查 —— 那属于契约 3"必须执行"，由下一节接手。

**验证要点**：一次正常的 `gated-build` 运行记为 pass；把 `policy-demo-scanner` 的命名空间改成 `policy-poc`（同名不同源）仍然记为 **fail**，证明完整来源确实被锁住了；删掉 `scan` 的变体同样记为 fail；其他 `pipelineRef` 画像记为 skip —— 没有误报。注意 PolicyReport 的聚合有数秒到数分钟的滞后（[§6.1.5](#s6-1-5)）。

还有一条平台边界值得点出来：**只有"有 finally 任务但普通任务为空"的 Pipeline 会被 Tekton 准入直接拒绝**（`spec.tasks is empty but spec.finally has 1 tasks`），所以这样的定义无法用作"resolver 会解析出一份定义"的测试用例。

#### 4.1.5 门禁必须执行的审计（`skippedTasks`，契约 3"必须执行"） {#s4-1-5}

- **治理什么**：门禁还在定义里，但**这一次运行把它跳过了** —— `when` 表达式求值为假，或者某个 matrix 参数是空数组。
- **难在哪里**：被跳过的门禁**不产生 TaskRun**，所以契约 2 在 TaskRun 层的校验对"不存在"完全是盲的（准入拦不住从未发生的事）；[§4.1.4](#s4-1-4) 的存在性 Audit 同样看不到它，因为门禁确实还在定义里。
- **策略怎么分层**：① 与上一节一样，按画像限定到具体模板 → ② 从 `status.skippedTasks` 中取出门禁那一条跳过记录 → ③ 判断它的 `reason` 是否属于**配置驱动的刻意跳过** → ④ 命中就记一条 PolicyReport 违规。
- **治理不了什么**：它仍然是子资源，因此**只能 Audit** —— 拦不住这一次运行；也不覆盖"门禁执行了但结果被无视"（那是模板在契约 4/5 下的责任）。同样，它信任 `status.skippedTasks` 是由可信的 Tekton 控制器写入的 —— **一个能写 `pipelineruns/status` 的身份可以抹掉刻意跳过的记录，或者换成一个合法的级联跳过 reason**，从而让本节连一条违规记录都不会有（与 [§4.4.1](#s4-4-1) 同一条信任边界）。

判据的关键在于**区分两类跳过**；`skippedTasks[].reason` 的取值来自 Tekton 的 `SkippingReason` 枚举：

- **配置驱动的"刻意跳过" = 门禁被绕过 —— 属于违规**：`When Expressions evaluated to false`（when 跳过）与 `Matrix Parameters have an empty array`（空 matrix 跳过）。
  它们的下游行为并不相同：`when=false` 之后，仅通过 `runAfter` 依赖门禁的 release **照样执行**；而空 matrix 会让 release 级联记录 `Parent Tasks were skipped` 并且不创建 TaskRun。**无论下游是否恰好被级联捕获，被配置跳过的门禁都必须留下一条 Audit 记录。**
- **级联 / 终止驱动的"被动跳过" = 合法，不算违规**：`Parent Tasks were skipped` / `PipelineRun was stopping` / `PipelineRun was gracefully cancelled` / `PipelineRun was gracefully stopped` / `PipelineRun timeout has been reached` / `PipelineRun Tasks timeout has been reached` / `PipelineRun Finally timeout has been reached`（三个超时变体，取值逐字完整列出 —— 如果将来把这一档改写成白名单形态，需要的正是这些精确字符串）。它们意味着流水线本来就在以失败、取消或超时收场，门禁随之被跳过并不是一次门禁绕过。
- `Results were missing` 介于两者之间 —— 门禁的输入 result 从未产出，这多半是契约 4 的数据绑定问题；按需把它并入违规集合。

以上三档合起来就是该枚举的全部取值（另有一个 `None` —— 表示"未跳过"的哨兵值，它永远不会出现在 `skippedTasks` 里）。**但这是一份黑名单（[§3.6](#s3-6)）**：当 Tekton 新增一个 `SkippingReason` 时，它默认落到"不算违规"那一侧 —— 如果这个新 reason 恰好也是配置驱动的，那么被配置跳过的门禁就不再留下 Audit 记录，而且**什么都不会报错**。所以每次 Tekton 升级之后都要重查这份取值表：该枚举定义在上游 `pkg/apis/pipeline/v1/pipelinerun_types.go` 的 `SkippingReason` 常量块中；比对之后，把每一个新增项归入上面三档之一，再调整判据。

**关键判据** —— 只有"刻意跳过"才算违规，而且**要计数，不要取 `[0]`**（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：

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

更稳健的加强版判据是"门禁被刻意跳过**并且**下游某个发布任务确实执行了"（按模板已知的 DAG，追加一项对 release 的 `childReferences` 存在性检查）。本示例用的是前者，它已经足以抓住绕过行为。

:::warning 与 §4.1.4 一样：门禁任务名因画像而异

这里的门禁任务是夹具模板的 `scan`（[§4.1.4](#s4-1-4) 关于同名的说明同样适用）。其他模板给门禁任务起的别名不同，照抄这条策略会**漏判违规** —— 请给每个模板画像配上它自己的门禁任务名，并从父 `PipelineRun.spec.pipelineRef` 精确推导出画像；不要用可被用户输入影响的运行时标签去替代 API spec 身份。

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

**如何复现"门禁被跳过"**（在跑 Tekton 与 Kyverno 的集群上）：[§3.3](#s3-3) 的 `gated-build` 带有一个 `demoSkipScan` 参数；把它设为 `"true"`，`scan` 就会被 `when` 跳过 —— 正是本节要抓的那种形态。存成 `skip-gate-probe.yaml`：
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

预期：命令 1 给出 `scan` + `When Expressions evaluated to false`；命令 2 的输出中**不含** `scan` 但**含有** `release`；命令 3 显示 `fail`。**第一次读命令 3 多半会是 `skip`** —— 报告行是在第一次 status UPDATE 时写入的，那时运行尚未到达终态；请**反复重读那条 PolicyReport 结果**，直到它**从 `skip` 变成终态结果**之后再下结论（只读一次的话，两次相同的实操可能分别得到 `fail` 与 `skip`）。**再跑一次普通的 `demo-run-pass` 作为反向对照** —— 它的 `skippedTasks` 是空的，本规则对它记录的是 `skip`（不是 pass：前置条件 `gateSkipCount != 0` 不成立，规则根本不会被求值）。如果没有 `fail` 出现，先按 [§6.1.2](#s6-1-2) 排查 —— 策略是否 Ready、四个画像字段是否匹配 —— 再去怀疑判据。

**与 [§4.1.4](#s4-1-4) 的分工**：[§4.1.4](#s4-1-4) 抓的是"门禁被移除"（定义漂移）；[§4.1.5](#s4-1-5) 抓的是"门禁被跳过"（运行时绕过）—— 只有两条 Audit 合起来，才覆盖契约 3"必须执行"的完整事后检测面。生产环境中两者叠加使用，与 [§4.2](#s4-2) 的参数契约（防门禁参数被关掉）和 [§4.1.1](#s4-1-1) 的白名单（防模板被换掉）互补。

#### 清理（§4.1）

按 [§4.0.4](#s4-0-4) 的两条规则：三条集群级策略在 UID 账本守卫下删除；运行时对象都位于自建命名空间中，随命名空间级联回收 —— 但 `PipelineRun/doc-gate-skipped` 最好现在就删掉：在"各节独立"模式下重跑下一节时，`kubectl get policyreport` 会多出一条属于上一节的 `doc-gate-skipped` 记录，很容易被误读成本节的判定结果。

```bash
# The helper refuses missing/duplicate ledger rows, read errors and UID replacements.
for pol in pipeline-template-allowlist pipeline-resolved-definition-audit \
  pipeline-gate-must-execute-audit; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
# Its TaskRuns / Pods cascade via ownerReference, and the PolicyReport rows go with it.
kubectl delete pipelinerun -n policy-poc doc-gate-skipped --ignore-not-found
```
### 4.2 参数约束：校验实际取值（契约 2） {#s4-2}

**总契约**：门禁相关参数（开关、阈值、目标分支）的**实际生效取值**必须合规。有两条路径：

- **主路径（参数已展开的那个观测点；通用）**：在**门禁 TaskRun CREATE** 时校验。那一刻 `spec.params` 里已经是展开后的实际取值 —— `$(params.x)` 已解析，连对上游任务 result 的引用也已经解析成具体值。身份链必须从 API server 提供的 `request.userInfo`（创建者是 Tekton 控制器 SA）与控制器写入的 `ownerReference` 起步，用 `apiCall` 读取父 PipelineRun，核对 owner UID 与父级的 `spec.pipelineRef`，再从当前 `spec.taskRef` 锁定 resolver、kind、catalog / name / version / namespace。这条路径对模板作者是**零迁移义务**的 —— 它不要求把任务级参数上浮到 PipelineRun 层。用哪个画像、解析到哪个 Task、校验哪些参数，**必须按模板版本逐个配置**（见 [§3.2](#s3-2) 的版本矩阵）。
- **辅路径（模板已经暴露参数时的提前拦截）**：当官方模板把关键开关放进 PipelineRun 级参数时，可以直接在 **PipelineRun CREATE** 时拦截 —— 一个任务都不会跑，使用者当场得到反馈。体验更好，但它取决于模板的参数设计，只能作为可选优化。这里还有一个陷阱：一个同名的 PipelineRun 级参数**是否真的接到了门禁上**，由模板的接线决定 —— 没接上时，这一层校验就是摆设（取值合规，而门禁根本不用它），这正是主路径要按展开后的实际取值判定的原因。

**本节导览**（全文最大的一节 —— 不要从头读到尾）：

- **[§4.2.1](#s4-2-1) 主路径** —— 门禁参数契约，在参数已展开的观测点上拒绝。**先读它**；后面各小节要么是同一件事的另一种响应形态，要么是互补的面。
- **[§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3)** —— **同一条判据**的另外两种响应形态：当拦截之后 finally 仍须执行时，用取消代替 deny（这两条加上 [§4.6](#s4-6) 的取消，共四条路径；主表在 [§4.6](#s4-6) 引言里）。
- **[§4.2.4](#s4-2-4)** —— 受保护分支的门禁契约（真实的 `sonarqube-scanner` 画像）；它治理的是"分析受保护分支时必须保持门禁严格"；PR / 特性分支构建不带分支准入约束。
- **[§4.2.5](#s4-2-5) 辅路径** —— 官方模板已经在 PipelineRun 层暴露开关时的提前拦截：**篇幅最长，但不是必装项** —— 只有当你使用那批官方模板、并希望使用者当场得到反馈时才需要它。
- **[§4.2.6](#s4-2-6)** —— mutate 注入默认值：不做拦截，只补齐缺失的东西。

:::warning 两条纪律 —— 破了任何一条，整节都能被绕过

**① 绝不要信任子 TaskRun 的 `tekton.dev/pipeline` / `pipelineTask` / `pipelineRun` 标签。** Tekton 允许 PipelineRun 通过 `spec.taskRunSpecs[].metadata.labels` 覆盖这些控制器标签，也就是说这些"身份"可以被调用方伪造。**机制是"先写者胜，而用户先写"**：控制器合成子 TaskRun 的标签时，会先合并 `taskRunSpecs[].metadata.labels`，再合并自己那套 `tekton.dev/*` —— 而合并函数**只在键尚不存在时才写入** —— 用户已经写好的同名键，控制器既不覆盖也不报错。所以这不是一个你可以指望被修掉的缺陷，而是既定的合并顺序。身份必须从控制器 `ownerReference` + 实时父运行 + `spec.taskRef` 推导。

**② 参数缺失必须失败关闭。** 流水线未绑定的参数**不会出现**在 TaskRun 的 `spec.params` 里（此时生效的是 Task 定义的默认值）。只有当 `spec.taskRef` 已经锁定到一个"默认值可信的确切 Task 版本"时，策略才可以把缺失映射为那个可信默认值；身份未锁定或默认值未知时，缺失一律视为违规。

另外注意：被 `when` 跳过的门禁根本不产生 TaskRun（契约 3），所以这条路径对"门禁缺席"是盲的 —— 那由 [§4.1.5](#s4-1-5) 的 `skippedTasks` Audit 接手。

:::

#### 4.2.1 门禁参数契约（主路径） {#s4-2-1}

- **治理什么**：**门禁开关不得被关掉** —— 在 `gated-build` 中，`scan` 的 `enableScanQualityGate` / `enableAnalyzeQualityGate` 必须恰好是字符串 `"true"`。
- **难在哪里**：在 PipelineRun CREATE 时，你只能看到调用方**显式写下的**内容，看不到模板默认值展开之后的**最终实际取值**（[§2.1](#s2-1) 观测点 2）；实际取值变得可见的时刻，是**扫描器自身 TaskRun 的 CREATE**。但那个时刻另有陷阱 —— TaskRun 上诸如 `tekton.dev/pipelineTask` 之类的标签，可以通过父运行的 `taskRunSpecs` 覆盖伪造，所以**绝不能用标签来判定"这是不是门禁任务"**。
- **策略怎么分层**：① 先证明来源 —— 创建者必须是 Tekton 控制器 SA，带有控制器写入的 ownerReference，并按 owner 查出**实时的**父运行核对 UID；② 再锁定身份 —— 父运行的 `pipelineRef` 必须恰好是 `tekton-templates/gated-build`，当前的 `taskRef` 必须恰好是那个可信扫描器；③ 最后才判定参数取值，并且把**"缺失"与"显式空字符串"分开处理** —— 只有缺失才继承可信 Task 的默认值 `"true"`；显式的 `false` / 空字符串 / `TRUE` / `1` 一律不达标。
- **覆盖不了什么**：deny 意味着门禁 TaskRun 根本创建不出来；父运行的终态是 `CreateRunFailed`，而且 **finally 不会执行**；如果 finally 必须执行，请改用 [§4.2.2](#s4-2-2)（取消父运行）或 [§4.2.3](#s4-2-3)（把门禁 TaskRun 自身 mutate 成取消态）。

**关键判据** —— 先建立身份链，再判定取值；用一个专门的 present 变量把"缺失"与"显式空字符串"区分开（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：

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

:::warning context.apiCall 取不到目标时失败关闭 —— 而且报错指向的是 APICall，不是你的判据

这条规则用 `apiCall` 按 ownerReference 查父 PipelineRun 并核对 UID。**查询失败（父对象不存在、API server 不可达、权限不足）不会降级成"跳过" —— 整条规则报错，请求被拒绝。** 以 Tekton 控制器 SA 的身份提交一个 ownerReference 指向不存在父运行的 TaskRun，会得到：

```text
failed to evaluate preconditions: failed to substitute variables in condition value:
failed to resolve parentRun.metadata.uid at path : failed to fetch data for APICall:
failed to GET resource with raw url
```

两个后果都要知道：① **方向是安全的** —— 查询完不成就什么都不放行；无主的门禁 TaskRun 绝不会被静默放进来；② **排障时不要被消息误导** —— 它报的是 `APICall` 失败，而不是"参数不合规"；看到它，先查 API server 可达性与 Kyverno 的读权限，而不是去改参数。当父运行已经被删除时（例如级联清理进行到一半），这条规则会让残留的子 TaskRun 创建不出来 —— 这是预期行为。

:::

**预期形态**：用 `enableAnalyzeQualityGate: "false"` 跑 `gated-build` —— 控制器创建 `scan` TaskRun 的尝试在准入阶段被拒，该错误被判为**永久性**，运行直接落到终态（**不会无限重试**；但"永久性"不等于"只尝试一次" —— 见 [§2.3](#s2-3) info 块的最后一项）；PipelineRun 很快到达终态 **`CreateRunFailed`**（从提交到终态通常是数十秒量级，取决于控制器的调度与重试节奏 —— 不要把它当成固定值），condition 消息里带有**完整的策略消息**（策略名 / 规则名 / 含实际取值的自定义文本）；`release` 从未被创建，finally 也不会执行（[§2.3](#s2-3) 对照表的第一行）。显式的 `false`、显式的空字符串，以及无法识别的取值 `TRUE`，全部被拦；只有两个开关都缺失（继承可信默认值 `"true"`）或者都显式为 `"true"` 的运行才被放行。

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

**如何验证**：本节不提供单独的探针清单 —— 复用 [§3.3](#s3-3) 的两个夹具，按 [§3.4](#s3-4) 的第三类**真跑一条流水线**（`--dry-run` 探针不行：拒绝发生在 Tekton 控制器创建子 TaskRun 的那一刻，而不是你提交 PipelineRun 的那一刻 —— 理由见 [§3.4.1](#s3-4-1)）：换个 `metadata.name` 重建 `demo-run-gates-off`；策略没装时它会一路全绿（[§3.3](#s3-3) 刻意暴露的那条绕过），装上策略之后 `scan` TaskRun 必须创建失败，父运行以 `CreateRunFailed` 收场且 finally 不执行。同样换个新名字重建 `demo-run-pass` 作为正向对照 —— 它的三个任务必须跑完，不受影响。**两个都要跑** —— 只跑负向的那个，证明不了策略没有误伤。

本示例聚焦于最关键的"开关不得被关掉"。扫描器的门禁**阈值 / 规则**（`analyzeQualityGateRules`）可以用同样的方式再加一条规则来覆盖，校验一条基线（例如必须包含一条阈值 ≥ 50 的覆盖率规则），写法按 [§4.4.2](#s4-4-2) 的数值失败关闭模式（先用正则把取值限定在 0–100，确认有界之后才 `to_number`，从而绕开 [§6.1.7](#s6-1-7) 的溢出与强制转换陷阱）。另外，参数展开覆盖的不只是 `$(params.x)` —— **上游 result 引用同样会被解析**，所以"作为下游参数绑定的某个 result 取值"，同样可以在下游 TaskRun 的 CREATE 时由准入来校验。

#### 4.2.2 用取消代替拒绝：门禁拦截之后 finally 仍须执行时（RunFinally） {#s4-2-2}

- **治理什么**：与 [§4.2.1](#s4-2-1) **完全相同**（门禁开关不得被关掉），只是响应不同 —— 不拒绝创建，而是取消父 PipelineRun，让 finally 照常执行。
- **难在哪里**：[§4.2.1](#s4-2-1) 的 deny 是硬拦截，代价是 `scan` TaskRun 创建不出来 → DAG 永远结束不了 → **finally 不执行**（机制见 [§2.3](#s2-3)）。依赖 finally 做通知 / 资源清理的团队，会撞上"门禁拦截时 finally 静默不执行"。
- **策略怎么分层**：① 检测点与 [§4.2.1](#s4-2-1) 完全相同（scan TaskRun CREATE + 同一条身份链）→ ② 命中之后不做 deny —— 用 **mutate-existing** 给 owner 所指的**那个父 PipelineRun** 打补丁 → ③ 写入 `spec.status: CancelledRunFinally`（"取消 DAG，但仍执行 finally"的语义）+ 一条带原因的注解。
- **覆盖不了什么**：mutate-existing 是**异步**的，存在竞态窗口（见下面的警告）；而且取消形态下的 condition 只带有通用的 `was cancelled` 文本 —— 它不像 deny 那样把完整的策略消息透传出来 —— 所以原因必须由你自己写进注解。

**这是本文若干条取消路径之一**（另有两条共用同一机制但判据不同：[§4.6.1](#s4-6-1) 的结果不达标、[§4.6.2](#s4-6-2) 的定义漂移）；"何时检测、动什么、同步还是异步、去哪里取证"的主表在 [§4.6](#s4-6) 引言中 —— **那张表才是取消路径的权威清单**。

:::warning 三条前提与边界 —— 安装之前先读

**① RBAC 前提**：mutate-existing 需要 background-controller 持有对 `pipelineruns` 的 update 权限，而 **Kyverno 会在策略创建时校验该 RBAC；没有就直接装不上** —— ClusterRole、先授权后安装的顺序及其传播检查，以及报错样例，都在 [§4.6](#s4-6) 引言中（由三条 mutate-existing 取消路径共用 —— 本节与 [§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2)；[§4.2.3](#s4-2-3) 的准入 mutate 不需要它；这里不重复配置说明）。本节需要单独记住的一点是：**创建时的鉴权检查不会对 `{{ request.namespace }}` 求值** —— 当 `mutate.targets[].namespace` 写成变量时，Kyverno 只认**集群级**的 update 权限；所以"用命名空间级 Role 治理单个固定命名空间"这条捷径，要求 `targets[].namespace` 也写成**字面量**（本节正文的清单正是这么做的；`targets` 的注释给出了跨命名空间的变体）—— 只加 Role 是不够的，而且报错看起来与"完全没授权"一模一样。**不要把两件事混为一谈**：`match.resources.namespaces` 决定**哪些请求会触发规则**；`targets[].namespace` 决定**给哪个命名空间的对象打补丁**；想要"装一次，但只在部分命名空间生效"，就收窄前者（或者用 `namespaceSelector`）。

**①b 安装本节策略时，Kyverno 会打印一条无关的告警** `Warning: You are matching on status but not including the status subresource...` —— 它是被补丁中的 `spec.status`（Tekton 的取消字段）触发的；本规则匹配的是 TaskRun 的 **CREATE**，从不碰 status 子资源；忽略即可。

**② 竞态**：mutate-existing 由 background controller **异步**执行 —— 到那时 `scan` TaskRun 早已通过准入，甚至可能已经开始运行；取消补丁稍后才落地。如果扫描器跑得很快（例如门禁关掉之后它不再自身失败，直接 Succeeded），排在它后面的 release 可能在取消落地之前就被调度了。**这不是"零竞态硬拦截"，而是"一检测到就取消"** —— 要零竞态，请用 [§4.2.1](#s4-2-1) 的 deny 或 [§4.2.3](#s4-2-3) 的准入 mutate。

**③ 防伪造 DoS**：由于 `taskRunSpecs[].metadata.labels` 能覆盖子 TaskRun 的 `tekton.dev/pipelineRun`，光"禁止裸 TaskRun"（[§4.5.4](#s4-5-4)）是不够的 —— 否则攻击者可以把标签指向别人处于 Pending 的运行，让策略替他取消掉。本策略完全忽略该标签：它只接受由 Tekton 控制器 SA 创建的 TaskRun，读取控制器写入的 ownerReference，用 `apiCall` 回查父运行并核对 UID，然后从父级的 `spec.pipelineRef` 与当前的 `spec.taskRef` 判定画像。一个带伪造标签的攻击运行只能取消它自己；它所指向的受害运行不受影响。

:::

**关键判据** —— 命中之后，补丁作用于 owner 所指的那个父运行，`targets` 用 name + uid 双重锁定：
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

:::details 前置 RBAC：命名空间级 Role + RoleBinding

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

:::details 用于验证的正反向 PipelineRun

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

**预期形态**：在违规运行中（显式 `false` 或显式空字符串），`prep` 成功，`scan` 被取消，`release` 以 `PipelineRun was stopping` 被跳过，父运行带有 `spec.status=CancelledRunFinally`、终态为 `Cancelled`（当取消与任务失败竞态时可能是 `Failed` —— 策略是否生效以 `spec.status` 与 `cancel-reason` 判定，[§2.3](#s2-3) / [§4.6.1](#s4-6-1)），`cancel-reason` 注解存在，而且 **finally 的 `notify` 正常成功**；在合规运行中，`prep / scan / release / notify` 全部成功，父运行为 `Succeeded`。

注意这只能证明触发接线与 finally 行为正确；**它并不消除竞态窗口**。还有一条与成本相关的边界：一个 TaskRun 可能已经被标记为 `TaskRunCancelled`，而它的 Pod 在并发创建路径上早已启动并继续运行到进程退出 —— 所以这不是一个"立刻杀掉计算"的强保证；成本敏感的场景，仍然要给任务设置合理的超时，并以 Pod 实际的终止行为为准去验证。

**为什么不干脆在 PipelineRun CREATE 时取消？** 这里其实是两个问题。**第一，在 CREATE 时你判定得了吗**：那一刻只能看到显式写进 PipelineRun 的参数（那部分属于提前 deny 的辅路径；[§4.2.5](#s4-2-5) 是真实模板的实例）；而本节要治理的**实际取值** —— 一个缺失的参数，其继承的默认值发生了漂移、或者被覆盖了 —— 要等控制器创建 `scan` TaskRun 时才可见；CREATE 时根本无从判起。**第二，取消在那时是正确的选择吗**：不是 —— 那时该用 deny；取消的价值**恰恰在于门禁之前已经跑过真实工作**，从而 finally 有东西可以通知 / 清理；CREATE 时什么都还没跑，一个"空的 finally"只是绕了个弯的 deny。在 [§3.3](#s3-3) 的基线模板 `gated-build` 中，`scan` 是**第一个任务** —— 正好落在"什么都还没跑"那一侧 —— 所以那里用 [§4.2.1](#s4-2-1) 的同步 deny 更干净；本节刻意改用 `gated-build-with-prep`，让 `prep` 先跑完，再在 scan CREATE 时触发取消。于是选型规则很简单：**扫描器是第一个任务 → 用 deny；扫描器之前有需要 finally 收尾的真实工作 → 才用取消。**

| 维度 | deny（[§4.2.1](#s4-2-1)） | 取消 · mutate-existing @ scan TaskRun（[§4.2.2](#s4-2-2)） |
|---|---|---|
| 运行终态 | `CreateRunFailed` | `Cancelled` |
| 扫描器之前的任务（如 `build` / `test`） | 跑过的就是跑过了 | 跑过的就是跑过了（在扫描器之前完成） |
| **finally** | **不执行** | **执行**（为已经跑过的真实任务做通知 / 清理） |
| 门禁原因的可见性 | condition 中带完整策略消息 | 通用文本 + `cancel-reason` 注解 |
| 需要把门禁开关放到 PipelineRun 层吗？ | 不需要 | **不需要**（读的是 scan TaskRun 上展开后的实际取值） |
| 同步 / 竞态 | 同步硬拦截 | 异步，存在竞态窗口 |
| 前置条件 | 无 | background-controller 对 `pipelineruns` 的 update RBAC |
| 适合 | 扫描器是第一个任务、不需要 finally 收尾，且希望立即硬拦截 + 完整原因 | 扫描器之前有真实工作、finally 必须做通知 / 清理；并且你接受"取消比检测稍晚一点" |

#### 4.2.3 准入 mutate 取消：deny 的同步替代方案（取消门禁 TaskRun 自身） {#s4-2-3}

- **治理什么**：使用与 [§4.2.1](#s4-2-1) **完全相同的完整身份链与同一组判据**（父 Pipeline 画像、实时父运行 UID、当前 Task 画像，以及两个门禁开关 —— 一个都不能少），只是换成第三种响应形态 —— **不拒绝门禁 TaskRun 的创建，而是在同一次准入过程中把它 mutate 成"已取消"**。
- **难在哪里**：deny 会让这个 DAG 节点**根本不存在** —— DAG 永远到不了 done，finally 被饿死；[§4.2.2](#s4-2-2) 能让 finally 执行，代价是异步竞态与额外的 RBAC。两者都不理想。
- **策略怎么分层**：① 同样锁定创建者为 Tekton 控制器、以及该 Task 的 resolver 坐标 → ② 命中不合规开关时执行一次准入 `mutate` → ③ 在该 TaskRun 上写入 `spec.status: TaskRunCancelled` 与 `spec.statusMessage: <reason>`。
- **本文所有取消路径中唯一同步的一条** —— 其余几条（[§4.2.2](#s4-2-2) 取消父运行、[§4.6.1](#s4-6-1) 结果不达标、[§4.6.2](#s4-6-2) 定义漂移）都是事后异步动作；完整表格在 [§4.6](#s4-6) 引言中。
- **治理不了什么**：它**不产生 PolicyReport 违规记录**（见下面的警告）；它也**不适用于裸 TaskRun 这个入口** —— 本节三种响应形态（[§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3)）都用 `subjects` 只匹配由 Tekton 控制器创建的子 TaskRun，**没有一种能拦住用户手工创建的裸 TaskRun**；那条路径由 [§4.5.4](#s4-5-4) 的入口封堵独家负责。

它之所以奏效，靠的是 Tekton 的状态机：mutate 成取消态，让节点**以失败姿态存在** —— TaskRun 的 reconciler 在构建 Pod 之前就判定它已被取消，直接收尾；节点到达 done 状态，DAG 得以完成，finally 照常被调度。治理效果等同于 deny（门禁的容器一秒都没跑过），而状态机保持完整：

- **没有容器启动**：取消判定发生在 reconcile 的最前面 —— `podName` 始终为空，从未创建 Pod，因此也没有拉取镜像；
- **不消耗重试次数**：Tekton 的重试分支明确排除已取消的 TaskRun —— 这比门禁任务 `exit 1` 还干净（后者确实会消耗 `retries`）；
- **原因可见**：`statusMessage` 会被逐字拼进 TaskRun 的失败 condition —— `tkn` 与控制台直接就能看到，不依赖 webhook 返回了什么 HTTP 状态码；
- **你必须适配的一点**：父运行的终态 reason 是 `Cancelled`，**而不是** `Failed` —— 按 `Failed` 过滤的告警 / 看板必须把 `Cancelled` 也加上。

**关键判据** —— 命中之后写入两个字段；取消原因随对象一起走：

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

在 PolicyReport 中，被取消的 TaskRun 表现为 `result=skip`，消息是 `no patches applied`（等 reports-controller 重新求值时，对象已经处于目标状态了）—— **而不是 `fail`**。所以"哪些运行是被策略取消的"，只能通过 TaskRun 的 `statusMessage` / 注解追溯，或者另外专门配一条 [§4.4](#s4-4) 的 Audit 规则来记账。

安装这条策略时，Kyverno 会打印 `You are matching on status but not including the status subresource in the policy`（因为补丁碰了 `spec.status`）—— 那是一条启发式提示，不影响生效。

**不要把它当作裸 TaskRun 入口的防线**：本规则的 `subjects` 只匹配由 Tekton 控制器创建的子 TaskRun；用户手工创建的裸 TaskRun **根本进不了这条规则** —— 封堵裸入口是 [§4.5.4](#s4-5-4) 的职责。

即便你把 `subjects` 去掉、让它也匹配用户创建的 TaskRun，也不该那样用：mutate 成取消态**不会产生任何同步错误** —— 创建者只会拿到一个"创建成功、下一瞬间却被取消"的对象，排查成本远高于一条 deny 消息。裸入口需要的是 deny，而不是静默取消。

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

**跑本节演示之前，先卸载 [§4.2.1](#s4-2-1) 的策略**（三种响应策略为何是互斥选择，完整说明在本章清理段落之前的警告里；这里提前放到你会踩到的那一处）：`gate-param-contract` 还装着的时候，同一个违规的 scan TaskRun 会先被它拒掉 —— mutate 确实在准入链上跑得更早、也确实已经把 `spec.status` 写成了 `TaskRunCancelled`，但 validate 阶段读到的 params 未被改动，照样拒绝 —— 运行的终态是 [§4.2.1](#s4-2-1) 的 `CreateRunFailed`，而本节的取消形态**完全看不见**。继续之前，请用 [§4.0.4](#s4-0-4) 的 UID 助手删掉 `gate-param-contract`；[§4.2.2](#s4-2-2) 的策略不冲突 —— 它的父级固定值是 `gated-build-with-prep`。

**用什么来跑**：本节同样不提供单独的运行清单 —— 再次复用 [§3.3](#s3-3) 的 `demo-run-gates-off`（两个开关都是 `"false"`；换个 `metadata.name` 重建即可）；下面说的"单独验证第二个开关"，是指把那个夹具再复制一份，只保留 `enableAnalyzeQualityGate` 为 `"false"`，而把 `enableScanQualityGate` 写成 `"true"`。正向对照仍然是 `demo-run-pass`。按 [§3.4.1](#s3-4-1) 的**类型 3** 取证 —— 读对象自身的 `spec.status` 与注解（命令见 [§6.2.3](#s6-2-3)），而不是准入返回值。

**预期形态**：不合规的那次运行（`enableScanQualityGate="false"`）—— `scan` TaskRun 会落到集群上，带着 `spec.status=TaskRunCancelled` 与保留下来的 `spec.statusMessage`；它的终态 condition 是 `False / TaskRunCancelled`，消息为 `TaskRun "<name>" was cancelled. <statusMessage 原文>`；`podName` 为空，该运行下唯一的 Pod 属于 finally（门禁容器一秒都没启动）；`release` 以 `PipelineRun was stopping` 被跳过；finally 的 `notify` 正常到达 `Succeeded`；父运行以 `False / Cancelled` 收场，消息形如 `Tasks Completed: 2 (Failed: 0, Cancelled 1), Skipped: 1`。合规运行中三个任务全部跑完、没有任何跳过 —— 策略没有误伤。**单独验证第二个开关** —— 一次只把 `enableAnalyzeQualityGate` 设为 `"false"`、另一个保持 `"true"` 的运行，同样会被取消（父运行 `False / Cancelled`，门禁 TaskRun `spec.status=TaskRunCancelled`，且 `statusMessage` 打印出两个开关的实际取值）；如果你只验证过第一个开关，那么"本节判定的东西与 [§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) 相同"这个说法就从未被验证过。

**三种响应形态的权衡**：下表比较的是把三种响应映射到**同一份可信父 Pipeline + 门禁 Task 画像**之后的机制差异。本文 [§4.2.2](#s4-2-2) 的演示夹具为了展示 finally，用的是另一个父 Pipeline 名 `gated-build-with-prep`；在为生产选型时，你必须把三条策略的父 / 子画像都指向同一组真实身份 —— 不要把这三份演示 YAML 当成可以直接互换的素材。

| 维度 | deny（[§4.2.1](#s4-2-1)） | mutate-existing 取消父运行（[§4.2.2](#s4-2-2)） | 准入 mutate 取消门禁 TaskRun（[§4.2.3](#s4-2-3)） |
|---|---|---|---|
| 运行终态 | `CreateRunFailed` | `Cancelled` | `Cancelled` |
| **finally** | **不执行** | **执行** | **执行** |
| 同步 / 竞态 | 同步硬拦截 | 异步，有竞态窗口 | **同步硬拦截，无竞态窗口** |
| 额外 RBAC | 无 | background-controller 对 `pipelineruns` 的 update | **无** |
| 门禁原因的可见性 | condition 中带完整策略消息 | 通用文本 + `cancel-reason` 注解 | TaskRun condition 中原样带有 `statusMessage` |
| PolicyReport 违规记录 | 有（Audit 模式下） | 无 | 无 |
| 对裸 TaskRun 入口 | **不适用**（同样被 `subjects` 限定） | 不适用 | 不适用 |
| 裸入口归谁管 | [§4.5.4](#s4-5-4) 入口封堵 | [§4.5.4](#s4-5-4) 入口封堵 | [§4.5.4](#s4-5-4) 入口封堵 |
| 适合 | 不需要 finally 收尾；要立即硬拦截 + 完整原因 | 已经有 mutate-existing 的基础设施；能接受"取消比检测稍晚" | finally 必须照常执行、要同步零竞态、且不想引入额外 RBAC |

#### 4.2.4 受保护分支的门禁契约（真实画像：sonarqube-scanner） {#s4-2-4}

- **治理什么**：**合入受保护分支之后的构建，其代码扫描必须保持严格门禁** —— 对 `main` / `release-*` 的分支分析，不得显式关闭门禁开关，也不得更换扫描来源。**PR / 特性分支构建不带分支准入约束**：PR 阶段的门禁属于尽力而为（本节的规则 ④，可选安装）；合入之后，规则 ③ 在**请求参数层**提供严格约束，而只有当仓库、`sonar-settings`、`sonar-credentials` 的内容治理同样成立时，它才上升为端到端保证（见下面的信任边界警告）。**输入必须是规范形态** —— 契约之外的形式（注释行、行首空白、经由 `sonarProperties` 走的受管键等）一律拒绝而不是解释；见规则 ②。
- **难在哪里**：准入层**没有可信的"PR 目标分支"信号** —— 平台没有独立的 targetBranch 字段，一切都搭在 PipelineRun 参数上。而且在 PR 分析模式下，分支参数本身是**失效的**（Task 检测到非空的 `sonar.pullrequest.key` 时会删掉 `sonar.branch.name`）。对一个在某些场景下根本不生效的参数做无条件断言，必然会把那些场景整体拦死 —— 所以门禁判据必须是**有条件的**：它只适用于那些分支分析目标是受保护分支（或者参数缺失时的默认分支）的运行。另一个难点是 `sonarProperties` 这类数组参数的自由度：注释行、行首空白、重复声明、某个元素里塞进一个换行……每一种形态在 Task 内部都有自己的解释方式，逐一建模是一条永远收敛不了的路（教训见下面第一个警告）。本节的答案是**先用规范形态门禁把输入面收窄**；其余所有判据都只在规范形态下成立。判定点仍然在 TaskRun 层（参数以展开后的取值写进扫描器 TaskRun —— 模板零改动），身份仍然锁定真实的 taskRef（子级标签可被 `taskRunSpecs` 伪造）。
- **策略怎么分层**：① `hub-source-integrity` —— 对 `catalog/sonarqube-scanner/0.7` 的**每一个** TaskRun，验证 Hub 来源没有被换掉（拒绝请求级 `url`、拒绝多个 `type`、显式 `type` 只能是 `artifact`）；**场景中立**，Enforce → ② `sonar-props-normative-form` —— **规范形态门禁**，同样场景中立，Enforce：`sonarProperties` 的每个元素必须恰好是一条规范的 `key=value`（键以字母开头、无行首空白、无 `#`、无换行）；受管键（`sonar.branch.name` / `sonar.host.url` / `sonar.projectKey` / 凭据类键 / `sonar.qualitygate.*`）不得经由 `sonarProperties` 传递，只能使用各自的专用参数；`sonar.pullrequest.key` / `.base` 允许出现（push 事件时平台会以空 key 注入整组，而官方模板没有对应的专用参数），但每种至多一条，且取值中不得含空白。**契约之外的形式一律拒绝，绝不解释** —— 这正是本节从"复刻 Task 的解析语义"收敛到"收窄支持面"之后的落点（见下面第一个警告）→ ③ `protected-branch-gates-strict` —— 实际分支只从 `sonarBranchName` 参数读取（规则 ② 已经把**请求参数内**其他所有入口都拒掉了）：只有当取值匹配 `^(main|release-.*)$` **或者缺失 / 为空白**时才进入本规则（此时扫描器分析的是项目默认分支 —— 正是被保护的对象；SonarQube 社区版不支持分支分析、只能省略该参数，所以这样处理是把它纳入治理而不是误拒），并且请求参数中没有非空的 PR key 声明；任一门禁开关**显式传入且 ≠ `"true"` 即拒绝**（缺失 = 继承 Task 的可信默认值 `"true"`，放行），Enforce；PR / 特性分支构建在前置条件处就已跳过 → ④ `pr-target-protected-gates-audit`（可选安装）—— 当声明了**非空的 `sonar.pullrequest.key`**（真实的 PR 分析；push 注入的空 key 形态不进入）且 `sonar.pullrequest.base=` 指向受保护分支时，对 PR 也要求门禁开关未被显式关闭，Audit。**不写 / 写错都只是跳过 —— 方向天然失败开放** —— 这是承认"PR 目标分支只能来自用户提供的参数、不可信"之后所接受的显式权衡。
- **治理不了什么**：ⓐ "受保护分支构建必须**真的跑**扫描" —— 当 `sonarURL` 为空时，扫描器任务会被模板的 `when` 整体跳过，根本不产生 TaskRun，准入什么都看不到（PipelineRun 层的判据见 [§4.2.5](#s4-2-5)，跳过审计见 [§4.1.5](#s4-1-5)）；ⓑ PR 门禁的可信度 —— `sonar.pullrequest.base` 是用户可控参数；规则 ④ 只能尽力而为；ⓒ "合入受保护分支必然触发构建"属于平台的触发器配置，是本节的**信任根**（与 [§5.0](#s5-0) 同级别治理）；ⓓ **仓库 / workspace / 凭据中的属性文件** —— 准入看不到 `sonar-project.properties`、`sonar-settings`、`sonar-credentials` 的内容：分支取值这一侧已经封闭（参数非空时 Task 会用参数覆盖文件里的值；参数缺失时判据直接把该运行视为处于受保护范围 —— 文件里写什么都改变不了准入判定）；剩下的路径是这些内容来源之一注入一个**非空的 `sonar.pullrequest.key`**，把 Task 翻转成 PR 模式 —— 见下面的信任边界警告。

**模板接线事实（判据锚点的依据，取自 catalog 源码：`task/sonarqube-scanner/0.7/sonarqube-scanner.yaml` 中的 `apply_branch_name_property` 函数，以及 `pipeline/java-image-build-scan-deploy/0.3` 的 sonar 参数透传块 —— 两者都在你环境的 catalog 仓库里，可以逐行核对）**：官方 0.3 模板把 `sonarBranchName` 硬接到 **`$(params.gitRevision)`** 上 —— 构建哪个 revision 就传哪个；调用方无法独立指定分析目标。两个门禁开关 `enableScanQualityGate` / `enableAnalyzeQualityGate` **不被透传**（模板只透传 `sonarHostURL` / `sonarProjectKey` / `sonarBranchName` / `sonarProperties` 这四个参数），所以它们保持 Task 侧的默认值 `"true"`。因此对官方模板的运行而言，规则 ③ 是**纵深防御**：开关缺失时永远放行；它真正拦的是那些绕开模板接线、显式关掉某个开关的自建 / 改造形态。而"这是不是一次受保护分支构建"，锚定在 `sonarBranchName` 的取值上。

**平台触发链的参数映射（规则 ③ 锚点背后的前提）**：

- **合入后触发（push）**：revision 类参数是**分支名**（例如 `release-4.10`），而不是 commit SHA —— commit SHA 走单独的 `git-commit` 参数，而 `pull-request-number` 是一个空占位符。→ 规则 ③ 的"分支名锚点"在平台的 PaC 触发链上（带 `pipelinesascode.tekton.dev/*` 标签的运行）**成立**。
- **PR 触发**：revision 是**源分支名**，同时带有 `target-branch`（目标分支）与非空的 `pull-request-number`。→ 源分支名匹配不上受保护正则 → 规则 ③ 跳过、PR 构建不被拦 —— 正是设计好的行为。
- **切换环境 / 触发器绑定时必须成立的那一条前提**：revision 类参数映射的是分支名而不是 SHA；如果某个环境的绑定把它映射成 SHA，规则 ③ 的锚点就失效了 —— 要么修触发器绑定，要么改锚点。**这是本节唯一一条无法从策略自身验证的信任前提；如何检查**：取一次真实的平台触发运行，看 revision 类参数的取值是分支名还是 40 位十六进制（`kubectl -n <ns> get pipelinerun <run> -o jsonpath='{.spec.params}'`），或者直接读触发器绑定中的变量映射（PaC 在 `.tekton/*.yaml` 里用 `{{revision}}` / `{{source_branch}}` / `{{target_branch}}`）。
- **顺带的一个升级机会**：PR 事件在触发层就已经带有 `target-branch`（它比 `sonar.pullrequest.base` 更靠近事件源，是触发器注入的而不是用户敲进去的）。官方模板目前没有把它透传给扫描器；等到模板透传 target-branch 的那一天，规则 ④ 应当把锚点换成它，并可以评估提升为 Enforce —— 信任根仍然是"由平台触发链创建的运行"；手工构造的运行照样能伪造那个参数，那一层由 [§4.5.4](#s4-5-4) 的入口封堵兜底。

**关键判据**（规则 ② 规范形态门禁 + 规则 ③ 门禁）—— 先整体拒绝契约之外的形态，再用分支参数把范围收敛到"对受保护分支（或默认分支）的一次分析"，最后拒绝"门禁被显式关掉"；PR / 特性分支构建在规则 ③ 的前置条件处就已跳过（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：
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

**本节中"缺失"的语义分三种走向** —— `sonarBranchName` 缺失或为空白：**落入规则 ③ 的受保护范围**（没有分支取值时扫描器分析的是项目默认分支 —— 正是被保护的对象；SonarQube 社区版不支持分支分析、只能省略该参数，所以这样处理是把它纳入治理，而不是误拒或豁免）；门禁开关缺失：继承 Task 的可信默认值 `"true"` 并放行（官方模板本来就不透传这两个参数）；`sonarBranchName` 非空但匹配不上受保护正则：规则 ③ **跳过**并放行 —— PR / 特性分支构建不带分支准入约束。真正无条件失败关闭的，是规则 ①（hub 来源被换掉）与规则 ②（规范形态），它们在任何场景下都会拒绝。

:::warning 为什么不复刻 Task 的解析语义：那条路永远收敛不了，而收窄输入面可以

`sonarProperties` 是一个**数组**参数，Task 会把它逐元素合并进 `sonar-project.properties`（`writePropertiesBatch` → `replaceValues`，同一个键后面的值覆盖前面的），随后这个文件被**两拨代码**消费：中间那几处 `^[#]*\s*<key>=` 的 grep（决定 PR 还是分支模式、以及哪些行会被删除），以及最终真正决定"扫描哪个分支"的 `java.util.Properties`（`#` 行是注释、行首空白被丢弃、`tr -d ' '` 删空格但不删制表符……）。本节曾经沿着"照抄消费者语义"这条路迭代判据 —— 每一轮修掉一批绕过 / 误拒，每一轮又暴露出下一批：注释掩护、行首换页符、取值为制表符的 PR key、一个元素里内嵌换行变成两条属性行。根因不是哪个正则不够严，而是**这个承诺本身封闭不了**：Task 合并的属性来源除了请求，还有仓库与 workspace 里的文件（见信任边界警告），而准入永远只能看到其中一部分 —— 而且每提高一档精度，判据就与 Task 的私有实现耦合深一档，Task 一升级就失配。

所以本节改为**收窄支持面**：规则 ② 只允许规范形态 —— `sonarBranchName` 不含换行、`sonarProperties` 每个元素恰好是一条规范的 `key=value`、受管键走各自的专用参数、PR 声明唯一且取值不含空白 —— 而**其余一律拒绝，不做解释**。判据随之坍缩 —— 实际分支就是 `sonarBranchName` 参数（缺失即默认分支），"是不是 PR 分析"就是那一条 key 声明是否非空；"最后一条胜出""注释算不算声明"这类问题，在已经被放行的输入上**根本无从提起**。

**代价，明说**（全部落在失败关闭方向，而且拒绝消息直接给出修法）：

| 被拒绝的形态 | 推荐写法 |
|---|---|
| 把 `sonar.branch.name=` / `sonar.host.url=` / `sonar.projectKey=` / 凭据类键 / `sonar.qualitygate.*` 写进 `sonarProperties` | 改用专用参数 `sonarBranchName` / `sonarHostURL` / `sonarProjectKey` 等 —— 即便注入的值会被参数覆盖也照样拒绝，这样判据就不必再回答"哪个入口生效" |
| 注释行（`#…`）、行首空白、单个元素内嵌换行 | 一个数组元素恰好是一条 `key=value`；注释不要放进参数 |
| `sonarBranchName` 参数取值中含换行（`\n` / `\r`）—— 写文件时 sed 会把它拆成两行，第二行可以冒充 `sonar.branch.name=<受保护分支>` | 分支名本来就不含换行；去掉即可 |
| 重复声明 `sonar.pullrequest.key` / `.base`，或者取值中含空白 | 每种恰好写一条，取值中不含空白（平台注入的空 key 那一组属于规范形态，照常放行） |

`sonarBranchName` 缺失**不在被拒名单里** —— 它落入规则 ③ 的受保护范围，按默认分支处理（社区版场景照常合规；见上文"缺失"那一段）；代价是"参数缺失 + 仓库属性文件把分析指向某个特性分支 + 门禁被显式关掉"这个组合会被误拒 —— 仍然是失败关闭方向，记录为 [§2.5](#s2-5) 第 19 条。

**这条教训比那些正则本身更值钱**：一条判据，要么复刻**最终消费者**的解析语义，要么**让复刻变得没有必要**。只有当输入面已经被收窄到消费者没有腾挪空间时，复刻才是可维护的；输入越自由，复刻就越像是别人那个解析器的影子实现 —— 任一侧改一行，两者就分叉，而分叉不会报错。在问"这种形态怎么建模"之前，先问"这种形态能不能禁掉"。

**这也不是 sonar 独有的**：Tekton 的校验 webhook 只保证 `spec.params` 中**参数名**唯一（[§4.2.5](#s4-2-5)）；它管不到**单个数组参数内部的元素**。对于任何把数组参数当作"配置列表"来消费的 Task，判据都应当先为元素固定一种规范形态并拒绝契约之外的东西，而不是假定第一条（或最后一条）就是生效值。

:::

:::warning 为什么不能写成"分支必须在受保护集合内"

最直觉的写法是无条件断言：任何匹配不上 `^(main|release-.*)$` 的 `sonarBranchName` 一律拒绝。在官方模板下，这是**整体误伤**：模板把该参数硬接到 `$(params.gitRevision)`，于是**特性分支构建与 PR 触发的构建全部在准入阶段被拒** —— PR 永远过不了 CI，也就永远合不进去。而它想防的那件事 —— "把分析指向别的分支来粉饰结果" —— 在官方模板画像下已经封闭（参数无法独立指定 + [§4.1.1](#s4-1-1) 锁模板 + 本节规则 ② / [§4.2.5](#s4-2-5) 禁止 `sonarProperties` 覆盖）。

一并记住语义边界：`sonarBranchName` 是**分支分析**的目标，**不是 PR 分析的目标**。当最终配置里带有非空的 `sonar.pullrequest.key`（PR 分析模式）时，Task 会**删掉** `sonar.branch.name` —— 对这样一个**在该场景下失效的参数**做无条件断言，正是"只在一种场景成立的判据被 Enforce 到所有场景"的教科书式失效形态。PR 分析的目标分支在 `sonar.pullrequest.base` 里，而它是用户可控参数 —— 规则 ④ 用"只在声明了**非空**的 `sonar.pullrequest.key`（真实 PR 分析）且目标受保护时才校验"的尽力而为语义来处理；**不安装规则 ④ 时，PR 阶段就没有门禁** —— 两种形态都是可接受的设计；合入之后，规则 ③ 在请求参数层提供严格约束，而端到端保证还需要下面列出的内容治理前提同时成立。

:::

:::warning 信任边界：属性来源中仍有一条准入看不见的路径

Task 合并属性的来源不止请求。按 `sonarqube-scanner` 0.7 的实际顺序（`sonarqube-scanner.yaml` 中的 `src_props_file` / `ws_props_file` 段落）：被扫描仓库自带的 `sonar-project.properties` → `sonar-settings` workspace 中的同名文件 → 普通 Task 参数与 `sonarProperties` → `sonar-credentials` 的连接器属性 → 最后由 `apply_branch_name_property` 选定分支模式还是 PR 模式。**准入只能看到参数这一步。** 本节的 37 个探针也全都是参数形态：它们证明的是请求参数契约，而不是文件 / 连接器内容没有注入同名属性。

在分支取值这一侧，判据已经对文件来源免疫：参数非空时，`apply_branch_name_property` 会用参数**覆盖**从文件合并来的 `sonar.branch.name`；参数缺失时，规则 ③ 直接把该运行视为处于受保护范围 —— 任何文件里写的分支值都改变不了准入判定，最坏情况是失败关闭方向上的一次误拒（[§2.5](#s2-5) 第 19 条）。于是只剩**一条**准入堵不住的路径：仓库、`sonar-settings` 或 `sonar-credentials` 中的内容注入一个**非空的 `sonar.pullrequest.key`**，把 Task 翻转成 PR 模式（`sonar.branch.name` 被删掉），于是一次本该是"受保护分支分析"的运行悄悄变成了 PR 分析 —— 门禁开关一个都没被动过，而对受保护分支的分析压根没有发生。这属于内容治理边界，不是 Kyverno 的参数判据能封住的：仓库内容由 [§2.1](#s2-1) 的仓库治理与代码评审兜底；`sonar-settings` / `sonar-credentials` 必须是经过评审的对象、以不可变方式引用且内容受控，它们的漂移属于 [§2.3](#s2-3) 的契约 1。**生产验收必须补上一项内容侧检查**：确认这三个来源都不含非空的 `sonar.pullrequest.key`，并在它们变更时重新核对；只有那一条成立之后，规则 ③ 才从"请求参数保证"上升为本文所声称的合入后保证。这条残余路径记录为 [§2.5](#s2-5) 第 18 条。

:::

:::warning 把本节当范式复用之前，先给"场景选择字段"做一次充分性检查

本节演示的通用形态是"**把判据按场景条件化，而不是无条件 Enforce**"。在把它移植到另一个参数 / 另一个 Task 之前，先确认你挑的那个"场景选择字段"**确实决定了最终语义** —— 三个问题，一个都不能跳：

1. **它是唯一入口吗？** 一种语义往往有好几个配置入口。本节的 `sonarBranchName` 就是历史反例：它看起来是分析目标的唯一来源，但请求里的 `sonarProperties` 同样能注入 `sonar.branch.name=`；再往外还有准入看不见的属性文件。**能收窄就不要建模**：现在的规则 ② 直接禁掉了多余的请求侧入口，规则 ③ 只读保留下来的那一个参数入口；准入看不见的文件 / 连接器来源，则被显式列为内容治理前提，而不是在 Kyverno 里继续复刻解析器。**同一个入口出现多次也算多入口** —— 数组参数内部同键条目重复时，生效的是消费者合并之后活下来的那一条，而一条取 `[0]` 的判据等于把"哪条胜出"的选择权又交回给了请求方。
2. **会不会有某个场景让消费者忽略它？** 本节的 `sonar.branch.name` 在 PR 模式下会被 Task 删掉（失效参数）—— 对它无条件断言就是整体误伤（见上一个警告）。
3. **你的判据算出来的值，和 Task 实际使用的值是同一个吗？** 判断方法只有一个：**读消费者的源码**（本节读的是 `apply_branch_name_property` 的合并顺序）；靠参数名和文档措辞去推断是不够的。

三条都过了，才谈得上"条件化"。漏掉第 1 问更危险：那样条件化出来的判据看起来有保证，实则带洞 —— 比无条件 Enforce 更难被发现。

:::

**扩展 / 升级时必须一起改的地方**（四条规则各自带有一份判据；漏掉任何一处，后果永远是**静默跳过** —— 策略还在，报告干净，实际什么都没锁住）：

| 你要做的变更 | 必须同步改动的位置 | 漏掉一处的后果 |
|---|---|---|
| 扫描器版本升级（0.7 → 0.8） | **四条规则各自的 `taskVersion` 前置条件**（每条一处，共 4 处）；同时针对新版本重新核对四项契约事实：门禁开关的参数名与默认值；"非空 `sonar.pullrequest.key` ⇒ 切换到 PR 模式"这一行为；规范形态门禁中的受管键清单是否仍与新版本的参数面对得上；以及 `apply_branch_name_property` 是否仍然把 `sonarBranchName` 逐字写进属性文件（这决定了参数内的换行是否仍需禁止） | 四条规则的身份全部匹配不上 → 统统静默跳过；来源完整性、规范门禁与门禁保证一起消失 |
| 增删受保护分支模式（例如新增 `hotfix-*`） | **两处正则字面量必须同时改**：规则 ③ 前置条件中的 `^(main|release-.*)$`，以及规则 ④ 的 `prBaseProtected` 正则 `^sonar[.]pullrequest[.]base=(main|release-.*)$` —— 之所以保留两份而不提取共享变量，是因为它们锚定的是不同字段（分支参数 / PR base 声明） | 只改一处 → 另一处仍按旧的分支集合求值；分支侧与 PR 侧的判定悄悄分叉，而且不报错 |
| 新增第三个门禁开关 | 规则 ③ 与 ④ 中的 `<switch>Present` / `<switch>` 变量对及 `gateWeakened` 表达式（每条一处，共 2 处），以及两条 `message` 中的回显 | 新开关可以随意关掉；判据看不见它 |
| 放宽 / 收紧规范形态（例如允许某个受管键改走 `sonarProperties`） | 规则 ② 的 `propsGovernedKey` 清单及其 `message`；如果该键参与场景选择，规则 ③ / ④ 的取值读取变量必须跟着改 | 漏改清单 → 该键继续被拒（整体失败关闭式误拒）；或者把该键从清单里去掉却没有评估后果 → 悄悄开了个口子 |
| 修改 hub catalog 名 | 四条规则的 `taskCatalog` 前置条件 + [§4.0.3](#s4-0-3) 的占位符替换表（该表那一行也注明了**参数键 `[?name=='catalog']` 不能替换**） | 与版本升级相同：统统静默跳过 |

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

:::details 验证探针（37 个；每一种真实触发场景都有放行用例）

如何执行：第 1-4 与 7-37 项用 `kubectl create --dry-run=server`（Enforce 判定可同步看到）；第 5、6 项是 Audit 规则的观察项 —— 请**真的创建**它们，然后到 PolicyReport 中对账 `fail` / `pass`；做完之后按 [§4.0.4](#s4-0-4) 清理探针对象。部署之后，按 [§3.5](#s3-5) 的上线流程、用 [§3.4.1](#s3-4-1) 的骨架 B 重跑这张表做复验。

| 探针 # | 场景 / 构造 | 预期 |
|---|---|---|
| 1 | 受保护分支，官方模板形态：`sonarBranchName: main` + `sonarProperties` 只含合法条目（例如 `sonar.java.binaries=target/classes`），门禁开关**缺失** | 放行（开关缺失 = 可信默认值） |
| 2 | 受保护分支，显式合规：`sonarBranchName: release-1.2` + `enableScanQualityGate: "true"` | 放行 |
| 3 | **特性分支构建，门禁关闭**：`sonarBranchName: feature-x` + `enableScanQualityGate: "false"` | **放行**（规则 ③ 跳过 —— 该场景的放行用例，证明 PR / 特性分支构建不会被整体拦死） |
| 4 | **push 注入形态**：`sonarBranchName: main` + `sonarProperties` 含整组 `sonar.pullrequest.*`（**key 为空**），开关缺失 | 放行（空 key 的整组注入属于规范形态；照常判为分支模式，且门禁未被削弱） |
| 5 | PR 尽力而为的正向用例：`sonarBranchName: feature-x` + `sonar.pullrequest.key=1770` + `sonar.pullrequest.base=main` + `enableScanQualityGate: "false"` | 放行 + PolicyReport **fail**（`pr-target-protected-gates-audit`；Audit 不拦截） |
| 6 | PR 尽力而为的负向用例：`key=1770` + `base=feature-y` + 门禁关闭 | 放行，无 fail（目标不受保护；这是被接受的失败开放） |
| 7 | 合法 settings：`sonarBranchName: feature-x` + `sonarProperties` 只含 `sonar.exclusions=**/vendor/**` + 门禁关闭 | 放行 |
| 8 | **取值中含受管键的合法属性**：`sonar.exclusions=**/sonar.branch.name=main/**` + 特性分支构建，门禁关闭 | 放行（前缀锚定在条目开头；取值内部的子串不算声明） |
| 9 | PR 模式下无误报：`sonarBranchName: main` + `sonar.pullrequest.key=1770` + 门禁关闭 | 放行（非空 key ⇒ Task 不做分支分析，规则 ③ 跳过；PR 阶段属于规则 ④，没有 base 声明它不触发） |
| 10 | 非受管键的取值中含空格：`sonar.projectName=My App`，开关缺失 | 放行（规范形态只约束键的形状与受管键；它不禁止取值内部含空格） |
| 11 | **社区版形态**：`sonarBranchName` 缺失 + `sonarProperties` 只含合法条目，开关**缺失** | 放行（分支缺失作为默认分支进入受保护范围，但门禁未被削弱 —— 合规的社区版用法不会被误拒） |
| 12 | 注入分支键：`sonarBranchName: feature-x` + `sonarProperties` 含 `sonar.branch.name=main` + 门禁关闭 | **拒绝**（`sonar-props-normative-form` —— 受管键不得经由 `sonarProperties` 传递；即便参数会覆盖它也照样拒绝） |
| 13 | 注入分支键，门禁全开：`sonarBranchName: main` + `sonar.branch.name=release-1.2`，开关缺失 | **拒绝**（规范形态门禁与场景无关：即便没有削弱门禁也照样拒绝） |
| 14 | 夹带后缀：`sonar.branch.name=main;sonar.foo=bar` + 门禁关闭 | **拒绝**（命中受管键前缀） |
| 15 | 注释行：`sonarProperties` 只含 `#sonar.branch.name=main` + 特性分支构建，门禁关闭 | **拒绝**（行首 `#` 不是规范的 `key=value` —— 不要把注释写进参数） |
| 16 | 行首空白：` sonar.branch.name=main`（一个前导空格；Tab 同理）+ 门禁关闭 | **拒绝**（非规范形态 —— 这正是从前松散前缀匹配留下的绕过口子；整类拒绝） |
| 17 | 行首换页符 `\f` + 门禁关闭 | **拒绝**（同上） |
| 18 | 行首垂直制表符 `\v` + 门禁关闭 | **拒绝**（同上；契约不去解释消费者会不会接受 —— 见 [§2.5](#s2-5) 第 19 条） |
| 19 | 两条 exclusion 挤在一个元素里、中间内嵌换行 + 特性分支构建，门禁关闭 | **拒绝**（一个元素必须恰好是一行 `key=value` —— 拆成两个数组元素即可放行） |
| 20 | 换行夹带：`sonar.exclusions=x` + 换行 + `sonar.branch.name=main` + 门禁关闭 | **拒绝**（非规范形态 + 受管键，双重命中） |
| 21 | **重复 PR key**：一条 `sonar.pullrequest.key=1770` 与一条 `sonar.pullrequest.key=` + 门禁关闭 | **拒绝**（声明有歧义 —— 重复直接拒绝；不再建模"最后一条胜出"） |
| 22 | **取值为空白的 PR key**：`sonar.pullrequest.key= `（等号后一个空格）+ 门禁关闭 | **拒绝**（key / base 的取值禁止空白 —— 不再建模 `tr -d ' '` 的置空语义） |
| 23 | **取值为制表符的 PR key**：`sonar.pullrequest.key=` 后跟一个 Tab + 门禁关闭 | **拒绝**（同上） |
| 24 | **重复注入分支**：一条 `sonar.branch.name=feature-x` 与一条 `sonar.branch.name=main` + 门禁关闭 | **拒绝**（命中受管键；重复声明时，连"哪条胜出"都不必回答了） |
| 25 | **端点注入**：`sonarProperties` 含 `sonar.host.url=http://evil.example` | **拒绝**（受管键 —— 端点在 TaskRun 层同样被锁定，而不只是在 [§4.2.5](#s4-2-5) 的 PipelineRun 层） |
| 26 | 类型回退：`sonarProperties` 以 **object** 传入 | **拒绝**（JSON 编码之后匹配不上规范的 `key=value` 形态 —— 属于契约之外的形式，不再"跳过并放行"） |
| 27 | 类型回退：`sonarProperties` 以**裸字符串** `sonar.branch.name=main` 传入 | **拒绝**（归一化成单个元素后按规范形态判定：命中受管键） |
| 28 | **分支缺失 + 门禁关闭**：`sonarBranchName` 缺失 + `enableScanQualityGate: "false"` | **拒绝**（`protected-branch-gates-strict` —— 缺失 = 默认分支分析，落在受保护范围内；这正是旧判据静默跳过的那个缺口） |
| 29 | **分支为空白 + 门禁关闭**：`sonarBranchName: ""` + `enableScanQualityGate: "false"` | **拒绝**（同上；空白取值等同于缺失） |
| 30 | 受保护分支，门禁显式关闭：`sonarBranchName: main` + `enableScanQualityGate: "false"` | **拒绝**（`protected-branch-gates-strict`） |
| 31 | 受保护分支，开关为显式空字符串：`sonarBranchName: main` + `enableAnalyzeQualityGate: ""` | **拒绝**（显式空字符串 ≠ 缺失） |
| 32 | hub 来源被换掉（请求级 `url`）+ `sonarBranchName: feature-x` | **拒绝**（`hub-source-integrity` —— 与场景无关；特性分支照样被拒） |
| 33 | 伪造出完全相同的标签，但真实 Task 身份不是 `catalog/sonarqube-scanner/0.7` | 四条规则全部跳过；无误报 |
| 34 | 回归用例：`sonarBranchName` 以**数组**传入（`[feature-a, feature-b]`）+ 门禁关闭 | 放行（归一化取第一个元素，它非空且匹配不上受保护正则 → 规则 ③ 跳过；**不会产生规则错误** —— 类型错误由 Tekton 自身的参数校验兜底） |
| 35 | **经参数的换行夹带**：`sonarBranchName` 取值为 `feature-x` + 换行 + `sonar.branch.name=main` + 门禁关闭 | **拒绝**（`sonar-props-normative-form` —— `replaceValues` 用 sed 写文件时，该取值会被拆成两行，Java 取最后一行的 `main`；判据禁止 `sonarBranchName` 中出现换行，与 `sonarProperties` 平行地封住这个入口） |
| 36 | **经参数的回车夹带**：同上，但把 `\n` 换成 `\r` | **拒绝**（对 Java properties 而言 `\r` 同样是行终止符；一并禁止） |
| 37 | 反向对照：带斜杠 / 点号的合法分支名（`release-1.2/hotfix`）+ 门禁开启 | 放行（只禁止换行；正常分支名不受影响 —— 无误报） |

:::

#### 4.2.5 官方模板的提前拦截（辅路径，真实画像） {#s4-2-5}

- **治理什么**：当使用官方模板 `java-image-build-scan-deploy` 0.3 **或** `python-image-build-scan-deploy` 0.3 时，**在 PipelineRun 创建的那一刻**就拦住那些把门禁关掉、或把门禁架空成形式的调用。
- **难在哪里**：这两个模板的门禁藏着三层递进的陷阱，只对齐 `when` 取值的朴素做法必然漏判 —— ① **默认压根不扫描**：`sonarURL` 默认为空，而 sonar 任务由 `when` 守卫，于是整个代码扫描被跳过（opt-in 陷阱，契约 3 的真实实例）；② **被调度 ≠ 真的扫了**：把 `trivyExtraArgs` 设成 `--help`，trivy 会退出 0、不产出任何报告，而 **TaskRun 照样是绿的**；③ **即便真扫了也可能是假的**：`sonarProperties` 能覆盖已批准的配置，`tlsVerify=false` 会打开 `--insecure`，`images` 有多个元素时 buildah 全部推送而 trivy 只扫第一个，workspace 还能被换成未经评审的来源。
- **策略怎么分层**：① 锁定 Hub 来源身份（拒绝请求级 `url`；显式 `type` 只能是 `artifact`）→ ② 强制门禁真的开着（`sonarURL` 非空、`skipTrivyScan` 恰为 `"false"`、`trivyExitCode` 未被设为只出报告的 `""` / `"0"`、`trivySeverity` 覆盖必需的严重级别、`trivyExtraArgs` 为空）→ ③ 强制实际配置不被架空（没有覆盖受管键的 `sonarProperties` 条目、没有覆盖 `sonarProjectKey`、`tlsVerify` 只能是可信默认值或恰为 `true`、`images` 非空且 shell 安全、严格画像下限定为单个镜像）→ ④ 把门禁相关 workspace 的来源限制为经过评审的对象 —— **共用的 6 个**（`sonar-settings` / `sonar-credentials` / `sonar-certificate` / `registry-config` / `ca-bundle` / `trivy-config`），再加上语言相关的部分：java 多 5 个 maven 的（共 11 个），python 多 `pip-conf`（共 7 个）。
- **治理不了什么**：这是**辅路径** —— 它只看得到 PipelineRun 上**显式写下**的内容；最终实际取值仍然在 TaskRun 层判定（[§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)）；而且本节**看不到运行结果** —— 扫描实际报了什么，是 [§4.4.1](#s4-4-1) 的职责。

:::info 上线之前，核对模板实际声明的 workspace

本节的 workspace 白名单是按 `java-image-build-scan-deploy` 0.3 的 **16** 个与 `python-image-build-scan-deploy` 0.3 的 **12** 个写的。**白名单是逐个枚举名称的；模板一改 workspace，白名单必须跟着改** —— 所以上线之前请对照实际解析出来的定义核实，而不要照抄本文的数字：

```bash
# On the cluster running Tekton, list the workspaces the template actually declares and verify them. The two fill-in values come first:
PIPELINE_NS='<your-pipeline-namespace>'
REAL_RUN='<one-real-run>'
kubectl -n "$PIPELINE_NS" get pipelinerun "$REAL_RUN" \
  -o jsonpath='{.status.pipelineSpec.workspaces[*].name}'
```

如果对不上，请按你自己那一份重新枚举。特别注意**某个 workspace 消失了**的情况：对应判据会恒为假 —— 看起来是绿的，实际什么都没锁住。

:::

本节的完整画像拆成**三条规则**，因为两个官方模板之间真正不同的，只有那一小块构建输入：

| rule | 覆盖的模板 | 治理什么 |
|---|---|---|
| `quality-gates-must-stay-enabled` | java 0.3 **与** python 0.3 | Hub 来源身份、Sonar 门禁、Trivy 门禁、TLS、`images`，以及 **6 个扫描 / 配置类 workspace**（`sonar-settings`、`sonar-credentials`、`sonar-certificate`、`registry-config`、`ca-bundle`、`trivy-config`） |
| `java-build-inputs-must-stay-approved` | 仅 java 0.3 | 5 个 maven 参数 + 5 个 maven workspace |
| `python-build-inputs-must-stay-approved` | 仅 python 0.3 | 5 个 `preBuild*` / `pythonImage` 参数 + `pip-conf` workspace |

门禁这一面之所以能共用一条规则，是因为两个模板在门禁判据触及的所有字段上**参数名与类型完全一致** —— trivy 侧（`skipTrivyScan` / `trivyExitCode` / `trivySeverity` / `trivyExtraArgs`）连默认值都逐字段相同；sonar 侧参数名相同（**但 `sonarProperties` 的默认值不同**：java 多一条 `sonar.java.binaries=target/classes`；本节判据只要求"不被请求侧覆盖"，从不与默认值比较，所以这一点无关紧要）。差异集中在语言相关的构建输入上（java 的 maven 组 ↔ python 的 `preBuild*` 组，workspace 16 ↔ 12）。采用方式同样分层：最小版的 `trivy-gate-must-stay-on` 属于最小硬保证，而本表的完整画像是**可选的环境画像** —— 按模板与环境选择性安装（最小集清单见 [§4.0.2](#s4-0-2)）；并不是每一次部署都必须照抄。

**两个模板共有 11 个同名 workspace，而本节只治理其中 6 个。** 其余 5 个 —— `source`、`git-basic-auth`、`git-ssh-directory`、`git-ssl-ca-directory`、`kubeconfig` —— **不在这三条规则的判据里**；它们分别属于 Git / 源码策略以及 [§4.5.5](#s4-5-5) 发布目标策略的职责（逐个 workspace 的分工见下面的职责表）。照抄本节规则并不意味着这 11 个全都被锁住了。

模板 0.3 的真实形态是这样的：`sonarURL` 默认为空，而 sonar 任务由 `when: sonarURL notin ["", " "]` 守卫 —— **默认情况下代码扫描被整体跳过**；trivy 任务由 `when: skipTrivyScan in ["false"]` 守卫，也就是说**只有取值恰为 `"false"` 时它才会被调度**。

但"任务被调度了"仍然不等于"它真的扫了"。漏洞门禁由 `trivyExitCode` 控制，**默认 `"1"`，即默认开启**（参数契约基线见 [§3.2](#s3-2) 的版本矩阵）—— 所以策略要防的不是"忘了打开"，而是**被显式关掉**（设成 `"0"` 或空字符串）。另外，`trivySeverity` 决定哪些严重级别计入门禁；把它收窄到只剩 `LOW`，同样等于把高危发现放行。往 `trivyExtraArgs` 里塞 `--help` 之类的参数，会让 trivy 退出 0、不产出任何报告，而 TaskRun 照样成功。`tlsVerify=false` 会让 Task 带着 `--insecure` 运行。buildah 会推送 `images` 的**每一个**元素，而 Trivy 只扫**第一个**，所以严格画像必须把它限定为单个镜像。Sonar 0.7 在已批准的 URL / project key 之后仍会继续应用 `sonarProperties` 与凭据；Maven 0.6 的工作目录、goals、运行镜像，以及它实际消费的那些 workspace，同样会改变构建及其信任来源。

:::warning 本节治理的是扫描门禁，不是构建与推送

模板以结构化形式把 `trivyExtraArgs` 传给 `trivy-scanner` 0.6（`scanType` / `scanTargets` / `severity` / `exitCode` / `extraArgs`），所以这一侧已经不存在"参数拼接成 shell 命令字符串"的注入面。

**但不要把这理解成"模板已经没有注入面了"**：同一个模板里，`buildExtraArgs` 与 `pushExtraArgs` **仍然是 string 类型**，它们的参数文档明确写着"必须由调用方做净化以避免命令注入"；`containerfilePath` / `buildContext` 也仍然会流入后续脚本的数据路径。本节的策略**不**治理构建与推送侧 —— 扫描门禁的每个参数都写对了，构建也可能早已被做了手脚。

:::

:::warning 要与最终实际配置精确对齐，而不只是对齐 when 取值

朴素做法 —— "只拒绝 `sonarURL==''`、只拒绝 `skipTrivyScan=='true'`" —— 有直接的绕过取值；再进一步、只保证任务被调度，仍然会漏掉三类：把 `trivyExitCode` 显式关成 `"0"`、把 `trivySeverity` 收窄到只剩低危，以及 `trivyExtraArgs: ["--help"]` 这类"退出 0 但不产出报告"的调用 —— 外加后续对已批准配置的参数 / workspace 覆盖。

因此完整画像禁止 PipelineRun 显式覆盖 `sonarProjectKey`，**禁止任何覆盖受管配置的 `sonarProperties` 条目**（见下一段），要求 `tlsVerify` 使用可信默认值或恰为 `true`、`images` 非空且 shell 安全，并把可选的 Sonar / Maven / registry / pip 类 workspace 限制为经过评审的对象。

**`sonarProperties` 按内容判定，而不是按是否存在判定**（与 [§4.2.4](#s4-2-4) 共用的判据形态）：该参数是传递合法分析设置（排除目录、覆盖率报告路径等）的**唯一通道**，而且在触发路径上平台还会通过它注入整组 `sonar.pullrequest.*` —— **"出现即拒绝"会把这一整类正常请求拦死**。按扫描器 0.7 的合并顺序（task params → `sonarProjectKey` → **`sonarProperties`** → 凭据 → 分支名 → 质量门禁归一化），这里真正能被覆盖的受管键只有三类：分析端点 `sonar.host.url`、项目身份 `sonar.projectKey`，以及 `sonarBranchName` 缺失时的 `sonar.branch.name`；凭据类键（`sonar.login` / `sonar.token` / `sonar.password`）会被后面的凭据步骤覆盖，`sonar.qualitygate.*` 会被最后的归一化覆盖 —— 两者目前都覆盖不了，但判据照样把它们列上，**这样将来合并顺序调整时就不会悄悄开口子**。**每一条的形态同样被判定**（与 [§4.2.4](#s4-2-4) 规则 ② 同一道规范门禁）：只有当条目是规范的 `key=value` 时，对受管键做前缀匹配才可靠 —— 带行首空白的写法能躲过前缀比较，却照样被 Task 逐字写进属性文件并在 Java 侧生效，所以非规范条目（行首空白、`#` 注释、单个条目内嵌换行）一律拒绝。

**示例中的对象名必须替换成你环境中真正批准的 Secret / ConfigMap**（那一批 `approved-*`），**而且 `<approved-sonar-url>` / `<approved-maven-mirror-url>` / `<approved-maven-cert-path>` 这三个取值也必须换成你自己的** —— 它们不是对象名，最容易被漏掉，而漏掉的后果是**合规请求被拒**：`sonarURL` 判据是无条件比较（**所有**请求都会被拒），而两条 maven 判据带有"只在显式传入时才判定"的前置条件（只有显式配置了 mirror / cert 的请求会被拒）。逐项的作用范围见 [§4.0.3](#s4-0-3) 的占位符表。模板升级时，请重新评审每一个字段与合并顺序。

:::

:::info Sonar 0.7 analyze 阶段的传输校验

`sonar-scanner` 步骤会把 `sonar-certificate` 导入 Java 的 truststore；而后续的 `sonar-analyze` 步骤调用 CLI 时带着 `--insecure-skip-tls-verify`。

**这不影响门禁本身的有效性** —— 质量阈值仍由 Sonar 服务端裁决，策略读取的 `code-scan-results` 仍然是服务端的结论。受影响的只是 analyze 阶段到 Sonar 服务器这一段传输上的证书校验。在多数部署中，Sonar 位于集群内网，而 `sonarURL` 被本节白名单锁定，所以实际暴露面收窄到内网可路由的路径攻击者；如果你的威胁模型包含这一类，那是 Task 侧的属性、准入策略改变不了 —— 请与 Task 维护者跟进。

:::

两个模板共有 11 个同名 workspace；java 另有 5 个 maven 的，python 另有 1 个 `pip-conf`（java 16 / python 12）。职责必须彻底拆清楚 —— 不要把"本节锁住了这些门禁类 workspace"误述成"所有 workspace 都受治理"：

| workspace | java / python | 职责边界 |
|---|---|---|
| `sonar-settings`、`sonar-credentials`、`sonar-certificate`、`registry-config`、`ca-bundle`、`trivy-config` | 6 / 6 | 由共用规则锁定：准入可见的来源类型与对象名；这些 workspace 会被 Task 读取，但策略不读 Secret / ConfigMap / PVC 的内部内容。其中 `trivy-config` 承载 trivy 的集中配置（`trivy.yaml`）与忽略规则 —— **它是一个坐在扫描门禁上的 workspace：绑定一个你可控的对象，就能在所有参数判据都是绿的情况下放松扫描** —— 所以判据对"绑定了，但不是那个 ConfigMap"（包括 PVC / Secret 来源）失败关闭 |
| `maven-settings`、`maven-server-secret`、`maven-local-repo`、`maven-cert` | 4 / — | 由 java 规则锁定；边界同上 |
| `pip-conf` | — / 1 | 由 python 规则锁定；`pip.conf` 决定包从哪里解析，所以未经评审的绑定就是一条供应链输入。不绑定是允许的 |
| `maven-trust-store` | 1 / — | Pipeline 0.3 会把它绑到 Maven 0.6 的同名 workspace，但 Maven 0.6 的执行逻辑从不读取它；这里的来源限制是一种**针对升级漂移的保守防御**，而不是"当前版本已经改变 Maven 信任"的证据 |
| `source` | 1 / 1 | 共享源代码与部署清单；源码身份、内容完整性以及源码到镜像的关联，属于可信检出模板、Git / 源码策略与供应链证明的职责 —— 不属于本节 |
| `git-basic-auth`、`git-ssh-directory`、`git-ssl-ca-directory` | 3 / 3 | Git 凭据 / SSH / CA；必须由单独的 Git URL / revision 与 workspace 来源策略批准；本节不做检查 |
| `kubeconfig` | 1 / 1 | 发布身份与目标；workspace 来源由 [§4.5.5](#s4-5-5) 精确批准，并与 RBAC 管控相结合 |

`trivy-config` 的判据**已经写进下面的完整策略**（四个变量 `trivyConfigCount` / `trivyConfigWorkspace` / `trivyConfigConfigMap` / `trivyConfigBad` 加上 `deny.conditions.any` 中对应的一条）；正反两格都在本节末尾的探针表里。当你自己扩展其他 workspace 时请记住：**只声明变量而不把它接进 `deny.conditions.any`，等于没加**。

**这些判据同时锁定了"来源类型"**：写法是 `xxxConfigMap != '<approved-object>'`，读的是 `.configMap.name`，所以把同一个 workspace 绑定为 **Secret / PVC / CSI / projected** 来源时，该字段为空 —— 一律拒绝。模板本身**并不**限制来源类型（它们只是可选 workspace）；**这是本文画像额外加的一道收紧**。**如果你们站点确实把某些配置放在 Secret 里**（例如一个携带凭据的 `sonar-settings`），不要删掉判据；改成读取对应字段、同时保持"绑定了就必须是批准对象"的形态 —— 例如 `(sonarSettingsWorkspace.configMap.name || sonarSettingsWorkspace.secret.secretName) != '<approved-object>'`，或者用 `contains([...], ...)` 把两种来源类型的对象名都批准；改完之后照旧跑正反向探针对（合规来源放行 / 换个对象被拒）。

:::warning 为什么这里的 [0] 是安全的：spec 侧的三项唯一性保证来自 Tekton

本节判据到处使用 `[?name=='x'] | [0]` —— 参数、resolver 参数、workspace 一概如此。它对"同名写两遍，策略只看到第一个"安全吗？**安全 —— 因为 Tekton 的校验 webhook 会先把请求拒掉**，策略根本见不到这样的对象：

| 构造 | Tekton 的报错原文 |
|---|---|
| 在 `spec.params` 中把 `trivyExtraArgs` 写两遍（第一处合规，第二处 `["--help"]`） | `expected exactly one, got both: spec.params[trivyExtraArgs].name` |
| 在 `pipelineRef.params` 中把 `version` 写两遍（第一个 `0.3`，第二个 `attacker-version`） | `expected exactly one, got both: spec.pipelineRef[version].name` |
| 在 `spec.workspaces` 中把 `trivy-config` 绑两遍（第一处是批准的 ConfigMap，第二处是恶意 PVC） | `workspace "trivy-config" provided by pipelinerun more than once, at index 0 and 1: spec.workspaces[1].name` |

所以 `spec` 侧的唯一性由 Tekton 保证，策略不必再数一遍（本节的 `trivyConfigCount > 1` 之类，只是与其他 workspace 判据保持同一形态的纵深防御，并非必需）。

**⚠️ 这项保证只覆盖 `spec`，绝不能外推到 `status`。** `status.results`、`status.conditions`、`status.skippedTasks`、`status.pipelineSpec.tasks` 都是由控制器写入的，而 **CRD 对其中任何一个都没有按名去重的约束**：**在准入时刻，同名条目可以出现两次，这足以绕过一条照抄 `[0]` 模式的策略**。所以每一条读取 `status` 的策略都必须显式要求"目标 result / condition 恰好只有一条"，终态守卫同样要计数而不是取 `[0]` —— 构造、A/B 证据与修法见 [§4.4.1](#s4-4-1) 中"读 status 时绝不要取 `[0]`"那条警告。

**而且这条规则要一层层数到底，而不是只数最外层。** `status.pipelineSpec.tasks[].taskRef.params` 是一个**嵌套在 status 里的参数列表**：即便外层已经数过"名为 `scan` 的任务恰好只有一个"，只要内层的 `kind` / `name` / `namespace` 仍然照抄 `[0]`，在前面插入一个诱饵参数就能让身份判据读到一个"干净"的值。[§4.1.4](#s4-1-4) 与 [§4.6.2](#s4-6-2) 中的 `scanRefParamsUnique` 正是那一层的计数守卫；**你自己每往 status 里下钻一层，就要问一次："这个列表有唯一性保证吗？"**

:::

##### 先看最小版本：只保证漏洞门禁没被关掉

如果你的需求就是"谁都不许把 trivy 门禁关掉"，那么**整条策略只要六条判据**（四个参数 + 两个 override 面），一并覆盖两个官方模板：
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

**第五条判据 `gateOverrideCount` 守的是一条完全绕开参数面的路径**：PipelineRun 可以通过 `spec.taskRunSpecs` 给单个任务附加 override，而 **`podTemplate.env` 会被注入该任务的每一个 step 容器**。于是一个所有参数都是绿的请求，只要带上

```yaml
  taskRunSpecs:
    - pipelineTaskName: trivy-scanner
      podTemplate:
        env:
          - name: TRIVY_SEVERITY
            value: LOW
```

就把扫描的实际严重级别收窄到只剩 `LOW` —— 而把 `trivySeverity` 参数留空是**合规的**（留空表示使用 trivy 自带的默认集合），所以那四条参数判据一条都不会触发。`serviceAccountName` 同理：它改变的是门禁 step 被允许做什么。**`stepSpecs` / `sidecarSpecs` 只携带 `computeResources`，所以资源调优仍然允许** —— 那一类 override 改变不了扫描行为，拒绝它属于过严。

**这条判据按 podTemplate 的"键"来判定，而不是"附加即拒绝"**：**调度类键** —— `nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName` —— 是允许的：把扫描任务调度到有缓存或专用污点的节点上是日常运维，拒绝它属于误判；其余所有键（`env`、`volumes`、`dnsConfig`、`securityContext`、`automountServiceAccountToken` 等，以及**将来新增的任何键**）一律拒绝。写成白名单而不是黑名单是刻意的：新字段默认落到拒绝侧，比漏掉更安全。`serviceAccountName` 仍然一律拒绝 —— **如果你们站点确实想给扫描器配一个专用 SA**，就把它从这条判据里摘出来，改写成 [§4.5.5](#s4-5-5) 那种批准名单形态（`contains(['<approved-scanner-service-account>'], serviceAccountName)`）；不要把整条条件删掉。

**有一处很容易踩的差别**：按任务的 `podTemplate` **不会**被 Tekton 的默认填充补上（缺失就是真的缺失），而运行级的 `taskRunTemplate.podTemplate` **永远不为空**（默认填充会把 `default-pod-template` 合并进去）。所以同样的"按键判定"模式只在按任务那一侧成立；在运行级，只能单独判定 `env`。

**第六条判据 `runWideEnvCount` 堵的是同一件事的运行级入口**：`spec.taskRunTemplate.podTemplate` 作用于本次运行的**每一个** TaskRun，所以在那里设置 env，等价于在 `taskRunSpecs` 里点名门禁任务 —— 而一条只看 `taskRunSpecs` 的判据对它完全是盲的。这一条**只判定 `env`**：运行级 podTemplate 里的 `nodeSelector` / `imagePullSecrets` / `tolerations` 都是正常配置，株连会造成大面积误拒。

**四条参数判据里，`trivySkipped` 是最容易被漏掉的一条**：`skipTrivyScan` 不是"扫描的一个选项" —— 它是 `trivy-scanner` 任务的 `when` 守卫。把它设成 `"true"`，任务根本不会被创建，于是另外三条参数判据**统统空转为假**，策略照样放行。**只判扫描参数而不判"扫描到底跑不跑"，等于没判。**

其余三条判据的权衡写在注释里；这里只强调"缺失"的语义 —— 它与多数白名单判据正好相反：

| 判据 | 参数未传时 | 为什么这样定义 |
|---|---|---|
| `trivySkipped` | **放行** | 模板默认是 `skipTrivyScan: "false"` —— 不传就是要扫；显式取值必须恰好等于 `"false"`（其他任何取值，包括空字符串，一律拒绝） |
| `trivyGateOff` | **放行** | 模板默认是 `trivyExitCode: "1"` —— 不传就是门禁开着。按参数契约，**只有 `""` 与 `"0"` 是仅出报告**，所以判据只拒绝这两个取值 —— 像 `"2"` 这样的非零码照样让运行失败，不构成关掉门禁的手段 |
| `trivySeverityBad` | **放行** | 空列表意味着 trivy 使用自带的默认严重级别集合，它比 `CRITICAL`+`HIGH` 更宽 —— 是更严，不是更松 |
| `trivyExtraArgsBad` | **放行** | 空数组只是"没有额外参数"；非空一律拒绝，理由见注释 |
| `gateOverrideCount` | **放行** | 没有 `taskRunSpecs` 就没有 override；被拒绝的只有"调度类键之外的 `podTemplate`，且**点名门禁任务**"以及任何 `serviceAccountName` —— 对其他任务的 override、`computeResources` 类 override，以及门禁任务上纯调度类的 `podTemplate`，都不受影响 |
| `runWideEnvCount` | **放行** | 没有运行级 `taskRunTemplate.podTemplate.env` 就没有注入；**只判定 `env` 这一项** —— 运行级的 `nodeSelector` / `imagePullSecrets` 等仍然允许 |

**前置条件锁定的是完整模板身份**（`resolver` + `kind` + `catalog` + `name` + `version`），而不只是名字。任何一项没锁住，"来自另一来源的同名 Pipeline"就会落进这条规则的判定范围 —— 而那是一个默认值完全不同的对象。反过来也要说清楚：**身份不匹配的请求会跳过 —— 也就是被放行**。"只能使用已批准的模板"是另一件事，由 [§4.1.1](#s4-1-1) 的模板白名单负责；两层必须一起安装。

:::warning 这条策略的承诺边界：只覆盖请求显式写下的内容

准确的表述是：它保证**没有人能通过 PipelineRun 的参数或按任务的 override 把漏洞门禁关掉** —— `skipTrivyScan` 跳不了扫描，`trivyExitCode` 设不成仅出报告的 `""` / `"0"`，`trivySeverity` 收窄不到漏掉高危，`trivyExtraArgs` 夹带不了绕过标志，门禁任务上不能带**调度类键之外**的 `podTemplate` override 或任何 `serviceAccountName` override（调度类键是允许的，见上面"按键判定"的说明），也不能通过运行级 `taskRunTemplate.podTemplate.env` 注入环境变量。

**有一条刻意保留的残余风险值得明说**：运行级 podTemplate 只判定 `env`，但它还有 `dnsConfig` / `securityContext` / `volumes` / `automountServiceAccountToken` 等字段 —— 理论上这些同样能改变门禁 step 的解析、运行身份或可读文件。判据没有株连它们，因为那样会连 `nodeSelector` / `imagePullSecrets` 这类日常配置一起拒掉；更严格的站点可以用同样的形态把这些字段纳进来，**但先想清楚这会拒掉哪些正常请求**。**而且有一条机制事实让"拒绝任何运行级 podTemplate"根本行不通**：Tekton 的默认填充 webhook 先于 Kyverno 执行，会把 `config-defaults` 的 `default-pod-template` 合并进每一次运行（在本文环境中是 `securityContext.fsGroup=65532`），所以准入看到的 `taskRunTemplate.podTemplate` **永远不为空** —— 只判定 `env` 这一项，是唯一既有效又无误报的形态。

**运行级的 `spec.taskRunTemplate.serviceAccountName` 同样不被判定** —— 这是有原因的，读者需要知道边界在哪。`taskRunTemplate` 只有 `podTemplate` 与 `serviceAccountName` 两个字段（用 `kubectl explain` 核实过），而这条策略治理的是**扫描结论**：门禁 step 跑的是 Task 自带的固定脚本，不使用集群凭据，所以更宽的运行身份**改变不了扫描结论** —— 真正在意身份的任务是**那些用凭据操作集群的**，也就是 [§4.5.5](#s4-5-5) 的部署阶段，那里的运行级 SA 由批准名单治理。相应地，"谁可以创建运行、运行能拿到什么权限"属于 [§4.5.4](#s4-5-4) 的入口封堵与 RBAC，不在本策略的承诺范围内。**旁边有一个陷阱**：在准入时刻这个字段永远是显式的（默认填充 webhook 会补上 SA —— 取自 `config-defaults` 的 `default-service-account`，该键缺失时则是 Tekton 内置的默认值 `default`），所以"非空即拒绝"的写法会拒掉**所有**请求；要真正治理它，请像 [§4.5.5](#s4-5-5) 那样用批准名单，并把默认值也放进名单。

关于 `gateOverrideCount` 的**严格度边界**再补一句：它拒绝的是"调度类键之外的 `podTemplate`，且点名门禁任务"（`dnsConfig` 能改变镜像仓库解析，`volumes` 能遮蔽挂载点，`env` 直接改变扫描行为）以及任何 `serviceAccountName`；**调度类键（`nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName`）明确允许**。剩下的唯一代价是"给扫描器配专用 SA"会被拒 —— **当这个合理需求出现时，请把 `serviceAccountName` 从这条判据里摘出来，改写成 [§4.5.5](#s4-5-5) 那样的批准名单**；不要把整条条件删掉。

它**不**保证下列任何一项：

- **扫描范围没有被放宽。** `trivy-config` workspace 可以绑定一个你可控的 ConfigMap，通过 `trivy.yaml` 或忽略规则把发现过滤掉 —— 所有参数都是绿的、门禁"开着"，而结果已经不代表完整的漏洞面了。要堵住这一条，需要叠加 `trivy-config` 的 workspace 白名单（在完整画像里；判据是 `trivyConfigBad`），而白名单只治理"绑定了哪个对象" —— **对象的内容仍然依赖配置对象自身的准入与评审**。
- **扫描真的跑完了。** `--help` 之类的参数会让 trivy 退出 0、不产出报告；那一类只有 [§4.4.1](#s4-4-1) 读取 `trivy-summary-metadata` 的 `status` 才看得见。
- **平台侧留下了证据。** 同样是 [§4.4.1](#s4-4-1) 那一层。
- **构建出来的每一个镜像都被扫过。** 模板把**整个 `images` 数组**交给 build-image（`$(params.images[*])`），却只把 **`images[0]`** 交给 trivy（`scanTargets: [$(params.images[0])]`），而部署同样只用 `images[0]`。所以一个 `images` 有多个元素的请求，**会构建并推送若干个未经扫描的镜像** —— 而最小版本**不判定 `images` 的元素个数**。"门禁开着"仍然成立；"镜像仓库里的每个镜像都过了门禁"则不成立。因此完整画像的 `imagesBad` 要求**恰好一个**元素（这不是过严 —— 它堵的正是这个缺口）；要真正支持多镜像，就让模板逐个扫描，或者另加一条"每个镜像都必须有对应扫描记录"的审计策略。

换句话说：最小版本挡住"开关被扳动"；完整画像再加上"不受控的配置入口"；[§4.4.1](#s4-4-1) 再加上"到底跑没跑、报了什么"。三层，各管一段。

:::

##### 再看完整画像：按分组取用 —— 不必全抄

上面那条策略只治理一件事：漏洞门禁。完整画像把同一个模板的其余治理面也焊死，**而且判据按彼此不依赖的分组划分** —— 按你实际的治理范围取用；删掉某一组不影响其余各组：

| 判据分组 | 包含 | 删掉它会失去什么 |
|---|---|---|
| **Trivy 门禁** | `trivySkipped` / `trivyGateOff` / `trivySeverityBad` / `trivyExtraArgsBad` / `gateOverrideCount` / `runWideEnvCount` | 正是最小版本的那**六**条 —— **六条一条都不能少**：没有 `trivySkipped`，一个 `skipTrivyScan: "true"` 就让另外三条空转；没有 `gateOverrideCount` 或 `runWideEnvCount`，一处 `podTemplate.env`（按任务或按运行附加）就能在所有参数都是绿的情况下改变扫描行为 |
| **Sonar 门禁** | `sonarBad` / `sonarPropertiesBad` / `sonarProjectKeyBad` | 代码扫描可以被空的 `sonarURL` 整体跳过，或者被一条覆盖受管键（端点 / 项目身份 / 分支锚点）的 `sonarProperties` 条目架空；非规范条目（行首空白 / `#` / 内嵌换行）一律拒绝 —— 只有这样，前缀匹配才可靠 |
| **Hub 来源身份** | `hubSourceBad` | 请求可以自带 `url`，从外部拉取同名模板；白名单就成了摆设 |
| **扫描目标与传输** | `imagesBad` / `tlsVerifyBad` / `trivySkipped` | 可以推送多个镜像却只扫第一个；可以打开 `--insecure`；可以把 trivy 任务整个跳过 |
| **构建输入** | `mavenExecutionInputsBad` 等 / `pythonBuildInputsBad` | 构建期间执行什么由请求方决定（改 goals、换构建镜像、注入前置构建脚本） |
| **可选 workspace 白名单** | `sonarCredentialsBad` / `trivyConfigBad` / `pipConfBad` 等 | 配置入口失控；尤其 `trivy-config` 直接影响扫描范围 —— 删掉它就意味着即便门禁参数全绿，扫描照样能被放松 |

**最可能需要按环境裁剪的是最后一组** —— 白名单里的对象名必须换成你自己批准的 Secret / ConfigMap，而你环境中不存在的 workspace，直接把对应判据删掉即可。

**关键判据** —— 每一组各算出一个布尔值，`deny.conditions.any` 命中任意一条即拒绝（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：

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

:::details 自查用例：装上策略之后，用 --dry-run=server 逐条走一遍

按每一行构造一个 PipelineRun，用 `kubectl create --dry-run=server` 提交；核对结果是否与"预期"一致。不一致就说明你的策略与本节的不同 —— 按最后一列排查。

| 你提交什么 | 预期 |
|---|---|
| 完全合规的画像 + 全部已批准的 workspace；以及同一画像加上单独显式的 `type=artifact` | 放行 |
| 不传 `trivyExitCode` / `trivySeverity`（继承模板默认值，门禁开着） | 放行 |
| 已批准的四元组外加一个请求级 `url`，或者显式的 `type=tekton` | 拒绝 |
| 空白 / 未批准的 Sonar 端点；显式覆盖 `sonarProjectKey` | 拒绝 |
| `sonarProperties` 中含有覆盖受管键的条目（命中 `sonar.host.url=` / `sonar.projectKey=` / `sonar.branch.name=` / 凭据类键 / `sonar.qualitygate.` 前缀中任意一个） | 拒绝 |
| `sonarProperties` 只含合法的分析设置（例如 `sonar.exclusions=**/vendor/**`）或平台注入的 `sonar.pullrequest.*` 组 | 放行 |
| `sonarProperties` 含有非规范条目（行首空白 / `#` 注释 / 单个条目内嵌换行） | 拒绝（规范形态门禁 —— 行首空白那种写法从前能躲过纯前缀匹配） |
| `sonarProperties` 以 **object** 传入（类型回退） | 拒绝 —— JSON 编码匹配不上规范的 `key=value` 形态（与 [§4.2.4](#s4-2-4) 探针 26 同一判定）；不产生策略错误 |
| 非法的 `skipTrivyScan` | 拒绝 |
| `trivyExitCode` 显式设为 `"0"` 或空字符串（仅出报告，即门禁关闭） | 拒绝 |
| `trivyExitCode` 设为其他非零码（例如 `"2"`） | 放行 —— 按契约它照样让运行失败 |
| `trivySeverity` 非空但没有同时覆盖 `CRITICAL` 与 `HIGH` | 拒绝 |
| `trivyExtraArgs` 非空 —— 无论是 `["--help"]` 这类不出报告的调用，还是重复的 `--exit-code` / `--severity` | 拒绝 |
| `tlsVerify=false`，或者 `tlsVerify` 写成 shell 文本 | 拒绝 |
| `images` 缺失 / 不安全 / 多元素 | 拒绝 |
| 覆盖构建输入参数（java 的 `mavenSubdirectory` / `mavenGoals` / `mavenImage`；python 的 `preBuildScript` / `pythonImage`） | 拒绝 |
| 未批准或来源类型不对的 Sonar 凭据 / settings / 证书，Maven settings / cert / server / local-repo，registry 配置，CA bundle，以及被保守限制的 `maven-trust-store` | 拒绝 |
| 不绑定 `trivy-config`；或者绑定到已批准的 ConfigMap | 放行 |
| `trivy-config` 绑定到另一个 ConfigMap；或者以 PVC 形式绑定（`configMap.name` 读出来是空的） | 拒绝 |
| 给门禁任务（`trivy-scanner` / `sonarqube-scanner`）附加的 `taskRunSpecs[].podTemplate` **只含调度类键**（`nodeSelector` / `tolerations` 等） | 放行 |
| 同一位置出现 `env` / `volumes` / `dnsConfig`（哪怕混在调度类键里），或者出现 `serviceAccountName` | 一律拒绝 |
| 把同样的 override 附加到**另一个**任务上；或者在门禁任务上通过 `stepSpecs` 给 `computeResources` | 放行 |
| 运行级 `taskRunTemplate.podTemplate.env`；对照运行级只给 `nodeSelector` | 拒绝 / 放行 |

**结果不符时先看哪里**：全部放行 → 多半是前置条件根本没匹配上；先核对 `pipelineRef` 的四元组（catalog / kind / name / version）是否与你提交的一致。本该放行的被拒 → 看拒绝消息点名的是哪条判据；多半是 workspace 白名单里的对象名与你环境中的不同。

这套用例验证的是**准入可见的契约**；它不能证明 Task 在运行时真的消费了这些 workspace（例如，它证明不了 Maven 会去读 `maven-trust-store`）。

:::

:::warning 升级顺序：策略必须与模板一起升级，否则合规请求会被你自己的策略拒掉

这条判据固定了模板的参数面。一旦模板引入新的门禁参数（比如从"把开关塞进 `trivyExtraArgs`"改成结构化的 `trivyExitCode` / `trivySeverity`），**按旧参数面写的策略不会"放行漏过"，而会开始拒绝每一个合规请求**：旧判据要求 `trivyExtraArgs` 恰好等于某份列表，而在新约定下这个参数本该是空的。

症状是升级之后流水线**在准入处成片卡住**，而拒绝消息来自你自己的 ClusterPolicy。所以升级模板时请按这个顺序来：

1. 先查看新模板版本的参数面。**取哪一份，取决于模板是怎么被引用的**：
   - 集群内的 `Pipeline` 对象（`resolver: cluster`）—— 在**跑 Tekton 的那个集群**上执行 `kubectl -n <ns> get pipeline <name> -o yaml`；
   - 通过 hub / git resolver 引用的模板 —— 它**不是集群里的 `Pipeline` 资源**，`kubectl get pipeline` 会直接返回 `NotFound`。要么从 hub / catalog 侧取，要么用一次真实运行的解析结果：`kubectl -n <ns> get pipelinerun <one-real-run> -o jsonpath='{.status.pipelineSpec}'` —— 那一份才是**实际生效**的定义；
2. 更新策略判据，并用 `--dry-run=server` 确认新版本的合规形态能被放行；
3. 最后才切换模板版本，并同步更新固定的 `refVersion` 取值。

反过来做 —— 先切模板、后修策略 —— 会让中间窗口变成**全部拒绝**而不是全部放行：影响面很大，但不是静默的，因此是更安全的失败方向。

:::

:::warning 本节的能力边界

策略只能约束 **PipelineRun 准入时可见的参数与 workspace 引用**。源码 workspace 里的 `sonar-project.properties`、已批准 Secret / ConfigMap / PVC 的实际内容，以及镜像是否真的从预期源码构建而来，必须分别由可信模板、配置对象的准入，以及供应链证明来约束 —— **不要把"引用了已批准对象"误当成"该对象的内容已经过审计"**。

:::

**与 [§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4) 的关系**：提前拦截治理的是"PipelineRun 层参数的取值"；主路径治理的是"最终展开进任务的实际取值"。两者叠加 —— 提前拦截改善体验，而 TaskRun 层为所有模板形态兜底。

#### 4.2.6 注入默认值（mutate） {#s4-2-6}

- **治理什么**：给那些没有显式设置的 PipelineRun 注入平台默认值（一个治理标签、一个默认超时）。
- **难在哪里**：注入不得覆盖调用方的显式选择 —— 否则它就从"补默认值"变成了"强行改写用户输入"。
- **策略怎么分层**：每一个被注入的字段无一例外都使用 `+()` 锚点（缺失才添加）—— 标签键与 `timeouts` 字段**两者都要**；不带锚点的标签键会强行覆盖调用方的显式取值。
- **治理不了什么**：mutate 不产生 PolicyReport 违规记录（与 [§4.2.3](#s4-2-3) 相同）；它是补齐，不是校验。
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

**预期形态**（用 `--dry-run=server -o yaml` 直接观察 mutate 结果）：一个没有 `timeouts` 的运行，输出对象里会带上 `policy.alauda.io/gated: "true"` 与 `timeouts.pipeline: 1h0m0s`；一个显式写了 `timeouts.pipeline: 30m0s` 的运行保持 `30m0s`；一个显式写了 `policy.alauda.io/gated: "false"` 的运行保持 `"false"`。对 resolver 引用式的运行同样适用。

#### 清理（§4.2）

按 [§4.0.4](#s4-0-4) 的两条规则清理：

:::warning 前三条策略是互斥的备选方案 —— 不要同时装着它们做验证

`gate-param-contract`（deny，[§4.2.1](#s4-2-1)）、`gate-param-cancel-existing`（mutate-existing 取消父运行，[§4.2.2](#s4-2-2)）与 `gate-param-mutate-to-cancel`（准入 mutate 取消门禁 TaskRun，[§4.2.3](#s4-2-3)）是**对同一个不合规输入的三种响应**；在生产中请按 [§4.2.3](#s4-2-3) 的对照表**只选一种**。三条同时装着时，deny 会先拦住门禁 TaskRun 的 CREATE，而另外两条策略所期待的 `Cancelled` 终态**根本不会出现** —— 逐节验证时，装一条、验一条、删一条，否则你会错误地得出另外两条"不起作用"的结论。

:::

用归属账本按记录的 UID 删除那七条集群级策略（**注意上面的互斥说明** —— 逐节验证意味着一次只装一条、删一条，所以到这一步只会剩下你还装着的那些）。

⚠️ 下面的清单里只能出现**本次实操确实创建过、并记录进 UID 归属账本**的策略。不要把你从未创建过的名字加进去；如果某个同名对象已经被替换，助手会因 UID 不匹配而跳过它 —— 不要为了"删干净"就退回去手工按名字删。

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

`policy-poc` 中的 `Role/kyverno-background-pipelineruns` 与同名 RoleBinding，会随命名空间的级联删除一并回收，无需单独删除。

### 4.3 真实的质量门禁失败（契约 3–6 落在模板侧） {#s4-3}

**总契约**：硬门禁的"失败"发生在流水线内部 —— 门禁任务读取前置结果，不达标就 exit 1，Tekton 原生把该运行标记为 `Failed`，排在门禁之后的任务被 DAG 跳过。Kyverno 在本节**不贡献任何新策略**：它的贡献在 [§4.1](#s4-1)（保证模板身份）与 [§4.2](#s4-2)（保证门禁参数）；失败本身不需要、也绝不该由准入系统制造出来（[§2.2](#s2-2) 的反面机制）。

模板设计检查清单（[§2.3](#s2-3) 各契约落到模板作者身上的部分）：

- **数据绑定 / 门禁内聚**（契约 4）：自带门禁的扫描器（例如 `sonarqube-scanner`，或 [§3.3](#s3-3) 的夹具）把"读取被测数据 + 按规则判定 + 不达标就自身失败"内聚在**同一个任务**里 —— 门禁开关 `enableScanQualityGate` / `enableAnalyzeQualityGate` 加上规则 `analyzeQualityGateRules` 就是它的契约。如果你的门禁是一个**独立的门禁任务**（消费上游 results），那就用 `$(tasks.<producer>.results.<name>)` 把实际取值显式接进门禁；
- **DAG 支配**（契约 5）：每一个发布 / 推送 / 晋级任务都 `runAfter` 门禁任务（自带门禁的扫描器或独立门禁；直接或传递皆可）。门禁只能拦住它的后继 —— **排在门禁之前或与之并行的任务已经执行的部分不会被回滚**。所有副作用都必须排在门禁之后；这是模板设计的责任，准入事后补救不了；
- **必须执行**（契约 3）：不要给门禁留任何跳过路径。自带门禁的扫描器，其绕过面是"把开关设成 `false`"（由 [§4.2.1](#s4-2-1) 焊死）与"给 `scan` 挂一个 `when` / 空 matrix 把它跳过"（由 [§4.1.5](#s4-1-5) 的 `skippedTasks` Audit 兜底）；引用式模板还多一种"参数触发的整体跳过"反模式（例如 `sonarURL` 默认为空 + `when: sonarURL notin ["", " "]` ⇒ 不传参数，整个扫描阶段就被跳过）—— 修法思路相同：策略侧焊死参数，模板侧收紧默认值，再叠一条漂移 Audit；
- **finally 安全**（契约 6）：finally 在失败时执行，或者在以 `CancelledRunFinally` 取消时执行；普通的 `Cancelled` 并不保证尚未开始的 finally 任务会被调度。不要把任何受门禁保护的副作用放进 finally。（`spec.status` 还有第三个同样会执行 finally 的取值 `StoppedRunFinally`，其语义是**让已经在跑的任务自行跑完**再停止；本文所有取消路径都使用 `CancelledRunFinally` —— 门禁不合规时的要点就是立刻切断执行中的步骤，等它跑完与取消的目的正好相反。只有在希望"让当前步骤收尾之后再停"的场景才切换到那个取值。另外，`spec.status` 还有**第四个**合法取值 `PipelineRunPending`，它与停止 / 取消无关 —— 其语义是"先别开始" —— 所以判定"这次运行被取消了"必须看**取值**，绝不能看"非空"；见 [§6.2.3](#s6-2-3)。）

**基线形态**：用 `coverage: "30"` 跑 [§3.3](#s3-3) 那个自带门禁的夹具（规则 `coverage>=80`，`enableAnalyzeQualityGate=true`）——

- `scan` 任务侧的质量门禁不达标 → **任务自身 `exit 1`**，写出 `code-scan-results.result=Failed`（真实的 0.7 Task 内部检查 SonarQube 的 `alert_status`，但那个内部字段不属于输出契约）；
- PipelineRun 的终态是 **`Failed`**；
- `skippedTasks: [{name: release, reason: PipelineRun was stopping}]` —— release 在物理上从未被创建；
- finally 的 `notify` 照常成功执行。

这就是"自带门禁的扫描器支配发布"的基线形态：门禁与被测数据内聚在 `scan` 这一个任务里，而 `release` 传递地 `runAfter` 它。平台 catalog 中 Task 的原生门禁能力工作方式相同 —— 用 `sonarqube-scanner`（0.7）时，`enableScanQualityGate` / `enableAnalyzeQualityGate` 不达标就意味着任务自身失败。**注意这两个开关的治理层级**：两个官方 0.3 模板都**没有把它们暴露为 Pipeline 参数** —— 生效的是 Task 侧默认值 `"true"` —— 所以像 [§4.2.5](#s4-2-5) 那样的 PipelineRun 层策略**既看不到也固定不了它们**；只有在 TaskRun 层才固定得住（[§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)）—— 而且要注意，控制器创建的 TaskRun 其 `spec.params` 同样只包含 Pipeline 显式传下来的参数，所以一个没被透传的开关在准入时表现为**缺失**（Task 默认值只在运行时才填上），因此 TaskRun 层的判据写成"只有显式传入且 ≠ `true` 时才拒绝；缺失放行"（[§4.2.4](#s4-2-4) 规则 ③ 的形态）。等到模板暴露它们的那一天，PipelineRun 层必须补上相应判据；`trivy-scanner`（0.6）通过退出码在漏洞超标时失败 —— 官方模板用 `trivyExitCode` 参数控制它，**其默认值是 `"1"`，即门禁默认开启**；策略要防的是它被显式关成 `"0"` 或空（见 [§4.2.5](#s4-2-5)）。

:::info 两个官方模板的 DAG 形状不同：哪些阶段排在门禁之后

**漏洞门禁本身是默认开启的**：模板的 `trivyExitCode` 默认为 `"1"`，所以一旦发现匹配 `trivySeverity` 的漏洞，`trivy-scanner` 就失败、流水线随之失败。所以这里担心的不是"漏洞混过去了没人知道" —— 担心的是**排在门禁之前、已经产生了副作用的那些阶段**。

对比两个模板真实的 DAG：

| | `sonarqube-scanner` | `build-image` | `deploy-or-upgrade` |
|---|---|---|---|
| java 0.3 | `runAfter: [maven]` | `runAfter: [maven]`（与 sonar **并行**） | `runAfter: [trivy-scanner]` |
| python 0.3 | `runAfter: [git-clone]` | `runAfter: [git-clone, pre-build]` | `runAfter: [sonarqube-scanner, trivy-scanner]` |

差别在于**"Sonar 结论支配发布"这件事有没有在 DAG 里表达出来**：python 0.3 表达了，java 0.3 没有。另外，两个模板里的 `build-image` 都与 Sonar 并行 —— 也就是说，**镜像推送并不排在 Sonar 结论之后**。

这算不算问题，取决于你持有哪种要求：

- 如果要求是**"质量问题必须被及时看到并处理"** —— 官方模板已经够用：门禁失败会让整条流水线失败，早在 PR 阶段就能拦住；再叠上 [§4.4.1](#s4-4-1) 的结果 Audit，在平台侧留下证据。
- 如果要求是**"Sonar 结论必须严格支配镜像推送 / 发布"**（契约 5 的强形式）—— 那就选一个 DAG 已经表达了这一顺序的模板（python 0.3 的发布侧就是），或者在模板侧补上 `runAfter`，或者采用 [§3.3](#s3-3) 夹具那种把门禁与被测数据打包进同一个任务的形态。

:::

#### 清理（§4.3）

本节**不创建任何 Kyverno 对象** —— 它是一份模板设计检查清单，而不是策略素材。唯一落到集群上的，是上面"基线形态"里那个 `coverage: "30"` 的 PipelineRun —— 它位于你自建的 `policy-poc` 中，名字是你创建时自己取的：命名空间级联删除会回收它；如果你还要继续做后面的章节，请先按你用过的名字把它删掉，以免它的 PolicyReport 记录干扰下一节（[§4.0.5](#s4-0-5)）。`gated-build` 模板与夹具 Task 本身属于 [§3.3](#s3-3) —— 后面章节还要用的话不要删。

### 4.4 结果审计与 PolicyReport（事后的那道防线） {#s4-4}

**本章共同的契约**：任务的运行结果（覆盖率、漏洞数、扫描结论）只存在于 `TaskRun/status` 的 `results` 中（[§2.1](#s2-1) 观测点 6）。这个观测点**只能 Audit** —— 它的价值在于把"哪些流水线的结果不达标"变成集群内可查询、可上报的 PolicyReport 记录，与 [§4.3](#s4-3) 的硬失败互补：**硬失败负责拦，Audit 负责看见**。

贯穿本章的两点：

- **终态守卫**：一次运行会触发很多次 status UPDATE，而 results 只在接近完成时才出现。用"目标 result 非空"来跳过早期事件读起来顺，但它**不是真正的终态判定** —— 如果某个 Task 已经到达终态却**没有写出 result**（崩了、写了垃圾、被跳过），非空判定会**静默跳过**它，而那恰恰是最该被关注的对象。正确的形态是**先从 `status.conditions` 的 `Succeeded` 条目确认 Task 已终态**，再三分：result 合规 = pass，result 不达标 = fail，**result 缺失 / 格式错误 = fail**（失败关闭）。
- **本章演示两种消费形态**（三种声明类型见 [§2.4](#s2-4)）：object result，用 JMESPath 下钻消费（[§4.4.1](#s4-4-1)，**推荐** —— catalog 中 sonar 与 trivy 这两个扫描 Task 都已经提供）；以及聚合字符串（叠加在 `type: string` 之上的约定），用 `split` + `to_number` 解析（[§4.4.2](#s4-4-2)，**兼容手段**，只在目标 Task 短期内改不了时使用）。

**本节导览**：

- **[§4.4.1](#s4-4-1) 主形态** —— object result 的结论审计（sonar 与 trivy 两种真实形态），**推荐写法**；先读它。
- **[§4.4.2](#s4-4-2)** —— 聚合字符串 result 的拆分范式：**兼容手段，不推荐** —— 只在目标 Task 短期内改不了时使用。
- **[§4.4.3](#s4-4-3)** —— 反面案例：为什么绝不能对 status 做 Enforce（运行会卡死 —— 既不失败也不结束，只能人工介入；见 [§6.1.4](#s6-1-4)）。
- **[§4.4.4](#s4-4-4)** —— 清点既有存量（后台扫描），以及如何确认证据在集群里还能查多久。

#### 4.4.1 object result 的结论审计（sonar 与 trivy 两种真实形态） {#s4-4-1}

catalog 中最常被消费的两个扫描 Task 都已经发布了 object result，消费方式看起来是一样的：**用 JMESPath 直接下钻到 property** —— 不切字符串、不用正则、不用 `to_number`。需要审计的东西则两者不同 —— sonar 给你一个**结论**（过没过），trivy 给你一组**计数加一个总体状态**（扫描成没成功、发现了多少）—— 所以判定的分层也不同；下面分别展开。

##### sonar 形态：扫描结论（`code-scan-results.result`）

- **治理什么**：**扫描结论到底是不是通过** —— 逐次运行地记录扫描器产出的结论（object result `code-scan-results.result`）；任何一次 `code-scan-results.result` 不是 `Succeeded` 的运行都算违规。这是一条 Audit 类策略：它只产出 PolicyReport 条目，不拦截任何请求（对 status 做 Enforce 会卡死，见 [§4.4.3](#s4-4-3)）。
- **难在哪里**：被判定的对象是 **status**，而 status 会被写很多次；朴素的"result 非空时才判定"会放过"已终态却从未写出 result"的情况 —— 而那恰恰是最值得抓的对象。此外，Kyverno 的比较运算符会对形似数字的字符串做强制转换 —— `NotEquals Succeeded` 这种写法会静默放行畸形结论 `"1"`（[§6.1.7](#s6-1-7)）。
- **策略怎么分层**：① 用完整的 `taskRef` 坐标锁定那个可信扫描器（不匹配就跳过；不误伤）→ ② 只有当 **`status.conditions[Succeeded]` ∈ {True, False}**，即已经终态时才求值 → ③ 用**精确正则** `^Succeeded$` 判定 —— 非 `Succeeded` 取值、非法取值，**以及终态而 result 缺失**，统统算 fail。
- **治理不了什么**：它只回答"这一次运行的结论是什么"，回答不了"扫描本身到底干活了没有"（那依赖 [§4.2](#s4-2) 的门禁参数契约）；而且切换到 hub 的 `sonarqube-scanner` 时，版本必须与名字一起锁定 —— 0.5 发布的是大写的 `CODE_SCAN_RESULTS`，0.7 是小写的；不锁版本的话，一个正常的 0.5 结果会被当成"0.7 的 result 缺失"而误报为 fail。

`sonarqube-scanner`（0.7）声明的 object result `code-scan-results` 带有四个 property —— `result` / `reportURL` / `taskID` / `projectID` —— 其中 `result` 就是扫描结论，真实取值范围为 `Succeeded`（通过）/ `Failed` / `Skipped` / `Canceled`。

**关键判据** —— 终态守卫加精确字符串结论；两者缺一不可（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：
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

**切换到生产的 hub 引用时**，完整的 `taskRef` 画像必须跟着改 —— `resolver=hub`、`catalog=catalog`、`kind=task`、`name=sonarqube-scanner`、`version=0.7` —— 而且要完全忽略子 TaskRun 的标签。0.5 与 0.7 的 Task 名相同，但 0.5 发布的是大写的 `CODE_SCAN_RESULTS`，0.7 发布的是小写的 `code-scan-results` —— 不锁版本的话，一个正常的 0.5 结果会被当成"0.7 的 result 缺失"而误报为 fail。

:::warning 取值范围勘误：alert_status 不是 code-scan-results.result

SonarQube 内部的 `alert_status=OK/ERROR` **不是** `sonarqube-scanner` 0.7 产出的 `code-scan-results.result`。真实的 `ScanResult.Result` 取值范围是 `Succeeded` / `Failed` / `Skipped` / `Canceled`（可在控制台的 **Pipelines → Tasks** 中打开该 Task 的 README、"ScanResult Output"一节核实）。

用 `!= "OK"` 去判定，会把**每一次**真实的 0.7 运行都误判为 fail。

:::

##### trivy 形态：漏洞聚合与总体状态（`trivy-summary-metadata`）

- **治理什么**：镜像 / 文件系统扫描的结果必须被记账 —— 本例把"出现任何 CRITICAL"判为不达标，**并且**把那些**根本没有成功扫描过**的运行也判为不达标。
- **难在哪里**：在这个 Task 的 result 里，"有没有漏洞"与"扫描成没成功"是**两个独立维度** —— 只读其中一个必然失败开放。三个陷阱：① **扫描失败时，计数字段照样读出 `0`**（不是空，也不是短横线）—— 只判 `critical > 0` 会把"根本没扫过"当成"零漏洞"放行；② **有发现不等于 Task 失败**：0.6 默认使用 trivy 自己的 `--exit-code 0`，所以一次发现了 CRITICAL 的运行照样是绿色 TaskRun —— 漏洞超标这件事在流水线层面**不可见**，只能从 result 里读出来；③ **`--help` 这类调用 —— 退出码 0 但不产出报告 —— 会让 TaskRun 变绿**，而 result 的 `status` 被写成 `failed` —— 这正是本节能抓到它、而只盯 TaskRun 终态抓不到的原因。
- **策略怎么分层**：① 用完整的 hub `taskRef` 坐标锁定那个可信 Task → ② 终态守卫（同上一小节）→ ③ **先判定 `status` 是否属于"产出了可用报告"的取值** → ④ 交叉核对 `failed` 必须为 `0`（它与 `status` 互相印证）→ ⑤ 再用正则确认计数是有界的非负整数 → ⑥ 只有在确认有界之后才 `to_number` 与阈值比较。凡是"读不出来"的一律判为不达标。
- **治理不了什么**：它只回答"这次扫描报了什么"，回答不了"扫描目标对不对"（`scanTargets` 是否真的指向本次构建产出的镜像，属于 [§4.2](#s4-2) 的参数契约）；也回答不了"这个漏洞该不该豁免"（那属于 `.trivyignore` 与安全评审）。它同样是 Audit 类策略：只产出 PolicyReport 条目，不拦截任何请求（对 status 做 Enforce 会卡死，见 [§4.4.3](#s4-4-3)）。

`trivy-scanner`（0.6）声明的 object result `trivy-summary-metadata` 带有 11 个 property，全部是 **string** 类型：

| property | 含义 | 策略怎么用它 |
|---|---|---|
| `status` | 本次扫描的总体状态；取值范围 `passed` / `findings` / `failed` / `unknown` | **第一层判据**：只有 `passed` / `findings` 才意味着"产出了可用报告"；`failed`（至少一个目标扫不了）与 `unknown`（**一个目标都没扫，或者计数取不到**）必须判为不达标 |
| `critical` / `high` / `medium` / `low` / `unknown` | 按严重级别的**全量聚合**计数 | 阈值判据；`to_number` 之前先用正则把它限定为非负整数 |
| `total` | 各级别之和 | 同上；可用作粗粒度的"到底有没有发现"判定 |
| `scanType` | `image` / `fs` / `config` / `sbom` / 透传的自定义子命令 | 当阈值需要按扫描类型区分时的路由键 |
| `targets` / `scanned` / `failed` | 目标总数 / 已扫描 / 失败 | 当需要比 `status` 更细地区分"部分失败"时使用 |

同名的 `trivy-summary`（array）其首个元素是**同一份聚合内容**的字符串镜像，供 Overview 渲染用；两者由同一份内部状态生成，不会漂移。**策略侧一律用 object 那一个** —— 不要去解析字符串那一个（那是 [§4.4.2](#s4-4-2) 的兼容路径）。

:::warning status 与计数必须一起判

`trivy-scanner` 0.6 的五种典型运行形态，以及各自留下的痕迹：

| 场景 | TaskRun 终态 | `status` | `critical` |
|---|---|---|---|
| 扫描完成，零发现 | Succeeded | `passed` | `0` |
| 扫描完成有发现，未启用门禁 | **Succeeded** | `findings` | `1` |
| 扫描完成有发现，`extraArgs` 带 `--exit-code 1` | Failed | `findings` | `1` |
| `extraArgs` 传了 `--help`（退出 0 但不产出报告） | **Succeeded** | **`failed`** | `0` |
| trivy 自身报错（拉不到漏洞库 / 镜像不存在） | Failed | `failed` | `0` |

三条推论：① **`critical=0` 不代表安全** —— 最后两行的 `critical` 都是 `0`；只按计数判定会把它们直接放行；② **绿色的 TaskRun 不代表扫描发生过** —— 第二行与第四行都是绿的；③ 要让漏洞真正**拦住**流水线，靠的是模板上的门禁参数 —— 两个官方 0.3 模板的 `trivyExitCode` 默认为 `"1"`，所以默认情况下它们确实会拦；要防的是它被显式改成 `"0"` / 空字符串，或者被 `skipTrivyScan` 把整个扫描跳过（见 [§4.2.5](#s4-2-5)）。本节的 Audit 只负责**看见**。

`status` 的四个取值分工明确 —— 不要混为一谈：`passed` 是"所有目标都扫了，零发现"；`findings` 是"扫了，存在漏洞"；`failed` 是"至少一个目标扫不了"；`unknown` 有**两个**成因 —— 一个目标都没扫，**或者计数根本取不到**（Task 的 `compute_scan_status` 对两者返回同一个取值）。要比 `status` 更细地区分"部分失败"，就读 `targets` / `scanned` / `failed` 这三个计数 —— 按契约，`scanned` 包含失败的目标，可用报告数是 `scanned - failed`。

**计数字段里确实会出现短横线（`-`）。** 当计数取不到时（例如自定义 `toolImage` 里缺少 JSON 解析器），Task 会把 `total` / `critical` / `high` / `medium` / `low` / `unknown` **统统写成 `"-"`** 而不是 `0` —— 而且代码注释说明这是**刻意的**：写 `0` 会被误读成"干净、零发现"。`trivy-summary` 数组的逐目标行同样用短横线标记该行报告缺失。

**所以下面那道正则守卫不是可有可无的纵深防御 —— 它是必需的**：它把短横线与空值挡在 `to_number` 之外，对应的正是这条真实路径。它也解释了为什么 `status` 与计数**必须一起判** —— 在计数取不到的那条路径上，`status` 是 `unknown` 而计数是 `-`；这两个信号是成对到达的。

:::

**关键判据** —— 先 status 守卫，中间正则守卫，最后才 `to_number`（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：

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

:::warning 这条策略信任的是"控制器写进 status 的东西"

它从 TaskRun 的 status 里读取 result，所以它的强度止步于"谁能写那份 status"。策略自身分辨不出一个 result 是真的由扫描产出的，还是被伪造进去的 —— 所以必须有两件事配套：

- **在 RBAC 中，不要给业务身份 `taskruns/status` 的写权限**（正常情况下只有 Tekton 控制器写它）；
- **把 Task 身份锁定到版本**（上面的前置条件已经锁定了 `catalog/trivy-scanner/0.6`）；否则一个同名的替身 Task 可以产出它自己的"合规"result。

`failed` 与 `status` 之间的交叉核对，是这条线上的**纵深防御**，而不是替代品：它能挡住只改 `status` 字段的粗糙伪造，挡不住把整份 summary 一致地重写的对手。要更严，可以再加上 `scanned == targets` 并固定 `scanType` —— 但**每加一条都必须在你自己的环境里走一遍正反用例** —— 本节给出的是上述判据的行为。

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

:::warning 读 status 时绝不要取 [0]：一条伪造的同名条目就能让整条规则失效

**`status.conditions` 与 `status.results` 都是由控制器写入的，而 Kubernetes 对两者都没有按名去重的约束**（`taskruns.tekton.dev` 的 schema 中没有任何东西让 API server 保证这两个列表按键唯一）。所以同名条目完全可以出现两次：`kubectl patch --subresource=status --dry-run=server` 的回显会把两条都显示出来，API server 原样接受（之后控制器的一次调和会把它们归一化，但**在准入时刻**看到的就是那两条 —— 而准入正是策略求值的时刻）。

这与 [§4.2.5](#s4-2-5) 中"对 `spec.params` 取 `[0]` 是安全的"正好是一对：`spec.params`、`pipelineRef.params`、`spec.workspaces` 中的同名重复都会被 **Tekton 自己的校验 webhook** 拒掉（报错原文见 [§4.2.5](#s4-2-5)）；而 status 一侧没有等价的保证。**"在 `spec` 上验证过"绝不能外推成"在 `status` 上也安全"。**

于是，如果终态判据写成 `[?type=='Succeeded'].status | [0]`，只要在真条目**之前**插入一条 `status: Unknown` 的假 condition，`isTerminal` 就变成 `false` —— 前置条件不满足 → **整条规则跳过**，而下面那道 `succeededConditionCount != 1` 的守卫根本没机会执行。这就是失败开放。

**下面的 A/B 表是加固调查的一次性记录（历史对照），不是当前部署需要重跑的步骤** —— 当前部署只需验证加固后的判据（本节 Cookbook 步骤测的正是它）。当时的构造是：取一个本该被拒的终态 TaskRun，逐字重放它的 status 作为对照组，然后只加一条诱饵、其余一概不动，作为实验组。三条策略的表现如下：

| 被攻击的策略 | 诱饵构造 | 对照组 | 实验组（旧写法） | 实验组（加固后） |
|---|---|---|---|---|
| [§4.4.1](#s4-4-1) trivy 形态（一次 `critical=1` 的运行） | 在 `conditions` 前面插入 `Succeeded=Unknown` | 拒绝 | **放行** | 拒绝 |
| [§4.4.1](#s4-4-1) sonar 形态（一次 `result=Failed` 的运行） | 在 `results` 前面插入一条 `result=Succeeded` 的同名条目 | 拒绝 | **放行** | 拒绝 |
| [§4.4.2](#s4-4-2) 字符串形态（一次 `critical=9` 的运行） | 在 `results` 前面插入一条 `critical=0` 的同名字符串 | 拒绝 | **放行** | 拒绝 |

加固不会误伤正常运行：一次干净的运行逐字重放照样放行；往里插入一条诱饵就会被拒 —— "重复的条目"本身就是违规。

这就是上面那个 `isTerminal` **对终态 condition 做计数**而不是取 `[0]` 的原因：
```yaml
length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`
```

这样一来，`[Unknown, True]` 仍然会被判为终态并进入 `deny`，随后由 `succeededConditionCount != 1` 把"条目重复"这件事本身判为违规。**残余边界**：两条都是 `Unknown` 时它仍然跳过 —— 那确实还没到终态，等它稳定下来就会被抓到；而一个能把 status 长期钉在 `Unknown` 上的攻击者，本来就已经持有 status 写权限，那是 RBAC 的边界，不是本策略的（见本小节前面那条警告"这条策略信任的是'控制器写进 status 的东西'"）。

**读取 results 需要同样的守卫。** 本文有四条策略读取 `status.results`，而**每一条都要求"目标 result 恰好只有一条"** —— 但守卫接在哪里因策略类型而异：

- 三条 Audit（[§4.4.1](#s4-4-1) 中 trivy 形态的 `summaryResultCount` 与 sonar 形态的 `verdictResultCount`，以及 [§4.4.2](#s4-4-2) 的 `summaryResultCount`），连同各自的 `succeededConditionCount`，都接进 `deny.conditions.any` —— 计数不等于 1 就记一条 fail；
- 那条取消类策略（[§4.6.1](#s4-6-1) 的 `coverageResultCount`）没有 `deny` 块；它的守卫接在中间变量 `coverageViolates` 里，所以**计数有歧义会直接触发取消**。

两种方式方向都是失败关闭，只是落点不同。**只声明变量而不接进去，等于没加** —— 而这道守卫恰恰是最容易忘记接线的一类，因为它缺失时，所有正常样本照样通过。

**每一条把 `isTerminal` 用作前置条件的策略都必须做同样的修正** —— 本文中的 [§4.4.1](#s4-4-1)（两种形态）、[§4.4.2](#s4-4-2) 与 [§4.6.1](#s4-6-1) 都已经改成计数形态。

:::

:::details 如何复现这个构造（以及为什么不能用 PolicyReport 去读结论）

**请在跑 Tekton 与 Kyverno 的那个集群上执行。** PolicyReport 是最终一致的：某一次 status UPDATE 的判定何时被写进报告并无保证，所以**结论无法归因到某一个具体请求**。要拿到同步、可归因的判定，就临时装一份**仅用于测量的 Enforce 副本**，用标签把它钉在探针对象上，然后直接读 `--dry-run=server` 的返回 —— 什么都不会被持久化：

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

**这些步骤测的是本文现在发布的（加固后的）判据** —— 第 1 步是从**线上策略**派生副本的，而它已经是计数形态，所以上表中"实验组（旧写法）"那一列**不会**从这些步骤里复现出来。想亲眼看到那个失败开放，你得另外手工造一份把 `isTerminal` 改回 `[?type=='Succeeded'].status | [0]` 的副本；如果你只想确认"现在拦得住"，照下表跑即可。

| 步骤 | 预期（当前发布的计数形态） | 不符时先看哪里 |
|---|---|---|
| 第 3 步 对照组 | 拒绝（deny 触发） | 没被拒 = 这个 TaskRun 的 `critical` 并不 `>0`，或者策略没匹配上：先 `kubectl get clusterpolicy "$MEASUREMENT_POLICY_NAME" -o yaml`，检查 `match` 的命名空间 / selector 以及 hub 身份那五项 |
| 第 4 步 实验组 | 拒绝（诱饵本身就是违规） | 如果被放行了：先 `kubectl get clusterpolicy "$MEASUREMENT_POLICY_NAME" -o jsonpath='{.spec.rules[0].context[?(@.name=="isTerminal")]}'` 确认生效的那一行确实是计数写法（只有第 1 步的 `kubectl wait` 通过之后才算装上）；再确认诱饵条目确实排在**前面**（放在后面的话，它对 `[0]` 写法本来就无效，构不成对照） |
| 第 5 步 收尾 | — | 忘了删测量副本 = 在 `*/status` 上留了一条 Enforce 规则，它会把带那个标签的对象卡死：用 `kubectl get clusterpolicy` 确认它已经不在了 |

加固不会改变对正常形态的判定：把下一个折叠块里那七种标准形态用同样的"逐字重放 + `--dry-run=server`"跑一遍，计数形态按表格顺序给出的判定是（放行 / 放行 / 拒绝 / 拒绝 / 拒绝 / 拒绝 / 放行（skip））—— **在这七种形态上与 `[0]` 写法完全一致**，也就是说加固不会误伤正常运行。**两种写法只在伪造 condition 的构造上分道扬镳**：诱饵条目排在最前面时，`[0]` 写法读到的是伪造条目，把一次违规运行判为未终态并放行（失败开放），而计数写法则以"条目重复本身就是违规"拒绝它。换句话说，它**只**封住了伪造 condition 这条路径。

:::

:::details 自查用例：七种运行形态各自应当被判成什么

| 探针 | 产出的 `status` / `critical` | 预期 PolicyReport |
|---|---|---|
| 扫描一个干净镜像 | `passed` / `0` | pass |
| 有发现，但 CRITICAL 被 severity 过滤掉了 | `findings` / `0` | pass |
| 发现 CRITICAL | `findings` / `1` | fail |
| 发现 CRITICAL 且 `extraArgs` 带 `--exit-code 1`（TaskRun 失败） | `findings` / `1` | fail |
| `extraArgs` 传 `--help`（TaskRun 成功但不产出报告） | `failed` / `0` | fail |
| trivy 自身报错（拉不到漏洞库） | `failed` / `0` | fail |
| 同一命名空间中一个无关的 TaskRun（不是 trivy 身份） | 没有该 result | skip（不误伤） |

**如何复现**（全部在**跑 Tekton 与 Kyverno 的那个集群**上执行；两者分开部署时，指的是业务集群，而不是全局管理集群）：

下面"复现所需的两份最小 YAML"折叠块给出了源码夹具与一个探针的完整 YAML。前六个探针在它之上**只改 `params`**；最后一个 —— 不误伤对照 —— 是例外：它必须换成一个**使用内联 `taskSpec` 的无关 TaskRun**（其 `taskRef` 不再指向 `trivy-scanner`；否则身份照样匹配，就证明不了不误伤了）。把上面的完整策略存为 `vuln-summary-audit.yaml`，夹具与探针分别存为 `trivy-source-fixture-cm.yaml` 与 `probe-findings-critical.yaml`，然后：

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

:::details 复现所需的两份最小 YAML（源码夹具 + 一个探针）

`trivy-source-fixture-cm.yaml` —— 一个装着假密钥的源码目录，用于在无网络、不拉漏洞库的情况下稳定产出发现：

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

`probe-findings-critical.yaml` —— "发现 CRITICAL"探针；其余探针在它之上只改 `params`：

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

**结果不符时先看哪里**：全部记为 `skip` → 多半是 `taskRef` 身份没匹配上（这条策略锁定在 `catalog/trivy-scanner/0.6`；换版本或换成 cluster resolver 都会产生 skip）；本该 `fail` 却是 `pass` → 先跑 `kubectl -n <ns> get taskrun <name> -o jsonpath='{.status.results}'` 看看 `trivy-summary-metadata` 里实际是什么，再与上面的判据对照；一直停在 `skip` 而 TaskRun 仍在 `Running` → 终态守卫正在起作用 —— 等到终态再读一次。

顺带一说，终态守卫起作用时就是这个样子：`trivy` 报错那一例在运行**仍处于 `Running`** 时被记为 `skip`（`preconditions not met`），只有落到终态之后才翻成 `fail`。这正是期望的行为 —— 不对中间态 status 下判定，而"result 还没写出来"既不误报也不永久沉默。

:::warning PolicyReport 是尽力而为的，不是完整账本

偶尔你会看到这样一条记录：TaskRun 已经到达终态、`trivy-summary-metadata` 也完整写出，可它在 PolicyReport 里**停在 `skip`**（`preconditions not met`），时间戳恰好是运行转入终态的那一秒 —— 终态时刻的那次求值没能落进报告。同样形态的运行在绝大多数情况下都会被记为 `fail`，所以这是一次低频漏记，而不是判据写错了。

原因：`*/status` 策略只在准入时刻求值，而 `background: false` 时**没有后台兜底**（[§4.4.4](#s4-4-4)）—— 一次求值在上报路径上丢了，就没有补偿的机会。

**这决定了 PolicyReport 该怎么用**：它适合用来**发现**问题（出现 `fail` 就一定是真问题），但**不能反过来当作合规证明** —— "没有 fail 条目"不等于"没有违规运行"。凡是"必须全部合规才能发布"这类决策，请回到 TaskRun / PipelineRun 本身，或者用流水线内部的硬门禁（[§4.3](#s4-3)）。

:::

要改判 `high` 或 `total`，把 `criticalRaw` / `criticalIsNumeric` 换成对应的 property 即可；判定结构不变。

**与 [§4.2.5](#s4-2-5) 的分工**：本节读的是**运行结果**，回答"这次扫描发现了什么"；[§4.2.5](#s4-2-5) 读的是**模板参数**，回答"门禁有没有被关掉或架空"。两者互补且都必要 —— 只有前者，超标镜像照样发布（TaskRun 是绿的）；只有后者，参数都对，但中途失败的扫描照样没人发现。

#### 4.4.2 非结构化字符串 result 的解析范式（兼容手段，不是推荐写法） {#s4-4-2}

:::warning 看示例之前先读这一段：本节不是推荐写法

本节演示的东西 —— 把聚合字符串拆开再判定 —— **不是本文推荐的扩展写法**；它是为了消费**既有 Task 契约**的兼容手段。推荐做法仍然是 [§2.4](#s2-4) 的第 1 条：让 Task 产出**结构化 result**（object result + `properties`），策略直接下钻到字段 —— 不需要正则，也不可能出现解析失配。

**针对 trivy 尤其要说：不要再用本节的写法。** `trivy-scanner` 0.6 已经同时发布了 object result `trivy-summary-metadata`；请直接用 [§4.4.1](#s4-4-1) 的下钻写法。本节保留下来是作为**通用范式** —— 当你面对一个只产出聚合字符串、而且短期内改不了的第三方 / 自研 Task 时，把这里的拆分与失败关闭结构照抄过去即可。下文仍然以漏洞计数为题材，是因为它把每一个陷阱都踩全了，但**它演示的是形态，而不是使用 trivy 的推荐方式**。

那为什么还要保留本节？两个现实理由：① 只产出聚合字符串的 Task 与 Task 版本在生产中依然存在，而治理不能等；② 这里的**失败关闭解析范式**（先锁终态与 Task 身份 → 再用正则确认是有界的非负整数 → 最后才与阈值比较，凡"读不出来"一律判为不达标）是一条可以逐字照抄的安全基线。

**如果你在设计一个新 Task，请直接上 object result —— 不要照抄本节。**

**兼容面已冻结**：本节判据的支持面到此为止 —— 它只服务于既有的聚合字符串契约，不会为新字段、新格式、新调用方增长新的解析判据；需要新的判定能力时，请走 object result（[§4.4.1](#s4-4-1)），而不是在本节之上再叠一层正则。

:::

- **治理什么**：一个只发布字符串 result 的 Task —— 当它报出的计数超过阈值时必须被记录在案；本例判定 `critical > 0`。
- **难在哪里**：计数被塞在一个聚合字符串里（形如 `"scanType=image;…;critical=3;high=10;…"`），而且三类陷阱叠在一起 —— ① 这类 Task 通常用**哨兵值**表示"数量不可知"（本例用 `critical=-`，一个短横线）；把 `-` 读成 0，等于把"扫描什么都没产出"当作"没有漏洞"放行；② **"取第一个匹配的 token"是个陷阱**：`critical=0;critical=9` 与 `critical=0=9` 都会被朴素解析器读成干净的 `0`；③ Kyverno 的运算符会对形似数字的字符串做强制转换，很容易把"读不出来"变成"判为通过"。这条解析路径处处失败开放。
- **策略怎么分层**：① 锁定终态 + Task 身份 → ② 从聚合字符串中切出 `critical=` 这个 token 并要求**恰好一个** → ③ **对整个 token 做正则匹配**（`^critical=[0-9]{1,9}$`，而不是只对从中切出来的取值）→ ④ 只有在确认有界之后才 `to_number` 并与阈值比较。凡是读不出取值、或者读出多个的情况，一律按违规处理。
- **治理不了什么**：字符串不是稳定契约 —— 字段顺序、分隔符、新增字段都可能让解析**静默失配**，而失配通常表现为**被误判为通过**。所以这只是一种过渡形态。此外，聚合字符串通常**没有**"扫描总体状态"这一维度（[§4.4.1](#s4-4-1) 的 `status` 补的正是这一块），所以本节判据只能覆盖"计数读不出来" —— 覆盖不了"报告根本没产出，而计数被写成了 0"。

**关键判据** —— 正则守卫在前，`to_number` 在后，`-` 与缺失都失败关闭（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：
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

下面的夹具画像使用 `policy-poc` 中命名空间本地的 `taskRef.name: policy-demo-trivy-summary`（不带 resolver）。名字里的 `trivy` 只是**沿用了它所模拟的那种聚合字符串形态** —— 它是为本文构建的产出方夹具，**不是** catalog 的 `trivy-scanner`；后者已经发布 object result，请走 [§4.4.1](#s4-4-1)。把它套用到你自己的目标 Task 上时，必须改成那个 Task 完整的 `taskRef` 身份（hub 引用的话，包含 catalog / name / version）—— **绝不能**用 `tekton.dev/task` 之类的子级标签去识别它。

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

:::details 复现夹具与探针：字符串形态的产出方（policy-demo-trivy-summary）

下表中 `trivy-*` 那几行用的就是这份夹具 —— 它**不需要网络访问，也不拉漏洞库**；它只是把几种聚合字符串形态逐字写进 result。两个对象都要创建：`policy-poc` 中的那个是策略的目标，而 `tekton-templates` 中那个**同名** Task 是最后一行"同名不同源 —— 必须跳过"的对照。

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

把上面两个 Task 存为 `trivy-summary-emitters.yaml`（替换 `<registry>`）并先创建 —— 下面六个探针会按名字引用它们：

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

六个 `trivy-*` 探针只有 `mode` 不同（`clean` / `vuln` / `unknown` / `dup` / `smuggled` / `missing`）；形态如下：

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

一次性把六个都创建出来（每个名字都与其 mode 对应，这样报告里的记录一眼就能对上）：
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

最后一行的对照探针改用 cluster resolver 指向另一个命名空间中的同名 Task（它没有 `mode` 参数）：

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

把它存为 `trivy-same-name-other-source.yaml` 并创建：

```bash
kubectl create -f trivy-same-name-other-source.yaml
```

运行结束之后，等 TaskRun 到达终态，再读取判定结果（该策略是 Audit —— 所有请求都会放行；结论只存在于报告里）：

```bash
# On the cluster that runs Tekton and Kyverno.
kubectl get policyreport -n policy-poc \
  -o custom-columns=SUBJECT:.scope.name,RESULT:.results[*].result
```

**读报告需要耐心**：一个 TaskRun 会经历多次非终态的 status 更新，每一次都因为 `isTerminal` 前置条件而被记为 `skip`；运行刚转入终态时，你读到的通常仍然是那个 `skip`，只有等上报链路跟上之后终态判定才会出现（通常是数十秒量级）。**读一次就下结论，你测到的是竞态 —— 而不是策略。**

还有一种更隐蔽的形态：**本该被判为 `skip` 的那个对象，可能连报告行都还没有**。表格最后那行"同名不同源 —— 必须跳过"正是这种情况 —— 它的判定永远是 `skip`，所以你没法用"它有没有变成 fail"来判断它的报告是否已经写出；于是你可能得到"六个判定全对、第七行整个不见"的局面，看起来像是"不误伤对照没生效"，其实只是报告还没到。等待条件要写成"**七个对象的报告行都存在**，其中六个已经不再是 `skip`" —— 不要只等前半句。

**注意这些探针是你手工提交的裸 TaskRun**：装了 [§4.5.4](#s4-5-4) `pipeline-entry-lockdown` 的集群会在前面就把它们拒掉（[§4.0.5](#s4-0-5)）。

:::

:::details 两条策略的预期 PolicyReport（sonar 的四值域 + 六种字符串夹具场景 + 两个不误伤对照）

| TaskRun | result 输入 | PolicyReport |
|---|---|---|
| `audit-sonar-terminal-pass` | `Succeeded` | pass |
| `audit-sonar-terminal-failed-verdict` | `Failed` | fail |
| `audit-sonar-terminal-skipped` | `Skipped` | fail |
| `audit-sonar-terminal-canceled` | `Canceled` | fail |
| `audit-sonar-terminal-numeric-invalid` | 非法的形似数字取值 `"1"` | fail |
| `audit-sonar-terminal-missing-result` | 终态，`code-scan-results` 缺失 | fail |
| `audit-sonar-terminal-non-scanner` | 另一个 Task 身份 | skip |
| `trivy-clean` | `critical=0` | pass |
| `trivy-vuln` | `critical=3` | fail |
| `trivy-unknown` | `critical=-` | fail |
| `trivy-dup` | `critical=0;critical=9`（token 重复） | fail |
| `trivy-smuggled` | `critical=0=9`（token 内多一个 `=`） | fail |
| `trivy-missing` | 终态，`trivy-summary` 缺失 | fail |
| `trivy-same-name-other-source` | 同名 Task，但 `resolver=cluster` 且命名空间为 `tekton-templates` | skip |

以 `trivy-*` 开头的那几行用的是 [§4.4.2](#s4-4-2) 的**字符串形态产出方**，而不是 catalog 的 `trivy-scanner`（后者见 [§4.4.1](#s4-4-1) 的用例表）。

五条关键结论：① 在 sonar 真实的四值域中只有 `Succeeded` 记为 pass，终态而缺失 result 的运行同样失败关闭，而非扫描器的那次运行因为完整 Task 身份不匹配而跳过；② `critical=-`（表示"数量不可知"的短横线哨兵值）记为 **fail** —— 而且是干净的 fail，`error=0`：正则守卫加上短路表达式，从未把 `-` 送进 `to_number`；③ **`trivy-dup` / `trivy-smuggled` 正是那两道守卫（整 token 匹配 + 计数必须为 1）存在的理由**：把守卫换回"只匹配切出来的取值、取第一个 token"，这两个输入都会**被误判为通过**；④ 终态却缺失目标 result 的 TaskRun 照样记为 fail，而不是静默跳过；⑤ 从另一个命名空间解析出来的同名 Task 记为 skip，证明画像锁定的是 resolver 形态与命名空间本地的名字，而不是只比对名称。

:::

#### 4.4.3 反面演示：为什么绝不能对 status 做 Enforce {#s4-4-3}

:::warning 本节是反面演示 —— 任何环境下都不要模仿

把一条 [§4.4.1](#s4-4-1) 形态的策略切成 `Enforce` 会发生什么（下文把这条仅供演示的策略称作 `scan-verdict-enforce-wedge-demo` —— 与清理清单中的名字相同）：产出方的 Pod 已经 `Completed`（活全干完了），但控制器写入完成态被拒 —— TaskRun 永远停在 `Running`、没有 `completionTime`，而事件不断重复：

```text
Warning  UpdateFailed  taskrun/…  Failed to update status for "…": admission webhook "validate.kyverno.svc-fail" denied the request: …
```

该运行既不失败也不结束；只有人工介入才能解开：策略被删除或放宽之后，控制器会按其退避节奏重试，并自行恢复到正常终态。恢复时间取决于控制器的重试节奏与当时的负载 —— 通常在 1 分钟以内，但**不能承诺任何固定值**。识别与解除的步骤见 [§6.1.4](#s6-1-4)。

:::

顺带给出一个能证伪"是不是标签惹的祸"的对照：`scan-verdict-enforce-wedge-demo` 只匹配完整的夹具 TaskRef（`resolver=cluster`、`kind=task`、`name=policy-demo-scanner`、`namespace=tekton-templates`），从不读取 `tekton.dev/task` 标签。一个独立的对照 TaskRun —— 即便它伪造了那个标签、并写出同名的 `code-scan-results.result=Failed` —— 只要真实 TaskRef 对不上，它就会正常到达终态，不会被卡死。

#### 4.4.4 清点既有存量（后台扫描） {#s4-4-4}

- **治理什么**：策略**刚装上**时集群里**已经存在**的那一批对象 —— 准入只在新的 CREATE/UPDATE 事件发生时才求值，而既有对象不会产生新事件，所以准入一个都看不到。
- **难在哪里**：直接上 Enforce 会不分青红皂白地拦住对旧运行的后续操作 —— 而你根本不知道存量里有多少违规。
- **策略怎么分层**：① `background: true` 让 reports-controller **周期性地调和并扫描既有主资源** → ② `Audit` 模式把每个对象的求值结果写进 PolicyReport → ③ 由此得到违规基线并制定治理节奏（先整改存量，再切 Enforce）。
- **治理不了什么**：后台扫描**只作用于主资源** —— `*/status` 子资源策略（[§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2)）没有后台兜底，只在准入时刻求值（[§2.2](#s2-2)）。

下面这个例子清点的是"哪些 PipelineRun 没有带上 `policy.alauda.io/gated` 标记"（也就是 [§4.2.6](#s4-2-6) 的注入策略生效之前创建的旧运行）：
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

**两个既有运行的完整清单**（存为 `doc-inventory-runs.yaml`）—— 它们只差一个标签，都使用 [§3.3](#s3-3) 的可信模板，而且跑得很快：

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

把上面的策略存为 `inventory-ungated-runs.yaml`。**顺序不能颠倒** —— 先创建运行并等它们到达终态，**然后**再安装策略；反过来的话，这两个运行会经历正常的准入求值，你测到的就不再是既有资源的清点了：

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

**预期形态**：两个 PipelineRun 先被创建并到达终态，策略在**之后**安装（Policy 的创建时间晚于被测资源）。在**完全没有新资源事件**的情况下，PolicyReport 把带有 `policy.alauda.io/gated: "true"` 的既有运行记为 `pass`，把缺少该标签的既有运行记为 `fail`，而且结果属性中明确写着 `results[].properties.process: background scan`。

:::warning policy.alauda.io/gated 标签不是门禁真的跑过的证据

本例只是用它来演示"清点缺少平台标记的旧运行"。[§4.2.6](#s4-2-6) 的 mutation 会给没有显式设置该标签的请求注入 `"true"`，但**流水线使用者自己也能在 PipelineRun 上写一个同名标签** —— 所以这只能证明扫描时对象上存在那个标签值；它既证明不了 mutation 执行过，也证明不了该运行真的通过了硬门禁。

要清点"它是否真的受门禁约束"，请去校验真实的门禁事实（门禁任务是否存在及其 result；[§4.1.4](#s4-1-4) 的漂移 Audit），或者让一个可信入口写入业务用户伪造不了的策略版本 / 配置哈希标记。

:::

##### PolicyReport 是干什么用的（怎么读、怎么消费、不要指望它做什么）

PolicyReport 是 Kyverno 写出的一种**标准 Kubernetes 资源**（`wgpolicyk8s.io`）—— 每个被求值的资源一份，以该资源的 UID 命名：`summary` 给出 pass / fail / warn / error / skip 计数，`results[]` 逐条列出"哪条策略的哪条规则、判定为什么、消息是什么"。它把策略求值结果变成了集群里**可查询、可聚合、可程序化消费**的数据 —— 而这恰恰是 Audit 策略唯一的输出形式。

三种最常用的读法：

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

配合 [§3.5](#s3-5) 的"先 Audit"上线流程，它的价值在于把治理变成一个**可度量的过程**：先用 Audit + `background: true` 清点出基线（读法 3 给你一个数字），把名单交给各团队整改（读法 2），等数字降到 0 或可接受水平之后再切 Enforce —— 并且**在同一次变更里重新评估 `failurePolicy` 层级**：这条策略出厂时是 `Ignore`（纯记账没有拦截收益；见素材注释与 [§3.7](#s3-7) 的分级），但切成 Enforce 之后它就归入拦截类了 —— 按集群的可用性规划决定它是否要改回 `Fail`。整改之后报告会自行收敛 —— 给一个违规运行打上标签，它的报告会在下一次求值时从 `fail: 1` 翻成 `pass: 1`；不需要手工清理报告。

同时，也要把它的**边界**弄清楚，否则你会把它当成它承担不了的证据：

- **它不是审计日志。** 报告以资源 UID 命名，并随资源一起被垃圾回收：删掉运行，它的报告也就没了。长期留存需要外部采集（把报告导出到日志 / 指标系统）；不要指望在集群里翻历史。
- **被 Enforce 拒绝的请求不会留下报告。** 在准入阶段被拒的对象根本没有被持久化，也就没有资源可供挂载报告；那条路径上的证据是 Kyverno 事件加上调用方收到的报错消息（[§6.2](#s6-2)）。
- **`mutate` 规则不产生违规记录。** 被 [§4.2.3](#s4-2-3) 取消的 TaskRun 在报告里表现为 `result=skip`、消息 `no patches applied`（后台重新求值时对象已经处于目标状态）—— 而不是 `fail`。要让"哪些运行被策略动过"可查询，请另加一条 Audit 规则记账，或者依赖对象上的注解 / `statusMessage`。
- **它只回答"求值结论是什么" —— 回答不了"这条流水线是否真的执行了质量检查"。** 结论的强度取决于策略本身读了什么（[§2.3](#s2-3) 的各条契约）；报告只是把结论搬运出来。
- **没找到 `fail` 不等于合规** —— 这是审计场景中最容易搞错的一步。空结果至少有五种含义，而它们看起来一模一样：① 真的合规；② 策略**没匹配上**（模板 / Task 版本变化把一切变成了 `skip`，[§3.6](#s3-6)）；③ 请求被 `resourceFilters` **整体跳过**（既不拒绝也不记报告，[§3.1](#s3-1) 清单第 7 项）；④ 报告**还没收敛**（[§6.1.5](#s6-1-5)）；⑤ 对象连同报告**已经被 GC 掉了**。所以审计结论只能表述为"**没有可用的违规记录**"，除非你能同时拿出：匹配到的策略与规则名（读法 2 的 `policy` 字段）、当时 `resourceFilters` 的快照、报告已过收敛窗口的确认，以及对象本身仍然存在的证据。

:::warning 要事后证明某次发布过了门禁，只归档 PolicyReport 是不够的

报告随对象一起被 GC，而**被 Enforce 拒绝的请求根本没有对象** —— 所以证据分散在四个地方、四种生命周期：**PipelineRun / 门禁 TaskRun 的终态与 `status.results`**（证明"它跑了，结论是什么"）、**PolicyReport**（证明"策略怎么判的"）、**Events**（证明发生过一次取消 / 拒绝），以及**准入拒绝消息**（它只存在于调用方与 Kyverno 的日志里）。长期留存意味着**趁对象还活着**把这四类都采集下来，并以 PipelineRun UID 为键关联起来（对象名会重复，UID 不会）。

本文不为你的环境规定这些对象的保留期 —— **但你不必去猜**：把下面的命令跑一次，就能得到**当前仍然存在的最老 `PipelineRun`** 的时间戳。⚠️ **那只是四类证据之一的视界，不是整条证据链的视界**：如刚才所说，四者生命周期不同 —— `PolicyReport` 随其对象被 GC（对已删除的运行而言只会更近），而 Events 与准入拒绝消息各有各的保留策略（这两者可能相差很远：曾见过最老的 `PipelineRun` 与最老的 Event 相差 43 天，方向还与直觉相反）。要回答"那次发布还查得到吗"，请**四类各查一次**，取其中最近的那个视界。（在跑 Tekton 的集群上执行。）

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

按 [§4.0.4](#s4-0-4) 的两条规则清理。用归属账本按记录的 UID 删除那四条集群级策略；如果你**自己**按 [§4.4.3](#s4-4-3) 的描述搭过那条反面演示策略（本文刻意不为它提供可安装的 YAML），它在创建时同样应当被写进了同一份账本 —— 那就按你实际用过的名字删掉它，并且**先确认没有 TaskRun 因它卡在 `Running`**：

```bash
for pol in scan-verdict-audit vuln-summary-audit vuln-threshold-audit \
  inventory-ungated-runs; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
```

命名空间级的对象（上表中的 14 个 TaskRun、真实的 `trivy-scanner` 0.6 TaskRun 及其源码夹具 ConfigMap、两个清点用 PipelineRun，以及 [§4.4.2](#s4-4-2) 的两个产出方夹具 Task）都位于自建命名空间中，会被级联删除回收；如果你还要继续做后面的章节，请先按名字删掉那些运行类对象 —— 否则它们的 PolicyReport 记录会出现在下一节的 `kubectl get policyreport` 里（[§4.0.5](#s4-0-5)）：
```bash
# A read loop, not `kubectl delete $(...)`: with no match the substitution would leave
# a delete with no names (an error), and an unquoted expansion is a paste trap anyway.
kubectl get taskrun -n policy-poc -o name \
  | grep -E '/(audit-sonar-terminal-|trivy-)' \
  | while read -r tr; do kubectl delete -n policy-poc "$tr"; done
kubectl delete pipelinerun -n policy-poc doc-inventory-gated doc-inventory-ungated \
  --ignore-not-found
```

### 4.5 来源、镜像与发布目标（契约 1"身份" / 契约 7"入口封闭"的运行时侧） {#s4-5}

本章覆盖三个未授权面：制品从哪里来（拷贝输入）、实际运行的是什么镜像（执行镜像）、发布到哪里去（发布目标）—— 外加入口封闭。

**本节导览**（按流水线的物料流向排列）：

- **[§4.5.1](#s4-5-1)** —— 制品拷贝来源白名单（真实的 `skopeo-copy` 画像）：输入从哪个镜像仓库拉取。
- **[§4.5.2](#s4-5-2)** —— 源镜像属性校验：用 `context.imageRegistry` 读取镜像 config，判定镜像自身的属性，而不只是它的名字。
- **[§4.5.3](#s4-5-3)** —— 执行镜像白名单：**Pod 级硬拦截**，是全文唯一能治理"这个 step 实际运行什么镜像"的观测点。
- **[§4.5.4](#s4-5-4)** —— 封堵裸 `TaskRun` / `CustomRun` 入口（契约 7）：[§4.2](#s4-2) 中那些从父运行推导身份的判据，只对控制器创建的子 TaskRun 成立；本节封的是绕开任何父运行、直接创建 Run 的那个入口（Pod 级的 [§4.5.3](#s4-5-3) 不受入口影响 —— 两者互补）。
- **[§4.5.5](#s4-5-5)** —— 发布目标白名单（真实的 `-image-build-scan-deploy` 0.3 画像）：产物可以发布到哪个命名空间 / 可以使用哪一套凭据。

#### 4.5.1 制品拷贝来源白名单（真实画像：skopeo-copy） {#s4-5-1}

- **治理什么**：**制品只能从已批准的镜像仓库拷入**。场景是用平台 catalog 的 `skopeo-copy` 做镜像拷贝 / 晋级；来源不受控时，任何人都能把一个外部镜像"拷"进内部仓库 —— 从此它就算"内部镜像"了。这是供应链投毒最廉价的入口。注意这里治理的是**拷贝的输入参数**，而不是这个 TaskRun 自身跑在什么镜像上（那是 [§4.5.3](#s4-5-3)）。
- **难在哪里**：`skopeo-copy` 允许**三种方式**指定来源，漏掉任何一种都是绕过口子 —— ① 简单模式，`srcTransport` + `srcImage`（裸引用，**不带** `docker://` 前缀）；② 内联模式，`imageMappings`（数组，每项为 `"SRC DST"`，**带** `docker://` 前缀）；③ 文件模式，一个 `copy-mappings` workspace（其内容在准入时**完全不可见**）。三者连前缀写法都不一样 —— 这正是下面这条策略要带那么多 context 变量的原因。
- **策略怎么分层**：① 先锁"这是不是那个 Task"（`taskRef` 中完整的 resolver 坐标 —— **绝不用节点别名或子级标签**，它们可以经 `taskRunSpecs` 覆盖伪造）→ ② 再锁"这个 Task 有没有被换掉"（拒绝请求级 `url`；显式 `type` 只能是 `artifact` —— 防的是"名字还是它，内容换成我的"）→ ③ 然后才是来源白名单（各模式各自的前缀 + `srcTransport` 只能是 `registry`；显式空字符串不等于缺失，不得继承默认值）→ ④ 三道失败关闭兜底：**换行夹带**、**文件模式直接拒绝**，以及**一个来源都识别不出来时拒绝**。
- **治理不了什么**：它只有在"**确实使用了这个 Task**"时才有效。任何绕开 `skopeo-copy`、创建一个跑 skopeo / crane 镜像的裸 TaskRun 手工推镜像的人，完全在这条规则的射程之外 —— 它必须与 [§4.5.4](#s4-5-4)（封堵裸 Tekton Run 入口）和 [§4.5.3](#s4-5-3)（Pod 级执行镜像白名单）一起才成立。

**通用契约**：约束"拷贝类任务的输入参数"。参数校验只在"用了这个任务"的场景下有效 —— 它必须与入口封堵（[§4.5.4](#s4-5-4)）配对；否则绕开这个任务直接推镜像就把它废掉了。

`skopeo-copy`（0.1）的三种来源模式都必须覆盖（字段取自真实的 Task 定义）：① 简单模式，`srcTransport`（默认 `registry`）+ `srcImage`（**裸镜像引用，不带 `docker://` 前缀**）；② 内联模式，`imageMappings`（数组，每项为 `"SRC DST"`，**带 `docker://` 传输前缀**）；③ 文件模式，一个 `copy-mappings` workspace（其内容在准入时**不可见**）。

**关键判据** —— 每种模式各算一个布尔值，`any` 下命中任意一条即拒绝；注意 `mappingsMalformed` 那一条不是凑数的：

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

**为什么换行夹带需要单独判定**：catalog 的脚本是**逐行**读取 mappings 的。往某个数组元素里塞一个 `\r\n` —— 第一段是已批准来源，第二段夹带一个未授权来源 —— 白名单只会看到第一段，而第二个来源就混过去了。所以两种模式都必须先断言"单行"，然后才应用前缀白名单。

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
| 简单模式：`srcImage` 来自已批准仓库 | 放行 |
| 简单模式：`srcImage` 来自 `docker.io` | 拒绝 |
| 简单模式：已批准的 `srcImage`，但 `srcTransport=oci-archive` | 拒绝 |
| 简单模式：显式为空的 `srcTransport` | 拒绝（空字符串不是缺失；不继承默认值） |
| 简单模式：`srcImage` 第一行已批准，第二行夹带未授权来源 | 拒绝 |
| 内联模式：`imageMappings` 每一项都已批准 | 放行 |
| 内联模式：混入一个未授权来源 | 拒绝 |
| 内联模式：单条 mapping 内嵌换行、夹带第二个来源 | 拒绝 |
| 文件模式：带有 `copy-mappings` workspace | 拒绝（准入盲区） |
| 一个可见来源都没有 | 拒绝（失败关闭） |
| 节点别名相同，但 Task 身份不是 `catalog/skopeo-copy/0.1` | 规则跳过 —— 不误伤 |
| 单独显式的 `type=artifact` | 放行 |
| 已批准元组 + 请求级 `url` | 拒绝 |
| 已批准元组 + 显式 `type=tekton` | 拒绝 |

:::

**文件模式的权衡**：`copy-mappings` workspace 里的 `SRC DST` 列表在准入时无法检视，所以本策略**直接拒绝该模式**。如果某个团队确实需要文件模式，正确答案是把列表内容的治理**上移**（去治理产出该 workspace 的上游任务 / 制品），而不是指望这条准入策略来兜底。

**它判定的是"请求里出现了什么"，而不是"Task 最终消费了什么"** —— 这是一个刻意保守的超集；安装之前先了解代价。`skopeo-copy` 自己有输入优先级：`imageMappings` 非空时用它，而 `srcImage` / `dstImages` 与 `copy-mappings` workspace 会被**忽略**；没有它才轮到简单模式；再没有才读文件模式。本策略**不复刻那套优先级** —— 任何一种模式里出现未批准来源，一律拒绝。

- **为什么不复刻**：判据一旦跟随 Task 的内部优先级，等到 Task 的下一个版本调整那套优先级时，策略就会**静默**放行 —— 这正是 [§4.2.4](#s4-2-4) 三问中第 3 问要防的形态。宁可过度拒绝，也不要静默漏判。
- **代价（两种已知误拒）**：① 合规的 `imageMappings` 加上一个没清理干净的、范围之外的遗留 `srcImage`；② 合规的简单模式加上一个随手绑定的 `copy-mappings` workspace —— 上游对这个组合有正式用例，运行时简单模式胜出、该 workspace 从不会被读取。这两种都会被本策略拒绝。
- **被拒时怎么办**：先检查请求里**是不是带了它并不使用的来源参数或 workspace 绑定** —— 删掉就能通过。不要为了放行那个"反正不会被读"的条目而放松判据 —— 准入看不到 Task 运行时的选择，而那个"反正"没有人担保。

#### 4.5.2 源镜像属性校验（`context.imageRegistry` 读取镜像 config） {#s4-5-2}

- **治理什么**：不只是"参数点名了哪个镜像"，而是**镜像自身的属性** —— 例如"被晋级的基础镜像必须带有 `build=tekton` 标签"、"它必须声明 `org.opencontainers.image.source`"。
- **难在哪里**：这些属性位于 OCI 镜像的 config 里；**它们不是任何 Kubernetes 对象的字段**，`context.apiCall` 够不着。
- **策略怎么分层**：① 收窄到拷贝类 Task，且只在它确实带有源镜像引用时 → ② 在准入期间用 `context.imageRegistry` 直接从镜像仓库拉取该镜像的 manifest / config → ③ 用 JMESPath 下钻到 `configData.config.Labels` 之类给出判定 —— **标签缺失必须显式默认成一个永远不可能通过的值**，否则规则会失败开放。
- **第 ① 层是最容易埋雷的地方**：Task 身份必须**同时**从 `taskRef.name` 与 resolver 的 `taskRef.params` 读取 —— 集群内引用把名字放在 `.name` 里，而在 hub / git / cluster resolver 形态下 `.name` 是**空的**、名字在 `params` 里。只匹配 `.name` 等于**静默跳过**所有 resolver 形态的 TaskRun（策略装上了、看起来没问题、什么都拦不住）。在生产中，请像 [§4.5.1](#s4-5-1) 那样进一步收紧到完整的 resolver 坐标。
- **治理不了什么**：**它只能读取准入时刻已经存在的镜像**（所以它只能校验来源，永远校验不了本次操作正在产出的目标）；而且它把外部网络放到了准入路径上 —— 四条局限见下面的警告；上线前先权衡。

对于这类需求，Kyverno 提供了另一个外部数据源 **`context.imageRegistry`**：在准入期间，Kyverno 自己从镜像仓库拉取指定镜像的 manifest / config，把结果放进一个变量，再由 JMESPath 下钻到 `configData.config.Labels` / `.Env` 或 `configData.architecture` 之类的字段。

**关键判据** —— 用 `|| 'MISSING'` 兜住标签缺失，确保它落到拒绝侧：

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

含点号的标签键在 JMESPath 中需要加引号才能下钻 —— 例如 `{{ imgdata.configData.config.Labels."org.opencontainers.image.source" || 'MISSING' }}` —— 之后就能正常读出。

:::warning 四条局限 —— 用之前先权衡

1. **它只能读取准入时刻已经存在的镜像。** 在拷贝 / 晋级场景中，目标镜像正是本次操作产出的，准入时它还不存在 —— **只能校验来源**；目标的属性要等它落到镜像仓库之后，由部署侧准入（[§4.5.3](#s4-5-3)）或专门的门禁任务来校验。
2. **可变 tag 存在竞态**：准入读取的是该 tag 此刻指向的 config；等到拷贝真正执行时，tag 可能已经被重新推送过了。要堵住这个缝，就让上游先把 tag 解析成 digest，而策略只校验 digest 形式的引用。
3. **私有镜像仓库需要凭据**：Kyverno 是以**它自己的身份**拉取镜像的，必须为它配置相应的 imagePullSecret / 仓库凭据，否则规则会因拉取失败而报错。**方向是失败关闭**：把 `srcImage` 指向一个不可达地址（`192.0.2.1/ops/nowhere:latest`），请求会**被拒**，拒绝消息里就是这条策略的名字；而同一条策略对可达镜像放行。**所以镜像仓库一旦不可达或凭据过期，所有经过这条策略的流水线都会被成片拒绝** —— 上线之前先决定这是不是你想要的方向（如果你想要失败开放，唯一的办法是不使用这类判据；Kyverno 没有"外部数据取不到时放行"的开关）。**还有一个比凭据更早的失败点：认证可能根本没有被尝试。** 当镜像仓库的 `www-authenticate` 响应把 realm 指向一个**私有或链路本地地址**时，Kyverno 使用的镜像库会拒绝去那里换取 token，规则报 `invalid realm in www-authenticate: realm host "<private-ip>" is a private or link-local address` —— 最容易在用集群镜像仓库的 IP 形式（`<private-ip>:<port>/...`）引用镜像时踩到，而且凭据再正确也没用；用集群内 DNS 名（例如 `registry.kube-system.svc.cluster.local`）引用同一个镜像就能正常读到。方向仍然是失败关闭（规则报错、请求被拒），所以**看到这个报错请去检查镜像是怎么引用的，而不是去查凭据**。
4. **它把外部网络放到了准入路径上。** 一次准入判定现在要等一趟镜像仓库往返，可能把延迟从普通准入的数百毫秒**推到秒级**，而且方差很大（仓库距离、镜像大小、缓存命中）；**冷启动的第一次调用甚至可能直接撞上 webhook 超时**：`failed calling webhook "validate.kyverno.svc-fail": context deadline exceeded`，重试才能通过。当镜像仓库变慢、被限流或不可达时，**每一个**被这条规则匹配到的请求都会变慢或失败 —— 在离网与大规模环境中，上线前请做压测，并把 match 收窄到确实需要它的那些 Task。量级参考：同一个 `--dry-run=server` 探针，对可达镜像大约 **3 秒**返回放行，指向不可达地址时大约 **5 秒**后返回拒绝（含 `kubectl` 往返）—— **这两个数字都远高于任何不读外部数据的准入判定**。把它们当作"这条规则该不该上主路径"的参考，而你自己环境的实际数字要自己测。

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

**先弄清你手上那个镜像实际带有哪些标签** —— 本节的判据断言的是**具体取值**，而本文无法为你的环境准备一个带标签的镜像。所以顺序是"先读镜像，再写判据"，而不是反过来：

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

用你读回来的真实键值写正向用例，再用**同一个键配上该镜像并不具备的取值**写负向用例。**如果输出是 `null` 或 `{}`，或者你想断言的那个键不存在，那么这个镜像不适合作为本节的正向用例**：这条规则的目标对象是**由你自己流水线构建、带有元数据的产品镜像**（`build` 与 `org.opencontainers.image.source` 都是在构建时注入的）；面对没有这些标签的第三方基础镜像，它只会把一切都拒掉。要么换成自建镜像，要么把这条规则的 match 收窄到只覆盖自建产物。

沿途有两个容易误读的现象：**① 这些标签是否存在，完全取决于你环境里基础镜像的构建流水线** —— 并不存在"内部镜像默认带有它们"这样的普遍规律。写判据之前，先用上面的 `skopeo inspect`（或等价手段）确认目标镜像**实际**带有哪些标签："读回来是空的"在你的环境里可能就是常态 —— 它意味着构建时没有注入这些元数据，而不是命令写错了（本文示例中用到的夹具镜像恰好带有 `build=tekton` 与 `org.opencontainers.image.source` —— 那是构建它的那条流水线的产物，不是普遍规律）。**② 有标签不等于有你想要的那个键**：同一个集群上不同镜像的标签集合可以不同，而 `build` 与 `org.opencontainers.image.source` **可能只存在其中一个**（例如同一集群上的某个 Tekton 组件镜像，可能只带 `org.opencontainers.image.source` 而没有 `build`）；这些集合还会随构建流水线的演进而变化，所以永远不要把其中任何一族当成必然存在。写判据之前，逐个键确认目标镜像**实际**带有哪些标签（`crane config <image> | jq '.config.Labels'`）；不要因为"标签非空"就动手写判据 —— 键缺失时这条规则会拒掉那个镜像，而那并不是配置错误。

**上面两份完整 YAML 都只断言 `build` 这一个标签**（`buildLabelBad` 那一行）—— 不要以为它们顺带治理了 `org.opencontainers.image.source`。要换成（或增加）另一个键，你要改的是 context 里那一行，形态完全相同 —— 含点号的键需要加引号才能下钻：
```yaml
        - name: sourceLabelBad
          variable:
            jmesPath: "(imgdata.configData.config.Labels.\"org.opencontainers.image.source\" || 'MISSING') != 'ops/baseimage'"
```

加上它同时意味着要把 `sourceLabelBad` 接进 `deny.conditions`（作为 `buildLabelBad` 的兄弟项；`any` 表示任一缺失即拒绝，`all` 表示两者都缺失才拒绝）；**只在 context 里加了变量而没接进 conditions，判据一点都没变** —— 这正是"策略装上了却没生效"里最难被发现的那一种（[§6.1.2](#s6-1-2)）。而接线的时候，**请同时改 `validate.message`**：判据接上了，用一个"有 `build` 但没有 source 标签"的镜像去撞它 —— 它被拒了，可消息里仍然只写着 `must carry label build=tekton`，于是被拦住的人跑去排查一个本来就合规的标签（[§4.0.6](#s4-0-6) 的最低标准）。两条判据都在时，消息这样写（点出两个键，让人知道该查哪两个）：

```yaml
        message: >-
          source image must carry an approved value for BOTH labels build and
          org.opencontainers.image.source; read the labels in the image config to
          see what this image actually has.
```

注意这条消息**只点名键，绝不写出已批准的取值**：写上"已批准取值是 X"，等于把白名单交给每一个被拒的人（[§4.0.6](#s4-0-6) 第三条规则）。具体取值 `build=tekton` 之所以出现在本文正文里，是因为它是示例判据要求的取值 —— 那并不意味着它适合出现在拒绝消息里。

**验证要点**：把同一个 `skopeo-copy` TaskRun 用 `kubectl create --dry-run=server` 跑一遍 —— 判据里填的是该镜像真实的标签取值时（本文示例夹具是 `build=tekton`）它被放行；把要求改成该镜像并不具备的 `build=production`，它被拒绝，并透传出策略消息。负向用例是必须的：它证明取值确实是从镜像 config 里读出来的，而不是因为什么都读不到而默认放行。如果你按上一段加了 source 标签判据，请同样跑一遍它的正反两格 —— **新加的判据必须自己验证过；不要指望 `build` 那一格替它作保**。
#### 4.5.3 运行镜像白名单（Pod 层硬拦截） {#s4-5-3}

- **治理什么**：**流水线中实际运行的容器镜像必须来自已批准的镜像仓库**。前面几节治理的都是"参数里写了什么"；这一节治理的是"最终执行的是哪个镜像" —— 它是唯一能对**实际运行的镜像**给出硬判定的拦截点。
- **难在哪里**：① TaskRun 层**看不到**引用式任务的 step 镜像（[§2.1](#s2-1) 观测点 4）；只有在 Pod 上才有解析之后的真实取值；② 镜像有**三条入口路径**，漏掉任何一条都会留下绕过面 —— Pod CREATE、Pod 的普通 UPDATE（Kubernetes 允许修改 `containers` / `initContainers` 的镜像），以及事后注入调试容器的 `pods/ephemeralcontainers` 子资源 UPDATE；③ 范围必须限定在 Tekton 创建的 Pod 上，否则该命名空间里所有业务 Pod 都会被误伤 —— 而那个 `managed-by` 标签的取值是**平台可配置的**，硬编码就会造成静默失配。
- **策略怎么分层**：① 用 Tekton 的 `managed-by` 标签把范围收敛到 Tekton Pod，标签取值要从 `config-defaults` 实际解析出来（区分键缺失与显式空值）→ ② 三条规则分别覆盖 CREATE / 普通 UPDATE / `ephemeralcontainers` 子资源，用 `foreach` 逐个断言每个镜像 → ③ 除了业务镜像仓库，白名单还必须包含 **Tekton 基础设施镜像**的五类仓库（entrypoint / nop / shell / sidecar log results / workingdirinit），否则合规流水线自己都起不来 → ④ 顺手把身份标签锁成**不可变** —— 否则攻击者可以先删掉标签，再从子资源溜进来。
- **治理不了什么**：它保证的是"镜像来自已批准仓库" —— **而不是镜像内容可信**。签名 / 证明校验（verifyImages）同样作用在 Pod 层，但属于配套文档。另外，`<approved-registry-regex>` 之类的占位符是**正则片段，不是主机名**；替换时必须逐字符转义元字符（见下面的设计要点 2）—— 照抄会扩大匹配面。

**关键判据** —— 正则**只声明一次**，由 `foreach` 逐容器引用；一条表达式同时容纳"业务镜像仓库"与"Tekton 基础设施镜像"两类：

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

这两个占位符含义完全不同：`<approved-registry-regex>` 匹配的是**镜像仓库前缀**（其后跟 `/.*`），而 `<tekton-infra-image-regex>` 匹配的是**完整仓库**（其后跟 `(:|@)`，即 tag 或 digest）。如何生成它们见下面两个小节。

有六个设计要点你必须理解：

- **把范围限定到 Tekton Pod，但绝不要硬编码标签取值。** 读取 `tekton-pipelines/config-defaults` 的完整 JSON，并**区分键缺失与显式空值**：只有当 `default-managed-by-label-value` **缺失**时，Tekton 的默认值 `tekton-pipelines` 才适用；键存在但取值为空**不会**走默认分支 —— 控制器会写入一个空的标签值，这是部署层面的阻塞项：必须先把它改成非空值，而策略渲染不能自作主张地回落。把解析出来的那个确切的、非空的取值替换进策略里每一处 `<tekton-managed-by-label-value>`，并在 Pod 的普通 UPDATE 上锁住该标签不得删除、不得修改 —— 否则自定义取值会让所有规则静默失配，或者攻击者可以先摘掉标签，再避开 `ephemeralcontainers` 子资源。对那个 ConfigMap 的修改必须受 RBAC 管控，并与策略的重新渲染**原子地**一起发布。
- **占位符是正则片段，不是原始主机名。** 替换时逐字符转义 RE2 元字符；对于镜像仓库 / 仓库路径的合法形态，至少要做 `.` → `[.]`、`[` → `[[]`、`]` → `[]]`，于是 `[2001:db8::1]:5000` 渲染成 `[[]2001:db8::1[]]:5000`。这种不含反斜杠的写法还顺带绕开了 YAML 双引号的转义问题；把含 `.` 或 IPv6 方括号的主机名直接塞进 `regex_match`，要么扩大匹配，要么让表达式报错。
- **白名单必须包含 Tekton 五类基础设施镜像仓库的当前配置。** 取值方法见下一小节 —— **两次读取要合并使用**；只用其中一次，两个方向都会出错。⚠️ **上游控制器实际声明了六个镜像参数** —— 第六个是 `-shell-image-win`（script 模式在 **Windows 节点**上使用的 PowerShell 镜像；上游至今仍把它默认成一个公共 MCR 镜像）。本节的五类与取值命令**刻意排除了它**：纯 Linux 集群永远不会实例化它，把它拉进白名单只是白白扩大白名单。**集群上跑 Windows TaskRun 的站点必须把它也加上**，否则那些 Pod 会被拒 —— 而那种拒绝是**响亮的**（`PodCreationFailed`，白名单形态，见 [§3.6](#s3-6)），不是静默放行。
- **消息必须点名违规镜像**，而且**同一条规则内正则只能声明一次**。前半句是为使用者：只看到 `PodCreationFailed`、而一个 Pod 里有十几个容器时，你根本不知道该修哪一个；后半句是为维护者。当前形态由三条真实约束决定：① **`element.*` 不能出现在 `validate.message` 中** —— Kyverno 在策略创建时就会拒绝（`variable 'element.name' present outside of foreach at path /validate/message`），而 `foreach` 条目也没有 `deny.message` 字段 —— 所以唯一的办法是在 `context` 里用同一条正则重新算出一份 `badImages` 列表；② 那次重算**不能复制正则** —— 把正则放进一个 `variable`，在该规则内处处引用它。两条判定镜像的规则契约不同：CREATE / UPDATE 规则的 `allowedImageRe` 同时含有 `<approved-registry-regex>` 与 `<tekton-infra-image-regex>`；而 `ephemeralcontainers` 规则的 `approvedRegistryRe` 只含 `<approved-registry-regex>`，刻意不允许基础设施仓库。所以已批准仓库那个占位符出现在两处、必须保持一致，而基础设施仓库那个只出现一处（context 变量不跨规则共享）；③ 在 `jmesPath` 内部引用那个变量必须写成**带引号的 `'{{ allowedImageRe }}'`** —— 写成裸标识符 `regex_match(allowedImageRe, image)` 时，JMESPath 会把它当作**资源的字段**去查找，得到 null，于是整条消息渲染成空字符串（判定依然正确，但使用者一点信息都拿不到）。还有两个陷阱：`[a, b][] | [?...]` 里的 `|` 是必需的（**没有它，过滤器会静默返回 `[]`**，消息变成"违规镜像：[]" —— 比什么都不说更误导）；以及只挑出不合规的镜像 —— **不要把整份白名单打印进消息**（那会把批准名单泄露给流水线使用者，[§4.0.6](#s4-0-6)）。

:::warning 正则写坏的两个方向（方向相反 —— 两者都要会认）

在每条判定镜像的规则内部，正则现在只声明一次；但整条策略有两条规则判定镜像，所以 `<approved-registry-regex>` 仍然出现在两处、必须保持一致。而且正则本身照样可能写错（漏转义、括号不配对）。两种失效形态表现完全不同；排障之前先分清你遇到的是哪一种：

- **`deny` 判据所用的正则无效**（比如括号不配对）→ **所有请求都被拒**，合规 Pod 也不例外。**失败关闭，而且很响** —— 切到 Enforce 之后第一条流水线就会失败，你不可能错过。
- **只有 `badImages`（消息侧）的计算写错了**（正则无效，或者与判据不同步）→ **判定完全正确，但消息里把合规镜像也列了出来**。对于一个"合规 sidecar + 违规主容器"的 Pod，两个镜像都会出现在消息里。**失败安全但很安静** —— 没有人会怀疑一条正确拦住了违规镜像的策略，于是使用者照着消息，跑去修那个本来就合规的镜像。

所以替换完 `<approved-registry-regex>` 之后，**正反两个探针都要跑**：违规 Pod 必须被拒，**且消息里只有那一个镜像**；合规 Pod 必须被放行（[§4.5.3](#s4-5-3) 九个自查探针中的第 1、2 个）。

:::
- **被断言的是请求里的原始字符串 `element.image`，而不是 Kyverno 解析出来的 `images.*`。** 两者不是一回事：一个不带镜像仓库的镜像（`nginx:1`）在 `element.image` 中**保持原样**，因此匹配不上任何 `<registry>/...` 前缀而**被拒**（失败关闭 —— 正是你想要的方向）；而 Kyverno 放进 `images` context 的 `registry` 是它**归一化之后**的取值（`nginx:1` 会被补全成 `registry=docker.io`）。改用 `images.*` 等于把判据的信任根从"请求说了什么"换成"Kyverno 怎么归一化" —— 凭空多出一层可配置行为。**请坚持断言原始字段。**
- **`foreach` 显式遍历三个容器列表**（`containers` / `initContainers` / `ephemeralContainers`），逐个断言镜像 —— 比 `pattern` 更清楚，而且能在消息里点名违规镜像。Pod 的普通 UPDATE 可以修改 `containers` / `initContainers` 的镜像，所以第一条规则必须**同时匹配 CREATE 与 UPDATE**；而 `ephemeralContainers` 是在 **Pod CREATE 之后**通过 `pods/ephemeralcontainers` 子资源 UPDATE 注入的，需要单独那条 `v1/Pod/ephemeralcontainers` 规则。**顺带说一下这条策略里 `kinds` 的两种写法**：第一条规则写的是 `Pod`，后两条写的是 `v1/Pod` 与 `v1/Pod/ephemeralcontainers` —— **两种匹配面完全相同**：Pod 属于 core group，而它只有 `v1` 这一个 group version，所以带不带前缀都只能命中那一种请求。这与 [§3.2](#s3-2)"API group-version 前提"中 Tekton 资源的情形不同：在 `tekton.dev` 之下，`v1` 与 `v1beta1` **并存**，所以那里的 group-version 前缀是必须的 —— 省略或写错都会真正改变匹配面。

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

##### 如何生成 `<tekton-infra-image-regex>`（完整示例）

上一节只说了"白名单必须包含五类基础设施镜像"；这里给出完整、可照做的流程。**关键认知：准入看到的镜像地址是平台镜像改写*之后*的形态** —— 控制器启动参数（命令 A）给出的是**改写之前**的地址，但清单是完整的；采样真实 Pod（命令 B）给出的是改写之后的形态，但清单**必然不完整**（你只能看到恰好跑过的那几类）。所以白名单的正确来源是：**A 取清单 → A2 把地址前缀换成平台私有镜像仓库地址 → B 只用于交叉验证**：

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

:::warning A 与 B 的输出很可能不同 —— 而这正是本节最容易踩的陷阱

- **照抄 A（跳过前缀改写）**：ACP 的镜像改写会更换镜像仓库主机。控制器参数里可能写的是 `registry.example.com/pipelines/...`，而准入实际看到的是 `192.0.2.10:11443/pipelines/...`。直接从启动参数生成正则 → **所有 Tekton Pod 当场被拒**，连合规流水线都起不来 —— 这就是 A2 必须做的原因。
- **把 B 当成清单**：任何一次采样只能看到这一批运行恰好实例化出来的那几类。五类基础设施镜像并不是每次运行都会用到 —— 一次采样很容易只含其中两三类（`nop` 只有在某个 step 被跳过时才会注入，常常压根不出现）；**如果一个 TaskRun Pod 都没跑过，采样就直接是空的**（代码块里的守卫写明了这一点）。只靠 Pod 来构建取值，等到某个未被采样到的类别真正需要时，它就会被误拦。B 只有一个正确用途：**验证 A2 的改写结果** —— 某个仓库出现在 B 中却不在 A2 的输出里，说明改写规则写错了，或者存在第六类镜像；继续之前先查清楚。

正确流程：**以 A 的清单、经 A2 前缀改写之后的结果作为生成来源**，并用两条交叉验证路径兜底 —— B（采样真实 Pod）与已安装状态对象（operator 的 `TektonConfig` / `TektonPipeline` CR，以及 `tekton-pipelines` 命名空间中 Deployment 的镜像，与 [§4.0.3](#s4-0-3) 占位符表同一种读法）；若任一路径冒出 A 之外的仓库，先弄清它是不是新的一类，再扩充清单。剥掉 tag / digest，只保留仓库，然后逐字符转义。

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

生成结果（针对本例）—— 把它替换到策略中的 `<tekton-infra-image-regex>` 处（**只有一处**：仅在 CREATE / UPDATE 规则的 `allowedImageRe` 中；`ephemeralcontainers` 规则刻意只允许业务侧的 `<approved-registry-regex>`，不把 Tekton 基础设施仓库当作临时调试容器的来源）：

```text
192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-entrypoint|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-nop|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-shell-image|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-sidecarlogresults|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-workingdirinit
```

当五类共用同一个主机与路径时，你可以手工把它压缩成等价形式（两种写法行为一致）：
```text
192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)
```

与业务镜像仓库（示例：`registry[.]example[.]com|192[.]0[.]2[.]20:60070`）配合之后，策略中的完整表达式渲染为：

```text
^((registry[.]example[.]com|192[.]0[.]2[.]20:60070)/.*|(192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit))(:|@).*)$
```

**替换之后的自查** —— 用 `kubectl create --dry-run=server` 去撞真实的 Kyverno，正反各跑一组：

:::details 自查探针（9 个，其中三个近邻用例证明转义生效）

| 探针镜像 | 预期 |
|---|---|
| `…:11443/pipelines/tektoncd-pipeline-entrypoint:v1.12.0` | 放行 |
| `…:11443/pipelines/tektoncd-pipeline-sidecarlogresults@sha256:0000…` | 放行（digest 形式） |
| `…:11443/pipelines/tektoncd-pipeline-nop:v1.12.0` | 放行（通常不会出现在 B 的采样里 —— `nop` 只有在某个 step 被跳过时才注入；清单的完整性由命令 A + A2 保证） |
| `192.0.2.**100**:11443/…/tektoncd-pipeline-entrypoint:v1.12.0` | 拒绝（近邻主机） |
| `192.0.2.10:**11444**/…/tektoncd-pipeline-entrypoint:v1.12.0` | 拒绝（近邻端口） |
| `…:11443/pipelines/tektoncd-pipeline-**evil**:v1.12.0` | 拒绝（同主机，但不属于那五类） |
| `192**X**0.2.10:11443/…/tektoncd-pipeline-entrypoint:v1.12.0` | 拒绝（**证明 `.` 被转义了**：不转义的话，这个主机会通过通配匹配上） |
| `…/tektoncd-pipeline-entrypoint`（无 tag、无 digest） | 拒绝（表达式要求末尾有 `(:\|@)` 段） |
| `docker.io/library/busybox:latest` | 拒绝 |

:::

:::warning 别漏掉第六类：Windows 节点

除上面五个参数之外，控制器还有一个 `-shell-image-win`，默认指向一个 Windows 基础镜像。如果集群上有跑 Tekton 的 Windows 节点，**它同样必须加进白名单**，否则 Windows 上的 step 会被拒。纯 Linux 集群可以不加，但升级之后建议重跑命令 A（以及 A2 的前缀改写）复核参数集合是否发生了变化。

:::

##### 让一条策略跨环境通用（策略里不硬编码任何前缀）

上面的示例把前缀直接渲染进了 YAML；问题在于**每个环境的镜像仓库主机与仓库路径都不同**，于是策略正文会按环境分叉。更好的做法是：**策略里一个前缀都不写，把环境差异集中到一个 ConfigMap 里** —— 同一份 ClusterPolicy 原样下发到每个环境，各环境只填这一处配置（取值仍然按上面的方法生成：A 取清单 → A2 前缀改写，B 交叉验证）。

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

把它存为 `pipeline-image-allowlist.yaml`。**这个 ConfigMap 必须先于策略存在** —— ConfigMap 缺失时策略失败关闭，也就是说安装顺序反了，范围内所有 Tekton Pod 都会被拒。看起来像"白名单写错了"，实际只是配置还没到位：

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

在策略侧，用 `context.configMap` 把它拉进来，并在 `regex_match` 内部展开变量。**关键判据**就是这两行 —— 正则不再是字面量，而是从 ConfigMap 变量展开而来：

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

:::warning 切换到这种形态时，三条规则必须一起切

这条策略与上面那条**同名**（`pod-image-registry-allowlist`），所以安装它是**整体替换**而不是追加。因此三条规则必须一并带上：只把第一条（容器镜像白名单）搬过来，而丢掉 `tekton-managed-by-label-is-immutable` 与 `tekton-ephemeral-images-from-approved-registries`，等于亲手打开两条绕过路径 —— 攻击者删掉作用域标签让规则失配，或者直接通过 `pods/ephemeralcontainers` 子资源注入未批准镜像。下面给出的是完整的三规则版本。

:::

:::details 完整策略 YAML：pod-image-registry-allowlist 的 ConfigMap 形态（三条规则）

与上面的字面量版本唯一的区别：每条使用正则的规则各自带有自己的 `context.configMap`，而正则从 `{{ allowlist.data.* }}` 展开。`<tekton-managed-by-label-value>` 仍然留在策略正文里（本节末尾有解释）。

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

注意 `<tekton-managed-by-label-value>` **仍然留在策略正文里**：这种形态收敛的是与环境相关的镜像仓库前缀；作用域标签取值属于另一类配置（取值方法见 [§4.0.3](#s4-0-3) 的占位符表），如果它也需要集中管理，可以挪进同一个 ConfigMap。

有三条实际行为值得了解：

- **变量在 `regex_match` 内部能正确展开**：合规的基础设施镜像（tag 形式与 digest 形式）被放行；同主机但不属于那五类的 `…/tektoncd-pipeline-evil`，以及 `docker.io/library/busybox`，都被拒绝；伪造的 `evil.example/anything/tektoncd-pipeline-entrypoint:v1` 同样被拒 —— 主机锚点依然成立。
- **换环境只需改 ConfigMap**：把 `tektonInfraRepoRegex` 从一个环境的前缀 patch 成另一个环境的即可生效（Kyverno 的 ConfigMap context 有短暂缓存 —— 改完稍等片刻再验证）；策略 YAML 一个字符都不用改：新前缀被放行，旧前缀立即被拒。
- **ConfigMap 缺失是失败关闭，而不是失败开放**：删掉该 ConfigMap，原本合规的 Pod 也会被拒，报错中明确写着 `failed to retrieve config map for context entry allowlist`。安全方向是对的，但**要注意可用性**：部署顺序必须让 ConfigMap 先于策略，而且该 ConfigMap 必须纳入 GitOps 与 RBAC 保护 —— **谁能改它 == 谁能改镜像白名单**；权限门槛等同于修改策略本身。

##### 不想维护主机时的两种放宽形态（附强度对比）

有些环境不愿意为每个集群维护一个镜像仓库主机（镜像改写会更换主机，见上文），希望策略文本完全不带环境信息。这种情况下，**不要直接退回到"任意前缀"** —— 中间有一个明显更安全的档位：**主机放开，但只允许一段，而项目路径与镜像名全部固定**。
```text
# Form B (the recommended relaxation): host contains no '/', project path and image names are pinned
^[^/]+/<project-path>/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)(:|@).*$

# Form C (widest, not recommended as a default): the prefix is unconstrained
^(.*/)?tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)(:|@).*$
```

关键差别在于 `[^/]+` 与 `.*`：前者只允许**一段**主机（`registry.example.com:5000` 这样的形态），把"多塞一级路径"的整个空间封死；后者则容忍任意深度。三种形态的强度对比（形态 A 即上面的 ConfigMap 形态）：

| 探针镜像 | A 固定主机 | B `[^/]+` + 固定路径 | C 任意前缀 |
|---|:---:|:---:|:---:|
| `192.0.2.10:11443/pipelines/tektoncd-pipeline-entrypoint:v1.12.0` | ✅ 放行 | ✅ 放行 | ✅ 放行 |
| `harbor.example.net:5000/pipelines/tektoncd-pipeline-nop@sha256:…`（**另一个环境的主机**） | ❌ 拒绝（需要改 ConfigMap） | ✅ 放行（这正是放宽的目的） | ✅ 放行 |
| `evil.example/**anything**/tektoncd-pipeline-entrypoint:v1` | ❌ 拒绝 | ❌ **拒绝** | ⚠️ **放行** |
| `192.0.2.10:11443/pipelines/**sub**/tektoncd-pipeline-entrypoint:v1`（多插一级） | ❌ 拒绝 | ❌ **拒绝** | ⚠️ **放行** |
| `…/pipelines/tektoncd-pipeline-**evil**:v1` | ❌ 拒绝 | ❌ 拒绝 | ❌ 拒绝 |
| `docker.io/library/busybox:latest` | ❌ 拒绝 | ❌ 拒绝 | ❌ 拒绝 |
| `**evil.example**/pipelines/tektoncd-pipeline-entrypoint:v1` | ❌ 拒绝 | ⚠️ **放行** | ⚠️ 放行 |

:::warning 形态 B 封不住的那一格（对比表最后一行）

只要攻击者把镜像推成 `<他自己的主机>/<项目路径>/tektoncd-pipeline-entrypoint`，形态 B 照样放行 —— **镜像名是调用方可控的字符串，不是身份**。

形态 B 的价值在于把绕过成本从"随便起个名"抬高到"必须精确复刻项目路径与镜像名、且一级目录都不能多"，同时它**完全不含环境信息、可跨集群直接复用**；它拦不住有意绕过的人。要真正封住这一格，就得回到形态 A（固定主机，并用上面的 ConfigMap 方案保持通用）。

**不要把形态 C 当默认**：它连"多插一级路径"那一格都放行；实践中它只能拦住"随手写了 `docker.io/library/busybox`"这类无意的越界。

:::

:::details 完整验证清单（端到端 + 子资源 + 作用域不误伤）

- 一个使用违规镜像（`docker.io/library/busybox`）的 Tekton TaskRun → Pod 被拒，**TaskRun 终态为 `PodCreationFailed`**（消息中带有完整策略文本；Pod 从未被创建）；
- 同一命名空间中一个**普通的非 Tekton Pod**（同样用 `docker.io` 镜像）**照常创建、不误伤** —— 作用域生效；
- 一个带 Tekton 标签、伪造成 `evil.example/<项目路径>/tektoncd-pipeline-entrypoint:fake` 的 Pod 被拒，证明仅凭仓库路径不能让任意主机获得信任；
- 策略生效期间，一条使用合规镜像的完整流水线端到端跑到 `Succeeded`；
- 另外创建一个带 Tekton 标签的实时 Pod：删除该标签的 patch 被拒；随后用 `docker.io/library/busybox` 打 `pods/ephemeralcontainers` 补丁被拒，而用已批准仓库镜像的补丁成功，且已批准的临时容器在实时 Pod 中可见；用已批准主镜像的普通 Pod UPDATE 被放行，而未批准的主镜像与未批准的 init 镜像都被拒；
- 在 managed-by 取值为合法字符串 `"false"` 的情况下，一次试图把标签改成形似数字的 `"1"` 的普通 UPDATE 被拒；此后未批准的临时镜像仍然被拒 —— 证明身份标签无法先被类型强转绕过、再逃出子资源选择器；
- 用一个位于带方括号 IPv6 镜像仓库上的 workingdirinit 仓库做 server dry-run：精确主机被放行，而只差一个字符的近邻主机被拒。

**参数化边界**：`"1"`、`"false"`、`"null"` 都是合法且非空的 Kubernetes 标签字符串。策略与探针中的 `<tekton-managed-by-label-value>` 必须放在 YAML 引号内，否则会被解析成整数、布尔或 null。标签不可变性检查同样必须先在 JMESPath 里算出一个精确字符串相等的布尔值再交给 Kyverno 做布尔比较 —— 绝不要用 `NotEquals` 直接比较形似数字的字符串。

:::

镜像的**签名 / 证明**校验（verifyImages）同样作用在 Pod 层 —— 见配套文档《Software Supply Chain Security of ACP with Tekton and Kyverno》。
#### 4.5.4 封堵裸 Tekton Run 入口（契约 7） {#s4-5-4}

- **治理什么**：**堵住"直接创建裸 TaskRun / CustomRun 绕过流水线"这个缺口**。到目前为止所有门禁都挂在流水线路径上；如果有人能自己创建一个裸 TaskRun 去跑构建、推镜像或部署，那些门禁就被一次性全部绕过了。
- **难在哪里**：怎么区分"控制器创建的合法子 Run"与"用户手工创建的裸 Run"？最直觉的答案是看 `ownerReferences` —— 合法的子 Run 从创建那一刻起就带有 `controller: true` 的 PipelineRun owner ref。**但那个字段是由创建对象的人写的**：攻击者创建裸 TaskRun 时可以伪造一个指向真实 PipelineRun 的 owner ref（uid 在他自己的命名空间里就读得到），而 Kubernetes 默认并不校验它的真伪 —— 信任它等于失败开放。
- **策略怎么分层**：① 硬保证锚定在 **`request.userInfo`** 上 —— 它由 API server 根据已认证的请求填写，客户端伪造不了；"创建者 == Tekton 控制器 SA"是一份不可伪造的来源证明；② 随后把 `ownerReferences` 用作**纵深防御的附加与条件** —— **只在控制器 SA 这条路径上加**（合法路径本来就带着它，零成本；而且即便伪造成功，userInfo 这一关照样抓得住）；③ 平台管理员身份是一条**独立的或分支**，**不要求 owner ref** —— 它是这个入口的破窗条款：名单上的人可以绕过本节的封堵。
- **治理不了什么**：它封的**只是裸 Tekton Run 这条路径** —— 并不意味着"任何工作负载都不能在流水线之外运行"：任何拥有 API 权限的人照样可以直接创建 Pod / Job / Deployment，或者在别处使用部署凭据。**"流水线绕不过去"是 RBAC 与本策略共同的产物**：RBAC 收窄业务身份对工作负载 API 与部署凭据的直接权限；本策略只补上裸 Run 这一块。

**关键判据** —— 在 **Tekton 控制器路径**上，以 userInfo 为锚点、owner ref 为附加与条件；**平台管理员身份是单独的或分支，不要求 owner ref**（破窗条款：名单上的人正是能绕过入口封堵的人）（**这是片段，不是可以直接 `kubectl apply` 的完整清单**；完整策略在本节的折叠块里）：

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

不要把"伪造的 owner 会被垃圾回收清掉"当成一道防线；它有两个缺口：

- **GC 是异步的。** TaskRun 一旦通过准入，它的 Pod 几乎立刻就被调度并运行起来；等到 GC 删掉它时，那次没有门禁的构建 / 发布可能早已完成 —— 绕过已经发生了。
- **owner 可以指向一个真实对象。** 只要伪造的 uid 指向一个确实存在的 PipelineRun，GC 就根本不会触发。

所以**身份的硬保证在 `request.userInfo`**；`ownerReference` 只是叠在它之上的一层。

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
| 以非控制器身份创建裸 TaskRun | 拒绝 |
| 裸 CustomRun | 拒绝 |
| **伪造 `ownerReferences`，但 userInfo 不是控制器** | **仍然拒绝**（owner ref 弥补不了 userInfo） |
| 控制器身份 + 一个控制器 PipelineRun owner | 放行 |
| 控制器身份但**没有** owner ref（异常 / 冒充） | 拒绝 |
| 一个专用的破窗 ServiceAccount（先在 RBAC 中授予最小的 TaskRun create 权限） | 被本策略显式放行 |
| 一次正常的 PipelineRun 端到端 | `Succeeded`；控制器创建的真实子 TaskRun 不受影响 |

破窗是**双层授权**：Kubernetes RBAC 与 Kyverno 白名单缺一不可。

:::

这条策略与 RBAC 是互补的：RBAC 决定"谁有 API 权限 —— 能不能直接创建 Pod / Job / Deployment"；而在那些确实有权限的身份之中，本策略进一步堵上裸 Tekton Run 这个缺口。用于生产时，白名单还应当包含合法的平台自动化身份（触发器 / GitOps 控制器等）—— 并且要注意，**你放进白名单的每一个身份，都是你为它打开了裸 Run 入口的身份**，所以要连同该身份自己的 RBAC 一起评估。

#### 4.5.5 发布目标白名单（真实画像：java / python `-image-build-scan-deploy` 0.3） {#s4-5-5}

- **治理什么**：**发布的目标参数与凭据来源只能是已批准的那些** —— 约束两个官方 0.3 模板中部署阶段的目标参数（命名空间 / 工作负载 / 镜像等）以及 `kubeconfig` 的来源。两个模板的 `deploy-or-upgrade` 是同一个 hub `kubectl` 0.1、参数面相同，所以**一条规则必须同时固定两个模板身份**；只固定其中一个，通过另一个模板发布就完全不受治理。
- **难在哪里**：① **判定点必须在 PipelineRun CREATE —— 下推不到 TaskRun 层**：模板里的 `deploy-or-upgrade` 只是一个节点别名；解析之后真实的 Task 是 hub `catalog/kubectl/0.1`，而它的 TaskRun 只收到 `args` 与一份**已经渲染好的 `script`** —— 那里根本没有 `workloadNamespace` 参数可读；② 该版本把目标参数**以纯文本替换、不加引号地拼进 shell `script`**，所以"只检查命名空间在不在白名单里"会留下一个**命令注入**口子；③ 只看 `kubeconfig` workspace 的 `.secret.secretName` 是可以被绕过的 —— 用 PVC / CSI / configMap 绑定时该字段为空，朴素的策略就直接放行了，攻击者可以借此塞进一份任意的 kubeconfig。
- **策略怎么分层**：① **无论是否启用部署**都校验 hub 来源身份；② 镜像模板的 `when` 逻辑要照搬 —— `workloadName` 为空或只有一个空格意味着未启用部署，此时跳过目标检查；③ 启用部署时，`workloadNamespace` 必须**显式**命中白名单 —— **缺失同样拒绝**。这是刻意的：模板对缺失的语义是"使用运行所在的命名空间"，这等于把"这次发布去哪里"交给运行的位置隐式决定 —— 审计者看请求是看不出目标的。**如果你们站点本来就是同命名空间部署**，修法不是删掉这条判据，而是在与名单比较之前先把缺失归一化（把 `targetNs == '' && contains([...], request.namespace)` 视为合规），并补一行"命名空间缺失 + 当前命名空间在名单内 → 放行"的探针；④ 把每一个会被拼进 shell 的输入都限制到**保守的文法**（DNS-1123 label、规范的工作负载 Kind、shell 安全的镜像引用、相对目录、整数秒超时）；④' `workloadContainers` —— 虽然它是以 **args 数组**（`--containers <name>…`）交给 kubectl Task 的、每处使用都带引号、**不是注入面** —— 仍然按容器名语法校验；理由不是注入，而是**只有真实名字才会生效**，见下面"到底更新了哪个容器"的边界说明；⑤ **"绑定了但不是 Secret"的 kubeconfig workspace 一律失败关闭**；⑥ **拒绝对 deploy 任务的任何 `taskRunSpecs` override，调度类键除外**（判定与 [§4.2.5](#s4-2-5) 相同：`nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName` 允许；其他任何键，以及任何 `serviceAccountName`，一律拒绝）—— `podTemplate.env` 会被注入 step 容器，而 kubectl Task **只有在 kubeconfig workspace 被绑定时才自己 `export KUBECONFIG`**，所以一个合规的"部署到当前集群"的请求，只需注入一个 `KUBECONFIG` 就能把整次发布重定向到别处，连带把命名空间白名单一起废掉；⑦ **两个运行级入口分别处理** —— `spec.taskRunTemplate` 恰好有两个字段（用 `kubectl explain` 核实过）：`podTemplate` 与 `serviceAccountName`。前者的 `env` 与 ⑥ 完全等价（它作用于本次运行的每一个 TaskRun，包括 deploy 那一步）—— **直接拒绝**；后者决定 deploy 步骤**以谁的身份**执行 `kubectl apply` —— 在没有绑定 kubeconfig 时，用的正是它，把它指向一个权限更宽的 SA 就绕过了"约束依赖部署凭据的 RBAC"这句话 —— 所以它用**批准名单**治理而不是直接拒绝：运行级 SA 是**正常配置**，一刀切拒绝会误伤大量合法请求。**名单必须包含 Tekton 默认填充填进去的那个 SA**（判据中的第一个占位符 `<tekton-default-service-account>`）—— 这是既定机制而非推断：Tekton 的默认填充 webhook 先于 Kyverno 执行，所以**正常情况下**准入看到的 `taskRunTemplate` 不是缺失（唯一的例外及其导致的失败开放，见 [§4.0.3](#s4-0-3) 中该占位符那一行），它到达时已经带着默认填充好的 SA（取自 `config-defaults` 的 `default-service-account`，**该键缺失时回落到 Tekton 内置默认值** —— 本文环境正是键缺失的情况，实际取值为 `default`）与 `default-pod-template`（本文环境中是 `securityContext.fsGroup=65532`）。**把那个默认 SA 漏在名单之外，每一个合规请求都会被拒** —— 放行探针会立刻暴露这一点；见 [§4.0.3](#s4-0-3) 占位符表中的同名条目。
- **治理不了什么**：它约束的是**请求中写下的目标参数与凭据来源** —— 它既不保证清单内容只触及那个命名空间（见下面的边界说明），也不保证被发布的制品本身可信（那属于 [§4.5.1](#s4-5-1) / [§4.5.3](#s4-5-3) 与供应链证明）；而且它的强度取决于模板版本 —— 这份画像是针对 0.3 真实的替换行为写的（这一段数据流在 0.2 与 0.3 中是相同的：`deploy-or-upgrade` 仍然是 `kubectl` 0.1，目标参数仍然以不加引号的文本拼进 `script`），所以**模板升级时必须重新评审每一个字段与合并顺序**。

**通用契约**：`workloadName`、`workloadKind`、`workloadNamespace`、`images`、`workloadManifestsDir`、`workloadRolloutTimeout` 以及 `kubeconfig` workspace，全部属于 **PipelineRun** 契约。写成针对 TaskRun CREATE 的规则，就读不到目标命名空间，对真实形态永远不会生效。

**只治理这一处 workspace 绑定是刻意的**：本节判定 `kubeconfig` workspace，是因为它直接决定"这次发布落到哪个集群" —— 绑错了目标白名单就形同虚设。**其余所有 workspace（源码、缓存、制品、各类凭据）本文通篇不做治理**：它们的风险是"谁能把哪个 Secret / PVC 挂进流水线"，而那是命名空间级的 RBAC 与 Secret 治理问题，不是流水线策略问题 —— 一个能在这个命名空间里创建运行的身份，通常本来就能读到那些 Secret，在准入处拦截只是把边界画错了地方。想在策略侧收紧的站点，判据形态与本节相同（按 `workspaces[].name` 定位目标绑定，再判定 `secret.secretName` 是否在批准名单内）—— 但**请先确认 RBAC 那一层已经收窄**，否则你拦住的只是"挂载"这一种用法而已。

:::warning 为什么这些参数值得在准入处再查一遍（"流水线自己会失败"还不够吗？）

因为它们**不是"写错了就报错"的参数，而是被拼进 shell 的注入面**。像 `workloadName` 这样的取值，会以文本替换、不加引号的方式进入 kubectl Task 的 `script` —— 形如 `x; <任意命令>` 的取值不会"失败"，它会**执行**，而且是在一个**已经挂载了部署 kubeconfig** 的容器里执行。等到流水线报失败时，注入的命令早就跑完了：**流水线失败是一种可用性机制，不是对抗恶意输入的安全机制。**

而准入拒绝发生在 PipelineRun CREATE，零副作用 —— 什么都没构建、没有镜像被推送、没有凭据进入任何容器。

反过来说，这也是本文**挑选治理哪些参数的判据**：只在准入处治理那些"准入看得到、且失败代价不可接受"的输入（会进入 shell 的、决定发布目标的、决定凭据来源的）。那些仅仅"格式写错就报错、没有注入面、也不影响权限"的参数，就让它们在流水线里失败 —— 在策略里再校验一遍，只会增加策略与模板版本之间的耦合。

:::

还有一条更隐蔽的绕过：**不要只看 `kubeconfig` workspace 的 `.secret.secretName`**。如果那个 workspace 是由 **PVC / CSI / configMap** 或其他非 Secret 来源绑定的，`secretName` 就是空的，朴素的策略会放行该请求 —— 攻击者于是可以用 PVC 塞进一份任意的 kubeconfig。"绑定了但不是 Secret"的 kubeconfig workspace 必须**失败关闭**。

**关键判据** —— 两个布尔值：来源身份始终校验，部署画像只在启用部署时校验：
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

:::details 验证探针（37 个探针，真实 hub PipelineRun 形态，--dry-run=server）

下表把 **21 行 = 37 个探针**压缩在一起：形态相同的探针合并成一行（例如"两者都拒绝"是两个探针，"拒绝 / 放行 / 放行"是三个）；逐个执行时，请按行内的枚举展开。

表中的"已批准命名空间 A / B"、"已批准 Secret"、"已批准 SA"，指的是策略五个占位符替换之后的取值 —— **先替换，再跑探针**，否则连第一行的放行用例都会被拒（占位符本身永远不会等于真实的参数取值）。

| 探针 | 预期 |
|---|---|
| 启用部署 + 已批准命名空间 A（不绑 kubeconfig，显式 `timeout=1` 秒）；以及同一画像加上单独显式的 `type=artifact` | 放行 |
| 已批准四元组外加一个请求级 `url`，或者显式的 `type=tekton` | 拒绝 |
| 未启用部署的两种形态：`workloadName` 缺失 / 等于单个空格；然后任取其一再跑两次，一次带请求级 `url`，一次带 `type=tekton` | 前两个跳过目标检查；后两个仍然被拒（来源判据不看"是否启用部署"） |
| 启用部署但命名空间缺失 | 拒绝 |
| 命名空间 = `kube-system`（或任何不在白名单里的命名空间） | 拒绝 |
| 已批准命名空间 B + 已批准 Secret | 放行 |
| 已批准命名空间 A + **PVC workspace** | 拒绝 |
| 已批准命名空间 A + 一个未授权的 Secret | 拒绝 |
| 一个合规请求 + 在 deploy 任务上加 `taskRunSpecs[].podTemplate.env`，或者在其上加 `serviceAccountName` | 两者都拒绝 |
| deploy 任务上**只含调度类键**（`nodeSelector` / `tolerations`）的 `podTemplate` | 放行（判定与 [§4.2.5](#s4-2-5) 相同） |
| 同样的按任务 override，但**未启用部署** | 放行（判据不越界 —— 那个任务反正也不会运行） |
| **python 0.3** 模板：名单外的命名空间 / 同一份完全合规的画像 | 拒绝 / 放行（身份覆盖两个模板） |
| 运行级 `taskRunTemplate.podTemplate.env`（启用部署） | 拒绝 |
| 运行级 podTemplate 只设置 `nodeSelector` | 放行（只判定 `env`） |
| 运行级 `serviceAccountName` 在批准名单外 / 在名单内 / 等于 `config-defaults` 的默认值 | 拒绝 / 放行 / 放行 |
| 运行级未批准 SA，但**未启用部署** | 放行 |
| `workloadContainers` 含非法容器名 / 含显式的 `*` | 两者都拒绝 |
| `workloadContainers` 含合法容器名 | 放行（"参数缺失 = 更新所有容器"这一形态，就是上面每一个合规探针） |
| 一个非目标 Pipeline 身份 | 不会被误拒 |
| 在 `workloadName`、`workloadKind`、`images[0]`、`workloadManifestsDir`、`workloadRolloutTimeout` 中各注入一段无副作用的 shell 片段 | 五个全部拒绝 |
| 小写的 `deployment`（清单 kind 比较区分大小写）、带单位的 `1s`（模板会把它拼成 `1ss`）、形似数字的 `workloadName: "1"` + 一个未批准的命名空间 | 全部拒绝 |

:::

:::warning 有损边界 —— 必读

**`workloadNamespace` 只是 `kubectl apply -n` 的默认命名空间；它不是"这次发布只能触及那个命名空间"的保证。** 模板最终执行的是 `kubectl apply -f "$PATCHED_YAML" -n "$NAMESPACE"` —— **清单内部写的 `metadata.namespace` 会覆盖 `-n`，而集群级资源（`ClusterRole` / `ClusterRoleBinding` / `Namespace` 等）与 `-n` 根本无关**。换句话说：源码仓库中 `workloadManifestsDir` 之下的内容声明了什么，就可能被 apply 什么，而准入看不到那些文件。**真正约束那一层的是部署凭据自身的 RBAC**（把 deploy ServiceAccount 收窄到目标命名空间内的最小权限，并拒绝集群级资源），加上对清单内容本身的评审 / 准入。

**除了"发布到哪里"，还有一层"发布了什么"：`workloadContainers` 决定新镜像被写进哪个容器。** 模板把它以 `--containers <name>…` 交给 kubectl Task，而 Task 随后执行 `kubectl set image "$KIND"/"$NAME" "$container"="$NEW_IMAGE"`（在清单分支上，`yq` 通过 `strenv(container)` 匹配容器名并改写镜像）；**留空**时，Task 会自己填上 `*` = 更新所有容器。策略校验的是"每一项都是合法的容器名"（这也是显式 `*` 被拒的原因 —— 要更新所有容器，就把列表留空），**但"应该更新哪个容器"是准入判断不了的业务语义**：

- 在 `kubectl set image` 分支上，不存在的名字会让命令报错、流水线失败（失败关闭 —— 吵，但安全）；
- 在**清单分支**上，`yq` 匹配不到时**什么都不改** —— 于是被 apply 的是清单**原本携带**的镜像，而不是刚刚构建并扫描过的那个，**而且流水线照样成功**。也就是说，"门禁过了 ⇒ 集群跑的是过了门禁的那个镜像"这个推论在这条路径上不成立；
- 当名字指向**另一个容器**（比如某个 sidecar）时，业务容器仍然跑着旧镜像 —— 同样是"看起来发布成功了，实际什么都没换"。

要把这一层也锁住，只能在流水线之外补：把容器名收窄成站点批准名单（形态与 `<approved-deploy-service-account>` 相同），或者对清单内容做评审 / 在目标集群上做准入。

**而"用 RBAC 约束它"本身还有一个前提：请求不能自己挑身份。** 在没有绑定 kubeconfig 时，`kubectl apply` 以本次运行的 ServiceAccount 身份执行，而 PipelineRun 有两处可以设置它 —— `taskRunSpecs[].serviceAccountName`（点名 deploy 任务；本策略直接拒绝）与 `spec.taskRunTemplate.serviceAccountName`（运行级；本策略要求它命中 `<approved-deploy-service-account>` 名单）。**两处都不治理的话，"deploy SA 已经收窄到最小权限"就只是在描述某一个特定的 SA —— 请求换一个更宽的就是了。** 反过来说，运行级 SA 是正常配置，一刀切拒绝会造成误拒，所以这里用批准名单而不是拒绝 —— 请把这份名单与你实际发放的部署凭据 RBAC 一起维护：新增一个 SA 时同步加进名单，而且**必须把 Tekton 默认填充的那个 SA 也列上**（见上面的机制说明）。

即便 workspace 来源已经收窄，**目标集群最终的安全边界仍然必须由目标集群自己的准入 / RBAC 来承担** —— 本策略约束的是"用哪个 kubeconfig Secret、部署到哪个命名空间参数"，而 kubeconfig Secret 的**内容**（它真正指向哪个集群、拥有什么权限）对准入是不可见的；只能通过"哪些 Secret 可以被引用"间接封堵。

**当 `<tekton-default-service-account>` 的实际取值读出来是空时，先修 ConfigMap 再谈策略**（本段是该占位符失败开放机制的完整版；[§4.0.3](#s4-0-3) 中的取值行指向这里）：取值请一律使用 [§4.0.3](#s4-0-3) 的实际取值命令，它读的是默认填充**之后**的结果 —— 不要从 `config-defaults` 去猜。`default-service-account` 键**缺失**时会回落到 Tekton 内置默认值 `default`（多数 ACP 集群出厂就是键缺失：它只出现在惰性的 `_example` 注释块里，所以直接从 ConfigMap 读出空值是正常的，不是命令写错了）。而**键存在但取值为空**是另一回事：Tekton 读取这份配置时只检查键是否**存在** —— 存在就原样取值，于是空字符串覆盖了内置默认值 `default`；而填充只在默认值非空时才发生（PipelineRun 与 TaskRun 皆然）—— 所以准入**确实会看到该字段缺失**，本节的 `runWideSa != ''` 判据整体跳过：**一次失败开放**。正确的修法是把 `config-defaults` 里的空值改成一个真实的 SA 名（与 `<tekton-managed-by-label-value>` 同理：空值本身就是部署层面的阻塞项）；不改的话，这条规则形同未装。

**复制之前先替换那五个站点取值**（`<approved-deploy-namespace-a>` / `-b`、`<approved-deploy-kubeconfig-secret>`、`<tekton-default-service-account>`、`<approved-deploy-service-account>`）—— 取值方法、名单式语法与失效方向（全部相反：漏替 = **所有合规的部署请求都被拒**），见 [§4.0.3](#s4-0-3) 对照表中对应的四行；这里不再重复。

**关于 `workloadRolloutTimeout`，给运维一条特别提醒：模板自己的参数说明是错的。** 它写着"其他取值应当带时间单位（例如 `1s`、`2m`、`3h`）"，但在调用处脚本拼的是 `--timeout=${ROLLOUT_TIMEOUT}s` —— 填 `1s` 会变成 `1ss`，执行时失败。**唯一正确的形式是整数秒（`0` = 永不超时）**，这也是本策略只接受整数的原因；上线时，请把这一条写进你给业务团队的填写说明，否则你会遇到"按模板文档填 → 被策略拒 → 绕过策略 → 在 Task 内部失败"这样一圈来回。

此外，目标命名空间约束与 shell 安全参数约束都依赖 Pipeline 0.3 真实的参数 / 脚本契约；**模板升级时，请重新评审每一条 `$(params.*)` 到 shell 的数据流**。示例中的工作负载 Kind、名称、路径、整数秒超时与镜像文法，是一份刻意保守的生产画像 —— 当业务团队需要更宽的合法集合时，请**放宽白名单并补上对抗性探针**，而不是把校验删掉。

:::

#### 清理（§4.5）

按 [§4.0.4](#s4-0-4) 的两条规则，用归属账本按记录的 UID 删除那五条集群级策略：
```bash
for pol in artifact-source-allowlist promotion-source-image-labels \
  pod-image-registry-allowlist pipeline-entry-lockdown release-target-allowlist; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
```

命名空间级对象随自建命名空间的级联删除一并回收：`pipeline-image-allowlist` ConfigMap（**只有当你采用了 [§4.5.3](#s4-5-3) 的 ConfigMap 变体时它才存在**），以及本节运行过的 PipelineRun / 独立 TaskRun 及其派生对象。如果你要继续做后面的章节，请先按名字删掉那些运行类对象，以免干扰 PolicyReport（[§4.0.5](#s4-0-5)）。
### 4.6 （进阶）自动取消运行中的流水线 {#s4-6}

**总契约**：硬门禁（[§4.3](#s4-3)）是"结果不达标 → 失败"的主线；但有些场景需要**尽早请求取消**一条已经在跑的流水线（例如提前掐掉后面昂贵的步骤）。使用的技术是 mutate-existing —— 在 status 事件触发时，给目标 PipelineRun 打上 `spec.status: CancelledRunFinally`（Tekton 原生的取消字段）。

本节给出**两种触发条件**：**[§4.6.1](#s4-6-1) 结果不达标**（读取某个 TaskRun 写出的 result）与 **[§4.6.2](#s4-6-2) 定义漂移**（读取回写进 status 的 `pipelineSpec`，发现解析出来的定义与已批准身份不符）。机制相同、判据不同 —— 而且**两者都在同一个补丁里写入一条说明原因的注解**（[§4.6.1](#s4-6-1) 记录哪个 result 越界，[§4.6.2](#s4-6-2) 记录漂移在哪里）：一次没有在对象上留下原因的取消，与手动取消无法区分 —— 理由见 [§4.0.6](#s4-0-6)，排障时怎么读见 [§6.2.3](#s6-2-3)。

**先看全局：本文一共有四条取消流水线的路径 —— 两条在这里，两条在 [§4.2](#s4-2)** —— 它们的区别不在"取消"这个动作，而在**何时检测到问题、动的是哪个对象**。这张表既用于选型也用于排障（它是路口；每一行完整的策略仍在各自的小节里）：

| 小节 | 何时检测、条件是什么 | 作用于什么 | 机制（同步 / 异步） | 证据在哪里（[§6.2.3](#s6-2-3) 的步骤号） |
|---|---|---|---|---|
| [§4.2.3](#s4-2-3) | 在门禁 TaskRun **准入**时：门禁开关 / 阈值参数不合规 | **门禁 TaskRun 自身** | 准入 `mutate` 写入 `spec.status: TaskRunCancelled` + `statusMessage` —— **同步、无竞态、不需要额外 RBAC** | 该 TaskRun 的 `spec.statusMessage` 与终态 condition —— **完整原因就在这里**（步骤 1） |
| [§4.2.2](#s4-2-2) | 同一时刻、同一判据（门禁参数不合规） | **父 PipelineRun** | mutate-existing 打补丁 `spec.status: CancelledRunFinally` —— 异步，需要 background controller 的 update RBAC | 父运行的 `cancel-reason` 注解（步骤 2） |
| [§4.6.2](#s4-6-2) | 当 PipelineRun 写 status 时：解析出来的定义中，可信门禁被**移除，或者整个 Task 身份被换掉**（定义漂移 —— 同名不同命名空间也算） | **运行自身**（自指向，不做跨运行查询） | 与上同一个补丁，`CancelledRunFinally` | 父运行的 `cancel-reason` 注解，其文本说明漂移情况（步骤 3） |
| [§4.6.1](#s4-6-1) | 当某个 TaskRun 到达终态时：某个 result 越界（覆盖率 / 漏洞数等）；**result 缺失或格式错误同样命中**（失败关闭说的是判据方向；取消能否真的落地取决于后台链路 —— 见本表下方第 ④ 点） | **父 PipelineRun**（一条五环身份链，防止认错父运行） | 与上同一个补丁，`CancelledRunFinally` | 父运行的 `cancel-reason` 注解，其中写明触发的 TaskRun 与越界取值（步骤 4） |

选型时最容易忽略的有四点：**① 前两行是同一条判据的三种响应形态中的两种**（第三种是 [§4.2.1](#s4-2-1) 的直接 deny，代价是 finally 不执行；三者的权衡见 [§4.2.3](#s4-2-3)）；**② 只有 [§4.2.3](#s4-2-3) 是同步的** —— 其余三条都是事后动作，已经发生的副作用不会回滚；**③ 终态未必是 `Cancelled`** —— 在 [§4.6.1](#s4-6-1) 中，当 result 压根没被写出来时，Tekton 的失败结论优先于取消，终态会是 `Failed`；取消的证据只存在于 `spec.status` 与注解里（见 [§4.6.1](#s4-6-1) 末尾）；**④ 后三行交付的是"发起取消"，而不是"取消一定会发生"** —— 判据一旦命中，补丁由 background controller 通过 UpdateRequest 异步投递，而那次投递完全没有同步反馈：`context.apiCall` 取不到目标、UpdateRequest 根本没被创建、控制器不可用或积压、目标资源的 update RBAC 被收回 —— 以上任何一种情况下，原始请求都照常放行、而补丁根本不会出现，并且它**不产生拒绝消息，也不产生 PolicyReport 违规记录**（mutate 类规则本来就不记违规，[§4.2.3](#s4-2-3)）；现场只剩下 background controller 的日志。所以后三行给的是"尽力而为的投递"，只有 [§4.2.3](#s4-2-3) 那一行给的是"在准入内当场生效"；**凡是需要"检测到就一定停"的地方，请选同步路径**（[§4.2.1](#s4-2-1) 的 deny 或 [§4.2.3](#s4-2-3) 的准入 mutate）；如果你继续使用这三条，请按 [§3.7](#s3-7)"异步投递链"一行补齐监控与故障注入。

**后三行（三条 mutate-existing 路径）的共同前提**（[§4.2.3](#s4-2-3) 是准入 mutate，动的是进入的请求对象，不需要这个权限；其余三条缺了它，策略要么装不上、要么不生效）：background controller 需要对目标 `pipelineruns` 的 update RBAC，而 **Kyverno 在策略创建时就会校验该 RBAC —— 缺失时直接拒绝创建策略**，报错形如：

```text
admission webhook "validate-policy.kyverno.svc" denied the request:
path: spec.rules[0].mutate.targets.: auth check fails, additional privileges are
required for the service account 'system:serviceaccount:kyverno:kyverno-background-controller':
... requires permissions update for resource tekton.dev/v1/PipelineRun
in namespace {{ request.namespace }}
```

**注意末尾那句 `in namespace {{ request.namespace }}` 从未被求值过** —— 这次鉴权检查发生在策略创建时，那时 `request` 还不存在，所以当 `mutate.targets[].namespace` 写成**变量**时，Kyverno 只认**集群级**的 update 权限；只有当命名空间是**字面量**时，命名空间级的 Role 才够用（这也是 [§4.2.2](#s4-2-2) 的单命名空间变体必须把 `targets` 也写成字面量的原因 —— 只加 Role 是不够的）。本章的规则使用了 `subjects` / 请求上下文，所以策略必须设置 `background: false`（否则创建时会以 `only select variables are allowed in background mode` 被拒）—— 但 mutate-existing 的目标仍然由 background controller 执行。

当你只治理一个固定命名空间时，可以复用 [§4.2.2](#s4-2-2) 的命名空间级 Role，并把 mutate 目标命名空间写成字面量；当你需要动态的跨命名空间目标时，就用下面这个聚合 ClusterRole —— **并注意这是一次权限提升**：它给了 background controller **全集群范围内**对 `pipelineruns` 的 update / patch，而从那一刻起，规则自身的身份校验（`subjects` + owner UID 回查 + 完整 TaskRef）就是这项权限唯一的约束了 —— 其中任何一环都不能省：

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

把它存为 `kyverno-background-update-pipelineruns.yaml`，然后**先授权、确认聚合已生效，再安装本节的两条策略** —— 顺序反了，你会得到一个与"从未授权过"一模一样的报错（[§6.1.1](#s6-1-1)）：

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

返回 `no` 时不要急着改策略：先把上面的命令重跑一次（聚合可能只是还没传播开），再检查 ClusterRole 上的 `rbac.kyverno.io/aggregate-to-background-controller: "true"` 标签有没有拼错。**安装策略时报出的鉴权错误，与"从未授权"看起来完全一样**，这正是这一步必须在安装任何策略之前单独确认的原因。

**共同边界**：取消是一种事件驱动的响应动作，而不是准入拒绝 —— 它发生在结果**已经产出之后**；此前已经执行的副作用不会回滚，而 finally 照常执行（[§2.3](#s2-3) 对照表第三行）。因此它是硬门禁的**补充**，而不是 [§4.3](#s4-3) 中门禁任务的替代品。

:::warning 取消 ≠ 立刻停止计算

在所有 mutate-existing 取消场景中，**一个 TaskRun 被标记为已取消，并不意味着它的 Pod 会同步终止**。已经处在并发创建路径上的 Pod 可能会一直跑到进程退出；即便把下游任务写成 `runAfter`，"下游 Pod CREATE"与"父运行被取消"之间仍然存在竞态。

成本敏感的场景不能把取消当作"算力立即回收"的保证：**给任务设置合理的超时**，并在你自己的目标算力与运行时上实测 Running Pod 的终止延迟。

:::

#### 4.6.1 由结果触发的取消（主要用法，含防伪造校验） {#s4-6-1}

- **治理什么**：**当结果已经出来、这才发现不达标时，把这条流水线停掉** —— 盯住某个 TaskRun 写 status 的那一刻，读取它产出的 result（示例中是覆盖率），取值越界时取消**父 PipelineRun**，让后面的构建 / 发布步骤不再继续。
- **难在哪里**：你必须先回答"哪个运行才是这个 TaskRun 真正的父级"，而且答案必须**不可伪造** —— TaskRun 上的 `tekton.dev/pipelineRun` 标签完全不可信：裸 TaskRun 可以自己写它，而真实的 PipelineRun 可以通过 `taskRunSpecs[].metadata.labels` 覆盖子 Run 的标签。取消意味着**伸手去修改别人的对象**；认错父运行等于发出了一个"取消任意流水线"的按钮。
- **策略怎么分层**：① 只匹配由 **Tekton 控制器 SA** 写入的 status 请求；② 从控制器写入的 `ownerReference` 取出父运行的 name/UID，再用 `apiCall` 拉取**实时的** PipelineRun 并核对 UID（挫败同名重建）；③ 另外要求触发者确实出现在父运行的 `status.childReferences` 中；④ 锁定完整的 Pipeline / Task 身份 —— 否则任何产出同名 result 的流水线都能触发取消；⑤ 只有以上全部成立，`mutate-existing` 才把父运行置为已取消。
- **治理不了什么**：它是**事后响应**，不是准入拒绝 —— result 产出**之前**已经执行的副作用不会回滚（镜像可能已经推送出去了），而 finally 照常执行。

本节用可信命名空间中的一个 `coverage-cancel-demo` Pipeline 与一个 `policy-demo-coverage-emitter` Task（产出示例 `coverage-lines` result）来演示，**不依赖 [§3.3](#s3-3) 的 sonar 扫描器**。把定义放在受 RBAC 保护的命名空间里、再锁定完整的 Pipeline / Task 身份，正是防止任意其他产出同名 result 的流水线触发取消的手段。适配到 sonar 形态时，把触发条件改成读取 `code-scan-results.result == 'Failed'`（或者 `code-scan-metrics` 里某个数值指标越界），身份锁定与防伪造那几部分原样保留。

:::warning apiCall 在 preconditions 之前执行

`subjects` 只能证明写 status 的是 Tekton 控制器 —— **直接创建的（裸）TaskRun，其 status 也是由同一个控制器写的**，所以裸 TaskRun 同样会进入 context 求值。没有父级时，`parentName` 为空，`apiCall` 退化成查询 PipelineRun 集合；随后父 UID、精确父画像、当前 TaskRef 与 `childReferences` 这几条前置条件全部不成立，请求被安全跳过。

这里的因果关系要弄清楚：**是"context 跑完之后被安全跳过"，而不是"选择器在 apiCall 之前就把它排除了"**。而真正的子 Run，则依靠 owner UID 等于实时父运行 UID，来排除同名重建或用户注入标签造成的混淆。

:::

**关键判据** —— 五环身份链必须全部成立，而且终态判定确实构成违规，才会动手（身份只决定*对谁*动手；*何时*动手由第 (3) 条的判定前置条件决定）：

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

:::details 验证清单（六种违规形态 + 三个不误报对照）

**违规形态**（逐个独立验证；每一种都必须在终态时触发失败关闭的取消）：`coverage-lines=30`（越界）、`not-a-number`（格式守卫）、`101`（数值范围守卫）、显式空字符串，以及到达终态却根本没有写出 `coverage-lines`。后两种分别证明"显式空值"与"result 缺失"不会被当成早期 status 写入而静默跳过。

**第六种：同一个 result 被写了两次**（由 `coverageResultCount` 守卫拦住）。这一条**必须**由 `coverageViolates` 承载，绝不能塞进 `deny` —— 这条规则驱动的是 `mutate-existing`，畸形的 status 必须走进**取消**这条路径才算失败关闭：

| 注入的 `status.results` | 加守卫之前 | 加守卫之后 |
|---|---|---|
| 单条 `coverage-lines=30`（正向对照） | 取消 | 取消 |
| `[coverage-lines=85, coverage-lines=30]`（干净的诱饵排在前面） | **不取消** ← 失败开放 | 取消 |
| 单条 `coverage-lines=85`（不误报对照） | 不取消 | 不取消 |

**探针只有在冒充 Tekton 控制器时才有意义**：这条规则的 `match` 带有 `subjects: tekton-pipelines-controller`，所以用你自己的身份去 patch TaskRun 的 status，规则**根本不会匹配** —— 连正向对照都不会取消，而这很容易被误读成"策略不起作用"。patch 之前加上 `--as=system:serviceaccount:tekton-pipelines:tekton-pipelines-controller`。（这也顺带证明了 `subjects` 这道门确实挡住了业务身份直接伪造 status。）

**不误报对照**：

- 一次非数值的运行用 `taskRunSpecs` **伪造了全部**子级的 pipeline / pipelineTask / pipelineRun 标签，结果仍然只取消了 owner 所指向的它自己的父运行 —— 证明策略不依赖那些标签；
- 另一个真实的控制器子 Run 使用同一个可信产出方，同样产出 `coverage-lines=30`，但它父 Pipeline 的精确身份是 `coverage-cancel-unrelated`：它正常跑到 `Succeeded` 而没有被取消，配套的 Audit 记为 skip —— 证明触发条件同时锁定了实时父画像与当前 TaskRef，而不是见到同名 result 就发作；
- 那个伪造标签的 TaskRun 与那个无父级的 TaskRun 都是由业务身份创建的，但它们随后的 status 请求仍然由 Tekton 控制器发出、确实会进入 context —— 它们最终因为 owner / 实时父运行 / 当前 TaskRef / childReferences 全部不成立而被安全跳过，各自正常跑完。

**一次成功的取消是什么样子**：目标父运行的 `spec.status` 被 patch 成 `CancelledRunFinally` → 该运行终态为 `Cancelled`，`sleeper` TaskRun 变成 `TaskRunCancelled`，finally 的 notify 照常执行。同一个补丁还会写入 `cancel-reason` 注解，**其中的变量是从触发请求解析出来的**（读起来形如 `coverage gate not met on TaskRun <emit TaskRun 名>: coverage-lines='30'`）—— 这是事后唯一能在**对象上**把策略取消与手动取消区分开的东西（[§6.2.3](#s6-2-3)；该注解任何有写权限的人都能写，要正面确认写入者得查 API server 审计日志）。反向对照也要跑：**合规运行（`coverage-lines=85`）在 emit 到达终态之后，必须既没有被取消、也不带这条注解** —— 否则说明注解是被无条件写入的。

:::

:::warning 注解里嵌的是不可信的原始文本，而且终态未必是 Cancelled

三个容易踩的陷阱：

- **`{{ coverage }}` 的内容不由策略决定** —— 由写 result 的人决定。把 `coverage-lines` 写成 `30' bad: injected` 或 `first\nsecond: value` 之类：补丁照常渲染、取消照常发生，而注解里逐字包含那段**原始的、惰性的文本**（它既不会变成 YAML 结构，也不会让补丁失败）。**所以这条注解是"策略生成的诊断信息 + 一段不可信的原始文本"**：前缀（哪条策略、为什么）是可信的；引号里的取值只是证据素材 —— 不要把它当成独立的审计结论，因为攻击者可以往里写任何看起来像结论的东西。
- **当 result 根本写不出来时，终态是 `Failed` 而不是 `Cancelled`**。把 result 撑到 4 KiB（超过 Tekton 的 result 容量）：emit 步骤自身 `exited with code 1`，result 缺失 → 策略照样给出失败关闭的判定、补丁也成功（`spec.status=CancelledRunFinally`，注解同样写入，取值为空），但 **PipelineRun 的终态 reason 是 `Failed`** —— 因为在 Tekton 的裁决中，真实的任务失败优先于取消。**排障时不要只在终态为 `Cancelled` 的运行里找取消**：取消的证据是 `spec.status` 与注解；终态可能是 `Failed`（[§6.2.3](#s6-2-3)）。
- **落在子 TaskRun 初始化窗口内的取消同样以 `Failed` 收场**，而这一条与 result 有没有写出来无关。上面的 `sleeper` 在取消到达时通常刚被创建，Tekton 注入的 init 容器还在跑：如果取消恰好落在那个窗口里，TaskRun 的失败 reason 会是 `InitContainerFailed`（而不是 `TaskRunCancelled`），失败裁决再次优先于取消，父运行终态为 `Failed`。**这不代表策略没起作用**：`spec.status` 与 `cancel-reason` 注解都在，判断依据仍然按上一条。要稳定复现干净的 `Cancelled` 形态，请用下面"关于并行形态"里的技巧 —— 让 sleeper 的 Pod 保持 Pending，这样就没有 init 容器可失败，那个窗口也就不存在了。

:::

**关于并行形态**：上面的 PipelineRun 保持了通用的并行形态。在算力受限的环境里（无法同时调度两个带 Tekton 注入 init 容器的 TaskRun Pod），你可以用一个匹配不到任何节点的 `taskRunSpecs.podTemplate.nodeSelector` 让 sleeper 的 Pod 保持 Pending，从而稳定验证"一个已经创建出来的子 TaskRun 被取消了" —— 但要清楚**这并不能证明一个 Running 的 Pod 会立刻停止**。另外，把 `sleeper` 写成 `runAfter: emit` 会让"下游 Pod CREATE"与"父运行被取消"竞态，你可能会看到 TaskRun 已被取消、而它并发创建出来的 Pod 仍在 Running。

:::warning 两条迁移边界

**① 当父运行已经被删除时**，`apiCall` 会以 404 报错 —— 对取消场景而言这是失败安全的（父级都没了，本来也无从取消），但它会在 background-controller 的日志里留下错误行，**而且照样会让指标的 `rule_result="error"` 增长**；排障时不必惊慌。也正因为这种正常竞态与真正的投递失败共用了整套信号，[§3.7](#s3-7) 的监控项才要求先按目标对象归因再分类 —— 绝不要对裸的 `error` 增长设告警（[§6.1](#s6-1)）。

**② 画像必须替换**：这个示例锁定的是 `targetPlr.spec.pipelineRef` 与当前 `spec.taskRef` 中的精确画像；迁移到真实模板时，请换成那个模板自己的完整身份 —— **不要改用 pipelineTask 标签来收窄，它可以被 `taskRunSpecs` 覆盖**。

:::

**一个姊妹变体（由参数触发的取消）**：把 match 换成 `TaskRun` 的 **CREATE**、把覆盖率检查换成对展开后参数的检查，你就得到了"门禁参数不合规时取消父运行" —— 但 [§2.3](#s2-3) 契约 2 的主路径是直接 Enforce 拒绝门禁 TaskRun 的 CREATE（更简单、同步、失败形态固定为 `CreateRunFailed`）；只有当已经开始的前置任务必须经由 finally 收尾时，取消变体才有额外价值（也就是 [§4.2.2](#s4-2-2)）。
#### 4.6.2 由定义漂移触发的自我取消（自指向，控制器身份约束） {#s4-6-2}

- **治理什么**：**当一次运行已经在跑、这才发现门禁已经从模板里被移除时，把这次运行自己停掉**。[§4.1.1](#s4-1-1) 只能校验"引用了谁"，永远看不到定义内容；只有当 resolver 把定义解析进 `status.pipelineSpec` 之后，你才第一次看得到"那个可信扫描器还在不在" —— 如果它不在了，就取消这次运行。
- **难在哪里**：检测信号与 [§4.1.4](#s4-1-4) 的漂移 Audit 完全相同；区别在于这里是**真的取消**，所以身份约束不能放松：写 status 的请求必须锁定到 Tekton 控制器 ServiceAccount —— 否则任何能写 status 的人都能**伪造一次漂移事件**去取消别人的流水线。
- **策略怎么分层**：① 匹配 `PipelineRun/status`，且写入者必须是控制器 SA → ② 在解析出来的 `status.pipelineSpec` 中检查那个可信扫描器是否仍然存在（**被移除或被换成另一个任务**都算漂移）→ ③ 命中就取消 —— 目标直接取自当前请求对象（**自指向**，不做跨运行查询，因此天然没有 [§4.6.1](#s4-6-1) 那种认错父运行的风险）。
- **治理不了什么**：这同样是**事后响应** —— 漂移只有在运行已经开始之后才被发现；在那之前的副作用不会回滚。

:::warning scan + 可信扫描器身份是夹具画像的门禁形态，不是普适身份

与 [§4.1.4](#s4-1-4) 的漂移 Audit 一样，这条自我取消**必须按模板画像逐个配置**（按父 `PipelineRun.spec.pipelineRef` 分支，每个画像配自己的扫描器身份）；绝不要不加守卫地对所有运行断言某一种门禁形态 —— 那会把所有使用其他门禁形态模板的运行**误取消**。不要用 `tekton.dev/pipeline` 标签替代 spec 身份。

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

:::details 用于验证的正反向 PipelineRun

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

**预期形态（多路对照）**：

- 正常的 `gated-build`（`scan` → `cluster/task/tekton-templates/policy-demo-scanner`）到达终态 `Succeeded`，`scan / release / notify` 全部成功；
- 漂移夹具 `gated-build-rogue` **保留了完全相同的 Task 名** `policy-demo-scanner`，只把命名空间换成 `policy-poc` —— 解析之后完整身份检查照样识别得出来：父运行被 patch 成 `CancelledRunFinally`、终态为 `Cancelled`，正在跑的 `prep` 变成 `TaskRunCancelled`，`scan / release` 被跳过，finally 的 `notify` 成功，cancel-reason 注解存在；
- 完全移除的夹具（删掉 `scan`、保留普通的 `prep`）同样被取消，finally 成功；
- 由**非控制器身份**提交的 status 子资源对照，既没有设置 `spec.status`，也没有取消注解，更没有产生任何后台 mutation —— 证明 subject 约束成立；
- 只有那种**有 finally 段而普通任务为空**的定义会被 Tekton 准入直接拒绝；那不是自我取消策略能处理的正常运行路径。

**时序说明**：触发发生在**解析之后**，所以前置任务可能已经开始跑了 —— 这是"尽早取消"，不是"阻止启动"；要阻止启动，请用 [§4.1](#s4-1) 的准入白名单。

#### 清理（§4.6）

按 [§4.0.4](#s4-0-4) 的两条规则，集群级对象用归属账本按记录的 UID 删除 —— 除了两条策略，本节还有一个 `ClusterRole`，删除命名空间同样带不走它：

```bash
for pol in cancel-on-failed-verdict cancel-run-without-gate; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
# The §4.2.2 alternative (namespaced Role / RoleBinding) belongs to §4.2's namespace and
# cascades with it -- do not delete twice.
delete_owned_cluster_object clusterrole kyverno-background-update-pipelineruns
```

命名空间级对象（四个演示 PipelineRun，以及 `tekton-templates` 中的 `Pipeline/coverage-cancel-demo` 与 `Task/policy-demo-coverage-emitter`）随自建命名空间的级联一并回收；如果你要继续做后面的章节，请先按名字删掉那四个运行，以免 PolicyReport 干扰（[§4.0.5](#s4-0-5)）：

```bash
kubectl delete pipelinerun -n policy-poc cancel-low-coverage-demo \
  cancel-missing-coverage-demo self-cancel-compliant self-cancel-rogue \
  --ignore-not-found
```
## 5. 作用域控制 {#s5}

不同项目需要不同的约束，但**作用域的实现方式决定了策略体系会不会留下一个绕过它的口子**。本章把 [§1.3](#s1-3) 的两层模型变成可运行的策略。

**先读 [§5.0](#s5-0)**：本章（乃至全文）的每一条保证，都建立在"能修改策略体系的人是受控的"之上 —— 作用域写得再严密，任何能修改策略、签发豁免、更改作用域标签，或更改 Kyverno 自身配置的身份，都能整体绕过它。这就是这条信任根放在本章开头、而不是埋在末尾的原因。

### 5.0 策略体系的自我保护（先读这一节） {#s5-0}

作用域治理的基础，是能修改策略体系的人受控。这并不意味着每条策略都只能由平台管理员维护；权限应当按资源作用域分层：

- **ClusterPolicy**：只有平台管理员可以创建、修改、删除。不应授予项目管理员该权限 —— 否则他们能影响其他项目，或者拆掉平台基线；
- **Policy**：可以下放给指定的项目管理员，用 RBAC 只允许他们在自己的命名空间内创建、修改、删除。普通业务开发默认不应拥有该权限 —— **能修改项目 `Policy` 的人，就能修改该项目的门禁**；
- **PolicyException**（**能创建 / 修改豁免对象 = 能放行**）—— 也就是 [§5.3](#s5-3) 中 `--exceptionNamespace` 所指命名空间的写权限；
- **命名空间的作用域标签**（例如 `cpaas.io/project`）—— **能改标签 = 能把某次运行移进或移出某一档约束**。首选是用 RBAC 封住谁能修改 `Namespace`；确实需要更细的按身份控制时，也可以用 Kyverno 校验 `Namespace` 的 UPDATE 来锁住这些标签的变更（一份 userInfo / 创建者白名单，写法与 [§4.5.4](#s4-5-4) 相同）。
- **Kyverno 自身的运行时配置**（`kyverno` 命名空间中的 `kyverno` ConfigMap）—— **它在链条上比任何策略都靠前，而且更安静**。它的 `resourceFilters` 在任何策略被查阅之前就生效了：被过滤掉的请求不会被拒绝、不会进 PolicyReport、也不会留下任何日志行（见 [§3.1](#s3-1) 清单第 7 项）。添加一条覆盖某个命名空间或 `PipelineRun` 的过滤项，等于**为整章策略开了一个豁免位 —— 没有 TTL、没有痕迹，也不经过 [§5.3](#s5-3) 的审批流程** —— 所以这份 ConfigMap 的写权限必须与 `ClusterPolicy` 同级，并纳入变更审计。
- **Kyverno 的 webhook 对象及其生成来源的配置** —— `ValidatingWebhookConfiguration` 由 Kyverno 自己维护（[§3.1](#s3-1) 清单第 6 项），但**一个能把它的 `failurePolicy` 翻成 `Ignore`、收窄它的匹配面、或者干脆删掉它的身份，实际上已经获得了对本文所有准入保证的拆除权**：模板白名单（[§4.1.1](#s4-1-1)）、门禁参数契约（[§4.2.1](#s4-2-1)）、裸 Run 入口封堵（[§4.5.4](#s4-5-4)）与 Pod 级镜像白名单（[§4.5.3](#s4-5-3)）会一次性全部落入策略真空，而集群表面上看仍然是"策略都还在、都还 Ready"。所以不要只保护 `ClusterPolicy` —— **Kyverno 的部署入口（[§3.1.1](#s3-1-1) 的 `ModuleInfo`）、它的 ConfigMap，以及它的 webhook 对象，是同一条信任链上的三环，必须一并管控。**

**本节给出的是权限边界，而不是变更历史**：上面各项保证的是"**此刻**谁能改什么"，而审计通常要问的是"**某次发布当时**实际生效的是哪些策略、哪些豁免、哪份 Kyverno 配置" —— 而这个问题**从集群里回答不了**：你查到的永远是当前对象，它排除不了中间曾经短暂放宽、替换、又改回来的可能。要能回答它，必须在部署时钉死两个锚点：① **所有策略与豁免都走 GitOps**（版本历史就是变更历史 —— [§3.6](#s3-6) 已经要求；PolicyException 用审批日期 / 单号命名，[§5.3](#s5-3)）；② **Kubernetes API server 的审计日志** —— 它是唯一能证明"某个对象在某个时间窗内被创建 / 修改 / 删除过"的来源，但**它是否启用、保留多久取决于你的环境** —— 把它写进审计判据之前先确认这一点。

**进阶（`generate`；本文不展开）**：一条 `generate` 规则可以为每个新建的项目命名空间自动下发一份命名空间级 `Policy`，让新项目自动继承一套基线。其生命周期管理（同步、删除）较为复杂；引入前请先评估。

### 5.1 作用域匹配方式 {#s5-1}

| 方式 | 匹配什么 | 典型用途 |
|---|---|---|
| 命名空间级 `Policy` 的 `metadata.namespace` | 仅该命名空间内的资源 | 项目管理员自助收紧；不需要 `ClusterPolicy` 权限 |
| `match.resources.namespaces` | 命名空间名称（字面量 / 通配） | 在少量固定命名空间中精确限定范围 |
| `namespaceSelector` | **Namespace 自身的标签** | 平台集中管理策略时，按项目标签做差异化 |
| `exclude.resources.namespaces` | 命名空间名称 | 从"所有"中把系统命名空间摘出去（平台基线的主力写法） |
| `match.resources.selector` | **被校验资源自身的标签** | 按 PipelineRun / TaskRun 自身的标签再细分 |

### 5.2 两层治理模型 {#s5-2}

- **治理什么**：让平台基线覆盖每一个业务命名空间，同时允许各项目在其之上**收紧**。
- **难在哪里**：基线**绝不能**依赖"这个命名空间带了某个标签" —— 新建的、未打标的、或者标签被改掉的命名空间就会天然逃出基线。
- **策略怎么分层**：① 基线 `match` 所有命名空间 + 用**否定式 `exclude`** 把系统命名空间摘出去 → ② 收紧使用**肯定式 `namespaceSelector`**（平台管理）或命名空间级 `Policy`（项目自助）→ ③ 多条策略匹配同一资源时，它们之间是**与**关系 —— 收紧只能更严，永远不能放松。
- **治理不了什么**：修改作用域标签本身的权限不在这一层 —— 那属于 RBAC，或者 [§5.0](#s5-0) 的策略体系自我保护。

**基线**：匹配所有命名空间，并 `exclude` 掉系统命名空间。下面的规则正文用一个注解探针代替真实约束（真实基线请换成 [§4.1](#s4-1)–[§4.5](#s4-5) 中的任意一条硬约束）：

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

**平台管理的项目侧收紧**：当项目策略由平台团队集中维护时，可以用 `namespaceSelector` 只选中带有 `cpaas.io/project: alpha` 标签的命名空间，并在其上叠加更严格的规则：

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

**先创建三个探针命名空间** —— 本节六格探针完全依赖它们之间的标签差异，而 `rogue-ns` 没有标签这件事本身就是其中一格。守卫与 [§3.3](#s3-3) 相同：既有命名空间保持不动、不打标记，因此下面的清理删不掉它：
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
**如果上面的输出是 "WALKTHROUGH_ID is unset"**：本节后续的每一条命令都会报命名空间不存在或探针失败 —— 那是**准备工作没做完**，不是策略判错了。回到 [§3.3](#s3-3)，把那个块跑一遍（或者把你记下的 id 重新 `export` 一次），再继续。我们刻意没有给后续每条命令都套一层检查：那会把整节变成流程控制而不是可读的实操，而且这种失败是**响亮的**（一眼就能看见的 NotFound），不是静默的。

**然后安装上面那两条策略** —— 它们是本节的被测对象；不装它们就跑探针，六格全都会返回**放行**，看起来就跟"策略写错了"一模一样：

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

**验证探针**（命名空间：`proj-a` 带 `cpaas.io/project=alpha`，`proj-b` 带 `=beta`，`rogue-ns` 无标签）：

| 探针 | 预期 |
|---|---|
| 在 `rogue-ns`（无标签）违反基线 | 拒绝（基线不看标签） |
| 在 `proj-a` 违反基线 | 拒绝 |
| 在 `tekton-operator`（已排除）违反基线 | 放行 |
| 在 `proj-a` 违反项目规则 | 拒绝（收紧生效） |
| 在 `proj-b`（另一个项目）违反项目规则 | 放行 |
| 在 `rogue-ns`（无标签）违反项目规则 | 放行 |

**关键结论**：基线建立在否定式 `exclude` 之上，未分类的命名空间就**无处可逃**；收紧建立在肯定式 `namespaceSelector` 之上，它就只作用于目标项目。多条策略匹配同一资源时是与关系 —— `proj-a` 中的一次运行同时受基线与收紧的约束。

**项目管理员的自助治理**：上面的 `project-alpha-tightening` 只是平台管理的写法。在项目自治模式下，把同样的 `spec.rules` 放进一个 `kind: Policy`，把 `metadata.namespace` 设成项目命名空间，并从规则中去掉 `namespaceSelector`（命名空间级 `Policy` 天然只作用于该命名空间）；`spec.webhookConfiguration` 的层级声明原样带过去 —— 命名空间级 `Policy` 支持同一个字段，它生成的 webhook 同样按取值分组。平台 RBAC 只授予指定的项目管理员在自己命名空间内管理 `Policy` 的权限，**不授予 `ClusterPolicy` 权限**。前提是 Kyverno 已由平台安装，且项目角色已被授予在本命名空间内管理 `policies.kyverno.io` 的权限；这一次性的平台配置完成之后，项目管理员日常调整规则就不需要平台管理员角色了。

| 部署模式 | 策略资源 | 维护者 | 生效范围 |
|---|---|---|---|
| 平台基线 | `ClusterPolicy` | 平台管理员 | 所有业务命名空间，以否定式排除系统命名空间 |
| 平台管理的项目侧收紧 | `ClusterPolicy` + `namespaceSelector` | 平台管理员 | selector 匹配到的那些命名空间 |
| 项目自助收紧（推荐给项目管理员的路径） | `Policy` | 项目管理员 | `metadata.namespace` 指名的那一个命名空间 |

`Policy` **只能收紧，不能覆盖或关闭**一条已经匹配上的 `ClusterPolicy` —— 每一条匹配到的 validate 规则都必须通过。它也治理不了 `Namespace` 这类集群级资源；而本文的 PipelineRun、TaskRun 与 Pod 都是命名空间级资源，所以主要的 validate / mutate 场景都可以用 `Policy` 实现。当某条规则使用 `mutate-existing` 或 `generate`、需要为 Kyverno 控制器授予额外 RBAC 时，那份控制器 RBAC 仍然由平台管理员预先审批并授予 —— 项目管理员不得通过自助策略获得跨命名空间或集群级的权限。

**平台强制要求绝不能只存在于项目自己就能修改或删除的 `Policy` 里** —— 它们必须留在平台管理的 `ClusterPolicy` 中；项目 `Policy` 承载的是项目自己的、可自行调整的收紧规则。

#### 清理（§5.2）

按 [§4.0.4](#s4-0-4) 的两条规则清理。**那六格探针没有留下任何需要清理的对象** —— 按 [§3.4.1](#s3-4-1)，它们是 `kubectl create --dry-run=server`，从不持久化任何东西；只有当你改成真的 `create` 时才会留下运行对象，而那些会被下面的命名空间级联回收。

先删掉那两条集群级策略（两条都是 Enforce —— 漏掉一条，它就会继续裁决所有人的准入请求，所以要读输出，别让失败悄悄滚过去）：

```bash
for pol in pipeline-baseline project-alpha-tightening; do
  delete_owned_cluster_object clusterpolicy "$pol"
done
```

按创建循环给它们打上的标记删除那三个命名空间 —— **既有的那些没有标记，这个循环碰不到它们**：

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
### 5.3 PolicyException 可控豁免 {#s5-3}

- **治理什么**：当某条流水线确实需要暂时绕过某一道门禁时（紧急发布、覆盖率稍后补），使用**可控豁免** —— 不要把"看到某个标签就放行"写进策略。
- **难在哪里**：**豁免的匹配键绝不能是任何业务可控的东西。** PipelineRun 的名字、它的标签，以及 `spec.taskRunSpecs[].metadata.labels`，全都是业务输入；而且 Tekton 还允许 `taskRunSpecs` 中的同名取值覆盖并传播到子 TaskRun 的标签上。拿这些字段当审批凭证 = 自助绕过。
- **策略怎么分层**：① 用一个**专用执行命名空间**作为豁免边界 —— PolicyException 只匹配该命名空间内的 TaskRun → ② 用 Enforce 策略锁死该命名空间的**所有运行入口**：谁可以创建 / 更新 PipelineRun、谁可以创建 TaskRun，以及**谁可以创建 CustomRun**（三类入口漏掉任何一类，你就为自助绕过留了一扇门 —— 与 [§4.5.4](#s4-5-4) 同理）→ ③ PolicyException 精确到"某条策略的某一条规则"；其余每一条规则照常拦截。
- **治理不了什么**：PolicyException 原生**没有 TTL** —— 对象一旦创建就永远有效；"临时"这个词背后没有任何机械保障。**过期清理要你自己实现**，而三个可放的位置各有代价：① 在审批工作流里挂一个过期任务（最直接，但依赖流程纪律）；② 用 Kyverno 的 cleanup 能力在过期时间点删除该对象（不需要人盯着，但意味着要多装并验证一条清理策略 —— **本文既不提供、也未验证过那份素材**）；③ 把过期日期硬编码进名字与标签（本节签发命令中建议的 `<yyyymmdd>-<seq>` 命名正是为此），再由周期性评审把过期项捞出来（最轻，但它只发现、不清理）。三者一个都不选 = 豁免是永久的；[§3.6](#s3-6) 中"PolicyException 过期却没被清理"那一行描述的正是这种局面。

**分层使用**：上面四条是安全模型 —— 只要你安装豁免，它们就必须整体成立；本节后面的签发命令，以及对传播延迟、吊销与清理的完整验证，属于**运营证据层** —— 首次启用与周期性审计时跑它们；日常签发只需要签发命令加上到期清理。如果你不需要豁免，就不要启用那个平台开关（[§3.1.1](#s3-1-1)）—— 整节可以作为一个整体不安装。

:::warning RBAC 是叠加的 —— "没有显式 RoleBinding"不等于被拒绝

为审批者身份新增一个 Role，**并不能收回**业务身份从 ACP 基线 ClusterRole 那里已经获得的 PipelineRun 权限。在真实环境中，业务 ServiceAccount 在一个新建命名空间里通常已经拥有 create 权限，所以下面那条 Enforce 策略必须**叠加在** RBAC 之上 —— 不能把"没有 RoleBinding"当作拒绝的证据。

:::

本节用到两个命名空间：`policy-exempt-runs`（豁免的执行边界）与 `policy-exceptions`（除了 `PolicyException` 对象之外什么都不放）。**后者通常在平台配置 `--exceptionNamespace` 时就已经存在**，而且是别人的可信命名空间 —— 所以还是老规矩：只创建不存在的那个，只给自己创建的东西打标签。

**先读出平台实际信任的是哪个命名空间**，再决定要不要创建东西：读晚了，你可能已经白白创建了一个命名空间 —— 然后还得回头把本节每一份 YAML 里的 `namespace` 都改一遍。

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

确认之后再创建命名空间：

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
**如果上面的块打印了 "WALKTHROUGH_ID is unset"**：本节后续的每一条命令都会报命名空间不存在或探针失败 —— 那是**准备工作没做完**，不是策略判错了。回到 [§3.3](#s3-3)，把那个块跑一遍（或者把你记下的 id 重新 `export` 一次），再继续。我们刻意没有给后续每条命令都套一层守卫：那会把整节变成流程控制而不是可读的实操，而且这种失败是**响亮的**（NotFound 一眼就能看出来），不是静默的。

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

:::warning 上面那些 ServiceAccount 身份必须对照你的环境核对

如果你的安装命名空间或控制器 SA 名称不同，请替换它们；**不要照抄未安装的可选组件的身份**。不要凭记忆核对 —— 把两个身份都读出来：
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

第一条命令打印出来的，正是要放进白名单的完整身份（形如 `system:serviceaccount:tekton-pipelines:tekton-pipelines-controller`，命名空间取自实际部署）；第二条没有输出，说明 Tekton Results 未启用——正对应下一段"未启用时不要把该身份写进列表"的情形。

`tekton-results-watcher` **仅在启用了 Tekton Results 时才适用**：它需要更新 PipelineRun 来管理 `results.tekton.dev/pipelinerun` finalizer，**漏掉一个真实存在的 watcher，会让归档后的 finalizer 清理卡住，正在删除的 run 就此僵死**。启用时，把 Results watcher Deployment 当前真实的 ServiceAccount 追加进 `only-trusted-identities-update-exempt-runs` 的 `value` 列表；未启用时（`TektonConfig.spec.result.disabled=true`——Deployment 和 ServiceAccount 都不存在），不要把该身份写进列表。

:::

本节的六个步骤之间会写若干**本地状态文件**（`gate-snapshot.txt`、`step3-verdict.txt`、`step4-verdict.txt`、`step6-delete.txt`、`step6-revocation.txt`、`exemption-id.txt`、`exemption-uid.txt`、`exemption-intent.txt`、`cleanup-exception-gone.txt`）——它们记录验证走到了哪一步、各步结论如何，因此你可以换一个终端接着做；**开始前先把上一轮的这些文件全删掉**（`rm -f` 即可），免得把上一轮的结论或过期的 `yes` 当成本轮自己的。

**确认身份无误之后再安装这条入口锁策略**——它正是本节步骤 ② 的被测对象。没有它，业务身份创建 PipelineRun 会**直接成功**，而正如 [§5.3](#s5-3) 开头的警告所说，ACP 基线 RBAC 通常本来就允许这个 create——于是这次成功没法归因为"RBAC 配错了"，你会去调一个根本不存在的问题：
```bash
# Save the four-rule YAML above as exempt-namespace-approver-only.yaml, AFTER
# substituting <approver-identity> and the ServiceAccount identities you just read.
# `create`, not `apply` (§4.0.4). An AlreadyExists means the policy is somebody
# else's object: find out whose before going on, and do NOT let this section's
# cleanup delete it.
create_owned_cluster_object exempt-namespace-approver-only.yaml clusterpolicy
kubectl wait --for=condition=Ready clusterpolicy/exempt-namespace-approver-only --timeout=60s
```

:::warning 被豁免的那条规则此刻必须真的装着，否则六步全是假通过

**`gate-param-contract`（[§4.2.1](#s4-2-1)）此刻必须已经安装，且作用范围同时覆盖正常执行命名空间与 `policy-exempt-runs`。** 在 [§4.0.5](#s4-0-5) 的分节独立路径上，你在 [§4.2](#s4-2) 末尾把它删掉了，而本节到此为止也没有重装过——目标规则缺席时，下面的步骤 ③ 和 ⑤ 都会直接成功，你会把"没被拒绝"读成"豁免生效了"。所以先装上，并读出两样东西来确认：
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

这条策略**留到本节最后**：清理末尾那次 ⑤ 复查同样依赖它（见 [§5.3](#s5-3) 的清理部分）。

:::

这个 PolicyException 只匹配专用执行命名空间里的 TaskRun——不再依赖 run 名称或标签。**`kinds` 写成带组版本的 `tekton.dev/v1/TaskRun`，与被豁免策略（`gate-param-contract`）自身的 match 逐字一致**——豁免对象的原则是：能多窄就多窄。不带组版本的裸写法 `TaskRun` 也能用，但更宽：在仍然提供 `v1beta1` 的环境里，这种写法会连 `v1beta1` 的 TaskRun 一起覆盖。今天两种写法**实际效果**相同（豁免只能作用于策略本来就会命中的请求，而那条策略只看 `v1`）；差别在将来：如果那条策略某天被放宽到也匹配 `v1beta1`，宽写法的豁免会**自动跟着一起放宽**，而且没有任何告警。改成带组/版本的写法是一次收紧——上线前用 [§3.4](#s3-4) 的正/负向探针重新验证：
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

⚠️ **这份演练资产只带了清理归属标记，没有 [§3.6](#s3-6) 要求的治理元数据**：生产签发时还要把审批工单、生效起止时间、责任人一并写进 `metadata.annotations`——机器可读的到期时间也正是上面回收方案 ②／③ 能落地的前提，而签发命令不会替你填这三项。

把上面的 YAML 存成 `approved-exemption.yaml`。**创建前先确认这个名字没被占用**——`policy-exceptions` 通常是**平台早就建好的可信命名空间**，里面可能已经有真实生效的豁免；而本节最后的清理是按名字删的。所以：
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

`ruleNames` 必须与目标策略当前的 `spec.rules[].name` **逐字一致**：名字过期时对象照样能创建，但它**静默地一条规则都没豁免**。

三个关键性质：**双重入口管控**（创建 PolicyException 的权限由 `policy-exceptions` 的 RBAC 关死；run 的入口由 RBAC + 准入策略共同关死，且准入侧必须**同时覆盖 PipelineRun / TaskRun / CustomRun 三类入口**：漏掉任何一类，这条性质就不再成立）、**精确到某条策略的某一条规则**（其余每条规则照常拦截），以及**可审计**（豁免对象、审批人身份、专用命名空间里的 run 都可查）。

**启用方式（ACP 特有）**：

1. PolicyException 需要控制器参数 `--enablePolicyException=true`（ACP 默认已开）**加上** `--exceptionNamespace=<可信命名空间>`——**只给其中一个都不够**。只给前者时，PolicyException 对象能创建（带一条告警），但**完全不生效**；补上后者，同一个豁免立刻生效。`--exceptionNamespace` 指定的命名空间就是豁免权限被关死的地方；它只接受**单个**命名空间或 `*`——不支持列表。多项目环境的两种部署形态（集中审批／`*` + 一条元策略）见 [§3.1.1](#s3-1-1)；本节演示的是**集中审批**模型——可信命名空间归审批方所有，项目成员永远进不去。
2. **持久化启用必须走平台模块的 chart values 覆盖面**——直接用 `kubectl patch` 打控制器 Deployment，会被下一次 reconcile 回滚。逐字步骤（含确认与回滚）见 **[§3.1.1](#s3-1-1)**。
3. `ClusterPolicy.status.conditions[].reason=Succeeded` **只能证明策略编译通过，证明不了 webhook informer 已经加载它**——而 PolicyException 的创建／删除还有各自的传播窗口。上线与自动化测试必须用**真实、受控的请求探测行为**：先证明"没有豁免时，违规 run = `CreateRunFailed`"，然后用一个**全新名字**创建豁免，直到一次被审批的 run 真的跑到 `Succeeded` 才宣布可用；删除之后同样要等到同类被审批的 run 重新变回 `CreateRunFailed`。**不要在传播窗口内删掉又立刻用同名重建**——这样得出的稳定性数字毫无意义。

**跑六步之前先把两个身份准备好**——步骤 ① 要的是"业务身份被 RBAC 拒绝"，其前提是**审批人身份确实已经被授权**；否则两个身份都被拒，你证明的只是"谁都创建不了"。审批授权就是一个命名空间级的 Role + RoleBinding（两个真实身份**只填一次**，填在下面代码块顶部的 `APPROVER_IDENTITY` / `BUSINESS_IDENTITY` 里，写成 `system:serviceaccount:<ns>:<sa>` 或用户名；六个步骤和清理都引用这两个变量）：
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

**名字为什么必须唯一**：固定名字在这个可信命名空间里有真实的碰撞对象——`policy-exceptions` 里很可能**已经存在**一份由别人维护的同名审批授权，而 `apply` 会就地改掉它；即便换成"先 `kubectl get` 确认名字没被占用，再 `create`"，get 与 create 之间仍留有窗口，别人照样能在这期间创建同名对象。一旦名字带上演练 id，这一整类事故就失去了前提：集群上不会有任何东西合法引用这个名字——**这也正是清理可以放心按名字删掉这两个对象的原因**；唯一可能撞上的，只有本次演练自己先前的尝试。
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

**六个步骤里的每一条 `kubectl create` 都必须带 `--as`**：①／② 用 `$BUSINESS_IDENTITY`，③–⑥ 用 `$APPROVER_IDENTITY`。**不带 `--as` 就是以你自己 kubeconfig 的身份在操作**（多半是管理员）：六步全都"通过"，而这什么也证明不了（[§4.0.3](#s4-0-3) 的身份自检说的是同一件事）。

**其余命令刻意不带 `--as`**——下面的代码块就是这么写的——出于两个不同的理由：

- **读操作（`kubectl wait` / `kubectl get`）**：被测的是"谁能写"，读只是取证。何况业务身份未必有 `get pipelineruns` 权限，用它来读只会得到一个与结论无关的 `forbidden`。用你自己的身份读：读到的是同一个对象的同一份状态。
- **⑥ 里的删除**：⑥ 验证的是"吊销能否传播"，不是"谁有权吊销"（那是步骤 ① 的活），所以用自己的身份删是对的。

:::details 端到端验证清单（六步；违规触发条件是两个 gate 开关都设为 "false"）

| 步骤 | 预期 |
|---|---|
| ① 业务身份创建 PolicyException | **被 RBAC 拒绝** |
| ② 业务身份在 `policy-exempt-runs` 里创建 PipelineRun | **被准入拒绝**（尽管 ACP 基线 RBAC 本来就允许这个 create） |
| ③ 没有豁免时，审批人身份在专用命名空间里创建违规 run | `CreateRunFailed` |
| ④ 用新名字的豁免经行为探针确认后，审批人身份创建同配置的 run | `Succeeded`，且 `scan / release / notify` 三个 TaskRun 全部成功 |
| ⑤ 正常命名空间里同配置的违规 run | 仍是 `CreateRunFailed`，子 TaskRun 数为 0 |
| ⑥ 删除豁免、缓存吊销稳定后，专用命名空间里同类被审批的 run | 重新变回 `CreateRunFailed` |

六个步骤用的是**同一个违规 run**，只有命名空间和名字不同——所以先定义一个生成它的函数，六步复用：
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

**开始六步之前，先确认前置条件真的成立。** 上面那些代码块都是"装上再读回来"，但读到的东西没有一样变成了控制流——就算两条策略压根没装、审批人身份也从未真正授权，六个步骤照样会跑完，并递给你一整套毫无意义的结论：
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

**② 业务身份在专用命名空间里创建 run——预期被准入拒绝**
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

**③ 没有豁免时，审批人身份创建违规 run——预期 `CreateRunFailed`**
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

**创建豁免（在 ③ 与 ④ 之间）**
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

**④ 豁免就位后，同配置的 run——预期 `Succeeded`**
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

**⑤ 正常命名空间里同配置的 run——预期仍是 `CreateRunFailed`**
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

**⑥ 删除豁免之后——预期重新变回 `CreateRunFailed`**
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

起保护作用的是 `EXC_DELETED` 变量，不是那条 `STOP` 提示——一句"只跑一次……"的注释拦不住任何一个整块粘贴的人：
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

**⑥ 正常跑完后豁免已经不在了**；如果删除失败或那个循环被跳过，它就还在——这正是下面的清理写成"先确认，再决定要不要删"而非无条件补删的原因。不管你走到哪一步，六个步骤创建的那些 run 都还留在两个命名空间里——清理里的删除命名空间会把它们级联回收掉。

顺带说一句为什么不退回"用标签标记豁免"的老做法：标签的**写入路径**确实可以保护——用策略禁止业务身份在 CREATE 时设置豁免标签、禁止通过 `taskRunSpecs` 注入、禁止在 UPDATE 时添加，只让审批人身份能改。但"写入路径可以保护"**不等于"标签可以充当豁免匹配键"**：匹配键必须是攻击者根本够不着的东西，而标签的可写面会随模板能力（比如 `taskRunSpecs`）而变——每多一条新的写入路径，就要多加一条禁令。所以本文把边界划在受控的专用命名空间上，而不是标签上。

:::

#### 清理（§5.3）

按 [§4.0.4](#s4-0-4) 的两条规则清理，但**本节的顺序很重要**。本节的残留也比其他节更危险：`PolicyException` 原生没有 TTL——忘了删就是一条永久绕行通道。

:::warning 即使中途放弃，这部分也要跑

六个步骤里任何一步失败、或者你决定停下来，**都要把这部分跑完**——它对你没走到的那些对象是安全的（读不到就报读不到，没创建过就无可删）。中途不清理就走，集群会同时留下：`gate-param-contract`（Enforce——它会持续拒绝真实流水线）、`exempt-namespace-approver-only`（Enforce）、审批人身份的 `Role` + `RoleBinding`（**能签发豁免 = 能放行**），以及可能已经创建出来的 `PolicyException`（**没有 TTL**）。这四样没有一个会自己消失。

:::

**① 先确认豁免已经不在**。正常路径上步骤 ⑥ 已经删过了；而当 `policy-exceptions` 是平台早已存在的可信命名空间时，下面的步骤 ④（删除命名空间）根本不会碰到它——所以这里单独确认一次，还在就删掉。这里的结论是后续步骤的**硬闸门**：只有在"归属台账里没有本轮的豁免记录"或"确认对象不存在"时才继续；读取／删除失败时，保留审批 RBAC、入口锁和 gate 策略——绝不在可能还存在活跃绕行通道的情况下拆掉安全边界。
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

**② 撤销审批授权**（名字带演练 id、只属于本次运行，所以按名字删没问题；先删 RoleBinding——先撤授权，再删它指向的 Role）：
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

**③ 只有在豁免与授权都确认清除之后，才删除入口锁策略**——反过来做会开出一个窗口：入口锁已经没了，而豁免还在：
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

**④ 删除两个命名空间**。六个步骤创建的 run 里，除了留在 `policy-poc` 的步骤 ⑤ 那个之外，其余全部——包括 ④／⑥ 的失败尝试——都会被级联回收；`policy-exceptions` 只有在**本轮自己创建**时才带演练标签——平台预先建好的那种，这个循环永远不会碰：
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

留在 `policy-poc` 的步骤 ⑤ 那个 run 属于 [§3.3](#s3-3) 的共享命名空间，随它的最终清理一并回收；想立刻重跑验证，就先删掉它：`kubectl delete pipelinerun -n policy-poc step5-normal-ns --ignore-not-found`。

**⑤ 先复查，最后再删 `gate-param-contract`**。先把上面六步表格的第 ⑤ 行再跑一次——正常命名空间里的违规 run 必须仍以 `CreateRunFailed` 结束；复查之所以有意义，恰恰是因为这条策略还装着——先删了它，剩下的只是一个注定"成功"的 run，什么也证明不了。复查通过之后：
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

留下的那些本地状态文件（`gate-snapshot.txt`、`step3-verdict.txt`、`step4-verdict.txt`、`step6-delete.txt`、`step6-revocation.txt`、`exemption-id.txt`、`exemption-uid.txt`、`exemption-intent.txt`、`cleanup-exception-gone.txt`、`*.err`）不受集群清理影响——要不要当证据留着由你决定；只要在下一轮演练开始前删掉即可（提醒在本节开头）。


## 6. FAQ 与故障排查 {#s6}

### 6.1 平台／项目管理员（策略侧） {#s6-1}

#### 6.1.1 策略装不上（创建时被拒） {#s6-1-1}

- **mutate-existing 缺少 RBAC**：报错提示 background-controller 对目标资源没有 update 权限。Kyverno 会在策略准入时校验 mutate.targets 的 RBAC——按 [§4.6](#s4-6) 授予 `update pipelineruns`。
- **子资源与 background 冲突**：匹配 `*/status` 的 validate 规则不能带 `background: true`（结果类策略保持 `background: false`）。

#### 6.1.2 策略装上了但不生效 {#s6-1-2}

按顺序逐条排查：
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

**如果上面四步都通过、策略仍未生效，那就只剩两种原因——而它们的症状与"策略没装"完全一致**：

1. **规则的身份前置条件没命中 → 规则被跳过（本文最常见的一种）**。[§4](#s4) 里相当一部分策略把身份钉死在演示夹具上（[§4.0.2](#s4-0-2) 里标了 🔧 的那些）；照搬进生产而不替换身份，规则每次都跳过，PolicyReport 里一条记录都不留——**与"策略没装"无从区分**。怎么查：把该规则 `preconditions` / `context` 里读的字段，逐个与真实请求对象比对（`kubectl get pipelinerun <name> -o yaml`，逐字段看），或按 [§4.0.3](#s4-0-3) 的警告用 `--as=<规则要求的身份>` 重跑探针。**不要用普通身份跑探针然后下结论说"策略没生效"**——以身份为前置条件的规则，在错误身份下永远是假通过。
2. **请求在任何策略被查询之前，就被 `resourceFilters` 整体跳过了**（[§3.1](#s3-1) 检查清单第 7 项）：没有拒绝、没有 PolicyReport 记录、没有日志行——一条**完全静默**的通道。怎么查：`kubectl get cm -n kyverno kyverno -o jsonpath='{.data.resourceFilters}'`（与 [§3.1](#s3-1) 检查清单第 7 项同一条命令），确认没有任何条目覆盖流水线所在命名空间或 `PipelineRun` / `TaskRun` / `Pod`。

#### 6.1.3 定位一次误拦 {#s6-1-3}

用 `--dry-run=server` 复现被拦的请求，从拒绝消息里读出策略名／规则名，再回到那条规则的前置条件、以及它的 context 变量取到了什么值。对 JMESPath 变量，用 `kubectl create --dry-run=server -o yaml` 观察 mutate 结果，或者用 kyverno CLI 离线跑夹具（[§6.1.6](#s6-1-6)）。

#### 6.1.4 ⚠️ 识别并解除被卡死的流水线 {#s6-1-4}

**症状**：TaskRun / PipelineRun 停在 `Running` 永不结束，Pod 已经 `Completed`，事件反复出现：
```text
Warning  UpdateFailed  taskrun/<name>  Failed to update status for "<name>": admission webhook "validate.kyverno.svc-fail" denied the request: ...
```

**根因**：某条策略对 `*/status` 子资源用了 `Enforce`，挡住了 Tekton 控制器的状态回写（[§2.2](#s2-2) 讲的反面机制）。

**解除**：找出那条既用 `Enforce` 又匹配 `*/status` 的策略，改成 `Audit` 或删掉；控制器会按它当前的退避节奏重试并自动写入终态——但不要把恢复时间说成一个固定承诺：通常 1 分钟以内，取决于当时的重试节奏与负载。**长效修法**：结果类约束一律用 Audit（[§4.4](#s4-4)）或 mutate-existing（[§4.6](#s4-6)）；绝不对 status 用 Enforce。

#### 6.1.5 PolicyReport 没有记录／滞后 {#s6-1-5}

- 后台盘点要求控制器能读到对应的**主资源**；但 `background: false` 的 status Audit 是经由准入报告链路聚合的，并不要求 reports-controller 直接 get/list/watch `*/status`。看到权限告警时，请把 SubjectAccessReview 做对——基础资源加 `--subresource=status`——并以真实 PolicyReport 是否收敛为准；单凭那条告警不足以证明"该功能缺 RBAC"。status 策略必须是 `background: false`；status 没有后台重扫这道兜底。
- PolicyReport 聚合有延迟；刚跑完的 run 稍等片刻再查。
- **等过之后仍然为空，就别再等了**：`*/status` 策略只在准入时刻求值，而 `background: false` 意味着没有后台补偿。**丢掉一次运行中的求值没关系**（之后每次 status UPDATE 都会重新求值，运行中记下的 `skip` 会在终态落定后翻成 `pass` / `fail`）；但如果丢的是**终态那一次**，就没有下一次了——记录会**永久**停在 `skip`，永远不会自行收敛（低频；机制与解读边界见 [§4.4.1](#s4-4-1) 里"PolicyReport 是尽力而为，不是完整台账"那条警告）。这也决定了报告能怎么用：出现 `fail` 一定有问题，但**"没有 fail"不能充当合规证明**——"全部合规"这类结论必须回到 TaskRun / PipelineRun 本身，或者依靠流水线内的硬闸门（[§4.3](#s4-3)）。

#### 6.1.6 用 kyverno CLI 离线测试，及其局限 {#s6-1-6}

**本节需要本地装有 `kyverno` 命令行**（[§3.1](#s3-1) 的工具校验会打印它在不在）——它和集群里跑着的 Kyverno 是两回事；集群里装了不代表你机器上有这个命令。没有就跳过本节；演练路径上没有别的步骤依赖它。
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

它适合验证 JMESPath／前置条件／deny 逻辑（在已展开的 TaskRun 夹具上尤其好用）。**局限**：`request.userInfo` **可以**通过 `-u/--userinfo` 喂进手工构造的身份（username / groups / clusterRoles 都能进到表达式里），但 CLI **对你给的东西照单全收——它不做任何真实的认证或鉴权**——所以你可以离线回归身份类策略的判定逻辑，却无法验证"这个人在集群里实际拥有什么身份"；`context.apiCall`（那些防伪造检查）离线会直接报错，而 `*/status` 子资源更新的真实时序、以及 mutate-existing 实际打出的 patch，都必须在集群里端到端验证。

#### 6.1.7 常见 JMESPath 陷阱 {#s6-1-7}

- 变量可能不存在：一律加 `|| ''` / `|| \`[]\`` 兜底，否则"Unknown key"会把规则变成 error；
- 数值比较前先 `to_number()`；字符串用 `split(x, ';')` 解析；
- 引号转义：标签名里含 `/` 或 `.` 时写成 `request.object.metadata.labels."policy.alauda.io/exemption"`；凡涉及身份判定，仍要先确认该标签会不会被业务输入伪造；
- ⚠️ **管道 `|` 的结合力比 `||` 弱；写"两种形态取其一"时必须加括号**。想同时接受集群内形态（`taskRef.name`）与 resolver 形态（名字放在 `taskRef.params` 里）时，很容易写成：
  ```text
  spec.taskRef.name || (spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''
  ```

  它实际被解析成 `(A || B) | ([0] || '')`：在集群内形态下 `A` 是一个**字符串**，对字符串取 `[0]` 得到 `null`，整个表达式落到 `''`——**它本想接受的那一半反而被判成空，规则静默跳过（fail-open）**。resolver 形态一切正常，所以只测 hub 引用永远暴露不出这个问题。正确写法是**把管道锁在括号里**，只作用于列表那一侧：
  ```text
  spec.taskRef.name || ((spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''
  ```

  **判据要精确，别过度推广。** **唯一**需要加括号的情形是"管道左边有一个顶层 `||`"：那里 `||` 先把一个**字符串**和一个**列表**合并，然后对结果取 `[0]`，而对字符串取下标会得到 `null`。

  反过来，末尾形态 `列表表达式 | [0] || '兜底值'` **在括号这件事上本来就是对的——不要再加**：管道左边没有顶层 `||`；`|| '兜底值'` 属于管道右侧，作用在取出的那个元素上，列表为空时正常兜底。

  **但"括号是对的"不等于"这样取值是安全的"。** `[0]` 只取过滤结果的第一项，因此只有在**被读的列表自带唯一性保证**时才可用：

  - `spec.params` / `pipelineRef.params` / `taskRef.params` / `spec.workspaces`——**用 `[0]` 没问题**：Tekton 自己的校验 webhook 会拒绝重名（准确的报错文本见 [§4.2.5](#s4-2-5)；上游对应 `ValidateParameters` → `validateNoDuplicateNames`，resolver 的 `params` 走同一套校验，workspaces 另有一处显式的重名检查）。**但这份保证是借来的**：它由 **Tekton** 的 validating webhook 提供，而非 API server 的 schema 约束——当该 webhook 不可用且其 `failurePolicy` 为 `Ignore` 时，带重名的请求就能进来，而 Kyverno 这边仍然只读 `[0]`。对需要硬保证的判据（尤其是身份类），把"数量等于 1"折进判据里仍是更稳的写法——[§4.2.4](#s4-2-4) 的规则 ① 就是这么写的。
  - `status.results` / `status.conditions` / `status.skippedTasks` / `status.pipelineSpec.tasks`——**绝不要用 `[0]`**：这些列表由控制器写入，而 **CRD 上没有任何按名字去重的约束**，所以准入时同名条目完全可能出现两次。**在真实 condition 前面塞一个 `Succeeded=Unknown`、在真实 result 前面塞一个干净的同名 result、在真实跳过记录前面塞一个理由正当的同名 skip、或者在被掏空的 gate 任务前面塞一个合规的同名 task——任何一种都能绕过照抄 `[0]` 的策略**（构造方法、A/B 证据与修法见 [§4.4.1](#s4-4-1)、[§4.1.4](#s4-1-4)、[§4.1.5](#s4-1-5)）。
  - **写新的读列表策略时怎么判断**：默认一律**数条目数**。只有当 API server 自己保证该列表按键唯一时，才允许用 `[0]`——检查方法是 `kubectl get crd <name> -o yaml`：看你要读的那个列表带不带按键唯一性约束（在 Tekton 的 `status` 侧，一个都没有）。**不要拿上游 Go 源码里的 marker 当依据**：源码 marker 未必进得了 CRD；以 CRD 实际内容为准。
  - **数量怎么接进去，取决于 `deny.conditions` 用的是 `any` 还是 `all`**：`any` 之下，数量可以作为一条独立条件加进去；**`all` 之下绝对不行**——多加一条 `all` 条件会**放宽**判据；数量必须折进布尔变量本身（本文的 [§4.1.4](#s4-1-4) / [§4.6.2](#s4-6-2) 用的是 `all`，数量折进了 `scanIdentityValid`）。

  所以，终态判据不要写成 `contains(['True','False'], (…)[?type=='Succeeded'].status | [0] || 'Unknown')`；改成数条目数：`length((…)[?type=='Succeeded' && (status=='True' || status=='False')]) > \`0\``；读 result 时同样要配一条"目标 result 只允许出现一次"的护栏。

  一句话判据：**看管道左边有没有顶层 `||`**——有才加括号；没有就别动。
- ⚠️ **Kyverno 的比较运算符会对"长得像数字的字符串"做类型转换**——`NotEquals value: "false"` 在 `"1"` 上会给出错误判定（把 `"1"` 当数字，与字符串 `"false"` 比较返回"相等"，于是不拒绝）。**要做精确的字符串检查，就在 JMESPath 里算出布尔值**（例如 `contains(['', ' '], x)`，或者用 `variable.jmesPath` 把 `x != 'false'` 求值成 true/false），再用 `Equals true` 触发拒绝——绕开运算符的类型转换。本文在 [§4.2.3](#s4-2-3) / [§4.2.5](#s4-2-5) / [§4.5.1](#s4-5-1) / [§4.5.2](#s4-5-2) / [§4.5.5](#s4-5-5) 用的就是这个模式。

#### 6.1.8 观察控制平面 {#s6-1-8}
```bash
kubectl logs -n kyverno deploy/kyverno-admission-controller     # admission decisions
kubectl logs -n kyverno deploy/kyverno-background-controller    # mutate-existing / background scan
kubectl get validatingwebhookconfiguration -o custom-columns=\
'NAME:.metadata.name,FAIL:.webhooks[*].failurePolicy' | grep kyverno   # failure policy
```

`failurePolicy: Fail` = Kyverno 不可用期间拒绝相关请求（安全优先——但控制器副本太少、或处在滚动更新窗口内时，请求可能短暂被拒；Tekton 会重试）；`Ignore` = 放行（可用性优先，代价是一小段策略真空）。适用版本下的默认值是 `Fail` / `timeoutSeconds=10`（1.15 的 CRD），但**某条策略实际生效的值可能被两层改写**——策略体内的 `spec.webhookConfiguration`（本文的资产显式声明了它；分级见 [§3.7](#s3-7)）与平台级的 `forceFailurePolicyIgnore` 覆盖——所以判断行为要读策略的声明、再看生成出来的 webhook 分组（[§3.1](#s3-1) 检查清单第 6 项的两层读法），不要照默认值想当然；控制器副本数与 HA 也要据此规划（生产不应长期只有一个副本）。

### 6.2 流水线使用者（run 被拦的人） {#s6-2}

#### 6.2.1 怎么读一条拒绝消息 {#s6-2-1}

`kubectl` / UI 报出的准入错误里直接含有：`<策略名>: <规则名>: <自定义消息>`。消息里通常写清了要求（例如"阈值必须 ≥ 50，实际是 10"）。

#### 6.2.2 我该改什么 {#s6-2-2}

- 模板类拒绝（[§4.1](#s4-1)）：换成被批准的模板引用形态（cluster/hub/git 三条通道之一，版本钉死）；
- 参数类拒绝（[§4.2](#s4-2)）：把 gate 参数改回合规取值（不要关扫描，不要降阈值）。**关于 [§4.2.4](#s4-2-4) 有一句特别提醒：它拦的是"受保护分支的分析被显式关掉了质量门开关"；正确做法是把 `enableScanQualityGate` / `enableAnalyzeQualityGate` 改回 `"true"` 或干脆不传（继承可信默认值）——绝不是去改分支参数**；PR／特性分支上的构建本来就不受这条规则拦截，反倒是把 `sonarBranchName` 改成 `main` 才正好会撞上它；
- 如果确实需要临时绕行：走 PolicyException 审批流程（[§5.3](#s5-3)），由审批人身份在受控执行命名空间里创建 run；不要自己改标签，也不要直接进那个命名空间。

**按消息里出现的字段名对号入座**（一条规则常常同时校验好几个字段，所以先认字段——别猜）：

| 消息里出现的字段 | 该改什么 |
|---|---|
| `pipelineRef` / `resolver` / `catalog` / `version` / `pathInRepo` | 模板引用形态（[§4.1.1](#s4-1-1)）——注意 `url` 参数本身就是被禁的，别去加一个 |
| `enableScanQualityGate` / `enableAnalyzeQualityGate` / `skipTrivyScan` / `trivyExtraArgs` / 阈值类参数 | gate 开关与阈值（[§4.2.1](#s4-2-1) / [§4.2.5](#s4-2-5)）；恢复模板默认值 |
| `request-level 'url' present` / `'type' param count` / `'type' value` | **不是分支的问题**：扫描 Task 的引用来源被篡改了。消息里三个计数各对应 `taskRef.params` 里的一处——删掉请求级的 `url`、把重复的 `type` 收敛成一个，且 `type` 只能是 `artifact` 或者干脆不出现（[§4.2.4](#s4-2-4) 规则 ①） |
| `protected branch '...'` | 这次 run 落在受保护范围内（分支参数是受保护分支，或者**缺失／为空**——那种情况下按默认分支处理，消息里的分支显示为空），且某个 gate 开关被显式改动了——把开关恢复成 `"true"`，或者去掉这次显式覆盖（[§4.2.4](#s4-2-4) 规则 ③）。分支取值只来自 `sonarBranchName` 参数：`sonarProperties` 里不再允许出现 `sonar.branch.name`（那是规则 ② 的拒绝——见下一行） |
| `must use the supported form` | 输入不是规范形态（[§4.2.4](#s4-2-4) 规则 ②）：消息里每个布尔／计数各对应一处——不规范的 `sonarProperties` 条目（前导空白／`#`／换行）、借 `sonarProperties` 夹带受管键、或者重复的 PR 声明、值里含空白的 PR 声明。按消息和 [§4.2.4](#s4-2-4) 第一条警告里的对应表改成推荐形态 |
| `PR analysis ... claims target '...'`（出现在 PolicyReport 里） | PR 分析声明了一个受保护目标，且某个 gate 开关被显式关掉了（[§4.2.4](#s4-2-4) 规则 ④；Audit 不拦请求）——把开关恢复即可；重复声明／值含空白不会出现在这里——它们已经在准入时被规则 ② 拒掉了 |
| `srcImage` / `mappings` / 镜像仓库前缀 | 制品来源（[§4.5.1](#s4-5-1)）或运行镜像（[§4.5.3](#s4-5-3)）——消息里列出了**具体是哪个镜像** |
| 命名空间 / Secret / ServiceAccount 名称 | 发布目标（[§4.5.5](#s4-5-5)）；这些白名单由平台维护——找平台要当前批准的取值 |
| `ownerReference` / 控制器身份 | 你在手工创建裸的 `TaskRun` / `CustomRun`（[§4.5.4](#s4-5-4)）——改成提交 PipelineRun |

**Pod 级拒绝（`PodCreationFailed`）要多走一步**：那条消息挂在 TaskRun 的 condition 上——先用 `kubectl describe taskrun <name>` 找到它；消息里列出了**不合规的镜像**（[§4.5.3](#s4-5-3) 的 `badImages`）；批准前缀清单不在消息里——需要时找平台要。

⚠️ **`--dry-run=server` 未必是你能自己跑的自检手段**：[§3.4](#s3-4) 给的是**策略维护者**的验证方法，而它仍是一次带 `create` 动词的 API 请求——只有 `get` / `describe` 权限的人跑不了。对该资源没有 `create` 权限时，把错误消息和改好的 manifest 交给平台／流水线治理负责人代跑，或者使用产品侧的预检入口（本文不涉及；见 [§7.1](#s7-1) 里"编排时的'适用策略预览'"那一行）。

#### 6.2.3 我的流水线为什么被自动取消了 {#s6-2-3}

如果 run 变成了 `Cancelled` 而且不是你干的，**首要嫌疑**是某条策略选择了"取消"而不是"拒绝"——但"不是你干的"排除不掉其他用户、运维工具或自动化（它们写的是同一个字段）；到底是不是策略，以本节的标记为准，找不到标记就只能记为来源未知（细节在下面）。**终态不是 `Cancelled` 也仍可能是策略取消**：当 gate 任务本身先失败时，Tekton 的失败判定优先于取消——run 的终态是 `Failed`，而 `spec.status` 其实已经被写成 `CancelledRunFinally`（见 [§4.6.1](#s4-6-1)）——所以看到 `Failed` 且 `spec.status` 是取消类取值时，照样走下面这张表。**先把"非空"和"被取消"分开——两者不是一回事**：Tekton 校验 `PipelineRun.spec.status` 只接受四个非空取值，其中三个带取消/停止语义（`Cancelled` / `CancelledRunFinally` / `StoppedRunFinally`）；第四个 **`PipelineRunPending` 与取消毫无关系**——它的意思是"先别启动"，是以挂起状态创建 run 的正常做法（`TaskRun.spec.status` 同理，它的两个合法取值是 `TaskRunCancelled` 与 `TaskRunPending`）。所以判断"被取消了"要看**取值**，绝不能看"非空"。**还要注意，即便是取消类取值，也只能证明"有人请求了取消"，证明不了是谁请求的**（手工取消写的是同一个字段）：要认定是策略取消，得靠下表里的标记；找不到任何标记，就只能记为来源未知。（标记本身只是普通的对象字段——任何对该 run 有写权限的人都能造出来；要**正面确认写入者**，去 API server 审计日志里看这次 run 的修改者是不是 Kyverno background-controller 的 ServiceAccount。）**本文有四条路径会请求取消（终态通常是 `Cancelled`，但也可能是 `Failed`——见上一句与 [§4.6.1](#s4-6-1)），而证据只落在两个地方**：路径 1 把它留在那个 gate TaskRun 自己身上；路径 2 / 3 / 4 都在父 PipelineRun 上写同一个 `cancel-reason` 注解，靠**文本**区分。按下面的顺序查，第一个命中的就是原因（四者在机制上的差异——何时检测、动了什么、同步还是异步——见 [§4.6](#s4-6) 开头的汇总表）：

| 检查顺序 | 来源 | 触发条件 | 证据在哪 |
|---|---|---|---|
| 1 | [§4.2.3](#s4-2-3) 准入 mutate 取消 gate TaskRun | gate 开关／阈值参数不合规 | 那个 gate TaskRun 的 `spec.statusMessage` 与终态 condition 消息——**完整原因就在这里**；最容易辨认 |
| 2 | [§4.2.2](#s4-2-2) mutate-existing 取消父 run | 同上，只是换成取消父 run 的形态 | 父 PipelineRun 的 `cancel-reason` 注解 |
| 3 | [§4.6.2](#s4-6-2) 定义漂移自取消 | 解析出来的 pipeline 定义与被批准的身份不符 | 父 PipelineRun 的 `cancel-reason` 注解（文本里写明是漂移） |
| 4 | [§4.6.1](#s4-6-1) 结果触发的取消 | 结果不达标（覆盖率／漏洞数等）；**result 缺失或格式错误同样会命中**（**fail-closed 是判据的方向，不是投递保证**——patch 由 background-controller 异步投递，链路断了就静默丢掉这次取消；见 [§4.6](#s4-6) 汇总表下的第 ④ 点与 [§3.7](#s3-7) 的"异步投递链路"一行；那种情况下注解里的取值可能为空） | 父 PipelineRun 的 `cancel-reason` 注解（文本里点名触发的 TaskRun 与越界取值，例如 `coverage-lines='30'`）+ 那个 result 本身；配套 Audit 规则部署了的话，PolicyReport 里还有一条 fail 记录 |

就按这个顺序排查：**先找带 `statusMessage` 的 TaskRun**（有就是形态 1），**再读父 run 的 `cancel-reason` 注解文本**（形态 2 / 3 / 4 都写这个注解；靠文本区分：gate 参数／定义漂移／结果越界）。

⚠️ **这一切都以策略真的写了标记为前提**：`cancel-reason` 是策略取消时**自己写进对象**的东西——不是 Tekton 提供的字段（本文四条取消策略都带着那段 `metadata.annotations`）。抄策略时把它丢掉，后果**按路径分成两半**：

- **形态 2 / 3 / 4（父 run 上只有这一个标记）**：丢了它，**"策略取消"与"某人手工取消"就再也分不开**——两种情况下 `Cancelled` 终态完全一样。那时你只能从"某个 result 明显越界"去**推断**——而推断不是证据；在审计场景里只能记为"原因未知"（[§4.0.6](#s4-0-6)、[§4.4.4](#s4-4-4)）。
- **形态 1（[§4.2.3](#s4-2-3)）另有第二个标记**：同一个 patch 还会写 `spec.statusMessage`，其文本以 `Cancelled by policy <策略名>:` 开头，并被逐字拼进 TaskRun 的失败 condition。所以这条路径**即使注解丢了也仍可判定**；反过来，只保留注解、删掉 `statusMessage`，被拦的人在 `tkn` / 控制台里就看不到任何原因——**两个都别删**。

⚠️ **也要留意反向情况：本该取消却没取消**。形态 2 / 3 / 4 都是 mutate-existing——取消是后台异步投递的；当某个 result 明显越界、流水线却跑到了完成，且父 run 上既没有 `spec.status` 也没有 `cancel-reason` 时，原因通常不是判据没命中，而是投递链路断了（`context.apiCall` 到不了目标、UpdateRequest 压根没创建出来、background-controller 挂了或积压、目标上的 update RBAC 被撤销）。这类失败**既不产生拒绝消息，也不产生 PolicyReport 违规记录**。完整的信号语义（指标只覆盖求值层、三种 ERR 特征、写入层事件、归因判据及其有效期）由 [§3.7.1](#s3-7-1) 规定；这一段只给排查**顺序**：**先确认 background-controller 自己活着**（[§3.7.1](#s3-7-1) ①——控制器挂了的话，其余信号一条新记录都不会产生，跳过这步会把"控制器死了"看成"一片平静"）；然后搜日志——**三个层次的特征、两个控制器都要搜**（后台侧：求值层的 `failed to mutate existing resource` 与写入层的 `failed to update target resource`；准入侧：创建层的 `failed to update request CR` / `UpdateRequest creation skipped`——UpdateRequest 压根没创建时，后台侧完全静默；各层的字段与事件见 [§3.7.1](#s3-7-1) ③），逐行按 `resource=` / 目标对象归因（判据与有效期照 [§3.7.1](#s3-7-1) ②——求值层信号里混着正常的"父对象已删除"竞态，即 [§4.6.1](#s4-6-1) 的 404 说明）；只有"本该取消却还在跑"的 run 才是真正的投递失败——别把竞态噪音判成链路故障；**别把事后的 `kubectl get updaterequests -n kyverno` 当证据**（输出为空证明不了链路是否健康——见 [§3.7.1](#s3-7-1) 开头；想看到 UpdateRequest，得在复现之前先起一个 `-w` watch）；最后才去查判据本身——不是因为它不会错，而是因为投递失败不留拒绝、也不留报告痕迹，只有上面那些运行时信号能证伪它，而判据可以离线复查（[§3.4](#s3-4) 的探针骨架）。

下面的命令按表格自身的顺序取证——**归因标记字段先打印**（父 run 的 `spec.status` 与 `cancel-reason`，各子 TaskRun 的 `spec.status` / `spec.statusMessage`），随后才是 Events 与 PolicyReport 作为佐证：
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

> ⚠️ **可追溯的前提**：[§4.6](#s4-6) 的取消是一条纯 mutate-existing 规则——它**不会**自己产生"不达标"的 PolicyReport 记录。所以要让"为什么被取消"可追溯，你必须**同时部署对应的 [§4.4](#s4-4) Audit 策略**（把触发取消的那次结果判定记进 PolicyReport），或者让取消动作在父 run 上写一个受控的注解／事件，记录触发策略与证据。只装取消规则而不装 Audit，PolicyReport 里就找不到任何取消原因。

> ⚠️ **本节讲的是"故障排查"，不是"审计"**：上面每一条命令都以**对象还活着**为前提。`cancel-reason` 注解、`spec.statusMessage`、Events、PolicyReport 全都挂在 PipelineRun / TaskRun 上——对象一被清理，它们随之消失。**这不是"查到了但不可信"，而是根本查不到。** 本文也没有提供"按时间窗抽查历史发布"的入口：集群内的 PolicyReport 随对象一起回收——它们不是历史归档。真要做季度抽查，先跑 [§4.4.4](#s4-4-4) 里那条"最早记录"命令，看看集群内证据实际能回溯到多久以前；比这更早的发布只能去外部归档里查，用当时归档的 PipelineRun UID 作键。

## 7. 从旧版流水线策略迁移 {#s7}

v3 平台工程的流水线策略作用在当年的私有资源模型上（Build / Delivery 等）；v4 策略作用在原生 Tekton 的 `PipelineRun` / `TaskRun` / `Pod` 上——**两代的资源模型完全不同，所以本章不做资源字段的一一映射，只回答"旧版的每项治理能力在新方案里有没有对应物"**。正确的迁移方式：按 [§4](#s4) 逐场景用新机制重建等价约束——不要试图逐字段照搬。

### 7.1 能力对照表 {#s7-1}

图例：✅ 能力等价；🟡 有等价实现，但有前提／语义不同；🔴 有损——需要补充说明。

| 旧版治理能力 | v4 对应物 | 程度 |
|---|---|---|
| 强制使用官方／指定的流水线模板 | [§4.1.1](#s4-1-1) 模板白名单（cluster / hub / git 三条通道，版本钉死） | 🟡 身份等价；内容保证按 [§2.1](#s2-1) 的三档强度——集群内定义最强，远程引用需要外部治理来补足 |
| 模板必须带指定标记／必须包含某类任务 | 集群内定义的修改权限由 RBAC 关死（[§4.1.2](#s4-1-2)）+ [§4.1.4](#s4-1-4) 的 `status.pipelineSpec` Audit | 🟡 集群内定义靠 RBAC 锁住写权限；远程引用只有事后 Audit 的深度，且依赖外部模板治理 |
| 模板必须来自指定的 git 源 | [§4.1.1](#s4-1-1) 的 git 通道白名单（钉死 commit SHA） | 🟡 只有钉死 SHA 才锁得住内容；分支/标签上的内容约束需要靠仓库权限控制来补 |
| 质量门（覆盖率／漏洞阈值）——不达标就让 run 失败 | [§2.3](#s2-3) 的 gate 任务 `exit 1`（[§4.3](#s4-3)）+ [§4.2](#s4-2) 的参数契约保证 gate 没被关掉 | 🟡 两种方案都只能在扫描结果出来之后才判定；变的是**谁来判、失败长什么样**——旧引擎在平台控制器里对结果快照求值，并**立即**取消底层 run（一次显式的平台裁决），而这里是 DAG 内的 gate 任务失败／DAG 跳过，失败形态是任务失败（用 [§4.3](#s4-3) 把它与普通失败区分开） |
| 覆盖率**不回退**（相对基线的增量） | **无等价实现**：本文只做覆盖率绝对下限（[§4.3](#s4-3)）；增量需要"上一次的基线"——那是准入侧看不到的输入 | 🔴 见 [§7.3](#s7-3) |
| 限制分析目标分支 | [§4.2.4](#s4-2-4) 的受保护分支 gate 契约（TaskRun 级） | 🟡 受保护分支分析上的 gate 能钉死（`sonarBranchName` 已锚定），但 **PR 阶段的 gate 只能尽力而为**（`sonar.pullrequest.base` 是用户提供的参数——fail-open，Audit；见 [§4.2.4](#s4-2-4) 规则 ④ 与"平台触发链路的参数映射"） |
| 业务团队不得关闭 gate 开关 | [§4.2.1](#s4-2-1) 主路径（TaskRun 级的生效值）+ [§4.2.5](#s4-2-5) 辅路径（PipelineRun 级提前拦截） | 🟡 校验点对模板作者零改动；但识别契约（哪个任务别名、哪个参数名）必须按模板版本逐一配置 |
| 制品来源白名单 | [§4.5.1](#s4-5-1) 的拷贝任务参数白名单 | 🟡 覆盖指定拷贝任务的参数入口；只有配合 [§4.5.4](#s4-5-4) 的入口封闭才不可绕过 |
| 运行镜像的仓库／完整性约束 | [§4.5.3](#s4-5-3) Pod 级镜像白名单 + verifyImages（配套文档） | ✅ Pod 层是真正执行的那些镜像的可靠拦截点（旧方案通常够不到这一层） |
| 发布目标白名单 | [§4.5.5](#s4-5-5) 的目标 ns 参数 + kubeconfig secret 白名单 | 🟡 命名空间维度可治理；目标"集群"维度只能通过 kubeconfig secret 间接治理 |
| 按项目／按命名空间的差异化约束 | [§1.3](#s1-3) / [§5.2](#s5-2) 的两层治理（负向排除的基线 + 正向逐项目收紧） | ✅ 并且多了一层"未分类的命名空间必然落在基线之下"的负向覆盖语义 |
| 把报告式检查变成数值闸门（例如 lint 计数） | [§2.4](#s2-4) 的扩展模型：自定义任务输出声明式 result + [§4.3](#s4-3)/[§4.4](#s4-4) | 🟡 检查任务需要补一份数据契约（result 改造） |
| 制品属性（label / env / tag） | [§4.5.2](#s4-5-2) 用 `context.imageRegistry` 从源镜像的 config 里读 `Labels` / `Env`；tag 在镜像引用字符串里，由 [§4.5.1](#s4-5-1) 的参数白名单判定 | 🟡 只能读**准入时刻已经存在**的镜像（校验的是来源，不是本次 run 即将产出的目标制品）；而且它把外部网络调用放到了准入路径上（[§4.5.2](#s4-5-2) 的四条限制） |
| 规则表达式（旧方案对事件快照求值） | Kyverno 的 `match` + `preconditions` + JMESPath，对**准入请求对象**求值；run 结果类判据改为读 `*/status`（[§4.4](#s4-4)） | 🟡 可见字段变了：你只看得到请求里真实存在的字段——未绑定的参数**根本不出现**在请求里，而显式空串 ≠ 缺失（处理原则见 [§4.2.1](#s4-2-1)"参数缺失必须 fail closed"——只有在锁定了确切 Task 版本时才有可信默认值的例外）；事件快照里的派生字段没有对应物；跨对象信息必须用 `context.apiCall` 实时查（[§4.2.1](#s4-2-1)） |
| 评估记录与可视化 | PolicyReport（[§4.4](#s4-4)） | 🟡 记录能力等价；但**报告随被评估对象一起被 GC，没有 TTL／保留语义，而且被 Enforce 拒绝的请求压根不留报告**（[§4.4.4](#s4-4-4) 的边界）——长期留存需要外部采集，且**要采的不止报告**：证明"这次发布过了闸门"需要四类一起归档——PipelineRun / gate TaskRun 的终态与 result、PolicyReport、Events、准入拒绝消息（以 run UID 串起来；见 [§4.4.4](#s4-4-4) 的警告）。面向用户的可视化需要产品侧接线 |
| 把策略下发到多个集群 | **没有对应机制**：`ClusterPolicy` / `Policy` 都是**集群内对象**，必须逐集群安装（GitOps 或平台模块下发） | 🔴 新集群起步时策略为零，而这段"策略真空"从老集群那边完全看不见——见 [§3.6](#s3-6) 的新集群一行 |
| 编排时的"适用策略预览" | **无等价物**：`--dry-run=server` 只回答"这一个请求会不会被拒"，不会列出"哪些策略会命中" | 🔴 流水线使用者仍然只有在创建 run 时才看到拒绝消息；编排时的提示必须在产品侧另行接线 |
| 分阶段的生命周期评估（多阶段闸门） | 由三个时刻分层接管：准入（定义／参数）+ 执行（gate 任务）+ 事后（Audit／取消） | 🔴 没有统一的"阶段"抽象；沿生命周期观测点分层重实现（[§2.1](#s2-1)）——语义被削弱 |

### 7.2 本方案新增的能力（旧版没有；不属于迁移项） {#s7-2}

下列能力是原生资源模型加上 Kyverno 自然带来的；旧方案没有，列在这里作为迁移的净收益：

- **入口身份约束**（[§4.5.4](#s4-5-4) 的 `request.userInfo`）：区分 PAC 机器人／人／平台自动化；
- **运行镜像来源约束**（[§4.5.3](#s4-5-3) Pod 级）：判定的是**真正执行的那个镜像的仓库前缀**（旧方案通常够不到 Pod 层）；同一层还可以约束 `securityContext` / digest / 签名，但**本文不提供那些策略**；
- **注入默认值**（[§4.2.6](#s4-2-6) 的 mutate）：统一超时／标签／SA；
- **受控豁免**（[§5.3](#s5-3) 的 PolicyException）：可审计、受 RBAC 管辖的临时放行；
- **盘点存量资源**（[§4.4.4](#s4-4-4) 的后台 Audit）：在策略生效之前扫一遍现状；
- **策略分阶段上线**（[§3.5](#s3-5) Audit→Enforce）：先观察，后强制。

### 7.3 有损项的补充说明（🔴／关键 🟡） {#s7-3}

- **分阶段评估（🔴）**：如果旧方案有"逐阶段推进的闸门编排"，v4 没有对应的一等抽象。缓解办法：把阶段拆到三个时刻——准入时的定义／参数（[§4.1](#s4-1)/[§4.2](#s4-2)）、流水线 gate 任务里的质量门（[§4.3](#s4-3)）、事后的结果校验与响应（[§4.4](#s4-4)/[§4.6](#s4-6)）；并用 [§2.3](#s2-3) 的契约保证这三层合起来无法绕过。
- **质量门语义变化（🟡）**：判定方从平台控制器搬进了 DAG。旧引擎同样是在扫描结果出来之后才判（对结果快照做规则求值），但裁决发生在**流水线之外**，一旦违规控制器会**立即**取消底层 run——那是一次显式的平台裁决；而这里的裁决是 DAG 内的 gate 任务失败，或者事后取消（[§4.6](#s4-6)，Kyverno mutate-existing，**异步、秒级**），失败形态是任务失败——用 [§4.3](#s4-3) 把它与普通失败区分开。两种方案下，已经启动的前序或并行任务的副作用都不会回滚（[§2.3](#s2-3) 契约 5）。缓解办法：模板设计时把所有副作用排在 gate 之后（DAG 支配关系），必要时叠加 [§4.6](#s4-6) 的提前取消。
- **多集群下发（🔴）**：旧方案里有一个平台同步组件把规则推到各业务集群；v4 没有这一层——Kyverno 策略对象只存在于它所在的那个集群里。缓解办法：把这些策略当作 **集群基线配置**，纳入 GitOps／平台模块管理；在新集群纳管流程里加一步"按 [§4.0.7](#s4-0-7) 安装最小集并把验收跑完"（[§3.6](#s3-6) 的新集群一行），并定期比对各集群的策略状态，别让哪个集群悄悄落后。**比对不能只看策略名**：同名策略可能在 A 集群是 `Enforce`，在 B 集群还停在 `Audit`，或者作用范围少列了一个命名空间——它们都表现为"清单对得上，保证对不上"，所以要比的是四样东西——**名称 + 每条规则的 `validate.failureAction` + 作用范围 + `spec.webhookConfiguration`（`failurePolicy` / `timeoutSeconds`）**——再加一项集群级状态：平台的 `forceFailurePolicyIgnore` 开关（在它打开的那个集群上，所有声明的 `Fail` 都按 `Ignore` 生效；[§3.1](#s3-1) 检查清单第 6 项）。
- **覆盖率不回退／相对基线的增量（🔴）**：准入侧拿不到"上一次的基线覆盖率"——它不在请求对象里，也不是任何 Tekton 字段；Kyverno 只看得到本次 run 报上来的值。缓解办法：**把增量判定整体搬进 gate 任务**（由它自己去 Sonar 或其他外部系统取基线、比较、不达标就 `exit 1`——[§2.4](#s2-4) 的扩展模型正是这个形态）；Kyverno 侧只承担"这个任务一定在、且它的 gate 参数没被关掉"（契约 3 + [§4.2](#s4-2)）。**不要指望用 `context.apiCall` 在准入时去取基线**：那会让每一次 run 创建都吊在外部系统的可用性上，还得塞进 webhook 单次请求的超时预算里（[§3.7](#s3-7)）——代价和风险都不划算。
- **编排时的适用策略预览（🔴）**：旧方案能在流水线还没跑之前就列出"哪些策略会命中"；v4 没有等价 API。缓解办法：把 [§6.2](#s6-2)"被拦时怎么读消息"作为流水线使用者的第一入口；确实需要事前提示的场合，由产品侧针对**已知的模板画像**做前端提示——别指望 Kyverno 产出一份适用性清单。
- **远程模板的内容保证（🟡）**：在 hub / git 引用下，Kyverno 只能锁住身份；对内容的信任来自外部治理。缓解办法：优先用集群内模板命名空间（[§4.1.2](#s4-1-2)：修改权限由 RBAC 关死）；远程引用一律钉死不可变版本 + 依赖 catalog／仓库的发布治理 + [§4.1.4](#s4-1-4) 的漂移 Audit。

## 8. 结论 {#s8}

### 8.1 决策树：我想拦住某样东西——该用哪个机制 {#s8-1}
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

还有三个机制不在这棵树里，因为它们做的是"放行"而不是"拦截"：**统一注入默认值**（超时／标签，mutate，[§4.2.6](#s4-2-6)）、**内联例外**（[§4.1.3](#s4-1-3)——在 [§4.1.1](#s4-1-1) 白名单之上开一条受限通道，与 [§4.1.2](#s4-1-2) 的集群级全面禁止二选一），以及**受控放行**（PolicyException 临时豁免，[§5.3](#s5-3)）。

一句话收尾：**硬闸门是流水线内的 gate 任务制造出来的失败；Kyverno 的价值在于保证这个 gate"一定在、参数关不掉、来源与目标不越界、裸 Tekton Run 入口被封死"——外加提供审计与受控取消。** 有两条边界必须一起说：① "流水线绕不过去"是 **Kyverno 加 RBAC 共同做到的**——Kyverno 封死裸 Tekton Run，RBAC 收敛对 Pod/Job/Deployment 的直接权限与部署凭据；单靠任何一个都不够；② Kyverno 保证的是"gate 在、且它的参数没被关掉"；**它是否真正支配了发布，取决于可信模板的 DAG**（例如官方 java 0.3 模板里，`deploy-or-upgrade` 排在 `trivy-scanner` 之后，却不在 `sonarqube-scanner` 之后；两个模板的形态对比见 [§4.3](#s4-3)）。永远不要用 Enforce 拦 `*/status`（会卡死）；结果类约束一律用 Audit 或取消。

### 8.2 参考资料 {#s8-2}

- Kyverno 官方文档：`ClusterPolicy` 与命名空间级 `Policy` 的作用范围 —— https://kyverno.io/docs/policy-types/cluster-policy/overview/
- Kyverno 官方文档：mutate-existing、PolicyException、JMESPath —— https://kyverno.io/docs/introduction/
- Tekton Pipelines：resolver、results、`spec.status` 取消语义 —— https://tekton.dev/docs/
- `sonarqube-scanner` 0.7 的参数与 results 契约：**以你环境里实际安装的版本为准**。Hub 提供的 Task 不是集群里的 Kubernetes 资源（`kubectl` 取不到）；在 ACP 控制台里查看：左侧导航 **流水线 → 任务**，在列表里按 `来源` 列（`catalog` / `Hub`）定位目标 Task，打开详情页即可看到该版本声明的参数与 results。策略里的字段名必须与那个页面上显示的真实契约对齐；本文所用画像的契约矩阵见 [§3.2](#s3-2)。
- ACP 4.3 合规管理（Kyverno 插件）安装：https://docs.alauda.io/container_platform/4.3/security/security_and_compliance/compliance/install.html
- ACP 4.3 Kyverno 使用场景：https://docs.alauda.io/container_platform/4.3/security/security_and_compliance/compliance/howto/kyverno_use_cases.html
- Alauda DevOps Pipelines 安装与 `TektonConfig`：https://docs.alauda.io/alauda-devops-pipelines/4.14/install.html
- Kyverno 官方 PolicyException：https://kyverno.io/docs/guides/exceptions/
- Kyverno 官方 mutate-existing：https://kyverno.io/docs/policy-types/cluster-policy/mutate/

> 镜像签名／证明（verifyImages）与部署侧的供应链校验不在本文范围内——见配套文档 [基于 Tekton 与 Kyverno 的 Alauda Container Platform 软件供应链安全](./Software_Supply_Chain_Security_of_Alauda_Container_Platform_with_Tekton_and_Kyverno.md)；Kyverno 官方 verifyImages 文档：https://kyverno.io/docs/policy-types/cluster-policy/verify-images/overview/