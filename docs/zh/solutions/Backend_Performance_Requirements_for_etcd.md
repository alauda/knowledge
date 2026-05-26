---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500008
sourceSHA: 49de5652856f85037331f2f961c6f3c6f45d02b34d52aeb8755fad8f6a6329d9
---

# 诊断 etcd 后端性能压力导致的慢只读范围警告

## 问题

在 Alauda 容器平台 (Kubernetes v1.34.5, etcd `registry.alauda.cn:60080/tkestack/etcd:v3.5.28-260325`)，etcd 成员作为静态 Pod `etcd-<control-plane-IP>` 运行在 `kube-system` 命名空间中。etcd 二进制文件对其存储和网络后端的性能非常敏感，底层 I/O 的缓慢可能会干扰其操作 \[ev:c1]。当后端无法跟上时，etcd v3.5.28 会在只读范围请求超过上游默认的 `expected-duration` 的 `100ms` 时发出类似 `apply request took too long ... read-only range` 的警告 \[ev:c4]\[ev:c6]。观察到活跃成员记录了此消息，测量的持续时间如 `145.306106ms` 超过了 `expected-duration:"100ms"` \[ev:c4]。

## 根本原因

该警告是由后端延迟驱动的，而不是由请求本身引起的：当磁盘或网络 I/O 变慢时，etcd 在应用只读范围请求时所花费的时间超过了其预期阈值，成员记录慢范围以显示后端压力 \[ev:c1]\[ev:c4]。产生这些日志行的相同条件也会降低集群的响应能力，因为每个接触 etcd 的 API 读取都继承了这种减速 \[ev:c1]。上游 etcd v3.5.28 二进制文件在其后端进一步降级时会发出四个相关的警告系列：

- `failed to send out heartbeat on time` — 心跳发送延迟超过心跳间隔（etcd 默认 100ms，在此集群中未更改 — etcd Pod 命令行没有携带 `--heartbeat-interval` 重写） \[ev:c2]。
- `server is likely overloaded` — 与心跳警告同时出现的伴随行，当 raft 循环无法跟上时 \[ev:c3]。
- `wal: sync duration of X s, expected less than 1s` — WAL fsync 花费的时间超过了上游定义的 1 秒预期 \[ev:c5]。
- `entries are taking too long to apply` — 平均应用持续时间在最近的采样窗口中超过了上游定义的 \~200ms 阈值 \[ev:c7]。

在这个健康的集群中，etcd 日志的 200 行尾部捕获了 41 条 `apply request took too long` 行（c4 系列，在正常 apiserver 列表负载下触发，`took` 稍微超过 `100ms` 预期），并且没有匹配其他四个警告系列 — 这些仅在后端降级时出现，而我们并未诱发这种情况 \[ev:c2]\[ev:c3]\[ev:c5]\[ev:c7]。

## 诊断步骤

检查受影响的控制平面节点上的 etcd 成员日志以确认慢范围信号。一个受到压力的后端会重复记录 `apply request took too long` 消息，带有 `read-only range` 前缀和一个 `took` 值高于上游 `expected-duration:"100ms"` \[ev:c4]\[ev:c6]：

```bash
kubectl -n kube-system logs etcd-<control-plane-IP> | grep "apply request took too long"
```

```text
"caller":"etcdserver/util.go:170","msg":"apply request took too long","took":"145.306106ms","expected-duration":"100ms","prefix":"read-only range "
```

为了量化后端，从集群的统一 Prometheus 查询 etcd 自身的服务器端磁盘百分位。etcd 成员绑定 `--listen-metrics-urls=http://127.0.0.1:2381`（仅在 Pod 网络命名空间内的本地主机），因此无法通过 apiserver Pod 代理直接抓取指标；监控堆栈通过 `kube-prometheus-exporter-kube-etcd` ServiceMonitor 收集这些指标（etcd 端口 `2379` 上的 `https-metrics` 端点），并通过统一的 Prometheus CR `cpaas-system/kube-prometheus-0` 暴露这些指标，该 CR 选择所有命名空间的 PrometheusRules 和指标 \[ev:c8]\[ev:c9]\[ev:c10]。与磁盘和成员间网络健康相关的直方图为：

```text
etcd_disk_backend_commit_duration_seconds_bucket
etcd_disk_wal_fsync_duration_seconds_bucket
etcd_network_peer_round_trip_time_seconds_bucket
```

通过 Prometheus API 查询每个直方图的 p99。例如，通过对 `prometheus-kube-prometheus-0-0` Pod 的只读端口转发到 `:9090`：

```bash
kubectl -n cpaas-system port-forward pod/prometheus-kube-prometheus-0-0 19191:9090 &
curl -s --data-urlencode \
  'query=histogram_quantile(0.99, sum by (le) (rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])))' \
  http://localhost:19191/api/v1/query
```

## 解决方案

评估每个百分位与上游 etcd v3.5.28 性能目标，以确认后端是否足够快速。对于存储，`etcd_disk_backend_commit_duration_seconds_bucket` 的 p99 应保持在 25ms 以下，而 `etcd_disk_wal_fsync_duration_seconds_bucket` 的 p99 应保持在 10ms 以下 \[ev:c8]\[ev:c9]。对于成员间网络，`etcd_network_peer_round_trip_time_seconds_bucket` 的 p99 应在多成员 etcd 上保持在 50ms 以下 \[ev:c10]。

在这个健康的 ACP 集群中，按上述方式查询的磁盘百分位，读取如下：

- `etcd_disk_backend_commit_duration_seconds_bucket` p99 ≈ **12.4 ms** (`0.012365`)，在 25 ms 目标范围内 \[ev:c8]。
- `etcd_disk_wal_fsync_duration_seconds_bucket` p99 ≈ **7.4 ms** (`0.007391`)，在 10 ms 目标范围内 \[ev:c9]。
- `etcd_network_peer_round_trip_time_seconds_bucket` 返回 `ABSENT`（0 系列）。该指标在 etcd v3.5.28 架构中存在，但在这里没有发出系列，因为该集群运行的是单个控制平面 etcd 成员（`etcd_server_has_leader` 返回恰好一个实例，`192.168.135.152:2379`），因此没有对等体可以测量 RTT。在多成员 etcd 中，该系列会发出 le-bucketed 系列，50 ms 目标通常适用 \[ev:c10]。

当磁盘百分位超过其目标时，相应的后端就是瓶颈：高 `backend_commit` 或 `wal_fsync` 百分位指向慢速存储 \[ev:c8]\[ev:c9]。在多成员 etcd 中，高 `peer_round_trip_time` 百分位指向成员间的网络 \[ev:c10]。缓解该瓶颈 — 为存储系列提供更快的磁盘，为对等系列提供更低延迟的链接 — 消除了产生慢只读范围警告、心跳发送失败/服务器过载警告、WAL 同步警告以及条目应用过慢警告的后端压力 \[ev:c1]\[ev:c2]\[ev:c3]\[ev:c4]\[ev:c5]\[ev:c7]。
