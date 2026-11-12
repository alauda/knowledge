---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# Vector log forwarding to external Kafka or OpenTelemetry fails on ACP

## Issue

Vector forwards platform logs to a target outside the platform, such as an external Kafka or an OpenTelemetry (OTLP) endpoint, and one of the following happens:

- The Vector Kafka sink fails SASL authentication (for example the broker answers with a password or credentials error), although the user, the password and the permissions are correct.
- Vector exits immediately with status 78 and `No provider for SASL mechanism GSSAPI` when the destination Kafka uses Kerberos.
- The external Kafka topic is auto-created but stays empty.
- The platform log page goes blank right after forwarding to Kafka was configured, while the external Kafka receives logs.
- Platform log search fails after compute nodes were added, on a cluster that uses Vector forwarding.
- Ingress logs need to be forwarded to an OTLP endpoint.

The in-cluster log pipeline can be healthy while the forwarding path is not. Vector runs as the `vector` container of the `razor` pod in `cpaas-system`. Its configuration is in Secret `cpaas-vector` (key `vector.yaml`), and changes to it may be carried by a resource patch (`rpch`).

## Root Cause

### Cause 1: The Vector Kafka sink fails SASL authentication because the sink enables TLS and the broker does not

Vector forwards logs to a Kafka with authentication enabled, and authentication fails. The Kafka user has full permissions, the username and password are correct, and TLS is not enabled on the Kafka listener. The sink has `sasl.enabled: true` with `mechanism: PLAIN`. It also has `tls.enabled: true` with `verify_certificate: false`, `verify_hostname: false`, and `librdkafka_options` `"enable.ssl.certificate.verification": "false"`.

The sink speaks TLS to a plaintext listener, so the SASL exchange never completes, and the failure looks like an authentication error. Setting `tls.enabled: false` in the sink fixes it, and forwarding returns to normal.

### Cause 2: The Vector librdkafka build has no GSSAPI, so a Kerberos Kafka sink exits with status 78

Vector loads its configuration and exits with status 78. The error is:

```text
Sink "output_logs_kafka": creating kafka producer failed: Client creation error: No provider for SASL mechanism GSSAPI: recompile librdkafka with libsasl2 or openssl support. Current build options: PLAIN SASL_SCRAM OAUTHBEARER.
```

A warning that transform `dispatcher_unmatched` has no consumers may appear first, and it is not the failure. The librdkafka in the Vector image is built with `PLAIN`, `SASL_SCRAM` and `OAUTHBEARER` only. The SASL mechanism `GSSAPI` (Kerberos) is not in this build, so the Kafka producer is not created. No setting enables GSSAPI in this image.

### Cause 3: The external Kafka topic is created and stays empty because the Vector condition matches only one cluster

The log storage is centralized ClickHouse on the global cluster. Platform log queries work, `razor` is `Running`, and Vector forwards to an external Kafka. Kafka auto-created the topic, which proves connectivity, but the topic holds no logs. The forwarding configuration's `condition` filters events by `.cluster`, and as written it does not cover the clusters whose logs are wanted. Rewriting it as an OR over all those cluster names, `(.cluster == "<cluster-a>" || .cluster == "<cluster-b>")`, delivers logs from all of them.

### Cause 4: The platform log page is empty after ClickHouse-to-Kafka forwarding was configured, while the external Kafka receives logs

Logs arrive continuously in the external Kafka, so collection and forwarding work, but the platform log page shows nothing from ClickHouse. `razor` logs no error, ClickHouse runs well below its limits, and restarting `razor` changes nothing.

The applied Vector configuration kept the `clickhouse` sink (`endpoint: "http://cpaas-clickhouse:8123"`, `database: observability`, `table: log_kubernetes_all`, `auth.strategy: "basic"`, `skip_unknown_fields: true`, a disk buffer). It added an `output_logs_kafka` sink of `type: kafka`. A special character somewhere in that configuration is suspected but has not been confirmed. Deleting the `rpch` that carried the configuration restores the default, and logs display again. Re-applying the configuration carefully keeps them displaying.

### Cause 5: Log search fails after new nodes until Vector forwarding is disabled and enabled again

