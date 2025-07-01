---
id: KB250500009
sourceSHA: 1621875b6ff7813f46f84e67da0d87424cfd33cc15b831594bc656a29c82ab4b
---

# 使用 Argo Rollouts 的 ACP 部署策略

## 概述

在 Kubernetes 集群中使用标准的滚动更新更新应用程序有时会引入风险。为了降低这种风险，蓝绿部署和金丝雀部署等高级部署策略被广泛采用。Alauda 容器平台完全兼容 Kubernetes API，并支持这些方法。

### 理解部署策略

#### 蓝绿部署

在蓝绿部署中，新版本被部署到非活动的绿色环境。一旦准备就绪，所有用户流量会立即从蓝色环境切换到绿色环境。

#### 金丝雀部署

金丝雀部署将新版本逐步引入一小部分用户，然后再进行全面发布。新版本与旧版本并行运行。流量会缓慢地以小增量转移到新版本，从而允许监控问题。

### Argo Rollouts 介绍

Argo Rollouts 是一个 Kubernetes 控制器和一组 CRD，提供蓝绿、金丝雀、金丝雀分析、实验和渐进交付等高级部署功能。

### 理解实现方法

Alauda 容器平台提供了几种使用 Argo Rollouts 实现蓝绿和金丝雀部署的方法。

| 章节 | 基础机制           | 流量类型         | 部署策略         |
| ---- | ------------------ | ---------------- | ----------------- |
| 1    | ALB/Nginx Ingress  | 仅北南流量       | 蓝绿部署          |
| 2    | ALB/Nginx Ingress  | 仅北南流量       | 金丝雀部署        |

**注意**：利用标准 Kubernetes `Service` 的替代方法在 ACP 部署策略中进行了介绍。

#### 方法 1：使用 ALB 或 Nginx Ingress 和 Argo Rollouts 实现蓝绿部署

此方法利用 Argo Rollouts 与 ALB 或 Nginx Ingress 进行流量管理：

1. 定义一个 Kubernetes Rollout 资源，指定所需的策略（blueGreen 或 canary）。
2. Rollout 引用一个流量管理器（ALB/Nginx Ingress）来控制流量流动。
3. Argo Rollouts 自动协调部署步骤：部署新 Pod、等待和修改流量权重。
4. 对于蓝绿部署，流量会立即从旧版本切换到新版本。

#### 方法 2：使用 ALB 或 Nginx Ingress 和 Argo Rollouts 实现金丝雀部署

此方法利用 Argo Rollouts 与 ALB 或 Nginx Ingress 进行流量管理：

1. 定义一个 Kubernetes Rollout 资源，指定所需的策略（blueGreen 或 canary）。
2. Rollout 引用一个流量管理器（ALB/Nginx Ingress）来控制流量流动。
3. Argo Rollouts 自动协调部署步骤：部署新 Pod、等待和修改流量权重。
4. 对于金丝雀部署，流量会根据配置的步骤和权重逐渐转移。

## 第 1 章：使用 ALB 或 Nginx Ingress 和 Argo Rollouts 实现蓝绿部署

在 ACP（Alauda 容器平台）中，Argo Rollouts 可以使用 ALB 或 Nginx Ingress 自动化蓝绿部署以进行流量管理。本章将解释如何使用 Argo Rollouts 实现蓝绿部署。

### 概念

- **Rollout**：Kubernetes 中的自定义资源定义（CRD），替代标准的 Deployment 资源，启用蓝绿和金丝雀部署等高级部署控制。
- **BlueGreen 策略**：一种部署策略，其中存在两个相同的环境（蓝色和绿色），流量在它们之间切换。
- **WorkloadRef**：对 Argo Rollouts 将管理的现有 Deployment 的引用。

### 先决条件

1. 安装了 Alauda 容器平台，并且有一个可用的 Kubernetes 集群。
2. 集群中安装了 Argo Rollouts。
3. 安装了 Argo Rollouts kubectl 插件。
4. 有一个项目以创建命名空间。
5. 集群中有一个将要部署应用程序的命名空间。
6. 安装了 `kubectl` 命令行工具，并安装了用于与 ACP 平台进行身份验证的 `kubectl-acp` 插件。
7. 使用 `kubectl acp login` 命令对集群进行了身份验证。

### 初始应用程序部署

首先定义应用程序的“蓝色”版本。这是用户将访问的当前版本。以下是蓝色部署的示例。容器镜像版本为 `hello:1.23.1`，适当的标签为 `app=web`。

