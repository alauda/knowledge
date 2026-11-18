---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - "3.10"
  - "3.12"
  - "3.14"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
---

# Kafka client connection failures: timeouts, TLS certificates, authorization, NodePort, and reverse DNS on ACP

## Issue

Applications cannot reach a Data Services Kafka instance, or need to know how to connect:

- New connections time out from outside the cluster on the external listener, while the broker pods are Running.
- The broker returns `TopicAuthorizationException: Not authorized to access topics: [<topic>]` and a Spring application logs `Send failed`. Clients that used to connect without a user are rejected after authentication was turned on.
- A Kafka CLI tool run inside a broker pod fails with `TimeoutException: Timed out waiting for a node assignment. Call: listTopics`, and the broker logs `Failed authentication with /<address> (Unexpected Kafka request of type METADATA during SASL handshake.)`.
- A TLS client fails with `ERR_TLS_CERT_ALTNAME_INVALID`: `Failed to connect to seed broker, trying another broker from the list: Connection error: Hostname/IP does not match certificate's altnames: IP: <broker-ip> is not in the cert's list:`.
- `openssl` on the client certificate shows it is past `notAfter`.
- Exporting the broker certificate through the console file download saves a `.crt` of 0 bytes.
- A new Kafka instance also creates a NodePort Service that is not wanted.
- Questions: can the connection address shown in Data Services change or be pinned, and can the Kafka Pod IPs be fixed?

A user whose secret does not exist, a user stuck in `Creating`, or `Simple authorization ACL rules are configured but not supported in the Kafka cluster configuration.` is covered in [Kafka user secret missing, user stuck in Creating, ACL not supported, or uppercase topic names on ACP](Kafka_user_secret_missing_user_stuck_in_Creating_ACL_not_supported_or_uppercase_topic_names_on_ACP.md). An application outside the cluster that reports `No route to host` while curl from inside the application pod to Kafka succeeds is a network path problem, not a certificate fault.

Listener ports of a Data Services Kafka: `9092` username/password inside the cluster, `9093` TLS inside the cluster, `9094` the external listener published through NodePort.

## Root Cause

### Cause 1: Kafka 2.7.0 blocks SASL_SSL threads on reverse DNS

New connections to a Kafka 2.7.0 broker on the external SASL_SSL listener (port 9094 behind a NodePort) time out, both by Pod IP and by NodePort. One broker accumulates many `CLOSE_WAIT` sockets (around 200) and its listen socket receive queue backs up. Inside the pod, reverse lookups of client addresses hang: CoreDNS forwards those PTR queries to an upstream resolver that the pod cannot reach, and the SASL_SSL accept thread stalls in the lookup. These are the upstream Kafka defects KAFKA-13576 and KAFKA-8562.

### Cause 2: The application client certificate is expired

Kafka-related application pods fail because the client certificate they present is past its end date. Replacing that client certificate restores them. The operator's clients CA is a different object: on ACP 3.10.2 it is issued for about one year, and the operator renews it near expiry, which restarts brokers (see [Kafka Restarts After Client CA Certificate Expiry on ACP 3.10.2](ecosystem/kafka/Kafka_Certificate_Expiry_Restart_on_ACP_3102.md)).

### Cause 3: Authentication and authorization are on and the client has no matching user, ACL, or SASL settings

With authentication enabled on a listener, a client needs a user, and with `authorization.type: simple` that user needs ACL entries for the topic and for the consumer group. A user without the group ACL still fails as a consumer.

A client that connects to a SASL listener without SASL settings (for example `kafka-topics.sh --bootstrap-server localhost:9092` with no client properties) sends ordinary Kafka requests where the broker expects a SASL handshake. The broker logs `Unexpected Kafka request of type METADATA during SASL handshake` and closes the connection, and the client keeps retrying until `Timed out waiting for a node assignment`. The source address in that broker line can be a node address (for example a Kube-OVN join subnet address when traffic arrives through a NodePort); it identifies the client, not a failing broker.

