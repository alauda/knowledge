---
kind:
  - Solution
products:
  - Alauda Application Services
id: KB1762160546-3B05
sourceSHA: 1eafcd21b4fc9e13c3cba64e04d9c78fa589f234dbbfcec4533eef864f4edd39
---

# 如何在 ACP 平台上使用 Node.js

## 概述

本指南解释了如何在 Alauda 容器平台 (ACP) 上开发、容器化和部署 Node.js 应用程序。提供示例源代码、容器文件、容器镜像工作流和 Kubernetes 清单（Deployment、Service）。您还将找到在 ACP 上运行 Node.js 的故障排除和最佳实践。

## Node.js 支持周期

ACP 上的 Node.js 支持周期 **与官方 Node.js 社区支持周期保持一致**，以确保安全性、稳定性和访问关键更新。Node.js 版本遵循明确的生命周期，包括三个阶段：

1. **当前**：积极添加新功能和改进；支持直到下一个主要版本发布。

2. **LTS（长期支持）**：专注于稳定性、安全补丁和错误修复；通常支持 18 个月（活动 LTS），随后再提供额外 12 个月的维护 LTS。

3. **生命周期结束（EOL）**：不再提供进一步更新（包括安全修复）；**虽然 ACP 提供 EOL Node.js 版本的技术咨询服务**，但强烈不建议在 ACP 上使用此类版本，因为这会引入安全风险和兼容性问题。

