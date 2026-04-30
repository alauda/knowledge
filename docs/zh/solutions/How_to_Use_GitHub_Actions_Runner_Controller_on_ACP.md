---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB260400016
sourceSHA: 8b0894866c53075448b4c5265c58154344c05054a69b0e001bf168bec623c5b3
---

# 在 Alauda Container Platform 上使用 ARC 部署 GitHub Actions 自托管运行器

## 概述

默认情况下，GitHub Actions 在 GitHub 托管的运行器上运行工作流。这些运行器位于公共互联网中，无法访问您的内部服务。**自托管运行器** 允许您在自己的集群内运行工作流，因此作业可以使用集群计算、访问内部资源，并在隔离环境中执行。每个工作流触发都会在集群中生成一个临时运行器 Pod，当作业完成时该 Pod 会被销毁。当工作流使用 `container:` 字段时，ARC 使用运行器容器挂钩来启动相应的作业 Pod / Kubernetes 作业在运行器命名空间中；当启用 DinD 模式时，运行器 Pod 本身携带 DinD 边车 / 初始化容器。

本文档描述了如何在 Alauda Container Platform (ACP) 上部署和使用 GitHub Actions 自托管运行器。该实现基于 GitHub 的上游 Actions Runner Controller (ARC) 项目，Alauda 将其重新打包为两个 ACP 集群插件：

