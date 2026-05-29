---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OpenTelemetry Collector logs "Instrument description conflict" for JVM memory metrics

## Issue

An `OpenTelemetryCollector` running on the cluster, configured with an OTLP receiver and the `prometheus` exporter, repeatedly logs an `info`-level conflict line for the `jvm_memory_used_bytes` metric whenever two upstream sources publish the same instrument name with different OpenTelemetry instrument descriptions. The log line carries the kept description and the dropped description verbatim, originates from the collector's `prometheusexporter` component, and recurs for every batch the collector ingests.

```text
info  prometheusexporter@v0.147.0/collector.go:656  Instrument description conflict, using existing
  {"otelcol.component.id": "prometheus",
   "otelcol.component.kind": "exporter",
   "otelcol.signal": "metrics",
   "instrument": "jvm_memory_used_bytes",
   "existing": "The amount of used memory",
   "dropped":  "Measure of memory used."}
```

The two descriptions in the message correspond to two independent JVM-metrics sources that publish under the same OTel instrument name `jvm_memory_used_bytes` — the OpenTelemetry Java agent's built-in `runtime-telemetry` module emits the instrument with description `Measure of memory used.`, while the Micrometer-to-OTel bridge (used by Spring Boot's actuator JVM metrics) emits it with description `The amount of used memory`.

## Root Cause

The Prometheus exporter inside the OpenTelemetry Collector deduplicates by instrument name. When a second registration arrives with the same name but a different description, the exporter keeps the description that was registered first and emits the `Instrument description conflict, using existing` log line; the conflict is recorded once and re-emitted whenever subsequent batches re-assert the conflicting description.

The conflict is cosmetic — the collector continues to scrape and export both source datapoints under the single retained instrument. After sending two OTLP payloads with the same instrument name and different label sets (one from a `micrometer` scope labelled `job=app-a`, value `1024`; one from a `runtime-telemetry` scope labelled `job=app-b`, value `2048`) and then scraping the exporter's `/metrics` endpoint, both samples appear in the output under a single `# HELP` line, with the first-registered description winning the shared HELP text.

```text
# HELP jvm_memory_used_bytes The amount of used memory
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes{job="app-a",otel_scope_name="micrometer",...} 1024
jvm_memory_used_bytes{job="app-b",otel_scope_name="runtime-telemetry",...} 2048
```

Repeated rounds of the two payloads continue to update both samples; no datapoint is dropped. The log noise is therefore the surface symptom of two independent sources writing under one name, not a metric-loss bug.

## Resolution

There are four remedies, all targeting the same underlying duplication of the two `jvm_memory_used_bytes` registrations described above. Only the first three silence the log line by removing one of the two sources; the fourth accepts the log noise as cosmetic since the metric continues to export.

**Option 1 — disable the Micrometer-to-OTel bridge in the Java agent.** If the Micrometer-bridged metrics are not specifically needed (the OTel Java agent already publishes equivalent JVM metrics out of the box), disable the bridge by setting the agent's feature flag to `false`, either at the workload level or via the auto-injected `Instrumentation` CR. With the bridge off, the Micrometer-sourced description (`The amount of used memory`) no longer reaches the collector, leaving only the agent's `runtime-telemetry`-sourced instrument and removing the conflict. The `Instrumentation` CR's `spec.java.env` field is the upstream-shaped vehicle for `OTEL_INSTRUMENTATION_*` env vars; the operator injects them into auto-instrumented containers. The CR shape was confirmed on the cluster — `spec.java.env` is `[]Object` with `name`/`value`/`valueFrom`, matching the upstream OpenTelemetry Operator schema.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-inst
  namespace: <your-app-namespace>
spec:
  java:
    env:
      - name: OTEL_INSTRUMENTATION_MICROMETER_ENABLED
        value: "false"
```

**Option 2 — disable the agent's runtime-telemetry instead.** If the Micrometer bridge is the strategic source for application metrics and should also own the JVM metrics, keep the bridge enabled and disable the agent's built-in runtime-telemetry module so Micrometer is the sole source of `jvm_memory_used_bytes` — the agent-sourced description (`Measure of memory used.`) then never registers with the exporter. Both env-var names are recognized by the OpenTelemetry Java auto-instrumentation agent and travel through the same `Instrumentation` CR `spec.java.env` field as option 1.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-inst
  namespace: <your-app-namespace>
spec:
  java:
    env:
      - name: OTEL_INSTRUMENTATION_MICROMETER_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_RUNTIME_TELEMETRY_ENABLED
        value: "false"
```

**Option 3 — disable the Micrometer JVM binders at the application level (Spring Boot).** If the application code already uses Spring Boot actuator + Micrometer but only the JVM meters should be silenced (leaving Micrometer free to publish business metrics), exclude the JVM binders from the application side with the actuator toggle so the Micrometer-sourced JVM instruments stop being registered with the bridge in the first place; the OTel agent's runtime-telemetry remains the JVM metrics source and Micrometer continues to publish everything else. Add the following property to the Spring Boot application's `application.properties` or `application.yaml`.

```text
management.metrics.enable.jvm=false
```

**Option 4 — tolerate the log noise.** If neither end of the pipeline can be changed and both sources are required, the log lines can be safely ignored. The conflict is `info`-level and the metrics export correctly with both sources contributing — both samples remain queryable from the Prometheus exporter under one `# HELP` line, and the collector's Prometheus exporter does not currently expose a configuration knob to suppress this specific log line.

## Diagnostic Steps

Read the collector logs and grep for the conflict line — its presence pins the source to the `prometheusexporter` component and identifies the offending instrument by name.

```bash
kubectl logs -n <otel-collector-namespace> deploy/<collector-deployment-name> \
  | grep -iE 'Instrument description conflict|prometheusexporter'
```

The matched log line shows the kept (`existing`) and discarded (`dropped`) description strings together with the offending `instrument` name. Repeated occurrences mean two upstream sources keep re-asserting the same instrument under different descriptions.

Verify that data is still flowing through despite the log noise by scraping the collector's Prometheus exporter endpoint and checking that both source datapoints are present.

```bash
kubectl exec -n <otel-collector-namespace> <client-pod> -- \
  curl -s http://<collector-svc>:8889/metrics | grep '^jvm_memory_used_bytes'
```

Each unique label combination (typically distinguished by `otel_scope_name` and the job's own labels) appears as a separate sample under a single `# HELP` line. If both samples are present, the conflict is purely cosmetic and no metric data has been lost — only one description has been chosen for the shared `# HELP` text.

Confirm the `Instrumentation` and `OpenTelemetryCollector` CRDs are present and reconciled by a live controller, which is the prerequisite for any of options 1 or 2 to take effect.

```bash
kubectl api-resources --api-group=opentelemetry.io
kubectl get instrumentation,opentelemetrycollector -A
```

The expected groups are `instrumentations.opentelemetry.io` (`v1alpha1`) and `opentelemetrycollectors.opentelemetry.io` (`v1beta1` on current builds; `v1alpha1` still served for backward compatibility). The operator CSV must be `Succeeded` and its controller pod `Running` for `Instrumentation` env-var changes to be injected into auto-instrumented workloads.