Log search from the platform fails after compute nodes are added (for example 10 nodes) on a cluster that uses Vector forwarding. The forwarding path is what broke. Disabling forwarding and then enabling it again makes queries return. No deeper defect has been identified.

### Cause 6: Forwarding ingress logs to an OpenTelemetry endpoint

Vector can forward ingress logs to an OTLP endpoint. The working setup reshapes each event into OTLP JSON (`resourceLogs`) with a `remap` transform. It sends the result through an `opentelemetry` sink over HTTP POST to the endpoint's `/v1/logs` path, with JSON encoding, `content-type: application/json`, and the TLS CA file. A wrong path on the endpoint side makes the delivery fail.

## Resolution

### Cause 1: The Vector Kafka sink fails SASL authentication because the sink enables TLS and the broker does not

1. Find out which security protocol the broker exposes on the port the sink uses. Ask the Kafka owner, or read the broker's `listeners` and `listener.security.protocol.map`. Also note which SASL mechanism the listener enables (`PLAIN`, `SCRAM-SHA-256` or `SCRAM-SHA-512`).

2. Read the sink:

   ```bash
   kubectl -n cpaas-system get secret cpaas-vector -o jsonpath='{.data.vector\.yaml}' | base64 -d | grep -n -A20 'type: kafka'
   ```

   `tls.enabled: true` against a `SASL_PLAINTEXT` listener matches this cause. The sink's `sasl.mechanism` must also be the mechanism that the listener enables, in the same spelling.

3. Correct the sink in the Vector configuration that holds it. Save the current configuration first.

   > **Warning:** Changing the Vector configuration restarts the forwarding pipeline, and a wrong sink can stop forwarding or the platform's own ClickHouse sink. Precondition: the listener protocol and mechanism are confirmed. Rollback: re-apply the saved configuration.

   ```yaml
   sinks:
     <kafka-sink>:
       type: kafka
       inputs:
         - <input>
       bootstrap_servers: <broker>:<port>
       topic: <topic>
       encoding:
         codec: json
       sasl:
         enabled: true
         mechanism: PLAIN
         username: <user>
         password: <password>
       tls:
         enabled: false
   ```

   Remove the `librdkafka_options` SSL entries that were only there for the TLS attempt. Validate the file with `vector validate` in the `vector` container before you apply it.

4. Check that the topic receives records.

### Cause 2: The Vector librdkafka build has no GSSAPI, so a Kerberos Kafka sink exits with status 78

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system logs <razor-pod> -c vector --tail=30
   ```

   The `GSSAPI` line and exit status 78 match this cause.

2. This Vector image cannot use Kerberos to authenticate to Kafka. Use one of the mechanisms the build supports (`PLAIN`, `SCRAM`, or `OAUTHBEARER`) on a listener of the destination Kafka, and configure the sink with it.

### Cause 3: The external Kafka topic is created and stays empty because the Vector condition matches only one cluster

1. Find the `condition` in the Kafka forwarding configuration:

   ```bash
   kubectl get rpch -A | grep -Ei 'vector|razor|clickhouse'
   kubectl -n cpaas-system get secret cpaas-vector -o jsonpath='{.data.vector\.yaml}' | base64 -d | grep -n -B2 -A4 'condition'
   ```

2. Widen the condition.

   > **Warning:** Widening the condition sends more clusters' logs to the external Kafka, which adds traffic and storage on the external side. Nothing changes in the platform storage. Precondition: only when the topic exists, stays empty, and the condition names fewer clusters than you intend to forward. Rollback: restore the saved configuration and restart `razor`.

   Write the condition as one expression that names every cluster to forward:

   ```yaml
   condition: '(.cluster == "<cluster-a>" || .cluster == "<cluster-b>")'
   ```

   Apply the configuration the same way it was created, then restart `razor`.

3. Read a few records from the topic.

### Cause 4: The platform log page is empty after ClickHouse-to-Kafka forwarding was configured, while the external Kafka receives logs

1. Save the forwarding patch:

   ```bash
   kubectl get rpch -A | grep -Ei 'vector|razor|clickhouse'
   kubectl get rpch <forwarding-rpch> -o yaml > /tmp/forwarding-rpch.yaml
   ```

2. Delete it.

   > **Warning:** Deleting the forwarding `rpch` stops forwarding to the external Kafka until you apply it again, and returns the Vector pipeline to the default. Precondition: only when the external Kafka receives logs, the platform page is empty, and `razor` and ClickHouse are healthy. Rollback: `kubectl apply -f /tmp/forwarding-rpch.yaml`.

   ```bash
   kubectl delete rpch <forwarding-rpch>
   ```

3. Confirm that the platform page shows current logs.

4. Apply the forwarding configuration again. Keep the `clickhouse` sink next to the new `kafka` sink, and check the file for stray quotes, non-ASCII punctuation or other special characters. Confirm that both the page and the external topic receive logs.

### Cause 5: Log search fails after new nodes until Vector forwarding is disabled and enabled again

> **Warning:** Turning Vector forwarding off stops the copy to the external target until it is turned on again, so external consumers see a gap for that interval. Precondition: only when search failed after compute nodes were added and forwarding is in use. Rollback: enable forwarding again, which is also the second step of the fix.

Disable Vector forwarding with the same switch that enabled it, then enable it again. Query a workload that is logging now.

### Cause 6: Forwarding ingress logs to an OpenTelemetry endpoint

Add a transform and a sink to the Vector configuration. `filter_workload_ingress` is the input name of the ingress filter in this example. Use the name that your configuration defines.

```yaml
transforms:
  remap_otlp_ingress:
    type: remap
    inputs:
      - filter_workload_ingress
    source: |
      ts = to_unix_timestamp(timestamp(.timestamp) ?? now(), unit: "nanoseconds")
      body = string(.message) ?? encode_json(.)
      . = {
        "resourceLogs": [{
          "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "acp-ingress"}}]},
          "scopeLogs": [{
            "scope": {"name": "vector"},
            "logRecords": [{"timeUnixNano": ts, "body": {"stringValue": body}}]
          }]
        }]
      }
