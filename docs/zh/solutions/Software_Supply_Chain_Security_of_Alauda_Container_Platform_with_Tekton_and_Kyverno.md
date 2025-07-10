---
id: KB250600001
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: 980d661aa1d25a6b54f254394c98e095cee8a5961158cff9433a2876186947e4
---

# Alauda Container Platform 使用 Tekton 和 Kyverno 实现软件供应链安全

## 概述

在当今高度依赖开源和第三方组件的软件开发环境中，供应链攻击日益频繁。从 SolarWinds 事件到 Log4j 漏洞，这些安全事件凸显了软件供应链安全的重要性。

软件供应链涵盖了软件开发生命周期中所有相关实体和流程，从应用开发到 CI/CD 流水线再到部署。现代软件通常由多个组件组成，包括开源软件，这些组件可能存在漏洞且通常不在开发者的直接控制范围内。因此，供应链安全成为每个组织必须承担的重要责任。

### 了解软件供应链中的主要风险

- **代码完整性风险**：与未经授权修改源代码、构建流程或开发环境相关的风险，可能危及软件完整性。
- **依赖组件风险**：源于第三方依赖及其供应链中的漏洞、恶意代码或合规性问题的风险。
- **构建流程风险**：与构建环境、工具及流程的安全和完整性相关的风险，可能导致产物被篡改。
- **分发流程风险**：与软件分发渠道安全相关的风险，包括容器镜像仓库、镜像签名及传输安全。
- **部署及运行时风险**：与部署环境安全、配置管理及运行时依赖相关的风险。
- **合规风险**：与法律法规要求相关的风险，包括开源许可、数据隐私及行业标准。

### 了解软件供应链安全

#### 供应链安全框架

##### 软件产物供应链等级（SLSA）

软件产物供应链等级（SLSA）框架是一套防篡改、提升完整性及增强项目、企业所用包和基础设施安全的控制清单。SLSA 规范了软件供应链完整性的标准，帮助业界和开源生态在软件开发生命周期各阶段保障安全。

作为框架的一部分，SLSA 包含多个保障等级。这些等级涵盖业界公认的最佳实践，形成四个逐级提升的保障层级。

