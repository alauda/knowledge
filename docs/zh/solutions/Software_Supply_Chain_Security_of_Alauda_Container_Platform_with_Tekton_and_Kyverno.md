---
id: KB250600001
products:
   - Alauda Container Platform
kind:
   - Solution
sourceSHA: 7e3980ae21e998f2fd0014ace7f2cd8b3264c605d2948ce55999536f20eab834
---

# 基于 Tekton 和 Kyverno 的 Alauda Container Platform 软件供应链安全

## 概述

在当今严重依赖开源和第三方组件的软件开发环境中，供应链攻击正变得日益频繁。从 SolarWinds 事件到 Log4j 漏洞，这些安全事件凸显了软件供应链安全的至关重要性。

软件供应链涵盖软件开发生命周期中涉及的所有实体和过程，从应用开发到 CI/CD 流水线和部署。现代软件通常由多个组件组成，其中包括开源软件，这些组件可能包含漏洞，且往往不在开发者的直接控制之内。这使得供应链安全成为每个组织的一项关键责任。

### 了解软件供应链中的主要风险

- **代码完整性风险**：与对源代码、构建过程或开发环境的未授权修改相关的风险，这些修改可能损害软件完整性。
- **依赖组件风险**：由第三方依赖及其供应链中的漏洞、恶意代码或合规问题引发的风险。
- **构建过程风险**：与构建环境、工具和过程的安全性与完整性相关的风险，可能导致制品被篡改。
- **分发过程风险**：与软件分发渠道安全相关的风险，包括容器镜像仓库、镜像签名和传输安全。
- **部署与运行时风险**：与部署环境、配置管理和运行时依赖的安全性相关的风险。
- **合规风险**：与法律法规要求相关的风险，包括开源许可、数据隐私和行业标准。

### 了解软件供应链安全

#### 供应链安全框架

##### 软件制品供应链层级（SLSA）

软件制品供应链层级（Supply chain Levels for Software Artifacts，SLSA）框架是一份控制措施清单，用于防止篡改、提升完整性，并增强项目、公司或企业所使用的软件包和基础设施的安全性。SLSA 将软件供应链完整性的相关标准形式化，帮助行业和开源生态在软件开发生命周期的各个阶段保障安全。

作为该框架的一部分，SLSA 具有多个保障层级。这些层级包含业界公认的最佳实践，形成四个逐级递增的保障层级。

