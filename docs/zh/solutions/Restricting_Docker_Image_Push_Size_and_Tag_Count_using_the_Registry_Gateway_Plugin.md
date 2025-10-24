---
kind:
  - Solution
products:
  - Alauda DevOps
ProductsVersion:
  - '4.0,4.1'
id: KB251000011
sourceSHA: f05df4ecef9cf95fa2de8b3d690a709635ed7a8602fa1762402852fb2548df5f
---

# 使用注册表网关插件限制 Docker 镜像推送大小和标签数量

## 介绍 {#introduction}

### 什么是 OCI 注册表网关

OCI 注册表的注册表网关用于限制镜像大小和标签数量。它可以为任何 OCI 注册表提供限制能力。

### 特性

- **镜像大小限制**：根据层的大小限制镜像大小。
- **标签数量限制**：限制一个仓库的标签数量。
- **全局/路径特定限制**：使用基于路径的规则限制所有仓库或特定仓库的镜像大小和标签数量。

### 架构

**在 Docker 注册表之前使用**

```
+--------------+         +---------------------+         +------------------+
|  Docker      |  <--->  |  注册表网关        |  --->   |  Docker 注册表   |
|  客户端      |         | (大小/标签限制器)  |         |                  |
+--------------+         +---------------------+         +------------------+
```

**在 Harbor 中使用**

```
+------------------+
|                  |
|  Docker 客户端   |
|                  |
+------------------+
         ^
         |
         v
+---------------------------------------------+      +---------------------------------------+
|                 Harbor                      |      |                                       |
|                                             |      |                                       |
|  +-----------------------+                  |      |                                       |
|  |       核心           |------------------+----->|   注册表网关 (大小/标签限制器)      |
|  +-----------------------+                  |      |                                       |
|                                             |      |                                       |
|  +-----------------------+                  |      |                                       |
|  |   Docker 注册表      |<-----------------+------|                                       |
|  +-----------------------+                  |      |                                       |
+---------------------------------------------+      +---------------------------------------+

```

### 实施限制

- 镜像大小限制基于层的大小，而不是解压后的镜像大小。
- 标签数量限制不稳定，特别是在并发场景中，当标签数量即将达到限制值时。但一旦超过限制，限制在并发场景中将保持稳定。

### 不支持 "Docker 镜像格式 v1 和 Docker 镜像清单版本 2" 格式

