---
id: KB250600001
products:
   - Alauda Container Platform
kind:
   - Solution
---

# 使用 Tekton 与 Kyverno 保障 Alauda Container Platform 的软件供应链安全

## 概述

在当今高度依赖开源与第三方组件的软件开发环境中，供应链攻击正变得愈发频繁。从 SolarWinds 事件到 Log4j 漏洞，这些安全事件都凸显了软件供应链安全的极端重要性。

软件供应链涵盖软件开发生命周期中涉及的全部实体与流程，从应用开发到 CI/CD 流水线再到部署。现代软件通常由多个组件构成，其中包括开源软件，它们可能含有漏洞，且往往不在开发者的直接掌控之内。这使得供应链安全成为每一个组织都必须承担的关键责任。

### 理解软件供应链中的主要风险

- **代码完整性风险**：与源代码、构建过程或开发环境遭到未授权修改相关的风险，这类修改会破坏软件的完整性。
- **依赖组件风险**：源自第三方依赖及其供应链中的漏洞、恶意代码或合规问题的风险。
- **构建过程风险**：与构建环境、工具和流程的安全性及完整性相关的风险，可能导致产出物被污染。
- **分发过程风险**：与软件分发渠道的安全性相关的风险，包括容器镜像仓库、镜像签名和传输安全。
- **部署与运行时风险**：与部署环境、配置管理和运行时依赖的安全性相关的风险。
- **合规风险**：与法律法规要求相关的风险，包括开源许可证、数据隐私和行业标准。

### 理解软件供应链安全

#### 供应链安全框架

##### 软件制品供应链层级（SLSA）

软件制品供应链层级（Supply chain Levels for Software Artifacts，SLSA）框架是一份控制项清单，用于防止篡改、提升完整性，并增强项目、企业或组织所使用的软件包与基础设施的安全性。SLSA 将软件供应链完整性的判定标准形式化，帮助整个行业与开源生态在软件开发生命周期的各个阶段保障安全。

作为框架的一部分，SLSA 提供了多个保障层级。这些层级汇集了业界公认的最佳实践，构成四个保障强度递增的等级。