蓝色版本的示例部署 YAML 文件如下：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: hello:1.23.1
        ports:
        - containerPort: 80
```

将其保存为名为 `web-deployment.yaml` 的 YAML 文件，并使用以下命令应用：

```shell
kubectl apply -f web-deployment.yaml
```

该部署需要一个 `Service` 来暴露蓝色部署。该服务将根据匹配的标签将流量转发到蓝色 Pod。最初，服务选择器的目标是标记为 `app=web` 的 Pod。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
```

将其保存为名为 `web-service.yaml` 的 YAML 文件，并使用以下命令应用：

```shell
kubectl apply -f web-service.yaml
```

### 蓝绿部署操作步骤

#### 步骤 1：创建 Rollout

使用 `BlueGreen` 策略从 Argo Rollouts 创建一个 `Rollout` 资源：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: rollout-bluegreen
spec:
  replicas: 2
  revisionHistoryLimit: 2
  selector:
    matchLabels:
      app: web
  workloadRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
    scaleDown: onsuccess
  strategy:
    blueGreen:
      activeService: web
      autoPromotionEnabled: false
```

将其保存为名为 `rollout.yaml` 的 YAML 文件，并使用以下命令应用：

```shell
kubectl apply -f rollout.yaml
```

**YAML 字段解释：**

- `spec.selector`：Pod 的标签选择器。现有的 ReplicaSets 其 Pod 被此选择器选中，将受到此 Rollout 的影响。它必须与 Pod 模板的标签匹配。

- `workloadRef`：指定工作负载引用和应用 Rollout 的缩放策略。
  - `scaleDown`：指定在迁移到 Rollout 后是否缩减工作负载（Deployment）。可能的选项有：
    - "never"：Deployment 不会缩减。
    - "onsuccess"：Rollout 成为健康后，Deployment 会缩减。
    - "progressively"：随着 Rollout 的扩展，Deployment 会缩减。如果 Rollout 失败，Deployment 将恢复扩展。

- `strategy`：Rollout 策略，支持 `BlueGreen` 和 `Canary` 策略。
  - `blueGreen`：`BlueGreen` Rollout 策略定义。
    - `activeService`：指定在推广时更新的新模板哈希的服务。此字段是蓝绿更新策略的必填项。
    - `autoPromotionEnabled`：通过在推广之前立即暂停 Rollout 来禁用新堆栈的自动推广。如果省略，则默认行为是在 ReplicaSets 完全准备/可用后立即推广新堆栈。可以使用以下命令恢复 Rollout：`kubectl argo rollouts promote ROLLOUT`

这为使用 `BlueGreen` 策略的部署设置了 Rollout。

#### 步骤 2：验证 Rollout

创建 `Rollout` 后，Argo Rollouts 将创建一个具有相同模板的新的 ReplicaSet。当新 ReplicaSet 的 Pod 健康时，Deployment 将缩减为 0。

使用以下命令确保 Pod 正常运行：

```shell
$ kubectl argo rollouts get rollout rollout-bluegreen
Name:            rollout-bluegreen
Namespace:       default
Status:          ✔ Healthy
Strategy:        BlueGreen
Images:          hello:1.23.1 (stable, active)
Replicas:
  Desired:       2
  Current:       2
  Updated:       2
  Ready:         2
  Available:     2

NAME                                           KIND        STATUS     AGE  INFO
⟳ rollout-bluegreen                            Rollout     ✔ Healthy  95s
└──# revision:1
   └──⧉ rollout-bluegreen-595d4567cc           ReplicaSet  ✔ Healthy  18s  stable,active
      ├──□ rollout-bluegreen-595d4567cc-mc769  Pod         ✔ Running  8s   ready:1/1
      └──□ rollout-bluegreen-595d4567cc-zdc5x  Pod         ✔ Running  8s   ready:1/1
```

服务 `web` 将把流量转发到 Rollout 创建的 Pod。使用以下命令：

```shell
kubectl describe service web | grep Endpoints
```

#### 步骤 3：准备绿色部署

接下来，准备应用程序的新版本作为绿色部署。使用新镜像版本（例如 `hello:1.23.2`）更新部署 `web`。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: hello:1.23.2
        ports:
        - containerPort: 80
```

**YAML 字段解释：**

