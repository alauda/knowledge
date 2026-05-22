---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500126
sourceSHA: 0a7a89eafed2ff591999dbca88f93ff0c42eb563564f80ea97e22677b14f91b5
---

# RabbitMQ Exporter 指标收集解决方案

## 背景

`rabbitmq_exporter` 从 RabbitMQ 管理 API 收集指标，并通过 `/metrics` 以 Prometheus 格式暴露这些指标。

该解决方案将导出器作为外部组件部署：

- 不修改 RabbitMQ operator 逻辑
- 每个 RabbitMQ 实例部署一个导出器
- 通过 Kubernetes `Service` 暴露指标
- 通过 `ServiceMonitor` 与 Prometheus Operator 集成

## 架构

```text
Prometheus
  |
  v
ServiceMonitor
  |
  v
Service/<exporter>:9419
  |
  v
Deployment/<exporter>
  |
  v
RabbitMQ Management API
```

一个导出器仅支持一个 `RABBIT_URL`，因此一个 RabbitMQ 实例通常需要一个导出器部署。

## 先决条件

- RabbitMQ 集群已存在
- 已启用 `rabbitmq_management` 插件
- 管理 API 可通过端口 `15672` 访问
- 一个 RabbitMQ 账户可以访问管理 API
- 如果将使用 `ServiceMonitor`，则需要安装 Prometheus Operator

RabbitMQ 集群 Operator 通常会创建一个名为：

```text
<rabbitmq-name>-default-user
```

## 部署

### 部署资源

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <exporter-name>
  namespace: <namespace>
  labels:
    app.kubernetes.io/name: <exporter-name>
    app.kubernetes.io/part-of: <rabbitmq-name>
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: <exporter-name>
  template:
    metadata:
      labels:
        app.kubernetes.io/name: <exporter-name>
        app.kubernetes.io/part-of: <rabbitmq-name>
    spec:
      containers:
        - name: exporter
          image: registry.alauda.cn:60070/middleware/rabbitmq-exporter:v4.1.1
          imagePullPolicy: IfNotPresent
          ports:
            - name: metrics
              containerPort: 9419
          env:
            - name: RABBIT_URL
              value: http://<rabbitmq-name>.<namespace>.svc:15672
            - name: RABBIT_USER
              valueFrom:
                secretKeyRef:
                  name: <default-user-secret>
                  key: username
            - name: RABBIT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: <default-user-secret>
                  key: password
            - name: RABBIT_CONNECTION
              value: loadbalancer
            - name: RABBIT_EXPORTERS
              value: exchange,node,queue,aliveness
            - name: PUBLISH_PORT
              value: "9419"
            - name: LOG_LEVEL
              value: info
            - name: RABBIT_TIMEOUT
              value: "30"
          readinessProbe:
            httpGet:
              path: /health
              port: metrics
          livenessProbe:
            httpGet:
              path: /
              port: metrics
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
```

### 重要环境变量

| 变量                | 描述                                             |
| ------------------- | ------------------------------------------------- |
| `RABBIT_URL`        | RabbitMQ 管理 API URL                            |
| `RABBIT_USER`       | 管理用户名                                       |
| `RABBIT_PASSWORD`   | 管理密码                                         |
| `RABBIT_CONNECTION` | 通过 Service 访问时使用 `loadbalancer`          |
| `RABBIT_EXPORTERS`  | 启用的指标模块                                   |
| `PUBLISH_PORT`      | 导出器指标端口                                   |
| `RABBIT_TIMEOUT`    | 管理 API 超时（秒）                             |

常见模块：

- `exchange`
- `node`
- `queue`
- `aliveness`
- `connections`
- `shovel`
- `federation`
- `memory`

推荐的默认模块：

```text
exchange,node,queue,aliveness
```

## Service 和 ServiceMonitor

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: <exporter-name>
  namespace: <namespace>
  labels:
    app.kubernetes.io/name: <exporter-name>
spec:
  type: ClusterIP
  ports:
    - name: metrics
      port: 9419
      targetPort: metrics
  selector:
    app.kubernetes.io/name: <exporter-name>
```

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: <exporter-name>
  namespace: <namespace>
  labels:
    app.kubernetes.io/name: <exporter-name>
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: <exporter-name>
  endpoints:
    - port: metrics
      path: /metrics
      interval: 60s
      scrapeTimeout: 30s
```

注意事项：

- `ServiceMonitor.metadata.labels` 必须与 Prometheus 实例的 `serviceMonitorSelector` 匹配。
- 如果您的平台 Prometheus 使用不同的选择器，请相应调整标签，例如 `release: kube-prometheus`。
- `endpoints[].port` 必须与 Service 端口名称匹配，即 `metrics`。

## 验证

检查 pod 状态和日志：

```bash
kubectl -n <namespace> get pod -l app.kubernetes.io/name=<exporter-name>
kubectl -n <namespace> logs deploy/<exporter-name> --tail=100
```

创建测试队列并发布消息：

```bash
RABBIT_USER=$(kubectl -n <namespace> get secret <default-user-secret> -o go-template='{{index .data "username" | base64decode}}')
RABBIT_PASSWORD=$(kubectl -n <namespace> get secret <default-user-secret> -o go-template='{{index .data "password" | base64decode}}')

kubectl -n <namespace> exec <rabbitmq-name>-server-0 -- \
  rabbitmqadmin --host localhost --port 15672 \
  --username "$RABBIT_USER" --password "$RABBIT_PASSWORD" \
  declare queue name=<check-queue> durable=true
```

检查指标：

```bash
kubectl -n <namespace> exec deploy/<exporter-name> -- sh -c \
  "wget -qO- http://localhost:9419/metrics | grep '^rabbitmq_' | head"
```

## 有用的指标

| 指标                                     | 含义                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `rabbitmq_up`                            | 导出器可以访问 RabbitMQ                        |
| `rabbitmq_module_up{module="queue"}`     | 队列模块抓取健康状态                           |
| `rabbitmq_queue_messages_ready`          | 队列中的准备消息数量                           |
| `rabbitmq_queue_messages_unacknowledged` | 未确认的消息数量                               |
| `rabbitmq_queue_consumers`               | 消费者数量                                     |
| `rabbitmq_queue_state`                   | 队列状态，例如 `running`、`idle` 或 `flow`   |
| `rabbitmq_node_mem_used`                 | 节点内存使用量                                 |
| `rabbitmq_node_disk_free`                | 可用磁盘字节数                                 |
| `rabbitmq_shovel_state`                  | 启用铲子模块时的铲子状态                       |

## 推荐的警报

```text
rabbitmq_up == 0
```

```text
rabbitmq_module_up{module="queue"} == 0
```

```text
rabbitmq_queue_state{state="flow"} == 1
```

```text
rabbitmq_queue_messages_ready > 0
```

```text
rabbitmq_queue_consumers == 0
```

## 风险和限制

- 一个导出器只能抓取一个 RabbitMQ 管理端点
- 通过 Service 获取的队列指标可能依赖于所选后端节点的管理视图
- `connections` 模块可能会产生高基数指标
- `/health` 反映的是导出器抓取状态，而不是完整的 RabbitMQ 业务健康状况

## 资源推荐

推荐的生产资源：

```yaml
resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 256Mi
```

## 卸载

```bash
kubectl -n <namespace> delete servicemonitor <exporter-name>
kubectl -n <namespace> delete service <exporter-name>
kubectl -n <namespace> delete deployment <exporter-name>
```
