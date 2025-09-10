---
products:
   - Alauda Container Platform
   - Alauda DevOps
kind:
   - Solution
id: KB250700002
---

# Leveraging Knative Eventing for Cloud Event Publishing and Consuming

## Overview

Knative Eventing is a powerful system for building event-driven applications on Kubernetes. It provides a standardized way to handle cloud events, enabling loose coupling between event producers and consumers. This document explains how application developers can leverage Knative Eventing to publish and receive cloud events in the ACP (Alauda Container Platform) environment.

### Understanding Knative Eventing

Knative Eventing enables applications to produce and consume events that conform to the CloudEvents specification. It provides:

- **Event-driven architecture**: Decouple event producers from consumers
- **Standardized event format**: Uses CloudEvents specification
- **Scalability**: Automatic scaling based on event volume
- **Reliability**: Built-in retry and dead letter queue mechanisms
- **Flexibility**: Support for various event sources and sinks

### Key Components

![](/KB250700002/knative-eventing.png)

#### Broker

A **Broker** is a central hub that receives events and routes them to appropriate destinations. It acts as an event mesh, providing:
- Event ingestion from multiple sources
- Event routing based on filters
- Event persistence and delivery guarantees
- Integration with various messaging systems

#### Trigger

A **Trigger** defines event routing rules, specifying:
- Event filtering criteria (event type, source, attributes)
- Destination service (subscriber) for matching events
- Retry and dead letter queue configuration

#### Event Sources
Event sources generate events and send them to brokers. Common sources include:
- HTTP endpoints
- Message queues
- Database changes
- Scheduled events
- Custom applications


### Prerequisites

1. Alauda Container Platform with `Knative Eventing` installed. The following steps uses `Alauda DevOps Eventing v3` plugin to deploy `Knative Eventing`.
2. `kubectl` command-line tool with `kubectl-acp` plugin
3. A project and namespace configured in ACP. A namespace `my-app-namespace` is assumed for this guide.
4. Authenticated to the cluster using `kubectl acp login`
5. Basic understanding of Kubernetes resources and CloudEvents specification

## Chapter 1. Setting Up Knative Eventing Infrastructure

### Creating a Broker

First, create a Broker in your namespace using the default configuration to handle event routing:

```yaml
apiVersion: eventing.knative.dev/v1
kind: Broker
metadata:
  name: default
  namespace: my-app-namespace
```

Save this as `broker.yaml` and apply it:

```shell
kubectl apply -f broker.yaml
```

Verify the broker is ready:

```shell
kubectl get broker default
```

The broker should show a `READY` status of `True`.

```shell
NAME      URL                                                                                 AGE   READY   REASON
default   http://broker-ingress.knative-operator.svc.cluster.local/my-app-namespace/default   2s    True
```

### Creating Event Sources

Create an event source to generate sample events. Here's an example using PingSource:

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

Save this as `ping-source.yaml` and apply it:

```shell
kubectl apply -f ping-source.yaml
```