- 与原始部署相同，唯一的例外是：
  - `containers.image`：更新为新镜像版本。

使用以下命令应用：

```shell
kubectl apply -f web-deployment.yaml
```

这为测试设置了新应用程序版本。

Rollouts 将创建一个新的 ReplicaSet 来管理绿色 Pod，流量仍然转发到蓝色 Pod。使用以下命令验证：

```shell
$ kubectl argo rollouts get rollout rollout-bluegreen
Name:            rollout-bluegreen
Namespace:       default
Status:          ॥ Paused
Message:         BlueGreenPause
Strategy:        BlueGreen
Images:          hello:1.23.1 (stable, active)
                 hello:1.23.2
Replicas:
  Desired:       2
  Current:       4
  Updated:       2
  Ready:         2
  Available:     2

NAME                                           KIND        STATUS     AGE  INFO
⟳ rollout-bluegreen                            Rollout     ॥ Paused   14m
├──# revision:2
│  └──⧉ rollout-bluegreen-776b688d57           ReplicaSet  ✔ Healthy  24s
│     ├──□ rollout-bluegreen-776b688d57-kxr66  Pod         ✔ Running  23s  ready:1/1
│     └──□ rollout-bluegreen-776b688d57-vv7t7  Pod         ✔ Running  23s  ready:1/1
└──# revision:1
   └──⧉ rollout-bluegreen-595d4567cc           ReplicaSet  ✔ Healthy  12m  stable,active
      ├──□ rollout-bluegreen-595d4567cc-mc769  Pod         ✔ Running  12m  ready:1/1
      └──□ rollout-bluegreen-595d4567cc-zdc5x  Pod         ✔ Running  12m  ready:1/1
```

目前有 4 个 Pod 正在运行，包含蓝色和绿色版本。活动服务是蓝色版本，Rollout 过程已暂停。

如果使用 Helm Chart 部署应用程序，请使用 Helm 工具将应用程序升级到绿色版本。

#### 步骤 4：将 Rollout 推广到绿色

当绿色版本准备就绪时，推广 Rollout 以将流量切换到绿色 Pod。使用以下命令：

```shell
kubectl argo rollouts promote rollout-bluegreen
```

验证 Rollout 是否完成：

```shell
kubectl argo rollouts get rollout rollout-bluegreen
Name:            rollout-bluegreen
Namespace:       default
Status:          ✔ Healthy
Strategy:        BlueGreen
Images:          hello:1.23.2 (stable, active)
Replicas:
  Desired:       2
  Current:       2
  Updated:       2
  Ready:         2
  Available:     2

NAME                                           KIND        STATUS         AGE   INFO
⟳ rollout-bluegreen                            Rollout     ✔ Healthy      3h2m
├──# revision:2
│  └──⧉ rollout-bluegreen-776b688d57           ReplicaSet  ✔ Healthy      168m  stable,active
│     ├──□ rollout-bluegreen-776b688d57-kxr66  Pod         ✔ Running      168m  ready:1/1
│     └──□ rollout-bluegreen-776b688d57-vv7t7  Pod         ✔ Running      168m  ready:1/1
└──# revision:1
   └──⧉ rollout-bluegreen-595d4567cc           ReplicaSet  • ScaledDown   3h1m
      ├──□ rollout-bluegreen-595d4567cc-mc769  Pod         ◌ Terminating  3h    ready:1/1
      └──□ rollout-bluegreen-595d4567cc-zdc5x  Pod         ◌ Terminating  3h    ready:1/1
```

如果活动的 `Images` 更新为 `hello:1.23.2`，并且蓝色 ReplicaSet 缩减为 0，则表示 Rollout 已完成。

## 第 2 章：使用 ALB 或 Nginx Ingress 和 Argo Rollouts 实现金丝雀部署

在 ACP（Alauda 容器平台）中，Argo Rollouts 可以使用 ALB 或 Nginx Ingress 自动化金丝雀部署以进行流量管理。本章将解释如何使用 Argo Rollouts 和 Gateway API 实现金丝雀部署。

### 概念

- **Rollout**：Kubernetes 中的自定义资源定义（CRD），替代标准的 Deployment 资源。
- **金丝雀策略**：一种部署策略，其中流量逐渐从稳定版本转移到新版本。
- **Gateway API**：Kubernetes API，提供配置 L4/L7 流量路由的方法。
- **HTTPRoute**：定义 HTTP 流量如何路由到服务的 Gateway API 资源。

