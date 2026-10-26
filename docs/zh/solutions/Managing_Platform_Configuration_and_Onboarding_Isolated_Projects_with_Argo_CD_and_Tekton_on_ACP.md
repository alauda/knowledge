---
products:
  - Alauda Container Platform
  - Alauda DevOps
kind:
  - Best Practices
ProductsVersion:
  - 4.x
id: KB261000025
sourceSHA: 7b34e21aa8112cc57d2dcf20623e7ee00e4ccee35f7ddbde0c90c6a89c984662
---

# 使用 Argo CD 和 Tekton 在 ACP 上管理平台配置和入驻隔离项目

当项目请求时，平台团队通常会首先配置集群中的组件并创建工具账户。随着项目数量的增加，回答哪些设置是有意的、如何一致地创建下一个项目以及在另一个环境中需要准备什么变得更加困难。

当平台配置需要一个持久的审核来源时，当打开一个项目时在 GitLab、Harbor、Nexus 和 SonarQube 中重复管理时，或者当需要一起解释部署和凭证边界时，请使用本文。平台 Git 仓库记录共享意图。入驻管道将审核过的项目声明转化为命名空间和工具资源，然后通过合并请求提出项目的部署注册。

这两种机制有不同的所有权。Argo CD 负责与 Git 所拥有的对象和字段进行协调。入驻任务负责协调它们创建的外部资源。任何机制都不能替代解密密钥、签名密钥、外部工具数据或结果存储的备份。撤销注册可能会删除资源，因此恢复需要的不仅仅是重放或还原 YAML。

到最后，您应该能够：

- 分离平台配置、共享模板和项目应用状态。
- 解释 18 个平台决策、其所有者及其仓库层次。
- 准备先决条件，审核项目声明，并通过其注册合并请求跟踪入驻。
- 验证生成的项目边界，并计划协调、凭证轮换和配置恢复。

本文是 [Alauda DevOps 最佳实践](./Alauda_DevOps_Best_Practices_Overview.md) 的平台部分。它假设一个 ACP 项目和每个项目的独立工具侧租户。其配置基线为 Pipelines 4.15、Artifact Hub Shim 1.0、Connectors 1.14 和 GitOps 4.4，适用于兼容的 ACP 安装。共享一个命名空间和一个工具租户的团队需要不同的边界模型。