This creates a PingSource that sends events to the broker every minute. For a more detailed reference please refer to the [Knative documentation](https://knative.dev/docs/eventing/sources/ping-source/reference/).

## Chapter 2. Building Event Consumer Applications

### Creating a Simple Event Consumer

Lets create a simple HTTP service that receives and output events as logs:

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
          # Change to inhouse registry address and image
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

Save this as `event-display.yaml` and apply it:

```shell
kubectl apply -f event-display.yaml
```

### Creating a Trigger for Event Routing

Create a Trigger to route events from the broker to your consumer:

```yaml
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: ping-trigger
  namespace: my-app-namespace
spec:
  broker: default
  # empty filters means all events will be sent to the subscriber
  filters: []
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: event-display
```

Save this as `trigger.yaml` and apply it:

```shell
kubectl apply -f trigger.yaml
```

**Explanation of YAML fields:**

- `spec.broker`: References the broker to subscribe to
- `spec.filters`: Defines filtering criteria for events
- `spec.subscriber`: Specifies the destination service for matching events


For a more detailed reference on Triggers, refer to the [Knative documentation](https://knative.dev/docs/eventing/triggers/).


### Verifying Event Flow

Check the logs of your event display to verify it's receiving events:

```shell
kubectl logs -f deployment/event-display
```

You should see log entries indicating that the service is receiving events from the PingSource like the following:

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


## Chapter 3. Enabling SpringBoot Applications for Cloud Events

### Adding Dependencies

Add the following dependencies to your Spring Boot application's `pom.xml`:

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

### Creating a Cloud Event Consumer

Create a Spring Boot controller to receive cloud events:

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
            // Parse the CloudEvent from HTTP request
            MessageReader messageReader = HttpMessageFactory.createReader(
                headers.toSingleValueMap(),
                body != null ? body.getBytes() : new byte[0]
            );

            CloudEvent event = messageReader.toEvent();

            // Process the event
            logger.info("Received CloudEvent:");
            logger.info("  ID: {}", event.getId());
            logger.info("  Type: {}", event.getType());
            logger.info("  Source: {}", event.getSource());
            logger.info("  Subject: {}", event.getSubject());
            logger.info("  Data: {}", new String(event.getData().toBytes()));

            // Your business logic here
            processEvent(event);

            return ResponseEntity.accepted().build();

        } catch (Exception e) {
            logger.error("Error processing event", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                                 .body("Error processing event: " + e.getMessage());
        }
    }

    private void processEvent(CloudEvent event) {
        // Implement your event processing logic here
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
        // Add your user creation handling logic
    }

    private void handleOrderPlaced(CloudEvent event) {
        logger.info("Processing order placed event: {}", event.getId());
        // Add your order processing logic
    }
}
```

### Creating a Cloud Event Publisher

For this part we will still build uppon the EventConsumer created on the last part.

There are two main approaches to publish CloudEvents from Spring Boot applications:

#### Method 1: Using CloudEvents HTTP Message Factory (Recommended)

This approach uses the CloudEvents HTTP message factory to properly format and send events. It ensures complete compliance with the CloudEvents specification.

Create a service to publish cloud events:

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
            // Create event data
            UserCreatedData eventData = new UserCreatedData(userId, userEmail);

            // Serialize event data to JSON
            String eventDataJson = objectMapper.writeValueAsString(eventData);
            byte[] eventDataBytes = eventDataJson.getBytes();

            // Build CloudEvent
            CloudEvent event = CloudEventBuilder.v1()
                    .withId(UUID.randomUUID().toString())
                    .withType("com.example.user.created")
                    .withSource(URI.create("https://example.com/user-service"))
                    .withTime(OffsetDateTime.now())
                    .withData("application/json", eventDataBytes)
                    .build();

            // Publish event
            publishEvent(event);

        } catch (Exception e) {
            logger.error("Error publishing user created event", e);
        }
    }

    public void publishOrderPlacedEvent(String orderId, String customerId, double amount) {
        try {
            // Create event data
            OrderPlacedData eventData = new OrderPlacedData(orderId, customerId, amount);

            // Serialize event data to JSON
            String eventDataJson = objectMapper.writeValueAsString(eventData);
            byte[] eventDataBytes = eventDataJson.getBytes();

            // Build CloudEvent
            CloudEvent event = CloudEventBuilder.v1()
                    .withId(UUID.randomUUID().toString())
                    .withType("com.example.order.placed")
                    .withSource(URI.create("https://example.com/order-service"))
                    .withTime(OffsetDateTime.now())
                    .withData("application/json", eventDataBytes)
                    .build();

            // Publish event
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

            // Use CloudEvents HTTP message factory to write the event
            MessageWriter messageWriter = createMessageWriter(httpUrlConnection);
            messageWriter.writeBinary(event);

            // Actually send the request and get the response
            int responseCode = httpUrlConnection.getResponseCode();
            logger.info("Broker response code: {}", responseCode);

            if (responseCode >= 200 && responseCode < 300) {
                logger.info("Successfully published event: {} ({})", event.getId(), event.getType());
            } else {
                // Read error response
                String errorResponse = "";
                try {
                    errorResponse = new String(httpUrlConnection.getErrorStream().readAllBytes());
                } catch (Exception e) {
                    // Ignore error reading error stream
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

    // Event data classes
    public static class UserCreatedData {
        private String userId;
        private String email;

        public UserCreatedData(String userId, String email) {
            this.userId = userId;
            this.email = email;
        }

        // Getters and setters
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

        // Getters and setters
        public String getOrderId() { return orderId; }
        public void setOrderId(String orderId) { this.orderId = orderId; }
        public String getCustomerId() { return customerId; }
        public void setCustomerId(String customerId) { this.customerId = customerId; }
        public double getAmount() { return amount; }
        public void setAmount(double amount) { this.amount = amount; }
    }
}
```