### Cause 4: The console file download writes an empty crt

The certificate path inside the broker pod is correct, but the console exec download saves a 0-byte `.crt`.

### Cause 5: External access is enabled, so a NodePort Service is created

A new Kafka gets a Service of type NodePort because the instance was created with external access on, and the external listener (named `external`, Service `<cluster>-kafka-external-bootstrap`) is present in the Kafka resource. No safe way is known to drop that Service from an existing instance without recreating it.

### Cause 6: The dialed broker IP is not in the certificate SAN

The client performs TLS hostname verification and dials an IP that is not in the server certificate's subject alternative names. An empty list after `is not in the cert's list:` means the certificate carries no SAN at all. The failure is in the client that verifies the name, not in a broker refusing TCP.

### Cause 7: Does the Kafka connection address in Data Services change, and can it be fixed?

The question comes up before applications are pointed at a new instance.

### Cause 8: Can the IP addresses of the Kafka Pods be fixed?

The request is to give broker Pods fixed IPs, for example from a Kube-OVN underlay IP pool, so that clients or firewalls can use them.

## Resolution

### Cause 1: Kafka 2.7.0 blocks SASL_SSL threads on reverse DNS

Apply this only when the broker is 2.7.0, the timeout is on 9094 or its NodePort, `CLOSE_WAIT` climbs on a broker, and PTR lookups from inside the pod are slow.

Add host records for the client source addresses to the CoreDNS `hosts` plugin so the reverse lookup answers immediately:

```bash
kubectl -n kube-system get cm coredns -o yaml > coredns.bak.yaml
kubectl -n kube-system edit cm coredns
```

```text
hosts {
    192.0.2.10 client-a.example.internal
    fallthrough
}
```

Use the real client source addresses. CoreDNS reloads the Corefile on its own when the `reload` plugin is enabled; otherwise restart it:

> **Warning:** Restarting CoreDNS briefly affects name resolution in the cluster. Do it one replica at a time with a rollout, and only after the ConfigMap change is saved. Roll back by re-applying `coredns.bak.yaml`.

```bash
kubectl -n kube-system rollout restart deploy/coredns
kubectl -n <namespace> exec <cluster>-kafka-0 -- getent hosts 192.0.2.10
```

The lookup should return immediately; then retry the external client. Moving the cluster off 2.7.0 also avoids the defect: 2.7.2, 2.8.1, and 3.0.0 do not block this way. A version change rolls the brokers; do it in a window.

### Cause 2: The application client certificate is expired

```bash
openssl x509 -in client.crt -noout -dates
```

Replace the expired certificate in the application key store or trust store and roll the application pods.

To inspect the clients CA of the instance:

```bash
kubectl -n <namespace> get secret <cluster>-clients-ca-cert -o jsonpath='{.data.ca\.crt}' | base64 -d > clients-ca.crt
openssl x509 -in clients-ca.crt -noout -dates
```

To lengthen later issuances, set both CA lifetimes on the `Kafka` resource (`3650` is a supported multi-year value) and renew:

```yaml
spec:
  clusterCa:
    validityDays: 3650
  clientsCa:
    validityDays: 3650
```

> **Warning:** Renewing the clients CA with `strimzi.io/force-renew` restarts brokers and invalidates client certificates signed by the previous CA. Use it only when `openssl -dates` shows the CA itself is expired or close to expiry, in a maintenance window, and give clients the new CA material afterwards. An expired application certificate alone is replaced without this step.

```bash
kubectl -n <namespace> annotate secret <cluster>-clients-ca-cert strimzi.io/force-renew=true --overwrite
```

### Cause 3: Authentication and authorization are on and the client has no matching user, ACL, or SASL settings

Create a user bound to the instance and grant topic and group operations. For a Data Services instance the object is `RdsKafkaUser` (`middleware.alauda.io/v1`, label `middleware.alauda.io/cluster: <instance>`); for a Strimzi `Kafka` created in the management view it is `KafkaUser` (label `strimzi.io/cluster: <cluster>`). The listener must have authentication (`scram-sha-512` or `tls`) and `spec.kafka.authorization.type` must be `simple`.

```yaml
apiVersion: kafka.strimzi.io/v1beta1
kind: KafkaUser
metadata:
  name: <user>
  namespace: <namespace>
  labels:
    strimzi.io/cluster: <cluster>