### 先决条件

1. 安装了 Alauda 容器平台，并且有一个可用的 Kubernetes 集群。
2. 集群中安装了 Argo Rollouts 和 Gateway API 插件。
3. 安装了 Argo Rollouts kubectl 插件。
4. 在集群中部署了 ALB，并分配给项目。
5. 有一个项目以创建命名空间。
6. 集群中有一个将要部署应用程序的命名空间。
7. 安装了 `kubectl` 命令行工具，并安装了用于与 ACP 平台进行身份验证的 `kubectl-acp` 插件。
8. 使用 `kubectl acp login` 命令对集群进行了身份验证。

### 初始应用程序部署

首先定义应用程序的“稳定”版本。这是用户将访问的当前版本。以下是稳定部署的示例。容器镜像版本为 `hello:1.23.1`，适当的标签为 `app=web`。

稳定版本的示例部署 YAML 文件如下：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: hello:1.23.1
        ports:
        - containerPort: 80
```

将其保存为名为 `web-deployment.yaml` 的 YAML 文件，并使用以下命令应用：

```shell
kubectl apply -f web-deployment.yaml
```

该部署需要一个 `Service` 来暴露稳定部署。该服务将根据匹配的标签将流量转发到稳定 Pod。最初，服务选择器的目标是标记为 `app=web` 的 Pod。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-stable
spec:
  selector:
    app: web
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
```

将其保存为名为 `web-stable-service.yaml` 的 YAML 文件，并使用以下命令应用：

```shell
kubectl apply -f web-stable-service.yaml
```

接下来，创建一个 Gateway 来暴露该服务。使用 `example.com` 作为访问服务的示例域，创建一个 `Gateway` 来暴露该服务：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: default
spec:
  gatewayClassName: exclusive-gateway
  listeners:
  - allowedRoutes:
      namespaces:
        from: All
    name: gateway-metric
    port: 11782
    protocol: TCP
  - allowedRoutes:
      namespaces:
        from: All
    hostname: example.com
    name: web
    port: 80
    protocol: HTTP
```

网关将分配一个外部 IP 地址，从网关资源的 `status.addresses` 中获取类型为 `IPAddress` 的 IP 地址。

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: default
# ... 省略其他字段以简化
status:
  addresses:
  - type: IPAddress
    value: 192.168.134.30
```

在您的 DNS 服务器中配置域名以将域名解析到网关的 IP 地址。使用以下命令验证 DNS 解析：

```shell
nslookup example.com
Server:         192.168.16.19
Address:        192.168.16.19#53

Non-authoritative answer:
Name:   example.com
Address: 192.168.134.30
```

它应该返回网关的地址。

现在创建一个 `HTTPRoute` 将流量路由到服务。这将连接 `Gateway` 和 `Service`，并将流量路由到稳定版本的 Pod：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web
spec:
  hostnames:
  - example.com
  parentRefs:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: default
    namespace: default
    sectionName: web
  rules:
  - backendRefs:
    - group: ""
      kind: Service
      name: web-stable
      namespace: default
      port: 80
      weight: 100
    matches:
    - path:
        type: PathPrefix
        value: /
```

使用以下命令：

```shell
kubectl apply -f httproute.yaml
```

### 金丝雀部署操作步骤

#### 步骤 1：创建金丝雀服务

创建一个 Kubernetes `Service`，暴露金丝雀部署。该服务将根据匹配的标签将流量转发到金丝雀版本的 Pod。最初，服务选择器的目标是标记为 `app=web` 的 Pod。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-canary
spec:
  selector:
    app: web
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
```

使用以下命令应用：

```shell
kubectl apply -f web-canary-service.yaml
```

这允许外部访问金丝雀部署。

#### 步骤 2：更新 HTTPRoute

更新 `HTTPRoute` 以添加金丝雀版本：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web
spec:
  hostnames:
  - example.com
  parentRefs:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: default
    namespace: default
    sectionName: web
  rules:
  - backendRefs:
    - group: ""
      kind: Service
      name: web-canary
      namespace: default
      port: 80
      weight: 0
    - group: ""
      kind: Service
      name: web-stable
      namespace: default
      port: 80
      weight: 100
    matches:
    - path:
        type: PathPrefix
        value: /
