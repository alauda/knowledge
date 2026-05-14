---
kind:
   - Solution
products: 
  - Alauda Application Services
---

# How to Use Camel Quarkus

## Audience and Scope

This document describes a practical Camel Quarkus implementation that can be built, deployed, and validated on Kubernetes. It is intended for platform users and solution engineers who need a repeatable reference for API aggregation, API orchestration, mock backend deployment, container image build, and Kubernetes validation.

The examples use two primary integration patterns:

- API aggregation: combine user details and order data into a single response.
- API orchestration: validate a user, check inventory, create an order, and return a unified result.

The document also includes deployment notes learned from real Kubernetes environments, including Quarkus `fast-jar` packaging, container image architecture, Harbor/containerd compatibility, and common runtime issues.

## Prerequisites

Required tools:

| Tool | Recommended Version | Purpose |
|------|---------------------|---------|
| JDK | 21 recommended, 17 supported if the project is adjusted | Compile and run the application |
| Maven | 3.9+ | Build the project |
| Podman | Recent stable version | Build and push container images |
| kubectl | Compatible with the target cluster | Deploy and validate Kubernetes resources |
| curl | Any recent version | API validation |

Validate the local environment:

```bash
java -version
mvn -version
mvn -version | grep "Java version"
podman info
kubectl version --short
kubectl get nodes
```

Define a namespace for all Kubernetes commands:

```bash
export NS=<your-namespace>
```

## Project Creation

Create the application with Quarkus CLI:

```bash
quarkus create app com.example:camel-quarkus-demo \
  --extension="camel-quarkus-platform-http,camel-quarkus-http,camel-quarkus-jackson,camel-quarkus-rest"
cd camel-quarkus-demo
```

If the Quarkus CLI is unavailable, generate the project from `https://code.quarkus.io` with:

- Group: `com.example`
- Artifact: `camel-quarkus-demo`
- Build tool: Maven
- Java version: 21
- Extensions: `camel-quarkus-platform-http`, `camel-quarkus-http`, `camel-quarkus-jackson`, `camel-quarkus-rest`

Expected project layout:

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

## Required Dependencies

The minimal dependency set for the two use cases is:

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

If Kubernetes health probes are used, add:

```xml
<dependency>
  <groupId>io.quarkus</groupId>
  <artifactId>quarkus-smallrye-health</artifactId>
</dependency>
```

## Application Configuration

Use a minimal `src/main/resources/application.properties`:

```properties
quarkus.application.name=camel-quarkus-demo
quarkus.http.port=8080
quarkus.log.category."org.apache.camel".level=INFO
```

Do not configure `camel.main.routes-discovery-enabled=true` for this project. With Camel Quarkus, CDI-managed `RouteBuilder` classes annotated with `@ApplicationScoped` are automatically registered.

## Use Case 1: API Aggregation

### Scenario

The frontend needs a single API that returns:

- User information from `GET /user/{userId}`
- Recent orders from `GET /orders?userId={userId}`

### Route Implementation

Create `src/main/java/com/example/routes/UserOrderAggregatorRoute.java`:

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

### Key Points

- `@ApplicationScoped` makes the route a CDI bean so Camel Quarkus can discover it.
- `platform-http` exposes HTTP endpoints without a servlet container.
- `multicast().parallelProcessing()` calls both downstream services concurrently.
- `toD` builds a dynamic endpoint URI from request headers.

## Use Case 2: API Orchestration

### Scenario

The order API must:

1. Validate the user.
2. Check inventory.
3. Create the order.
4. Return a consistent success or error response.

### Route Implementation

Create `src/main/java/com/example/routes/OrderOrchestrationRoute.java`:

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

### Key Points

- The route keeps the original request body in an exchange property before calling downstream services.
- The implementation reads JSON request fields from a `Map` instead of using `${body[...]}` expressions. This avoids requiring additional Camel language support at runtime.
- `throwExceptionOnFailure=false` allows the route to handle non-2xx downstream responses explicitly.

## Mock Backend Services on Kubernetes

The examples assume two Kubernetes services:

- `mock-api`: JSON Server for the aggregation use case.
- `wiremock-api`: WireMock for the orchestration use case.

