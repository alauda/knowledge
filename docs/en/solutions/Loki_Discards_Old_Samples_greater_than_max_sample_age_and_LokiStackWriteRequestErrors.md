---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `LokiStackWriteRequestErrors` alert fires, and the gateway in front of Loki is returning HTTP 5xx for a double-digit percentage of write requests. Collector pods (Vector in most ACP setups) log repeated retries of the form:

```text
WARN sink{...component_type=loki}: vector::sinks::util::retries:
  Retrying after error. error=Server responded with an error: 500 Internal Server Error
```

In the Loki distributor, errors name a specific rejection reason:

```text
level=error component=distributor path=write
  msg="write operation failed"
  details="entry for stream '{...}' has timestamp too old:
           2026-02-28T19:19:04Z,
           oldest acceptable timestamp is: 2026-03-01T08:26:38Z"
  org_id=infrastructure
```

Exporting `loki_discarded_samples_total` and plotting discards by reason confirms the picture:

```text
sum by (tenant, reason) (irate(loki_discarded_samples_total[2m]))
```

One reason dominates: `greater_than_max_sample_age`.

## Root Cause

Loki's distributor rejects any log entry whose timestamp falls outside a write window measured from "now". Two limits govern that window:

- `reject_old_samples: true` — enable rejection of samples older than the configured age.
- `reject_old_samples_max_age: 168h` — reject anything older than seven days.

The ACP Logging Service ships with both of these set to the defaults above, and the values are not exposed as tenant-tunable knobs in the standard LokiStack surface. Any log line that carries a timestamp older than seven days at the moment the distributor accepts it is discarded, the distributor returns an error to the gateway, and the gateway's 500s then surface on the collector side as retry loops.

Two operational conditions routinely push sample timestamps past the seven-day line:

1. **First-time ingestion of a pre-existing log volume.** When the collector starts on a node that has accumulated several weeks of container or journal logs, it begins at the oldest available offset. Entries whose timestamp is older than seven days are rejected on the way in; only lines from the most recent seven days land in the store.
2. **Backlog after a long outage.** If either the collectors or the log store were unavailable long enough that the queue accumulates more than `168h` of buffered entries, the tail of that queue is older than the acceptance window by the time flow is restored. The distributor rejects those old entries and the `LokiStackWriteRequestErrors` alert fires until the queue has drained past the seven-day boundary.

In both cases, once the collector catches up to entries whose timestamps fall within the seven-day window, the error rate returns to baseline on its own.

## Resolution

There is nothing to reconfigure and no bug to work around. The seven-day cut-off is Loki's designed-in protection against unbounded retention growth from late-arriving writes, and the `reject_old_samples*` knobs are deliberately not exposed per-tenant in the supported LokiStack CRD surface.

### Preferred: let the alert self-clear

In the ACP Logging Service, the operator path is to recognise the condition from the distributor's error message (`has timestamp too old`) and the discard reason (`greater_than_max_sample_age`), confirm that the timestamps being rejected are indeed older than seven days relative to wall-clock now, and then wait. Once the collector front-end advances past the old tail of its queue, the distributor stops rejecting, and both the alert and the gateway 5xx spike clear without human intervention.

If the operational concern is "I do not want to lose the older data", the answer has to be solved upstream of Loki — keep the source logs archived elsewhere, or shorten the recovery window so the backlog never grows past seven days.

### Fallback: raw Loki (self-managed, outside the Logging Service)

If Loki has been deployed directly (for example, a self-managed Loki running alongside ACP rather than through the Logging Service's LokiStack surface), the two limits are available as top-level `limits_config` fields in the Loki configuration:

```yaml
limits_config:
  reject_old_samples: true
  reject_old_samples_max_age: 168h
```

They can be raised on a self-managed Loki, but two warnings apply:

- **Retention interacts.** A larger acceptance window means the chunk range extends further into the past; plan `retention_period` and storage headroom accordingly.
- **The Logging Service path does not honour changes here.** Edits to the raw Loki config on a LokiStack-managed Loki will be reverted by the operator at the next reconcile; the supported path is to accept the seven-day window and treat this as expected behaviour.

## Diagnostic Steps

Confirm the rejection is happening and identify which tenant is affected:

```bash
# Replace the namespace with the one where Loki runs in this cluster.
LOKI_NS=cpaas-logging

# Distributor logs: count and sample the "timestamp too old" errors.
POD=$(kubectl -n "$LOKI_NS" get pod \
        -l app.kubernetes.io/component=distributor \
        -o jsonpath='{.items[0].metadata.name}')

kubectl -n "$LOKI_NS" logs "$POD" | grep -c "has timestamp too old"
kubectl -n "$LOKI_NS" logs "$POD" | grep "has timestamp too old" | tail -1
```

The sampled error line includes the timestamp of the rejected entry and the oldest-acceptable cut-off. The distance between the two is the backlog the collectors still have to burn down.

Quantify the discard rate by reason across all tenants from Prometheus / ThanosQuerier:

```text
sum by (tenant, reason) (irate(loki_discarded_samples_total[2m]))
```

Only `greater_than_max_sample_age` is the "too old" case; other reasons (`rate_limited`, `line_too_long`, `stream_limit`) are unrelated failure modes, each with its own tuning story.

Plot the distributor error line over time (`irate(loki_request_duration_seconds_count{status_code=~"5.."}[2m])`) alongside the collector queue-depth metric. If the two decline together on their own over the course of hours, the system is self-healing and no action is needed. If the queue depth is flat or rising, the collectors are still producing new old-timestamp entries — that is the cue to look at **why** the source logs are that old (stopped collector, stopped ingester, an offline node whose journal is now being replayed) rather than at Loki's limits.
