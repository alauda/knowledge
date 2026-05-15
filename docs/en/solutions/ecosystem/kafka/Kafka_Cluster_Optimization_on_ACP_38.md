---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Cluster Optimization on ACP 3.8

:::info Applicable Versions
ACP 3.8.x.
:::

## Introduction

This guide summarizes resource and configuration adjustments for Kafka clusters on ACP 3.8.x. Use it as a review checklist when creating or tuning Kafka instances.

## Reference Resource Plan

For a small 2 vCPU / 4 GiB Kafka broker profile, plan the surrounding components as well:

| Component | Resource | Storage |
| --- | --- | --- |
| Kafka broker | 2 vCPU / 4 GiB | 100 GiB or workload-specific |
| ZooKeeper | 2 vCPU / 4 GiB | 10-100 GiB depending on policy |
| TLS sidecar | 200m CPU / 128 MiB | N/A |
| Topic operator | 1 vCPU / 2 GiB | N/A |
| User operator | 1 vCPU / 2 GiB | N/A |
| Kafka exporter | 1 vCPU / 2 GiB | N/A |

## JVM Sizing

Set Kafka and ZooKeeper JVM heap to roughly one quarter of the container memory limit as a starting point:

```yaml
spec:
  kafka:
    jvmOptions:
      -Xms: 1024m
      -Xmx: 1024m
    resources:
      limits:
        cpu: 2
        memory: 4Gi
      requests:
        cpu: 2
        memory: 4Gi
  zookeeper:
    jvmOptions:
      -Xms: 1024m
      -Xmx: 1024m
    resources:
      limits:
        cpu: 2
        memory: 4Gi
      requests:
        cpu: 2
        memory: 4Gi
```

## Entity Operator Resources

```yaml
spec:
  entityOperator:
    tlsSidecar:
      resources:
        limits:
          cpu: 200m
          memory: 128Mi
        requests:
          cpu: 200m
          memory: 128Mi
    topicOperator:
      jvmOptions:
        -Xms: 500m
        -Xmx: 500m
      resources:
        limits:
          cpu: "1"
          memory: 2Gi
        requests:
          cpu: "1"
          memory: 2Gi
    userOperator:
      jvmOptions:
        -Xms: 500m
        -Xmx: 500m
      resources:
        limits:
          cpu: "1"
          memory: 2Gi
        requests:
          cpu: "1"
          memory: 2Gi
```

## Kafka Exporter Resources

```yaml
spec:
  kafkaExporter:
    groupRegex: ".*"
    topicRegex: ".*"
    resources:
      limits:
        cpu: 1
        memory: 2Gi
      requests:
        cpu: 1
        memory: 2Gi
```

## Naming Rules

Do not use underscores in Kafka-related custom resource names. Kubernetes resource names must follow RFC 1123. Use lowercase letters, numbers, hyphens, and dots, and start and end with an alphanumeric character.

## Topic Defaults

In ACP 3.8.2 and later, the default topic segment size was corrected. For older resources, verify topic config and set the intended value explicitly when needed:

```yaml
spec:
  config:
    retention.ms: "604800000"
    message.max.bytes: "1073741824"
```

## Important Considerations

- Size the topic operator and user operator according to the number of topics and users, not only the broker size.
- Use explicit topic configuration for production workloads.
- Keep resource requests equal to limits for predictable Kafka scheduling when using dedicated nodes.
- Validate generated YAML after UI changes because product defaults can vary by patch version.
