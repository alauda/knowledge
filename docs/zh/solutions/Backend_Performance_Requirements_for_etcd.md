---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500008
sourceSHA: 80cbc0ebf21caddd392290c4f87c823cf5ceb041841e13769bafcd9bd1459784
---

# etcd 后端性能要求

## 问题

由于存储或网络后端能力不足，etcd 性能下降，产生类似以下的日志消息：

```
etcdserver: failed to send out heartbeat on time (exceeded the 100ms timeout for xxx ms)
etcdserver: server is likely overloaded
etcdserver: read-only range request "key:\"xxxx\"" count_only:true with result "xxxx" took too long (xxx s) to execute
wal: sync duration of xxxx s, expected less than 1s
```

这些警告表明存储子系统或网络无法满足 etcd 的延迟要求。

## 根本原因

etcd 对存储和网络性能高度敏感。后端基础设施中的任何瓶颈——慢磁盘 I/O、高网络延迟、数据包丢失或 CPU 饱和——都会直接影响 etcd 集群处理写入和维持领导者心跳截止时间的能力。请求通常应在 50 毫秒内完成；持续超过 200 毫秒的时长会在日志中触发警告。

## 解决方案

### 确定瓶颈

etcd 变慢的三种常见原因：

1. **慢存储** — 磁盘 I/O 延迟超过可接受阈值
2. **CPU 过载** — 控制平面节点超负荷
3. **数据库大小增长** — etcd 数据文件已超出最佳大小

### 使用 fio 检查存储性能

在每个控制平面节点上运行 I/O 基准测试以验证磁盘性能：

```bash
fio --name=etcd-io-test --ioengine=sync --bs=4k --numjobs=1 --size=512M \
    --rw=write --iodepth=1 --fsync=1 --runtime=30 --time_based
```

99 百分位的 fdatasync 延迟必须低于 **10 毫秒**。

### 监控关键 etcd 指标

使用 Prometheus 跟踪以下指标：

| 指标                                                   | 阈值                  | 意义                    |
| ------------------------------------------------------ | --------------------- | ----------------------- |
| `etcd_disk_wal_fsync_duration_seconds_bucket` (p99)      | < 10 ms               | WAL 写入延迟            |
| `etcd_disk_backend_commit_duration_seconds_bucket` (p99) | < 25 ms               | 后端提交延迟            |
| `etcd_network_peer_round_trip_time_seconds_bucket` (p99) | < 50 ms               | 点对点网络 RTT         |
| `etcd_mvcc_db_total_size_in_bytes`                       | < 2 GB (默认配额)     | 数据库大小              |

### 网络健康

etcd 成员之间的高网络延迟或数据包丢失会使集群不稳定。监控网络 RTT，并调查控制平面网络接口上的任何持续数据包丢失。

### 数据库碎片整理

如果数据库大小接近配额，请执行手动碎片整理：

```bash
kubectl exec -n kube-system etcd-<node-name> -- etcdctl defrag \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

## 诊断步骤

检查 etcd 日志以获取延迟警告：

```bash
kubectl logs -n kube-system etcd-<node-name> --tail=100 | grep -E "took too long|heartbeat|overloaded"
```

通过 Prometheus 端点直接查询 etcd 指标。大多数发行版的 etcd 容器镜像不带 HTTP 客户端，因此在其中执行 `wget`/`curl` 并不可靠。使用 `kubectl port-forward` 转发到 pod，并从工作站查询：

```bash
# 终端 1: 将指标端口转发到本地端口。
kubectl port-forward -n kube-system pod/etcd-<node-name> 12381:2381

# 终端 2: 查询并过滤感兴趣的指标。
curl -s http://127.0.0.1:12381/metrics \
  | grep -E "^(etcd_disk_wal_fsync|etcd_disk_backend_commit|etcd_mvcc_db_total_size)"
```

如果集群有 Prometheus 抓取 etcd，则通过 PromQL 也可以获得相同的指标——通常是在生产环境中最干净的路径。
