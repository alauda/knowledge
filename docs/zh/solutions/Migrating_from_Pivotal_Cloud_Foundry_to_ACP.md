---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251100002
sourceSHA: 5b96991d2921558f415554e9e9881dad26bc50f121095b71d33d851646bffacd
---

# 从 PCF（Pivotal Cloud Foundry）迁移应用程序到 ACP（Alauda Container Platform）

## 概述

将应用程序从 Pivotal Cloud Foundry (PCF) 迁移到 Alauda Container Platform (ACP) 涉及将 Cloud Foundry 特定的配置和部署模型转换为 Kubernetes 原生资源。本文档提供了使用 Move2Kube 作为主要迁移工具的全面迁移过程指南。

### 理解迁移概念

#### Cloud Foundry 架构

Cloud Foundry 使用平台即服务 (PaaS) 模型，具有构建包、应用程序和服务绑定等抽象。应用程序通过 `cf push` 命令和清单文件进行部署，平台负责容器创建和路由。

#### Kubernetes 架构

Kubernetes 使用容器编排模型，具有部署、服务和配置映射等资源。应用程序作为容器镜像进行部署，并对网络、扩展和资源管理进行明确配置。

### 迁移过程概述

从 PCF 到 ACP 的迁移涉及几个关键阶段：

| 阶段          | 描述                          | 关键活动                        |
| -------------- | ------------------------------------ | ------------------------------------- |
| 分析       | 理解 PCF 应用程序结构 | 提取元数据，识别组件 |
| 转换 | 转换为 Kubernetes 资源      | 使用 Move2Kube 生成清单   |
| 调整     | 针对 ACP 进行定制                    | 修改网络、存储、安全  |
| 部署     | 部署到 ACP                        | 构建镜像，应用清单         |
| 验证   | 验证功能               | 测试、监控、微调              |

## 先决条件

在开始迁移过程之前，请确保您具备：

