---
kind:
  - Article
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260500065
sourceSHA: 534acd415f1def491762586d8e5af1ff2402d10e3d43d8767def6ea6e7409514
---

# 如何使用 Camel Quarkus

## 受众和范围

本文档描述了一个实用的 Camel Quarkus 实现，可以在 Kubernetes 上构建、部署和验证。它旨在为需要可重复参考的 API 聚合、API 编排、模拟后端部署、容器镜像构建和 Kubernetes 验证的平台用户和解决方案工程师提供指导。

示例使用了两种主要的集成模式：

- API 聚合：将用户详细信息和订单数据合并为单个响应。
- API 编排：验证用户、检查库存、创建订单并返回统一结果。

本文档还包括从实际 Kubernetes 环境中获得的部署注意事项，包括 Quarkus `fast-jar` 打包、容器镜像架构、Harbor/containerd 兼容性和常见运行时问题。

## 先决条件

所需工具：

| 工具     | 推荐版本                                         | 目的                                    |
| -------- | ------------------------------------------------ | --------------------------------------- |
| JDK      | 推荐 21，支持 17（如果项目进行了调整）          | 编译和运行应用程序                      |
| Maven    | 3.9+                                            | 构建项目                                |
| Podman   | 最新稳定版本                                    | 构建和推送容器镜像                      |
| kubectl  | 与目标集群兼容                                  | 部署和验证 Kubernetes 资源              |
| curl     | 任何近期版本                                    | API 验证                                |

验证本地环境：

```bash
java -version
mvn -version
podman info
kubectl version --client
kubectl get nodes
```

为所有 Kubernetes 命令定义一个命名空间：

```bash
export NS=<your-namespace>
```

## 项目创建

使用 Quarkus CLI 创建应用程序：

```bash
quarkus create app com.example:camel-quarkus-demo \
  --extension="camel-quarkus-platform-http,camel-quarkus-http,camel-quarkus-jackson,camel-quarkus-rest"
cd camel-quarkus-demo
```

如果 Quarkus CLI 不可用，可以从 `https://code.quarkus.io` 生成项目，参数如下：

- 组：`com.example`
- 工件：`camel-quarkus-demo`
- 构建工具：Maven
- Java 版本：21
- 扩展：`camel-quarkus-platform-http`、`camel-quarkus-http`、`camel-quarkus-jackson`、`camel-quarkus-rest`

预期的项目布局：

```text
camel-quarkus-demo/
|-- pom.xml
|-- src/
|   `-- main/
|       |-- java/com/example/routes/
|       |   |-- UserOrderAggregatorRoute.java
|       |   `-- OrderOrchestrationRoute.java
|       `-- resources/application.properties
`-- k8s/
    |-- mock-api.yaml
    |-- wiremock-api.yaml
    `-- camel-app.yaml
```

## 所需依赖

这两个用例的最小依赖集为：

```xml
<dependencies>
  <dependency>
    <groupId>org.apache.camel.quarkus</groupId>
    <artifactId>camel-quarkus-platform-http</artifactId>
  </dependency>
  <dependency>
    <groupId>org.apache.camel.quarkus</groupId>
    <artifactId>camel-quarkus-http</artifactId>
  </dependency>
  <dependency>
    <groupId>org.apache.camel.quarkus</groupId>
    <artifactId>camel-quarkus-jackson</artifactId>
  </dependency>
  <dependency>
    <groupId>org.apache.camel.quarkus</groupId>
    <artifactId>camel-quarkus-rest</artifactId>
  </dependency>
  <dependency>
    <groupId>io.quarkus</groupId>
    <artifactId>quarkus-arc</artifactId>
  </dependency>
</dependencies>
```

如果使用 Kubernetes 健康探针，请添加：

```xml
<dependency>
  <groupId>io.quarkus</groupId>
  <artifactId>quarkus-smallrye-health</artifactId>