spec:
  authentication:
    type: scram-sha-512
  authorization:
    type: simple
    acls:
      - {host: "*", operation: Write, resource: {type: topic, name: <topic>, patternType: literal}}
      - {host: "*", operation: Read, resource: {type: topic, name: <topic>, patternType: literal}}
      - {host: "*", operation: Describe, resource: {type: topic, name: <topic>, patternType: literal}}
      - {host: "*", operation: Read, resource: {type: group, name: <group>, patternType: literal}}
```

```bash
kubectl -n <namespace> apply -f kafkauser.yaml
kubectl -n <namespace> get kafkauser <user>
kubectl -n <namespace> get secret <user> -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n <namespace> get svc <cluster>-kafka-bootstrap <cluster>-kafka-external-bootstrap
```

Password clients use `SASL_PLAINTEXT` on 9092 (or `SASL_SSL` on a TLS listener) with `sasl.mechanism=SCRAM-SHA-512`. TLS clients also need the cluster CA in their trust store.

For CLI tools inside a broker pod, write a client file and pass it with `--command-config`:

```bash
kubectl -n <namespace> exec -i <cluster>-kafka-0 -- sh -c 'cat > /tmp/client.properties' <<'EOF'
security.protocol=SASL_PLAINTEXT
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="<user>" password="<password>";
EOF
kubectl -n <namespace> exec <cluster>-kafka-0 -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --command-config /tmp/client.properties --describe --under-replicated-partitions
```

An empty result means no under-replicated partitions.

### Cause 4: The console file download writes an empty crt

Read the Secret, or copy the file with `kubectl cp`, instead of the console download:

```bash
kubectl -n <namespace> get secret <cluster>-cluster-ca-cert -o jsonpath='{.data.ca\.crt}' | base64 -d > cluster-ca.crt
kubectl -n <namespace> cp <cluster>-kafka-0:<path-inside-pod> ./exported.crt
ls -l cluster-ca.crt exported.crt
```

Both files should be non-empty.

### Cause 5: External access is enabled, so a NodePort Service is created

For an instance that is not created yet, turn external access off in the create form; the `external` listener is then absent and no NodePort Service is created. For an existing instance, deleting the Service by hand is not a verified fix: the operator can recreate it while the external listener remains.

### Cause 6: The dialed broker IP is not in the certificate SAN

Confirm the address is missing from the SAN, using the port the application uses:

```bash
openssl s_client -connect 192.0.2.10:9094 -servername 192.0.2.10 </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName
```

No `X509v3 Subject Alternative Name` block means the certificate has no SAN. The fix is to turn off hostname verification on the failing client.

> **Warning:** Turning off hostname verification makes the client accept any certificate signed by the trusted CA, whatever name it was issued for. Apply it only when the error is `Hostname/IP does not match certificate's altnames` and the dialed address is not in the SAN. Keep a copy of the previous client configuration; roll back by removing the setting.

Java client (`ssl.endpoint.identification.algorithm` empty):

```properties
ssl.endpoint.identification.algorithm=
```

Spring: `spring.kafka.properties.ssl.endpoint.identification.algorithm=`. librdkafka-based clients: `ssl.endpoint.identification.algorithm=none`.

The wording `ERR_TLS_CERT_ALTNAME_INVALID` and `Failed to connect to seed broker` comes from a Node.js client such as KafkaJS, which does not read Java properties. There, skip the name check with `checkServerIdentity` while keeping the CA check (general Node.js behavior):

