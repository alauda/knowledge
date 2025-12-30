---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251100008
sourceSHA: 5f9136e14597e107ae9b9d6c56f6d1ea59b13b45daa854de1ca078d0ebf7375c
---

# 如何安装 Crossplane

## 概述

Crossplane 是一个用于平台工程的控制平面框架。Crossplane 允许您构建控制平面来管理您的云原生软件。它使您能够设计用户与控制平面交互所使用的 API 和抽象。

Crossplane 拥有丰富的扩展生态系统，使构建控制平面变得更快、更容易。它建立在 Kubernetes 之上，因此可以与您已经使用的所有 Kubernetes 工具兼容。

Crossplane 的关键价值在于，它解锁了构建您自己的 Kubernetes 自定义资源的好处，而无需为它们编写控制器。

官方文档：

- **主文档**： <https://www.crossplane.io/>

# 安装

## 获取上传工具

导航至 `平台管理` -> `Marketplace` -> `上架软件包` 下载名为 `violet` 的上传工具。下载后，授予二进制文件执行权限。

## 上传

下载 Crossplane 安装文件：`crossplane-ALL.2.x.tgz`

使用 `violet` 命令发布到平台仓库：

```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password=<platform-admin-password> crossplane-ALL.2.x.tgz
```

参数描述：

- `--platform-address`：ACP 平台地址。
- `--platform-username`：ACP 平台管理员用户名。
- `--platform-password`：ACP 平台管理员密码。

在 `violet` 命令执行完成后，导航至 \[public-charts] 的详细信息页面，路径为 \[管理员] -> \[Marketplace] -> \[Chart Repositories]。您将看到列出的 Crossplane chart。

## 安装

### 先决条件

- 导航至 \[项目] 页面，点击 `创建项目` 按钮。
- 提供以下信息：
  - 名称：`crossplane`
  - 集群：选择将安装 Crossplane 的集群。
- 点击 `创建项目` 按钮以创建项目。
- 导航至 \[项目] -> \[命名空间] 页面，点击 `创建命名空间` 按钮。
- 提供以下信息：
  - 集群：选择将安装 Crossplane 的集群。
  - 命名空间：`crossplane-system`
- 点击 `创建` 按钮以创建命名空间。

### 安装 Crossplane

要安装 Crossplane，请按照以下步骤操作：

- 导航至 Crossplane chart 的详细信息页面，路径为 \[管理员] -> \[Marketplace] -> \[Chart Repositories]。

- 点击 \[部署模板] 安装 Crossplane chart。

- 提供以下信息：
  - 名称：`crossplane`
  - 项目：`crossplane`
  - 命名空间：`crossplane-system`
  - Chart 版本：`2.x.x`
  - 自定义值：
  ```yaml
  replicas: 2
  image:
    repository: <platform-registry-address>/3rdparty/crossplane/crossplane
  ```
  （将 <platform-registry-address> 替换为您的实际注册表地址。平台注册表地址可以从 `global` 集群详细信息页面获取，路径为：\[管理员] -> \[集群] -> \[集群] -> \[global]）

- 点击 \[部署] 开始安装。

- 安装完成后，您可以通过运行以下命令来验证安装：
  ```bash
  $ kubectl get pods -n crossplane-system
  NAME                                       READY   STATUS    RESTARTS   AGE
  crossplane-6d67f8cd9d-g2gjw                1/1     Running   0          26m
  crossplane-rbac-manager-86d9b5cf9f-2vc4s   1/1     Running   0          26m
  ```

如果安装成功，您将看到 Crossplane 组件在 `crossplane-system` 命名空间中运行。

### 功能标志

Crossplane 在功能标志后引入新功能。默认情况下，alpha 功能是关闭的。Crossplane 默认启用 beta 功能。要启用功能标志，请在 Helm chart 中设置 args 值。可用的功能标志可以通过运行 crossplane core start --help 直接找到，或参考 Crossplane 文档 [feature-flags](https://docs.crossplane.io/latest/get-started/install/#feature-flags)。

## 卸载 Crossplane

要卸载 Crossplane，请按照以下步骤操作：

- 导航至 \[Alauda Container Platform] -> \[应用程序] -> \[应用程序] 中的 `crossplane` 应用程序详细信息页面。
- 点击 \[操作] -> \[删除] 开始卸载。
- 卸载完成后，您可以通过运行以下命令来验证卸载：
  ```bash
  $ kubectl get pods -n crossplane-system
  No resources found in crossplane-system namespace.
  ```
