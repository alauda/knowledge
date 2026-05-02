---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Vector-based log collector configured to forward records to an external Kafka cluster fails authentication when the Kafka broker is at the 4.0 line and the SASL mechanism is set to `SCRAM-SHA-512`. Collector logs show repeated authentication failures from `librdkafka`:

```text
ERROR librdkafka: librdkafka: FAIL [thrd:sasl_ssl://kafka-...-bootstrap]:
sasl_ssl://...:443/bootstrap: SASL authentication error: Authentication
failed during authentication due to invalid credentials with SASL mechanism
SCRAM-SHA-512 (after 312ms in state AUTH_REQ, 4 identical error(s) suppressed)

ERROR rdkafka::client: librdkafka: Global error: Authentication
(Local: Authentication failure): ...
```

Forwarding stalls; data backs up at the collector.

## Root Cause

The credentials are correct — the SCRAM secret has been validated against the same broker with another client. The failure is an interoperability issue between the version of `librdkafka` that Vector links against and Kafka 4.0's SASL handshake. The 4.0 release tightened how SCRAM challenge frames are parsed; older `librdkafka` versions emit a frame the broker now rejects with a generic `Authentication failure` rather than a more descriptive code, which makes the credentials look wrong even though they are not.

The same Vector configuration succeeds against Kafka 3.x brokers and against Kafka 4.0 brokers reached over plain TLS (no SASL) or with SASL `PLAIN`/`OAUTHBEARER`.

## Resolution

Two viable paths until the bundled `librdkafka` is rebuilt against a SCRAM-compatible release:

### Switch the Kafka listener to TLS authentication

If the Kafka cluster's listener already supports mutual TLS (or can be reconfigured to support it), switch the log-forwarding output to `tls` authentication and remove the SASL block:

```yaml
apiVersion: observability.alauda.io/v1
kind: ClusterLogForwarder
metadata:
  name: collector
  namespace: kube-logging
spec:
  outputs:
  - name: kafka-out
    type: kafka
    kafka:
      url: tls://kafka-bootstrap.app.svc.cluster.local:9093/audit-topic
      authentication:
        tls:
          ca:
            secretName: kafka-ca
            key: ca.crt
          certificate:
            secretName: kafka-client
            key: tls.crt
          key:
            secretName: kafka-client
            key: tls.key
```

The broker validates the client certificate; SCRAM is no longer on the path so the `librdkafka` issue is bypassed.

### Pin Kafka brokers below 4.0

For environments where mutual TLS is not feasible (for example a managed Kafka exposing only SCRAM-SHA-512), keep the broker on the 3.x line until the collector image is updated. Verify the broker version with:

```bash
kubectl -n kafka-system get kafka <cluster> \
  -o jsonpath='{.spec.kafka.version}{"\n"}'
```

Plan the broker upgrade only after the new collector build is available and validated end-to-end.

## Diagnostic Steps

Confirm the cause before changing anything:

1. Check the SASL mechanism declared in the forwarder spec:

   ```bash
   kubectl -n kube-logging get clusterlogforwarder <name> \
     -o jsonpath='{.spec.outputs[*].kafka.authentication.sasl.mechanism}{"\n"}'
   ```

   If it returns `SCRAM-SHA-512` and the symptom matches, this article applies.

2. Identify the broker version. From inside any client pod with the same network reachability:

   ```bash
   kubectl -n <ns> exec -it <client-pod> -- \
     kafka-broker-api-versions.sh \
       --bootstrap-server kafka-bootstrap:9092 | head
   ```

3. Cross-check by sending a quick probe with another client (same SCRAM credentials) — for example `kcat`:

   ```bash
   kcat -b kafka-bootstrap:9093 -X security.protocol=SASL_SSL \
     -X sasl.mechanism=SCRAM-SHA-512 \
     -X sasl.username=$USER -X sasl.password=$PASS -L
   ```

   If `kcat` also fails with `librdkafka` from the same vintage, the broker is rejecting the client. If `kcat` (or a Java client) succeeds, the issue is the collector's library version.

4. Inspect collector logs for the exact `librdkafka` version banner — it appears at startup and helps the platform team correlate against the upstream tracker.