- 鉴于 Docker 已弃用 "Docker 镜像格式 v1 和 Docker 镜像清单版本 2" 格式，当前的注册表网关不支持这些格式。有关更多信息，请参阅：
  - [OCI 镜像清单](https://github.com/opencontainers/image-spec/blob/v1.0/manifest.md#image-manifest-property-descriptions)
  - [Docker 镜像清单版本 2，模式 2](https://github.com/distribution/distribution/blob/v2.8.3/docs/spec/manifest-v2-2.md#image-manifest-version-2-schema-2)
  - [Docker 已弃用模式 v1](https://github.com/distribution/distribution/blob/v2.8.3/docs/spec/deprecated-schema-v1.md)
  - [Docker 已弃用的使用镜像清单 v2，模式 1 的推送和拉取](https://docs.docker.com/engine/deprecated/#pushing-and-pulling-with-image-manifest-v2-schema-1)

## 安装 OCI 注册表网关插件 {#installing-the-oci-registry-gateway-plugin}

### 先决条件

1. 准备一台可以访问平台的 Windows、Linux 或 macOS 操作机器。推荐使用 Linux；以下说明以 Linux 为例。
2. 确保操作机器可以访问 `platform` 的网络。
3. 下载集群插件包并将其保存到操作机器的工作目录中。

:::info
在 Alauda Cloud Marketplace 中搜索 "Registry Gateway" 以找到集群插件包。
:::

### 获取上传工具

导航到 `平台管理` -> `市场` -> `上架软件包` 下载上传工具。下载后，授予二进制文件执行权限。

### 上传集群插件

> 无论您是导入新的集群插件还是更新现有插件，都可以使用相同的命令和 `upload tool`。

在您的工作目录中运行以下命令：

```bash
./violet push \
    <plugin-package> \
    --platform-address <platform-address> \
    --platform-username <platform-username> \
    --platform-password <platform-password> \
    --clusters <clusters>
```

有关 `violet push` 命令的更多详细信息，请参阅 [violet push 文档](https://docs.alauda.io/container_platform/4.0/ui/cli_tools/index.html)。

### 安装集群插件

上传集群插件后，转到 `平台管理` -> `市场` -> `集群插件`，切换到目标集群，并部署相应的集群插件。

集群插件具有以下配置参数：

**命名空间**

您希望部署注册表网关的命名空间。通常，这应该与您的 OCI 注册表部署的命名空间匹配。

如果您正在代理 Harbor，请将命名空间设置为与您的 Harbor 部署相同。

**注册表 URL**

要代理的上游注册表 URL。这可以是注册表网关可访问的 Kubernetes 服务地址。

- 对于 Harbor：将注册表 URL 设置为 Harbor 注册表服务地址，例如 `http://harbor-registry:5000`。
- 对于 Docker 注册表：将注册表 URL 设置为内部 Docker 注册表地址，例如 `http://docker-registry:5000`。

**注意：** 仅支持 HTTP 地址。

**外部 URL**

注册表网关的外部 URL。这应该与用于拉取和推送镜像到注册表的注册表 URL 匹配。

- 对于 Harbor：将外部 URL 设置为您的 Harbor 外部地址，例如 `https://harbor.example.com`。
- 对于 Docker 注册表：将外部 URL 设置为您的 Docker 注册表外部地址，例如 `https://docker-registry.example.com`。

### 配置注册表网关 {#configuring-the-registry-gateway}

#### 设置镜像大小和标签数量限制 {#setting-image-size-and-tag-count-limits}

安装集群插件后，将在目标命名空间中创建一个名为 `registry-gateway-config` 的 ConfigMap。

您可以通过两种方式配置注册表网关：

1. **全局限制：** 设置适用于所有仓库的默认限制。
2. **路径特定限制：** 使用基于路径的规则为特定仓库定义自定义限制。

对该 ConfigMap 的任何更改将立即生效。

##### 全局限制 {#global-limits}

要设置全局镜像大小和标签数量限制，请在 ConfigMap 中指定以下键：

- `max_image_size`：允许的最大镜像大小。支持单位：GB、MB、KB、B。默认值：1GB。
- `tag_count_limit`：每个仓库允许的最大标签数量。默认值：1000。

示例：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: registry-gateway-config
data:
  max_image_size: "100MB"      # 字符串值
  tag_count_limit: "100"       # 字符串值
```

所有仓库将继承这些全局限制，除非被路径特定规则覆盖。

##### 路径特定限制 {#path-specific-limits}

要为特定仓库定义自定义限制，请在 ConfigMap 中添加 `rules` 条目。每条规则由一个正则表达式 `path` 和一个 `limit` 块组成，指定镜像大小和标签数量限制。

示例：以下配置对 `project-1` 和 `project-2` 仓库应用不同的限制。

- `project-1/` 仓库的最大镜像大小限制为 20MB，最大标签数量限制为 3。
- `project-2/` 仓库的最大镜像大小限制为 50MB，最大标签数量限制为 10。

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: registry-gateway-config
data:
  max_image_size: "100MB"
  tag_count_limit: "100"
  rules: |
    - path: ^project-1/.*
      limit:
        max_image_size: "20MB"
        tag_count_limit: "3"
    - path: ^project-2/.*
      limit:
        max_image_size: "50MB"
        tag_count_limit: "10"
```

`path` 字段支持正则表达式。规则按顺序评估，应用第一个匹配的规则。如果没有规则匹配，则使用全局限制。

**注意：** 在定义路径特定规则时，必须为每条规则指定 `max_image_size` 和 `tag_count_limit`。

##### 其他示例

- 将 `project-1/` 仓库限制为 20MB 和 3 个标签。
- 将 `project-2/big-image/` 仓库限制为 5GB 和 200 个标签。
- 将 `project-2/` 仓库限制为 50MB 和 10 个标签。
- 对所有其他仓库应用默认限制 100MB 和 100 个标签。

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: registry-gateway-config
data:
  max_image_size: "100MB"
  tag_count_limit: "100"
  rules: |
    - path: ^project-1/.*
      limit:
        max_image_size: "20MB"
        tag_count_limit: "3"
    - path: ^project-2/big-image/.*
      limit:
        max_image_size: "5GB"
        tag_count_limit: "200"
    - path: ^project-2/.*
      limit:
        max_image_size: "50MB"
        tag_count_limit: "10"
```

#### 配置 Harbor 身份验证 {#configuring-harbor-authentication}

**注意：** 如果您正在代理 Docker 注册表，可以跳过此步骤。

如果您正在代理 Harbor，您必须在 Secret `registry-gateway-external-registry-secret` 中提供 Harbor 身份验证凭据。

该 Secret 应包含以下键：

- `username`：Harbor 用户名。
- `password`：Harbor 密码或机器人令牌。
- `insecure`：是否跳过证书验证或使用 HTTP 而不是 HTTPS。默认值：`false`。可选值为 `true` 或 `false`。

例如：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: registry-gateway-external-registry-secret
data:
  username: <base64-encoded-harbor-username>
  password: <base64-encoded-harbor-password>
  insecure: <base64-encoded-insecure-flag> # 可选
```

建议使用 Harbor 机器人账户生成此 Secret。机器人账户必须具有 `repository:pull` 和 `tag:list` 权限。

更新身份验证 Secret 后，重启 `registry-gateway-gateway` pod 以使更改生效：

```bash
kubectl scale deployment registry-gateway-gateway --replicas=0 -n <namespace>
kubectl scale deployment registry-gateway-gateway --replicas=1 -n <namespace>
```

#### 更改 Harbor 核心中的 Harbor 注册表 URL {#changing-the-harbor-registry-url-in-harbor-core}

**注意：** 如果您正在代理 Docker 注册表，可以跳过此步骤。

如果您正在代理 Harbor，请在 Harbor 核心 ConfigMap 中更新 Harbor 注册表地址，以指向注册表网关服务地址：

```bash
kubectl patch configmap harbor-core -n <namespace> --type=strategic -p '{"data": {"REGISTRY_URL": "http://registry-gateway-service:5000"}}'
```

如果您使用的是 Alauda Build 的 Harbor，请在 Harbor 核心 ConfigMap 中添加注释 `skip-sync: "true"`，以防止操作员还原您的更改：

```bash
kubectl patch configmap harbor-core -n <namespace> --type=strategic -p '{"metadata": {"annotations": {"skip-sync": "true"}}}'
```

更新注册表地址后，重启 Harbor 核心 pod 以使更改生效：

```bash
kubectl scale deployment harbor-core --replicas=0 -n <namespace>
kubectl scale deployment harbor-core --replicas=1 -n <namespace>
```

### 卸载集群插件 {#uninstalling-the-cluster-plugin}

要卸载集群插件，请导航到 **平台管理** → **市场** → **集群插件**，切换到目标集群，并卸载相应的集群插件。

:::warning
默认情况下，卸载集群插件还会删除 `registry-gateway-config` ConfigMap 和 `registry-gateway-external-registry-secret` Secret。

如果您使用的是 Alauda 平台，每当您修改 `registry-gateway-config` ConfigMap 或 `registry-gateway-external-registry-secret` Secret 时，都会创建一个 `ResourcePatch` 资源。

卸载集群插件不会删除 `ResourcePatch` 资源。当您重新安装集群插件时，任何现有的 `ResourcePatch` 资源将自动应用于 `registry-gateway-config` ConfigMap 和 `registry-gateway-external-registry-secret` Secret。

如果您 **不** 使用资源补丁，请记得在卸载集群插件之前备份这些资源。
:::
