---
products:
   - Alauda Container Platform
kind:
   - Solution
---

# 在 Alauda 容器平台上使用 GitHub Actions Runner Controller 部署 self-hosted runner

## 概述

GitHub Actions 默认在 GitHub 托管的 runner 上跑 workflow，那些 runner
跑在公网，访问不到您的内网服务。**self-hosted runner** 让您把 runner
放进自己的集群里，从而能用集群算力、访问内网资源、在 air-gap 环境里
跑 CI 任务。每次 workflow 触发都会在集群里运行一个临时 runner pod，跑完
自动销毁；启用 workflow 的 `container:` 字段时，ARC 会通过
runner-container-hooks 在 runner 所在 namespace 里动态起额外的 job pod /
k8s job 来承载该 job；启用 DinD 模式时，runner pod 内则会再带上 DinD
sidecar / init container。

本文档介绍如何在 Alauda 容器平台 (ACP) 上部署并使用 GitHub Actions
self-hosted runner。底层是 GitHub 官方的 Actions Runner Controller (ARC)
项目，Alauda 将其重新打包为两个 ACP 集群插件：

- **Alauda Support for GitHub Actions Runner Controller**（下文简称
  "**控制器插件**"）—— ARC 控制平面，每个 ACP 集群装一次。
- **Alauda Support for GitHub Actions Runner Scale Set**（下文简称
  "**Scale-Set 插件**"）—— 提供一组与 GitHub 组织 / 仓库绑定的 self-hosted
  runner。**ACP 集群插件入口只支持一个默认实例**；如需在同一集群上跑多组
  互相隔离的 runner，可改走 ACP 平台的 **Catalog → Helm Chart** 入口
  （仍在 ACP UI 内完成，**不需要 `helm` 命令行**）多装几份上游
  `gha-runner-scale-set` chart 实例，详见
  [Chapter 4. 多团队 / 多项目隔离策略](#chapter-4-多团队--多项目隔离策略) 的 Method 3。

两个插件均只支持 ARC 的 **scale-set 模式**（不支持 legacy / runner-deployment
模式）。背景见 [为什么是 scale-set 模式（不是 legacy）](#为什么是-scale-set-模式不是-legacy)。

### 本文覆盖的内容

- 两个插件的安装与首个 workflow 验证（[Chapter 1](#chapter-1-安装控制器插件)
  至 [Chapter 2](#chapter-2-安装-scale-set-插件)）—— 新用户阅读这部分即可
  完成 self-hosted runner 的首次部署。
- Runner 镜像：内置 CLI 工具、运行身份、第三方 action 的处理。见
  [Runner 镜像](#runner-镜像)。
- 通过 Extra Values 做高级配置 —— ServiceAccount、资源限制、PVC 缓存、
  DinD 模式、自定义镜像等。见 [Chapter 3](#chapter-3-通过-extra-values-自定义-runner)。
- 多团队 / 多项目隔离策略。见 [Chapter 4](#chapter-4-多团队--多项目隔离策略)。
- workflow 写法实战：在自定义 container 里跑 job、触发集群里的 Tekton
  Pipeline、用 Buildah 以无 Docker daemon 的方式构建镜像（仍需
  privileged）。见
  [Chapter 5](#chapter-5-workflow-示例)。
- 故障排查与卸载。见 [Chapter 6](#chapter-6-故障排查) 与
  [Chapter 7](#chapter-7-卸载)。

### 两个插件一览

| 插件 | 作用 | 默认安装 namespace | 每集群多实例 |
|---|---|---|---|
| 控制器插件 | 承载 ARC 控制平面（控制器 Deployment、CRD） | `arc-systems` | 否 |
| Scale-Set 插件 | 定义一组绑定到 GitHub org / repo 的 runner scale-set | `arc-runners` | 通过集群插件入口装：否；通过 ACP **Catalog → Helm Chart** 装上游 chart：可以（见 Chapter 4 Method 3） |

### 适用范围

| 项 | 当前对应 |
|---|---|
| 上游 ARC 版本 | `gha-runner-scale-set-0.14.1`（chart values 参考章节链接均 pin 到该 tag） |
| Alauda 集群插件版本 | 与上游 0.14.1 对齐的 Alauda 打包版；具体版本号见 ACP Marketplace 上的插件详情页 |
| 验证的 GitHub 形态 | 实际验证：仅 GitHub.com（公网 `github.com`）。GitHub Enterprise Cloud 与 `github.com` 共用同一注册端点，**理论上支持**但本文未单独验证；GHES 同样**不在本文验证范围**，请把这两类形态的细节差异以现网真实状态为准 |
| 安装路径 | 通过 ACP Marketplace 装两个集群插件；通过 ACP **Catalog → Helm Chart** 装上游 chart 的路径不在本文主线（见 Chapter 4 Method 3） |

> **Note：** 本文里的实现细节（表单字段、镜像内置工具、UID/GID、chart
> values default、错误信息字面量等）都以上述基线为准。**插件版本或
> 上游 ARC 升级后部分细节可能变**；如遇与本文不一致的现象，请以现网
> 真实状态（`kubectl get autoscalingrunnerset -o yaml`、对应版本的上游
> `values.yaml`）为准。

### 术语表

| 缩写 | 全称 | 说明 |
|---|---|---|
| ARC | Actions Runner Controller | GitHub 官方的 self-hosted runner Kubernetes 控制器 |
| ACP | Alauda Container Platform | 本平台 |
| ARS | AutoscalingRunnerSet | ARC 核心 CRD，描述一组可伸缩的 runner |
| ER / ERS | EphemeralRunner / EphemeralRunnerSet | runner pod 与所属集合的 CRD |
| SA | ServiceAccount | Kubernetes ServiceAccount |
| GHES | GitHub Enterprise Server | GitHub 自部署版 |
| PAT | Personal Access Token | GitHub 个人访问令牌 |
| ECV | Extra Chart Values | 插件表单顶层 textarea，用于高级覆盖 |
| EGV | Extra Global Values | 同上但内容嵌入 chart 的 `global:` 块 |

---

## 架构理解

### 为什么是 scale-set 模式（不是 legacy）

ARC 上游有两种部署形态：**scale-set** 与 **legacy**（runner-deployment
模式）。Alauda 提供的两个集群插件**只**以 scale-set 模式打包，背景如下：

- **GitHub 官方推荐方向。** scale-set 是 GitHub 自 2023 年起力推的
  ARC 新模式；legacy 模式已进入维护态、不再加新特性。新部署一律走
  scale-set。
- **更安全的认证模型。** scale-set 推荐用 GitHub App 安装级凭证（也
  兼容 PAT），颗粒度比 PAT 细，可按仓库 / 组织授权，旋转更容易。
- **更原生的弹性伸缩。** scale-set 直接对接 GitHub 的 Actions Service
  （基于 job-acquisition 协议长轮询），任务来了拉起 ephemeral pod、
  跑完销毁，scale-from-zero 是默认行为，不需要常驻空闲 runner。
- **架构更简单。** legacy 模式靠 webhook 触发，需要 GitHub 能反向访问
  集群；scale-set 完全 outbound（集群 → GitHub），不需要给集群暴露
  公网入口。

### 组件如何协同

两个插件装好之后，集群上有四个逻辑组件分布在两个 namespace：

| 组件 | 所在 namespace | Pod 类型 | 归属 |
|---|---|---|---|
| 控制器 | `arc-systems` | Deployment | 控制器插件 |
| Listener（每个 scale-set 一个） | `arc-systems` | Pod（由控制器管理） | 控制器（代表 scale-set 起的） |
| AutoscalingRunnerSet (ARS) | `arc-runners` | CRD 资源 | Scale-Set 插件 |
| EphemeralRunner pod | `arc-runners` | Pod（按 workflow job 生命周期） | 控制器 |

新用户经常踩的几个不直观点：

- **Listener pod 跑在控制器命名空间**（`arc-systems`），不在 Scale-Set
  自己的 `arc-runners`。原因是 listener 由控制器创建并复用控制器的
  ServiceAccount / RBAC。
- 当 `minRunners=0` 时，没有 workflow 触发，`arc-runners` 里没有任何
  runner pod，是正常的。
- CRD（`AutoscalingRunnerSet`、`AutoscalingListener`、`EphemeralRunnerSet`、
  `EphemeralRunner`）由控制器插件创建，是 cluster 级。

### 安装包内置镜像清单

下表列出 ARC 各组件镜像在 Alauda 应用市场分发的安装包内是否预置，以及
air-gap 环境需要做什么：

| 组件 | 镜像 | 内置 | air-gap 处理 |
|---|---|---|---|
| 控制器 | `gha-runner-scale-set-controller` | ✅ 控制器插件内置 | 无需处理 |
| Listener | 由控制器 fork 同一镜像 | ✅ | 无需处理 |
| Runner 主容器 | `gha-runner-scale-set-runner-extension` | ✅ Scale-Set 插件内置 | 无需处理 |
| DinD sidecar | `docker:<tag>-dind` | ❌ | 需将上游镜像同步到平台镜像仓库；见 [Recipe 8](#recipe-8-dind-模式在-runner-里跑-docker-build) 与 [Recipe 9](#recipe-9-覆盖-arc-镜像自定义版本--替换镜像源) |

**结论：** 不启用 DinD 模式时，安装包在 air-gap 集群里能端到端跑通；
启用 DinD 需要额外同步一个镜像。

> **关于 air-gap 中的第三方 action：** 形如
> `uses: actions/checkout@v4` 这类 step 在 runtime 需要从 `github.com`
> 拉 action 源码。runner 镜像不预绑定 action 源码，平台插件也不提供
> action mirror。air-gap 处理方案见
> [使用第三方 action（`uses:`）](#使用第三方-actionuses)。

### 平台默认运行时配置

通过 ACP 应用市场安装时，插件 chart 自动接收以下值，您**无需**手工配置：

- `global.registry.address` —— 平台镜像仓库地址前缀；ARC 各组件镜像
  自动加上此前缀拉取。
- `global.registry.imagePullSecrets` —— 拉取平台仓库的凭证，由平台
  控制器自动维护。
- `global.images.<component>.repository` —— 默认指向平台仓库内 ARC 镜像
  的路径。

仅当您需要覆盖镜像源（自定义上游版本 / 私有仓库 sub-path / DinD 镜像）
时，才需要在 **Extra Global Values** 里写 `images:`。详见
[Recipe 9](#recipe-9-覆盖-arc-镜像自定义版本--替换镜像源)。

> **Warning：** 不要在 EGV 里写 `registry:` 子键。平台已渲染过
> `global.registry`；如果您写 `  registry:`（EGV 内部 2 空格缩进），
> 会被静默丢弃 —— 配置无效但不会报错。

### Runner 镜像

两个插件装好之后，您可能想知道 runner 镜像里有什么、以什么身份运行。

#### 预装的 CLI 工具

Runner 镜像内置了 CI / CD 场景常用的命令行工具，您可以在 workflow
`run:` step 里直接调用：

| 类别 | 工具 |
|---|---|
| Kubernetes | `kubectl`、`helm` |
| Tekton | `tkn` |
| 通用 CLI | `git`（含 git-lfs）、`curl`、`jq`、`yq` |
| Shell / 解压 | `bash`、`tar`、`unzip`、`zip`、`gzip`、`zstd` |
| Node.js 运行时 | Node 20 / Node 24（仅 runtime —— 见下方说明） |
| OpenSSH | `ssh` |

补充说明：

- **Docker 不在预装清单内。** Alauda runner 镜像基于
  `almalinux:9-minimal`，刻意**不**装 `docker` / `docker-compose` /
  `dockerd` / `containerd` / `buildx` / `runc`，以保持镜像精简、CVE
  暴露面小。Container Mode = `dind` 模式会由上游 chart 起一个独立的
  `docker:dind` sidecar 提供 docker daemon，但 sidecar 里的 docker CLI
  **不会自动**出现在 runner pod。如果 step 真的要调 `docker` /
  `docker-compose`，标准做法是按
  [Recipe 9](#recipe-9-覆盖-arc-镜像自定义版本--替换镜像源) 自定义一个
  **内置 docker CLI** 的 runner 镜像，再通过 `images.runnerExtension`
  替换默认镜像。
  - **不建议在 step 里用 `microdnf install -y docker-ce-cli` 临时装。**
    默认 runner 以非 root `runner` 用户（UID/GID 1001）运行，普通 step
    里先天就不适合做系统包安装；而且 Alauda runner 镜像默认只启用
    AlmaLinux BaseOS / AppStream 仓库，`docker-ce-cli` 也不在其中。
    临时安装既要解决 root 权限，又要额外配置 docker.io 仓库，脆弱且每个
    step 都要重做。
  - **也不要切到 `jobs.<id>.container.image:`。** DinD 模式与 GHA
    `container:` 字段不兼容（详见 [Example 1](#example-1-让单个-job-跑在自定义-container-里)
    的 Warning）。
- **Node.js (20 / 24) 只是 embedded runtime** —— 镜像里的 Node 是上游
  剥过的（**不带 `npm` / 不带 `corepack` / 不带 Alpine 变体**），仅满足
  JavaScript action 自身运行所需。如果 step 要用完整 Node 开发环境，调
  `actions/setup-node@v5`，它会按需现场装一份完整工具链。
- **`kubectl` / `tkn` 默认只有一小部分基础权限，不等于业务 RBAC。**
  这些工具被装在 runner 镜像里，但 runner pod 默认使用的
  ServiceAccount 主要只带 runner container hooks 所需的 namespace
  级基础权限（如 `pods`、`pods/log`、`pods/exec`、`secrets`；具体还会受
  当前 container mode 影响），并不天然等于“可以随意查 / 改集群资源”。
  如果 workflow 需要访问 Tekton、Deployment、CRD 或业务 namespace
  资源，仍应按
  [Recipe 1](#recipe-1-runner-pod-用自定义-serviceaccount跑-in-cluster-任务)
  给 runner 配一个有明确 RBAC 的 ServiceAccount。
  实际生效权限还可能被平台上额外的 RoleBinding / ClusterRoleBinding
  放大，因此不要靠“文档印象”判断，建议用
  `kubectl auth can-i --list --as system:serviceaccount:<runner-ns>:<runner-sa> -n <runner-ns>`
  现场确认。

#### 如果缺少您需要的工具

如果工作流需要的工具不在上表内，按下面三种方式之一处理：

1. **优先用 step 级工具安装 action**：如 `actions/setup-node@v5`、
   `actions/setup-go@v5`、`actions/setup-java@v4` 等。只有当您明确切到
   了一个允许 root 装包的自定义 job container 时，才考虑在 `run:` 里调
   包管理器。Alauda 默认 runner 镜像虽然基于 `almalinux:9-minimal`、
   **自带 `microdnf`，不是 `dnf`**，但 runner 本身以 UID/GID 1001
   非 root 运行，普通 workflow step 里直接
   `microdnf install -y <包名>`（例如 `make`）通常会因权限失败。
2. **用 workflow `container:` 切到自定义镜像**：在 job 上加
   `jobs.<id>.container.image:` 指向一个内置该工具的镜像。**仅适用于**
   `kubernetes-novolume`（默认）或 `kubernetes` 模式；`dind` 模式不支持
   GHA 的 `container:` 字段。参考
   [Example 1](#example-1-让单个-job-跑在自定义-container-里)。
3. **替换默认 runner 镜像**：定制一个包含您需要工具的 runner 镜像，
   通过 [Recipe 9](#recipe-9-覆盖-arc-镜像自定义版本--替换镜像源)
   把 `images.runnerExtension` 指过去。

#### 运行身份

- **UID / GID：** 1001 / 1001（非 root `runner` 用户）。
- **`HOME`：** `/home/runner`。
- **当前启动链路：** chart / overlay 会显式执行
  `command: ["/home/runner/run.sh"]`，再由 `run.sh` 启动 runner 进程。
  `entrypoint.sh` / `startup.sh` 属于上游 runner 镜像的传统启动链路，不是
  当前 Alauda runner-extension 镜像的主执行入口。
- **资源限制场景：** 在 [Recipe 4](#recipe-4-限制-runner-的-cpu--memory)
  给 runner 容器加 `resources` 时，**必须保留**
  `command: ["/home/runner/run.sh"]`（chart 默认就是这个）。漏写时 pod
  会起来但 runner 进程不会执行 `run.sh`（退回到基础镜像默认启动行为），
  导致 workflow 一直 Queued。

#### 使用第三方 action（`uses:`）

GitHub Actions 的 `uses: actions/checkout@v4` 这类 step 让 workflow
调用社区维护的可复用 action。runner 在 step 执行前会从 GitHub 拉
action 源码到 pod 的 `/home/runner/_work/_actions/`，再交给 Node.js
运行。**这是 runtime 行为，不是镜像里预装的**。

##### Method 1：直连 / HTTPS 代理

集群有出站直连 `github.com` 的网络时，workflow YAML 里照常写：

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v5
    with:
      node-version: '20'
  - run: npm ci
```

如果集群没有直连但有出站 HTTPS 代理（企业网关常见），需要给 runner
pod 注入 `HTTPS_PROXY`，按 [Recipe 2](#recipe-2-在-runner-容器内注入-secret--自定义-env)
把下面这段贴进 Scale-Set 插件的 **Extra Chart Values** 字段（YAML 中
的 `image:` 与 `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` 是 helm 数组替
换语义下必填的兜底字段，参见 [Chapter 3 Step 1](#step-1-理解-ecv-vs-egv)
安全骨架）：

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>          # 必填；见 Recipe 9 获取现网镜像路径
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                         # kubernetes-novolume / dind 模式必填
      - name: HTTPS_PROXY
        value: "http://proxy.example.com:3128"
      - name: NO_PROXY
        value: "<内网域名>,localhost,127.0.0.1"
```

##### Method 2：air-gap —— 把 action 同步到内网 GHES

集群完全没有出站到 `github.com` 时，ARC **没有**内建 action mirror 能力
—— runner 镜像不预绑定任何 action 源码，平台插件也没有 "action 源 URL
转发" 配置项。

第一种思路是把 `actions/checkout` 等需要的 action 仓库 fork（或 mirror）
到**您注册 runner 用的那个 GitHub 实例**（即 `githubConfigUrl` 指向
的 host —— 一般是内网 GHES），然后在 workflow 里把 `uses:` 改成内网
路径：

```yaml
steps:
  - uses: my-org/checkout@v4   # 假设已经把 actions/checkout 镜像到同一个 GHES 实例
```

runner 解析 `uses:` 时会按 `githubConfigUrl` 推断的 base URL 去拉 action
源 —— 所以 `my-org/checkout` 必须在**同一个 GitHub 实例**（github.com
或 GHES）上才可达。

> **Note —— 内网 git 是 GitLab / Gitea / Gitee 的情况。** GitHub Actions
> 的 `uses: owner/repo@ref` 协议只解析到 GitHub 实例，无法直接从
> GitLab / Gitea / Gitee 拉取。这种环境里 Method 2 不可用，请改走下面
> 的 Method 3（在 `run:` 里自己写 `git clone`）。

##### Method 3：air-gap —— 完全不用 `uses:`，用 `run:` 自己写脚本

最朴素的兜底，完全不依赖任何 action 仓库 mirror。`actions/checkout@v4`
的功能用一行 `git clone` 就能替代：

```yaml
steps:
  - name: checkout
    env:
      GIT_TOKEN: ${{ secrets.INTERNAL_GIT_TOKEN }}
    run: |
      git clone --depth=1 \
        "https://oauth2:${GIT_TOKEN}@my-internal-git.example.com/${GITHUB_REPOSITORY}" .
```

workflow 写起来长一点，但**完全不依赖 GitHub.com、也不依赖 action 仓库
镜像**，最稳。

> **Warning —— runner 注册到 github.com 但集群无出站时：** Method 2
> 的前提是 `githubConfigUrl` 指向的实例集群里能访问到。如果 runner
> 注册到 github.com 但 runner pod 又出不了网，**`uses:` 没有可行路径**，
> 只能改用 Method 3，或给集群开通到 github.com 的代理。

---

## 公共基础配置

### 环境准备

#### 系统要求

- 一个 ACP 集群（global 集群或业务集群均可）。
- 集群有出站网络能访问 GitHub Actions runner 所需的 GitHub 域名。对
  GitHub.com，至少包括 `github.com:443`、`api.github.com:443`、
  `*.actions.githubusercontent.com:443`；更多域名以及 GHES 场景的要求
  请以 GitHub 官方 self-hosted runner communication requirements 为准，
  不要简单理解成“只替换两个域名”。
- air-gap 集群参见 [安装包内置镜像清单](#安装包内置镜像清单) 了解需要
  预先同步哪些镜像；workflow 中 `uses:` 的处理方案见
  [使用第三方 action（`uses:`）](#使用第三方-actionuses)。

#### 必需组件

- 控制器插件（Alauda Support for GitHub Actions Runner Controller）。
- Scale-Set 插件（Alauda Support for GitHub Actions Runner Scale Set）。
- 一种 GitHub 凭证 —— GitHub App 或 PAT。

#### 权限要求

- 安装两个集群插件需要集群管理员权限。
- 创建 namespace 的权限（默认 `arc-systems` 与 `arc-runners`）。
- 一个 GitHub 身份（App 或 PAT），按 `githubConfigUrl` 的范围选择认证方式：

| `githubConfigUrl` 范围 | GitHub App | PAT |
|---|---|---|
| 仓库级（`https://github.com/<org>/<repo>`） | 支持 | 支持 |
| 组织级（`https://github.com/<org>`） | 支持 | 支持 |
| 企业级（`https://github.com/enterprises/<enterprise>`） | **不支持**（GitHub 平台限制） | 支持（**唯一选择**） |

> **Note —— 企业级 ARC 只能用 PAT。** GitHub 在 enterprise 级 runner 注册
> 场景下不接受 GitHub App 认证（[GitHub 官方文档](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api)
> 明确说明）。如果您要装的 scale-set `githubConfigUrl` 是企业级，准备
> Secret 时跳过下面 Method 1（GitHub App），直接走 Method 2（PAT）。

按选定的认证方式给 GitHub 身份配置最小权限：

- **GitHub App，仓库级 scale-set** ——
  - Repository：`Administration: Read & Write`、`Metadata: Read`
- **GitHub App，组织级 scale-set** ——
  - Repository：`Metadata: Read`
  - Organization：`Self-hosted runners: Read & Write`
- **PAT (Classic)** —— 按 `githubConfigUrl` 范围选 scope：仓库级勾选
  `repo`；组织级勾选 `admin:org`（已含 self-hosted runners 写权限）；
  企业级勾选 `manage_runners:enterprise`（**这是企业级 ARC 唯一可行
  的 PAT 类型** —— Fine-grained PAT 不支持企业级）。
- **PAT (Fine-grained)** —— **仓库级**：Repository permissions
  `Administration: Read and write`。**组织级**：Repository permissions
  `Administration: Read` + Organization permissions
  `Self-hosted runners: Read and write`。**企业级不支持**。

> **来源：** scope 名称与组合方式以
> [GitHub 官方 ARC 鉴权文档](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api)
> 为准。
>
> GitHub 官方还有一条容易忽略的注释：`Administration: Read & Write`
> **只在仓库级注册时需要**；组织级注册不需要这一项。

### GitHub 凭证准备

下面两种方式选一种，创建一个让 runner 认证到 GitHub 的 Secret。本步骤
可以在 Scale-Set 插件**之前或之后**做：先创建 Secret 不会被插件覆盖。
如果是**首次安装后才补建**这个 Secret，相关 pod 通常会在 Secret 出现后
自动恢复；若几分钟后仍未恢复，再手动删一次 listener pod 触发重建。
如果是**轮换一个已经存在的 Secret 内容**，listener pod **不会自动感知**
这次变化（controller 没有 watch Secret 资源），需要手动触发一次重建：

```shell
$ kubectl -n arc-systems delete pod \
    -l actions.github.com/scale-set-name=<scale-set-name>
```

controller 会用新凭据重建 listener pod 并重新连接 GitHub。

默认 Secret 名 `gha-runner-scale-set-github-config`。如要换名，在
[Chapter 2 Step 2](#step-2-在应用市场安装-1) 的 **GitHub Credentials Secret Name**
字段填新名即可。

> **Note：** 如果您计划把 Scale-Set 插件安装到自定义 namespace，下面
> Method 1 / Method 2 命令里的 `arc-runners` 都要同步替换成那个
> namespace。**GitHub 凭证 Secret 必须与 Scale-Set 的 Install Namespace
> 完全一致。**

#### Method 1：GitHub App 方式（推荐）

```shell
$ kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f -

$ kubectl -n arc-runners create secret generic gha-runner-scale-set-github-config \
    --from-literal=github_app_id=<your-app-id> \
    --from-literal=github_app_installation_id=<your-installation-id> \
    --from-file=github_app_private_key=/path/to/your-app.private-key.pem
```

三个字段的获取方式（前两项来自同一个 GitHub App 设置页，第三项来自把
App 装到目标 org / repo 之后的安装 URL）：

- **`github_app_id`**：在 GitHub UI **Settings → Developer settings →
  GitHub Apps → 您的 App** 页面，"About" 区块里的 `App ID` 字段，是
  一串数字。如果改用 YAML manifest（而不是
  `kubectl create secret --from-literal`）创建 Secret，**这个值必须加
  引号写成字符串**（如 `github_app_id: "123456"`），否则 ARC 会报
  `failed to get app id: strconv.ParseInt`。
- **`github_app_private_key`**：在同一个 App 设置页底部 "Private keys"
  区点击 "Generate a private key" 下载 `.pem` 文件，把路径填到
  `--from-file=github_app_private_key=...` 即可。**必须用 `--from-file`，
  不要用 `--from-literal`** —— PEM 文件每行必须保留换行；用
  `--from-literal` 会把多行内容塌成一行，导致 listener 日志报
  `failed to parse private key`。
- **`github_app_installation_id`**：先把 App 装到目标 org / repo ——
  到 **GitHub Apps → 您的 App → "Install App" 标签页**，选择目标
  organization / repository 安装。装完后回到 "Install App"，点对应
  org / repo 那一行的 "Configure"，浏览器跳转后的 URL 形如
  `https://github.com/organizations/<org>/settings/installations/12345678`，
  **末尾的 `12345678` 就是 `installation_id`**。如果填错，listener
  日志会出现 `Could not find any installation` 报错。

#### Method 2：PAT（Personal Access Token）方式

**生成 PAT**：在 GitHub UI **Settings → Developer settings → Personal
access tokens** 创建。两种 token 可选；权限按 `githubConfigUrl` 范围
配置（详细 scope 列表与权威解释见
[GitHub 官方 ARC 鉴权文档](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api)）：

- **Fine-grained（细粒度，推荐）**：按单个仓库 / 组织授权。创建时选择
  Resource owner（个人或组织）与目标仓库（All / Only select repositories）。
  **Fine-grained PAT 不支持企业级 ARC。**
  - **仓库级 `githubConfigUrl`** —— Repository permissions：
    `Administration: Read and write`。
  - **组织级 `githubConfigUrl`** ——
    - Repository permissions：`Administration: Read`
    - Organization permissions：`Self-hosted runners: Read and write`
- **Classic（旧版）**：scope 较粗，**企业级 ARC 唯一选择**。
  - **仓库级**：勾选 `repo`。
  - **组织级**：勾选 `admin:org`。
  - **企业级**：勾选 `manage_runners:enterprise`。

详细步骤参见 GitHub 官方文档
[Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

拿到 token 后，把它写进 Secret：

```shell
$ kubectl -n arc-runners create secret generic gha-runner-scale-set-github-config \
    --from-literal=github_token=ghp_xxxxxxxxxxxxxxxxxxxxx
```

### Workflow 侧：`runs-on:` 要求

本文（Alauda 当前已验证路径）只覆盖**单字符串**用法 —— 值等于您在
Scale-Set 插件里设置的 `runnerScaleSetName`：

```yaml
# Alauda 已验证：单字符串
runs-on: my-runners
```

> **Note —— 想让一个 scale-set 同时承接多组 label？** 上游 chart 的
> `scaleSetLabels` 字段配合数组形式 `runs-on:` 即可做到，**但有一条
> install-time-only 的关键约束**：装完 scale-set 之后再改 labels 不会
> 通告给 GitHub。完整链路、注入方式与"已装完想改 labels 怎么办"见
> [Workflow 侧：runs-on 数组形式与 scaleSetLabels](#workflow-侧runs-on-数组形式与-scalesetlabels)。

**最常见错误**是直接写 `runs-on: [self-hosted, label]`（legacy ARC
语法）而没有在 scale-set 上配套设 `scaleSetLabels`，结果 GitHub 端
永远匹配不上 —— 注意这跟新 scale-set 模式下的数组形式（首项是
`runnerScaleSetName`，不是 `self-hosted`）是两件事。诊断路径见
[Issue 3](#issue-3-workflow-stays-queued---runner-永远不来)。

### Workflow 侧：`runs-on:` 数组形式与 `scaleSetLabels`

让一个 scale-set 同时承接多种 job（例如同一组 runner pod 既要跑通用
job、又要跑 GPU 限定 job），又不想拆出多个独立 scale-set 时，可以用
**数组形式** `runs-on:` 配合 chart 的 `scaleSetLabels` 字段。本节给出
完整的注入与匹配规则，并明确一条**容易踩坑的关键约束**：在 chart
0.14.1 上 `scaleSetLabels` **只在 scale-set 首次创建时生效**，安装后
再改不会通告给 GitHub。

> **⚠️ 关键约束 —— `scaleSetLabels` 是 install-time-only**
>
> 这是上游 ARC 在 chart 0.14.1 的设计：scale-set 在 GitHub 端首次注册
> 时把 labels 一次性通告过去；之后即使本地 chart values 改了
> `scaleSetLabels`，ARC 也**不会**再把新 labels 推送给 GitHub。
>
> 后果：装好 scale-set 之后再改 `scaleSetLabels`（无论是改 ECV、改
> moduleinfo、还是 helm upgrade），本地 ARS spec 会更新，但 GitHub 端
> 通告的 label 集合不变 —— workflow 的数组形式 `runs-on:` 会与 GitHub
> 端的旧 label 集合比对，永远卡 `Queued`。本节后面的"安装后想改 labels
> 怎么办"给出绕过该约束的两条路径。

**完整链路（首次安装时）：**

1. chart values 顶层字段 `scaleSetLabels: [...]`（默认 `[]`）。
2. chart 模板把它原样写进 `AutoscalingRunnerSet.spec.runnerScaleSetLabels`。
3. **首次** reconcile：controller 调 `CreateRunnerScaleSet` 把
   `runnerScaleSetName` + `runnerScaleSetLabels` 一起注册到 GitHub。
4. workflow `runs-on: [<scale-set-name>, A, B]`：第一项必须等于
   `runnerScaleSetName`（Scale-Set 插件表单里的 **Runner Scale-Set Name**）；
   后续每一项都必须出现在 GitHub 端通告的 label 集合里
   （subset-of-advertised，AND 关系）。

**注入方式 —— 安装前在 ECV 写好（ACP form 不暴露此字段）：**

最稳的做法是**装 scale-set 插件之前**就把 labels 写进 ECV，让首次
reconcile 直接带着这些 labels 注册到 GitHub：

1. 在 Marketplace → Cluster Plugins 找到 ARC Scale-Set 插件，但**先别
   点 Install**。
2. 在表单的 **Extra Custom Values** 字段（即 ECV）里填入：

   ```yaml
   scaleSetLabels:
     - linux
     - gpu
   ```

3. 提交安装。
4. 等 ARS reconcile 成功，核对：

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
       -o jsonpath='{.spec.runnerScaleSetLabels}'
   # 期望：列出 ECV 里写的所有 label
   ```

如果**已经装完**才想加 labels，参见下一节"安装后想改 labels 怎么办"。

**workflow 写法：**

```yaml
# 数组形式 —— 第一项必须等于 runnerScaleSetName，
# 后续每项都必须在创建时已通告给 GitHub。
jobs:
  build:
    runs-on: [my-runners, linux, gpu]
```

**安装后想改 labels 怎么办：**

由于上游约束，**唯一可靠的换 label 方法**是让 GitHub 端先"忘记"这个
scale-set，再让 controller 重新注册：

- **方式 A（推荐，干净）**：先卸载 Scale-Set 插件（参见
  [Chapter 7](#chapter-7-卸载)），写好新的 ECV `scaleSetLabels:` 后
  重新安装。期间正在跑的 workflow 会失败，需要在维护窗口操作。
- **方式 B（仅在 GitHub 端有权限时）**：用 PAT 调 GitHub API 删除该
  scale-set 注册条目；下一次 controller reconcile 会把它当作"不存在"
  重新注册，自动带上当前 ARS spec 里的 labels。**这条路径上游不保证
  全程 idempotent**，删除后短时间内 listener 可能 CrashLoop，等
  controller 重新创建即可。

**chart 校验上限：**

- 每个 label 必须**非空**且**长度 < 256 字符**；违反时 chart 渲染会
  失败，moduleinfo status 会回报错误。

**workflow runs-on 数组形式的常见错觉：**

- 数组形式是 **AND**：每一项都必须在通告集合里；只要有一项缺失，
  GitHub 端永远找不到匹配，workflow 一直 `Queued`，listener 也不会主动
  报错。
- **不要**把第一项写成 `self-hosted`：那是 legacy ARC
  （`RunnerDeployment`）的语法，scale-set 模式不识别。
- "我改了 ECV，labels 也确实在 ARS spec 里出现了，为什么 workflow 还是
  卡 Queued？" —— 看上面的 ⚠️ 关键约束块，几乎一定是因为安装后改
  labels 没有传给 GitHub。

**排错：workflow 卡在 Queued？**

1. 检查 ARS 是否真的通告了那些 label：

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
       -o jsonpath='{.spec.runnerScaleSetLabels}'
   ```

2. 比对 workflow 里 `runs-on:` 数组的每一项 —— 第一项要等于
   `runnerScaleSetName`，其余每项都要在上一步输出里。
3. **如果第 1 步看到 labels 都在但 workflow 还是 Queued**，几乎可以
   肯定是 install-time-only 限制（您是先装的 scale-set 后改的 ECV
   labels）。回到上面"安装后想改 labels 怎么办"按方式 A/B 处理。
4. listener 日志可以确认 GitHub 端有没有把 job 发过来：

   ```shell
   $ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=50
   # 真的收到时会出现 "Acquired job ..." 字样；持续没有则是 GitHub
   # 端没有匹配，回到第 3 步排查
   ```

---

## Chapter 1. 安装控制器插件

### Step 1: 先决条件

安装前确认：

- 目标集群上已创建 `arc-systems` namespace（安装器不会替您创建）：
  ```shell
  $ kubectl create namespace arc-systems --dry-run=client -o yaml | kubectl apply -f -
  ```
- 您具备集群管理员权限，能安装集群插件。

### Step 2: 在应用市场安装

在 ACP UI 上：**Administrator → Marketplace → Cluster Plugins**，找到
**Alauda Support for GitHub Actions Runner Controller**，点开后选目标
集群 → 安装。

表单字段：

| 字段 | 默认 | 安装后可改 | 备注 |
|---|---|---|---|
| Install Namespace | `arc-systems` | 否 | 极少自定义；如填的 namespace 在集群上不存在，**安装会失败**，请先创建。改名后 Scale-Set 插件的 Controller Namespace 必须同步改 |
| Log Level | `info` | 是 | 排错时改 `debug` |
| Log Format | `json` | 是 | 默认 JSON 便于平台日志聚合；排错时改 `text` 更易读 |
| Enable Metrics | `false` | 是 | 接 Prometheus 时改 `true`，会在 controller 与 listener pod 暴露 8080 端口 |
| Runner Max Concurrent Reconciles（高级） | `2` | 是 | EphemeralRunner 数 > 50 时调高 |
| Update Strategy（高级） | `immediate` | 是 | 升级时立即重建（默认）/ 等 runner 跑完（`eventual`） |
| Extra Chart Values (YAML)（高级） | 空 | 是 | 见 [Chapter 3](#chapter-3-通过-extra-values-自定义-runner) |
| Extra Global Values (YAML)（高级） | 空 | 是 | 见 [Recipe 9 控制器插件部分（A）](#a--控制器插件) |

### Step 3: 验证控制器已运行

控制器插件状态转 `Installed` 时，目标集群上会出现：

- `arc-systems` 命名空间。
- `Deployment/arc-gha-rs-controller`。
- `ServiceAccount/arc-gha-rs-controller`。
- 一组 ARC CRD：`AutoscalingRunnerSet`、`AutoscalingListener`、
  `EphemeralRunnerSet`、`EphemeralRunner`。

> **Note：** 下面命令按默认控制器 namespace `arc-systems` 展示；如果您
> 安装时用了自定义控制器 namespace，请把命令里的 `arc-systems` 替换成
> 实际值。

验证命令：

```shell
$ kubectl -n arc-systems get pod
# 期望：arc-gha-rs-controller-...   1/1   Running

$ kubectl get crd | grep actions.github.com
# 期望：列出 4 个 CRD
```

> **Note：** 控制器装完后什么 runner 也不会起 —— 接下来要装 Scale-Set
> 插件，它才真正定义 runner 池。

---

## Chapter 2. 安装 Scale-Set 插件

> **Note —— 安装前先规划好 namespace。** 表单的 **Install Namespace**
> 字段（默认 `arc-runners`）在插件安装后会锁定，不允许修改；如果需要
> 换 ns，必须先卸载再重新安装。**典型场景下用默认 `arc-runners` 即可**；
> 如果按团队 / 业务线拆分 runner（例如 `team-a-runners`、
> `team-b-runners`），请在安装前就规划好命名空间，本章后续命令也都换
> 成同一个 ns。
>
> 同时注意：**GitHub 凭证 Secret 必须创建在与 Scale-Set 插件相同
> 的 namespace 里** —— 也就是说，下面的 `kubectl create namespace ...`
> 和 `kubectl -n <ns> create secret ...` 这两步的 `<ns>` 必须一致。
> 如果您计划装到 `team-a-runners`，请把两条命令中的 `arc-runners`
> 都换成 `team-a-runners`。

### Step 1: 先决条件

- 控制器插件已经安装并 `Running`（[Chapter 1](#chapter-1-安装控制器插件)）。
- 目标集群上已创建 `arc-runners` namespace：
  ```shell
  $ kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f -
  ```
- GitHub 凭证 Secret 已经在 `arc-runners` 创建。见
  [GitHub 凭证准备](#github-凭证准备)。

### Step 2: 在应用市场安装

回到 **Cluster Plugins** 列表，找到 **Alauda Support for GitHub Actions
Runner Scale Set**，点开后选**同一个集群**（必须与控制器插件同集群）→
安装。

表单字段：

| 字段 | 默认 | 必填 | 安装后可改 | 备注 |
|---|---|---|---|---|
| Install Namespace | `arc-runners` | 是 | 否 | runner pod 跑在这。如填的 namespace 在集群上不存在，**安装会失败**；请先创建 |
| GitHub URL | 无 | 是 | 否 | 见下面 [GitHub URL 三种格式](#github-url-三种格式)。**安装后为只读，不支持在线修改。** 如需切换目标 repo / org / enterprise，请按新实例重建或卸载后重装，并到 GitHub **Settings → Actions → Runners** 核对并清理旧的 scale-set 注册条目。 |
| GitHub Credentials Secret Name | `gha-runner-scale-set-github-config` | 是 | 否 | 必须与 [GitHub 凭证准备](#github-凭证准备) 创建的 Secret 名一致；**安装后为只读，不支持在线修改** |
| Controller Namespace | `arc-systems` | 是 | 否 | **必须与控制器插件 Install Namespace 一致**，否则 Scale-Set 侧对 controller 的引用与授权绑定会指错对象，listener / runner 相关资源无法被正常创建或更新。注意 listener pod 实际起在这个 namespace 里（不是 Scale-Set 自己的 `arc-runners`），验证时用 `kubectl -n arc-systems get pod` 查它 |
| Controller ServiceAccount Name（高级） | `arc-gha-rs-controller` | 是 | 否 | 控制器插件创建的 SA 名；通过插件装的不要改 |
| Runner Scale-Set Name | 空 | 否 | 否 | **GitHub 端识别这组 runner 的名字，workflow 的 `runs-on:` 要写这个值。** 留空时 chart 会用 Helm release name（默认 `arc-runner-set`）作为 fallback；如果 release name 后续发生变化，GitHub 端会注册新的 scale-set，旧条目仍占用 GitHub Actions 的注册名额，需要手动到 GitHub UI **Settings → Actions → Runners** 删除。建议填写一个与业务场景对应的固定名称 |
| Min Runners | `0` | 否 | 是 | 常驻最少 runner pod 数。0 = 纯按需 |
| Max Runners | `5` | 否 | 是 | 同时存在的最多 runner pod 数 |
| Container Mode（高级） | `kubernetes-novolume` | 否 | 是 | 见下面 [Container Mode 怎么选](#container-mode-怎么选)。**留空** 用于完全自定义（必须在 ECV 完整接管 `containerMode:` 块） |
| Extra Chart Values (YAML)（高级） | 空 | 否 | 是 | 见 [Chapter 3](#chapter-3-通过-extra-values-自定义-runner) |
| Extra Global Values (YAML)（高级） | 空 | 否 | 是 | 见 [Recipe 9 Scale-Set 插件部分（B）](#b--scale-set-插件) |

#### GitHub URL 三种格式

| 范围 | URL 格式 | 用例 |
|---|---|---|
| 单仓库 | `https://github.com/<org>/<repo>` | 项目级 self-hosted |
| 组织级 | `https://github.com/<org>` | 组织内所有仓库共用 |
| 企业级 | `https://github.com/enterprises/<enterprise>` | GHEC enterprise |

GitHub Enterprise Server (GHES) 自部署：把 `https://github.com` 换成
您 GHES 的 URL 即可。

#### Container Mode 怎么选

新用户从下面三个表单选项里挑一个即可：

| 表单选项 | 适用 |
|---|---|
| `kubernetes-novolume`（默认） | 适用于大多数 workflow（不需要在 runner 内启 docker、不需要 PVC 持久工作目录）；无特殊需求时可作为默认选项 |
| `dind` | workflow 里要跑 `docker build` / `docker push` |
| **（留空）** | 高级用法，需要在 Extra Chart Values 完整接管 `containerMode:` 块（如 kubernetes 模式 + PVC、自定义 containerMode 字段等） |

> **Warning —— 不要直接在表单选 `kubernetes`。** 表单虽然有
> `kubernetes` 选项，但直接选会让 chart 渲染出缺少
> `kubernetesModeWorkVolumeClaim` 字段的 ARS，被 CRD 校验拒绝。如需
> kubernetes 模式（持久工作目录、container-job、`actions/cache@v4`
> 等 PVC 能力），请把表单 **留空**，并在 Extra Chart Values 里完整写
> `containerMode:` 块 —— 详见
> [Recipe 7](#recipe-7-kubernetes-模式--持久工作目录)。

#### Min / Max Runners 怎么定

- `minRunners=0`：纯按需，没 workflow 就 0 pod。第一次触发 workflow
  会有约 10s 启动延迟（pod 启动 + GitHub 注册）。
- `minRunners=1`：始终常驻 1 个 idle runner，第一次触发延迟 < 1s，但
  占资源。
- `maxRunners`：上限。按集群资源 + 同时跑的 workflow 数估算（建议在
  [Recipe 4](#recipe-4-限制-runner-的-cpu--memory) 里给 runner 加
  resources 限制）。

### Step 3: 验证 listener 与 AutoscalingRunnerSet

等插件实例转为 `Installed`，再依次检查下列资源：

> **Note：** 下面命令默认假设控制器在 `arc-systems`、Scale-Set 在
> `arc-runners`。如果您自定义了 namespace，请同步替换。

```shell
# 控制器在 arc-systems
$ kubectl -n arc-systems get pod
# 期望：arc-gha-rs-controller-...     1/1     Running

# listener 也在 arc-systems（不是 arc-runners！）
$ kubectl -n arc-systems get pod -l app.kubernetes.io/component=runner-scale-set-listener
# 期望：<scaleset>-...-listener     1/1     Running
```

> **Note：** **listener pod 在控制器命名空间（默认 `arc-systems`）**，
> 不在 Scale-Set 自己的 `arc-runners`。这是 ARC 架构使然 —— listener
> 是控制器代理 scale-set 起的，必须用控制器的 SA / RBAC。如果您
> minRunners=0，`arc-runners` 里这时什么 pod 都没有，是正常的。

验证 AutoscalingRunnerSet 状态：

```shell
$ kubectl -n arc-runners get autoscalingrunnerset
# 列：MAXIMUM RUNNERS / CURRENT RUNNERS / STATE
```

到 GitHub 端确认 runner 已注册：打开您的 GitHub 仓库（或 org /
enterprise）的 **Settings → Actions → Runners**，应当看到一个名字与
`runnerScaleSetName` 一致的 runner，状态显示为 `Online`（已连接、
空闲，对应上游文档里所说的 idle 状态）或 `Active`（正在执行任务）。

### Step 4: 触发一个最小 workflow

在您的 GitHub 仓库放一个 `.github/workflows/smoke.yaml`：

```yaml
name: ARC Smoke
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: my-runners      # 本文当前已验证的最稳妥写法：直接写 runnerScaleSetName 单字符串
    steps:
      - name: runner identity
        # 优先使用 GitHub 提供的环境变量与 shell 内置变量，避免依赖
        # 某个基础镜像是否恰好带了 `hostname` 之类的 OS 命令；这里直接
        # 用 ${HOSTNAME} 更稳。
        run: |
          echo "runner_name: ${RUNNER_NAME:-unknown}"
          echo "hostname:    ${HOSTNAME:-unknown}"
          echo "workspace:   ${GITHUB_WORKSPACE:-unknown}"
          echo "job:         ${GITHUB_JOB:-unknown}"
          echo "whoami:      $(whoami)"
          id
          echo "pwd:         $(pwd)"
```

提交后到 GitHub Actions 页面手工触发或 push 一次。观察 runner pod
跑起来又消失：

```shell
$ kubectl -n arc-runners get pod -w
# 期望：一个 EphemeralRunner pod 经历 Pending → Running → 完成 → 销毁
```

如果 workflow 一直 `Queued`，见
[Issue 3](#issue-3-workflow-stays-queued---runner-永远不来)。

---

## Chapter 3. 通过 Extra Values 自定义 runner

平台 UI 把上游 ARC chart 里**最常用的几十个字段**做成了表单，但 chart
里实际可配置的项远不止这些（嵌套 pod / container spec 字段后会更多）。
剩下的通过两个**转义口**配置：

- **Extra Chart Values（ECV）** —— 顶层 textarea。内容追加到表单生成的
  values 文档**末尾**，新增顶层 key。**不能覆盖** 表单已渲染的顶层 key
  （同名冲突会让插件无法变成 `Installed`，停在错误状态）。
- **Extra Global Values（EGV）** —— 同样是 textarea，但内容嵌入
  `global:` 块下面，作为 `global.*` 子键。

> **Warning —— Extra Global Values 的"缩进契约"。** 该字段没有 indent
> 模板辅助，您写的内容会被原样插入到一个 2 空格缩进的上下文里 ——
> **每一行都必须以 2 个空格起始**，否则装包会直接失败。column 0 起的
> 内容会变成新的顶层 key，把整段 YAML 弄坏。复制粘贴本文片段时，
> 请逐行检查行首是否有 2 个空格再保存。

> **Warning —— Helm 数组字段必须整段提供。** `tolerations`、
> `containers`、`volumes`、`volumeMounts`、`env`、
> `topologySpreadConstraints` 这类**数组**字段在 Helm 合并时是
> **整体替换**而非逐元素 merge —— 这是 Helm 的限制。如果您只写自己
> 关心的元素，chart 默认那部分元素会**全部丢失**。
>
> 下面每个 Recipe 给出的 YAML 都已经是"该数组字段的完整形态"，直接
> 照抄即可。如果您要在我们给的基础上**加**新元素，把新元素**追加**到
> 既有列表里，不要新写一份只含新元素的小片段。
>
> 受影响的 Recipe 与对应数组字段：
>
> - [Recipe 2](#recipe-2-在-runner-容器内注入-secret--自定义-env) —— `containers` / `containers.env`
> - [Recipe 3](#recipe-3-把-runner-pin-到专用节点) —— `tolerations`
> - [Recipe 4](#recipe-4-限制-runner-的-cpu--memory) —— `containers` / `containers.resources`
> - [Recipe 5](#recipe-5-多节点集群把-runner-散布到不同节点) —— `topologySpreadConstraints`
> - [Recipe 6](#recipe-6-runner-pod-挂-maven-缓存--额外-configmap--ca-bundle) —— `volumes` / `volumeMounts`

> **Warning —— 自定义 `template.spec.containers[0]` 时必须保留下面这套
> 安全骨架。** 因为 Helm 整段替换 `containers` 数组，您没写的字段会被
> 全部丢失。chart 的 runner-container helper 会在缺失时兜底补上大部分
> `ACTIONS_RUNNER_*` 变量，**但不会兜底 `image:` 和 `command:`**；而且
> 它对 `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` 兜底的默认值是 `"true"`
> —— 而 Alauda 默认的 `kubernetes-novolume` 模式要求 `"false"`，所以
> 您必须显式写回。任何改写
> `containers[0]` 的 ECV 都从这套骨架起步：
>
> ```yaml
> template:
>   spec:
>     containers:
>       - name: runner
>         image: <runner-extension-image>          # 必填；见 Recipe 9，或用下面命令读取现网值：
>                                                  #   kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
>                                                  #     -o jsonpath='{.spec.template.spec.containers[0].image}'
>         command: ["/home/runner/run.sh"]         # 必填；chart 不会自动补，缺失时 runner 进程不会正确启动
>         env:
>           - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
>             value: "false"                       # kubernetes-novolume / dind 模式必填；否则所有未声明 `container:` 的 job 都会被拒绝
>         # 您自己的自定义字段（resources / volumeMounts / extra env / ...）从这里往下追加
> ```
>
> 漏写 `image:` 的症状：runner pod 报
> `spec.containers[0].image: Required value`，永远调度不到。
> 漏写 `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER=false` 的症状：workflow
> 日志报 `Jobs without a job container are forbidden on this runner`。
>
> 改完 ECV 后的自检：
>
> ```shell
> $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
>     -o yaml | yq '.spec.template.spec.containers[0]'
> # 确认 `image`、`command`、`env` 条目都在
> ```

### Step 1: 理解 ECV vs EGV

ECV 写顶层 chart 字段；EGV 写 `global:` 下的子键。经验法则：

- 用 **ECV** 写 runner pod 模板字段：`template.spec.*` 下的
  serviceAccount / nodeSelector / tolerations / containers / volumes，
  以及 `containerMode:`（条件式 —— 仅在表单 Container Mode 留空时才写到
  ECV，详见下文禁忌列表）、`listenerTemplate.spec.*`，以及
  `scaleSetLabels:`（数组，每个元素非空且 < 256 字符；**install-time-only**
  ——必须在 scale-set 首次安装的 ECV 里就写好，详见
  [Workflow 侧：runs-on 数组形式与 scaleSetLabels](#workflow-侧runs-on-数组形式与-scalesetlabels)）等。
- 用 **EGV** 写镜像覆盖：`images.*`（controller / runnerExtension /
  dind）。

最常见的错误是写了一个表单已经渲染过的顶层 key。下面列出禁忌顶层 key。

**ECV 不要写下列顶层 key：**

- 控制器插件：`flags`、`metrics`、`namespaceOverride`、`replicaCount`、
  `global`。
- Scale-Set 插件：`namespaceOverride`、`global`、`githubConfigUrl`、
  `githubConfigSecret`、`runnerScaleSetName`、`minRunners`、`maxRunners`、
  `controllerServiceAccount`。
  - `containerMode` 是**条件式**：表单 Container Mode 字段**非空时禁止**
    （插件已经渲染了 `containerMode:` 块）；表单 Container Mode **留空时**
    反而**必须**在 ECV 完整接管 `containerMode:` 块 —— 详见
    [Recipe 7](#recipe-7-kubernetes-模式--持久工作目录)。

如果需要覆盖 `global.*` 下的内容（比如 `global.images.*`），改用 EGV
—— 详见 [Recipe 9](#recipe-9-覆盖-arc-镜像自定义版本--替换镜像源)。

> **完整 chart values 参考（按插件分别给出，注释保留）已挪到全文末的 [Appendix: 全量 chart values 参考](#appendix-全量-chart-values-参考)。** 主教程从这里直接接 [Step 2: 验证配置真的生效](#step-2-验证配置真的生效) 与下方各 Recipe。

### Step 2: 验证配置真的生效

每改一次 ECV 或 EGV，建议按下面 3 步确认改动真正落到 runner pod 上：

1. **确认插件状态变成 `Installed`。** 保存表单后稍等 30s 左右，平台
   有两个入口都能查到状态：
   - **Marketplace → Cluster Plugins**：列表里 ARC Scale-Set 一行的
     状态应当显示为 `Installed`（绿色对勾）。
   - **Clusters → \<您的集群\> → Functional Components**：注意先在
     面包屑里选对目标集群，再切到 **Functional Components** 标签页；
     列表里 `Alauda Support for GitHub Actions Runner Scale Set` 一行
     状态应当是 `Running`（绿色箭头），右侧还会带版本号。

   如果一直没变成 `Installed`、或显示安装失败，点开插件详情看
   "事件 / 状态" 信息（最常见的是 ECV 同名顶层 key 冲突或 EGV 缩进错）。

2. **检查渲染后的 AutoscalingRunnerSet 模板。** 插件 reconcile 完会
   更新 namespace 内的 `AutoscalingRunnerSet`，您可以直接看 chart
   合并后的最终 spec：

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset -o yaml \
       | grep -A 3 <您新加的字段名>
   ```

   能看到您写的字段说明 ARC chart 已经把 ECV / EGV 合并进去了。

3. **触发一个测试 workflow，确认新 runner pod 真正带上了配置。** 随便
   一个 `workflow_dispatch` + 一行 `echo` step 都行。workflow 跑起来时
   另开一个终端：

   ```shell
   $ kubectl -n arc-runners get pods -w
   # 等 ephemeral runner pod 出现，记下 pod 名
   $ kubectl -n arc-runners get pod <pod-name> -o yaml \
       | grep -A 3 <您新加的字段名>
   ```

   runner pod 里能看到新字段，才说明配置端到端生效。

### Step 3: Update / Upgrade / 详情 —— 三个不同入口

平台 UI 上"维护插件"对应**三个不同入口**，分别管不同的事：

| 您要做什么 | 入口 | 结果 |
|---|---|---|
| **改 ECV / EGV / 其他可改字段** | **Marketplace → Cluster Plugins** → 插件行右侧 ⋮ → **Update** | 只更新允许修改的字段；**不会升级版本** |
| **查看完整配置面板（含版本号等元信息）** | **Marketplace → Cluster Plugins** → 点击**插件名称**进入详情 | 详情页 Plugin Configuration 区列出 Install Namespace、Log Level、Log Format、Enable Metrics、Advanced 块（含 ECV / EGV 等）所有项，并显示当前安装版本 |
| **升级插件版本（chart / 镜像）** | **Clusters → \<您的集群\> → Functional Components** → 顶部 **Upgrade** 按钮 | 拉 chart 仓库里更新版本，真正做版本升级 |

两个特别容易踩的细节：

- **Update 表单以只读方式展示部署期字段。** `Install Namespace` 等
  部署期一次性写死的字段不可在线修改，但 Update 表单会以只读标签
  形式列出，便于您在不离开页面的情况下确认当前值。**插件详情页**
  （第三行入口）展示同样的信息加上版本号等元信息，适合在需要全面板
  视图时打开。
- **Update 不能用来升级版本。** Update 用的是当前已安装的 chart 版本，
  改完只是 reconcile 一次。要拿到新版本必须走 Functional Components 的
  Upgrade 按钮。

下面按客户最常见的几类需求**分组**给出可复制的配置片段。每个 Recipe
都在 ACP 集群上验证过，含 **何时用 → YAML → 期望效果** 三部分。请按
需要复制粘贴到对应字段。

### Recipe 1: Runner pod 用自定义 ServiceAccount（跑 in-cluster 任务）

**何时用：** workflow 里要 `kubectl apply -f manifest.yaml`、调集群
API。默认 SA 只有 runner container hooks 所需的基础权限，不等于业务
workflow 真正需要的 RBAC。

先在 install ns 建 SA + 绑权限（下面 `my-runner-sa` 是示例名称，请按
业务命名规范替换为您实际想用的名字）：

```shell
$ kubectl create serviceaccount my-runner-sa -n arc-runners

# 推荐做法：根据 workflow 实际要做什么列出最小动词集合，写成一个
# namespace-scoped Role 再绑给 SA。下面这个例子允许 workflow 在
# arc-runners 内 list/get pods、读 pod log、kubectl exec 进 pod。
$ cat <<EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-runner-sa-role
  namespace: arc-runners
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["create"]
EOF

$ kubectl create rolebinding my-runner-sa-binding \
    --role=my-runner-sa-role \
    --serviceaccount=arc-runners:my-runner-sa \
    -n arc-runners
```

如果 workflow 还要操作 deployment、CRD、跨 namespace 资源，把对应的
动词追加到 Role 的 `rules:` 即可；跨 namespace 改用 ClusterRole +
ClusterRoleBinding，但仍按"动词最小化"原则列具体资源，**不要直接绑
`ClusterRole/edit`** —— `edit` 含读写 Secret、修改 ConfigMap、删
Deployment 等高风险动作，等于把整个 ns 的写权限交给任何能改 workflow
YAML 的 GitHub 用户。

然后在 Extra Chart Values 指过去：

```yaml
template:
  spec:
    serviceAccountName: my-runner-sa
```

**期望效果：** runner pod 用 `my-runner-sa` 而不是 chart 默认的
`<scaleset>-gha-rs-kube-mode`，workflow 内 `kubectl` 命令按
`my-runner-sa` 的 RBAC 鉴权。

> **Warning —— kubernetes / kubernetes-novolume 模式下慎用。** 这两个
> 模式下，chart 默认的 `<release>-gha-rs-kube-mode` SA 不是“空白 SA”，
> 它自带 runner container hooks 所需的基础权限：`pods`、
> `pods/exec`、`pods/log`、`secrets`，以及 `kubernetes` 模式下额外的
> `jobs`。一旦您换成自己的 SA，就要把这套权限按实际需要补齐；否则依赖
> container hooks 的能力（如 `container:` job、日志跟踪、k8s mode
> 下的 job / secret 流程）会失败。
>
> 同时要注意：这个默认 SA 有 hooks 所需基础权限，并不代表它已经具备您
> 业务 workflow 真正需要的权限。比如是否能读 Tekton Pipeline、创建
> PipelineRun、访问其他 namespace 资源，都要看当前环境里额外绑定了什么
> RBAC。最稳妥的做法仍然是按业务场景显式准备一个自定义 SA，并用
> `kubectl auth can-i` 做一次权限验收。
>
> **Known issue（当前版本已知问题）：** 在 `kubernetes` /
> `kubernetes-novolume` 模式下，如果您**临时**把
> `template.spec.serviceAccountName` 改成自定义 SA，后续又把这个字段清空
> 或改回默认路径，平台/上游 cleanup 流程有概率把自动生成的默认
> `<scaleset>-gha-rs-kube-mode` `ServiceAccount` / `Role` /
> `RoleBinding` 留在 `Terminating` 状态（`metadata.deletionTimestamp`
> 挂住，且 finalizer 仍是 `actions.github.com/cleanup-protection`）。
> 一旦发生，后续依赖默认 SA 的 workflow 可能表现为：
> `container:` job 在 "Initialize containers" 阶段失败并报
> `HTTP-Code: 401 Unauthorized`，或 runner 容器内 `kubectl auth can-i`
> 直接返回 `error`。如果您需要长期跑 in-cluster 任务，建议**持续使用**
> 明确的自定义 SA，不要在默认 SA 与自定义 SA 之间频繁来回切换；如确实切
> 回默认 SA，请先看本章后文的"已知问题：切回默认 runner SA 后，默认
> kube-mode RBAC 资源卡在 `Terminating`"并做一次验收。

#### 关于权限模型

**作用范围。** 通过 `template.spec.serviceAccountName` 配置的 SA 是
**runner pod 级**的，意味着**同一个 Scale-Set 实例下所有 workflow 共享
这一个 SA 与对应的 RBAC**。SA 实际能访问到的资源，由您给它绑定的
Role / ClusterRole 决定 —— 上面例子用 `--role=my-runner-sa-role` +
`rolebinding -n arc-runners` 是 namespace 级。

生产环境建议遵循最小权限原则：

- **优先用 Role + RoleBinding**（namespace 级，限定在 runner 安装
  namespace 内），而不是 ClusterRole / ClusterRoleBinding（集群级）。
- 给 SA 单独定制一份 Role，列出 workflow 实际需要的资源 / 动词；不要
  直接套用 `cluster-admin`、`edit` 这类宽泛的 ClusterRole。

**是否可以让不同 workflow 用不同 SA / 权限？** 当前架构下 runner pod
的 SA 由插件级配置决定，**同一个 Scale-Set 实例下所有 workflow 共享
同一个 SA**。如果您需要按 workflow 区分权限，常见做法：

- 在 workflow 内调用 `kubectl --token=...` 或挂载 kubeconfig，显式指定
  另一个 SA 的 token，绕过 pod 默认 SA。
- 把权限敏感的步骤转成触发 Tekton PipelineRun（参考
  [Example 2](#example-2-触发集群中已存在的-tekton-pipeline)），
  PipelineRun 里再让具体 Task 用自己的 SA。
- 在 GitHub 端用
  [environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
  / branch protection 限定哪些 workflow 才能跑到这个 runner 池。

### Recipe 2: 在 runner 容器内注入 secret / 自定义 env

**何时用：** workflow 里要访问私有 npm registry / 私有 maven 仓 / 业务
后端 API 等需要 secret 的资源。

先在 install ns 创建好 Secret（如 `npm-credentials`），然后在 Extra
Chart Values 写：

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>           # required — 见 Chapter 3 数组替换警告
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                          # kubernetes-novolume / dind 模式必填
      - name: NPM_TOKEN
        valueFrom:
          secretKeyRef:
            name: npm-credentials
            key: token
            optional: true                      # 设为 true：Secret 轮换期间短暂缺失不会阻塞 pod 启动
      - name: BUILD_PROFILE
        value: production
```

**期望效果：** 每个 runner pod 的 runner 容器能直接读到 `$NPM_TOKEN`
和 `$BUILD_PROFILE`。注意：Helm 整段替换 `containers` 数组（详见本章
开头的[数组警告](#chapter-3-通过-extra-values-自定义-runner)），
chart 默认的 `ACTIONS_RUNNER_*` 条目会被丢失 —— chart 的 runner-container
helper 会在缺失时兜底 `ACTIONS_RUNNER_POD_NAME` /
`ACTIONS_RUNNER_CONTAINER_HOOKS`，但
`ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` 兜底默认是 `"true"`，所以必须像
上面那样显式覆写为 `"false"`。

### Recipe 3: 把 runner pin 到专用节点

**何时用：** 集群里有专用机器跑 CI runner（比如标了
`workload=arc-runner` label，加了 `arc-dedicated:NoSchedule` taint），
其他 workload 不能落上去。

**Extra Chart Values**（在 Scale-Set 插件表单填）：

```yaml
template:
  spec:
    nodeSelector:
      workload: arc-runner
    tolerations:
    - key: arc-dedicated
      operator: Exists
      effect: NoSchedule
```

**期望效果：** runner pod 只调度到带 `workload=arc-runner` label 的
节点；对 `arc-dedicated:NoSchedule` taint 的节点能容忍。如果集群里
没这种 label / taint 的节点，runner pod 会停在 Pending 并报
`FailedScheduling` 事件 —— 这正好可用来"反向验证规则真生效了"。

### Recipe 4: 限制 runner 的 CPU / memory

**何时用：** 避免单个 runner pod 跑出资源边界把节点压崩；或者对接
ResourceQuota 时。

**Extra Chart Values：**

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>      # required — 见 Chapter 3 数组警告
      command: ["/home/runner/run.sh"]     # required — chart 不会兜底
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                     # kubernetes-novolume / dind 模式必填
      resources:
        requests:
          cpu: 500m
          memory: 1Gi
        limits:
          cpu: "4"
          memory: 8Gi
```

**期望效果：** 每个 EphemeralRunner pod 的 runner 容器带上指定
resources。

> **Warning —— 两个细节：**
>
> - `command: ["/home/runner/run.sh"]` 必须保留 —— Helm 合并数组时
>   **整段替换**（见本章开头数组警告），漏写时 pod 虽然能起来，但
>   runner 容器会用镜像默认 entrypoint 而非 `run.sh`，runner 进程
>   不正确启动，workflow 一直 Queued。
> - **CPU 整数必须写字符串：** `cpu: "4"` 不是 `cpu: 4`。后者裸数字
>   虽然 k8s 能接受，但部分客户端再序列化时会拒。统一双引号最稳。

### Recipe 5: 多节点集群把 runner 散布到不同节点

**何时用：** 避免 maxRunners=20 时所有 runner 都挤一个节点把节点压崩；
多 AZ 集群的 HA 部署。

**Extra Chart Values：**

```yaml
template:
  spec:
    affinity:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                actions.github.com/scale-set-name: my-runners   # 您的 runnerScaleSetName
            topologyKey: kubernetes.io/hostname
    topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          actions.github.com/scale-set-name: my-runners
```

**期望效果：** scheduler 优先把 runner pod 分散到不同 hostname 的节点；
节点不够时仍然能调度（"软"反亲和）。

> **Note：** 想要"硬"分散（节点不够就不调度），把
> `preferredDuringSchedulingIgnoredDuringExecution` 改成
> `requiredDuringSchedulingIgnoredDuringExecution`，并把
> `whenUnsatisfiable` 改为 `DoNotSchedule`。

### Recipe 6: Runner pod 挂 maven 缓存 / 额外 ConfigMap / CA bundle

**何时用：** workflow 跑 maven build 想加速（共享 .m2 cache PVC）；
或注入集群外 CA 证书；或共享其他 ConfigMap / Secret 文件。

先把 PVC / ConfigMap 在 install ns 创好，然后在 Extra Chart Values 写：

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>      # required — 见 Chapter 3 数组警告
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                     # kubernetes-novolume / dind 模式必填
      volumeMounts:
      - name: maven-repo
        mountPath: /home/runner/.m2
      - name: ca-bundle
        mountPath: /etc/ssl/extra-ca/ca.crt
        subPath: ca.crt
        readOnly: true
    volumes:
    - name: maven-repo
      persistentVolumeClaim:
        claimName: maven-cache-pvc         # 您需要先在 arc-runners 建好这个 PVC
    - name: ca-bundle
      configMap:
        name: extra-ca-bundle              # 同上
```

**期望效果：** runner pod 起来后能直接读到挂载的 maven cache 与 CA
文件。您写的 volumes 会与 chart 默认管理的卷（如 DinD 模式下的
`dind-sock`、kubernetes 模式下的 `work` PVC）**共存**，不冲突。

> **Note：** 如果 PVC 用的 StorageClass 是 `volumeBindingMode:
> WaitForFirstConsumer`（许多基于本地盘的 SC 实现会采用此模式，例如
> 某些 TopoLVM 部署），PVC 在第一个 runner
> pod 真正起来消费它之前会一直处于 `Pending` —— 这是预期行为，不是
> 配置错误，`kubectl describe pvc maven-cache-pvc` 会写
> `waiting for first consumer to be created before binding`。

### Recipe 7: kubernetes 模式 + 持久工作目录

**何时用：** workflow 需要
[container-job](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontainer)、
`actions/cache@v4`、或其他需要 runner 内挂 PVC 的能力。

**配置三步：**

1. **Container Mode 表单字段留空**（让插件不渲染 `containerMode:` 块）。
2. 在 Extra Chart Values 写完整 `containerMode:`：
   ```yaml
   containerMode:
     type: kubernetes
     kubernetesModeWorkVolumeClaim:
       storageClassName: <集群已存在的 SC>      # 比如 sc-topolvm
       accessModes: [ReadWriteOnce]
       resources:
         requests:
           storage: 1Gi
   ```
3. 保存。

**期望效果：** 每个 EphemeralRunner pod 起来时，k8s 会用 generic
ephemeral volume 机制为它创建一份 PVC `<pod-name>-work`，挂在
`/home/runner/_work`，随 pod 销毁而清理。Scale-Set 插件 chart 的两个
helper（`kubernetes-mode-runner-container` 与
`kubernetes-novolume-mode-runner-container`，都位于
`gha-runner-scale-set/templates/_helpers.tpl`）会在 `containerMode.type`
为 `kubernetes` 或 `kubernetes-novolume` 时分别给 runner 容器注入
`ACTIONS_RUNNER_CONTAINER_HOOKS` 环境变量，指向 k8s mode 的 hook 脚本
（默认 `/home/runner/k8s/index.js` 或 `/home/runner/k8s-novolume/index.js`）。

#### 演示 workflow：用最简 step 集验证 workspace PVC 真的可读写

`kubernetesModeWorkVolumeClaim` 配好之后，您不需要在 workflow YAML 里
显式引用这个 StorageClass —— ARC 会自动用它给每个 runner pod 创建一份
临时 PVC，挂载到 `/home/runner/_work`。下面这个 workflow 用最小集
（inspect → 写 16 MiB 文件 + 时间戳 → 读回校验）证明 workspace 真落
在 PVC 上、且文件能跨 step 持久：

```yaml
name: K8s Mode Persistent Work Volume Demo

on:
  workflow_dispatch:

jobs:
  pvc-smoke:
    # Alauda 当前验证路径：runs-on 用单字符串
    runs-on: my-runners
    steps:
      - name: inspect workspace mount
        run: |
          set -eux
          # POD_NAME 让您能在日志里直接对照 kubectl 看到的 runner pod
          POD_NAME="${ACTIONS_RUNNER_POD_NAME:-${HOSTNAME:-$(cat /proc/sys/kernel/hostname 2>/dev/null || echo unknown)}}"
          echo "runner_name=${RUNNER_NAME:-unset}"
          echo "pod_name=${POD_NAME}"
          echo "workspace=${GITHUB_WORKSPACE}"
          id
          pwd
          mkdir -p "${GITHUB_WORKSPACE}"
          ls -ld "${GITHUB_WORKSPACE}"
          ls -ld /home/runner/_work
          # df 证明 workspace 落在独立挂载点（不是 container rootfs）；
          # 后面写入 + 读回的步骤再证明这个挂载点是可写、稳定的。
          df -h "${GITHUB_WORKSPACE}"
          df -h /home/runner/_work
          # mountinfo 拿到的是源设备（最有说服力），失败时回退到 mount / proc/mounts
          grep " /home/runner/_work " /proc/self/mountinfo || \
            mount | grep -E "(/__w/|/home/runner/_work|${GITHUB_WORKSPACE})" || \
            cat /proc/mounts | grep -E "(/__w/|/home/runner/_work|${GITHUB_WORKSPACE})"

      - name: write payload into workspace PVC
        run: |
          set -eux
          DEMO_DIR="${GITHUB_WORKSPACE}/pvc-demo"
          mkdir -p "${DEMO_DIR}"
          # 时间戳文件用于在第三步证明跨 step 的文件持久性
          date -u +%FT%TZ > "${DEMO_DIR}/timestamp.txt"
          dd if=/dev/zero of="${DEMO_DIR}/payload.bin" bs=1M count=16 status=none
          sha256sum "${DEMO_DIR}/payload.bin" | tee "${DEMO_DIR}/payload.bin.sha256"
          sync
          ls -lah "${DEMO_DIR}"

      - name: read back payload from workspace PVC
        run: |
          set -eux
          DEMO_DIR="${GITHUB_WORKSPACE}/pvc-demo"
          test -s "${DEMO_DIR}/payload.bin"
          sha256sum -c "${DEMO_DIR}/payload.bin.sha256"
          # 上一步写的时间戳能读回，说明文件跨 step 真实持久在 PVC 上
          cat "${DEMO_DIR}/timestamp.txt"
          du -sh "${DEMO_DIR}"
          df -h "${GITHUB_WORKSPACE}"
```

**预期跑成功后您能看到：**

- `runner_name` / `pod_name` / `id` 输出可以直接和
  `kubectl -n arc-runners get pods` / `kubectl describe pod` 对照。
- `GITHUB_WORKSPACE` 落在 `/home/runner/_work/<repo>/<repo>`。
- `df -h ${GITHUB_WORKSPACE}` 与 `/proc/self/mountinfo` 一致显示底层
  是您配置的 SC 提供的块设备（比如 `/dev/topolvm/<volume-id>`，而不是
  节点本地的 overlay rootfs）。
- 16 MiB 文件 `pvc-demo/payload.bin` 写入成功。
- 第三步 `sha256sum -c` 读回校验通过、`cat timestamp.txt` 也能拿到
  step 2 写的 UTC 时间（证明文件跨 step 持久）。
- `du -sh pvc-demo` 显示约 17M。

> **Note：** 这个 demo **故意不用 `container:` 字段也不用
> `actions/checkout`** —— Recipe 7 的核心就是验证「workspace 落在
> 持久 PVC 上」这一件事，step 越简单越容易复现。如果您还想顺手验证
> job container（`jobs.<id>.container`）也能正常用，参考
> [Example 1](#example-1-让单个-job-跑在自定义-container-里)。

触发后可在 ACP 集群侧观察 PVC 自动创建与销毁：

```shell
# workflow 跑起来时
$ kubectl -n arc-runners get pvc
# 期望：<runner-pod-name>-work   Bound   <storageClassName>   ...

# workflow 结束后，PVC 自动释放
$ kubectl -n arc-runners get pvc
# 期望：no resources found（或仅剩其他还在跑的 workflow 对应的 PVC）
```

> **Note：** 如果 PVC 一直 `Pending`，多半是 `storageClassName` 写错或
> 集群里该 SC 不能动态 provisioning。可用 `kubectl get sc` 列出可用
> SC，并 `kubectl describe pvc <name>` 看 events。

### Recipe 8: DinD 模式（在 runner 里跑 docker build）

**何时用：** workflow 需要 `docker build` / `docker push` / 调用
docker CLI。

> **Warning —— DinD 镜像不在安装包内。** 插件安装包不内置 DinD 镜像
> （避免把上游 Docker CVE 面带进 Alauda 补丁包）。您必须先把上游
> `docker:<docker-tag>-dind` 同步到平台镜像仓库的某个路径下，然后通过
> Extra Global Values 把 `global.images.dind.repository` / `tag` 指
> 过去（见 [Recipe 9](#recipe-9-覆盖-arc-镜像自定义版本--替换镜像源)）。

**配置两步：**

1. **同步并 override DinD 镜像。** 在 Scale-Set 插件的 Extra Global
   Values 字段写：
   ```yaml
     images:
       dind:
         repository: <您在平台仓库内的 dind 路径>   # 例如 devops/actions/docker
         tag: <您的 docker dind tag>             # 例如 28.0.4-dind
   ```
2. **表单 Container Mode 选 `dind`。**

**期望效果：** 每个 runner pod 起一个 init container
（`init-dind-externals`，跑完后退出，负责把 docker CLI 拷进共享卷）和
一个 sidecar container（`dind`，持续运行 dockerd），加上一个 runner
主容器。runner 容器里有 `DOCKER_HOST=unix:///var/run/docker.sock`
环境变量，直接对接 DinD sidecar；workflow 里 `docker build` 命令直接
生效。

> **Note：** 在 Kubernetes 1.29+ 上，上游 chart 会用 native sidecar
> 语义渲染 `dind`（表现为出现在 `initContainers` 下且带
> `restartPolicy: Always`）；在更低版本上它通常表现为普通 sidecar
> container。两种写法的运行意图相同，排障时请按实际 pod spec 判断。

> **Note —— 更安全的替代：** 如果您的集群禁用 privileged，或者您不想给
> runner pod 整个 Docker daemon 的能力，看
> [Example 3](#example-3-进阶buildah-无-docker-daemon-构建镜像仍需-privileged) 用 Buildah
> rootless 在普通 job container 里构建镜像。

### Recipe 9: 覆盖 ARC 镜像（自定义版本 / 替换镜像源）

**何时用：** 插件安装包默认包含与本插件版本匹配的 **controller** 与
**runner-extension** 两个镜像，所以 ACP 集群**默认就支持 air-gap 部署**
（控制器 + Scale-Set 装上即跑）。下列场景才需要主动覆盖镜像：

- 用 `dind` 模式 —— **DinD 镜像不在安装包内，必须 override**（前置见
  [Recipe 8](#recipe-8-dind-模式在-runner-里跑-docker-build)）。
- 想用比插件版本更新的 ARC 上游版本（升级 controller / runner-extension）。
- 想换其他 DinD 镜像（比如 `docker:dind-alpine`）。
- 安全审计要求镜像走团队私有仓库的 sub-path。

**前置要求：**

1. 把您想要的目标镜像**先同步到 ACP 平台镜像仓库**，路径要与下面配置
   片段里 `repository` 字段一致。例如片段写
   `repository: devops/actions/docker` + `tag: dind-alpine`，您必须
   先把 `docker:dind-alpine` 推到平台镜像仓库的
   `<global.registry.address>/devops/actions/docker:dind-alpine` 路径
   上。否则 runner pod 起来时 ImagePullBackOff。
2. **`repository` 字段不要带 registry 域名** —— 平台已自动注入
   `global.registry.address`，runner 拉镜像时会拼前缀。
3. **`tag` 必须在平台镜像仓库内真实存在。** 下面片段里
   `<your-target-tag>` 是占位符，您需要替换成您目标 ARC 版本的实际
   tag（在平台 UI 的"集群插件"详情页能看到当前 chart 版本，ARC 三件套
   的镜像 tag 与 chart 版本对齐）。

**配置：** 在 **Extra Global Values** 字段写入下面任一片段。

> **Warning —— 粘贴前必读：行首必须有 2 个空格。** 本 Recipe 接下来给的
> YAML 都是要贴到 **Extra Global Values** 字段（嵌入到 `global:` 块内）。
> 该字段没有 indent 模板辅助，您写的内容会被原样插入到一个 2 空格缩进
> 的上下文里 —— **每一行都必须以 2 个空格起始**，否则装包会直接失败。
> 复制粘贴下方代码块时请逐行核对行首再保存。

下面 A / B 两组配置片段分别对应两个插件，按您的诉求挑对应版本，**粘贴
到对应插件的 Extra Global Values 字段即可**（不是二选一，是两个插件
各管自己的）。

#### A — 控制器插件

控制器插件只接受一个镜像 key（`controller`）。

只改 tag（最常见的升级场景）：

```yaml
  images:
    controller:
      repository: devops/actions/gha-runner-scale-set-controller
      tag: <your-target-tag>          # 您目标 ARC 版本的 tag，必须已同步到平台镜像仓库
```

或者连 `repository` 也换路径（团队私有仓库 sub-path / 安全审计场景）：

```yaml
  images:
    controller:
      repository: my-team/private-mirror/gha-runner-scale-set-controller
      tag: <your-target-tag>
```

#### B — Scale-Set 插件

Scale-Set 插件接受两个镜像 key：

- **`runnerExtension`** —— runner 镜像，**安装包内置**有匹配版本，覆盖
  仅在升级版本 / 换镜像源时需要。
- **`dind`** —— DinD sidecar 镜像，**安装包不内置**（参见
  [Recipe 8](#recipe-8-dind-模式在-runner-里跑-docker-build) 前置说明）。
  只在您启用了 `dind` 模式时才需要写这一节，且必须先把镜像同步到平台
  仓库。

只改 tag：

```yaml
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
```

启用 DinD 模式时（在上面的 `images:` 块下追加）：

```yaml
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
    dind:
      repository: <您在平台仓库内的 dind 路径>     # 比如 devops/actions/docker
      tag: <您的 docker dind tag>               # 比如 28.0.4-dind
```

或者全部覆盖到团队私有仓库 sub-path：

```yaml
  images:
    runnerExtension:
      repository: my-team/private-mirror/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
    dind:
      repository: my-team/private-mirror/docker
      tag: <your-docker-dind-tag>
```

**期望效果：** controller / listener / runner / dind 的实际镜像从您
指定的路径（在平台镜像仓库内）拉取。

> **Warning —— `registry` 子键不能写。** 平台已经渲染了
> `global.registry`，您在 Extra Global Values 写 `  registry:` 会被
> 静默丢弃（不报错，但您写的不生效）。

---

## Chapter 4. 多团队 / 多项目隔离策略

通过 ACP **集群插件入口**时，每个集群插件在同一集群上**只能装一个默认
实例**；这意味着插件化安装路径不适合在单集群里直接起多组彼此独立的
runner。若有团队 / 项目级隔离诉求，请按下面三种方式之一：

### Method 1: GitHub 侧用 runner groups / Selected repositories / Selected workflows 做访问控制（推荐）

让单个 scale-set 实例对应一个 org 级或 enterprise 级 `githubConfigUrl`，
再在 GitHub 侧用 **runner group** 的访问策略限定"谁能用这组 runner"。

- **GitHub App / PAT 的职责是 ARC 调 GitHub API 的鉴权。** 它们决定
  ARC 如何注册 runner、如何向 GitHub 取任务；**不直接等价于**
  "哪些仓库 / workflow 能使用这组 runner"。
- **组织级 runner**：在 GitHub 组织的 **Settings → Actions → Runner
  groups** 里把这组 runner 放入专用 runner group，再用
  `Selected repositories` / `Selected workflows` 收紧访问范围。
- **企业级 runner**：在 GitHub enterprise 的 **Policies → Actions →
  Runner groups** 里先限制 `Selected organizations` /
  `Selected workflows`；如果这组 enterprise runner 再共享给组织，
  组织所有者还可以继续收紧仓库 / workflow 访问策略。

这种方式解决的是 **GitHub 侧的使用授权边界**（谁能把 job 调度到这组
runner），**不**包含"runner 跑在不同节点 / 不同 namespace"这种运行时
隔离。如果您的诉求主要是"一组 runner 只给某些仓库 / workflow 用"，这
通常是最合适的第一选择。

> **关于 GitHub App 与 enterprise runner 的关系：** GitHub 不接受
> GitHub App 用于 enterprise 级 runner 注册（见 [权限要求](#权限要求)）；
> 这时 ARC 鉴权必须改用 Classic PAT +
> `manage_runners:enterprise`。但即便在 enterprise 级，"哪些组织 /
> workflow 能使用这组 runner"的访问控制，仍然主要应由 runner group
> 策略来做，而不是靠 PAT 本身完成。

### Method 2: 多 ACP 集群分别装 ARC（强隔离）

团队 A 用集群 A、团队 B 用集群 B；**每个集群上各自独立装一套控制器
插件 + Scale-Set 插件**，分别配不同的 `runnerScaleSetName`、不同的
`githubConfigUrl`、不同的 GitHub 凭证 Secret，互不干扰。每组 runner
跑在自己的集群里，资源 / 网络 / 节点完全隔离。适合团队之间本来就因为
业务 / 安全边界需要分集群部署的场景 —— 单集群只能装一份 Scale-Set
插件，不影响**跨集群**部署多份。

### Method 3: 通过 Helm Chart 直接部署多实例（特殊诉求）

如果有强隔离需求且只想用一套集群，可以通过 ACP 平台的
**Catalog → Helm Chart** 入口（不是 Marketplace 集群插件入口），把上游
`gha-runner-scale-set` chart 装成多套独立的 ARC 实例 —— 整个过程仍在
ACP UI 中完成，**不需要 `helm` 命令行**。这条路径**没有集群插件那套
表单化字段**（如 "Container Mode"、"GitHub URL" 等下拉项），
所有参数都要在 chart values（YAML）里写明；升级、参数调整也通过
Catalog 中对应实例的操作完成。

> **Note —— labels 路由不能替代真正的多实例。** 上游 chart 支持
> `scaleSetLabels` + 数组形式 `runs-on:`，可以让一个 scale-set 同时
> 响应多组 label 名（用法与 install-time-only 约束见
> [Workflow 侧：runs-on 数组形式与 scaleSetLabels](#workflow-侧runs-on-数组形式与-scalesetlabels)）—— 但所有匹配到的 workflow 仍然跑在**同一个**
> scale-set 实例下，共享同一份 controller、同一份 SA 与 RBAC、同一份
> GitHub 凭证。如果您追求的是"团队 A 的 workflow 不能动到团队 B 的
> 资源"这种**运行时真正隔离**，labels 路由不解决问题，通常需要上面的
> Method 2 / 3；Method 1 只解决"谁可以使用 runner 池"的 GitHub 侧访问
> 控制。

### 安全注意事项（短 checklist）

把 ARC 部署到生产前，至少把下面四件事过一遍 —— 这些点散在各 Recipe /
Example 里都讲过，这里集中列一份方便审阅。

- **`githubConfigUrl` 范围 = 注册边界；runner group 策略 = 实际使用边界。**
  `githubConfigUrl` 越大，ARC 注册到 GitHub 的边界越宽；真正决定"哪些
  仓库 / workflow 可以使用这组 runner"的，应是 runner group 的
  `Selected repositories` / `Selected workflows`（enterprise 级还包括
  `Selected organizations`）。企业级 / 组织级 `githubConfigUrl` 配合一份
  共享 SA 时，**任何被允许提交到该 runner group 的 workflow 作者**都能
  用这组 runner 跑代码，因此规划时要同时收紧 `githubConfigUrl` 与
  runner group 策略。
- **自定义 SA = 把集群权限交给 workflow 作者。** 走
  [Recipe 1](#recipe-1-runner-pod-用自定义-serviceaccount跑-in-cluster-任务)
  给 runner 配 SA 后，**任何能修改 workflow YAML 的 GitHub 用户**都
  能继承这份 SA 的全部 RBAC。**不要**绑 `ClusterRole/edit` 之类宽泛角色；
  按 workflow 实际需要的动词逐条放权（参考 Recipe 1 里的最小 Role 示例）。
- **DinD / privileged Buildah 只发给受控仓库。**
  [Recipe 8 (DinD)](#recipe-8-dind-模式在-runner-里跑-docker-build) 与
  [Example 3 (Buildah)](#example-3-进阶buildah-无-docker-daemon-构建镜像仍需-privileged) 都
  会让 runner 拿到 root / 容器逃逸面更宽的权限。**只给您信任的内部仓库**
  接入这组 runner；把开放贡献的仓库放到独立的、走非 privileged 路径的
  scale-set 实例上。
- **fork PR / 外部贡献建议隔离 runner 池。** GitHub 的
  `pull_request_target` 等触发条件可让外部 PR 在仓库主分支的 secrets
  / SA 上下文里跑代码，是常见的供应链攻击面。如果您的仓库接受外部
  贡献，**单独装一组 runner**（按上面 Method 2 / Method 3）专门给它们
  用，不共享主线 runner 的 secrets / SA。

---

## Chapter 5. Workflow 示例

下面 3 个示例展示几种常见的 workflow 写法，用 runner 自带的工具或
GitHub Actions 原生能力覆盖典型 CI 场景。所有 YAML 都可直接复制粘贴
使用（按需把 `my-runners` 换成您自己的 `runnerScaleSetName`，把镜像
路径换成您内网集群可拉到的镜像）。

> **Note：** 以下示例仅供参考，实际 workflow 结构请按项目需要调整。

### Example 1: 让单个 job 跑在自定义 container 里

**何时用：** 默认 runner 镜像没装某语言运行时（例如想要 Maven、想要
特定 JDK 版本）；不想改 runner 镜像；又不想用 DinD。GitHub Actions
原生
[`jobs.<id>.container`](https://docs.github.com/en/actions/using-jobs/running-jobs-in-a-container)
字段在 ACP scale-set 模式下完全可用 —— ARC 会通过
runner-container-hooks 在 runner 所在 namespace 里为该 job 动态创建对应的
job pod / k8s job，step 在那个容器环境里执行，而不是简单在同一个 runner
pod 里再挂一个 sidecar。**这一模式要求 Scale-Set 的 Container Mode 为
`kubernetes-novolume`（默认）或 `kubernetes`；`dind` 模式不支持
`container:`。**

**完整 workflow：**

```yaml
name: Container Job Example
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  container-job:
    runs-on: my-runners
    container:
      image: docker.io/library/ubuntu:24.04
    steps:
      - name: identify the container
        # 避免依赖 job container 是否自带 `hostname` 命令，直接用
        # shell 内置 ${HOSTNAME} 更稳。
        run: |
          echo "runner_name: ${RUNNER_NAME:-unknown}"
          echo "hostname:    ${HOSTNAME:-unknown}"
          echo "workspace:   ${GITHUB_WORKSPACE:-unknown}"
          cat /etc/os-release
          echo "whoami:      $(whoami)"
          id
```

**期望效果：** job 的 step 跑在 `ubuntu:24.04` 提供的容器环境里，不影响
runner 主容器本身；集群侧通常会看到与该 job 对应的额外 job pod / k8s job
资源。

#### 如果 job container 还需要其他权限 / 凭证

- **访问集群 API（在容器里跑 `kubectl`）：** job container 默认会继承
  runner pod 的 ServiceAccount（k8s 自动挂载 SA token 到
  `/var/run/secrets/kubernetes.io/serviceaccount/`）—— 给 runner pod
  配自定义 SA 的方法见
  [Recipe 1](#recipe-1-runner-pod-用自定义-serviceaccount跑-in-cluster-任务)。
  注意 `image:` 指向的镜像里**必须自带 `kubectl` 二进制**（社区
  `ubuntu:24.04` 不带，请用自带 kubectl 的镜像，或在 step 里临时下载）。
- **拉私有 registry 镜像：** job container 的 image 拉取最终仍由 runner
  pod 的拉镜像凭证路径决定。当前 Alauda 插件化安装路径里，runner 侧
  推荐通路是平台注入的 `global.registry.imagePullSecrets`，或通过
  自定义 SA 间接挂载。上游 chart 会把
  `template.spec.imagePullSecrets` 透传到 runner pod spec，但本文没有把它
  作为插件化安装路径的主推荐 / 主验证方式；如要使用，建议先在目标集群
  现网验证渲染结果与实际拉镜像行为。
- **注入业务凭证：** 优先把 `${{ secrets.X }}` 放到具体 step 的 `env:`
  （或多个 step 共用时放到 `jobs.<id>.env`）里；`container.env` 更适合放
  非敏感常量。原因是 ARC 的 Kubernetes container mode 下，secrets 通过
  step `env:` 传递更稳。例如：

  ```yaml
  jobs:
    container-job:
      runs-on: my-runners
      container:
        image: docker.io/library/ubuntu:24.04
        env:
          APP_REGION: cn-north-1
      steps:
        - name: use business secret
          env:
            NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          run: |
            echo "region=$APP_REGION"
            echo "token length=${#NPM_TOKEN}"
  ```

> **Warning —— 要求 Container Mode：** `kubernetes-novolume`（默认）或
> `kubernetes`（Recipe 7）。`dind` 模式下不支持 GHA 的 `container:`
> 字段。
>
> **Warning —— air-gap：** 您写的 `image:` 必须是平台镜像仓库或集群
> 可拉到的镜像路径。`docker.io/library/ubuntu:24.04` 在内网集群里通常
> 拉不到 —— 换成您平台镜像仓库内已经同步好的对应镜像。

### Example 2: 触发集群中已存在的 Tekton Pipeline

**何时用：** GitHub Actions 负责触发与编排，Tekton 在集群里跑实际的
重活（构建、测试、部署）。真实部署都把 Tekton `Pipeline` 资源放在
集群里作为带版本的可复用定义；workflow 只创建一个新的 `PipelineRun`
引用它。

**前置：**

- **集群已部署 Tekton Pipelines。** 本示例假设 `tekton.dev/v1` 的
  CRD（`Pipeline` / `PipelineRun` / `Task` / `TaskRun`）已经安装。在
  ACP 上可通过 ACP DevOps 模块或上游
  [tektoncd/pipeline](https://github.com/tektoncd/pipeline) 安装。
  未部署时，下面的 `kubectl apply` 会报
  `no matches for kind "Pipeline" in version "tekton.dev/v1"`。
- **runner pod 用一个带 Tekton 操作权限的 ServiceAccount。** 先参考
  [Recipe 1](#recipe-1-runner-pod-用自定义-serviceaccount跑-in-cluster-任务)
  建好自定义 SA（如 `my-runner-sa`），然后给它绑下面这份 Role，用以
  创建 / 跟踪 PipelineRun：

  ```shell
  $ kubectl apply -n arc-runners -f - <<'EOF'
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: tekton-pipelinerun-runner
  rules:
  - apiGroups: ["tekton.dev"]
    resources: ["pipelines"]                  # `tkn pipeline start` 先 GET Pipeline 取参数列表
    verbs: ["get", "list", "watch"]
  - apiGroups: ["tekton.dev"]
    resources: ["pipelineruns"]
    verbs: ["create", "get", "list", "watch"]
  - apiGroups: ["tekton.dev"]
    resources: ["taskruns"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata:
    name: my-runner-sa-tekton
  subjects:
  - kind: ServiceAccount
    name: my-runner-sa
    namespace: arc-runners
  roleRef:
    kind: Role
    name: tekton-pipelinerun-runner
    apiGroup: rbac.authorization.k8s.io
  EOF
  ```

  Role 给 Pipeline 的 **read** 权限（`tkn pipeline start` 要先读取
  Pipeline 的参数列表），PipelineRun 的 **create + read** 权限，以及
  TaskRun / pods 的 **read** 权限，以及 pod log 的 **get** 权限
  （`tkn pipeline start --showlog` 与 `tkn pr logs -f` 跟踪运行需要）。
  本文场景不需要给 TaskRun `create`。
  如果漏掉 Pipelines 的 read 规则，
  `tkn pipeline start` 会报 `Pipeline name <pipeline> does not exist
  in namespace <ns>` —— 即便 Pipeline 在 cluster admin 视角下确实存在。

- **在集群中预创建一个最小 Pipeline。** 直接 apply 下面的 manifest。
  默认所有资源都放在 `arc-runners`（与 runner pod 同一个 namespace，
  避免跨 namespace 的 RBAC 麻烦）。如要换 namespace，把这条命令以及
  下面 workflow `env` 块里的 `arc-runners` 一起改掉。

  > **Note：** 下面 `image:` 字段用了 `docker.io/library/busybox:1.36`
  > 作为 demo 镜像。**air-gap 集群里请先替换为您平台镜像仓库可拉到的
  > 路径**再 apply。

  ```shell
  $ kubectl apply -n arc-runners -f - <<'EOF'
  apiVersion: tekton.dev/v1
  kind: Pipeline
  metadata:
    name: gh-trigger-demo
  spec:
    params:
    - name: git-url
      type: string
    - name: git-revision
      type: string
    tasks:
    - name: greet
      params:
      - name: git-url
        value: $(params.git-url)
      - name: git-revision
        value: $(params.git-revision)
      taskSpec:
        params:
        - name: git-url
          type: string
        - name: git-revision
          type: string
        steps:
        - name: echo
          image: docker.io/library/busybox:1.36   # air-gap: replace with an internally-reachable image
          script: |
            #!/bin/sh
            echo "triggered for $(params.git-url) @ $(params.git-revision)"
  EOF
  ```

  真实部署里这个 Pipeline 会是一条完整的构建-部署流（`git-clone` →
  `buildah` → `kubectl-deploy` 等）。

**完整 workflow：**

```yaml
name: Trigger Tekton PipelineRun
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  trigger-tekton:
    runs-on: my-runners
    steps:
      - name: start tekton pipeline
        # `env` carries the platform-specific values for this trigger.
        # Defaults match the prerequisites above; override here (or
        # promote to GitHub repo variables for multi-pipeline use).
        env:
          TEKTON_NS: arc-runners
          PIPELINE_NAME: gh-trigger-demo
          GIT_URL: ${{ github.server_url }}/${{ github.repository }}
          GIT_SHA: ${{ github.sha }}
        run: |
          # 直接使用 runner 镜像内置的 `tkn` CLI 触发 Pipeline。
          # `tkn pipeline start` 会创建一个由服务端生成名字的
          # PipelineRun；`--showlog` 则会持续跟踪日志直到执行结束，
          # 不再需要单独渲染 manifest、跑 kubectl create，或额外
          # 再接一个 `tkn pr logs -f`。
          tkn pipeline start "${PIPELINE_NAME}" \
            -n "${TEKTON_NS}" \
            -p git-url="${GIT_URL}" \
            -p git-revision="${GIT_SHA}" \
            --showlog
```

**期望效果：** `tkn pipeline start` 创建一个引用集群中
`gh-trigger-demo` Pipeline 的 `PipelineRun`；Tekton 控制器把
`pipelineRef.name` 解析为当前 Pipeline spec 并执行；`--showlog` 把
PipelineRun 的日志流式输出到 GitHub Actions 控制台；PipelineRun 跑完
之后 step 退出码与 PipelineRun 的成功状态一致。**Pipeline 定义留在
集群里、由您的平台团队维护；workflow 只是个借用 runner 镜像内置 CLI
的轻量触发器**。

> **Note —— 为什么用 `tkn pipeline start` 而不是 `kubectl create -f`？**
> runner 镜像内置了 `tkn`；`tkn pipeline start` 一条命令就完成
> "创建 PipelineRun + 跟踪日志"，不需要渲染 YAML manifest、不需要
> 处理 `metadata.generateName` 的细节、也不需要再单独跑
> `tkn pr logs -f`。RBAC 仍以本节上面那份最小 Role 为准：Pipeline 需要
> read，PipelineRun 需要 create + read，TaskRun / pods 需要 read，
> pod log 需要 get，因此 Recipe 1 那套自定义 SA 仍然适用。
> `tkn pipeline start --help` 还提供 `--serviceaccount` /
> `--workspace` / `--use-param-defaults` 等扩展能力，等您的真实
> Pipeline 复杂度上来时按需启用。

### Example 3 (进阶): Buildah 无 Docker daemon 构建镜像（仍需 privileged）

**何时用：** workflow 要 `buildah build` / `docker build` 类操作；又
不想启用 DinD（[Recipe 8](#recipe-8-dind-模式在-runner-里跑-docker-build)
需要 privileged sidecar）。Buildah rootless 在普通 job container 里
就能跑构建，对集群安全策略更友好。这里的 **rootless** 指 Buildah 进程在
容器内以非 root 用户身份运行；**不等于** 整个 job pod 就一定不需要额外
capability / privileged。

**关键挑战：** Buildah 在容器内 rootless 构建时，默认 storage 路径
需要非 root 用户可写、又不能复用宿主机的 root-owned 路径。把
`CONTAINERS_STORAGE_CONF` 指到 `/tmp` 下一份自定义配置即可绕过。

**前置：** 在您的 GitHub 仓库 **Settings → Secrets and variables →
Actions** 里创建两个 repository secret：`REGISTRY_USERNAME` 和
`REGISTRY_PASSWORD`，值为您平台镜像仓库的登录凭证（用于 push 构建产物）。

这套示例同样依赖 GHA 的 `container:` 字段，因此**只适用于**
`kubernetes-novolume`（默认）或 `kubernetes` 模式；`dind` 模式不支持。

**完整 workflow**（社区 buildah 镜像 + 通用 secret 名）：

```yaml
name: Buildah Rootless Example
on:
  workflow_dispatch:

jobs:
  build:
    runs-on: my-runners
    container:
      image: quay.io/buildah/stable:latest
      options: --privileged
      env:
        STORAGE_DRIVER: vfs
        BUILDAH_ISOLATION: chroot
        # 把 buildah storage 重定向到 /tmp（mode 1777，非 root 也能写）
        HOME: /tmp
        CONTAINERS_STORAGE_CONF: /tmp/storage.conf

    steps:
      - name: prepare buildah storage config
        run: |
          mkdir -p /tmp/.buildah-root /tmp/.buildah-runroot
          cat > /tmp/storage.conf <<'EOF'
          [storage]
          driver = "vfs"
          runroot = "/tmp/.buildah-runroot"
          graphroot = "/tmp/.buildah-root"
          EOF

      - name: write Containerfile and build
        run: |
          mkdir -p /tmp/build && cd /tmp/build
          cat > Containerfile <<'EOF'
          FROM docker.io/library/alpine:3.20
          RUN echo "built by buildah at $(date -u)" > /built.txt
          EOF
          buildah bud --storage-driver vfs -t my-image:${{ github.sha }} .
          buildah images

      - name: push to your registry
        env:
          REGISTRY_USERNAME: ${{ secrets.REGISTRY_USERNAME }}
          REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
        run: |
          buildah login -u "$REGISTRY_USERNAME" -p "$REGISTRY_PASSWORD" \
            --tls-verify=false my.registry.example.com
          buildah push --storage-driver vfs --tls-verify=false \
            my-image:${{ github.sha }} \
            my.registry.example.com/my/repo:${{ github.sha }}
```

**关键说明：**

- `options: --privileged`：Buildah rootless 仍需要部分 capability，
  最简单做法是 privileged。换句话说，**rootless != unprivileged**：
  进程身份可以是非 root，但 pod 级仍可能需要额外 capability。生产更严格
  场景可以只授 SYS_ADMIN，但配置复杂。
- `HOME=/tmp` + `CONTAINERS_STORAGE_CONF=/tmp/storage.conf`：把
  Buildah 的 storage 路径强制重定向到 `/tmp`（job container 内 `/tmp`
  是 mode 1777，非 root user 也能写）。
- `STORAGE_DRIVER=vfs` + `BUILDAH_ISOLATION=chroot`：在容器嵌套场景下
  最稳的 storage / isolation 组合（性能不是最好，但兼容性最佳）。
- 上面的 `image: quay.io/buildah/stable:latest`、
  `docker.io/library/alpine:3.20` 等都是社区路径，**air-gap 集群必须
  先把这些镜像同步到平台镜像仓库并把 `image:` 字段改成对应内部路径**，
  否则起不来。
- `quay.io/buildah/stable:latest` 仅适合 demo 说明，不适合作为长期可复现
  的文档建议。真正落地时，建议改成您团队已验证并已同步到内网仓库的固定
  tag（或 digest）。

> **Warning —— 以下为演示代码，不建议直接用于生产环境。**
> `--privileged` + `STORAGE_DRIVER=vfs` + `BUILDAH_ISOLATION=chroot`
> 这套是兼容性最好、最容易跑通的组合，但：
>
> - 集群启用了 PSA `restricted` / OpenShift SCC `restricted` 之类策略
>   时，`--privileged` 会被准入拒绝，本 workflow 起不来。
> - `vfs` storage driver 性能差，复杂构建会慢。
> - 真在 air-gap 内打镜像还要处理 base image 路径替换、registry 凭证
>   注入、缓存等。
>
> **生产环境推荐路径：** 把镜像构建任务**下放到 ACP 内的 Tekton
> Pipelines**（用
> [Example 2](#example-2-触发集群中已存在的-tekton-pipeline)
> 的模式，从 GitHub workflow 里 `tkn pipeline start` 触发一个内含 Buildah /
> Kaniko Task 的 PipelineRun）。Tekton 社区的 buildah / kaniko Task
> 已经把权限边界、缓存、签名这些做得比较成熟，比在 GHA workflow 里
> 现搭一个 buildah 容器更靠谱。

---

## Chapter 6. 故障排查

下面按客户**实际遇到的频次**排序，从最常踩的往下排。

> **Note：** 本章命令默认使用控制器 namespace `arc-systems` 与
> Scale-Set namespace `arc-runners`。如果您的实际部署使用自定义
> namespace，排障时请先做命令替换，再观察现象。

### Issue 1: 安装失败 —— 选的 Install Namespace 在集群上不存在

**症状：** 在平台 UI 装控制器插件 / Scale-Set 插件，等几秒后插件实例
没能变成 `Installed`，停在错误状态，详情里报
`namespaces "<your-ns>" not found`。

**原因：** 您在表单 Install Namespace 字段填的命名空间在目标集群上还
没创建，平台不会替您建。

**解决：** 先建 namespace 再装。两种方式：

```shell
# 方式 1：kubectl
$ kubectl create ns arc-systems   # 控制器插件用
$ kubectl create ns arc-runners   # Scale-Set 插件用
```

或在平台 UI："集群 → 命名空间"页面预先创建。

> **Note —— 两个插件用各自独立的 namespace。** 默认情况下控制器装在
> `arc-systems`，Scale-Set 装在 `arc-runners`（这两个值是 ACP 表单的
> 默认值，不是硬性约束 —— 您的实际部署完全可以用其他名字，比如
> `arc-controller-prod` / `team-a-runners`）。如果您改了默认名，**请
> 同步把 Scale-Set 表单的 "Controller Namespace" 字段指向控制器实际
> 安装到的那个 ns**，否则 Scale-Set 侧对 controller 的引用与授权绑定会
> 指错对象，listener 无法正常创建或更新。

### Issue 2: Listener pod 起不来（Pending 或 CrashLoopBackOff）—— GitHub 凭证问题

**症状：** `kubectl -n arc-systems get pod` 看 `<scaleset>-...-listener`
长时间 Pending；或起来了又 CrashLoopBackOff，日志里有 `401`、
`Bad credentials`、`Could not find any installation`、`PEM` 之类字样。

**最常见原因：**

| 现象 | 原因 | 解决 |
|---|---|---|
| `secret "gha-runner-scale-set-github-config" not found` | Step 1 的 GitHub 凭证 Secret 没建，或建在了错的 namespace | 按 [GitHub 凭证准备](#github-凭证准备) 重新创建；**namespace 必须是 Scale-Set 插件的 Install Namespace**（默认 `arc-runners`） |
| 首次安装后才补建 Secret，之前一直报 not found / listener 起不来 | 初始凭证缺失，scale-set 启动时拿不到 GitHub 凭证 | 先按 [GitHub 凭证准备](#github-凭证准备) 补建 Secret；通常 Secret 出现后会自动恢复，若几分钟后仍未恢复，再手动删除 listener pod 触发重建 |
| listener 日志 `401 Unauthorized` 或 `Bad credentials` | GitHub App 的 `app_id` / `installation_id` 写错了 | 到 GitHub UI（**Settings → Developer settings → GitHub Apps → 您的 App**）核对 App ID；点开 "Install App" 页面 URL 后缀的数字是 installation_id |
| listener 日志 `failed to parse private key` 或类似 PEM 报错 | private key 不是合法 PEM 格式（典型是 `--from-literal` 单行存了，换行被吞） | 用 `--from-file=github_app_private_key=app.pem` 重建 secret |
| listener 日志 `Could not find any installation` | App 还没装到目标 org / repo 上 | 在 GitHub UI "Install App"，把 App 装到 `githubConfigUrl` 指向的 org / repo |
| listener 日志 `401 Unauthorized` / `Bad credentials`（PAT 场景） | PAT 已过期、被撤销，或 Secret 里的 token 值写错了 | 重新生成 / 重新注入 PAT；确认 Secret 键名是 `github_token` |
| 轮换已有 Secret 后 listener 仍报旧凭证 / 继续 `401` | listener 不会热加载已经存在 Secret 的新内容 | 删除 listener pod，让 controller 按新凭据重建 |
| listener 日志 `403 Forbidden`、`Resource not accessible by personal access token`，或 enterprise 级一直注册失败 | PAT scope / 权限不足；例如 classic PAT 缺 `repo` / `admin:org` / `manage_runners:enterprise`，或把 fine-grained PAT 用到了 enterprise 级 | 按 [权限要求](#权限要求) 重建 PAT；**enterprise 级只支持 Classic PAT + `manage_runners:enterprise`** |
| 使用 fine-grained PAT 时持续报权限错误，但 token 看起来有效 | token 的 owner / repository selection 没覆盖 `githubConfigUrl` 指向的目标 repo / org | 重新创建 fine-grained PAT，确认资源 owner 与 repository 选择覆盖目标范围；拿不准时先用 classic PAT 交叉验证 |

排查命令：

```shell
# 看 listener 当前状态
$ kubectl -n arc-systems get pod -l app.kubernetes.io/component=runner-scale-set-listener

# 看最近的日志（GitHub 错误一般在 listener 启动时报）
$ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=50
```

### Issue 3: Workflow stays "Queued" - runner 永远不来

**症状：** GitHub UI 上 workflow 一直 `Queued`；listener pod
Running、日志看起来正常；runner pod 一直没起。

**原因：** workflow YAML 的 `runs-on:` 没匹配到 scale-set。对本文当前已
验证的 Alauda 路径，**最稳妥**的写法是使用**单字符串**，直接等于
Scale-Set 插件里的 `runnerScaleSetName`。

**解决：** 简单做法 —— 改成单字符串：

```yaml
# 本文当前已验证、最稳妥：单字符串
runs-on: my-runners       # 等于 Scale-Set 插件 Runner Scale-Set Name 字段
```

> **Note：** 上游 chart 支持 `scaleSetLabels` + 数组形式 `runs-on:`，
> 想让一个 scale-set 同时承接多组 label 时使用；用法、注入方式、
> install-time-only 约束以及"装完想改 labels 怎么办"见
> [Workflow 侧：runs-on 数组形式与 scaleSetLabels](#workflow-侧runs-on-数组形式与-scalesetlabels)。

**排查步骤：**

```shell
# 1. 确认 scale-set 注册名
$ kubectl -n arc-runners get autoscalingrunnerset \
    -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.runnerScaleSetName}{"\n"}{end}'

# 2. workflow 推上去后，listener 日志里应当出现 "Acquired job ..." 字样；
#    没出现说明 runs-on 没匹配上
$ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=20
```

> **Note：** 想给不同团队 / 项目分隔 runner 池？看
> [Chapter 4. 多团队 / 多项目隔离策略](#chapter-4-多团队--多项目隔离策略)。

### Issue 4: Listener 不出现 / 不可用 —— controller 引用不一致或节点资源不够

**症状：** listener 没有正常可用；要么根本没出现，要么 pod 一直 Pending
（不是 GitHub 凭证问题，那种归 Issue 2）。

| 原因 | 常见表现 | 解决 |
|---|---|---|
| Scale-Set 表单里的 **Controller Namespace** / **Controller ServiceAccount Name** 与控制器插件不一致 | listener 可能根本不出现，或 controller 日志 / 事件里出现权限、reconcile 相关错误。这里的 `arc-gha-rs-controller` 是 Scale-Set 给 controller 绑定权限时引用的 subject，不是 listener pod 自己挂载的 SA | 改回控制器插件实际使用的 namespace / SA（默认 `arc-systems` / `arc-gha-rs-controller`） |
| 节点资源不够 | listener pod 已创建但 Pending；`kubectl describe pod` 里有 `0/N nodes are available: insufficient cpu/memory` | 加节点 / 减少 listener resources / 检查全局 nodeSelector 没把它锁到没资源的节点 |

### Issue 5: Runner pod ImagePullBackOff / ContainerCreating 不动

**症状：** workflow 触发了，runner pod 起来后卡 `ContainerCreating` 或
`ImagePullBackOff`。

**常见原因 + 解决：**

- **改了 ARC 镜像 override 但没把目标镜像同步到平台镜像仓库：** 检查
  [Recipe 9](#recipe-9-覆盖-arc-镜像自定义版本--替换镜像源) 写的
  `repository` 路径是否真的能在 ACP 平台镜像仓库里 pull 到。**默认
  安装包内含匹配镜像，原则上不需要做 override。**
- **PVC 没就绪**（kubernetes 模式）：检查 Recipe 7 写的
  `storageClassName` 是否存在且能动态 provisioning。
- **私有 registry imagePullSecrets：** 默认
  `global.registry.imagePullSecrets` 已由平台注入；如果是从您自己的
  私有 registry 拉镜像，runner 侧请优先沿用平台注入的
  `global.registry.imagePullSecrets`，或通过自定义 SA 间接挂载。
  `template.spec.imagePullSecrets` 不是本文推荐的诊断路径，详见
  [已知限制](#已知限制) 中关于 `imagePullSecrets` 的说明。

### Issue 6: 改了表单但集群没反应

**症状：** 在平台 UI 改了 Extra Chart Values（或其他字段），保存后集群
上的 ARS / Deployment / Pod 没更新。

**最常见原因：** Extra Chart Values 里写了一个表单已经渲染过的顶层
key，导致 helm 解析失败。例子：

```yaml
# ❌ 错误：flags 是控制器表单已渲染的顶层 key
flags:
  watchSingleNamespace: my-team-namespace
```

```yaml
# ❌ 错误：global 是表单已渲染的顶层 key（要覆盖 global.images.* 请改用 EGV，见 Recipe 9）
global:
  images:
    runnerExtension:
      repository: x/y
```

**解决：**

- **先看插件实例状态：** 在平台 UI（**Marketplace → Cluster Plugins**）
  找该插件实例。如果没变成 `Installed`，详情里会有类似
  `yaml: unmarshal errors: mapping key "<key>" already defined` 的
  错误。
- **改 Extra Global Values（不是 Extra Chart Values）覆盖 `global.*`：**
  写 `images:` 顶层（每行 2 空格起始）替代 `global.images.*`。详见
  [Recipe 9](#recipe-9-覆盖-arc-镜像自定义版本--替换镜像源)。
- **不要在 Extra Chart Values 里写下列顶层 key**（已被表单渲染）：
  - 控制器：`flags`、`metrics`、`namespaceOverride`、`replicaCount`、
    `global`。
  - Scale-Set：`namespaceOverride`、`global`、`githubConfigUrl`、
    `githubConfigSecret`、`runnerScaleSetName`、`minRunners`、
    `maxRunners`、`controllerServiceAccount`。
  - `containerMode` 是**条件式**：表单 Container Mode **非空时**，不要在
    ECV 再写 `containerMode:`；只有当表单刻意**留空**、需要在 ECV 里
    完整接管该块时，才应该写 `containerMode:`。详见
    [Container Mode 怎么选](#container-mode-怎么选)。

#### 已知问题：切回默认 runner SA 后，默认 kube-mode RBAC 资源卡在 `Terminating`

**适用范围：** 当前基线版本，在 `kubernetes` / `kubernetes-novolume`
模式下，**先**按 [Recipe 1](#recipe-1-runner-pod-用自定义-serviceaccount跑-in-cluster-任务)
把 `template.spec.serviceAccountName` 指到自定义 SA，**后**又把这个字段清空
或切回默认路径。

**症状：**

- 后续走默认 SA 的 workflow 异常：GitHub job 卡在
  "Initialize containers"，日志里有 `HTTP-Code: 401 Unauthorized`；
- 或 runner pod 里明明带了 `kubectl`，但 `kubectl auth can-i ...`
  直接返回 `error`；
- `kubectl get sa,role,rolebinding -n arc-runners` 能看到默认的
  `<scaleset>-gha-rs-kube-mode` 资源，但其中一个或多个对象带
  `metadata.deletionTimestamp`，一直不消失。

**确认命令：**

```shell
$ kubectl -n arc-runners get sa,role,rolebinding \
    <runner-scale-set-name>-gha-rs-kube-mode -o yaml
```

如果输出里仍能看到：

```yaml
metadata:
  deletionTimestamp: "..."
  finalizers:
    - actions.github.com/cleanup-protection
```

说明您已经命中这个已知问题。

**Workaround：**

1. **优先规避：** 如果这组 runner 长期需要访问集群 API，建议固定使用一份
   自定义 runner SA，不要在默认 SA 与自定义 SA 之间频繁来回切换。
2. **切回默认 SA 后做一次验收：** 在 ACP UI 里
   **Marketplace → Cluster Plugins → 该 Scale-Set 插件 → Update**，
   保存一次无害变更触发 reconcile（例如临时把 `Maximum Runners` `+1`
   保存，再改回原值保存一次），然后重新检查上面 3 个默认 kube-mode
   资源是否都已重建且**不带** `deletionTimestamp`。
3. **如果已经卡住：** 先手工清掉 3 个默认 kube-mode 资源上的
   `actions.github.com/cleanup-protection` finalizer，再按上一步做一次
   Update / reconcile，让平台重建默认 SA / Role / RoleBinding。例如：

```shell
$ kubectl -n arc-runners patch sa <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
$ kubectl -n arc-runners patch role <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
$ kubectl -n arc-runners patch rolebinding <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
```

这是当前版本与上游 cleanup/finalizer 问题同类的已知限制，不代表
`template.spec.serviceAccountName` 这条能力本身不支持；它的主效果
（runner pod 改用自定义 SA 并按该 SA 的 RBAC 鉴权）仍然是生效的。

---

## Chapter 7. 卸载

### 卸载前必须确认

下手前，确认：

- GitHub 端 workflow 都已停跑（卸载时正在跑的 workflow 会失败）。
- 没有其他业务依赖 `arc-runners` namespace 里的 PVC / ConfigMap /
  Secret。
- GitHub 端对应的 runner 注册（**Settings → Actions → Runners**）
  已记好，卸载后如果 controller 侧自动清理没走通，需要您手工去删除
  （详见下方 Step 1 的 Note）。

### Step 1: 卸载 Scale-Set 插件

在平台 UI 上：**Marketplace → Cluster Plugins**，找到 Scale-Set 插件
实例 → ⋮ → **Uninstall**。

> **Note：** 如果您的控制器 / Scale-Set 不是装在默认的
> `arc-systems` / `arc-runners`，本节后续所有 `kubectl -n ...` 与
> `kubectl delete namespace ...` 命令都要同步替换成您的实际 namespace。
> 卸载命令是 destructive 操作，不建议直接照抄默认值。

等 `arc-runners`（默认 Install Namespace）下的 pod 清理完：

```shell
$ kubectl -n arc-runners get autoscalingrunnerset
# 期望：no resources found

$ kubectl -n arc-runners get pod
# 期望：no resources found（或仅剩您自己其他非 ARC 的 workload）
```

> **Note：** 在当前 ARC 版本里，**正常**卸载 Scale-Set 插件时，controller
> 会在 `AutoscalingRunnerSet` finalizer 阶段调用 GitHub API 删除对应的
> runner scale set 注册条目，因此**通常不需要**您再到 GitHub UI 手工删。
> 只有在这条清理链路没走通时（例如控制器先被卸掉、GitHub 凭证失效、或
> finalizer 阶段报错卡住），才需要到 GitHub 上 **Settings → Actions →
> Runners** 手工检查并删除残留条目。注意这里的 scale set 条目与 GitHub 的
> "runner group"（runner 访问控制分组）不是同一个概念。

### Step 2: 卸载控制器插件

> **Warning —— 必须先卸载所有 Scale-Set 插件实例。** 控制器卸载时若
> 还有 scale-set 存在，listener pod 会进入 reconcile 循环，控制器的
> CRD 也可能残留 finalizer。

Marketplace → Cluster Plugins，找到控制器插件 → ⋮ → **Uninstall**。

确认控制器资源已经删除：

```shell
$ kubectl -n arc-systems get pod
# 期望：no resources found

$ kubectl get crd | grep actions.github.com
# 期望：empty（4 个 ARC CRD 由控制器插件移除）
```

### Step 3: 清理残留资源

部分资源不会被插件卸载自动删，需要手动清理：

```shell
# GitHub 凭证 Secret（插件不会删用户创建的 Secret）
$ kubectl -n arc-runners delete secret gha-runner-scale-set-github-config

# Recipe 1 自定义的 SA / Role / RoleBinding
$ kubectl -n arc-runners delete sa my-runner-sa
$ kubectl -n arc-runners delete rolebinding my-runner-sa-binding
$ kubectl -n arc-runners delete role my-runner-sa-role

# Recipe 6 自定义的 PVC / ConfigMap
$ kubectl -n arc-runners delete pvc maven-cache-pvc
$ kubectl -n arc-runners delete configmap extra-ca-bundle

# namespace（确认无残留 pod 后）
$ kubectl delete namespace arc-runners arc-systems
```

> **Warning：** 上面的删除命令按默认 namespace 展示。若您实际部署用了
> 自定义 namespace，请逐条替换后再执行，尤其不要在未核对的情况下直接
> 删除默认 `arc-runners` / `arc-systems`。

---

## 已知限制

- **控制器单 namespace 监听不可配。** 上游 chart 的
  `flags.watchSingleNamespace` 字段当前不可通过 Extra Chart Values
  设置（`flags` 顶层 key 已被表单渲染）。如有强需求，请联系平台支持
  团队。
- **本文对 runner 私有镜像拉取的主推荐路径是平台注入的
  `global.registry.imagePullSecrets`，或通过 ServiceAccount 间接挂
  `imagePullSecrets`。** 上游 chart 会把
  `template.spec.imagePullSecrets` 透传到 runner pod spec，但本文没有把它
  单列为插件化安装路径的主验证矩阵；若您想走这条路径，建议直接检查渲染后
  的 ARS / runner pod spec，并在目标集群上完成一次实际拉镜像验证。下面
  给出更稳妥、也更便于平台统一治理的 SA 挂载方式：

  ```shell
  $ kubectl create secret docker-registry my-private-registry \
      --docker-server=my.registry.com \
      --docker-username=<u> --docker-password=<p> \
      -n arc-runners
  $ kubectl create serviceaccount runner-puller -n arc-runners
  $ kubectl patch sa runner-puller -n arc-runners \
      -p '{"imagePullSecrets":[{"name":"my-private-registry"}]}'
  ```

  然后参考 [Recipe 1](#recipe-1-runner-pod-用自定义-serviceaccount跑-in-cluster-任务)
  把 `template.spec.serviceAccountName: runner-puller` 配进去。Listener
  侧 imagePullSecrets 不受此限制，可以直接在 Extra Chart Values 写
  `listenerTemplate.spec.imagePullSecrets`。
- **Scale-Set 集群插件入口只支持一个默认实例。** 通过 ACP 集群插件
  入口在同一集群上装第二份会被拒绝；如需在同集群上跑多组互相隔离的
  runner，可通过 ACP 平台的 **Catalog → Helm Chart** 多装几份上游
  `gha-runner-scale-set` chart 实例 —— 详见
  [Chapter 4 Method 3](#method-3-通过-helm-chart-直接部署多实例特殊诉求)。

---

## Appendix: 全量 chart values 参考

> **Tip —— 这是参考资料，不是必读。** 如果您只是想直接照着 Recipe 改
> 配置，可以跳过本节，直接到 [Step 2: 验证配置真的生效](#step-2-验证配置真的生效)
> 或下面的 [Recipe 1](#recipe-1-runner-pod-用自定义-serviceaccount跑-in-cluster-任务)。
> 本节把两个插件的上游 chart values（`gha-runner-scale-set-0.14.1`）完整
> 内嵌（带原文注释），方便您在写 ECV / EGV 时不离开本文档就能查到所有
> 字段的语义与 default。

ARC 由两个独立的 Cluster Plugin 组成 —— **控制器插件**和 **Scale-Set
插件**，两者各自有自己的 chart 与 values schema。Alauda overlay 对它们
的 default 调整也不一样，最显眼的差异在 `global.images.*`：控制器插件
只有 `images.controller`，Scale-Set 插件有 `images.runnerExtension`，
DinD 用户还会额外配置 `images.dind`。下面按插件分别给出。

每个插件都按两层组织 values：

- **Alauda overlay** —— Alauda Cluster Plugin 新增的字段（最关键的是
  `global:` 整块，承载平台镜像仓库 rewrite + pull-secret 注入），以及
  Alauda 改了 default 的字段。
- **上游 chart** —— ARC 上游发布、未经修改的 `gha-runner-scale-set-
  controller` / `gha-runner-scale-set` chart。当前 Alauda 插件对应上游
  `gha-runner-scale-set-0.14.1` 这个 release，下方链接与内嵌的 values
  都 pin 在该 tag。任何未在 Alauda overlay 显式列出的字段，default 都
  与上游一致 —— 把上游 values 当作 default 与字段语义的权威来源。

先读 Alauda 层了解平台已经替您处理掉哪些事；写 ECV / EGV 覆盖表单未
暴露的字段时，再去查上游层。下方折叠块里的 YAML 注释**保持英文**，与
源 chart 注释一致，便于您把片段直接对照原文。

### 控制器插件

<details>
<summary>Alauda overlay —— 控制器插件独有的新增 / default 改动（点击展开）</summary>

下面的 `global:` 块是最显眼的 Alauda 新增字段 —— 上游 chart 顶层
**没有** `global:`，是 Alauda Cluster Plugin 在装机时自动注入的，让
控制器的镜像拉取走平台仓库：

```yaml
# Provided by the Alauda Cluster Plugin; not present in the upstream chart.
global:
  registry:
    address: registry.alauda.cn:60070   # platform-injected on ACP install
    imagePullSecrets: []                # platform-managed; do not write directly
  labelBaseDomain: alauda.io
  images:
    controller:
      repository: devops/actions/gha-runner-scale-set-controller
      tag: "latest"
```

此外，Alauda overlay 还把以下上游字段改了 default（字段名与上游一致，
仅 default 不同）：

- `resources` / `podSecurityContext` / `securityContext` —— 调整为 PSS
  `restricted` 兼容值，按 ACP 控制面节点尺寸预设。
- `flags.logFormat: "json"`（上游默认 `text`）。

</details>

<details>
<summary>上游 chart values —— gha-runner-scale-set-0.14.1（点击展开）</summary>

源文件：[`charts/gha-runner-scale-set-controller/values.yaml` @ `gha-runner-scale-set-0.14.1`](https://github.com/actions/actions-runner-controller/blob/gha-runner-scale-set-0.14.1/charts/gha-runner-scale-set-controller/values.yaml)。下方为该文件原样转载，注释保留，免得您再跳到 GitHub。

```yaml
# Default values for gha-runner-scale-set-controller.
# This is a YAML-formatted file.
# Declare variables to be passed into your templates.
labels: {}

# leaderElection will be enabled when replicaCount>1,
# So, only one replica will in charge of reconciliation at a given time
# leaderElectionId will be set to {{ define gha-runner-scale-set-controller.fullname }}.
replicaCount: 1

image:
  repository: "ghcr.io/actions/gha-runner-scale-set-controller"
  pullPolicy: IfNotPresent
  # Overrides the image tag whose default is the chart appVersion.
  tag: ""

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

env:
## Define environment variables for the controller pod
#  - name: "ENV_VAR_NAME_1"
#    value: "ENV_VAR_VALUE_1"
#  - name: "ENV_VAR_NAME_2"
#    valueFrom:
#      secretKeyRef:
#        key: ENV_VAR_NAME_2
#        name: secret-name
#        optional: true

serviceAccount:
  # Specifies whether a service account should be created for running the controller pod
  create: true
  # Annotations to add to the service account
  annotations: {}
  # The name of the service account to use.
  # If not set and create is true, a name is generated using the fullname template
  # You can not use the default service account for this.
  name: ""

podAnnotations: {}

podLabels: {}

podSecurityContext: {}
# fsGroup: 2000

securityContext: {}
# capabilities:
#   drop:
#   - ALL
# readOnlyRootFilesystem: true
# runAsNonRoot: true
# runAsUser: 1000

resources: {}
## We usually recommend not to specify default resources and to leave this as a conscious
## choice for the user. This also increases chances charts run on environments with little
## resources, such as Minikube. If you do want to specify resources, uncomment the following
## lines, adjust them as necessary, and remove the curly braces after 'resources:'.
# limits:
#   cpu: 100m
#   memory: 128Mi
# requests:
#   cpu: 100m
#   memory: 128Mi

nodeSelector: {}

tolerations: []

affinity: {}

topologySpreadConstraints: []

# Mount volumes in the container.
volumes: []
volumeMounts: []

# Leverage a PriorityClass to ensure your pods survive resource shortages
# ref: https://kubernetes.io/docs/concepts/configuration/pod-priority-preemption/
# PriorityClass: system-cluster-critical
priorityClassName: ""

## If `metrics:` object is not provided, or commented out, the following flags
## will be applied the controller-manager and listener pods with empty values:
## `--metrics-addr`, `--listener-metrics-addr`, `--listener-metrics-endpoint`.
## This will disable metrics.
##
## To enable metrics, uncomment the following lines.
# metrics:
#   controllerManagerAddr: ":8080"
#   listenerAddr: ":8080"
#   listenerEndpoint: "/metrics"

flags:
  ## Log level can be set here with one of the following values: "debug", "info", "warn", "error".
  ## Defaults to "debug".
  logLevel: "debug"
  ## Log format can be set with one of the following values: "text", "json"
  ## Defaults to "text"
  logFormat: "text"

  ## Restricts the controller to only watch resources in the desired namespace.
  ## Defaults to watch all namespaces when unset.
  # watchSingleNamespace: ""

  ## The maximum number of concurrent reconciles which can be run by the EphemeralRunner controller.
  # Increase this value to improve the throughput of the controller.
  # It may also increase the load on the API server and the external service (e.g. GitHub API).
  runnerMaxConcurrentReconciles: 2

  ## Defines how the controller should handle upgrades while having running jobs.
  ##
  ## The strategies available are:
  ## - "immediate": (default) The controller will immediately apply the change causing the
  ##   recreation of the listener and ephemeral runner set. This can lead to an
  ##   overprovisioning of runners, if there are pending / running jobs. This should not
  ##   be a problem at a small scale, but it could lead to a significant increase of
  ##   resources if you have a lot of jobs running concurrently.
  ##
  ## - "eventual": The controller will remove the listener and ephemeral runner set
  ##   immediately, but will not recreate them (to apply changes) until all
  ##   pending / running jobs have completed.
  ##   This can lead to a longer time to apply the change but it will ensure
  ##   that you don't have any overprovisioning of runners.
  updateStrategy: "immediate"

  ## Defines a list of prefixes that should not be propagated to internal resources.
  ## This is useful when you have labels that are used for internal purposes and should not be propagated to internal resources.
  ## See https://github.com/actions/actions-runner-controller/issues/3533 for more information.
  ##
  ## By default, all labels are propagated to internal resources
  ## Labels that match prefix specified in the list are excluded from propagation.
  # excludeLabelPropagationPrefixes:
  #   - "argocd.argoproj.io/instance"

# Overrides the default `.Release.Namespace` for all resources in this chart.
namespaceOverride: ""

## Defines the K8s client rate limiter parameters.
  # k8sClientRateLimiterQPS: 20
  # k8sClientRateLimiterBurst: 30
```

</details>

### Scale-Set 插件

<details>
<summary>Alauda overlay —— Scale-Set 插件独有的新增 / default 改动（点击展开）</summary>

下面的 `global:` 块是最显眼的 Alauda 新增字段 —— 上游 chart 顶层
**没有** `global:`，是 Alauda Cluster Plugin 在装机时自动注入的，让
runner / runner-extension 的镜像拉取走平台仓库：

```yaml
# Provided by the Alauda Cluster Plugin; not present in the upstream chart.
global:
  registry:
    address: registry.alauda.cn:60070   # platform-injected on ACP install
    imagePullSecrets: []                # platform-managed; do not write directly
  labelBaseDomain: alauda.io
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: "latest"
    # `dind` image is intentionally NOT pre-declared — DinD mode is
    # opt-in and the upstream Docker CVE surface is best kept off the
    # Alauda patch backlog. Customers using DinD must mirror an upstream
    # image and override `global.images.dind.{repository,tag}` themselves.
```

此外，Alauda overlay 还把以下上游字段改了 default（字段名与上游一致，
仅 default 不同）：

- `githubConfigUrl` —— 写成显式占位符，让安装时缺值立即失败而不是
  渲染出空 URL。
- `githubConfigSecret: gha-runner-scale-set-github-config` —— 表单要求
  的默认 Secret 名。
- `containerMode.type: kubernetes-novolume`。
- `template.spec.containers[0]` —— 预填平台 runner 镜像 +
  `command: ["/home/runner/run.sh"]` +
  `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER=false`。
- `minRunners: 0` / `maxRunners: 5`。
- `controllerServiceAccount` —— 写死指向 `arc-systems` /
  `arc-gha-rs-controller`。

</details>

<details>
<summary>上游 chart values —— gha-runner-scale-set-0.14.1（点击展开）</summary>

源文件：[`charts/gha-runner-scale-set/values.yaml` @ `gha-runner-scale-set-0.14.1`](https://github.com/actions/actions-runner-controller/blob/gha-runner-scale-set-0.14.1/charts/gha-runner-scale-set/values.yaml)。下方为该文件原样转载，注释保留，免得您再跳到 GitHub。

> **Warning：** 下方内容按上游 `values.yaml` 原样转载，其中 pre-defined
> GitHub App Secret 的示例命令有一处已知瑕疵：它把
> `github_app_private_key` 示例写成了
> `-----BEGIN CERTIFICATE-----...`。实际使用时这里必须是 GitHub App
> private key 的 PEM 内容，而不是 certificate。执行请以正文的
> [Method 1：GitHub App 方式（推荐）](#method-1github-app-方式推荐)
> 为准。

```yaml
## githubConfigUrl is the GitHub url for where you want to configure runners
## ex: https://github.com/myorg/myrepo or https://github.com/myorg or https://github.com/enterprises/myenterprise
githubConfigUrl: ""

scaleSetLabels: []

## githubConfigSecret is the k8s secret information to use when authenticating via the GitHub API.
## You can choose to supply:
##   A) a PAT token,
##   B) a GitHub App, or
##   C) a pre-defined secret.
## The syntax for each of these variations is documented below.
## (Variation A) When using a PAT token, the syntax is as follows:
githubConfigSecret:
  # Example:
  # github_token: "ghp_sampleSampleSampleSampleSampleSample"
  github_token: ""
#
## (Variation B) When using a GitHub App, the syntax is as follows:
# githubConfigSecret:
#   # NOTE: IDs MUST be strings, use quotes
#   # The github_app_id can be an app_id or the client_id
#   github_app_id: ""
#   github_app_installation_id: ""
#   github_app_private_key: |
#      private key line 1
#      private key line 2
#      .
#      .
#      .
#      private key line N
#
## (Variation C) When using a pre-defined secret.
## The secret can be pulled either directly from Kubernetes, or from the vault, depending on configuration.
## Kubernetes secret in the same namespace that the gha-runner-scale-set is going to deploy.
## On the other hand, if the vault is configured, secret name will be used to fetch the app configuration.
## The syntax is as follows:
# githubConfigSecret: pre-defined-secret
## Notes on using pre-defined Kubernetes secrets:
##   You need to make sure your predefined secret has all the required secret data set properly.
##   For a pre-defined secret using GitHub PAT, the secret needs to be created like this:
##   > kubectl create secret generic pre-defined-secret --namespace=my_namespace --from-literal=github_token='ghp_your_pat'
##   For a pre-defined secret using GitHub App, the secret needs to be created like this:
##   > kubectl create secret generic pre-defined-secret --namespace=my_namespace --from-literal=github_app_id=123456 --from-literal=github_app_installation_id=654321 --from-literal=github_app_private_key='-----BEGIN CERTIFICATE-----*******'

## proxy can be used to define proxy settings that will be used by the
## controller, the listener and the runner of this scale set.
#
# proxy:
#   http:
#     url: http://proxy.com:1234
#     credentialSecretRef: proxy-auth # a secret with `username` and `password` keys
#   https:
#     url: http://proxy.com:1234
#     credentialSecretRef: proxy-auth # a secret with `username` and `password` keys
#   noProxy:
#     - example.com
#     - example.org

## maxRunners is the max number of runners the autoscaling runner set will scale up to.
# maxRunners: 5

## minRunners is the min number of idle runners. The target number of runners created will be
## calculated as a sum of minRunners and the number of jobs assigned to the scale set.
# minRunners: 0

# runnerGroup: "default"

## name of the runner scale set to create.  Defaults to the helm release name
# runnerScaleSetName: ""

## A self-signed CA certificate for communication with the GitHub server can be
## provided using a config map key selector. If `runnerMountPath` is set, for
## each runner pod ARC will:
## - create a `github-server-tls-cert` volume containing the certificate
##   specified in `certificateFrom`
## - mount that volume on path `runnerMountPath`/{certificate name}
## - set NODE_EXTRA_CA_CERTS environment variable to that same path
## - set RUNNER_UPDATE_CA_CERTS environment variable to "1" (as of version
##   2.303.0 this will instruct the runner to reload certificates on the host)
##
## If any of the above had already been set by the user in the runner pod
## template, ARC will observe those and not overwrite them.
## Example configuration:
#
# githubServerTLS:
#   certificateFrom:
#     configMapKeyRef:
#       name: config-map-name
#       key: ca.crt
#   runnerMountPath: /usr/local/share/ca-certificates/

# keyVault:
  # Available values: "azure_key_vault"
  # type: ""
  # Configuration related to azure key vault
  # azure_key_vault:
  #   url: ""
  #   client_id: ""
  #   tenant_id: ""
  #   certificate_path: ""
    # proxy:
    #   http:
    #     url: http://proxy.com:1234
    #     credentialSecretRef: proxy-auth # a secret with `username` and `password` keys
    #   https:
    #     url: http://proxy.com:1234
    #     credentialSecretRef: proxy-auth # a secret with `username` and `password` keys
    #   noProxy:
    #     - example.com
    #     - example.org

## Container mode is an object that provides out-of-box configuration
## for dind and kubernetes mode. Template will be modified as documented under the
## template object.
##
## If any customization is required for dind or kubernetes mode, containerMode should remain
## empty, and configuration should be applied to the template.
# containerMode:
#   type: "dind"  ## type can be set to "dind", "kubernetes", or "kubernetes-novolume"
#   ## the following is required when containerMode.type=kubernetes
#   kubernetesModeWorkVolumeClaim:
#     accessModes: ["ReadWriteOnce"]
#     # For local testing, use https://github.com/openebs/dynamic-localpv-provisioner/blob/develop/docs/quickstart.md to provide dynamic provision volume with storageClassName: openebs-hostpath
#     storageClassName: "dynamic-blob-storage"
#     resources:
#       requests:
#         storage: 1Gi
#   kubernetesModeAdditionalRoleRules: []
#

## listenerTemplate is the PodSpec for each listener Pod
## For reference: https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#PodSpec
# listenerTemplate:
#   spec:
#     containers:
#     # Use this section to append additional configuration to the listener container.
#     # If you change the name of the container, the configuration will not be applied to the listener,
#     # and it will be treated as a side-car container.
#     - name: listener
#       securityContext:
#         runAsUser: 1000
#     # Use this section to add the configuration of a side-car container.
#     # Comment it out or remove it if you don't need it.
#     # Spec for this container will be applied as is without any modifications.
#     - name: side-car
#       image: example-sidecar

## listenerMetrics are configurable metrics applied to the listener.
## In order to avoid helm merging these fields, we left the metrics commented out.
## When configuring metrics, please uncomment the listenerMetrics object below.
## You can modify the configuration to remove the label or specify custom buckets for histogram.
##
## If the buckets field is not specified, the default buckets will be applied. Default buckets are
## provided here for documentation purposes
# listenerMetrics:
#   counters:
#     gha_started_jobs_total:
#       labels:
#         ["repository", "organization", "enterprise", "job_name", "event_name", "job_workflow_ref", "job_workflow_name", "job_workflow_target"]
#     gha_completed_jobs_total:
#       labels:
#         [
#           "repository",
#           "organization",
#           "enterprise",
#           "job_name",
#           "event_name",
#           "job_result",
#           "job_workflow_ref",
#           "job_workflow_name",
#           "job_workflow_target",
#         ]
#   gauges:
#     gha_assigned_jobs:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_running_jobs:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_registered_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_busy_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_min_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_max_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_desired_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_idle_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#   histograms:
#     gha_job_startup_duration_seconds:
#       labels:
#         ["repository", "organization", "enterprise", "job_name", "event_name","job_workflow_ref", "job_workflow_name", "job_workflow_target"]
#       buckets:
#         [
#           0.01,
#           0.05,
#           0.1,
#           0.5,
#           1.0,
#           2.0,
#           3.0,
#           4.0,
#           5.0,
#           6.0,
#           7.0,
#           8.0,
#           9.0,
#           10.0,
#           12.0,
#           15.0,
#           18.0,
#           20.0,
#           25.0,
#           30.0,
#           40.0,
#           50.0,
#           60.0,
#           70.0,
#           80.0,
#           90.0,
#           100.0,
#           110.0,
#           120.0,
#           150.0,
#           180.0,
#           210.0,
#           240.0,
#           300.0,
#           360.0,
#           420.0,
#           480.0,
#           540.0,
#           600.0,
#           900.0,
#           1200.0,
#           1800.0,
#           2400.0,
#           3000.0,
#           3600.0,
#         ]
#     gha_job_execution_duration_seconds:
#       labels:
#         [
#           "repository",
#           "organization",
#           "enterprise",
#           "job_name",
#           "event_name",
#           "job_result",
#           "job_workflow_ref",
#           "job_workflow_name",
#           "job_workflow_target"
#         ]
#       buckets:
#         [
#           0.01,
#           0.05,
#           0.1,
#           0.5,
#           1.0,
#           2.0,
#           3.0,
#           4.0,
#           5.0,
#           6.0,
#           7.0,
#           8.0,
#           9.0,
#           10.0,
#           12.0,
#           15.0,
#           18.0,
#           20.0,
#           25.0,
#           30.0,
#           40.0,
#           50.0,
#           60.0,
#           70.0,
#           80.0,
#           90.0,
#           100.0,
#           110.0,
#           120.0,
#           150.0,
#           180.0,
#           210.0,
#           240.0,
#           300.0,
#           360.0,
#           420.0,
#           480.0,
#           540.0,
#           600.0,
#           900.0,
#           1200.0,
#           1800.0,
#           2400.0,
#           3000.0,
#           3600.0,
#         ]

## template is the PodSpec for each runner Pod
## For reference: https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#PodSpec
template:
  ## template.spec will be modified if you change the container mode
  ## with containerMode.type=dind, we will populate the template.spec with following pod spec
  ## template:
  ##   spec:
  ##     initContainers:
  ##     - name: init-dind-externals
  ##       image: ghcr.io/actions/actions-runner:latest
  ##       command: ["cp", "-r", "/home/runner/externals/.", "/home/runner/tmpDir/"]
  ##       volumeMounts:
  ##         - name: dind-externals
  ##           mountPath: /home/runner/tmpDir
  ##     - name: dind
  ##       image: docker:dind
  ##       args:
  ##         - dockerd
  ##         - --host=unix:///var/run/docker.sock
  ##         - --group=$(DOCKER_GROUP_GID)
  ##       env:
  ##         - name: DOCKER_GROUP_GID
  ##           value: "123"
  ##       securityContext:
  ##         privileged: true
  ##       restartPolicy: Always
  ##       startupProbe:
  ##         exec:
  ##           command:
  ##             - docker
  ##             - info
  ##         initialDelaySeconds: 0
  ##         failureThreshold: 24
  ##         periodSeconds: 5
  ##       volumeMounts:
  ##         - name: work
  ##           mountPath: /home/runner/_work
  ##         - name: dind-sock
  ##           mountPath: /var/run
  ##         - name: dind-externals
  ##           mountPath: /home/runner/externals
  ##     containers:
  ##     - name: runner
  ##       image: ghcr.io/actions/actions-runner:latest
  ##       command: ["/home/runner/run.sh"]
  ##       env:
  ##         - name: DOCKER_HOST
  ##           value: unix:///var/run/docker.sock
  ##         - name: RUNNER_WAIT_FOR_DOCKER_IN_SECONDS
  ##           value: "120"
  ##       volumeMounts:
  ##         - name: work
  ##           mountPath: /home/runner/_work
  ##         - name: dind-sock
  ##           mountPath: /var/run
  ##     volumes:
  ##     - name: work
  ##       emptyDir: {}
  ##     - name: dind-sock
  ##       emptyDir: {}
  ##     - name: dind-externals
  ##       emptyDir: {}
  ######################################################################################################
  ## with containerMode.type=kubernetes, we will populate the template.spec with following pod spec
  ## template:
  ##   spec:
  ##     containers:
  ##     - name: runner
  ##       image: ghcr.io/actions/actions-runner:latest
  ##       command: ["/home/runner/run.sh"]
  ##       env:
  ##         - name: ACTIONS_RUNNER_CONTAINER_HOOKS
  ##           value: /home/runner/k8s/index.js
  ##         - name: ACTIONS_RUNNER_POD_NAME
  ##           valueFrom:
  ##             fieldRef:
  ##               fieldPath: metadata.name
  ##         - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
  ##           value: "true"
  ##       volumeMounts:
  ##         - name: work
  ##           mountPath: /home/runner/_work
  ##     volumes:
  ##       - name: work
  ##         ephemeral:
  ##           volumeClaimTemplate:
  ##             spec:
  ##               accessModes: [ "ReadWriteOnce" ]
  ##               storageClassName: "local-path"
  ##               resources:
  ##                 requests:
  ##                   storage: 1Gi
  ######################################################################################################
  ## with containerMode.type=kubernetes-novolume, we will populate the template.spec with following pod spec
  ## template:
  ##   spec:
  ##     containers:
  ##     - name: runner
  ##       image: ghcr.io/actions/actions-runner:latest
  ##       command: ["/home/runner/run.sh"]
  ##       env:
  ##         - name: ACTIONS_RUNNER_CONTAINER_HOOKS
  ##           value: /home/runner/k8s-novolume/index.js
  ##         - name: ACTIONS_RUNNER_POD_NAME
  ##           valueFrom:
  ##             fieldRef:
  ##               fieldPath: metadata.name
  ##         - name: ACTIONS_RUNNER_IMAGE
  ##           value: ghcr.io/actions/actions-runner:latest # should match the runnerimage
  ##         - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
  ##           value: "true"
  spec:
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:latest
        command: ["/home/runner/run.sh"]
## Optional controller service account that needs to have required Role and RoleBinding
## to operate this gha-runner-scale-set installation.
## The helm chart will try to find the controller deployment and its service account at installation time.
## In case the helm chart can't find the right service account, you can explicitly pass in the following value
## to help it finish RoleBinding with the right service account.
## Note: if your controller is installed to only watch a single namespace, you have to pass these values explicitly.
# controllerServiceAccount:
#   namespace: arc-system
#   name: test-arc-gha-runner-scale-set-controller

# Overrides the default `.Release.Namespace` for all resources in this chart.
namespaceOverride: ""

## Optional annotations and labels applied to all resources created by helm installation
##
## Annotations applied to all resources created by this helm chart. Annotations will not override the default ones, so make sure
## the custom annotation is not reserved.
# annotations:
#   key: value
##
## Labels applied to all resources created by this helm chart. Labels will not override the default ones, so make sure
## the custom label is not reserved.
# labels:
#   key: value

## If you want more fine-grained control over annotations applied to particular resource created by this chart,
## you can use `resourceMeta`.
## Order of applying labels and annotations is:
## 1. Apply labels/annotations globally, using `annotations` and `labels` field
## 2. Apply `resourceMeta` labels/annotations
## 3. Apply reserved labels/annotations
# resourceMeta:
#   autoscalingRunnerSet:
#     labels:
#       key: value
#     annotations:
#       key: value
#   githubConfigSecret:
#     labels:
#       key: value
#     annotations:
#       key: value
#   kubernetesModeRole:
#     labels:
#       key: value
#     annotations:
#       key: value
#   kubernetesModeRoleBinding:
#     labels:
#       key: value
#     annotations:
#       key: value
#   kubernetesModeServiceAccount:
#     labels:
#       key: value
#     annotations:
#       key: value
#   managerRole:
#     labels:
#       key: value
#     annotations:
#       key: value
#   managerRoleBinding:
#     labels:
#       key: value
#     annotations:
#       key: value
#   noPermissionServiceAccount:
#     labels:
#       key: value
#     annotations:
#       key: value
#   autoscalingListener:
#     labels:
#       key: value
#     annotations:
#       key: value
#   listenerServiceAccount:
#     labels:
#       key: value
#     annotations:
#       key: value
#   listenerRole:
#     labels:
#       key: value
#     annotations:
#       key: value
#   listenerRoleBinding:
#     labels:
#       key: value
#     annotations:
#       key: value
#   listenerConfigSecret:
#     labels:
#       key: value
#     annotations:
#       key: value
#   ephemeralRunnerSet:
#     labels:
#       key: value
#     annotations:
#       key: value
#   ephemeralRunner:
#     labels:
#       key: value
#     annotations:
#       key: value
#   ephemeralRunnerConfigSecret:
#     labels:
#       key: value
#     annotations:
#       key: value
```

</details>

---

## 参考资料

- [Alauda Container Platform 文档](https://docs.alauda.io/) —— 平台 UI 通用操作。
- [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps) —— GitHub App 创建步骤。
- [GitHub Actions Runner Controller (upstream)](https://github.com/actions/actions-runner-controller) —— 上游项目，含完整 chart values 文档。
- [Self-hosted runner concepts](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller/about-actions-runner-controller) —— GitHub 官方对 ARC scale-set 模式的概念介绍。
- [Communicating with self-hosted runners](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/runners/self-hosted-runners) —— GitHub 官方 self-hosted runner 连通性要求，含 `github.com`、`api.github.com`、`*.actions.githubusercontent.com` 等域名范围（[系统要求](#系统要求) 段引用）。
- [Authenticate to the GitHub API (ARC)](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api) —— GitHub 官方 PAT scope 与 fine-grained 权限矩阵的权威来源（[权限要求](#权限要求)、
  [Method 2：PAT](#method-2pat-personal-access-token-方式) 段引用）。
- [Managing access to self-hosted runners using groups](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access) —— GitHub 官方对 runner groups、`Selected repositories`、`Selected workflows`、enterprise `Selected organizations` 的说明（[Chapter 4](#chapter-4-多团队--多项目隔离策略) 段引用）。
- [Use ARC in a workflow](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/use-arc-in-a-workflow) —— GitHub 官方对 `runs-on:` 字符串与数组形式、`scaleSetLabels` 的说明（[Workflow 侧：runs-on 要求](#workflow-侧runs-on-要求)、
  [Workflow 侧：runs-on 数组形式与 scaleSetLabels](#workflow-侧runs-on-数组形式与-scalesetlabels)、
  [Issue 3](#issue-3-workflow-stays-queued---runner-永远不来) 段引用）。