### Configuration

Add the following to your `application.yml`:

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

### Creating a REST Controller for Testing

Create a REST controller to trigger event publishing:

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
        // Simulate user creation logic
        String userId = "user-" + System.currentTimeMillis();

        // Publish user created event
        eventPublisherService.publishUserCreatedEvent(userId, request.getEmail());

        return ResponseEntity.ok("User created with ID: " + userId);
    }

    @PostMapping("/orders")
    public ResponseEntity<String> placeOrder(@RequestBody CreateOrderRequest request) {
        // Simulate order placement logic
        String orderId = "order-" + System.currentTimeMillis();

        // Publish order placed event
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

And our main entrypoint

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

### Deploying the Spring Boot Application

Create a Kubernetes deployment for your Spring Boot application:

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

### Testing the SpringBoot Application

1. **Test Event Publishing**:

   Change the address to its full qualified URL and try the API:

   ```shell
   curl -X POST http://springboot-event-app/api/users \
     -H "Content-Type: application/json" \
     -d '{"email": "user@example.com"}'
   ```

2. **Test Event Consumption**:

   Create a Trigger to route events to your Spring Boot application:

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

3. **Monitor Application Logs**:
   ```shell
   kubectl logs -f deployment/springboot-event-app
   ```

## Chapter 5. Advanced Event Routing and Filtering

### Complex Event Filtering

Create triggers with advanced filtering capabilities:

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
	    amount: "1000"  # Filter for amound suffixed attributes equals to 1000
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: high-value-order-processor
```


### Dead Letter Queue Configuration

Configure dead letter queues for failed event processing:

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

## Conclusion

Knative Eventing provides a powerful and flexible platform for building event-driven applications on Kubernetes. By leveraging brokers, triggers, and cloud events, developers can create scalable, loosely coupled systems that react to events in real-time.

Key benefits of using Knative Eventing include:

1. **Standardization**: CloudEvents specification ensures interoperability
2. **Scalability**: Automatic scaling based on event volume
3. **Reliability**: Built-in retry mechanisms and dead letter queues
4. **Flexibility**: Support for multiple event sources and sinks
5. **Developer Experience**: Simple APIs for event publishing and consuming

Spring Boot integration makes it easy to add event-driven capabilities to existing applications, while the comprehensive filtering and routing capabilities of Knative Eventing enable sophisticated event processing workflows.

By following the patterns and examples in this document, developers can effectively implement event-driven architectures that are both robust and maintainable in the ACP environment.

## References

- [Knative Eventing Documentation](https://knative.dev/docs/eventing/)
- [Cloud Events website](https://cloudevents.io/)
- [CloudEvents Java SDK Repository](https://github.com/cloudevents/sdk-java)
- [CloudEvents Java SDK Website](https://cloudevents.github.io/sdk-java/)
- [Knative color demo app](https://github.com/danielfbm/knative-demo)
