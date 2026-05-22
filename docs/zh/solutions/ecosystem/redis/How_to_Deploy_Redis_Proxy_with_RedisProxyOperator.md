---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260500087
sourceSHA: 2fce38509ad8462246b482dc0a7e49b5e3864f2f651be5e624c49d33988ed851
---

# 使用 RedisProxyOperator 部署 Redis 代理

:::info 适用版本
本指南适用于 Alauda Cache Service for Redis OSS **3.18 及更高版本**。之前的内置 Predixy 代理（仅支持集群模式）在 3.18 中被弃用，并由独立的 `redis-proxy-operator` 替代。
:::

## 介绍

某些应用程序无法采用标准的 Redis Sentinel 或集群客户端库，而是期望通过单一端点与 Redis 通信。典型情况包括：

- 为单个 Redis 实例编写的遗留应用程序。
- 为主/从对编写的遗留应用程序。
- 之前使用第三方 Redis 代理（前端）的应用程序，后面有主/从、哨兵或集群拓扑。

为了支持这些工作负载，Alauda 提供了 `redis-proxy-operator`，这是一个独立的操作员，在现有 Redis 实例前部署基于 Predixy 的代理。Predixy 是在社区 Redis 代理评审中根据功能和采用情况选择的；已知问题在此发行版中已被修复。

新的操作员支持：

1. **哨兵模式代理**
2. **集群模式代理**
3. **基于表单的代理部署**，通过平台 UI

## 先决条件

- 已安装标准应用服务平台的 ACP 集群。
- 已部署并处于 `Ready` 状态的 Alauda Cache Service for Redis OSS 实例（哨兵或集群模式）。
- 从 Alauda Cloud 下载的 `redis-proxy-operator` Violet 包，并上传到目标业务集群。
- 与 Redis 实例位于同一命名空间的 Redis 密码 Secret，包含与 Redis 实例密码匹配的 `password` 字段。

### 兼容版本

| 兼容平台版本 | redis-proxy-operator 镜像                                              |
| ------------ | ----------------------------------------------------------------------- |
| >= 3.18      | `build-harbor.alauda.cn/middleware/redis-proxy-operator-bundle:v3.18.1` |

## 操作步骤

### 1. 禁用旧的内置代理

在部署新的独立代理之前，禁用任何集群模式 Redis 实例上的内置代理。

:::warning 迁移说明

- 由遗留 `redisProxy` 创建的服务默认未通过 NodePort 暴露。如果手动添加了 NodePort，请在删除之前**记录分配的端口**，以便在新实例上重用，实现透明切换。
- 遗留操作员将代理 CR 命名为与 Redis 实例相同的名称。为了保留相同的外部访问名称，请将新的 Proxy CR 命名为与 Redis 实例相同的名称。
:::

#### 在 3.18.x 上

编辑 Redis 实例 YAML 并设置：

```yaml
spec:
  redisProxy:
    enable: false
```

保存以应用更改。

#### 在早于 3.18 的版本上

在实例更新页面，展开 **高级配置**，关闭 **独立模式** 开关，然后保存。

### 2. 使用 Violet 上传操作员包

使用 `violet` CLI 将操作员包推送到平台的应用商店：

```bash
violet push \
  --platform-address <ACP-address> \
  --clusters <cluster-name> \
  --platform-username <username> \
  --platform-password '<password>' \
  <path-to-redis-proxy-operator-bundle.tgz>

# 示例
violet push \
  --platform-address https://192.168.129.215 \
  --clusters business-1 \
  --platform-username admin \
  --platform-password 'abc123' \
  ./redis-proxy-operator-3.18.1-acp3.18-20250214.tgz
```

### 3. 部署操作员

1. 导航到 **管理员** > **市场** > **OperatorHub**。
2. 找到 **RedisProxyOperator** 并点击 **部署**。
3. 默认的部署配置对于大多数情况是足够的。操作员 Pod 默认请求 `500m` CPU 和 `500Mi` 内存。