```

使用以下命令应用：

```shell
kubectl apply -f httproute.yaml
```

#### 步骤 3：创建 Rollout

接下来，使用 `Canary` 策略创建 `Rollout` 资源：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: rollout-canary
spec:
  minReadySeconds: 30
  replicas: 2
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: web
  strategy:
    canary:
      canaryService: web-canary
      maxSurge: 25%
      maxUnavailable: 0
      stableService: web-stable
      steps:
      - setWeight: 50
      - pause: {}
      - setWeight: 100
      trafficRouting:
        plugins:
          argoproj-labs/gatewayAPI:
            httpRoute: web
            namespace: default
  workloadRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
    scaleDown: onsuccess
```

使用以下命令应用：

```shell
kubectl apply -f rollout.yaml
```

这为使用 `Canary` 策略的部署设置了 Rollout。它将初始权重设置为 50，并等待推广。50% 的流量将转发到金丝雀服务。推广 Rollout 后，权重将设置为 100，100% 的流量将转发到金丝雀服务。最后，金丝雀服务将成为稳定服务。

#### 步骤 4：验证 Rollout

创建 `Rollout` 后，Argo Rollouts 将创建一个具有相同模板的新 ReplicaSet。当新 ReplicaSet 的 Pod 健康时，Deployment 将缩减为 0。

使用以下命令确保 Pod 正常运行：

```shell
kubectl argo rollouts get rollout rollout-canary
Name:            rollout-canary
Namespace:       default
Status:          ✔ Healthy
Strategy:        Canary
  Step:          9/9
  SetWeight:     100
  ActualWeight:  100
Images:          hello:1.23.1 (stable)
Replicas:
  Desired:       2
  Current:       2
  Updated:       2
  Ready:         2
  Available:     2

NAME                                      KIND        STATUS     AGE  INFO
⟳ rollout-canary                            Rollout     ✔ Healthy  32s
└──# revision:1
   └──⧉ rollout-canary-5c9d79697b           ReplicaSet  ✔ Healthy  32s  stable
      ├──□ rollout-canary-5c9d79697b-fh78d  Pod         ✔ Running  32s  ready:1/1
      └──□ rollout-canary-5c9d79697b-rrbtj  Pod         ✔ Running  32s  ready:1/1
```

#### 步骤 5：准备金丝雀部署

接下来，准备应用程序的新版本作为金丝雀部署。使用新镜像版本（例如 `hello:1.23.2`）更新部署 `web`。使用以下命令：

```shell
kubectl patch deployment web -p '{"spec":{"template":{"spec":{"containers":[{"name":"web","image":"hello:1.23.2"}]}}}}'
```

这为测试设置了新应用程序版本。

Rollouts 将创建一个新的 ReplicaSet 来管理金丝雀 Pod，50% 的流量将转发到金丝雀 Pod。使用以下命令验证：

```shell
kubectl argo rollouts get rollout rollout-canary
Name:            rollout-canary
Namespace:       default
Status:          ॥ Paused
Message:         CanaryPauseStep
Strategy:        Canary
  Step:          1/3
  SetWeight:     50
  ActualWeight:  50
Images:          hello:1.23.1 (stable)
                 hello:1.23.2 (canary)
Replicas:
  Desired:       2
  Current:       3
  Updated:       1
  Ready:         3
  Available:     3

NAME                                      KIND        STATUS     AGE  INFO
⟳ rollout-canary                            Rollout     ॥ Paused   95s
├──# revision:2
│  └──⧉ rollout-canary-5898765588           ReplicaSet  ✔ Healthy  46s  canary
│     └──□ rollout-canary-5898765588-ls5jk  Pod         ✔ Running  45s  ready:1/1
└──# revision:1
   └──⧉ rollout-canary-5c9d79697b           ReplicaSet  ✔ Healthy  95s  stable
      ├──□ rollout-canary-5c9d79697b-fk269  Pod         ✔ Running  94s  ready:1/1
      └──□ rollout-canary-5c9d79697b-wkmcn  Pod         ✔ Running  94s  ready:1/1
```

目前有 3 个 Pod 正在运行，包含稳定和金丝雀版本。权重为 50，50% 的流量将转发到金丝雀服务。Rollout 过程已暂停，等待推广。

如果使用 Helm Chart 部署应用程序，请使用 Helm 工具将应用程序升级到金丝雀版本。

访问 `http://example.com`，50% 的流量将转发到金丝雀服务。您应该从该 URL 收到不同的响应。

#### 步骤 6：推广 Rollout