### Deploy Mock Services

Prepare `k8s/mock-api.yaml` and `k8s/wiremock-api.yaml`, then deploy:

```bash
kubectl apply -f k8s/mock-api.yaml -n $NS
kubectl apply -f k8s/wiremock-api.yaml -n $NS
kubectl rollout status deployment/mock-api -n $NS
kubectl rollout status deployment/wiremock-api -n $NS
```

### Validate Mock Services

Use port-forward for quick validation:

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

Expected results:

- `mock-api /user/1` returns Alice's user profile.
- `mock-api /orders?userId=1` returns the user's order list.
- `wiremock-api /users/123` returns HTTP 200.
- `wiremock-api /inventory/A001` returns stock greater than 0.
- `wiremock-api /orders` returns a generated order response.

## Build and Package the Application

Run:

```bash
./mvnw clean package -DskipTests
```

Quarkus produces a `fast-jar` layout by default:

```text
target/
|-- camel-quarkus-demo-1.0.0.jar
`-- quarkus-app/
    |-- app/
    |-- lib/
    |-- quarkus/
    `-- quarkus-run.jar
```

Do not package this application by copying only `target/camel-quarkus-demo-1.0.0.jar`. The runtime needs the full `target/quarkus-app/` directory.

## Recommended Containerfile

Create `Containerfile` in the project root:

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

Make sure `.dockerignore` allows the recursive `quarkus-app` directory:

```dockerignore
*
!target/quarkus-app/
!target/quarkus-app/**
```

## Build and Push the Container Image

Set the target image:

```bash
export IMAGE=<registry>/<project>/camel-quarkus-demo:<tag>
```

Build and push:

```bash
podman build -t $IMAGE -f Containerfile .
podman push $IMAGE
```

For an `amd64` Kubernetes cluster:

```bash
podman build --platform linux/amd64 -t $IMAGE -f Containerfile .
podman push $IMAGE
```

For an `arm64` Kubernetes cluster:

```bash
podman build --platform linux/arm64 -t $IMAGE -f Containerfile .
podman push $IMAGE
```

For ARM + containerd environments, OCI format is often a safer choice than forcing Docker format:

```bash
podman build --platform linux/arm64 --format oci -t $IMAGE -f Containerfile .
podman push --format oci $IMAGE
```

Avoid repeatedly reusing `latest` during troubleshooting. Use a new tag such as `arm64-oci-001` or `amd64-fix-001` so nodes do not reuse stale cached layers.

## Kubernetes Application Manifest

Create `k8s/camel-app.yaml`:

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

If `quarkus-smallrye-health` is included, add probes:

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

Deploy:

```bash
kubectl apply -f k8s/camel-app.yaml -n $NS
kubectl rollout status deployment/camel-quarkus-demo -n $NS
kubectl get pod,svc -n $NS -l app=camel-quarkus-demo
```

## Kubernetes Validation

Use port-forward when an external Ingress or NodePort is unavailable:

```bash
kubectl port-forward svc/camel-quarkus-demo 8080:80 -n $NS &
export APP_HOST=http://localhost:8080
```

### API Aggregation

```bash
curl -i "$APP_HOST/aggregate?userId=1"
```

Expected response:

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

### API Orchestration

Successful order:

```bash
curl -i -X POST "$APP_HOST/api/place-order" \
  -H "Content-Type: application/json" \
  -d '{"userId":123,"itemId":"A001"}'
```

Expected: HTTP 201 with a generated `orderId`.

Invalid user:

```bash
curl -i -X POST "$APP_HOST/api/place-order" \
  -H "Content-Type: application/json" \
  -d '{"userId":13,"itemId":"A001"}'
```

Expected: HTTP 400 with:

```json
{"error":"Invalid user"}
```

Out of stock:

```bash
curl -i -X POST "$APP_HOST/api/place-order" \
  -H "Content-Type: application/json" \
  -d '{"userId":123,"itemId":"A003"}'
```

Expected: HTTP 400 with:

```json
{"error":"Out of stock"}
```

Check logs:

```bash
kubectl logs -n $NS -l app=camel-quarkus-demo --tail=100
```

## Troubleshooting

