---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500844
sourceSHA: abf0cef8d525f549c4d143117e348d8809f01a05930958abefd8a8222c236619
---

# OpenTelemetry Apache HTTPD 自动注入在用户卷没有为智能体留出空间时失败

## 问题

在 Alauda 容器平台 (Kubernetes v1.34.5) 上，Alauda Build 的 OpenTelemetry 安装了一个 pod 变更的 admission webhook，该 webhook 在 pod 模板携带 `instrumentation.opentelemetry.io/inject-apache-httpd: <Instrumentation-name>` 注解时，会注入一个 Apache HTTPD 自动注入的 init 容器及其支持的卷。被注入的 pod 最终会有一个 init 容器，该容器将 OTel Apache 智能体文件准备到一个共享的 `emptyDir` 中，并在应用容器上设置 `volumeMounts`，以便 Apache 进程在启动时加载这些文件。

当用户的 Deployment 已经声明了与 OTel webhook 需要添加的卷路径或名称冲突的 `volumes` 和 `volumeMounts` 时，合并后的 pod 将会出现 Apache 智能体文件不在 Apache 进程预期的位置的布局。然后，Apache HTTPD 容器将无法启动（或无法加载其 OTel 智能体模块），并显示错误信息 `No such file or directory`。

## 环境

- Alauda 容器平台，Kubernetes v1.34.5
- Alauda Build 的 OpenTelemetry v2 (`opentelemetry-operator2.v0.147.0-r0`，镜像 `build-harbor.alauda.cn/asm/opentelemetry-operator2:0.147.0-r0`)，CSV `Succeeded`，控制器 pod 在命名空间 `opentelemetry-operator2` 中 `Running`
- Pod-CREATE 变更 webhook `mpod.kb.io` 注册在服务路径 `/mutate-v1-pod`，`failurePolicy=Ignore`
- CRDs `instrumentations.opentelemetry.io` (v1alpha1，包含 `spec.apacheHttpd.{attrs, configPath, env, image, resourceRequirements, version, volumeClaimTemplate, volumeLimitSize}`)，`opentelemetrycollectors.opentelemetry.io`，`opampbridges.opentelemetry.io`，`targetallocators.opentelemetry.io`

## 根本原因

在 admission 时发生的卷合并将用户声明的卷和 OTel webhook 注入的智能体卷通过相同的 pod 规格进行处理。如果用户的布局占用了 — 或未能为 — 注入器所需的插槽（特别是它用于将 Apache 智能体文件暂存到应用容器的 `/opt/opentelemetry-webserver/agent` 中的共享 `emptyDir`，以及生成的 `httpd.conf` 片段目录 `/usr/local/apache2/conf`），则生成的注入 pod 将具有一个布局，其中智能体文件不在 Apache 进程预期的位置。Apache 进程在启动时无法找到这些预期的文件，并发出 `No such file or directory`。

## 诊断步骤

确认 OpenTelemetry pod 变更 webhook 在集群中是活跃的 — 注入路径通过此 webhook 运行：

```bash
kubectl get mutatingwebhookconfiguration -o json |
  jq -r '.items[].webhooks[] | select(.name=="mpod.kb.io") |
    "\(.name) | \(.clientConfig.service.namespace)/\(.clientConfig.service.name)\(.clientConfig.service.path) | failurePolicy=\(.failurePolicy)"'
```

在正常工作的集群中，这将列出指向操作员命名空间中的 `opentelemetry-operator-controller-manager-service` 的 `mpod.kb.io`，路径为 `/mutate-v1-pod`。

确认 Instrumentation CRD 的 `apacheHttpd` 分支已注册（这是注入器在应用注解时读取的输入）：

```bash
kubectl explain instrumentation.spec.apacheHttpd
```

报告的字段为 `attrs`、`configPath`、`env`、`image`、`resourceRequirements`、`version`、`volumeClaimTemplate`、`volumeLimitSize`。

检查实时合并的 pod 规格，以查看 webhook 是否实际注入了其 init 容器和卷。正常的注入会添加两个 init 容器（`otel-agent-source-container-clone`，`otel-agent-attach-apache`）和两个卷（`otel-apache-conf-dir`，`otel-apache-agent`），主容器在 `/opt/opentelemetry-webserver/agent` 挂载 `otel-apache-agent`，在 `/usr/local/apache2/conf` 挂载 `otel-apache-conf-dir`：

```bash
kubectl get pod -n <ns> <pod> -o jsonpath='
init: {.spec.initContainers[*].name}{"\n"}
volumes: {range .spec.volumes[*]}{.name}{","}{end}{"\n"}
mounts:  {range .spec.containers[0].volumeMounts[*]}{.name}:{.mountPath}{","}{end}{"\n"}'
```

