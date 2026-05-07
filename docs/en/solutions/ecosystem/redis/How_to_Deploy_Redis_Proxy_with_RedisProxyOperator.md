---
products:
  - Alauda Application Services
kind:
  - Solution
---

# Deploy a Redis Proxy with RedisProxyOperator

:::info Applicable Versions
This guide applies to Alauda Cache Service for Redis OSS **3.18 and later**. The previous in-tree Predixy proxy (which only supported Cluster mode) was deprecated in 3.18 and replaced by the standalone `redis-proxy-operator`.
:::

## Introduction

Some applications cannot adopt the standard Redis Sentinel or Cluster client libraries and instead expect to talk to Redis through a single endpoint. Typical cases include:

- Legacy applications written for a single Redis instance.
- Legacy applications written for a primary/replica pair.
- Applications that previously used a third-party Redis proxy (front end), with a primary/replica, Sentinel, or Cluster topology behind it.

To support these workloads, Alauda provides `redis-proxy-operator`, a standalone operator that deploys a Predixy-based proxy in front of an existing Redis instance. Predixy was selected after a community Redis proxy review based on functionality and adoption; known issues have been patched in this distribution.

The new operator supports:

1. **Sentinel-mode proxy**
2. **Cluster-mode proxy**
3. **Form-based proxy deployment** from the platform UI

## Prerequisites

- An ACP cluster with the standard application services platform installed.
- An Alauda Cache Service for Redis OSS instance (Sentinel or Cluster mode) already deployed and in `Ready` state.
- The `redis-proxy-operator` Violet package downloaded from Alauda Cloud and uploaded to the target business cluster.
- A Redis password Secret in the same namespace as the Redis instance, containing a `password` field that matches the Redis instance password.

### Compatible Versions

| Compatible Platform Version | redis-proxy-operator Image |
| --- | --- |
| >= 3.18 | `build-harbor.alauda.cn/middleware/redis-proxy-operator-bundle:v3.18.1` |

## Procedure

### 1. Disable the Old In-Tree Proxy

Before deploying the new standalone proxy, disable the in-tree proxy on any cluster-mode Redis instance.

:::warning Migration Notes
- The Service created by the legacy `redisProxy` was not exposed via NodePort by default. If a NodePort was added manually, **record the allocated port** before deletion so you can reuse it on the new instance for a transparent cutover.
- The legacy operator gave the proxy CR the same name as the Redis instance. To preserve the same external access name, give the new Proxy CR the same name as the Redis instance.
:::

#### On 3.18.x

Edit the Redis instance YAML and set:

```yaml
spec:
  redisProxy:
    enable: false
```

Save to apply.

#### On Versions Earlier Than 3.18

In the instance update page, expand **Advanced Configuration** and turn off the **Standalone Mode** switch, then save.

### 2. Upload the Operator Package with Violet

Use the `violet` CLI to push the operator bundle to the platform's app store:

```bash
violet push \
  --platform-address <ACP-address> \
  --clusters <cluster-name> \
  --platform-username <username> \
  --platform-password '<password>' \
  <path-to-redis-proxy-operator-bundle.tgz>

# Example
violet push \
  --platform-address https://192.168.129.215 \
  --clusters business-1 \
  --platform-username admin \
  --platform-password 'abc123' \
  ./redis-proxy-operator-3.18.1-acp3.18-20250214.tgz
```

### 3. Deploy the Operator

1. Navigate to **Administrator** > **Marketplace** > **OperatorHub**.
2. Locate **RedisProxyOperator** and click **Deploy**.
3. The default deployment configuration is sufficient for most cases. The operator pod requests `500m` CPU and `500Mi` memory by default.

### 4. Create a Proxy Instance

1. Go to **Administrator** > **Marketplace** > **Deployed Operators** and open **redis-proxy-operator**.
2. Open the **Resource Instances** tab and click **Create Instance**.
3. In the dialog, click **Create Instance** under **Proxy**.
4. Fill in the proxy parameters. Pay attention to the following:
   - **Name** — If you are migrating from the legacy proxy, set this to the **Redis instance name** so client applications can switch over without code changes.
   - **Namespace** — Must match the namespace of the target Redis instance.
   - **NodePort** — If the legacy proxy used a fixed NodePort, set the same port here for a seamless cutover.
   - **Password Secret** — Select a Secret that contains a `password` field matching the Redis instance password.

:::warning Password Secret Format
The referenced Secret **must** contain a `password` key. The proxy will fail to start if the field is missing or does not match the Redis instance password.
:::

### 5. Connect to the Proxy

After the Proxy is deployed, the operator generates a Service named `<proxy-cr-name>-proxy`. For example, a Proxy named `redis-cluster-proxy` produces a Service named `redis-cluster-proxy-proxy`.

For NodePort access, connect using any cluster node IP and the allocated NodePort. You can view the Service details in the container platform UI.

:::warning ALB Not Recommended
Do not place an ALB in front of the proxy. Predixy itself adds 20–30% overhead; layering ALB on top brings total overhead to 50% or more.
:::

## Supported Commands

