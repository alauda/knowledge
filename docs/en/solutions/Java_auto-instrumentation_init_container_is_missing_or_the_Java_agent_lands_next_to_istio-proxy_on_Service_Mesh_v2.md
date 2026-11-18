---
kind:
  - Troubleshooting
products:
  - Alauda Service Mesh
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Java auto-instrumentation init container is missing or the Java agent lands next to istio-proxy on Service Mesh v2

## Issue

Non-intrusive (automatic) tracing is configured for a Java application, but Jaeger shows no traces from that Pod. One of these is seen:

- The Pod has no `opentelemetry-auto-instrumentation-java` init container.
- Both the Istio sidecar and the OpenTelemetry Java agent are injected, but `JAVA_TOOL_OPTIONS` is set on `istio-proxy` instead of the business container.
- Business logs carry no TraceID, so a log line cannot be matched to a trace in the Jaeger UI.
- The question is whether the platform's OpenTelemetry Operator can auto-instrument Nginx.

The Alauda Build of OpenTelemetry v2 operator injects the agent through a pod-mutating admission webhook when the pod template carries an `instrumentation.opentelemetry.io/inject-java` annotation that points at an `Instrumentation` resource.

Related articles: "asm-otel collectors keep restarting, Service Mesh JVM monitoring has no data, or an otel instance cannot be deleted" covers an agent that is injected but cannot reach the Collector, and missing JVM metrics.

## Root Cause

### Cause 1: the OpenTelemetry v2 integration was not completed in order

The integration has an order: install Jaeger and the OpenTelemetry Collector, connect them to Elasticsearch or OpenSearch, create an `Instrumentation`, and only then annotate the Java workload. When any earlier step is missing, the webhook does not generate the `opentelemetry-auto-instrumentation-java` init container. Completing the whole sequence resolves it.

### Cause 2: on Mesh v2 with Kubernetes earlier than 1.33, the agent targets the sidecar

On Mesh v2 and Kubernetes versions earlier than 1.33, the business container that should receive the Java agent has to be named with an annotation; otherwise injection can apply to the Istio sidecar. From Kubernetes 1.33, sidecar init containers are supported and this does not happen. On Mesh v1, simultaneous injection of the Java agent and the Istio sidecar is supported.

### Cause 3: the TraceID is created by the Java agent and has to be written into the log pattern

Jaeger does not generate TraceIDs. The OpenTelemetry Java agent generates and propagates them. The Istio sidecar can generate a TraceID, but propagation across calls must then be handled by the application. The TraceID appears in business logs only when the log pattern prints it.

### Cause 4: Nginx auto-instrumentation is enabled in `opentelemetry-operator2.v0.157.0-r1`

The operator build `opentelemetry-operator2.v0.157.0-r1` sets `ENABLE_NGINX_AUTO_INSTRUMENTATION` to `"true"` (next to `ENABLE_GO_AUTO_INSTRUMENTATION: "true"`). The implementation is the upstream OpenTelemetry Operator Nginx auto-instrumentation of v0.157.0.

## Resolution

### Cause 1: the OpenTelemetry v2 integration was not completed in order

1. Check each step and complete the first one that is missing:
   1. The OpenTelemetry v2 operator is installed and its webhook is registered.
   2. Jaeger and the Collector are deployed and connected to Elasticsearch or OpenSearch. Jaeger v2 is deployed by the OpenTelemetry v2 operator; a separate Alauda Build of Jaeger v2 install is not needed.
   3. An `Instrumentation` exists in the application namespace, or the annotation references one in another namespace as `<namespace>/<instrumentation-name>`.
   4. The pod template carries the injection annotation.

   ```bash
   kubectl get csv -A | grep -i opentelemetry
   kubectl get mutatingwebhookconfiguration | grep -i opentelemetry
   kubectl get opentelemetrycollector -A
   kubectl get pods -A | grep -i -E 'jaeger|otel|collector'
   kubectl get instrumentation -n <app-namespace>
   ```

2. Create the `Instrumentation`, pointing at the Collector Service. Use the `<collector-service>.<collector-namespace>` form; a full name with a wrong cluster domain does not resolve.

   ```yaml
   apiVersion: opentelemetry.io/v1alpha1
   kind: Instrumentation
   metadata:
     name: java-instrumentation
     namespace: <app-namespace>
   spec:
     exporter:
       endpoint: http://<collector-service>.<collector-namespace>:4318
     propagators:
       - tracecontext
       - baggage
   ```

   ```bash
   kubectl apply -f java-instrumentation.yaml
   ```

