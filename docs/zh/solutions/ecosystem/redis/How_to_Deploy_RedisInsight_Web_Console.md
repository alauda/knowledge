---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500091
sourceSHA: f3d86f5a7bf53e9ff877ad14607cecd46596a3787237d85fbe6c96256874a65e
---

# 如何部署 RedisInsight Web 控制台

## 介绍

RedisInsight 是一个用于与 Redis 数据库交互的图形用户界面。它支持键浏览、对标准数据结构的 CRUD 操作、JSON 编辑、慢日志分析、Pub/Sub、大批量操作以及用于高级命令的工作台。本指南解释了如何在 Kubernetes 集群中部署 RedisInsight 2.58 并将其连接到 Sentinel 和集群模式的 Redis 实例。

:::warning
RedisInsight 不包含内置的身份验证或授权。一旦服务被暴露，任何能够访问 URL 的人都可以连接并操作附加的 Redis 实例。请在网络或负载均衡器层限制访问。
:::

## 先决条件

- 一个具有 `kubectl` 访问权限的 Kubernetes 集群。
- 一个可用的持久存储 `StorageClass`。
- RedisInsight 镜像在您的镜像注册表中可用。从 Docker Hub 拉取 `redis/redisinsight:2.58`（`https://hub.docker.com/r/redis/redisinsight`）并推送到您的私有注册表。

## 操作步骤

### 1. 准备镜像

将 RedisInsight 镜像拉取并推送到您的注册表。如果需要，请在部署 YAML 中替换 `image` 字段为注册表特定路径。

### 2. 应用部署 YAML

将以下清单保存为 `redis-insight.yaml`。根据您的环境调整 `storageClassName` 和资源限制。

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  labels:
    app.kubernetes.io/name: redis-insight
  name: redis-insight-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: <your-storage-class>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app.kubernetes.io/name: redis-insight
  name: redis-insight
spec:
  replicas: 1
  revisionHistoryLimit: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: redis-insight
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app.kubernetes.io/name: redis-insight
    spec:
      containers:
        - env:
            - name: RI_APP_PORT
              value: "5540"
            - name: RI_APP_HOST
              value: "0.0.0.0"
            - name: RI_ENCRYPTION_KEY
              value: ""
            - name: RI_LOG_LEVEL
              value: info
            - name: RI_FILES_LOGGER
              value: "false"
            - name: RI_STDOUT_LOGGER
              value: "true"
            - name: RI_PROXY_PATH
              value: ""
          image: redis/redisinsight:2.58
          imagePullPolicy: IfNotPresent
          name: web
          ports:
            - name: http
              containerPort: 5540
              protocol: TCP
          resources:
            limits:
              cpu: 1
              memory: 1Gi
            requests:
              cpu: 500m
              memory: 500Mi
          livenessProbe:
            failureThreshold: 3
            initialDelaySeconds: 10
            periodSeconds: 10
            successThreshold: 1
            httpGet:
              path: /api/health/
              port: http
            timeoutSeconds: 5
          startupProbe:
            failureThreshold: 3
            initialDelaySeconds: 10
            periodSeconds: 10
            successThreshold: 1
            tcpSocket:
              port: http
            timeoutSeconds: 5
          securityContext:
            readOnlyRootFilesystem: true
            runAsUser: 1000
            runAsNonRoot: true
            runAsGroup: 1000
          volumeMounts:
            - mountPath: /data
              name: redis-insight-data
      restartPolicy: Always
      securityContext:
        fsGroup: 1000
      terminationGracePeriodSeconds: 30
      volumes:
        - name: redis-insight-data
          persistentVolumeClaim:
            claimName: redis-insight-data
---
apiVersion: v1
kind: Service
metadata:
  labels:
    app.kubernetes.io/name: redis-insight
  name: redis-insight
spec:
  ports:
    - name: http
      port: 5540
      protocol: TCP
      targetPort: http
  selector:
    app.kubernetes.io/name: redis-insight
  type: NodePort
