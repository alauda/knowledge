---
kind:
  - How To
products:
  - Alauda Service Mesh
ProductsVersion:
  - "4.2"
  - "4.3"
  - "4.4"
---

# Moving Service Mesh v2 tracing storage from Elasticsearch to OpenSearch with Jaeger v2

## Issue

A Service Mesh v2 tracing pipeline stores traces in Elasticsearch and has to move to OpenSearch. The questions are whether the move affects business traffic, which component versions fit together, and what the steps are. Related questions:

- Is Alauda Build of Jaeger v2 now deployed independently of ASM, and how does the mesh send traces to it?
- Which Elasticsearch version does the tracing feature support, for example whether an existing ES7 can be used?
- Must the host that runs the Jaeger v2 installation have `jq`?

The layout described for Cause 1 is that of ACP 4.2.2: an OpenTelemetry Collector sends traces to a Jaeger v2 service in `jaeger-system` that writes to Elasticsearch. The Alauda Build of OpenTelemetry v2 operator (adapted to ACP 4.2) deploys Jaeger v2; OpenSearch Operator v2.8 from the App Marketplace deploys OpenSearch 3.x.

## Root Cause

### Cause 1: the tracing pipeline uses the legacy mesh integration with Elasticsearch storage

Moving to OpenSearch means deploying a Jaeger v2 instance integrated with OpenSearch and pointing the OpenTelemetry Collector at it. Switching the backend does not affect business traffic; a small amount of trace data can be lost during the switch.

### Cause 2: Jaeger v2 is the standalone product Alauda Distributed Tracing

Alauda Build of Jaeger v2 is installed and run as the standalone product Alauda Distributed Tracing; it is no longer part of ASM. ASM only exports Istio spans to the deployed Jaeger v2 and OpenTelemetry Collector. One tracing stack can serve both the mesh and other workloads in the cluster; its default namespace is `jaeger-system`. The old stack, Alauda Build of Jaeger (Jaeger 1.60.0) plus Alauda Build of OpenTelemetry, is deprecated in ACP 4.4 and will be removed; the old Distributed Tracing pages are removed in ACP 4.4, with ACP 4.3 as the last version that contains them.

### Cause 3: Elasticsearch 8.x is the supported version

The Alauda Distributed Tracing documentation (Configuration > Storage Backend > Elasticsearch) lists Elasticsearch 8.x as supported. Jaeger detects the version from the Elasticsearch root endpoint and then uses the matching index mappings and REST APIs; the version can also be set explicitly with the `version` property of the Elasticsearch storage configuration. ES7 is not listed as supported.

### Cause 4: the Jaeger v2 installation depends on `jq`

The Jaeger v2 installation depends on `jq`, so the host that runs the installation must have it.

## Resolution

### Cause 1: the tracing pipeline uses the legacy mesh integration with Elasticsearch storage

Install OpenSearch Operator v2.8 from the App Marketplace and create an OpenSearch 3.x cluster. Back up the Collector configuration:

```bash
kubectl get opentelemetrycollector -A
kubectl -n <collector-namespace> get opentelemetrycollector <collector-name> -o yaml > /tmp/otel-collector.bak.yaml
kubectl -n jaeger-system get all
```

Then choose one of the three paths.

#### Path A: historical traces are not needed

1. Deploy a new Jaeger v2 service integrated with OpenSearch, following the Jaeger v2 deployment procedure of the OpenTelemetry v2 operator. Set `JAEGER_INSTANCE_NAME` to a value other than `jaeger`, for example `jaeger-opensearch`, so it does not collide with the old instance.
2. Point the Collector exporter at the new service; copy TLS and other settings from the exporter that points at the old Jaeger.

   ```yaml
   spec:
     config:
       exporters:
         otlp/jaeger-opensearch:
           endpoint: <new-jaeger-collector-service>.<new-jaeger-namespace>.svc:4317
       service:
         pipelines:
           traces:
             exporters:
               - otlp/jaeger-opensearch
   ```

   > **Warning:** The Collector restarts and spans in flight can be lost. Only when the new Jaeger v2 is Running and connected to OpenSearch, and the backup exists. Rollback: `kubectl apply -f /tmp/otel-collector.bak.yaml`.

   ```bash
   kubectl -n <collector-namespace> edit opentelemetrycollector <collector-name>
   kubectl -n <collector-namespace> get pods -w
   ```

3. Confirm new traces in the new Jaeger UI, then uninstall the old Jaeger v2 service in `jaeger-system` with the uninstall step of the procedure that deployed it.

   > **Warning:** Traces stored through the old Jaeger can no longer be queried once it is removed. Only after new traces are confirmed and only when historical traces are not needed. Rollback: reinstall the old Jaeger against Elasticsearch to read old traces.

#### Path B: historical traces must be kept for a period

Deploy the new Jaeger v2 as in Path A. Add a second traces pipeline so data goes to both services; keep the receivers and processors of the existing pipeline:

```yaml
spec:
  config:
    exporters:
      otlp/jaeger:
        endpoint: <old-jaeger-collector-service>.jaeger-system.svc:4317
      otlp/jaeger-opensearch:
        endpoint: <new-jaeger-collector-service>.<new-jaeger-namespace>.svc:4317
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [otlp/jaeger]
        traces/opensearch:
          receivers: [otlp]
          processors: [batch]
          exporters: [otlp/jaeger-opensearch]
```

