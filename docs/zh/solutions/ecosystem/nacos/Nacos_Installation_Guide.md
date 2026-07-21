---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260700056
sourceSHA: 4e60caaaf18ac3ef823ac30a6884b06dcf4c4a82f3979b82692f5e5cf24cac07
---

# Alauda 对 Nacos 的支持 — 安装指南

## 概述

**Alauda 对 Nacos 的支持** 是 Alauda 应用服务 (S2，认证) 对 [Nacos](https://nacos.io/) 的打包 — 阿里巴巴的动态服务发现、配置管理和服务管理平台 — 在 Alauda Cloud 市场上列出，并可从 ACP OperatorHub 安装。

由于上游社区的 OLM 包对 Nacos 已被放弃，因此此插件以 **chart-wrap** 模式交付：官方的 `nacos-group/nacos-k8s` Helm chart 被 operator-sdk helm-operator 包装，并作为 OLM Operator 发布。您从市场安装 Operator，然后创建一个单独的 `Nacos` 自定义资源；Operator 在后台运行 `helm install` 并管理生成的 Nacos `StatefulSet` 和 `Service`。一个空的 `spec` 为您提供一个准备就绪的 **独立** Nacos 和 **嵌入式** 存储。

本指南描述了如何从 ACP 市场安装 **Alauda 对 Nacos 的支持**，启动一个独立的 Nacos 实例，访问其控制台，并验证配置管理和服务发现的端到端功能。

### 支持的版本

<!-- factory:auto:supported-versions BEGIN -->

| 项目                              | 版本                                                               |
| --------------------------------- | ------------------------------------------------------------------- |
| ACP                               | 4.1, 4.2, 4.3                                                       |
| 架构                              | amd64 (x86_64), arm64                                              |
| Alauda 对 Nacos 的支持 (包)      | v3.0.1                                                              |
| Nacos 服务器 (操作数)            | v3.0.1 (`docker.io/nacos/nacos-server:v3.0.1`, multi-arch)          |
| 上游 chart                        | `nacos-group/nacos-k8s` `/helm` @ `1b98fe67a4b2` (appVersion 3.0.1) |

<!-- factory:auto:supported-versions END -->

> **网络:** 此版本在 IPv4 和 IPv6 集群上均已验证。发布的端到端矩阵覆盖了在 amd64/IPv6 上的 ACP 4.3 和在 arm64/IPv4 上的 ACP 4.2 + 4.1；其他架构 × IP 栈组合（包括双栈）预计可以正常工作，但在此版本中未进行测试。

## 先决条件

- 一个支持上述版本的 ACP 集群，并且对目标业务集群具有 `cluster-admin` 访问权限。
- 集群的 OperatorHub 中可用的 **Alauda 对 Nacos 的支持** 插件。如果尚未上传，管理员可以使用 `violet` CLI（从 **App Store > App Onboarding** 下载，匹配目标平台版本）将其推送：
  ```bash
  violet push <nacos-operator-plugin-package>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- 针对目标集群配置的 `kubectl`。

## 安装 Alauda 对 Nacos 的支持

1. 在 ACP 控制台中，转到 **管理员 > 市场 > OperatorHub**，选择目标集群，找到 **Alauda 对 Nacos 的支持**，然后点击 **安装**。
2. 保持默认通道（`alpha`），选择目标命名空间，并确认安装。平台会创建一个 `Subscription` 并批准 `InstallPlan`。

### 验证 Operator

```bash
# CSV 应该达到 Succeeded 阶段
kubectl -n <operator-namespace> get csv | grep nacos-operator

# 操作控制器 Deployment 应该是可用的
kubectl -n <operator-namespace> get deploy | grep nacos-operator
```

预期：CSV `nacos-operator.v3.0.1` 达到阶段 `Succeeded`，并且操作的 controller-manager Deployment 显示 `1/1` 准备就绪。

## 快速开始：部署独立 Nacos

设置以下命令中使用的变量：

```bash
export NAMESPACE=nacos-demo
kubectl create namespace ${NAMESPACE}
```

### 1. 创建 Nacos 实例

一个空的 `spec` 部署独立的 Nacos 和嵌入式存储。chart 的独立 Service `nacos-cs` 类型为 `NodePort`，因此无需额外对象即可访问它。

```yaml
apiVersion: nacos-operator.alauda.io/v1
kind: Nacos
metadata:
  name: nacos
  namespace: nacos-demo
spec: {}   # -> global.mode=standalone, nacos.storage.type=embedded, service.type=NodePort
```

```bash
kubectl apply -f nacos.yaml
```

### 2. 等待 Nacos 准备就绪

Operator 将 CR 协调为 Nacos `StatefulSet`（发布名称为 `nacos`）以及 `nacos-cs` Service。等待 Pod 准备就绪：

```bash
kubectl -n ${NAMESPACE} rollout status statefulset/nacos --timeout=600s
kubectl -n ${NAMESPACE} get pods,svc
```

> 第一次发布可能需要几分钟 — Nacos 服务器 3.x 启动较慢，并且当启用持久性时 PVC 必须先绑定。在将尚未准备好的 Pod 视为失败之前，请允许最多 \~10 分钟。

预期：`nacos-0` Pod 状态为 `1/1` 运行，并且存在一个 `nacos-cs` Service，暴露以下端口：

| 端口        | 名称    | 目的                                             |
| ----------- | ------- | --------------------------------------------------- |
| 8848        | http    | Nacos 服务器 — SDK、配置和命名客户端开放 API |
| 8080        | console | Web 控制台 + `/v3/console/health/readiness`        |
| 9848 / 9849 | —       | gRPC client-rpc / raft-rpc                          |
| 9080        | mcp     | MCP 端点                                        |

### 3. 访问控制台 (NodePort)

```bash
# 控制台节点端口 (8080 是自动分配的；服务器 8848 端口固定为 30000)
CONSOLE_PORT=$(kubectl -n ${NAMESPACE} get svc nacos-cs \
  -o jsonpath='{.spec.ports[?(@.name=="console")].nodePort}')
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

# 如果主机是 IPv6 地址，则用括号括起来 (IPv6-only / air-gapped 集群)
case "$NODE_IP" in *:*) HOST="[$NODE_IP]" ;; *) HOST="$NODE_IP" ;; esac
echo "控制台: http://${HOST}:${CONSOLE_PORT}/"

