---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500008
---

# Diagnosing etcd backend performance pressure from slow read-only range warnings

## Issue

On Alauda Container Platform (Kubernetes v1.34.5, etcd `registry.alauda.cn:60080/tkestack/etcd:v3.5.28-260325`), the etcd member runs as a static pod `etcd-<control-plane-IP>` in the `kube-system` namespace. The etcd binary is highly sensitive to the performance of its storage and network backend, and slow underlying I/O can disrupt its operation. When the backend cannot keep up, etcd v3.5.28 emits warnings of the form `apply request took too long ... read-only range` when a read-only range request exceeds the upstream-default `expected-duration` of `100ms`. Live members have been observed logging this message with measured durations such as `145.306106ms` against `expected-duration:"100ms"`.

## Root Cause

The warning is driven by backend latency rather than by the request itself: when disk or network I/O slows down, the time etcd spends applying a read-only range request grows past its expected threshold, and the member logs the slow range to surface the backend pressure. The same condition that produces these log lines also degrades cluster responsiveness, since every API read that touches etcd inherits the slowdown. The upstream etcd v3.5.28 binary emits four related warning families when its backend degrades further:

- `failed to send out heartbeat on time` — heartbeat send delayed past the heartbeat interval (etcd default 100ms, unchanged on this cluster — the etcd pod cmdline carries no `--heartbeat-interval` override).
- `server is likely overloaded` — companion line raised alongside the heartbeat warning when the raft loop cannot keep up.
- `wal: sync duration of X s, expected less than 1s` — the WAL fsync took longer than the upstream-defined 1-second expectation.
- `entries are taking too long to apply` — average apply duration ran past the upstream-defined ~200ms threshold over the recent sample window.

On this healthy cluster a 200-line tail of the etcd log captured 41 `apply request took too long` lines (the c4 family, which fires under normal apiserver list load with `took` modestly above the `100ms` expectation) and zero matches for the other four warning families above — those surface only on backend degradation, which we did not induce.

## Diagnostic Steps

Inspect the etcd member's log on the affected control-plane node to confirm the slow-range signal. A backend under pressure repeatedly logs the `apply request took too long` message with a `read-only range` prefix and a `took` value above the upstream `expected-duration:"100ms"`:

```bash
kubectl -n kube-system logs etcd-<control-plane-IP> | grep "apply request took too long"
```

```text
"caller":"etcdserver/util.go:170","msg":"apply request took too long","took":"145.306106ms","expected-duration":"100ms","prefix":"read-only range "
```

To quantify the backend, query etcd's own server-side disk percentiles from the cluster's unified Prometheus. The etcd member binds `--listen-metrics-urls=http://127.0.0.1:2381` (localhost only inside the pod netns), so the metric endpoint cannot be scraped directly through the apiserver pod-proxy; the monitoring stack collects these metrics through the `kube-prometheus-exporter-kube-etcd` ServiceMonitor (`https-metrics` endpoint on etcd port `2379`) and exposes them through the unified Prometheus CR `cpaas-system/kube-prometheus-0`, which selects PrometheusRules and metrics across all namespaces. The relevant histograms for disk and inter-member network health are:

```text
etcd_disk_backend_commit_duration_seconds_bucket
etcd_disk_wal_fsync_duration_seconds_bucket
etcd_network_peer_round_trip_time_seconds_bucket
```

Query the p99 of each histogram against the Prometheus API. For example, against a read-only port-forward to the `prometheus-kube-prometheus-0-0` pod's `:9090`:

```bash
kubectl -n cpaas-system port-forward pod/prometheus-kube-prometheus-0-0 19191:9090 &
curl -s --data-urlencode \
  'query=histogram_quantile(0.99, sum by (le) (rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])))' \
  http://localhost:19191/api/v1/query
```

## Resolution

Evaluate each percentile against the upstream etcd v3.5.28 performance targets to confirm the backend is fast enough. For storage, the p99 of `etcd_disk_backend_commit_duration_seconds_bucket` should stay below 25ms, and the p99 of `etcd_disk_wal_fsync_duration_seconds_bucket` should stay below 10ms. For the inter-member network, the p99 of `etcd_network_peer_round_trip_time_seconds_bucket` should stay below 50ms on a multi-member etcd.

On this healthy ACP cluster the disk percentiles, queried as above against `cpaas-system/kube-prometheus-0`, read:

- `etcd_disk_backend_commit_duration_seconds_bucket` p99 ≈ **12.4 ms** (`0.012365`), within the 25 ms target.
- `etcd_disk_wal_fsync_duration_seconds_bucket` p99 ≈ **7.4 ms** (`0.007391`), within the 10 ms target.
- `etcd_network_peer_round_trip_time_seconds_bucket` returned `ABSENT` (0 series). The metric exists in the etcd v3.5.28 schema but emits no series here because this cluster runs a single control-plane etcd member (`etcd_server_has_leader` returns exactly one instance, `192.168.135.152:2379`) and there are therefore no peers to measure RTT against. On a multi-member etcd the family emits le-bucketed series and the 50 ms target applies normally.

When a disk percentile exceeds its target, the corresponding backend is the bottleneck: high `backend_commit` or `wal_fsync` percentiles point at slow storage. On a multi-member etcd, a high `peer_round_trip_time` percentile points at the network between members. Relieving that bottleneck — faster disks for the storage families, lower-latency links for the peer family — removes the backend pressure that produces the slow read-only range warnings, the heartbeat-send-fail / server-overloaded warnings, the WAL sync warnings, and the entries-taking-too-long-to-apply warning.
