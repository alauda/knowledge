---
products:
  - Alauda Container Platform
  - Alauda DevOps
kind:
  - Solution
id: KB250700002
sourceSHA: bb2615eee6b1ae25524a1b828fd792922c1d6548659aaa9a3df353849dafb9e0
---

# 利用 Knative Eventing 进行云事件的发布与消费

## 概述

Knative Eventing 是一个强大的系统，用于在 Kubernetes 上构建事件驱动的应用程序。它提供了一种标准化的方式来处理云事件，使事件生产者和消费者之间实现松耦合。本文档解释了应用程序开发人员如何利用 Knative Eventing 在 ACP（Alauda Container Platform）环境中发布和接收云事件。

### 理解 Knative Eventing

Knative Eventing 使应用程序能够生成和消费符合 CloudEvents 规范的事件。它提供了：

- **事件驱动架构**：将事件生产者与消费者解耦
- **标准化事件格式**：使用 CloudEvents 规范
- **可扩展性**：基于事件量的自动扩展
- **可靠性**：内置重试和死信队列机制
- **灵活性**：支持多种事件源和接收器

### 关键组件

![](/KB250700002/knative-eventing.png)

#### Broker

**Broker** 是一个中央集线器，接收事件并将其路由到适当的目的地。它充当事件网格，提供：

- 来自多个源的事件摄取
- 基于过滤器的事件路由
- 事件持久性和交付保证
- 与各种消息系统的集成

#### Trigger

**Trigger** 定义事件路由规则，指定：

- 事件过滤标准（事件类型、源、属性）
- 匹配事件的目标服务（订阅者）
- 重试和死信队列配置

#### 事件源

事件源生成事件并将其发送到 Broker。常见的源包括：

- HTTP 端点
- 消息队列
- 数据库变更
- 定时事件
- 自定义应用程序

### 先决条件

1. 安装了 `Knative Eventing` 的 Alauda Container Platform。以下步骤使用 `Alauda DevOps Eventing v3` 插件来部署 `Knative Eventing`。
2. 配备 `kubectl` 命令行工具和 `kubectl-acp` 插件
3. 在 ACP 中配置了项目和命名空间。假设本指南使用命名空间 `my-app-namespace`。
4. 使用 `kubectl acp login` 进行集群身份验证
5. 对 Kubernetes 资源和 CloudEvents 规范有基本了解

## 第 1 章. 设置 Knative Eventing 基础设施

### 创建 Broker

首先，在您的命名空间中使用默认配置创建一个 Broker 来处理事件路由：

```yaml
apiVersion: eventing.knative.dev/v1
kind: Broker
metadata:
  name: default
  namespace: my-app-namespace
```

将其保存为 `broker.yaml` 并应用：

```shell
kubectl apply -f broker.yaml
```

验证 Broker 是否准备就绪：

```shell
kubectl get broker default
```

Broker 应显示 `READY` 状态为 `True`。

```shell
NAME      URL                                                                                 AGE   READY   REASON
default   http://broker-ingress.knative-operator.svc.cluster.local/my-app-namespace/default   2s    True
```

### 创建事件源

创建一个事件源以生成示例事件。以下是使用 PingSource 的示例：

```yaml
apiVersion: sources.knative.dev/v1
kind: PingSource
metadata:
  name: ping-source
  namespace: my-app-namespace
spec:
  schedule: "*/1 * * * *"
  contentType: "application/json"
  data: '{"message": "Hello from PingSource"}'
  sink:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: default
```

将其保存为 `ping-source.yaml` 并应用：

```shell
kubectl apply -f ping-source.yaml
```

