---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '3.18.x,4.x'
id: KB250900012
sourceSHA: 6b965340ef53877c4b0e601cafc57862c3bc44122340cd13764f820054215a26
---

# 将应用程序从 OCP（OpenShift 容器平台）迁移到 ACP（Alauda 容器平台）

## 概述

本文档提供了将应用程序从 OpenShift 容器平台（OCP）迁移到 Alauda 容器平台（ACP）的详细说明，使用预先准备的 OCP 清单和一系列自定义工具（`oc-convert`、`template2helm`）。

## 环境信息

Alauda 容器平台:3.18.x,4.x

OCP 版本: 4.10 - 4.14

## 先决条件

- **Alauda 容器平台环境**: 一个可用的 ACP 账户（例如，LDAP），并具有访问权限。
- **项目和命名空间**: 在 ACP 中预先创建的项目和命名空间，并具有适当的权限。
- **OCP 应用程序清单**: 预先准备的 OCP 模板的 YAML 文件（例如，`DeploymentConfig`、`Route`、`Service`、`HorizontalPodAutoscaler`）。
- **OCP 路由替换策略**:
  - **Ingress Nginx**: 必须提前部署 ingress-nginx 控制器。
  - **Istio 和 Gateway**: 必须在 ACP 上部署 Istio，并为应用程序配置 Gateway。
