---
kind:
  - How To
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515005
sourceSHA: db41533c9b71724ded7f79e618595b1abe6d21c13b4de87d565d1e08ef9bd633
---

# 如何部署 CloudBeaver 以管理 MySQL

## 问题

您需要一个基于 Web 的 SQL 客户端，用于浏览和查询由 Alauda Application Services 管理的 MySQL 实例，而无需在每个操作员的工作站上安装桌面工具。CloudBeaver 是 DBeaver 的开源 Web 版本，并作为单个 Pod 部署在 Kubernetes 上。本文将介绍如何部署 CloudBeaver 并将其连接到 MySQL Group Replication (MGR) 实例。

## 环境

- 任何可供操作员访问的 Kubernetes 集群（下面使用 NodePort 暴露；Ingress 同样有效）
- 一个能够提供 ReadWriteOnce PVC 的 `StorageClass` — 用于在 Pod 重启之间持久化 CloudBeaver 工作区状态
- CloudBeaver Pod 与目标 MySQL Router 服务之间的网络可达性

## 解决方案

### 1. 准备清单

将以下内容保存到 `cloudbeaver.yaml`。根据您的环境调整 `storageClassName`、镜像注册表和资源请求：

```yaml
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cloudbeaver
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: sc-topolvm     # 替换为集群中可用的任何 RWO StorageClass
  volumeMode: Filesystem
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudbeaver
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cloudbeaver
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: cloudbeaver
    spec:
      containers:
        - name: cloudbeaver
          image: docker-mirrors.alauda.cn/dbeaver/cloudbeaver:latest
          imagePullPolicy: Always
          ports:
            - name: web
              containerPort: 8978
              protocol: TCP
          resources:
            limits:
              cpu: "1"
              memory: 1Gi
            requests:
              cpu: 100m
              memory: 256Mi
          volumeMounts:
            - name: cloudbeaver-data
              mountPath: /opt/cloudbeaver/workspace
      volumes:
        - name: cloudbeaver-data
          persistentVolumeClaim:
            claimName: cloudbeaver
---
apiVersion: v1
kind: Service
metadata:
  name: cloudbeaver
spec:
  type: NodePort
  selector:
    app: cloudbeaver
  ports:
    - name: web
      port: 8978
      targetPort: 8978
      protocol: TCP
```

> CloudBeaver 将其管理员密码、保存的连接和查询历史存储在 `/opt/cloudbeaver/workspace` 下。没有持久卷，所有内容将在每次 Pod 重启时丢失。在应用之前，请确认所选的 `storageClassName` 在目标集群中存在。

### 2. 部署

```bash
kubectl -n <namespace> apply -f cloudbeaver.yaml
kubectl -n <namespace> rollout status deploy/cloudbeaver
```

### 3. 查找访问 URL

该服务使用 NodePort，因此任何节点 IP 加上分配的 NodePort 都可以访问 UI：

```bash
namespace=<namespace>
HOST=$(kubectl -n "$namespace" get pod -l app=cloudbeaver \
        -o jsonpath='{.items[0].status.hostIP}')
PORT=$(kubectl -n "$namespace" get svc cloudbeaver \
        -o jsonpath='{.spec.ports[0].nodePort}')
echo "http://$HOST:$PORT"
```

在浏览器中打开该 URL。

### 4. 初始设置

1. 在首次启动时，CloudBeaver 会提示您设置管理员密码。选择一个强密码并安全存储 — 此帐户管理所有后续的服务器端配置。
2. 使用管理员用户登录。
3. （可选）在右上角的用户菜单中切换 UI 语言。

### 5. 连接到 MySQL 实例

1. 点击 **新建连接** 并选择 **MySQL**。

2. 在 **主机** 中填写目标 MGR 实例的 Router 服务，并在 **端口** 中填写读写端口。从集群外部，检索 NodePort：

   ```bash
   kubectl -n <mysql-namespace> get svc <instance>-router
   ```

3. 输入应用数据库用户和密码。

4. 在 **驱动程序属性** 下，将 `allowPublicKeyRetrieval` 设置为 `TRUE`，以便 MySQL 8 驱动程序能够完成针对非 TLS 端点的 `caching_sha2_password` 握手。请勿在不受信任的网络上启用此选项 — 它允许客户端通过未加密的通道检索服务器的公钥。

5. 在 **访问管理** 下，授予当前 CloudBeaver 用户使用新连接的权限。

6. 保存并测试连接。现在可以从浏览器打开 SQL 编辑器并对 MGR 集群执行查询。

### 6. 卸载

```bash
kubectl -n <namespace> delete -f cloudbeaver.yaml
```

PVC 将与清单的其余部分一起删除。要保留 CloudBeaver 状态以便将来重新部署，请仅删除 Deployment 和 Service，并在下次安装时重新附加现有 PVC。