# 就绪端点 — 打印 HTTP 状态 (期望 200)
curl -s -o /dev/null -w '%{http_code}\n' "http://${HOST}:${CONSOLE_PORT}/v3/console/health/readiness"
```

### 4. 验证配置管理和服务发现

针对服务器端口 `8848` 的 `nacos-cs` Service 运行 v1 客户端开放 API（在默认拓扑中保持开放）。Nacos Pod 已经包含 `curl`，因此使用 `kubectl exec` **在** Pod 内运行探测 — 这不需要外部探测镜像，这在 air-gapped / IPv6-only 集群中很重要，因为像 `curlimages/curl` 这样的镜像无法被拉取。从 Pod 内部调用 Service DNS 也会测试 `nacos-cs` Service 路由，而不仅仅是 `localhost`：

```bash
POD=nacos-0
SVC="nacos-cs.${NAMESPACE}.svc.cluster.local:8848"

# (A) 发布配置 -> "true"，然后读取它 -> key=value
kubectl -n ${NAMESPACE} exec ${POD} -- curl -s -X POST \
  "http://${SVC}/nacos/v1/cs/configs" \
  -d 'dataId=demo.properties&group=DEFAULT_GROUP&content=key=value'
kubectl -n ${NAMESPACE} exec ${POD} -- curl -s \
  "http://${SVC}/nacos/v1/cs/configs?dataId=demo.properties&group=DEFAULT_GROUP"

# (B) 注册服务实例 -> "ok"，然后列出它 -> hosts[] with 10.0.0.1:8080
kubectl -n ${NAMESPACE} exec ${POD} -- curl -s -X POST \
  "http://${SVC}/nacos/v1/ns/instance" \
  -d 'serviceName=demo-svc&ip=10.0.0.1&port=8080'
kubectl -n ${NAMESPACE} exec ${POD} -- curl -s \
  "http://${SVC}/nacos/v1/ns/instance/list?serviceName=demo-svc"