```javascript
const fs = require('fs');
const { Kafka } = require('kafkajs');
const kafka = new Kafka({
  clientId: '<client-id>',
  brokers: ['192.0.2.10:9094'],
  ssl: {
    ca: [fs.readFileSync('/path/to/ca.crt', 'utf-8')],
    checkServerIdentity: () => undefined,
  },
});
```

### Cause 7: Does the Kafka connection address in Data Services change, and can it be fixed?

The address is already fixed: it comes from the Kubernetes Services of the instance and stays the same as long as those Services are not modified. Changing it is not recommended. For external access, NodePort gives a node IP plus node port that does not change after the instance is created.

```bash
kubectl -n <namespace> get svc -l strimzi.io/cluster=<cluster>
kubectl -n <namespace> get svc <cluster>-kafka-external-bootstrap -o jsonpath='{.spec.ports[*].nodePort}{"\n"}'
```

Inside the cluster, use the bootstrap Service `<cluster>-kafka-bootstrap.<namespace>.svc` or the per-broker names `<cluster>-kafka-<n>.<cluster>-kafka-brokers.<namespace>.svc`.

### Cause 8: Can the IP addresses of the Kafka Pods be fixed?

Not through a Data Services instance at present: `RdsKafka` does not support setting Pod `annotations`, which is how a Kube-OVN IP pool is normally attached, so a fixed IP pool cannot be assigned to the broker Pods. Pod IPs usually change when a Pod is recreated or rescheduled, so clients should not depend on them. Use the Service addresses from Cause 7 inside the cluster and NodePort from outside.

## Diagnostic Steps

1. Classify the client error:

   - Timeout only from outside, Kafka 2.7.0, `CLOSE_WAIT` on a broker: Cause 1.
   - `certificate has expired`, or `openssl -dates` in the past: Cause 2.
   - `TopicAuthorizationException`, or `Unexpected Kafka request of type METADATA during SASL handshake` on the broker with a client timeout: Cause 3.
   - Empty file from the console download: Cause 4.
   - `ERR_TLS_CERT_ALTNAME_INVALID`, `Hostname/IP does not match certificate's altnames`: Cause 6. Note the client language from the error format.

2. Listener authentication and ports:

   ```bash
   kubectl -n <namespace> get kafka <cluster> -o jsonpath='{.spec.kafka.listeners}{"\n"}{.spec.kafka.version}{"\n"}'
   kubectl -n <namespace> get svc -l strimzi.io/cluster=<cluster>
   ```

   `"authentication":{"type":"scram-sha-512"}` on a listener means every client of that port, CLI tools included, needs SASL settings.

3. Accept queue and reverse lookup (Cause 1). The broker image may lack `ss`; use `/proc/net/tcp` then (state `08` is `CLOSE_WAIT`):

   ```bash
   kubectl -n <namespace> exec <cluster>-kafka-0 -- sh -c 'ss -ant 2>/dev/null | grep -c CLOSE-WAIT || awk "\$4==\"08\"" /proc/net/tcp /proc/net/tcp6 | wc -l'
   kubectl -n <namespace> exec <cluster>-kafka-0 -- sh -c 'time getent hosts <client-address>'
   ```

   A multi-second PTR lookup is Cause 1. An immediate return rules it out.

4. Find where a source address in a broker log comes from before blaming a broker:

   ```bash
   kubectl get pod -A -o wide | grep <address>; kubectl get node -o wide | grep <address>
   kubectl get ip -o custom-columns='IP:.spec.ipAddress,SUBNET:.spec.subnet,POD:.spec.podName' | grep <address>
   ```

5. A timeout combined with ZooKeeper down or `FailedAttachVolume` is not a client problem; see [Kafka and ZooKeeper down from storage stalls, a full node disk, or a probe kill during log replay on ACP](Kafka_and_ZooKeeper_down_from_storage_stalls_a_full_node_disk_or_a_probe_kill_during_log_replay_on_ACP.md).
