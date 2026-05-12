---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# Troubleshoot Redis Cluster Mode Connection Errors

## Introduction

Applications that connect to an Alauda Cache Service for Redis OSS instance running in **cluster mode** may fail with errors such as:

| Symptom | What it means |
|---|---|
| `ERR SELECT is not allowed in cluster mode` | The client is calling `SELECT n` (database switch). Cluster mode supports only DB `0`. |
| `MOVED <slot> <host>:6379` | The client connected to one shard but the requested key lives on a different shard. The current connection is not following cluster redirects. |
| `unable to connect` after seemingly correct configuration | Only one seed node is configured and that node is unreachable, **or** the client uses a non-cluster API. |

All three point to the same underlying cause: **a non-cluster (standalone or sentinel) client is being used to talk to a Redis Cluster.** This document focuses on diagnosing the symptom and switching the client to the cluster API. It does **not** cover how to write a cluster-aware client from scratch — for full client configuration examples, see the public docs:

- [How to Access Cluster Instance](https://docs.alauda.io/redis/5.0/how_to/access/20-cluster.html) (covers Jedis, Lettuce, Redisson, go-redis)

## Prerequisites

- An Alauda Cache Service for Redis OSS instance deployed in **cluster** mode.
- A client application that fails with one of the symptoms above.
- The list of cluster node endpoints from the instance's **Access Method** page.

## Diagnosis

### 1. Confirm the instance is in Cluster mode

In the platform UI, open the Redis instance detail page and verify the **Architecture** is `cluster` (not `sentinel` or `standalone`). If the instance is sentinel/standalone, the symptoms above are not the cause — investigate the actual error message instead.

### 2. Check the client library API in use

Inspect the client code or framework configuration:

| Symptom | Look for | Fix |
|---|---|---|
| `SELECT not allowed` | `SELECT 1`, `spring.redis.database: 1`, `Jedis#select(int)` | Remove DB-switch calls; cluster mode supports only DB `0`. |
| `MOVED ...` | `Jedis` (single node), `RedisClient` (Lettuce, single endpoint), `redis.client: standalone` | Switch to the cluster API: `JedisCluster`, `RedisClusterClient`, etc. |
| Single-host config | `spring.redis.host`, `redis.host` | Replace with a cluster-mode block that lists multiple seed nodes. |

### 3. Check the seed-node list

Cluster mode discovers topology by gossiping with the seed nodes you provide. If only one seed is configured and that pod is rescheduled or restarted, the client may fail at startup. **Always list at least three primary endpoints** so bootstrap survives a single-node outage.

## Resolution

1. Remove every `SELECT n` (or equivalent multi-DB option) from the application.
2. Switch the client to its **cluster API** — see the public docs linked above for the exact code per library.
3. Provide **all primary endpoints** (or at minimum three) as the seed node list.
4. Keep the password identical on every shard — all nodes in a cluster share the same password; use the platform-provisioned default user secret.
5. Restart the application and tail logs to confirm `MOVED` / `SELECT` errors are gone.

## Important Considerations

- **Standalone clients cannot be made to work with cluster mode** by adding more host entries — the cluster API must be used. There is no equivalent shim.
- **Pipelining across slots is not supported.** If your application pipelines multiple keys, group them into the same slot using hash tags (`{tag}`) — for example, `user:{42}:profile` and `user:{42}:sessions` both hash on `42`.
- **External access.** When the client runs outside the Kubernetes cluster, every shard's primary and replica must be reachable. Expose them via NodePort or LoadBalancer and use those addresses in the seed list.
- **Operator behavior:** the operator does not transform standalone connections into cluster connections. If a `MOVED` error appears, the responsibility is on the client side.