> [安全层级](https://slsa.dev/spec/v1.1/levels)

| 轨道/层级 | 要求 | 关注点 |
| ----------- | ------------ | ----- |
| Build L0    | （无）       | （不适用） |
| Build L1    | 显示软件包如何构建的 Provenance | 失误、文档 |
| Build L2    | 由托管构建平台生成的签名 Provenance | 构建之后的篡改 |
| Build L3    | 加固的构建平台 | 构建过程中的篡改 |

> Tekton 可以达到 SLSA Level 2 合规。更多信息请参阅 [使用 Tekton 和 Tekton Chains 达到 SLSA Level 2](https://tekton.dev/blog/2023/04/19/getting-to-slsa-level-2-with-tekton-and-tekton-chains/)

#### 安全验证机制

##### 镜像签名

镜像签名用于验证镜像完整性，防止镜像在传输和存储过程中被篡改。它是一种基础的验证机制，只需使用 cosign 即可验证签名。

##### 无密钥签名

无密钥签名是一种现代签名方法，不依赖传统的私钥和公钥对。它使用：
- 用于审计追踪的透明日志

无密钥签名具有以下优势：
- 无需管理私钥
- 无需密钥轮换
- 简化的密钥管理

##### 镜像 attestation

镜像 attestation 用于存储和验证与镜像相关的元数据信息。它提供更丰富的供应链安全信息，例如：

- [SLSA Provenance](#slsa-provenance-integrity-attestation)
- [SBOM](#sbom-software-bill-of-materials)
- [漏洞扫描结果](#vulnerability-scan-results)
- [自定义元数据](#custom-metadata)

##### Attestation 验证

该验证机制高度灵活，可以自定义以校验 attestation 中存在的任何元数据。这意味着存储在 attestation 中的任何信息都可以作为校验条件，使组织能够根据自身特定需求实施精确的安全控制。

attestation 验证的灵活性通过多种校验方法得以体现：

- Kyverno [JMESPath](https://jmespath.org/) 校验
   - 使用 JMESPath 语法进行 JSON 查询和校验

- [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/) 策略校验
   - 利用 Open Policy Agent（OPA）实施复杂策略
   - 支持声明式策略规则和自定义校验逻辑
   - 示例：校验构建者信息和构建环境

- [CUE](https://cuelang.org/) 校验
   - 提供用于校验的类型系统和约束系统
   - 支持 schema 校验和数据一致性检查
   - 支持复杂数据结构校验

#### Attestation 类型

Attestation 类型是用于记录和验证容器镜像各方面信息的标准化格式。这些 attestation 通常使用 cosign 等工具附加到镜像上，并可通过 Kyverno 等策略引擎进行验证。

##### SLSA Provenance（完整性 attestation）

[SLSA Provenance](https://slsa.dev/provenance/v1) 是一套可逐步采用的供应链安全指南，由行业共识确立。它包括：
- 构建过程信息
- 构建环境详情
- 构建时间信息
- 源代码信息
- 依赖信息

predicate 类型：
- https://slsa.dev/provenance/v1
- https://slsa.dev/provenance/v0.2

##### SBOM（软件物料清单）

[SBOM](https://www.ntia.gov/page/software-bill-materials) 是软件的嵌套清单，即构成软件组件的成分列表，包括：
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

##### 漏洞扫描结果

[Cosign 漏洞扫描结果](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md) 记录软件构建过程的安全评估，包括：
- 扫描器信息（名称、版本）
  - 漏洞数据库信息
- 发现的漏洞列表及其严重程度
- 修复建议

predicate 类型：
- https://cosign.sigstore.dev/attestation/vuln/v1

##### 自定义元数据

可以按需添加自定义元数据，以支持特定的安全需求。

例如，grype 可以生成漏洞扫描结果，并将这些结果作为自定义类型上传到镜像仓库。

predicate 类型：
- https://cosign.sigstore.dev/attestation/v1

## 了解实现方法

Alauda Container Platform 利用 OpenSSF SLSA 框架提供全面的供应链安全。平台通过核心组件与专用工具的组合集成多种安全能力：

核心组件：
- Tekton Pipelines：用于流水线编排和自动化
- Tekton Chains：用于 SLSA 合规和制品签名
- Kyverno：用于策略执行和校验

依赖工具：
- cosign：用于镜像签名和验证
- syft/trivy：用于 SBOM 生成和漏洞扫描
- grype：用于漏洞扫描

实现过程分为三个主要阶段：

### 阶段 1：Attestation 生成

| 功能 | 标准化 Predicate 类型 | 工具 | 描述 |
|----------------------------|---------------|------|-------------|
| 镜像签名 | [-](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md) | Tekton Chains | 自动为镜像签名 |
| | | cosign | 手动为镜像签名 |
| SLSA Provenance | - [https://slsa.dev/provenance/v0.2](https://slsa.dev/provenance/v1)<br>- [https://slsa.dev/provenance/v1](https://slsa.dev/provenance/v1) | Tekton Chains | 为镜像生成 SLSA Provenance<br>将 TaskRun 或 PipelineRun 元数据上传到镜像的 SLSA Provenance |
| SBOM | - [https://spdx.dev/Document](https://cyclonedx.org/specification/overview/)<br>- [https://cyclonedx.org/bom](https://cyclonedx.org/specification/overview/) | syft | 生成 SBOM 文件并附加到镜像 |
| | | trivy + cosign | 使用 trivy 生成 SBOM 文件并通过 cosign 附加到镜像 |
| 漏洞扫描结果 | [https://cosign.sigstore.dev/attestation/vuln/v1](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md) | grype + cosign | 使用 grype 生成漏洞扫描结果<br>使用 cosign 将结果附加到镜像 |
| | | trivy + cosign | 使用 trivy 生成漏洞扫描结果<br>使用 cosign 将结果附加到镜像 |
| 自定义元数据 | [https://cosign.sigstore.dev/attestation/v1](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_PREDICATE_SPEC.md) | cosign | 将自定义元数据附加到镜像 |

### 阶段 2：Attestation 校验

| 校验类型 | 校验要求 | 描述 |
|-----------------|------------------------|-------------|
| 镜像签名 | 签名验证 | 要求镜像由特定签名者签名 |
| SLSA Provenance | 构建环境 | 要求镜像构建来源来自特定构建环境 |
| | 源代码 | 要求镜像构建来源来自特定仓库地址 |
| SBOM | 组件要求 | 要求 SBOM 包含或排除特定软件组件或版本 |
| | 基础镜像 | 要求基础镜像为特定名称和版本（操作系统） |
| 漏洞扫描 | 严重漏洞 | 要求扫描结果中不存在严重漏洞 |
| | 扫描时效 | 要求漏洞扫描在特定时间窗口内完成 |
| 自定义元数据 | 自定义要求 | 要求自定义元数据包含或排除特定元数据 |

### 阶段 3：能力集成

Attestation 系统为软件供应链安全提供了灵活且可组合的框架。
你可以组合不同的 attestation 来满足特定的安全需求。

常见用例及其所需能力：

| 章节 | 描述 | 所需能力 | 关键工具 |
|---------|-------------|----------------------|-----------|
| 1 | 镜像签名与验证 | 镜像签名、验证 | Chains、cosign/Kyverno |
| 2 | 构建系统验证 | SLSA Provenance、Attestation 验证 | Chains、Kyverno |
| 3 | 源代码仓库验证 | SLSA Provenance、Attestation 验证 | Git 仓库、Chains、Kyverno |
| 4 | 漏洞扫描验证 | 漏洞扫描结果、Attestation 验证 | grype/trivy、cosign、Kyverno |
| 5 | 基础镜像验证 | SBOM、Attestation 验证 | syft/trivy、cosign、Kyverno |
| 6 | 许可证合规验证 | SBOM、Attestation 验证 | syft/trivy、cosign、Kyverno |
| 7 | （可选）无密钥签名验证 | OIDC 认证、无密钥签名 | Rekor、cosign、Kyverno |

你可以根据自身特定需求自定义这些 attestation。
系统将这些能力集成起来，提供全面的供应链安全保护。

#### 方法 1：镜像签名与验证

此方法使用 Tekton Chains 自动为构建的镜像签名，然后使用 cosign 或 Kyverno 验证签名：

1. 配置 Tekton Chains 自动为构建的镜像签名。
2. 使用 `buildah` Tekton Task 构建镜像。
3. （可选）使用 `cosign` cli 验证签名。
4. 配置 Kyverno 规则，仅允许已签名的镜像。
5. 使用该镜像创建 Pod 以验证签名。

#### 方法 2：构建系统验证

此方法使用 Chains 自动为构建的镜像生成 SLSA Provenance，然后使用 Kyverno 验证 provenance：

1. 配置 Tekton Chains 自动为构建的镜像生成 SLSA Provenance。
2. 使用 `buildah` Tekton Task 构建镜像。
3. （可选）使用 `cosign` cli 验证 attestation。
4. 配置 Kyverno 规则验证 attestation。
5. 使用该镜像创建 Pod 以验证 attestation。

#### 方法 3：源代码仓库验证

此方法使用 Chains 自动为构建的镜像生成 SLSA Provenance，然后使用 Kyverno 验证 provenance：

1. 配置 Tekton Chains 自动为构建的镜像生成 SLSA Provenance。
2. 使用 `git` Tekton Task 获取源代码仓库。
3. 使用 `buildah` Tekton Task 构建镜像。
4. 在 Pipeline 的 results 中声明 `git` 和 `buildah` 的 results 信息。这有助于记录镜像的源代码仓库和 commit 信息。
5. 配置 Kyverno 规则验证源代码仓库。
6. 使用该镜像创建 Pod 以验证源代码仓库。

#### 方法 4：漏洞扫描验证

此方法使用类似 trivy 的工具对镜像进行漏洞扫描，然后使用 Kyverno 验证漏洞扫描结果：

1. 使用 `trivy` Tekton Task 对镜像进行漏洞扫描。
2. 使用 `cosign` Tekton Task 将漏洞扫描结果上传到镜像。
3. 配置 Kyverno 规则验证漏洞扫描结果。
4. 使用该镜像创建 Pod 以验证漏洞扫描结果。

#### 方法 5：基础镜像验证

此方法使用类似 syft 的工具为镜像生成 SBOM，然后使用 Kyverno 验证 SBOM：

1. 使用 `syft` Tekton Task 为镜像生成 SBOM 并附加到镜像。
2. 配置 Kyverno 规则验证 SBOM。
3. 使用该镜像创建 Pod 以验证 SBOM。

#### 方法 6：许可证合规验证

此方法与方法 5 类似，只需修改 kyverno 规则以验证许可证合规性。

1. 配置 Kyverno 规则验证 SBOM。
2. 使用该镜像创建 Pod 以验证 SBOM。

#### 方法 7：（可选）无密钥签名验证

> **注意：**
> - **此方法要求环境能够访问互联网。**<br>
> - 如果你已部署私有 [Rekor](https://github.com/sigstore/rekor) 服务，也可以通过调整相关配置来使用这些能力。<br>
> - 关于部署私有 [Rekor](https://github.com/sigstore/rekor) 服务不在本文档范围内，请参阅相关文档。

此方法使用透明日志来增强安全性，无需进行密钥管理：

1. 配置 Tekton Chains 使用无密钥签名。
2. 使用 `buildah` Tekton Task 构建镜像。
3. 配置 Kyverno 规则验证无密钥签名。
4. 使用该镜像创建 Pod 以验证无密钥签名。

## 通用基础配置

### 环境准备

#### 系统要求

- 已安装 Alauda Container Platform，并具备可用的 Kubernetes 集群
- 已安装 Kubectl 命令行工具及 kubectl-acp 插件，用于 ACP 平台认证
- 已使用 kubectl acp login 命令完成集群认证。
- （可选）本地已安装 cosign cli

#### 所需组件

- Tekton Chains
- Tekton Pipeline
- Kyverno
- 用于存储镜像和签名的 OCI Registry

#### 权限要求

- 配置 Tekton Chains 所需的平台管理员权限
- 配置 Kyverno 策略所需的集群管理员权限
- 创建 namespace 所需的项目级权限
- 推送和拉取镜像所需的镜像仓库访问权限

### 通用配置

#### Tekton Chains

> 此过程需要平台管理员权限进行配置。

##### 生成签名密钥

> **注意：** 此密钥用于生成制品的签名信息，请妥善保管。

你可以使用 [cosign](https://github.com/sigstore/cosign) 工具生成签名密钥。

```shell
$ COSIGN_PASSWORD={password} cosign generate-key-pair k8s://tekton-pipelines/signing-secrets
```

**注意：**

- 你需要已安装 cosign CLI 并能够访问 k8s 集群。
- `COSIGN_PASSWORD` 是用于加密签名密钥的密码。
- `tekton-pipelines` 是部署 Chains 组件的 namespace，默认为 `tekton-pipelines`。
- `signing-secrets` 是用于存储签名密钥的 Secret 名称。

执行完成后，可以查看对应的 Secret 资源。

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

##### 获取签名公钥

> 如果你没有权限，可以请管理员获取公钥。

```shell
$ export NAMESPACE=<tekton-pipelines>
$ kubectl get secret -n $NAMESPACE signing-secrets -o jsonpath='{.data.cosign\.pub}' | base64 -d > cosign.pub
```

##### 获取签名 secret

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

配置 Tekton Chains 自动为 OCI 制品生成签名和 SLSA Provenance。

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

> 如果你的镜像仓库使用自签名证书，需要在 `TektonConfig` 的 `config` 中添加以下配置。
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

> 关于 Tekton Chains 配置的更多细节，请参阅 [Tekton Chains 配置](https://github.com/tektoncd/chains/blob/main/docs/config.md)

> 默认情况下，Tekton Chains 通过 `TektonConfig` 资源自动部署。你可以修改 `TektonConfig` 资源来配置 Chains。<br>
> 本质上，Tekton Operator 会将 Chains 配置从 `TektonConfig` 资源同步到 `TektonChains` 资源，最终体现在 `chains-config` ConfigMap 中。<br>
> 你可以通过 `kubectl get configmaps -n <tekton-pipelines> chains-config -o yaml` 查看配置

#### 镜像仓库配置

> 此过程需要在将要构建和部署镜像的 namespace 中完成。

##### 创建镜像仓库 secret

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

##### 获取镜像仓库 secret

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

#### ServiceAccount 配置

> 此过程需要在将要构建和部署镜像的 namespace 中完成。

将镜像仓库凭证添加到 ServiceAccount，用于镜像构建和签名推送。

```shell
$ export NAMESPACE=<default>
$ export SERVICE_ACCOUNT_NAME=<default>
$ export REGISTRY_CREDENTIALS=<registry-credentials>

$ kubectl patch serviceaccount -n $NAMESPACE $SERVICE_ACCOUNT_NAME \
  -p "{\"imagePullSecrets\": [{\"name\": \"$REGISTRY_CREDENTIALS\"}]}"
```

#### Kyverno 配置

> 此过程需要集群管理员权限进行配置。

由于 Kyverno 需要镜像仓库凭证来验证镜像签名，你需要在部署 Kyverno 的 namespace 中创建镜像仓库 secret。

在我们的环境中，该 namespace 通常是 `kyverno`。

### 基本概念

#### 镜像签名
- 镜像的数字签名，用于确保其完整性和真实性
- 使用 cosign 进行签名和验证
- 支持传统基于密钥的签名和无密钥签名两种方法

#### 镜像 Attestation
- 与镜像相关的元数据信息
- 包括 SLSA Provenance、SBOM、漏洞扫描结果
- 与镜像一起存储在镜像仓库中

#### SLSA Provenance
- 记录软件构建过程的完整性 attestation
- 包括构建过程信息、环境详情、源代码信息
- 有助于验证镜像的构建过程和来源

#### Kyverno 策略
- Kubernetes 的策略引擎
- 用于校验镜像并执行安全策略
- 支持使用 JMESPath 表达式的复杂校验规则

#### Tekton Chains Type Hinting

> 关于 type hinting 的更多细节可参阅 [Tekton Chains Type Hinting](https://tekton.dev/docs/chains/slsa-provenance/#type-hinting) 文档。

Type Hinting 是 Tekton Chains 中的一种特殊机制，通过特定的命名约定帮助 Chains 理解 PipelineRun/TaskRun 中的输入制品和输出制品。

**用途**
- 帮助 Chains 正确识别并记录构建过程中的输入和输出制品
- 生成准确的 SLSA Provenance attestation
- 确保构建过程的可追溯性和完整性

有几种方式可以指定输入和输出制品：

##### **CHAINS-GIT_URL 与 CHAINS-GIT_COMMIT 组合**
- 用于 Git 仓库信息的特殊 type hint
- 用于跟踪源代码仓库详情
- 有助于生成源代码的 provenance
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
- 有助于跟踪依赖和源材料
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
- 可以指定多个镜像，用逗号或换行分隔
- 每个镜像必须包含完整的 digest
  ```yaml
  results:
    - name: IMAGES
      type: string
  ```

##### **\*ARTIFACT_URI / \*ARTIFACT_DIGEST 组合**
- 与 IMAGE_URL/IMAGE_DIGEST 类似，但命名约定不同
- 用于指定制品位置及其 digest
  ```yaml
  results:
    - name: first-ARTIFACT_URI
      type: string
    - name: first-ARTIFACT_DIGEST
      type: string
  ```

##### **\*ARTIFACT_OUTPUTS**
- 使用 object 类型的 results
- 必须包含 uri 和 digest 字段
  ```yaml
  results:
    - name: first-ARTIFACT_OUTPUTS
      type: object
      properties:
        uri: {}
        digest: {}
  ```

## 第 1 章 强制镜像签名：自动签名与部署控制

在 ACP（Alauda Container Platform）中，你可以使用 Tekton Chains 自动为 Tekton Pipeline 构建的镜像签名，并使用 Kyverno 仅允许已签名的镜像被部署。

本章逐步说明如何实现上述过程。

### 步骤 1：前置条件

请检查前置条件是否已完成，特别是以下部分：

- [镜像仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)

### 步骤 2：创建流水线以生成镜像

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
> 本教程通过在流水线中内联生成 `Dockerfile` 来演示简化的工作流。
> 在生产环境中，你通常会：
>
> 1. 使用 `git-clone` task 从你的仓库拉取源代码
> 2. 使用源代码中已有的 Dockerfile 构建镜像
> 3. 这种方式可确保正确的版本控制，并保持代码与流水线配置的分离

**YAML 字段说明：**

- `params`：流水线的参数。
  - `generate-dockerfile`：用于生成构建镜像所需 Dockerfile 的脚本。
  - `image`：构建的目标镜像地址。
- `tasks`：流水线的 tasks。
  - `generate-dockerfile`：生成构建镜像所需 Dockerfile 的 task。
  - `build-image`：构建镜像并推送到镜像仓库的 task。
    - `params.TLS_VERIFY`：是否验证镜像仓库的 TLS 证书。
- `results`：流水线的 results。
  - `first_image_ARTIFACT_OUTPUTS`：第一个镜像制品输出的 result。
    - `digest`：镜像的 digest。
    - `uri`：镜像的 URI。
  - 该格式符合 Tekton Chains 规范，更多细节见上文 [Tekton Chains Type Hinting](#tekton-chains-type-hinting) 部分。
- `workspaces`：流水线的 workspaces。
  - `source`：源代码的 workspace。
  - `dockerconfig`：Docker 配置的 workspace。

**需要调整的配置**
- `params`：
  - `generate-dockerfile`
    - `default`：调整 from 镜像地址。
  - `image`：
    - `default`：构建的目标镜像地址。

保存为名为 `chains.demo-1.pipeline.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline resource in the namespace
$ kubectl apply -n $NAMESPACE -f chains.demo-1.pipeline.yaml
```

### 步骤 3：运行流水线以生成镜像

这是一个 PipelineRun 资源，用于运行流水线。

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
- `taskRunTemplate`：task run 模板。
  - `serviceAccountName`：流水线使用的 service account。
- `workspaces`：流水线的 workspaces。
  - `dockerconfig`：Docker 配置的 workspace。
  - `source`：源代码的 workspace。

**需要调整的配置**

- `taskRunTemplate`：
  - `serviceAccountName`：在前面步骤 [ServiceAccount 配置](#serviceaccount-configuration) 中准备的 service account。
- `workspaces`：
  - `dockerconfig`：
    - `secret.secretName`：在前面步骤 [镜像仓库配置](#registry-configuration) 中准备的镜像仓库 secret。
  - `source`：
    - `volumeClaimTemplate.spec.storageClassName`：volume claim 模板的 storage class 名称。

保存为名为 `chains.demo-1.pipelinerun.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline run resource in the namespace
$ kubectl create -n $NAMESPACE -f chains.demo-1.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-1-<xxxxx>   True        Succeeded   2m         2m
```

### 步骤 4：等待 PipelineRun 被签名

等待 PipelineRun 带有 `chains.tekton.dev/signed: "true"` 注解。

```shell
$ export NAMESPACE=<default>
$ export PIPELINERUN_NAME=<chains-demo-1-xxxxx>

$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o yaml | grep "chains.tekton.dev/signed"

    chains.tekton.dev/signed: "true"
```

一旦 PipelineRun 带有 `chains.tekton.dev/signed: "true"` 注解，即表示镜像已签名。

### 步骤 5：从 PipelineRun 获取镜像

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

该镜像将用于验证签名。

### 步骤 6：（可选）使用 cosign 验证签名

> **提示：**:
>
> - 此步骤是可选的，当你需要通过 cosign 验证镜像签名时执行。
> - 如果你对如何使用 cosign 验证签名感兴趣，可以继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 部分获取签名公钥。

使用 cosign 验证签名。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ cosign verify --key cosign.pub ${IMAGE}
```

收到类似如下输出，表示签名验证成功。

```text
[{"critical":{"identity":{"docker-reference":"<registry>/test/chains/demo-1"},"image":{"docker-manifest-digest":"sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046"},"type":"cosign container image signature"},"optional":null}]
```

你可以使用 `cosign` 验证未签名的镜像。

```shell
$ cosign verify --key cosign.pub ${IMAGE}
```

收到类似如下输出，表示签名验证失败。

```text
Error: no signatures found
error during command execution: no signatures found
```

### 步骤 7：使用 Kyverno 验证签名

#### 步骤 7.1：创建 Kyverno 策略，仅允许已签名的镜像被部署

> 此步骤需要集群管理员权限。

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

- `spec.rules[].match.any[].resources`：要匹配和校验的资源。
  - `kinds`：要匹配和校验的资源类型。
    - `Pod`：Pod 资源。
  - `namespaces`：要匹配和校验的资源所在的 namespace。
    - `policy`：`policy` namespace 中的资源将被匹配和校验。
- `spec.rules[].verifyImages`：镜像验证配置
  - `imageReferences`：要验证的镜像引用。
    - `*`：将验证所有镜像引用。
    - `<registry>/test/*`：仅验证 `<registry>/test` 仓库中的镜像引用。
  - `skipImageReferences`：要跳过的镜像引用。
    - `ghcr.io/trusted/*`：仅跳过 `ghcr.io/trusted` 仓库中的镜像引用。
  - `imageRegistryCredentials`：
    - `allowInsecureRegistry`：是否允许不安全的镜像仓库。
    - `secrets`：用于镜像仓库凭证的 secrets。
      - `registry-credentials`：secret 的名称。该 secret 需要存在于部署 kyverno 的 namespace 中。
  - `attestors`：用于镜像验证的 attestors。
    - `count`：需要匹配的 attestor 数量。
    - `entries`：attestors 的条目。
      - `keys.publicKeys`：attestors 的公钥。该公钥与 `signing-secrets` secret 中的公钥 `cosign.pub` 相同。
      - `keys.ctlog.ignoreSCT`：是否忽略 SCT。在隔离网络环境中，先忽略 SCT。
      - `keys.rekor.ignoreTlog`：是否忽略 Tlog。在隔离网络环境中，先忽略 Tlog。

**需要调整的配置**

- `spec.rules[].attestors[].entries[].keys.publicKeys`：签名者的公钥。
  - 该公钥与 `signing-secrets` secret 中的公钥 `cosign.pub` 相同。
  - 公钥可从 [获取签名公钥](#get-the-signing-public-key) 部分获取。

保存为名为 `kyverno.only-cosign-image-deploy.yaml` 的 yaml 文件，并通过以下命令应用：

```shell
$ kubectl apply -f kyverno.only-cosign-image-deploy.yaml

clusterpolicy.kyverno.io/only-cosign-image-deploy configured
```

#### 步骤 7.2：验证策略

在定义该策略的 `policy` namespace 中，创建一个 Pod 来验证策略。

使用流水线创建的已签名镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ kubectl run -n $NAMESPACE signed --image=${IMAGE} -- sleep 3600

pod/signed created
```

Pod 将创建成功。

```shell
$ export NAMESPACE=<policy>
$ kubectl get pod -n $NAMESPACE signed

NAME      READY   STATUS    RESTARTS   AGE
signed   1/1     Running   0          10s
```

使用未签名的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/unsigned:latest>

$ kubectl run -n $NAMESPACE unsigned --image=${IMAGE} -- sleep 3600
```

收到类似如下输出，表示 Pod 被策略拦截。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/unsigned was blocked due to the following policies

only-cosign-image-deploy:
  check-image: 'failed to verify image ubuntu:latest:
    .attestors[0].entries[0].keys: no signatures found'
```

### 步骤 8：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE signed

pod "signed" deleted
```

删除策略。

```shell
$ kubectl delete clusterpolicy only-cosign-image-deploy
```

## 第 2 章 基于构建环境强制镜像部署

在 ACP（Alauda Container Platform）中，你可以使用 Tekton Chains 自动为镜像生成 SLSA provenance。

在 SLSA provenance 中有一个 `builder.id` 字段，用于表示镜像的构建环境。在本章中，我们将使用该 `builder.id` 字段来验证镜像。

> **提示：**
>
> **由于 Tekton Chains 在准备阶段已经处理了镜像签名和 SLSA provenance 生成，我们可以直接复用 [第 1 章](#chapter-1-enforcing-image-signature-automated-signing-and-deployment-control) 的流程和镜像。**<br>
> **本章我们将重点关注 SLSA provenance 的验证。**

本章逐步说明如何实现上述过程。

### 步骤 1：前置条件

请检查前置条件是否已完成，特别是以下部分：

- [镜像仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)

如果你想更改默认的 `builder.id`，可以调整 `TektonConfig` 的 `config` 中的 `builder.id` 字段。

> 此过程需要平台管理员权限进行配置。

```shell
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "builder.id": "https://alauda.io/builders/tekton/v1"
    }
  }
}'
```

### 步骤 2：（可选）重新运行流水线以生成镜像

> **提示：**
>
> **如果你更改了 `builder.id` 字段，需要重新运行流水线以生成镜像。**<br>
> 因为旧镜像不是用新的 `builder.id` 签名的，所以会被策略拦截。<br>
> 否则，你可以跳过此步骤，使用旧镜像来验证策略。

要重新生成并获取镜像，请按以下步骤操作：

- [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image)
- [第 1 章：等待流水线被签名](#step-4-wait-for-the-pipeline-to-be-signed)
- [第 1 章：从 pipelinerun 获取镜像](#step-5-get-the-image-from-the-pipelinerun)

### 步骤 3：（可选）使用 cosign 验证构建者信息

> **提示：**:
>
> - 此步骤是可选的，当你需要通过 cosign 验证镜像构建者的真实性时执行。
> - 如果你对如何使用 cue 或 rego 验证构建者信息感兴趣，可以继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 部分获取签名公钥。

Cosign 提供两种方式来 [校验 attestation](https://docs.sigstore.dev/cosign/verifying/attestation/)：

- [CUE](https://cuelang.org/)
- [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/)

下面将展示这两种方式的验证方法。

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

将 CUE 文件保存为 `builder.cue`

使用 cosign 验证构建者信息。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.cue $IMAGE
```

收到类似如下输出，表示构建者信息验证成功。

```text
will be validating against CUE policies: [builder.cue]
will be validating against CUE policies: [builder.cue]

Verification for <registry>/test/chains/demo-1:latest@sha256:8ac1af8dd89652bf32abbbd0c5f667ae9fe6d92c91972617e70b5398303c8e27 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key
{"payloadType":"application/vnd.in-toto+json","payload":"","signatures":[]}
```

将 `builder.cue` 文件中的 builder id 更改为另一个值 `https://alauda.io/builders/tekton/v2`，然后再次验证。

```shell
$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.cue $IMAGE
```

收到类似如下输出，表示构建者信息验证失败。

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

将 Rego 文件保存为 `builder.rego`

使用 cosign 验证构建者信息。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.rego $IMAGE
```

收到类似如下输出，表示构建者信息验证成功。

```text
will be validating against Rego policies: [builder.rego]
will be validating against Rego policies: [builder.rego]

Verification for <registry>/test/chains/demo-1:latest --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key
{"payloadType":"application/vnd.in-toto+json","payload":"","signatures":[]}
```

将 `builder.rego` 文件中的 builder id 更改为另一个值 `https://alauda.io/builders/tekton/v2`，然后再次验证。

```shell
$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.rego $IMAGE
```

收到类似如下输出，表示构建者信息验证失败。

```text
will be validating against Rego policies: [builder.rego]
will be validating against Rego policies: [builder.rego]
There are 2 number of errors occurred during the validation:

- expression value, false, is not true
- expression value, false, is not true
Error: 2 validation errors occurred
error during command execution: 2 validation errors occurred
```
### 步骤 4：使用 Kyverno 验证镜像构建者信息

> 此步骤需要集群管理员权限。

provenance 的内容大致如下，我们将使用 `builder.id` 字段来验证构建环境。

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

#### 步骤 4.1：创建 Kyverno 策略，仅允许部署在特定构建环境中构建的镜像

> 此步骤需要集群管理员权限。

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

> 关于 Kyverno ClusterPolicy 的更多细节，请参考 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- 该策略与 [第 1 章：创建 Kyverno 策略以仅允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致。下面仅介绍差异部分。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：slsa provenance 类型为 `https://slsa.dev/provenance/v0.2` 或 `https://slsa.dev/provenance/v1`。
  - `attestors`：与上文相同。
  - `conditions`：需要验证的条件。
    - `all`：必须满足所有条件。
      - `key: "{{ builder.id }}"`：检查 attestation 中的 `builder.id` 字段是否等于 `https://alauda.io/builders/tekton/v1`

将策略保存到名为 `kyverno.verify-tekton-built-images.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl apply -f kyverno.verify-tekton-built-images.yaml

clusterpolicy.kyverno.io/verify-tekton-built-images configured
```

#### 步骤 4.2：验证策略

在定义策略的 `policy` namespace 中，创建一个 Pod 来验证策略。

使用构建出的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ kubectl run -n $NAMESPACE built --image=${IMAGE} -- sleep 3600

pod/built created
```

Pod 将创建成功。

```shell
$ kubectl get pod -n $NAMESPACE built

NAME      READY   STATUS    RESTARTS   AGE
built   1/1     Running   0          10s
```

将 `ClusterPolicy` 中的 builder id 修改为另一个值 `https://alauda.io/builders/tekton/v2`，然后再次验证。

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

收到类似如下的输出，表示该 Pod 已被策略拦截。

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

### 步骤 5：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE built
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-tekton-built-images
```

## 第 3 章 强制执行基于源代码仓库的镜像部署

在 Tekton Chains 中，它可以从 `PipelineRun` 中收集特定的输入和输出，并将其记录在 `SLSA Provenance` 中。

> 更多细节请参见上文的 [Tekton Chains Type Hinting](#tekton-chains-type-hinting) 章节。

我们可以利用这一特性，将代码仓库信息包含到 SLSA Provenance 信息中。然后就可以在 kyverno 中验证代码仓库。

本章将逐步讲解如何实现上述过程。

### 步骤 1：前置条件

请检查前置条件是否已完成，尤其是以下部分：

- [Registry 配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [jq](https://stedolan.github.io/jq/)
  - 用于以友好的方式展示 attestation 的内容。

为了避免 Tekton Chains 同时为 TaskRun 和 PipelineRun 生成 SLSA Provenance（这会影响后续 kyverno 的验证），我们首先禁用 TaskRun 的 SLSA Provenance。

> 此过程需要平台管理员权限进行配置。

```shell
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "artifacts.taskrun.storage": ""
    }
  }
}'
```

### 步骤 2：调整流水线，将代码仓库信息包含到镜像来源信息中

在之前的镜像构建流水线中，添加一个 `git` clone 任务，并将 `git` 任务的输出保存到 `PipelineRun` 的 `results` 中。

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
> 本教程通过在流水线中内联生成 `Dockerfile` 和 `git-clone` 任务输出来演示一个简化的工作流。
> 在生产环境中，通常你会：
>
> 1. 使用 `git-clone` 任务从你的代码仓库拉取源代码
> 2. 使用源代码中已有的 Dockerfile 构建镜像
> 3. 这种方式可以确保正确的版本控制，并保持代码与流水线配置之间的分离

**YAML 字段说明：**

- 大多数字段与 [第 1 章：创建构建镜像的流水线](#step-2-create-a-pipeline-to-generate-the-image) 中相同。下面仅介绍差异部分。
- `params`
  - `generate-git-clone-results`：一个模拟克隆代码并将仓库 URL 与提交信息写入 results 的脚本。
- `results`
  - `source_repo_ARTIFACT_INPUTS`：源代码仓库 URL 与提交信息。
    - `digest`：源代码仓库的 commit sha。
  - 该格式符合 Tekton Chains 的规范，更多细节请参见上文的 [Tekton Chains Type Hinting](#tekton-chains-type-hinting) 章节。


### 步骤 3：运行流水线以生成镜像

这是一个 PipelineRun 资源，用于运行流水线。

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

- 与 [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 中相同。

保存到名为 `chains.demo-3.pipelinerun.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline run resource in the namespace
$ kubectl create -n $NAMESPACE -f chains.demo-3.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-3-<xxxxx>   True        Succeeded   2m         2m
```

### 步骤 4：等待流水线被签名

等待 PipelineRun 带有 `chains.tekton.dev/signed: "true"` 注解。

```shell
$ export NAMESPACE=<default>
$ export PIPELINERUN_NAME=<chains-demo-3-xxxxx>

$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o yaml | grep "chains.tekton.dev/signed"

    chains.tekton.dev/signed: "true"
```

一旦 PipelineRun 带有 `chains.tekton.dev/signed: "true"` 注解，即表示镜像已被签名。

### 步骤 5：从 PipelineRun 中获取镜像

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

该镜像将用于验证代码仓库。

### 步骤 7：（可选）获取 SLSA Provenance attestation

> **提示：**:
>
> - 如果你对 SLSA Provenance attestation 的内容感兴趣，可以继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 章节获取签名公钥。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出将类似于以下内容，其中包含 SLSA Provenance attestation。

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

> 关于 SLSA Provenance attestation 的更多细节，请参考 [SLSA Provenance](https://slsa.dev/spec/v1.1/provenance)

**字段说明：**

- `predicateType`：predicate 的类型。
- `predicate`：
  - `buildConfig`：
    - `tasks`：构建的任务。
  - `buildType`：构建的类型，这里是 `tekton.dev/v1beta1/PipelineRun`。
  - `builder`：
    - `id`：构建者的 id，这里是 `https://alauda.io/builders/tekton/v1`。
  - `invocation`：
    - `parameters`：构建的参数。
  - `materials`：构建的物料。
    - `uri`：
      - `oci://<registry>/devops/tektoncd/hub/run-script`：所使用任务的镜像。
      - `https://github.com/tektoncd/pipeline`：该任务的源代码仓库。
  - `metadata`：构建的元数据。
    - `buildFinishedOn`：构建完成的时间。
    - `buildStartedOn`：构建开始的时间。

### 步骤 8：使用 Kyverno 验证镜像源代码仓库限制

provenance 的内容大致如下，我们将使用 `materials` 字段来验证代码仓库。

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

#### 步骤 8.1：创建 Kyverno 策略，仅允许部署从特定源代码仓库构建的镜像

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

> 关于 Kyverno ClusterPolicy 的更多细节，请参考 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明**

- 该策略与 [第 1 章：创建 Kyverno 策略以仅允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致
- `spec.rules[].verifyImages[].attestations[].conditions`：需要验证的条件。
  - `all`：必须满足所有条件。
    - `key: "{{ buildType }}"`：构建类型必须等于 `tekton.dev/v1beta1/PipelineRun`。
    - `key: "{{ materials[?starts_with(uri, 'https://github.com/tektoncd/')] | length(@) }}"`：materials 中必须至少有一条以 `https://github.com/tektoncd/` 开头的记录。

保存到名为 `verify-code-repository-material.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl create -f verify-code-repository-material.yaml

clusterpolicy.kyverno.io/verify-code-repository-material created
```

#### 步骤 8.2：验证策略

在定义策略的 `policy` namespace 中，创建一个 Pod 来验证策略。

使用构建出的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20>

$ kubectl run -n $NAMESPACE built-from-specific-repo --image=${IMAGE} -- sleep 3600

pod/built-from-specific-repo created
```

Pod 将创建成功。

```shell
$ kubectl get pod -n $NAMESPACE built-from-specific-repo

NAME                      READY   STATUS    RESTARTS   AGE
built-from-specific-repo   1/1     Running   0          10s
```

将 `ClusterPolicy` 中的代码仓库修改为另一个值 `https://gitlab.com/`，然后再次验证。

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

收到类似如下的输出，表示该 Pod 已被策略拦截。

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

### 步骤 9：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE built-from-specific-repo
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-code-repository-material
```

## 第 4 章 阻止部署存在严重安全漏洞的镜像

在 ACP（Alauda Container Platform）中，你可以使用 Tekton Pipeline 构建镜像并扫描镜像漏洞。

具体来说，使用 `trivy` 任务生成漏洞扫描结果，然后使用 `cosign` 上传漏洞扫描结果的 attestation，最后使用 `kyverno` 校验漏洞扫描结果的 attestation。

本章将逐步讲解如何实现上述过程。

### 步骤 1：前置条件

请检查前置条件是否已完成，尤其是以下部分：

- [Registry 配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [获取签名 secret](#get-the-signing-secret)
  - **重要**：这里仅为方便起见，使用了 Chains 的全局签名证书。在实际使用中，你可以使用单独的证书来签名镜像漏洞信息。
  - 将该 secret 导入到执行流水线的 namespace 中。
- [jq](https://stedolan.github.io/jq/)
  - 用于以友好的方式展示 attestation 的内容。

### 步骤 2：创建生成 cosign vuln attestation 的流水线

这是一个 Pipeline 资源，用于构建镜像并生成 cosign vuln attestation。

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

- 与 [第 1 章：创建生成镜像的流水线](#step-2-create-a-pipeline-to-generate-the-image) 中相同，但增加了以下内容：
  - `workspaces`：
    - `signkey`：用于镜像签名的私钥和密码的 workspace。
  - `tasks`：
    - `trivy-scanner`：扫描镜像漏洞的任务。
    - `cosign-uploads`：上传漏洞扫描结果 attestation 的任务。

保存到名为 `chains-demo-4.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline in the namespace
$ kubectl create -n $NAMESPACE -f chains-demo-4.yaml

pipeline.tekton.dev/chains-demo-4 created
```

### 步骤 3：运行流水线以生成 cosign vuln attestation

这是一个 PipelineRun 资源，用于运行流水线。

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

- 与 [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 中相同。下面仅介绍差异部分。
- `workspaces`
  - `signkey`：签名密钥的 secret 名称。
    - `secret.secretName`：上一步 [获取签名 secret](#get-the-signing-secret) 中准备的签名 secret。但你需要在与 pipeline run 相同的 namespace 中创建一个新的 secret。

保存到名为 `chains-demo-4.pipelinerun.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline run in the namespace
$ kubectl create -n $NAMESPACE -f chains-demo-4.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-4-<xxxxx>     True        Succeeded   2m  2m
```

### 步骤 4：从 pipelinerun 中获取镜像
> **与 [第 1 章：从 pipelinerun 中获取镜像](#step-5-get-the-image-from-the-pipelinerun) 相同**

### 步骤 5：（可选）获取 cosign vuln attestation

> **提示：**:
>
> - 如果你对 cosign vuln attestation 的内容感兴趣，可以继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 章节获取签名公钥。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-4:latest@sha256:5e7b466e266633464741b61b9746acd7d02c682d2e976b1674f924aa0dfa2047>

$ cosign verify-attestation --key cosign.pub --type vuln $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出将类似于以下内容，其中包含漏洞扫描结果。

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

> 关于 cosign vuln attestation 的更多细节，请参考 [cosign vuln attestation](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)

**字段说明：**

- `predicateType`：predicate 的类型。
- `predicate.scanner`：
  - `uri`：扫描器的 URI。
  - `version`：扫描器的版本。
  - `result`：漏洞扫描的结果。
    - `CreatedAt`：漏洞扫描完成的时间。
    - `Metadata`：
      - `OS.Family`：操作系统的家族。
      - `OS.Name`：操作系统的名称。
    - `Results`：漏洞扫描的结果。
      - `Class.os-pkgs`：操作系统软件包。
      - `Class.lang-pkgs`：语言软件包。
      - `Packages`：镜像中的软件包。
      - `Vulnerabilities.Severity`：漏洞的严重程度。
      - `Vulnerabilities.PkgID`：漏洞所属软件包的 id。
      - `Vulnerabilities.PkgName`：漏洞所属软件包的名称。
      - `Vulnerabilities.CVSS.nvd`：漏洞的 NVD CVSS 评分。
      - `Vulnerabilities.CVSS.redhat`：漏洞的 Red Hat CVSS 评分。

### 步骤 6：使用 Kyverno 验证漏洞扫描结果

#### 步骤 6.1：创建 Kyverno 策略以拒绝存在高危漏洞的镜像

> 此步骤需要集群管理员权限。

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

> 关于 Kyverno ClusterPolicy 的更多细节，请参考 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- 该策略与 [第 1 章：创建 Kyverno 策略以仅允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致。下面仅介绍差异部分。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cosign vuln attestation 类型为 `https://cosign.sigstore.dev/attestation/vuln/v1`
  - `attestors`：与上文相同。
  - `conditions`：需要验证的条件。
    - `all`：必须满足所有条件。
      - `key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"`：漏洞的严重程度不得为 `HIGH` 或 `CRITICAL`。
      - `key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`][] | length(@) }}"`：CVSS 评分大于 1.0 的漏洞数量必须为 0。

将策略保存到名为 `kyverno.reject-high-risk-image.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl apply -f kyverno.reject-high-risk-image.yaml

clusterpolicy.kyverno.io/reject-high-risk-image configured
```

#### 步骤 6.2：验证策略

在定义策略的 `policy` namespace 中，创建一个 Pod 来验证策略。

使用构建出的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-4:latest@sha256:0f123204c44969876ed12f40066ccccbfd68361f68c91eb313ac764d59428bef>

$ kubectl run -n $NAMESPACE vuln-image --image=${IMAGE} -- sleep 3600
```

如果你的镜像存在高危漏洞，该 Pod 将被策略拦截。
收到类似如下的输出：

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

修改 `ClusterPolicy` 中的条件，允许存在高危漏洞但 CVSS 评分小于 10.0 的镜像。

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

然后再次创建一个 Pod 来验证策略。

```shell
$ kubectl run -n $NAMESPACE vuln-image --image=${IMAGE} -- sleep 3600

pod/vuln-image created
```

Pod 将创建成功。

### 步骤 7：（可选）要求漏洞扫描结果在 168 小时以内

> **提示：**:
>
> - 如果你有兴趣为策略添加更多条件，可以继续阅读以下内容。

由于 [Cosign Vulnerability Scan Record Attestation](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md) 包含 `scanFinishedOn` 字段，
且 `trivy` 符合该规范，我们可以使用此字段来判断漏洞扫描结果是否在 168 小时以内。

我们只需要在 `ClusterPolicy` 中添加一个条件，检查 `scanFinishedOn` 字段是否在 168 小时以内。

```yaml
conditions:
  - all:
      - key: "{{ time_since('','{{metadata.scanFinishedOn}}','') }}"
        operator: LessThanOrEquals
        value: "168h"
        message: "The vulnerability scan results must be within 168 hours, not {{ metadata.scanFinishedOn }}"
```

此处不再演示，感兴趣的读者可以自行尝试。

### 步骤 8：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE vuln-image
```

删除策略。

```shell
$ kubectl delete clusterpolicy reject-high-risk-image
```

## 第 5 章 基础镜像白名单验证

如果我们希望仅允许部署特定类型的基础镜像，
可以在获取到该信息后，将其保存到镜像的 attestation 中。

在 [第 4 章](#chapter-4-preventing-deployment-of-images-with-critical-security-vulnerabilities) 中，`cosign-vuln` 格式的 attestation 已经包含了基础镜像信息。
但这里我们将使用另一种方式，使用 `syft` 为镜像生成 SBOM。
SBOM 信息中同样包含基础镜像信息。

在 ACP（Alauda Container Platform）中，你可以在 Tekton Pipeline 中使用 `trivy` 或 `syft` 任务为镜像生成 SBOM。
这里我们使用 syft 任务生成 SBOM。

### 步骤 1：前置条件

请检查前置条件是否已完成，尤其是以下部分：

- [Registry 配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [获取签名 secret](#get-the-signing-secret)
  - **重要**：这里仅为方便起见，使用了 Chains 的全局签名证书。在实际使用中，你可以使用单独的证书来签名镜像漏洞信息。
  - 将该 secret 导入到执行流水线的 namespace 中。
- [jq](https://stedolan.github.io/jq/)
  - 用于以友好的方式展示 attestation 的内容。

### 步骤 2：创建生成 SBOM 的流水线

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

- 与 [第 1 章：创建生成镜像的流水线](#step-2-create-a-pipeline-to-generate-the-image) 中相同，但增加了以下内容：
  - `workspaces`：
    - `signkey`：用于镜像签名的私钥和密码的 workspace。
  - `tasks`：
    - `syft-sbom`：为镜像生成 SBOM 并上传 attestation 的任务。

### 步骤 3：运行流水线以生成 cosign vuln attestation

这是一个 PipelineRun 资源，用于运行流水线。

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

- 与 [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 中相同。下面仅介绍差异部分。
- `workspaces`
  - `signkey`：签名密钥的 secret 名称。
    - `secret.secretName`：上一步 [获取签名 secret](#get-the-signing-secret) 中准备的签名 secret。但你需要在与 pipeline run 相同的 namespace 中创建一个新的 secret。

保存到名为 `chains-demo-5.pipelinerun.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# create the pipeline run in the namespace
$ kubectl create -n $NAMESPACE -f chains-demo-5.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-5-<xxxxx>     True        Succeeded   2m  2m
```

### 步骤 4：从 pipelinerun 中获取镜像
> **与 [第 1 章：从 pipelinerun 中获取镜像](#step-5-get-the-image-from-the-pipelinerun) 相同**

### 步骤 5：（可选）获取 SBOM attestation

> **提示：**:
>
> - 如果你对 SBOM attestation 的内容感兴趣，可以继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 章节获取签名公钥。

```shell
# Disable tlog upload and enable private infrastructure
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ cosign verify-attestation --key cosign.pub --type cyclonedx $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出将类似于以下内容，其中包含镜像的组件信息。

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

> 关于 cyclonedx SBOM attestation 的更多细节，请参考 [cyclonedx SBOM attestation](https://cyclonedx.org/docs/1.6/json/)

**字段说明：**

- `predicateType`：predicate 的类型。
- `predicate`：
  - `components`：镜像的组件。
    - `bom-ref`：组件的 BOM 引用。
    - `licenses`：组件的许可证。
      - `license.name`：许可证的名称。
      - `license.id`：许可证的 id。
    - `name`：组件的名称。
    - `type`：组件的类型。
    - `version`：组件的版本。
  - `metadata`：镜像的元数据。
    - `timestamp`：镜像的时间戳。
    - `tools.components`：工具的组件。
      - `author`：工具的作者。
      - `name`：工具的名称。
      - `type`：工具的类型。
      - `version`：工具的版本。

### 步骤 6：验证基础镜像信息

#### 步骤 6.1：创建 Kyverno 策略以验证基础镜像信息

> 此步骤需要集群管理员权限。

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

- 该策略与 [第 1 章：创建 Kyverno 策略以仅允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致。下面仅介绍差异部分。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cyclonedx SBOM attestation 类型为 `https://cyclonedx.org/bom`
  - `attestors`：与上文相同。
  - `conditions`：需要验证的条件。
    - `any`：满足任意一个条件即可。
      - `key: "{{ components[?type=='operating-system'] | [?name=='ubuntu' && (version=='22.04' || version=='24.04')] | length(@) }}"`：操作系统必须是 Ubuntu 22.04 或 24.04。
      - `key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"`：操作系统必须是 Alpine 3.18 或 3.20。

将策略保存到名为 `kyverno.verify-base-image.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl create -f kyverno.verify-base-image.yaml

clusterpolicy.kyverno.io/verify-base-image created
```

#### 步骤 6.2：验证策略

在定义策略的 `policy` namespace 中，创建一个 Pod 来验证策略。

使用构建出的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ kubectl run -n $NAMESPACE base-image --image=${IMAGE} -- sleep 3600
```

如果你的基础镜像是 Ubuntu 22.04 或 24.04，Pod 将创建成功。

修改 `ClusterPolicy` 中的条件，仅允许 Alpine 3.18 或 3.20。

```yaml
conditions:
  - any:
      - key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"
        operator: GreaterThan
        value: 0
        message: "The operating system must be Alpine 3.18 or 3.20, not {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"
```

然后创建一个 Pod 来验证策略。

```shell
$ kubectl run -n $NAMESPACE deny-base-image --image=${IMAGE} -- sleep 3600
```

收到类似如下的输出：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/deny-base-image was blocked due to the following policies

verify-base-image:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-5:latest and predicate https://cyclonedx.org/bom:
    The operating system must be Alpine 3.18 or 3.20, not ["ubuntu"] ["24.04"]'
```
### 步骤 7：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE base-image
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-base-image
```

## 第 6 章 许可证合规验证 - 拒绝包含特定许可证类型的镜像

在 ACP（Alauda Container Platform）中，你可以在 Tekton Pipeline 中使用 `trivy` 或 `syft` 任务为镜像生成 SBOM。

SBOM 包含镜像中每个组件的许可证信息。
我们可以使用 Kyverno 策略来拒绝包含特定许可证的镜像。

由于在 [第 5 章](#chapter-5-base-image-allowlist-verification) 中已经为镜像生成了 SBOM，这里我们不再创建流水线，而是直接使用已有的镜像来验证该能力。

> 本章基于 [第 5 章](#chapter-5-base-image-allowlist-verification)，仅增加了校验镜像许可证信息的逻辑。

### 步骤 1：验证镜像的许可证信息

#### 步骤 1.1：创建 Kyverno 策略以验证基础镜像信息

> 此步骤需要集群管理员权限。

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

- 该策略与 [第 1 章：创建 Kyverno 策略以仅允许部署已签名的镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略基本一致。下面仅介绍差异部分。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cyclonedx SBOM attestation 类型为 `https://cyclonedx.org/bom`
  - `attestors`：与上文相同。
  - `conditions`：需要验证的条件。
    - `any`：满足任意一个条件即可。
      - `key: "{{ components[].licenses[].license.id }}"`：镜像包含不被允许的 GPL 许可证。
      - `key: "{{ components[].licenses[].license.name }}"`：镜像包含不被允许的 Expat 许可证。

将策略保存到名为 `kyverno.verify-component-licenses.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl create -f kyverno.verify-component-licenses.yaml

clusterpolicy.kyverno.io/verify-component-licenses created
```

#### 步骤 1.2：验证策略

在定义策略的 `policy` namespace 中，创建一个 Pod 来验证策略。

使用构建出的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ kubectl run -n $NAMESPACE component-licenses --image=${IMAGE} -- sleep 3600
```

如果你的镜像包含 GPL 许可证，Pod 将创建失败。

收到类似如下的输出：

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

修改 `ClusterPolicy` 中的许可证限制，允许 GPL 许可证。

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

然后创建一个 Pod 来验证策略。

```shell
$ kubectl run -n $NAMESPACE component-licenses --image=${IMAGE} -- sleep 3600

pod/component-licenses created
```

Pod 将创建成功。

### 步骤 2：（可选）验证镜像检查 CVE-2022-42889

> **提示：**:
>
> - 如果你有兴趣为策略添加更多条件，可以继续阅读以下内容。

CVE-2022-42889 是 Apache Commons Text 库中的一个严重漏洞，可能导致任意代码执行，影响 1.5 至 1.9 版本。可以通过在 SBOM 中识别带有受影响版本之一的 "commons-text" 软件包来检测受影响的软件包。该策略检查 `imageReferences` 下指定镜像的 CycloneDX 格式已认证 SBOM，如果其中包含 commons-text 软件包的 1.5-1.9 版本，则拒绝该镜像。

我们只需要在 `ClusterPolicy` 中添加一个条件，检查镜像中是否包含 `commons-text` 软件包。

```yaml
conditions:
  - all:
    - key: "{{ components[?name=='commons-text'].version || 'none' }}"
      operator: AllNotIn
      value: ["1.5","1.6","1.7","1.8","1.9"]
```

此处不再演示，感兴趣的读者可以自行尝试。

### 步骤 3：清理资源

删除前面步骤中创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE component-licenses
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-component-licenses
```

## 第 7 章（可选）Keyless 签名验证

> **提示：**:
>
> - 如果你对 keyless 签名验证感兴趣，可以继续阅读以下内容。
> - 本章内容需要能够访问公网。
> - 但如果你已经部署了私有 Rekor 服务，也可以使用它们。

虽然 ACP（Alauda Container Platform）目前不提供部署私有 Rekor 实例的能力，但它提供了与 Rekor 服务的集成能力。

这里我们以集成公共 Rekor 为例，介绍如何使用这些服务。
如果你已经部署了私有 Rekor 服务，请参考相关文档进行配置。

### 步骤 1：前置条件

请检查前置条件是否已完成，尤其是以下部分：

- [Registry 配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [rekor-cli](https://github.com/sigstore/rekor/releases)
  - 用于验证并与存储在 Rekor 透明日志服务器中的 attestation 交互。
- [jq](https://stedolan.github.io/jq/)
  - 用于以友好的方式展示签名的内容。

### 步骤 2：配置 Tekton Chains

> 此过程需要平台管理员权限进行配置。

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

> 如果你有私有 Rekor 服务，可以将 `transparency.url` 设置为你的 Rekor 服务器的 URL。
> - `transparency.url: "<https://rekor.sigstore.dev>"`

> 关于配置的更多细节，请参考 [Transparency Log](https://tekton.dev/docs/chains/config/#transparency-log)

### 步骤 3：重新运行流水线以生成镜像

> **提示：**:
>
> - 由于我们修改了透明日志配置，需要在 [第 1 章](#step-3-run-the-pipeline-to-generate-the-image) 中触发一次新的流水线运行。
> - 这将使 Tekton Chains 为新的镜像和 PipelineRun 生成透明日志条目。

要重新生成并获取镜像，请按以下步骤操作：

- [第 1 章：运行流水线以生成镜像](#step-3-run-the-pipeline-to-generate-the-image)
- [第 1 章：等待流水线被签名](#step-4-wait-for-the-pipeline-to-be-signed)

### 步骤 4：获取 rekor 日志索引

从 PipelineRun 的注解中获取 rekor 签名。

```shell
$ export NAMESPACE=<pipeline-namespace>
$ export PIPELINERUN_NAME=<pipelinerun-name>
$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.metadata.annotations.chains\.tekton\.dev/transparency}'

https://rekor.sigstore.dev/api/v1/log/entries?logIndex=<232330257>
```

### 步骤 5：通过 curl 获取 rekor 签名

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

该内容与镜像中的 attestation 相同，用于验证镜像内容的真实性和完整性。
无需镜像仓库的凭证即可从 Rekor 检索 attestation 信息，使验证更加方便易得。

### 步骤 6：通过 rekor-cli 获取 rekor 签名

通过日志索引获取签名

```shell
# the log index is same as the one in the annotations of the PipelineRun
$ rekor-cli get --log-index <232330257> --format json | jq -r .Attestation | jq .
```

通过镜像 digest 获取签名

```shell
# get the uuid by image digest
$ rekor-cli search --sha da4885861a8304abad71fcdd569c92daf33422073d1102013a1fed615dfb285a

Found matching entries (listed by UUID):
108e9186e8c5677a1364e68001a916d3a7316bc2580bd6b5fbbce39a9c62f13282d3e974a6b434ab

# get the signature by uuid
$ rekor-cli get --uuid 108e9186e8c5677a1364e68001a916d3a7316bc2580bd6b5fbbce39a9c62f13282d3e974a6b434ab --format json | jq -r .Attestation | jq .
```

### 步骤 7：在 Kyverno 中验证 rekor

修改 `ClusterPolicy` 的 `keys` 部分，添加 rekor 验证。

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
- `rekor`：rekor 验证配置。
  - `ignoreTlog`：是否忽略透明日志。
    - 如果为 `false`，将验证 rekor 服务器。
  - `url`：rekor 服务器的 URL。
    - 公共 rekor 服务器为 `https://rekor.sigstore.dev`。
  - `pubkey`：签名者的公钥。
    - 你可以从 rekor 服务器获取公钥。
      - `curl <https://rekor.sigstore.dev>/api/v1/log/publicKey`

如果你的镜像未签名，该 Pod 将被拦截。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/sign was blocked due to the following policies

only-cosign-image-deploy:
  check-image: 'failed to verify image <registry>/test/chains/demo-1@sha256:e02263e9f7c215cd5f029cf235d625861afa1d0bccdaba141c5f41f19d482ff2>:
    .attestors[0].entries[0].keys: no matching signatures: signature not found in
    transparency log
```

## 结论

Alauda Container Platform（ACP）通过 OpenSSF SLSA 框架为实现软件供应链安全提供了全面的解决方案。本文档探讨了实现安全可靠软件交付的关键组件与实现方法：

### 核心安全能力

1. **代码与构建过程安全**
   - 代码仓库来自可信的 git 来源
   - 通过 SLSA Provenance 进行构建过程证明
   - 通过签名与验证保障镜像完整性
   - 现代化的 keyless 签名方案
   - 构建环境验证与加固

2. **依赖与组件安全**
   - 通过漏洞扫描进行安全风险评估
   - 通过生成 SBOM 建立组件清单
   - 许可证合规验证
   - 第三方依赖校验

3. **分发与部署安全**
   - 使用 Kyverno 进行基于策略的校验
   - 灵活的校验机制
   - 自动化的安全策略执行
   - 运行时环境安全控制

### 实现架构

1. **核心组件**
   - Tekton Pipelines：用于流水线编排与自动化
   - Tekton Chains：用于 SLSA 合规与制品签名
   - Kyverno：用于策略执行与校验

2. **支撑工具**
   - cosign：用于镜像签名与验证
   - syft/trivy：用于 SBOM 生成与漏洞扫描
   - trivy/grype：用于漏洞扫描

3. **实现过程**
   - 阶段 1：Attestation 生成
   - 阶段 2：Attestation 校验

### 关键收益

1. **全面的风险缓解**
   - 确保构建过程的完整性与可追溯性
   - 提供全面的漏洞管理
   - 支持无密钥管理负担的现代签名方式
   - 覆盖所有主要的供应链安全风险

2. **运维效率**
   - 支持自动化的安全策略执行
   - 减少人工安全检查
   - 简化合规验证流程
   - 简化安全管理

3. **实现灵活性**
   - 每项安全特性均有多种工具可选
   - 可定制的校验规则
   - 与现有 CI/CD 流水线集成
   - 可适配不同的安全需求

通过实施这些供应链安全措施，组织可以显著改进软件交付过程、降低安全风险，并确保符合行业标准。平台的灵活性使团队能够根据自身具体需求选择最合适的安全控制，同时保持稳健可靠的软件供应链。
## 参考资料

- [SLSA](https://slsa.dev/)
  - [供应链威胁](https://slsa.dev/spec/v1.1/threats-overview)
  - [安全等级](https://slsa.dev/spec/v1.1/levels)
- [Tekton Chains](https://tekton.dev/docs/chains/)
  - [Chains 配置](https://tekton.dev/docs/chains/config/)
  - [SLSA Provenance](https://tekton.dev/docs/chains/slsa-provenance/)
  - [使用 Tekton 和 Tekton Chains 达到 SLSA Level 2](https://tekton.dev/blog/2023/04/19/getting-to-slsa-level-2-with-tekton-and-tekton-chains/)
- [Cosign](https://github.com/sigstore/cosign)
  - [Cosign 签名规范](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md)
  - [Cosign 漏洞扫描记录 Attestation 规范](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)
  - [验证 In-Toto Attestations](https://docs.sigstore.dev/cosign/verifying/attestation/)
- [Kyverno](https://kyverno.io/)
  - [ClusterPolicy 规范](https://htmlpreview.github.io/?https://github.com/kyverno/kyverno/blob/main/docs/user/crd/index.html)
  - [Kyverno - JMESPath](https://release-1-11-0.kyverno.io/docs/writing-policies/jmespath/)
  - kyverno 提供了一系列 [策略](https://kyverno.io/policies/?policytypes=Security+Tekton+Tekton%2520in%2520CEL+verifyImages)
    - [检查 Tekton TaskRun 漏洞扫描](https://kyverno.io/policies/tekton/verify-tekton-taskrun-vuln-scan/verify-tekton-taskrun-vuln-scan/)：检查高危漏洞
    - [要求 Tekton Task 已签名](https://kyverno.io/policies/tekton/verify-tekton-taskrun-signatures/verify-tekton-taskrun-signatures/)：要求 Tekton TaskRun 的 TaskRef 中的 bundle 具有签名信息
    - [要求镜像漏洞扫描](https://kyverno.io/policies/other/require-vulnerability-scan/require-vulnerability-scan/)：要求镜像具有 168h 内的漏洞扫描信息
    - [验证镜像检查 CVE-2022-42889](https://kyverno.io/policies/other/verify-image-cve-2022-42889/verify-image-cve-2022-42889/)：要求镜像不存在 CVE-2022-42889 漏洞
