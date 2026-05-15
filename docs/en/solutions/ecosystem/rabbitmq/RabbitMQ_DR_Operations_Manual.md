---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Disaster Recovery Operations Manual

:::info Applicable Versions
ACP 3.14, 3.15, and 3.16.
:::

## Routine Monitoring

The DR solution should be monitored from both RabbitMQ Management and queue behavior.

Key checks:

- shovel state
- source-side `amq.gen-*` internal queue
- queued message growth
- consumer acknowledgement rate
- target cluster health and storage consumption

## Shovel States

| State | Meaning |
| --- | --- |
| `starting` | Shovel is trying to connect to one or both sides |
| `running` | Shovel is actively consuming and forwarding messages |

If the state does not reach `running`, check source URI, target URI, credentials, queue or exchange existence, and network connectivity.

## Queue-Based Health Checks

When exchange-to-exchange replication is used, Shovel creates an internal queue under the source exchange.

Use these signals:

- If total queued messages keep increasing, target-side replication is slower than source-side publishing.
- If queued messages stay above zero without movement, replication may be stalled.
- If consumer acknowledgement rate is much lower than publish rate, check target cluster performance and cross-site latency.

## Failover Procedure

1. Confirm that the source cluster is unavailable or no longer safe for writes.
2. Stop or redirect producers so the switch is controlled.
3. Point producers and consumers to the target cluster.
4. Validate exchange, queue, and consumer behavior on the target side.
5. Watch for duplicate consumption during the first recovery window.

## Switch-Back Principle

Do not automatically replicate traffic back to the original source cluster. After the source cluster is repaired, decide whether to rebuild it from scratch, resynchronize business state, or create a new DR direction.

## Shovel Management Commands

List shovel status on a specific node:

```bash
rabbitmqctl shovel_status -n rabbit@<pod>.<headless-service>.<namespace>
```

Restart a shovel:

```bash
rabbitmqctl -n rabbit@<pod>.<headless-service>.<namespace> restart_shovel <shovel-name>
```

Delete a shovel:

```bash
rabbitmqctl -n rabbit@<pod>.<headless-service>.<namespace> delete_shovel <shovel-name>
```

## Common Risks

- source-target latency spike
- target cluster storage exhaustion
- forgotten queue or binding changes that were never duplicated to the target side
- duplicate consumption after client failover

## Recommendations

- Run DR drills after operator upgrades or major queue topology changes.
- Keep an operations record of all shovel names, URIs, protected exchanges, and owning applications.
- Test application reconnection behavior before relying on the DR design in production.