sinks:
  output_logs_ingress:
    type: opentelemetry
    inputs:
      - remap_otlp_ingress
    protocol:
      type: http
      uri: https://<otel-endpoint>/v1/logs
      method: post
      encoding:
        codec: json
      framing:
        method: newline_delimited
      batch:
        max_events: 1
      request:
        headers:
          content-type: application/json
      tls:
        ca_file: /var/ca-bundle.crt
    buffer:
      type: disk
      max_size: <bytes>
```

Set `max_size` to the disk buffer size in bytes (1 GiB is 1073741824). The `protocol` block takes the options of Vector's `http` sink. Check the key placement against the Vector version in the `vector` container (`vector --version`), and run `vector validate` on the file before you apply it. Make sure the URI ends in `/v1/logs`.

## Diagnostic Steps

1. Find the forwarding configuration and the Vector state:

   ```bash
   kubectl get secret -A | grep -E 'cpaas-vector'
   kubectl get rpch -A | grep -Ei 'vector|razor|clickhouse'
   kubectl -n cpaas-system get pods | grep -Ei 'razor'
   kubectl -n cpaas-system logs <razor-pod> -c vector --tail=50
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | SASL authentication fails with correct credentials, and the sink sets `tls.enabled: true` against a broker without TLS | Cause 1 |
   | Exit status 78 and `No provider for SASL mechanism GSSAPI` | Cause 2 |
   | An external topic that exists and stays empty | Cause 3 |
   | An empty platform page right after Kafka forwarding was added, while the external topic fills | Cause 4 |
   | Search that broke only after new nodes were added, on a cluster with forwarding | Cause 5 |
   | OTLP deliveries fail | Cause 6, check the URI path and the CA file |

3. If `ALAUDA_LOG_TOPIC` lag is growing and forwarding is not configured, the forwarding path is not involved. See [Log Kafka lag from Elasticsearch write hot spots, breaker trips, IK analyzer errors, or too few partitions on ACP](./Log_Kafka_lag_from_Elasticsearch_write_hot_spots_breaker_trips_IK_analyzer_errors_or_too_few_partitions_on_ACP.md).

## Related Information

- [Log query shows no logs, HTTP 500, slow long ranges, or an empty real-time log on ACP](./Log_query_shows_no_logs_HTTP_500_slow_long_ranges_or_an_empty_real-time_log_on_ACP.md)
