---
products: 
   - Alauda Service Mesh
kind:
   - Solution
id: KB250500014
---
# Integrate Alauda Service Mesh to Standard Kubernetes

## Overview

Alauda Service Mesh (ASM) extends Istio's capabilities with enhanced management features while maintaining compatibility with the Istio ecosystem. This document provides a comprehensive guide for migrating standard Kubernetes applications to Alauda Service Mesh, focusing on operational workflows, configuration differences, and technical implementation.

### Understanding service mesh concepts

#### Service mesh architecture

A service mesh is a dedicated infrastructure layer that controls service-to-service communication within a microservices architecture. It provides features such as traffic management, security, and observability without requiring changes to application code.

#### Sidecar proxy pattern

The sidecar pattern deploys a proxy container alongside each application container. This proxy intercepts all network traffic to and from the application, enabling advanced traffic management, security policies, and telemetry collection.

### Differences between Istio and Alauda Service Mesh

The key differences are summarized below:


| **Aspect**            | **Native Istio**                          | **Alauda Service Mesh (ASM)**            |
|-----------------------|-------------------------------------------|------------------------------------------|
| Namespace-Level sidecar injection        | Labels on `istio-injection` or `istio.io/rev`       | Labels on `istio.io/rev` + `cpaas.io/serviceMesh`  |
| Pod-Level sidecar injection  | Labels on pods/deployments               | Custom `MicroService` resource           |
| Service Global Rate Limiting | `ConfigMap` and `EnvoyFilter`  | Custom `GlobalRateLimiter` resource  |
| Service API-Level Traffic Monitoring  | `WasmPlugin` and `Telemetry`   | Custom `ApiAttribute` resource       |

#### Sidecar Injection

Alauda Service Mesh Observability is based on the MicroService custom resource. If you want to have the ability, please use Alauda Service Mesh configuration to inject the sidecar.

##### Native Istio configuration 
Istio's native sidecar injection involves two levels of configuration:

1. **Namespace-Level Configuration**
   - **Option 1**: Add the label `istio-injection=enabled` to the namespace (legacy approach)
   - **Option 2**: Use `istio.io/rev=<revision>` to select a specific Istio control plane revision (modern approach)

2. **Pod-Level Configuration**
   - Add the annotation `sidecar.istio.io/inject=true` to pod templates in deployments

##### Alauda Service Mesh configuration

ASM retains Istio's core principles but introduces additional labels and custom resources for enhanced control:

1. **Namespace-Level Configuration**
   - Use `istio.io/rev=<revision>` just as in Istio
   - Add the label `cpaas.io/serviceMesh=enabled` to the namespace

2. **Pod-Level Configuration**
  - Define a `MicroService` custom resource to automate sidecar injection
  - Example configuration:

  ```yaml
  apiVersion: asm.alauda.io/v1beta3
  kind: MicroService
  metadata:
    labels:
      app.cpaas.io/microservice-type: service-mesh
    name: <microservice-name> # must use the same name as K8S service
    namespace: <service-namespace>
  spec:
    accessLogging:
      enabled: false
    deployments:
      - name: <deployment-name>
    otelJavaAgent:
      enabled: false
    services:
      - name: <service-name>
    sidecar:
      enabled: true
      envoyLogLevel: warning
      resources:
        limits:
          cpu: 500m
          memory: 512Mi
        requests:
          cpu: 100m
          memory: 128Mi
  ```  

  - Labels and annotation will be autoly added to Deployment and Service

  ```yaml
  deployment label
  asm.cpaas.io/msname: <microservice-name>
  pod annotation
  kubectl.kubernetes.io/restartedAt: 2025-05-21T02:54:29.851209145Z
  pod label
  app: <microservice-name>
  asm.cpaas.io/msname: <microservice-name>
  service label
  asm.cpaas.io/msname: <microservice-name>
  ```

#### Service Global Rate Limiting

##### Native Istio configuration