> [安全等级](https://slsa.dev/spec/v1.1/levels)

| 轨道/等级 | 要求                                                     | 关注点                     |
| --------- | -------------------------------------------------------- | -------------------------- |
| Build L0  | （无）                                                   | （不适用）                 |
| Build L1  | 证明包的构建来源                                         | 错误防范、文档             |
| Build L2  | 签名的构建来源，由托管构建平台生成                       | 构建后篡改防护             |
| Build L3  | 加固的构建平台                                           | 构建中篡改防护             |

> Tekton 可实现 SLSA Level 2 合规。详情请参见 [使用 Tekton 和 Tekton Chains 达到 SLSA Level 2](https://tekton.dev/blog/2023/04/19/getting-to-slsa-level-2-with-tekton-and-tekton-chains/)

#### 安全验证机制

##### 镜像签名

镜像签名用于验证镜像完整性，防止传输和存储过程中的篡改。它是一种基础验证机制，仅需使用 cosign 即可验证签名。

##### 无密钥签名

无密钥签名是一种现代签名方式，不依赖传统的公私钥对，而是利用：

- 透明日志实现审计追踪

无密钥签名的优势包括：

- 无需管理私钥
- 无需密钥轮换
- 简化密钥管理

##### 镜像证明

镜像证明用于存储和验证与镜像相关的元数据信息，提供更丰富的供应链安全信息，如：

- [SLSA 证明](#slsa-provenance-integrity-attestation)
- [SBOM](#sbom-software-bill-of-materials)
- [漏洞扫描结果](#vulnerability-scan-results)
- [自定义元数据](#custom-metadata)

##### 证明验证

验证机制高度灵活，可自定义验证证明中的任意元数据。这意味着任何存储在证明中的信息都可作为验证标准，允许组织根据具体需求实现精准的安全控制。

证明验证的灵活性通过多种验证方式体现：

- Kyverno [JMESPath](https://jmespath.org/) 验证
  - 使用 JMESPath 语法进行 JSON 查询和验证

- [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/) 策略验证
  - 利用 Open Policy Agent (OPA) 实现复杂策略执行
  - 支持声明式策略规则和自定义验证逻辑
  - 示例：验证构建者信息和构建环境

- [CUE](https://cuelang.org/) 验证
  - 提供类型系统和约束系统进行验证
  - 支持模式验证和数据一致性检查
  - 支持复杂数据结构验证

#### 证明类型

证明类型是用于记录和验证容器镜像各方面信息的标准化格式。通常通过 cosign 等工具附加到镜像上，并可通过 Kyverno 等策略引擎进行验证。

##### SLSA 证明（完整性证明）

[SLSA 证明](https://slsa.dev/provenance/v1) 是一套逐步可采用的供应链安全指导原则，由业界共识建立。包括：

- 构建流程信息
- 构建环境详情
- 构建时间信息
- 源代码信息
- 依赖信息

谓词类型：

- <https://slsa.dev/provenance/v1>
- <https://slsa.dev/provenance/v0.2>

##### SBOM（软件物料清单）

[SBOM](https://www.ntia.gov/page/software-bill-materials) 是软件的嵌套清单，列出构成软件组件的成分，包括：

- 软件组件
- 组件版本
- 许可证信息
- 依赖关系

SBOM 可采用多种格式，如：

- [SPDX](https://spdx.dev/use/specifications/)
- [CycloneDX](https://cyclonedx.org/specification/overview/)

谓词类型：

- <https://spdx.dev/Document>
- <https://cyclonedx.org/bom>

##### 漏洞扫描结果

[Cosign 漏洞扫描结果](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md) 记录软件构建过程的安全评估，包括：

- 扫描器信息（名称、版本）
  - 漏洞数据库信息
- 发现的漏洞列表及其严重性
- 修复建议

谓词类型：

- <https://cosign.sigstore.dev/attestation/vuln/v1>

##### 自定义元数据

可根据需要添加自定义元数据以支持特定安全需求。

例如，grype 可生成漏洞扫描结果，并将结果作为自定义类型上传至镜像仓库。

谓词类型：

- <https://cosign.sigstore.dev/attestation/v1>

## 实现方法概述

Alauda Container Platform 利用 OpenSSF SLSA 框架提供全面的供应链安全。平台通过核心组件和专用工具的组合集成多项安全能力：

核心组件：

- Tekton Pipelines：流水线编排与自动化
- Tekton Chains：实现 SLSA 合规与产物签名
- Kyverno：策略执行与验证

依赖工具：

- cosign：镜像签名与验证
- syft/trivy：SBOM 生成与漏洞扫描
- grype：漏洞扫描

实现过程分为三个主要阶段：

### 阶段 1：证明生成

| 功能                     | 标准化谓词类型                                                                                                                                             | 工具           | 描述                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| 镜像签名                 | [-](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md)                                                                                   | Tekton Chains  | 自动签名镜像                                                                                           |
|                          |                                                                                                                                                            | cosign         | 手动签名镜像                                                                                           |
| SLSA 证明                | - [https://slsa.dev/provenance/v0.2](https://slsa.dev/provenance/v1)<br>- <https://slsa.dev/provenance/v1>                                                  | Tekton Chains  | 为镜像生成 SLSA 证明<br>上传 TaskRun 或 PipelineRun 元数据至镜像的 SLSA 证明                            |
| SBOM                     | - [https://spdx.dev/Document](https://cyclonedx.org/specification/overview/)<br>- [https://cyclonedx.org/bom](https://cyclonedx.org/specification/overview/) | syft           | 生成 SBOM 文件并附加到镜像                                                                             |
|                          |                                                                                                                                                            | trivy + cosign | 使用 trivy 生成 SBOM 文件并通过 cosign 附加到镜像                                                     |
| 漏洞扫描结果             | [https://cosign.sigstore.dev/attestation/vuln/v1](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)                       | grype + cosign | 使用 grype 生成漏洞扫描结果<br>通过 cosign 附加结果至镜像                                             |
|                          |                                                                                                                                                            | trivy + cosign | 使用 trivy 生成漏洞扫描结果<br>通过 cosign 附加结果至镜像                                             |
| 自定义元数据             | [https://cosign.sigstore.dev/attestation/v1](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_PREDICATE_SPEC.md)                                   | cosign         | 附加自定义元数据到镜像                                                                                 |

### 阶段 2：证明验证

| 验证类型           | 验证要求                 | 描述                                                                 |
| ------------------ | ------------------------ | -------------------------------------------------------------------- |
| 镜像签名           | 签名验证                 | 要求镜像由特定签名者签名                                           |
| SLSA 证明          | 构建环境                 | 要求镜像构建来源于特定构建环境                                     |
|                    | 源代码                   | 要求镜像构建来源于特定代码仓库地址                                 |
| SBOM               | 组件要求                 | 要求 SBOM 包含或排除特定软件组件或版本                             |
|                    | 基础镜像                 | 要求基础镜像为特定名称和版本（操作系统）                           |
| 漏洞扫描           | 关键漏洞                 | 要求扫描结果中无关键漏洞                                           |
|                    | 扫描时间                 | 要求漏洞扫描在特定时间窗口内完成                                   |
| 自定义元数据       | 自定义要求               | 要求自定义元数据包含或排除特定元数据                               |

### 阶段 3：能力集成

证明系统提供灵活且可组合的软件供应链安全框架。您可以组合不同证明以满足特定安全需求。

常见用例及所需能力：

| 章节 | 描述                             | 所需能力                             | 关键工具                      |
| ---- | -------------------------------- | ---------------------------------- | ----------------------------- |
| 1    | 镜像签名与验证                   | 镜像签名、验证                     | Chains、cosign/Kyverno        |
| 2    | 构建系统验证                     | SLSA 证明、证明验证                | Chains、Kyverno               |
| 3    | 源代码仓库验证                   | SLSA 证明、证明验证                | Git 仓库、Chains、Kyverno     |
| 4    | 漏洞扫描验证                     | 漏洞扫描结果、证明验证             | grype/trivy、cosign、Kyverno  |
| 5    | 基础镜像验证                     | SBOM、证明验证                    | syft/trivy、cosign、Kyverno   |
| 6    | 许可证合规验证                   | SBOM、证明验证                    | syft/trivy、cosign、Kyverno   |
| 7    | （可选）无密钥签名验证           | OIDC 认证、无密钥签名              | Rekor、cosign、Kyverno        |

您可以根据具体需求自定义这些证明。系统集成这些能力，提供全面的供应链安全保护。

#### 方法 1：镜像签名与验证

该方法使用 Tekton Chains 自动签名构建的镜像，然后使用 cosign 或 Kyverno 验证签名：

1. 配置 Tekton Chains 自动签名构建的镜像。
2. 使用 `buildah` Tekton 任务构建镜像。
3. （可选）使用 `cosign` CLI 验证签名。
4. 配置 Kyverno 规则，仅允许签名镜像。
5. 使用该镜像创建 Pod 以验证签名。

#### 方法 2：构建系统验证

该方法使用 Chains 自动生成镜像的 SLSA 证明，然后使用 Kyverno 验证证明：

1. 配置 Tekton Chains 自动生成镜像的 SLSA 证明。
2. 使用 `buildah` Tekton 任务构建镜像。
3. （可选）使用 `cosign` CLI 验证证明。
4. 配置 Kyverno 规则验证证明。
5. 使用该镜像创建 Pod 以验证证明。

#### 方法 3：源代码仓库验证

该方法使用 Chains 自动生成镜像的 SLSA 证明，然后使用 Kyverno 验证证明：

1. 配置 Tekton Chains 自动生成镜像的 SLSA 证明。
2. 使用 `git` Tekton 任务获取源代码仓库。
3. 使用 `buildah` Tekton 任务构建镜像。
4. 在 Pipeline 结果中声明 `git` 和 `buildah` 的结果信息，便于记录镜像的源代码仓库和提交信息。
5. 配置 Kyverno 规则验证源代码仓库。
6. 使用该镜像创建 Pod 以验证源代码仓库。

#### 方法 4：漏洞扫描验证

该方法使用类似 trivy 的工具扫描镜像漏洞，然后使用 Kyverno 验证漏洞扫描结果：

1. 使用 `trivy` Tekton 任务扫描镜像漏洞。
2. 使用 `cosign` Tekton 任务上传漏洞扫描结果至镜像。
3. 配置 Kyverno 规则验证漏洞扫描结果。
4. 使用该镜像创建 Pod 以验证漏洞扫描结果。

#### 方法 5：基础镜像验证

该方法使用类似 syft 的工具生成镜像的 SBOM，然后使用 Kyverno 验证 SBOM：

1. 使用 `syft` Tekton 任务生成镜像 SBOM 并附加到镜像。
2. 配置 Kyverno 规则验证 SBOM。
3. 使用该镜像创建 Pod 以验证 SBOM。

#### 方法 6：许可证合规验证

该方法与方法 5 类似，仅更改 Kyverno 规则以验证许可证合规性。

1. 配置 Kyverno 规则验证 SBOM。
2. 使用该镜像创建 Pod 以验证 SBOM。

#### 方法 7：（可选）无密钥签名验证

> **注意：**
>
> - **该方法需要环境能够访问互联网。**<br>
> - 如果您已部署私有 [Rekor](https://github.com/sigstore/rekor) 服务，也可通过调整相关配置使用该能力。<br>
> - 私有 [Rekor](https://github.com/sigstore/rekor) 服务的部署不在本文档范围，请参考相关文档。

该方法使用透明日志提升安全性，免除密钥管理：

1. 配置 Tekton Chains 使用无密钥签名。
2. 使用 `buildah` Tekton 任务构建镜像。
3. 配置 Kyverno 规则验证无密钥签名。
4. 使用该镜像创建 Pod 以验证无密钥签名。

## 常见基础配置

### 环境准备

#### 系统要求

- 已安装 Alauda Container Platform 并具备可用 Kubernetes 集群
- 安装 kubectl 命令行工具及 kubectl-acp 插件以认证 ACP 平台
- 使用 `kubectl acp login` 命令完成集群认证
- （可选）本地安装 cosign CLI

#### 必需组件

- Tekton Chains
- Tekton Pipeline
- Kyverno
- 用于存储镜像和签名的 OCI Registry

#### 权限要求

- 配置 Tekton Chains 需平台管理员权限
- 配置 Kyverno 策略需集群管理员权限
- 创建命名空间需项目级权限
- 镜像推拉需仓库访问权限

### 通用配置

#### Tekton Chains

> 该过程需要平台管理员权限进行配置。

##### 生成签名密钥

> **注意：** 此密钥用于生成产物的签名信息，请妥善保管。

您可以使用 [cosign](https://github.com/sigstore/cosign) 工具生成签名密钥。

```sh
$ COSIGN_PASSWORD={password} cosign generate-key-pair k8s://tekton-pipelines/signing-secrets
```

**注意：**

- 需要安装 cosign CLI 并能访问 k8s 集群。
- `COSIGN_PASSWORD` 是用于加密签名密钥的密码。
- `tekton-pipelines` 是 Chains 组件部署的命名空间，默认即为 `tekton-pipelines`。
- `signing-secrets` 是存储签名密钥的 Secret 名称。

执行完成后，可查看对应的 Secret 资源。

```sh
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

> 若无权限，可向管理员索取公钥。

```sh
$ export NAMESPACE=<tekton-pipelines>
$ kubectl get secret -n $NAMESPACE signing-secrets -o jsonpath='{.data.cosign\.pub}' | base64 -d > cosign.pub
```

##### 获取签名密钥 Secret

```sh
$ export NAMESPACE=<tekton-pipelines>
$ kubectl get secret -n $NAMESPACE signing-secrets -o yaml > signing-secrets.yaml
```

##### 重启 Tekton Chains 组件使签名密钥生效

```sh
$ kubectl delete pods -n tekton-pipelines -l app=tekton-chains-controller
```

等待组件启动。

```sh
$ kubectl get pods -n tekton-pipelines -l app=tekton-chains-controller -w

NAME                                        READY   STATUS    RESTARTS   AGE
tekton-chains-controller-55876dfbbd-5wv5z   1/1     Running   0          1m30s
```

##### Tekton Chains 配置

配置 Tekton Chains 自动为 OCI 产物生成签名和 SLSA 证明。

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

> 若您的仓库使用自签名证书，需要向 `TektonConfig` 的 `config` 添加以下配置：
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

> 更多 Tekton Chains 配置详情，请参见 [Tekton Chains Configuration](https://github.com/tektoncd/chains/blob/main/docs/config.md)

> 默认情况下，Tekton Chains 通过 `TektonConfig` 资源自动部署。您可以修改 `TektonConfig` 资源配置 Chains。<br>
> 本质上，Tekton Operator 会将 Chains 配置从 `TektonConfig` 同步到 `TektonChains` 资源，最终反映在 `chains-config` ConfigMap 中。<br>
> 可通过 `kubectl get configmaps -n <tekton-pipelines> chains-config -o yaml` 查看配置。

#### 仓库配置

> 该过程需在构建和部署镜像的命名空间中完成。

##### 创建仓库 Secret

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

##### 获取仓库 Secret

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

> 该过程需在构建和部署镜像的命名空间中完成。

将仓库凭证添加至 ServiceAccount，用于镜像构建和签名推送。

```shell
$ export NAMESPACE=<default>
$ export SERVICE_ACCOUNT_NAME=<default>
$ export REGISTRY_CREDENTIALS=<registry-credentials>

$ kubectl patch serviceaccount -n $NAMESPACE $SERVICE_ACCOUNT_NAME \
  -p "{\"imagePullSecrets\": [{\"name\": \"$REGISTRY_CREDENTIALS\"}]}"
```

#### Kyverno 配置

> 该过程需要集群管理员权限进行配置。

由于 Kyverno 需要仓库凭证验证镜像签名，需在 Kyverno 部署命名空间创建仓库 Secret。

在我们的环境中，命名空间通常为 `kyverno`。

### 基础概念

#### 镜像签名

- 镜像的数字签名，确保其完整性和真实性
- 使用 cosign 进行签名和验证
- 支持传统基于密钥和无密钥签名方式

#### 镜像证明

- 与镜像相关的元数据信息
- 包含 SLSA 证明、SBOM、漏洞扫描结果
- 与镜像一同存储于仓库

#### SLSA 证明

- 记录软件构建过程的完整性证明
- 包含构建流程信息、环境详情、源代码信息
- 有助于验证镜像的构建过程和来源

#### Kyverno 策略

- Kubernetes 的策略引擎
- 用于验证镜像和执行安全策略
- 支持使用 JMESPath 表达式的复杂验证规则

#### Tekton Chains 类型提示

> 更多类型提示详情请参见 [Tekton Chains Type Hinting](https://tekton.dev/docs/chains/slsa-provenance/#type-hinting) 文档。

类型提示是 Tekton Chains 中的一种特殊机制，通过特定命名约定帮助 Chains 理解 PipelineRun/TaskRun 中的输入和输出产物。

**目的**

- 帮助 Chains 正确识别和记录构建过程中的输入输出产物
- 生成准确的 SLSA 证明
- 确保构建过程的可追溯性和完整性

指定输入输出产物的方式有多种：

##### **CHAINS-GIT_URL 和 CHAINS-GIT_COMMIT 组合**

- Git 仓库信息的特殊类型提示
- 用于追踪源代码仓库详情
- 有助于生成源代码的证明

```yaml
results:
  - name: CHAINS-GIT_URL
    type: string
  - name: CHAINS-GIT_COMMIT
    type: string
```

##### **\*ARTIFACT_INPUTS**

> **注意：**
>
> - `*` 表示任意表达式

- 用于指定影响构建过程的输入产物
- 有助于追踪依赖和源材料

```yaml
results:
  - name: first-ARTIFACT_INPUTS
    type: object
    properties:
      uri: {}
      digest: {}
```

##### **\*IMAGE_URL 和 \*IMAGE_DIGEST 组合**

```yaml
results:
  - name: first-image-IMAGE_URL
    type: string
  - name: first-image-IMAGE_DIGEST
    type: string
```

##### **IMAGES**

- 可指定多个镜像，使用逗号或换行分隔
- 每个镜像必须包含完整的摘要

```yaml
results:
  - name: IMAGES
    type: string
```

##### **\*ARTIFACT_URI / \*ARTIFACT_DIGEST 组合**

- 类似 IMAGE_URL/IMAGE_DIGEST，但命名不同
- 用于指定产物位置及其摘要

```yaml
results:
  - name: first-ARTIFACT_URI
    type: string
  - name: first-ARTIFACT_DIGEST
    type: string
```

##### **\*ARTIFACT_OUTPUTS**

- 使用对象类型结果
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

在 ACP（Alauda Container Platform）中，您可以使用 Tekton Chains 自动签名 Tekton Pipeline 构建的镜像，并使用 Kyverno 仅允许签名镜像部署。

本章逐步说明如何实现上述流程。

### 第 1 步：准备工作

请确认已完成准备工作，特别是以下内容：

- [仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)

### 第 2 步：创建生成镜像的流水线

以下是 Pipeline 资源，用于生成镜像。

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
> 本教程通过流水线内联生成 `Dockerfile`，演示简化流程。
> 生产环境中，通常：
>
> 1. 使用 `git-clone` 任务从仓库拉取代码
> 2. 使用代码中的 Dockerfile 构建镜像
> 3. 该方式确保版本控制和代码与流水线配置分离

**YAML 字段说明：**

- `params`：流水线参数。
  - `generate-dockerfile`：生成 Dockerfile 的脚本。
  - `image`：构建的目标镜像地址。
- `tasks`：流水线任务。
  - `generate-dockerfile`：生成 Dockerfile 任务。
  - `build-image`：构建并推送镜像任务。
    - `params.TLS_VERIFY`：是否验证仓库 TLS 证书。
- `results`：流水线结果。
  - `first_image_ARTIFACT_OUTPUTS`：第一个镜像产物输出结果。
    - `digest`：镜像摘要。
    - `uri`：镜像 URI。
  - 该格式符合 Tekton Chains 规范，详见上文 [Tekton Chains 类型提示](#tekton-chains-type-hinting)。
- `workspaces`：流水线工作空间。
  - `source`：源代码工作空间。
  - `dockerconfig`：Docker 配置工作空间。

**需调整配置**

- `params`：
  - `generate-dockerfile`
    - `default`：调整基础镜像地址。
  - `image`：
    - `default`：构建的目标镜像地址。

保存为 `chains.demo-1.pipeline.yaml`，并执行：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建流水线资源
$ kubectl apply -n $NAMESPACE -f chains.demo-1.pipeline.yaml
```

### 第 3 步：运行流水线生成镜像

以下是 PipelineRun 资源，用于运行流水线。

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
  - `name`：流水线名称。
- `taskRunTemplate`：任务运行模板。
  - `serviceAccountName`：流水线使用的 ServiceAccount。
- `workspaces`：流水线工作空间。
  - `dockerconfig`：Docker 配置工作空间。
  - `source`：源代码工作空间。

**需调整配置**

- `taskRunTemplate`：
  - `serviceAccountName`：前一步准备的 ServiceAccount，详见 [ServiceAccount 配置](#serviceaccount-configuration)。
- `workspaces`：
  - `dockerconfig`：
    - `secret.secretName`：前一步准备的仓库 Secret，详见 [仓库配置](#registry-configuration)。
  - `source`：
    - `volumeClaimTemplate.spec.storageClassName`：卷声明模板的存储类名称。

保存为 `chains.demo-1.pipelinerun.yaml`，并执行：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建流水线运行资源
$ kubectl create -n $NAMESPACE -f chains.demo-1.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-1-<xxxxx>   True        Succeeded   2m         2m
```

### 第 4 步：等待 PipelineRun 签名完成

等待 PipelineRun 带有 `chains.tekton.dev/signed: "true"` 注解。

```shell
$ export NAMESPACE=<default>
$ export PIPELINERUN_NAME=<chains-demo-1-xxxxx>

$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o yaml | grep "chains.tekton.dev/signed"

    chains.tekton.dev/signed: "true"
```

当 PipelineRun 带有该注解时，表示镜像已签名。

### 第 5 步：从 PipelineRun 获取镜像

```shell
# 获取镜像 URI
$ export IMAGE_URI=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.uri}')

# 获取镜像摘要
$ export IMAGE_DIGEST=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.digest}')

# 组合镜像 URI 和摘要，形成完整镜像引用
$ export IMAGE=$IMAGE_URI@$IMAGE_DIGEST

# 输出镜像引用
$ echo $IMAGE

<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046
```

该镜像将用于验证签名。

### 第 6 步：（可选）使用 cosign 验证签名

> **提示：**
>
> - 此步骤为可选，适用于需要使用 cosign 验证镜像签名的场景。
> - 若想了解如何使用 cosign 验证签名，可继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 获取公钥。

使用 cosign 验证签名。

```shell
# 禁用 tlog 上传，启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ cosign verify --key cosign.pub ${IMAGE}
```

若输出如下，表示签名验证成功。

```text
[{"critical":{"identity":{"docker-reference":"<registry>/test/chains/demo-1"},"image":{"docker-manifest-digest":"sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046"},"type":"cosign container image signature"},"optional":null}]
```

您也可以使用 `cosign` 验证未签名镜像。

```shell
$ cosign verify --key cosign.pub ${IMAGE}
```

若输出如下，表示签名验证失败。

```text
Error: no signatures found
error during command execution: no signatures found
```

### 第 7 步：使用 Kyverno 验证签名

#### 第 7.1 步：创建 Kyverno 策略，仅允许签名镜像部署

> 该步骤需要集群管理员权限。

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
              # 该凭证需存在于 Kyverno 部署的命名空间
              - registry-credentials

          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |- # <- 签名者公钥
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                      UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                      -----END PUBLIC KEY-----

                    ctlog:
                      ignoreSCT: true

                    rekor:
                      ignoreTlog: true
```

> 更多 Kyverno ClusterPolicy 详情，请参见 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- `spec.rules[].match.any[].resources`：匹配并验证的资源。
  - `kinds`：资源类型。
    - `Pod`：Pod 资源。
  - `namespaces`：资源所在命名空间。
    - `policy`：仅匹配 `policy` 命名空间。
- `spec.rules[].verifyImages`：镜像验证配置。
  - `imageReferences`：需验证的镜像引用。
    - `*`：验证所有镜像。
    - `<registry>/test/*`：仅验证指定仓库镜像。
  - `skipImageReferences`：跳过验证的镜像引用。
    - `ghcr.io/trusted/*`：跳过指定仓库镜像。
  - `imageRegistryCredentials`：
    - `allowInsecureRegistry`：是否允许不安全仓库。
    - `secrets`：用于仓库凭证的 Secret。
      - `registry-credentials`：Secret 名称，需存在 Kyverno 部署命名空间。
  - `attestors`：用于镜像验证的签名者。
    - `count`：需匹配的签名者数量。
    - `entries`：签名者条目。
      - `keys`：签名者公钥。
        - `publicKeys`：签名者公钥，与 `signing-secrets` 中的 `cosign.pub` 相同。
      - `ctlog`：透明日志配置。
        - `ignoreSCT`：是否忽略 SCT，隔离网络环境下建议忽略。
      - `rekor`：Rekor 日志配置。
        - `ignoreTlog`：是否忽略 Tlog，隔离网络环境下建议忽略。

**需调整配置**

- `spec.rules[].attestors[].entries[].keys.publicKeys`：签名者公钥。
  - 与 `signing-secrets` 中的 `cosign.pub` 相同。
  - 可从 [获取签名公钥](#get-the-signing-public-key) 获取。

保存为 `kyverno.only-cosign-image-deploy.yaml`，并执行：

```shell
$ kubectl apply -f kyverno.only-cosign-image-deploy.yaml

clusterpolicy.kyverno.io/only-cosign-image-deploy configured
```

#### 第 7.2 步：验证策略

在定义策略的 `policy` 命名空间创建 Pod 以验证策略。

使用流水线创建的签名镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ kubectl run -n $NAMESPACE signed --image=${IMAGE} -- sleep 3600

pod/signed created
```

Pod 创建成功。

```shell
$ export NAMESPACE=<policy>
$ kubectl get pod -n $NAMESPACE signed

NAME      READY   STATUS    RESTARTS   AGE
signed   1/1     Running   0          10s
```

使用未签名镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/unsigned:latest>

$ kubectl run -n $NAMESPACE unsigned --image=${IMAGE} -- sleep 3600
```

输出如下，表示 Pod 被策略阻止。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/unsigned was blocked due to the following policies

only-cosign-image-deploy:
  check-image: 'failed to verify image ubuntu:latest:
    .attestors[0].entries[0].keys: no signatures found'
```

### 第 8 步：清理资源

删除前面创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE signed

pod "signed" deleted
```

删除策略。

```shell
$ kubectl delete clusterpolicy only-cosign-image-deploy
```

## 第 2 章 强制基于构建环境的镜像部署

在 ACP 中，您可以使用 Tekton Chains 自动生成镜像的 SLSA 证明。

SLSA 证明中包含 `builder.id` 字段，用于指示镜像的构建环境。本章将使用该字段验证镜像。

> **提示：**
>
> **由于 Tekton Chains 在准备阶段已处理镜像签名和 SLSA 证明生成，我们可直接复用 [第 1 章](#chapter-1-enforcing-image-signature-automated-signing-and-deployment-control) 的流程和镜像。**<br>
> **本章重点验证 SLSA 证明。**

本章逐步说明如何实现上述流程。

### 第 1 步：准备工作

请确认已完成准备工作，特别是以下内容：

- [仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)

若需更改默认 `builder.id`，可调整 `TektonConfig` 的 `config` 中的 `builder.id` 字段。

> 该过程需要平台管理员权限。

```shell
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "builder.id": "https://alauda.io/builders/tekton/v1"
    }
  }
}'
```

### 第 2 步：（可选）重新运行流水线生成镜像

> **提示：**
>
> **若更改了 `builder.id` 字段，需重新运行流水线生成镜像。**<br>
> 旧镜像未使用新 `builder.id` 签名，将被策略阻止。<br>
> 否则可跳过此步，使用旧镜像验证策略。

重新生成并获取镜像，参见：

- [第 1 章：运行流水线生成镜像](#step-3-run-the-pipeline-to-generate-the-image)
- [第 1 章：等待流水线签名](#step-4-wait-for-the-pipeline-to-be-signed)
- [第 1 章：从 PipelineRun 获取镜像](#step-5-get-the-image-from-the-pipelinerun)

### 第 3 步：（可选）使用 cosign 验证构建者信息

> **提示：**
>
> - 此步骤为可选，适用于需要使用 cosign 验证镜像构建者真实性的场景。
> - 若想了解如何使用 cue 或 rego 验证构建者信息，可继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 获取公钥。

Cosign 提供两种方式验证证明：

- [CUE](https://cuelang.org/)
- [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/)

以下展示两种验证方法。

##### 方法 1：使用 [CUE](https://cuelang.org/) 验证

生成用于验证构建者信息的 CUE 文件。

```cue
// 谓词必须满足以下约束。
predicate: {
    builder: {
        id: "https://alauda.io/builders/tekton/v1"
    }
}
```

保存为 `builder.cue`

使用 cosign 验证构建者信息。

```shell
# 禁用 tlog 上传，启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.cue $IMAGE
```

若输出如下，表示构建者信息验证成功。

```text
will be validating against CUE policies: [builder.cue]
will be validating against CUE policies: [builder.cue]

Verification for <registry>/test/chains/demo-1:latest@sha256:8ac1af8dd89652bf32abbbd0c5f667ae9fe6d92c91972617e70b5398303c8e27 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key
{"payloadType":"application/vnd.in-toto+json","payload":"","signatures":[]}
```

将 `builder.cue` 中的 `builder.id` 改为 `https://alauda.io/builders/tekton/v2`，再次验证。

```shell
$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.cue $IMAGE
```

若输出如下，表示构建者信息验证失败。

```text
will be validating against CUE policies: [builder.cue]
will be validating against CUE policies: [builder.cue]
There are 2 number of errors occurred during the validation:

- predicate.builder.id: conflicting values "https://alauda.io/builders/tekton/v1" and "https://alauda.io/builders/tekton/v2"
- predicate.builder.id: conflicting values "https://alauda.io/builders/tekton/v1" and "https://alauda.io/builders/tekton/v2"
Error: 2 validation errors occurred
error during command execution: 2 validation errors occurred
```

##### 方法 2：使用 [Rego](https://www.openpolicyagent.org/docs/latest/policy-language/) 验证

生成用于验证构建者信息的 Rego 文件。

```
package signature

default allow = false

# 定义允许的 builder.id
allowed_builder_id = "https://alauda.io/builders/tekton/v1"

# 验证 builder.id
allow {
    # 检查谓词中的 builder.id 是否等于允许值
    input.predicate.builder.id == allowed_builder_id
}

# 不匹配时返回错误信息
deny[msg] {
    input.predicate.builder.id != allowed_builder_id
    msg := sprintf("unexpected builder.id: %v, expected: %v", [input.predicate.builder.id, allowed_builder_id])
}
```

保存为 `builder.rego`

使用 cosign 验证构建者信息。

```shell
# 禁用 tlog 上传，启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.rego $IMAGE
```

若输出如下，表示构建者信息验证成功。

```text
will be validating against Rego policies: [builder.rego]
will be validating against Rego policies: [builder.rego]

Verification for <registry>/test/chains/demo-1:latest --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key
{"payloadType":"application/vnd.in-toto+json","payload":"","signatures":[]}
```

将 `builder.rego` 中的 `builder.id` 改为 `https://alauda.io/builders/tekton/v2`，再次验证。

```shell
$ cosign verify-attestation --key cosign.pub --type slsaprovenance --policy builder.rego $IMAGE
```

若输出如下，表示构建者信息验证失败。

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

> 该步骤需要集群管理员权限。

证明内容大致如下，我们将使用 `builder.id` 字段验证构建环境。

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

#### 第 4.1 步：创建 Kyverno 策略，仅允许特定构建环境构建的镜像部署

> 该步骤需要集群管理员权限。

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
              # 该凭证需存在于 Kyverno 部署的命名空间
              - registry-credentials

          attestations:
            - type: https://slsa.dev/provenance/v0.2
              attestors:
                - entries:
                    - keys:
                        publicKeys: |- # <- 签名者公钥
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

> 更多 Kyverno ClusterPolicy 详情，请参见 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- 策略与 [第 1 章：创建 Kyverno 策略仅允许签名镜像部署](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 基本一致，仅介绍差异。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：slsa 证明类型为 `https://slsa.dev/provenance/v0.2` 或 `https://slsa.dev/provenance/v1`。
  - `attestors`：同上。
  - `conditions`：需验证的条件。
    - `all`：所有条件均需满足。
      - `key: "{{ builder.id }}"`：验证证明中的 `builder.id` 字段等于 `https://alauda.io/builders/tekton/v1`。

保存为 `kyverno.verify-tekton-built-images.yaml`，并执行：

```shell
$ kubectl apply -f kyverno.verify-tekton-built-images.yaml

clusterpolicy.kyverno.io/verify-tekton-built-images configured
```

#### 第 4.2 步：验证策略

在定义策略的 `policy` 命名空间创建 Pod 以验证策略。

使用构建的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-1:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ kubectl run -n $NAMESPACE built --image=${IMAGE} -- sleep 3600

pod/built created
```

Pod 创建成功。

```shell
$ kubectl get pod -n $NAMESPACE built

NAME      READY   STATUS    RESTARTS   AGE
built   1/1     Running   0          10s
```

将 `ClusterPolicy` 中的 `builder.id` 改为 `https://alauda.io/builders/tekton/v2`，再次验证。

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

输出如下，表示 Pod 被策略阻止。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/unbuilt was blocked due to the following policies

verify-tekton-built-images:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-1@sha256:93635f39cb31de5c6988cdf1f10435b3fb85570c930d51d41bbadc1a90046
    and predicate https://slsa.dev/provenance/v0.2: The builder.id must be equal to
    https://alauda.io/builders/tekton/v2, not https://alauda.io/builders/tekton/v1'
```

### 第 5 步：清理资源

删除前面创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE built
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-tekton-built-images
```

## 第 3 章 强制基于源代码仓库的镜像部署

Tekton Chains 可以收集 `PipelineRun` 的特定输入输出，并记录在 `SLSA 证明` 中。

> 详见上文 [Tekton Chains 类型提示](#tekton-chains-type-hinting)。

我们可以利用此功能，将代码仓库信息包含在 SLSA 证明中，然后在 Kyverno 中验证代码仓库。

本章逐步说明如何实现上述流程。

### 第 1 步：准备工作

请确认已完成准备工作，特别是以下内容：

- [仓库配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [jq](https://stedolan.github.io/jq/)
  - 用于友好展示证明内容。

为避免 Tekton Chains 同时为 TaskRun 和 PipelineRun 生成 SLSA 证明，影响后续 Kyverno 验证，先禁用 TaskRun 的 SLSA 证明。

> 该过程需要平台管理员权限。

```shell
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "artifacts.taskrun.storage": ""
    }
  }
}'
```

### 第 2 步：调整流水线，将代码仓库信息包含在镜像源信息中

在之前的镜像构建流水线中，添加 `git` 克隆任务，并将 `git` 任务输出保存到 `PipelineRun` 的 `results` 中。

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
> 本教程通过流水线内联生成 `Dockerfile` 和 `git-clone` 任务输出，演示简化流程。
> 生产环境中，通常：
>
> 1. 使用 `git-clone` 任务从仓库拉取代码
> 2. 使用代码中的 Dockerfile 构建镜像
> 3. 该方式确保版本控制和代码与流水线配置分离

**YAML 字段说明：**
- 大多数字段与[第1章：创建流水线构建镜像](#step-2-create-a-pipeline-to-generate-the-image)中相同，以下仅介绍差异部分。
- `params`
  - `generate-git-clone-results`：用于模拟克隆代码的脚本，将仓库 URL 和提交信息写入结果。
- `results`
  - `source_repo_ARTIFACT_INPUTS`：源代码仓库 URL 和提交信息。
    - `digest`：源代码仓库的提交 sha。
  - 该格式符合 Tekton Chains 标准，详情请参见上文中的[Tekton Chains 类型提示](#tekton-chains-type-hinting)。

### 第3步：运行流水线生成镜像

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

- 与[第1章：运行流水线生成镜像](#step-3-run-the-pipeline-to-generate-the-image)相同。

保存为名为 `chains.demo-3.pipelinerun.yaml` 的 yaml 文件，并执行：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建 pipeline run 资源
$ kubectl create -n $NAMESPACE -f chains.demo-3.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-3-<xxxxx>   True        Succeeded   2m         2m
```

### 第4步：等待流水线签名完成

等待 PipelineRun 拥有 `chains.tekton.dev/signed: "true"` 注解。

```shell
$ export NAMESPACE=<default>
$ export PIPELINERUN_NAME=<chains-demo-3-xxxxx>

$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o yaml | grep "chains.tekton.dev/signed"

    chains.tekton.dev/signed: "true"
```

一旦 PipelineRun 拥有 `chains.tekton.dev/signed: "true"` 注解，表示镜像已签名。

### 第5步：从 PipelineRun 获取镜像

```shell
# 获取镜像 URI
$ export IMAGE_URI=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.uri}')

# 获取镜像摘要
$ export IMAGE_DIGEST=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.digest}')

# 组合镜像 URI 和摘要形成完整镜像引用
$ export IMAGE=$IMAGE_URI@$IMAGE_DIGEST

# 输出镜像引用
$ echo $IMAGE

<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20
```

此镜像将用于验证代码仓库。

### 第7步：（可选）获取 SLSA Provenance 证明

> **提示：**
>
> - 如果您对 SLSA Provenance 证明内容感兴趣，可以继续阅读以下内容。

根据[获取签名公钥](#get-the-signing-public-key)部分获取签名公钥。

```shell
# 禁用 tlog 上传并启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出类似如下，包含 SLSA Provenance 证明。

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

> 关于 SLSA Provenance 证明的更多详情，请参见 [SLSA Provenance](https://slsa.dev/spec/v1.1/provenance)

**字段说明：**

- `predicateType`：谓词类型。
- `predicate`：
  - `buildConfig`：
    - `tasks`：构建任务。
  - `buildType`：构建类型，此处为 `tekton.dev/v1beta1/PipelineRun`。
  - `builder`：
    - `id`：构建者 ID，此处为 `https://alauda.io/builders/tekton/v1`。
  - `invocation`：
    - `parameters`：构建参数。
  - `materials`：构建材料。
    - `uri`：
      - `oci://<registry>/devops/tektoncd/hub/run-script`：使用的任务镜像。
      - `https://github.com/tektoncd/pipeline`：任务的源代码仓库。
  - `metadata`：构建元数据。
    - `buildFinishedOn`：构建完成时间。
    - `buildStartedOn`：构建开始时间。

### 第8步：使用 Kyverno 验证镜像源代码仓库限制

证明内容大致如下，我们将使用 `materials` 字段验证代码仓库。

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

#### 第8.1步：创建 Kyverno 策略，仅允许从特定源代码仓库构建的镜像部署

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
              # 凭证需存在于 kyverno 部署的命名空间
              - registry-credentials

          attestations:
            - type: https://slsa.dev/provenance/v0.2
              attestors:
                - entries:
                    - keys:
                        publicKeys: |- # <- 签名者的公钥
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
                      message: "buildType 必须等于 tekton.dev/v1beta1/PipelineRun，当前为 {{ buildType }}"

                    - key: "{{ materials[?starts_with(uri, 'https://github.com/tektoncd/')] | length(@) }}"
                      operator: GreaterThan
                      value: 0
                      message: "materials 中必须至少包含一个以 https://github.com/tektoncd/ 开头的条目，当前为 {{ materials }}"
```

> 更多 Kyverno ClusterPolicy 详情，请参见 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明**

- 策略与[第1章：创建 Kyverno 策略仅允许部署签名镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed)基本一致。
- `spec.rules[].verifyImages[].attestations[].conditions`：验证条件。
  - `all`：所有条件必须满足。
    - `key: "{{ buildType }}"`：构建类型必须为 `tekton.dev/v1beta1/PipelineRun`。
    - `key: "{{ materials[?starts_with(uri, 'https://github.com/tektoncd/')] | length(@) }}"`：materials 中必须至少有一个条目以 `https://github.com/tektoncd/` 开头。

保存为 `verify-code-repository-material.yaml` 并执行：

```shell
$ kubectl create -f verify-code-repository-material.yaml

clusterpolicy.kyverno.io/verify-code-repository-material created
```

#### 第8.2步：验证策略

在定义策略的 `policy` 命名空间中创建 Pod 以验证策略。

使用构建好的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20>

$ kubectl run -n $NAMESPACE built-from-specific-repo --image=${IMAGE} -- sleep 3600

pod/built-from-specific-repo created
```

Pod 会成功创建。

```shell
$ kubectl get pod -n $NAMESPACE built-from-specific-repo

NAME                      READY   STATUS    RESTARTS   AGE
built-from-specific-repo   1/1     Running   0          10s
```

将 `ClusterPolicy` 中的代码仓库改为其他值 `https://gitlab.com/`，再次验证。

```yaml
conditions:
  - all:
      - key: "{{ buildType }}"
        operator: Equals
        value: "tekton.dev/v1beta1/PipelineRun"
        message: "buildType 必须等于 tekton.dev/v1beta1/PipelineRun，当前为 {{ buildType }}"

      - key: "{{ materials[?starts_with(uri, 'https://gitlab.com/')] | length(@) }}"
        operator: GreaterThan
        value: 0
        message: "materials 中必须至少包含一个以 https://gitlab.com/ 开头的条目，当前为 {{ materials }}"
```

```shell
$ kubectl run -n $NAMESPACE unbuilt-from-specific-repo --image=${IMAGE} -- sleep 3600
```

收到如下输出，表示 Pod 被策略阻止。

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

### 第9步：清理资源

删除前面步骤创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE built-from-specific-repo
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-code-repository-material
```

## 第4章 防止部署存在严重安全漏洞的镜像

在 ACP (Alauda Container Platform) 中，可以使用 Tekton Pipeline 构建并扫描镜像漏洞。

具体流程是使用 `trivy` 任务生成漏洞扫描结果，再用 `cosign` 上传漏洞扫描结果的证明，最后用 `kyverno` 验证漏洞扫描结果的证明。

本章将逐步讲解如何实现上述流程。

### 第1步：准备工作

请确认准备工作已完成，特别是以下部分：

- [Registry Configuration](#registry-configuration)
- [ServiceAccount Configuration](#serviceaccount-configuration)
- [Get the signing public key](#get-the-signing-public-key)
- [Get the signing secret](#get-the-signing-secret)
  - **重要**：此处仅为方便起见，使用了 Chains 的全局签名证书。实际使用中，可使用单独证书签署镜像漏洞信息。
  - 将 secret 导入流水线执行的命名空间。
- [jq](https://stedolan.github.io/jq/)
  - 用于友好展示证明内容。

### 第2步：创建流水线生成 cosign 漏洞证明

这是一个 Pipeline 资源，用于构建镜像并生成 cosign 漏洞证明。

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

- 与[第1章：创建流水线生成镜像](#step-2-create-a-pipeline-to-generate-the-image)相同，但添加了以下内容：
  - `workspaces`：
    - `signkey`：用于镜像签名的私钥和密码的工作空间。
  - `tasks`：
    - `trivy-scanner`：扫描镜像漏洞的任务。
    - `cosign-uploads`：上传漏洞扫描结果证明的任务。

保存为 `chains-demo-4.yaml` 并执行：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建流水线
$ kubectl create -n $NAMESPACE -f chains-demo-4.yaml

pipeline.tekton.dev/chains-demo-4 created
```

### 第3步：运行流水线生成 cosign 漏洞证明

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

- 与[第1章：运行流水线生成镜像](#step-3-run-the-pipeline-to-generate-the-image)相同，以下仅介绍差异。
- `workspaces`
  - `signkey`：签名密钥的 secret 名称。
    - `secret.secretName`：前一步[获取签名 secret](#get-the-signing-secret)中准备的签名 secret，但需在流水线运行的命名空间中创建新的 secret。

保存为 `chains-demo-4.pipelinerun.yaml` 并执行：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建流水线运行
$ kubectl create -n $NAMESPACE -f chains-demo-4.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-4-<xxxxx>     True        Succeeded   2m  2m
```

### 第4步：从 pipelinerun 获取镜像

> **同[第1章：从 pipelinerun 获取镜像](#step-5-get-the-image-from-the-pipelinerun)**

### 第5步：（可选）获取 cosign 漏洞证明

> **提示：**
>
> - 如果您对 cosign 漏洞证明内容感兴趣，可以继续阅读以下内容。

根据[获取签名公钥](#get-the-signing-public-key)部分获取签名公钥。

```shell
# 禁用 tlog 上传并启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-4:latest@sha256:5e7b466e266633464741b61b9746acd7d02c682d2e976b1674f924aa0dfa2047>

$ cosign verify-attestation --key cosign.pub --type vuln $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出类似如下，包含漏洞扫描结果。

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

> 关于 cosign 漏洞证明的更多详情，请参见 [cosign vuln attestation](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)

**字段说明：**

- `predicateType`：谓词类型。
- `predicate.scanner`：
  - `uri`：扫描器 URI。
  - `version`：扫描器版本。
  - `result`：漏洞扫描结果。
    - `CreatedAt`：漏洞扫描完成时间。
    - `Metadata`：
      - `OS`：
        - `Family`：操作系统家族。
        - `Name`：操作系统名称。
    - `Results`：漏洞扫描结果。
      - `Class`：
        - `os-pkgs`：操作系统包。
        - `lang-pkgs`：语言包。
      - `Packages`：镜像中的包。
      - `Vulnerabilities`：镜像中的漏洞。
        - `Severity`：漏洞严重度。
        - `PkgID`：漏洞包 ID。
        - `PkgName`：漏洞包名称。
        - `CVSS`：漏洞 CVSS 评分。
          - `nvd`：NVD 评分。
          - `redhat`：Red Hat 评分。

### 第6步：使用 Kyverno 验证漏洞扫描结果

#### 第6.1步：创建 Kyverno 策略拒绝存在高风险漏洞的镜像

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
              # 凭证需存在于 kyverno 部署的命名空间
              - registry-credentials

          attestations:
            - type: https://cosign.sigstore.dev/attestation/vuln/v1
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- 签名者公钥
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
                      # 支持值：UNKNOWN, LOW, MEDIUM, HIGH, CRITICAL
                      value: ["HIGH", "CRITICAL"]
                      message: |
                        镜像包含高风险漏洞，请先修复。
                        严重度等级：{{ scanner.result.Results[].Vulnerabilities[].Severity }}

                    - key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`][] | length(@) }}"
                      operator: Equals
                      value: 0
                      message: |
                        镜像包含高风险漏洞，请先修复。
                        高风险漏洞（CVSS > 1.0）：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].CVSS.redhat.V3Score[] }}。
                        严重度等级：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].Severity[] }}。
                        PkgIDs：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].PkgID[] }}。
```

> 更多 Kyverno ClusterPolicy 详情，请参见 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- 策略与[第1章：创建 Kyverno 策略仅允许部署签名镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed)基本一致，以下仅介绍差异。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cosign 漏洞证明类型为 `https://cosign.sigstore.dev/attestation/vuln/v1`
  - `attestors`：同上。
  - `conditions`：验证条件。
    - `all`：所有条件必须满足。
      - `key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"`：漏洞严重度不能为 `HIGH` 或 `CRITICAL`。
      - `key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`][] | length(@) }}"`：CVSS 分数大于 1.0 的漏洞数量必须为 0。

保存为 `kyverno.reject-high-risk-image.yaml` 并执行：

```shell
$ kubectl apply -f kyverno.reject-high-risk-image.yaml

clusterpolicy.kyverno.io/reject-high-risk-image configured
```

#### 第6.2步：验证策略

在定义策略的 `policy` 命名空间中创建 Pod 以验证策略。

使用构建好的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-4:latest@sha256:0f123204c44969876ed12f40066ccccbfd68361f68c91eb313ac764d59428bef>

$ kubectl run -n $NAMESPACE vuln-image --image=${IMAGE} -- sleep 3600
```

如果镜像存在高风险漏洞，Pod 会被策略阻止。
收到如下输出：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/high-risk was blocked due to the following policies

reject-high-risk-image:
  check-image: |
    image attestations verification failed, verifiedCount: 0, requiredCount: 1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed for <registry>/test/chains/demo-4:latest and predicate https://cosign.sigstore.dev/attestation/vuln/v1: 镜像包含高风险漏洞，请先修复。
    高风险漏洞（CVSS > 1.0）：[8.6,2.7,6.2,5.9,7.5,4.7,7.4,4.7,7.4,4.7,7.4,4.7,7.4,5.9,3.6,3.6,7.3,4.4,6.5,5.4]。
    严重度等级：["LOW","MEDIUM","LOW","LOW","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","LOW","LOW","LOW","MEDIUM","MEDIUM","MEDIUM","MEDIUM"]。
    PkgIDs：["coreutils@9.4-3ubuntu6","gpgv@2.4.4-2ubuntu17","gpgv@2.4.4-2ubuntu17","libgcrypt20@1.10.3-2build1","liblzma5@5.6.1+really5.4.5-1build0.1","libpam-modules@1.5.3-5ubuntu5.1","libpam-modules@1.5.3-5ubuntu5.1","libpam-modules-bin@1.5.3-5ubuntu5.1","libpam-modules-bin@1.5.3-5ubuntu5.1","libpam-runtime@1.5.3-5ubuntu5.1","libpam-runtime@1.5.3-5ubuntu5.1","libpam0g@1.5.3-5ubuntu5.1","libpam0g@1.5.3-5ubuntu5.1","libssl3t64@3.0.13-0ubuntu3.5","login@1:4.13+dfsg1-4ubuntu3.2","passwd@1:4.13+dfsg1-4ubuntu3.2","perl-base@5.38.2-3.2build2.1","golang.org/x/net@v0.23.0","golang.org/x/net@v0.23.0","stdlib@v1.22.12"]。
```

将 `ClusterPolicy` 中条件修改为允许高风险漏洞，但 CVSS 分数小于 10.0。

```yaml
conditions:
  - all:
      - key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"
        operator: AllNotIn
        value: ["CRITICAL"]
        message: |
          镜像包含高风险漏洞，请先修复。
          严重度等级：{{ scanner.result.Results[].Vulnerabilities[].Severity }}

      - key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`][] | length(@) }}"
        operator: Equals
        value: 0
        message: |
          镜像包含高风险漏洞，请先修复。
          高风险漏洞（CVSS > 10.0）：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].CVSS.redhat.V3Score[] }}。
          严重度等级：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].Severity[] }}。
          PkgIDs：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].PkgID[] }}。
```

再次创建 Pod 验证策略。

```shell
$ kubectl run -n $NAMESPACE vuln-image --image=${IMAGE} -- sleep 3600

pod/vuln-image created
```

Pod 创建成功。

### 第7步：（可选）要求漏洞扫描结果在168小时内

> **提示：**
>
> - 如果您想为策略添加更多条件，可以继续阅读以下内容。

由于[Cosign 漏洞扫描记录证明](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)包含 `scanFinishedOn` 字段，且 `trivy` 符合规范，我们可以用此字段判断漏洞扫描结果是否在168小时内。

只需在 `ClusterPolicy` 中添加条件，检查 `scanFinishedOn` 字段是否在168小时内。

```yaml
conditions:
  - all:
      - key: "{{ time_since('','{{metadata.scanFinishedOn}}','') }}"
        operator: LessThanOrEquals
        value: "168h"
        message: "漏洞扫描结果必须在168小时内，当前为 {{ metadata.scanFinishedOn }}"
```

此处不演示，感兴趣的读者可自行尝试。

### 第8步：清理资源

删除前面步骤创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE vuln-image
```

删除策略。

```shell
$ kubectl delete clusterpolicy reject-high-risk-image
```

## 第5章 基础镜像白名单验证

如果只允许特定类型的基础镜像部署，
可以在获取镜像证明后，将该信息保存到镜像证明中。

在[第4章](#chapter-4-preventing-deployment-of-images-with-critical-security-vulnerabilities)中，`cosign-vuln` 格式的证明已包含基础镜像信息。
但这里我们采用不同方式，使用 `syft` 生成镜像的 SBOM。
SBOM 信息也包含基础镜像信息。

在 ACP (Alauda Container Platform) 中，可以使用 Tekton Pipeline 中的 `trivy` 或 `syft` 任务生成镜像 SBOM。
这里使用 syft 任务生成 SBOM。

### 第1步：准备工作

请确认准备工作已完成，特别是以下部分：

- [Registry Configuration](#registry-configuration)
- [ServiceAccount Configuration](#serviceaccount-configuration)
- [Get the signing public key](#get-the-signing-public-key)
- [Get the signing secret](#get-the-signing-secret)
  - **重要**：此处仅为方便起见，使用了 Chains 的全局签名证书。实际使用中，可使用单独证书签署镜像漏洞信息。
  - 将 secret 导入流水线执行的命名空间。
- [jq](https://stedolan.github.io/jq/)
  - 用于友好展示证明内容。

### 第2步：创建流水线生成 SBOM

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

- 与[第1章：创建流水线生成镜像](#step-2-create-a-pipeline-to-generate-the-image)相同，但添加了以下内容：
  - `workspaces`：
    - `signkey`：用于镜像签名的私钥和密码的工作空间。
  - `tasks`：
    - `syft-sbom`：生成镜像 SBOM 并上传证明的任务。

### 第3步：运行流水线生成 cosign 漏洞证明

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

- 与[第1章：运行流水线生成镜像](#step-3-run-the-pipeline-to-generate-the-image)相同，以下仅介绍差异。
- `workspaces`
  - `signkey`：签名密钥的 secret 名称。
    - `secret.secretName`：前一步[获取签名 secret](#get-the-signing-secret)中准备的签名 secret，但需在流水线运行的命名空间中创建新的 secret。

保存为 `chains-demo-5.pipelinerun.yaml` 并执行：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建流水线运行
$ kubectl create -n $NAMESPACE -f chains-demo-5.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-5-<xxxxx>     True        Succeeded   2m  2m
```

### 第4步：从 pipelinerun 获取镜像

> **同[第1章：从 pipelinerun 获取镜像](#step-5-get-the-image-from-the-pipelinerun)**

### 第5步：（可选）获取 SBOM 证明

> **提示：**
>
> - 如果您对 SBOM 证明内容感兴趣，可以继续阅读以下内容。

根据[获取签名公钥](#get-the-signing-public-key)部分获取签名公钥。

```shell
# 禁用 tlog 上传并启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ cosign verify-attestation --key cosign.pub --type cyclonedx $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出类似如下，包含镜像组件信息。

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

> 关于 cyclonedx SBOM 证明的更多详情，请参见 [cyclonedx SBOM attestation](https://cyclonedx.org/docs/1.6/json/)

**字段说明：**

- `predicateType`：谓词类型。
- `predicate`：
  - `components`：镜像组件。
    - `bom-ref`：组件的 BOM 引用。
    - `licenses`：组件的许可证。
      - `license`：组件许可证。
        - `name`：许可证名称。
        - `id`：许可证 ID。
    - `name`：组件名称。
    - `type`：组件类型。
    - `version`：组件版本。
  - `metadata`：镜像元数据。
    - `timestamp`：时间戳。
    - `tools`：
      - `components`：工具组件。
        - `author`：工具作者。
        - `name`：工具名称。
        - `type`：工具类型。
        - `version`：工具版本。

### 第6步：验证基础镜像信息

#### 第6.1步：创建 Kyverno 策略验证基础镜像信息

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
              # 凭证需存在于 kyverno 部署的命名空间
              - registry-credentials

          attestations:
            - type: https://cyclonedx.org/bom
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- 签名者公钥
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
                      message: "操作系统必须是 Ubuntu 22.04 或 24.04，当前为 {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"

                    - key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"
                      operator: GreaterThan
                      value: 0
                      message: "操作系统必须是 Alpine 3.18 或 3.20，当前为 {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"
```

**YAML 字段说明：**

- 策略与[第1章：创建 Kyverno 策略仅允许部署签名镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed)基本一致，以下仅介绍差异。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cyclonedx SBOM 证明类型为 `https://cyclonedx.org/bom`
  - `attestors`：同上。
  - `conditions`：验证条件。
    - `any`：满足任一条件即可。
      - `key: "{{ components[?type=='operating-system'] | [?name=='ubuntu' && (version=='22.04' || version=='24.04')] | length(@) }}"`：操作系统必须是 Ubuntu 22.04 或 24.04。
      - `key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"`：操作系统必须是 Alpine 3.18 或 3.20。

保存为 `kyverno.verify-base-image.yaml` 并执行：

```shell
$ kubectl create -f kyverno.verify-base-image.yaml

clusterpolicy.kyverno.io/verify-base-image created
```

#### 第6.2步：验证策略

在定义策略的 `policy` 命名空间中创建 Pod 以验证策略。

使用构建好的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ kubectl run -n $NAMESPACE base-image --image=${IMAGE} -- sleep 3600
```

如果基础镜像是 Ubuntu 22.04 或 24.04，Pod 会成功创建。

将 `ClusterPolicy` 中条件改为只允许 Alpine 3.18 或 3.20。

```yaml
conditions:
  - any:
      - key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"
        operator: GreaterThan
        value: 0
        message: "操作系统必须是 Alpine 3.18 或 3.20，当前为 {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"
```

再次创建 Pod 验证策略。

```shell
$ kubectl run -n $NAMESPACE deny-base-image --image=${IMAGE} -- sleep 3600
```

收到如下输出：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/deny-base-image was blocked due to the following policies

verify-base-image:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-5:latest and predicate https://cyclonedx.org/bom:
    操作系统必须是 Alpine 3.18 或 3.20，当前为 ["ubuntu"] ["24.04"]'
```

### 第7步：清理资源

删除前面步骤创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE base-image
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-base-image
```

## 第6章 许可证合规验证 - 拒绝包含特定许可证类型的镜像

在 ACP (Alauda Container Platform) 中，可以使用 Tekton Pipeline 中的 `trivy` 或 `syft` 任务生成镜像 SBOM。

SBOM 包含镜像中每个组件的许可证信息。
我们可以使用 Kyverno 策略拒绝包含特定许可证的镜像。

由于在[第5章](#chapter-5-base-image-allowlist-verification)中已为镜像生成 SBOM，这里不再创建流水线，直接使用已有镜像验证此功能。

> 本章基于[第5章](#chapter-5-base-image-allowlist-verification)，仅增加验证镜像许可证信息的逻辑。

### 第1步：验证镜像许可证信息

#### 第1.1步：创建 Kyverno 策略验证基础镜像信息

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
              # 凭证需存在于 kyverno 部署的命名空间
              - registry-credentials

          attestations:
            - type: https://cyclonedx.org/bom
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- 签名者公钥
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
                    # 检查镜像是否包含特定许可证
                    - key: "{{ components[].licenses[].license.id }}"
                      operator: AllNotIn
                      value: ["GPL-3.0-only", "GPL-3.0-or-later"]
                      message: |
                        镜像包含不允许的 GPL 许可证。
                        发现许可证：{{ components[].licenses[].license.id }}

                    # 检查镜像是否包含特定许可证名称
                    - key: "{{ components[].licenses[].license.name }}"
                      operator: AllNotIn
                      value: ["GPL"]
                      message: |
                        镜像包含不允许的 Expat 许可证。
                        发现许可证：{{ components[].licenses[].license.name }}
```

**YAML 字段说明：**

- 策略与[第1章：创建 Kyverno 策略仅允许部署签名镜像](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed)基本一致，以下仅介绍差异。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`：cyclonedx SBOM 证明类型为 `https://cyclonedx.org/bom`
  - `attestors`：同上。
  - `conditions`：验证条件。
    - `any`：满足任一条件即可。
      - `key: "{{ components[].licenses[].license.id }}"`：镜像包含不允许的 GPL 许可证。
      - `key: "{{ components[].licenses[].license.name }}"`：镜像包含不允许的 Expat 许可证。

保存为 `kyverno.verify-component-licenses.yaml` 并执行：

```shell
$ kubectl create -f kyverno.verify-component-licenses.yaml

clusterpolicy.kyverno.io/verify-component-licenses created
```

#### 第1.2步：验证策略

在定义策略的 `policy` 命名空间中创建 Pod 以验证策略。

使用构建好的镜像创建 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ kubectl run -n $NAMESPACE component-licenses --image=${IMAGE} -- sleep 3600
```

如果镜像包含 GPL 许可证，Pod 创建失败。

收到如下输出：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/high-risk was blocked due to the following policies

verify-component-licenses:
  check-image: |
    image attestations verification failed, verifiedCount: 0, requiredCount: 1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed for <registry>/test/chains/demo-5:latest and predicate https://cyclonedx.org/bom: 镜像包含不允许的 GPL 许可证。
    发现许可证：["GPL-3.0-only","GPL-3.0-or-later","Latex2e"]
    ; 镜像包含不允许的 Expat 许可证。
    发现许可证：[,"GPL","LGPL","public-domain"]
```

将 `ClusterPolicy` 中许可证限制改为允许 GPL 许可证。

```yaml
conditions:
  - any:
    - key: "{{ components[].licenses[].license.id }}"
      operator: AllNotIn
      value: ["GPL-8.0-only"]
      message: |
        镜像包含不允许的 GPL 许可证。
        发现许可证：{{ components[].licenses[].license.id }}

    - key: "{{ components[].licenses[].license.name }}"
      operator: AllNotIn
      value: ["GPL-x"]
      message: |
        镜像包含不允许的 Expat 许可证。
        发现许可证：{{ components[].licenses[].license.name }}
```

再次创建 Pod 验证策略。

```shell
$ kubectl run -n $NAMESPACE component-licenses --image=${IMAGE} -- sleep 3600

pod/component-licenses created
```

Pod 创建成功。

### 第2步：（可选）验证镜像是否包含 CVE-2022-42889

> **提示：**
>
> - 如果您想为策略添加更多条件，可以继续阅读以下内容。

CVE-2022-42889 是 Apache Commons Text 库中的严重漏洞，可能导致任意代码执行，影响版本为 1.5 至 1.9。可通过 SBOM 中检测名为 "commons-text" 且版本在 1.5-1.9 的包来识别。此策略检查指定镜像的 CycloneDX 格式证明，若包含受影响版本则拒绝。

只需在 `ClusterPolicy` 中添加条件，检查镜像中是否包含 `commons-text` 包。

```yaml
conditions:
  - all:
    - key: "{{ components[?name=='commons-text'].version || 'none' }}"
      operator: AllNotIn
      value: ["1.5","1.6","1.7","1.8","1.9"]
```

此处不演示，感兴趣的读者可自行尝试。

### 第3步：清理资源

删除前面步骤创建的 Pod。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE component-licenses
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-component-licenses
```

## 第7章（可选）无密钥签名验证

> **提示：**
>
> - 如果您对无密钥签名验证感兴趣，可以继续阅读以下内容。
> - 本章内容需要能够访问公网。
> - 如果您已部署私有 Rekor 服务，也可以使用私有 Rekor 服务。

虽然 ACP (Alauda Container Platform) 目前不支持部署私有 Rekor 实例，但提供了与 Rekor 服务的集成能力。

这里以集成公共 Rekor 为例介绍如何使用这些服务。
如果您已部署私有 Rekor 服务，请参考相关文档进行配置。

### 第1步：准备工作

请确认准备工作已完成，特别是以下部分：

- [Registry Configuration](#registry-configuration)
- [ServiceAccount Configuration](#serviceaccount-configuration)
- [Get the signing public key](#get-the-signing-public-key)
- [rekor-cli](https://github.com/sigstore/rekor/releases)
  - 用于验证和交互存储在 Rekor 透明日志服务器中的证明。
- [jq](https://stedolan.github.io/jq/)
  - 用于友好展示签名内容。
### 第 2 步：配置 Tekton Chains

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

> 如果您有私有的 Rekor 服务，可以将 `transparency.url` 设置为您的 Rekor 服务器的 URL。
>
> - `transparency.url: "<https://rekor.sigstore.dev>"`

> 有关配置的更多详细信息，请参阅 [Transparency Log](https://tekton.dev/docs/chains/config/#transparency-log)

### 第 3 步：重新运行 pipeline 以生成镜像

> **提示：**
>
> - 由于我们修改了透明日志配置，需要在[第 1 章](#step-3-run-the-pipeline-to-generate-the-image)中触发新的 pipeline 运行。
> - 这将允许 Tekton Chains 为新的镜像和 PipelineRun 生成透明日志条目。

要重新生成并获取镜像，请执行以下步骤：

- [第 1 章：运行 pipeline 以生成镜像](#step-3-run-the-pipeline-to-generate-the-image)
- [第 1 章：等待 pipeline 被签名](#step-4-wait-for-the-pipeline-to-be-signed)

### 第 4 步：获取 rekor 日志索引

从 PipelineRun 的 annotations 中获取 rekor 签名。

```shell
$ export NAMESPACE=<pipeline-namespace>
$ export PIPELINERUN_NAME=<pipelinerun-name>
$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.metadata.annotations.chains\.tekton\.dev/transparency}'

https://rekor.sigstore.dev/api/v1/log/entries?logIndex=232330257
```

### 第 5 步：通过 curl 获取 rekor 签名

```shell
$ curl -s "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=232330257" | jq
```

如果需要查看 rekor 签名的内容，可以执行以下命令：

```shell
$ curl -s "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=232330257" | jq -r '.[keys[0]].attestation.data | @base64d' | jq .

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

此内容与镜像中的 attestation 相同，用于验证镜像内容的真实性和完整性。  
attestation 信息可以从 Rekor 获取，无需镜像仓库的凭据，使验证更加方便和易于访问。

### 第 6 步：通过 rekor-cli 获取 rekor 签名

通过日志索引获取签名

```shell
# 日志索引与 PipelineRun annotations 中的相同
$ rekor-cli get --log-index 232330257 --format json | jq -r .Attestation | jq .
```

通过镜像摘要获取签名

```shell
# 通过镜像摘要获取 uuid
$ rekor-cli search --sha da4885861a8304abad71fcdd569c92daf33422073d1102013a1fed615dfb285a

Found matching entries (listed by UUID):
108e9186e8c5677a1364e68001a916d3a7316bc2580bd6b5fbbce39a9c62f13282d3e974a6b434ab

# 通过 uuid 获取签名
$ rekor-cli get --uuid 108e9186e8c5677a1364e68001a916d3a7316bc2580bd6b5fbbce39a9c62f13282d3e974a6b434ab --format json | jq -r .Attestation | jq .
```

### 第 7 步：在 Kyverno 中验证 rekor

修改 `ClusterPolicy` 的 `keys` 部分，添加 rekor 验证配置。

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
                    publicKeys: |- # <- 签名者的公钥
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                      UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                      -----END PUBLIC KEY-----

                    rekor:
                      ignoreTlog: false
                      # url: <https://rekor.sigstore.dev>
                      # # 从 rekor 服务器获取公钥
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
    - 若为 `false`，则会验证 rekor 服务器。
  - `url`：rekor 服务器的 URL。
    - 若未设置，默认使用 `https://rekor.sigstore.dev`。
  - `pubkey`：签名者的公钥。
    - 若未设置，将从 rekor 服务器获取公钥。
    - 如果 rekor 服务器是私有的，需要从 rekor 服务器获取公钥。
      - `curl <https://rekor.sigstore.dev>/api/v1/log/publicKey`

如果镜像未签名，Pod 将被阻止。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/sign was blocked due to the following policies

only-cosign-image-deploy:
  check-image: 'failed to verify image <registry>/test/chains/demo-1:latest:
    .attestors[0].entries[0].keys: no matching signatures: searching log query: Post
    "http:///api/v1/log/entries/retrieve": POST http:///api/v1/log/entries/retrieve
    giving up after 4 attempt(s): Post "http:///api/v1/log/entries/retrieve": http:
    no Host in request URL'
```

## 结论

Alauda Container Platform (ACP) 提供了基于 OpenSSF SLSA 框架实现软件供应链安全的完整解决方案。本文档探讨了实现安全可靠软件交付的关键组件和方法：

### 核心安全能力

1. **代码与构建过程安全**
   - 来自可信 git 源的代码仓库
   - 构建过程的 SLSA Provenance 证明
   - 通过签名和验证确保镜像完整性
   - 现代无密钥签名方案
   - 构建环境的验证与加固

2. **依赖与组件安全**
   - 漏洞扫描以评估安全风险
   - 通过 SBOM 生成实现组件清单
   - 许可证合规性验证
   - 第三方依赖验证

3. **分发与部署安全**
   - 基于 Kyverno 的策略验证
   - 灵活的验证机制
   - 自动化安全策略执行
   - 运行时环境安全控制

### 实现架构

1. **核心组件**
   - Tekton Pipelines：用于 pipeline 编排和自动化
   - Tekton Chains：实现 SLSA 合规和工件签名
   - Kyverno：策略执行和验证

2. **辅助工具**
   - cosign：镜像签名与验证
   - syft/trivy：SBOM 生成与漏洞扫描
   - trivy/grype：漏洞扫描

3. **实现流程**
   - 阶段 1：生成 attestation
   - 阶段 2：验证 attestation

### 主要优势

1. **全面的风险缓解**
   - 确保构建过程的完整性和可追溯性
   - 提供全面的漏洞管理
   - 支持现代签名方法，无需密钥管理负担
   - 覆盖所有主要供应链安全风险

2. **运营效率**
   - 支持自动化安全策略执行
   - 减少人工安全检查
   - 简化合规验证
   - 降低安全管理复杂度

3. **实现灵活性**
   - 多种工具支持各安全功能
   - 可定制的验证规则
   - 与现有 CI/CD pipeline 集成
   - 适应不同安全需求

通过实施这些供应链安全措施，组织能够显著提升软件交付流程的安全性，降低安全风险，并确保符合行业标准。平台的灵活性使团队能够根据具体需求选择最合适的安全控制措施，同时保持强健可靠的软件供应链。

## 参考文献

- [SLSA](https://slsa.dev/)
  - [供应链威胁](https://slsa.dev/spec/v1.1/threats-overview)
  - [安全等级](https://slsa.dev/spec/v1.1/levels)
- [Tekton Chains](https://tekton.dev/docs/chains/)
  - [Chains 配置](https://tekton.dev/docs/chains/config/)
  - [SLSA Provenance](https://tekton.dev/docs/chains/slsa-provenance/)
  - [使用 Tekton 和 Tekton Chains 达到 SLSA 2 级](https://tekton.dev/blog/2023/04/19/getting-to-slsa-level-2-with-tekton-and-tekton-chains/)
- [Cosign](https://github.com/sigstore/cosign)
  - [Cosign 签名规范](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md)
  - [Cosign 漏洞扫描记录 attestation 规范](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)
  - [验证 In-Toto Attestations](https://docs.sigstore.dev/cosign/verifying/attestation/)
- [Kyverno](https://kyverno.io/)
  - [ClusterPolicy 规范](https://htmlpreview.github.io/?https://github.com/kyverno/kyverno/blob/main/docs/user/crd/index.html)
  - [Kyverno - JMESPath](https://release-1-11-0.kyverno.io/docs/writing-policies/jmespath/)
  - kyverno 提供一系列[策略](https://kyverno.io/policies/?policytypes=Security+Tekton+Tekton%2520in%2520CEL+verifyImages)
    - [检查 Tekton TaskRun 漏洞扫描](https://kyverno.io/policies/tekton/verify-tekton-taskrun-vuln-scan/verify-tekton-taskrun-vuln-scan/)：检查高风险漏洞
    - [要求签名的 Tekton Task](https://kyverno.io/policies/tekton/verify-tekton-taskrun-signatures/verify-tekton-taskrun-signatures/)：要求 Tekton TaskRun 的 TaskRef 中包含签名信息
    - [要求镜像漏洞扫描](https://kyverno.io/policies/other/require-vulnerability-scan/require-vulnerability-scan/)：要求镜像在 168 小时内有漏洞扫描信息
    - [验证镜像是否存在 CVE-2022-42889](https://kyverno.io/policies/other/verify-image-cve-2022-42889/verify-image-cve-2022-42889/)：要求镜像无 CVE-2022-42889 漏洞
