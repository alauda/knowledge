---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ CPU Imbalance Across Multiple Instances

## Problem

In performance tests with multiple large RabbitMQ instances on the same node, CPU and memory were not exhausted, but throughput still plateaued early and instances interfered with each other.

## Cause

In containerized environments, RabbitMQ and Erlang scheduler behavior can bind work unevenly across CPU cores. With the default RabbitMQ scheduler bind type, some cores are used heavily while others remain underused. When several RabbitMQ instances share a node, this can create unnecessary CPU contention and lower throughput.

## Erlang Scheduler Bind Types

| Value | Meaning |
| --- | --- |
| `u` | Unbound. The operating system decides scheduler placement. |
| `ns` | No spread. Keep schedulers close together. |
| `ts` | Thread spread. Spread across hardware threads. |
| `ps` | Processor spread. Spread across processor packages. |
| `s` | Spread as much as possible. |
| `db` | Default bind behavior. |

## Recommendation

Set the scheduler bind type to `u` so the operating system can distribute RabbitMQ scheduler threads more evenly.

## Configuration

Add the following under `spec.rabbitmq.envConfig`:

```yaml
spec:
  rabbitmq:
    envConfig: |
      RABBITMQ_SCHEDULER_BIND_TYPE="u"
```

## Expected Result

After the change:

- CPU allocation is usually more balanced across cores
- throughput improves when multiple RabbitMQ instances share the same node
- the workload can approach the true network or storage limit instead of an artificial CPU scheduling bottleneck

## Notes

- Re-run performance tests after the change.
- Combine this fix with proper node placement and anti-affinity if several large clusters share the same hardware.
