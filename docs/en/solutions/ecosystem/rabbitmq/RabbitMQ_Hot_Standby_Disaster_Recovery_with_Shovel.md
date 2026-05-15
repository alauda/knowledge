---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Hot Standby Disaster Recovery with Shovel

:::info Applicable Versions
ACP 3.14, 3.15, and 3.16.
:::

## Introduction

This solution builds two RabbitMQ clusters in different sites. The source cluster serves production traffic. The target cluster receives replicated messages and is used only after a failover decision.

Replication is implemented with RabbitMQ Shovel. Shovel acts as a client that reads messages from the source side and publishes them to the target side.

## Architecture

RabbitMQ routes messages through exchanges and queues. Shovel can consume from either side of that model and publish to either side of the target model. For hot standby, the practical choices are:

- source exchange to target exchange
- source exchange to target queue

The recommended mode is source exchange to target exchange. With a `topic` exchange and routing key `#`, one shovel can cover all matching traffic for that exchange.

## Limitations

- Shovel is not a full active-active replication engine.
- Replication is asynchronous, so some data loss is still possible during failure.
- The target cluster stores replicated messages without normal consumption, so storage must be sized for the retained backlog.
- Duplicate consumption can occur after failover because already consumed source messages may still exist on the target side.
- Client producer and consumer endpoints are not switched automatically.
- During unstable network conditions, Shovel can remove its auto-created internal queue and may lose in-flight data.

## Recommended Topology

| Item | Recommendation |
| --- | --- |
| Shovel location | Enable shovel plugins on one side only, usually the target cluster |
| Source mode | Exchange |
| Target mode | Exchange |
| Exchange type | `topic` when broad exchange-level protection is required |
| Routing key | `#` for full exchange coverage |

## Enable Shovel Plugins

Add the following plugins to the `RabbitmqCluster`:

```yaml
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_shovel
      - rabbitmq_shovel_management
```

## Key Shovel Parameters

| Parameter | Description |
| --- | --- |
| `Name` | Shovel name shown in the management UI |
| `Source` | Source protocol, URI, and exchange or queue settings |
| `Destination` | Target protocol, URI, and exchange or queue settings |
| `Reconnect delay` | Delay before reconnect after link failure |
| `Acknowledgement mode` | `no ack`, `on publish`, or `on confirm` |

Prefer `on confirm` when message durability matters more than throughput.

## Deployment Flow

1. Create the source and target clusters.
2. Enable shovel plugins on the chosen cluster.
3. Create the required exchanges, queues, and bindings on both sides.
4. Configure the shovel in RabbitMQ Management.
5. Verify that the auto-created internal queue appears on the source side.
6. Publish test data to the source exchange.
7. Confirm that the target queue receives the replicated messages.

## Monitoring

Shovel health can be judged from both shovel state and queue behavior:

- Shovel state should move from `starting` to `running`.
- The source-side internal queue usually appears as `amq.gen-*`.
- If queued messages keep growing, target-side delivery is too slow.
- If queued messages stay above zero without change, replication may be stalled.
- If consumer acknowledgement rate is much lower than publish rate, replication throughput is insufficient.

## Important Considerations

- Size target storage for full standby retention.
- Test failover with business clients before calling the solution ready.
- Build idempotency or duplicate-handling into consumers.
- Use this pattern for hot standby, not for multi-primary messaging.
