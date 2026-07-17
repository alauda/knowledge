---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: TBD
sourceSHA: e6b9cd686b04d93bcada95c888f6da8c9420c9ee7bc0668747d4a5545e0c8a5a
---

# Alauda 对 Knative 的支持 — 安装指南

## 概述

**Alauda 对 Knative 的支持** 是 Alauda 应用服务 (S2，认证) 打包的上游 CNCF Knative Operator，列在 Alauda Cloud 市场上，并可以从 ACP OperatorHub 安装。

Knative 是一个 CNCF 项目，为 Kubernetes 添加无服务器构建模块。它有两个组件：

- **Serving** — 运行无状态、请求驱动的工作负载，支持零规模、基于修订版的流量分配，以及可插拔的入口层 (Kourier / Istio / Contour)。
- **Eventing** — 通过 Brokers、Triggers、Channels 和 Sources 传递 CloudEvents。

在 Alauda Container Platform (ACP) 上，Knative 作为 OLM Operator 提供，您可以从市场中安装。该 Operator 管理 `KnativeServing` 和 `KnativeEventing` 自定义资源的生命周期。本指南描述了如何从 ACP 市场安装 **Alauda 对 Knative 的支持**，启动带有 Kourier 入口的 Knative Serving，并验证无服务器 `Service` 的端到端功能。

### 支持的版本

<!-- factory:auto:supported-versions BEGIN -->

| 项目                                | 版本                                          |
| ----------------------------------- | ------------------------------------------------ |
| ACP                                 | 4.1, 4.2, 4.3                                    |
| 架构                                | amd64 (x86_64), arm64                           |
| Alauda 对 Knative 的支持 (包)      | v1.22.1                                          |
| Knative Serving / Eventing 操作数  | v1.22.0                                          |
| 上游包                              | `quay.io/operatorhubio/knative-operator:v1.22.1` |

<!-- factory:auto:supported-versions END -->