```

> \[!注意]
> 如果 Pod 到自身 Service ClusterIP 的路径没有收敛（某些 CNI 缺乏发夹支持），请在上述命令中将 Service DNS 替换为 `localhost:8848` 以确认 Nacos 本身是健康的，同时您调查路由问题。

## 通过安装表单进行配置

包装的 CR spec 反映了上游 chart 的 `values.yaml`。安装表单（由插件的 spec 描述符驱动）暴露了主要的调节项；您也可以直接在 CR `spec` 上设置它们：

| 组         | CR 路径                                                                                                   | 备注                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拓扑       | `global.mode`, `nacos.replicaCount`                                                                       | `standalone`（默认）或 `cluster`。**集群模式需要 `nacos.replicaCount` ≥ 3 和外部 MySQL 存储**（见存储），并受以下限制的约束。 |
| 存储       | `nacos.storage.type`, `nacos.storage.db.*`                                                                | `embedded`（默认；仅限独立）或外部 `mysql`（`nacos.storage.db.{host,port,name,username,password}`） — 集群模式所需                             |
| 持久性     | `persistence.enabled`, `persistence.data.storageClassName`, `persistence.data.resources.requests.storage` | 在重启之间保留嵌入式数据                                                                                                                                      |
| 服务       | `service.type`, `service.nodePort`                                                                        | `NodePort`（默认）或 `ClusterIP` + 您自己的 Gateway/Ingress                                                                                                            |
| 资源       | `resources.requests.cpu`, `resources.requests.memory`                                                     | 服务器容器请求                                                                                                                                                 |
| 安全性     | `nacos.authToken`                                                                                         | **在生产中必须覆盖** — 见下文                                                                                                                                    |

> \[!重要]
> Nacos 服务器 3.x 默认启用其认证插件，并从配置的认证令牌初始化 JWT 签名密钥，该密钥必须 base64 解码为 **≥ 32 字节**。chart 默认值（`nil`）在启动时会崩溃容器，因此此插件提供了一个 **公共占位符** 认证令牌以使空的 `spec` 启动。**在生产中您必须覆盖 `nacos.authToken`**（安装表单 **Auth Token**，或 `spec.nacos.authToken`）为您自己的值。请注意，v1 客户端开放 API（`/nacos/v1/cs`，`/nacos/v1/ns`）在此配置中保持开放 — 令牌仅初始化认证插件 — 这与上游社区 chart 行为一致。

### 持久性（可选）

独立 + 嵌入式存储默认使用 `emptyDir`，因此嵌入式（Derby）数据不会在 Pod 重启后保留。要保留它，请使用 StorageClass 启用持久性：

```yaml
apiVersion: nacos-operator.alauda.io/v1
kind: Nacos
metadata: {name: nacos, namespace: nacos-demo}
spec:
  persistence:
    enabled: true
    data:
      storageClassName: <your-sc>
      resources: {requests: {storage: 5Gi}}
```

## 已知限制

<!-- factory:auto:known-limitations BEGIN -->

- **首次发布遵循 chart 声明的服务器版本 (3.0.1)。** 官方的 `nacos-group/nacos-k8s` chart 声明 `appVersion: 3.0.1`；更新的上游服务器版本 (3.2.x) 由工厂的 oss-watch 机器人跟踪，并在以后的 chart 更新中被采纳。此插件版本作为一个单元跟随 chart。
- **发布验证以独立模式为主；集群模式在此版本中未进行测试。** 集群模式（`global.mode: cluster`）需要 `nacos.replicaCount` ≥ 3 **和** 外部 MySQL 存储（嵌入式存储仅限独立），发布的端到端覆盖了独立拓扑。
- **arm64 上的集群模式是已知限制。** chart 的 `peer-finder` 初始化镜像（`nacos/nacos-peer-finder-plugin:1.1`）是 **amd64-only**，并且仅在 `global.mode: cluster` 时呈现。独立模式（默认）不使用它，因此不受影响。集群模式在 arm 上等待未来版本中的多架构 peer-finder。
- **生产环境必须覆盖默认的 Auth Token**（见上面的安全性说明） — 交付的占位符是公共的。

<!-- factory:auto:known-limitations END -->

## 清理

```bash
kubectl delete nacos nacos -n nacos-demo
kubectl delete namespace nacos-demo
# 从管理员 > 市场 > OperatorHub > 已安装中卸载 Operator，或：
kubectl -n <operator-namespace> delete subscription nacos-operator
kubectl -n <operator-namespace> delete csv nacos-operator.v3.0.1
```

## 常见问题

**问：Nacos Pod 在安装后处于 `CrashLoopBackOff`。**
检查日志中是否有 `IllegalArgumentException: the length of secret key must ... >= 32 bytes`。这意味着 `nacos.authToken` 被设置为无效（过短 / `nil`）值。使用交付的默认值或一个 base64 解码至少为 32 字节的值。

**问：Nacos Pod 卡在 `ImagePullBackOff`。**
插件将操作数引用重写为 `docker.io/nacos/nacos-server`，以便平台镜像白名单可以匹配并将其重写为集群内注册表。在 air-gapped 集群中，确保 `sync-images` 步骤将 `nacos-server:v3.0.1` 镜像同步到平台注册表，并且 ImageWhiteList 重写生效。

**问：我的嵌入式配置在 Pod 重启后消失了。**
独立 + 嵌入式存储默认使用 `emptyDir`。启用 `persistence` 和 StorageClass（见 [持久性](#persistence-optional)）以在重启之间保留数据。

**问：如何在不使用 NodePort 的情况下将控制台暴露到集群外部？**
设置 `spec.service.type: ClusterIP`，并在 `nacos-cs` Service 前放置您自己的 Gateway/Ingress（控制台在 8080 端口，服务器在 8848 端口）。

**问：如何升级 Nacos？**
从市场将 Operator 升级到新版本；它会将 `Nacos` CR 协调到匹配的 chart/operand 版本。版本跟随升级由工厂的版本跟随管道处理。
