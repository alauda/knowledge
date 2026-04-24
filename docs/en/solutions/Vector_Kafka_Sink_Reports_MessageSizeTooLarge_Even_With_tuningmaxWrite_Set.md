---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `ClusterLogForwarder` pipeline shipping logs to a Kafka sink through Vector reports `MessageSizeTooLarge` errors against individual log lines. The error is terminal per-message (no retries, the message is dropped) and looks like this in the collector pod log:

```text
ERROR sink{component_kind="sink" component_id=output_kafka_app component_type=kafka}:
  vector_common::internal_event::service: Service call failed. No retries or retries exhausted.
  error=Some(KafkaError (Message production error:
                         MessageSizeTooLarge (Broker: Message size too large)))
  request_id=N error_type="request_failed" stage="sending" internal_log_rate_limit=true
```

The Kafka broker's `message.max.bytes` is generously sized (10 MiB is typical for audit-capable clusters), the `ClusterLogForwarder` spec even carries an explicit `tuning.maxWrite` set to a value inside the broker's cap, and Fluentd-based forwarders against the same broker work without issue. Vector, though, keeps dropping messages.

## Root Cause

Vector's Kafka sink has two places where the maximum message size is enforced:

1. **The collector's own batching / write size** — governed by `tuning.maxWrite` on the `ClusterLogForwarder` output (or the equivalent `batch.max_bytes` in a hand-written Vector config). This caps how much payload Vector will pack into a single emit towards Kafka.
2. **The underlying `rdkafka` producer's `message.max.bytes`** — an option the librdkafka client exposes. It caps the size of a single message the producer client will attempt to send to the broker.

In affected Logging Service releases, the forwarder reconciler sets (1) from `tuning.maxWrite` but leaves (2) at the librdkafka default (1 MB on older rdkafka versions). The result: Vector packs a batch below the `tuning.maxWrite` ceiling, hands it to the rdkafka producer, and the producer rejects it locally as `MessageSizeTooLarge` **before** it reaches the broker — without consulting the broker's generously-sized `message.max.bytes`.

The effect is a stuck output whose symptoms look like a broker-side size rejection but that is actually a client-side rejection that no broker tuning can fix.

The corresponding fix in newer Logging Service releases propagates the effective `tuning.maxWrite` value into the rdkafka producer's `message.max.bytes` so the two limits stay aligned. Once the operator reconciles a collector built from the fixed version, messages up to `maxWrite` flow through to the broker as intended.

## Resolution

### Upgrade the Logging Service operator

The durable fix is an operator release that carries the updated collector configuration. Upgrade through the platform's operator-management surface and confirm the rendered collector config now includes an explicit `message.max.bytes` on the Kafka producer that matches (or exceeds) `tuning.maxWrite`.

After the upgrade rolls out, the collector's `DaemonSet` rolls, new pods come up with the corrected config, and the `MessageSizeTooLarge` errors stop accumulating. Verify by watching the collector log for a period equal to whatever business cycle was producing the oversized lines:

```bash
kubectl -n <logging-ns> logs -l app.kubernetes.io/component=collector \
  --since=10m | grep -c 'MessageSizeTooLarge' || true
```

A clean run reports zero (or negligible compared to the pre-upgrade baseline). Messages that were previously dropped are delivered from the pod's buffer on the way back up, so there may be a brief traffic spike at the broker as the backlog drains.

### Workaround while the upgrade is pending

If the upgrade has to wait, the two mitigations below keep the pipeline functional at some cost:

1. **Lower `tuning.maxWrite` below rdkafka's default.** Setting `maxWrite: 900k` (a bit under 1 MB) keeps the collector's own batches small enough that the rdkafka producer's unset limit does not reject them. The trade-off is fewer log lines per batch, more round-trips to the broker, and audit log lines above the cap are still dropped individually (audit events can exceed 1 MB — those will still fail).

   ```yaml
   # Logging 6 shape (observability.alauda.io ClusterLogForwarder)
   apiVersion: observability.alauda.io/v1
   kind: ClusterLogForwarder
   metadata:
     name: kafka-forwarder
     namespace: cluster-logging
   spec:
     outputs:
       - name: kafka-app
         kafka:
           url: tcp://kafka.cluster-logging.svc.cluster.local:9092/clo-topic
         tuning:
           maxWrite: 900k     # workaround: below rdkafka's default to dodge client-side reject
   ```

2. **Switch the collector to Fluentd for the Kafka pipeline.** Fluentd's Kafka output is not affected by the rdkafka producer-cap issue. This is a bigger change (Fluentd consumes more memory than Vector and is being phased out of the Logging stack on the upgrade roadmap), so it is only appropriate as a time-boxed fallback.

Neither workaround is durable; both should end as soon as the fixed operator version is available.

### Confirm broker-side limits once for ceiling

While troubleshooting, confirm that the broker's own caps are not the actual bottleneck. This rules out a misconfigured topic or broker:

```bash
# Broker-wide default
kubectl -n <kafka-ns> exec deploy/kafka-broker -- \
  kafka-configs.sh --bootstrap-server localhost:9092 --entity-type brokers --describe \
  | grep -E 'message.max.bytes|socket.request.max.bytes'

# Topic-level override
kubectl -n <kafka-ns> exec deploy/kafka-broker -- \
  kafka-configs.sh --bootstrap-server localhost:9092 --entity-type topics \
    --entity-name clo-topic --describe \
  | grep -E 'max.message.bytes'
```

If the topic's `max.message.bytes` is smaller than what the collector sends, raise it to match `tuning.maxWrite`. Otherwise broker limits are not the issue; the problem is the client-side producer as described above.

## Diagnostic Steps

Confirm the Vector collector is the entity reporting the error (and not the broker itself):

```bash
kubectl -n <logging-ns> logs -l app.kubernetes.io/component=collector \
  --tail=500 | grep -E 'KafkaError.*MessageSizeTooLarge' | head
```

If the error appears in collector pod logs but the broker's `/var/log/kafka/server.log` shows no corresponding `Message size exceeded` rejection at the same timestamps, the rejection is happening client-side — the signature of this issue.

Read the ClusterLogForwarder spec for the effective `tuning.maxWrite`:

```bash
# Logging 5-era shape
kubectl -n <logging-ns> get clusterlogforwarder -o yaml | \
  yq '.items[].spec.outputs[] | select(.type=="kafka") | {name, tuning}'

# Logging 6-era shape (observability API)
kubectl -n <logging-ns> get clusterlogforwarder.observability.alauda.io -o yaml | \
  yq '.items[].spec.outputs[] | select(.kafka != null) | {name, kafka, tuning}'
```

Compare the value with the brokers and topic limits gathered in the Resolution section. If `tuning.maxWrite` is below both broker and topic limits and `MessageSizeTooLarge` still appears, the client-side rdkafka cap is the culprit — apply the workaround or schedule the upgrade.

Finally, quantify how many log lines have been dropped so the impact is known before the fix lands:

```bash
kubectl -n <logging-ns> logs -l app.kubernetes.io/component=collector \
  --since=1h | grep -c 'MessageSizeTooLarge'
```

Counts in the hundreds per hour on an audit-heavy cluster are common — those lines are permanently lost until the fix is in place.