</dependency>
```

## 应用程序配置

使用最小的 `src/main/resources/application.properties`：

```properties
quarkus.application.name=camel-quarkus-demo
quarkus.http.port=8080
quarkus.log.category."org.apache.camel".level=INFO
```

不要为此项目配置 `camel.main.routes-discovery-enabled=true`。使用 Camel Quarkus，带有 `@ApplicationScoped` 注解的 CDI 管理的 `RouteBuilder` 类会自动注册。

## 用例 1：API 聚合

### 场景

前端需要一个返回以下内容的单一 API：

- 从 `GET /user/{userId}` 获取用户信息
- 从 `GET /orders?userId={userId}` 获取最近的订单

### 路由实现

创建 `src/main/java/com/example/routes/UserOrderAggregatorRoute.java`：

```java
package com.example.routes;

import org.apache.camel.AggregationStrategy;
import org.apache.camel.builder.RouteBuilder;

import jakarta.enterprise.context.ApplicationScoped;

@ApplicationScoped
public class UserOrderAggregatorRoute extends RouteBuilder {

    @Override
    public void configure() {
        AggregationStrategy userOrderStrategy = (oldExchange, newExchange) -> {
            if (oldExchange == null) {
                return newExchange;
            }
            String userJson = oldExchange.getIn().getBody(String.class);
            String orderJson = newExchange.getIn().getBody(String.class);
            oldExchange.getIn().setBody(
                String.format("{ \"user\": %s, \"orders\": %s }", userJson, orderJson));
            return oldExchange;
        };

        from("platform-http:/aggregate?httpMethodRestrict=GET")
            .routeId("user-order-api")
            .log("Received aggregation request, userId: ${header.userId}")
            .multicast(userOrderStrategy).parallelProcessing()
                .toD("http://mock-api/user/${header.userId}?bridgeEndpoint=true")
                .toD("http://mock-api/orders?userId=${header.userId}&bridgeEndpoint=true")
            .end()
            .setHeader("Content-Type", constant("application/json"))
            .log("Aggregation result: ${body}");
    }
}
```

### 关键点

- `@ApplicationScoped` 使路由成为 CDI bean，以便 Camel Quarkus 可以发现它。
- `platform-http` 在没有 servlet 容器的情况下公开 HTTP 端点。
- `multicast().parallelProcessing()` 同时调用两个下游服务。
- `toD` 从请求头构建动态端点 URI。

## 用例 2：API 编排

### 场景

订单 API 必须：

1. 验证用户。
2. 检查库存。
3. 创建订单。
4. 返回一致的成功或错误响应。

### 路由实现

创建 `src/main/java/com/example/routes/OrderOrchestrationRoute.java`：

```java
package com.example.routes;

import org.apache.camel.Exchange;
import org.apache.camel.builder.RouteBuilder;
import org.apache.camel.model.dataformat.JsonLibrary;
import org.apache.camel.model.rest.RestBindingMode;

import jakarta.enterprise.context.ApplicationScoped;

import java.util.Map;

@ApplicationScoped
public class OrderOrchestrationRoute extends RouteBuilder {

