---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Disaster Recovery Deployment Guide

:::info Applicable Versions
ACP 3.14, 3.15, and 3.16.
:::

## Introduction

This guide covers deployment of a hot standby RabbitMQ DR solution based on Shovel. The source cluster handles production traffic. The target cluster keeps replicated messages and becomes active only after failover.

## DR Characteristics

| Item | Value |
| --- | --- |
| Replication engine | RabbitMQ Shovel |
| Mode | Near-real-time asynchronous replication |
| Recommended topology | Source exchange to target exchange |
| RTO | Minutes, depending on manual failover |
| RPO | Seconds to minutes, depending on backlog and network |

## Risks and Limitations

- Shovel is single-process replication and needs operational monitoring.
- Replication lag grows when network or target performance is insufficient.
- Source and target message state can diverge during instability.
- Consumers must tolerate duplicate messages after failover.

## Prerequisites

- Source and target RabbitMQ clusters are created in separate failure domains.
- Network connectivity between the sites is stable.
- Target cluster storage is sized for full replicated backlog.
- Source and target exchanges, queues, and bindings are planned in advance.
- The shovel plugins are enabled on one side, preferably the target cluster.

## Enable Plugins

```yaml
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_shovel
      - rabbitmq_shovel_management
```

## Recommended Deployment Pattern

### Source Exchange to Target Exchange

Use this mode when the target cluster should preserve exchange semantics. Shovel creates an internal source-side queue and republishes messages to the target exchange.

When the source exchange is a `topic` exchange, routing key `#` can protect all routing keys for that exchange.

### Source Exchange to Target Queue

Use this mode only when the target side intentionally terminates into a specific queue. RabbitMQ uses the default exchange on the target side to route the message to that queue.

## Create Source and Target Objects

Before configuring the shovel:

1. Create the required exchanges on both clusters.
2. Create the target queues.
3. Create the target bindings.
4. Confirm that source routing keys and target routing rules are consistent.

The auto-generated `amq.*` internal queue used by Shovel does not need to be created manually.

## Configure the Shovel

In RabbitMQ Management, configure:

1. the source URI and source object
2. the destination URI and destination object
3. reconnect delay
4. acknowledgement mode

Recommended settings:

- `Reconnect delay`: a non-zero value such as `5`
- `Acknowledgement mode`: `on confirm`

## Deployment Verification

1. Confirm that the shovel status becomes `running`.
2. Confirm that the internal queue is created and bound correctly on the source side.
3. Publish test messages to the source exchange.
4. Confirm that target queues receive the expected messages.
5. Leave the test running long enough to observe backlog behavior under sustained publish load.

## Capacity Considerations

- The target cluster keeps replicated messages without normal consumer drain.
- Queue retention and message expiration should be planned explicitly.
- Bandwidth between the sites must exceed peak replication demand.
- Target cluster disk, CPU, and memory sizing should match the source workload profile.
