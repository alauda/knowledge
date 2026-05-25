---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB260500140
sourceSHA: c41a37020fc168abff62d9f8d4b25763e7c597551717c1c400d0de9c35c053f7
---

# 如何实现优雅的 Pod 关闭

## 概述

当 Kubernetes 删除一个 Pod 时——无论是通过手动的 `kubectl delete pod` 还是通过 Deployment 滚动更新缩减旧副本——如果处理不当，正在进行的请求可能会因连接重置或 5xx 错误而失败。

本文档描述了在 ACP 环境中优雅关闭的工作原理，Kubernetes 和网关（Ingress NGINX、Envoy Gateway）在 Pod 被删除时的行为，以及应用程序在终止期间应该（和不应该）做的事情。

目标是：**所有正在进行的请求正常完成，客户端并不知道 Pod 已被移除。**

## 先决条件

优雅关闭必须满足两个条件：

1. **网关停止将新流量路由到正在终止的 Pod。** 当 Kubernetes 删除一个 Pod 时，它更新 EndpointSlice 将其标记为 `ready=false`。Ingress NGINX 和 Envoy Gateway 监视 EndpointSlice，并停止将新请求转发到该 Pod。这个传播需要时间。

2. **应用程序在收到停止信号后不会立即退出。** Pod 进入 Terminating 状态与网关实际停止新流量之间存在一个时间间隔。如果在这个间隔内进程退出，正在进行的请求将被中断。

## 1. Pod 被删除时发生了什么

### 1.1 Kubernetes Pod 终止流程

当 Pod 被删除时，Kubernetes 执行以下序列：

```text
Pod 被删除
→ deletionTimestamp 被设置；Pod 进入 Terminating 状态
→ terminationGracePeriodSeconds 倒计时开始（默认 30s）
→ 控制平面更新服务的 EndpointSlice
→ kubelet 开始本地容器停止序列
→ 如果配置了 preStop 钩子，则首先运行它
→ preStop 完成后，kubelet 向容器发送 SIGTERM
→ 如果宽限期到期而未退出，则发送 SIGKILL
```

关键细节：

- **倒计时在 Pod 进入 Terminating 时开始，而不是在应用程序接收到 SIGTERM 时开始。** preStop 钩子的持续时间包含在同一倒计时中。

- **preStop 在 SIGTERM 之前运行。** 如果没有 preStop，kubelet 几乎立即发送 SIGTERM。若有 preStop，SIGTERM 会等待直到 preStop 完成。

  ```text
  Pod Terminating → preStop → SIGTERM → SIGKILL
  ```

- **preStop 消耗相同的终止窗口。** 示例：

  ```text
  terminationGracePeriodSeconds: 60
  preStop: sleep 15

  0s       Pod 进入 Terminating，60s 倒计时开始
  0–15s    preStop 执行
  15s      发送 SIGTERM
  15–60s   应用程序最多有 45s 时间退出
  60s      如果仍在运行则发送 SIGKILL
  ```

### 1.2 EndpointSlice 更新

当 Pod 被删除时，控制平面更新相应的 EndpointSlice。一个正在终止的 Pod 显示为：

```yaml
conditions:
  ready: false
  serving: true
  terminating: true
```

- `terminating: true` — Pod 已被删除并正在关闭。
- `ready: false` — 正常的服务流量不应转发到此端点。
- `serving: true` — 应用程序可能仍在处理正在进行的请求。

`ready=false` 是由 Kubernetes 自动设置的，因为 Pod 正在终止。它与应用程序的 readinessProbe 结果无关。即使 readinessProbe 仍然通过，Kubernetes 也会将正在终止的 Pod 标记为 `ready=false`。

### 1.3 从 EndpointSlice 到流量实际停止

EndpointSlice 被标记为 `ready=false` 并不意味着流量会立即停止。存在一个传播链：

```text
EndpointSlice 更新为 ready=false
→ Ingress Controller / Gateway 监视并检测到变化
→ 新流量停止到达旧 Pod
```