    @Override
    public void configure() {
        restConfiguration()
            .component("platform-http")
            .bindingMode(RestBindingMode.json);

        rest("/api")
            .post("/place-order")
            .consumes("application/json")
            .produces("application/json")
            .to("direct:orchestrateOrder");

        from("direct:orchestrateOrder")
            .routeId("order-orchestration-route")
            .setProperty("requestBody", body())

            .setHeader(Exchange.HTTP_METHOD, constant("GET"))
            .process(exchange -> {
                Map<?, ?> requestBody = exchange.getIn().getBody(Map.class);
                exchange.getIn().setHeader("userId", requestBody.get("userId"));
            })
            .toD("http://wiremock-api/users/${header.userId}"
                + "?bridgeEndpoint=true&throwExceptionOnFailure=false")
            .choice()
                .when(header(Exchange.HTTP_RESPONSE_CODE).isNotEqualTo(200))
                    .setHeader(Exchange.HTTP_RESPONSE_CODE, constant(400))
                    .setBody(constant("{\"error\":\"Invalid user\"}"))
                    .stop()
            .end()

            .setBody(exchange -> exchange.getProperty("requestBody"))
            .setHeader(Exchange.HTTP_METHOD, constant("GET"))
            .process(exchange -> {
                Map<?, ?> requestBody = exchange.getIn().getBody(Map.class);
                exchange.getIn().setHeader("itemId", requestBody.get("itemId"));
            })
            .toD("http://wiremock-api/inventory/${header.itemId}"
                + "?bridgeEndpoint=true&throwExceptionOnFailure=false")
            .unmarshal().json(JsonLibrary.Jackson)
            .choice()
                .when(exchange -> {
                    Map<?, ?> inventory = exchange.getIn().getBody(Map.class);
                    Object stock = inventory.get("stock");
                    return stock instanceof Number number && number.intValue() <= 0;
                })
                    .setHeader(Exchange.HTTP_RESPONSE_CODE, constant(400))
                    .setBody(constant("{\"error\":\"Out of stock\"}"))
                    .stop()
            .end()

            .setBody(exchange -> exchange.getProperty("requestBody"))
            .setHeader(Exchange.HTTP_METHOD, constant("POST"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"))
            .marshal().json(JsonLibrary.Jackson)
            .to("http://wiremock-api/orders?bridgeEndpoint=true&throwExceptionOnFailure=false")

            .setHeader(Exchange.HTTP_RESPONSE_CODE, constant(201))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));
    }
}
```

### 关键点

- 路由在调用下游服务之前将原始请求体保存在交换属性中。
- 实现从 `Map` 中读取 JSON 请求字段，而不是使用 `${body[...]}` 表达式。这避免了在运行时需要额外的 Camel 语言支持。
- `throwExceptionOnFailure=false` 允许路由显式处理非 2xx 的下游响应。

## 在 Kubernetes 上模拟后端服务

示例假设有两个 Kubernetes 服务：

- `mock-api`：用于聚合用例的 JSON 服务器。
- `wiremock-api`：用于编排用例的 WireMock。

### 部署模拟服务

准备 `k8s/mock-api.yaml` 和 `k8s/wiremock-api.yaml`，然后部署：

```bash
kubectl apply -f k8s/mock-api.yaml -n $NS
kubectl apply -f k8s/wiremock-api.yaml -n $NS
kubectl rollout status deployment/mock-api -n $NS
kubectl rollout status deployment/wiremock-api -n $NS
```

### 验证模拟服务

使用端口转发进行快速验证：

```bash
kubectl port-forward svc/mock-api 8081:80 -n $NS &
kubectl port-forward svc/wiremock-api 8082:80 -n $NS &

curl http://localhost:8081/user/1
curl "http://localhost:8081/orders?userId=1"

curl http://localhost:8082/users/123
curl http://localhost:8082/inventory/A001
curl -X POST http://localhost:8082/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":123,"itemId":"A001"}'
```

预期结果：

- `mock-api /user/1` 返回 Alice 的用户资料。
- `mock-api /orders?userId=1` 返回用户的订单列表。
- `wiremock-api /users/123` 返回 HTTP 200。
- `wiremock-api /inventory/A001` 返回库存大于 0。
- `wiremock-api /orders` 返回生成的订单响应。

## 构建和打包应用程序

运行：

```bash
./mvnw clean package -DskipTests
```

Quarkus 默认生成 `fast-jar` 布局：

```text
target/
|-- camel-quarkus-demo-1.0.0.jar
`-- quarkus-app/
    |-- app/
    |-- lib/
    |-- quarkus/
    `-- quarkus-run.jar
```

不要仅通过复制 `target/camel-quarkus-demo-1.0.0.jar` 来打包此应用程序。运行时需要完整的 `target/quarkus-app/` 目录。

## 推荐的 Containerfile

在项目根目录创建 `Containerfile`：

```dockerfile
FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