- **Alauda 对 GitHub Actions Runner Controller 的支持**（以下称为 **controller plugin**）—— ARC 控制平面。每个 ACP 集群安装一次。
- **Alauda 对 GitHub Actions Runner Scale Set 的支持**（以下称为 **scale-set plugin**）—— 提供一组绑定到 GitHub 组织或存储库的自托管运行器。**ACP 集群插件条目仅支持每个集群一个默认实例**；对于同一集群上的多个隔离运行器池，请通过平台的 **Catalog → Helm Chart** 条目安装额外的上游 `gha-runner-scale-set` 图表副本（仍在 ACP UI 内；**不需要 `helm` CLI**）。请参见 [第 4 章 多团队 / 多项目隔离](#chapter-4-multi-team--multi-project-isolation)，方法 3。

这两个插件仅提供 ARC 的 **scale-set 模式**（不支持传统的运行器部署模式）。原因详见 [为什么选择 scale-set 模式（而不是传统模式）](#why-scale-set-mode-not-legacy)。

### 本文档涵盖的内容

- 安装两个插件并验证第一个工作流（[第 1 章](#chapter-1-installing-the-controller-plugin) 到 [第 2 章](#chapter-2-installing-the-scale-set-plugin)）—— 新用户可以仅通过阅读本节完成第一次部署。
- 运行器镜像：预安装的 CLI 工具、运行时身份、第三方操作处理。请参见 [运行器镜像](#the-runner-image)。
- 通过额外值进行高级自定义—— ServiceAccount、资源限制、PVC 缓存、DinD 模式、自定义镜像等。请参见 [第 3 章](#chapter-3-customizing-runners-via-extra-values)。
- 多团队 / 多项目隔离策略。请参见 [第 4 章](#chapter-4-multi-team--multi-project-isolation)。
- 工作流示例：在自定义容器中运行作业、触发集群内的 Tekton Pipeline，以及在无守护进程模式下使用 Buildah 构建镜像（仍然是特权模式）。请参见 [第 5 章](#chapter-5-workflow-examples)。
- 故障排除和卸载。请参见 [第 6 章](#chapter-6-troubleshooting) 和 [第 7 章](#chapter-7-uninstall)。

### 两个插件一览

| 插件              | 目的                                                   | 默认安装命名空间 | 每个集群多个实例                                                                                     |
| ----------------- | ----------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Controller plugin | 托管 ARC 控制平面（控制器部署、CRDs）                 | `arc-systems`    | 否                                                                                                                 |
| Scale-set plugin  | 定义一组绑定到 GitHub 组织 / 存储库的运行器           | `arc-runners`    | 否，通过集群插件条目；是，通过 **Catalog → Helm Chart** 使用上游图表（请参见第 4 章方法 3） |

### 适用性

| 项目                          | 当前基线                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 上游 ARC 版本                 | `gha-runner-scale-set-0.14.1`（图表值引用链接固定在此标签）                                                                                                                                                                                                                                            |
| Alauda 集群插件版本          | Alauda 打包跟踪上游 0.14.1；确切的版本号在 ACP Marketplace 的插件详细信息页面上显示                                                                                                                                                                                              |
| 验证的 GitHub 形式因素       | 仅针对公共 `github.com` 进行验证。GitHub Enterprise Cloud 共享相同的注册端点，**理论上支持**，但在本文档中未单独验证；GHES 同样**不在**本文档的验证范围内。请根据您的实时集群验证任何特定形式因素的详细信息 |
| 安装路径                      | 通过 ACP Marketplace 集群插件条目；**Catalog → Helm Chart** 路径不是本文档的主要主题（请参见第 4 章方法 3）                                                                                                                                                                              |

> **注意：** 本文档中的具体细节（表单字段、预安装工具、UID/GID、图表值默认值、错误消息文本等）均与上述基线相关。**某些细节在插件或上游 ARC 升级后可能会发生变化**；当现实与文档不符时，请信任实时集群（`kubectl get autoscalingrunnerset -o yaml`，匹配的上游 `values.yaml`）而不是这里写的内容。

### 术语

| 缩写        | 全名                                | 本文档中的含义                                                  |
| ----------- | ----------------------------------- | --------------------------------------------------------------- |
| ARC         | Actions Runner Controller           | GitHub 的上游 Kubernetes 控制器，用于自托管运行器               |
| ACP         | Alauda Container Platform           | 本平台                                                         |
| ARS         | AutoscalingRunnerSet                | 描述一组可扩展运行器的核心 ARC CRD                             |
| ER / ERS    | EphemeralRunner / EphemeralRunnerSet | 个别运行器 Pod 及其拥有集的 CRD                                |
| SA          | ServiceAccount                      | Kubernetes ServiceAccount                                       |
| GHES        | GitHub Enterprise Server            | GitHub 的自托管发行版                                         |
| PAT         | Personal Access Token               | GitHub 访问令牌                                               |
| ECV         | Extra Chart Values                  | 插件表单中用于高级覆盖的顶级 YAML 文本区域                    |
| EGV         | Extra Global Values                 | 与 ECV 相同，但内容嵌入在图表的 `global:` 块下               |

---

## 理解架构

### 为什么选择 scale-set 模式（而不是传统模式）

ARC 有两种上游部署模式：**scale-set** 和 **legacy**（运行器部署模式）。这两个 Alauda 插件仅打包 scale-set 模式，原因如下：

- **GitHub 推荐的方向。** Scale-set 是 GitHub 自 2023 年以来一直推动的新 ARC 模式；传统模式处于维护状态，不再接收新功能。新的部署应使用 scale-set。
- **更好的身份验证模型。** Scale-set 推荐使用 GitHub 应用安装级别的凭证（也支持 PAT），其粒度比 PAT 更细，易于按存储库 / 组织进行范围限制，并且更易于轮换。
- **原生自动扩展。** Scale-set 通过长轮询作业获取协议直接与 GitHub 的 Actions 服务进行通信。当作业到达时，会创建一个临时 Pod，并在作业结束时销毁；默认情况下为零扩展——不需要空闲运行器。
- **更简单的架构。** 传统模式需要 GitHub 到集群的 webhook 交付，这意味着需要将集群暴露到互联网。Scale-set 完全是出站的（集群 → GitHub），不需要任何入站暴露。

### 组件如何协同工作

当安装了两个插件时，集群在两个命名空间中运行四个逻辑组件：

| 组件                          | 运行位置       | Pod 类型                          | 所有者                             |
| ----------------------------- | -------------- | --------------------------------- | ---------------------------------- |
| Controller                    | `arc-systems`  | Deployment                        | Controller plugin                  |
| Listener (每个 scale-set 一个) | `arc-systems`  | Pod（由控制器管理）               | Controller（代表 scale-set）      |
| AutoscalingRunnerSet (ARS)    | `arc-runners`  | CRD 对象                          | Scale-set plugin                   |
| EphemeralRunner pod           | `arc-runners`  | Pod（生命周期：每个工作流作业）  | Controller                         |

一些新用户经常遇到的非显而易见的要点：

- **监听器 Pod 在控制器命名空间中运行**（`arc-systems`），而不是在 scale-set 自己的 `arc-runners` 中。这是因为监听器是由控制器创建的，并重用控制器的 ServiceAccount / RBAC。
- 使用 `minRunners=0` 时，`arc-runners` 中不存在运行器 Pod，直到工作流触发——这是正常的。
- CRDs（`AutoscalingRunnerSet`、`AutoscalingListener`、`EphemeralRunnerSet`、`EphemeralRunner`）由控制器插件创建，并且是集群范围的。

### 安装包中捆绑的镜像

下表澄清了哪些 ARC 组件镜像在 Alauda Marketplace 安装包中预捆绑，哪些需要手动同步：

| 组件        | 镜像                                            | 捆绑                  | 空隙操作                                                                                                                                                                              |
| ----------- | ----------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller   | `gha-runner-scale-set-controller`                | ✅ 在控制器插件中     | 无                                                                                                                                                                                  |
| Listener     | 使用控制器镜像（由控制器分叉）                 | ✅                     | 无                                                                                                                                                                                  |
| Runner main  | `gha-runner-scale-set-runner-extension`          | ✅ 在 scale-set 插件中 | 无                                                                                                                                                                                  |
| DinD 边车   | `docker:<tag>-dind`                              | ❌                     | 将上游镜像同步到平台注册表；请参见 [食谱 8](#recipe-8-dind-mode-run-docker-build-inside-runner) 和 [食谱 9](#recipe-9-override-arc-images-custom-version--private-registry) |

**结论：** 在没有 DinD 模式的情况下，安装包在隔离集群内端到端运行。DinD 模式需要将一个额外的镜像同步到平台注册表。

> **关于空隙中的第三方操作的注意事项：** 使用 `uses: actions/checkout@v4` 和其他社区操作的工作流需要网络访问，以便在运行时从 `github.com` 获取操作源。运行器镜像不捆绑操作源，平台插件也不提供操作镜像。请参见 [使用第三方操作（`uses:`）](#using-third-party-actions-uses) 以获取空隙的解决方法。

### 平台注入的运行时默认值

通过 ACP Marketplace 安装时，插件图表会自动接收以下值。您**不需要**手动配置它们：

- `global.registry.address` — 平台镜像注册表前缀；ARC 组件镜像会自动从该前缀拉取。
- `global.registry.imagePullSecrets` — 平台注册表的凭证，由平台控制器管理。
- `global.images.<component>.repository` — 默认指向平台注册表内捆绑的镜像路径。

您只需在 **Extra Global Values** 字段中设置 `images:`，当您想要覆盖镜像源时——例如，自定义上游版本、私有注册表子路径或 DinD 镜像。请参见 [食谱 9](#recipe-9-override-arc-images-custom-version--private-registry)。

> **警告：** 请勿在 EGV 下编写 `registry:` 子键。平台已经呈现了 `global.registry`；如果您写 `  registry:`（在 EGV 内的 2 空格缩进），它会被静默丢弃。覆盖无效且不会报告错误。

### 运行器镜像

安装两个插件后，您可能想知道运行器镜像中可用的内容以及它是如何执行的。

#### 预安装的 CLI 工具

运行器镜像捆绑了常见的 CI/CD 命令行工具。您可以直接在工作流的 `run:` 步骤中调用它们：

| 类别            | 工具                                             |
| --------------- | ------------------------------------------------- |
| Kubernetes      | `kubectl`、`helm`                                 |
| Tekton          | `tkn`                                             |
| 通用 CLI        | `git`（带有 git-lfs）、`curl`、`jq`、`yq`          |
| Shell / 压缩    | `bash`、`tar`、`unzip`、`zip`、`gzip`、`zstd`     |
| Node.js 运行时  | Node 20 / Node 24（仅运行时——见下文说明）        |
| OpenSSH         | `ssh`                                             |

注意：

- **Docker 未预安装。** Alauda 运行器镜像基于 `almalinux:9-minimal` 构建，故意排除了 `docker` / `docker-compose` / `dockerd` / `containerd` / `buildx` / `runc`，以保持镜像小巧并减少 CVE 面。DinD 模式（容器模式 = `dind`）启动一个由上游图表提供的单独 `docker:dind` 边车，但其 docker CLI 不会自动在运行器 Pod 内可用。如果工作流步骤需要调用 `docker` / `docker-compose`，标准路径是构建一个自定义运行器镜像，将 docker CLI 捆绑在内，并通过 [食谱 9](#recipe-9-override-arc-images-custom-version--private-registry) 将 `images.runnerExtension` 指向它。
  - **请勿尝试在步骤时间使用 `microdnf install -y docker-ce-cli` 进行安装。** 默认运行器以非根用户 `runner`（UID/GID 1001）身份运行，因此普通工作流步骤已经不是系统软件包安装的正确位置；此外，运行器镜像默认仅启用 AlmaLinux BaseOS / AppStream，而 `docker-ce-cli` 不在任何存储库中。步骤时间安装必须解决根权限问题和额外的 docker.io 存储库设置——脆弱且每个步骤重复。
  - **请勿切换到 `jobs.<id>.container.image:`** 以在 DinD 下引入 docker CLI——DinD 与 GHA 的 `container:` 字段不兼容（请参见 [示例 1](#example-1-run-a-job-in-a-custom-container) 下的警告）。
- **Node.js（20 / 24）仅为嵌入式运行时**——捆绑的 Node 被精简（无 `npm` / 无 `corepack` / 无 Alpine 变体）。这是运行 JavaScript 操作所需的最小配置；要在步骤内获得完整的 Node 开发环境，请调用 `actions/setup-node@v5`，该操作按需安装相应的完整工具链。
- **`kubectl` / `tkn` 默认仅具有小的基线权限集，这与业务 RBAC 不同。** 二进制文件安装在运行器镜像中，但运行器 Pod 使用的默认 ServiceAccount 主要携带运行器容器挂钩所需的命名空间范围基线权限（例如 `pods`、`pods/log`、`pods/exec`、`secrets`；确切的权限集仍取决于当前的容器模式）。这并不自动意味着工作流可以自由检查或修改集群资源。如果工作流需要 Tekton、Deployment、CRD 或业务命名空间访问，仍需配置具有所需 RBAC 的显式 ServiceAccount——请参见 [食谱 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs)。还请注意，有效权限集可能会因环境中的额外 RoleBindings / ClusterRoleBindings 而扩大，因此请不要仅依赖文档印象；请在集群中使用 `kubectl auth can-i --list --as system:serviceaccount:<runner-ns>:<runner-sa> -n <runner-ns>` 验证。

#### 如果您需要的工具缺失怎么办

如果工作流需要的工具不在上表中，请采取以下方法之一：

1. **优先使用步骤级设置操作**，例如 `actions/setup-node@v5`、`actions/setup-go@v5` 或 `actions/setup-java@v4`。只有在您故意切换到允许根软件包安装的自定义作业容器时，才应考虑在 `run:` 中调用包管理器。默认的 Alauda 运行器镜像基于 `almalinux:9-minimal` 构建，捆绑了 **`microdnf`，而不是 `dnf`**，但运行器本身以非根 UID/GID 1001 用户身份执行，因此在正常工作流步骤中，普通的 `microdnf install -y <pkg>` 通常因权限问题而失败。
2. **使用工作流 `container:` 切换到自定义镜像**——将 `jobs.<id>.container.image` 设置为包含该工具的镜像。**这仅适用于** `kubernetes-novolume`（默认）或 `kubernetes` 容器模式；`dind` 不支持 GHA 的 `container:` 字段。请参见 [示例 1](#example-1-run-a-job-in-a-custom-container)。
3. **替换默认运行器镜像**——构建一个自定义运行器镜像，并通过 [食谱 9](#recipe-9-override-arc-images-custom-version--private-registry) 将 `images.runnerExtension` 指向它。

#### 运行时身份

- **UID / GID：** 1001 / 1001（非根 `runner` 用户）。
- **`HOME`：** `/home/runner`。
- **当前启动路径：** 图表 / 覆盖明确运行 `command: ["/home/runner/run.sh"]`，然后 `run.sh` 启动运行器进程。`entrypoint.sh` / `startup.sh` 属于传统的上游运行器镜像启动路径，但它们不是当前 Alauda 运行器扩展镜像的主要执行入口点。
- **资源限制：** 在 [食谱 4](#recipe-4-limit-cpu--memory-of-runners) 中向运行器容器添加 `resources` 时，您**必须保持** `command: ["/home/runner/run.sh"]`（图表默认）。省略它会使 Pod 启动，但运行器进程永远不会运行 `run.sh`（它回退到基础镜像的默认启动行为），导致工作流保持排队状态。

#### 使用第三方操作（`uses:`）

GitHub Actions 步骤如 `uses: actions/checkout@v4` 使工作流调用社区维护的可重用操作。在执行步骤之前，运行器会从 GitHub 下载操作源到 Pod 内的 `/home/runner/_work/_actions/`，然后将其交给 Node.js 执行。**这是运行时行为，不是运行器镜像的一部分。**

##### 方法 1：直接连接 / HTTPS 代理

当集群可以直接访问 `github.com` 时，工作流就可以正常工作：

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v5
    with:
      node-version: '20'
  - run: npm ci
```

如果集群没有直接访问，但有 HTTPS 出口代理（在企业网络中很常见），请通过 [食谱 2](#recipe-2-inject-secrets--custom-env-into-runner) 将 `HTTPS_PROXY` 注入到运行器 Pod 中。在 scale-set 插件表单的额外图表值中粘贴以下内容（`image:` 和 `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` 条目是 helm 数组替换语义下的必需回退——请参见 [第 3 章，第 1 步](#step-1-understanding-ecv-vs-egv) 中的安全骨架警告）：

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>          # required; see Recipe 9 to discover the live path
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                         # required for kubernetes-novolume / dind modes
      - name: HTTPS_PROXY
        value: "http://proxy.example.com:3128"
      - name: NO_PROXY
        value: "<internal-domain>,localhost,127.0.0.1"
```

##### 方法 2：空隙——将操作镜像到内部 GHES

当集群完全无法访问 `github.com` 时，ARC 没有内置的操作镜像——运行器镜像不捆绑任何操作源，平台插件也不提供“操作源 URL 转发”选项。

第一种选择是将 `actions/checkout` 和其他所需的操作库分叉（或镜像）到**与运行器注册的同一 GitHub 实例**（即由 `githubConfigUrl` 引用的主机——通常是您的内部 GHES），然后将 `uses:` 更改为内部路径：

```yaml
steps:
  - uses: my-org/checkout@v4   # mirrored to the same GHES instance
```

运行器根据从 `githubConfigUrl` 派生的基本 URL 解析 `uses:`，因此 `my-org/checkout` 必须位于**同一 GitHub 实例**（github.com 或 GHES）上——并且该主机必须可以从集群访问。

> **注意——内部 git 是 GitLab / Gitea / Gitee。** GitHub Actions `uses: owner/repo@ref` 协议仅在 GitHub 实例上解析；无法从 GitLab / Gitea / Gitee 获取。在这些环境中，方法 2 不适用——请切换到下面的方法 3（在 `run:` 中编写 `git clone`）。

##### 方法 3：空隙——用 `run:` shell 脚本替换 `uses:`

完全跳过 `uses:`，自己编写等效的 shell。`actions/checkout@v4` 的功能可以用一个 `git clone` 替代：

```yaml
steps:
  - name: checkout
    env:
      GIT_TOKEN: ${{ secrets.INTERNAL_GIT_TOKEN }}
    run: |
      git clone --depth=1 \
        "https://oauth2:${GIT_TOKEN}@my-internal-git.example.com/${GITHUB_REPOSITORY}" .
```

工作流稍微长一些，但**不依赖于 github.com 或任何操作镜像**——这是最稳健的空隙路径。

> **警告——运行器注册到 github.com，但集群没有出站：** 方法 2 仅在 `githubConfigUrl` 引用的主机可以从集群访问时有效。如果运行器注册到 github.com，但运行器 Pod 没有出站，**`uses:` 无法直接工作**——您必须使用方法 3 或授予集群访问 github.com 的代理。

---

## 常见基本配置

### 环境准备

#### 系统要求

- ACP 集群（global 集群或业务集群，任意均可）。
- 集群可以访问自托管运行器所需的 GitHub 域。对于 GitHub.com，这至少包括 `github.com:443`、`api.github.com:443` 和 `*.actions.githubusercontent.com:443`。有关更广泛的域列表和 GHES 特定要求，请遵循 GitHub 的官方自托管运行器通信要求，而不是假设您只需替换两个主机名。
- 对于空隙集群，请参见 [安装包中捆绑的镜像](#images-bundled-in-the-install-package) 以了解哪些镜像需要预同步，以及 [使用第三方操作（`uses:`）](#using-third-party-actions-uses) 以获取工作流 `uses:` 的解决方法。

#### 所需组件

- 控制器插件（Alauda 对 GitHub Actions Runner Controller 的支持）。
- Scale-set 插件（Alauda 对 GitHub Actions Runner Scale Set 的支持）。
- 一个 GitHub 凭证——可以是 GitHub 应用或 PAT。

#### 权限要求

- 集群管理员权限以安装两个插件。
- 创建命名空间的权限（默认为 `arc-systems` 和 `arc-runners`）。
- GitHub 身份（应用或 PAT）。根据 `githubConfigUrl` 范围选择身份验证方法：

| `githubConfigUrl` 范围                                    | GitHub 应用                                | PAT                         |
| ---------------------------------------------------------- | ----------------------------------------- | --------------------------- |
| 存储库 (`https://github.com/<org>/<repo>`)                | 支持                                     | 支持                         |
| 组织 (`https://github.com/<org>`)                         | 支持                                     | 支持                         |
| 企业 (`https://github.com/enterprises/<enterprise>`)     | **不支持**（GitHub 平台限制）            | 支持（**唯一选择**）        |

> **注意——企业级 ARC 需要 PAT。** GitHub 不接受 GitHub 应用身份验证用于企业级的运行器注册（[上游文档](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api) 明确指出）。如果您的 scale-set 的 `githubConfigUrl` 是企业范围的，请跳过下面的方法 1（GitHub 应用），直接转到方法 2（PAT）。

使用所选的身份验证方法，授予最低权限：

- **GitHub 应用，存储库级别的 scale-set** —
  - 存储库：`Administration: Read & Write`、`Metadata: Read`
- **GitHub 应用，组织级别的 scale-set** —
  - 存储库：`Metadata: Read`
  - 组织：`Self-hosted runners: Read & Write`
- **PAT（经典）** — 根据 `githubConfigUrl` 范围选择：存储库使用 `repo`，组织使用 `admin:org`（已涵盖自托管运行器写入），企业使用 `manage_runners:enterprise`（**企业级 ARC 需要经典 PAT**——不支持细粒度令牌）。
- **PAT（细粒度）** — **存储库级别**：存储库权限 `Administration: Read and write`。**组织级别**：存储库权限 `Administration: Read` + 组织权限 `Self-hosted runners: Read and write`。**企业级：不支持。**

> **来源：** 规范的范围名称和组合记录在 [GitHub 的 ARC 身份验证指南](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api) 中。
>
> GitHub 自己的说明容易被忽视：`Administration: Read & Write` 仅在存储库范围的注册时**是必需的**；组织范围的注册不需要它。

### GitHub 凭证设置

选择以下两种方法之一创建一个 Secret，以便运行器可以通过它进行身份验证。此 Secret 可以在安装 scale-set 插件**之前或之后**创建：插件不会覆盖已存在的 Secret。如果这是**安装后创建的初始 Secret**，相关 Pod 通常会在 Secret 出现后自动恢复；如果几分钟后仍未恢复，请删除监听器 Pod 一次以强制重建。如果您正在**轮换现有 Secret 的内容**，监听器 Pod **不会自动获取更改**——控制器不会监视 Secret 资源。通过删除监听器 Pod 强制重启，例如：

```shell
$ kubectl -n arc-systems delete pod \
    -l actions.github.com/scale-set-name=<scale-set-name>
```

控制器将重新创建监听器 Pod，并使用新凭证重新连接。

默认 Secret 名称为 `gha-runner-scale-set-github-config`。要使用不同的名称，请在 scale-set 插件表单上设置 **GitHub Credentials Secret Name** 字段（[第 2 章 第 2 步](#step-2-install-via-marketplace-1)）。

> **注意：** 如果您计划将 scale-set 插件安装到自定义命名空间，请在方法 1 和方法 2 中将 `arc-runners` 替换为该命名空间。**GitHub 凭证 Secret 必须位于 scale-set 的安装命名空间中。**

#### 方法 1：GitHub 应用（推荐）

```shell
$ kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f -

$ kubectl -n arc-runners create secret generic gha-runner-scale-set-github-config \
    --from-literal=github_app_id=<your-app-id> \
    --from-literal=github_app_installation_id=<your-installation-id> \
    --from-file=github_app_private_key=/path/to/your-app.private-key.pem
```

如何获取这三个值（前两个来自同一 GitHub 应用设置页面，第三个来自安装后在目标组织 / 存储库上的应用安装 URL）：

- **`github_app_id`** — 在 GitHub UI **设置 → 开发者设置 → GitHub 应用 → 您的应用**中，“关于”块中的 `App ID` 字段。它是一个数字。如果您使用 YAML 清单而不是 `kubectl create secret --from-literal` 创建 Secret，**请将值用引号括起来**（例如，`github_app_id: "123456"`）；否则 ARC 报告 `failed to get app id: strconv.ParseInt`。
- **`github_app_private_key`** — 在同一应用设置页面底部，点击“生成私钥”以下载 `.pem` 文件。使用 `--from-file=github_app_private_key=...` 传递路径。**使用 `--from-file`，而不是 `--from-literal`**——PEM 文件需要换行；`--from-literal` 会将多行合并为一行，监听器日志报告 `failed to parse private key`。
- **`github_app_installation_id`** — 首先将应用安装到目标组织 / 存储库。转到 **GitHub 应用 → 您的应用 → 安装应用** 选项卡，选择要安装的组织 / 存储库。安装后，单击该行上的“配置”；浏览器将导航到类似于 `https://github.com/organizations/<org>/settings/installations/12345678` 的 URL，尾部的 `12345678` 即为 `installation_id`。错误的值会导致监听器日志中的 `Could not find any installation` 错误。

#### 方法 2：个人访问令牌

**在 GitHub UI 中生成 PAT** **设置 → 开发者设置 → 个人访问令牌**。有两种类型可用；根据 `githubConfigUrl` 范围选择权限（规范列表和理由见 [GitHub 的 ARC 身份验证指南](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api)）：

- **细粒度（推荐）** — 作用于特定存储库或组织。创建时选择资源所有者（用户或组织）和目标存储库（所有 / 仅选择的存储库）。
  **细粒度令牌不支持企业级 ARC。**
  - **存储库级 `githubConfigUrl`** — 存储库权限：`Administration: Read and write`。
  - **组织级 `githubConfigUrl`** —
    - 存储库权限：`Administration: Read`
    - 组织权限：`Self-hosted runners: Read and write`
- **经典** — 范围较粗；**企业级 ARC 的唯一选项**。
  - **存储库级** — `repo`。
  - **组织级** — `admin:org`。
  - **企业级** — `manage_runners:enterprise`。

有关详细信息，请参见 GitHub 的官方文档 [管理您的个人访问令牌](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

获取令牌后，将其写入 Secret：

```shell
$ kubectl -n arc-runners create secret generic gha-runner-scale-set-github-config \
    --from-literal=github_token=ghp_xxxxxxxxxxxxxxxxxxxxx
```

### 工作流侧：`runs-on:` 要求

本文档（Alauda 当前验证路径）仅涵盖 **单字符串** 形式——`runs-on:` 设置为在 scale-set 插件表单中配置的 `runnerScaleSetName`：

```yaml
# Alauda 验证的：单字符串
runs-on: my-runners
```

> **注意——想要一个 scale-set 覆盖多个标签集？** 上游图表的 `scaleSetLabels` 字段与 `runs-on:` 的数组形式结合，正好可以实现这一点，**但有一个关键的仅限安装时的约束**：安装后更改标签不会传播到 GitHub。完整路径、注入方法和“如果我已经安装它该怎么办”在 [工作流侧：带有 scaleSetLabels 的 runs-on 数组形式](#workflow-side-runs-on-array-form-with-scalesetlabels) 中。

**最常见的错误**是写 `runs-on: [self-hosted, label]`（传统 ARC 语法），而没有在 scale-set 上配置 `scaleSetLabels`，导致 GitHub 没有匹配的内容。请注意，这与新的 scale-set 模式数组形式不同（其中第一个元素是 `runnerScaleSetName`，而不是 `self-hosted`）。请参见 [问题 3](#issue-3-workflow-stays-queued-runner-never-arrives) 以获取诊断路径。

### 工作流侧：带有 `scaleSetLabels` 的 `runs-on:` 数组形式

当您希望一个 scale-set 处理多种类型的作业（例如，同一运行器池同时服务于一般作业和仅 GPU 作业）而不将其拆分为单独的 scale-set 时，可以使用 **数组形式** 的 `runs-on:` 以及图表的 `scaleSetLabels` 字段。本节提供完整的注入和匹配规则，并明确一个 **容易错过的约束**：在图表 0.14.1 中，`scaleSetLabels` **仅在创建 scale-set 时生效**；安装后更改不会传播到 GitHub。

> **⚠️ 关键约束——`scaleSetLabels` 仅限安装时**
>
> 这是图表 0.14.1 中上游 ARC 的设计：标签在首次创建 scale-set 时与 GitHub 注册。稍后在本地图表值中更改 `scaleSetLabels` **不会**将新标签推送到 GitHub。
>
> 后果：安装后更改 `scaleSetLabels`（无论是通过 ECV、moduleinfo 还是 `helm upgrade`）会更新本地 ARS 规范，但 GitHub 为此 scale-set 广告的标签集保持不变——数组形式的 `runs-on:` 与 GitHub 的过时集匹配并保持 `Queued` 状态。下面的“如果我想在安装后更改标签”部分涵盖了绕过此约束的两条路径。

**端到端路径（首次安装时）：**

1. 图表值顶级字段 `scaleSetLabels: [...]`（默认 `[]`）。
2. 图表模板将数组逐字写入 `AutoscalingRunnerSet.spec.runnerScaleSetLabels`。
3. **第一次** 调和：控制器在 GitHub 端注册 `runnerScaleSetName` 以及 `runnerScaleSetLabels`。
4. 工作流使用 `runs-on: [<scale-set-name>, A, B]`：第一个元素必须等于 `runnerScaleSetName`（在 Scale-Set 插件表单中的 **Runner Scale-Set Name** 字段）；每个后续元素必须出现在 GitHub 广告的集合中（子集-广告，并且语义）。

**注入——在安装之前将其写入 ECV（ACP 表单未显示此字段）：**

可靠的方法是在单击 Scale-Set 插件上的安装之前将标签放入 ECV，以便第一次调和将它们注册到 GitHub：

1. 在 Marketplace → Cluster Plugins 中找到 ARC Scale-Set 插件，但**不要立即单击安装**。

2. 在表单的 **Extra Chart Values** 字段（即 ECV）中输入：

   ```yaml
   scaleSetLabels:
     - linux
     - gpu
   ```

3. 提交安装。

4. 在 ARS 调和完成后，验证：

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
       -o jsonpath='{.spec.runnerScaleSetLabels}'
   # 期望：您写入 ECV 的每个标签
   ```

如果 scale-set **已经安装**，而您现在只想添加标签，请参见下面的“如果我想在安装后更改标签？”部分。

**工作流 YAML：**

```yaml
# 数组形式——第一个元素必须等于 runnerScaleSetName，
# 每个剩余元素必须在 scale-set 注册时已向 GitHub 广告。
jobs:
  build:
    runs-on: [my-runners, linux, gpu]
```

**如果我想在安装后更改标签：**

由于上游约束，**唯一可靠的方法**是让 GitHub 忘记此 scale-set，并让控制器重新注册它：

- **选项 A（推荐，干净）：** 卸载 Scale-Set 插件（请参见 [第 7 章](#chapter-7-uninstall)），编辑 ECV `scaleSetLabels:`，然后重新安装。在此期间，正在进行的工作流会失败，因此请在维护窗口中执行此操作。
- **选项 B（仅在您具有 GitHub 侧权限时）：** 使用 PAT 直接删除 scale-set 的 GitHub 注册；控制器的下一个调和将将其视为缺失并使用当前 ARS 规范标签重新注册。**上游代码路径并非完全幂等**——监听器可能会短暂 CrashLoop，直到控制器重新创建注册。

**图表侧验证上限：**

- 每个标签必须是 **非空** 且 **少于 256 个字符**；违反将导致图表渲染失败，并在 moduleinfo 状态中显示为错误。

**关于工作流数组形式的常见误解：**

- 数组形式是 **AND**：每个元素必须在广告集中；如果任何元素缺失，GitHub 将永远找不到匹配项，工作流将保持 `Queued` 状态，监听器不会主动报告错误。
- **不要** 将第一个元素设置为 `self-hosted`：那是传统 ARC（`RunnerDeployment`）语法；scale-set 模式不识别它。
- “我更改了 ECV，标签显示在 ARS 规范中，为什么我的工作流仍然停留在 Queued？”——请参见上面的 ⚠️ 关键约束；几乎可以肯定是因为安装后更改的标签未能到达 GitHub。

**故障排除：工作流停留在 Queued？**

1. 检查 ARS 实际携带的标签：

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
       -o jsonpath='{.spec.runnerScaleSetLabels}'
   ```

2. 与工作流的 `runs-on:` 数组中的每个条目进行比较——第一个元素必须等于 `runnerScaleSetName`；每个其他元素必须出现在步骤 1 的输出中。

3. **如果步骤 1 已经显示您的标签，而工作流仍然是 Queued**，这几乎可以肯定是安装时的唯一约束（您首先安装了 scale-set，然后添加了标签）。请返回“如果我想在安装后更改标签”并遵循选项 A 或 B。

4. 监听器日志显示 GitHub 是否正在调度作业：

   ```shell
   $ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=50
   # 在成功匹配时：“获取作业...”
   # 如果没有任何内容：GitHub 端没有匹配——请返回步骤 3。
   ```

---

## 第 1 章 安装控制器插件

### 第 1 步：先决条件

在安装之前，请确认以下内容：

- 目标集群上已创建 `arc-systems` 命名空间（安装程序不会为您创建它）：
  ```shell
  $ kubectl create namespace arc-systems --dry-run=client -o yaml | kubectl apply -f -
  ```
- 您具有集群管理员权限，可以安装集群插件。

### 第 2 步：通过市场安装

在 ACP UI 中，转到 **管理员 → 市场 → 集群插件**，找到 **Alauda 对 GitHub Actions Runner Controller 的支持**，点击插件并选择目标集群，然后安装。

表单字段：

| 字段                                       | 默认       | 安装后可编辑 | 备注                                                                                                                                                                                        |
| ------------------------------------------- | ----------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装命名空间                               | `arc-systems` | 否           | 必须在集群上存在；否则安装将失败，显示 `namespaces "<name>" not found`。如果您更改此名称，scale-set 插件的控制器命名空间必须匹配。 |
| 日志级别                                   | `info`      | 是           | 设置为 `debug` 以进行故障排除。                                                                                                                                                          |
| 日志格式                                   | `json`      | 是           | JSON 与平台日志聚合对齐；在故障排除时切换为 `text` 以提高可读性。                                                                                                                    |
| 启用指标                                   | `false`     | 是           | 设置为 `true` 以在控制器和监听器 Pod 上公开 8080 端口以供 Prometheus 使用。                                                                                                            |
| 运行器最大并发调和（高级）                  | `2`         | 是           | 当 EphemeralRunner 数量超过 50 时增加。                                                                                                                                                    |
| 更新策略（高级）                           | `immediate`  | 是           | `immediate` 在升级时重建运行器；`eventual` 等待当前作业完成。                                                                                                                         |
| 额外图表值（YAML）（高级）                  | 空          | 是           | 请参见 [第 3 章](#chapter-3-customizing-runners-via-extra-values)。                                                                                                                        |
| 额外全局值（YAML）（高级）                  | 空          | 是           | 请参见 [食谱 9 — 控制器插件部分（A）](#a--controller-plugin)。                                                                                                                       |

### 第 3 步：验证控制器是否正在运行

当控制器插件达到 `Installed` 时，集群应具有：

- `arc-systems` 命名空间。
- `Deployment/arc-gha-rs-controller`。
- `ServiceAccount/arc-gha-rs-controller`。
- 一组 ARC CRDs：`AutoscalingRunnerSet`、`AutoscalingListener`、`EphemeralRunnerSet`、`EphemeralRunner`。

> **注意：** 下面的命令使用默认控制器命名空间 `arc-systems`。如果您将控制器安装到自定义命名空间，请在运行它们之前将 `arc-systems` 替换为实际值。

验证：

```shell
$ kubectl -n arc-systems get pod
# 期望：arc-gha-rs-controller-...   1/1   运行中

$ kubectl get crd | grep actions.github.com
# 期望：列出 4 个 CRD
```

> **注意：** 单独安装控制器不会启动任何运行器。下一章安装 scale-set 插件，实际上会创建一个运行器池。

---

## 第 2 章 安装 Scale-Set 插件

> **注意——在开始之前规划安装命名空间。** 表单的 **安装命名空间** 字段（默认 `arc-runners`）在插件安装后被锁定；稍后更改需要卸载并重新安装。默认的 `arc-runners` 对于大多数集群来说是合适的；如果您按团队或业务线拆分运行器，请提前选择一个稳定的名称（例如 `team-a-runners`、`team-b-runners`），并在本章的其余部分使用它。
>
> **GitHub 凭证 Secret 必须位于与 Scale-Set 插件相同的命名空间**——即下面的 `kubectl create namespace ...` 和 `kubectl -n <ns> create secret ...` 命令必须使用相同的 `<ns>`。如果您决定安装到 `team-a-runners`，请在两个命令中将 `arc-runners` 替换为 `team-a-runners`。

### 第 1 步：先决条件

- 控制器插件已安装并处于 `运行中` 状态（[第 1 章](#chapter-1-installing-the-controller-plugin)）。
- 目标集群上存在 `arc-runners` 命名空间：
  ```shell
  $ kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f -
  ```
- 在 `arc-runners` 中创建了 GitHub 凭证 Secret。请参见 [GitHub 凭证设置](#github-credential-setup)。

### 第 2 步：通过市场安装

返回 **集群插件**，找到 **Alauda 对 GitHub Actions Runner Scale Set 的支持**，点击插件，选择与控制器相同的 **集群**，然后安装。

表单字段：

| 字段                                     | 默认                              | 必需 | 安装后可编辑 | 备注                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------- | ---- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装命名空间                             | `arc-runners`                      | 是   | 否           | 运行运行器 Pod 的地方。必须存在；否则安装失败。                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GitHub URL                                | （无）                             | 是   | 否           | 请参见 [GitHub URL 格式](#github-url-formats) 下文。**此字段在安装后为只读，不支持就地更新。** 如果您需要切换目标存储库 / 组织 / 企业，请重新创建 scale-set（或卸载并重新安装），并手动验证 / 删除旧的 GitHub 侧 scale-set 注册，位于 **设置 → 操作 → 运行器**。                                                                                                       |
| GitHub 凭证 Secret 名称                  | `gha-runner-scale-set-github-config` | 是   | 否           | 必须与在 [GitHub 凭证设置](#github-credential-setup) 中创建的 Secret 名称匹配；**安装后为只读**。                                                                                                                                                                                                                                                                                                                                                       |
| 控制器命名空间                           | `arc-systems`                      | 是   | 否           | **必须与控制器插件的安装命名空间匹配**，否则 scale-set 将其控制器面向的引用 / RBAC 指向错误的主题，导致监听器 / 运行器调和失败。监听器 Pod 实际上在此命名空间中运行，而不是在 `arc-runners` 中；使用 `kubectl -n arc-systems get pod` 验证。                                                                                                                                                        |
| 控制器 ServiceAccount 名称（高级）      | `arc-gha-rs-controller`            | 是   | 否           | 由控制器插件创建的 SA；通过插件安装时请勿更改。                                                                                                                                                                                                                                                                                                                                                                                         |
| 运行器 Scale-Set 名称                    | 空                                  | 否   | 否           | **GitHub 用于识别此运行器池的名称；工作流的 `runs-on:` 字段必须与此值匹配。** 当为空时，图表会回退到 Helm 发布名称（默认 `arc-runner-set`）。如果发布名称稍后更改，GitHub 会注册一个新的 scale-set，旧的仍占用注册槽——必须手动从 GitHub UI **设置 → 操作 → 运行器** 中删除。建议设置与您的业务场景一致的显式名称。 |
| 最小运行器                               | `0`                                | 否   | 是           | 常驻运行器 Pod 的最小数量。`0` 表示纯按需。                                                                                                                                                                                                                                                                                                                                                                                                             |
| 最大运行器                               | `5`                                | 否   | 是           | 并发运行器 Pod 的最大数量。                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 容器模式（高级）                         | `kubernetes-novolume`              | 否   | 是           | 请参见 [容器模式选择](#container-mode-selection) 下文。**留空** 以完全通过额外图表值接管 `containerMode:`。                                                                                                                                                                                                                                                                                                                                 |
| 额外图表值（YAML）（高级）                | 空                                  | 否   | 是           | 请参见 [第 3 章](#chapter-3-customizing-runners-via-extra-values)。                                                                                                                                                                                                                                                                                                                                                                                                             |
| 额外全局值（YAML）（高级）                | 空                                  | 否   | 是           | 请参见 [食谱 9 — scale-set 插件部分（B）](#b--scale-set-plugin)。                                                                                                                                                                                                                                                                                                                                                                                                          |

#### GitHub URL 格式

| 范围        | URL 格式                                    | 用例                             |
| ------------ | ------------------------------------------- | -------------------------------- |
| 单个存储库  | `https://github.com/<org>/<repo>`           | 项目级自托管运行器               |
| 组织        | `https://github.com/<org>`                  | 在组织中所有存储库共享           |
| 企业        | `https://github.com/enterprises/<enterprise>` | GHEC 企业                        |

对于自托管的 GitHub Enterprise Server (GHES)，将 `https://github.com` 替换为您的 GHES URL。

#### 容器模式选择

在表单上选择以下三种选项之一：

| 表单选项                     | 用例                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubernetes-novolume`（默认） | 大多数工作流不需要在运行器内部使用 Docker，并且不需要持久工作目录。除非您有特定需求，否则将其作为默认值使用。 |
| `dind`                        | 当工作流运行 `docker build` / `docker push` 时。                                                                                                         |
| **（空）**                    | 高级——通过额外图表值完全接管 `containerMode:`（例如，具有 PVC 的 kubernetes 模式，或自定义 containerMode 字段）。                           |

> **警告——请勿直接选择 `kubernetes`。** 尽管表单中有 `kubernetes` 选项，但选择它会生成没有所需 `kubernetesModeWorkVolumeClaim` 字段的 ARS，CRD 会拒绝它。如果您需要 kubernetes 模式（持久工作目录、容器作业、`actions/cache@v4` 和其他依赖 PVC 的功能），**请保持表单为空**，并在额外图表值下编写完整的 `containerMode:` 块——请参见 [食谱 7](#recipe-7-kubernetes-mode-with-persistent-work-volume)。

#### 最小 / 最大运行器大小

- `minRunners=0` — 纯按需；空闲时没有 Pod。第一次工作流触发有大约 10 秒的延迟（Pod 启动 + GitHub 注册）。
- `minRunners=1` — 保持一个空闲运行器；第一次触发延迟小于 1 秒，但占用资源。
- `maxRunners` — 上限。根据集群资源和并发工作流数量进行调整（建议与 [食谱 4](#recipe-4-limit-cpu--memory-of-runners) 配对，为运行器添加 `resources`）。

### 第 3 步：验证监听器和 AutoscalingRunnerSet

等待插件实例达到 `Installed`，然后检查以下资源：

> **注意：** 下面的命令假设控制器位于 `arc-systems`，scale set 位于 `arc-runners`。如果您自定义了任一命名空间，请一致地替换它们。

```shell
# 控制器在 arc-systems 中
$ kubectl -n arc-systems get pod
# 期望：arc-gha-rs-controller-...     1/1     运行中

# 监听器 Pod 也在 arc-systems 中（而不是在 arc-runners 中）
$ kubectl -n arc-systems get pod -l app.kubernetes.io/component=runner-scale-set-listener
# 期望：<scaleset>-...-listener     1/1     运行中
```

> **注意：** 监听器 Pod 在 **控制器命名空间**（默认 `arc-systems`）中运行，而不是在 scale-set 自己的 `arc-runners` 中。这是 ARC 设计的结果——监听器由控制器分叉并重用控制器的 SA/RBAC。使用 `minRunners=0` 时，`arc-runners` 此时没有 Pod，这是正常的。

验证 AutoscalingRunnerSet 状态：

```shell
$ kubectl -n arc-runners get autoscalingrunnerset
# 列：最大运行器 / 当前运行器 / 状态
```

在 GitHub 侧验证运行器是否已注册：打开您的 GitHub 存储库（或组织 / 企业）**设置 → 操作 → 运行器**。名为您的 `runnerScaleSetName` 的运行器应出现，状态为 `Online`（已连接且空闲——在上游文档中称为“空闲”状态）或 `Active`（当前正在执行作业）。

### 第 4 步：触发烟雾工作流

将以下最小工作流放置在您的 GitHub 存储库中的 `.github/workflows/smoke.yaml`：

```yaml
name: ARC Smoke
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: my-runners      # 本文档中当前安全验证的形式：runnerScaleSetName 作为单个字符串
    steps:
      - name: runner identity
        # 优先使用 GitHub 提供的上下文和 shell 内置，而不是
        # 特定于镜像的操作系统实用程序；这避免了依赖于给定基础镜像是否
        # 恰好捆绑了 `hostname`。直接使用 ${HOSTNAME}。
        run: |
          echo "runner_name: ${RUNNER_NAME:-unknown}"
          echo "hostname:    ${HOSTNAME:-unknown}"
          echo "workspace:   ${GITHUB_WORKSPACE:-unknown}"
          echo "job:         ${GITHUB_JOB:-unknown}"
          echo "whoami:      $(whoami)"
          id
          echo "pwd:         $(pwd)"
```

提交，然后通过推送或 `workflow_dispatch` 触发。观察运行器 Pod 出现、运行并消失：

```shell
$ kubectl -n arc-runners get pod -w
# 期望：一个 EphemeralRunner Pod 状态从 Pending → Running → completed → deleted
```

如果工作流保持 `Queued`，请参见 [问题 3](#issue-3-workflow-stays-queued-runner-never-arrives)。

---

## 第 3 章 通过额外值自定义运行器

平台 UI 将最常用的图表字段作为表单输入，但图表还有许多其他可配置字段（尤其是嵌套的 Pod / 容器规格字段）。其余部分通过两个 **逃生口** 达到：

- **额外图表值（ECV）** — 表单上的顶级文本区域。内容附加到表单呈现的值文档末尾，添加新的顶级键。**它不能覆盖** 表单已经呈现的键；同键冲突会导致安装失败，插件实例永远不会达到 `Installed`。
- **额外全局值（EGV）** — 也是一个文本区域，但其内容嵌入在 `global:` 块下作为 `global.*` 子键。

> **警告——额外全局值的缩进约定。** EGV 中的每一行 YAML **必须以 2 个空格开头**——此字段没有缩进模板助手，您的内容逐字插入到 2 空格缩进的上下文中。以列 0 开头的行变成新的顶级键并破坏 YAML；安装失败。粘贴来自本文档的 EGV 片段时，请逐行验证前导 2 个空格，然后再保存。

> **警告——Helm 数组字段必须完整提供。** 像 `tolerations`、`containers`、`volumes`、`volumeMounts`、`env` 和 `topologySpreadConstraints` 这样的字段是数组。Helm 通过 **整体替换** 而不是逐元素合并数组。如果您仅提供自定义元素，则图表的默认元素将 **全部丢失**。
>
> 每个食谱中的 YAML 已经是数组字段的完整形式——按原样复制。要在我们提供的基础上添加新元素，请将您的新元素附加到现有列表中，而不是编写仅包含新元素的单独片段。
>
> 受影响的食谱及其涉及的数组字段：
>
> - [食谱 2](#recipe-2-inject-secrets--custom-env-into-runner) — `containers` / `containers.env`
> - [食谱 3](#recipe-3-pin-runners-to-dedicated-nodes) — `tolerations`
> - [食谱 4](#recipe-4-limit-cpu--memory-of-runners) — `containers` / `containers.resources`
> - [食谱 5](#recipe-5-spread-runners-across-nodes) — `topologySpreadConstraints`
> - [食谱 6](#recipe-6-mount-maven-cache--extra-configmap--ca-bundle) — `volumes` / `volumeMounts`

> **警告——在覆盖 `template.spec.containers[0]` 时，请保持下面的安全骨架。** 因为 Helm 替换整个 `containers` 数组，您未写入的任何字段都会被丢弃。图表的运行器容器助手在缺失时会自动提供大多数 `ACTIONS_RUNNER_*` 环境条目，但它**不**提供 `image:` 或 `command:`，并
> `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` 的默认值为 `"true"`，但 Alauda 默认的 `kubernetes-novolume` 模式需要 `"false"` — 您必须自己将该行写回。编写涉及 `containers[0]` 的 ECV 时，请始终从此骨架开始：
>
> ```yaml
> template:
>   spec:
>     containers:
>       - name: runner
>         image: <runner-extension-image>          # 必需 — 参见食谱 9，或读取实时值：
>                                                  #   kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
>                                                  #     -o jsonpath='{.spec.template.spec.containers[0].image}'
>         command: ["/home/runner/run.sh"]         # 必需 — chart 不会自动提供；缺少它会导致 runner 进程未启动
>         env:
>           - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
>             value: "false"                       # 对于 kubernetes-novolume / dind 模式是必需的；没有它，每个未声明 `container:` 的作业都会被拒绝
>         # 在此行下添加您的自定义字段（资源 / volumeMounts / 额外的环境变量条目 / ...）
> ```
>
> 忘记 `image:` 的症状：runner pod 失败，显示 `spec.containers[0].image: Required value`，并且永远不会调度。
> 忘记 `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER=false` 的症状：
> 工作流日志显示 `Jobs without a job container are forbidden on this runner`。
>
> 编辑 ECV 后的自检：
>
> ```shell
> $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
>     -o yaml | yq '.spec.template.spec.containers[0]'
> # 确认您期望的 `image`、`command` 和 `env` 条目都存在
> ```

### 第一步：理解 ECV 与 EGV

ECV 适用于 chart 的顶级键；EGV 适用于 `global:`。作为经验法则：

- 对于 runner pod 模板字段，请使用 **ECV**：`template.spec.*` 用于 serviceAccount / nodeSelector / tolerations / containers / volumes；还包括 `containerMode:`（条件 — 仅在表单的 Container Mode 字段为空时在 ECV 中写入此内容；有关详细信息，请参见下面的禁止键列表），`listenerTemplate.spec.*` 和 `scaleSetLabels:`（一个数组；每个元素必须非空且短于 256 个字符；此字段为 **安装时仅** — 参见 [Workflow side: runs-on array form with scaleSetLabels](#workflow-side-runs-on-array-form-with-scalesetlabels)）等。
- 对于镜像覆盖，请使用 **EGV**：`images.*`（controller / runnerExtension / dind）。

一个常见的错误是写入一个已经由表单渲染的顶级键。禁止的顶级键列在下面。

**请勿在 ECV 中写入以下顶级键：**

- Controller 插件：`flags`、`metrics`、`namespaceOverride`、`replicaCount`、`global`。
- Scale-set 插件：`namespaceOverride`、`global`、`githubConfigUrl`、`githubConfigSecret`、`runnerScaleSetName`、`minRunners`、`maxRunners`、`controllerServiceAccount`。
  - `containerMode` 是 **条件**：当表单的 Container Mode 字段非空时禁止（插件已经渲染了它）；当表单 Container Mode **留空** 时，您必须在 ECV 中写入完整的 `containerMode:` 块 — 参见 [Recipe 7](#recipe-7-kubernetes-mode-with-persistent-work-volume)。

如果您需要覆盖 `global.*` 下的任何内容（例如 `global.images.*`），请改用 EGV — 参见 [Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry)。

> **完整的 chart-values 参考（按插件，保留上游注释）已移至 [附录：完整 chart 值参考](#appendix-full-chart-values-reference) 本文档末尾。** 主要教程直接继续到 [第二步：验证配置更改是否生效](#step-2-verifying-a-config-change-took-effect) 和下面的食谱。

### 第二步：验证配置更改是否生效

在每次更改 ECV / EGV 后，使用以下三个步骤确认更改确实到达 runner pods：

1. **确认插件实例已达到 `Installed`。** 保存表单后，等待 ~30 秒。平台提供两个入口点来检查状态：

   - **Marketplace → Cluster Plugins** — 插件行应显示 `Installed`（绿色勾）。
   - **Clusters → \<your cluster> → Functional Components** — 确保面包屑选择了目标集群，然后切换到 **Functional Components** 选项卡。`Alauda Support for GitHub Actions Runner Scale Set` 行应显示 `Running`（绿色箭头）及右侧的版本。

   如果状态保持卡住或显示安装失败，请单击插件详细信息并检查事件 / 状态块（最常见的原因：顶级键的 ECV 冲突，或 EGV 缩进错误）。

2. **检查渲染的 AutoscalingRunnerSet 模板。** 当插件进行协调时，它会更新安装命名空间中的 `AutoscalingRunnerSet`。您可以直接读取合并的 spec：

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset -o yaml \
       | grep -A 3 <new-field-name>
   ```

   在合并的 spec 中看到您的字段确认 ECV / EGV 成功合并到 chart 值中。

3. **触发测试工作流并确认新的 runner pod 实际上携带配置。** 任何带有单个 `echo` 步骤的 `workflow_dispatch` 都可以。在工作流运行时：

   ```shell
   $ kubectl -n arc-runners get pods -w
   # 等待短暂的 runner pod 出现，注意 pod 名称
   $ kubectl -n arc-runners get pod <pod-name> -o yaml \
       | grep -A 3 <new-field-name>
   ```

   在 pod spec 中看到新字段确认了端到端传播。

### 第三步：更新 / 升级 / 查看 — 三个不同的入口点

平台 UI 提供三个不同的入口点用于“维护插件”，每个处理不同的关注点：

| 目标                                                               | 入口点                                                                            | 结果                                                                                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **修改 ECV / EGV / 其他可编辑字段**                               | **Marketplace → Cluster Plugins** → ⋮ 在插件行上 → **Update**                   | 仅更新可编辑字段；**不升级 chart 版本**。                                                                                                 |
| **查看完整配置面板（包括版本元数据）**                           | **Marketplace → Cluster Plugins** → 单击插件 **名称** 进入详细页面             | 详细页面列出安装命名空间、日志级别、日志格式、启用指标和高级块（包括 ECV / EGV）以及已安装版本。 |
| **升级插件版本（chart / images）**                               | **Clusters → \<cluster> → Functional Components** → 顶部 **Upgrade** 按钮       | 从 chart 仓库拉取较新版本并执行实际升级。                                                                                |

两个会让用户困惑的细节：

- **更新表单显示安装时字段为只读。** 像 `Install Namespace` 这样的字段在安装时决定，无法在线更改，但更新表单将其列为只读标签，以便您可以在不离开页面的情况下确认当前值。插件详细信息页面（上面第三行）显示相同的信息以及版本元数据，当您需要单个完整面板视图时非常有用。
- **更新无法升级版本。** 更新重用当前安装的 chart 版本；它仅进行协调。要拉取新版本，请使用功能组件下的 **Upgrade** 按钮。

本章的其余部分根据常见需求对食谱进行分组。每个食谱已在 ACP 集群中验证，包含三个部分：**何时使用 → YAML → 预期效果**。根据需要复制并粘贴到适当的字段中。

### 食谱 1：为集群内作业创建自定义 ServiceAccount

**何时使用：** 工作流运行 `kubectl apply -f manifest.yaml` 或调用集群 API。默认的 SA 仅携带 runner 容器钩子所需的基础权限；它与工作流实际需要的业务 RBAC 不同。

首先在安装命名空间中创建一个 SA，并绑定权限（`my-runner-sa` 是示例名称；根据您的约定重命名）：

```shell
$ kubectl create serviceaccount my-runner-sa -n arc-runners

# 推荐：在命名空间范围的角色中准确列出工作流所需的动词，然后将其绑定到 SA。下面的示例允许工作流列出/获取 pods，读取 pod 日志，并 `kubectl exec` 进入 arc-runners 命名空间内的 pods。
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

如果工作流需要管理部署、CRD 或跨命名空间资源，请使用这些特定动词扩展角色的 `rules:`（或切换到 ClusterRole + ClusterRoleBinding 以进行跨命名空间使用，仍然列出具体资源）。**请勿直接绑定 `ClusterRole/edit`** — `edit` 包括对 Secrets 的读/写、变更 ConfigMaps、删除 Deployments 和其他高影响动词，这实际上将整个命名空间的写入表面交给任何可以修改 GitHub 存储库中的工作流 YAML 的人。

然后通过额外的 Chart 值将 runner pod 指向此 SA：

```yaml
template:
  spec:
    serviceAccountName: my-runner-sa
```

**预期效果：** runner pod 使用 `my-runner-sa` 而不是 chart 默认的 `<release>-gha-rs-kube-mode`。工作流中的 `kubectl` 调用将根据 `my-runner-sa` 的 RBAC 进行授权。

> **警告 — 在 kubernetes / kubernetes-novolume 模式下要小心。** 在这些模式下，默认的 `<release>-gha-rs-kube-mode` SA 不是空白的；它携带 `pods`、`pods/exec`、`pods/log`、`secrets` 的 runner-container-hooks 基础权限，并且在 `kubernetes` 模式下还包括 `jobs`。如果您用自己的 SA 替换它，您必须重新添加工作流仍然需要的权限；否则，基于容器钩子的流（例如 `container:` 作业、日志访问或 k8s 模式作业/秘密操作）将失败。
>
> 还要注意，拥有此默认 SA 基线并不意味着它已经携带工作流所需的业务权限。它是否可以读取 Tekton Pipelines、创建 PipelineRuns 或访问其他命名空间中的资源仍然取决于环境中绑定的额外 RBAC。最安全的方法仍然是为工作流场景准备一个明确的自定义 SA，并通过 `kubectl auth can-i` 验证它。
>
> **已知问题（当前基线）：** 在 `kubernetes` / `kubernetes-novolume` 模式下，如果您 **暂时** 将 `template.spec.serviceAccountName` 切换到自定义 SA，然后稍后清除此字段或切换回默认路径，平台 / 上游清理流程可能会将生成的默认 `<scaleset>-gha-rs-kube-mode` `ServiceAccount` / `Role` / `RoleBinding` 卡在 `Terminating` 状态（`metadata.deletionTimestamp` 保持设置，最终处理程序仍为 `actions.github.com/cleanup-protection`）。当发生这种情况时，后续依赖于默认 SA 的工作流可能会在 `container:` 作业初始化期间失败，显示 `HTTP-Code: 401 Unauthorized`，或者从 runner 容器内部运行 `kubectl auth can-i` 可能会直接返回 `error`。如果此 runner 池需要长期的集群内访问，最好保持一个明确的自定义 SA，而不是在默认 SA 和自定义 SA 之间来回切换。如果您确实切换回默认 SA，请查看本章后面已知问题的说明，并验证默认 kube-mode 资源是否已干净地重新创建。

#### 权限模型说明

**范围。** 通过 `template.spec.serviceAccountName` 配置的 SA 是在 **runner pod 级别**，这意味着 **同一 scale-set 实例下的所有工作流共享相同的 SA 及其 RBAC**。SA 可以访问的实际资源由您授予的 Role / ClusterRole 绑定决定 — 上面的示例（`--role=my-runner-sa-role` + `rolebinding -n arc-runners`）是命名空间范围的。

对于生产环境，请遵循最小权限原则：

- **优先选择 Role + RoleBinding**（命名空间范围，限制在 runner 安装命名空间内）而不是 ClusterRole / ClusterRoleBinding（集群范围）。
- 定义一个自定义 Role，准确列出工作流所需的资源 / 动词；不要直接绑定广泛的 ClusterRoles，如 `cluster-admin` 或 `edit`。

**不同工作流可以使用不同的 SA 吗？** 在当前架构下，runner pod 的 SA 是由插件级配置固定的 — **同一 scale-set 实例下的所有工作流共享相同的 SA**。如果您需要每个工作流的权限分离，常见的方法：

- 在工作流内部，使用 `kubectl --token=...` 或显式挂载 kubeconfig，指向另一个 SA 的令牌，绕过 pod 默认。
- 将权限敏感的步骤移动到触发 Tekton PipelineRun
  （[示例 2](#example-2-trigger-an-in-cluster-tekton-pipeline-from-a-workflow)）；在 PipelineRun 内，单个任务使用自己的 SA。
- 在 GitHub 端，使用
  [environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
  / 分支保护来限制哪些工作流可以使用此 runner 池。

### 食谱 2：将秘密 / 自定义环境注入 runner

**何时使用：** 工作流需要访问私有 npm 注册表、私有 Maven 仓库、后端 API 或任何其他需要秘密的资源。

首先在安装命名空间中创建 Secret（例如 `npm-credentials`），然后写入额外的 Chart 值：

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>           # 必需 — 参见第 3 章数组警告
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                          # 对于 kubernetes-novolume / dind 模式是必需的
      - name: NPM_TOKEN
        valueFrom:
          secretKeyRef:
            name: npm-credentials
            key: token
            optional: true                      # true: 如果 Secret 在轮换期间短暂缺失，pod 启动不会被阻止
      - name: BUILD_PROFILE
        value: production
```

**预期效果：** 每个 runner pod 的 runner 容器读取 `$NPM_TOKEN` 和 `$BUILD_PROFILE`。由于 helm 替换整个 `containers` 数组（参见 [第 3 章数组警告](#chapter-3-customizing-runners-via-extra-values)），chart 默认的 `ACTIONS_RUNNER_*` 环境条目被删除 — chart 的 runner-container 辅助工具在缺失时会自动提供 `ACTIONS_RUNNER_POD_NAME` 和 `ACTIONS_RUNNER_CONTAINER_HOOKS`，但 `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` 默认值为 `"true"`，必须如上所示覆盖。

### 食谱 3：将 runners 固定到专用节点

**何时使用：** 集群中有专用节点用于 CI runners（例如标记为 `workload=arc-runner` 并带有污点 `arc-dedicated:NoSchedule`）；其他工作负载不应落在这些节点上。

**额外的 Chart 值**（在 scale-set 插件表单上）：

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

**预期效果：** runner pods 仅在标记为 `workload=arc-runner` 的节点上调度，并容忍 `arc-dedicated:NoSchedule` 污点。如果不存在这样的节点，runner pod 将保持 Pending 状态，并出现 `FailedScheduling` 事件 — 有助于“反向验证规则确实应用”。

### 食谱 4：限制 runners 的 CPU / 内存

**何时使用：** 防止单个 runner pod 消耗所有节点资源，或与 ResourceQuota 集成。

**额外的 Chart 值：**

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>      # 必需 — 参见第 3 章数组警告
      command: ["/home/runner/run.sh"]     # 必需 — chart 不会自动提供
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                     # 对于 kubernetes-novolume / dind 模式是必需的
      resources:
        requests:
          cpu: 500m
          memory: 1Gi
        limits:
          cpu: "4"
          memory: 8Gi
```

**预期效果：** 每个 EphemeralRunner pod 的 runner 容器携带指定的资源。

> **警告 — 两个细节：**
>
> - `command: ["/home/runner/run.sh"]` 必须保留。Helm 整体替换数组（参见本章开头的数组警告）；省略此行会让 pod 启动，但 runner 容器会回退到镜像默认的入口点，而不是 `run.sh`，这意味着 runner 进程永远不会启动，工作流将保持排队状态。
> - **引用整数 CPU 值：** `cpu: "4"`，而不是 `cpu: 4`。裸数字形式被 Kubernetes 接受，但某些客户端在重新序列化时会拒绝它。始终使用双引号。

### 食谱 5：在节点之间分散 runners

**何时使用：** 防止所有 20 个 runners 堆积在一个节点上，当 `maxRunners=20`；或在多 AZ 集群中进行 HA 部署。

**额外的 Chart 值：**

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

**预期效果：** 调度程序更倾向于在不同主机名之间分散 runner pods；在必要时回退到在同一节点上调度（软反亲和性）。

> **注意：** 对于硬分散（在节点不足时拒绝调度），将 `preferredDuringSchedulingIgnoredDuringExecution` 更改为 `requiredDuringSchedulingIgnoredDuringExecution`，并将 `whenUnsatisfiable` 更改为 `DoNotSchedule`。

### 食谱 6：挂载 maven 缓存 / 额外的 ConfigMap / CA 包

**何时使用：** 通过共享的 `.m2` PVC 加快 Maven 构建速度；注入额外的集群 CA 证书；共享其他 ConfigMap / Secret 文件。

首先在安装命名空间中创建 PVC / ConfigMap，然后写入额外的 Chart 值：

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>      # 必需 — 参见第 3 章数组警告
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                     # 对于 kubernetes-novolume / dind 模式是必需的
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
        claimName: maven-cache-pvc         # 首先在 arc-runners 中创建此 PVC
    - name: ca-bundle
      configMap:
        name: extra-ca-bundle              # 首先在 arc-runners 中创建此 ConfigMap
```

**预期效果：** runner pods 在指定路径挂载 Maven 缓存和 CA 文件。您的卷与 chart 管理的默认值共存（例如在 DinD 模式下的 `dind-sock` 卷或在 kubernetes 模式下的 `work` PVC）。

> **注意：** 如果 PVC 的 StorageClass 使用 `volumeBindingMode: WaitForFirstConsumer`（通常由本地磁盘支持的 SC 实现使用，例如某些 TopoLVM 部署），则 PVC 将保持 `Pending` 状态，直到第一个 runner pod 使用它。这是预期行为，而不是配置错误 — `kubectl describe pvc maven-cache-pvc` 将显示 `waiting for first consumer to be created before binding`。

### 食谱 7：使用持久工作卷的 Kubernetes 模式

**何时使用：** 工作流需要
[container-job](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontainer),
`actions/cache@v4`，或其他需要在 runner 内部 PVC 的功能。

**三个配置步骤：**

1. **将 Container Mode 表单字段留空**，以便插件不渲染 `containerMode:` 块。
2. 在额外的 Chart 值中写入完整的 `containerMode:` 块：
   ```yaml
   containerMode:
     type: kubernetes
     kubernetesModeWorkVolumeClaim:
       storageClassName: <existing-sc-name>      # 例如 sc-topolvm
       accessModes: [ReadWriteOnce]
       resources:
         requests:
           storage: 1Gi
   ```
3. 保存。

**预期效果：** 对于每个 EphemeralRunner pod，Kubernetes 创建一个通用的临时 PVC `<pod-name>-work`，挂载在 `/home/runner/_work`，在 pod 被删除时清理。Scale-Set 插件 chart 提供两个助手 — `kubernetes-mode-runner-container` 和 `kubernetes-novolume-mode-runner-container`（均在 `gha-runner-scale-set/templates/_helpers.tpl` 中） — 当 `containerMode.type` 为 `kubernetes` 或 `kubernetes-novolume` 时，将 `ACTIONS_RUNNER_CONTAINER_HOOKS` 注入到 runner 容器中，指向相应的钩子脚本（默认 `/home/runner/k8s/index.js` 或 `/home/runner/k8s-novolume/index.js`）。

#### 演示工作流：验证工作区 PVC 是可读写的

在设置 `kubernetesModeWorkVolumeClaim` 后，您无需在工作流 YAML 中显式引用此 StorageClass — ARC 会自动为每个 runner pod 创建一个临时 PVC，并挂载在 `/home/runner/_work`。以下工作流验证工作区落在 PVC 上，并且文件在步骤之间保持持久：

```yaml
name: K8s Mode Persistent Work Volume Demo

on:
  workflow_dispatch:

jobs:
  pvc-smoke:
    # Alauda 验证的路径：runs-on 使用单字符串形式
    runs-on: my-runners
    steps:
      - name: inspect workspace mount
        run: |
          set -eux
          POD_NAME="${ACTIONS_RUNNER_POD_NAME:-${HOSTNAME:-$(cat /proc/sys/kernel/hostname 2>/dev/null || echo unknown)}}"
          echo "runner_name=${RUNNER_NAME:-unset}"
          echo "pod_name=${POD_NAME}"
          echo "workspace=${GITHUB_WORKSPACE}"
          id
          pwd
          mkdir -p "${GITHUB_WORKSPACE}"
          ls -ld "${GITHUB_WORKSPACE}"
          ls -ld /home/runner/_work
          # df 证明工作区落在一个单独的挂载上（而不是容器根文件系统）；
          # 下面的写入 + 读取步骤证明挂载是可写且稳定的。
          df -h "${GITHUB_WORKSPACE}"
          df -h /home/runner/_work
          # mountinfo 给出源设备（最权威）；回退到 mount / proc/mounts
          grep " /home/runner/_work " /proc/self/mountinfo || \
            mount | grep -E "(/__w/|/home/runner/_work|${GITHUB_WORKSPACE})" || \
            cat /proc/mounts | grep -E "(/__w/|/home/runner/_work|${GITHUB_WORKSPACE})"

      - name: write payload into workspace PVC
        run: |
          set -eux
          DEMO_DIR="${GITHUB_WORKSPACE}/pvc-demo"
          mkdir -p "${DEMO_DIR}"
          # 时间戳文件：在步骤 3 中用于证明跨步骤持久性
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
          # 步骤 2 中写入的时间戳在这里可读，证明 PVC 上的跨步骤持久性
          cat "${DEMO_DIR}/timestamp.txt"
          du -sh "${DEMO_DIR}"
          df -h "${GITHUB_WORKSPACE}"
```

**成功时的预期：**

- `runner_name` / `pod_name` / `id` 输出可以与 `kubectl -n arc-runners get pods` / `kubectl describe pod` 匹配。
- `GITHUB_WORKSPACE` 落在 `/home/runner/_work/<repo>/<repo>`。
- `df -h ${GITHUB_WORKSPACE}` 和 `/proc/self/mountinfo` 就由您的 StorageClass 提供的块设备达成一致（例如 `/dev/topolvm/<volume-id>`，而不是节点本地的 overlay 根文件系统）。
- 16 MiB 文件 `pvc-demo/payload.bin` 成功写入。
- 第 3 步 `sha256sum -c` 通过；`cat timestamp.txt` 返回步骤 2 的 UTC 时间（证明跨步骤持久性）。
- `du -sh pvc-demo` 显示约 17M。

> **注意：** 此演示故意避免 `container:` 和 `actions/checkout` — 食谱 7 的重点是验证工作区位于持久 PVC 上，步骤越简单，越容易重现。如果您还想验证作业容器（`jobs.<id>.container`）是否可以正常工作，请参见 [示例 1](#example-1-run-a-job-in-a-custom-container)。

观察集群侧 PVC 的创建和清理：

```shell
# 在工作流运行时
$ kubectl -n arc-runners get pvc
# 预期：<runner-pod-name>-work   Bound   <storageClassName>   ...

# 工作流完成后，PVC 会自动释放
$ kubectl -n arc-runners get pvc
# 预期：未找到资源（或仅找到其他仍在运行的工作流的 PVC）
```

> **注意：** 如果 PVC 保持 `Pending`，最可能的原因是 `storageClassName` 错误或 SC 不支持动态供应。使用 `kubectl get sc` 列出 SC，并使用 `kubectl describe pvc <name>` 检查事件。

### 食谱 8：DinD 模式（在 runner 内部运行 docker build）

**何时使用：** 工作流需要 `docker build` / `docker push` / 任何 docker CLI 调用。

> **警告 — DinD 镜像未捆绑。** 安装包不包括 DinD 镜像（以避免将上游 Docker CVE 带入 Alauda 补丁包）。您必须首先将上游的 `docker:<docker-tag>-dind` 镜像同步到平台注册表，然后通过额外的全局值将 `global.images.dind.repository` / `tag` 指向它（参见 [食谱 9](#recipe-9-override-arc-images-custom-version--private-registry)）。

**两个配置步骤：**

1. **同步并覆盖 DinD 镜像。** 在 scale-set 插件的额外全局值中，写入：
   ```yaml
     images:
       dind:
         repository: <dind-path-inside-platform-registry>   # 例如 devops/actions/docker
         tag: <your-docker-dind-tag>                         # 例如 28.0.4-dind
   ```
2. **在表单上，将容器模式设置为 `dind`。**

**预期效果：** 每个 runner pod 获得一个初始化容器（`init-dind-externals`，在复制 docker CLI 到共享卷后退出）、一个侧车（`dind`，运行 docker 守护进程）和 runner 主容器。runner 容器具有 `DOCKER_HOST=unix:///var/run/docker.sock`，指向 DinD 侧车；工作流中的 `docker build` 调用直接工作。

> **注意：** 在 Kubernetes 1.29+ 上，上游 chart 使用原生侧车语义渲染 `dind`（因此它出现在 `initContainers` 下，`restartPolicy: Always`）；在较低版本中，它通常作为常规侧车容器出现。运行时意图是相同的，因此请根据您看到的实际 pod spec 进行故障排除。

> **注意 — 更安全的替代方案：** 如果您的集群禁止特权 pod，或者您不想授予 runner pod 完整的 Docker 守护进程能力，请参见 [示例 3](#example-3-advanced-buildah-daemonless-image-build-still-privileged)，该示例在常规作业容器内使用 Buildah 无根模式。

### 食谱 9：覆盖 ARC 镜像（自定义版本 / 私有注册表）

**何时使用：** 安装包默认包括与插件版本匹配的 **controller** 和 **runner-extension** 镜像，因此 ACP 集群 **默认支持气隙**（controller + scale-set 直接工作）。仅在以下情况下覆盖镜像：

- 使用 DinD 模式 — **DinD 镜像未捆绑，必须覆盖**（参见 [食谱 8](#recipe-8-dind-mode-run-docker-build-inside-runner)）。
- 使用比插件提供的更新的上游 ARC 版本（升级 controller / runner-extension）。
- 切换到不同的 DinD 镜像（例如 `docker:dind-alpine`）。
- 安全审计要求镜像来自团队的私有注册表子路径。

**先决条件：**

1. **首先将目标镜像同步到 ACP 平台注册表。** 路径必须与下面的 `repository` 字段匹配。例如，如果片段说 `repository: devops/actions/docker` + `tag: dind-alpine`，您必须将 `docker:dind-alpine` 推送到 `<global.registry.address>/devops/actions/docker:dind-alpine` 的平台注册表中。否则，runner pod 会遇到 ImagePullBackOff。
2. **在 `repository` 中不要包含注册表域。** 平台会自动在拉取时添加 `global.registry.address` 前缀。
3. **`tag` 必须实际存在于平台注册表中。** 下面的 `<your-target-tag>` 占位符必须替换为您的实际目标标签。当前 chart 版本在集群插件详细信息页面上可见，ARC 三个镜像集的标签与 chart 版本对齐。

**配置：** 将以下片段之一写入 **额外全局值** 字段。

> **警告 — 需要前导 2 个空格。** 本食谱中的所有 YAML 都放入 **额外全局值** 字段（嵌入在 `global:` 下）。该字段没有缩进模板助手，您的内容逐行插入到 2 空格缩进的上下文中 — **每行必须以 2 个空格开头**，否则安装将完全失败。保存前逐行验证。

两个片段组 A 和 B 分别针对两个插件。选择正确的组并粘贴到该插件的额外全局值中（这不是二选一；每个插件管理自己的）。

#### A — Controller 插件

Controller 插件接受一个镜像键（`controller`）。

仅覆盖标签（最常见的升级场景）：

```yaml
  images:
    controller:
      repository: devops/actions/gha-runner-scale-set-controller
      tag: <your-target-tag>          # 目标 ARC 版本标签，必须已同步到平台注册表
```

或者也覆盖 `repository`（团队私有注册表子路径 / 安全审计）：

```yaml
  images:
    controller:
      repository: my-team/private-mirror/gha-runner-scale-set-controller
      tag: <your-target-tag>
```

#### B — Scale-set 插件

Scale-set 插件接受两个镜像键：

- **`runnerExtension`** — runner 主镜像；**捆绑**在安装包中；仅在升级版本或切换镜像源时覆盖。
- **`dind`** — DinD 侧车镜像；**未捆绑**（参见 [食谱 8](#recipe-8-dind-mode-run-docker-build-inside-runner) 的先决条件）。仅在启用 DinD 模式时写入此部分，且镜像必须已同步到平台注册表。

仅覆盖标签：

```yaml
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
```

当启用 DinD 模式时（附加到上面的 `images:` 块）：

```yaml
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
    dind:
      repository: <dind-path-inside-platform-registry>     # 例如 devops/actions/docker
      tag: <your-docker-dind-tag>                          # 例如 28.0.4-dind
```

或者将所有内容覆盖到团队私有注册表子路径：

```yaml
  images:
    runnerExtension:
      repository: my-team/private-mirror/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
    dind:
      repository: my-team/private-mirror/docker
      tag: <your-docker-dind-tag>
```

**预期效果：** controller / listener / runner / dind 镜像从您指定的路径中拉取到平台注册表中。

> **警告 — 不能写入 `registry:` 子键。** 平台已经渲染了 `global.registry`。写入 `  registry:`（在 EGV 中的 2 空格缩进）会被静默丢弃；没有错误报告，但您的覆盖没有效果。

---

## 第四章 多团队 / 多项目隔离

通过 ACP **集群插件入口**，每个插件仅支持 **每个集群一个默认实例**。这意味着当您想要在一个集群上拥有多个隔离的 runner 池时，插件安装路径并不合适。对于团队 / 项目隔离，请选择以下之一：

### 快速决策指南

从一个问题开始：**所有团队 / 项目是否可以共享相同的 runner 运行时身份**（相同的 ServiceAccount、相同的节点池、相同的 GitHub 凭证）？

- **是** → 选择 **方法 1**：安装单个 ARC 并使用 GitHub runner-group 策略来缩小访问范围。ACP 端没有变化。
- **不，并且团队已经使用不同的集群** → 选择 **方法 2**：每个集群安装一组插件；资源 / 网络 / 节点在结构上是隔离的。
- **不，但仅有一个集群可用** → 选择 **方法 3**：通过 ACP **Catalog → Helm Chart** 多次安装上游 chart。
- **存储库接受分叉 PR / 外部贡献** → 无论上述选择如何，为这些存储库运行一个 **单独** 的 runner 池，以便它们不与主池共享秘密 / SA（请参见本章后面安全检查表的第 4 项）。

| 隔离目标                                                                                                    | 配置者                                                                                                  | 推荐        | 隔离粒度                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------- |
| “仅这些存储库 / 工作流可以调度到此池”；所有工作流可以共享一个 SA / 凭证 / 节点池                          | GitHub 管理员（组织 → 设置 → 操作 → Runner 组；企业 → 策略 → 操作 → Runner 组）                       | **方法 1** | GitHub 端授权；运行时仍然共享                         |
| 团队 A 和团队 B 已经使用不同的 ACP 集群                                                                     | ACP 管理员（在每个集群中安装 controller + scale-set 插件）                                            | **方法 2** | 集群级别（资源 / 网络 / 节点完全独立）               |
| 单个集群但需要多个独立的 runner 池（不同的 GitHub URL / 凭证 / SA / 节点池）                              | ACP 管理员（通过 Catalog → Helm Chart 多次安装上游 chart）                                           | **方法 3** | 在一个集群内的多实例                                   |

### 方法 1：一个 ARC 实例，通过 GitHub runner 组缩小访问（推荐）

将单个 scale-set 实例绑定到组织级或企业级 `githubConfigUrl`，然后使用 GitHub **runner 组** 策略定义谁可以使用该 runner 池。

- **GitHub App / PAT 是 ARC 身份验证方法。** 它们决定 ARC 如何与 GitHub API 通信、注册 runners 和获取作业；它们本身并不定义哪些存储库 / 工作流可以使用 runner 池。
- **组织 runners**：在 GitHub **设置 → 操作 → Runner 组** 中，将 runners 放入专用的 runner 组，并通过 `Selected repositories` / `Selected workflows` 缩小访问范围。
- **企业 runners**：在 GitHub 企业 **策略 → 操作 → Runner 组** 中，首先通过 `Selected organizations` / `Selected workflows` 缩小访问范围；如果企业 runner 组共享给一个组织，组织所有者可以进一步缩小存储库 / 工作流访问（如适用）。

此方法解决了共享 runner 池的 **GitHub 端使用边界**。它并不提供运行时隔离，例如单独的节点或命名空间。如果您的主要目标是“仅这些存储库 / 工作流可以调度到此池”，这通常是正确的首选。

> **关于 GitHub App 和企业 runners：** GitHub 不接受 GitHub App 进行企业级 runner 注册（参见 [权限要求](#permission-requirements)）；ARC 必须使用具有 `manage_runners:enterprise` 的经典 PAT。即便如此，“哪些组织 / 工作流可以使用此 runner 池”的控制仍应主要通过 runner 组策略处理，而不是通过 PAT 本身。

### 方法 2：多集群 ARC 部署（强隔离）

团队 A 使用集群 A，团队 B 使用集群 B。**每个集群安装自己的 controller 插件 + scale-set 插件**，具有独立的 `runnerScaleSetName`、独立的 `githubConfigUrl` 和独立的 GitHub 凭证 Secret。Runner 池生活在自己的集群中，具有完全的资源 / 网络 / 节点隔离。适合团队因业务 / 安全原因已经部署独立集群的情况 — 单集群“仅一个 scale-set 插件”不会影响 **跨集群** 多实例部署。

### 方法 3：直接 Helm chart 部署（特殊需求）

如果您需要强隔离但只想要一个集群，请通过平台的 **Catalog → Helm Chart** 入口（而不是 Marketplace 集群插件入口）部署多个独立的 ARC 实例，安装上游的 `gha-runner-scale-set` chart — 整个流程保持在 ACP UI 内；**不需要 `helm` CLI**。此路径 **不提供基于表单的配置字段**（例如“容器模式”和“GitHub URL”下拉框）；所有参数必须在 chart 值（YAML）中设置，升级 / 参数更改通过 Catalog 中相应的实例进行。

> **注意 — 标签路由不是实际多实例的替代方案。** 上游 chart 支持 `scaleSetLabels` + 数组形式的 `runs-on:`，让一个 scale-set 响应多个标签名称（用法和安装时仅约束在 [Workflow side: runs-on array form with scaleSetLabels](#workflow-side-runs-on-array-form-with-scalesetlabels) 中覆盖） — 但每个匹配的工作流仍然在 **同一** scale-set 实例上运行，共享一个 controller、一个 SA / RBAC 和一个 GitHub 凭证。如果您真正想要“团队 A 的工作流无法接触团队 B 的资源”的 **运行时隔离**，标签路由无法解决此问题；通常需要上述方法 2 / 3。方法 1 仅控制谁可以在 GitHub 端使用 runner 池。

### 安全检查表

在生产中运行 ARC 之前，请逐项检查以下四个项目。每个项目也在分散的食谱 / 示例中覆盖；此检查表只是一个合并的审计参考。

- **`githubConfigUrl` 范围 = 注册边界；runner 组策略 = 实际使用边界。** `githubConfigUrl` 越宽，ARC 的 GitHub 端注册边界越广。真正控制“哪些存储库 / 工作流可以使用此池”的应来自 runner 组策略：`Selected repositories` / `Selected workflows`（以及企业 runners 的 `Selected organizations`）。使用企业或组织级 `githubConfigUrl` 加上共享 SA，**任何被允许进入该 runner 组的工作流作者**都可以在此池上运行代码。一起缩小 `githubConfigUrl` 和 runner 组策略。
- **自定义 SA 将集群权限交给工作流作者。** 一旦 [食谱 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs) 将自定义 SA 附加到 runner，**任何可以编辑工作流 YAML 的人**都将继承 SA 的完整 RBAC。**请勿** 绑定广泛的角色，如 `ClusterRole/edit`；根据工作流需求授予动词（请参见食谱 1 中的最小权限角色示例）。
- **DinD / 特权 Buildah 仅用于受控存储库。** [食谱 8 (DinD)](#recipe-8-dind-mode-run-docker-build-inside-runner) 和 [示例 3 (Buildah)](#example-3-advanced-buildah-daemonless-image-build-still-privileged) 给予 runner root 或更广泛的容器逃逸表面。**仅让受信任的内部存储库**目标此 runner 池；将开放贡献的存储库路由到单独的、非特权的 scale-set。
- **为分叉 PR / 外部贡献隔离 runner 池。** GitHub 触发器，如 `pull_request_target` 允许外部 PR 在主分支的秘密 / SA 上下文中运行代码，这是一个已知的供应链攻击面。如果您的存储库接受外部贡献，**为它们提供一个单独的 runner 池**（通过上述方法 2 / 方法 3），并且不要与主 runners 共享秘密或 SA。

---

## 第五章 工作流示例

以下三个示例涵盖使用 runner 捆绑工具或原生 GitHub Actions 功能的常见工作流模式。所有 YAML 可以按原样复制粘贴 — 将 `my-runners` 替换为您的 `runnerScaleSetName`，并将镜像路径替换为从您的集群可访问的镜像。

> **注意：** 示例仅供参考；根据项目的需要调整工作流结构。

### 示例 1：在自定义容器中运行作业

**何时使用：** 默认的 runner 镜像缺少运行时（例如，您需要 Maven、特定的 JDK 版本）；您不想修改 runner 镜像；您也不想使用 DinD。GitHub Actions 原生 [`jobs.<id>.container`](https://docs.github.com/en/actions/using-jobs/running-jobs-in-a-container) 字段在 ACP scale-set 模式下完全有效 — ARC 使用 runner-container-hooks 动态创建相应的作业 pod / Kubernetes 作业在 runner 命名空间中，步骤在该容器环境中执行，而不是简单地在同一 runner pod 内添加一个侧车。**此模式要求 scale set 使用 `kubernetes-novolume`（默认）或 `kubernetes` 容器模式；`dind` 不支持 GHA 的 `container:` 字段。**

**完整工作流：**

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
        # 避免依赖于作业容器镜像是否恰好
        # 提供 `hostname`；使用 shell 内置的 ${HOSTNAME}。
        run: |
          echo "runner_name: ${RUNNER_NAME:-unknown}"
          echo "hostname:    ${HOSTNAME:-unknown}"
          echo "workspace:   ${GITHUB_WORKSPACE:-unknown}"
          cat /etc/os-release
          echo "whoami:      $(whoami)"
          id
```

**预期效果：** 作业的步骤在 `ubuntu:24.04` 容器环境中运行，保持 runner 主容器不变。在集群侧，您通常会看到该工作流作业的额外作业 pod / Kubernetes 作业资源。

#### 作业容器的额外权限 / 凭证

- **访问集群 API（容器内的 `kubectl`）：** 作业容器默认继承 runner pod 的 ServiceAccount（Kubernetes 自动挂载 SA 令牌在 `/var/run/secrets/kubernetes.io/serviceaccount/`）。有关 runner pod 上自定义 SA 的信息，请参见 [食谱 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs)。请注意，引用的 `image:` **必须包含 `kubectl` 二进制文件** — 社区的 `ubuntu:24.04` 不包含；使用一个捆绑 `kubectl` 的镜像，或者在步骤中动态下载它。
- **从私有注册表拉取：** 作业容器的镜像拉取仍然依赖于 runner 端的镜像拉取凭证路径。在当前的 Alauda 插件安装路径中，支持的 runner 端路径是平台注入的 `global.registry.imagePullSecrets`，或通过自定义 SA 间接附加凭证。上游 chart 确实将 `template.spec.imagePullSecrets` 传递到 runner pod spec，但本文档并未将该路径视为主要验证 / 推荐的插件安装路径；如果您使用它，请验证渲染的 spec 和目标集群上的实际拉取行为。
- **注入业务凭证：** 更倾向于将 `${{ secrets.X }}` 放在步骤级的 `env:` 块中（或 `jobs.<id>.env` 如果多个步骤共享它）；保留 `container.env` 用于非敏感常量。在 ARC 的 Kubernetes 容器模式中，通过步骤 `env:` 传递秘密是更可靠的路径。例如：

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

> **警告 — 容器模式要求。** 此模式要求 `kubernetes-novolume`（默认）或 `kubernetes`（食谱 7）。`dind` 模式不支持 GHA 的 `container:` 字段。
>
> **警告 — 气隙。** 您指定的 `image:` 必须是平台镜像注册表或集群可以拉取的路径。`docker.io/library/ubuntu:24.04` 在内部集群中通常无法访问 — 请替换为您已同步到平台注册表的相应镜像。

### 示例 2：从工作流触发集群内的 Tekton Pipeline

**何时使用：** GitHub Actions 处理触发和编排；Tekton 在集群上运行实际的重工作（构建、测试、部署）。真实部署将 Tekton `Pipeline` 资源保留在集群中作为版本化、可重用的定义；工作流仅创建一个引用它的新 `PipelineRun`。

**先决条件：**

- **Tekton Pipelines 已在集群中部署。** 此示例假设已安装 `tekton.dev/v1` CRDs（`Pipeline` / `PipelineRun` / `Task` / `TaskRun`）。在 ACP 上，通过 ACP DevOps 模块或上游 [tektoncd/pipeline](https://github.com/tektoncd/pipeline) 安装。否则，下面的 `kubectl apply` 将返回 `no matches for kind "Pipeline" in version "tekton.dev/v1"`。

- **Runner pod 使用具有 Tekton 操作权限的 ServiceAccount。** 使用 [食谱 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs) 创建自定义 SA（例如 `my-runner-sa`），然后绑定以下角色以创建 / 跟踪 PipelineRuns：

  ```shell
  $ kubectl apply -n arc-runners -f - <<'EOF'
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: tekton-pipelinerun-runner
  rules:
  - apiGroups: ["tekton.dev"]
    resources: ["pipelines"]                  # `tkn pipeline start` 首先 GET Pipeline 以发现其参数
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

  该角色授予对 Pipelines 的 **读取** 权限（以便 `tkn pipeline start` 可以解析 Pipeline 的参数）、对 PipelineRuns 的 **创建 + 读取** 权限，以及对 TaskRuns 和 pods 的 **读取** 权限，以及对 pod 日志的 **获取** 权限（因此 `tkn pipeline start --showlog` 和 `tkn pr logs -f` 可以跟踪运行）。本文档的场景不需要对 TaskRuns 的 `create` 权限。如果没有 Pipelines 读取规则，`tkn pipeline start` 将失败，显示 `Pipeline name <pipeline> does not exist in namespace <ns>` — 即使从集群管理员的角度来看，Pipeline 是存在的。

- **在集群中预创建一个最小的 Pipeline。** 应用以下清单。默认情况下，一切都位于 `arc-runners`（与 runner pod 相同的命名空间，避免跨命名空间 RBAC）。要使用不同的命名空间，请在此处和工作流 `env` 块中替换 `arc-runners`。

  > **注意：** 下面的 `image:` 使用 `docker.io/library/busybox:1.36` 进行演示。**对于气隙集群，请在应用之前将其替换为您的平台注册表可以拉取的路径。**

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
          image: docker.io/library/busybox:1.36   # 气隙：用内部可访问的镜像替换
          script: |
            #!/bin/sh
            echo "triggered for $(params.git-url) @ $(params.git-revision)"
  EOF
  ```

  在真实部署中，此 Pipeline 将是一个完整的构建和部署流程（`git-clone` → `buildah` → `kubectl-deploy` 等）。

**完整工作流：**

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
        # `env` 携带此触发的特定平台值。
        # 默认值与上述先决条件匹配；在此处覆盖（或提升到 GitHub 存储库变量以供多管道使用）。
        env:
          TEKTON_NS: arc-runners
          PIPELINE_NAME: gh-trigger-demo
          GIT_URL: ${{ github.server_url }}/${{ github.repository }}
          GIT_SHA: ${{ github.sha }}
        run: |
          # 使用捆绑的 `tkn` CLI 启动管道。
          # `tkn pipeline start` 创建一个 PipelineRun（带有服务器生成的名称）；`--showlog` 跟踪其日志直到运行完成 — 替代清单渲染、kubectl 创建和单独的 `tkn pr logs -f` 步骤。
          tkn pipeline start "${PIPELINE_NAME}" \
            -n "${TEKTON_NS}" \
            -p git-url="${GIT_URL}" \
            -p git-revision="${GIT_SHA}" \
            --showlog
```

**预期效果：** `tkn pipeline start` 创建一个引用集群内 `gh-trigger-demo` Pipeline 的 `PipelineRun`；Tekton 控制器解析 `pipelineRef.name` 到当前的 Pipeline spec 并运行它。`--showlog` 将运行的日志尾部返回到 GitHub Actions 控制台；当 PipelineRun 完成时，步骤以 PipelineRun 的成功状态退出。**Pipeline 定义保存在集群中，由您的平台团队拥有；工作流只是使用 runner 镜像捆绑的 CLI 的薄触发器。**

> **注意 — 为什么使用 `tkn pipeline start` 而不是 `kubectl create -f`？** runner 镜像捆绑了 `tkn`；`tkn pipeline start` 覆盖整个“创建 PipelineRun + 尾部其日志”的流程，只需一个命令，无需渲染 YAML 清单、处理 `metadata.generateName` 或链接单独的 `tkn pr logs -f`。RBAC 要求仍然是上面列出的最小角色：对 Pipelines 的读取、对 PipelineRuns 的创建 + 读取、对 TaskRuns 和 pods 的读取，以及对 pod 日志的获取，因此食谱 1 的自定义 SA 仍然适用。使用 `tkn pipeline start --help` 发现 `--serviceaccount`、`--workspace`、`--use-param-defaults` 和其他标志，因为您的真实 Pipeline 变得更大。

### 示例 3（高级）：Buildah 无根镜像构建（仍然特权）

**何时使用：** 工作流需要 `buildah build` / `docker build` 风格的操作，但您不想启用 DinD
（[食谱 8](#recipe-8-dind-mode-run-docker-build-inside-runner) 需要一个特权侧车）。Buildah 无根模式可以在常规作业容器内构建，更友好于集群安全策略。这里的 **无根** 意味着 Buildah 进程本身作为非根用户在容器内运行；它并不自动意味着整个作业 pod 免于额外的能力 / 特权要求。

**关键挑战：** Buildah 无根模式在容器内需要一个非根可写存储路径，而不与主机的根拥有默认路径冲突。将 `CONTAINERS_STORAGE_CONF` 重定向到 `/tmp` 可以解决此问题。

**先决条件：** 在您的 GitHub 存储库中，**设置 → 秘密和变量 → 操作**，创建两个存储库秘密：`REGISTRY_USERNAME` 和 `REGISTRY_PASSWORD` 用于您的平台注册表登录（用于推送构建工件）。

此示例还依赖于 GHA 的 `container:` 字段，因此仅适用于 `kubernetes-novolume`（默认）或 `kubernetes` 模式；`dind` 不支持它。

**完整工作流**（社区 Buildah 镜像 + 通用秘密名称）：

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
        # 将 buildah 存储重定向到 /tmp（模式 1777，非根用户可写）
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

**注意事项：**

- `options: --privileged` — Buildah 无根模式仍然需要一些能力；最简单的路径是特权。换句话说，**无根 != 非特权**：进程身份可以是非根用户，而 pod 仍然需要额外的能力。对于更严格的生产环境，仅授予 SYS_ADMIN，但配置会更复杂。
- `HOME=/tmp` + `CONTAINERS_STORAGE_CONF=/tmp/storage.conf` — 强制 Buildah 的存储路径为 `/tmp`（在作业容器内为模式 1777，非根用户可写）。
- `STORAGE_DRIVER=vfs` + `BUILDAH_ISOLATION=chroot` — 嵌套容器场景中最兼容的存储 / 隔离组合（性能不是最佳，但兼容性最高）。
- 上述 `image: quay.io/buildah/stable:latest`、`docker.io/library/alpine:3.20` 路径是社区路径。**气隙集群必须首先将这些镜像同步到平台注册表，并更新 `image:` 为相应的内部路径**，否则 pods 将无法启动。
- `quay.io/buildah/stable:latest` 适用于演示，但不作为长期可重复的文档推荐。为了真正采用，请将其切换为您的团队已验证并镜像到内部注册表的固定标签（或摘要）。

> **警告 — 仅用于演示；不建议按原样用于生产。** 组合 `--privileged` + `STORAGE_DRIVER=vfs` + `BUILDAH_ISOLATION=chroot` 是最兼容和最容易设置的，但：
>
> - 在具有 PSA `restricted` / OpenShift SCC `restricted` 策略的集群上，`--privileged` 会被拒绝，导致此工作流无法启动。
> - `vfs` 存储驱动速度较慢；复杂构建将很慢。
> - 气隙镜像构建仍需处理基础镜像路径替换、注册表凭证注入、缓存等。
>
> **生产建议：** 将镜像构建任务 **下推到 ACP 的 Tekton Pipelines**（使用 [示例 2](#example-2-trigger-an-in-cluster-tekton-pipeline-from-a-workflow) 模式；从 GitHub 工作流中，`tkn pipeline start` 触发一个包含 Buildah / Kaniko 任务的 PipelineRun）。Tekton 社区的 buildah / kaniko 任务在权限边界、缓存和签名处理方面比临时 Buildah 在 GHA 工作流中更成熟。

---

## 第六章 故障排除

问题按 **在客户部署中观察到的频率** 排序，最常见的在前。

> **注意：** 本章中的命令假设控制器命名空间为 `arc-systems`，scale-set 命名空间为 `arc-runners`。如果您的部署使用自定义命名空间，请先重写命令，然后比较观察到的行为。

### 问题 1：安装失败 — 选择的安装命名空间不存在

**症状：** 在平台 UI 中，安装控制器插件或 scale-set 插件后，插件实例在几秒钟内未达到 `Installed`；详细页面显示 `namespaces "<your-ns>" not found`。

**原因：** 安装命名空间表单字段中指定的命名空间在目标集群中不存在，平台不会为您创建它。

**解决方案：** 首先创建命名空间，然后安装。有两种方法：

```shell
# 选项 1：kubectl
$ kubectl create ns arc-systems   # 用于控制器插件
$ kubectl create ns arc-runners   # 用于 scale-set 插件
```

或者在平台 UI 上预创建：集群 → 命名空间页面。

> **注意 — 这两个插件位于不同的命名空间。** 默认情况下，控制器安装到 `arc-systems`，scale-set 安装到 `arc-runners`（这些是 ACP 表单默认值，而不是硬性要求 — 您的实际部署可以使用其他名称，例如 `arc-controller-prod` / `team-a-runners`）。如果您更改了默认值，**确保 scale-set 表单的控制器命名空间字段指向控制器的实际安装命名空间**；否则，scale-set 会将其控制器面向的引用 / RBAC 指向错误的主体，导致监听器无法正确创建或更新。

### 问题 2：监听器 pod 无法启动（Pending 或 CrashLoopBackOff） — GitHub 凭证问题

**症状：** `kubectl -n arc-systems get pod` 显示 `<scaleset>-...-listener` 长时间处于 Pending 状态，或者它启动并 CrashLoopBackOff，日志中显示 `401`、`Bad credentials`、`Could not find any installation` 或 `PEM` 错误。

**常见原因：**

| 症状                                                                                                                         | 原因                                                                                                                                                                                             | 解决方案                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `secret "gha-runner-scale-set-github-config" not found`                                                                         | 第一步中的 Secret 未创建，或位于错误的命名空间                                                                                                                                | 根据 [GitHub 凭证设置](#github-credential-setup) 重新创建；**命名空间必须是集群插件的安装命名空间**（默认 `arc-runners`）。                                      |
| Secret 仅在安装后创建，而集群插件在启动时失败并显示 `not found` / 监听器从未启动 | 启动时缺少初始凭证                                                                                                                                       | 根据 [GitHub 凭证设置](#github-credential-setup) 创建 Secret；一旦 Secret 出现，通常会自动恢复，如果没有，删除监听器 Pod 一次以强制重建。 |
| 监听器日志 `401 Unauthorized` 或 `Bad credentials`                                                                            | GitHub 应用的 `app_id` / `installation_id` 错误                                                                                                                                             | 在 GitHub UI 中验证应用 ID (**设置 → 开发者设置 → GitHub 应用 → 你的应用**)；在“安装应用” → 配置 URL 的尾部数字即为 `installation_id`。                         |
| 监听器日志 `failed to parse private key` 或类似 PEM 错误                                                                 | 私钥不是有效的 PEM 格式（典型：通过 `--from-literal` 存储在单行中，换行符丢失）                                                                                          | 使用 `--from-file=github_app_private_key=app.pem` 重新创建 Secret。                                                                                                                            |
| 监听器日志 `Could not find any installation`                                                                                  | 应用尚未安装在目标组织 / 仓库                                                                                                                                             | 在 GitHub UI 中“安装应用”，将应用安装到 `githubConfigUrl` 引用的组织 / 仓库。                                                                                                     |
| 使用 PAT 时监听器日志 `401 Unauthorized` / `Bad credentials`                                                              | PAT 已过期、被撤销，或 Secret 中的令牌值错误                                                                                                                            | 重新创建 / 重新注入 PAT，并验证 Secret 键为 `github_token`。                                                                                                                          |
| 监听器持续报告旧凭证 / 在你旋转 Secret 后仍返回 `401`                                     | 监听器未从现有 Secret 热重载更新内容                                                                                                                             | 删除监听器 Pod，以便控制器使用新凭证重新创建它。                                                                                                                    |
| 监听器日志 `403 Forbidden`、`Resource not accessible by personal access token`，或企业注册持续失败      | PAT 范围 / 权限不足；例如，Classic PAT 缺少 `repo` / `admin:org` / `manage_runners:enterprise`，或在企业级使用了细粒度 PAT | 根据 [权限要求](#permission-requirements) 重新创建 PAT；**企业运行器仅支持 Classic PAT + `manage_runners:enterprise`**。                                           |
| 尽管令牌看起来有效，但细粒度 PAT 持续出现权限错误                                         | 令牌的所有者 / 仓库选择未覆盖 `githubConfigUrl` 引用的仓库 / 组织                                                                                            | 重新创建细粒度 PAT，并确保其所有者和仓库选择覆盖目标范围；如果不确定，先与 Classic PAT 交叉检查。                                            |

诊断命令：

```shell
# 当前监听器状态
$ kubectl -n arc-systems get pod -l app.kubernetes.io/component=runner-scale-set-listener

# 最近日志（GitHub 错误通常在监听器启动时出现）
$ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=50
```

### 问题 3：工作流保持“排队”，运行器从未到达

**症状：** GitHub UI 显示工作流为 `Queued`；监听器 Pod 正在运行且日志正常；没有运行器 Pod 出现。

**原因：** 工作流 YAML 中的 `runs-on:` 与集群插件不匹配。
对于本文中验证的 Alauda 路径，**最安全**的形式是与集群插件表单中的 `runnerScaleSetName` 相等的 **单字符串**。

**解决方案：** 最简单的修复 — 使用单字符串形式：

```yaml
# 本文中当前验证的最安全形式：单字符串
runs-on: my-runners       # 等于集群插件的运行器规模集名称字段
```

> **注意：** 上游图表支持 `scaleSetLabels` + 数组形式的 `runs-on:` 以从单个集群插件提供多个标签集；
> 完整用法、注入方法、仅限安装时的约束，以及“如果我已经安装该怎么办”在
> [工作流侧：带有 scaleSetLabels 的 runs-on 数组形式](#workflow-side-runs-on-array-form-with-scalesetlabels) 中。

**诊断步骤：**

```shell
# 1. 确认集群插件注册名称
$ kubectl -n arc-runners get autoscalingrunnerset \
    -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.runnerScaleSetName}{"\n"}{end}'

# 2. 推送工作流后，监听器日志应显示“获取作业 ...”；
#    缺少该信息意味着 runs-on 不匹配
$ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=20
```

> **注意：** 需要每个团队 / 项目单独的运行器池？请参见
> [第 4 章 多团队 / 多项目隔离](#chapter-4-multi-team--multi-project-isolation)。

### 问题 4：监听器缺失 / 不可用 — 控制器引用不匹配或节点资源不足

**症状：** 监听器未变为可用；要么它从未出现，要么 Pod 保持 Pending（而不是问题 2 中的 GitHub 凭证问题）。

| 原因                                                                                                               | 通常看到的内容                                                                                                                                                                                                                           | 解决方案                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 集群插件表单的 **控制器命名空间** / **控制器服务帐户名称** 与控制器插件不匹配 | 监听器可能从未出现，或控制器日志 / 事件显示 RBAC 或协调失败。此处 `arc-gha-rs-controller` 是集群插件控制器面向绑定引用的主题，而不是监听器 Pod 本身挂载的 SA | 恢复控制器插件的实际命名空间 / SA（默认值：`arc-systems` / `arc-gha-rs-controller`）  |
| 节点资源不足                                                                                         | 监听器 Pod 存在但保持 Pending；`kubectl describe pod` 显示 `0/N nodes are available: insufficient cpu/memory`                                                                                                                     | 添加节点 / 减少监听器资源 / 验证全局 nodeSelector 未将其固定到资源不足的节点。 |

### 问题 5：运行器 Pod ImagePullBackOff 或卡在 ContainerCreating

**症状：** 工作流触发，运行器 Pod 出现，然后保持在 `ContainerCreating` 或 `ImagePullBackOff`。

**常见原因和解决方案：**

- **覆盖了 ARC 镜像但未将目标镜像同步到平台注册表。** 验证在
  [食谱 9](#recipe-9-override-arc-images-custom-version--private-registry)
  中写入的 `repository` 实际上可以从 ACP 平台注册表中拉取。**默认安装包包含匹配的镜像，因此原则上不需要覆盖。**
- **PVC 未准备好**（Kubernetes 模式）：验证来自
  食谱 7 的 `storageClassName` 存在并支持动态供给。
- **私有注册表 imagePullSecrets：** 默认的
  `global.registry.imagePullSecrets` 是平台注入的。如果从您自己的私有注册表拉取，建议使用平台注入的
  `global.registry.imagePullSecrets` 或通过自定义 SA 间接附加凭证。`template.spec.imagePullSecrets` 不是本文推荐的诊断路径；请参见
  [已知限制](#known-limitations) 下的 `imagePullSecrets` 条目。

### 问题 6：表单更改未传播

**症状：** 您在平台 UI 上编辑了额外的图表值（或其他字段）；保存后，集群的 ARS / 部署 / Pod 未更新。

**最常见原因：** ECV 包含一个顶级键，该表单已经呈现，破坏了图表的 Helm 解析。示例：

```yaml
# ❌ 错误：`flags` 是控制器表单呈现的顶级键
flags:
  watchSingleNamespace: my-team-namespace
```

```yaml
# ❌ 错误：`global` 是表单呈现的（通过 EGV 覆盖 global.images.* 而不是 — 请参见食谱 9）
global:
  images:
    runnerExtension:
      repository: x/y
```

**解决方案：**

- **检查插件实例状态。** 在平台 UI
  (**Marketplace → Cluster Plugins**)，找到插件实例。如果它不是 `Installed`，详细信息页面将显示类似
  `yaml: unmarshal errors: mapping key "<key>" already defined` 的错误。
- **使用额外的全局值（而不是额外的图表值）覆盖 `global.*`。** 在顶级写 `images:`（每行缩进 2 个空格），而不是 `global.images.*` — 请参见
  [食谱 9](#recipe-9-override-arc-images-custom-version--private-registry)。
- **不要在 ECV 中写入以下顶级键**（已经表单呈现）：
  - 控制器插件：`flags`、`metrics`、`namespaceOverride`、
    `replicaCount`、`global`。
  - 集群插件：`namespaceOverride`、`global`、`githubConfigUrl`、
    `githubConfigSecret`、`runnerScaleSetName`、`minRunners`、`maxRunners`、
    `controllerServiceAccount`。
  - `containerMode` 是 **条件性的**：当表单的容器模式字段为 **非空** 时，不要在 ECV 中再次写 `containerMode:`；仅在您故意将表单字段留空并完全接管该块时写 `containerMode:`。请参见
    [容器模式选择](#container-mode-selection)。

#### 已知问题：切换回默认运行器 SA 后，默认 kube-mode RBAC 对象仍然卡在 `Terminating`

**适用范围：** 当前基线版本，在 `kubernetes` /
`kubernetes-novolume` 模式下，当您首次根据
[食谱 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs) 将
`template.spec.serviceAccountName` 指向自定义 SA，然后稍后清除该字段或切换回默认路径时。

**症状：**

- 后续工作流使用默认 SA 时，在 `container:` 作业初始化期间失败，显示 `HTTP-Code: 401 Unauthorized`；
- 或者运行器 Pod 仍包含 `kubectl`，但
  `kubectl auth can-i ...` 直接返回 `error`；
- 或者 `kubectl get sa,role,rolebinding -n arc-runners` 仍显示默认的 `<scaleset>-gha-rs-kube-mode` 对象，但其中一个或多个仍然带有 `metadata.deletionTimestamp`。

**如何确认：**

```shell
$ kubectl -n arc-runners get sa,role,rolebinding \
    <runner-scale-set-name>-gha-rs-kube-mode -o yaml
```

如果输出仍包含：

```yaml
metadata:
  deletionTimestamp: "..."
  finalizers:
    - actions.github.com/cleanup-protection
```

您遇到了这个已知问题。

**解决方法：**

1. **尽量避免状态转换：** 如果该运行器池需要长期的集群内访问，保持一个专用的自定义运行器 SA，而不是在默认 SA 和自定义 SA 之间来回切换。
2. **切换回默认 SA 后验证一次：** 在 ACP UI 中，
   **Marketplace → Cluster Plugins → 该集群插件 → 更新**，
   保存一个无害的更改以触发协调（例如暂时将 `最大运行器` 增加 1，保存，然后再改回并再次保存），然后验证三个默认 kube-mode 资源已被重新创建且不再携带 `deletionTimestamp`。
3. **如果它们已经卡住：** 首先从三个默认 kube-mode 资源中清除
   `actions.github.com/cleanup-protection` 最终器，然后触发上述协调，以便平台重新创建默认 SA / 角色 / 角色绑定。例如：

```shell
$ kubectl -n arc-runners patch sa <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
$ kubectl -n arc-runners patch role <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
$ kubectl -n arc-runners patch rolebinding <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
```

这是与当前清理/最终器问题相关的已知限制。它并不意味着
`template.spec.serviceAccountName` 本身不受支持；主要行为仍按预期工作：运行器 Pod 切换到自定义 SA 并根据该 SA 的 RBAC 授权。

---

## 第 7 章 卸载

### 卸载前检查清单

在运行以下任何步骤之前，请确认以下内容：

- GitHub 侧的所有工作流已停止（在卸载期间，正在进行的工作流将失败）。
- 没有业务工作负载依赖于 `arc-runners` 中的 PVC / ConfigMap / Secret 资源。
- GitHub 侧的相应运行器注册信息 (**设置 → 操作 → 运行器**) 已记录；您需要在卸载后删除它们（仅当控制器侧清理未自动删除它们时 — 请参见第 1 步下的说明）。

### 第 1 步：卸载集群插件

在平台 UI 中，**Marketplace → Cluster Plugins**，找到集群插件实例，点击 ⋮ → **卸载**。

> **注意：** 如果您的控制器 / 集群插件未安装在默认的
> `arc-systems` / `arc-runners` 命名空间中，请在下面的每个 `kubectl -n ...` 和 `kubectl delete namespace ...` 命令中用您的实际部署命名空间替换这些命名空间值。这些是破坏性命令；请勿盲目复制默认值。

等待 `arc-runners`（默认安装命名空间）中的 Pods 被清理：

```shell
$ kubectl -n arc-runners get autoscalingrunnerset
# 预期：未找到资源

$ kubectl -n arc-runners get pod
# 预期：未找到资源（或仅您的非 ARC 工作负载）
```

> **注意：** 在当前 ARC 版本中，**正常**的集群插件卸载会导致控制器在 `AutoscalingRunnerSet` 完成时从 GitHub 删除相应的运行器集，因此 **手动 GitHub UI 清理通常是不必要的**。您只需检查并删除 **设置 → 操作 → 运行器** 中的剩余条目，当该清理路径未完成时（例如，控制器首先被删除，GitHub 凭证已损坏，或完成失败且资源被卡住）。此集群插件条目与 GitHub 的“运行器组”（运行器访问控制分组）不同。

### 第 2 步：卸载控制器插件

> **警告 — 首先卸载集群插件。** 在集群插件仍存在的情况下卸载控制器，监听器 Pod 进入协调循环，控制器的 CRD 可能会留下残余的最终器。

Marketplace → Cluster Plugins，找到控制器插件，点击 ⋮ →
**卸载**。

验证控制器资源是否已消失：

```shell
$ kubectl -n arc-systems get pod
# 预期：未找到资源

$ kubectl get crd | grep actions.github.com
# 预期：空（四个 ARC CRD 被控制器插件删除）
```

### 第 3 步：清理残余资源

某些资源不会被插件卸载删除，需要手动清理：

```shell
# GitHub 凭证 Secret（插件不会删除用户创建的 Secrets）
$ kubectl -n arc-runners delete secret gha-runner-scale-set-github-config

# 来自食谱 1 的任何自定义 SA / 角色 / 角色绑定
$ kubectl -n arc-runners delete sa my-runner-sa
$ kubectl -n arc-runners delete rolebinding my-runner-sa-binding
$ kubectl -n arc-runners delete role my-runner-sa-role

# 来自食谱 6 的任何自定义 PVC / ConfigMap
$ kubectl -n arc-runners delete pvc maven-cache-pvc
$ kubectl -n arc-runners delete configmap extra-ca-bundle

# 命名空间（在确认没有残余 Pods 后）
$ kubectl delete namespace arc-runners arc-systems
```

> **警告：** 上述删除命令使用默认命名空间进行说明。如果您的部署使用自定义命名空间，请在执行之前逐行替换它们，尤其是在删除 `arc-runners` /
> `arc-systems` 之前。

---

## 已知限制

- **控制器单命名空间监视不可配置。** 上游图表的 `flags.watchSingleNamespace` 目前无法通过额外图表值设置（`flags` 顶级键是表单呈现的）。如有需要，请联系平台支持团队。
- **本文推荐的运行器侧私有镜像拉取的主要路径是平台注入的 `global.registry.imagePullSecrets`，或通过服务帐户间接附加 `imagePullSecrets`。** 上游图表确实将 `template.spec.imagePullSecrets` 传递到运行器 Pod 规格，但本文不将其视为单独验证的插件安装矩阵。如果您希望依赖该路径，请先检查渲染的 ARS / 运行器 Pod 规格，并在目标集群上验证实际镜像拉取。基于 SA 的路径通常更容易一致管理：

  ```shell
  $ kubectl create secret docker-registry my-private-registry \
      --docker-server=my.registry.com \
      --docker-username=<u> --docker-password=<p> \
      -n arc-runners
  $ kubectl create serviceaccount runner-puller -n arc-runners
  $ kubectl patch sa runner-puller -n arc-runners \
      -p '{"imagePullSecrets":[{"name":"my-private-registry"}]}'
  ```

  然后参考 [食谱 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs)
  设置 `template.spec.serviceAccountName: runner-puller`。监听器侧的 imagePullSecrets 不受此限制，可以通过额外图表值直接写为
  `listenerTemplate.spec.imagePullSecrets`。
- **集群插件条目仅支持每个集群一个默认实例。** 通过 ACP 集群插件条目在同一集群上安装第二个实例将被拒绝。要在同一集群上运行多个隔离的运行器池，请通过平台的
  **Catalog → Helm Chart** 条目安装上游 `gha-runner-scale-set` 图表的额外副本 — 请参见
  [第 4 章 方法 3](#method-3-direct-helm-chart-deployment-special-needs)。

---

## 附录：完整图表值参考

> **提示 — 这是参考材料，而不是必读内容。** 如果您
> 只想遵循食谱并调整配置，请跳过此部分，直接跳转到
> [第 2 步：验证配置更改已生效](#step-2-verifying-a-config-change-took-effect)
> 或下面的 [食谱 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs)。此部分内联了两个插件（`gha-runner-scale-set-0.14.1`，保留注释）的完整上游图表值，以便您在编写 ECV / EGV 时查找字段语义和默认值，而无需离开文档。

ARC 作为两个独立的集群插件发布 — **控制器插件**
和 **集群插件** — 每个插件都有自己的图表及其值架构。Alauda 覆盖以不同的方式调整它们的默认值；
最明显的是，`global.images.*` 在每个插件中不同（控制器插件仅包含 `images.controller`，而集群插件包含 `images.runnerExtension` 和 `images.dind`，供 DinD 用户使用）。
这两个插件在下面分别记录。

对于每个插件，值以两个层次呈现：

- **Alauda 覆盖** — Alauda 集群插件添加的字段（最显著的是携带平台注册表重写 +
  拉取密钥注入的 `global:` 块）或其设置的与上游不同的默认值。
- **上游图表** — ARC 发布的未修改的 `gha-runner-scale-set-controller`
  / `gha-runner-scale-set` 图表。当前 Alauda 插件发布上游 `gha-runner-scale-set-0.14.1` 版本；下面的链接和内联值固定在该标签。将此层视为每个可配置字段及其默认值的权威参考 — 任何未在上述 Alauda 覆盖中明确列出的内容都保持上游默认值。

首先阅读 Alauda 层以了解已实施的特定平台行为；在需要为表单未公开的字段编写 ECV / EGV 覆盖时，请查阅上游层。

### 控制器插件

<details>
<summary>Alauda 覆盖 — 控制器特定的附加项 / 默认覆盖（点击展开）</summary>

下面的 `global:` 块是最明显的 Alauda 添加 — 它
**不是** 上游图表的一部分，Alauda 集群插件在安装时填充它，因此每个控制器镜像拉取都通过平台注册表解析：

```yaml
# 由 Alauda 集群插件提供；不在上游图表中。
global:
  registry:
    address: registry.alauda.cn:60070   # 在 ACP 安装时平台注入
    imagePullSecrets: []                # 平台管理；请勿直接写入
  labelBaseDomain: alauda.io
  images:
    controller:
      repository: devops/actions/gha-runner-scale-set-controller
      tag: "latest"
```

此外，以下上游字段在此插件中以 Alauda 调整的默认值提供（字段名称与上游匹配 — 仅默认值不同）：

- `resources` / `podSecurityContext` / `securityContext` — 设置为与 PSS-`restricted` 兼容的值，适用于默认 ACP 控制平面节点的大小。
- `flags.logFormat: "json"`（上游默认值为 `text`）。

</details>

<details>
<summary>上游图表值 — gha-runner-scale-set-0.14.1（点击展开）</summary>

来源：[ `charts/gha-runner-scale-set-controller/values.yaml` @ `gha-runner-scale-set-0.14.1`](https://github.com/actions/actions-runner-controller/blob/gha-runner-scale-set-0.14.1/charts/gha-runner-scale-set-controller/values.yaml)。
完整文件逐字复制，保留上游注释，以便您无需离开文档即可阅读。

```yaml
# gha-runner-scale-set-controller 的默认值。
# 这是一个 YAML 格式的文件。
# 声明要传递到模板中的变量。
labels: {}

# 当 replicaCount>1 时，将启用 leaderElection，
# 因此，在给定时间内，只有一个副本负责协调
# leaderElectionId 将设置为 {{ define gha-runner-scale-set-controller.fullname }}。
replicaCount: 1

image:
  repository: "ghcr.io/actions/gha-runner-scale-set-controller"
  pullPolicy: IfNotPresent
  # 覆盖默认的图表应用版本的镜像标签。
  tag: ""

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

env:
## 为控制器 Pod 定义环境变量
#  - name: "ENV_VAR_NAME_1"
#    value: "ENV_VAR_VALUE_1"
#  - name: "ENV_VAR_NAME_2"
#    valueFrom:
#      secretKeyRef:
#        key: ENV_VAR_NAME_2
#        name: secret-name
#        optional: true

serviceAccount:
  # 指定是否应为运行控制器 Pod 创建服务帐户
  create: true
  # 要添加到服务帐户的注释
  annotations: {}
  # 要使用的服务帐户名称。
  # 如果未设置且创建为 true，则使用 fullname 模板生成名称
  # 您不能使用默认服务帐户。
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
## 我们通常建议不要指定默认资源，而是将其留给用户做出有意识的选择。
## 这也增加了图表在资源较少的环境（如 Minikube）上运行的机会。如果您确实想指定资源，请取消注释以下行，按需调整，并在 'resources:' 后删除大括号。
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

# 在容器中挂载卷。
volumes: []
volumeMounts: []

# 利用优先级类确保您的 Pods 在资源短缺时存活
# 参考：https://kubernetes.io/docs/concepts/configuration/pod-priority-preemption/
# PriorityClass: system-cluster-critical
priorityClassName: ""

## 如果未提供 `metrics:` 对象，或将其注释掉，则以下标志
## 将应用于控制器管理器和监听器 Pods，值为空：
## `--metrics-addr`、`--listener-metrics-addr`、`--listener-metrics-endpoint`。
## 这将禁用指标。
##
## 要启用指标，请取消注释以下行。
# metrics:
#   controllerManagerAddr: ":8080"
#   listenerAddr: ":8080"
#   listenerEndpoint: "/metrics"

flags:
  ## 日志级别可以在此处设置为以下值之一：“debug”、“info”、“warn”、“error”。
  ## 默认值为“debug”。
  logLevel: "debug"
  ## 日志格式可以设置为以下值之一：“text”、“json”
  ## 默认值为“text”
  logFormat: "text"

  ## 限制控制器仅监视所需命名空间中的资源。
  ## 默认情况下，未设置时监视所有命名空间。
  # watchSingleNamespace: ""

  ## 可由临时运行器控制器运行的最大并发协调数。
  # 增加此值以提高控制器的吞吐量。
  # 这也可能增加 API 服务器和外部服务（例如 GitHub API）的负载。
  runnerMaxConcurrentReconciles: 2

  ## 定义控制器在运行作业时如何处理升级。
  ##
  ## 可用的策略有：
  ## - "immediate"：（默认）控制器将立即应用更改，导致
  ##   重新创建监听器和临时运行器集。如果有待处理/正在运行的作业，这可能会导致运行器的过度配置。这在小规模下通常不是问题，但如果您有大量作业并发运行，可能会导致资源显著增加。
  ##
  ## - "eventual"：控制器将立即删除监听器和临时运行器集，
  ##   但在所有待处理/正在运行的作业完成之前不会重新创建它们（以应用更改）。
  ##   这可能导致应用更改的时间更长，但将确保
  ##   您不会有任何运行器的过度配置。
  updateStrategy: "immediate"

  ## 定义应不传播到内部资源的前缀列表。
  ## 当您有用于内部目的的标签且不应传播到内部资源时，这很有用。
  ## 有关更多信息，请参见 https://github.com/actions/actions-runner-controller/issues/3533。
  ##
  ## 默认情况下，所有标签都传播到内部资源
  ## 匹配列表中指定的前缀的标签将被排除在传播之外。
  # excludeLabelPropagationPrefixes:
  #   - "argocd.argoproj.io/instance"

# 覆盖此图表中所有资源的默认 `.Release.Namespace`。
namespaceOverride: ""

## 定义 K8s 客户端速率限制器参数。
  # k8sClientRateLimiterQPS: 20
  # k8sClientRateLimiterBurst: 30
```

</details>

### 集群插件

<details>
<summary>Alauda 覆盖 — 集群特定的附加项 / 默认覆盖（点击展开）</summary>

下面的 `global:` 块是最明显的 Alauda 添加 — 它
**不是** 上游图表的一部分，Alauda 集群插件在安装时填充它，因此每个运行器 / 运行器扩展镜像拉取都通过平台注册表解析：

```yaml
# 由 Alauda 集群插件提供；不在上游图表中。
global:
  registry:
    address: registry.alauda.cn:60070   # 在 ACP 安装时平台注入
    imagePullSecrets: []                # 平台管理；请勿直接写入
  labelBaseDomain: alauda.io
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: "latest"
    # `dind` 镜像故意未预先声明 — DinD 模式是
    # 自愿的，上游 Docker CVE 表面最好保持关闭
    # Alauda 补丁积压。使用 DinD 的客户必须镜像上游
    # 镜像并自行覆盖 `global.images.dind.{repository,tag}`。
```

此外，以下上游字段在此插件中以 Alauda 调整的默认值提供（字段名称与上游匹配 — 仅默认值不同）：

- `githubConfigUrl` — 设置为明显无效的占位符，以便安装快速失败，而不是渲染为空 URL。
- `githubConfigSecret: gha-runner-scale-set-github-config` — 表单期望的默认 Secret 名称。
- `containerMode.type: kubernetes-novolume`。
- `template.spec.containers[0]` — 预填充平台运行器镜像 + `command: ["/home/runner/run.sh"]` +
  `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER=false`。
- `minRunners: 0` / `maxRunners: 5`。
- `controllerServiceAccount` — 固定为 `arc-systems` /
  `arc-gha-rs-controller`。

</details>

<details>
<summary>上游图表值 — gha-runner-scale-set-0.14.1（点击展开）</summary>

来源：[ `charts/gha-runner-scale-set/values.yaml` @ `gha-runner-scale-set-0.14.1`](https://github.com/actions/actions-runner-controller/blob/gha-runner-scale-set-0.14.1/charts/gha-runner-scale-set/values.yaml)。
完整文件逐字复制，保留上游注释，以便您无需离开文档即可阅读。

> **警告：** 以下摘录逐字复制自上游
> `values.yaml`，包括预定义的 GitHub 应用 Secret 示例中的一个已知缺陷。显示 `github_app_private_key='-----BEGIN
> CERTIFICATE-----...'` 的示例行对于实际使用是不正确的：此值必须是
> GitHub 应用私钥 PEM，而不是证书。请使用
> [方法 1：GitHub 应用（推荐）](#method-1-github-app-recommended) 中的可执行程序。

```yaml
## githubConfigUrl 是您希望配置运行器的 GitHub URL
## 例如：https://github.com/myorg/myrepo 或 https://github.com/myorg 或 https://github.com/enterprises/myenterprise
githubConfigUrl: ""

scaleSetLabels: []

## githubConfigSecret 是在通过 GitHub API 进行身份验证时使用的 k8s secret 信息。
## 您可以选择提供：
##   A) PAT 令牌，
##   B) GitHub 应用，或
##   C) 预定义的 secret。
## 每种变体的语法在下面记录。
## （变体 A）使用 PAT 令牌时，语法如下：
githubConfigSecret:
  # 示例：
  # github_token: "ghp_sampleSampleSampleSampleSampleSample"
  github_token: ""
#
## （变体 B）使用 GitHub 应用时，语法如下：
# githubConfigSecret:
#   # 注意：ID 必须是字符串，请使用引号
#   # github_app_id 可以是 app_id 或 client_id
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
## （变体 C）使用预定义的 secret。
## Secret 可以直接从 Kubernetes 中提取，或根据配置从保管库中提取。
## Kubernetes secret 在 gha-runner-scale-set 将要部署的相同命名空间中。
## 另一方面，如果配置了保管库，将使用 secret 名称来获取应用配置。
## 语法如下：
# githubConfigSecret: pre-defined-secret
## 使用预定义 Kubernetes secrets 的注意事项：
##   您需要确保您的预定义 secret 正确设置了所有必需的 secret 数据。
##   对于使用 GitHub PAT 的预定义 secret，secret 需要这样创建：
##   > kubectl create secret generic pre-defined-secret --namespace=my_namespace --from-literal=github_token='ghp_your_pat'
##   对于使用 GitHub 应用的预定义 secret，secret 需要这样创建：
##   > kubectl create secret generic pre-defined-secret --namespace=my_namespace --from-literal=github_app_id=123456 --from-literal=github_app_installation_id=654321 --from-literal=github_app_private_key='-----BEGIN CERTIFICATE-----*******'

## proxy 可用于定义控制器、监听器和此集群的运行器的代理设置。
#
# proxy:
#   http:
#     url: http://proxy.com:1234
#     credentialSecretRef: proxy-auth # 一个包含 `username` 和 `password` 键的 secret
#   https:
#     url: http://proxy.com:1234
#     credentialSecretRef: proxy-auth # 一个包含 `username` 和 `password` 键的 secret
#   noProxy:
#     - example.com
#     - example.org

## maxRunners 是自动缩放运行器集将扩展到的最大运行器数量。
# maxRunners: 5

## minRunners 是空闲运行器的最小数量。创建的目标运行器数量将计算为 minRunners 和分配给集群的作业数量之和。
# minRunners: 0

# runnerGroup: "default"

## 要创建的运行器规模集的名称。默认为图表发布名称
# runnerScaleSetName: ""

## 可以使用配置映射键选择器提供与 GitHub 服务器通信的自签名 CA 证书。如果设置了 `runnerMountPath`，对于每个运行器 Pod ARC 将：
## - 创建一个包含在 `certificateFrom` 中指定的证书的 `github-server-tls-cert` 卷
## - 在路径 `runnerMountPath`/{证书名称} 上挂载该卷
## - 将 NODE_EXTRA_CA_CERTS 环境变量设置为相同的路径
## - 将 RUNNER_UPDATE_CA_CERTS 环境变量设置为 "1"（自版本 2.303.0 起，这将指示运行器重新加载主机上的证书）
##
## 如果用户在运行器 Pod 模板中已经设置了上述任何内容，ARC 将观察这些内容并不会覆盖它们。
## 示例配置：
#
# githubServerTLS:
#   certificateFrom:
#     configMapKeyRef:
#       name: config-map-name
#       key: ca.crt
#   runnerMountPath: /usr/local/share/ca-certificates/

# keyVault:
  # 可用值：“azure_key_vault”
  # type: ""
  # 与 azure key vault 相关的配置
  # azure_key_vault:
  #   url: ""
  #   client_id: ""
  #   tenant_id: ""
  #   certificate_path: ""
    # proxy:
    #   http:
    #     url: http://proxy.com:1234
    #     credentialSecretRef: proxy-auth # 一个包含 `username` 和 `password` 键的 secret
    #   https:
    #     url: http://proxy.com:1234
    #     credentialSecretRef: proxy-auth # 一个包含 `username` 和 `password` 键的 secret
    #   noProxy:
    #     - example.com
    #     - example.org

## 容器模式是一个对象，为 dind 和 kubernetes 模式提供开箱即用的配置。
## 如果需要对 dind 或 kubernetes 模式进行任何自定义，containerMode 应保持为空，并应将配置应用于模板。
# containerMode:
#   type: "dind"  ## 类型可以设置为 "dind"、"kubernetes" 或 "kubernetes-novolume"
#   ## 当 containerMode.type=kubernetes 时，以下是必需的
#   kubernetesModeWorkVolumeClaim:
#     accessModes: ["ReadWriteOnce"]
#     # 对于本地测试，请使用 https://github.com/openebs/dynamic-localpv-provisioner/blob/develop/docs/quickstart.md 提供具有 storageClassName: openebs-hostpath 的动态供给卷
#     storageClassName: "dynamic-blob-storage"
#     resources:
#       requests:
#         storage: 1Gi
#   kubernetesModeAdditionalRoleRules: []
#

## listenerTemplate 是每个监听器 Pod 的 PodSpec
## 参考：https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#PodSpec
# listenerTemplate:
#   spec:
#     containers:
#     # 使用此部分将其他配置附加到监听器容器。
#     # 如果您更改容器的名称，则配置将不会应用于监听器，
#     # 它将被视为侧车容器。
#     - name: listener
#       securityContext:
#         runAsUser: 1000
#     # 使用此部分添加侧车容器的配置。
#     # 如果您不需要它，请将其注释掉或删除。
#     # 此容器的规范将按原样应用，而无需任何修改。
#     - name: side-car
#       image: example-sidecar

## listenerMetrics 是应用于监听器的可配置指标。
## 为了避免 helm 合并这些字段，我们将指标注释掉。
## 配置指标时，请取消注释下面的 listenerMetrics 对象。
## 您可以修改配置以删除标签或为直方图指定自定义桶。
##
## 如果未指定桶字段，将应用默认桶。默认桶在此处提供以供文档参考
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

## template 是每个运行器 Pod 的 PodSpec
## 参考：https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#PodSpec
template:
  ## template.spec 将在您更改容器模式时修改
  ## 当 containerMode.type=dind 时，我们将填充 template.spec 以包含以下 Pod 规格
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
  ## 当 containerMode.type=kubernetes 时，我们将填充 template.spec 以包含以下 Pod 规格
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
  ## 当 containerMode.type=kubernetes-novolume 时，我们将填充 template.spec 以包含以下 Pod 规格
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
  ##           value: ghcr.io/actions/actions-runner:latest # 应与运行器镜像匹配
  ##         - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
  ##           value: "true"
  spec:
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:latest
        command: ["/home/runner/run.sh"]
## 需要具有所需角色和角色绑定的可选控制器服务帐户
## 以操作此 gha-runner-scale-set 安装。
## Helm 图表将在安装时尝试查找控制器部署及其服务帐户。
## 如果 Helm 图表无法找到正确的服务帐户，您可以显式传递以下值
## 以帮助它完成与正确服务帐户的角色绑定。
## 注意：如果您的控制器仅安装为监视单个命名空间，则必须显式传递这些值。
# controllerServiceAccount:
#   namespace: arc-system
#   name: test-arc-gha-runner-scale-set-controller

# 覆盖此图表中所有资源的默认 `.Release.Namespace`。
namespaceOverride: ""

## 在 Helm 安装创建的所有资源上应用的可选注释和标签
##
## 应用于此 Helm 图表创建的所有资源的注释。注释不会覆盖默认注释，因此请确保
## 自定义注释未被保留。
# annotations:
#   key: value
##
## 应用于此 Helm 图表创建的所有资源的标签。标签不会覆盖默认标签，因此请确保
## 自定义标签未被保留。
# labels:
#   key: value

## 如果您希望对此图表创建的特定资源应用的注释进行更细粒度的控制，
## 您可以使用 `resourceMeta`。
## 应用标签和注释的顺序是：
## 1. 使用 `annotations` 和 `labels` 字段全局应用标签/注释
## 2. 应用 `resourceMeta` 标签/注释
## 3. 应用保留的标签/注释
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

## 参考文献

- [Alauda 容器平台文档](https://docs.alauda.io/) — 一般平台 UI 操作。
- [创建 GitHub 应用](https://docs.github.com/en/apps/creating-github-apps) — GitHub 应用创建步骤。
- [GitHub Actions Runner Controller（上游）](https://github.com/actions/actions-runner-controller) — 上游项目，包括完整的图表值文档。
- [自托管运行器概念](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller/about-actions-runner-controller) — GitHub 官方对 ARC 集群模式的概念介绍。
- [与自托管运行器通信](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/runners/self-hosted-runners) — GitHub 官方自托管运行器的网络通信要求，包括 `github.com`、`api.github.com` 和 `*.actions.githubusercontent.com`（[系统要求](#system-requirements) 引用）。
- [对 GitHub API 进行身份验证（ARC）](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api) — PAT 范围和细粒度权限矩阵的规范来源；引用自 [权限要求](#permission-requirements) 和 [方法 2：PAT](#method-2-personal-access-token)。
- [使用组管理对自托管运行器的访问](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access) — GitHub 官方关于运行器组、`Selected repositories`、`Selected workflows` 和企业 `Selected organizations` 的指导（[第 4 章](#chapter-4-multi-team--multi-project-isolation) 引用）。
- [在工作流中使用 ARC](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/use-arc-in-a-workflow) — 关于 `runs-on:` 字符串与数组形式及 `scaleSetLabels` 的官方指导；引用自 [工作流侧：runs-on 要求](#workflow-side-runs-on-requirements)、[工作流侧：带有 scaleSetLabels 的 runs-on 数组形式](#workflow-side-runs-on-array-form-with-scalesetlabels) 和 [问题 3](#issue-3-workflow-stays-queued-runner-never-arrives)。
