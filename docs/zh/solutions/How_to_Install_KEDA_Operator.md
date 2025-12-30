---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251200009
sourceSHA: 7e6f3f1965f799d89972888a1b8b012f384b5d8e3d852854949386edd434c1da
---

# 如何安装 KEDA Operator

## 概述

通过 [**KEDA(Kubernetes 事件驱动的自动扩缩)**](https://keda.sh/)，您可以根据需要处理的事件数量驱动 Kubernetes 中任何容器的扩缩。

### 介绍

KEDA 是一个单一用途且轻量级的组件，可以添加到任何 Kubernetes 集群中。KEDA 与标准 Kubernetes 组件（如 [水平 Pod 自动扩缩](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)）协同工作，可以扩展功能而不覆盖或重复。使用 KEDA，您可以明确映射希望使用事件驱动扩缩的应用程序，而其他应用程序继续正常运行。这使得 KEDA 成为与任何数量的其他 Kubernetes 应用程序或框架并行运行的灵活且安全的选择。

有关更多详细信息，请参阅官方文档：[Keda 文档](https://keda.sh/docs/)

### 优势

**KEDA 的核心优势：**

- **简化的自动扩缩：** 为您的 Kubernetes 集群中的每个工作负载带来丰富的扩缩功能
- **事件驱动：** 智能扩缩您的事件驱动应用程序
- **内置扩缩器：** 提供70多个内置扩缩器的目录，适用于各种云平台、数据库、消息系统、遥测系统、CI/CD 等
- **多种工作负载类型：** 支持多种工作负载类型，如部署、作业和自定义资源，具有 **/scale** 子资源
- **减少环境影响：** 通过优化工作负载调度和零扩缩构建可持续平台
- **可扩展：** 自定义扩缩器或使用社区维护的扩缩器
- **供应商无关：** 支持跨多种云提供商和产品的触发器
- **Azure Functions 支持：** 在生产工作负载中在 Kubernetes 上运行和扩缩您的 Azure Functions

### KEDA 的工作原理

KEDA 监控外部事件源，并根据需求调整您的应用程序资源。其主要组件协同工作以实现这一目标：

1. **KEDA Operator** 跟踪事件源，并根据需求上下调整应用程序实例的数量
2. **Metrics Server** 向 Kubernetes 的 HPA 提供外部指标，以便其做出扩缩决策
3. **Scalers** 连接到消息队列或数据库等事件源，提取当前使用情况或负载的数据
4. **自定义资源定义 (CRDs)** 定义应用程序如何根据队列长度或 API 请求速率等触发器进行扩缩

简单来说，KEDA 监听 Kubernetes 外部发生的事情，获取所需的数据，并相应地扩缩您的应用程序。它高效且与 Kubernetes 集成良好，以动态处理扩缩。

#### KEDA 自定义资源定义 (CRDs)

KEDA 使用 **自定义资源定义 (CRDs)** 来管理扩缩行为：

- **ScaledObject**：将您的应用程序（如 Deployment 或 StatefulSet）链接到外部事件源，定义扩缩的工作方式
- **ScaledJob**：通过根据外部指标扩缩作业来处理批处理任务
- **TriggerAuthentication**：提供安全访问事件源的方法，支持环境变量或云特定凭据等方法

这些 CRDs 使您能够控制扩缩，同时保持应用程序的安全性和对需求的响应。

**ScaledObject 示例**：

以下示例针对整个 Pod 的 CPU 利用率。如果 Pod 有多个容器，则将是其中所有容器的总和。

```yaml
kind: ScaledObject
metadata:
  name: cpu-scaledobject
  namespace: <your-namespace>
spec:
  scaleTargetRef:
    name: <your-deployment>
  triggers:
  - type: cpu
    metricType: Utilization # 允许的类型为 'Utilization' 或 'AverageValue'
    metadata:
      value: "50"
```

## 安装

### 获取上传工具

导航到 `平台管理` -> `市场` -> `上架软件包` 下载名为 `violet` 的上传工具。下载后，授予二进制文件执行权限。

### 上传 KEDA Operator 包

下载 KEDA 安装文件：`keda.stable.*.tgz`

使用 `violet` 命令发布到平台仓库：

```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password=<platform-admin-password> keda.stable.*.tgz
```

参数说明：

- `--platform-address`：ACP 平台地址
- `--platform-username`：ACP 平台管理员用户名
- `--platform-password`：ACP 平台管理员密码

### 通过命令行安装

#### 安装 KEDA Operator

如果 KEDA operator 的命名空间不存在，请创建命名空间：

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: "keda"
EOF
```

运行以下命令在目标集群中安装 KEDA Operator：

```bash
kubectl apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  annotations:
    cpaas.io/target-namespaces: ""
  labels:
    catalog: platform
  name: keda
  namespace: keda
spec:
  channel: stable
  installPlanApproval: Automatic
  name: keda
  source: custom
  sourceNamespace: cpaas-system
  startingCSV: keda.v2.17.2
EOF
```

配置参数：

| **参数**                    | **推荐配置**                                                                                     |
| :------------------------- | :----------------------------------------------------------------------------------------------- |
| **metadata.name**          | `keda`：订阅名称设置为 **keda**。                                                                |
| **metadata.namespace**     | `keda`：订阅命名空间设置为 **keda**。                                                            |
| **spec.channel**           | `stable`：默认通道设置为 **stable**。                                                            |
| **spec.installPlanApproval** | `Automatic`：**升级** 操作将自动执行。                                                           |
| **spec.name**              | `keda`：操作员包名称，必须为 **keda**。                                                          |
| **spec.source**            | `custom`：keda operator 的目录源，必须为 **custom**。                                          |
| **spec.sourceNamespace**   | `cpaas-system`：目录源的命名空间，必须为 **cpaas-system**。                                    |
| **spec.startingCSV**       | `keda.v2.17.2`：keda operator 的起始 CSV 名称。                                                 |

#### 创建 KedaController 实例

在命名空间 keda 中创建名为 keda 的 KedaController 资源：

```bash
kubectl apply -f - <<EOF
apiVersion: keda.sh/v1alpha1
kind: KedaController
metadata:
  name: keda
  namespace: keda
spec:
  admissionWebhooks:
    logEncoder: console
    logLevel: info
  metricsServer:
    logLevel: "0"
  operator:
    logEncoder: console
    logLevel: info
  serviceAccount: null
  watchNamespace: ""
EOF
```

### 通过 Web 控制台安装

#### 安装 KEDA Operator

1. 登录并导航到 **管理员** 页面
2. 点击 **市场** > **OperatorHub**
3. 找到 **KEDA** operator，点击 **安装**，进入 **安装** 页面

配置参数：

| **参数**                 | **推荐配置**                                                                                                                                 |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| **通道**                 | `stable`：默认通道设置为 **stable**。                                                                                                        |
| **版本**                 | 请选取最新版本。                                                                                                                              |
| **安装模式**             | `Cluster`：单个 Operator 在集群中所有命名空间共享，用于实例创建和管理，从而降低资源使用。                                                    |
| **安装位置**             | `推荐`：如果不存在，将自动创建。                                                                                                              |
| **升级策略**             | 请选取 `Auto`。 <ul><li>**升级** 操作将自动执行。</li></ul>                                                                                   |

4. 在 **安装** 页面，选择默认配置，点击 **安装**，完成 **KEDA** Operator 的安装。

#### 创建 KedaController 实例

1. 点击 **市场** > **OperatorHub**

2. 找到已安装的 **KEDA** operator，导航到 **所有实例**

3. 点击 **创建实例** 按钮，并在资源区域点击 **KedaController** 卡片

4. 在实例的参数配置页面，您可以使用默认配置，除非有特定要求

5. 点击 **创建**

### 验证

实例成功创建后，等待几分钟，然后使用以下命令检查 KEDA 组件是否已在运行：

```bash
kubectl get pods -n keda -w
NAME                                     READY   STATUS    RESTARTS      AGE
keda-admission-56f9d8f45b-f67fg          1/1     Running   0             1h
keda-metrics-apiserver-7989cf4c9-9ljzt   1/1     Running   0             1h
keda-olm-operator-58f695f5fd-p2kh4       1/1     Running   0             1h
keda-operator-5c779f7f7-8b6h5            1/1     Running   0             1h
```

### 其他场景

#### 集成 ACP 日志收集器

- 确保目标集群中安装了 **ACP 日志收集器插件**。请参考 <ExternalSiteLink name="logs" href="/install_log.html#install-alauda-container-platform-log-collector-plugin" children="安装 Alauda Container Platform 日志收集器插件" />
- 在安装 **ACP 日志收集器插件** 时启用 **平台** 日志开关
- 使用以下命令为 **keda** 命名空间添加标签：
  ```bash
  kubectl label namespace keda cpaas.io/product=Container-Platform --overwrite
  ```

### 卸载 KEDA Operator

#### 删除 KedaController 实例

```bash
kubectl delete kedacontroller keda -n keda
```

#### 通过 CLI 卸载 KEDA Operator

```bash
kubectl delete subscription keda -n keda
```

#### 通过 Web 控制台卸载 KEDA Operator

要卸载 KEDA Operator，请点击 **市场** > **OperatorHub**，选择已安装的操作员 **KEDA**，然后点击 **卸载**。