COPY target/quarkus-app/lib/ /app/lib/
COPY target/quarkus-app/*.jar /app/
COPY target/quarkus-app/app/ /app/app/
COPY target/quarkus-app/quarkus/ /app/quarkus/

EXPOSE 8080

ENTRYPOINT ["java", "-Dquarkus.http.host=0.0.0.0", "-Djava.util.logging.manager=org.jboss.logmanager.LogManager", "-jar", "/app/quarkus-run.jar"]
```

确保 `.dockerignore` 允许递归的 `quarkus-app` 目录：

```text
*
!target/quarkus-app/
!target/quarkus-app/**
```

## 构建和推送容器镜像

设置目标镜像：

```bash
export IMAGE=<registry>/<project>/camel-quarkus-demo:<tag>
```

构建并推送：

```bash
podman build -t $IMAGE -f Containerfile .
podman push $IMAGE
```

对于 `amd64` Kubernetes 集群：

```bash
podman build --platform linux/amd64 -t $IMAGE -f Containerfile .
podman push $IMAGE
```

对于 `arm64` Kubernetes 集群：

```bash
podman build --platform linux/arm64 -t $IMAGE -f Containerfile .
podman push $IMAGE
```

对于 ARM + containerd 环境，OCI 格式通常比强制 Docker 格式更安全：

```bash
podman build --platform linux/arm64 --format oci -t $IMAGE -f Containerfile .
podman push --format oci $IMAGE
```

在故障排除期间避免重复使用 `latest`。使用新标签，如 `arm64-oci-001` 或 `amd64-fix-001`，以便节点不重用过时的缓存层。

## Kubernetes 应用程序清单

创建 `k8s/camel-app.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: camel-quarkus-demo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: camel-quarkus-demo
  template:
    metadata:
      labels:
        app: camel-quarkus-demo
    spec:
      containers:
        - name: camel-quarkus-demo
          image: <registry>/<project>/camel-quarkus-demo:<tag>
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
          env:
            - name: QUARKUS_HTTP_PORT
              value: "8080"
---
apiVersion: v1
kind: Service
metadata:
  name: camel-quarkus-demo
spec:
  selector:
    app: camel-quarkus-demo
  ports:
    - port: 80
      targetPort: 8080
```

如果包含 `quarkus-smallrye-health`，请添加探针：

```yaml
readinessProbe:
  httpGet:
    path: /q/health/ready
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
livenessProbe:
  httpGet:
    path: /q/health/live
    port: 8080
  initialDelaySeconds: 20
  periodSeconds: 10
```

部署：

```bash
kubectl apply -f k8s/camel-app.yaml -n $NS
kubectl rollout status deployment/camel-quarkus-demo -n $NS
kubectl get pod,svc -n $NS -l app=camel-quarkus-demo
```

## Kubernetes 验证

当外部 Ingress 或 NodePort 不可用时，使用端口转发：

```bash
kubectl port-forward svc/camel-quarkus-demo 8080:80 -n $NS &
export APP_HOST=http://localhost:8080
```

### API 聚合

```bash
curl -i "$APP_HOST/aggregate?userId=1"
```

预期响应：

```json
{
  "user": {
    "id": 1,
    "name": "Alice",
    "email": "alice@example.com"
  },
  "orders": [
    { "orderId": 1, "userId": 1, "item": "Book" },
    { "orderId": 2, "userId": 1, "item": "Laptop" }
  ]
}
```

### API 编排

成功的订单：

```bash
curl -i -X POST "$APP_HOST/api/place-order" \
  -H "Content-Type: application/json" \
  -d '{"userId":123,"itemId":"A001"}'
```

预期：HTTP 201 和生成的 `orderId`。

无效用户：

```bash
curl -i -X POST "$APP_HOST/api/place-order" \
  -H "Content-Type: application/json" \
  -d '{"userId":13,"itemId":"A001"}'
```

预期：HTTP 400 和：

```json
{"error":"Invalid user"}
```

缺货：

```bash
curl -i -X POST "$APP_HOST/api/place-order" \
  -H "Content-Type: application/json" \
  -d '{"userId":123,"itemId":"A003"}'
```

预期：HTTP 400 和：

```json
{"error":"Out of stock"}
```

检查日志：

```bash
kubectl logs -n $NS -l app=camel-quarkus-demo --tail=100
```

## 故障排除

### 路由启动失败，出现 `routesDiscoveryEnabled`

症状：

```text
Error binding property (camel.main.routesDiscoveryEnabled=true)
```

原因：`camel.main.routes-discovery-enabled` 对于当前的 Camel Quarkus 运行时无效。

修复：删除该属性。在 `RouteBuilder` 类上使用 `@ApplicationScoped`。

### 路由启动失败，出现 `No language could be found for: bean`

症状：

```text
No language could be found for: bean
```

原因：表达式如 `${body[userId]}` 可能需要运行时不存在的语言支持。

修复：在 `.process(...)` 中将 JSON 请求数据作为 `Map` 读取，如编排路由所示。

### Pod 无法从 Docker Hub 拉取镜像

症状：

```text
failed to pull image ... dial tcp ... i/o timeout
```

原因：集群节点无法访问 Docker Hub 或公共注册表。

修复选项：

- 将镜像镜像到内部注册表。
- 在集群节点上配置注册表镜像。
- 配置节点级的出站/代理访问。
- 使用批准的内部基础镜像。

### 向 Harbor 推送镜像失败，出现 `unauthorized`

症状：

```text
unauthorized to access repository, action: push
```

原因：当前 Harbor 用户或机器人账户没有项目的推送权限。

修复：

```bash
podman logout <harbor>
podman login <harbor>
```

然后推送到用户具有写权限的项目。

### 容器失败，出现 `exec format error`

症状：

```text
exec /opt/java/openjdk/bin/java: exec format error
```

原因：镜像架构与节点架构不匹配。

检查节点架构：

```bash
kubectl get node -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.nodeInfo.architecture}{"\n"}{end}'
```

为正确的架构重新构建：

```bash
podman build --platform linux/amd64 -t $IMAGE -f Containerfile .
podman push $IMAGE
```

或：

```bash
podman build --platform linux/arm64 -t $IMAGE -f Containerfile .
podman push $IMAGE
```

使用新标签以避免节点端镜像缓存重用。

### containerd 拉取失败，出现 `archive/tar: invalid tar header`

症状：

```text
archive/tar: invalid tar header
```

可能原因：

- Docker 镜像格式与 containerd/Harbor 兼容性问题。
- 在推送或注册表存储期间层内容损坏。
- 重用的标签指向过时或不一致的层。
- 架构或基础镜像层兼容性问题。

针对 ARM + containerd 的推荐测试：

```bash
export IMAGE=<harbor>/<project>/camel-quarkus-demo:arm64-oci-001
podman build --platform linux/arm64 --format oci -t $IMAGE -f Containerfile .
podman push --format oci $IMAGE
nerdctl --namespace k8s.io pull $IMAGE --insecure-registry --debug
```

如果问题仍然存在，暂时将基础镜像从：

```dockerfile
FROM eclipse-temurin:21-jre-alpine
```

更改为：

```dockerfile
FROM eclipse-temurin:21-jre
```

然后重新构建并再次测试。

### 健康探针失败

如果探针调用 `/q/health/ready` 和 `/q/health/live`，确保包含 `quarkus-smallrye-health`。否则，删除探针，让平台使用其默认的就绪策略。

### curl 似乎没有返回任何内容

使用 `-i`、`-v` 和超时：

```bash
curl -i -v --max-time 15 "$APP_HOST/api/place-order" \
  -H "Content-Type: application/json" \
  -d '{"userId":123,"itemId":"A001"}'
```

`curl` 默认只打印响应体。如果响应体为空，该命令看起来可能没有返回任何内容，即使返回了 HTTP 状态。

## 操作检查清单

在考虑部署完成之前，请验证：

- `mock-api` 部署可用。
- `wiremock-api` 部署可用。
- `camel-quarkus-demo` Pod 正在运行并准备就绪。
- `/aggregate?userId=1` 返回合并的用户和订单响应。
- `/api/place-order` 对 `userId=123,itemId=A001` 返回 HTTP 201。
- `/api/place-order` 对无效用户返回 HTTP 400。
- `/api/place-order` 对缺货库存返回 HTTP 400。
- 应用程序日志显示 Camel 路由活动。

有用的命令：

```bash
kubectl get all -n $NS
kubectl logs -f -n $NS -l app=camel-quarkus-demo
kubectl rollout restart deployment/camel-quarkus-demo -n $NS
kubectl delete -f k8s/ -n $NS
```