这个传播有延迟——通常在几秒钟的范围内。应用程序必须在这个窗口内保持存活。

### 1.4 Envoy Gateway 排水超时

Envoy Gateway 在优雅关闭期间通过两个参数控制连接排水：

- **drainTimeout**（默认 60s）：优雅关闭开始后，Envoy 等待的最长时间以排水现有连接。在此超时后，Envoy 强制退出并关闭任何剩余连接。对于具有长请求、流式响应或长连接（gRPC 流、WebSocket）的后端，此值应与应用程序的 `terminationGracePeriodSeconds` 协调，以避免强制连接终止。
- **minDrainDuration**（默认 10s）：Envoy 在退出之前在排水状态下花费的最短时间。即使所有连接提前关闭，Envoy 也至少等待这么长时间。这确保了无论连接状态如何，都会有一个基本的排水窗口。

```text
关闭触发
→ Envoy 进入排水状态
→ minDrainDuration (10s)：Envoy 至少在排水状态下停留这么长时间
→ drainTimeout (60s)：最大总排水时间；即使连接仍然存在，Envoy 也会在此后退出
→ 任何剩余连接被强制关闭
```

**指导原则**：`drainTimeout` 应该 ≥ 应用程序的 `terminationGracePeriodSeconds`，以便 Envoy 不会在应用程序完成之前关闭连接。

## 2. 应用程序在终止期间应该做什么

对于普通的 HTTP 应用程序，答案很简单：**什么都不做。** 应用程序应继续正常运行。在网关看到 EndpointSlice 变化后，它停止转发新请求。正在进行的请求完成后，进程再退出。

应用程序不需要关闭监听器、拒绝请求或返回 503。它只需要保持存活。

### 2.1 何时需要排水：长连接

对于维护长连接的后端（gRPC 流、WebSocket 等），情况有所不同。在网关移除端点后，它不会向旧 Pod 发送新请求，但现有的长连接可能仍然保持打开状态。网关不一定会终止它们。在这些连接关闭之前，旧 Pod 继续接收流量，无法退出。

排水端点解决了这个问题：它通知应用程序即将被删除，以便应用程序可以主动关闭所有长连接。客户端检测到断开连接并重新建立连接。新连接由网关路由到新启动的 Pods，旧 Pod 的流量降至零。

```text
应用程序接收到排水通知
→ 关闭所有长连接
→ 客户端检测到断开并重新连接
→ 网关将新连接路由到新 Pods
→ 旧 Pod 流量降至零；安全退出
```

对于没有长连接的普通 HTTP 应用程序，实现排水端点是没有必要的。唯一的要求是不要在 SIGTERM 上立即退出。

### 2.2 触发源

preStop、SIGTERM 和手动 `/drain` 调用是同一操作的不同触发源。应用程序应有一个单一的排水实现，供所有源重用。

排水必须是幂等的。相同的实例可能会同时接收到多个触发：

```text
preStop 调用 /drain
SIGTERM 处理程序触发排水
手动调用 /drain
```

在第一次调用后，后续触发不应重新关闭资源或中断正在进行的请求。

### 2.3 PID 1 和信号转发

kubelet 向容器内的 PID 1 发送 SIGTERM。如果应用程序进程不是 PID 1，它将不会接收到信号，并将在宽限期到期后被 SIGKILL 强制杀死——就像根本没有处理 SIGTERM 一样。

这通常发生在：

- Dockerfile 使用了 shell 形式的 ENTRYPOINT：`ENTRYPOINT sh -c "java -jar app.jar"`。此时，shell 成为 PID 1，而不是 JVM。
- 启动脚本在后台运行应用程序：`java -jar app.jar &`。

修复方法：

- 在 Dockerfile 中使用 exec 形式，使应用程序直接成为 PID 1：

  ```dockerfile
  ENTRYPOINT ["java", "-jar", "app.jar"]
  ```

- 或者在 shell 形式中使用 `exec` 来替换 shell 进程：

  ```bash
  exec java -jar app.jar
  ```