[伴随示例](https://github.com/AlaudaDevops/devops-best-practices-samples) 包含完整的参考文件。诸如 `shop`、`payments`、`platform-connectors` 和 `registry.example.com` 等名称是虚构的。请替换它们、图像占位符、组资源名称、策略身份和目标环境的加密 Secret 占位符。

## 建立所有权模型

保持三种类型的仓库分开：

| 仓库                          | 内容                                                                                                                                     | 所有者         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 平台仓库                      | 组件配置、准入政策、加密管理员凭证、项目声明和平台原生应用定义                                                                          | 平台团队      |
| 模板仓库和目录               | 版本化的共享管道和任务；初始项目 GitOps 仓库内容                                                                                       | 平台团队      |
| 项目仓库                      | 应用源和 `.tekton/`；项目 GitOps 仓库中的环境清单和摘要引用                                                                             | 项目团队      |

这种分离使三种类型的审核变得易于理解。平台变更可能会改变多个项目的约束，并需要平台审核。目录版本更改可重用工作流，并需要兼容性和采用决策。应用发布更改项目自身的期望状态，并属于项目的发布过程。

运行模板是项目命名空间中的执行设置，与版本化目录管道定义不同。它们保存特定管道使用的参数、工作区和集成。将应用清单保存在项目 GitOps 仓库中。项目可以添加命名空间策略，而共享基线仍由平台拥有。

```mermaid
flowchart TB
  MR[审核平台变更] --> Git[平台仓库]
  Git --> Argo[Argo CD]
  Argo --> Components[组件设置]
  Argo --> Policies[平台政策]
  Argo --> Credentials[加密管理员凭证]
  Argo --> Declarations[已发布项目声明]
  Declarations --> Onboard[Tekton 入驻]
  Onboard --> Tools[GitLab Harbor Nexus SonarQube]
  Onboard --> Namespaces[项目命名空间和身份]
  Onboard --> Seed[种子项目 GitOps 仓库]
  Onboard --> Registration[提出平台注册 MR]
  Registration --> Git
  Seed --> ProjectArgo[项目应用]
```

该图描述了所有权和交接。合并后的 PaC 调度程序在等待其发布配置后开始处理已更改的声明；Argo CD 并不会仅通过同步 ConfigMap 来触发 Tekton。入驻稍后提出单独的注册更改，必须在项目应用生效之前进行审核。

为每个资源或字段分配一个所有者。Argo CD 自我修复适用于它跟踪的对象；它不会协调集群中的每个对象或逆转外部工具操作。删除声明并不是自动退役程序。

### 决定配置恢复应提供什么

将配置保存在 Git 中提供了初始化的起点、审核轨迹和建议返回到早期设置的方法。它还允许审核者一起检查项目目的地、所有者和平台政策。这些好处依赖于明确的字段所有权和可恢复的先决条件集。

| 预期好处                             | 此设计提供的内容                                                   | 操作后果                                                          |
| ------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| 一致地初始化另一个环境。             | 审核过的组件设置、政策、模板和项目声明。                         | 安装兼容的控制器并在同步之前恢复凭证。                           |
| 解释平台变更。                       | Git diff、审核和合并修订。                                        | 限制对平台仓库的直接集群写入和访问。                             |
| 修复跟踪漂移。                       | 在启用和验证的层中自我修复。                                     | 操作员拥有的字段和凭证轮换需要自己的所有权规则。                 |
| 返回到先前的配置。                   | 对早期 Git 内容的审核更改。                                       | 在将还原视为安全之前检查修剪和外部副作用。                       |
| 协调项目资源。                       | 使用相同支持参数的重复入驻。                                     | 考虑令牌轮换、部分运行和项目锁定。                               |

注册表、数据库或身份系统可以保留 Git 中缺失的状态。定义恢复是否意味着恢复该状态或创建具有相同声明形状的新租户。此系列提供配置和入驻路径；完整的恢复运行手册必须在目标环境中执行。

## 在引导之前准备平台

使用其产品安装说明安装组件：

- [Pipelines](https://docs.alauda.io/alauda-devops-pipelines/4.15/install.html)，包括所需的 [PaC 组件](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/install/manage_pac.html) 和 [手动审批门](https://docs.alauda.io/alauda-devops-pipelines/4.15/how_to/manual_approval_gate_operator.html)。
- [Connectors](https://docs.alauda.io/alauda-devops-connectors/1.14/install/install.html)。
- [GitOps](https://docs.alauda.io/gitops/4.4/install_gitops/index.html)。
- [Kyverno](https://docs.alauda.io/container_platform/4.4/security/security_and_compliance/compliance/install.html) 和密封密钥控制器。在同步政策和 SealedSecrets 之前，必须存在它们的 CRD。

管理员创建管理命名空间，示例中的 `platform-connectors`，并在其中安装四个 Connectors 自动创建任务。这些任务是从 Connectors 文档中安装的；它们不是从一般任务目录中获取的。在提交之前准备对四个工具的管理员访问权限，并加密目标密封密钥控制器的凭证。

在 Git 之外创建 Chains 签名密钥和中央注册凭证。中央注册凭证必须在同步挂载它的组件层之前存在。仅允许其访问 Chains 必须读取和签名的注册项目，并在项目入驻时更新该访问权限。

在入驻之前，检查每个项目的 ServiceAccount，包括自动创建的 EventListener 身份及其实际组：Secret 的 `get`、`list` 和 `watch`，以及在 Chains 命名空间中创建 Pod 必须被拒绝。如果允许任何请求，则在其平台管理的源中缩小权限，或安装具有最小权限角色的组件版本，然后使用独立项目令牌重复检查。内置的 webhook Secret 验证使用单独的 core-interceptors 身份；EventListener 不需要集群范围的 Secret 读取。在权限更改后重新检查实际 webhook 接受和错误身份验证拒绝。遵循示例的 [项目访问检查](https://github.com/AlaudaDevops/devops-best-practices-samples/blob/main/sample-app/chains/README.md#check-project-access-before-enabling-signing)。

使用 Argo CD 注册平台仓库，并为每个项目 GitOps 仓库提供读取访问权限。仓库凭证模板可以覆盖批准的 GitLab URL 前缀；每个项目必须添加更窄的模板。对于应用程序和 AppProject GitLab 引用，请使用以 `.git` 结尾的仓库 URL。对于应用程序目标和 AppProject 目标约束，请使用由 Alauda GitOps 注册的集群名称。

通过平台在入驻之前创建 ACP 项目。管道导出该项目的清单以供后续注册。将现有项目导入 Git 需要与创建一个项目相同的审核：项目应用可以稍后修剪该资源。

入驻创建 GitLab 组及其服务令牌；它不会决定哪些人类用户属于该组或授予他们 GitLab 项目创建权限。平台或项目管理员必须单独添加批准的成员并管理这些成员资格，而不是使用 Pipelines-as-Code 使用的令牌。

平台管理员负责平台、项目 GitOps 和应用程序仓库的 webhook 设置和事件交付验证。当启用自动注册并配置 PaC 控制器 URL 时，创建 `Repository` 可能会导致注册控制器创建和删除项目 webhook。这需要一个集中式的 webhook 注册 GitLab 凭证，具有 `api` 范围和对项目的维护者访问权限，存储在控制器的命名空间中；PaC 仓库的开发者级别组令牌无法管理 webhook。配置控制器 URL，以便在 `pipelines-as-code-info` ConfigMap 中填充 `controller-url`，并在接受入驻之前验证仓库的注册状态和真实事件。有关产品特定凭证和控制器设置，请遵循 [高级仓库配置](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/advanced_repository_config.html) 和 [为 PAC 创建 Git Secret](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/create_git_secret.html)。

合并调度程序在声明 ConfigMap 之外还有第二个就绪合同。在创建子入驻运行之前，`projects` 应用程序必须已在管理命名空间中发布确切的合并声明作为 `project-<name>`，并且入驻应用程序必须在其中创建项目的 release-Connector `Role` 和 `RoleBinding`。示例将这两个对象命名为 `project-onboarding-release-connectors-<name>`，并授予调度程序 ServiceAccount 名称范围的 `get` 访问权限。这些权限允许调度程序等待，而不授予其更改发布连接器的权限。因此，新项目需要其 release-Connector RBAC 文件及其在声明和 `projects/kustomization.yaml` 生成条目中的 `onboarding/kustomization.yaml` 条目。如果任一应用程序仍在赶上，调度程序必须等待或报告项目未准备好；在尝试协调发布连接器时，过早启动子运行可能会失败。在应用程序准备就绪后，从合并提交重试，只要它仍然是 `main` HEAD，使用 `/test onboard-changed-projects branch:main`。如果该提交不再是分支 HEAD，则改为启动受影响项目的入驻运行模板；在重试后检查父结果和每个子运行。

保持 Harbor 项目私有。如果 Nexus 启用了匿名访问，并且其匿名角色可以读取租户仓库，则未经身份验证的用户可以读取由入驻任务创建的仓库，绕过租户凭证。入驻任务仅对匿名访问发出警告。禁用它（设置 → 安全 → 匿名访问）或删除匿名角色对租户仓库的访问权限，然后确认拒绝未经身份验证的读取。根据其任务指南，根据项目隔离要求配置 SonarQube 权限。不要仅仅根据单独凭证的存在推断隔离。

对于离线环境，在运行管道之前准备本地目录内容、固定工具和基础镜像、依赖仓库、证书和漏洞数据库。

## 决定 18 个平台基线

项目不应各自决定如何暴露管理员凭证、审计历史存储在哪里或哪些控制器可以绕过共享政策。在移交平台之前解决这些问题。特定于应用程序的输入和额外限制可以保留在项目中。

示例将决策分为四个 Git 所有权层：

| 层级      | 它拥有的配置                                                                           | 单独层级的原因                                                        |
| ---------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 组件      | TektonConfig 片段、Chains 选项、Pruner、Results 和监控设置。                       | 共享控制器和单例字段需要操作员感知的同步。                        |
| 政策      | ClusterPolicies 和共享准入边界。                                                    | 平台限制需要受控的推出和保护，以防项目更改。                        |
| 凭证      | 管理员 Connectors、加密 Secret 源和平台 PaC 注册。                                 | 凭证访问和轮换与应用状态有不同的生命周期。                        |
| 项目      | 声明和审核注册输出：应用程序、绑定和目标补丁。                                     | 每个项目请求的资源和部署范围可以一起审核。                        |

入驻安装是一个单独的应用程序，因为其执行权限和发布生命周期也需要审核。下面的层级列标识责任；四个自动创建任务仍然管理自己的外部资源。

该表标识平台决策及其仓库层。值和详细步骤属于链接的产品文档。这些是由管理员管理的建议，其成熟度和先决条件由所选版本决定。

| #  | 何时重要                                                                           | 决策                                                                                                                                                                                             | 共享的原因                                                       | 层级和指导                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | 在入驻第一个仓库或更改 GitLab 提供者之前。                                         | 将仓库访问令牌与 webhook 管理分开；使用审核过的默认分支定义和明确的 GitLab 提供者 URL。                                                                                                           | 凭证范围和合并前执行信任应保持一致。                           | 凭证和项目：[PaC 仓库配置](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/advanced_repository_config.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2  | 当团队需要可重复的合并请求或推送触发的重跑时。                                     | 对于合并请求运行，在合并请求上评论 `/test <pipelinerun-name> branch:<branch>`；对于推送触发的运行，在应运行的分支的最新提交上发布相同的形式。                                                    | 团队使用一个受支持的条目并明确源分支。                         | 项目模板：[触发 PAC 管道](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/trigger_pipeline.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3  | 当平台管理的地址或 Connector 必须在不编辑每个应用程序的情况下更改时。             | 将平台提供的仓库参数与应用程序输入分开。                                                                                                                                                          | 地址和 Connector 名称有明确的所有者。                            | 项目：[高级仓库配置](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/advanced_repository_config.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4  | 当外部注册表事件启动另一个管道时。                                               | 决定 Harbor 事件交接。                                                                                                                                                                            | 事件端点和验证需要一致的所有权。                                 | 组件：[Harbor 事件](https://docs.alauda.io/alauda-devops-pipelines/4.15/triggers/how_to/harbor_events.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 5  | 当凭证或声明需要定期修复时。                                                       | 安排协调和轮换，并设置故障警报。                                                                                                                                                                  | 平台拥有间隔和操作响应。                                         | 组件：[ScheduledTrigger](https://docs.alauda.io/alauda-devops-pipelines/4.15/triggers/how_to/scheduledtriggers.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6  | 在将 webhook 端点暴露到集群外部之前。                                             | 标准化 EventListener 暴露。                                                                                                                                                                        | TLS、路由和 webhook 验证属于平台。                                | 组件：[自动暴露规则](https://docs.alauda.io/alauda-devops-pipelines/4.15/triggers/how_to/trigger-wrapper-config.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7  | 当新项目必须接收相同的工具侧资源时。                                               | 使用四个产品任务协调工具侧租户创建。                                                                                                                                                               | 管理员保留工具范围的凭证。                                       | 凭证和项目：下面的工具任务指南。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8  | 在第一个令牌达到其到期窗口之前。                                                   | 为每个工具定义长期凭证轮换。                                                                                                                                                                      | 到期和续订行为因工具而异。                                       | 组件和凭证：[GitLab 自动创建任务](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors-gitlab/how_to/using_gitlab_connector_automatic_creation_task.html#step-by-step--rotate-in-place)、[Harbor 自动创建任务](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors-harbor/how_to/using_harbor_connector_automatic_creation_task.html#example-re-run-the-task-to-refresh-credentials-and-reconcile-resources)、[Nexus 自动创建任务](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors-nexus/how_to/using_nexus_connector_automatic_creation_task.html#re-run-to-add-repositories-or-rotate-credentials) 和 [SonarQube 自动创建任务](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors-sonarqube/how_to/using_sonarqube_connector_automatic_creation_task.html#rotation)。 |
| 9  | 在生产注册表由 Kyverno 强制执行之前。                                               | 配置 Chains 签名密钥和镜像验证。                                                                                                                                                                  | 平台拥有签名者并分发其公钥。                                     | 组件、凭证、政策：[签名密钥](https://docs.alauda.io/alauda-devops-pipelines/4.15/chains/configure/signing_key_configuration.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10 | 当工作负载访问长期凭证必须被缩小时。                                               | 使用 Connector 代理访问，同时跟踪长期凭证例外。                                                                                                                                                  | 访问边界和轮换需要一个中央所有者。                                 | 凭证：[Connectors Proxy](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors/concepts/connectors_proxy.html) 和 [CSI 驱动程序](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors/concepts/connectors_csi.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11 | 在构建工具和工作负载共享集群之前。                                               | 应用命名空间 Pod 安全性并分隔构建命名空间。                                                                                                                                                      | 构建工具和工作负载具有不同的权限需求。                           | 政策和项目：[受限标准](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/comply_with_pod_security_restricted.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 12 | 在生产凭证或工件可以发布之前。                                                     | 安装审批并定义受保护环境组和提升规则。                                                                                                                                                            | 审批所有权是平台控制。                                           | 组件、项目、政策：[手动审批门](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/manual_approval_gate.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 13 | 当项目需要额外限制而不削弱平台控制时。                                             | 建立平台和项目政策层。                                                                                                                                                                            | 项目可以添加限制，而不削弱平台基线。                             | 政策：[限制管道执行](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/constrain_pipeline_execution_with_kyverno.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 14 | 当集群无法从互联网获取任务或管道时。                                               | 拥有共享的、本地可用的目录。                                                                                                                                                                        | 重用和离线内容需要治理。                                         | 组件：[作者目录资源](https://docs.alauda.io/alauda-devops-artifacthub-shim/1.0/catalog/how_to/author_catalog_resources.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 15 | 当多个项目使用相同的工作流时。                                                     | 发布版本化的中央管道。                                                                                                                                                                            | 项目明确采用审核版本。                                           | 组件：[集中式管道管理](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/hub_pipeline_run_template_centralized_management.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 16 | 在清理可以删除共享运行历史记录之前。                                               | 选择 Pruner 默认值和命名空间覆盖策略。                                                                                                                                                            | 清理影响共享集群历史和容量。                                     | 组件：[Pruner 配置](https://docs.alauda.io/alauda-devops-pipelines/4.15/pruner/configure/pruner_configuration.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 17 | 在实时 Tekton 对象被修剪之前。                                                     | 定义结果存储、观察范围、身份验证和保留。                                                                                                                                                          | 审计记录需要独立于实时对象的存储。                               | 组件：[结果保留](https://docs.alauda.io/alauda-devops-pipelines/4.15/results/configure/retention_policy_configuration.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 18 | 在没有控制器健康证据的情况下操作平台之前。                                         | 启用指标和操作监控。                                                                                                                                                                            | 操作员需要控制器和执行健康的证据。                               | 组件：[指标收集](https://docs.alauda.io/alauda-devops-pipelines/4.15/configure/metrics_collection.html)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 选择共享默认值而不隐藏其成本

对于仓库访问和触发器，集中 webhook 管理，以便项目不需要 webhook 管理令牌。将较低权限的仓库令牌、审核过的定义源和明确的提供者 URL 与仓库配置保持在一起。标准重试命令有助于操作员，但发布工作流可以故意禁止评论重试：应用程序示例的 `ci` 需要在 `main` 上进行真实的 `push`。使用其单独的合并请求定义进行评论触发的检查。

对于工具访问，管理员准备创建任务及其凭证一次；项目接收范围资源和 Connectors。代理工作负载令牌减少了对工具凭证的常规暴露。它们不会移除工具的后端凭证、PaC 克隆凭证、镜像拉取 Secret 或 Chains 注册表访问的轮换。构建命名空间分离和对 Pod 创建的限制是此选择的一部分，而不仅仅是资源上的标签。

对于发布信任，平台拥有签名密钥、验证政策和受保护的生产凭证路径。项目选择哪个环境需要审批，并可以添加限制。单独安装审批组件并不能保护凭证。生产提升还需要核心准入规则和对已部署镜像源的限制，这些在交付文章中描述；这些附加内容并不是由此示例安装的。

对于共享资产，通过本地服务发布目录任务和版本化管道。固定版本使采用可审核；平台还必须保留引用的内容并定义发布坐标是否可以更改。初始 GitOps 模板是种子，因此升级该模板需要对已经包含内容的仓库进行单独更改。

对于操作，选择清理、归档和监控。清理节省集群容量，但删除实时证据。结果需要外部存储及其自己的读取授权，而审批响应需要单独保留。第一次 Pruner 同步和结果观察范围可能会影响现有租户，因此引入它们时需要进行清单和约定的保留限制。

这些设置是平台决策，而不是承诺产品默认值已经启用预期控制。检查
[功能成熟度](https://docs.alauda.io/alauda-devops-pipelines/4.15/overview/feature_maturity.html)
以获取所选版本，并分阶段引入每个控制。

### 将政策范围与定义信任分开

使用平台 ClusterPolicies 进行共享控制，使用命名空间策略进行项目特定限制。项目可以缩小允许的模板、版本、镜像仓库或参数，而不削弱平台基线。这取决于防止项目授予自己例外或更改平台政策。

通过实际提交身份限制直接 TaskRun 和 CustomRun 创建；仅依靠客户端提供的拥有者引用并不是授权边界。列举控制器身份并审核其权限。允许自动化身份创建直接运行会为任何可以使用该身份的人打开该入口。示例将管理命名空间排除在其解析器和直接运行策略之外，因此该命名空间的执行权限仍然至关重要。

可选地限制 PipelineRun 引用为批准的解析器类型。此缩略政策仅说明源类型决策；为每个平台系统命名空间调整命名空间排除：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipelinerun-source-baseline
spec:
  background: false
  rules:
    - name: approved-resolver-only
      match:
        any:
          - resources:
              kinds: [tekton.dev/v1/PipelineRun]
              operations: [CREATE]
      exclude:
        any:
          - resources:
              namespaces: [platform-connectors]
      validate:
        failureAction: Audit
        message: "pipelineRef must use an approved resolver"
        deny:
          conditions:
            all:
              - key: "{{ request.object.spec.pipelineRef.resolver || '' }}"
                operator: AnyNotIn
                value: [cluster, hub, git]
```

这并不限制解析器的 URL、目录、命名空间、版本、定义内容或运行时凭证范围。它还在强制时拒绝内联 `pipelineSpec`。在为项目仓库启用该限制之前，将示例的内联验证流转换为目录管道。在 `Audit` 中，违反此解析器规则的 PipelineRun 仍然被接受，并应生成 PolicyReport；在 `Enforce` 中，相同的请求被拒绝。在依赖该政策之前，使用一次性项目身份测试这两种模式。仅允许平台管理员创建 `PolicyException` 对象，或根据平台政策禁用例外；不要将此逃生口委托给项目身份。

### 限制项目部署而不替代 ACP 所有权

示例的 `argocd-project-namespace-boundary` 政策从一开始就以 `Enforce` 安装。不要遵循此边界的审核优先推出：审核报告不会阻止项目身份写入受保护对象。该政策通过配置的 Argo CD 身份限制对标记项目命名空间中的 Role、RoleBinding、ResourceQuota、LimitRange、NetworkPolicy、Kyverno PolicyException 和 Connectors AccessPolicy 的写入。它允许平台拥有的注册路径，并要求 `allowExistingViolations: false`。根据目标集群调整两个 Argo CD 身份，并在依赖边界之前验证已安装 API 的预期允许和拒绝情况。平台 `projects` 应用程序的例外依赖于 Argo CD 的 `argocd.argoproj.io/tracking-id` 注释；仅基于标签的资源跟踪不受覆盖。限制其他身份创建例外和 AccessPolicy，并将任何平台例外命名空间保持在项目目标之外。在每个应适用该边界的目标集群上安装并验证该政策。

当所有三个条件成立时，该政策拒绝受保护的写入：

1. 写入者是实际的 Argo CD 身份之一：注册的集群身份或应用程序控制器的身份。
2. 目标是标记为 `cpaas.io/project` 的命名空间，排除平台系统项目。
3. 对象的跟踪注释未标识平台拥有的 `projects` 应用程序。

这为平台注册提供了受控路径，同时防止项目应用程序利用部署权限重写其自身的权限、配额、网络边界、政策例外或 Connector 访问。它涵盖新对象和现有对象，因此使用实际身份测试创建、更新和删除请求。报告控制器还需要对匹配的 API 具有读取访问权限；示例包括 PolicyException 和 AccessPolicy 的聚合读取角色。

被拒绝的对象使应用程序的同步失败，并显示政策消息。重试设置决定后续尝试。从项目源中删除被禁止的对象并同步更正的修订。保持此边界从首次安装时就处于 `Enforce` 状态；其目的是阻止项目身份更改受保护对象，因此审核推出将留下该空白。

Kyverno 可用性和恢复是平台操作问题。对于用作准入门的政策，保持资源 webhook 注册为 `failurePolicy: Fail`；当 Kyverno 无法访问时，匹配的写入将被拒绝。这同样适用于审核政策：`failureAction: Audit` 控制 Kyverno 评估请求时的结果，但它不会使不可用的 Kyverno webhook 失败。在示例中，`no-bare-taskrun` 是一个审核政策，匹配集群中的直接 `TaskRun` 创建（除了其文档平台排除），因此 Kyverno 故障可能会阻止这些 TaskRuns 的创建，并可能停止依赖于它们的管道。对于此边界，失败还包括 Role、RoleBinding、ResourceQuota、LimitRange、NetworkPolicy、PolicyException 和 Connectors AccessPolicy 写入：入驻身份和集群管理员在 Kyverno 恢复之前被拒绝。缺失的 webhook 不提供强制执行，且有序的零规模可以删除资源 webhook 注册。保持 Kyverno 高可用，并保持受控的恢复程序，包括临时删除和稍后恢复 webhook 配置的条件。签名结果证明签名密钥，而不是生成图像的管道。将 ClusterPolicy、解析器、webhook 和 PolicyException 的更改限制为平台管理员。有关政策设计，请参见 [使用 Tekton 和 Kyverno 的管道政策约束](./Pipeline_Policy_Constraints_with_Tekton_and_Kyverno.md)。

## 组织和同步平台仓库

### 连接仓库、集群和所有权层

Argo CD 需要三个独立的协议：仓库读取访问权限、注册的目标集群和允许源和目标的 AppProject。在调试工作负载清单之前完成这三项。使用只读平台仓库凭证和覆盖批准的项目 GitOps URL 前缀的仓库凭证模板。入驻创建应用程序，而不是那些 Argo CD 凭证。

在应用程序和 AppProject 引用中使用以 `.git` 结尾的 GitLab URL，以避免 Argo CD 不遵循的重定向。使用来自 Alauda GitOps 注册的 `destination.name: <cluster-name>`，并在 AppProject 目标中使用相同名称。默认的 `in-cluster` 条目可以限制为 Argo CD 命名空间；它不是 ACP 注册集群的可互换名称。当迁移使用 `destination.server` 的清单时，删除该字段，而不是在实时对象上保留 `name` 和 `server`。

使用 `platform-repo/` 作为树根；仓库本身可以有任何名称。示例分为四个所有权层和入驻安装：

```text
platform-repo/
├── argocd/apps/       # 根和子应用程序定义
├── components/        # TektonConfig 和组件选项
├── policies/          # 平台准入政策
├── credentials/       # 管理员 Connectors 和密封占位符
├── projects/          # 声明和审核注册输出
├── templates/         # 注册渲染模板
├── onboarding/        # 管道、运行模板、计划和 RBAC
└── .tekton/           # 验证和更改项目调度
```

每个层级一个应用程序让审核者理解其路径和同步政策。一个层级中的渲染失败可能会阻止该应用程序中的所有对象；单独的应用程序减少受影响的范围，而控制器、凭证和运行之间的先决条件仍需得到尊重。示例具有根、四个所有权层和一个用于入驻的第五个子层。

根据其 README 将 `onboarding/` 从示例复制到平台仓库根。将仓库以只读方式注册到 Argo CD，并为每个层使用一个子应用程序。根应用程序管理这些应用程序定义。在替换占位符并准备上述凭证和 CRD 后，从该仓库的根引导一次：

```bash
kubectl apply -k argocd/apps/
```

在 `projects/` 中已存在的声明在稍后的 `main` 更改之前不会被合并调度程序拾取。在应用程序同步后，为每个现有声明运行一次入驻运行模板。稍后的更改遵循审核过的 Git 和调度程序路径。

### 根据资源生命周期选择同步行为

自动同步应用新的 Git 修订。自我修复在没有新修订的情况下修复实时更改。修剪删除从 Git 中移除的跟踪资源。这些是单独的决策：启用一个并不意味着所有三个都适合某个层级。

| 应用程序或层级               | 示例选择                                       | 原因和条件                                                                                              |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 根应用程序定义              | 自动同步、修剪和自我修复。                     | Git 拥有子应用程序配置。在删除应用程序之前审核移除和最终处理程序。                                   |
| 组件                        | 自动同步；`prune: false`，`selfHeal: false`。 | 部分单例 TektonConfig 字段与操作员共存；移除片段不得删除单例。                                       |
| 凭证                        | 自动同步，自我修复禁用。                       | 协调密封源、控制器管理字段和实时令牌轮换。                                                             |
| 政策、项目和入驻           | 示例中自动同步、修剪和自我修复。               | Git 拥有这些资源；注册删除对项目级别有影响。                                                           |
| 项目环境应用程序           | 自动同步、修剪和自我修复。                     | Git 是期望的应用程序状态；测试和生产在 Git 审核要求上有所不同。                                     |

对于部分单例组件配置，使用服务器端应用程序，以便平台仓库仅拥有指定字段。与之一起设置 `argocd.argoproj.io/compare-options: ServerSideDiff=true`；如果没有服务器端差异，应用程序可能保持 `OutOfSync`，自我修复可能会重复应用相同的明显漂移。在同步之前审核生成的差异和操作员的字段所有权。组件层使用 `prune: false`，以便移除片段时不会删除单例 TektonConfig，并以 `selfHeal: false` 开始。在启用持续自我修复之前，观察操作员的写回行为和有效所有权。自动同步新的 Git 修订和实时编辑的自我修复是单独的决策。

凭证层不启用自我修复：密封 Secrets 控制器可能会将控制器管理的状态写回实时 Secret，因此 Argo CD 可能会看到必须不重复覆盖的字段级差异。为目标控制器密封凭证，并计划如何轮换更新实时 Secrets 和加密源。对于启用自我修复的层，必须通过平台仓库和审核过的合并更改来更改受管理的对象；直接的 `kubectl` 编辑是临时的，并将被协调。ACP 项目首先创建同名的内部命名空间；入驻标记并采用该命名空间，然后创建工作负载、构建和交付命名空间。不要使用 `CreateNamespace` 添加第二个命名空间创建者。

### 审核有效的 AppProject 及其替代方案

ACP 维护与 ACP 项目关联的 AppProject。注册补丁仅管理预期的仓库和目标字段。将有效目标与平台管理的条目协调，并使用准入边界进行对象类型限制。不要仅依赖应用程序的同步状态来证明部署边界。

示例仅在 ACP 管理的 AppProject 上补丁 `sourceRepos` 和 `destinations`。ACP 还可以维护项目自身命名空间的目标条目，包括构建和交付。检查有效对象；注册补丁不是可达命名空间的独占列表。将单独命名的部署 AppProject 作为另一种选择，例如 `<project>-deploy`，具有自己的源、目标和资源限制。它使 Argo CD 拥有该项目的限制，但使用它的应用程序在选择 `spec.project` 等于 ACP 项目名称时不会出现在 ACP 项目的 GitOps 列表中。操作员将使用 Argo CD 查看它们。根据所有权和所需的控制台体验进行选择。

示例的平台 AppProject 允许广泛的注册操作。为了生产平台，缩小其源、目标和允许的类型；不要将其注册权限交给项目应用程序编写者。退役还需要单独检查和删除与 ACP 关联的 AppProject。

### 将注册回滚视为生命周期操作

仔细审核删除。还原注册提交或删除 `projects/<project>/` 及其 `resources` 条目可能会使 Argo CD 修剪注册的 ACP 项目。这可能会删除其同名命名空间以及其中的 Secrets、Connectors 和 Repository 对象。它不会逆转工具侧创建或自动删除每个构建、交付或环境命名空间。

仅删除 `projects/<project>.yaml` 是不同的：它不会退役项目，并且将其 `configMapGenerator` 条目保留在位置会使声明层渲染失败。使用单独的批准退役程序，涵盖工作负载、保留证据、外部租户、凭证、webhook 和每个命名空间。

### 在合并之前验证更改

在更改合并之前，渲染每个目录应用程序所需的内容。错误的 Kustomize 引用会阻止生成该应用程序的清单集，因此同一层中的不相关对象也可能停止同步。在合并请求验证中找到问题使其接近作者和差异。

平台和项目 GitOps 模板都包含 `.tekton/validate.yaml`，它组合目录 `git-clone` 和 `run-script` 任务。用包含 `sh`、`kubectl` 和 `kubectl kustomize` 命令的本地可用镜像替换其工具镜像；仅具有独立 Kustomize 二进制文件的镜像不足以满足示例脚本的要求。在第一次合并请求运行之前建立其 webhook。通过默认分支定义来源，验证定义的更改在进入该分支后首次执行。

验证每个应用程序拥有的目录，并将新目录添加到验证路径。使用 `/test validate branch:<branch>` 重新运行合并请求检查。PaC 使用合并请求的源分支，并忽略 `branch:` 以选择另一个 MR 分支；要运行另一个分支，请在其最新提交上评论。YAML 解析和 Kustomize 渲染不验证 CRD 准入行为；使用目标模式和隔离项目进行该接受步骤。

验证状态仅在 Git 平台要求时阻止合并。在 GitLab 上，为平台和项目 GitOps 仓库启用 **管道必须成功**。如果 Auto DevOps 启动没有可用运行器的额外管道，则合并请求可能保持在运行状态；禁用这些仓库的 Auto DevOps 或提供运行器。

使用 `pipelinerun_provenance: default_branch`，定义被审核，但验证仍然渲染提议的合并请求内容。示例的平台 Repository 和验证运行位于 `platform-connectors` 中，该位置也保存管理员 Secrets。该位置仅适合受信任的平台维护者：在那里创建运行的权限可能会暴露这些 Secrets。在接受不太可信的贡献之前，将 Repository、其有限令牌和验证执行移动到没有管理员凭证的命名空间。保持管理调度分开，仅授权审核过的调度路径以创建入驻运行。
样本入职调度程序将推送的修订版与其第一个父级进行比较。使用合并或压缩工作流，确保在该比较中保留所有声明更改；包含多个独立提交的快进推送可能会导致早期的声明更改被遗漏。样本的 `on-path-change` 注释是 4.15 版本中的技术预览功能，因此在依赖它作为触发边界之前，请验证其成熟度和行为。

## 声明项目并运行入职

声明记录项目请求的内容：所有权组、环境、命名空间和工具租户。它不包含凭证或运行时生成的工具 ID。平台合并请求还提供了使请求可执行的命名权限和计划。

该样本故意支持一种命名约定和所有四种工具。显式派生名称使审查者能够在不记住该约定的情况下查看请求的形状；入职验证器检查它们是否一致。声明不是通用的供应 API，更改名称可能会改变外部工具中的身份或凭证行为。

声明是一个示例架构，而不是 ACP API。管道验证其支持的命名约定。完整的 `shop` 声明包括以下字段；使用样本的完整文件：

```yaml
name: shop
platformProject: shop
owners:
  - shop-platform-owners
environments: [test, prod]
tools: [gitlab, harbor, nexus, sonarqube]
approvers:
  prod: group:release-managers
imagePullFrom: []
namespaces:
  workloads: [shop, shop-test, shop-prod]
  build: shop-build
  delivery: shop-cd
gitlab:
  group: shop
  subgroups: [apps, gitops]
harbor:
  projects: [shop, shop-prod]
nexus:
  repositories:
    - name: shop-maven
      format: maven2
      type: hosted
    - name: shop-npm
      format: npm
      type: hosted
sonarqube:
  project: shop
```

`owners` 包含没有 `group:` 前缀的 ACP 组资源名称；审批条目使用 `group:<resource-name>`。控制台显示名称不是资源名称。当需要固定组名称时，请将该组作为经过审核的 `auth.alauda.io/v1` `Group` 对象创建，并通过 ACP 组管理导入其用户成员；不要在每个声明中放置单个用户名。以下示例使用 ACP 的本地身份源。显示名称注释和身份源引用都是必需的；对于由其他身份提供者管理的组，请使用适当的引用。

```yaml
apiVersion: auth.alauda.io/v1
kind: Group
metadata:
  name: shop-platform-owners
  annotations:
    cpaas.io/display-name: Shop platform owners
spec:
  refConnector:
    id: local
    type: local
  users: []
```

组存在后，在控制台中添加已批准的成员，并通过 `kubectl get groups.auth.alauda.io` 验证资源名称。组成员资格的更改属于组管理，而不是在每个声明中编辑个人名称。

`imagePullFrom` 是保留字段：该示例仅在设置时打印警告，并不授予跨项目拉取访问权限。

声明的 `approvers` 字段仅是经过审核的记录：入职验证其形状，但不应用或比较它。生效的审批者是提升管道的 `ApprovalTask` 列表和生产 `AccessPolicy`；没有任何东西可以保持这三个来源的同步，因此请在一次审核更改中一起更新它们。将生产 `AccessPolicy` 保持在平台管理员控制之下，因为可以编辑管道的人可以在 AccessPolicy 继续执行其自己的审批者集的同时更改其 `ApprovalTask` 列表。签名结果记录配置的密钥，而不是生成图像的管道，且 Chains 不会为包含 `CustomRun` 任务的 `PipelineRun` 创建运行级签名；请在发布证据中保持该限制。

### 审查项目合并请求中的所有输入

包括声明、其 `configMapGenerator` 条目、项目的命名入职权限、其 ScheduledTrigger 和 Kustomize 条目，以及其生产图像验证存储库条目。这些内容是一起的，因为仅凭声明无法授予入职身份管理新的生产连接器或扩展验证策略。

每个项目的权限文件是故意的：它们将发布连接器的写入限制在列出的名称内。从任何声明生成任意 RoleBindings 将需要更广泛的 `bind` 或 `escalate` 权限。在用更多自动化替换显式文件之前，请审查该安全成本。单独地，将新的注册表项目添加到平台拥有的中央 Chains 凭证的访问权限中。

通过平台合并请求提交声明、项目特定的入职权限和计划。确认声明和入职原生应用已同步；在使用手动同步策略时手动同步它们。然后检查调度结果和每个子入职运行。成功的合并或调度本身并不建立完整的项目准备。

合并检查并不替代入职验证。声明的结构和派生名称由合并后的入职运行检查，因此语法上有效但语义上无效的声明仍然可以合并，并且必须从该运行的结果中诊断。

样本在合并后调度更改的声明。路径过滤器也可以允许没有相关声明更改的运行；调度程序负责选择实际声明。已删除的声明被跳过，而不是被解释为删除项目的指令。

### 理解七个入职阶段

在这些阶段之前，管道原子地获取项目的 ConfigMap 锁。然后在更改租户资源之前验证声明。在其他检查中，样本要求四个支持的工具、组形状的审批者、匹配的派生名称和不在平台保留名称之外的命名空间。它拒绝采用另一个项目的命名空间。例外是与 ACP 项目一起创建的同名内部命名空间，入职明确标记并采用。

这七个阶段描述了责任；在命名空间准备好后，几个工具任务并行运行，注册步骤开始自己的子运行。

| 阶段 | 工作                                                                                                                                                                                               | 所有者或机制                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1     | 导出现有的 ACP 项目而不带运行时元数据；创建或协调标记的命名空间和交付身份。工作负载使用受限的 Pod 安全；构建命名空间是分开的。 | 样本编排和 Kubernetes API    |
| 2     | 创建 GitLab 租户组和两个组访问令牌：用于项目操作的开发者令牌和用于 GitOps 交付的单独维护者令牌。                                          | GitLab 自动创建任务              |
| 3     | 创建私有源和生产 Harbor 项目，分发图像拉取配置，并为发布创建单独的源读取和生产写入连接器。                            | Harbor 自动创建任务              |
| 4     | 创建 Nexus 存储库和一个范围用户，然后写入项目连接器。                                                                                                                     | Nexus 自动创建任务               |
| 5     | 创建 SonarQube 用户、令牌和项目权限模板，然后写入连接器。                                                                                                       | SonarQube 自动创建任务           |
| 6     | 种子空项目 GitOps 存储库并创建其 PaC 存储库和访问密钥。单独完成并验证 webhook 配置。                                                    | 样本模板播种和 PaC 资源   |
| 7     | 渲染项目应用程序、AppProject 补丁、拥有者和连接器绑定，以及导出的 ACP 项目。打开平台注册合并请求。                                             | 单独的 `gitops-repo-update` PipelineRun |

第一个和最后一个阶段是样本编排。四个外部工具使用产品自动创建任务，而存储库播种仅复制一次经过审核的模板。这种分离将工具特定的帐户和轮换行为保留在产品任务中，并将排序和注册保留在样本管道中。

导出的 ACP 项目省略状态、服务器生成的元数据和 GitOps 跟踪标记。将运行时跟踪保持在 Git 之外，避免仅用于复制先前同步的元数据的注册合并请求。在工具任务需要它们之前，命名空间和交付身份已创建。构建命名空间使用 Pod 安全 `baseline`；工作负载和交付命名空间使用更严格的 `restricted` 级别。在应用命名空间标签时保持这种区别。

Harbor 拉取配置分发到工作负载和构建命名空间。样本交付命名空间运行工具图像，并且不接收该项目拉取密钥。项目的四个连接器位于项目命名空间中；GitOps 写入者位于交付中；生产发布连接器位于管理中。检查每个凭证实际持有的权限，而不是从名称如“pull”或“readonly”推断它们。

入职创建项目的 GitLab 组，但不向其中添加人员。在移交之前，平台管理员必须根据平台的访问政策将项目的开发人员添加到该组，并授予他们在该组中创建存储库的角色。

注册步骤建议 Git 更改，而不是直接应用 Argo CD 资源。审查整个差异，包括 RBAC 和目标更改。提交一个平台合并请求，添加声明、其 `configMapGenerator` 条目在 `projects/kustomization.yaml` 中、项目的 release-Connector 角色和 RoleBinding 以及 ScheduledTrigger 文件，以及它们在 `onboarding/kustomization.yaml` 中的条目，以及项目在图像验证策略中的生产存储库。没有 `configMapGenerator` 条目，调度程序将等待项目的 ConfigMap，然后跳过该项目。没有 release-Connector RBAC 条目，调度程序无法确认子运行的连接器先决条件存在。为父运行和子运行保留足够的执行容量：等待的父运行仍然保留其 Pod 资源。取消和清理必须考虑独立创建的子运行。

管道在管理命名空间中运行，使用管理员连接器。创建 Pods 或 PipelineRuns 的权限实际上是对这些凭证的访问，即使没有 API 权限读取 Secrets。将该命名空间和入职身份限制为平台自动化和管理员。

<span id="reuse-the-product-tasks"></span>

### 重用产品任务

为每个工具的租户资源、帐户、令牌和连接器输出使用产品任务。样本添加了声明解析、命名空间所有权、排序、锁定、播种和平台注册。在入职脚本中重新实现四个工具的帐户逻辑将重复它们的合同和轮换行为。

这四个任务具有不同的参数和轮换行为。阅读它们的安装、访问和先决条件说明：

- [GitLab 租户组和连接器](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors-gitlab/how_to/using_gitlab_connector_automatic_creation_task.html)。
- [Harbor 资源和连接器](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors-harbor/how_to/using_harbor_connector_automatic_creation_task.html)。
- [Nexus 资源和连接器](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors-nexus/how_to/using_nexus_connector_automatic_creation_task.html)。
- [SonarQube 租户和连接器](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors-sonarqube/how_to/using_sonarqube_connector_automatic_creation_task.html)。

将目标 `connector` 设置为 `namespace/name`。明确设置 GitLab 访问级别：样本中的两个令牌都是组访问令牌，开发者用于项目操作，维护者用于 GitOps 写入。开发者令牌具有 `api`，因此缺少 `write_repository` 不会阻止基于 API 的存储库更改，而 `main` 是未受保护的；在将 `main` 保护之前，请先保护它。连接器 CSI 挂载使用 `connectors` 属性，并包含命名空间。

样本仅使用显式授权的 ServiceAccount 写入当前集群。对于跨集群应用，请遵循每个任务的 Kubernetes 连接器和 `kubeconfig` 工作区说明。不要假设管理命名空间的默认 ServiceAccount 具有所需的写入权限。

选择当前集群的 ServiceAccount 避免分发另一个管理员 kubeconfig，但代价是每个所需写入的显式 RBAC。使用 `generateName` 提交的 TaskRun 或 PipelineRun 使用 `kubectl create`。在运行它们的命名空间中安装任务，并在提交之前检查运行身份；未指定的默认 ServiceAccount 不是隐式管理员。

替代产品工作流从命名空间事件创建项目连接器：[自动为项目创建连接器](https://docs.alauda.io/alauda-devops-connectors/1.14/how_to/automatically_create_connectors_for_a_project.html)。如果选择该路径，请为每个租户和资源分配一个创建者和轮换所有者。避免两个独立的调解器管理相同的凭证。

## 注册存储库并验证事件

在每个 PaC 存储库上设置自管理提供程序 URL 和经过审核的定义源。以下片段省略凭证数据；通过批准的凭证路径创建其引用的 Secret：

```yaml
apiVersion: pipelinesascode.tekton.dev/v1alpha1
kind: Repository
metadata:
  name: shop-gitops
  namespace: shop
spec:
  url: https://git.example.com/shop/gitops/config
  git_provider:
    type: gitlab
    url: https://git.example.com
    secret:
      name: shop-gitops-auth
    webhook_secret:
      name: shop-gitops-auth
  settings:
    pipelinerun_provenance: default_branch
```

明确设置提供程序 URL，以便完成请求和存储库令牌使用预期的 GitLab 实例。PaC 存储库 URL 与 Argo CD 使用的 `.git` URL 不同。`gitops/config` 是位于 `gitops` 子组下的存储库，而不是与该子组名称冲突的存储库路径。

项目的 PaC 存储库使用开发者级别的组访问令牌。当启用自动 webhook 注册时，控制器使用平台管理员配置的集中式 webhook 注册凭证来创建和删除 webhook；验证新事件及其结果运行。单独的 GitOps 写入者使用维护者级别的组访问令牌。在存储库退役后，保持 webhook 注册凭证可用，并在之后检查剩余的代码平台 webhook。应用程序的存储库属于构建命名空间，在那里 CI 执行。应用程序 CI 对象属于构建命名空间；CD 和提升运行模板及 PipelineRuns 属于交付命名空间，并需要管理员或明确的委托授权。

如果省略 `git_provider.url`，PaC 可以将完成评论发送到公共的 `gitlab.com` 提供程序，而不是自管理的 GitLab 实例，因此预期的合并请求可能永远不会显示最终状态。始终为自管理安装设置提供程序 URL，并验证预期合并请求上的评论。

### 将平台参数与应用输入分开

入职流程将平台提供的值（例如注册表地址和连接器名称）写入生成的存储库的 `spec.params` 中。PaC 定义可以消费这些值，而应用程序提供自己的源修订和构建输入。这使得平台拥有的地址有明确的所有者，并避免在每个消费存储库参数的定义中重复它。

该参数层不会重写所有现有配置。注册表和 Git 地址也出现在播种的 GitOps 内容、应用程序 CI/CD、提升映射、Argo CD 引用和验证策略中。地址迁移必须通过其自己的审核更改更新这些消费者。重新运行入职将保持非空的 GitOps 存储库不变。

存储库访问和 webhook 管理也具有不同的生命周期。PaC 从存储库访问令牌生成每次运行的克隆凭证；即使运行没有接收 webhook 管理员令牌，这些凭证仍然是敏感的。单独测试注册、交付新事件、预期运行命名空间和完成状态。

<span id="reconcile-and-rotate-deliberately"></span>

## 深思熟虑地调解和轮换

### 区分调解与模板升级

重复入职对于支持的声明更改、计划工具调解和在先决条件恢复后重建声明配置是有用的。它不是外部状态的全面回滚。任务可以在其他幂等资源操作中轮换或重新创建凭证。

使用相同支持参数的重复运行进行调解。不要将连接器 `Ready=True` 等同于未过期的可用工具令牌；在轮换之前和之后执行授权工具请求或工作负载操作。

| 更改                                | 所需操作                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 支持的声明字段更改 | 审查特定任务的重新创建和轮换效果，然后调解项目。                                 |
| 添加新环境            | 通过项目合并请求添加其 GitOps 目录和验证路径，并更改声明。 |
| 模板更改                    | 分别建议更新现有项目存储库。播种仅复制到空存储库。        |
| 凭证到期需要轮换      | 在到期减去安全边际的时间表上运行相关任务；在失败时发出警报并重试。        |
| 凭证没有到期            | 按政策要求的间隔进行轮换；明确选择任务的刷新行为。                         |

样本支持的 GitLab 子组是 `apps` 和 `gitops`。更改该约定需要审核的管道更改，而不仅仅是声明编辑。工具侧身份更改可以重新创建帐户或凭证；在更改名称或项目集之前，请检查产品任务的合同。

例如，添加 `staging` 需要审核的声明更改和项目 GitOps 更改，以提供 `envs/staging` 及其验证路径。注册输出可以指向真实目录。仅更新声明可能会创建无法渲染的应用程序。类似地，更改种子模板是对现有项目的升级提案，而不是覆盖其存储库的理由。

注册是从经过审核的模板重新生成的。没有注册差异的重新运行不应创建另一个合并请求。检查生成的 Git 更改或没有更改；仅通用更新步骤结果并不能证明需要注册或已合并。

### 序列化租户更改并恢复保留锁

不要重叠同一租户的运行。这三个示例入口点——计划调解、合并调度和手动运行模板——使用相同的入职管道。它的第一个任务在任何租户更改之前原子地创建每个项目的 ConfigMap 锁；竞争运行失败。成功运行在最后一个任务中释放自己的锁。失败、取消或中断清理可能会将锁保留在原地。检查其记录的 PipelineRun 和任何独立启动的子运行，确认所有工作已停止，然后在重试之前移除锁。绝不要仅仅因为运行时间超过预期就清除锁。

锁释放与拥有运行的 UID 相关联，因此竞争运行无法清理另一个运行的锁。没有基于超时的接管：慢速外部 API 或独立注册子运行在父运行看起来停滞后仍然可以工作。记录所有者，停止并检查所有相关运行，然后再移除保留的锁。重试使用相同的管道，必须再次获取该锁。

### 在凭证到期之前规划轮换

在活动管道窗口之外安排轮换，并在当前凭证到期之前监控失败的运行。CSI 工作负载令牌的发放与轮换工具的长期凭证是分开的。咨询任务指南以获取到期恢复；定义本地恢复程序，而不是依赖未观察到的自然到期路径。

如果启用连接器审批，请为每个受影响的工作负载准备授权，启用 `enable-connectors-approval`，立即创建所需的 AccessPolicies，然后启用 `enable-connector-proxy-permissions`。样本的可选管理员 AccessPolicy 不包括在默认 Kustomization 中，仅在启用该功能后应用。使用 RBAC 进行文档化的跨命名空间授权，并保持审批门控的生产连接器不直接授予代理权限。有关完整的推出边界，请参见 [交付文章](./From_Commit_to_Production_on_ACP.md#gate-the-production-connector-after-approval)。

## 理解六个项目边界

入职创建可以建立隔离的资源。验证有效权限以及资源：单独的帐户仍然可以具有广泛的角色，项目标签并不限制每个写入者。

| 边界                   | 结果和剩余条件                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 命名空间和 Pod 安全 | 工作负载、构建和交付具有不同的命名空间和安全级别。样本所有者绑定仅在项目命名空间中授予 `admin`。                                                                |
| 部署授权   | 有效的 AppProject 目标限制位置；平台入境边界限制由实际 Argo CD 身份写入的敏感类型。直接 Kubernetes 写入者仍然需要 RBAC 限制。 |
| 管道路由           | 存储库和触发器将事件路由到预期项目。定义源和直接运行策略仅在安装和强制执行的地方限制执行。                                                   |
| 外部工具租赁      | GitLab 组、私有 Harbor 项目、Nexus 存储库/用户和 SonarQube 权限按项目范围。验证实例范围的匿名和可见性设置作为先决条件。                         |
| 凭证访问          | 项目用户无法在管理员或签名命名空间中创建工作负载。代理授权、原始 Secret 访问、PaC 凭证和 Chains 凭证分别进行审核。                                    |
| 执行历史          | 实时清理和命名空间覆盖与保留的外部结果记录共存。审批响应具有单独的保留路径。                                                                         |

该示例中的生产发布凭证可以读取暂存项目并写入生产，因为复制任务对两个端点使用目标代理配置。名为 source-readonly 的挂载提供源 CA；它不建立单独的身份验证路径。Chains 使用其平台拥有的中央注册凭证进行提升签名；不要给 `shop-release` 身份匹配的生产注册凭证，否则 Chains 将优先选择该凭证，发布身份将获得直接写入路径。交付文章解释了这种特定于复制的行为及其审批边界。

当启用提升入境时，使用管道的 `imageMappings` 输入进行每个源到发布的映射。入境规则识别该映射形式；单独提供的存储库或标签参数不是替代品。验证每个摘要的构建来源，然后再批准提升。

跨项目拉取访问需要单独审核的授权。声明的保留 `imagePullFrom` 字段在样本中仅发出警告；它不会创建 Harbor 权限或分发新的拉取凭证。保持项目私有，并在将省略的授权视为隔离之前演示拒绝。

### 检查六个角色与实际授权的对比

以下矩阵总结了六个角色以及此参考提供或要求的授权。Kubernetes 授权是累加的：缺失的样本绑定不会撤销从 ACP 或其他角色继承的权限。Git 权限和生产保护必须在 GitLab 中单独配置。

| 角色                                  | 平台存储库         | 项目声明   | 项目命名空间                   | 交付命名空间                                 | GitOps `envs/prod`                              | 生产                                    | 连接器                                                          |
| ------------------------------------- | --------------------- | --------------------- | ----------------------------------- | -------------------------------------------------- | ----------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| 平台管理员                | 写入，先决条件   | 写入，先决条件   | 管理员，先决条件         | 应用定义并启动运行                   | 单独配置保护                 | 管理员，先决条件                   | 管理员连接器                                            |
| 应用程序开发人员 / 项目所有者 | 未提供 Git 授权 | 未提供 Git 授权 | 在 `shop` 中获得 `admin` 的所有者组 | 无样本绑定                                  | 未提供 Git 授权                           | 未提供工作负载绑定                  | 可以通过 Pods 读取项目 Secrets 并使用凭证 `shop` |
| 发布审批者                      | 未提供授权     | 未提供授权     | 未提供绑定                 | ApprovalTask 响应；可选控制台读取角色  | 未提供 Git 审查角色                     | 未提供工作负载绑定                  | 未提供挂载授权                                             |
| CI ServiceAccount                     | 未提供访问    | 未提供访问    | 在 `shop-build` 中运行                | 未提供绑定                                | 未提供写入者                              | 未提供工作负载绑定                  | 项目 Harbor、SonarQube、Nexus 的挂载/代理授权             |
| 交付 ServiceAccount               | 未提供访问    | 未提供访问    | 未提供绑定                 | 执行 CD；未提供运行创建授权        | 通过写入连接器的维护者组令牌 | 更改 Git 引用，由 Argo CD 调解 | GitOps 写入者挂载/代理授权                                     |
| 提升 ServiceAccount              | 未提供访问    | 未提供访问    | 未提供绑定                 | 执行提升；未提供运行创建授权 | 未提供写入者                              | 通过连接器写入生产注册表  | 挂载两个注册连接器；仅对源的直接代理授权  |

发布审批者并不自动成为 Git 代码所有者。如果需要两个审批，请单独配置 Git 审查角色。提供的维护者写入者可以更改 GitLab 保护设置；生产部署需要单独保护的分支或存储库以及更窄的写入者身份。在将交付命名空间的运行创建委托给项目所有者之前，验证实际用户和 ServiceAccounts 的有效权限。

名称范围连接器 `get` 授权记录此工作流所需的挂载；它们不会删除 ACP 在项目内的更广泛默认连接器读取。特定于身份的代理限制需要 [交付文章](./From_Commit_to_Production_on_ACP.md#gate-the-production-connector-after-approval) 中描述的代理权限功能和授权。在审查此矩阵时，保持读取授权、代理授权和对原始 Secrets 的访问之间的区别。`defaultPermission` 策略仅选择在连接器上具有命名空间范围 `get` 的身份；名称范围的 `get` 不符合资格，其他身份在策略仍然可以报告 `Ready` 的同时被静默跳过。

保持 CI、GitOps 交付和工件提升身份分开。具有执行凭证的运行时 ServiceAccount 并不意味着它可以创建自己的 PipelineRuns。同样，作为应用程序存储库维护者并不在构建或交付命名空间中建立 Kubernetes 授权。在将运行模板委托给项目所有者之前，检查两侧。

可选的 ACP 控制台审批者角色提供了查找审批工作所需的读取访问，而不授予运行创建或 Secret 读取权限。它不会分配 Git 代码所有者角色，也不能证明审批者不能通过其他继承权限启动发布。审查实际组成员资格和有效权限，并保持发布发起者和审批者分开。

<span id="accept-the-project-boundaries"></span>

## 接受项目边界

### 在移交之前检查每个入职结果

| 边界                    | 必须证明的内容                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命名空间和 Pod 安全 | 工作负载命名空间具有预期的标签；构建和交付使用它们各自的命名空间和身份。                                                                     |
| 部署范围            | 有效的 AppProject 目标和平台入境仅允许预期的项目部署路径。使用实际的 Argo CD 身份测试禁止的 RBAC 和配额写入。 |
| 工具访问                 | GitLab、Harbor、Nexus 和 SonarQube 授权与租户匹配。在进行负面跨项目测试之前使用正面控制。                                                   |
| 凭证访问           | 项目用户无法在管理员或签名命名空间中创建 Pods 或运行。分别清点图像拉取 Secrets、PaC 克隆凭证和中央 Chains 凭证。    |
| 事件路由               | 新的存储库事件或合并请求重试在预期命名空间中产生预期的运行。                                                                                |
| 轮换                    | 成功的非重叠运行更新预期的凭证，并且授权操作在之后有效。                                                                       |

从样本中在隔离的接受项目中运行 `acceptance/02-platform-and-onboarding.sh`。其伴随的交付脚本在第一次提升的生产部署后验证图像路径。接受脚本不检查入职运行：阅读调度程序的 `onboarding-runs` 结果，确认它为每个应入职的项目命名运行，并确认每个子运行的状态为 `Succeeded=True`。检查四个连接器、播种的存储库、注册合并请求和应用程序。初始占位符摘要不可部署；工作负载健康状态在第一次真实部署后跟随。平台 `projects` 应用程序可以在此设计中保持 `OutOfSync` 状态，以便于平台管理的字段；检查有效的目标和策略，而不是仅将该状态视为失败。当启用 `no-bare-taskrun.yaml` 时，创建一个一次性直接 TaskRun 作为项目身份，并确认 `Audit` 允许它通过 PolicyReport，而 `Enforce` 拒绝它；删除探测并保留报告作为证据。

对于跨项目图像拒绝，首先验证确切的图像存在并可以在其自己的项目中拉取。然后测试未经授权的项目，区分 `unauthorized` 与 `not found` 和 Pod 安全拒绝，并使用存在于另一方向的图像重复测试。检查后删除临时探测资源。

仅在接受项目中的一次性资源上测试自愈。入职呈现一个专用的 `<project>-self-healing-probe` RoleBinding，没有主体，因此删除它不会移除任何人的访问权限。在运行检查之前合并并同步其注册；现有项目需要注册更新以获取它。该脚本要求其接受探测标签，并拒绝带有主体的绑定。它保存 UID 和恢复清单，删除探测，并要求 GitOps 使用不同的 UID 重新创建它；回退恢复被报告为失败。这与证明操作管理组件层的持续自动调解是分开的。

### 知道哪些输出应该存在

在审查和合并注册后，预期的输出是：

| 位置                        | 预期输出                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 平台 Git                    | 每个项目一份声明、其注册的 Kustomize 条目和经过审核的项目注册文件。                        |
| Argo CD                         | 根和层应用程序、入职应用程序，以及每个项目环境的一个应用程序。                              |
| GitLab                          | 项目组、`apps` 和 `gitops` 子组、两个组访问令牌，以及播种的 `gitops/config` 存储库。              |
| Harbor                          | 私有源和生产项目、一个项目机器人和两个发布路径机器人，以及所需的拉取配置。 |
| Nexus                           | 声明的存储库及其范围用户。                                                                               |
| SonarQube                       | 一个用户、令牌和项目权限模板；第一次扫描创建应用程序项目。                                |
| 项目 Kubernetes 资源    | 带标签的命名空间、交付身份、四个项目连接器、PaC 注册和经过审核的所有者/挂载绑定。        |
| 管理 Kubernetes 资源 | 管理员和项目发布连接器、命名入职授权和调解计划。                        |

不要求每个应用程序立即报告相同的状态。
占位符工作负载摘要不是可运行的图像；环境健康在第一次真实部署后跟随。`projects` AppProject 补丁可以保持 OutOfSync，因为 ACP 也维护字段。组件层的持续自愈在所有权验证之前被禁用。读取有效对象、修订、策略决策和工作负载状态，以对应每个接受声明。

项目准备意味着其子入职运行成功，注册经过审核和同步，工具访问在预期租户内有效，新存储库事件到达正确的定义，并且禁止访问因预期原因被拒绝。交付准备还需要交付文章中描述的第一次真实构建和发布。成功的调度程序或四个准备好的连接器单独并不满足这些条件。

<span id="preserve-audit-records-and-plan-recovery"></span>

## 保留审计记录并规划恢复

### 选择清理和归档作为一个操作决策

选择一种清理机制，并在启用之前审查其范围。根据全局和命名空间配置指南使用基于事件的 Pruner；在迁移时禁用较旧的定期机制。在目标环境中验证每种选择的保留模式，以便在其可以删除共享运行历史记录之前。

全局值在第一次同步后适用于整个集群，包括其他租户的命名空间，除非应用命名空间覆盖，并且成功和失败的运行按命名空间分别计算。在共享集群上，在启用清理之前计算每个命名空间的完成 PipelineRuns 和独立 TaskRuns，选择高于最高计数的限制或与租户达成较低限制，并首先通知所有者。

使用外部 PostgreSQL 和文档记录的日志存储来存储结果。定义观察范围、身份验证和一个保留策略以供参考配置。通过结果 API 验证读取授权，而不是从 Kubernetes 资源可见性推断。清理之前单独保留审批响应，以免删除 ApprovalTask 对象。

在启用结果观察者之前确定范围：默认观察可能会影响跨命名空间的完成运行，并添加 `results.tekton.dev/*` 最终处理程序。禁用归档不会删除已经存在的最终处理程序。在删除之前遵循产品恢复程序，并在集群对象被修剪后将外部结果存储视为审计源。请参见 [S3 存储](https://docs.alauda.io/alauda-devops-pipelines/4.15/results/configure/s3_storage_configuration.html) 和 [结果保留](https://docs.alauda.io/alauda-devops-pipelines/4.15/results/configure/retention_policy_configuration.html)。

### 在重放配置之前恢复先决条件

Git 不会替换凭证和外部数据的备份。在平台重建之前，平台团队必须准备和排练恢复这些依赖项：

1. 兼容的平台组件、Kyverno 和密封的 secrets CRD 和控制器。
2. 密封的 secrets 解密密钥，或新控制器的重新密封凭证。
3. Chains 签名密钥和中央注册凭证；与图像入境协调任何验证密钥更改。
4. 管理命名空间和已安装的自动创建任务。
5. Argo CD 存储库访问和项目存储库凭证模板，以及 PaC 访问和 webhook 配置。

对于签名密钥轮换，首先在 `require-signed-images` 中配置一个 attestor，`count: 1`，并为旧的和新的公钥分别设置 `entries`。确认旧签名的图像仍然被接受，然后通过其支持的管理工作流替换签名者并验证新签名。在每个旧签名的图像（包括回滚版本）被退役之前，保留旧条目；在单独的审核更改中删除它。在替换之前检查签名 Secret 的不可变性、所有者和安装方法。

在准备好这些依赖项后，同步平台层，运行入职以声明的项目，审查注册更改，并完成接受检查。这是依赖项大纲；完整的空集群或第二集群恢复运行手册必须在目标环境中进行演练。

在重建过程中，注册对象可能在所有项目命名空间存在之前就存在。允许声明在命名空间依赖绑定之前同步，以便入职可以读取它们；不要将声明 ConfigMaps 放在被这些绑定阻塞的后续同步波中。检查失败的对象和重试，而不是将暂时不完整的层视为入职无法继续的证明。该依赖序列需要自己的恢复接受。

### 深思熟虑地调整和操作平台

替换工具地址、管理命名空间、项目/组命名约定、环境列表、Argo CD 集群名称、两个边界策略身份、签名公钥、加密凭证、本地图像、令牌生命周期和轮换间隔。验证每个目标集群边界在调整身份后。地址迁移还需要对已播种的存储库以及策略和提升输入进行更改；存储库参数只是该操作的一部分。

在生产之前，完成样本的加固工作：将合并前验证与管理员凭证隔离，缩小用于项目注册的 AppProject，保护 GitOps 写入者的命名空间，安装提升核心规则，并限制生产图像源。限制直接集群写入，同时进行 Git 审查。模板升级、退役、容量规划、离线包分发和客户变更管理集成需要单独的操作程序。

继续阅读 [从提交到生产](./From_Commit_to_Production_on_ACP.md) 以使用入职项目的构建、测试、提升和生产 GitOps 路径。