```

:::note
容器、Pod 端口和服务端口均设置为 **5540**（自 2.x 起为 RedisInsight 的默认值）。`targetPort: http` 解析为命名的容器端口，因此这三个值保持一致。
:::

部署资源：

```bash
kubectl -n <namespace> create -f redis-insight.yaml
```

### 3. 环境变量参考

RedisInsight 镜像支持以下环境变量：

| 名称                 | 描述                                                                                       | 默认值   |
| -------------------- | ------------------------------------------------------------------------------------------ | -------- |
| `RI_APP_PORT`        | RedisInsight 监听的端口                                                                    | `5540`   |
| `RI_APP_HOST`        | RedisInsight 监听的地址                                                                    | `0.0.0.0` |
| `RI_SERVER_TLS_KEY`  | TLS 私钥                                                                                   | (空)     |
| `RI_SERVER_TLS_CERT` | TLS 密钥的 TLS 证书                                                                        | (空)     |
| `RI_ENCRYPTION_KEY`  | 用于本地存储的敏感数据的加密密钥（数据库密码、工作台历史等）                                | (空)     |
| `RI_LOG_LEVEL`       | 日志级别                                                                                   | `info`   |
| `RI_FILES_LOGGER`    | 将日志写入文件                                                                             | `true`   |
| `RI_STDOUT_LOGGER`   | 将日志写入标准输出                                                                         | `true`   |
| `RI_PROXY_PATH`      | 在反向代理后运行时的子路径                                                                 | (空)     |

## 访问 RedisInsight

### 通过 NodePort

提供的清单将 RedisInsight 作为 `NodePort` 服务暴露。计算一个可外部访问的 URL：

```bash
namespace="<namespace>"
echo "http://$(kubectl -n $namespace get pods -l app.kubernetes.io/name=redis-insight -o jsonpath='{.items[0].status.hostIP}'):$(kubectl -n $namespace get svc redis-insight -o jsonpath='{.spec.ports[0].nodePort}')"
```

### 通过负载均衡器 (ALB)

在 **Container Platform > Networking > Load Balancers** 中，创建一个规则，将流量转发到 `redis-insight` 服务。使用负载均衡器的地址访问 RedisInsight。

## 连接到 Redis

打开 RedisInsight URL 并接受 EULA 后，使用 **添加 Redis 数据库**。

### Sentinel 模式

1. 输入 Sentinel 地址（如果 RedisInsight 与 Redis 同处于集群内部，则为集群内部地址，否则为外部地址）。可以留空密码：从 operator 版本 3.18 开始支持 Sentinel 密码。
2. 配置从节点连接：根据需要设置 **数据库别名**、**密码** 和 **数据库索引**。
3. 选择要将实例添加到的组。
4. 从左上角的 logo 返回主页。新实例将出现在列表中。点击条目以检查和编辑数据。

### 集群模式

1. 输入任何集群节点的地址（集群内部或外部）。
2. RedisInsight 自动检测集群模式并将实例添加到列表中。
3. 点击实例条目以检查和编辑数据。

## 数据操作

- **浏览**：点击实例以查看其键。使用过滤器缩小结果。
- **编辑**：选择一个键以在右侧窗格中查看其值并进行就地编辑。
- **批量操作**：从实例详细视图中，在左侧导航中打开 **工作台** 以一次运行多个命令。

## 卸载

要删除 RedisInsight 部署：

```bash
# 删除部署
kubectl -n <namespace> delete deployment redis-insight
# 删除服务
kubectl -n <namespace> delete svc redis-insight
# 删除持久卷声明
kubectl -n <namespace> delete pvc redis-insight-data
```

## 重要注意事项

- **无内置身份验证**：通过集群防火墙、入口身份验证或 VPN 限制对 RedisInsight 的网络访问。将 RedisInsight 视为特权管理工具。
- **存储类可用性**：在应用清单之前确认 `storageClassName` 在集群中存在。如有需要，请替换为其他存储类。
- **资源大小**：默认限制（1 CPU / 1 GiB）适合小型到中型环境。如果您预计有许多并发用户或大型数据集，请增加它们。
- **镜像来源**：对于隔离环境，请确保在部署之前将 RedisInsight 镜像镜像到您的内部注册表。
- **参考**：上述操作步骤基于 RedisInsight 2.58。其他版本的 UI 元素可能略有不同。请参阅 [官方 RedisInsight 文档](https://redis.io/docs/latest/develop/connect/insight/) 获取最新指导。