### 4. 创建代理实例

1. 转到 **管理员** > **市场** > **已部署的操作员**，打开 **redis-proxy-operator**。
2. 打开 **资源实例** 选项卡，点击 **创建实例**。
3. 在对话框中，点击 **代理** 下的 **创建实例**。
4. 填写代理参数。注意以下几点：
   - **名称** — 如果您正在从遗留代理迁移，请将其设置为 **Redis 实例名称**，以便客户端应用程序可以无代码更改地切换。
   - **命名空间** — 必须与目标 Redis 实例的命名空间匹配。
   - **NodePort** — 如果遗留代理使用了固定的 NodePort，请在此处设置相同的端口，以实现无缝切换。
   - **密码 Secret** — 选择一个包含与 Redis 实例密码匹配的 `password` 字段的 Secret。

:::warning 密码 Secret 格式
引用的 Secret **必须** 包含 `password` 键。如果缺少该字段或与 Redis 实例密码不匹配，代理将无法启动。
:::

### 5. 连接到代理

代理部署后，操作员会生成一个名为 `<proxy-cr-name>-proxy` 的服务。例如，名为 `redis-cluster-proxy` 的代理会生成一个名为 `redis-cluster-proxy-proxy` 的服务。

要进行 NodePort 访问，请使用任何集群节点 IP 和分配的 NodePort 进行连接。您可以在容器平台 UI 中查看服务详细信息。

:::warning 不推荐使用 ALB
请勿在代理前放置 ALB。Predixy 本身增加了 20–30% 的开销；在其上叠加 ALB 会使总开销达到 50% 或更多。
:::

## 支持的命令

代理当前支持 Redis 7.2 命令的子集。下表列出了按命令组分类的支持和不支持的命令。