### Route Startup Fails with `routesDiscoveryEnabled`

Symptom:

```text
Error binding property (camel.main.routesDiscoveryEnabled=true)
```

Cause: `camel.main.routes-discovery-enabled` is not valid for the current Camel Quarkus runtime.

Fix: remove the property. Use `@ApplicationScoped` on `RouteBuilder` classes.

### Route Startup Fails with `No language could be found for: bean`

Symptom:

```text
No language could be found for: bean
```

Cause: expressions such as `${body[userId]}` may require language support that is not present in the runtime.

Fix: read JSON request data from the body as a `Map` inside `.process(...)`, as shown in the orchestration route.

### Pod Cannot Pull Images from Docker Hub

Symptom:

```text
failed to pull image ... dial tcp ... i/o timeout
```

Cause: cluster nodes cannot access Docker Hub or the public registry.

Fix options:

- Mirror the image into an internal registry.
- Configure a registry mirror on cluster nodes.
- Configure node-level egress/proxy access.
- Use an approved internal base image.

### Image Push to Harbor Fails with `unauthorized`

Symptom:

```text
unauthorized to access repository, action: push
```

Cause: the current Harbor user or robot account has no push permission for the project.

Fix:

```bash
podman logout <harbor>
podman login <harbor>
```

Then push to a project where the user has write permission.

### Container Fails with `exec format error`

Symptom:

```text
exec /opt/java/openjdk/bin/java: exec format error
```

Cause: image architecture does not match node architecture.

Check node architecture:

```bash
kubectl get node -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.nodeInfo.architecture}{"\n"}{end}'
```

Rebuild for the correct architecture:

```bash
podman build --platform linux/amd64 -t $IMAGE -f Containerfile .
podman push $IMAGE
```

or:

```bash
podman build --platform linux/arm64 -t $IMAGE -f Containerfile .
podman push $IMAGE
```

Use a new tag to avoid node-side image cache reuse.

### containerd Pull Fails with `archive/tar: invalid tar header`

Symptom:

```text
archive/tar: invalid tar header
```

Likely causes:

- Docker image format and containerd/Harbor compatibility issue.
- Layer content corrupted during push or registry storage.
- Reused tag points to stale or inconsistent layers.
- Architecture or base image layer compatibility issue.

Recommended test for ARM + containerd:

```bash
export IMAGE=<harbor>/<project>/camel-quarkus-demo:arm64-oci-001
podman build --platform linux/arm64 --format oci -t $IMAGE -f Containerfile .
podman push --format oci $IMAGE
nerdctl --namespace k8s.io pull $IMAGE --insecure-registry --debug
```

If the problem persists, temporarily switch the base image from:

```dockerfile
FROM eclipse-temurin:21-jre-alpine
```

to:

```dockerfile
FROM eclipse-temurin:21-jre
```

Then rebuild and test again.

### Health Probe Fails

If probes call `/q/health/ready` and `/q/health/live`, ensure `quarkus-smallrye-health` is included. Otherwise, remove the probes and let the platform use its default readiness policy.

### curl Appears to Return Nothing

Use `-i`, `-v`, and a timeout:

```bash
curl -i -v --max-time 15 "$APP_HOST/api/place-order" \
  -H "Content-Type: application/json" \
  -d '{"userId":123,"itemId":"A001"}'
```

`curl` prints only the response body by default. If the body is empty, the command can look like it returned nothing even when an HTTP status was returned.

## Operational Checklist

Before considering the deployment complete, verify:

- `mock-api` deployment is available.
- `wiremock-api` deployment is available.
- `camel-quarkus-demo` Pod is `Running` and ready.
- `/aggregate?userId=1` returns a merged user and orders response.
- `/api/place-order` returns HTTP 201 for `userId=123,itemId=A001`.
- `/api/place-order` returns HTTP 400 for an invalid user.
- `/api/place-order` returns HTTP 400 for out-of-stock inventory.
- Application logs show Camel route activity.

Useful commands:

```bash
kubectl get all -n $NS
kubectl logs -f -n $NS -l app=camel-quarkus-demo
kubectl rollout restart deployment/camel-quarkus-demo -n $NS
kubectl delete -f k8s/ -n $NS
```