The proxy currently supports a subset of Redis 7.2 commands. The table below lists supported and unsupported commands by command group.

| Group | Supported | Unsupported |
| --- | --- | --- |
| Connection Management | `auth` (proxy), `ping` (proxy), `echo` (proxy), `quit` (proxy), `select` | `client`, `hello`, `reset` |
| Generic | `copy`, `del`, `dump`, `exists`, `expire`, `expireat`, `expiretime`, `move`, `persist`, `pexpire`, `pexpireat`, `pexpiretime`, `pttl`, `randomkey`, `rename`, `renamenx`, `restore`, `scan`, `sort`, `sort_ro`, `touch`, `ttl`, `type`, `unlink` | `keys`, `migrate`, `object`, `wait`, `waitof` |
| Bitmap | `bitcount`, `bitfield`, `bitfield_ro`, `bitop`, `bitops`, `getbit`, `setbit` |  |
| String | `append`, `decr`, `decrby`, `get`, `getdel`, `getex`, `getrange`, `getset`, `incr`, `incrby`, `incrbyfloat`, `lcs`, `mget`, `mset`, `msetnx`, `psetex`, `set`, `setex`, `setnx`, `setrange`, `strlen` | `substr` |
| List | `blpop`, `brpop`, `brpoplpush`, `lindex`, `linsert`, `llen`, `lmove`, `lmpop`, `lpop`, `lpos`, `lpush`, `lpushx`, `lrange`, `lrem`, `lset`, `ltrim`, `rpop`, `rpoplpush`, `rpush`, `rpushx` | `blmove`, `blmpop` |
| Set | `sadd`, `scard`, `sdiff`, `sdiffstore`, `sinter`, `sintercard`, `sinterstore`, `sismember`, `smembers`, `smismember`, `smove`, `spop`, `srandmember`, `srem`, `sscan`, `sunion`, `sunionstore` |  |
| Sorted Set | `zadd`, `zcard`, `zcount`, `zdiff`, `zdiffstore`, `zincrby`, `zinter`, `zintercard`, `zinterstore`, `zlexcount`, `zmpop`, `zmscore`, `zpopmax`, `zpopmin`, `zrandmember`, `zrange`, `zrangebylex`, `zrangebyscore`, `zrangestore`, `zrank`, `zrem`, `zremrangebylex`, `zremrangebyrank`, `zremrangebyscore`, `zrevrange`, `zrevrangebylex`, `zrevrangebyscore`, `zrevrank`, `zscan`, `zscore`, `zunion`, `zunionstore` | `bzmpop`, `bzpopmax`, `bzpopmin` |
| Hash | `hdel`, `hexists`, `hexpire`, `hexpireat`, `hexpiretime`, `hget`, `hgetall`, `hincrby`, `hincrbyfloat`, `hkeys`, `hlen`, `hmget`, `hmset`, `hscan`, `hset`, `hsetnx`, `hstrlen`, `hvals` |  |
| Geospatial | `geoadd`, `geodist`, `geohash`, `geopos`, `georadius`, `georadius_ro`, `georadiusbymember`, `georadiusbymember_ro`, `geosearch`, `geosearchstore` |  |
| HyperLogLog | `pfadd`, `pfcount`, `pfmerge` | `pfdebug`, `pfselftest` |
| Scripting | `eval`, `eval_ro`, `evalsha`, `evalsha_ro`, `script load` | `script kill`, `script flush`, `script exists`, `script debug` |
| Pub/Sub | `psubscribe`, `publish`, `pubsub`, `punsubscribe`, `subscribe`, `unsubscribe` | `spublish`, `ssubscribe`, `sunsubscribe` |
| Stream |  | `xacl`, `xadd`, `xautoclaim`, `xclaim`, `xdel`, `xgroup`, `xinfo`, `xlen`, `xpending`, `xrange`, `xread`, `xreadgroup`, `xrevrange`, `xsetid`, `xtrim` |
| Transaction (not supported in Cluster mode) | `discard`, `exec`, `multi`, `unwatch`, `watch` |  |
| Server Management | `command` (proxy), `config` (proxy), `info` (proxy) | `acl`, `bgrewrite`, `bgsave`, `command`, `config`, `dbsize`, `failover`, `flushall`, `flushdb`, `info`, `lastsave`, `latency`, `lolwut`, `memory`, `module`, `monitor`, `psync`, `replconf`, `replicaof`, `role`, `save`, `shutdown`, `slaveof`, `slowlog`, `swapdb`, `sync`, `time` |

## Important Considerations

- **Performance overhead** — The proxy itself adds roughly 20–30% latency overhead compared with direct Redis access. Plan capacity accordingly.
- **Transactions in Cluster mode** — `MULTI`/`EXEC` and friends are **not** supported when the proxy fronts a Cluster instance.
- **Streams** — None of the `X*` stream commands are supported by the proxy.
- **Service naming** — The proxy Service is always `<proxy-cr-name>-proxy`. Keep the Proxy CR name aligned with the legacy proxy or Redis instance name to enable transparent client cutover.
- **Password Secret** — The Secret referenced by the Proxy CR must contain a `password` key whose value matches the Redis instance password.
