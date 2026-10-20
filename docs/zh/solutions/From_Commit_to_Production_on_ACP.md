---
products:
  - Alauda Container Platform
  - Alauda DevOps
kind:
  - Article
ProductsVersion:
  - 4.x
id: KB261000023
sourceSHA: 65726b2d0abae3f8253b53738b5e2e4262c43949d7fca67695e1c35b709ef205
---

# 从提交到生产在 ACP 上：选择触发器、部署和发布控制

使用本文来选择管道定义的位置、部署如何使用构建输出，以及审批、推广和签名检查的归属。有关指导实施，请参阅 [原生应用 CI/CD 教程](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/tutorials/index.html)。

这是 [Alauda DevOps 最佳实践](./Alauda_DevOps_Best_Practices_Overview.md) 的交付部分。其配置基线为 Pipelines 4.15、Artifact Hub Shim 1.0、Connectors 1.14 和 GitOps 4.4。项目命名空间、工具侧资源和 Connectors 必须已经存在；[平台文章](./Managing_Platform_Configuration_and_Onboarding_Isolated_Projects_with_Argo_CD_and_Tekton_on_ACP.md) 解释了它们的准备工作。

[伴随示例](https://github.com/AlaudaDevops/devops-best-practices-samples) 使用一个虚构的 `shop` 项目。CI 在 `shop-build` 中运行；CD 和推广在 `shop-cd` 中运行；工作负载在 `shop-test` 和 `shop-prod` 中运行。请根据您的环境替换每个示例地址、工具镜像、组、凭证占位符和策略身份。确保漏洞数据库、工具镜像、基础镜像和依赖项在本地可用，以便进行离线执行。

## 在工作流中跟踪一个镜像身份

```mermaid
flowchart LR
  Commit[合并应用更改] --> CI[构建和扫描]
  CI --> Source[按摘要从源注册表获取镜像]
  Source --> Test[在测试中部署和验证]
  Test --> Approve[批准选定的摘要]
  Approve --> Copy[将镜像复制到生产注册表]
  Copy --> Sign[验证签名和来源]
  Sign --> MR[审查生产 GitOps 更改]
  MR --> Sync[Argo CD 同步和发布]
```

在部署、推广源、签名验证和审计关联中使用 `repository@sha256:<digest>`。标签帮助人们识别发布；单独的标签并不能识别不可变内容。Harbor 推送事件表明镜像已被推送，但并不表明成功扫描、测试、签名或批准。

当在已部署的镜像中发现漏洞时，修复它并使用相同的构建、推广和部署工作流发布新的摘要。保留构建证据和用发布记录替换漏洞镜像的决定。

## 选择定义的位置和运行的启动方式

| 模型             | 定义位置                                                         | 触发器                                              | 适用场景                                               |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| 集群管道         | 项目命名空间中的管道；执行设置在运行模板中                       | 手动、触发器或计划触发器                            | 少量集中操作的管道                                     |
| 代码中的管道     | 应用的 `.tekton/` 目录中的 PipelineRun 文件                     | 推送和合并请求事件                                  | 与源和合并请求检查版本控制的定义                       |
| 中央模板         | 版本化的目录管道，或受控集群命名空间中的管道                     | 运行模板或带有 `pipelineRef` 的 PaC PipelineRun    | 跨项目共享标准                                         |

当集群管道足够时，从集群管道开始。当变更历史和合并请求体验重要时，添加 PaC。当项目应重用标准工作流时，使用中央模板。同一项目可以针对不同的作业使用这三者。针对特定事件选择一种路径，PaC 或触发器。

对于来自合并请求的重试，使用 `/test <pipelinerun-name>`。通过链接到 [触发 PAC 管道](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/trigger_pipeline.html) 保持完整语法在一个地方。

### 将 PaC 与中央模板结合

将事件注释和项目输入保留在 `.tekton/` 中。通过解析器和固定版本引用平台的管道。以下片段显示了应用示例使用的引用；这不是完整的 PipelineRun。使用示例的完整参数和工作区绑定。

```yaml
spec:
  pipelineRef:
    resolver: hub
    params:
      - name: catalog
        value: catalog-pipelines
      - name: kind
        value: pipeline
      - name: name
        value: python-image-build-scan-deploy
      - name: version
        value: "0.3"
```

对于受控集群管道，使用 `resolver: cluster`。在 PaC 定义中避免裸露的 `pipelineRef.name`，当入场检查必须检查定义的来源时。请参阅 [解析器](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/concepts/resolver_concept.html) 和 [在 Git 中定义 PipelineRuns](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/maintain_pipeline_code.html)。

通过审查其固定版本的更改来升级目录管道。项目不会自动采用新发布的版本。为了可重复回滚定义，保留已审查的版本并定义发布坐标是否不可变。运行模板的版本更改是对现有模板的更改，而不是创建另一个模板的理由。

### 保护定义及其运行时凭证

对于自管理的 GitLab 实例，在每个 PaC `Repository` 上设置 `spec.git_provider.url`。没有该 URL，本文中描述的 PaC 行为 [高级存储库配置](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/advanced_repository_config.html) 可能会将完成状态请求和存储库令牌发送到 `gitlab.com`。为应用、平台和项目 GitOps 存储库显式设置提供者 URL。

在预合并运行必须使用已审查定义的地方，设置 `spec.settings.pipelinerun_provenance: default_branch`。这选择定义，而不是受信任的应用代码：合并请求运行仍然使用该定义挂载的凭证构建提议的源。限制这些凭证，并将合并请求镜像输出与发布候选分开。

示例将两个输出分开：

| 定义                                       | 事件          | 镜像存储库                          | 交付用途                       |
| ------------------------------------------ | -------------- | ------------------------------------ | ------------------------------ |
| `sample-app/.tekton/ci.yaml`               | 推送到 `main` | `registry.example.com/shop/hello`    | 测试 CD 和推广的源             |
| `sample-app/.tekton/ci-merge-request.yaml` | 合并请求      | `registry.example.com/shop/hello-mr` | 临时合并请求工件               |

示例的 Harbor Connector 具有项目级访问权限。分离存储库名称本身并不能强制凭证边界。为了更强的分离，使用一个独特的临时注册项目和一个不能写入发布候选镜像的凭证。在交付之前，检查所选摘要是否为成功受信任的 `main` CI 运行的 `IMAGE_DIGEST`。

两个示例 CI 定义通过 `ca-bundle` 工作区绑定 Connector 代理 CA。即使上游注册表使用公共受信任证书，代理的 CA 也是必需的。对于离线扫描，将 `trivyExtraArgs` 设置为使用平台的镜像漏洞数据库，例如 `--db-repository registry.example.com/mirror/trivy-db:2`。扫描器必须能够拉取该镜像。

平台和 GitOps 存储库验证示例组合了 `git-clone` 和 `run-script` 内联。如果平台启用禁止内联 `pipelineSpec` 的策略，则将该验证流程发布为目录管道，并通过解析器引用它。

## 根据环境选择部署路径

| 路径             | 选定摘要如何到达环境                                           | 权衡                                                                         |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 直接部署         | 任务如 `workload-apply`、`helm-upgrade` 或 `run-script` 更新工作负载。 | 移动部件更少；Git 不持有环境状态的第二份副本。                             |
| GitOps            | 更改更新 Git 中环境的镜像引用；Argo CD 进行协调。              | 可审查的环境状态和历史；需要一个存储库和同步路径。                        |

一个有用的起点是将直接部署用于开发或测试，将 GitOps 用于生产。示例在测试和生产中都使用 GitOps，以便在两个环境中使用相同的协调路径。

对于直接部署，在 `workloadContainers` 中使用摘要；使用小写的 `workloadKind`，例如 `deployment`。运行身份需要访问读取和更新目标工作负载。请查阅目录任务以获取其发布、超时、回滚和跨集群选项。

对于 GitOps，每个环境使用一个目录和一个原生应用。将每个镜像摘要保留在一个地方，例如 Kustomize 的 `images` 条目：

```text
gitops/
├── base/
└── envs/
    ├── test/kustomization.yaml
    └── prod/kustomization.yaml
```

在示例中，测试 CD 使用 `submitMode: direct`；生产 CD 使用 `submitMode: pr`。生产覆盖层以生产注册表存储库为基础，因此发布仅更改其摘要。第一次生产部署等待推广的镜像。

在代码平台中强制执行生产 Git 审查。使用受保护的分支，并在支持的情况下进行代码所有者审批。其他选项包括单独受保护的生产分支或存储库，或经过审查的服务器端策略。仅分支保护并不会创建目录级保护。移除直接生产写入访问权限，以避免绕过所选的审查路径。

### 在构建、推广和 GitOps 之间传递结果

`gitops-repo-update` 是一个管道，并作为单独的 PipelineRun 运行。将选定的摘要作为参数传递给其更新脚本。每次运行使用一个新的源工作区卷和一个包含脚本使用的每个命令的镜像。`submitMode: pr` 还需要配置的 GitLab CLI 镜像和具有 API 访问权限的令牌。

示例使用 `sed` 更新 `digest:` 行，并使用 Kustomize 验证呈现的镜像。这保留了一行生产差异。避免使用更改无关格式或镜像字段的重写操作。GitOps 写入令牌需要克隆、推送和创建合并请求所需的范围；将其与应用 CI 令牌分开。

示例从呈现的 PipelineRun YAML 手动启动测试 CD、推广和生产 CD。替换模板参数，验证镜像映射、身份和工作区，并使用 `kubectl create` 提交。使用 [运行模板](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/run_template.html) 进行其他执行条目。Harbor 事件自动化是额外的集成，不是示例的手动路径的一部分。

生产回滚遵循相同的审查边界：选择一个保留的、以前推广的摘要，验证其签名和应用兼容性，并审查 GitOps 更改。数据库和数据迁移需要特定于应用的回滚计划。在目标环境中建立并排练完整的回滚运行手册。配置 [Harbor 标签保留](https://goharbor.io/docs/2.14.0/working-with-projects/working-with-images/create-tag-retention-rules/) 和 [标签不可变性](https://goharbor.io/docs/2.14.0/working-with-projects/working-with-images/create-tag-immutability-rules/)，以确保所需的回滚镜像保持可用。

## 选择发布控制

推广、审批、凭证门控和镜像接纳解决不同的决策：

| 决策                                           | 推荐控制                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 生产是否使用单独的工件项目？                   | 将选定的摘要复制到该项目中，然后更新生产 Git 引用。                                                                                             |
| 谁授权选定的发布？                             | 根据政策，使用 ApprovalTask、生产 Git 合并请求审查或两者。                                                                                     |
| 谁可以使用生产 Connector？                     | 一个专用的发布身份加上入场和 RBAC 限制。当凭证所有者和管道所有者分开时，添加审批门控的代理访问。                                               |
| 可以部署什么？                                 | 允许的生产存储库、签名和任何所需的已批准摘要证据的入场政策。                                                                                   |

在 [使用 Kyverno 限制工件推广](https://docs.alauda.io/alauda-devops-artifacthub-shim/1.0/catalog/how_to/constrain_artifact_promotion_with_kyverno.html) 中使用核心推广入场规则。规则 1-3 限制推广执行路径。当推广管道在命名空间中维护时，添加规则 4，以控制对该定义的更改。伴随示例未安装这些推广规则或仅限生产存储库的部署策略；平台管理员必须在使用参考设计作为生产控制之前添加它们。

推广验证源和目标映射并复制字节。它不会查询 CI 以确定镜像是否通过。审批者必须将摘要与受信任的构建、扫描和测试证据关联。示例验证镜像映射是否首先，源是否使用 SHA-256 摘要，存储库和发布标签格式是否与配置的工作流匹配。可选的签名映射必须引用相同的镜像摘要。

### 添加审批节点

在 `approvers` 中使用 ACP 组资源名称，而不是组的显示名称或个人名称。以下是任务片段；用实际资源名称替换示例组：

```yaml
- name: wait-for-approval
  taskRef:
    apiVersion: openshift-pipelines.org/v1alpha1
    kind: ApprovalTask
  timeout: "24h"
  params:
    - name: approvers
      value:
        - group:release-managers
    - name: numberOfApprovalsRequired
      value: "1"
    - name: description
      value: "批准生产中的推广"
```

PipelineRun 和任务超时预算必须包括审批前的工作、整个审批窗口和审批后的工作。保持审批者组与允许启动或修改发布运行的身份分开。使用 [手动审批门](https://docs.alauda.io/alauda-devops-pipelines/4.15/pipelines/how_to/manual_approval_gate.html) 进行审批权限、组响应和超时配置。在对象被移除之前，单独保留 ApprovalTask 响应。

审批者可以在控制台或通过 `kubectl` 检查待处理的工作。可选示例 `promotion/optional/console-approver.yaml` 提供了自定义控制台角色和组绑定；在应用之前请检查其范围。可以使用目录的 `send-mail` 任务发送审批通知。电子邮件地址、SMTP 配置和凭证必须单独配置；示例未集成该通知步骤。

客户变更管理系统集成不在本系列之内。可用的构建块是审批节点和 [传入 Webhooks](https://docs.alauda.io/alauda-devops-pipelines/4.15/pac/how_to/incoming_webhooks.html)。单独定义该集成的映射和审计合同。

### 在审批后门控生产 Connector

将生产 Connector 及其 Secret 保留在项目成员无法创建 Pods 或运行任意管道的命名空间中。Pod 可以在其自己的命名空间中挂载 Secret，而无需单独的 Secret 读取授权检查。因此，在带有凭证的命名空间中创建 Pods 或 PipelineRuns 的权限是凭证边界。

示例发布 ServiceAccount `shop-release` 读取源 Connector，并从 `platform-connectors` 挂载生产 Connector。其现有权限在 `sample-app/promotion/standing-access.yaml` 中。使用 RBAC 进行产品指南中描述的跨命名空间代理权限。

审批门控使用两个全局安装功能标志。按以下顺序推出它们：

1. 清点每个未经过审批的挂载 Connector 的身份。准备其读取授权和 `connectors/proxy` 权限，动词为 `*`。对 `connectors/proxy` 的 `get` 授权不足。不要直接授予生产 Connector 的代理访问权限，必须经过审批。
2. 启用 `enable-connectors-approval`。立即创建所需的 AccessPolicies，包括管理员-Connector 授权和生产审批政策。在启用标志和创建政策之间，不要启动受影响的运行。
3. 在生产 AccessPolicy 中，配置指定的 `approvers`，并保持与 ApprovalTask 和推广入场政策的一致性。删除任何其他匹配的默认或直接代理授权。
4. 启用 `enable-connector-proxy-permissions`，这也将代理权限检查应用于请求。

通过 `ConnectorsConfig` 设置功能标志。有关完整配置和验证路径，请参阅 [启用代理权限检查和审批门控](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors/how_to/enable_proxy_permissions_and_approval.html)、[AccessPolicy](https://docs.alauda.io/alauda-devops-connectors/1.14/connectors/concepts/access_policy.html) 和 [Skopeo 复制连接器审批](https://docs.alauda.io/alauda-devops-artifacthub-shim/1.0/catalog/how_to/promote_artifacts_with_skopeo_copy.html#connector-approval)。

`defaultPermission` 策略具有授权前提条件，并不能替代每个跨命名空间的 RBAC 授权。仅就绪策略并不能建立有效的挂载。验证实际身份、Pod 事件、挂载配置和 AccessRequest 结果。

## 签名和验证镜像

集中配置 Chains 签名密钥，并仅将公共验证密钥分发给项目。保护签名 Secret 和在其命名空间中创建 Pods 的能力。应用团队不需要访问签名 Secret。

示例将签名和证明存储在镜像旁边。Chains 首先使用运行的 ServiceAccount 中匹配的注册凭证。这些凭证必须能够推送到镜像的注册项目。如果缺少这些凭证，请通过 `TektonConfig` 在 Chains 控制器上配置一个集中管理的注册凭证。Chains 不使用 Connector 的 CSI 代理工作区作为其注册凭证。

集中凭证由管理员创建，位于 Git 之外。将其限制为 Chains 必须读取和签名的注册项目。在引导项目时，平台团队必须将其源和生产注册项目添加到该凭证的访问权限中。轮换它并限制其 Secret 和命名空间。在维护窗口中应用控制器配置更改，保留已配置的其他容器选项。

成功的 PipelineRun 并不能证明存储的签名。检查 TaskRun 签名注释和事件，并独立验证镜像及其证明。这里的接受对象是镜像摘要和复制 TaskRun 的来源；审批历史是单独的证据。

```bash
# IMAGE 是选定的 repository@sha256:digest；平台提供 cosign.pub。
cosign verify --key cosign.pub "$IMAGE"
cosign verify-attestation --key cosign.pub --type slsaprovenance "$IMAGE"
```

对于未配置透明日志的离线安装，使用产品的离线验证设置，包括在需要时使用 `--insecure-ignore-tlog=true`。这会跳过外部透明日志检查；保留签名和证明检查。对私有注册表进行身份验证，而不提交登录凭证。

如果平台选择一个单独的签名存储库，请集中配置 `storage.oci.repository`，并在验证和 Kyverno 的存储库设置中使用相应的 `COSIGN_REPOSITORY`。在将构建和推广证明组合为相同摘要之前，检查存储和覆盖行为。在推广期间复制构建签名附件是可选的；如果选择，请使用文档中的 `imageMappings` 和 `multiArch: all` 配置。

在部署入场时，在审计中启动镜像验证策略，使用示例的 `mutateDigest: false` 设置，并在执行之前审查匹配的镜像和报告。示例的生产镜像列表是明确的：将每个新引导的生产存储库添加到策略中。请参阅 [镜像签名验证](https://docs.alauda.io/alauda-devops-pipelines/4.15/chains/how_to/image_signature_verification.html)。

## 在实际执行点检查控制

| 工作流中的点                      | 检查内容                                            | 剩余责任                                     |
| ---------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| 存储库事件和定义解析            | 事件匹配和已审查的定义来源                        | 限制可用于提议源代码的凭证。                 |
| PipelineRun 入场                  | 允许的定义来源和配置的推广路径                    | 限制谁可以编辑引用的定义和参数。             |
| TaskRun 或 CustomRun 创建         | 直接运行限制的已批准控制器身份                    | 保护自动化身份及其 RBAC。                     |
| 审批                               | 指定的审批者响应                                  | 将已批准的摘要与 CI 和测试证据匹配。         |
| 生产注册表写入                    | 推广映射和凭证访问                                | 控制其他写入者，包括签名身份。               |
| 工作负载入场                       | 允许的注册表和所需的签名检查                      | 移除绕过政策的直接部署路径。                 |
| 保留和清理                        | 选定的运行/日志保留                               | 导出审批证据并验证归档访问。                 |

使用平台 ClusterPolicies 作为基线，项目 Policies 作为额外限制。限制 PolicyException 的创建或根据平台政策禁用异常。仅解析器类型的允许列表并不能固定目录、存储库、命名空间、版本或定义内容。启用无内联策略时，必须明确处理内联验证异常。

## 接受交付工作流

仅在隔离的接受项目中替换输入后，从示例运行 `acceptance/01-commit-to-production.sh`。检查是执行操作步骤，而不是声称任意环境已准备就绪。

| 检查                                  | 所需证据                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI 完成                               | 受信任的 `main` 运行成功；其镜像存储库和摘要与选定的发布输入匹配。                                                                                               |
| 测试运行选定的镜像                   | 比较完整的工作负载镜像引用并验证发布完成。                                                                                                                      |
| 推广复制该镜像                       | 推广结果报告预期的目标存储库和摘要。                                                                                                                              |
| 生产使用推广结果                     | GitOps 合并请求已合并，呈现的镜像与目标摘要匹配，工作负载发布完成。仅 `Synced` 可能描述旧版本。                                                               |
| 签名和来源存在                       | 两个 cosign 命令在生产镜像上成功。仅签名注释不足以证明。                                                                                                        |
| 入场强制执行所选政策                 | 在接受项目中使用受限兼容探针，并区分政策拒绝与 Pod 安全或镜像拉取失败。之后清理探针。                                                                          |
| 审批是可归属的                       | 在发布记录中保存 ApprovalTask 响应、审批者组成员、选定摘要和相关运行标识符。                                                                                   |

在生产之前，解决示例中的显式加固工作：限制 GitOps 写入者的命名空间，保护生产 Git 更改，安装推广核心规则，限制生产镜像源，并限制直接集群写入。不要授予项目成员在包含管理员或发布凭证的命名空间中创建 Pod 的权限。建立本地回滚和政策服务恢复运行手册。

继续阅读 [管理平台配置和引导隔离项目](./Managing_Platform_Configuration_and_Onboarding_Isolated_Projects_with_Argo_CD_and_Tekton_on_ACP.md)，了解此工作流背后的平台配置、项目声明和操作边界。
