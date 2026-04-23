---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB260400014
sourceSHA: d96d5f4ab1186230dc845c4ed102d9460ee1f04a9e18fb15562a1b0a9c66f2ee
---

# 如何使用社区 Percona Operator 部署 MongoDB

## 概述

本指南将引导您在 Alauda 容器平台上使用上游 **社区** [Percona Server for MongoDB Operator](https://github.com/percona/percona-server-mongodb-operator) 部署 MongoDB。之前捆绑的 Alauda MongoDB 插件不再通过 ACP 市场分发，因此本指南提供了使用社区版本的自助路径。

**验证版本**（在 ACP 4.2 / Kubernetes 1.33 上验证；请查看上游文档以获取更新版本）：

| 组件                               | 版本                  |
| :---------------------------------- | :-------------------- |
| Percona Server for MongoDB Operator | `1.22.0`              |
| MongoDB                             | `6.0` / `7.0` / `8.0` |

> **注意**
> Operator `1.22.0` 不支持 MongoDB `4.x` 或 `5.x`。如果您需要较旧的 MongoDB 主版本，请查阅 [Percona 系统要求页面](https://docs.percona.com/percona-operator-for-mongodb/System-Requirements.html) 以获取支持的 operator 版本。

有关 operator 功能的背景信息，请参见：

- [Percona Operator for MongoDB 文档](https://docs.percona.com/percona-operator-for-mongodb/index.html)
- [OperatorHub.io 列表](https://operatorhub.io/operator/percona-server-mongodb-operator)

## 先决条件

- 一个具有 `cluster-admin` 访问权限的 ACP 4.x 集群。
- 针对目标集群配置的 `kubectl`。
- 一个目标命名空间（在下面称为 `<NS>`）。
- 一个具有动态 PVC 配置的 `StorageClass`。如果您希望在集群 CR 中省略 `storageClassName`，请将其标记为默认存储类。
- 一个集群节点可以拉取的私有容器注册表，并具有推送到该注册表的凭据。
- 一台可以从 `docker.io` 拉取并推送到您的私有注册表的工作站。`skopeo` 或 `docker` 都可以使用。

## 步骤 1：将所需镜像镜像到您的私有注册表

ACP 集群节点通常无法直接从 `docker.io` 拉取。您必须先将 operator 和操作员镜像镜像到您的私有注册表中。

本指南使用的四个镜像流：

| 目的        | `docker.io` 上的源                          | 标签         |
| :----------- | :---------------------------------------- | :---------- |
| Operator     | `percona/percona-server-mongodb-operator` | `1.22.0`    |
| MongoDB 6.0  | `percona/percona-server-mongodb`          | `6.0.27-21` |
| MongoDB 7.0  | `percona/percona-server-mongodb`          | `7.0.30-16` |
| MongoDB 8.0  | `percona/percona-server-mongodb`          | `8.0.19-7`  |
| 备份 (PBM)   | `percona/percona-backup-mongodb`          | `2.12.0`    |

您只需要您打算部署的版本的 MongoDB 镜像。PBM 镜像是可选的，除非您启用备份。

### 选项 A：skopeo（推荐）

`skopeo` 直接在注册表之间复制镜像，无需本地 Docker 守护进程，并保留多架构清单。

```bash
PRIVATE_REGISTRY="<your-private-registry>"          # 例如 registry.example.com
skopeo login "$PRIVATE_REGISTRY"                    # 如果您的注册表需要身份验证

for img in \
  percona/percona-server-mongodb-operator:1.22.0 \
  percona/percona-server-mongodb:6.0.27-21 \
  percona/percona-server-mongodb:7.0.30-16 \
  percona/percona-server-mongodb:8.0.19-7 \
  percona/percona-backup-mongodb:2.12.0 ; do
    skopeo copy --all \
      "docker://docker.io/$img" \
      "docker://$PRIVATE_REGISTRY/$img"
done
```

`--all` 标志会复制多架构标签的每个平台变体。

### 选项 B：docker pull / tag / push

```bash
REGISTRY_SERVER="<your-registry-host>"               # 例如 registry.example.com:443
PRIVATE_REGISTRY="$REGISTRY_SERVER/<your-project>"   # 例如 registry.example.com:443/middleware
docker login "$REGISTRY_SERVER"

for img in \
  percona/percona-server-mongodb-operator:1.22.0 \
  percona/percona-server-mongodb:8.0.19-7 ; do
    docker pull  "docker.io/$img"
    docker tag   "docker.io/$img" "$PRIVATE_REGISTRY/$img"
    docker push  "$PRIVATE_REGISTRY/$img"
done
```

> **注意**
> 选项 B 仅镜像本地主机的架构。如果您的集群可能是 ARM64、x86_64 或混合架构，请使用选项 A 和 `skopeo copy --all` 来保留多架构标签的每个平台变体。

### 使用 ACP 集成的 Harbor 注册表

如果您将镜像推送到与 ACP 一起提供的 Harbor 注册表（典型端点 `https://<acp-portal-host>:45443`），则推送凭据存储在管理集群的 Secret 中——它们与您的 ACP 门户登录不同：

```bash
# 读取 Harbor 管理员凭据
REG_USER=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.username}' | base64 -d)
REG_PASS=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.password}' | base64 -d)

REGISTRY_SERVER="<acp-portal-host>:45443"            # 例如 acp.example.com:45443
PRIVATE_REGISTRY="$REGISTRY_SERVER/<your-harbor-project>"   # 例如 acp.example.com:45443/middleware
skopeo login -u "$REG_USER" -p "$REG_PASS" --tls-verify=false "$REGISTRY_SERVER"

# skopeo copy 调用 — 注意 --dest-tls-verify=false 用于自签名证书
for img in \
  percona/percona-server-mongodb-operator:1.22.0 \
  percona/percona-server-mongodb:8.0.19-7 \
  percona/percona-backup-mongodb:2.12.0 ; do
    skopeo copy --all --dest-tls-verify=false \
      "docker://docker.io/$img" \
      "docker://$PRIVATE_REGISTRY/$img"
done
```

## 步骤 2：创建镜像拉取 Secret

如果您的私有注册表需要身份验证（ACP 集成的 Harbor 需要），集群节点在没有凭据的情况下无法拉取镜像。在目标命名空间中创建一个 `kubernetes.io/dockerconfigjson` Secret，稍后您将把它附加到 operator 部署和集群 CR。

`--docker-server` 必须仅是注册表 **主机**（没有项目路径）。对于 ACP Harbor，这就是您在步骤 1 中分配给 `REGISTRY_SERVER` 的值——例如 `acp.example.com:45443`，而不是 `acp.example.com:45443/middleware`。

设置三个变量以用于您的注册表，然后创建 Secret。如果您来自步骤 1 的 ACP-Harbor 部分，您已经设置了这些；否则现在定义它们：

```bash
REGISTRY_SERVER="<your-registry-host>"     # 例如 registry.example.com:443（仅主机 — 无项目路径）
REG_USER="<registry-username>"
REG_PASS="<registry-password>"

# 对于 ACP 集成的 Harbor，具体来说，从管理集群的
# registry-admin Secret 中填充 REG_USER / REG_PASS（见步骤 1 的 Harbor 部分）：
#   REG_USER=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.username}' | base64 -d)
#   REG_PASS=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.password}' | base64 -d)

kubectl -n <NS> create secret docker-registry acp-registry-pull \
  --docker-server="$REGISTRY_SERVER" \
  --docker-username="$REG_USER" \
  --docker-password="$REG_PASS"
```

如果您的注册表允许匿名拉取，请跳过此步骤并省略步骤 4 和 5 中显示的 `imagePullSecrets` 字段。

## 步骤 3：配置命名空间 Pod 安全性

默认的 Percona operator 和 `mongod` pod 规格不满足 Kubernetes Pod 安全准入 `restricted` 配置文件。在安装之前将目标命名空间重新标记为 `baseline`（或更宽松）：

```bash
kubectl label ns <NS> \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/audit=baseline \
  pod-security.kubernetes.io/warn=baseline --overwrite
```

这是最常见的安装失败点。跳过此步骤会产生提交流程错误，提到 `seccompProfile` 或 `capabilities`。

## 步骤 4：安装 Operator

下载上游的 `bundle.yaml`，将 operator 镜像重写为您的私有注册表，并应用。

```bash
PRIVATE_REGISTRY="<your-private-registry>"

curl -sL -o bundle.yaml \
  https://raw.githubusercontent.com/percona/percona-server-mongodb-operator/v1.22.0/deploy/bundle.yaml

# 可移植的镜像重写（适用于 GNU sed 和 BSD sed / macOS）
sed "s|image: percona/|image: $PRIVATE_REGISTRY/percona/|g" bundle.yaml > bundle.patched.yaml \
  && mv bundle.patched.yaml bundle.yaml

kubectl -n <NS> apply -f bundle.yaml --server-side
```

如果您在步骤 2 中创建了镜像拉取 Secret，请在等待部署完成之前将其附加到 operator 部署：

```bash
kubectl -n <NS> patch deployment percona-server-mongodb-operator --type=strategic -p \
  '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"acp-registry-pull"}]}}}}'
```

等待 operator 启动：

```bash
kubectl -n <NS> rollout status deploy/percona-server-mongodb-operator --timeout=120s
```

验证：

```bash
kubectl -n <NS> get pods                # operator pod 应该在运行
kubectl get crd | grep psmdb            # 应该存在三个 CRD
```

预期的 CRD：

- `perconaservermongodbs.psmdb.percona.com`
- `perconaservermongodbbackups.psmdb.percona.com`
- `perconaservermongodbrestores.psmdb.percona.com`

## 步骤 5：创建 MongoDB 集群

### 5a. 创建用户 Secret

该 operator 管理五个内置用户。创建一个包含其凭据的 Secret；集群 CR 通过名称引用它。

```bash
kubectl -n <NS> apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: my-mongo-secrets
type: Opaque
stringData:
  MONGODB_BACKUP_USER: backup
  MONGODB_BACKUP_PASSWORD: <change-me>
  MONGODB_DATABASE_ADMIN_USER: databaseAdmin
  MONGODB_DATABASE_ADMIN_PASSWORD: <change-me>
  MONGODB_CLUSTER_ADMIN_USER: clusterAdmin
  MONGODB_CLUSTER_ADMIN_PASSWORD: <change-me>
  MONGODB_CLUSTER_MONITOR_USER: clusterMonitor
  MONGODB_CLUSTER_MONITOR_PASSWORD: <change-me>
  MONGODB_USER_ADMIN_USER: userAdmin
  MONGODB_USER_ADMIN_PASSWORD: <change-me>
EOF
```

> **重要**
> 在任何非测试环境中应用之前，请将每个 `<change-me>` 替换为强密码。

### 5b. 创建集群 CR

选择您想要的 MongoDB 镜像标签；替换 `<PRIVATE_REGISTRY>` 和 `<storage-class>`。如果您在步骤 2 中创建了镜像拉取 Secret，请保留 `imagePullSecrets` 字段；否则将其删除。

```yaml
apiVersion: psmdb.percona.com/v1
kind: PerconaServerMongoDB
metadata:
  name: my-mongo
spec:
  crVersion: 1.22.0
  image: <PRIVATE_REGISTRY>/percona/percona-server-mongodb:8.0.19-7   # 或 7.0.30-16 / 6.0.27-21
  imagePullPolicy: IfNotPresent
  imagePullSecrets:
  - name: acp-registry-pull
  unsafeFlags:
    replsetSize: true     # size: 1 时必需（仅用于测试 — 生产环境中请删除）
    mongosSize: true
  upgradeOptions:
    apply: disabled
  secrets:
    users: my-mongo-secrets
  replsets:
  - name: rs0
    size: 1               # 生产环境：3 或更多
    volumeSpec:
      persistentVolumeClaim:
        storageClassName: <storage-class>
        resources:
          requests:
            storage: 10Gi
  sharding:
    enabled: true
    configsvrReplSet:
      size: 1             # 生产环境：3 或更多
      volumeSpec:
        persistentVolumeClaim:
          storageClassName: <storage-class>
          resources:
            requests:
              storage: 10Gi
    mongos:
      size: 1             # 生产环境：2 或更多
  backup:
    enabled: false
    image: <PRIVATE_REGISTRY>/percona/percona-backup-mongodb:2.12.0
```

使用 `kubectl -n <NS> apply -f cluster.yaml` 应用。

有关完整的自定义资源字段参考和所有可用选项（TLS、监控、备份等），请参见 [Percona Operator 自定义资源参考](https://docs.percona.com/percona-operator-for-mongodb/operator.html)。

### 5c. 等待集群准备就绪

```bash
kubectl -n <NS> get psmdb -w
```

等待 `STATUS=ready`。在健康的存储上，集群在 ~60 秒内达到就绪状态。

```text
NAME       ENDPOINT                                            STATUS   AGE
my-mongo   my-mongo-mongos.<NS>.svc.cluster.local:27017        ready    55s
```

## 步骤 6：访问集群

检索 `userAdmin` 密码并对 mongos 路由器运行非交互式烟雾测试：

```bash
PASS=$(kubectl -n <NS> get secret my-mongo-secrets \
  -o jsonpath='{.data.MONGODB_USER_ADMIN_PASSWORD}' | base64 -d)

kubectl -n <NS> exec my-mongo-mongos-0 -c mongos -- mongosh --quiet \
  -u userAdmin -p "$PASS" --authenticationDatabase admin \
  --eval 'print(JSON.stringify({version: db.version(), hello: db.hello().msg}))'
```

预期输出：`{"version":"8.0.19-7","hello":"isdbgrid"}`（当您通过分片的 mongos 路由器连接时，`msg` 为 `isdbgrid`，或者当直接连接到副本集成员时，`msg` 为主副本集名称）。

要获得交互式 shell：

```bash
kubectl -n <NS> exec -it my-mongo-mongos-0 -c mongos -- \
  mongosh -u userAdmin -p "$PASS" --authenticationDatabase admin
```

要进行外部客户端访问，请对 mongos 服务进行端口转发：

```bash
kubectl -n <NS> port-forward svc/my-mongo-mongos 27017:27017
```

然后使用 `mongodb://userAdmin:<password>@localhost:27017/?authSource=admin` 连接任何 MongoDB 客户端。

## 限制

本指南的范围是基线部署：安装 operator，将其连接到您的私有注册表，创建一个分片 MongoDB 集群，并运行访问烟雾测试。备份、TLS、监控和其他高级功能在下面的表中作为单独的后续路径进行了记录。

为了明确期望：

- **Alauda 验证的** 功能已在代表性的 ACP 集群（ACP 4.2 / Kubernetes 1.33，operator v1.22.0）上进行了端到端测试。它们按此处记录的方式工作。
- **未经过 Alauda 验证的** 功能可能有效，但 Alauda 尚未在 ACP 上测试它们。如果您的用例依赖于它们，请将上游 Percona 文档视为权威，并在依赖它们用于生产之前在您自己的环境中验证。

### Alauda 验证的功能

| 领域                       | 测试内容                                                                                                                                                                                                 |
| :------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator 安装             | 通过 `kubectl` 应用捆绑，镜像重写到私有注册表，命名空间 operator（单命名空间监视）                                                                                                                                  |
| MongoDB 版本               | 6.0 (`6.0.27-21`)、7.0 (`7.0.30-16`)、8.0 (`8.0.19-7`) — 每个分片集群达到 `ready`                                                                                                                               |
| 集群拓扑                   | 副本集（大小 1、3、5）和分片集群（`rs0` + `cfg` + `mongos`）                                                                                                                                                      |
| 内置用户配置               | 从 `secrets.users` Secret 创建的所有五个 operator 管理的用户（`userAdmin`、`databaseAdmin`、`clusterAdmin`、`clusterMonitor`、`backup`）                                                                                     |
| 故障转移 / 重新选举        | 杀死主节点触发重新选举；数据和副本集成员资格得以保留                                                                                                                                                             |
| 逻辑备份 + 恢复           | `PerconaServerMongoDBBackup` 到 S3 兼容的 MinIO；`PerconaServerMongoDBRestore` 正确将数据库恢复到备份点                                                                                                        |
| 通过 cert-manager 的 TLS   | `tls.issuerConf` 引用 ACP `ClusterIssuer`（例如 `cpaas-ca`）；operator 创建 `Certificate` CR，颁发证书，强制执行 `requireTLS`，mongosh 通过 TLS 连接                                                                 |
| 智能升级                   | 从 MongoDB 7.0 到 8.0 的 `spec.image` 补丁触发滚动重启（次要节点优先，主节点最后）；数据和副本集健康得以保留                                                                                                   |
| PVC 调整大小               | 在 `spec.enableVolumeExpansion: true` 和具有 `allowVolumeExpansion: true` 的 `StorageClass` 下，增加 `volumeSpec.persistentVolumeClaim.resources.requests.storage` 会传播到底层 PVC，而无需重启 pod |
| 副本扩展                   | `replsets.rs0.size` 3 → 5（干净加入 + 初始同步）和 5 → 3（干净退役）                                                                                                                                               |
| ACP 私有注册表            | 通过 `skopeo copy --all` 将镜像镜像到 ACP 集成的 Harbor，并使用附加的 `imagePullSecret` 拉取它们                                                                                                                 |

### 未经过 Alauda 验证的功能

建议客户在生产使用之前独立验证以下任何功能：

| 功能                                                             | 开始位置                                                                                                                                        |
| :---------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| 物理和增量备份                                                  | [备份和恢复 — 物理备份](https://docs.percona.com/percona-operator-for-mongodb/backups.html)                                                       |
| 时间点恢复 (PITR)                                               | [时间点恢复](https://docs.percona.com/percona-operator-for-mongodb/backups-pitr.html)                                                           |
| LDAP 身份验证                                                   | [LDAP 集成](https://docs.percona.com/percona-operator-for-mongodb/ldap.html)                                                                     |
| HashiCorp Vault 用于静态加密密钥                               | [使用 Vault 进行静态数据加密](https://docs.percona.com/percona-operator-for-mongodb/encryption.html)                                             |
| PMM（Percona 监控和管理）                                       | [使用 PMM 监控](https://docs.percona.com/percona-operator-for-mongodb/monitoring.html)                                                           |
| 多集群 / 跨站点分片集群                                         | [多集群部署](https://docs.percona.com/percona-operator-for-mongodb/replication.html) — 需要多个联邦 Kubernetes 集群                                   |
| 分片集群的智能升级（配置服务器 + mongos 部署）                 | [升级 MongoDB 版本](https://docs.percona.com/percona-operator-for-mongodb/update.html) — 仅验证了普通副本集升级                                   |
| 链式主版本升级（例如 6.0 → 7.0 → 8.0）                          | 同上游指南 — 仅验证了 7.0 → 8.0 的单跳升级；每次执行一个主版本跳跃，并在每次跳跃后重新验证                                                      |
| 混乱 / 网络分区自愈                                             | 超出简单的主 pod 故障转移；未进行测试                                                                                                             |

### 支持的 MongoDB 版本

Operator `1.22.0` 仅支持 MongoDB **6.0、7.0 和 8.0**。**MongoDB 4.x 和 5.x 不受支持。** 运行支持 MongoDB 4.x/5.x 的较旧 operator 版本是可能的，但这些 operator 版本不再在 OperatorHub.io 上发布，并且不接收上游修复。

### Operator 升级

本指南**不涵盖** operator 本身的升级（例如 `1.22.0` → 将来的 `1.23.x`）。步骤 4 中的镜像重写 + 捆绑应用模式将重新安装新版本的 operator，但真实的升级流程必须遵循上游程序，以避免破坏正在进行的 CR。请参见 [更新 Percona Operator for MongoDB](https://docs.percona.com/percona-operator-for-mongodb/update.html#update-percona-operator-for-mongodb)。

### 镜像注册表

集群节点通常无法直接访问 `docker.io`。该过程假定您已经将所需的 Percona 镜像镜像到您的节点可以拉取的私有注册表中（步骤 1）。如果您的注册表策略随后驱逐了镜像标签，则 operator 和集群将在下次重新创建 pod 时出现故障。

本指南中固定的镜像标签在发布日期时经过验证。新的补丁版本会定期在上游出现 — 定期通过检查 [Percona 系统要求页面](https://docs.percona.com/percona-operator-for-mongodb/System-Requirements.html) 重新镜像最新支持的补丁。

### 支持模型

本指南部署了 Percona Server for MongoDB Operator 的 **上游社区版本**。它不在 ACP 市场中捆绑或支持。有关 operator 本身的错误报告和功能请求应提交至 [上游 Percona 问题跟踪器](https://github.com/percona/percona-server-mongodb-operator/issues)。Alauda 支持可以帮助解决平台级问题（存储、网络、注册表、PSA），但不负责 operator 的协调行为。

## 重要考虑事项

- **生产规模。** 示例 CR 为开发/测试规模（每个角色一个 pod）。对于生产环境，请删除 `unsafeFlags`，设置 `replsets.rs0.size: 3`、`sharding.configsvrReplSet.size: 3` 和 `sharding.mongos.size: 2` 或更多。检查 CPU/内存请求、反亲和性规则和 `PodDisruptionBudget`。
- **启用 PVC 调整大小。** 增加 `volumeSpec.persistentVolumeClaim.resources.requests.storage` 默认情况下是 **无操作**。要让 operator 将存储增加传播到底层 PVC，请在 `PerconaServerMongoDB` CR 上设置 `spec.enableVolumeExpansion: true`。您的 StorageClass 还必须具有 `allowVolumeExpansion: true`。
- **PVC 保留。** 删除 `PerconaServerMongoDB` 资源不会 **删除** 其 PVC。要释放存储：
  ```bash
  kubectl -n <NS> delete pvc -l app.kubernetes.io/instance=my-mongo
  ```
- **备份、TLS 和监控。** 本文未涵盖；请参见 [上游 Percona Operator 文档](https://docs.percona.com/percona-operator-for-mongodb/index.html)。
- **Operator 升级。** 请遵循 [上游升级指南](https://docs.percona.com/percona-operator-for-mongodb/update.html)。您的 CR 中的镜像标签也必须更新。

## 故障排除

| 症状                                                                               | 原因                                                 | 修复                                                                                                                                              |
| :-------------------------------------------------------------------------------- | :---------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| PVC 卡在 `Pending`                                                                  | 没有带有工作提供程序的 `StorageClass`               | `kubectl get sc` 并创建或默认一个工作类                                                                                                         |
| `ImagePullBackOff`，`connection reset by peer` 到 `registry-1.docker.io`          | operator 或 CR 镜像仍引用 `docker.io`               | 重新运行步骤 4 中的 `sed` 重写或修复 CR 中的 `image:` 字段                                                                                      |
| `ImagePullBackOff`，出现 `unauthorized` 或 `insufficient_scope: authorization failed` | 缺少镜像拉取 Secret 或未附加                       | 完成步骤 2，并确认 operator 部署的 `spec.template.spec.imagePullSecrets` 和 CR 的 `spec.imagePullSecrets` 已设置                             |
| Pod 提交错误提到 `securityContext`、`seccompProfile` 或 `capabilities`           | 命名空间 PSA 仍设置为 `restricted`                  | 重新应用步骤 3 中的标签                                                                                                                        |
| Operator 发出 `replset size below safe minimum`                                   | `unsafeFlags.replsetSize: true` 缺失，适用于 `size: 1` | 添加 `unsafeFlags`，如示例所示，或扩展到 3                                                                                                     |

## 参考文献

- [Percona Operator for MongoDB 文档](https://docs.percona.com/percona-operator-for-mongodb/index.html)
- [自定义资源参考](https://docs.percona.com/percona-operator-for-mongodb/operator.html)
- [系统要求和支持的版本](https://docs.percona.com/percona-operator-for-mongodb/System-Requirements.html)
- [Operator 升级指南](https://docs.percona.com/percona-operator-for-mongodb/update.html)
- [GitHub 上的源代码库](https://github.com/percona/percona-server-mongodb-operator)
- [OperatorHub.io 列表](https://operatorhub.io/operator/percona-server-mongodb-operator)