| 组别                                       | 支持的                                                                                                                                                                                                                                                                                                                                                                                                              | 不支持的                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 连接管理                                   | `auth` (proxy), `ping` (proxy), `echo` (proxy), `quit` (proxy), `select`                                                                                                                                                                                                                                                                                                                                               | `client`, `hello`, `reset`                                                                                                                                                                                                                                                           |
| 通用                                       | `copy`, `del`, `dump`, `exists`, `expire`, `expireat`, `expiretime`, `move`, `persist`, `pexpire`, `pexpireat`, `pexpiretime`, `pttl`, `randomkey`, `rename`, `renamenx`, `restore`, `scan`, `sort`, `sort_ro`, `touch`, `ttl`, `type`, `unlink`                                                                                                                                                                       | `keys`, `migrate`, `object`, `wait`, `waitof`                                                                                                                                                                                                                                        |
| 位图                                       | `bitcount`, `bitfield`, `bitfield_ro`, `bitop`, `bitops`, `getbit`, `setbit`                                                                                                                                                                                                                                                                                                                                           |                                                                                                                                                                                                                                                                                      |
| 字符串                                     | `append`, `decr`, `decrby`, `get`, `getdel`, `getex`, `getrange`, `getset`, `incr`, `incrby`, `incrbyfloat`, `lcs`, `mget`, `mset`, `msetnx`, `psetex`, `set`, `setex`, `setnx`, `setrange`, `strlen`                                                                                                                                                                                                                  | `substr`                                                                                                                                                                                                                                                                             |
| 列表                                       | `blpop`, `brpop`, `brpoplpush`, `lindex`, `linsert`, `llen`, `lmove`, `lmpop`, `lpop`, `lpos`, `lpush`, `lpushx`, `lrange`, `lrem`, `lset`, `ltrim`, `rpop`, `rpoplpush`, `rpush`, `rpushx`                                                                                                                                                                                                                            | `blmove`, `blmpop`                                                                                                                                                                                                                                                                   |
| 集合                                       | `sadd`, `scard`, `sdiff`, `sdiffstore`, `sinter`, `sintercard`, `sinterstore`, `sismember`, `smembers`, `smismember`, `smove`, `spop`, `srandmember`, `srem`, `sscan`, `sunion`, `sunionstore`                                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                      |
| 有序集合                                   | `zadd`, `zcard`, `zcount`, `zdiff`, `zdiffstore`, `zincrby`, `zinter`, `zintercard`, `zinterstore`, `zlexcount`, `zmpop`, `zmscore`, `zpopmax`, `zpopmin`, `zrandmember`, `zrange`, `zrangebylex`, `zrangebyscore`, `zrangestore`, `zrank`, `zrem`, `zremrangebylex`, `zremrangebyrank`, `zremrangebyscore`, `zrevrange`, `zrevrangebylex`, `zrevrangebyscore`, `zrevrank`, `zscan`, `zscore`, `zunion`, `zunionstore` | `bzmpop`, `bzpopmax`, `bzpopmin`                                                                                                                                                                                                                                                     |
| 哈希                                       | `hdel`, `hexists`, `hexpire`, `hexpireat`, `hexpiretime`, `hget`, `hgetall`, `hincrby`, `hincrbyfloat`, `hkeys`, `hlen`, `hmget`, `hmset`, `hscan`, `hset`, `hsetnx`, `hstrlen`, `hvals`                                                                                                                                                                                                                               |                                                                                                                                                                                                                                                                                      |
| 地理空间                                   | `geoadd`, `geodist`, `geohash`, `geopos`, `georadius`, `georadius_ro`, `georadiusbymember`, `georadiusbymember_ro`, `geosearch`, `geosearchstore`                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| HyperLogLog                                 | `pfadd`, `pfcount`, `pfmerge`                                                                                                                                                                                                                                                                                                                                                                                          | `pfdebug`, `pfselftest`                                                                                                                                                                                                                                                              |
| 脚本                                       | `eval`, `eval_ro`, `evalsha`, `evalsha_ro`, `script load`                                                                                                                                                                                                                                                                                                                                                              | `script kill`, `script flush`, `script exists`, `script debug`                                                                                                                                                                                                                       |
| 发布/订阅                                   | `psubscribe`, `publish`, `pubsub`, `punsubscribe`, `subscribe`, `unsubscribe`                                                                                                                                                                                                                                                                                                                                          | `spublish`, `ssubscribe`, `sunsubscribe`                                                                                                                                                                                                                                             |
| 流                                         |                                                                                                                                                                                                                                                                                                                                                                                                                        | `xacl`, `xadd`, `xautoclaim`, `xclaim`, `xdel`, `xgroup`, `xinfo`, `xlen`, `xpending`, `xrange`, `xread`, `xreadgroup`, `xrevrange`, `xsetid`, `xtrim`                                                                                                                               |
| 事务（在集群模式下不支持）                 | `discard`, `exec`, `multi`, `unwatch`, `watch`                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                      |
| 服务器管理                                 | `command` (proxy), `config` (proxy), `info` (proxy)                                                                                                                                                                                                                                                                                                                                                                    | `acl`, `bgrewrite`, `bgsave`, `command`, `config`, `dbsize`, `failover`, `flushall`, `flushdb`, `info`, `lastsave`, `latency`, `lolwut`, `memory`, `module`, `monitor`, `psync`, `replconf`, `replicaof`, `role`, `save`, `shutdown`, `slaveof`, `slowlog`, `swapdb`, `sync`, `time` |

## 重要注意事项

- **性能开销** — 代理本身与直接访问 Redis 相比大约增加 20–30% 的延迟开销。请相应地规划容量。
- **集群模式下的事务** — 当代理位于集群实例前时，`MULTI`/`EXEC` 等命令**不**受支持。
- **流** — 代理不支持任何 `X*` 流命令。
- **服务命名** — 代理服务始终为 `<proxy-cr-name>-proxy`。保持 Proxy CR 名称与遗留代理或 Redis 实例名称一致，以实现透明的客户端切换。
- **密码 Secret** — Proxy CR 引用的 Secret 必须包含一个 `password` 键，其值与 Redis 实例密码匹配。