Native Istio uses `ConfigMap` and `EnvoyFilter` to configure service global rate limiting, requiring additional deployment of [https://github.com/envoyproxy/ratelimit](https://github.com/envoyproxy/ratelimit) as the global rate limiting server.

##### Alauda Service Mesh configuration

ASM uses the `GlobalRateLimiter` custom resource to configure service global rate limiting, with simple configuration and more user-friendly rate limiting metrics integration into ASM monitoring.

#### Service API-Level Traffic Monitoring

##### Native Istio configuration

Native Istio uses `WasmPlugin` and `Telemetry` to configure service API-level traffic monitoring.

##### Alauda Service Mesh configuration

ASM uses the `ApiAttribute` custom resource to configure service API-level traffic monitoring (integration into ASM monitoring), with simple configuration and better performance than Native Istio.

## Prerequisites

Before migrating to Alauda Service Mesh, ensure you have:

1. Alauda Container Platform environment and account
2. Project and namespaces already created inside Alauda Container Platform with necessary permissions
3. Standard Kubernetes application manifests (Deployments, Services, ServiceAccounts)
4. [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/) installed
5. `kubectl acp plugin` installed for authentication to the cluster

## Migration process overview

Migrating from a standard Kubernetes deployment to Alauda Service Mesh involves several key steps:

1. **Environment setup and validation**
2. **Preparation of existing Kubernetes resources**
3. **Integration with the service mesh** (sidecar injection)
4. **Implementation of service mesh features** (traffic routing, resilience, observability)
5. **Testing and validation**

## Chapter 1: Standard Kubernetes application example

Before migrating to ASM, let's understand the structure of a typical Kubernetes application. This will serve as our starting point for the migration process.

### Standard Kubernetes resources

A typical Kubernetes microservice consists of the following resources:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: <service-name>
  namespace: <service-namespace>
  labels:
    service: <service-name>
spec:
  ports:
  - port: 8080
    name: http-8080
    protocol: TCP
    appProtocol: http
  selector:
    service: <service-name>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <deployment-name>
  namespace: <deployment-namespace>
  labels:
    service: <service-name>
spec:
  replicas: 2
  selector:
    matchLabels:
      service: <service-name>
  template:
    metadata:
      labels:
        service: <service-name>
    spec:
      containers:
      - name: <container-name>
        image: <registry-address>/<service-name>:<tag>
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: <container-port>
```

**Key components:**

- **Service**: Exposes the application on port <container-port> and selects pods with the label `service: <service-name>`
- **Deployment**: Manages the application pods, specifying the container image, ports, and labels

## Chapter 2: Service Mesh integration process

This chapter details the step-by-step process to integrate your standard Kubernetes application with Alauda Service Mesh.

### Step 1: Enable mesh in namespace

**Note**: If you do not have permission to update the namespace, please contact an administrator.

To integrate your application with ASM, first add the necessary labels to your namespace:

```shell
kubectl label namespace <namespace> cpaas.io/serviceMesh=enabled istio.io/rev=1-22
```

Verify the namespace labels:

```shell
kubectl get ns <namespace> -o yaml
```

The output should contain:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: <namespace>
  labels:
    # existing labels
    cpaas.io/serviceMesh: enabled
    istio.io/rev: 1-22
```

**Explanation of labels:**

- `cpaas.io/serviceMesh: enabled`: Indicates that this namespace should be managed by Alauda Service Mesh
- `istio.io/rev: 1-22`: Specifies the Istio control plane revision to use (1.22 in this example)

### Step 2: Create MicroService resource

Instead of manually injecting sidecars into your pods, create an ASM MicroService resource to manage your application's mesh integration.

**Note:**

- The `MicroService` resource must have the same name as the K8S Service; otherwise, it will affect the observability features of the microservice.
- `MicroService` supports a one-to-one relationship between `Deployment` and `Service`. If a `Deployment` corresponds to multiple `Services`, you need to select one `Service` as the `MicroService`.
- Istio can automatically detect HTTP and HTTP/2 traffic. If the protocol cannot automatically be determined, traffic will be treated as plain TCP traffic. [Protocols can be specified manually](https://istio.io/v1.22/docs/ops/configuration/traffic-management/protocol-selection/#explicit-protocol-selection) in the Service definition.This can be configured in two ways:
  - In Kubernetes 1.18+, by the appProtocol field: `appProtocol: <protocol>`.
  - By the name of the port: `name: <protocol>[-<suffix>]`.
- If the `spec.template.metadata.labels` in the `Deployment` contains the `app` or `app.kubernetes.io/name` label, and the name is different from the `MicroService` name, you need to add the `service.istio.io/canonical-name: <microservice-name>` label to `spec.template.metadata.labels` for the observability features of the microservice.

```yaml
apiVersion: asm.alauda.io/v1beta3
kind: MicroService
metadata:
  labels:
    app.cpaas.io/microservice-type: service-mesh
  name: <microservice-name-same-as-service-name>
  namespace: <service-namespace>
spec:
  deployments:
  - name: <deployment-name>
  services:
  - name: <service-name>
  sidecar:
    enabled: true
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
    envoyLogLevel: warning
  accessLogging:
    enabled: false
  otelJavaAgent:
    enabled: false
```

Apply this configuration:

```shell
kubectl apply -f microservice.yaml
```

**Explanation of MicroService fields:**

- `spec.deployments`: Lists the deployments to be managed by the service mesh
- `spec.services`: Lists the services associated with the deployments
- `spec.sidecar`: Configures the Envoy sidecar proxy
  - `enabled`: Enables sidecar injection
  - `resources`: Sets resource limits for the sidecar
  - `envoyLogLevel`: Sets the logging level for the Envoy proxy
- `spec.accessLogging`: Enables access logging for the service
- `spec.otelJavaAgent`: Configures OpenTelemetry Java agent integration (disabled in this example). When enabled, it will automatically inject OpenTelemetry Java agent, used for observability, able to view Java service JVM monitoring and internal span.

This configuration will:
- Register your deployment and service with the service mesh
- Configure Envoy sidecar proxy injection
- Set resource limits for the sidecar proxy

## Chapter 3: Implementing service mesh features

After migrating your application to the service mesh, you can implement various service mesh features to enhance your application's capabilities.

### Traffic Routing

A `VirtualService` defines a set of traffic routing rules to apply when a host is addressed. Each routing rule defines matching criteria for traffic of a specific protocol. If the traffic is matched, then it is sent to a named destination service.

For `HTTPRoute`, it supports matching based on `uri`, `method`, `headers`, `queryParams`, `port`, etc. On top of routing, it also supports operations such as `redirect`, `rewrite`, `timeout`, `retries`, `fault`, `mirror`, etc.

#### Gateway Routing

After the administrator has deployed the ingress gateway and created the `Istio Gateway` resource, developers can create a `VirtualService` to configure gateway routing.

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: httpbin-route # virtual service name
  namespace: <service-namespace>
spec:
  hosts:
  - "httpbin.example.com" # your domain name for visiting your service
  gateways:
  - <gateway-ns>/<gateway-name> # namespace and name of the Istio Gateway resource
  http:
  - match:
    - uri:
        exact: /headers
    - uri:
        prefix: /status/
    route:
    - destination:
        host: httpbin.<service-namespace>.svc.cluster.local # service full name
        port:
          number: 80 # service port
```

Apply this configuration:

```shell
kubectl apply -f virtualservice.yaml
```

then, you can visit your service through the ingress gateway:

```shell
# If your gateway is http
curl http://httpbin.example.com/headers
# If your gateway is https
curl https://httpbin.example.com/headers
```

#### Service Routing

Control traffic flow between services by creating a VirtualService:

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: <virtualservice-name>
  namespace: <service-namespace>
spec:
  hosts:
  - <service-name> # interpreted as <service-name>.<service-namespace>.svc.cluster.local
  http:
  - route:
    - weight: 90
      destination:
        host: <service-name>
    - weight: 10
      destination:
        host: <another-service-name>
```

Apply this configuration:

```shell
kubectl apply -f virtualservice.yaml
```

**Explanation of VirtualService fields:**

- `spec.hosts`: Specifies the hosts to which traffic is being routed
- `spec.http`: Defines HTTP routing rules
  - `route`: Specifies the destinations and their weights
    - `weight`: Percentage of traffic to route to each destination
    - `destination.host`: The target service for the traffic

This configuration routes 90% of traffic to `<service-name>` and 10% to `<another-service-name>`.

#### Retries

Istio's retry mechanism allows you to automatically retry failed HTTP requests to a service. This can help improve the reliability of your application by attempting to recover from transient failures without involving the client.

You can configure retries in a VirtualService by specifying the number of retry attempts, the timeout for each attempt, and the conditions under which a retry should be triggered. Here’s an example:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: <virtualservice-name>
  namespace: <service-namespace>
spec:
  hosts:
    - <service-name> # interpreted as <service-name>.<service-namespace>.svc.cluster.local
  http:
    - retries:
        attempts: 3
        perTryTimeout: 3s
        retryOn: connect-failure,refused-stream,unavailable,cancelled,5xx
      route:
        - destination:
            host: <service-name>
          weight: 100
```

For a complete list of supported retry conditions, refer to the [Envoy documentation](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter#config-http-filters-router-x-envoy-retry-on).

**Note:** If a global HTTP retry policy is configured during service mesh deployment (with default retry conditions: `connect-failure, refused-stream, unavailable, cancelled, 503`), any retry policy specified for a particular service will override the global policy. This allows for fine-tuned control over retry behavior on a per-service basis.

### Traffic Policies

`DestinationRule` defines policies that apply to traffic intended for a service after routing has occurred. These rules specify configuration for load balancing, connection pool size from the sidecar, and outlier detection settings to detect and evict unhealthy hosts from the load balancing pool.

**Note:** There should only be one top-level trafficPolicy for the same host.

#### Load Balancing

Load balancing policies to apply for a specific destination. Supported policies include `LEAST_REQUEST` (default) , `ROUND_ROBIN`, `RANDOM`, `PASSTHROUGH`.

For example, the following rule uses a round robin load balancing policy for all traffic going to the `<service-name>` service.

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: <destinationrule-name>
  namespace: <service-namespace>
spec:
  host: <service-name>.<service-namespace>.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      simple: ROUND_ROBIN
```

#### Circuit Breaking

A Circuit breaker implementation that tracks the status of each individual host in the upstream service. Applicable to both HTTP and TCP services. For HTTP services, hosts that continually return 5xx errors for API calls are ejected from the pool for a pre-defined period of time. For TCP services, connection timeouts or connection failures to a given host counts as an error when measuring the consecutive errors metric.

**Note:** If a global circuit breaker is configured, the circuit breaker configuration for individual services will override the global configuration.

Apply circuit breaking patterns using Istio's native DestinationRule:

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: <destinationrule-name>
  namespace: <service-namespace>
spec:
  host: <service-name>.<service-namespace>.svc.cluster.local
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 100
        maxRequestsPerConnection: 10
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 600s
      maxEjectionPercent: 100
```

Apply this configuration:

```shell
kubectl apply -f destinationrule.yaml
```

**Explanation of DestinationRule fields:**

- `spec.host`: The service to which this rule applies
- `spec.trafficPolicy`: Defines the traffic management policy
  - `connectionPool`: Configures connection pooling
    - `tcp.maxConnections`: Maximum number of TCP connections
    - `http.http1MaxPendingRequests`: Maximum number of pending HTTP requests
    - `http.maxRequestsPerConnection`: Maximum number of requests per connection
  - `outlierDetection`: Configures circuit breaking
    - `consecutive5xxErrors`: Number of 5xx errors before ejecting a host
    - `interval`: Time between ejection analysis
    - `baseEjectionTime`: Minimum ejection duration
    - `maxEjectionPercent`: Maximum percentage of hosts that can be ejected

This configuration implements circuit breaking to protect your service from cascading failures.

#### Warm up with DestinationRule

Istio's Warmup feature allows newly created Pods to gradually increase traffic before receiving full traffic, helping them run stably. This feature is particularly suitable for services that require cold start preheating (such as JVM applications). It can reduce the risk of service interruptions, request delays, or even timeouts caused by sudden traffic surges when scaling or deploying new versions of applications, effectively improving the stability and high availability of applications during scaling and version updates.

##### Function Overview

Istio's Warmup feature is implemented based on the Slow start mode provided by Envoy.

Slow start mode is a configuration setting in Envoy to progressively increase amount of traffic for newly added upstream endpoints. With no slow start enabled Envoy would send a proportional amount of traffic to new upstream endpoints. This could be undesirable for services that require warm up time to serve full production load and could result in request timeouts, loss of data and deteriorated user experience.

##### Usage Limitations

- Istio version >= v1.14
  - Version v1.24 introduces more comprehensive Warmup configuration parameters (`minimumPercent` and `aggression`)
- Only supports `ROUND_ROBIN` and `LEAST_REQUEST` load balancing policies
- Not applicable for new deployment scenarios
- Requirements for the number of application replicas:
  - For scaling scenarios: At least one replica of the application is required
  - For rolling update scenarios: At least two replicas of the application are required

##### Best Practices

1. **Applicable Scenarios**

   Warmup is most effective when few new endpoints come up like scale event in Kubernetes. When all the endpoints are relatively new like new deployment, this is not very effective as all endpoints end up getting same amount of requests.

   In Deployment rolling update scenarios, avoid using the default rollingUpdate strategy, as all pods will be rolled out at the same moment, which makes the load weight very inaccurate. It is recommended to set `maxSurge` to an appropriate percentage (e.g., 34%) and `maxUnavailable` to 0 to achieve a gradual update.

2. **Reasonable Configuration of Warmup**

   Warmup configuration parameters in Istio v1.24:

   - `duration`: The warmup duration, which should be set based on the application's characteristics. It is recommended to determine the optimal value through performance testing.
   - `minimumPercent`: The minimum initial traffic percentage for new endpoints, default is 10%
   - `aggression`: The coefficient for traffic increase during warmup, default is 1.0 (linear growth)

   Versions prior to v1.24 only support configuring the `warmupDurationSecs` parameter, with other parameters using default values.

3. **Monitoring and Validation**

   After configuring the Warmup strategy, continuously monitor key metrics such as QPS, p99 latency, and error rate. If the results do not meet expectations, gradually adjust the warmup parameters and repeat the validation process.

##### Example Configuration

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: <destinationrule-name>
  namespace: <service-namespace>
spec:
  host: <service-name>
  trafficPolicy:
    loadBalancer:
      simple: LEAST_REQUEST
      warmupDurationSecs: 300
```

Apply this configuration:

```shell
kubectl apply -f destinationrule.yaml
```

#### Rate limiting

**Note:** Please confirm with the administrator whether the service mesh has enabled the rate limiting feature (connected to Redis).

Implement cluster-level rate limiting to protect your services from overload:

```yaml
apiVersion: asm.alauda.io/v1alpha1
kind: GlobalRateLimiter
metadata:
  name: <microservice-name>
  namespace: <microservice-namespace>
  labels:
    app.cpaas.io/msname: <microservice-name>
spec:
  serviceType: micro-service
  failureModeDeny: false
  domain: <microservice-name>.<microservice-namespace>.<cluster-name>
  rules:
  # Global policy (do not configure or can only configure one)
  - shadowMode: false
    rateLimit:
      fixedWindow:
        unit: <unit> # Options: second, minute, hour, day
        requestsPerUnit: <requestsPerUnit>
    name: global_rate_limit # Fixed name
    descriptors:
    - kind: global_service
      match:
        method: eq
        value: <microservice-name>.<microservice-namespace>.<cluster-name>
  # Condition policy (can configure multiple)
  - shadowMode: false
    rateLimit:
      fixedWindow:
        unit: <unit> # Options: second, minute, hour, day
        requestsPerUnit: <requestsPerUnit>
    name: <condition-rate-limit-name>
    descriptors:
    - kind: <kind> # Options: request_url_path, request_method, request_header
      match:
        key: <key> # Only required when kind is request_header
        method: <method> # Options: eq, ne, regex
        value: <value>
    # Example
    - kind: "request_method" # Request method
      match:
        method: "eq"
        value: "GET" # uppercase
    - kind: "request_url_path" # Request path: exact match
      match:
        method: "eq"
        value: "/get"
    - kind: "request_url_path" # Request path: regex match
      match:
        method: "eq"
        value: "/status/[^/]+"
    - kind: "request_header" # Request header: exact match
      match:
        key: "x-custom-for"
        method: "eq"
        value: "bar"
```

Apply this configuration:

```shell
kubectl apply -f ratelimiter.yaml
```

**Explanation of GlobalRateLimiter fields:**

- `spec.serviceType`: Type of service being rate limited
- `spec.failureModeDeny`: Whether to deny requests when the rate limiter fails
- `spec.domain`: Domain for the rate limiter
- `spec.rules`: Rate limiting rules
  - `shadowMode`: Whether to only log rate limit violations without enforcing them
  - `rateLimit.fixedWindow`: Fixed window rate limiting configuration
    - `unit`: Time unit for the rate limit window (second, minute, hour, day)
    - `requestsPerUnit`: Maximum number of requests allowed per unit
  - `descriptors`: Descriptors for the rate limit

This configuration limits requests to `<microservice-name>` to `<requestsPerUnit>` per `<unit>`, and can also limit requests based on request headers, request paths, and request methods.

### Security

Istio provides a comprehensive security model that encompasses workload-to-workload authentication (via mutual TLS) and fine-grained access control (via authorization policies). In this section, we introduce how to configure PeerAuthentication to enforce mutual TLS for incoming connections, and how to use AuthorizationPolicy to control which clients may access which workloads.

#### Peer Authentication (mTLS)

`PeerAuthentication` resources define the mutual TLS (mTLS) requirements for incoming traffic to workloads within the mesh. When you enable `PeerAuthentication`, Envoy sidecars enforce that incoming connections use the specified mTLS mode. Istio supports three mTLS modes:

* **`STRICT`**: Workloads only accept connections encrypted with mTLS. Plaintext (non-mTLS) traffic is rejected.
* **`PERMISSIVE`**: Workloads accept both mTLS and plaintext traffic. This is useful during migrations when some workloads have not yet been upgraded to require mTLS.
* **`DISABLE`**: mTLS is disabled; workloads accept only plaintext traffic. It is recommended to use this mode only if you have an external security solution.

Istio applies `PeerAuthentication` policies in the following precedence order:

1. **Workload-specific** (narrowest scope; selects pods by label).
2. **Namespace-wide** (applies to all workloads in a namespace).
3. **Mesh-wide** (applies cluster-wide).

The following examples illustrate how to use `PeerAuthentication` to enforce namespace-wide mTLS:

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: <namespace>
spec:
  mtls:
    mode: STRICT
```

Apply this policy to ensure that any client not using mTLS will be rejected when attempting to connect to a sidecar in namespace `<namespace>`.

#### Authorization Policy

`AuthorizationPolicy` resources define fine-grained access control rules (allow, deny, audit) for workloads—controlling which principals (service accounts), namespaces, IP blocks, or request attributes (methods, paths, headers, JWT claims) can access specific workloads or ports.

* **`action: ALLOW`** (default): Only matching requests are permitted; all others are rejected.
* **`action: DENY`**: Matching requests are explicitly rejected; others are permitted.
* **`action: AUDIT`**: Matching requests are marked for audit (logged) but not rejected.

Policies consist of a set of rules. Each rule may have:

* **`from.source`**: Specifies the request origin, such as `principals`, `namespaces`, or `ipBlocks`.
* **`to.operation`**: Filters requests by `methods`, `paths`, `ports`, or `hosts`.
* **`when`**: Conditions on request attributes, including JWT claims or headers.

The following example allows only service account `cluster.local/ns/<another-service-namespace>/sa/<another-service-account>` **or** any workload in namespace `<service-namespace>` to access the service pod match `<pod-label-key>: <pod-label-value>`:

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: <service-name-allow>
  namespace: <service-namespace>
spec:
  selector:
    matchLabels:
      <pod-label-key>: <pod-label-value>
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/<another-service-namespace>/sa/<another-service-account>"]
    - source:
        namespaces: ["<service-namespace>"]
```

### API definition

Define API endpoints for metrics collection and monitoring:

```yaml
apiVersion: asm.alauda.io/v1alpha2
kind: ApiAttribute
metadata:
  labels:
    asm.cpaas.io/msname: <microservice-name>
    app.cpaas.io/microservice-type: service-mesh
  name: <microservice-name>
  namespace: <microservice-namespace>
spec:
  apis:
  - operationid: get-service-data
    path: "/api/v1/data/{id}" # support Restful API
    method: GET
    port: <service-port>
  - operationid: create-service-data
    path: "/api/v1/data"
    method: POST
    port: <service-port>
```

Apply this configuration:

```shell
kubectl apply -f apiattribute.yaml
```

**Explanation of ApiAttribute fields:**

- `spec.apis`: List of API endpoints
  - `operationid`: Unique identifier for the operation
  - `path`: URL path for the API endpoint
  - `method`: HTTP method for the API endpoint
  - `port`: Port on which the API is exposed

This configuration defines API endpoints for metrics collection and monitoring.

## Chapter 4: Validation and testing

After migrating to ASM, it's important to validate your setup to ensure everything is working correctly.

### Verify sidecar injection

Check that the Envoy sidecar proxy has been injected into your pods:

```shell
kubectl get pods -n <namespace> -o jsonpath='{.items[*].spec.containers[*].name}' | grep istio-proxy
```

If the sidecar has been injected successfully, you should see `istio-proxy` in the output.

### Check proxy configuration

Examine the Envoy proxy configuration:

```shell
istioctl proxy-config all <pod-name> -n <namespace>
```

This command displays the complete configuration of the Envoy proxy, including listeners, routes, clusters, and endpoints.

### Test service connectivity

Verify that your services can communicate with each other:

```shell
kubectl exec -it <client-pod> -n <namespace> -- curl <service-name>:<port>/<api-path>
```

This command tests connectivity from a client pod to your service.

### Verify traffic management

Analyze your service mesh configuration for potential issues:

```shell
istioctl analyze -n <namespace>
```

This command checks your service mesh configuration for common issues and provides recommendations.

### Monitor traffic flow

Use the Alauda Service Mesh dashboard to monitor traffic flow between your services. The dashboard provides visualizations of service dependencies, traffic patterns, and performance metrics.

Alauda Service Mesh provides built-in end-to-end tracing capabilities to help you visualize and diagnose request flows across all services—even when traffic traverses multiple clusters.

## Chapter 5: Troubleshooting common issues

### Sidecar injection fails

If sidecar injection doesn't work:

1. Verify namespace labels are correctly applied:
   ```shell
   kubectl get namespace <namespace> --show-labels
   ```

2. Check MicroService resource status:
   ```shell
   kubectl get microservice <microservice-name> -n <namespace> -o yaml
   ```

3. Restart pods to trigger injection after configuration changes:
   ```shell
   kubectl rollout restart deployment <deployment-name> -n <namespace>
   ```

### Service connectivity issues

If services can't communicate:

1. Verify that Service ports are correctly named (e.g., `http`, `grpc`):
   ```shell
   kubectl get service <service-name> -n <namespace> -o yaml
   ```

2. Check authentication policies:
   ```shell
   kubectl get peerauthentication -n <namespace>
   kubectl get authorizationpolicy -n <namespace>
   ```

3. Ensure NetworkPolicies allow traffic:
   ```shell
   kubectl get networkpolicy -n <namespace>
   ```

### Traffic routing problems

If traffic routing doesn't work as expected:

1. Validate VirtualService configuration:
   ```shell
   kubectl get virtualservice <virtualservice-name> -n <namespace> -o yaml
   ```

2. Check destination hosts:
   ```shell
   kubectl get service -n <namespace>
   ```

3. Verify DestinationRule configuration:
   ```shell
   kubectl get destinationrule <destinationrule-name> -n <namespace> -o yaml
   ```

## Best Practices

1. **Resource Naming**: Use consistent naming conventions for all resources
2. **Label Strategy**: Apply consistent labels across all resources for better management
3. **Resource Limits**: Configure appropriate resource limits for application and sidecar containers
4. **Gradual Migration**: Migrate applications one by one, testing thoroughly at each step

## Conclusion

Migrating from Istio to Alauda Service Mesh provides several advantages:

1. **Enhanced Management**: ASM provides a more user-friendly management interface and additional custom resources for easier configuration.
2. **Simplified Sidecar Injection**: The MicroService resource simplifies sidecar injection and configuration.
3. **Advanced Traffic Management**: ASM extends Istio's traffic management capabilities with additional features.
4. **Improved Observability**: ASM provides enhanced observability through integrated dashboards, metrics and tracing.
5. **Enterprise Support**: ASM offers enterprise-grade support and integration with the broader Alauda Container Platform.

By following this guide, you can successfully migrate your standard Kubernetes applications to Alauda Service Mesh, unlocking advanced capabilities for traffic management, resilience, and observability while maintaining compatibility with the broader Istio ecosystem.

For more detailed information and advanced configurations, refer to the official Alauda Service Mesh documentation.