这将创建一个 PingSource，每分钟向 Broker 发送事件。有关更详细的参考，请参阅 [Knative 文档](https://knative.dev/docs/eventing/sources/ping-source/reference/)。

## 第 2 章. 构建事件消费者应用程序

### 创建简单的事件消费者

让我们创建一个简单的 HTTP 服务，接收并将事件输出为日志：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: event-display
  namespace: my-app-namespace
spec:
  replicas: 1
  selector:
    matchLabels: &labels
      app: event-display
  template:
    metadata:
      labels: *labels
    spec:
      containers:
        - name: event-display
          # 更改为内部注册表地址和镜像
          image: gcr.io/knative-releases/knative.dev/eventing/cmd/event_display

---

kind: Service
apiVersion: v1
metadata:
  name: event-display
  namespace: my-app-namespace
spec:
  selector:
    app: event-display

  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
```

将其保存为 `event-display.yaml` 并应用：

```shell
kubectl apply -f event-display.yaml
```

### 创建事件路由的 Trigger

创建一个 Trigger，将事件从 Broker 路由到您的消费者：

```yaml
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: ping-trigger
  namespace: my-app-namespace
spec:
  broker: default
  # 空过滤器意味着所有事件将发送到订阅者
  filters: []
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: event-display
```

将其保存为 `trigger.yaml` 并应用：

```shell
kubectl apply -f trigger.yaml
```

**YAML 字段解释：**

- `spec.broker`：引用要订阅的 Broker
- `spec.filters`：定义事件的过滤标准
- `spec.subscriber`：指定匹配事件的目标服务

有关 Trigger 的更详细参考，请参阅 [Knative 文档](https://knative.dev/docs/eventing/triggers/)。

### 验证事件流

检查事件显示的日志以验证其是否接收事件：

```shell
kubectl logs -f deployment/event-display
```

您应该看到日志条目，指示服务正在接收来自 PingSource 的事件，如下所示：

```shell
☁️  cloudevents.Event
Context Attributes,
  specversion: 1.0
  type: dev.knative.sources.ping
  source: /apis/v1/namespaces/my-app-namespace/pingsources/ping-source
  id: f4eb5186-dc5e-49be-bc7b-cc60ab863084
  time: 2025-07-09T12:39:00.126160549Z
  datacontenttype: application/json
Extensions,
  knativearrivaltime: 2025-07-09T12:39:00.134355865Z
Data,
  {
    "message": "Hello from PingSource"
  }
```

## 第 3 章. 为云事件启用 SpringBoot 应用程序

### 添加依赖项

将以下依赖项添加到您的 Spring Boot 应用程序的 `pom.xml` 中：

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
    <dependency>
        <groupId>io.cloudevents</groupId>
        <artifactId>cloudevents-core</artifactId>
        <version>2.5.0</version>
    </dependency>
    <dependency>
        <groupId>io.cloudevents</groupId>
        <artifactId>cloudevents-http-basic</artifactId>
        <version>2.5.0</version>
    </dependency>
    <dependency>
        <groupId>io.cloudevents</groupId>
        <artifactId>cloudevents-json-jackson</artifactId>
        <version>2.5.0</version>
    </dependency>
    <dependency>
        <groupId>com.fasterxml.jackson.datatype</groupId>
        <artifactId>jackson-datatype-jsr310</artifactId>
    </dependency>
</dependencies>
```

### 创建云事件消费者

创建一个 Spring Boot 控制器以接收云事件：

```java
package com.example.eventpublisher;

import io.cloudevents.CloudEvent;
import io.cloudevents.core.message.MessageReader;
import io.cloudevents.http.HttpMessageFactory;
import io.cloudevents.jackson.JsonFormat;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
public class EventConsumerController {

    private static final Logger logger = LoggerFactory.getLogger(EventConsumerController.class);

    @PostMapping("/")
    public ResponseEntity<String> receiveEvent(
            @RequestHeader HttpHeaders headers,
            @RequestBody(required = false) String body) {

        try {
            // 从 HTTP 请求中解析 CloudEvent
            MessageReader messageReader = HttpMessageFactory.createReader(
                headers.toSingleValueMap(),
                body != null ? body.getBytes() : new byte[0]
            );

            CloudEvent event = messageReader.toEvent();

            // 处理事件
            logger.info("Received CloudEvent:");
            logger.info("  ID: {}", event.getId());
            logger.info("  Type: {}", event.getType());
            logger.info("  Source: {}", event.getSource());
            logger.info("  Subject: {}", event.getSubject());
            logger.info("  Data: {}", new String(event.getData().toBytes()));

            // 这里是您的业务逻辑
            processEvent(event);

            return ResponseEntity.accepted().build();

        } catch (Exception e) {
            logger.error("Error processing event", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                                 .body("Error processing event: " + e.getMessage());
        }
    }

    private void processEvent(CloudEvent event) {
        // 在这里实现您的事件处理逻辑
        switch (event.getType()) {
            case "com.example.user.created":
                handleUserCreated(event);
                break;
            case "com.example.order.placed":
                handleOrderPlaced(event);
                break;
            default:
                logger.warn("Unknown event type: {}", event.getType());
        }
    }

    private void handleUserCreated(CloudEvent event) {
        logger.info("Processing user created event: {}", event.getId());
        // 添加您的用户创建处理逻辑
    }

    private void handleOrderPlaced(CloudEvent event) {
        logger.info("Processing order placed event: {}", event.getId());
        // 添加您的订单处理逻辑
    }
}
```

### 创建云事件发布者

在这一部分，我们将继续构建上一个部分创建的事件消费者。

有两种主要方法可以从 Spring Boot 应用程序发布 CloudEvents：

#### 方法 1：使用 CloudEvents HTTP 消息工厂（推荐）

此方法使用 CloudEvents HTTP 消息工厂来正确格式化和发送事件。它确保完全符合 CloudEvents 规范。

创建一个服务来发布云事件：

```java
package com.example.eventpublisher;

import io.cloudevents.CloudEvent;
import io.cloudevents.core.message.MessageWriter;
import io.cloudevents.core.builder.CloudEventBuilder;
import io.cloudevents.http.HttpMessageFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.time.OffsetDateTime;
import java.util.UUID;

@Service
public class EventPublisherService {

    private static final Logger logger = LoggerFactory.getLogger(EventPublisherService.class);

    @Value("${knative.broker.url:http://broker-ingress.knative-operator.svc.cluster.local/my-app-namespace/default}")
    private String brokerUrl;

    private final ObjectMapper objectMapper;

    public EventPublisherService() {
        this.objectMapper = new ObjectMapper();
        this.objectMapper.registerModule(new JavaTimeModule());
    }

    public void publishUserCreatedEvent(String userId, String userEmail) {
        try {
            // 创建事件数据
            UserCreatedData eventData = new UserCreatedData(userId, userEmail);

            // 将事件数据序列化为 JSON
            String eventDataJson = objectMapper.writeValueAsString(eventData);
            byte[] eventDataBytes = eventDataJson.getBytes();

            // 构建 CloudEvent
            CloudEvent event = CloudEventBuilder.v1()
                    .withId(UUID.randomUUID().toString())
                    .withType("com.example.user.created")
                    .withSource(URI.create("https://example.com/user-service"))
                    .withTime(OffsetDateTime.now())
                    .withData("application/json", eventDataBytes)
                    .build();

            // 发布事件
            publishEvent(event);

        } catch (Exception e) {
            logger.error("Error publishing user created event", e);
        }
    }

    public void publishOrderPlacedEvent(String orderId, String customerId, double amount) {
        try {
            // 创建事件数据
            OrderPlacedData eventData = new OrderPlacedData(orderId, customerId, amount);

            // 将事件数据序列化为 JSON
            String eventDataJson = objectMapper.writeValueAsString(eventData);
            byte[] eventDataBytes = eventDataJson.getBytes();

            // 构建 CloudEvent
            CloudEvent event = CloudEventBuilder.v1()
                    .withId(UUID.randomUUID().toString())
                    .withType("com.example.order.placed")
                    .withSource(URI.create("https://example.com/order-service"))
                    .withTime(OffsetDateTime.now())
                    .withData("application/json", eventDataBytes)
                    .build();

            // 发布事件
            publishEvent(event);

        } catch (Exception e) {
            logger.error("Error publishing order placed event", e);
        }
    }

    private void publishEvent(CloudEvent event) {
        try {
            URL url = URI.create(brokerUrl).toURL();
            HttpURLConnection httpUrlConnection = (HttpURLConnection) url.openConnection();
            httpUrlConnection.setRequestMethod("POST");
            httpUrlConnection.setDoOutput(true);
            httpUrlConnection.setDoInput(true);

            logger.info("Sending message to broker {}", brokerUrl);

            // 使用 CloudEvents HTTP 消息工厂写入事件
            MessageWriter messageWriter = createMessageWriter(httpUrlConnection);
            messageWriter.writeBinary(event);

            // 实际发送请求并获取响应
            int responseCode = httpUrlConnection.getResponseCode();
            logger.info("Broker response code: {}", responseCode);

            if (responseCode >= 200 && responseCode < 300) {
                logger.info("Successfully published event: {} ({})", event.getId(), event.getType());
            } else {
                // 读取错误响应
                String errorResponse = "";
                try {
                    errorResponse = new String(httpUrlConnection.getErrorStream().readAllBytes());
                } catch (Exception e) {
                    // 忽略读取错误流时的错误
                }
                logger.error("Failed to publish event. Response code: {}, Error: {}", responseCode, errorResponse);
                throw new RuntimeException("Failed to publish event. Response code: " + responseCode);
            }

        } catch (Exception e) {
            logger.error("Error publishing event to broker", e);
            throw new RuntimeException("Failed to publish event", e);
        }
    }

    private static MessageWriter createMessageWriter(HttpURLConnection httpUrlConnection) {
        return HttpMessageFactory.createWriter(
            httpUrlConnection::setRequestProperty,
            body -> {
                try {
                    if (body != null) {
                        httpUrlConnection.setRequestProperty("content-length", String.valueOf(body.length));
                        try (OutputStream outputStream = httpUrlConnection.getOutputStream()) {
                            outputStream.write(body);
                        }
                    } else {
                        httpUrlConnection.setRequestProperty("content-length", "0");
                    }
                } catch (IOException t) {
                    throw new UncheckedIOException(t);
                }
            });
    }

    // 事件数据类
    public static class UserCreatedData {
        private String userId;
        private String email;

        public UserCreatedData(String userId, String email) {
            this.userId = userId;
            this.email = email;
        }

        // Getter 和 Setter
        public String getUserId() { return userId; }
        public void setUserId(String userId) { this.userId = userId; }
        public String getEmail() { return email; }
        public void setEmail(String email) { this.email = email; }
    }

    public static class OrderPlacedData {
        private String orderId;
        private String customerId;
        private double amount;

        public OrderPlacedData(String orderId, String customerId, double amount) {
            this.orderId = orderId;
            this.customerId = customerId;
            this.amount = amount;
        }

        // Getter 和 Setter
        public String getOrderId() { return orderId; }
        public void setOrderId(String orderId) { this.orderId = orderId; }
        public String getCustomerId() { return customerId; }
        public void setCustomerId(String customerId) { this.customerId = customerId; }
        public double getAmount() { return amount; }
        public void setAmount(double amount) { this.amount = amount; }
    }
}
```

### 配置

将以下内容添加到您的 `application.yml` 中：

```yaml
server:
  port: 8080

knative:
  broker:
    url: http://broker-ingress.knative-operator.svc.cluster.local/my-app-namespace/default

logging:
  level:
    com.example: DEBUG
```

### 创建用于测试的 REST 控制器

创建一个 REST 控制器以触发事件发布：

```java
package com.example.eventpublisher;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class EventTriggerController {

    @Autowired
    private EventPublisherService eventPublisherService;

    @PostMapping("/users")
    public ResponseEntity<String> createUser(@RequestBody CreateUserRequest request) {
        // 模拟用户创建逻辑
        String userId = "user-" + System.currentTimeMillis();

        // 发布用户创建事件
        eventPublisherService.publishUserCreatedEvent(userId, request.getEmail());

        return ResponseEntity.ok("User created with ID: " + userId);
    }

    @PostMapping("/orders")
    public ResponseEntity<String> placeOrder(@RequestBody CreateOrderRequest request) {
        // 模拟订单下单逻辑
        String orderId = "order-" + System.currentTimeMillis();

        // 发布订单下单事件
        eventPublisherService.publishOrderPlacedEvent(orderId, request.getCustomerId(), request.getAmount());

        return ResponseEntity.ok("Order placed with ID: " + orderId);
    }

    public static class CreateUserRequest {
        private String email;

        public String getEmail() { return email; }
        public void setEmail(String email) { this.email = email; }
    }

    public static class CreateOrderRequest {
        private String customerId;
        private double amount;

        public String getCustomerId() { return customerId; }
        public void setCustomerId(String customerId) { this.customerId = customerId; }
        public double getAmount() { return amount; }
        public void setAmount(double amount) { this.amount = amount; }
    }
}
```

以及我们的主入口点

```java
package com.example.eventpublisher;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class EventPublisherApplication {

    public static void main(String[] args) {
        SpringApplication.run(EventPublisherApplication.class, args);
    }
}
```

### 部署 Spring Boot 应用程序

为您的 Spring Boot 应用程序创建一个 Kubernetes 部署：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: springboot-event-app
  namespace: my-app-namespace
spec:
  replicas: 1
  selector:
    matchLabels:
      app: springboot-event-app
  template:
    metadata:
      labels:
        app: springboot-event-app
    spec:
      containers:
      - name: springboot-event-app
        image: your-registry/springboot-event-app:latest
        ports:
        - containerPort: 8080
        env:
        - name: KNATIVE_BROKER_URL
          value: "http://broker-ingress.knative-eventing.svc.cluster.local/my-app-namespace/default"
---
apiVersion: v1
kind: Service
metadata:
  name: springboot-event-app
  namespace: my-app-namespace
spec:
  selector:
    app: springboot-event-app
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
```

### 测试 Spring Boot 应用程序

1. **测试事件发布**：

   将地址更改为其完全合格的 URL 并尝试 API：

   ```shell
   curl -X POST http://springboot-event-app/api/users \
     -H "Content-Type: application/json" \
     -d '{"email": "user@example.com"}'
   ```

2. **测试事件消费**：

   创建一个 Trigger 将事件路由到您的 Spring Boot 应用程序：

   ```yaml
   apiVersion: eventing.knative.dev/v1
   kind: Trigger
   metadata:
     name: springboot-trigger
     namespace: my-app-namespace
   spec:
     broker: default
     filter:
       attributes:
         type: com.example.user.created
     subscriber:
       ref:
         apiVersion: v1
         kind: Service
         name: springboot-event-app
   ```

3. **监控应用程序日志**：
   ```shell
   kubectl logs -f deployment/springboot-event-app
   ```

## 第 5 章. 高级事件路由和过滤

### 复杂事件过滤

创建具有高级过滤能力的触发器：

```yaml
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: high-value-orders
  namespace: my-app-namespace
spec:
  broker: default
  filters:
  - all:
	- exact:
	      type: com.example.order.placed
	- suffix:
	    amount: "1000"  # 过滤属性后缀等于 1000 的金额
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: high-value-order-processor
```

### 死信队列配置

为失败的事件处理配置死信队列：

```yaml
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: order-trigger-with-dlq
  namespace: my-app-namespace
spec:
  broker: default
  filter:
    attributes:
      type: com.example.order.placed
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: order-processor
    delivery:
      deadLetterSink:
        ref:
          apiVersion: v1
          kind: Service
          name: dead-letter-service
      retry: 3
```

## 结论

Knative Eventing 提供了一个强大而灵活的平台，用于在 Kubernetes 上构建事件驱动的应用程序。通过利用 Broker、Trigger 和云事件，开发人员可以创建可扩展的、松耦合的系统，实时响应事件。

使用 Knative Eventing 的主要好处包括：

1. **标准化**：CloudEvents 规范确保互操作性
2. **可扩展性**：基于事件量的自动扩展
3. **可靠性**：内置重试机制和死信队列
4. **灵活性**：支持多种事件源和接收器
5. **开发人员体验**：简单的事件发布和消费 API

Spring Boot 集成使得将事件驱动能力轻松添加到现有应用程序，而 Knative Eventing 的全面过滤和路由能力使得复杂的事件处理工作流成为可能。

通过遵循本文档中的模式和示例，开发人员可以有效地实现事件驱动架构，这些架构在 ACP 环境中既强大又可维护。

## 参考文献

- [Knative Eventing 文档](https://knative.dev/docs/eventing/)
- [Cloud Events 网站](https://cloudevents.io/)
- [CloudEvents Java SDK 仓库](https://github.com/cloudevents/sdk-java)
- [CloudEvents Java SDK 网站](https://cloudevents.github.io/sdk-java/)
- [Knative 彩色演示应用](https://github.com/danielfbm/knative-demo)