Apply it with `kubectl edit` under the same Warning as Path A step 2. After the retention period, remove the `traces` pipeline and the `otlp/jaeger` exporter, and uninstall the old service under the Warning of Path A step 3.

#### Path C: test environment where a short trace gap is acceptable

Uninstall the old Jaeger v2 first, then deploy the new one with `JAEGER_INSTANCE_NAME=jaeger`, integrated with OpenSearch. Because the name stays `jaeger`, the Collector exporter can stay unchanged; confirm the Service it points to exists after the new instance is Ready.

> **Warning:** No traces are stored between the uninstall and the new instance becoming Ready, and old traces are no longer reachable. Test environments only. Rollback: reinstall Jaeger v2 against Elasticsearch to read old traces.

```bash
kubectl -n jaeger-system get opentelemetrycollector,deploy,svc
kubectl -n jaeger-system get svc -o custom-columns='NAME:.metadata.name,PORTS:.spec.ports[*].port'
```

### Cause 2: Jaeger v2 is the standalone product Alauda Distributed Tracing

1. For a new deployment, follow the current Alauda Distributed Tracing installation guide for the backend you use (Elasticsearch or OpenSearch) instead of the deprecated tracing documents; existing deployments follow its migration guide. The order is:
   1. Cluster plugin Alauda Build of Jaeger v2.
   2. OpenTelemetry v2 Operator.
   3. Deploy Jaeger v2.
   4. Deploy the Collector.

   ```bash
   kubectl get pods -n jaeger-system
   kubectl get svc -n jaeger-system | grep -E 'otel-collector|jaeger'
   ```

2. To send mesh traces, add an `extensionProviders` entry on the `Istio` resource that points at the Collector, and reference it from a `Telemetry` resource. The provider name is an example and the sampling percentage is a site choice. If the cluster DNS domain is not `cluster.local`, use the cluster's domain in the service name.

   > **Warning:** istiod pushes new configuration to every proxy, and a `Telemetry` in `istio-system` changes tracing for the whole mesh. Copy existing `extensionProviders` entries into the patch, because a merge patch replaces the whole list. Rollback: `kubectl apply -f /tmp/istio-tracing.bak.yaml` (remove `metadata.resourceVersion` on conflict) and `kubectl delete telemetry -n istio-system mesh-default`.

   ```bash
   kubectl get istio <istio-name> -o yaml > /tmp/istio-tracing.bak.yaml
   kubectl get istio <istio-name> -o jsonpath='{.spec.values.meshConfig.extensionProviders}{"\n"}'
   kubectl patch istio <istio-name> --type=merge -p '{"spec":{"values":{"meshConfig":{"extensionProviders":[{"name":"otel-tracing","opentelemetry":{"service":"otel-collector.jaeger-system.svc.cluster.local","port":4317}}]}}}}'
   ```

   ```yaml
   apiVersion: telemetry.istio.io/v1
   kind: Telemetry
   metadata:
     name: mesh-default
     namespace: istio-system
   spec:
     tracing:
       - providers:
           - name: otel-tracing
         randomSamplingPercentage: 10.0
   ```

   ```bash
   kubectl apply -f mesh-default-telemetry.yaml
   ```

3. To remove the mesh integration later, remove the `Istio` and `Telemetry` configuration first; leave Jaeger and the Collector in place while other workloads still use tracing.

### Cause 3: Elasticsearch 8.x is the supported version

Use Elasticsearch 8.x. If only ES7 is available, it can be tested, but it is not a supported combination. Read the version Jaeger will detect:

```bash
curl -s -k -u '<es-user>:<es-password>' https://<es-address>:9200/ | grep '"number"'
```

### Cause 4: the Jaeger v2 installation depends on `jq`

Install `jq` on the host that runs the installation, then rerun the step:

```bash
command -v jq || echo 'jq is missing'
yum install -y jq    # or: apt-get install -y jq; use an internal mirror on an offline host
jq --version
```

## Diagnostic Steps

1. Confirm the layout before starting:

   ```bash
   kubectl get csv -A | grep -i -E 'opentelemetry|opensearch'
   kubectl get pods -n jaeger-system
   kubectl -n <collector-namespace> get opentelemetrycollector <collector-name> -o jsonpath='{.spec.config}{"\n"}'
   ```

2. After the switch, check that the Collector exports without errors and the new Jaeger receives data:

   ```bash
   kubectl -n <collector-namespace> logs <collector-pod> --tail=200 | grep -i -E 'error|export'
   kubectl -n <new-jaeger-namespace> logs <new-jaeger-pod> --tail=200 | grep -i -E 'opensearch|error'
   ```

| What you see | Next step |
| --- | --- |
| Collector logs export errors to the new endpoint | Check the Service name and port in the exporter |
| New Jaeger logs OpenSearch connection errors | Check the OpenSearch address and credentials given to Jaeger |
| No mesh spans in the standalone Jaeger v2 | Cause 2: check `extensionProviders` on `Istio` and the `Telemetry` provider name |
| Elasticsearch root endpoint reports a 7.x `number` | Cause 3 |
| Installation stops because `jq` is not found | Cause 4 |