如果这四个名称在合并的规格中缺失，则 webhook 未注入 — 确认注解中引用的 `Instrumentation` CR 在 pod 的命名空间中存在，并且 pod 模板携带字面注解 `instrumentation.opentelemetry.io/inject-apache-httpd: <Instrumentation-name>`。

## 解决方案

在用户的 Deployment 中添加一个不冲突的 `volumeMount` 路径（例如 `/tmp/.otel-instr-fix`），并由新的 `emptyDir` 卷支持。这为 OTel 变更 webhook 提供了完成 Apache HTTPD 注入准备步骤所需的空间，以便合并后的布局是一致的。在缓解措施之后，Apache HTTPD 容器在启动时不再发出 `No such file or directory`，并且 OTel 自动注入成功。

首先，确保工作负载的命名空间中存在 Apache HTTPD 的 `Instrumentation` CR。`apacheHttpd` 块选择智能体镜像和容器内的 Apache 配置目录：

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: apache-instrumented
spec:
  exporter:
    endpoint: http://otel-collector:4317
  apacheHttpd:
    image: registry.alauda.cn:60080/3rdparty/otel/instrumentation-apache-httpd:1.0.4
    configPath: /usr/local/apache2/conf
  propagators:
    - tracecontext
    - baggage
```

一个因 `No such file or directory` 而失败的用户 Deployment 通常如下所示 — 用户声明了自己的 `modhttp2`/`apacheindex` 卷和挂载，但没有为 OTel 智能体文件留出空间：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: http
spec:
  replicas: 1
  selector:
    matchLabels:
      app: http
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-apache-httpd: "apache-instrumented"
      labels:
        app: http
    spec:
      containers:
        - image: <your-apache-image>
          imagePullPolicy: IfNotPresent
          name: container
          ports:
            - containerPort: 8080
              protocol: TCP
          volumeMounts:
            - mountPath: /etc/httpd/conf.modules.d/mod_http2.conf
              name: modhttp2
              subPath: mod_http2.conf
            - mountPath: /var/www/html
              name: apacheindex
      volumes:
        - configMap:
            defaultMode: 420
            name: modhttp2
          name: modhttp2
        - configMap:
            defaultMode: 420
            name: apacheindex
          name: apacheindex
```

扩展 Deployment 的 `volumes` 和 `volumeMounts`，添加额外的 emptyDir（`(1)` 是一个不存在的、不冲突的挂载路径；`(2)` 是支持的 `emptyDir`），以便变更 webhook 可以放置 Apache HTTPD 注入准备所需的内容：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: http
spec:
  template:
    spec:
      containers:
        - image: <your-apache-image>
          volumeMounts:
            - mountPath: /etc/httpd/conf.modules.d/mod_http2.conf
              name: modhttp2
              subPath: mod_http2.conf
            - mountPath: /var/www/html
              name: apacheindex
            - mountPath: /tmp/.otel-instr-fix          # (1)
              name: otel-instrumentation-fix
      volumes:
        - configMap:
            defaultMode: 420
            name: modhttp2
          name: modhttp2
        - configMap:
            defaultMode: 420
            name: apacheindex
          name: apacheindex
        - emptyDir: {}                                 # (2)
          name: otel-instrumentation-fix
```

在应用更新后的 Deployment 后，使用上面的 `kubectl get pod ... -o jsonpath` 命令重新检查合并的 pod 规格；后续的 pod 应该现在携带用户的 `modhttp2`、`apacheindex` 和 `otel-instrumentation-fix` 卷，以及 webhook 注入的 `otel-apache-conf-dir` 和 `otel-apache-agent` 卷，OTel init 容器也到位。

## 注意事项和警告

- 基本行为 — 用户提供的 `volumes`/`volumeMounts` 和 webhook 添加的智能体卷之间的卷合并交互 — 是上游 OpenTelemetry Operator 注入路径；此缓解措施适用于直到更新的 Alauda Build 的 OpenTelemetry 版本原生支持任意用户卷布局为止。您特定的操作员版本是否仍需要此缓解措施应与您安装的操作员构建的发布说明进行核对。
- 变更 webhook 的 `failurePolicy` 为 `Ignore`；如果 webhook 无法访问，pods 会在没有注入的情况下被接收，而不是被拒绝。如果您期望注入，但后续的 pod 缺少 OTel init 容器和智能体卷，请验证操作员 pod 是否为 `Running`，并且注解中引用的 `Instrumentation` CR 是否存在于与工作负载相同的命名空间中。
