---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Migration from 3.8.x to 3.12.4

:::info Applicable Versions
Validated for ACP 3.14 and later environments that need to replace older 3.8.x RabbitMQ clusters.
:::

## Problem

Migrate data and metadata from RabbitMQ 3.8.x to RabbitMQ 3.12.4.

## Constraints

- Direct rolling upgrade across all intermediate versions is not handled by the operator workflow.
- The RabbitMQ upgrade path in upstream guidance requires intermediate major and minor versions.
- The safest production path is usually to create a new 3.12.4 cluster and switch applications to it.

## Recommended Option

If possible, let the old cluster drain completely and cut over to the new cluster without migrating messages.

## Option 1: Cut Over After Backlog Is Drained

### Suitable For

Queues can be fully consumed, or unconsumed messages do not need to be preserved.

### Steps

1. Create a new 3.12.x cluster with comparable sizing.
2. Enable the same required plugins.
3. Export definitions from the old cluster.
4. Import definitions into the new cluster.
5. Stop producers on the old cluster.
6. Wait until source queues are drained.
7. Update client connection settings and start using the new cluster.

## Option 2: Migrate Remaining Data with Shovel

### Suitable For

Some queues cannot be drained completely and their backlog must be preserved.

### Additional Preparation

Enable Shovel on the new cluster:

```yaml
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_shovel
      - rabbitmq_shovel_management
```

### Steps

1. Create the new 3.12.x cluster.
2. Import metadata from the old cluster.
3. Stop source-side producers where possible to reduce the number of queues that need migration.
4. Identify the queues that still contain required backlog.
5. Configure one shovel per queue.
6. Verify that messages arrive in the new cluster.
7. Remove the shovel after migration completes.
8. Switch clients to the new cluster.

### Example Shovel Command

```bash
rabbitmqctl set_parameter shovel <shovel-name> --vhost / \
  '{"src-protocol":"amqp091","src-uri":"amqp://<src-user>:<src-pass>@<src-host>:<src-port>/<vhost>","src-queue":"<src-queue>","dest-protocol":"amqp091","dest-uri":"amqp://<dest-user>:<dest-pass>@<dest-host>:<dest-port>/<vhost>","dest-queue":"<dest-queue>"}'
```

Check shovel state:

```bash
rabbitmqctl shovel_status --formatter=pretty_table
```

Remove the shovel after cutover:

```bash
rabbitmqctl clear_parameter shovel "<shovel-name>"
```

## Important Notes

- For the default vhost, do not keep a trailing `/<vhost>` value of `/` in the URI if your environment rejects it.
- Queue-by-queue shovel configuration is time-consuming. Reducing backlog first saves significant effort.
- Re-validate plugin compatibility on the new cluster before cutover.