- **所需工具**:
  - `oc-convert`: 一种专有的 ACP 工具，用于将 OCP 特定资源（例如，`DeploymentConfig` 和 `Route` 模板）转换为 Kubernetes 资源（例如，`Deployment` 和网络资源）。
  - `template2helm`: 一种专有的 ACP 工具，用于将 OCP 模板转换为 Helm 图表。
  - [Helm CLI](https://helm.sh/docs/intro/install/): 用于渲染 Kubernetes YAML 清单。
  - [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/): 用于与 ACP 集群交互。
- **容器镜像注册表访问**: 应用程序镜像必须推送到 ACP 镜像注册表，并且用户必须具有访问权限。

## 将 OCP YAML 迁移到 Helm 图表

在将应用程序部署到 ACP 之前，必须将 OCP YAML 文件迁移到 Helm 图表。这是一次性的转换过程。在此初始步骤之后，后续的应用程序发布不需要重复转换。对于 ACP 平台上的每个新发布，可以直接使用标准 Helm 命令从图表渲染 Kubernetes YAML 并进行部署，从而简化持续部署过程。

迁移过程分为以下步骤：

1. 分析 OCP 应用程序清单
2. 准备迁移环境
3. 转换 OCP 特定资源
4. 将 OCP 模板转换为 Helm 图表
5. 生成并验证 Kubernetes 资源
6. 将应用程序部署到 ACP
7. 验证和优化部署

### 1. 分析 OCP 应用程序清单

审查预先准备的 OCP 清单，以了解应用程序的结构、依赖关系和配置。

假设应用程序包括以下清单：

- `deploymentconfig.yaml`: 定义应用程序的 `DeploymentConfig`。
- `route.yaml`: 指定 OCP `Route` 以进行外部访问。
- `service.yaml`: 描述用于内部通信的 `Service`。
- `hpa.yaml`（可选）: 配置用于扩展的 `HorizontalPodAutoscaler`。
- `configmap.yaml`: 存储非敏感配置数据，例如应用程序设置或环境变量，可以作为卷挂载或传递给 Pod。
- `secret.yaml`: 管理敏感信息，例如密码、API 密钥或证书，这些信息被安全存储并挂载到 Pod 中供应用程序使用。

分析清单并记录以下内容：

- **运行时要求**: 在 `DeploymentConfig` 中引用的容器镜像。
- **资源要求**: CPU、内存和存储规格。
- **服务绑定**: 与数据库、消息队列或外部服务的连接。
- **网络**: 路由、域名和外部流量模式。
- **环境变量**: 在 `DeploymentConfig` 中定义的配置设置和秘密。

### 2. 准备迁移环境

将预先准备的清单放入迁移目录：

```bash
mkdir ocp-yaml
cp /path/to/ocp/yaml/*.yaml ocp-yaml/
```

确认所有必要的清单都存在且有效：

```bash
ls ocp-yaml/
# 预期输出: deploymentconfig.yaml  hpa.yaml  route.yaml  service.yaml  secret.yaml  configmap.yaml
cat ocp-yaml/*.yaml

# 示例:
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "服务的全名。"
    required: true
  - name: SERVICE_NAME
    description: "服务的名称。"
    required: true
  - name: VERSION
    description: "当前服务的版本。"
    required: true
  - name: REGISTRY
    description: "拉取 Docker 镜像的注册表。"
    required: true
  - name: APP_PROFILE
    description: "部署的环境。"
    required: true
  - name: NAMESPACE
    description: "当前命名空间的版本。"
    required: true
  - name: ENV_DOMAIN
    description: "相应环境的域名。"
    required: true
  - name: BASE_IMAGE_VERSION
    description: "镜像版本"
    required: true
  - name: CM_VALUE
    description: "configmap 名称"
    required: true
  - name: OCP_CLUSTER_URL
    description: "集群 URI 名称"
    required: false
metadata:
  name: ${SERVICE_FULLNAME}
  labels:
    app: ${SERVICE_FULLNAME}
    name: ${SERVICE_FULLNAME}
objects:
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: ${NAMESPACE}-${APP_PROFILE}-${CM_VALUE}-configmapvar
      namespace: ${NAMESPACE}
    data:
      module.xml: |
        hello,module.xml
      mariadb-java-client-3.5.1.jar: |
        hello,mariadb
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: ${NAMESPACE}-${APP_PROFILE}-${CM_VALUE}-configmapfile
      namespace: ${NAMESPACE}
    data:
      module.xml: |
        hello,module.xml
      mariadb-java-client-3.5.1.jar: |
        hello,mariadb
  - apiVersion: v1
    data:
      nginx.conf: |
        events {
        }

        http {
          log_format main '$remote_addr - $remote_user [$time_local]  $status '
          '"$request" $body_bytes_sent "$http_referer" '
          '"$http_user_agent" "$http_x_forwarded_for"';
          access_log /var/log/nginx/access.log main;
          error_log  /var/log/nginx/error.log;

          server {
            listen 8443 ssl;

            root /usr/share/nginx/html;
            #index index.html;
            index 50x.html;

            server_name nginx.example.com;
            ssl_certificate /etc/nginx-server-certs/tls.crt;
            ssl_certificate_key /etc/nginx-server-certs/tls.key;
          }
        }
    kind: ConfigMap
    metadata:
      name: nginx-configmap
      namespace: ${NAMESPACE}
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "服务的全名。"
    required: true
  - name: SERVICE_NAME
    description: "服务的名称。"
    required: true
  - name: VERSION
    description: "当前服务的版本。"
    required: true
  - name: REGISTRY
    description: "拉取 Docker 镜像的注册表。"
    required: true
  - name: APP_PROFILE
    description: "部署的环境。"
    required: true
  - name: NAMESPACE
    description: "当前命名空间的版本。"
    required: true
  - name: ENV_DOMAIN
    description: "相应环境的域名。"
    required: true
  - name: BASE_IMAGE_VERSION
    description: "镜像版本"
    required: true
  - name: CM_VALUE
    description: "configmap 名称"
    required: true
  - name: OCP_CLUSTER_URL
    description: "集群 URI 名称"
    required: false
metadata:
  name: ${SERVICE_FULLNAME}
  labels:
    app: ${SERVICE_FULLNAME}
    name: ${SERVICE_FULLNAME}
objects:
  - apiVersion: v1
    kind: DeploymentConfig
    metadata:
      name: ${SERVICE_FULLNAME}
      namespace: ${NAMESPACE}
      labels:
        app: ${SERVICE_FULLNAME}
        name: ${SERVICE_FULLNAME}
    spec:
      replicas: 1
      selector:
        app: ${SERVICE_FULLNAME}
        deploymentconfig: ${SERVICE_FULLNAME}
      triggers:
        - type: "ConfigChange"
      strategy:
        type: Rolling
      template:
        metadata:
          labels:
            app: ${SERVICE_FULLNAME}
            deploymentconfig: ${SERVICE_FULLNAME}
        spec:
          containers:
            - env:
                - name: APP_PROFILE
                  value: ${APP_PROFILE}
                - name: CLUSTER_NAME
                  value: ${OCP_CLUSTER_URL}
                - name: service_name
                  value: ${SERVICE_FULLNAME}
              image: ${BASE_IMAGE_VERSION}
              imagePullPolicy: Always
              name: ${SERVICE_NAME}
              volumeMounts:
                - name: appconfig
                  mountPath: "/opt/eap/modules/org/mariadb/jdbc/main/module.xml"
                  subPath: module.xml
                - name: appconfig
                  mountPath: "/opt/eap/modules/org/mariadb/jdbc/main/mariadb-java-client-3.5.1.jar"
                  subPath: mariadb-java-client-3.5.1.jar
                - name: nginx-config
                  mountPath: /etc/nginx
                  readOnly: true
                - name: nginx-server-certs
                  mountPath: /etc/nginx-server-certs
                  readOnly: true
              ports:
                - containerPort: 8443
                  protocol: TCP
              resources:
                limits:
                  cpu: 2000m
                  memory: 4096Mi
                requests:
                  cpu: 2000m
                  memory: 4096Mi
              envFrom:
                - configMapRef:
                    name: ${NAMESPACE}-${APP_PROFILE}-${CM_VALUE}-configmapvar
                - secretRef:
                    name: ${NAMESPACE}-${APP_PROFILE}-secretvar
              readinessProbe:
                tcpSocket:
                  port: 8443
                initialDelaySeconds: 30
                timeoutSeconds: 2
                periodSeconds: 15
                successThreshold: 1
                failureThreshold: 3
              livenessProbe:
                tcpSocket:
                  port: 8443
                initialDelaySeconds: 30
                timeoutSeconds: 2
                periodSeconds: 15
                successThreshold: 1
                failureThreshold: 6
              startupProbe:
                tcpSocket:
                  port: 8443
                initialDelaySeconds: 30
                timeoutSeconds: 2
                periodSeconds: 15
                successThreshold: 1
                failureThreshold: 6
          volumes:
            - name: appconfig
              configMap:
                name: ${NAMESPACE}-${APP_PROFILE}-${CM_VALUE}-configmapfile
            - name: appjks
              secret:
                secretName: ${NAMESPACE}-${APP_PROFILE}-retail-secret
            - name: nginx-config
              configMap:
                name: nginx-configmap
            - name: nginx-server-certs
              secret:
                secretName: nginx-server-certs
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "服务的全名。"
    required: true
  - name: NAMESPACE
    description: "当前命名空间的版本。"
    required: true
metadata: {}
objects:
  - kind: HorizontalPodAutoscaler
    apiVersion: autoscaling/v2
    metadata:
      name: ${SERVICE_FULLNAME}
      namespace: ${NAMESPACE}
    spec:
      scaleTargetRef:
        apiVersion: apps.openshift.io/v1
        kind: DeploymentConfig
        name: ${SERVICE_FULLNAME}
      minReplicas: 1
      maxReplicas: 8
      metrics:
        - resource:
            name: memory
            target:
              type: Utilization
              averageUtilization: 80
          type: Resource
        - resource:
            name: cpu
            target:
              type: Utilization
              averageUtilization: 80
          type: Resource
---
kind: Template
apiVersion: v1
parameters:
  - name: GREEN_SERVICE_FULLNAME
    description: "绿色路由中的服务全名"
    required: true
  - name: SERVICE_FULLNAME
    description: "服务的全名"
    required: true
  - name: WILDCARD_DNS
    description: "集群的 DNS"
    required: true
  - name: NAMESPACE
    description: "当前命名空间的版本。"
    required: true
objects:
  - kind: Route
    apiVersion: v1
    metadata:
      labels:
        app: ${GREEN_SERVICE_FULLNAME}
      name: ${GREEN_SERVICE_FULLNAME}
      namespace: ${NAMESPACE}
      annotations:
        haproxy.router.openshift.io/balance: roundrobin
    spec:
      host: ${GREEN_SERVICE_FULLNAME}-${NAMESPACE}.${WILDCARD_DNS}
      port:
        targetPort: 8443-tcp
      tls:
        termination: passthrough
      to:
        kind: Service
        name: ${SERVICE_FULLNAME}
    status: {}
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_NAME
    description: "路由中服务的全名。"
    required: true
  - name: SERVICE_FULLNAME
    description: "路由中服务的全名。"
    required: true
  - name: APP_DOMAIN
    description: "该服务的环境。"
    required: true
  - name: NAMESPACE
    description: "当前命名空间的版本。"
    required: true
objects:
  - kind: Route
    apiVersion: v1
    metadata:
      labels:
        app: ${SERVICE_NAME}
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
      annotations:
        haproxy.router.openshift.io/balance: random
        haproxy.router.openshift.io/disable_cookies: "true"
    spec:
      host: ${APP_DOMAIN}
      port:
        targetPort: 8443-tcp
      tls:
        termination: passthrough
      to:
        kind: Service
        name: ${SERVICE_FULLNAME}
    status: {}
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "服务的全名。"
    required: true
  - name: SERVICE_NAME
    description: "服务的名称。"
    required: true
  - name: APP_PROFILE
    description: "部署的环境。"
    required: true
  - name: NAMESPACE
    description: "当前命名空间的版本。"
    required: true
  - name: ENV_DOMAIN
    description: "相应环境的域名。"
    required: true
  - name: HOST
    description: "域名的主机"
    required: true
metadata:
  name: ${SERVICE_FULLNAME}
  labels:
    app: ${SERVICE_FULLNAME}
    name: ${SERVICE_FULLNAME}
objects:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: ${NAMESPACE}-${APP_PROFILE}-secretvar
      namespace: ${NAMESPACE}
    type: Opaque
    data:
      secretvar: aGVsbG8= # Base64 编码的 "hello"
  - apiVersion: v1
    kind: Secret
    metadata:
      name: ${NAMESPACE}-${APP_PROFILE}-retail-secret
      namespace: ${NAMESPACE}
    type: Opaque
    data:
      ${HOST}.${ENV_DOMAIN}.jks: aGVsbG8= # Base64 编码的 "hello"
  - apiVersion: v1
    data:
      tls.crt: "example"
      tls.key: "example"
    kind: Secret
    metadata:
      name: nginx-server-certs
      namespace: ${NAMESPACE}
    type: kubernetes.io/tls
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "服务的全名。"
    required: true
  - name: NAMESPACE
    description: "当前命名空间的版本。"
    required: true
objects:
  - kind: Service
    apiVersion: v1
    metadata:
      annotations:
        openshift.io/generated-by: OpenShiftWebConsole
      labels:
        app: ${SERVICE_FULLNAME}
      name: ${SERVICE_FULLNAME}-1
      namespace: ${NAMESPACE}
    spec:
      ports:
        - name: 8443-tcp
          port: 8443
          protocol: TCP
          targetPort: 8443
        - name: metrics
          port: 9990
          protocol: TCP
          targetPort: 9990
      selector:
        app: ${SERVICE_FULLNAME}
        deploymentconfig: ${SERVICE_FULLNAME}
      sessionAffinity: None
      type: ClusterIP
    status:
      loadBalancer: {}
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "服务的全名。"
    required: true
  - name: NAMESPACE
    description: "当前命名空间的版本。"
    required: true
objects:
  - kind: Service
    apiVersion: v1
    metadata:
      annotations:
        openshift.io/generated-by: OpenShiftWebConsole
      labels:
        app: ${SERVICE_FULLNAME}
      name: ${SERVICE_FULLNAME}
      namespace: ${NAMESPACE}
    spec:
      ports:
        - name: 8443-tcp
          port: 8446
          protocol: TCP
          targetPort: 8443
        - name: metrics
          port: 9990
          protocol: TCP
          targetPort: 9990
      selector:
        app: ${SERVICE_FULLNAME}
        deploymentconfig: ${SERVICE_FULLNAME}
      sessionAffinity: None
      type: ClusterIP
    status:
      loadBalancer: {}

```

### 3. 转换 OCP 特定资源

使用 `oc-convert` 将 OCP 特定资源（例如，`DeploymentConfig`、`Route`）转换为 Kubernetes 兼容资源。

`oc-convert` 命令支持以下标志：

- `-i, --input <string>`
  指定 OpenShift 模板文件或目录的路径。可以是相对路径或绝对路径。

- `-o, --output <string>`
  定义转换后的模板文件将保存的路径。

- `--gateway <string>`
  指定 Istio Gateway，格式为 `gw-namespace/gw-name`。此选项将 Route 转换为 Istio Gateway 资源。

- `--ingress <string>`
  指定 Ingress Nginx 类名，默认值为 `nginx`。此选项将 Route 转换为 Ingress 资源。`--gateway` 和 `--ingress` 标志不能同时使用。

`oc-convert` 工具执行以下转换：

- 将 `DeploymentConfig` 转换为 `Deployment`，通过：
  - 调整 `spec.selector` 以符合 Kubernetes 标准。
  - 修改 `spec.strategy` 以使用 Kubernetes 滚动更新或重建策略。
  - 删除 OCP 特定的 `spec.template.triggers`。
- 如果使用 `--gateway`，则将 `Route` 转换为 Istio 兼容资源（例如，`VirtualService`、`DestinationRule`）。
- 如果使用 `--ingress`，则将 `Route` 转换为 Ingress-Nginx 兼容资源（例如，`Ingress`）。

#### 场景 1: 使用 Ingress Nginx

```shell
# 将 Route 转换为 Ingress
oc-convert --input ocp-yaml/ --output output.yaml --ingress <ingress-class-name>
```

输出文件（`output.yaml`）是一个包含所有转换资源的综合模板。检查 `output.yaml` 以确保所有资源都已正确转换：

```yaml
# cat output.yaml

kind: Template
apiVersion: v1
parameters:
- name: SERVICE_FULLNAME
  description: 服务的全名
  required: true
- name: ...
metadata: {}
objects:
- apiVersion: apps/v1
  kind: Deployment
  metadata:
    ...
  spec:
    ...
- apiVersion: autoscaling/v2
  kind: HorizontalPodAutoscaler
  ...
- apiVersion: networking.k8s.io/v1
  kind: Ingress
  ...
```

验证：

- `DeploymentConfig` 已被替换为 `Deployment`。
- `Route` 已被替换为 `Ingress`：

  ```yaml
  - apiVersion: networking.k8s.io/v1
    kind: Ingress
    metadata:
      annotations:
        nginx.ingress.kubernetes.io/backend-protocol: HTTPS
        nginx.ingress.kubernetes.io/load-balance: round_robin
        nginx.ingress.kubernetes.io/ssl-passthrough: "true"
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
    spec:
      ingressClassName: ${NGINX_INGRESS_NAME}
      rules:
        - host: ${APP_DOMAIN}
          http:
            paths:
              - backend:
                  service:
                    name: ${SERVICE_FULLNAME}
                    port:
                      number: 8443
                path: /
                pathType: Prefix
      tls:
        - hosts:
            - ${APP_DOMAIN}
  ```

#### 场景 2: 使用 Istio Gateway

```shell
# 将 Route 转换为 Istio Gateway
oc-convert --input ocp-yaml/ --output output.yaml --gateway
```

验证：

- `DeploymentConfig` 已被替换为 `Deployment`。

- `Route` 已被替换为 `VirtualService` 和 `DestinationRule`：

  ```yaml
  - apiVersion: networking.istio.io/v1
    kind: VirtualService
    metadata:
      labels:
        cpaas.io/gw-name: ${ISTIO_GATEWAY_NAME}
        cpaas.io/gw-ns: ${ISTIO_GATEWAY_NAMESPACE}
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
    spec:
      gateways:
        - ${ISTIO_GATEWAY_NAMESPACE}/${ISTIO_GATEWAY_NAME}
      hosts:
        - ${APP_DOMAIN}
      tls:
        - match:
            - port: 443
              sniHosts:
                - ${APP_DOMAIN}
          route:
            - destination:
                host: ${SERVICE_FULLNAME}.${NAMESPACE}.svc.cluster.local
                port:
                  number: 8443
              weight: 100
  - apiVersion: networking.istio.io/v1
    kind: DestinationRule
    metadata:
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
    spec:
      host: ${SERVICE_FULLNAME}.${NAMESPACE}.svc.cluster.local
      trafficPolicy:
        loadBalancer:
          simple: RANDOM # 或 ROUND_ROBIN
  ```

- 其他资源（例如，`Service`、`HorizontalPodAutoscaler`）保持兼容。

### 4. 将 OCP 模板转换为 Helm 图表

使用 `template2helm` 将综合模板转换为 Helm 图表。

```bash
# 将综合模板转换为 Helm 图表
template2helm convert -t output.yaml
```

此命令生成一个 `output/` 目录（与 `output.yaml` 文件同名），其中包含 Helm 图表结构：

- `Chart.yaml`: Helm 图表的元数据。
- `values.yaml`: 默认配置值。
- `templates/`: Kubernetes 资源模板。
- `charts/`: 依赖项（如果有）。

审查并在必要时修改生成的 Helm 图表：

```bash
ls output
# 预期输出: Chart.yaml  values.yaml  templates/

tree output
# 示例输出目录
output
├── Chart.yaml
├── templates
│   ├── configmap.yaml
│   ├── deployment.yaml
│   ├── destinationrule.yaml
│   ├── horizontalpodautoscaler.yaml
│   ├── secret.yaml
│   ├── service.yaml
│   └── virtualservice.yaml
└── values.yaml
```

此时，OCP YAML 文件已成功迁移到 ACP 应用程序图表。该图表应保存在代码库中，以便后续的应用程序发布。

## 从 Helm 图表部署应用程序

在初始 Helm 图表转换之后，后续的应用程序发布可以通过 CI/CD 管道进行管理。管道可以使用 `helm template` 命令和更新的参数来渲染 Kubernetes YAML 文件，然后使用 `kubectl apply` 与渲染的 YAML 进行应用程序更新。

### 1. 从图表渲染 Kubernetes YAML

使用 Helm 生成应用程序的最终 Kubernetes 清单：

```bash
# 进入输出目录
cd output

# 使用 --set 参数更新变量并预览
helm template . \
  --set BASE_IMAGE_VERSION=<your-registry-url> \
  --set NAMESPACE=<your-namespace> \
  --set SERVICE_FULLNAME=<your-service-name> > rendered.yaml
```

要仅更新应用程序的单个资源，请仅渲染其对应的 YAML 文件：

```bash
# 预览特定的 YAML 文件
helm template . \
  --set BASE_IMAGE_VERSION=<your-registry-url> \
  --set NAMESPACE=<your-namespace> \
  --set SERVICE_FULLNAME=<your-service-name> \
  -s templates/deployment.yaml > rendered.yaml  # 仅预览 deployment.yaml
```

验证生成的 YAML 的正确性：

```bash
# 登录到 ACP
kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name>

# 使用 dry-run 检查错误
kubectl apply --dry-run=client -f rendered.yaml
```

检查 `rendered.yaml` 以确保：

- 正确的镜像引用。
- 正确的命名空间范围。
- 有效的 Istio `VirtualService` 和 `DestinationRule` 配置。
- 适当的资源限制和安全上下文。

### 2. 将应用程序部署到 Alauda 容器平台

部署渲染的清单：

```bash
# 应用资源
kubectl apply -f rendered.yaml
```

检查已部署资源的状态：

```bash
# 检查部署
kubectl get deployments -n <your-namespace>

# 检查 Pods
kubectl get pods -n <your-namespace>

# 检查服务
kubectl get svc -n <your-namespace>

# 检查 virtualservices
kubectl get virtualservice -n <your-namespace>
```

## 结论

通过使用预先准备的清单以及 `oc-convert`、`template2helm` 和 Helm 工具，从 OCP 到 ACP 的迁移得以简化，使 OCP 特定资源向 Kubernetes 原生部署的平稳过渡。遵循本指南可以高效地进行应用程序迁移，同时利用 ACP 的高级功能，例如基于 Istio 的网络和 Argo Rollouts 部署策略。

如需更多支持，请查阅 Alauda 容器平台文档或联系 ACP 支持团队。
