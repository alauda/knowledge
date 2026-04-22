---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

etcd performance degrades due to insufficient storage or network backend capabilities, producing log messages similar to the following:

```
etcdserver: failed to send out heartbeat on time (exceeded the 100ms timeout for xxx ms)
etcdserver: server is likely overloaded
etcdserver: read-only range request "key:\"xxxx\"" count_only:true with result "xxxx" took too long (xxx s) to execute
wal: sync duration of xxxx s, expected less than 1s
```

These warnings indicate the storage subsystem or network cannot keep up with etcd's latency requirements.

## Root Cause

etcd is highly sensitive to storage and network performance. Any bottleneck in the backend infrastructure — slow disk I/O, high network latency, packet drops, or CPU saturation — directly impacts the ability of the etcd cluster to process writes and maintain leader-heartbeat deadlines. A request should normally complete in under 50 ms; durations exceeding 200 ms trigger warnings in the logs.

## Resolution

### Identify the Bottleneck

Three common causes of etcd slowness:

1. **Slow storage** — Disk I/O latency exceeds acceptable thresholds
2. **CPU overload** — Control-plane nodes are overcommitted
3. **Database size growth** — The etcd data file has grown beyond optimal size

### Check Storage Performance with fio

Run an I/O benchmark on each control-plane node to validate disk performance:

```bash
fio --name=etcd-io-test --ioengine=sync --bs=4k --numjobs=1 --size=512M \
    --rw=write --iodepth=1 --fsync=1 --runtime=30 --time_based
```

The 99th percentile fdatasync latency must be under **10 ms**.

### Monitor Key etcd Metrics

Use Prometheus to track the following metrics:

| Metric | Threshold | Meaning |
|---|---|---|
| `etcd_disk_wal_fsync_duration_seconds_bucket` (p99) | < 10 ms | WAL write latency |
| `etcd_disk_backend_commit_duration_seconds_bucket` (p99) | < 25 ms | Backend commit latency |
| `etcd_network_peer_round_trip_time_seconds_bucket` (p99) | < 50 ms | Peer-to-peer network RTT |
| `etcd_mvcc_db_total_size_in_bytes` | < 2 GB (default quota) | Database size |

### Network Health

High network latency or packet drops between etcd members destabilize the cluster. Monitor network RTT and investigate any persistent packet loss on the control-plane network interface.

### Database Defragmentation

If the database size approaches the quota, perform manual defragmentation:

```bash
kubectl exec -n kube-system etcd-<node-name> -- etcdctl defrag \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

## Diagnostic Steps

Check etcd logs for latency warnings:

```bash
kubectl logs -n kube-system etcd-<node-name> --tail=100 | grep -E "took too long|heartbeat|overloaded"
```

Query etcd metrics directly via the Prometheus endpoint. The etcd container image ships without an HTTP client on most distributions, so exec'ing `wget`/`curl` inside it is not reliable. Use `kubectl port-forward` against the pod and query from the workstation:

```bash
# Terminal 1: forward the metrics port to a local port.
kubectl port-forward -n kube-system pod/etcd-<node-name> 12381:2381

# Terminal 2: query and filter the metrics of interest.
curl -s http://127.0.0.1:12381/metrics \
  | grep -E "^(etcd_disk_wal_fsync|etcd_disk_backend_commit|etcd_mvcc_db_total_size)"
```

If the cluster has Prometheus scraping etcd, the same metrics are also available via PromQL — typically the cleanest path in a production environment.