有关最新的 Node.js 支持周期详细信息（包括活动 LTS 版本、EOL 日期和发布计划），请参阅官方 Node.js 网站：[Node.js 发布计划](https://nodejs.org/en/about/releases/)

### 推荐的 Node.js 镜像仓库

为了确保遵循支持周期并访问经过验证的安全镜像，在为 ACP 构建 Node.js 容器时，请使用以下官方仓库：

1. **Node.js 社区 Docker Hub 仓库**（官方、社区维护的镜像）：

   <https://hub.docker.com/_/node>

- 包括 Alpine、Debian 和 Slim 变体（例如，`node:20-alpine`、`node:22-slim`）。

- 标签与 Node.js 版本控制保持一致（例如，`node:18.20.2` 表示特定补丁版本，`node:18-lts` 表示最新的活动 LTS 补丁）。

2. **Red Hat 公共 Node.js 仓库**：

- ACP 还支持从 Red Hat 公共镜像仓库拉取 nodejs 镜像的部署。

## 支持的平台

此支持平台列表截至其所属的分支/版本。

### 输入

Node.js 依赖于 V8 和 libuv。我们采用它们支持平台的子集。

### 策略

有三个支持级别：

- **Tier 1**：这些平台代表了大多数 Node.js 用户。Node.js 构建工作组维护基础设施以确保全面的测试覆盖。Tier 1 平台上的测试失败将阻止发布。
- **Tier 2**：这些平台代表了较小的 Node.js 用户群体。Node.js 构建工作组维护基础设施以确保全面的测试覆盖。Tier 2 平台上的测试失败将阻止发布。基础设施问题可能会延迟这些平台的二进制文件发布。
- **实验性**：可能无法编译或测试套件可能无法通过。核心团队不会为这些平台创建发布。实验性平台上的测试失败不会阻止发布。欢迎对改善这些平台支持的贡献。

平台可能会在主要发布线之间移动。下表将反映这些变化。

### 平台列表

Node.js 的编译/执行支持取决于操作系统、架构和 libc 版本。下表列出了每个受支持组合的支持级别。还提供了 [受支持的编译工具链](#supported-toolchains) 的列表，适用于 Tier 1 平台。

**对于生产应用程序，仅在受支持的平台上运行 Node.js。**

如果供应商已停止对某个平台版本的支持，则 Node.js 不支持该平台版本。换句话说，Node.js 不支持在生命周期结束（EoL）平台上运行。这一点在下表中无论如何都适用。

| 操作系统          | 架构              | 版本                              | 支持类型     | 备注                                   |
| ---------------- | ---------------- | --------------------------------- | ------------ | -------------------------------------- |
| GNU/Linux        | x64              | kernel >= 4.18[^1], glibc >= 2.28 | Tier 1       | 例如 Ubuntu 20.04、Debian 10、RHEL 8  |
| GNU/Linux        | x64              | kernel >= 3.10, musl >= 1.1.19    | 实验性       | 例如 Alpine 3.8                        |
| GNU/Linux        | x86              | kernel >= 3.10, glibc >= 2.17     | 实验性       | 自 Node.js 10 起降级                   |
| GNU/Linux        | arm64            | kernel >= 4.18[^1], glibc >= 2.28 | Tier 1       | 例如 Ubuntu 20.04、Debian 10、RHEL 8  |
| GNU/Linux        | armv7            | kernel >= 4.18[^1], glibc >= 2.28 | 实验性       | 自 Node.js 24 起降级                   |
| GNU/Linux        | armv6            | kernel >= 4.14, glibc >= 2.24     | 实验性       | 自 Node.js 12 起降级                   |
| GNU/Linux        | ppc64le >=power8 | kernel >= 4.18[^1], glibc >= 2.28 | Tier 2       | 例如 Ubuntu 20.04、RHEL 8              |
| GNU/Linux        | s390x            | kernel >= 4.18[^1], glibc >= 2.28 | Tier 2       | 例如 RHEL 8                            |
| GNU/Linux        | loong64          | kernel >= 5.19, glibc >= 2.36     | 实验性       |                                        |
| Windows          | x64              | >= Windows 10/Server 2016         | Tier 1       | [^2],[^3]                              |
| Windows          | arm64            | >= Windows 10                     | Tier 2       |                                        |
| macOS            | x64              | >= 13.5                           | Tier 1       | 有关编译的说明请参见 [^4]              |
| macOS            | arm64            | >= 13.5                           | Tier 1       |                                        |
| SmartOS          | x64              | >= 18                             | Tier 2       |                                        |
| AIX              | ppc64be >=power8 | >= 7.2 TL04                       | Tier 2       |                                        |
| FreeBSD          | x64              | >= 13.2                           | 实验性       |                                        |
| OpenHarmony      | arm64            | >= 5.0                            | 实验性       |                                        |

<!--lint disable final-definition-->

[^1]: 较旧的内核版本可能有效。然而，官方 Node.js 发布的二进制文件是在 [RHEL 8 系统上构建的](#official-binary-platforms-and-toolchains)，内核为 4.18。

[^2]: 在 Windows 上，在 Windows 终端仿真器中运行 Node.js，如 `mintty`，需要使用 [winpty](https://github.com/rprichard/winpty) 以使 tty 通道正常工作（例如 `winpty node.exe script.js`）。在 "Git bash" 中，如果您调用 node shell 别名（`node` 不带 `.exe` 扩展名），则会自动使用 `winpty`。

[^3]: Windows 子系统 Linux (WSL) 不受支持，但 GNU/Linux 构建过程和二进制文件应该有效。社区只会解决在本地 GNU/Linux 系统上重现的问题。仅在 WSL 上重现的问题应在 [WSL 问题跟踪器](https://github.com/Microsoft/WSL/issues) 中报告。在 WSL 中运行 Windows 二进制文件（`node.exe`）将无法工作，除非使用标准输入输出重定向等变通方法。

[^4]: 我们的 macOS 二进制文件以 13.5 为目标进行编译。需要 Xcode 16 进行编译。

<!--lint enable final-definition-->

### 支持的工具链

根据主机平台，工具链的选择可能会有所不同。

| 操作系统          | 编译器版本                                              |
| ---------------- | ------------------------------------------------------ |
| Linux            | GCC >= 12.2 或 Clang >= 19.1                           |
| Windows          | Visual Studio >= 2022，64 位主机上安装 Windows 10 SDK |
| macOS            | Xcode >= 16.4（Apple LLVM >= 19）                      |

### 官方二进制平台和工具链

在 <https://nodejs.org/download/release/> 上生成的二进制文件：

| 二进制包            | 平台和工具链                                          |
| ------------------- | ----------------------------------------------------- |
| aix-ppc64           | 在 PPC64BE 上使用 GCC 12 的 AIX 7.2 TL04              |
| darwin-x64          | macOS 15，Xcode 16，使用 -mmacosx-version-min=13.5   |
| darwin-arm64 (和 .pkg) | macOS 15（arm64），Xcode 16，使用 -mmacosx-version-min=13.5 |
| linux-arm64         | RHEL 8，使用 Clang 19.1 和 gcc-toolset-14-libatomic-devel[^6] |
| linux-ppc64le       | RHEL 8，使用 Clang 19.1 和 gcc-toolset-14-libatomic-devel[^6] |
| linux-s390x         | RHEL 8，使用 Clang 19.1 和 gcc-toolset-14-libatomic-devel[^6] |
| linux-x64           | RHEL 8，使用 Clang 19.1 和 gcc-toolset-14-libatomic-devel[^6] |
| win-arm64           | Windows Server 2022 (x64)，使用 Visual Studio 2022   |
| win-x64             | Windows Server 2022 (x64)，使用 Visual Studio 2022   |

[^5]: 在这些系统上生成的二进制文件需要 libstdc++12，可从 \[AIX toolbox]\[] 获取。

[^6]: 在这些系统上生成的二进制文件与 glibc >= 2.28 和 libstdc++ >= 6.0.25 (`GLIBCXX_3.4.25`) 兼容。这些在本地支持 GCC 8.1 或更高版本的发行版上可用，例如 Debian 10、RHEL 8 和 Ubuntu 20.04。

#### OpenSSL asm 支持

OpenSSL-1.1.1 在 x86_64 和 ia32 上使用 asm 支持需要以下汇编器版本。

对于 AVX-512 的使用，

- gas（GNU 汇编器）版本 2.26 或更高
- Windows 上的 nasm 版本 2.11.8 或更高

AVX-512 在 Skylake-X 上被 OpenSSL-1.1.1 禁用。

对于 AVX2 的使用，

- gas（GNU 汇编器）版本 2.23 或更高
- Xcode 版本 5.0 或更高
- llvm 版本 3.3 或更高
- Windows 上的 nasm 版本 2.10 或更高

有关详细信息，请参阅 <https://docs.openssl.org/1.1.1/man3/OPENSSL_ia32cap/>。

如果在没有上述之一的情况下进行编译，请使用 `configure` 和 `--openssl-no-asm` 标志。否则，`configure` 将失败。

## 先决条件

- 访问 ACP 实例和用户凭据。
- 已配置并登录到您的 ACP 集群的 kubectl 和 kubectl-acp。
- Podman 或兼容的容器构建工具，并访问您的 ACP 集群可以拉取的镜像注册表（镜像仓库地址和凭据）。
- 对 Node.js 和 npm 有基本的了解。

## 示例 Node.js 应用程序

创建一个最小的 Express 应用程序。保存为 `app.js`：

```js
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello from Node.js on ACP!');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

创建一个最小的 `package.json`：

```json
{
  "name": "acp-nodejs-sample",
  "version": "1.0.0",
  "main": "app.js",
  "scripts": {
    "start": "node app.js"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}
```

### 容器文件

使用 node:22-alpine 构建一个小型生产镜像：

```
FROM node:22-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "app.js"]
```

## 构建并推送镜像

1. 在本地构建镜像（将 `<registry>` 和 `<repo>` 替换为您的注册表地址）：

```bash
podman build -t <registry>/<repo>/acp-nodejs-sample:1.0.0 .
```

2. 将镜像推送到您的注册表（确保凭据已配置）：

```bash
podman push <registry>/<repo>/acp-nodejs-sample:1.0.0
```

如果您的组织使用平台工具发布镜像（例如 `violet push`），请遵循您平台的标准镜像发布工作流，并注意最终镜像 URL。

## 准备 ACP 命名空间和镜像拉取密钥

1. 登录 ACP 并选择集群/命名空间：

```bash
kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name> --namespace=<namespace-name>
```

2. 如有必要，创建项目/命名空间：

```bash
kubectl acp create project <project-name> --cluster=<cluster-name>
kubectl acp process namepace-quota-limit -n cpaas-system -p NAMESPACE=<namespace-name> -p PROJECT=<project-name> -p CLUSTER=<cluster-name> | kubectl acp apply -f -
```

3. 创建镜像拉取密钥，以便集群可以拉取您的镜像（适当替换凭据）：

```bash
kubectl create secret docker-registry regcred \
  --docker-server=<registry> \
  --docker-username=<username> \
  --docker-password=<password> \
  --docker-email=<email> \
  -n <namespace-name>
```

## Kubernetes 清单（Deployment + Service）

将以下内容保存为 `deployment-nodejs.yaml`。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: acp-nodejs-sample
  labels:
    app: acp-nodejs-sample
spec:
  replicas: 2
  selector:
    matchLabels:
      app: acp-nodejs-sample
  template:
    metadata:
      labels:
        app: acp-nodejs-sample
    spec:
      imagePullSecrets:
      - name: regcred
      containers:
      - name: nodejs
        image: <registry>/<repo>/acp-nodejs-sample:1.0.0
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        livenessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"

---
apiVersion: v1
kind: Service
metadata:
  name: acp-nodejs-service
spec:
  selector:
    app: acp-nodejs-sample
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: ClusterIP
```

在您的命名空间中应用清单：

```bash
kubectl acp apply -f deployment-nodejs.yaml -n <namespace-name>
```

## 使用 ACP 应用程序（UI）进行部署

ACP 还支持从目录创建应用程序或通过上传清单。步骤（UI）：

1. 在 ACP 控制台中，转到目标命名空间并单击应用程序 → 创建。
2. 选择从 YAML/清单创建或从目录创建（如果您打包了应用程序图表）。
3. 提供 `deployment-nodejs.yaml` 和任何配置值（镜像标签、副本等）。
4. 从应用程序监控面板创建并监控部署。

## 扩展和更新

- 要扩展副本：

```bash
kubectl scale deployment acp-nodejs-sample --replicas=4 -n <namespace-name>
```

- 要执行滚动更新（镜像更改）：

```bash
kubectl set image deployment/acp-nodejs-sample nodejs=<registry>/<repo>/acp-nodejs-sample:1.0.1 -n <namespace-name>
```

ACP 将在 UI 中显示发布状态；您还可以使用以下命令进行监控：

```bash
kubectl rollout status deployment/acp-nodejs-sample -n <namespace-name>
```

## 故障排除

- 查看 pod 日志：

```bash
kubectl logs -l app=acp-nodejs-sample -n <namespace-name>
```

- 进入正在运行的 pod 进行调试：

```bash
kubectl exec -it $(kubectl get pod -l app=acp-nodejs-sample -n <namespace-name> -o jsonpath='{.items[0].metadata.name}') -n <namespace-name> -- /bin/sh
```

- 常见问题：
  - 镜像拉取错误：确认 `regcred` 存在且镜像 URL 正确。
  - CrashLoopBackOff：检查 `NODE_ENV`、缺少环境变量或应用程序启动错误。
  - 就绪探针失败：在应用程序预热期间增加 initialDelaySeconds。

## 最佳实践

- 如果您编译本地模块或希望获得更小的镜像，请使用多阶段构建。
- 固定 Node.js 基础镜像版本并整理依赖项以减少漏洞。
- 配置存活/就绪探针和资源请求/限制。
- 使用 ConfigMaps 和 Secrets 进行配置和敏感数据管理。
- 使用滚动更新和就绪门控以避免更新期间的停机。

## 示例快速命令

```bash
# 构建并推送
podman build -t <registry>/<repo>/acp-nodejs-sample:1.0.0 .
podman push <registry>/<repo>/acp-nodejs-sample:1.0.0

# 创建密钥（一次性）
kubectl create secret docker-registry regcred --docker-server=<registry> --docker-username=<user> --docker-password=<pw> -n <namespace-name>

# 部署
kubectl acp apply -f deployment-nodejs.yaml -n <namespace-name>

# 检查状态
kubectl get pods -l app=acp-nodejs-sample -n <namespace-name>
kubectl logs -l app=acp-nodejs-sample -n <namespace-name>
```

## 注意事项

本文件为在 ACP 上运行 Node.js 工作负载提供了一个起点。对于生产部署，请考虑添加可观察性（Prometheus 指标、跟踪）、安全镜像扫描和与 ACP 目录集成的 CI/CD 管道。
