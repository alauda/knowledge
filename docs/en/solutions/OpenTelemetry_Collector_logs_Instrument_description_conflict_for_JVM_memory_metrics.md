---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An OpenTelemetry Collector that ingests metrics from a Java workload and re-exports them to Prometheus emits repeated `info`-level lines about an instrument description conflict for `jvm_memory_used_bytes`:

```text
info prometheusexporter@vX.Y.Z/collector.go:517 Instrument description conflict, using existing
  {"otelcol.component.id":"prometheus","otelcol.component.kind":"exporter",
   "otelcol.signal":"metrics","instrument":"jvm_memory_used_bytes",
   "existing":"The amount of used memory","dropped":"Measure of memory used."}
```

The metric is exported correctly (Prometheus scrapes a single, consistent value); only the **description** string flips between two strings produced by two different instrumentations. The log noise is substantial in any application that reports JVM metrics frequently.

## Root Cause

The collector receives the same metric `jvm_memory_used_bytes` from two sources at the same time:

- The OpenTelemetry Java agent's built-in **runtime telemetry** instrumentation (`OTEL_INSTRUMENTATION_RUNTIME_TELEMETRY_ENABLED=true`, on by default) emits the metric with description `"The amount of used memory"`.
- The OpenTelemetry **Micrometer bridge** (`OTEL_INSTRUMENTATION_MICROMETER_ENABLED=true`) re-exports JVM metrics that the application's framework (Spring Boot, etc.) already publishes via Micrometer, with description `"Measure of memory used."`.

The Prometheus exporter de-duplicates by metric name and keeps the first description it sees; subsequent registrations for the same name with a different description trigger the conflict log line. The metric value itself is unaffected — both sources observe the same JVM heap counter — but the duplicate publisher is genuine and the log spam will not stop on its own.

## Resolution

Pick one source of JVM metrics. Four practical options:

### Option 1 — Disable Micrometer bridging in the OTel Java agent

Simplest if the application does not rely on application-specific Micrometer metrics:

```yaml
env:
  - name: OTEL_INSTRUMENTATION_MICROMETER_ENABLED
    value: "false"
```

The OTel agent's runtime telemetry remains the single source of JVM metrics.

### Option 2 — Keep Micrometer bridging but disable the agent's runtime telemetry

Use this when application-specific Micrometer metrics need to flow through OTel but JVM metrics should come from Micrometer:

```yaml
env:
  - name: OTEL_INSTRUMENTATION_MICROMETER_ENABLED
    value: "true"
  - name: OTEL_INSTRUMENTATION_RUNTIME_TELEMETRY_ENABLED
    value: "false"
```

These environment variables can be set on the workload directly, or projected via the `Instrumentation` custom resource managed by the OpenTelemetry Operator:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java
spec:
  java:
    env:
      - name: OTEL_INSTRUMENTATION_MICROMETER_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_RUNTIME_TELEMETRY_ENABLED
        value: "false"
```

### Option 3 — Disable JVM meters at the application level (Spring Boot)

Let the OTel Java agent be the sole source of JVM metrics while Micrometer continues to bridge custom application metrics. Add to `application.properties` or `application.yaml`:

```properties
management.metrics.enable.jvm=false
```

### Option 4 — Tolerate the log lines

If neither source can be turned off (Micrometer bridge is needed, runtime telemetry is needed by other consumers), the conflict logs are harmless: values are correct, the description string just flaps. The Prometheus exporter does not currently expose a knob to suppress these specific lines, so this is a "live with it" path.

## Diagnostic Steps

1. Confirm the conflict is on JVM metrics specifically:

   ```bash
   kubectl logs <otel-collector-pod> -n <ns> | grep "Instrument description conflict" | head -n 20
   ```

   The `instrument` field identifies the metric name. JVM metrics (`jvm_memory_*`, `jvm_threads_*`, `jvm_gc_*`) are the typical hits.

2. List the active OTel Java agent environment variables on the workload to confirm both sources are enabled:

   ```bash
   kubectl exec <java-pod> -n <ns> -- env | grep -i OTEL_INSTRUMENTATION
   ```

3. Inspect the OpenTelemetry Operator's `Instrumentation` resource attached to the namespace:

   ```bash
   kubectl get instrumentation -n <ns> -o yaml
   ```

4. Validate that the metric value is consistent before and after the change by querying Prometheus:

   ```text
   jvm_memory_used_bytes{area="heap",service_name="<svc>"}
   ```

   The series should remain continuous through the configuration change, with only the description string in `/metrics` becoming stable.
