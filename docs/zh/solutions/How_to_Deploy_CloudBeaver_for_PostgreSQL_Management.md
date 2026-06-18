---
kind:
   - How To
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515008
sourceSHA: e84115331a26da1f333d7e670c2f23f9970f7e06f98f168db22f6b0646ca7e5c
---

# 如何部署 CloudBeaver 以管理 PostgreSQL

## 问题

你需要一个基于 Web 的 SQL 客户端，用于浏览和查询由 Alauda Application Services 管理的 PostgreSQL 实例，而无需在每位运维人员的工作站上安装桌面工具。CloudBeaver 是 DBeaver 的开源 Web 版本，作为单 Pod 的 Deployment 运行在 Kubernetes 上。本文档部署 CloudBeaver 并将其连接到由 PostgreSQL Operator 管理的 PostgreSQL 集群。

## 环境

- 任意运维人员可访问的 Kubernetes 集群（下文使用 NodePort 暴露；Ingress / Route 同样适用）
- 能够供给 ReadWriteOnce PVC 的 `StorageClass`——用于在 Pod 重启间持久化 CloudBeaver 工作区状态
- 从 CloudBeaver Pod 到目标 PostgreSQL Service（`<cluster>` 的 5432 端口）的网络可达性

## 解决方案

### 1. 准备清单

将以下内容保存为 `cloudbeaver.yaml`。根据环境调整 `storageClassName`、镜像仓库与资源请求：

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
  storageClassName: sc-topolvm     # 替换为集群中任意可用的 RWO StorageClass
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

> CloudBeaver 将其管理员密码、已保存的连接和查询历史存储在 `/opt/cloudbeaver/workspace` 下。没有持久卷，所有内容都会在每次 Pod 重启时丢失。应用前请确认所选 `storageClassName` 在目标集群中存在。

> **隔离网络 / 仅 IPv6 集群：** 公共镜像 `docker-mirrors.alauda.cn/dbeaver/cloudbeaver:latest` 可能从集群内无法访问。请先将其镜像到集群自身的仓库，并在 Deployment 中引用该路径，例如 `skopeo copy docker://docker-mirrors.alauda.cn/dbeaver/cloudbeaver:latest docker://<cluster-registry>/dbeaver/cloudbeaver:latest`。

### 2. 部署

```bash
kubectl -n <namespace> apply -f cloudbeaver.yaml
kubectl -n <namespace> rollout status deploy/cloudbeaver
```

### 3. 获取访问地址

Service 使用 NodePort，因此任意节点 IP 加上分配的 NodePort 即可访问 UI：

```bash
namespace=<namespace>
HOST=$(kubectl -n "$namespace" get pod -l app=cloudbeaver \
        -o jsonpath='{.items[0].status.hostIP}')
PORT=$(kubectl -n "$namespace" get svc cloudbeaver \
        -o jsonpath='{.spec.ports[0].nodePort}')
echo "http://$HOST:$PORT"
```

在浏览器中打开该地址。

### 4. 初始设置

1. 首次启动时，CloudBeaver 会提示设置管理员密码。请选择强密码并妥善保存——该账户管理后续所有服务端配置。
2. 使用管理员用户登录。
3. （可选）在右上角用户菜单中切换 UI 语言。

### 5. 连接 PostgreSQL 实例

1. 点击 **New Connection** 并选择 **PostgreSQL**。
2. **Host** 填写集群 Service 名称，**Port** 填写 `5432`。集群内部主机为 `<cluster>.<namespace>`（读写 Service）；`<cluster>-repl` Service 指向副本。从集群外部访问时，获取 NodePort 或 LoadBalancer 地址：

   ```bash
   kubectl -n <pg-namespace> get svc <cluster>
   ```

3. 输入数据库用户与密码。`postgres` 超级用户密码以环境变量 / Secret 形式存在于集群中：

   ```bash
   kubectl exec -n <pg-namespace> <cluster>-0 -c postgres -- \
     bash -c 'echo $PGPASSWORD_SUPERUSER'
   ```

4. （可选）将 **Database** 设置为目标数据库；否则 CloudBeaver 连接到默认的 `postgres` 数据库。
5. 在 **Access Management** 中，授予当前 CloudBeaver 用户使用该新连接的权限。
6. 保存并测试连接。此后即可从浏览器打开 SQL 编辑器并对 PostgreSQL 集群执行查询。

### 6. 卸载

```bash
kubectl -n <namespace> delete -f cloudbeaver.yaml
```

PVC 会随清单的其余部分一并删除。若要为将来重新部署保留 CloudBeaver 状态，仅删除 Deployment 与 Service，并在下次安装时重新挂载现有 PVC。
