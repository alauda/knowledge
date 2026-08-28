---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260800029
sourceSHA: 4ca4a655d174ff41ffbb0ff8731c3e49a270bdb92699c7f56875b5ed15fb13fb
---

# Redis Enterprise 8.0 与 ACP 集成

## 概述

[Redis Enterprise](https://redis.io/enterprise/) 是 Redis 的商业内存数据库。在 Kubernetes 上，它以 `redis-enterprise-k8s` Operator 的形式提供，该 Operator 管理一组 Redis Enterprise 节点及其上托管的数据库。

本指南描述了如何在 Alauda Container Platform (ACP) 上部署 Redis Enterprise，包括隔离环境下的镜像准备、Operator 安装、集群和数据库创建、验证以及升级路径。该集成在 ACP 4.1 和 Redis Enterprise 8.0 上进行了验证。

Redis Enterprise 通过四种自定义资源进行管理：

| 资源                                   | 简称       | 描述                                                                                     |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `RedisEnterpriseCluster`               | REC        | 节点池。每个命名空间一个 REC；每个 REDB 和 REAADB 依赖于它。                             |
| `RedisEnterpriseDatabase`              | REDB       | 逻辑数据库。支持密集型、稀疏型和 OSS 集群兼容的稀疏分片。                             |
| `RedisEnterpriseRemoteCluster`         | RERC       | 对远程 REC 的引用，用于配置主动-主动复制。                                             |
| `RedisEnterpriseActiveActiveDatabase`  | REAADB     | 主动-主动（地理复制）数据库。                                                           |

## 环境

| 组件                                   | 版本 / 值                               |
| -------------------------------------- | --------------------------------------- |
| 容器平台                               | ACP 4.x（在 4.1 上验证）                |
| 产品                                   | Redis Enterprise 8.0                    |
| Operator                               | `redis-enterprise-k8s` bundle `v8.0.2-6` |
| Operator 镜像                          | `redislabs/operator:8.0.2-6`            |
| Redis 镜像                             | `redislabs/redis:8.0.2-41`              |
| 服务触发器镜像                        | `redislabs/k8s-controller:8.0.2-6`      |
| 呼叫回家客户端镜像                    | `redislabs/re-call-home-client:8.0.2-6` |
| Redis 声明的 Kubernetes 版本          | 1.31, 1.32, 1.33                        |
| 安装方法                               | Bundle YAML（推荐）或 Helm chart       |

支持的 Kubernetes 版本是 Redis 为此 Operator 版本声明的版本。请查看 Redis 发布说明以获取适用于您安装版本的确切列表。

> **注意**：Redis Enterprise 镜像版本与 Operator 版本耦合。在安装之前，请在 Redis 文档网站上确认您镜像的镜像标签与您应用的 Operator bundle 匹配。

## 先决条件

- 一个具有 `kubectl` 访问权限的 ACP 4.x 集群。
- 一个 **支持卷扩展的网络持久 StorageClass**。不支持本地磁盘。如果使用自动分层，建议使用 SSD 支持的存储，因为热值存储在 RAM 中，而冷值存储在闪存上。
- 一个集群可以拉取的私有注册表，当集群没有直接互联网访问时。
- 一个 Redis Enterprise 试用或商业许可证。试用许可证限制为 4 个分片（包括副本），每个分片最多 25 GB。
- 在用于准备的工作站上安装 `skopeo` 和 `helm`。

本指南中使用了以下占位符。请将其替换为您环境中的值：

| 占位符               | 描述                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `<private-registry>` | 集群可访问的注册表                                                                     |
| `<storage-class>`    | 支持扩展的网络 StorageClass                                                             |
| `<namespace>`        | 托管 Redis Enterprise 集群的命名空间                                                   |
| `<pull-secret>`      | 存储 `<private-registry>` 凭据的 `kubernetes.io/dockerconfigjson` Secret                |
| `<admin-username>`   | Redis Enterprise 集群管理员的登录名，格式为电子邮件                                     |

## 解决方案

### 1. 镜像镜像

需要四个镜像。通过环境变量传递注册表凭据——绝不要将其写入提交的文件中：

```shell
export REG_USER=<registry-user>
export REG_PASS=<registry-password>

for image in \
  "redislabs/operator:8.0.2-6" \
  "redislabs/redis:8.0.2-41" \
  "redislabs/k8s-controller:8.0.2-6" \
  "redislabs/re-call-home-client:8.0.2-6" ; do
  skopeo copy \
    docker://docker.io/${image} \
    docker://<private-registry>/${image} \
    --dest-tls-verify=false \
    --dest-username "$REG_USER" --dest-password "$REG_PASS" \
    --multi-arch all
done
```

如果您计划在安装后运行负载测试，还需要镜像一个 `memtier_benchmark` 镜像。

### 2. 安装 Operator

创建命名空间，并在私有注册表需要身份验证时，在其中创建一个镜像拉取 Secret，使用步骤 1 中导出的相同凭据。Operator 部署使用 `imagePullPolicy: Always` 运行，因此没有此 Secret，Operator pod 将保持在 `ImagePullBackOff` 状态：

```shell
kubectl create namespace <namespace>
kubectl create secret docker-registry <pull-secret> \
  --namespace <namespace> \
  --docker-server=<private-registry> \
  --docker-username="$REG_USER" \
  --docker-password="$REG_PASS"
```

下载目标版本的 bundle，将其镜像指向私有注册表，附加拉取 Secret，并应用它：

```shell
VERSION='v8.0.2-6'
curl -sSLO https://raw.githubusercontent.com/RedisLabs/redis-enterprise-k8s-docs/${VERSION}/bundle.yaml
# 编辑 bundle.yaml，在 redis-enterprise-operator 部署中：
#   - 在两个 redislabs/operator 镜像引用前加上 <private-registry>/
#   - 在 pod 规格中添加 `imagePullSecrets: [{name: <pull-secret>}]`
kubectl apply -n <namespace> -f bundle.yaml
kubectl get pod -n <namespace>
```

> **注意**：该 bundle 仅引用 Operator 镜像——在 `v8.0.2-6` 中，它出现了两次，一次用于 `redis-enterprise-operator` 容器，另一次用于 `admission` 容器。步骤 1 中镜像的其他三个（`redis`、`k8s-controller`、`re-call-home-client`）未出现在 bundle 中；它们由步骤 3 中的 REC 选择。

从 `8.0.2-6` 开始，admission controller 作为 Operator 部署中的第二个容器提供，Operator 在其自己的命名空间中创建 `ValidatingWebhookConfiguration` 和 `admission-tls` Secret——无需单独应用 webhook 清单。如果 webhook 仅需验证特定命名空间，请使用 `namespaceSelector` 修补 `ValidatingWebhookConfiguration`。

Helm 也受支持，但有一些限制——该 chart 仅执行全新安装。它不涵盖升级或迁移、自定义配置值、多命名空间监视、机架感知或 Vault 集成：

```shell
helm repo add redis https://helm.redis.io/
helm repo update
helm install <release-name> redis/redis-enterprise-operator \
  --version <chart-version> \
  --namespace <namespace> \
  --create-namespace
```

当部署需要后续升级时，请使用 bundle YAML。

### 3. 创建 RedisEnterpriseCluster (REC)

一个命名空间只能包含一个 REC。

如果您持有商业许可证，请先将其存储在 Secret 中。当既未设置 `spec.license` 也未设置 `spec.licenseSecretName` 时，集群将以内置试用许可证启动，分片限制如下所述：

```shell
kubectl create secret generic my-rec-license \
  --namespace <namespace> \
  --from-file=license=./license.txt
```

> **注意**：`spec.license` 和 `spec.licenseSecretName` 是互斥的——只能设置其中一个。Secret 必须在键 `license` 下存储许可证字符串。

将每个镜像规格指向私有注册表，并引用拉取 Secret 和许可证 Secret：

```yaml
apiVersion: app.redislabs.com/v1
kind: RedisEnterpriseCluster
metadata:
  name: my-rec
spec:
  nodes: 3
  clusterCredentialSecretName: my-rec
  clusterCredentialSecretType: kubernetes
  createServiceAccount: true
  serviceAccountName: my-rec
  username: <admin-username>
  licenseSecretName: my-rec-license  # 省略以使用内置试用许可证
  persistentSpec:
    enabled: true
    storageClassName: <storage-class>
    volumeSize: 20Gi
  redisEnterpriseNodeResources:
    requests:
      cpu: "8"
      memory: 20Gi
    limits:
      cpu: "8"
      memory: 20Gi
  pullSecrets:  # 省略当注册表不需要身份验证时
    - name: <pull-secret>
  bootstrapperImageSpec:
    repository: <private-registry>/redislabs/operator
    versionTag: 8.0.2-6
  redisEnterpriseImageSpec:
    repository: <private-registry>/redislabs/redis
    versionTag: 8.0.2-41
  redisEnterpriseServicesRiggerImageSpec:
    repository: <private-registry>/redislabs/k8s-controller
    versionTag: 8.0.2-6
  usageMeter:
    callHomeClient:
      imageSpec:
        repository: <private-registry>/redislabs/re-call-home-client
        versionTag: 8.0.2-6
  services:
    apiService:
      type: NodePort
  uiServiceType: NodePort
```

```shell
kubectl apply -n <namespace> -f rec.yaml
kubectl get rec -n <namespace>
```

Operator 创建一个以 CR 命名的 Secret，保存管理员凭据——用户名为 `spec.username` 中设置的值，密码随机生成——并在节点之间分发自签名的 TLS 证书。从该 Secret 中读取密码：

```shell
kubectl get secret my-rec -n <namespace> -o jsonpath='{.data.password}' | base64 -d
```

> **注意**：API 和 UI 服务的 `NodePort` 便于验证。对于生产环境，请通过集群的标准入口路径公开它们。

### 4. 创建数据库 (REDB)

#### 4.1 密集放置

密集放置将分片尽可能保留在少数节点上，是开源哨兵部署的对应方式：

```yaml
apiVersion: app.redislabs.com/v1alpha1
kind: RedisEnterpriseDatabase
metadata:
  name: mydb
spec:
  memorySize: 20GB
  persistence: aofEverySecond
  replication: true
  redisEnterpriseCluster:
    name: my-rec
```

#### 4.2 稀疏放置

稀疏放置将分片分散到多个节点上，是开源集群部署的对应方式：

```yaml
spec:
  memorySize: 20GB
  shardCount: 3
  persistence: aofEverySecond
  shardsPlacement: "sparse"
  ossCluster: false
  redisEnterpriseCluster:
    name: my-rec
```

设置 `ossCluster: true` 以通过 OSS 集群 API 公开数据库，以便客户端可以使用开源集群命令，例如 `CLUSTER NODES`。在 ACP 上验证了三种模式——密集型、稀疏型和稀疏型（`ossCluster: true`）。

每个数据库都有一个与 REDB 同名的 `ClusterIP` 服务，以及一个 `-headless` 服务。

### 5. 验证部署

```shell
kubectl get rec,redb -n <namespace>
kubectl get pod -n <namespace>
kubectl get svc -n <namespace>
```

使用数据库服务和数据库 Secret 中的密码连接任何 Redis 客户端。当对数据库运行 `memtier_benchmark` 时，客户端模式必须与数据库配置匹配：

```shell
# 标准基于代理的数据库：不要传递 --cluster-mode
memtier_benchmark -s <db-service> -p <db-port> --authenticate=$AUTH_PASS \
  --data-size=4096 --threads=10 --clients=50 --key-pattern=P:P --test-time=180

# 启用 OSS 集群 API 的数据库：添加 --cluster-mode
memtier_benchmark -s <db-service> -p <db-port> --authenticate=$AUTH_PASS --cluster-mode \
  --data-size=4096 --threads=10 --clients=50 --key-pattern=P:P --test-time=180
```

> **注意**：Redis Enterprise 将所有客户端流量通过代理路由，而开源 Redis 集群则让客户端直接连接到每个分片。这两种架构的结果不可直接比较——请在其各自拓扑的上下文中阅读。

指标在端口 `8070` 上公开，可以通过 `ServiceMonitor` 收集。

### 6. 升级路径

按顺序升级三个层，并在开始之前确认 Redis 文档中支持的升级路径和模块兼容性：

1. **Operator** — 应用目标版本的 bundle。admission controller 是 Operator 部署中的一个容器，因此与 Operator 一起升级。
2. **REC** — 设置 `spec.autoUpgradeRedisEnterprise: true`，或手动更新 `redisEnterpriseImageSpec.versionTag`。
3. **REDB** — 更新 `spec.redisVersion` 为目标次要版本，例如 `"8.0"`。该字段还接受 `major` 和 `latest` 通道，这总是升级到最新的主要版本或最新可用版本。REC 升级策略和 REDB 版本必须一致。

## 已知限制

| 领域                                                      | 限制                                                                                                                                               | 建议                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Operator 范围                                            | 默认情况下，Operator 仅监视单个命名空间；通过额外配置支持多个命名空间                                                                          | 在安装之前确认您的部署所需的监视范围                                   |
| Helm chart                                                | 仅支持全新安装——不支持升级或迁移、配置值、多命名空间、机架感知或 Vault 集成                                                                    | 当部署需要升级时，请使用 bundle YAML                                   |
| 存储                                                     | 需要支持扩展的网络持久存储；自动分层建议使用 SSD                                                                                                 | 不要使用本地磁盘                                                     |
| 外部访问                                                 | 数据库默认是 `ClusterIP`；通过 REC 的 `ingressOrRouteSpec` 配置 Ingress（HAProxy 或 Nginx）、Istio Gateway 和 OpenShift Route                | 在公开数据库之前明确选择并配置访问路径                               |
| 主动-主动、物理隔离部署、双栈                            | 此验证未涵盖                                                                                                                                   | 在依赖它们之前单独验证                                               |
| 试用许可证                                               | 包括副本在内的最大 4 个分片，每个分片 25 GB                                                                                                      | 使用商业许可证进行容量测试                                           |

## 安全注意事项

- 注册表地址、注册表凭据、许可证详情和数据库密码必须通过 Secrets 或环境变量提供，绝不要提交到代码库中。
- Operator 自动创建集群管理员凭据。从 Secret 中读取它们，而不是设置固定密码。
- 当集群托管不相关的工作负载时，限制 admission webhook 仅验证其需要验证的命名空间。