- 对于设计上不作为 PID 1 运行的容器（例如，init 系统、supervisord），配置 init 系统将信号转发给应用程序进程。

要验证，请运行 `docker exec <container> ps 1` 并确认 PID 1 是应用程序二进制文件，而不是 shell。

## 3. 最佳实践

### 3.1 preStop：遗留应用程序的后备方案

preStop 主要解决一个场景：应用程序在接收到 SIGTERM 时立即退出且代码无法更改。在这种情况下，preStop 在 preStop 阶段保持进程存活，给网关时间停止路由流量。

实际的网关传播时间通常在几秒钟的范围内。在 preStop 中使用 `sleep 15` 是保守的，以提供足够的余量。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: app
          image: demo-app:latest
          ports:
            - containerPort: 8080
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - "sleep 15"
```

> **注意：** 这个示例假设容器镜像包含 `/bin/sh` 和 `sleep`。最小镜像（无发行版、scratch）可能没有这些二进制文件。在这种情况下，可以使用轻量级静态二进制文件（例如，`busybox sleep 15`）、针对健康端点的 `httpGet` preStop 钩子，或在应用程序代码中处理延迟。

时间线：

```text
0s       Pod 进入 Terminating，30s 倒计时开始
0s       控制平面更新 EndpointSlice ready=false
0–15s    preStop sleep；网关完成流量切换（实际：几秒钟）
15s      preStop 结束；kubelet 发送 SIGTERM
15–30s   应用程序退出
30s      如果仍在运行则发送 SIGKILL
```

如果应用程序已经正确处理 SIGTERM（不立即退出），则不需要 preStop。直接在应用程序中处理 SIGTERM 比依赖 preStop 更可靠。

### 3.2 具有长连接的应用程序：排水 + 扩展宽限期

维护长连接的应用程序需要两件事：一个调用排水端点以关闭长连接的 preStop 钩子，以及一个足够大的 `terminationGracePeriodSeconds` 以允许关闭完成。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 120
      containers:
        - name: app
          image: demo-app:latest
          ports:
            - containerPort: 8080
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - |
                    curl -fsS http://127.0.0.1:8080/drain
                    sleep 15
```

时间线：

```text
0s        Pod 进入 Terminating，120s 倒计时开始
0s        控制平面更新 EndpointSlice ready=false
0s        preStop 调用 /drain；应用程序开始关闭长连接
0–15s     preStop sleep 15s；等待网关切换 + 连接关闭传播
15s       preStop 结束；kubelet 发送 SIGTERM
15–120s   应用程序等待长连接关闭，释放资源，退出
120s      如果仍在运行则发送 SIGKILL
```

`terminationGracePeriodSeconds: 120` 是必要的，因为关闭长连接可能需要相当长的时间（等待客户端重新连接，等待流式请求完成）。如果在 30s 内完成关闭，则默认值是足够的。

### 3.3 总结

- 当 Pod 进入 Terminating 时，Kubernetes 自动更新 EndpointSlice 以切断流量。应用程序不需要使就绪状态失败。
- 普通 HTTP 应用程序在接收到 SIGTERM 时不应立即退出。保持存活几秒钟以便网关切换流量是足够的。
- 具有长连接的应用程序应实现排水端点。在接收到排水通知后，它们主动关闭长连接，以便客户端重新连接到新 Pods。
- preStop 是无法修改以正确处理 SIGTERM 的遗留应用程序的后备方案。如果代码可以更改，则直接在应用程序中处理 SIGTERM。
- 排水必须是幂等的，并能够容忍重复触发。
- 在排水期间，livenessProbe 应保持成功，以避免 kubelet 重新启动容器并中断正在进行的请求。
- 默认的 `terminationGracePeriodSeconds` 为 30s，对于普通 HTTP 应用程序是足够的。只有需要超过 30s 关闭的长连接应用程序应增加此值。
- 即使在正确的优雅关闭情况下，Pod 删除与网关流量切换之间仍然存在短暂的失败窗口。客户端应实现带有指数退避的重试机制，以透明地处理这些瞬态故障。