> **网络要求：** 此版本仅支持 IPv4 和 IPv4-primary 双栈集群。有关单栈 IPv6 的信息，请参见 [已知限制](#known-limitations)。

## 先决条件

- 一个符合上述支持版本的 ACP 集群，并且对目标业务集群具有 `cluster-admin` 访问权限。
- 在您集群的 OperatorHub 中可用的 **Alauda 对 Knative 的支持** 插件。如果尚未上传，管理员可以使用 `violet` CLI 推送它：
  ```bash
  violet push alauda-support-for-knative.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- 已配置 `kubectl` 以连接目标集群。
- 集群网络为 IPv4 或 IPv4-primary 双栈（请参见 [已知限制](#known-limitations)）。

## 安装 Alauda 对 Knative 的支持

1. 在 ACP 控制台中，转到 **管理员 > 市场 > OperatorHub**，选择目标集群，找到 **Alauda 对 Knative 的支持**，然后点击 **安装**。
2. 保持默认通道 (`alpha`) 和命名空间，并确认安装。

### 验证 Operator

```bash
kubectl -n operators get csv | grep alauda-support-for-knative
kubectl -n operators get deploy knative-operator
```

预期：CSV `alauda-support-for-knative.v<version>` 达到 `Succeeded` 状态，`knative-operator` 部署（操作员自己的部署名称，与上游保持不变）显示 `1/1` 准备就绪。

## 快速开始：使用 Knative Serving 部署无服务器服务

### 1. 创建 KnativeServing 实例

Knative Serving 是一个集群单例。适用两个 ACP 特定规则：

- **在使用 Kourier 时，必须在 `knative-serving` 命名空间中创建** — Operator 的 kourier-bootstrap ConfigMap 硬编码了 xDS 地址 `net-kourier-controller.knative-serving`。
- **您必须设置 `spec.registry.override`** 以将数据平面镜像重写为 *tag* 形式。Operator 的嵌入清单通过摘要引用操作数，而平台镜像白名单无法重写摘要引用 — 因此在隔离集群中，Pod 将无法拉取。`queue-proxy` 侧车来自 `config-deployment`，并单独设置。

```yaml
apiVersion: operator.knative.dev/v1beta1
kind: KnativeServing
metadata:
  name: knative-serving
  namespace: knative-serving
spec:
  registry:
    override:
      # factory:auto:install-images BEGIN  (operand tag == operator's embedded serving version)
      activator: gcr.io/knative-releases/knative.dev/serving/cmd/activator:v1.22.0
      autoscaler: gcr.io/knative-releases/knative.dev/serving/cmd/autoscaler:v1.22.0
      autoscaler-hpa: gcr.io/knative-releases/knative.dev/serving/cmd/autoscaler-hpa:v1.22.0
      controller: gcr.io/knative-releases/knative.dev/serving/cmd/controller:v1.22.0
      webhook: gcr.io/knative-releases/knative.dev/serving/cmd/webhook:v1.22.0
      queue-proxy: gcr.io/knative-releases/knative.dev/serving/cmd/queue:v1.22.0
      net-kourier-controller/controller: gcr.io/knative-releases/knative.dev/net-kourier/cmd/kourier:v1.22.0
      # factory:auto:install-images END
  ingress:
    kourier:
      enabled: true
  config:
    network:
      ingress-class: "kourier.ingress.networking.knative.dev"
    deployment:
      # queue-proxy 侧车镜像来自 config-deployment；registry.override 不覆盖它
      queue-sidecar-image: gcr.io/knative-releases/knative.dev/serving/cmd/queue:v1.22.0
```

```bash
kubectl create namespace knative-serving --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f knative-serving.yaml
```

### 2. 等待 KnativeServing 变为 Ready

```bash
kubectl get knativeserving knative-serving -n knative-serving \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
kubectl get pods -n knative-serving
```

预期：`Ready` 为 `True`，核心部署（`activator`、`autoscaler`、`controller`、`webhook`、`net-kourier-controller`、`3scale-kourier-gateway`）均为运行状态。

### 3. 部署示例 Knative 服务

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: hello
  namespace: default
spec:
  template:
    spec:
      containers:
        - image: gcr.io/knative-samples/helloworld-go
          ports:
            - containerPort: 8080
          env:
            - name: TARGET
              value: "Knative on ACP"
```

```bash
kubectl apply -f hello.yaml
```

### 4. 验证服务是否正常提供

```bash
kubectl get ksvc hello -n default
# READY 应为 True，且 URL 已填充，例如 http://hello.default.<domain>
URL=$(kubectl get ksvc hello -n default -o jsonpath='{.status.url}')
curl -s "$URL"
# -> Hello Knative on ACP!
```

## 启用事件处理（可选）

在 `knative-eventing` 命名空间中创建 `KnativeEventing` 实例，应用相同的 `spec.registry.override` 模式到事件处理镜像（controller、webhook、broker filter/ingress、in-memory channel、mtping、jobsink），并固定到操作数版本。有关 Broker/Trigger 配置，请参见 [上游事件处理文档](https://knative.dev/docs/eventing/)。

## 已知限制

<!-- factory:auto:known-limitations BEGIN -->

- **此版本不支持单栈 IPv6 / IPv6-primary 双栈集群。** Serving `autoscaler` 进入 `CrashLoopBackOff`：上游的 stat-forwarder 硬编码了 bucket-lease `EndpointSlice` 的 `AddressType` 为 IPv4 (`pkg/autoscaler/statforwarder/leases.go`)，因此在 IPv6 Pod IP 上，API 服务器拒绝它 (`endpoints[0].addresses ... must be an IPv4 address`)，`KnativeServing` 永远不会变为 `Ready`。在 `main` 上已修复 ([knative/serving#16591](https://github.com/knative/serving/pull/16591))，但尚未包含在发布的 1.22.x 中。此插件遵循社区发布流，因此一旦发布包含修复的 Knative 版本，限制将解除。在此之前，请使用 IPv4 或 IPv4-primary 双栈集群。
- 此版本验证的安装路径覆盖 **使用 Kourier 的 Serving**；事件处理和非 Kourier 入口 (Istio / Contour) 由用户根据上游文档安装。

<!-- factory:auto:known-limitations END -->

## 清理

```bash
kubectl delete ksvc hello -n default
kubectl delete knativeserving knative-serving -n knative-serving
kubectl delete namespace knative-serving
# 从管理员 > 市场 > OperatorHub 卸载 Operator（或删除其订阅/CSV）
kubectl -n operators delete subscription alauda-support-for-knative
kubectl -n operators delete csv -l operators.coreos.com/alauda-support-for-knative.operators
```

## 常见问题解答

**问：`autoscaler` Pod 处于 `CrashLoopBackOff` 状态，`KnativeServing` 永远不会变为 Ready。**
检查集群的 IP 家族：`kubectl get pod <autoscaler-pod> -n knative-serving -o jsonpath='{.status.podIPs}'`。如果 Pod IP 是 IPv6，您遇到了上述单栈 IPv6 限制 — 请使用 IPv4 或 IPv4-primary 双栈集群，直到包含上游修复的 Knative 版本可用。

**问：Serving Pods 被卡在 `ImagePullBackOff`。**
确保 `KnativeServing` CR 上存在 `spec.registry.override`（以及 `config.deployment` 下的 `queue-sidecar-image`）。如果没有，Operator 将通过摘要部署操作数，而平台镜像白名单无法重写，因此隔离集群无法拉取它们。

**问：Kourier 网关永远不会变为 Ready。**
`KnativeServing` 必须在 `knative-serving` 命名空间中创建 — kourier-bootstrap ConfigMap 硬编码了 `net-kourier-controller.knative-serving`。其他命名空间将无法收敛。

**问：如何升级 Knative？**
从市场中将 Operator 升级到新版本；它将 `KnativeServing` / `KnativeEventing` 调整为匹配的操作数版本。将 `spec.registry.override` 中的镜像标签更新为新操作数版本，以保持它们固定。
