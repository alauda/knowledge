---
products:
  - Alauda Container Platform
  - Alauda DevOps
kind:
  - Article
ProductsVersion:
  - 4.x
id: KB261000020
sourceSHA: 8cdf0c0809912524e67d79728e85bedcb3ec2f8988c5d466f6ef107d2a376ab5
---

# Alauda DevOps 最佳实践：概述和场景指南

本系列帮助应用程序和平台团队将 Alauda DevOps 功能结合到交付工作流中。从一个可工作的管道开始，将构建输出连接到受控发布，然后为多个隔离项目标准化平台。

配置基线为 Alauda DevOps Pipelines 4.15、Artifact Hub Shim 1.0、Connectors 1.14 和 Alauda Container Platform GitOps 4.4，适用于兼容的 ACP 安装。在选择软件包时，请使用每个组件的兼容性要求。示例使用 GitLab、Harbor、Nexus 和 SonarQube。它们描述了一个参考实现，生产使用前需要环境准备和验收检查。

该系列有三个入口点：

| 您的起点                                                                         | 接下来阅读                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 您需要一个用于一个代码库的构建或测试管道。                                      | [开始一个管道](#start-a-pipeline) 在下方。                                                                                                                              |
| 一个管道已经在运行；您需要从提交到生产的可追溯路径。                            | [从提交到生产在 ACP](./From_Commit_to_Production_on_ACP.md)。                                                                                                         |
| 您操作一个共享平台，需要可重复的配置和项目入驻。                                | [管理平台配置和入驻隔离项目](./Managing_Platform_Configuration_and_Onboarding_Isolated_Projects_with_Argo_CD_and_Tekton_on_ACP.md)。 |

[伴随示例](https://github.com/AlaudaDevops/devops-best-practices-samples) 包含平台代码库、项目声明、入驻管道、GitOps 代码库模板、应用程序交付示例和验收脚本。在使用之前，请替换示例地址、镜像引用、身份和加密凭证占位符。

## 整体设计

交付层将一个更改从源移动到不可变镜像，然后到环境。平台层提供可重用的定义、工具访问、命名空间和操作设置。控制层决定什么可以运行，谁批准发布，以及必须保留什么证据。

```mermaid
flowchart TB
  subgraph Controls[控制层]
    Policy[管道和镜像准入]
    Approval[发布批准]
    Audit[运行和日志保留]
  end
  subgraph Delivery[交付层]
    Source[源代码库] --> Trigger[PaC 或触发器]
    Trigger --> Build[构建和扫描]
    Build --> Image[由摘要标识的镜像]
    Image --> Test[测试部署]
    Test --> Promote[提升所选摘要]
    Promote --> Production[生产 GitOps 更改]
  end
  subgraph Platform[平台层]
    Catalog[版本化目录管道和任务]
    Connectors[项目和管理员连接器]
    Git[平台配置和项目声明]
  end
  Policy -.-> Trigger
  Policy -.-> Production
  Approval -.-> Promote
  Audit -.-> Build
  Catalog -.-> Build
  Connectors -.-> Build
  Git -.-> Connectors
```

应用程序开发人员负责源代码和应用程序交付配置。平台管理员负责共享组件、准入规则、管理员凭证和入驻。发布批准者在检查其构建和测试证据后授权所选摘要。将发布身份与构建身份分开。

## 开始一个管道

选择满足团队需求的最简单定义模型。这些模型可以共存。

| 模型                      | 定义和触发                                                                                                                                                          | 使用场景                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 集群中的管道              | 在项目命名空间中创建一个管道。将参数、工作区和集成保存在运行模板中。手动启动、通过触发器或按计划启动。                                                            | 少量管道需要简单的执行入口。                                                |
| 作为代码的管道 (PaC)      | 将 PipelineRun 定义保存在应用程序的 `.tekton/` 目录中。代码事件启动运行并将结果报告到合并请求中。                                                                  | 定义应随源代码演变并参与合并请求检查。                                     |
| 中央管理模板              | 在目录中维护一个版本化的管道，或在受控命名空间中维护一个管道。项目通过运行模板或使用解析器的 PaC PipelineRun 提供参数。                                          | 多个项目应共享相同的标准工作流。                                            |

对于 PaC 重试，在合并请求中使用 `/test <pipelinerun-name>`，并参考 [触发 PaC 管道](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/trigger_pipeline.html) 获取完整语法。每个事件使用一个事件路由：PaC 或触发器。为同一事件启用两个路由可能会启动重复工作。

从 [运行模板](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/run_template.html)、[配置 GitLab 仓库](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/guides/configure_gitlab_repo.html) 或 [通过 Hub 管道和运行模板进行集中管理](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/hub_pipeline_run_template_centralized_management.html) 开始。[应用程序 CI/CD 教程](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/tutorials/index.html) 提供了指导实施。

## 连接交付阶段

| 需求                             | 推荐组合                                                                                                               | 详细指导                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 构建可追溯的工件                 | 重用目录任务，扫描输出，并将其摘要传递给后续阶段。                                                                    | [从提交到生产](./From_Commit_to_Production_on_ACP.md)。                                                                                     |
| 部署到开发或测试环境             | 当环境状态的 Git 历史不必要时，直接按摘要更新工作负载。                                                                | [应用程序 CI/CD 教程](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/tutorials/index.html)。                                      |
| 部署到生产                       | 审查对生产 GitOps 仓库的更改；Argo CD 会协调所选摘要。                                                                | [Alauda Container Platform GitOps](https://docs.alauda.io/gitops/4.4/)。                                                                                 |
| 分离生产工件访问                 | 批准并将所选镜像按摘要复制到生产注册项目中。                                                                          | [使用 Skopeo 复制提升工件](https://docs.alauda.io/alauda-devops-artifacthub-shim/1.0/catalog/how_to/promote_artifacts_with_skopeo_copy.html)。 |
| 记录谁批准了发布                 | 添加 ApprovalTask，使用组资源名称，并保留其批准响应。                                                               | [手动批准门](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/manual_approval_gate.html)。                                 |
| 验证镜像签名                     | 中央配置 Chains 密钥和注册访问；在提升和部署准入前按摘要验证镜像。                                                    | [签名密钥配置](https://docs.alauda.io/alauda-devops-pipelines/4.15/chains/configure/signing_key_configuration.html)。                       |
| 移交工件事件                     | 将 Harbor 事件映射到下一个管道，携带摘要。分别检查扫描和签名证据。                                                    | [使用 Harbor 事件触发器](https://docs.alauda.io/alauda-devops-pipelines/4.15/triggers/how_to/harbor_events.html)。                                    |

提升操作复制所选镜像；它并不表明该镜像通过了 CI。批准者必须将摘要与成功的受信构建和测试环境进行匹配。签名建立了配置签名者的声明；其意义还取决于对签名密钥的控制和允许运行的定义。

示例故意将测试 CD、提升和生产 CD 保持为手动启动的运行。它们的输入来自前一个运行的摘要结果。由 Harbor 驱动的自动化是一个单独的集成步骤。发布教程的第一次部署由管理员执行；后续发布遵循配置的交付路径。

## 准备共享平台

平台设置是管理员的决策。分阶段推出，并检查所选发布的 [功能成熟度](https://docs.alauda.io/alauda-devops-pipelines/4.15/overview/feature_maturity.html)。

| 平台关注点                     | 推荐方法                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具访问                       | 使用项目范围的连接器。代理访问使用短期工作负载令牌。将镜像拉取凭证、PaC 克隆凭证和 Chains 注册凭证作为单独的长期凭证责任进行管理。                                                                 |
| 项目入驻                       | 协调四个连接器自动创建任务，然后为项目 GitOps 仓库提供种子，并通过合并请求提出平台注册。完成管理员的前提条件和验收检查。                                                                 |
| 平台配置                       | 将组件设置、策略、加密管理员凭证和项目声明保存在平台代码库中。为每个资源或字段分配一个所有者。                                                                                                   |
| 命名空间隔离                   | 使用单独的项目命名空间和工具侧租户。分离构建、交付和工作负载命名空间，并限制对管理员命名空间的访问。                                                                                           |
| 执行策略                       | 使用平台 ClusterPolicies 和项目 Policies。限制直接创建 TaskRun 和 CustomRun。可选地要求批准的解析器类型和坐标。在检查预期工作流后，从审计转移到强制执行。                                           |
| 清理                           | 选择一种清理机制。对于基于事件的 Pruner，在启用删除之前检查全局默认值和命名空间覆盖设置。                                                                                                         |
| 审计历史                       | 将运行记录和日志存储在外部结果存储中，并设定明确的保留期。在删除对象之前单独导出批准证据。                                                                                                         |
| 定期工作                       | 使用 ScheduledTrigger 或 CronJob 进行协调和轮换，设置故障警报，并确保租户没有重叠运行。                                                                                                           |

结果观察者范围值得单独推出决策。其默认观察范围可能会影响集群中的已完成运行，并添加 `results.tekton.dev/*` 最终处理程序。在启用之前对其进行范围限制。禁用归档不会删除现有的最终处理程序；在清理之前遵循产品恢复程序。在 Pruner 删除集群对象后，外部结果存储是审计来源。

[平台文章](./Managing_Platform_Configuration_and_Onboarding_Isolated_Projects_with_Argo_CD_and_Tekton_on_ACP.md) 解释了 18 个平台决策、代码库布局、所有权边界、入驻工作流、轮换和验收检查。

## 在没有互联网访问的情况下操作

通过平台的批准内部服务提供目录、固定工具和基础镜像、软件包依赖项、证书和漏洞数据库。运行时管道必须从本地目录或集群源解析任务和管道。示例 CI 配置将 Trivy 指向 `registry.example.com/mirror/trivy-db:2`；将其替换为可访问的数据库镜像并授予扫描器访问权限。

网络隔离的程度、团队数量和所需的批准证据是平台团队必须决定的部署输入。容量规划、迁移和退役自动化、平台灾难恢复、客户变更管理集成和离线软件包分发程序超出了本系列的范围。为目标环境定义这些程序。

## 相关信息

- [Pipelines 4.15](https://docs.alauda.io/alauda-devops-pipelines/4.15/)
- [Artifact Hub Shim 1.0](https://docs.alauda.io/alauda-devops-artifacthub-shim/1.0/)
- [Connectors 1.14](https://docs.alauda.io/alauda-devops-connectors/1.14/)
- [GitOps 4.4](https://docs.alauda.io/gitops/4.4/)
- [使用 Tekton 和 Kyverno 的软件供应链安全](./Software_Supply_Chain_Security_of_Alauda_Container_Platform_with_Tekton_and_Kyverno.md)
- [使用 Tekton 和 Kyverno 的管道策略约束](./Pipeline_Policy_Constraints_with_Tekton_and_Kyverno.md)
