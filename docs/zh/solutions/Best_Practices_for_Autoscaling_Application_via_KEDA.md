---
kind:
  - Best Practices
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251200010
sourceSHA: 243ac6b0929ad2d72150e5b6831810ac86e1a178070ca89913f0f5f7fe3c0f0f
---

# 通过 KEDA（Kubernetes 事件驱动自动扩缩）实现应用自动扩缩

## 将 ACP 监控与 Prometheus 插件集成

### 前提条件

在使用此功能之前，请确保：

- [安装 KEDA Operator](/solutions/How_to_Install_KEDA_Operator.md)
- [使用 Prometheus 插件安装 ACP 监控](https://docs.alauda.io/container_platform/4.2/observability/monitor/install_monitor.html)
- 获取当前 Kubernetes 集群的 Prometheus 端点 URL 和 secretName：
  ```bash
  PrometheusEndpoint=$(kubectl get feature monitoring -o jsonpath='{.spec.accessInfo.database.address}')
  ```
- 获取当前 Kubernetes 集群的 Prometheus secret：
  ```bash
  PrometheusSecret=$(kubectl get feature monitoring -o jsonpath='{.spec.accessInfo.database.basicAuth.secretName}')
  ```
- 在 **`<your-namespace>`** 命名空间中创建一个名为 **`<your-deployment>`** 的部署

### 操作步骤

- 在 **keda** 命名空间中配置 Prometheus 身份验证 Secret。

从 cpaas-system 复制 Secret 到 keda 命名空间的步骤

```bash
# 获取 Prometheus 身份验证信息
PrometheusUsername=$(kubectl get secret $PrometheusSecret -n cpaas-system -o jsonpath='{.data.username}' | base64 -d)
PrometheusPassword=$(kubectl get secret $PrometheusSecret -n cpaas-system -o jsonpath='{.data.password}' | base64 -d)
```

```bash
# 在 keda 命名空间中创建 secret
kubectl create secret generic $PrometheusSecret \
  -n keda \
  --from-literal=username=$PrometheusUsername \
  --from-literal=password=$PrometheusPassword
```

- 使用 **ClusterTriggerAuthentication** 配置 KEDA 对 Prometheus 访问的身份验证。

要配置 KEDA 访问 Prometheus 的身份验证凭据，请定义一个引用包含用户名和密码的 Secret 的 ClusterTriggerAuthentication 资源。以下是示例配置：

```bash
kubectl apply -f - <<EOF
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: cluster-prometheus-auth
spec:
  secretTargetRef:
    - key: username
      name: $PrometheusSecret
      parameter: username
    - key: password
      name: $PrometheusSecret
      parameter: password
EOF
```

- 使用 Prometheus 指标配置 Kubernetes 部署的自动扩缩，使用 **ScaledObject**。

要基于 Prometheus 指标扩缩 Kubernetes 部署，请定义一个引用已配置的 ClusterTriggerAuthentication 的 **ScaledObject** 资源。以下是示例配置：

```bash
kubectl apply -f - <<EOF
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: prometheus-scaledobject
  namespace: <your-namespace>
spec:
  cooldownPeriod: 300          # 扩缩后等待的时间（秒）
  maxReplicaCount: 5           # 最大副本数
  minReplicaCount: 1           # 最小副本数（注意：HPA 可能强制要求最小为 1）
  pollingInterval: 30          # 查询 Prometheus 指标的间隔（秒）
  scaleTargetRef:
    name: <your-deployment>    # 目标 Kubernetes 部署的名称
  triggers:
    - authenticationRef:
        kind: ClusterTriggerAuthentication
        name: cluster-prometheus-auth  # 引用 ClusterTriggerAuthentication
      metadata:
        authModes: basic       # 身份验证方法（在此情况下为基本身份验证）
        query: sum(container_memory_working_set_bytes{container!="POD",container!="",namespace="<your-namespace>",pod=~"<your-deployment-name>.*"})
        queryParameters: timeout=10s  # 可选查询参数
        serverAddress: $PrometheusEndpoint
        threshold: "1024000"   # 扩缩的阈值
        unsafeSsl: "true"      # 跳过 SSL 证书验证（不推荐用于生产环境）
      type: prometheus         # 触发器类型
EOF
```

### 验证

要验证 ScaledObject 是否已扩缩部署，您可以检查目标部署的副本数量：

```bash
kubectl get deployment <your-deployment> -n <your-namespace>
```

或者您可以使用以下命令检查 pod 的数量：

```bash
kubectl get pods -n <your-namespace> -l <your-deployment-label-key>=<your-deployment-label-value>
```

副本数量应根据 ScaledObject 中指定的指标增加或减少。如果部署正确扩缩，您应该看到 pod 的数量已更改为 `maxReplicaCount` 值。

## 暂停 KEDA 中的自动扩缩

KEDA 允许您暂时暂停工作负载的自动扩缩，这在以下情况下非常有用：

- 集群维护。
- 通过缩减非关键工作负载来避免资源匮乏。

### 使用当前副本立即暂停

在您的 **ScaledObject** 定义中添加以下注释，以在不更改当前副本数量的情况下暂停扩缩：

```yaml
metadata:
  annotations:
    autoscaling.keda.sh/paused: "true"
```

### 在扩缩到特定副本数量后暂停

使用此注释将工作负载扩缩到特定数量的副本，然后暂停：

```yaml
metadata:
  annotations:
    autoscaling.keda.sh/paused-replicas: "<number>"
```

### 同时设置两个注释时的行为

如果同时指定 **paused** 和 **paused-replicas**：

- KEDA 将工作负载扩缩到 **paused-replicas** 中定义的值。
- 之后暂停自动扩缩。

### 取消暂停自动扩缩

要恢复自动扩缩：

- 从 ScaledObject 中删除 paused 和 paused-replicas 注释。
- 如果仅使用了 paused: "true"，则将其设置为 false：
  ```yaml
  metadata:
    annotations:
      autoscaling.keda.sh/paused: "false"
  ```

## 扩缩到零

### 自动扩缩到零

与 HPA 不同，KEDA 可以扩缩到零。如果您在 `ScaledObject` CR 中将 minReplicaCount 值设置为 0，KEDA 将工作负载从 1 副本缩减到 0 副本，或从 0 副本扩缩到 1 副本。这被称为激活阶段。在扩缩到 1 副本后，HPA 控制扩缩。这被称为扩缩阶段。

示例 ScaledObject 配置：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: example-scaledobject
  namespace: <your-namespace>
spec:
  scaleTargetRef:
    name: example-deployment
  minReplicaCount: 0
```

### 手动扩缩到零并暂停自动扩缩

将副本指定为 `0` 并停止自动扩缩：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: example-scaledobject
  namespace: <your-namespace>
  annotations:
    autoscaling.keda.sh/paused-replicas: "0"  # 扩缩到 0 副本并暂停
```

### 验证

要验证 ScaledObject 是否已扩缩到零，您可以检查目标部署的副本数量：

```bash
kubectl get deployment <your-deployment> -n <your-namespace>
```

或者您可以检查目标部署中的 pod 数量：

```bash
kubectl get pods -n <your-namespace> -l <your-deployment-label-key>=<your-deployment-label-value>
```

pod 的数量应为零，表示部署已扩缩到零。

## 其他 KEDA 扩缩器

KEDA **扩缩器**可以检测部署是否应该激活或停用，并为特定事件源提供自定义指标。

KEDA 支持广泛的其他 **扩缩器**。有关更多详细信息，请参阅官方文档：[KEDA 扩缩器](https://keda.sh/docs/scalers/)。