> [安全层级](https://slsa.dev/spec/v1.1/levels)

| 轨道/层级 | 要求 | 关注点 |
| ----------- | ------------ | ----- |
| Build L0    | （无）       | （不适用） |
| Build L1    | 提供来源证明，说明软件包是如何构建的 | 失误、文档化 |
| Build L2    | 由托管的构建平台生成的、经过签名的来源证明 | 构建之后的篡改 |
| Build L3    | 经过加固的构建平台 | 构建过程中的篡改 |

> Tekton 可以达到 SLSA Level 2 合规。更多信息请参阅 [Getting To SLSA Level 2 with Tekton and Tekton Chains](https://tekton.dev/blog/2023/04/19/getting-to-slsa-level-2-with-tekton-and-tekton-chains/)

#### 安全验证机制

##### 镜像签名

镜像签名用于验证镜像完整性，防止其在传输和存储过程中被篡改。这是一种基础的验证机制，只需使用 cosign 即可完成签名校验。

##### 无密钥签名

无密钥签名是一种现代签名方式，它不依赖传统的公私钥对，而是使用：
- 透明日志，用于留存审计轨迹

无密钥签名具有以下优势：
- 无需管理私钥
- 无需进行密钥轮换
- 简化密钥管理

##### 镜像证明

镜像证明用于存储和验证与镜像相关的元数据信息。它可以提供更丰富的供应链安全信息，例如：

- [SLSA 来源证明](#slsa-provenance-integrity-attestation)
- [SBOM](#sbom-software-bill-of-materials)
- [漏洞扫描结果](#vulnerability-scan-results)
- [自定义元数据](#custom-metadata)

##### 证明验证

该验证机制具有高度灵活性，可以定制以校验证明中存在的任意元数据。这意味着证明中存储的任何信息都可以作为校验依据，使组织能够基于自身的具体需求实施精确的安全管控。

证明验证的灵活性体现在多种校验方式上：

- Kyverno [JMESPath](https://jmespath.org/) 校验
   - 使用 JMESPath 语法进行 JSON 查询与校验

- [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/) 策略校验
   - 借助 Open Policy Agent（OPA）实施复杂的策略管控
   - 支持声明式策略规则与自定义校验逻辑
   - 示例：校验构建者信息与构建环境

- [CUE](https://cuelang.org/) 校验
   - 提供用于校验的类型系统与约束系统
   - 支持 schema 校验与数据一致性检查
   - 支持复杂数据结构的校验

#### 证明类型

证明类型是用于记录和验证容器镜像各方面属性的标准化格式。这些证明通常通过 cosign 之类的工具附加到镜像上，并可通过 Kyverno 之类的策略引擎进行验证。

##### SLSA 来源证明（完整性证明） {#slsa-provenance-integrity-attestation}

[SLSA Provenance](https://slsa.dev/provenance/v1) 是一套由业界共识确立、可逐步采纳的供应链安全指南。它包含：
- 构建过程信息
- 构建环境详情
- 构建时间信息
- 源代码信息
- 依赖信息

predicate 类型：
- https://slsa.dev/provenance/v1
- https://slsa.dev/provenance/v0.2

##### SBOM（软件物料清单） {#sbom-software-bill-of-materials}

[SBOM](https://www.ntia.gov/page/software-bill-materials) 是软件的嵌套式清单，即构成软件组件的"配料表"，包括：
- 软件组件
- 组件版本
- 许可证信息
- 依赖关系

SBOM 可以采用多种格式，例如：
- [SPDX](https://spdx.dev/use/specifications/)
- [CycloneDX](https://cyclonedx.org/specification/overview/)

predicate 类型：
- https://spdx.dev/Document
- https://cyclonedx.org/bom

##### 漏洞扫描结果 {#vulnerability-scan-results}

[Cosign 漏洞扫描结果](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)记录了软件构建过程的安全评估情况，包括：
- 扫描器信息（名称、版本）
  - 漏洞数据库信息
- 已发现漏洞的清单及其严重级别
- 修复建议

predicate 类型：
- https://cosign.sigstore.dev/attestation/vuln/v1

##### 自定义元数据 {#custom-metadata}

可以按需添加自定义元数据，以支持特定的安全要求。

例如，grype 能够生成漏洞扫描结果，这些结果可以作为自定义类型上传到镜像仓库。

predicate 类型：
- https://cosign.sigstore.dev/attestation/v1
## 理解实现方式

Alauda Container Platform 借助 OpenSSF 的 SLSA 框架提供全面的供应链安全能力。平台通过核心组件与专用工具的组合，集成了多项安全能力：

核心组件：
- Tekton Pipelines：用于流水线编排与自动化
- Tekton Chains：用于 SLSA 合规与制品签名
- Kyverno：用于策略实施与校验

依赖工具：
- cosign：用于镜像签名与验证
- syft/trivy：用于生成 SBOM 与漏洞扫描
- grype：用于漏洞扫描

整个实现过程分为三个主要阶段：

### 阶段 1：生成证明

| 能力 | 标准化 Predicate 类型 | 工具 | 说明 |
|----------------------------|---------------|------|-------------|
| 镜像签名 | [-](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md) | Tekton Chains | 自动为镜像签名 |
| | | cosign | 手动为镜像签名 |
| SLSA 来源证明 | - [https://slsa.dev/provenance/v0.2](https://slsa.dev/provenance/v1)<br>- [https://slsa.dev/provenance/v1](https://slsa.dev/provenance/v1) | Tekton Chains | 为镜像生成 SLSA Provenance<br>将 TaskRun 或 PipelineRun 的元数据上传到镜像的 SLSA Provenance 中 |
| SBOM | - [https://spdx.dev/Document](https://cyclonedx.org/specification/overview/)<br>- [https://cyclonedx.org/bom](https://cyclonedx.org/specification/overview/) | syft | 生成 SBOM 文件并附加到镜像上 |
| | | trivy + cosign | 使用 trivy 生成 SBOM 文件，并通过 cosign 附加到镜像上 |
| 漏洞扫描结果 | [https://cosign.sigstore.dev/attestation/vuln/v1](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md) | grype + cosign | 使用 grype 生成漏洞扫描结果<br>使用 cosign 将结果附加到镜像上 |
| | | trivy + cosign | 使用 trivy 生成漏洞扫描结果<br>使用 cosign 将结果附加到镜像上 |
| 自定义元数据 | [https://cosign.sigstore.dev/attestation/v1](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_PREDICATE_SPEC.md) | cosign | 将自定义元数据附加到镜像上 |

### 阶段 2：校验证明

| 校验类型 | 校验要求 | 说明 |
|-----------------|------------------------|-------------|
| 镜像签名 | 签名验证 | 要求镜像由特定签名者签名 |
| SLSA 来源证明 | 构建环境 | 要求镜像的构建来源为特定的构建环境 |
| | 源代码 | 要求镜像的构建来源为特定的仓库地址 |
| SBOM | 组件要求 | 要求 SBOM 中包含或不包含特定的软件组件或版本 |
| | 基础镜像 | 要求基础镜像为特定的名称与版本（operating-system） |
| 漏洞扫描 | 严重漏洞 | 要求扫描结果中不存在严重级别的漏洞 |
| | 扫描时效 | 要求漏洞扫描在特定的时间窗口内完成 |
| 自定义元数据 | 自定义要求 | 要求自定义元数据中包含或不包含特定的元数据 |

### 阶段 3：能力组合

证明体系为软件供应链安全提供了一个灵活且可组合的框架。
你可以组合不同的证明来满足特定的安全要求。

常见场景及其所需能力：

| 章节 | 说明 | 所需能力 | 关键工具 |
|---------|-------------|----------------------|-----------|
| 1 | 镜像签名与验证 | 镜像签名、签名验证 | Chains、cosign/Kyverno |
| 2 | 构建系统验证 | SLSA 来源证明、证明验证 | Chains、Kyverno |
| 3 | 源代码仓库验证 | SLSA 来源证明、证明验证 | Git 仓库、Chains、Kyverno |
| 4 | 漏洞扫描验证 | 漏洞扫描结果、证明验证 | grype/trivy、cosign、Kyverno |
| 5 | 基础镜像验证 | SBOM、证明验证 | syft/trivy、cosign、Kyverno |
| 6 | 许可证合规验证 | SBOM、证明验证 | syft/trivy、cosign、Kyverno |
| 7 | （可选）无密钥签名验证 | OIDC 认证、无密钥签名 | Rekor、cosign、Kyverno |

你可以根据自身的具体需求定制这些证明。
平台将这些能力整合起来，提供全面的供应链安全防护。

#### 方式 1：镜像签名与验证

该方式使用 Tekton Chains 自动为构建出的镜像签名，随后使用 cosign 或 Kyverno 验证签名：

1. 配置 Tekton Chains，使其自动为构建出的镜像签名。
2. 使用 `buildah` Tekton Task 构建镜像。
3. （可选）使用 `cosign` 命令行验证签名。
4. 配置 Kyverno 规则，只允许已签名的镜像。
5. 使用该镜像创建 Pod，以验证签名。

#### 方式 2：构建系统验证

该方式使用 Chains 自动为构建出的镜像生成 SLSA Provenance，随后使用 Kyverno 验证该来源证明：

1. 配置 Tekton Chains，使其自动为构建出的镜像生成 SLSA Provenance。
2. 使用 `buildah` Tekton Task 构建镜像。
3. （可选）使用 `cosign` 命令行验证证明。
4. 配置 Kyverno 规则以验证证明。
5. 使用该镜像创建 Pod，以验证证明。

#### 方式 3：源代码仓库验证

该方式使用 Chains 自动为构建出的镜像生成 SLSA Provenance，随后使用 Kyverno 验证该来源证明：

1. 配置 Tekton Chains，使其自动为构建出的镜像生成 SLSA Provenance。
2. 使用 `git` Tekton Task 获取源代码仓库。
3. 使用 `buildah` Tekton Task 构建镜像。
4. 在 Pipeline 的 results 中声明 `git` 与 `buildah` 的 results 信息。这样便于记录镜像对应的源代码仓库与提交信息。
5. 配置 Kyverno 规则以验证源代码仓库。
6. 使用该镜像创建 Pod，以验证源代码仓库。

#### 方式 4：漏洞扫描验证

该方式使用 trivy 之类的工具扫描镜像漏洞，随后使用 Kyverno 验证漏洞扫描结果：

1. 使用 `trivy` Tekton Task 扫描镜像漏洞。
2. 使用 `cosign` Tekton Task 将漏洞扫描结果上传到镜像。
3. 配置 Kyverno 规则以验证漏洞扫描结果。
4. 使用该镜像创建 Pod，以验证漏洞扫描结果。

#### 方式 5：基础镜像验证

该方式使用 syft 之类的工具为镜像生成 SBOM，随后使用 Kyverno 验证该 SBOM：

1. 使用 `syft` Tekton Task 为镜像生成 SBOM 并附加到镜像上。
2. 配置 Kyverno 规则以验证 SBOM。
3. 使用该镜像创建 Pod，以验证 SBOM。

#### 方式 6：许可证合规验证

该方式与方式 5 类似，只需把 Kyverno 规则改为验证许可证合规即可。

1. 配置 Kyverno 规则以验证 SBOM。
2. 使用该镜像创建 Pod，以验证 SBOM。

#### 方式 7：（可选）无密钥签名验证

> **注意：**
> - **该方式要求环境能够访问互联网。**<br>
> - 如果你已经部署了私有的 [Rekor](https://github.com/sigstore/rekor) 服务，也可以通过调整相关配置来使用这些能力。<br>
> - 私有 [Rekor](https://github.com/sigstore/rekor) 服务的部署不在本文范围内，请参阅相关文档。

该方式利用透明日志来增强安全性，从而免去密钥管理：

1. 配置 Tekton Chains 使用无密钥签名。
2. 使用 `buildah` Tekton Task 构建镜像。
3. 配置 Kyverno 规则以验证无密钥签名。
4. 使用该镜像创建 Pod，以验证无密钥签名。
## 通用基础配置

### 环境准备

#### 系统要求

- 已安装 Alauda Container Platform，并有可用的 Kubernetes 集群
- 已安装 Kubectl 命令行工具，以及用于向 ACP 平台认证的 kubectl-acp 插件
- 已通过 kubectl acp login 命令完成集群认证
- （可选）本地机器上已安装 cosign 命令行工具

#### 所需组件

- Tekton Chains
- Tekton Pipeline
- Kyverno
- 用于存放镜像与签名的 OCI Registry

#### 权限要求

- 配置 Tekton Chains 需要平台管理员权限
- 配置 Kyverno 策略需要集群管理员权限
- 创建命名空间需要项目级权限
- 推送和拉取镜像需要镜像仓库访问权限

### 通用配置

#### Tekton Chains

> 该流程需要平台管理员权限才能配置。

##### 生成签名密钥

> **注意：** 该密钥用于生成制品的签名信息，请妥善保管。

你可以使用 [cosign](https://github.com/sigstore/cosign) 工具生成签名密钥。

```shell
$ COSIGN_PASSWORD={password} cosign generate-key-pair k8s://tekton-pipelines/signing-secrets
```

**注意：**

- 你需要已安装 cosign CLI，并且能够访问 k8s 集群。
- `COSIGN_PASSWORD` 是用于加密签名密钥的密码。
- `tekton-pipelines` 是 Chains 组件所部署的命名空间，默认为 `tekton-pipelines`。
- `signing-secrets` 是用于存放签名密钥的 Secret 名称。

执行完成后，你可以查看对应的 Secret 资源。

```shell
$ kubectl get secret signing-secrets -n tekton-pipelines -o yaml

apiVersion: v1
data:
  cosign.key: <base64-encoded-private-key>
  cosign.password: <base64-encoded-password>
  cosign.pub: <base64-encoded-public-key>
immutable: true
kind: Secret
metadata:
  name: signing-secrets
  namespace: tekton-pipelines
type: Opaque
```

##### 获取签名公钥 {#get-the-signing-public-key}

> 如果你没有权限，可以请管理员帮忙获取公钥。

```shell
$ export NAMESPACE=<tekton-pipelines>
$ kubectl get secret -n $NAMESPACE signing-secrets -o jsonpath='{.data.cosign\.pub}' | base64 -d > cosign.pub
```

##### 获取签名 Secret {#get-the-signing-secret}

```shell
$ export NAMESPACE=<tekton-pipelines>
$ kubectl get secret -n $NAMESPACE signing-secrets -o yaml > signing-secrets.yaml
```

##### 重启 Tekton Chains 组件使签名密钥生效

```shell
$ kubectl delete pods -n tekton-pipelines -l app=tekton-chains-controller
```

等待组件启动。

```shell
$ kubectl get pods -n tekton-pipelines -l app=tekton-chains-controller -w

NAME                                        READY   STATUS    RESTARTS   AGE
tekton-chains-controller-55876dfbbd-5wv5z   1/1     Running   0          1m30s
```

##### Tekton Chains 配置

配置 Tekton Chains，使其自动为 OCI 制品生成签名与 SLSA Provenance。

```shell
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "artifacts.oci.format": "simplesigning",
      "artifacts.oci.storage": "oci",
      "artifacts.pipelinerun.format": "in-toto",
      "artifacts.pipelinerun.storage": "oci",
      "artifacts.taskrun.format": "in-toto",
      "artifacts.taskrun.storage": "oci",
      "builder.id": "https://alauda.io/builders/tekton/v1"
    }
  }
}'
```

> 如果你的镜像仓库使用自签名证书，需要在 `TektonConfig` 的 `config` 中追加以下配置。
>
> ```shell
> $ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
>   "spec": {
>     "chain": {
>       "storage.oci.repository.insecure": true
>     }
>   }
> }'
> ```

> 关于 Tekton Chains 配置的更多细节，请参阅 [Tekton Chains Configuration](https://github.com/tektoncd/chains/blob/main/docs/config.md)

> 默认情况下，Tekton Chains 通过 `TektonConfig` 资源自动部署。你可以修改 `TektonConfig` 资源来配置 Chains。<br>
> 本质上，Tekton Operator 会把 Chains 配置从 `TektonConfig` 资源同步到 `TektonChains` 资源，最终体现在 `chains-config` ConfigMap 中。<br>
> 你可以通过 `kubectl get configmaps -n <tekton-pipelines> chains-config -o yaml` 查看该配置

#### 镜像仓库配置 {#registry-configuration}

> 该流程需要在构建和部署镜像所在的命名空间中执行。

##### 创建镜像仓库 Secret

```shell
$ export NAMESPACE=<default>
$ export REGISTRY_CREDENTIALS=<registry-credentials>

$ kubectl create secret docker-registry -n $NAMESPACE $REGISTRY_CREDENTIALS \
  --docker-server=<registry-server> \
  --docker-username=<username> \
  --docker-email=<someemail@something.com> \
  --docker-password=<password>
```

##### 设置 `config.json` 键

```shell
$ DOCKER_CONFIG=$(kubectl get secret -n $NAMESPACE $REGISTRY_CREDENTIALS -o jsonpath='{.data.\.dockerconfigjson}')
$ kubectl patch secret -n $NAMESPACE $REGISTRY_CREDENTIALS -p "{\"data\":{\"config.json\":\"$DOCKER_CONFIG\"}}"
```

##### 获取镜像仓库 Secret

```shell
$ kubectl get secret -n $NAMESPACE $REGISTRY_CREDENTIALS -o yaml

apiVersion: v1
data:
  .dockerconfigjson: <base64-encoded-dockerconfigjson>
  config.json: <base64-encoded-config.json>
kind: Secret
metadata:
  name: <registry-credentials>
type: kubernetes.io/dockerconfigjson
```

#### ServiceAccount 配置 {#serviceaccount-configuration}

> 该流程需要在构建和部署镜像所在的命名空间中执行。

将镜像仓库凭据添加到 ServiceAccount，用于镜像构建与签名推送。

```shell
$ export NAMESPACE=<default>
$ export SERVICE_ACCOUNT_NAME=<default>
$ export REGISTRY_CREDENTIALS=<registry-credentials>

$ kubectl patch serviceaccount -n $NAMESPACE $SERVICE_ACCOUNT_NAME \
  -p "{\"imagePullSecrets\": [{\"name\": \"$REGISTRY_CREDENTIALS\"}]}"
```

#### Kyverno 配置

> 该流程需要集群管理员权限才能配置。

由于 Kyverno 需要镜像仓库凭据来验证镜像签名，你需要在 Kyverno 所部署的命名空间中创建一个镜像仓库 Secret。
在我们的环境中，该命名空间通常是 `kyverno`。

### 基本概念

#### 镜像签名
- 为镜像生成数字签名，以确保其完整性与真实性
- 使用 cosign 进行签名与验证
- 同时支持传统的基于密钥的签名和无密钥签名两种方式

#### 镜像证明
- 与镜像相关的元数据信息
- 包括 SLSA Provenance、SBOM、漏洞扫描结果
- 与镜像一同存放在镜像仓库中

#### SLSA 来源证明
- 记录软件构建过程的完整性证明
- 包括构建过程信息、环境详情、源代码信息
- 有助于验证镜像的构建过程与来源

#### Kyverno 策略
- 面向 Kubernetes 的策略引擎
- 用于校验镜像并强制实施安全策略
- 支持使用 JMESPath 表达式编写复杂的校验规则

#### Tekton Chains 类型提示 {#tekton-chains-type-hinting}

> 关于类型提示的更多细节，可参阅 [Tekton Chains Type Hinting](https://tekton.dev/docs/chains/slsa-provenance/#type-hinting) 文档。

类型提示（Type Hinting）是 Tekton Chains 中的一种特殊机制，它通过特定的命名约定帮助 Chains 理解 PipelineRun/TaskRun 中的输入制品与输出制品。

**作用**
- 帮助 Chains 正确识别并记录构建过程中的输入与输出制品
- 生成准确的 SLSA Provenance 证明
- 确保构建过程的可追溯性与完整性

指定输入与输出制品有以下几种方式：

##### **CHAINS-GIT_URL 与 CHAINS-GIT_COMMIT 组合**
- 针对 Git 仓库信息的特殊类型提示
- 用于追踪源代码仓库的详细信息
- 有助于为源代码生成来源证明
  ```yaml
  results:
    - name: CHAINS-GIT_URL
      type: string
    - name: CHAINS-GIT_COMMIT
      type: string
  ```

##### **\*ARTIFACT_INPUTS**

> **注意：**
> - `*` 表示任意表达式

- 用于指定影响构建过程的输入制品
- 有助于追踪依赖与源材料
  ```yaml
  results:
    - name: first-ARTIFACT_INPUTS
      type: object
      properties:
        uri: {}
        digest: {}
  ```

##### **\*IMAGE_URL 与 \*IMAGE_DIGEST 组合**
```yaml
results:
  - name: first-image-IMAGE_URL
    type: string
  - name: first-image-IMAGE_DIGEST
    type: string
```

##### **IMAGES**
- 可以指定多个镜像，以逗号或换行分隔
- 每个镜像都必须包含完整的 digest
  ```yaml
  results:
    - name: IMAGES
      type: string
  ```

##### **\*ARTIFACT_URI / \*ARTIFACT_DIGEST 组合**
- 与 IMAGE_URL/IMAGE_DIGEST 类似，只是命名约定不同
- 用于指定制品的位置及其 digest
  ```yaml
  results:
    - name: first-ARTIFACT_URI
      type: string
    - name: first-ARTIFACT_DIGEST
      type: string
  ```

##### **\*ARTIFACT_OUTPUTS**
- 使用 object 类型的 results
- 必须包含 uri 与 digest 字段
  ```yaml
  results:
    - name: first-ARTIFACT_OUTPUTS
      type: object
      properties:
        uri: {}
        digest: {}
  ```
## 第 1 章：强制镜像签名 —— 自动签名与部署管控 {#chapter-1-enforcing-image-signature-automated-signing-and-deployment-control}

在 ACP（Alauda Container Platform）中，你可以使用 Tekton Chains 自动为 Tekton Pipeline 构建出的镜像签名，并使用 Kyverno 只允许已签名的镜像被部署。

本章逐步说明如何实现上述流程。

### 第 1 步：前置条件

请检查前置条件是否已完成，尤其是以下这几节：

- [镜像仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)

### 第 2 步：创建用于生成镜像的流水线 {#step-2-create-a-pipeline-to-generate-the-image}

这是一个 Pipeline 资源，用于生成镜像。

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: chains-demo-1
spec:
  params:
    - default: |-
        echo "Generate a Dockerfile for building an image."

        cat << 'EOF' > Dockerfile
        FROM ubuntu:latest
        ENV TIME=1
        EOF

        echo -e "\nDockerfile contents:"
        echo "-------------------"
        cat Dockerfile
        echo "-------------------"
        echo -e "\nDockerfile generated successfully!"
      description: A script to generate a Dockerfile for building an image.
      name: generate-dockerfile
      type: string
    - default: <registry>/test/chains/demo-1:latest
      description: The target image address built
      name: image
      type: string
  tasks:
    - name: generate-dockerfile
      params:
        - name: script
          value: $(params.generate-dockerfile)
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: run-script
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
    - name: build-image
      params:
        - name: IMAGES
          value:
            - $(params.image)
        - name: TLS_VERIFY
          value: "false"
      runAfter:
        - generate-dockerfile
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: buildah
          - name: version
            value: "0.9"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
  results:
    - description: first image artifact output
      name: first_image_ARTIFACT_OUTPUTS
      type: object
      value:
        digest: $(tasks.build-image.results.IMAGE_DIGEST)
        uri: $(tasks.build-image.results.IMAGE_URL)
  workspaces:
    - name: source
      description: The workspace for source code.
    - name: dockerconfig
      description: The workspace for Docker configuration.
```

> **注意：**
>
> 本教程为简化流程，直接在流水线内联生成 `Dockerfile`。
> 在生产环境中，你通常会：
>
> 1. 使用 `git-clone` task 从代码仓库拉取源代码
> 2. 使用源代码中已有的 Dockerfile 构建镜像
> 3. 这种做法确保了恰当的版本管理，并保持代码与流水线配置之间的分离

**YAML 字段说明：**

- `params`：流水线的参数。
  - `generate-dockerfile`：用于生成构建镜像所需 Dockerfile 的脚本。
  - `image`：构建产出的目标镜像地址。
- `tasks`：流水线的任务。
  - `generate-dockerfile`：生成构建镜像所需 Dockerfile 的任务。
  - `build-image`：构建镜像并推送到镜像仓库的任务。
    - `params.TLS_VERIFY`：是否校验镜像仓库的 TLS 证书。
- `results`：流水线的结果。
  - `first_image_ARTIFACT_OUTPUTS`：第一个镜像制品输出的结果。
    - `digest`：镜像的 digest。
    - `uri`：镜像的 URI。
  - 该格式符合 Tekton Chains 的约定，更多细节参见上文的 [Tekton Chains 类型提示](#tekton-chains-type-hinting)。
- `workspaces`：流水线的工作空间。
  - `source`：用于源代码的工作空间。
  - `dockerconfig`：用于 Docker 配置的工作空间。

**需要调整的配置**
- `params`：
  - `generate-dockerfile`
    - `default`：调整 from 的镜像地址。
  - `image`：
    - `default`：构建产出的目标镜像地址。

保存为名为 `chains.demo-1.pipeline.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline resource in the namespace
$ kubectl apply -n $NAMESPACE -f chains.demo-1.pipeline.yaml
```

### 第 3 步：运行流水线以生成镜像 {#step-3-run-the-pipeline-to-generate-the-image}

这是一个 PipelineRun 资源，用于运行该流水线。

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: chains-demo-1-
spec:
  pipelineRef:
    name: chains-demo-1
  taskRunTemplate:
    serviceAccountName: <default>
  workspaces:
    - name: dockerconfig
      secret:
        secretName: <registry-credentials>
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
          storageClassName: <nfs>
```

**YAML 字段说明：**

- `pipelineRef`：要运行的流水线。
  - `name`：流水线的名称。
- `taskRunTemplate`：任务运行模板。
  - `serviceAccountName`：流水线使用的 service account。
- `workspaces`：流水线的工作空间。
  - `dockerconfig`：用于 Docker 配置的工作空间。
  - `source`：用于源代码的工作空间。

**需要调整的配置**

- `taskRunTemplate`：
  - `serviceAccountName`：上一步 [ServiceAccount 配置](#serviceaccount-configuration) 中准备好的 service account。
- `workspaces`：
  - `dockerconfig`：
    - `secret.secretName`：上一步 [镜像仓库配置](#registry-configuration) 中准备好的镜像仓库 secret。
  - `source`：
    - `volumeClaimTemplate.spec.storageClassName`：卷声明模板所用的 storage class 名称。

保存为名为 `chains.demo-1.pipelinerun.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline run resource in the namespace
$ kubectl create -n $NAMESPACE -f chains.demo-1.pipelinerun.yaml
```

等待该 PipelineRun 执行完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-1-<xxxxx>   True        Succeeded   2m         2m
```

### 第 4 步：等待 PipelineRun 被签名 {#step-4-wait-for-the-pipelinerun-to-be-signed}

等待该 PipelineRun 出现 `chains.tekton.dev/signed: "true"` 注解。

```shell
$ export NAMESPACE=<default>
$ export PIPELINERUN_NAME=<chains-demo-1-xxxxx>

$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o yaml | grep "chains.tekton.dev/signed"
    chains.tekton.dev/signed: "true"
```

一旦该 PipelineRun 带上 `chains.tekton.dev/signed: "true"` 注解，就说明镜像已被签名。

### 第 5 步：从 PipelineRun 中获取镜像 {#step-5-get-the-image-from-the-pipelinerun}

```shell
# Get the image URI
$ export IMAGE_URI=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.uri}')

# Get the image digest
$ export IMAGE_DIGEST=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.digest}')

# Combine the image URI and digest to form the full image reference
$ export IMAGE=$IMAGE_URI@$IMAGE_DIGEST

# Print the image reference
$ echo $IMAGE

<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046
```

该镜像将用于后续的签名验证。

### 第 6 步：（可选）使用 cosign 验证签名

> **提示：**
>
> - 本步骤为可选，当你需要用 cosign 验证镜像签名时才执行。
> - 如果你想了解如何使用 cosign 验证签名，可以继续阅读下面的内容。

按照 [获取签名公钥](#get-the-signing-public-key) 一节获取签名公钥。

使用 cosign 验证签名。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ cosign verify --key cosign.pub ${IMAGE}
```

收到如下输出，说明签名验证成功。

```text
[{"critical":{"identity":{"docker-reference":"<registry>/test/chains/demo-1"},"image":{"docker-manifest-digest":"sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046"},"type":"cosign container image signature"},"optional":null}]
```

你也可以用 `cosign` 去验证一个未签名的镜像。

```shell
$ cosign verify --key cosign.pub ${IMAGE}
```

收到如下输出，说明签名验证失败。

```text
Error: no signatures found
error during command execution: no signatures found
```

### 第 7 步：使用 Kyverno 验证签名

#### 第 7.1 步：创建 Kyverno 策略，只允许部署已签名的镜像 {#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed}

> 本步骤需要集群管理员权限。

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: only-cosign-image-deploy
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # The credential needs to exist in the namespace where kyverno is deployed
              - registry-credentials

          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |- # <- The public key of the signer
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                      UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                      -----END PUBLIC KEY-----

                    ctlog:
                      ignoreSCT: true

                    rekor:
                      ignoreTlog: true
```

> 关于 Kyverno ClusterPolicy 的更多细节，请参阅 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- `spec.rules[].match.any[].resources`：需要匹配并校验的资源。
  - `kinds`：需要匹配并校验的资源类型。
    - `Pod`：Pod 资源。
  - `namespaces`：需要匹配并校验的资源所在的命名空间。
    - `policy`：`policy` 命名空间中的资源将被匹配并校验。
- `spec.rules[].verifyImages`：镜像验证配置
  - `imageReferences`：需要验证的镜像引用。
    - `*`：所有镜像引用都会被验证。
    - `<registry>/test/*`：只有 `<registry>/test` 仓库中的镜像引用会被验证。
  - `skipImageReferences`：需要跳过的镜像引用。
    - `ghcr.io/trusted/*`：只有 `ghcr.io/trusted` 仓库中的镜像引用会被跳过。
  - `imageRegistryCredentials`：
    - `allowInsecureRegistry`：是否允许不安全的镜像仓库。
    - `secrets`：用作镜像仓库凭据的 secret。
      - `registry-credentials`：该 secret 的名称。该 secret 需要存在于 kyverno 所部署的命名空间中。
  - `attestors`：用于镜像验证的证明方。
    - `count`：需要匹配的证明方数量。
    - `entries`：证明方的条目。
      - `keys.publicKeys`：证明方的公钥。该公钥与 `signing-secrets` secret 中的 `cosign.pub` 公钥相同。
      - `keys.ctlog.ignoreSCT`：是否忽略 SCT。在隔离网络环境中，先忽略 SCT。
      - `keys.rekor.ignoreTlog`：是否忽略 Tlog。在隔离网络环境中，先忽略 Tlog。

**需要调整的配置**

- `spec.rules[].attestors[].entries[].keys.publicKeys`：签名者的公钥。
  - 该公钥与 `signing-secrets` secret 中的 `cosign.pub` 公钥相同。
  - 该公钥可以从 [获取签名公钥](#get-the-signing-public-key) 一节获取。

保存为名为 `kyverno.only-cosign-image-deploy.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ kubectl apply -f kyverno.only-cosign-image-deploy.yaml

clusterpolicy.kyverno.io/only-cosign-image-deploy configured
```

#### 第 7.2 步：验证策略

在定义了该策略的 `policy` 命名空间中，创建一个 Pod 来验证策略。

使用流水线构建出的已签名镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ kubectl run -n $NAMESPACE signed --image=${IMAGE} -- sleep 3600

pod/signed created
```

该 Pod 会创建成功。

```shell
$ export NAMESPACE=<policy>
$ kubectl get pod -n $NAMESPACE signed

NAME      READY   STATUS    RESTARTS   AGE
signed   1/1     Running   0          10s
```

再使用未签名的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/unsigned:latest>

$ kubectl run -n $NAMESPACE unsigned --image=${IMAGE} -- sleep 3600
```

收到如下输出，说明该 Pod 被策略拦截了。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/unsigned was blocked due to the following policies

only-cosign-image-deploy:
  check-image: 'failed to verify image ubuntu:latest:
    .attestors[0].entries[0].keys: no signatures found'
```

### 第 8 步：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE signed

pod "signed" deleted
```

删除该策略。

```shell
$ kubectl delete clusterpolicy only-cosign-image-deploy
```
## 第 2 章：强制基于构建环境的镜像部署

在 ACP（Alauda Container Platform）中，你可以使用 Tekton Chains 自动为镜像生成 SLSA 来源证明。

SLSA 来源证明中有一个 `builder.id` 字段，用于标识镜像的构建环境。本章将使用这个 `builder.id` 字段来验证镜像。

> **提示：**
>
> **由于 Tekton Chains 在准备阶段已经同时处理了镜像签名与 SLSA 来源证明的生成，我们可以直接复用 [第 1 章](#chapter-1-enforcing-image-signature-automated-signing-and-deployment-control) 的流程与镜像。**<br>
> **本章将聚焦于对 SLSA 来源证明的验证。**

本章逐步说明如何实现上述流程。

### 第 1 步：前置条件

请检查前置条件是否已完成，尤其是以下这几节：

- [镜像仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)

如果你想修改默认的 `builder.id`，可以调整 `TektonConfig` 的 `config` 中的 `builder.id` 字段。

> 该流程需要平台管理员权限才能配置。

```shell
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "builder.id": "https://alauda.io/builders/tekton/v1"
    }
  }
}'
```

### 第 2 步：（可选）重新运行流水线以生成镜像

> **提示：**
>
> **如果你修改了 `builder.id` 字段，就需要重新运行流水线来生成镜像。**<br>
> 因为旧镜像并不是用新的 `builder.id` 签名的，会被策略拦截。<br>
> 否则可以跳过本步骤，直接用旧镜像来验证策略。

要重新生成并获取镜像，请依次执行以下步骤：

- [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image)
- [第 1 章：等待流水线被签名](#step-4-wait-for-the-pipelinerun-to-be-signed)
- [第 1 章：从 pipelinerun 中获取镜像](#step-5-get-the-image-from-the-pipelinerun)

### 第 3 步：（可选）使用 cosign 验证构建者信息

> **提示：**
>
> - 本步骤为可选，当你需要用 cosign 验证镜像构建者的真实性时才执行。
> - 如果你想了解如何使用 cue 或 rego 验证构建者信息，可以继续阅读下面的内容。

按照 [获取签名公钥](#get-the-signing-public-key) 一节获取签名公钥。

Cosign 提供了两种 [校验证明](https://docs.sigstore.dev/cosign/verifying/attestation/) 的方式：

- [CUE](https://cuelang.org/)
- [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/)

下面分别演示这两种方式的验证方法。

#### 方式 1：使用 [CUE](https://cuelang.org/) 验证

生成用于验证构建者信息的 CUE 文件。

```cue
// The predicate must match the following constraints.
predicate: {
    builder: {
        id: "https://alauda.io/builders/tekton/v1"
    }
}
```

将该 CUE 文件保存为 `builder.cue`

使用 cosign 验证构建者信息。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.cue $IMAGE
```

收到如下输出，说明构建者信息验证成功。

```text
will be validating against CUE policies: [builder.cue]
will be validating against CUE policies: [builder.cue]

Verification for <registry>/test/chains/demo-1:latest@sha256:8ac1af8dd89652bf32abbbd0c5f667ae9fe6d92c91972617e70b5398303c8e27 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key
{"payloadType":"application/vnd.in-toto+json","payload":"","signatures":[]}
```

把 `builder.cue` 文件中的 builder id 改成另一个值 `https://alauda.io/builders/tekton/v2`，再验证一次。

```shell
$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.cue $IMAGE
```

收到如下输出，说明构建者信息验证失败。

```text
will be validating against CUE policies: [builder.cue]
will be validating against CUE policies: [builder.cue]
There are 2 number of errors occurred during the validation:

- predicate.builder.id: conflicting values "https://alauda.io/builders/tekton/v1" and "https://alauda.io/builders/tekton/v2"
- predicate.builder.id: conflicting values "https://alauda.io/builders/tekton/v1" and "https://alauda.io/builders/tekton/v2"
Error: 2 validation errors occurred
error during command execution: 2 validation errors occurred
```

#### 方式 2：使用 [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/) 验证

生成用于验证构建者信息的 Rego 文件。

```text
package signature

default allow = false

# Define the allowed builder.id
allowed_builder_id = "https://alauda.io/builders/tekton/v1"

# Verify the builder.id
allow {
    # Check if the builder.id in the predicate is equal to the allowed value
    input.predicate.builder.id == allowed_builder_id
}

# Return error message when not match
deny[msg] {
    input.predicate.builder.id != allowed_builder_id
    msg := sprintf("unexpected builder.id: %v, expected: %v", [input.predicate.builder.id, allowed_builder_id])
}
```

将该 Rego 文件保存为 `builder.rego`

使用 cosign 验证构建者信息。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.rego $IMAGE
```

收到如下输出，说明构建者信息验证成功。

```text
will be validating against Rego policies: [builder.rego]
will be validating against Rego policies: [builder.rego]

Verification for <registry>/test/chains/demo-1:latest --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key
{"payloadType":"application/vnd.in-toto+json","payload":"","signatures":[]}
```

把 `builder.rego` 文件中的 builder id 改成另一个值 `https://alauda.io/builders/tekton/v2`，再验证一次。

```shell
$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.rego $IMAGE
```

收到如下输出，说明构建者信息验证失败。

```text
will be validating against Rego policies: [builder.rego]
will be validating against Rego policies: [builder.rego]
There are 2 number of errors occurred during the validation:

- expression value, false, is not true
- expression value, false, is not true
Error: 2 validation errors occurred
error during command execution: 2 validation errors occurred
```

### 第 4 步：使用 Kyverno 验证镜像构建者信息

> 本步骤需要集群管理员权限。

来源证明的内容大致如下，我们将使用其中的 `builder.id` 字段来验证构建环境。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "predicate": {
    "buildType": "tekton.dev/v1beta1/TaskRun",
    "builder": {
      "id": "https://alauda.io/builders/tekton/v1"
    },
    "materials": [
      {
        "digest": {
          "sha256": "8d5ea9ecd9b531e798fecd87ca3b64ee1c95e4f2621d09e893c58ed593bfd4c4"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/buildah"
      }
    ],
    "metadata": {
      "buildFinishedOn": "2025-06-06T10:21:27Z",
      "buildStartedOn": "2025-06-06T10:20:55Z"
    }
  }
}
```

#### 第 4.1 步：创建 Kyverno 策略，只允许部署在特定构建环境中构建的镜像

> 本步骤需要集群管理员权限。

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-tekton-built-images
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # The credential needs to exist in the namespace where kyverno is deployed
              - registry-credentials

          attestations:
            - type: https://slsa.dev/provenance/v0.2
              attestors:
                - entries:
                    - keys:
                        publicKeys: |- # <- The public key of the signer
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true
              conditions:
                - all:
                    - key: "{{ builder.id }}"
                      operator: Equals
                      value: "https://alauda.io/builders/tekton/v1"
                      message: "The builder.id must be equal to https://alauda.io/builders/tekton/v1, not {{ builder.id }}"
```

> 关于 Kyverno ClusterPolicy 的更多细节，请参阅 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- 该策略与 [第 1 章：创建 Kyverno 策略，只允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致，下面只介绍差异部分。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：slsa 来源证明的类型为 `https://slsa.dev/provenance/v0.2` 或 `https://slsa.dev/provenance/v1`。
  - `attestors`：与上文相同。
  - `conditions`：需要校验的条件。
    - `all`：所有条件都必须满足。
      - `key: "{{ builder.id }}"`：这会检查证明中的 `builder.id` 字段是否等于 `https://alauda.io/builders/tekton/v1`

将该策略保存为名为 `kyverno.verify-tekton-built-images.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ kubectl apply -f kyverno.verify-tekton-built-images.yaml

clusterpolicy.kyverno.io/verify-tekton-built-images configured
```

#### 第 4.2 步：验证策略

在定义了该策略的 `policy` 命名空间中，创建一个 Pod 来验证策略。

使用构建出的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ kubectl run -n $NAMESPACE built --image=${IMAGE} -- sleep 3600

pod/built created
```

该 Pod 会创建成功。

```shell
$ kubectl get pod -n $NAMESPACE built

NAME      READY   STATUS    RESTARTS   AGE
built   1/1     Running   0          10s
```

把 `ClusterPolicy` 中的 builder id 改成另一个值 `https://alauda.io/builders/tekton/v2`，再验证一次。

```yaml
conditions:
  - all:
      - key: "{{ builder.id }}"
        operator: Equals
        value: "https://alauda.io/builders/tekton/v2"
        message: "The builder.id must be equal to https://alauda.io/builders/tekton/v2, not {{ builder.id }}"
```

```shell
$ kubectl run -n $NAMESPACE unbuilt --image=${IMAGE} -- sleep 3600
```

收到如下输出，说明该 Pod 被策略拦截了。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/unbuilt was blocked due to the following policies

verify-tekton-built-images:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-1@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046
    and predicate https://slsa.dev/provenance/v0.2: The builder.id must be equal to
    https://alauda.io/builders/tekton/v2, not https://alauda.io/builders/tekton/v1'
```

### 第 5 步：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE built
```

删除该策略。

```shell
$ kubectl delete clusterpolicy verify-tekton-built-images
```
## 第 3 章：强制基于源代码仓库的镜像部署

Tekton Chains 能够从 `PipelineRun` 中收集特定的输入与输出，并把它们记录进 `SLSA Provenance`。

> 更多细节参见上文的 [Tekton Chains 类型提示](#tekton-chains-type-hinting)。

我们可以利用这一能力，把代码仓库信息写入 SLSA Provenance，然后在 kyverno 中对代码仓库进行验证。

本章逐步说明如何实现上述流程。

### 第 1 步：前置条件

请检查前置条件是否已完成，尤其是以下这几节：

- [镜像仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [jq](https://stedolan.github.io/jq/)
  - 用于以友好的方式展示证明的内容。

为避免 Tekton Chains 同时为 TaskRun 和 PipelineRun 生成 SLSA Provenance（这会影响后续 kyverno 的验证），我们先禁用针对 TaskRun 的 SLSA Provenance。

> 该流程需要平台管理员权限才能配置。

```shell
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "artifacts.taskrun.storage": ""
    }
  }
}'
```

### 第 2 步：调整流水线，把代码仓库信息写入镜像来源信息

在之前的镜像构建流水线中，新增一个 `git` clone 任务，并把 `git` 任务的输出保存到 `PipelineRun` 的 `results` 中。

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: chains-demo-3
spec:
  params:
    - default: |-
        echo "Simulate cloning the code and write the repository URL and commit message into the results."

        # This commit sha must be a valid commit sha [0-9a-f]{40}.
        cat << 'EOF' > $(results.array-result.path)
        [
          "https://github.com/tektoncd/pipeline",
          "cccccaaaa0000000000000000000000000000000"
        ]
        EOF

        echo -e "\nResults:"
        echo "-------------------"
        cat $(results.array-result.path)
        echo "-------------------"
        echo -e "\nClone successfully!"
      description: A script to simulate cloning the code and write the repository URL and commit message into the results.
      name: generate-git-clone-results
      type: string
    - default: |-
        echo "Generate a Dockerfile for building an image."

        cat << 'EOF' > Dockerfile
        FROM ubuntu:latest
        ENV TIME=1
        EOF

        echo -e "\nDockerfile contents:"
        echo "-------------------"
        cat Dockerfile
        echo "-------------------"
        echo -e "\nDockerfile generated successfully!"
      description: A script to generate a Dockerfile for building an image.
      name: generate-dockerfile
      type: string
    - default: <registry>/test/chains/demo-3:latest
      description: The target image address built
      name: image
      type: string
  results:
    - description: first image artifact output
      name: first_image_ARTIFACT_OUTPUTS
      type: object
      value:
        digest: $(tasks.build-image.results.IMAGE_DIGEST)
        uri: $(tasks.build-image.results.IMAGE_URL)
    - description: first repo artifact input
      name: source_repo_ARTIFACT_INPUTS
      type: object
      value:
        digest: sha1:$(tasks.git-clone.results.array-result[1])
        uri: $(tasks.git-clone.results.array-result[0])
  tasks:
    - name: git-clone
      params:
        - name: script
          value: $(params.generate-git-clone-results)
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: run-script
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
    - name: generate-dockerfile
      params:
        - name: script
          value: $(params.generate-dockerfile)
      runAfter:
        - git-clone
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: run-script
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
    - name: build-image
      params:
        - name: IMAGES
          value:
            - $(params.image)
        - name: TLS_VERIFY
          value: "false"
      runAfter:
        - generate-dockerfile
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: buildah
          - name: version
            value: "0.9"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
  workspaces:
    - name: source
      description: The workspace for source code.
    - name: dockerconfig
      description: The workspace for Docker configuration.
```

> **注意：**
>
> 本教程为简化流程，直接在流水线内联生成 `Dockerfile` 与 `git-clone` 任务的输出。
> 在生产环境中，你通常会：
>
> 1. 使用 `git-clone` task 从代码仓库拉取源代码
> 2. 使用源代码中已有的 Dockerfile 构建镜像
> 3. 这种做法确保了恰当的版本管理，并保持代码与流水线配置之间的分离

**YAML 字段说明：**

- 大部分字段与 [第 1 章：创建用于构建镜像的流水线](#step-2-create-a-pipeline-to-generate-the-image) 相同，下面只介绍差异部分。
- `params`
  - `generate-git-clone-results`：用于模拟克隆代码、并把仓库 URL 与提交信息写入 results 的脚本。
- `results`
  - `source_repo_ARTIFACT_INPUTS`：源代码仓库的 URL 与提交信息。
    - `digest`：源代码仓库的 commit sha。
  - 该格式符合 Tekton Chains 的约定，更多细节参见上文的 [Tekton Chains 类型提示](#tekton-chains-type-hinting)。


### 第 3 步：运行流水线以生成镜像

这是一个 PipelineRun 资源，用于运行该流水线。

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: chains-demo-3-
spec:
  pipelineRef:
    name: chains-demo-3
  taskRunTemplate:
    serviceAccountName: <default>
  workspaces:
    - name: dockerconfig
      secret:
        secretName: <registry-credentials>
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
          storageClassName: <nfs>
```

**YAML 字段说明：**

- 与 [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 相同。

保存为名为 `chains.demo-3.pipelinerun.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline run resource in the namespace
$ kubectl create -n $NAMESPACE -f chains.demo-3.pipelinerun.yaml
```

等待该 PipelineRun 执行完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-3-<xxxxx>   True        Succeeded   2m         2m
```

### 第 4 步：等待流水线被签名

等待该 PipelineRun 出现 `chains.tekton.dev/signed: "true"` 注解。

```shell
$ export NAMESPACE=<default>
$ export PIPELINERUN_NAME=<chains-demo-3-xxxxx>

$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o yaml | grep "chains.tekton.dev/signed"

    chains.tekton.dev/signed: "true"
```

一旦该 PipelineRun 带上 `chains.tekton.dev/signed: "true"` 注解，就说明镜像已被签名。

### 第 5 步：从 PipelineRun 中获取镜像

```shell
# Get the image URI
$ export IMAGE_URI=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.uri}')

# Get the image digest
$ export IMAGE_DIGEST=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.digest}')

# Combine the image URI and digest to form the full image reference
$ export IMAGE=$IMAGE_URI@$IMAGE_DIGEST

# Print the image reference
$ echo $IMAGE

<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20
```

该镜像将用于后续的代码仓库验证。

### 第 7 步：（可选）获取 SLSA Provenance 证明

> **提示：**
>
> - 如果你对 SLSA Provenance 证明的内容感兴趣，可以继续阅读下面的内容。

按照 [获取签名公钥](#get-the-signing-public-key) 一节获取签名公钥。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出会与下面类似，其中包含 SLSA Provenance 证明。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "subject": [
    {
      "name": "<registry>/test/chains/demo-3:latest",
      "digest": {
        "sha256": "db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20"
      }
    }
  ],
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "predicate": {
    "buildConfig": {
      "tasks": null
    },
    "buildType": "tekton.dev/v1beta1/PipelineRun",
    "builder": {
      "id": "https://alauda.io/builders/tekton/v1"
    },
    "invocation": {
      "parameters": {
        "image": "<registry>/test/chains/demo-3:latest"
      }
    },
    "materials": [
      {
        "digest": {
          "sha256": "bad5d84ded24307d12cacc9ef37fc38bce90ea5d00501f43b27d0c926be26f19"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/run-script"
      },
      {
        "digest": {
          "sha1": "cccccaaaa0000000000000000000000000000000"
        },
        "uri": "https://github.com/tektoncd/pipeline"
      }
    ],
    "metadata": {
      "buildFinishedOn": "2025-06-06T10:28:21Z",
      "buildStartedOn": "2025-06-06T10:27:34Z"
    }
  }
}
```

> 关于 SLSA Provenance 证明的更多细节，请参阅 [SLSA Provenance](https://slsa.dev/spec/v1.1/provenance)

**字段说明：**

- `predicateType`：predicate 的类型。
- `predicate`：
  - `buildConfig`：
    - `tasks`：本次构建的任务。
  - `buildType`：构建的类型，此处为 `tekton.dev/v1beta1/PipelineRun`。
  - `builder`：
    - `id`：构建者的 id，此处为 `https://alauda.io/builders/tekton/v1`。
  - `invocation`：
    - `parameters`：本次构建的参数。
  - `materials`：本次构建的材料。
    - `uri`：
      - `oci://<registry>/devops/tektoncd/hub/run-script`：所用 task 的镜像。
      - `https://github.com/tektoncd/pipeline`：该 task 的源代码仓库。
  - `metadata`：本次构建的元数据。
    - `buildFinishedOn`：构建完成的时间。
    - `buildStartedOn`：构建开始的时间。

### 第 8 步：使用 Kyverno 验证镜像的源代码仓库限制

来源证明的内容大致如下，我们将使用其中的 `materials` 字段来验证代码仓库。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "predicate": {
    "buildType": "tekton.dev/v1beta1/PipelineRun",
    "builder": {
      "id": "https://alauda.io/builders/tekton/v1"
    },
    "materials": [
      {
        "digest": {
          "sha256": "bad5d84ded24307d12cacc9ef37fc38bce90ea5d00501f43b27d0c926be26f19"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/run-script"
      },
      {
        "digest": {
          "sha256": "7a63e6c2d1b4c118e9a974e7850dd3e9321e07feec8302bcbcd16653c512ac59"
        },
        "uri": "http://tekton-hub-api.tekton-pipelines:8000/v1/resource/catalog/task/run-script/0.1/yaml"
      },
      {
        "digest": {
          "sha256": "8d5ea9ecd9b531e798fecd87ca3b64ee1c95e4f2621d09e893c58ed593bfd4c4"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/buildah"
      },
      {
        "digest": {
          "sha256": "3225653d04c223be85d173747372290058a738427768c5668ddc784bf24de976"
        },
        "uri": "http://tekton-hub-api.tekton-pipelines:8000/v1/resource/catalog/task/buildah/0.9/yaml"
      },
      {
        "digest": {
          "sha1": "cccccaaaa0000000000000000000000000000000"
        },
        "uri": "https://github.com/tektoncd/pipeline"
      }
    ],
    "metadata": {
      "buildFinishedOn": "2025-06-06T10:21:27Z",
      "buildStartedOn": "2025-06-06T10:20:38Z"
    }
  }
}
```

#### 第 8.1 步：创建 Kyverno 策略，只允许部署由特定源代码仓库构建的镜像

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-code-repository-material
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # The credential needs to exist in the namespace where kyverno is deployed
              - registry-credentials

          attestations:
            - type: https://slsa.dev/provenance/v0.2
              attestors:
                - entries:
                    - keys:
                        publicKeys: |- # <- The public key of the signer
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true
              conditions:
                - all:
                    - key: "{{ buildType }}"
                      operator: Equals
                      value: "tekton.dev/v1beta1/PipelineRun"
                      message: "The buildType must be equal to tekton.dev/v1beta1/PipelineRun, not {{ buildType }}"

                    - key: "{{ materials[?starts_with(uri, 'https://github.com/tektoncd/')] | length(@) }}"
                      operator: GreaterThan
                      value: 0
                      message: "The materials must have at least one entry starts with https://github.com/tektoncd/, {{ materials }}"
```

> 关于 Kyverno ClusterPolicy 的更多细节，请参阅 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明**

- 该策略与 [第 1 章：创建 Kyverno 策略，只允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致
- `spec.rules[].verifyImages[].attestations[].conditions`：需要校验的条件。
  - `all`：所有条件都必须满足。
    - `key: "{{ buildType }}"`：构建类型必须等于 `tekton.dev/v1beta1/PipelineRun`。
    - `key: "{{ materials[?starts_with(uri, 'https://github.com/tektoncd/')] | length(@) }}"`：materials 中必须至少有一项以 `https://github.com/tektoncd/` 开头。

保存为名为 `verify-code-repository-material.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ kubectl create -f verify-code-repository-material.yaml

clusterpolicy.kyverno.io/verify-code-repository-material created
```

#### 第 8.2 步：验证策略

在定义了该策略的 `policy` 命名空间中，创建一个 Pod 来验证策略。

使用构建出的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20>

$ kubectl run -n $NAMESPACE built-from-specific-repo --image=${IMAGE} -- sleep 3600

pod/built-from-specific-repo created
```

该 Pod 会创建成功。

```shell
$ kubectl get pod -n $NAMESPACE built-from-specific-repo

NAME                      READY   STATUS    RESTARTS   AGE
built-from-specific-repo   1/1     Running   0          10s
```

把 `ClusterPolicy` 中的代码仓库改成另一个值 `https://gitlab.com/`，再验证一次。

```yaml
conditions:
  - all:
      - key: "{{ buildType }}"
        operator: Equals
        value: "tekton.dev/v1beta1/PipelineRun"
        message: "The buildType must be equal to tekton.dev/v1beta1/PipelineRun, not {{ buildType }}"

      - key: "{{ materials[?starts_with(uri, 'https://gitlab.com/')] | length(@) }}"
        operator: GreaterThan
        value: 0
        message: "The materials must have at least one entry starts with https://gitlab.com/, {{ materials }}"
```


```shell
$ kubectl run -n $NAMESPACE unbuilt-from-specific-repo --image=${IMAGE} -- sleep 3600
```

收到如下输出，说明该 Pod 被策略拦截了。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/unbuilt-from-specific-repo was blocked due to the following policies

verify-code-repository-material:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-3:latest and predicate https://slsa.dev/provenance/v0.2:
    The materials must have at least one entry starts with https://gitlab.com/,
    [{"digest":{"sha256":"bad5d84ded24307d12cacc9ef37fc38bce90ea5d00501f43b27d0c926be26f19"},"uri":"oci://<registry>/devops/tektoncd/hub/run-script"},{"digest":{"sha256":"7a63e6c2d1b4c118e9a974e7850dd3e9321e07feec8302bcbcd16653c512ac59"},"uri":"http://tekton-hub-api.tekton-pipelines:8000/v1/resource/catalog/task/run-script/0.1/yaml"},{"digest":{"sha256":"8d5ea9ecd9b531e798fecd87ca3b64ee1c95e4f2621d09e893c58ed593bfd4c4"},"uri":"oci://<registry>/devops/tektoncd/hub/buildah"},{"digest":{"sha256":"3225653d04c223be85d173747372290058a738427768c5668ddc784bf24de976"},"uri":"http://tekton-hub-api.tekton-pipelines:8000/v1/resource/catalog/task/buildah/0.9/yaml"},{"digest":{"sha1":"cccccaaaa0000000000000000000000000000000"},"uri":"https://github.com/tektoncd/pipeline"}]'
```

### 第 9 步：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE built-from-specific-repo
```

删除该策略。

```shell
$ kubectl delete clusterpolicy verify-code-repository-material
```
## 第 4 章：阻止部署存在严重安全漏洞的镜像 {#chapter-4-preventing-deployment-of-images-with-critical-security-vulnerabilities}

在 ACP（Alauda Container Platform）中，你可以使用 Tekton Pipeline 构建镜像并扫描其漏洞。

具体来说，使用 `trivy` task 生成漏洞扫描结果，然后使用 `cosign` 上传漏洞扫描结果的证明，最后使用 `kyverno` 校验该漏洞扫描结果的证明。

本章逐步说明如何实现上述流程。

### 第 1 步：前置条件

请检查前置条件是否已完成，尤其是以下这几节：

- [镜像仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [获取签名 Secret](#get-the-signing-secret)
  - **重要**：这里直接使用 Chains 的全局签名证书只是为了方便。在实际使用中，你可以用一份单独的证书来为镜像漏洞信息签名。
  - 需要把该 secret 导入到流水线执行所在的命名空间。
- [jq](https://stedolan.github.io/jq/)
  - 用于以友好的方式展示证明的内容。

### 第 2 步：创建用于生成 cosign vuln 证明的流水线

这是一个 Pipeline 资源，用于构建镜像并生成 cosign vuln 证明。

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: chains-demo-4
spec:
  params:
    - default: |-
        echo "Generate a Dockerfile for building an image."

        cat << 'EOF' > Dockerfile
        FROM ubuntu:latest
        ENV TIME=1
        EOF

        echo -e "\nDockerfile contents:"
        echo "-------------------"
        cat Dockerfile
        echo "-------------------"
        echo -e "\nDockerfile generated successfully!"
      description: A script to generate a Dockerfile for building an image.
      name: generate-dockerfile
      type: string
    - default: <registry>/test/chains/demo-4:latest
      description: The target image address built
      name: image
      type: string
  results:
    - description: first image artifact output
      name: first_image_ARTIFACT_OUTPUTS
      type: object
      value:
        digest: $(tasks.build-image.results.IMAGE_DIGEST)
        uri: $(tasks.build-image.results.IMAGE_URL)
  tasks:
    - name: generate-dockerfile
      params:
        - name: script
          value: $(params.generate-dockerfile)
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: run-script
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
    - name: build-image
      params:
        - name: IMAGES
          value:
            - $(params.image)
        - name: TLS_VERIFY
          value: "false"
      runAfter:
        - generate-dockerfile
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: buildah
          - name: version
            value: "0.9"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
    - name: trivy-scanner
      params:
        - name: COMMAND
          value: |-
            set -x

            mkdir -p .git

            # support for insecure registry
            export TRIVY_INSECURE=true

            echo "generate cyclonedx sbom"
            trivy image --skip-db-update --skip-java-db-update --scanners vuln --format cyclonedx --output .git/sbom-cyclonedx.json $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST)
            cat .git/sbom-cyclonedx.json

            echo "trivy scan vulnerabilities based on cyclonedx sbom"
            trivy sbom --skip-db-update --skip-java-db-update --format cosign-vuln --output .git/trivy-scan-result.json .git/sbom-cyclonedx.json
            cat .git/trivy-scan-result.json

            echo "trivy scan vulnerabilities based on cyclonedx sbom and output in table format"
            trivy sbom --skip-db-update --skip-java-db-update --format table .git/sbom-cyclonedx.json
      runAfter:
        - build-image
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: trivy-scanner
          - name: version
            value: "0.4"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
    - name: cosign-uploads
      params:
        - name: COMMAND
          value: |-
            set -x

            export COSIGN_ALLOW_INSECURE_REGISTRY=true
            export COSIGN_TLOG_UPLOAD=false
            export COSIGN_KEY=$(workspaces.signkey.path)/cosign.key

            echo "Signing image vuln"
            cosign attest --type vuln --predicate .git/trivy-scan-result.json $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST)

            echo "Signing image sbom"
            cosign attest --type cyclonedx --predicate .git/sbom-cyclonedx.json $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST)
      runAfter:
        - trivy-scanner
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: cosign
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
        - name: signkey
          workspace: signkey
  workspaces:
    - name: source
      description: The workspace for source code.
    - name: dockerconfig
      description: The workspace for Docker configuration.
    - name: signkey
      description: The workspace for private keys and passwords used for image signatures.
```

**YAML 字段说明：**

- 与 [第 1 章：创建用于生成镜像的流水线](#step-2-create-a-pipeline-to-generate-the-image) 相同，但增加了以下内容：
  - `workspaces`：
    - `signkey`：存放镜像签名所用私钥与密码的工作空间。
  - `tasks`：
    - `trivy-scanner`：扫描镜像漏洞的任务。
    - `cosign-uploads`：上传漏洞扫描结果证明的任务。

保存为名为 `chains-demo-4.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline in the namespace
$ kubectl create -n $NAMESPACE -f chains-demo-4.yaml

pipeline.tekton.dev/chains-demo-4 created
```

### 第 3 步：运行流水线以生成 cosign vuln 证明

这是一个 PipelineRun 资源，用于运行该流水线。

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: chains-demo-4-
spec:
  pipelineRef:
    name: chains-demo-4
  taskRunTemplate:
    serviceAccountName: <default>
  workspaces:
    - name: dockerconfig
      secret:
        secretName: <registry-credentials>
    - name: signkey
      secret:
        secretName: <signing-secrets>
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
          storageClassName: <nfs>
```

**YAML 字段说明：**

- 与 [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 相同，下面只介绍差异部分。
- `workspaces`
  - `signkey`：签名密钥的 secret 名称。
    - `secret.secretName`：上一步 [获取签名 Secret](#get-the-signing-secret) 中准备好的签名 secret。但你需要在与该 pipeline run 相同的命名空间中新建一个同样的 secret。

保存为名为 `chains-demo-4.pipelinerun.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline run in the namespace
$ kubectl create -n $NAMESPACE -f chains-demo-4.pipelinerun.yaml
```

等待该 PipelineRun 执行完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-4-<xxxxx>     True        Succeeded   2m  2m
```

### 第 4 步：从 pipelinerun 中获取镜像
> **与 [第 1 章：从 pipelinerun 中获取镜像](#step-5-get-the-image-from-the-pipelinerun) 相同**

### 第 5 步：（可选）获取 cosign vuln 证明

> **提示：**
>
> - 如果你对 cosign vuln 证明的内容感兴趣，可以继续阅读下面的内容。

按照 [获取签名公钥](#get-the-signing-public-key) 一节获取签名公钥。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-4:latest@sha256:5e7b466e266633464741b61b9746acd7d02c682d2e976b1674f924aa0dfa2047>

$ cosign verify-attestation --key cosign.pub --type vuln $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出会与下面类似，其中包含漏洞扫描结果。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://cosign.sigstore.dev/attestation/vuln/v1",
  "predicate": {
    "scanner": {
      "uri": "pkg:github/aquasecurity/trivy@dev",
      "version": "dev",
      "result": {
        "CreatedAt": "2025-06-07T07:05:30.098889688Z",
        "Metadata": {
          "OS": {
            "Family": "ubuntu",
            "Name": "24.04"
          }
        },
        "Results": [
          {
            "Class": "os-pkgs",
            "Packages": [
              {
                "Arch": "amd64",
                "ID": "coreutils@9.4-3ubuntu6",
                "Identifier": {
                  "BOMRef": "pkg:deb/ubuntu/coreutils@9.4-3ubuntu6?arch=amd64&distro=ubuntu-24.04",
                  "PURL": "pkg:deb/ubuntu/coreutils@9.4-3ubuntu6?arch=amd64&distro=ubuntu-24.04",
                  "UID": "82bb3c93286700bc"
                },
                "Licenses": [
                  "GPL-3.0-or-later",
                  "BSD-4-Clause-UC",
                  "GPL-3.0-only",
                  "ISC",
                  "FSFULLR",
                  "GFDL-1.3-no-invariants-only",
                  "GFDL-1.3-only"
                ],
                "Name": "coreutils"
              }
            ],
            "Vulnerabilities": [
              {
                "CVSS": {
                  "nvd": {
                    "V2Score": 2.1,
                    "V2Vector": "AV:L/AC:L/Au:N/C:N/I:P/A:N",
                    "V3Score": 6.5,
                    "V3Vector": "CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:C/C:N/I:H/A:N"
                  },
                  "redhat": {
                    "V2Score": 6.2,
                    "V2Vector": "AV:L/AC:H/Au:N/C:C/I:C/A:C",
                    "V3Score": 8.6,
                    "V3Vector": "CVSS:3.0/AV:L/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H"
                  }
                },
                "InstalledVersion": "9.4-3ubuntu6",
                "LastModifiedDate": "2025-04-20T01:37:25.86Z",
                "PkgID": "coreutils@9.4-3ubuntu6",
                "PkgName": "coreutils",
                "PublishedDate": "2017-02-07T15:59:00.333Z",
                "References": [
                  "http://seclists.org/oss-sec/2016/q1/452",
                  "http://www.openwall.com/lists/oss-security/2016/02/28/2",
                  "http://www.openwall.com/lists/oss-security/2016/02/28/3",
                  "https://access.redhat.com/security/cve/CVE-2016-2781",
                  "https://lists.apache.org/thread.html/rf9fa47ab66495c78bb4120b0754dd9531ca2ff0430f6685ac9b07772%40%3Cdev.mina.apache.org%3E",
                  "https://lore.kernel.org/patchwork/patch/793178/",
                  "https://mirrors.edge.kernel.org/pub/linux/utils/util-linux/v2.28/v2.28-ReleaseNotes",
                  "https://nvd.nist.gov/vuln/detail/CVE-2016-2781",
                  "https://www.cve.org/CVERecord?id=CVE-2016-2781"
                ],
                "Severity": "LOW",
                "SeveritySource": "ubuntu",
                "Status": "affected",
                "VendorSeverity": {
                  "azure": 2,
                  "cbl-mariner": 2,
                  "nvd": 2,
                  "redhat": 2,
                  "ubuntu": 1
                },
                "VulnerabilityID": "CVE-2016-2781"
              }
            ]
          }
        ],
        "SchemaVersion": 2
      }
    },
    "metadata": {
      "scanStartedOn": "2025-06-07T07:05:30.104726629Z",
      "scanFinishedOn": "2025-06-07T07:05:30.104726629Z"
    }
  }
}
```

> 关于 cosign vuln 证明的更多细节，请参阅 [cosign vuln attestation](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)

**字段说明：**

- `predicateType`：predicate 的类型。
- `predicate.scanner`：
  - `uri`：扫描器的 URI。
  - `version`：扫描器的版本。
  - `result`：漏洞扫描的结果。
    - `CreatedAt`：漏洞扫描完成的时间。
    - `Metadata`：
      - `OS.Family`：操作系统的系列。
      - `OS.Name`：操作系统的名称。
    - `Results`：漏洞扫描的结果集。
      - `Class.os-pkgs`：操作系统软件包。
      - `Class.lang-pkgs`：语言级软件包。
      - `Packages`：镜像中的软件包。
      - `Vulnerabilities.Severity`：漏洞的严重级别。
      - `Vulnerabilities.PkgID`：漏洞所属软件包的 id。
      - `Vulnerabilities.PkgName`：漏洞所属软件包的名称。
      - `Vulnerabilities.CVSS.nvd`：该漏洞的 NVD CVSS 评分。
      - `Vulnerabilities.CVSS.redhat`：该漏洞的 Red Hat CVSS 评分。

### 第 6 步：使用 Kyverno 验证漏洞扫描结果

#### 第 6.1 步：创建 Kyverno 策略，拒绝存在高危漏洞的镜像

> 本步骤需要集群管理员权限。
策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: reject-high-risk-image
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # The credential needs to exist in the namespace where kyverno is deployed
              - registry-credentials

          attestations:
            - type: https://cosign.sigstore.dev/attestation/vuln/v1
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- The public key of the signer
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true

              conditions:
                - all:
                    - key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"
                      operator: AllNotIn
                      # supported values: UNKNOWN, LOW, MEDIUM, HIGH, CRITICAL
                      value: ["HIGH", "CRITICAL"]
                      message: |
                        The image contains high-risk vulnerabilities, please fix them before proceeding.
                        Severity levels: {{ scanner.result.Results[].Vulnerabilities[].Severity }}

                    - key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`][] | length(@) }}"
                      operator: Equals
                      value: 0
                      message: |
                        The image contains high-risk vulnerabilities, please fix them before proceeding.
                        High-risk vulnerabilities (CVSS > 1.0): {{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].CVSS.redhat.V3Score[] }}.
                        Severity levels: {{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].Severity[] }}.
                        PkgIDs: {{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].PkgID[] }}.
```

> 关于 Kyverno ClusterPolicy 的更多细节，请参阅 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- 该策略与 [第 1 章：创建 Kyverno 策略，只允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致，下面只介绍差异部分。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cosign vuln 证明的类型为 `https://cosign.sigstore.dev/attestation/vuln/v1`
  - `attestors`：与上文相同。
  - `conditions`：需要校验的条件。
    - `all`：所有条件都必须满足。
      - `key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"`：漏洞的严重级别不得为 `HIGH` 或 `CRITICAL`。
      - `key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`][] | length(@) }}"`：CVSS 评分大于 1.0 的漏洞数量必须为 0。

将该策略保存为名为 `kyverno.reject-high-risk-image.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ kubectl apply -f kyverno.reject-high-risk-image.yaml

clusterpolicy.kyverno.io/reject-high-risk-image configured
```

#### 第 6.2 步：验证策略

在定义了该策略的 `policy` 命名空间中，创建一个 Pod 来验证策略。

使用构建出的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-4:latest@sha256:0f123204c44969876ed12f40066ccccbfd68361f68c91eb313ac764d59428bef>

$ kubectl run -n $NAMESPACE vuln-image --image=${IMAGE} -- sleep 3600
```

如果你的镜像存在高危漏洞，该 Pod 会被策略拦截。
收到的输出如下：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/high-risk was blocked due to the following policies

reject-high-risk-image:
  check-image: |
    image attestations verification failed, verifiedCount: 0, requiredCount: 1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed for <registry>/test/chains/demo-4:latest and predicate https://cosign.sigstore.dev/attestation/vuln/v1: The image contains high-risk vulnerabilities, please fix them before proceeding.
    High-risk vulnerabilities (CVSS > 1.0): [8.6,2.7,6.2,5.9,7.5,4.7,7.4,4.7,7.4,4.7,7.4,4.7,7.4,5.9,3.6,3.6,7.3,4.4,6.5,5.4].
    Severity levels: ["LOW","MEDIUM","LOW","LOW","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","LOW","LOW","LOW","MEDIUM","MEDIUM","MEDIUM","MEDIUM"].
    PkgIDs: ["coreutils@9.4-3ubuntu6","gpgv@2.4.4-2ubuntu17","gpgv@2.4.4-2ubuntu17","libgcrypt20@1.10.3-2build1","liblzma5@5.6.1+really5.4.5-1build0.1","libpam-modules@1.5.3-5ubuntu5.1","libpam-modules@1.5.3-5ubuntu5.1","libpam-modules-bin@1.5.3-5ubuntu5.1","libpam-modules-bin@1.5.3-5ubuntu5.1","libpam-runtime@1.5.3-5ubuntu5.1","libpam-runtime@1.5.3-5ubuntu5.1","libpam0g@1.5.3-5ubuntu5.1","libpam0g@1.5.3-5ubuntu5.1","libssl3t64@3.0.13-0ubuntu3.5","login@1:4.13+dfsg1-4ubuntu3.2","passwd@1:4.13+dfsg1-4ubuntu3.2","perl-base@5.38.2-3.2build2.1","golang.org/x/net@v0.23.0","golang.org/x/net@v0.23.0","stdlib@v1.22.12"].
```

修改 `ClusterPolicy` 中的条件，允许存在高危漏洞、但 CVSS 评分低于 10.0 的镜像。

```yaml
conditions:
  - all:
      - key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"
        operator: AllNotIn
        value: ["CRITICAL"]
        message: |
          The image contains high-risk vulnerabilities, please fix them before proceeding.
          Severity levels: {{ scanner.result.Results[].Vulnerabilities[].Severity }}

      - key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`][] | length(@) }}"
        operator: Equals
        value: 0
        message: |
          The image contains high-risk vulnerabilities, please fix them before proceeding.
          High-risk vulnerabilities (CVSS > 10.0): {{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].CVSS.redhat.V3Score[] }}.
          Severity levels: {{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].Severity[] }}.
          PkgIDs: {{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].PkgID[] }}.
```

然后再次创建 Pod 来验证策略。

```shell
$ kubectl run -n $NAMESPACE vuln-image --image=${IMAGE} -- sleep 3600

pod/vuln-image created
```

该 Pod 会创建成功。

### 第 7 步：（可选）要求漏洞扫描结果在 168 小时以内

> **提示：**
>
> - 如果你想给策略添加更多条件，可以继续阅读下面的内容。

由于 [Cosign 漏洞扫描记录证明](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md) 中包含 `scanFinishedOn` 字段，
且 `trivy` 符合该规范，我们可以利用这个字段来判断漏洞扫描结果是否在 168 小时以内。

只需在 `ClusterPolicy` 中增加一个条件，检查 `scanFinishedOn` 字段是否在 168 小时以内即可。

```yaml
conditions:
  - all:
      - key: "{{ time_since('','{{metadata.scanFinishedOn}}','') }}"
        operator: LessThanOrEquals
        value: "168h"
        message: "The vulnerability scan results must be within 168 hours, not {{ metadata.scanFinishedOn }}"
```

这里不做演示，感兴趣的读者可以自行尝试。

### 第 8 步：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE vuln-image
```

删除该策略。

```shell
$ kubectl delete clusterpolicy reject-high-risk-image
```
## 第 5 章：基础镜像白名单验证 {#chapter-5-base-image-allowlist-verification}

如果我们只想允许部署特定类型的基础镜像，
可以在获取到这一信息后，把它写入镜像证明。

在 [第 4 章](#chapter-4-preventing-deployment-of-images-with-critical-security-vulnerabilities) 中，`cosign-vuln` 格式的证明已经包含了基础镜像信息。
但这里我们换一种做法，使用 `syft` 为镜像生成 SBOM。
SBOM 信息中同样包含基础镜像信息。

在 ACP（Alauda Container Platform）中，你可以在 Tekton Pipeline 中使用 `trivy` 或 `syft` task 为镜像生成 SBOM。
这里我们使用 syft task 来生成 SBOM。

### 第 1 步：前置条件

请检查前置条件是否已完成，尤其是以下这几节：

- [镜像仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [获取签名 Secret](#get-the-signing-secret)
  - **重要**：这里直接使用 Chains 的全局签名证书只是为了方便。在实际使用中，你可以用一份单独的证书来为镜像漏洞信息签名。
  - 需要把该 secret 导入到流水线执行所在的命名空间。
- [jq](https://stedolan.github.io/jq/)
  - 用于以友好的方式展示证明的内容。

### 第 2 步：创建用于生成 SBOM 的流水线

这是一个 Pipeline 资源，用于构建镜像并生成 SBOM。

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: chains-demo-5
spec:
  params:
    - default: |-
        echo "Generate a Dockerfile for building an image."

        cat << 'EOF' > Dockerfile
        FROM ubuntu:latest
        ENV TIME=1
        EOF

        echo -e "\nDockerfile contents:"
        echo "-------------------"
        cat Dockerfile
        echo "-------------------"
        echo -e "\nDockerfile generated successfully!"
      description: A script to generate a Dockerfile for building an image.
      name: generate-dockerfile
      type: string
    - default: <registry>/test/chains/demo-5:latest
      description: The target image address built
      name: image
      type: string
  results:
    - description: first image artifact output
      name: first_image_ARTIFACT_OUTPUTS
      type: object
      value:
        digest: $(tasks.build-image.results.IMAGE_DIGEST)
        uri: $(tasks.build-image.results.IMAGE_URL)
  tasks:
    - name: generate-dockerfile
      params:
        - name: script
          value: $(params.generate-dockerfile)
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: run-script
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
    - name: build-image
      params:
        - name: IMAGES
          value:
            - $(params.image)
        - name: TLS_VERIFY
          value: "false"
      runAfter:
        - generate-dockerfile
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: buildah
          - name: version
            value: "0.9"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
    - name: syft-sbom
      params:
        - name: COMMAND
          value: |-
            set -x

            mkdir -p .git

            echo "Generate sbom.json"
            syft scan $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST) -o cyclonedx-json=.git/sbom.json > /dev/null

            echo -e "\n\n"
            cat .git/sbom.json
            echo -e "\n\n"

            echo "Generate and Attestation sbom"
            syft attest $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST) -o cyclonedx-json
      runAfter:
        - build-image
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: syft
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
        - name: signkey
          workspace: signkey
  workspaces:
    - name: source
      description: The workspace for source code.
    - name: dockerconfig
      description: The workspace for Docker configuration.
    - name: signkey
      description: The workspace for private keys and passwords used for image signatures.
```

**YAML 字段说明：**

- 与 [第 1 章：创建用于生成镜像的流水线](#step-2-create-a-pipeline-to-generate-the-image) 相同，但增加了以下内容：
  - `workspaces`：
    - `signkey`：存放镜像签名所用私钥与密码的工作空间。
  - `tasks`：
    - `syft-sbom`：为镜像生成 SBOM 并上传证明的任务。

### 第 3 步：运行流水线以生成 cosign vuln 证明

这是一个 PipelineRun 资源，用于运行该流水线。

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: chains-demo-5-
spec:
  pipelineRef:
    name: chains-demo-5
  taskRunTemplate:
    serviceAccountName: <default>
  workspaces:
    - name: dockerconfig
      secret:
        secretName: <registry-credentials>
    - name: signkey
      secret:
        secretName: <signing-secrets>
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
          storageClassName: <nfs>
```

**YAML 字段说明：**

- 与 [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 相同，下面只介绍差异部分。
- `workspaces`
  - `signkey`：签名密钥的 secret 名称。
    - `secret.secretName`：上一步 [获取签名 Secret](#get-the-signing-secret) 中准备好的签名 secret。但你需要在与该 pipeline run 相同的命名空间中新建一个同样的 secret。

保存为名为 `chains-demo-5.pipelinerun.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline run in the namespace
$ kubectl create -n $NAMESPACE -f chains-demo-5.pipelinerun.yaml
```

等待该 PipelineRun 执行完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-5-<xxxxx>     True        Succeeded   2m  2m
```

### 第 4 步：从 pipelinerun 中获取镜像
> **与 [第 1 章：从 pipelinerun 中获取镜像](#step-5-get-the-image-from-the-pipelinerun) 相同**

### 第 5 步：（可选）获取 SBOM 证明

> **提示：**
>
> - 如果你对 SBOM 证明的内容感兴趣，可以继续阅读下面的内容。

按照 [获取签名公钥](#get-the-signing-public-key) 一节获取签名公钥。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ cosign verify-attestation --key cosign.pub --type cyclonedx $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出会与下面类似，其中包含镜像的组件信息。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://cyclonedx.org/bom",
  "predicate": {
    "$schema": "http://cyclonedx.org/schema/bom-1.6.schema.json",
    "bomFormat": "CycloneDX",
    "components": [
      {
        "bom-ref": "os:ubuntu@24.04",
        "licenses": [
          {
            "license": {
              "name": "GPL"
            }
          }
        ],
        "description": "Ubuntu 24.04.2 LTS",
        "name": "ubuntu",
        "type": "operating-system",
        "version": "24.04"
      }
    ],
    "metadata": {
      "timestamp": "2025-06-07T09:56:05Z",
      "tools": {
        "components": [
          {
            "author": "anchore",
            "name": "syft",
            "type": "application",
            "version": "1.23.1"
          }
        ]
      }
    }
  }
}
```

> 关于 cyclonedx SBOM 证明的更多细节，请参阅 [cyclonedx SBOM attestation](https://cyclonedx.org/docs/1.6/json/)

**字段说明：**

- `predicateType`：predicate 的类型。
- `predicate`：
  - `components`：镜像中的组件。
    - `bom-ref`：该组件的 BOM 引用。
    - `licenses`：该组件的许可证。
      - `license.name`：许可证的名称。
      - `license.id`：许可证的 id。
    - `name`：组件的名称。
    - `type`：组件的类型。
    - `version`：组件的版本。
  - `metadata`：镜像的元数据。
    - `timestamp`：镜像的时间戳。
    - `tools.components`：所用工具的组件信息。
      - `author`：工具的作者。
      - `name`：工具的名称。
      - `type`：工具的类型。
      - `version`：工具的版本。

### 第 6 步：验证基础镜像信息

#### 第 6.1 步：创建 Kyverno 策略以验证基础镜像信息

> 本步骤需要集群管理员权限。

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-base-image
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # The credential needs to exist in the namespace where kyverno is deployed
              - registry-credentials

          attestations:
            - type: https://cyclonedx.org/bom
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- The public key of the signer
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true

              conditions:
                - any:
                    - key: "{{ components[?type=='operating-system'] | [?name=='ubuntu' && (version=='22.04' || version=='24.04')] | length(@) }}"
                      operator: GreaterThan
                      value: 0
                      message: "The operating system must be Ubuntu 22.04 or 24.04, not {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"

                    - key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"
                      operator: GreaterThan
                      value: 0
                      message: "The operating system must be Alpine 3.18 or 3.20, not {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"
```

**YAML 字段说明：**

- 该策略与 [第 1 章：创建 Kyverno 策略，只允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致，下面只介绍差异部分。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cyclonedx SBOM 证明的类型为 `https://cyclonedx.org/bom`
  - `attestors`：与上文相同。
  - `conditions`：需要校验的条件。
    - `any`：满足任意一个条件即可。
      - `key: "{{ components[?type=='operating-system'] | [?name=='ubuntu' && (version=='22.04' || version=='24.04')] | length(@) }}"`：操作系统必须是 Ubuntu 22.04 或 24.04。
      - `key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"`：操作系统必须是 Alpine 3.18 或 3.20。

将该策略保存为名为 `kyverno.verify-base-image.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ kubectl create -f kyverno.verify-base-image.yaml

clusterpolicy.kyverno.io/verify-base-image created
```

#### 第 6.2 步：验证策略

在定义了该策略的 `policy` 命名空间中，创建一个 Pod 来验证策略。

使用构建出的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ kubectl run -n $NAMESPACE base-image --image=${IMAGE} -- sleep 3600
```

如果你的基础镜像是 Ubuntu 22.04 或 24.04，该 Pod 会创建成功。

修改 `ClusterPolicy` 中的条件，改为只允许 Alpine 3.18 或 3.20。

```yaml
conditions:
  - any:
      - key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"
        operator: GreaterThan
        value: 0
        message: "The operating system must be Alpine 3.18 or 3.20, not {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"
```

然后再创建一个 Pod 来验证策略。

```shell
$ kubectl run -n $NAMESPACE deny-base-image --image=${IMAGE} -- sleep 3600
```

收到的输出如下：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/deny-base-image was blocked due to the following policies

verify-base-image:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-5:latest and predicate https://cyclonedx.org/bom:
    The operating system must be Alpine 3.18 or 3.20, not ["ubuntu"] ["24.04"]'
```
### 第 7 步：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE base-image
```

删除该策略。

```shell
$ kubectl delete clusterpolicy verify-base-image
```
## 第 6 章：许可证合规验证 —— 拒绝含有特定许可证类型的镜像

在 ACP（Alauda Container Platform）中，你可以在 Tekton Pipeline 中使用 `trivy` 或 `syft` task 为镜像生成 SBOM。

SBOM 中包含镜像内每个组件的许可证信息。
我们可以用 Kyverno 策略拒绝那些含有特定许可证的镜像。

由于 [第 5 章](#chapter-5-base-image-allowlist-verification) 中已经为镜像生成过 SBOM，这里不再新建流水线，直接用已有镜像来验证这一能力。

> 本章基于 [第 5 章](#chapter-5-base-image-allowlist-verification)，只是增加了校验镜像许可证信息的逻辑。

### 第 1 步：验证镜像的许可证信息

#### 第 1.1 步：创建 Kyverno 策略以验证基础镜像信息

> 本步骤需要集群管理员权限。

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-component-licenses
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # The credential needs to exist in the namespace where kyverno is deployed
              - registry-credentials

          attestations:
            - type: https://cyclonedx.org/bom
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- The public key of the signer
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true

              conditions:
                - any:
                    # Check if the image contains specific licenses
                    - key: "{{ components[].licenses[].license.id }}"
                      operator: AllNotIn
                      value: ["GPL-3.0-only", "GPL-3.0-or-later"]
                      message: |
                        The image contains GPL licenses which are not allowed.
                        Found licenses: {{ components[].licenses[].license.id }}

                    # Check if the image contains specific license names
                    - key: "{{ components[].licenses[].license.name }}"
                      operator: AllNotIn
                      value: ["GPL"]
                      message: |
                        The image contains Expat license which is not allowed.
                        Found licenses: {{ components[].licenses[].license.name }}
```

**YAML 字段说明：**

- 该策略与 [第 1 章：创建 Kyverno 策略，只允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致，下面只介绍差异部分。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cyclonedx SBOM 证明的类型为 `https://cyclonedx.org/bom`
  - `attestors`：与上文相同。
  - `conditions`：需要校验的条件。
    - `any`：满足任意一个条件即可。
      - `key: "{{ components[].licenses[].license.id }}"`：镜像中含有不被允许的 GPL 许可证。
      - `key: "{{ components[].licenses[].license.name }}"`：镜像中含有不被允许的 Expat 许可证。

将该策略保存为名为 `kyverno.verify-component-licenses.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ kubectl create -f kyverno.verify-component-licenses.yaml

clusterpolicy.kyverno.io/verify-component-licenses created
```

#### 第 1.2 步：验证策略

在定义了该策略的 `policy` 命名空间中，创建一个 Pod 来验证策略。

使用构建出的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ kubectl run -n $NAMESPACE component-licenses --image=${IMAGE} -- sleep 3600
```

如果你的镜像含有 GPL 许可证，该 Pod 会创建失败。

收到的输出如下：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/high-risk was blocked due to the following policies

verify-component-licenses:
  check-image: |
    image attestations verification failed, verifiedCount: 0, requiredCount: 1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed for <registry>/test/chains/demo-5:latest and predicate https://cyclonedx.org/bom: The image contains GPL licenses which are not allowed.
    Found licenses: ["GPL-3.0-only","GPL-3.0-or-later","Latex2e"]
    ; The image contains Expat license which is not allowed.
    Found licenses: [,"GPL","LGPL","public-domain"]
```

修改 `ClusterPolicy` 中的许可证限制，改为允许 GPL 许可证。

```yaml
conditions:
  - any:
    - key: "{{ components[].licenses[].license.id }}"
      operator: AllNotIn
      value: ["GPL-8.0-only"]
      message: |
        The image contains GPL licenses which are not allowed.
        Found licenses: {{ components[].licenses[].license.id }}

    - key: "{{ components[].licenses[].license.name }}"
      operator: AllNotIn
      value: ["GPL-x"]
      message: |
        The image contains Expat license which is not allowed.
        Found licenses: {{ components[].licenses[].license.name }}
```

然后再创建一个 Pod 来验证策略。

```shell
$ kubectl run -n $NAMESPACE component-licenses --image=${IMAGE} -- sleep 3600

pod/component-licenses created
```

该 Pod 会创建成功。

### 第 2 步：（可选）验证镜像是否存在 CVE-2022-42889

> **提示：**
>
> - 如果你想给策略添加更多条件，可以继续阅读下面的内容。

CVE-2022-42889 是 Apache Commons Text 库中的一个严重漏洞，可能导致任意代码执行，影响 1.5 至 1.9 版本。要检测受影响的软件包，可以在 SBOM 中查找版本落在受影响区间内的 "commons-text" 包。下面这条策略会检查 `imageReferences` 所指定镜像的 CycloneDX 格式 SBOM 证明，如果其中含有 1.5-1.9 版本的 commons-text 包就予以拒绝。

只需在 `ClusterPolicy` 中增加一个条件，检查镜像中是否存在 `commons-text` 包即可。

```yaml
conditions:
  - all:
    - key: "{{ components[?name=='commons-text'].version || 'none' }}"
      operator: AllNotIn
      value: ["1.5","1.6","1.7","1.8","1.9"]
```

这里不做演示，感兴趣的读者可以自行尝试。

### 第 3 步：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE component-licenses
```

删除该策略。

```shell
$ kubectl delete clusterpolicy verify-component-licenses
```
## 第 7 章：（可选）无密钥签名验证

> **提示：**
>
> - 如果你对无密钥签名验证感兴趣，可以继续阅读下面的内容。
> - 本章内容要求环境能够访问公网。
> - 但如果你已经部署了私有的 Rekor 服务，也可以使用它。

虽然 ACP（Alauda Container Platform）目前不提供部署私有 Rekor 实例的能力，但它提供了与 Rekor 服务集成的能力。

这里以集成公共 Rekor 为例，介绍如何使用这些服务。
如果你已经部署了私有 Rekor 服务，请参阅相关文档进行配置。

### 第 1 步：前置条件

请检查前置条件是否已完成，尤其是以下这几节：

- [镜像仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [rekor-cli](https://github.com/sigstore/rekor/releases)
  - 用于验证存放在 Rekor 透明日志服务器中的证明，并与之交互。
- [jq](https://stedolan.github.io/jq/)
  - 用于以友好的方式展示签名的内容。

### 第 2 步：配置 Tekton Chains

> 该流程需要平台管理员权限才能配置。

配置 Tekton Chains 的透明日志

```shell
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "transparency.enabled": true
    }
  }
}'
```

> 如果你有私有的 Rekor 服务，可以把 `transparency.url` 设置为你自己 Rekor 服务器的 URL。
> - `transparency.url: "<https://rekor.sigstore.dev>"`

> 关于该配置的更多细节，请参阅 [Transparency Log](https://tekton.dev/docs/chains/config/#transparency-log)

### 第 3 步：重新运行流水线以生成镜像

> **提示：**
>
> - 由于我们修改了透明日志配置，需要在 [第 1 章](#step-3-run-the-pipeline-to-generate-the-image) 中重新触发一次流水线运行。
> - 这样 Tekton Chains 才会为新的镜像和 PipelineRun 生成透明日志条目。

要重新生成并获取镜像，请依次执行以下步骤：

- [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image)
- [第 1 章：等待流水线被签名](#step-4-wait-for-the-pipelinerun-to-be-signed)

### 第 4 步：获取 rekor 日志索引

从 PipelineRun 的注解中获取 rekor 签名。

```shell
$ export NAMESPACE=<pipeline-namespace>
$ export PIPELINERUN_NAME=<pipelinerun-name>
$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.metadata.annotations.chains\.tekton\.dev/transparency}'

https://rekor.sigstore.dev/api/v1/log/entries?logIndex=<232330257>
```

### 第 5 步：通过 curl 获取 rekor 签名

```shell
$ curl -s "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=<232330257>" | jq
```

如果你需要查看 rekor 签名的内容，可以执行以下命令：

```shell
$ curl -s "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=<232330257>" | jq -r '.[keys[0]].attestation.data | @base64d' | jq .

{
  "_type": "https://in-toto.io/Statement/v0.1",
  "subject": null,
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "predicate": {
    "buildType": "tekton.dev/v1beta1/PipelineRun",
    "builder": {
      "id": "https://alauda.io/builders/tekton/v1"
    },
    "materials": [
      {
        "digest": {
          "sha256": "8d5ea9ecd9b531e798fecd87ca3b64ee1c95e4f2621d09e893c58ed593bfd4c4"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/buildah"
      }
    ],
    "metadata": {
      "buildFinishedOn": "2025-06-08T03:11:52Z",
      "buildStartedOn": "2025-06-08T03:10:33Z"
    }
  }
}
```

这段内容与镜像中的证明一致，可用于验证镜像内容的真实性与完整性。
从 Rekor 获取证明信息无需镜像仓库的凭据，因此在验证场景下更加方便、更易获取。

### 第 6 步：通过 rekor-cli 获取 rekor 签名

按日志索引获取签名

```shell
# the log index is same as the one in the annotations of the PipelineRun
$ rekor-cli get --log-index <232330257> --format json | jq -r .Attestation | jq .
```

按镜像 digest 获取签名

```shell
# get the uuid by image digest
$ rekor-cli search --sha da4885861a8304abad71fcdd569c92daf33422073d1102013a1fed615dfb285a

Found matching entries (listed by UUID):
108e9186e8c5677a1364e68001a916d3a7316bc2580bd6b5fbbce39a9c62f13282d3e974a6b434ab

# get the signature by uuid
$ rekor-cli get --uuid 108e9186e8c5677a1364e68001a916d3a7316bc2580bd6b5fbbce39a9c62f13282d3e974a6b434ab --format json | jq -r .Attestation | jq .
```

### 第 7 步：在 Kyverno 中验证 rekor

修改 `ClusterPolicy` 的 `keys` 部分，加入 rekor 验证。

```yaml

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
spec:
  rules:
    - name: check-image
      verifyImages:
        - attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |- # <- The public key of the signer
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                      UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                      -----END PUBLIC KEY-----

                    rekor:
                      ignoreTlog: false
                      # url: <https://rekor.sigstore.dev>
                      # # get the public key from the rekor server
                      # # curl <https://rekor.sigstore.dev>/api/v1/log/publicKey
                      # pubkey: |-
                      #   -----BEGIN PUBLIC KEY-----
                      #   MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr
                      #   kBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==
                      #   -----END PUBLIC KEY-----
```

**YAML 字段说明：**
- `rekor`：rekor 验证的配置。
  - `ignoreTlog`：是否忽略透明日志。
    - 若为 `false`，则会向 rekor 服务器发起验证。
  - `url`：rekor 服务器的 URL。
    - 公共 rekor 服务器为 `https://rekor.sigstore.dev`。
  - `pubkey`：签名者的公钥。
    - 你可以从 rekor 服务器获取该公钥。
      - `curl <https://rekor.sigstore.dev>/api/v1/log/publicKey`

如果你的镜像未被签名，该 Pod 会被拦截。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/sign was blocked due to the following policies

only-cosign-image-deploy:
  check-image: 'failed to verify image <registry>/test/chains/demo-1@sha256:e02263e9f7c215cd5f029cf235d625861afa1d0bccdaba141c5f41f19d482ff2>:
    .attestors[0].entries[0].keys: no matching signatures: signature not found in
    transparency log
```

## 结论

Alauda Container Platform（ACP）通过 OpenSSF SLSA 框架，为软件供应链安全提供了一套完整的解决方案。本文探讨了实现安全、可靠的软件交付所需的关键组件与实现方式：
### 核心安全能力

1. **代码与构建过程安全**
   - 代码仓库来自可信的 git 源
   - 使用 SLSA Provenance 为构建过程提供证明
   - 通过签名与验证保障镜像完整性
   - 现代化的无密钥签名方案
   - 构建环境的验证与加固

2. **依赖与组件安全**
   - 通过漏洞扫描评估安全风险
   - 通过生成 SBOM 建立组件清单
   - 许可证合规验证
   - 第三方依赖校验

3. **分发与部署安全**
   - 基于 Kyverno 的策略化校验
   - 灵活的校验机制
   - 自动化的安全策略实施
   - 运行时环境的安全管控

### 实现架构

1. **核心组件**
   - Tekton Pipelines：用于流水线编排与自动化
   - Tekton Chains：用于 SLSA 合规与制品签名
   - Kyverno：用于策略实施与校验

2. **配套工具**
   - cosign：用于镜像签名与验证
   - syft/trivy：用于生成 SBOM 与漏洞扫描
   - trivy/grype：用于漏洞扫描

3. **实现流程**
   - 阶段 1：生成证明
   - 阶段 2：校验证明

### 主要收益

1. **全面的风险缓解**
   - 确保构建过程的完整性与可追溯性
   - 提供全面的漏洞管理
   - 支持无需密钥管理开销的现代签名方式
   - 覆盖供应链安全的各类主要风险

2. **运维效率**
   - 支持自动化的安全策略实施
   - 减少人工安全检查
   - 简化合规验证流程
   - 降低安全管理复杂度

3. **实现上的灵活性**
   - 每项安全能力都有多种工具可选
   - 校验规则可定制
   - 可与现有 CI/CD 流水线集成
   - 能适配不同的安全要求

通过实施这些供应链安全措施，组织可以显著改善其软件交付流程、降低安全风险，并确保符合行业标准。平台的灵活性让团队能够根据自身的具体需求选择最合适的安全管控手段，同时保持稳健可靠的软件供应链。

## 参考文献

- [SLSA](https://slsa.dev/)
  - [Supply chain threats](https://slsa.dev/spec/v1.1/threats-overview)
  - [Security levels](https://slsa.dev/spec/v1.1/levels)
- [Tekton Chains](https://tekton.dev/docs/chains/)
  - [Chains Configuration](https://tekton.dev/docs/chains/config/)
  - [SLSA Provenance](https://tekton.dev/docs/chains/slsa-provenance/)
  - [Getting To SLSA Level 2 with Tekton and Tekton Chains](https://tekton.dev/blog/2023/04/19/getting-to-slsa-level-2-with-tekton-and-tekton-chains/)
- [Cosign](https://github.com/sigstore/cosign)
  - [Cosign Signature Specifications](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md)
  - [Cosign Vulnerability Scan Record Attestation Specification](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)
  - [Validate In-Toto Attestations](https://docs.sigstore.dev/cosign/verifying/attestation/)
- [Kyverno](https://kyverno.io/)
  - [ClusterPolicy Specification](https://htmlpreview.github.io/?https://github.com/kyverno/kyverno/blob/main/docs/user/crd/index.html)
  - [Kyverno - JMESPath](https://release-1-11-0.kyverno.io/docs/writing-policies/jmespath/)
  - kyverno 提供了一系列 [策略](https://kyverno.io/policies/?policytypes=Security+Tekton+Tekton%2520in%2520CEL+verifyImages)
    - [Check Tekton TaskRun Vulnerability Scan](https://kyverno.io/policies/tekton/verify-tekton-taskrun-vuln-scan/verify-tekton-taskrun-vuln-scan/)：检查高危漏洞
    - [Require Signed Tekton Task](https://kyverno.io/policies/tekton/verify-tekton-taskrun-signatures/verify-tekton-taskrun-signatures/)：要求 Tekton TaskRun 的 TaskRef 中 bundle 带有签名信息
    - [Require Image Vulnerability Scans](https://kyverno.io/policies/other/require-vulnerability-scan/require-vulnerability-scan/)：要求镜像具备 168 小时以内的漏洞扫描信息
    - [Verify Image Check CVE-2022-42889](https://kyverno.io/policies/other/verify-image-cve-2022-42889/verify-image-cve-2022-42889/)：要求镜像不含 CVE-2022-42889 漏洞