当金丝雀版本测试通过后，您可以推广 Rollout，将所有流量切换到金丝雀 Pod。使用以下命令：

```shell
kubectl argo rollouts promote rollout-canary
```

验证 Rollout 是否完成：

```shell
kubectl argo rollouts get rollout rollout-canary
Name:            rollout-canary
Namespace:       default
Status:          ✔ Healthy
Strategy:        Canary
  Step:          3/3
  SetWeight:     100
  ActualWeight:  100
Images:          hello:1.23.2 (stable)
Replicas:
  Desired:       2
  Current:       2
  Updated:       2
  Ready:         2
  Available:     2

NAME                                      KIND        STATUS         AGE    INFO
⟳ rollout-canary                            Rollout     ✔ Healthy      8m42s
├──# revision:2
│  └──⧉ rollout-canary-5898765588           ReplicaSet  ✔ Healthy      7m53s  stable
│     ├──□ rollout-canary-5898765588-ls5jk  Pod         ✔ Running      7m52s  ready:1/1
│     └──□ rollout-canary-5898765588-dkfwg  Pod         ✔ Running      68s    ready:1/1
└──# revision:1
   └──⧉ rollout-canary-5c9d79697b           ReplicaSet  • ScaledDown   8m42s
      ├──□ rollout-canary-5c9d79697b-fk269  Pod         ◌ Terminating  8m41s  ready:1/1
      └──□ rollout-canary-5c9d79697b-wkmcn  Pod         ◌ Terminating  8m41s  ready:1/1
```

如果稳定的 `Images` 更新为 `hello:1.23.2`，并且修订版 1 的 ReplicaSet 缩减为 0，则表示 Rollout 已完成。

访问 `http://example.com`，100% 的流量将转发到金丝雀服务。

#### 步骤 7：中止 Rollout（可选）

如果您在 Rollout 过程中发现金丝雀版本存在问题，可以中止该过程，将所有流量切换到稳定服务。使用以下命令：

```shell
kubectl argo rollouts abort rollout-canary
```

验证结果：

```yaml
kubectl argo rollouts get rollout rollout-canary
Name:            rollout-demo
Namespace:       default
Status:          ✖ Degraded
Message:         RolloutAborted: Rollout aborted update to revision 3
Strategy:        Canary
  Step:          0/3
  SetWeight:     0
  ActualWeight:  0
Images:          hello:1.23.1 (stable)
Replicas:
  Desired:       2
  Current:       2
  Updated:       0
  Ready:         2
  Available:     2

NAME                                      KIND        STATUS        AGE  INFO
⟳ rollout-canary                            Rollout     ✖ Degraded    18m
├──# revision:3
│  └──⧉ rollout-canary-5c9d79697b           ReplicaSet  • ScaledDown  18m  canary,delay:passed
└──# revision:2
   └──⧉ rollout-canary-5898765588           ReplicaSet  ✔ Healthy     17m  stable
      ├──□ rollout-canary-5898765588-ls5jk  Pod         ✔ Running     17m  ready:1/1
      └──□ rollout-canary-5898765588-dkfwg  Pod         ✔ Running     10m  ready:1/1
```

访问 `http://example.com`，100% 的流量将转发到稳定服务。

## 结论

Alauda 容器平台（ACP）提供了多种使用 Argo Rollouts 实现蓝绿和金丝雀部署的策略，每种策略都有其自身的优点和使用案例。本文探讨了两种不同的方法：

1. **使用 ALB 或 Nginx Ingress 和 Argo Rollouts 实现蓝绿部署**：
   - 利用 Argo Rollouts 自动化部署过程
   - 提供零停机时间的部署，流量即时切换
   - 适用于北南（外部）流量
   - 提供对推广过程的完全控制
   - 简化应用程序版本之间的过渡

2. **使用 ALB 或 Nginx Ingress 和 Argo Rollouts 实现金丝雀部署**：
   - 通过 Gateway API 实现逐步流量转移
   - 提供对流量百分比的细粒度控制
   - 允许在有限用户曝光下测试新版本
   - 支持自动和手动推广
   - 通过逐步向用户暴露新版本来降低风险

Alauda 容器平台的灵活性使您能够根据特定需求选择最合适的部署策略，确保以最小的风险和停机时间可靠高效地更新应用程序。通过实施这些渐进式交付策略，组织可以显著改善其部署流程，降低失败部署的风险，并更自信地向用户交付新功能。
