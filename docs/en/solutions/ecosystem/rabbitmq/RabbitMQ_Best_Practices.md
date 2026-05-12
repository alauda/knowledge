---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Best Practices

:::info Applicable Versions
ACP 3.14 and later. Most sizing and deployment guidance also applies to earlier operator-based RabbitMQ deployments.
:::

## Introduction

RabbitMQ is widely used for application decoupling, asynchronous processing, event distribution, and request-reply workloads. In Kubernetes environments, production stability depends on correct sizing, queue design, storage selection, and deployment isolation.

Use this guide as a baseline when planning a new RabbitMQ cluster or reviewing an existing one.

## Core Concepts

| Term | Description |
| --- | --- |
| Producer | Client that publishes messages. |
| Exchange | Receives messages and routes them according to bindings. |
| Queue | Stores messages for consumers. |
| Binding | Routing rule between an exchange and a queue. |
| Consumer | Client that reads messages from a queue. |
| Broker | A RabbitMQ node. A cluster contains one or more brokers. |

## Exchange Types

| Type | Use Case |
| --- | --- |
| `direct` | Exact routing key matching. Good for point-to-point routing. |
| `fanout` | Broadcast to all bound queues. |
| `topic` | Pattern-based routing. Good for selective pub/sub. |
| `headers` | Routing by message headers instead of routing keys. |

Prefer `topic` exchanges when the business requires flexible routing growth over time. Use `fanout` only when broad broadcast semantics are intentional.

## Capacity Planning

### Memory

RabbitMQ memory usage is affected by message size, backlog size, persistence, consumer speed, and queue type. Large backlogs increase both broker memory pressure and disk usage.

Recommendations:

- Keep queue backlog low whenever possible.
- Monitor memory alarms and queue growth together.
- Avoid co-locating memory-heavy business workloads on the same nodes unless resource isolation is validated.

### CPU

CPU usage mainly comes from routing, protocol handling, queue management, TLS, and plugin overhead.

Recommendations:

- Size CPU for peak publish and consume rates, not average load.
- Benchmark quorum queues and mirrored workloads separately from simple classic queues.
- Review Erlang scheduler binding behavior when many large RabbitMQ instances share the same node.

### Disk

Persistent queues require storage that can absorb both normal write throughput and burst backlogs.

Recommendations:

- Use stable persistent volumes for production clusters.
- Prefer storage classes with predictable latency.
- Size capacity from message rate, retention, durability mode, and DR duplication overhead.
- Keep operational headroom for failover, requeue, and temporary backlog spikes.

## Deployment Recommendations

### Operator and Instance Layout

- Use multiple replicas for production clusters.
- Distribute replicas across nodes with pod anti-affinity.
- Keep plugin sets aligned across clusters when DR or migration is required.
- Use the same service exposure model across environments unless there is a clear reason to differ.

### Service Type

Choose service exposure according to the access model:

- `ClusterIP` for in-cluster applications.
- `NodePort` when external access is required and platform networking is managed at the node level.
- `LoadBalancer` when MetalLB or a cloud load balancer is available.

### Persistence

Do not run production message workloads without persistence unless data loss is acceptable by design.

### Additional Configuration

Review these items during creation:

- replica count
- storage class and storage size
- CPU and memory requests and limits
- service type
- additional plugins
- affinity, anti-affinity, and tolerations
- environment configuration such as scheduler binding or plugin paths

## Integration Guidance

- Prefer access through a stable Service endpoint instead of individual pod IPs.
- Keep exchange, queue, and binding creation under version-controlled application or platform automation.
- Align client retry behavior with broker failover behavior.
- Design consumers to tolerate duplicate delivery.

## Operations Guidance

- Track queue depth, consumer count, message rates, memory alarms, and disk alarms.
- Investigate increasing backlog early. Slow consumers usually become visible before resource exhaustion.
- Validate plugin changes, DR settings, and migration procedures in a non-production environment first.

## Common Risks

- Too many messages accumulating in queues
- Under-sized storage for persistent workloads
- Missing anti-affinity for multi-replica clusters
- Uncontrolled plugin growth
- Treating RabbitMQ as durable long-term storage instead of a messaging system

## Reference Suggestions

- Use dedicated nodes when the cluster must meet strict latency or throughput targets.
- Prefer explicit routing and queue lifecycle management over ad hoc console-driven changes.
- Re-run capacity tests after changing queue types, plugins, or service exposure mode.