1. Alauda Container Platform 环境和帐户（本指南中使用的 LDAP 帐户）
2. 在 Alauda Container Platform 中已创建项目和命名空间，并具有必要的权限
3. 访问您的 PCF 应用程序源代码（可选）和清单文件
4. [Move2Kube CLI](https://move2kube.konveyor.io/installation/) 已安装
5. [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/) 已安装
6. Cloud Foundry 命令行接口 (cf CLI) 已安装（可选）
7. `kubectl acp plugin` 已安装以进行 ACP 身份验证
8. [Skopeo](https://github.com/containers/skopeo) 已安装以进行容器镜像管理
9. 访问容器注册表以存储迁移的应用程序镜像

## 第 1 章：分析您的 PCF 应用程序

在迁移之前，您需要彻底了解您的 PCF 应用程序的结构、依赖关系和配置。

### 概念

- **PCF 清单**：定义应用程序属性、依赖关系和配置的 YAML 文件
- **构建包**：为 PCF 中的应用程序提供运行时支持
- **服务绑定**：将应用程序连接到后端服务，如数据库
- **路由**：定义流量如何到达您的应用程序

### 提取 PCF 应用程序元数据

使用 Cloud Foundry CLI 收集有关您的应用程序的详细信息：

```shell
# 登录到 PCF
cf login -a <PCF API URL> -u <username> -p <password>

# 列出目标空间中的所有应用程序
cf apps

# 获取有关您的应用程序的详细信息
cf app <app-name>

# 列出服务绑定
cf services

# 获取环境变量
cf env <app-name>

# 导出应用程序清单
cf create-app-manifest <app-name> -p manifest.yml
```

**命令说明：**

- `cf login`：使用 PCF API 进行身份验证
- `cf apps`：列出当前空间中的所有应用程序
- `cf app`：显示特定应用程序的详细信息
- `cf services`：列出所有服务实例和绑定
- `cf env`：显示应用程序的环境变量
- `cf create-app-manifest`：从现有应用程序生成清单文件

### 识别应用程序组件

查看生成的 `manifest.yml` 文件以识别关键应用程序特征：

```yaml
---
applications:
- name: sample-app
  memory: 1G
  instances: 2
  buildpacks:
  - java_buildpack
  path: target/sample-app.jar
  env:
    JBP_CONFIG_SPRING_AUTO_RECONFIGURATION: '{enabled: false}'
    SPRING_PROFILES_ACTIVE: cloud
  services:
  - mysql-db
  - redis-cache
  routes:
  - route: sample-app.apps.pcf.example.com
```

**需要识别的关键组件：**

1. **运行时要求**：使用的构建包 (`java_buildpack`)
2. **内存和扩展**：内存分配 (`1G`) 和实例数量 (`2`)
3. **服务绑定**：应用程序依赖的外部服务 (`mysql-db`, `redis-cache`)
4. **环境变量**：配置设置 (`SPRING_PROFILES_ACTIVE: cloud`)
5. **路由和域**：应用程序的访问方式 (`sample-app.apps.pcf.example.com`)

### 分析应用程序架构

记录您的应用程序架构，重点关注：

1. **微服务组件**：应用程序如何划分为服务
2. **服务依赖关系**：应用程序依赖的外部系统和数据库
3. **外部 API 集成**：使用的第三方服务和 API
4. **持久性要求**：数据存储需求和模式
5. **可扩展性需求**：应用程序在负载下如何扩展
6. **网络流量模式**：组件之间的通信

创建架构图，显示组件之间的关系，以指导您的迁移计划。

## 第 2 章：使用 Move2Kube 准备迁移

Move2Kube 是一个开源工具，通过分析源代码并生成 Kubernetes 清单，帮助将应用程序迁移到 Kubernetes。

### 概念

- **Move2Kube**：将应用程序转换为 Kubernetes 的迁移工具
- **转换计划**：指导迁移过程的配置文件
- **工件**：迁移所需的源代码、配置文件和其他资源

### 安装 Move2Kube

安装 Move2Kube CLI 工具以促进迁移过程：

```shell
# 从 GitHub 下载最新版本
curl -L https://github.com/konveyor/move2kube/releases/latest/download/move2kube-darwin-amd64 -o move2kube

# 使其可执行
chmod +x move2kube

# 移动到 PATH 中的目录
sudo mv move2kube /usr/local/bin/
```

### 分析和收集应用程序信息

在使用 Move2Kube 从 Cloud Foundry (CF) 迁移到应用程序容器平台 (ACP) 的过程中，准备必要的资源至关重要。主要有三种方法可以收集成功迁移所需的信息：

1. 源代码准备：

   - 准备内容：确保您可以访问应用程序的完整源代码。

   - 效果：这种方法允许更灵活和全面的迁移，因为 Move2Kube 可以分析代码库以生成最佳的容器化策略。适用于源代码可用且可以根据需要进行修改的应用程序。

   ```shell
   # 创建项目目录
   mkdir -p pcf-migration/<app-name>
   cd pcf-migration/<app-name>

   # 分析应用程序
   # <project-name> 是您要迁移的应用程序的名称
   # <source-path> 是您要迁移的源应用程序的路径
   move2kube plan -n <project-name> -s <source-path>
   ```

2. 工件和清单准备：

   - 准备内容：收集已编译的工件（例如 JAR 文件）以及 PCF 清单文件。

   - 效果：当源代码不可用时，此方法适用。它依赖于现有的构建工件和部署配置，可能会限制迁移过程的灵活性，但通常设置更快。

   ```shell
   # 创建项目目录
   mkdir -p pcf-migration/<app-name>
   cd pcf-migration/<app-name>

   # 分析应用程序
   # <project-name> 是您要迁移的应用程序的名称
   # <source-path> 是您要迁移的源应用程序的路径，可能包含构建工件（例如 JAR 文件）和 manifest.yml 文件
   move2kube plan -n <project-name> -s <source-path>
   ```

3. Move2Kube 收集方法：

   - 准备内容：使用 move2kube collect 命令从现有 CF 环境收集配置和部署信息。

   - 效果：这种方法有助于直接从 CF 环境捕获应用程序及其依赖关系的当前状态。它提供了现有设置的快照，这在确保在迁移过程中考虑所有必要组件时非常有用。

   - 先决条件：此方法需要安装 Cloud Foundry CLI (cf) 并使用 cf login 成功登录到您的 Cloud Foundry 实例。这是访问和收集在 Cloud Foundry 环境中运行的应用程序的运行时信息所必需的。

   > 默认情况下，`move2kube collect` 收集所有部署到 Cloud Foundry 实例的应用程序的运行时信息。但是，可能会有大量（数百或数千）应用程序部署在 Cloud Foundry 上，我们希望限制 `move2kube collect` 仅收集较小子集的应用程序信息。这也可能加快 `move2kube collect` 的执行速度，因为它不必获取所有应用程序的信息。
   > Move2Kube 可以通过 YAML 文件仅收集选定 CF 应用程序的元数据。首先，创建一个新文件夹（例如，`collect_input`），然后在新文件夹内创建一个 YAML 文件（例如，`collect_cfapps.yaml`），其中包含您要收集运行时信息的 CF 应用程序名称/ GUID。下面提供了一个示例 YAML 文件，以收集 `inventory` 和 `cfnodejsapp` 应用程序的信息。

```yaml
apiVersion: move2kube.konveyor.io/v1alpha1
kind: CfCollectApps
spec:
  filters:
    # 通过指定 CF spaceguid 从特定 CF 空间过滤应用程序
    spaceguid: dummy-cf-space-guid
  applications:
    - application:
        name: inventory
    - application:
        name: cfnodejsapp
```

```shell
# 使用以下命令登录到 CF
cf login -a <YOUR CF API endpoint>
# <collect-input-path> 是包含 CfCollectApps YAML 的目录
move2kube collect -a cf -s <collect-input-path>

# 分析应用程序
# <project-name> 是您要迁移的应用程序的名称
# <source-path> 是您要迁移的源应用程序的路径，可能包含构建工件（例如 JAR 文件）和 manifest.yml 文件
move2kube plan -n <project-name> -s <source-path>

# 我们收集的数据将存储在名为 ./m2k_collect 的新目录中。
# 将 ./m2k_collect/cf 目录移动到源目录 ./cloud-foundry
mv m2k_collect cloud-foundry/
# 分析应用程序
move2kube plan -s cloud-foundry
```

`move2kube plan` 命令将创建一个 *m2k.plan*，这实际上是一个 YAML 文件。您可以查看 *plan* 文件的内容。

```shell
cat m2k.plan
```

### 配置 Move2Kube

创建一个自定义配置文件以指导迁移过程：

```yaml
# move2kube.yaml
move2kube:
  containerization:
    default:
      dockerfileTemplate: ""
      healthCheck: true
  transformation:
    mode: directory
    services:
      enable: true
  target:
    kubernetes:
      clusterType: kubernetes
      outputPath: ""
      outputFormat: yaml
      enablePodSecurityContext: false
```

**配置说明：**

- `containerization`：控制应用程序的容器化方式
  - `healthCheck`：启用健康检查探针的生成
- `transformation`：定义应用程序的转换方式
  - `mode`：指定转换模式（基于目录）
  - `services`：启用服务发现和生成
- `target`：配置目标平台
  - `clusterType`：指定目标 Kubernetes 平台
  - `outputFormat`：定义生成资源的输出格式

## 第 3 章：将 PCF 工件转换为 Kubernetes 资源

本章指导您通过使用 Move2Kube 分析 PCF 应用程序并生成 Kubernetes 资源的过程。

### 概念

- **Kubernetes 清单**：定义 Kubernetes 资源的 YAML 文件
- **容器化**：将应用程序打包到容器中的过程
- **资源映射**：将 PCF 概念转换为 Kubernetes 等效项

### 转换您的应用程序

根据生成的计划执行转换：

```shell
# 根据计划进行转换
move2kube transform -p m2k.plan
```

在转换过程中，Move2Kube 将交互式地询问有关您的应用程序的问题。根据您应用程序的要求和目标环境回答这些问题。

**您可能会遇到的关键问题：**

1. 容器注册表选择
2. 服务绑定替换
3. Ingress/路由配置
4. 资源要求

### 审查生成的资源

转换后，Move2Kube 在输出目录中生成 Kubernetes 清单：

```shell
# 导航到生成的输出
cd m2k-output

# 列出生成的文件
ls -la
```

输出通常包括：

1. **Dockerfile(s)**：用于构建容器镜像
2. **部署清单**：用于部署应用程序容器
3. **服务定义**：用于暴露应用程序
4. **ConfigMap 和 Secret 资源**：用于配置和敏感数据
5. **Ingress/Route 定义**：用于外部访问
6. **其他相关资源**：如 PersistentVolumeClaims

仔细审查这些文件，以了解 Move2Kube 如何转换您的应用程序。

## 第 4 章：调整 Move2Kube 输出以适应 Alauda Container Platform

Move2Kube 生成的资源需要调整，以便在 Alauda Container Platform 的特定功能和要求下最佳工作。

### 概念

- **Istio Gateway**：ACP 首选的外部访问资源
- **虚拟服务**：定义请求如何路由到内部服务。与 Gateway 一起工作，将外部流量转发到集群中。
- **存储类**：定义存储供应的 Kubernetes 资源

### 暴露服务：Ingress 与 Istio Gateway

在调整 Move2Kube 输出以适应 Alauda Container Platform 时，您有两种选择来暴露服务：使用 Kubernetes Ingress 或 Istio Gateway。

#### 使用 Kubernetes Ingress

如果您选择使用 Kubernetes Ingress，并且在 Move2Kube 中选择了“Ingress”，该工具将自动生成必要的 Ingress 资源。以下是生成的 Ingress 资源的示例：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myproject
spec:
  # 请向您的平台管理员询问正确的 ingressClassName
  ingressClassName: alb
  rules:
    - host: myproject.example.com
      http:
        paths:
          - backend:
              service:
                name: provider
                port:
                  name: port-8080
            path: /
            pathType: Prefix
  tls:
    - hosts:
        - myproject.example.com
      secretName: myproject-tls-cert
```

此配置使用静态 TLS 证书。如果您需要动态证书轮换，则需要向 Ingress 资源添加 `cert-manager.io/cluster-issuer` 注释以启用此功能。请向您的平台管理员询问在注释中使用的正确颁发者名称。

#### 使用 Istio Gateway

以下示例创建一个 Gateway，监听 `example.com` 主机上的 HTTP 80 端口的流量：

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: my-gateway
  namespace: default
spec:
  selector:
  		# 可用于暴露服务的 Ingress 网关选择器
      # 请向您的平台管理员询问标签
    istio: ingressgateway
  servers:
  - port:
      number: 80
      name: http
      protocol: HTTP
    hosts:
    - "example.com"
```

#### 创建虚拟服务以使用 Gateway

此虚拟服务将请求从 Gateway 路由到名为 my-service 的内部 Kubernetes 服务，端口为 8080：

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-virtualservice
  namespace: default
spec:
  hosts:
  - "example.com"
  gateways:
  - my-gateway
  http:
  - match:
    - uri:
        prefix: /
    route:
    - destination:
        host: my-service
        port:
          number: 8080
```

### 更新容器注册表引用

更新镜像引用，以指向 Alauda Container Platform 中的目标注册表：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <app-name>
spec:
  # ...
  template:
    spec:
      containers:
      - name: <container-name>
        image: <your-registry-url>/<namespace>/<image-name>:<tag>
        # ...
```

### 处理持久卷

更新 PersistentVolumeClaim 资源，以使用 Alauda Container Platform 中可用的适当存储类：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc-name>
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: <alauda-storage-class>
```

**注意**：请咨询您的 ACP 管理员，以确定您环境中可用的存储类。

## 第 5 章：容器化应用程序组件

本章介绍构建和推送应用程序容器镜像的过程。

### 概念

- **Dockerfile**：定义如何构建容器镜像的脚本
- **容器注册表**：用于存储和分发容器镜像的库
- **镜像标签**：特定版本容器镜像的标识符

### 审查和自定义 Dockerfiles

Move2Kube 根据您的应用程序的构建包或运行时要求生成 Dockerfiles。如果需要，请审查并修改这些文件，以：

1. 优化镜像大小和层
2. 添加自定义初始化脚本
3. 配置环境变量
4. 设置适当的用户权限
5. 包含必要的依赖项

### 构建容器镜像

使用生成的 Dockerfiles 构建容器镜像：

```shell
# 导航到包含 Dockerfile 的目录
cd <app-component-dir>

# 构建容器镜像
docker build -t <your-registry-url>/<namespace>/<image-name>:<tag> .

# 登录到您的容器注册表
docker login <your-registry-url> -u <username> -p <password>

# 将镜像推送到注册表
docker push <your-registry-url>/<namespace>/<image-name>:<tag>
```

### 使用 Skopeo 进行镜像管理

如果您需要在注册表之间复制镜像，Skopeo 提供了一种方便的方法：

```shell
# 登录到源和目标注册表
skopeo login -u <username> -p <password> <source-registry>
skopeo login -u <username> -p <password> <target-registry>

# 复制镜像
skopeo copy docker://<source-registry>/<image-path>:<tag> docker://<target-registry>/<image-path>:<tag>
```

**注意**：也可以使用任何其他可以在注册表之间复制镜像的工具，例如 `docker` 或 `podman`。

**使用 Skopeo 的好处：**

1. 无需拉取和推送大型镜像
2. 在注册表之间高效传输
3. 支持各种身份验证方法
4. 能够复制特定的镜像层

## 第 6 章：将应用程序部署到 Alauda Container Platform

本章指导您将容器化应用程序部署到 Alauda Container Platform 的过程。

### 概念

- **命名空间**：Kubernetes 中用于资源隔离的虚拟集群
- **资源应用顺序**：Kubernetes 资源应应用的顺序
- **部署验证**：检查资源是否正确创建和运行

### 进行 Alauda Container Platform 身份验证

在部署资源之前，先进行 ACP 环境的身份验证：

```shell
# 登录到 ACP
kubectl acp login -u <username> -p <password> <alauda-container-platform-url> --idp=ldap

# 设置目标集群
kubectl acp set-cluster <workcluster-name>
```

### 如有需要，创建命名空间

如果您的命名空间尚不存在，请创建它：

```shell
kubectl create namespace <your-namespace>
```

### 应用 Kubernetes 清单

按照正确的顺序应用 Kubernetes 清单，以确保满足依赖关系：

```shell
# 首先应用配置资源
kubectl apply -n <your-namespace> -f configmaps/
kubectl apply -n <your-namespace> -f secrets/

# 应用服务定义
kubectl apply -n <your-namespace> -f services/

# 应用部署
kubectl apply -n <your-namespace> -f deployments/

# 应用网络资源
kubectl apply -n <your-namespace> -f networking/
```

**应用顺序说明：**

1. **配置资源**：ConfigMaps 和 Secrets 必须在引用它们的 Deployments 之前存在
2. **服务资源**：服务应在暴露它们的 Deployments 之前创建
3. **部署资源**：核心应用程序组件
4. **网络资源**：引用服务的外部访问配置

### 验证部署状态

检查所有资源是否已成功部署：

```shell
# 检查部署状态
kubectl get deployments -n <your-namespace>

# 检查 pods
kubectl get pods -n <your-namespace>

# 检查服务
kubectl get services -n <your-namespace>

# 检查 Gateway 和 VirtualService 资源
kubectl get gateway,virtualservice -n <your-namespace>
```

有关特定资源的更多详细信息：

```shell
# 获取有关部署的详细信息
kubectl describe deployment <deployment-name> -n <your-namespace>

# 检查 pod 日志
kubectl logs <pod-name> -n <your-namespace>
```

## 第 7 章：常见迁移挑战及解决方案

本章解决从 PCF 迁移到 ACP 时遇到的常见挑战，并提供实用解决方案。

### 服务绑定和配置

PCF 服务绑定需要替换为 Kubernetes 等效项：

1. **识别 PCF 应用程序中的所有服务绑定**
2. **创建等效的 Kubernetes 资源**（ConfigMaps、Secrets）
3. **更新环境变量**以匹配 Kubernetes 约定

将 PCF 环境变量转换为 ConfigMap 的示例：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: <app-name>-config
  namespace: <your-namespace>
data:
  DATABASE_URL: "jdbc:postgresql://postgres-service:5432/mydb"
  REDIS_HOST: "redis-service"
  REDIS_PORT: "6379"
```

对于敏感信息，请使用 Secrets：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: <app-name>-secrets
  namespace: <your-namespace>
type: Opaque
data:
  DATABASE_PASSWORD: <base64-encoded-password>
  API_KEY: <base64-encoded-api-key>
```

### 日志和监控适应

调整应用程序的日志以适应 Kubernetes：

1. **配置应用程序记录到 stdout/stderr**
2. **实现结构化日志**（JSON 格式）
3. **向日志事件添加相关的 Kubernetes 元数据**

为 Spring Boot 应用程序的结构化日志配置示例：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: <app-name>-logging-config
data:
  application.yml: |
    logging:
      pattern:
        console: '{"timestamp":"%d{yyyy-MM-dd HH:mm:ss.SSS}","level":"%p","thread":"%t","class":"%c{1}","message":"%m"}%n'
      level:
        root: INFO
        com.example: DEBUG
```

### 环境特定配置

使用 Kubernetes ConfigMaps 进行环境特定配置：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: <app-name>-env-config
  namespace: <your-namespace>
data:
  APP_PROFILE: "prod"
  LOG_LEVEL: "INFO"
```

将 ConfigMap 挂载为环境变量：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <app-name>
spec:
  # ...
  template:
    spec:
      containers:
      - name: <app-name>
        # ...
        envFrom:
        - configMapRef:
            name: <app-name>-env-config
```

## 结论

使用 Move2Kube 从 PCF 迁移到 Alauda Container Platform 简化了将 Cloud Foundry 应用程序转换为 Kubernetes 原生部署的过程。通过遵循本指南，您可以成功迁移应用程序，同时保留功能并利用 Alauda Container Platform 的高级功能。

迁移过程涉及几个关键阶段：

1. **分析**：理解您的 PCF 应用程序结构和依赖关系
2. **转换**：使用 Move2Kube 将 PCF 工件转换为 Kubernetes 资源
3. **调整**：为 ACP 定制生成的资源
4. **部署**：构建和部署容器化应用程序
5. **验证**：测试和微调部署

每个阶段都需要仔细的规划和执行，但结果是一个现代的、容器化的应用程序，可以充分利用 Kubernetes 的可扩展性、弹性和编排能力。

有关更详细的信息或特定应用程序类型的帮助，请参考官方 Move2Kube 文档和 Alauda Container Platform 资源。

## 参考文献

1. [Move2Kube 文档](https://move2kube.konveyor.io/)
2. [Alauda Container Platform 文档](https://docs.alauda.io/)
3. [Kubernetes 最佳实践](https://kubernetes.io/docs/concepts/configuration/overview/)
4. [Argo Rollouts 文档](https://argoproj.github.io/argo-rollouts/)
