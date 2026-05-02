---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Configuring and Troubleshooting Prometheus remote_write Tuning Options
## Issue

The cluster monitoring stack lets operators forward time-series samples to an external long-term store via the `remoteWrite` block of the Prometheus ConfigMap or the equivalent `Prometheus` / `PrometheusOperator`-managed CR. Two frictions show up repeatedly:

- The set of tunables accepted under `remoteWrite.queueConfig` does not match the raw upstream Prometheus `remote_write` schema one-to-one. Fields that are documented on the upstream Prometheus site may be silently ignored or renamed when fed through the operator-managed ConfigMap.
- The ConfigMap is **not pre-validated** by the monitoring operator on write. A typo in a key name (for example wrong camelCase, a stale upstream field) is accepted by the API server but never applied to the Prometheus runtime, so the misconfiguration only surfaces as "my tuning has no effect".

## Root Cause

The monitoring operator translates its own `remoteWriteSpec` into the Prometheus runtime configuration. That spec is a curated subset of the upstream `remote_write` schema — extra keys and stray capitalisations are dropped during translation rather than rejected. The visible symptom is that the tunables appear in the ConfigMap but are absent from the live Prometheus runtime configuration returned by the Prometheus HTTP API.

## Resolution

1. **Use the operator-supported keys, not raw Prometheus keys.** Only fields under `remoteWriteSpec.queueConfig` that are documented as part of the ACP monitoring stack are honoured. Pay close attention to **capitalisation** — keys are camelCase (for example `maxShards`, `capacity`, `batchSendDeadline`), not snake_case as in the upstream Prometheus `remote_write` documentation.

2. **Shape the `remoteWrite` block under the monitoring ConfigMap.** A typical tuning-heavy entry looks like:

   ```yaml
   prometheusK8s:
     remoteWrite:
       - url: "https://receiver.example.com/api/v1/write"
         queueConfig:
           capacity: 10000
           maxShards: 50
           minShards: 1
           maxSamplesPerSend: 2000
           batchSendDeadline: 5s
           minBackoff: 30ms
           maxBackoff: 5s
         writeRelabelConfigs:
           - sourceLabels: [__name__]
             regex: "up|node_.*"
             action: keep
   ```

   Fields that exist in raw Prometheus but are not in the operator-exposed subset (for example some experimental fields) must not be added — they will be dropped, not errored.

3. **Force a reload and verify.** After updating the monitoring configuration, the operator reconciles and restarts or SIGHUPs the Prometheus pods. Always confirm that what landed in the running Prometheus matches the intent before assuming the tuning is in effect (see `Diagnostic Steps`).

4. **For sizing decisions** (how high to push `capacity`, `maxShards`, and `maxSamplesPerSend`), treat the upstream Prometheus "tuning remote write" guidance as the conceptual reference: the receiver's ingest rate and round-trip latency bound the useful shard count; `capacity` should absorb short network stalls; `batchSendDeadline` trades end-to-end latency for batch efficiency. The operator passes these through unchanged, so the tuning intuitions carry over.

## Diagnostic Steps

Confirm what Prometheus is **actually** running — not what the ConfigMap claims — by querying Prometheus' own runtime configuration endpoint from inside the pod:

```bash
kubectl -n <monitoring-namespace> exec prometheus-k8s-1 -c prometheus -- \
  curl -s http://localhost:9090/api/v1/status/config \
  | jq -r '.data.yaml' \
  | grep -A 40 '^remote_write:'
```

The returned YAML block is authoritative; if a `queueConfig` field is missing there, it did not survive the translation and the key is either misspelled or not in the operator-supported subset. Cross-check that block against the ConfigMap input and correct any key that was silently dropped.

If the runtime config looks right but samples are still not flowing, inspect the remote-write telemetry exposed by Prometheus itself — metrics such as `prometheus_remote_storage_samples_pending`, `prometheus_remote_storage_samples_failed_total`, and `prometheus_remote_storage_shards` reveal whether shards are saturated, whether the receiver is rejecting, and whether batches are stuck in the queue. Those are the right signals for deciding whether to raise `maxShards` or `capacity` versus investigating the receiver.
