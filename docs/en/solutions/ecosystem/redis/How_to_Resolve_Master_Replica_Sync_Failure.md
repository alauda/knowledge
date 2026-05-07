---
products:
  - Alauda Application Services
kind:
  - Solution
---

# Resolve Master-Replica Sync Failure

:::info Applies to
Redis instances in **Sentinel mode** and **Cluster mode**.
:::

## Introduction

Redis replication relies on two buffers between the primary and the replica:

- **Replication backlog** (`repl-backlog-size`) - shared by all clients on the primary, default `1mb`. Used for partial resynchronization.
- **Client output buffer** (`client-output-buffer-limit`) - per-connection, including replica connections. The default `slave` setting is `256mb 64mb 60`: a hard cap of 256 MiB, a soft limit of 64 MiB sustained for 60 seconds before the connection is closed.

When either buffer overflows, the replica is disconnected and forced into a full resynchronization, which produces visible errors and replication lag.

:::note redis-operator >= 3.14
Starting from redis-operator **3.14**, `repl-backlog-size` is auto-calculated by the operator using the formula `maxmemory * 0.01`. On older versions you must size it manually.
:::

## Prerequisites

1. `kubectl` access to the namespace where the Redis instance runs.
2. Permission to update the Redis CR (or the underlying ConfigMap that holds the Redis configuration).
3. Awareness that changing `client-output-buffer-limit` on a running instance will reset open replica connections.

## Identifying the Symptom

### On the Replica

The replica logs report:

```text
I/O error reading bulk count from MASTER: Resource temporarily unavailable
```

### On the Primary

The primary logs report:

```text
... scheduled to be closed ASAP for overcoming of output buffer limits.
```

Either message indicates the replica's client output buffer on the primary has overflowed.

## Diagnosis: Why the Buffer Overflows

| Cause | How to recognize | Remediation |
|-------|------------------|-------------|
| Clients write too fast | Primary CPU sits at ~90% during normal load | Raising the buffer helps short-term, but increasing the instance size or adding shards is the durable fix. |
| Replica writes too slow | The replica log shows a long RDB load duration during full sync (e.g. 2 GB taking ~3 min). Full sync is bottlenecked by disk. | Switch to the `diskless` parameter template to reduce replica disk I/O. |
| Big keys | The primary's RDB persistence log shows persistence triggered by very few key updates (much less than ~20k); CPU is not saturated and writes are not heavy. A single large value can saturate the buffer instantly. | Increase the buffer; identify and split big keys in the application layer. |

## Procedure

### 1. (redis-operator < 3.14 only) Size the Replication Backlog

For older operators, set `repl-backlog-size` explicitly. Use roughly `maxmemory * 0.01`:

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  customConfig:
    repl-backlog-size: "100mb"   # Example for a 10 GiB instance
```

For redis-operator **>= 3.14**, this is computed automatically and does not need to be set.

### 2. Increase the Replica Client Output Buffer

The default for the `slave` class is `256mb 64mb 60`. Adjust the **slave portion only**, leaving `normal` and `pubsub` at their defaults. A reasonable first step is to double the limits:

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  customConfig:
    client-output-buffer-limit: "normal 0 0 0 slave 516mb 256mb 60 pubsub 33554432 8388608 60"
```

Apply the change and watch the primary's log. If the `out output buffer limit` errors persist, **double the slave hard and soft limits again** and observe.

### 3. Validate

Check `INFO replication` on the primary:

```bash
kubectl -n <namespace> exec -it <primary-pod> -- \
  redis-cli -a '<password>' info replication
```

A healthy replica entry shows `state=online` and `lag=0` (or single-digit seconds). Errors should no longer appear in the primary or replica logs.

## Important Considerations

### The Buffer Is Per-Connection

`client-output-buffer-limit slave` applies to **each** replica's connection independently. Memory budget on the primary scales with the number of replicas, so very large limits combined with many replicas can pressure the primary's memory.

### Big Keys Are the Real Fix

A single multi-megabyte value (a long list, hash, or set) can fill the buffer in one command. Raising the buffer only postpones the symptom. Use `redis-cli --bigkeys` or `MEMORY USAGE` to find offenders, then remodel the data (split the key, reduce element count) in the application.

### Diskless Replication for Slow Replicas

If the bottleneck is the replica's disk during full sync, switch the operator's parameter template to **diskless**. The primary streams the RDB directly into the replica's memory rather than writing to and reading from disk on both sides.

### Resync Is Disruptive

Whenever the buffer overflows, the next resync may be a full sync (instead of partial). Full syncs spike both primary and replica resource usage; size the buffer such that **partial** resync remains the norm during transient slowdowns.
