---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Disaster Recovery Solution Before ACP 3.12

:::info Applicable Versions
Validated for ACP 3.8 era RabbitMQ deployments.
:::

## Introduction

Earlier RabbitMQ DR deployments also used the Shovel plugin, but the operating model was more manual. A primary cluster handled normal traffic while a standby cluster held copied data for failover.

## Supported Shovel Modes

Older deployments commonly described four source-destination combinations:

| Source | Destination | Notes |
| --- | --- | --- |
| Exchange | Exchange | Recommended for routing-preserving replication |
| Exchange | Queue | Publishes into the default exchange on the target side |
| Queue | Exchange | Reads directly from a source queue |
| Queue | Queue | Direct queue-to-queue replication |

The exchange-to-exchange model is still the safest default because it keeps routing behavior closer to the original design.

## Enable Plugins

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: rabbitmq-source
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_shovel
      - rabbitmq_shovel_management
```

## Important Parameters

### Common Parameters

- `Name`
- `Source`
- `Destination`
- `Reconnect delay`
- `Acknowledgement mode`

### Source-Side Parameters

- source URI
- source queue or exchange
- routing key when the source is an exchange
- prefetch count
- auto-delete policy

### Target-Side Parameters

- target URI
- target queue or exchange
- routing key when the target is an exchange
- forwarding headers

## Validation Approach

For each configured mode:

1. Create the expected exchanges and queues on both clusters.
2. Publish test messages that hit both matched and unmatched routing paths.
3. Verify that Shovel creates its internal queue when exchange-based source mode is used.
4. Confirm the exact messages visible in the target queue or target exchange bindings.

## Operational Notes

- Queue-based source replication consumes directly from the source queue and can interfere with normal consumers.
- The management UI in older versions is enough for configuration and state observation, but repeated manual validation is still required.
- This solution is appropriate only when the team can tolerate manual setup, manual verification, and manual failover.
