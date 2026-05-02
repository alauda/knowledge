---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `ClusterLogForwarder` configured with a Kafka output and `authentication.sasl.mechanism: SCRAM-SHA-512` fails to authenticate against a Kafka 4.0 broker. Vector keeps retrying and logs:

```text
ERROR librdkafka: librdkafka: FAIL [thrd:sasl_ssl://kafka-bootstrap.example.com]:
  sasl_ssl://kafka-bootstrap.example.com:443/bootstrap: SASL authentication error:
  Authentication failed during authentication due to invalid credentials with
  SASL mechanism SCRAM-SHA-512 (after 312ms in state AUTH_REQ, 4 identical error(s) suppressed)
ERROR rdkafka::client: librdkafka: Global error: Authentication
  (Local: Authentication failure): ... SASL authentication error: ...
```

The same SCRAM credentials authenticate cleanly against a Kafka 3.x broker, and other Kafka clients (kcat, Java clients with the upstream `kafka-clients` library) authenticate successfully against the same Kafka 4.0 broker using the same credentials. Only Vector — through its embedded `librdkafka` / `rdkafka` Rust binding — is rejected.

## Root Cause

Kafka 4.0 changed the SASL authentication round-trip in a way that the older `librdkafka` snapshot bundled into the Vector / Rust `rdkafka` build does not yet handle. The library reports the broker's response as `Authentication failed during authentication due to invalid credentials`, but the credentials themselves are valid — the failure is on the protocol negotiation, not on the password match. This is an upstream librdkafka / rdkafka compatibility gap that is being tracked for resolution in a future Vector release; until that lands, Vector cannot speak SCRAM-SHA-512 to a Kafka 4.0 broker.

## Resolution

There is no in-place SCRAM-SHA-512 fix while running a Vector built against the affected librdkafka. Two options to keep log forwarding working:

### Option 1 — Switch the output to TLS / mTLS

If the Kafka broker exposes a listener that accepts TLS client-certificate authentication, point the `ClusterLogForwarder` Kafka output at it and replace the SASL block with a TLS block. The shape of the output:

```yaml
apiVersion: logging.alauda.io/v1
kind: ClusterLogForwarder
metadata:
  name: collector
  namespace: <log-collector-ns>
spec:
  outputs:
    - name: kafka-app
      type: kafka
      kafka:
        url: tls://kafka-bootstrap.example.com:9093/clo-topic
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
  pipelines:
    - name: app-to-kafka
      inputRefs: [application]
      outputRefs: [kafka-app]
```

The Kafka listener on the broker side must have TLS client auth enabled (`ssl.client.auth=required` and the broker's listener mapped to `SSL`). This bypasses the SCRAM handshake entirely.

### Option 2 — Pin Vector to a compatible Kafka broker version

If TLS client-cert auth is not available on the existing brokers and the Kafka cluster is dedicated to log ingestion, hold the Kafka cluster at the latest 3.x patch release until a Vector release with an updated `librdkafka` / `rdkafka` lands. Track the platform's Logging release notes for the version that resolves the bundled `librdkafka` upgrade and re-enable the SCRAM path after it ships.

### Option 3 — Use a Kafka broker that exposes a non-SCRAM SASL mechanism

`SASL/PLAIN` over TLS, or `SASL/OAUTHBEARER`, both authenticate against the same `librdkafka` build without exercising the affected SCRAM state machine. The trade-off is that PLAIN sends credentials in cleartext on the wire (acceptable only over TLS) and OAUTHBEARER requires an issuer the brokers trust.

## Diagnostic Steps

1. Confirm the broker version is Kafka 4.0:

   ```bash
   kafkactl --bootstrap kafka-bootstrap.example.com:443 brokers --output json \
     | jq -r '.[] | "\(.id)  \(.version)"'
   # or, against a Strimzi-managed cluster:
   kubectl -n <kafka-ns> get kafka -o jsonpath='{.items[*].spec.kafka.version}'
   ```

2. Confirm the failing output is in fact configured for SCRAM-SHA-512:

   ```bash
   kubectl get clusterlogforwarder -A -o yaml \
     | yq '.items[].spec.outputs[]
           | select(.kafka != null)
           | {name: .name, mechanism: .kafka.authentication.sasl.mechanism}'
   ```

3. Validate the credentials are themselves correct — that is, the rejection is a Vector / `librdkafka` issue, not a real auth failure. Use `kcat` from the same namespace as the Vector pod, with the same `Secret`:

   ```bash
   kubectl run kcat-probe --rm -it --image=edenhill/kcat:1.7.1 -- \
     -b kafka-bootstrap.example.com:443 \
     -X security.protocol=SASL_SSL \
     -X sasl.mechanism=SCRAM-SHA-512 \
     -X sasl.username=<user> -X sasl.password=<pass> \
     -L
   ```

   If `kcat` lists topics, the credentials work and the failure is the Vector path.

4. Capture the Vector log over a clean retry window for the support record — the `4 identical error(s) suppressed` line is the protocol-level rejection signature:

   ```bash
   kubectl -n <log-collector-ns> logs -l app.kubernetes.io/name=vector \
     --tail=200 | grep -E 'librdkafka|SCRAM|SASL'
   ```
