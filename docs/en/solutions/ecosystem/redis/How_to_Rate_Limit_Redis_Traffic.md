---
products:
  - Alauda Application Services
kind:
  - Solution
---

# How to Rate Limit Redis Traffic

## Introduction

This guide explains strategies for controlling Redis traffic to prevent excessive load that could compromise cluster stability. It covers the trade-offs of bandwidth-based rate limiting versus connection-based throttling, and provides practical recommendations for managing Redis traffic in production environments.

## Background

### What Causes Excessive Redis Traffic?

Excessive Redis traffic typically results from one or more of the following:

1. High request volume from applications
2. Storage and frequent access of BigKeys
3. Use of dangerous commands that return large amounts of data in a single call

### Why Direct Bandwidth Throttling Is Problematic

:::warning
Applying bandwidth limits directly to Redis pods can cause cascading failures.
:::

If you apply bandwidth limits to Redis, traffic spikes will saturate the available bandwidth, leading to:

- Client requests blocking on Redis operations. With API concurrency above 10,000, all 10,000 TCP connections (the default `maxclients`) compete for limited bandwidth, causing slow responses.
- Widespread TCP request timeouts, which propagate as upstream API timeouts.
- Disruption of Redis primary-replica replication and cluster heartbeat synchronization, increasing replication lag and undermining high availability.

For these reasons, **bandwidth-based rate limiting is not recommended**. Use connection-based limits and upstream API throttling instead.

## Considerations Before Throttling

In most production workloads, Redis itself rarely becomes the bottleneck:

- Sentinel mode can sustain ~500K QPS, and with read/write splitting, ~1M QPS.
- For higher throughput, use Cluster mode.

Before adding traffic controls at the Redis layer, evaluate:

- Whether the upstream API tier can sustain the traffic
- Whether the downstream databases can sustain the traffic
- Whether throttling should be applied at the gateway or API layer instead

When bandwidth is not the bottleneck, Redis responds promptly even under high concurrency. The presence of BigKeys, however, can disproportionately consume bandwidth. Limiting the maximum client connections is generally more effective than throttling bandwidth: when a burst of traffic exceeds the connection limit, clients receive an immediate error rather than queuing on a slow Redis.

## Procedure

### Method 1: Limit Maximum Client Connections (`maxclients`)

Set the `maxclients` parameter in your Redis instance configuration to control concurrency at the connection level.

- **Default value**: `10000`
- **Recommended adjustment**: Reduce to `5000` or lower based on your actual concurrency needs.

Update `maxclients` through the instance parameter configuration in your Redis management UI or through the YAML `customConfig` field:

```yaml
spec:
  customConfig:
    maxclients: "5000"
```

:::tip
Connection-based limiting is preferred over bandwidth limiting because excess clients fail fast with a clear error rather than experiencing slow timeouts.
:::

### Method 2: Apply Rate Limiting at the API or Gateway Layer

Implement throttling closer to the client to protect Redis:

1. **API gateway-based throttling**:
   - Use an API gateway such as Kgateway or Kong to apply rate limit rules per route, consumer, or API key.
2. **Application-level throttling**:
   - Implement rate limiting directly within your business APIs (for example, token bucket or leaky bucket algorithms).

### Method 3: Detect and Remediate BigKeys

BigKeys consume disproportionate bandwidth and CPU when accessed. Identify and remediate them:

1. Use the BigKey detection tooling provided by your Redis platform.
2. Refactor application logic to split BigKeys into smaller structures.
3. Avoid frequent full reads of large hashes, lists, or sets.

### Method 4: Reduce Use of Dangerous Commands

Certain commands return large datasets in a single call, occupying significant bandwidth and blocking Redis. Avoid or restrict the following:

- `KEYS`
- `HGETALL`
- `SMEMBERS`

Replace these with iterative alternatives where possible:

- Use `SCAN` instead of `KEYS`
- Use `HSCAN` instead of `HGETALL`
- Use `SSCAN` instead of `SMEMBERS`

You can also disable dangerous commands at the Redis instance level. See the related solution **How to Manage Dangerous Redis Commands**.

## Important Considerations

- Direct bandwidth throttling at the Pod level can cause widespread service degradation. Avoid this approach.
- Rate limiting is most effective when applied at multiple layers: gateway, API, and Redis connection limits.
- Monitor BigKeys regularly. A single BigKey accessed frequently can saturate Redis bandwidth even with a low connection count.
- When tuning `maxclients`, ensure the value still accommodates legitimate peak traffic; setting it too low can cause connection rejections during normal operation.