3. Annotate the workload.

   > **Warning:** Patching the pod template restarts the workload's Pods. Only after steps 1.1 to 1.3 are in place. Rollback: set the annotation to `null` with the same patch, which restarts the Pods without the agent.

   ```bash
   kubectl -n <app-namespace> patch deployment <deployment-name> --type=merge \
     -p '{"spec":{"template":{"metadata":{"annotations":{"instrumentation.opentelemetry.io/inject-java":"java-instrumentation"}}}}}'
   kubectl -n <app-namespace> get pod <pod-name> -o jsonpath='{.spec.initContainers[*].name}{"\n"}'
   ```

   The new Pod should list `opentelemetry-auto-instrumentation-java` among its init containers.

### Cause 2: on Mesh v2 with Kubernetes earlier than 1.33, the agent targets the sidecar

1. Check the Kubernetes version and the container names:

   ```bash
   kubectl version
   kubectl -n <app-namespace> get deploy <deployment-name> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
   ```

2. Below 1.33, name the business container with `instrumentation.opentelemetry.io/container-names`.

   > **Warning:** The Pods restart with the agent attached only to the named container. Only on Mesh v2 with Kubernetes earlier than 1.33 and both the sidecar and the agent injected. Rollback: set `instrumentation.opentelemetry.io/container-names` to `null`.

   ```bash
   kubectl -n <app-namespace> patch deployment <deployment-name> --type=merge \
     -p '{"spec":{"template":{"metadata":{"annotations":{"instrumentation.opentelemetry.io/inject-java":"java-instrumentation","instrumentation.opentelemetry.io/container-names":"<business-container>"}}}}}'
   ```

   On Kubernetes 1.33 and later, and on Mesh v1, this annotation is not needed.

### Cause 3: the TraceID is created by the Java agent and has to be written into the log pattern

After the agent is injected, add the TraceID to the business log pattern. For Spring Boot logging:

```properties
logging.pattern.level = trace_id=%mdc{trace_id}
```

Search the TraceID from a log line in the Jaeger UI to open the full call chain. For the agent's overhead, use the OpenTelemetry Java agent performance test report as the reference; no single figure applies to every application.

### Cause 4: Nginx auto-instrumentation is enabled in `opentelemetry-operator2.v0.157.0-r1`

1. Confirm the switch on the installed operator:

   ```bash
   kubectl get csv -A | grep opentelemetry-operator2
   kubectl get csv -n <operator-namespace> <opentelemetry-operator2-csv> -o yaml | grep -A1 -E 'ENABLE_NGINX_AUTO_INSTRUMENTATION|ENABLE_GO_AUTO_INSTRUMENTATION'
   ```

2. Follow the upstream Nginx auto-instrumentation document for v0.157.0: the `Instrumentation` carries an `nginx` section (optionally `configFile` and `attrs`), and the workload opts in with `instrumentation.opentelemetry.io/inject-nginx: "true"`. Check the supported Nginx versions and the expected configuration layout (`/etc/nginx/nginx.conf` with a `conf.d` include in the `http` block, unless `configFile` says otherwise) against the image first.

   > **Warning:** The Pods restart with the Nginx module injected. Only when an `Instrumentation` with an `nginx` section exists in the namespace and the image meets the upstream requirements. Rollback: set the annotation to `null`.

   ```bash
   kubectl -n <app-namespace> patch deployment <nginx-deployment> --type=merge \
     -p '{"spec":{"template":{"metadata":{"annotations":{"instrumentation.opentelemetry.io/inject-nginx":"true"}}}}}'
   ```

## Diagnostic Steps

1. Look at what was injected into a running Pod:

   ```bash
   kubectl -n <app-namespace> get pod <pod-name> -o jsonpath='{.metadata.annotations}{"\n"}{.spec.initContainers[*].name}{"\n"}'
   kubectl -n <app-namespace> get pod <pod-name> -o jsonpath='{range .spec.containers[*]}{.name}{" "}{.env[?(@.name=="JAVA_TOOL_OPTIONS")].value}{"\n"}{end}'
   ```

2. Read the operator log for the Pod's admission:

   ```bash
   kubectl -n <operator-namespace> logs <operator-pod> --tail=200 | grep -i -E 'inject|instrumentation'
   ```

| What you see | Cause |
| --- | --- |
| No `opentelemetry-auto-instrumentation-java` init container; Collector, Jaeger, storage, or `Instrumentation` missing | 1 |
| `JAVA_TOOL_OPTIONS` on `istio-proxy`, Kubernetes earlier than 1.33 | 2 |
| Agent injected, logs have no TraceID | 3 |
| Nginx auto-instrumentation wanted on `opentelemetry-operator2.v0.157.0-r1` | 4 |
| Agent injected into the business container, init container `terminated`, application log shows `Failed to export ... timeout` | The asm-otel article, Cause 4 |
