---
products:
  - Alauda Application Services
kind:
  - Solution
---

# Kafka Performance Testing Guide

## 1. Purpose and Scope

This guide describes how to run repeatable and auditable performance tests for a Kafka instance on Alauda Container Platform (ACP). It is intended to answer the following questions:

- What sustained producer and consumer throughput can the instance deliver with a specified replication, acknowledgment, and compression policy?
- What usable capacity can the instance deliver while latency, error rate, replica synchronization, and resource utilization remain within their constraints?
- Is the bottleneck in the clients, broker CPU, memory, or network, persistent volumes, or partition and replica placement?
- After an instance or client parameter is changed, are the results comparable and is the improvement reproducible?

This guide uses Apache Kafka terminology for brokers, topics, and controllers.

In-sync replica (ISR) terminology follows the Apache Kafka documentation.

This guide covers both Kafka Raft metadata mode (KRaft) and legacy ZooKeeper-based instances. Treat the metadata mode as part of the test profile. Do not compare or combine results across metadata modes.

The primary commands use the Apache Kafka 4.2.0 script interfaces. Section 8.5 lists the required command changes for the legacy Kafka 2.x clients shipped with ZooKeeper-based operator releases. For any installed version, first save the `--version` and `--help` output and use only the options shown by that version.

This guide does not provide a universally applicable "best throughput" or "best configuration." A change in hardware, storage, network, message size, compression ratio, reliability policy, or workload can make results incomparable.

> **Risk notice:** Performance tests write large amounts of data and can exhaust disk, network, or node resources. Run them only against an authorized, isolated instance, namespace, and test window. Do not search for the saturation point on an instance that serves production traffic.

## 2. Result Profiles

Select one workload mode and one reliability profile before testing. Do not combine results from different profiles.

### 2.1 Workload modes

| Mode | Purpose | Execution | Primary results |
| --- | --- | --- | --- |
| Producer-only | Measure write capacity | Run producers only | records/s, MiB/s, produce acknowledgment latency |
| Consumer-only | Measure read capacity | Preload enough data, then run consumers | records/s, MiB/s, consumer group lag |
| Concurrent produce and consume | Simulate continuous data flow | Start consumers, then start producers | Throughput on both sides, lag growth, broker resources, and stability |

The producer script reports produce request acknowledgment latency, not application end-to-end latency. The consumer script reports throughput but does not report the time from message production to consumption. To measure end-to-end latency, write a send timestamp into each message and calculate latency in an application-specific load generator at the consumer. Do not subtract the output of the two scripts.

### 2.2 Reliability profiles

| Profile | Topic | Producer | Purpose |
| --- | --- | --- | --- |
| Production reliability baseline | `replication.factor=3`, `min.insync.replicas=2` | `acks=all`, `enable.idempotence=true` | Default for capacity planning and production acceptance |
| Leader acknowledgment ceiling | `replication.factor=3`; all other settings match the tested baseline | `acks=1`, `enable.idempotence=false` | Estimate the throughput ceiling with weaker acknowledgment |

`acks=1` waits only for the leader to acknowledge the request. If the leader fails immediately afterward, data that has not been replicated can be lost. Kafka idempotent production requires `acks=all`, so an `acks=1` test must explicitly set `enable.idempotence=false` to avoid a conflicting client configuration. Every capacity result must identify its reliability profile. Do not report the leader acknowledgment ceiling as production reliability capacity.

### 2.3 Access paths

External connections can use Transport Layer Security (TLS) and Simple Authentication and Security Layer (SASL). Test with the same security configuration planned for the application.

| Access path | Client location | Constraints included in the result | Use case |
| --- | --- | --- | --- |
| In-cluster capacity | Dedicated load-test nodes in the business cluster, connected through the internal bootstrap Service | Kafka, cluster network, and storage | Instance capacity and tuning; this is the default path in this guide |
| External end-to-end | Customer-selected source cluster or host, connected through the actual external listener | All in-cluster constraints plus the load balancer, wide area network (WAN), firewall, TLS/SASL, and client egress | Application connectivity acceptance |

Do not combine results from the two paths. For an external end-to-end test, save the client location, listener, round-trip latency, packet loss, and network path. Confirm that the client can reach every broker address advertised in Kafka metadata, not only the bootstrap address. After initializing the variables in section 4.3, read listener addresses from current resource status instead of inferring them from naming rules:

```bash
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{range .status.listeners[*]}{.name}{"\t"}{.bootstrapServers}{"\n"}{end}'
```

### 2.4 Metadata modes

| Area | KRaft instance | ZooKeeper-based instance |
| --- | --- | --- |
| Metadata quorum | KRaft controller quorum | ZooKeeper ensemble |
| Controller role | Dedicated or combined controller/broker roles, depending on the deployment | One broker is elected as the active Kafka controller; ZooKeeper nodes are not Kafka controllers |
| Generated workloads | Kafka Pods and, where supported, `KafkaNodePool` resources | Kafka and ZooKeeper StatefulSets |
| Primary health evidence | `kafka-metadata-quorum.sh`, controller metrics, and broker health | ZooKeeper ensemble metrics, exactly one active Kafka controller, and broker health |
| Storage outside broker data volumes | Controller metadata storage, depending on role layout | A separate persistent volume claim (PVC) for each ZooKeeper node |

Determine the mode from the final generated resources and installed operator schema, not from the Kafka version alone. Record the mode, operator version, Kafka version, and generated resource shape for every result.

## 3. Standard Test Matrix

Run the standard matrix first to produce comparable data, then add a workload that matches the actual message model, connection security, and concurrency pattern. Run the complete matrix separately for KRaft and ZooKeeper-based instances; the metadata mode must not change within a comparison series.

### 3.1 Instance and message matrix

| Broker resources | Brokers | Topic partitions | Replication factor | Message sizes |
| --- | ---: | ---: | ---: | --- |
| 1 vCPU / 2 GiB | 3 | 30 | 3 | 100 B, 500 B, 1000 B |
| 2 vCPU / 4 GiB | 3 | 30 | 3 | 100 B, 500 B, 1000 B |
| 4 vCPU / 8 GiB | 3 | 30 | 3 | 100 B, 500 B, 1000 B |
| 8 vCPU / 16 GiB | 3 | 30 | 3 | 100 B, 500 B, 1000 B |

Use these record counts for the standard points:

- For 1, 2, and 4 vCPU, send 50,000,000 records for each message size.
- For 8 vCPU, send 100,000,000 records for 100 B and 500 B, and 50,000,000 records for 1000 B.

Start each standard producer point with one producer process. If section 12 shows that the client reaches its limit first, add processes and report the aggregated result separately. The standard consumer point targets 20 consumers. Run 20 independent processes in the same consumer group in every metadata mode. Do not rely on `--threads`: Kafka 4.2 does not provide it, and some legacy Kafka 2.x scripts accept it but ignore it. The processes can be distributed across multiple adequately resourced Pods, but record the number of processes and resources in each Pod.

If the test window or disk capacity cannot support these record counts, reduce them, but keep each steady-state point running for at least 10 minutes and record the actual count and duration. A short burst result is not a substitute for steady-state capacity.

### 3.2 Application-specific matrix

In addition to the standard matrix, test at least one configuration that matches the production plan:

- message-size distribution, not only an average size;
- record-key distribution and partitioning strategy;
- `compression.type`;
- connection security such as TLS and SASL;
- number of producer and consumer instances;
- topic count, partition count, replication factor, and retention time;
- actual burst and idle cycles.

If no production workload distribution is available, label the conclusion as a synthetic workload result. Do not present it as application capacity.

## 4. Prerequisites

### 4.1 Environment isolation

1. Create a dedicated namespace, Kafka instance, topic, consumer group, and load-test clients.
2. Distribute brokers across Kubernetes nodes. For a ZooKeeper-based instance, distribute ZooKeeper replicas across nodes and failure domains as well. Preserve the production plan for whether one broker and one ZooKeeper Pod may share a node.
3. Do not place load-test clients on any broker, controller, or ZooKeeper node, because client resource contention will distort results.
4. Do not run scaling, upgrades, node maintenance, storage migration, ZooKeeper reconfiguration, or other high-load tasks during the test.
5. Use the same node and persistent-volume types as the target environment. Prefer local block storage or qualified block storage for production capacity testing. Do not extrapolate results from unqualified shared file storage to a block-storage environment.
6. Use a new instance for each instance-parameter test, or delete the test topic and wait for the instance to stabilize. After changing a parameter that requires a restart, wait until all Pods are Ready, all replicas are synchronized, and the KRaft quorum or ZooKeeper ensemble is stable before starting the next run.

### 4.2 Required tools and permissions

- `kubectl` access to the business cluster;
- the required permissions for Kafka and, for a legacy deployment, ZooKeeper resources, as well as Pods, StatefulSets, ConfigMaps, Secrets, Services, and persistent volume claims (PVCs) in the test namespace;
- read access to platform monitoring or Prometheus time-series data;
- permission to read the Kafka image name from a deployed broker Pod. This guide reuses the Kafka image managed by the operator and does not require a private image name;
- a client-configuration Secret for SASL/TLS. Do not include passwords, tokens, private keys, or complete Secrets in the report.

### 4.3 Create an evidence directory

Run the following initialization in one Bash session. Later code blocks use these variables and error-handling options:

```bash
set -euo pipefail

export KUBECONFIG=/path/to/business-cluster.kubeconfig
export NS=kafka-perf
export CLUSTER=perf-kafka
export TOPIC=perf-rf3-p30
export METADATA_MODE=kraft
export GROUP="perf-$(date -u +%Y%m%dT%H%M%SZ)"
export RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${CLUSTER}"
export OUT="$(pwd)/kafka-perf-${RUN_ID}"
mkdir -p "$OUT"

kubectl version -o yaml >"$OUT/kubectl-version.yaml"
kubectl cluster-info >"$OUT/cluster-info.txt"
kubectl get nodes -o wide >"$OUT/nodes.txt"
kubectl get storageclass -o yaml >"$OUT/storageclasses.yaml"
```

Set `METADATA_MODE=zookeeper` for a ZooKeeper-based instance. Keep this variable fixed for the complete comparison series.

Export only non-sensitive metadata. Do not write kubeconfig files, Secret data, registry credentials, or client passwords to the evidence directory.

## 5. Export and Freeze Instance Parameters

The general Kafka parameter template is usually named `general-kafka`. The template is product configuration in the management cluster. The `RdsKafka` resource in the business cluster stores the final effective instance configuration. Templates can change between product versions, so export the installed version for every test instead of relying on the table in this guide.

If you have read access to the management cluster, run:

```bash
export MGMT_KUBECONFIG=/path/to/management-cluster.kubeconfig

kubectl --kubeconfig "$MGMT_KUBECONFIG" get paramtemplate -A \
  -l component=kafka

export TEMPLATE_NS="$(kubectl --kubeconfig "$MGMT_KUBECONFIG" \
  get paramtemplate -A -l component=kafka \
  -o jsonpath='{range .items[?(@.metadata.name=="general-kafka")]}{.metadata.namespace}{"\n"}{end}')"
test -n "$TEMPLATE_NS"
kubectl --kubeconfig "$MGMT_KUBECONFIG" -n "$TEMPLATE_NS" \
  get paramtemplate general-kafka -o yaml \
  >"$OUT/general-kafka-paramtemplate.yaml"
```

If management-cluster access is unavailable, select the general Kafka parameter template in the product console and export the final `spec.config` from the instance. Do not infer values from the template name.

Review at least the following parameters in the current standard general template. The example baseline only identifies parameters; it does not replace the installed template.

| Broker parameter | Example baseline | Effect and test interpretation |
| --- | ---: | --- |
| `auto.create.topics.enable` | `false` | Prevents an accidental topic from being created because of a typo; create test topics explicitly |
| `default.replication.factor` | `3` | Default when replication factor is omitted; the test still specifies `3` explicitly |
| `min.insync.replicas` | `1` | Template baseline; set it explicitly to `2` at the topic or instance level for the production reliability test |
| `num.network.threads` | `3` | Number of threads that process network requests |
| `num.io.threads` | `8` | Number of threads that process requests and disk-related work |
| `num.replica.fetchers` | `1` | Number of replica fetcher threads per source broker |
| `num.recovery.threads.per.data.dir` | `1` | Threads per data directory for startup recovery and shutdown flushes |
| `background.threads` | `10` | Background task thread-pool size |
| `message.max.bytes` | `1048588` | Maximum record-batch size accepted by a broker; not the size of one record |
| `compression.type` | `producer` | Retains the compression type selected by the producer |
| `log.segment.bytes` | `1073741824` | Log-segment size |
| `log.retention.hours` | `168` | Time-based retention period |
| `log.roll.hours` | `168` | Maximum time before a log segment rolls |
| `delete.topic.enable` | `true` | Allows test topics to be deleted |
| `unclean.leader.election.enable` | `false` | Prevents a replica outside the ISR from becoming leader |

The current product version determines how parameter-template changes are applied. Before testing, query the parameter definition and record its `applyStrategy`. If it is `RestartApply`, exclude the rolling-restart interval from the measurement window.

```bash
kubectl --kubeconfig "$MGMT_KUBECONFIG" get paramdefinition kafka-general -o yaml \
  >"$OUT/kafka-general-paramdefinition.yaml"
```

### 5.1 Additional snapshot for a ZooKeeper-based instance

The legacy generated `Kafka` resource stores the broker and ZooKeeper specifications separately. Save both before testing:

```bash
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.version}{"\n"}' \
  >"$OUT/kafka-version.txt"
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.config}' \
  >"$OUT/kafka-broker-config.json"
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.zookeeper}' \
  >"$OUT/zookeeper-spec.json"
```

Record `log.message.format.version` and `inter.broker.protocol.version` when present. A value that does not match the broker major and minor version can indicate an incomplete upgrade. Do not change either value during a performance comparison.

ZooKeeper settings under `spec.zookeeper.config` are version-specific, and the operator prevents changes to settings that it owns, including server addresses, data directories, client ports, quorum authentication, and several TLS properties. Query the installed custom resource definition before changing a ZooKeeper setting. Keep the complete ZooKeeper configuration, resources, JVM options, and metrics mapping fixed unless one of them is the single variable under test.

## 6. Persistent-Volume Capacity and Storage Qualification

### 6.1 Capacity formula for a bounded synthetic test

For one topic, estimate the message payload stored by each broker as follows:

```text
payload bytes per broker ≈ record count × record bytes × replication factor ÷ broker count ÷ measured compression ratio
recommended minimum PVC = payload bytes per broker × safety factor + other topics, indexes, and operational reserve
```

The compression ratio is uncompressed bytes divided by bytes stored. Use `1` during estimation when no measured ratio is available; do not assume a compression benefit. This guide uses an engineering safety factor of `1.5` for a new, single-topic, bounded synthetic test. This factor is not a Kafka default and does not apply to production capacity planning. Increase it based on measured peaks when data can be skewed, replicas can be reassigned, multiple topics exist, or writes continue throughout the retention period. Reserve migration space separately.

With 3 brokers, replication factor 3, and compression ratio 1, one copy of every record is stored on each broker on average. The payload and recommended minimums are:

| Records | Message size | Payload per broker | Minimum rounded up after multiplying by 1.5 |
| ---: | ---: | ---: | ---: |
| 50,000,000 | 100 B | 4.66 GiB | 7 GiB |
| 50,000,000 | 500 B | 23.28 GiB | 35 GiB |
| 50,000,000 | 1000 B | 46.57 GiB | 70 GiB |
| 100,000,000 | 100 B | 9.31 GiB | 14 GiB |
| 100,000,000 | 500 B | 46.57 GiB | 70 GiB |

The table does not separately account for keys, record headers, batch overhead, indexes, control records, other topics, or temporary reassignment space. A 50 GiB PVC is therefore insufficient to safely run the complete standard point for either 50,000,000 1000 B records or 100,000,000 500 B records. Do not use this bounded formula for a test with unlimited duration or unknown write volume. Calculate those cases from the write rate, retention time, and target disk utilization.

A dedicated KRaft controller does not store topic message payload and must not use the broker payload formula. Its PVC must satisfy the minimum for the installed product version and be calibrated from changes in topic and partition count, metadata-log growth, and retention. When controllers and brokers share a data volume in a combined role, the PVC must accommodate the broker payload minimum plus metadata, indexes, and operational reserve.

A ZooKeeper PVC also does not store topic payload and must not use the broker payload formula. Size it from observed ZooKeeper data and snapshot growth, recovery requirements, and an explicit free-space reserve. Use persistent, low-latency block storage and separate ZooKeeper volumes from Kafka broker data volumes. Do not use ephemeral ZooKeeper storage for a capacity result: a single-replica ensemble with ephemeral storage loses cluster metadata after a restart, and any ephemeral ensemble introduces a recovery condition that is not representative of production.

For this legacy operator model, storage type and class are not general tuning variables. Persistent-volume expansion is increase-only, depends on the StorageClass, and causes the operator to restart Pods that use the resized volume. Complete any expansion before the measurement window and wait for the full ensemble and all broker sessions to stabilize.

### 6.2 Storage checks

```bash
kubectl -n "$NS" get pvc -o wide >"$OUT/pvc-before.txt"
kubectl -n "$NS" get pod -o wide >"$OUT/pods-before.txt"

# Filter with labels from the current instance; do not assume Pod names.
kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-kafka" \
  -o wide
```

Confirm that:

- every PVC is `Bound` and is at least as large as the calculated requirement;
- persistent volumes and nodes are distributed as required by the test design;
- the StorageClass, volume type, file system, and node disks match the target environment;
- no node has sustained disk pressure and Kafka has no replicas awaiting recovery.

Storage latency is a primary Kafka constraint. A StorageClass name alone does not prove storage equivalence. Also save the provisioner, media type, topology, and I/O latency and utilization during the test.

## 7. Create or Update the Kafka Instance

Create a dedicated instance in the product console, or update an existing dedicated test instance. Console fields can change between product versions. Treat the `RdsKafka` resource and generated Strimzi resources in the business cluster as the final state.

### 7.1 Topology

- Use at least 3 brokers.
- Distribute brokers across nodes and failure domains with Pod anti-affinity.
- Use the same metadata mode and role layout as production.
- Test the broker CPU and memory sizes in section 3 while keeping metadata-service resources fixed, so broker and metadata-service sizes do not change at the same time.
- Do not allow the Java Virtual Machine (JVM) heap limit to consume all container memory. Reserve memory for page cache and non-heap memory in the container.

> Kafka relies on the operating system page cache. Increasing the JVM heap does not increase cache available to Kafka. A heap configured too close to the container limit can reduce page-cache capacity. Out of memory (OOM) can also terminate the container.

For KRaft, match the production use of dedicated controllers or combined controller/broker roles and state the role layout in the report. Keep controller count, resources, and storage fixed while testing broker sizes.

For ZooKeeper mode:

- use an odd number of ZooKeeper replicas, with at least 3 for a production-representative test;
- spread ZooKeeper replicas across nodes and failure domains with Pod anti-affinity;
- use persistent, low-latency block storage and keep ZooKeeper resources, JVM options, storage, and configuration fixed;
- record which broker is the active Kafka controller, but do not describe a ZooKeeper Pod as a Kafka controller;
- preserve the production colocation policy between brokers and ZooKeeper Pods.

After submitting the console form, verify the following KRaft fields against the current `RdsKafka` custom resource definition (CRD). Do not infer the effective configuration from displayed console values:

| `RdsKafka` field | Standard test requirement |
| --- | --- |
| `spec.mode` | `KRaft` |
| `spec.replicas` | 3 brokers |
| `spec.resources.requests/limits` | Current matrix size; record both requests and limits |
| `spec.storage.class` | Customer-selected and qualified StorageClass |
| `spec.storage.size` | At least the value calculated in section 6 |
| `spec.storage.deleteClaim` | Select according to data-retention and destruction requirements; do not set it to `true` only to simplify cleanup |
| `spec.controller` | Roles, count, resources, and storage match the production plan; use at least 3 voting nodes for dedicated controllers |
| `spec.config` | Exported `general-kafka` baseline plus the one parameter changed in this run |
| `spec.kafka.listeners` | Matches the in-cluster or external access path for this run |
| `spec.kafkaExporter` | Enabled when consumer group lag is required, with topic and group regular expressions limited to the test scope |

```bash
kubectl explain rdskafka.spec --recursive \
  >"$OUT/rdskafka-spec-schema.txt"
```

For a ZooKeeper-based instance, also verify these fields in the generated `Kafka` resource. Field availability is determined by the installed CRD:

| Generated `Kafka` field | Standard test requirement |
| --- | --- |
| `spec.kafka.version` | Installed and supported Kafka version; keep fixed |
| `spec.kafka.replicas` | 3 brokers |
| `spec.kafka.resources` | Current matrix size; record requests and limits |
| `spec.kafka.storage` | Qualified persistent block storage sized by section 6 |
| `spec.kafka.config` | Frozen broker baseline; record `inter.broker.protocol.version` and `log.message.format.version` when present |
| `spec.zookeeper.replicas` | Odd count, with at least 3 for a production-representative test |
| `spec.zookeeper.resources` | Fixed requests and limits |
| `spec.zookeeper.storage` | Persistent, low-latency block storage with a fixed type, class, and size |
| `spec.zookeeper.jvmOptions` | Fixed heap and JVM settings |
| `spec.zookeeper.config` | Frozen ZooKeeper configuration |
| `spec.zookeeper.metricsConfig` | Java Management Extensions (JMX) Prometheus Exporter mapping enabled for the test |
| `spec.kafkaExporter` | Enabled when consumer group lag is required, with topic and group regular expressions limited to the test scope |

Do not apply KRaft-only fields such as `spec.mode`, `spec.controller`, or `KafkaNodePool` to a legacy ZooKeeper-based resource.

### 7.2 Fixed variables

Change only one evaluated variable in each test cycle. Keep the following fixed and record them in the report:

- Kafka and operator versions and metadata mode;
- KRaft role placement and broker/controller counts, or ZooKeeper replica count and active broker-controller state;
- broker, controller, and ZooKeeper CPU, memory, JVM heap, node selection, and anti-affinity, as applicable;
- StorageClass, PVC size, and storage media;
- complete broker-configuration snapshot;
- topic partitions, replication factor, and `min.insync.replicas`;
- client image version, resources, node location, and connection security;
- message size, record count, compression, key distribution, acknowledgments, and consumer parameters.

Save the final instance state:

```bash
kubectl -n "$NS" get rdskafka "$CLUSTER" -o yaml \
  >"$OUT/rdskafka.yaml"
kubectl -n "$NS" get kafka "$CLUSTER" -o yaml \
  >"$OUT/kafka.yaml"
kubectl -n "$NS" get pod,pvc,service -o wide \
  >"$OUT/workloads-before.txt"
```

For KRaft, also save the node pools:

```bash
kubectl -n "$NS" get kafkanodepool \
  -l "strimzi.io/cluster=${CLUSTER}" -o yaml \
  >"$OUT/kafkanodepools.yaml"
```

For ZooKeeper mode, save both generated StatefulSets and the ZooKeeper Pods:

```bash
kubectl -n "$NS" get statefulset \
  "${CLUSTER}-kafka" "${CLUSTER}-zookeeper" -o yaml \
  >"$OUT/kafka-zookeeper-statefulsets.yaml"
kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-zookeeper" -o wide \
  >"$OUT/zookeeper-pods-before.txt"
```

If any collection command fails, stop and investigate permissions, resource names, or instance status. Do not conceal the error with `|| true`.

### 7.3 Monitoring options

Enable the Kafka metrics collection provided by the platform when creating the instance. If consumer group lag is required, also enable Kafka Exporter and limit its topic and consumer-group regular expressions to this test. Before starting the load test, check the final resources and Exporter Pod:

```bash
kubectl -n "$NS" get rdskafka "$CLUSTER" \
  -o jsonpath='{.spec.kafkaExporter}' \
  >"$OUT/rdskafka-kafka-exporter.json"
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.metricsConfig}' \
  >"$OUT/kafka-metrics-config.json"
kubectl -n "$NS" get pod \
  -l "strimzi.io/cluster=${CLUSTER},strimzi.io/name=${CLUSTER}-kafka-exporter" \
  -o wide
```

For ZooKeeper mode, also save its metrics configuration and confirm that all ensemble Pods exist:

```bash
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.zookeeper.metricsConfig}' \
  >"$OUT/zookeeper-metrics-config.json"
kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-zookeeper" -o wide
```

If the last command finds no Pod, Kafka Exporter is disabled or the current version uses different labels. Check `RdsKafka`, the generated `Kafka` resource, and actual Pod labels. Do not interpret an empty result as zero lag.

## 8. Deploy Load-Test Clients

### 8.1 Reuse the instance Kafka image

Read the Kafka image used by the operator from a broker Pod. This keeps the script version aligned with the server version without exposing an image-registry address in an external document.

```bash
export KAFKA_IMAGE="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-kafka" \
  -o jsonpath='{.items[0].spec.containers[?(@.name=="kafka")].image}')"

test -n "$KAFKA_IMAGE"
export BOOTSTRAP="${CLUSTER}-kafka-bootstrap.${NS}.svc:9092"
```

The Service name follows the Strimzi internal bootstrap Service convention, but query the current instance to verify the listener, port, and authentication method:

```bash
kubectl -n "$NS" get service -l "strimzi.io/cluster=${CLUSTER}" -o wide
kubectl -n "$NS" get kafka "$CLUSTER" \
  -o jsonpath='{.spec.kafka.listeners}' >"$OUT/listeners.json"
```

The following examples use a plaintext internal listener in an isolated namespace. For TLS/SASL, put all client properties in an access-controlled Secret and mount it as a read-only volume. Do not pass passwords as command-line arguments.

### 8.2 Create client properties

```bash
kubectl -n "$NS" create configmap kafka-perf-client-config \
  --from-literal=admin.properties='' \
  --from-literal=producer.properties='acks=all
enable.idempotence=true
batch.size=50000
linger.ms=5
compression.type=none
buffer.memory=134217728' \
  --from-literal=consumer.properties='auto.offset.reset=earliest
fetch.min.bytes=1
fetch.max.wait.ms=500
max.partition.fetch.bytes=1048576
fetch.max.bytes=52428800' \
  --dry-run=client -o yaml | kubectl apply -f -
```

When authentication is enabled, prepare complete `producer.properties` and `consumer.properties` files containing the performance and connection properties in a controlled local directory. Use a Secret instead of the ConfigMap:

```bash
kubectl -n "$NS" create secret generic kafka-perf-client-config \
  --from-file=admin.properties=/secure/path/admin.properties \
  --from-file=producer.properties=/secure/path/producer.properties \
  --from-file=consumer.properties=/secure/path/consumer.properties \
  --dry-run=client -o yaml | kubectl apply -f -
```

Also replace the `configMap` volume sources in both Pods in section 8.3 with:

```yaml
secret:
  secretName: kafka-perf-client-config
```

`admin.properties` contains only connection-security properties required by administrative scripts. The producer and consumer files separately contain their performance properties. `security.protocol`, SASL, and SSL settings must match the instance listener. Store only redacted copies in the report and evidence directory. Do not export Secrets, passwords, tokens, private keys, or unredacted Java Authentication and Authorization Service (JAAS) configuration.

### 8.3 Create client Pods

```bash
kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: kafka-producer-perf
  labels:
    app: kafka-perf
    role: producer
spec:
  restartPolicy: Never
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: strimzi.io/cluster
                operator: In
                values: ["${CLUSTER}"]
          topologyKey: kubernetes.io/hostname
  containers:
    - name: kafka
      image: ${KAFKA_IMAGE}
      command: ["sh", "-c", "sleep infinity"]
      resources:
        requests: {cpu: "1", memory: 2Gi}
        limits: {cpu: "1", memory: 2Gi}
      volumeMounts:
        - name: config
          mountPath: /opt/perf-config
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: kafka-perf-client-config
---
apiVersion: v1
kind: Pod
metadata:
  name: kafka-consumer-perf
  labels:
    app: kafka-perf
    role: consumer
spec:
  restartPolicy: Never
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: strimzi.io/cluster
                operator: In
                values: ["${CLUSTER}"]
          topologyKey: kubernetes.io/hostname
  containers:
    - name: kafka
      image: ${KAFKA_IMAGE}
      command: ["sh", "-c", "sleep infinity"]
      resources:
        requests: {cpu: "1", memory: 2Gi}
        limits: {cpu: "1", memory: 2Gi}
      volumeMounts:
        - name: config
          mountPath: /opt/perf-config
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: kafka-perf-client-config
EOF

kubectl -n "$NS" wait --for=condition=Ready \
  pod/kafka-producer-perf pod/kafka-consumer-perf --timeout=300s
kubectl -n "$NS" get pod -l app=kafka-perf -o wide
```

If the cluster has no nodes separate from all brokers, `required` anti-affinity leaves the client Pods Pending. Add dedicated load-test nodes. Change the rule to `preferred` only when no nodes can be added and the resource-contention bias is explicitly accepted, then record that limitation in the report.

If a Pod reports `ImagePullBackOff`, use `kubectl describe pod` to inspect the cause, then check the broker Pod's `spec.imagePullSecrets` and service account. If a pull Secret is required, reference an approved Secret in the client Pod's `spec.imagePullSecrets`. Do not put registry passwords in the document, command line, or test report.

The initial client limit of 1 vCPU / 2 GiB is not a capacity limit. If client CPU approaches the limit, a node network interface reaches capacity, CPU throttling occurs, or garbage collection becomes abnormal, increase client resources or client Pods before attributing the bottleneck to Kafka.

### 8.4 Record script versions and interfaces

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh --version \
  | tee "$OUT/kafka-client-version.txt"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh --help \
  >"$OUT/producer-perf-help.txt" 2>&1

kubectl -n "$NS" exec kafka-consumer-perf -- \
  /opt/kafka/bin/kafka-consumer-perf-test.sh --help \
  >"$OUT/consumer-perf-help.txt" 2>&1
```

If Kafka is installed at a path other than `/opt/kafka` in the image, confirm the path from the image documentation or broker container environment and update the commands. Do not mix in scripts downloaded from an unknown version.

### 8.5 Legacy Kafka 2.x script compatibility

The ZooKeeper-based operator line uses Kafka 2.x client scripts whose interfaces differ from the Kafka 4.2 examples. The reviewed legacy scripts have these differences:

| Operation | Kafka 4.2 example in this guide | Legacy Kafka 2.x form |
| --- | --- | --- |
| Producer bootstrap and property file | `--bootstrap-server` and `--command-config` | Put `bootstrap.servers=$BOOTSTRAP` in the property file and use `--producer.config` |
| Producer warmup | `--warmup-records` | No equivalent option in the reviewed scripts; run a separate, predefined warmup cycle |
| Producer interval option | `--reporting-interval` | Not exposed by the reviewed producer script; preserve its raw interval output |
| Producer property override | `--command-property` | Use a separate complete `--producer.config` file |
| Consumer record target | `--num-records` | `--messages` |
| Consumer property file | `--command-config` | `--consumer.config` |
| Consumer concurrency | One process per consumer | Use one process per consumer for cross-version consistency |

Some earlier Kafka 2.x scripts implement `--threads`, while later Kafka 2.x scripts accept it but ignore it. Never use `--threads` to establish the standard concurrency point. Use independent processes or Pods and verify the actual consumer group membership.

For a legacy test, add the resolved bootstrap address to the producer property file before creating the ConfigMap or Secret:

```properties
bootstrap.servers=perf-kafka-kafka-bootstrap.kafka-perf.svc:9092
```

Replace the example value with the resolved value of `$BOOTSTRAP`; property files do not expand shell variables. Store connection-security properties in the same protected file when authentication is enabled.

## 9. Create and Verify the Test Topic

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --create --if-not-exists \
  --topic "$TOPIC" \
  --partitions 30 \
  --replication-factor 3 \
  --config min.insync.replicas=2

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --topic "$TOPIC" \
  | tee "$OUT/topic-before.txt"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --entity-type topics --entity-name "$TOPIC" --describe \
  | tee "$OUT/topic-config.txt"
```

Before starting, confirm that:

- `PartitionCount=30` and `ReplicationFactor=3`;
- every partition has 3 replicas and an ISR count of 3;
- leaders are not materially imbalanced across brokers;
- the dynamic topic configuration contains `min.insync.replicas=2`;
- the topic is new for this run or has been cleaned according to the test design, and the consumer group name has not been reused.

## 10. Run One Test Point

### 10.1 Production reliability baseline

Record the parameters before execution. The example is a functional check with 1,000,000 records of 500 B each. For a formal standard point, replace `--num-records` and ensure the PVC is large enough.

```bash
export NUM_RECORDS=1000000
export RECORD_SIZE=500

kubectl -n "$NS" exec kafka-producer-perf -- sh -c \
  "cat /opt/perf-config/producer.properties" \
  >"$OUT/producer.properties"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --num-records "$NUM_RECORDS" \
  --record-size "$RECORD_SIZE" \
  --throughput -1 \
  --warmup-records 100000 \
  --reporting-interval 5000 \
  --command-config /opt/perf-config/producer.properties \
  --print-metrics \
  | tee "$OUT/producer-${RECORD_SIZE}B.txt"
```

`--throughput -1` disables client-side throttling and searches for the limit at the current client concurrency. It does not prove that the brokers are saturated; evaluate client and broker metrics together. Keep `--warmup-records` fixed in formal comparisons and use only the script's steady-state summary. Do not include warmup in the result.

For a legacy ZooKeeper-based instance, use the same payload and producer properties with the legacy interface:

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh \
  --topic "$TOPIC" \
  --num-records "$NUM_RECORDS" \
  --record-size "$RECORD_SIZE" \
  --throughput -1 \
  --producer.config /opt/perf-config/producer.properties \
  --print-metrics \
  | tee "$OUT/producer-${RECORD_SIZE}B.txt"
```

Run a separate, fixed warmup cycle before the measured legacy command. Do not count its records in the test target, and use a fresh topic or account explicitly for warmup data before a consumer-only test.

### 10.2 Leader acknowledgment ceiling

Keep all other properties unchanged and override only acknowledgment and idempotence:

```properties
acks=1
enable.idempotence=false
batch.size=50000
linger.ms=5
compression.type=none
buffer.memory=134217728
```

Kafka 4.2 can override these two values from the property file with `--command-property`, avoiding accidental changes to other parameters:

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-producer-perf-test.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --num-records "$NUM_RECORDS" \
  --record-size "$RECORD_SIZE" \
  --throughput -1 \
  --warmup-records 100000 \
  --reporting-interval 5000 \
  --command-config /opt/perf-config/producer.properties \
  --command-property acks=1 \
  --command-property enable.idempotence=false \
  --print-metrics \
  | tee "$OUT/producer-leader-ack-${RECORD_SIZE}B.txt"
```

Label the result `leader-ack`. Do not compare it directly with `acks=all` capacity.

For a legacy client, create a separate `producer-leader-ack.properties` file containing the same properties as the baseline except for `acks=1` and `enable.idempotence=false`, then pass it with `--producer.config`. Save a redacted diff between the two files. Do not use an unsupported `--command-property` option.

### 10.3 Consumer-only test

Before a consumer-only test, load at least `NUM_RECORDS` records and use a new consumer group:

```bash
export NUM_RECORDS=1000000
export RECORD_SIZE=500
export GROUP="perf-consumer-$(date -u +%Y%m%dT%H%M%SZ)"

kubectl -n "$NS" exec kafka-consumer-perf -- sh -c \
  "cat /opt/perf-config/consumer.properties" \
  >"$OUT/consumer.properties"

kubectl -n "$NS" exec kafka-consumer-perf -- \
  /opt/kafka/bin/kafka-consumer-perf-test.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --group "$GROUP" \
  --num-records "$NUM_RECORDS" \
  --fetch-size 200000 \
  --timeout 60000 \
  --show-detailed-stats \
  --reporting-interval 5000 \
  --command-config /opt/perf-config/consumer.properties \
  --print-metrics \
  | tee "$OUT/consumer-${RECORD_SIZE}B.txt"
```

In Kafka 4.2, `--messages` is deprecated; use `--num-records`. `--fetch-size` limits the data fetched from one partition in one request, and the `max.partition.fetch.bytes` client property also applies. Save `records-consumed-total` from the `--print-metrics` output and confirm that the consumer read the target count. A timeout, insufficient topic data, or authorization error can make the script exit early, so do not rely only on the final throughput line.

For a legacy ZooKeeper-based instance, use `--messages` and `--consumer.config`:

```bash
kubectl -n "$NS" exec kafka-consumer-perf -- \
  /opt/kafka/bin/kafka-consumer-perf-test.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --group "$GROUP" \
  --messages "$NUM_RECORDS" \
  --fetch-size 200000 \
  --timeout 60000 \
  --show-detailed-stats \
  --reporting-interval 5000 \
  --consumer.config /opt/perf-config/consumer.properties \
  --print-metrics \
  | tee "$OUT/consumer-${RECORD_SIZE}B.txt"
```

The legacy script reports messages rather than records in some headings. Preserve its original output labels and normalize only in separate report fields.

### 10.4 Concurrent produce and consume

1. Start consumers with a new consumer group and confirm that they have joined the group.
2. Start producers.
3. Collect metrics throughout the steady-state window.
4. After producers stop, keep consumers running until lag reaches zero or a predefined timeout expires.
5. Save the final consumer position and log end offset (LEO).

Do not run one consumer command in the foreground and then attempt to start the producer in the same terminal. Use two terminals, or start both through Jobs or a test orchestrator and save their standard output separately. Any background execution method must preserve process exit codes. Log files alone do not prove that commands succeeded.

### 10.5 Example with 20 consumers on Kafka 4.2

This example starts 20 independent consumer processes in one client Pod and checks every `kubectl exec` exit code. Before a formal test, use section 12.1 to confirm that Pod CPU, memory, and network are not bottlenecks. If resources are insufficient, replicate the consumer Pod from section 8.3 and distribute the processes across load-test nodes.

```bash
export CONSUMER_COUNT=20
export CONSUMER_POD=kafka-consumer-perf
export GROUP="perf-consumer-20-$(date -u +%Y%m%dT%H%M%SZ)"
test "$NUM_RECORDS" -ge "$CONSUMER_COUNT"

q=$((NUM_RECORDS / CONSUMER_COUNT))
r=$((NUM_RECORDS % CONSUMER_COUNT))
pids=()

for ((i = 1; i <= CONSUMER_COUNT; i++)); do
  process_records="$q"
  if ((i <= r)); then
    process_records=$((q + 1))
  fi

  kubectl -n "$NS" exec "$CONSUMER_POD" -- \
    /opt/kafka/bin/kafka-consumer-perf-test.sh \
    --bootstrap-server "$BOOTSTRAP" \
    --topic "$TOPIC" \
    --group "$GROUP" \
    --num-records "$process_records" \
    --fetch-size 200000 \
    --timeout 60000 \
    --reporting-interval 5000 \
    --command-config /opt/perf-config/consumer.properties \
    --command-property "client.id=perf-consumer-${i}" \
    --print-metrics \
    >"$OUT/consumer-${i}-${RECORD_SIZE}B.txt" 2>&1 &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
test "$failed" -eq 0
```

Sum the actual records consumed across all 20 files and confirm the total equals `NUM_RECORDS`. Calculate aggregate throughput as total records or bytes divided by the common measurement window. If process start and end times differ, do not add the individual average rates. A timeout, nonzero exit, or record-count mismatch in any process invalidates the test point.

For legacy Kafka 2.x, use the same 20-process allocation but replace `--num-records` with `--messages` and `--command-config` with `--consumer.config`. Do not add `--threads`; on later Kafka 2.x scripts it is deprecated and ignored.

## 11. Client Parameter Reference

### 11.1 Producer

| Parameter | Standard value | Mechanism and boundary |
| --- | ---: | --- |
| `--num-records` | See the matrix | Records sent; total payload is approximately this value multiplied by `--record-size` |
| `--record-size` | 100/500/1000 | Bytes in the synthetic record value; mutually exclusive with a message payload file |
| `--throughput` | `-1` | Unthrottled limit search; for controlled load, set the target records/s |
| `--warmup-records` | Fixed value | Kafka 4.2 option that excludes connection setup, metadata, and JVM warmup; use a separate fixed warmup cycle on the reviewed legacy scripts |
| `acks` | `all` or `1` | Acknowledgment strength; changing it changes reliability and performance semantics |
| `enable.idempotence` | `true` | Prevents duplicates caused by retries; requires compatible acknowledgments, retries, and in-flight request settings |
| `batch.size` | `50000` | Target maximum batch size per partition; a large value can increase memory use and wait time |
| `linger.ms` | `5` | Maximum wait for batching; Kafka 4.x defaults differ from earlier versions, so set it explicitly |
| `compression.type` | `none` | The standard matrix disables compression; use the production algorithm in the application matrix and record CPU and measured compression ratio |
| `buffer.memory` | `134217728` | Total producer memory available for records waiting to be sent; not the complete container-memory requirement |

Each partition has an independent batch. More producers, partitions, batch capacity, or linger time can improve batching but can also increase memory use and latency. Attribute a result to a parameter only when all other variables remain fixed.

### 11.2 Consumer

| Parameter | Standard value | Mechanism and boundary |
| --- | ---: | --- |
| `--group` | Unique per run | Consumers in the same group share partitions; a reused group can start at old offsets |
| `--num-records` or legacy `--messages` | Matches preloaded data | Planned total records; select the version-supported option and verify the actual value with client metrics |
| `--fetch-size` | `200000` | Per-partition fetch size passed by the script |
| `--timeout` | `60000` | Maximum time between returned records, not total test duration; a timeout makes the tool exit early with a warning |
| `fetch.min.bytes` | `1` | Minimum data before the broker returns a Fetch response; increasing it can improve batching but can add wait latency |
| `fetch.max.wait.ms` | `500` | Maximum wait when `fetch.min.bytes` has not been reached |
| `max.partition.fetch.bytes` | `1048576` | Per-partition limit for one Fetch response; it must accommodate the maximum record batch allowed by the broker |
| `fetch.max.bytes` | `52428800` | Overall limit for one Fetch response, still subject to server and partition limits |

Effective parallelism in one consumer group cannot exceed the number of assignable partitions. This guide uses one consumer per script process in every Kafka version. To run 2, 4, or 8 consumers, create independent Pods or processes with identical properties and the same consumer group. Consumers beyond the partition count receive no partitions.

`NUM_RECORDS` in the matrix is the aggregate target across all processes, not a per-process target. With concurrency `C`, set `q=NUM_RECORDS/C` and `r=NUM_RECORDS%C`. Give `q+1` records to the first `r` processes and `q` to the remainder, so the targets sum to `NUM_RECORDS`. Use the same allocation for multi-producer tests. If every process produces or consumes all `NUM_RECORDS`, the total data volume has changed and the result cannot be compared directly with the single-process point.

## 12. Find the Saturation Point and Usable Capacity

### 12.1 Exclude client limits first

Probe producers and consumers separately with 1, 2, 4, and 8 independent client processes. For the standard consumer point, continue to 12, 16, and 20 unless partition parallelism or a resource limit is reached first. Distribute clients across load-test nodes when possible, use identical properties for each process, and aggregate process throughput. At each increase in concurrency, check at least:

- client Pod CPU, memory, CPU throttling, network, and restart count;
- broker CPU, memory, network, disk latency, and disk utilization;
- request errors, timeouts, retries, and produce acknowledgment latency;
- `UnderReplicatedPartitions`, `UnderMinIsrPartitionCount`, and consumer group lag;
- partition leaders, log bytes, and traffic balance across brokers;
- for ZooKeeper mode, ZooKeeper Pod CPU, memory, disk latency and utilization, request latency, outstanding requests, quorum size, and broker ZooKeeper session state.

If throughput continues to increase materially after client resources or processes are added, the prior result was a client limit and must not be reported as the Kafka limit. If the network interface on one load-test node is saturated, add client nodes instead of adding more processes on that node.

### 12.2 Two-phase load staircase

1. **Unthrottled probe:** Use `--throughput -1` and increase client processes to establish an achievable throughput range.
2. **Controlled-load validation:** Starting from the unthrottled result, apply approximately 25%, 50%, 75%, 90%, 100%, and 110% target throughput. The sum of `--throughput` across all producers equals the target for that point.
3. Warm up each point, then maintain steady state for at least 10 minutes. Afterward, wait for lag to reach zero and verify replica health.
4. Add denser test points near 90%. Repeat both the last stable point and first unstable point at least three times.
5. Randomize repeat order or rerun the baseline to detect thermal effects, cache state, noisy neighbors, and time drift.

The percentages are only a starting strategy for finding the range; they are not product thresholds. If the first load point violates a health condition, reduce the load and re-establish the range.

### 12.3 Define acceptance criteria in advance

Before testing, the customer must set these thresholds from the service level objective (SLO) for the application:

- p95 and p99 produce acknowledgment latency;
- error, timeout, and retry rates;
- maximum consumer lag and drain time;
- resource-utilization limits for brokers, clients, nodes, and PVCs;
- permitted `UnderReplicatedPartitions` and `UnderMinIsrPartitionCount`, normally both always zero;
- for ZooKeeper mode, stable ensemble membership, exactly one active Kafka controller, acceptable ZooKeeper request latency, no sustained growth in outstanding requests, and no broker ZooKeeper session loss;
- steady-state window and repeat count.

If the customer has no thresholds, use the following as engineering rules for this test and label them as test rules, not official Kafka thresholds:

- after a load or concurrency increase, aggregate throughput improves by less than 5% for two consecutive steps; and
- p99 latency, errors/timeouts, lag, or resource utilization continues to worsen; or
- `UnderReplicatedPartitions>0`, `UnderMinIsrPartitionCount>0`, an offline log directory, a Pod restart, or disk pressure occurs; or
- in ZooKeeper mode, ensemble membership changes, the sum of `ActiveControllerCount` across brokers differs from 1, a broker loses its ZooKeeper session, or ZooKeeper request latency or outstanding requests breach the predefined test threshold.

The first point meeting the combined conditions is the **saturation point**. The last point before saturation that satisfies all SLOs, has stable repeat results, and has no health anomaly is the **usable capacity**. Do not substitute an instantaneous maximum for usable capacity.

Report repeat variability. By default, use the median as the center and also report the minimum, maximum, and coefficient of variation. If throughput at one test point has a coefficient of variation greater than 5%, investigate environmental drift and add repetitions. The 5% value is also a rule for this test, not a Kafka guarantee.

## 13. Instance Parameter Tuning

Complete one run with the template baseline, then change one parameter at a time in response to monitoring evidence. The following entries are diagnostic directions, not fixed optimal values.

| Parameter or resource | When to consider a change | Validation | Risk and stop condition |
| --- | --- | --- | --- |
| Broker CPU | Request-processing threads are busy, CPU remains near its constraint, and clients are not saturated | Add CPU and repeat the same load | If throughput does not improve while disk or network is full, more CPU will not help |
| Broker memory/JVM heap | Container memory pressure, frequent garbage collection (GC), or insufficient page cache | Observe heap, GC, resident set size (RSS), working set, and disk reads together | An oversized heap displaces page cache; a heap too close to the container limit can cause an out-of-memory (OOM) event |
| `num.network.threads` | `NetworkProcessorAvgIdlePercent` remains low and CPU headroom exists | Increase in small steps and repeat the same point | More threads add scheduling and memory overhead and cannot fix a saturated network interface |
| `num.io.threads` | `RequestHandlerAvgIdlePercent` remains low and disk and CPU headroom exist | Increase in small steps and compare request wait and throughput | Cover at least the number of data volumes; too many threads can increase context switching and I/O contention |
| `num.replica.fetchers` | Replicas catch up slowly and replication traffic has unused resources | Validate during controlled recovery or high replication load | More fetchers increase network, disk, and CPU use |
| `num.recovery.threads.per.data.dir` | Startup or recovery is too slow | Validate in a controlled recovery test | Faster recovery increases interference with foreground I/O |
| Topic partition count | Per-partition throughput is limiting and enough consumer concurrency exists | Compare new topics with different partition counts | More partitions change key-ordering scope and add metadata and replica overhead; partitions cannot be reduced arbitrarily |
| Broker count | A broker has reached its resource constraint and horizontal scaling is required | Scale out, wait for replica reassignment to finish, then retest | Adding brokers alone does not rebalance existing partition data; results during reassignment are invalid |
| `message.max.bytes` | The largest application record batch exceeds the default | Check topic, producer, and consumer fetch limits together | A larger value increases memory and network bursts; inconsistent settings cause produce or consume failures |
| Retention and log-segment parameters | Disk use, deletion granularity, or recovery time does not meet requirements | Test retention and deletion behavior over a long interval | Do not change production retention only to improve a short benchmark |
| ZooKeeper CPU, memory, or JVM heap | ZooKeeper request latency or outstanding requests rise while storage has headroom | Change one resource dimension and repeat the same metadata and traffic load | Oversized heap can increase pause time; resource changes invalidate direct comparison unless they are the tested variable |
| ZooKeeper storage | Request latency correlates with disk latency, queue depth, or synchronous-write pressure | Qualify lower-latency persistent block storage in a separate instance | A storage-class or media change creates a new environment baseline; do not present it as a broker-only tuning gain |
| ZooKeeper replica count | Availability requirements or production topology require a different odd-sized ensemble | Validate quorum health and failover outside the measured capacity window | Replica count is not a routine throughput knob; an even count adds no failure tolerance over the preceding odd count and reconfiguration invalidates the measurement window |

For Apache Kafka thread-idle metrics, a value closer to zero means the threads are busier. If `NetworkProcessorAvgIdlePercent` or `RequestHandlerAvgIdlePercent` remains below approximately 0.3, evaluate CPU, network, and storage together for insufficient processing capacity. This value is a diagnostic signal, not an independent scaling trigger.

After each change:

1. Save the complete configuration diff before and after the change.
2. Apply a rolling restart or dynamic update according to the installed product version.
3. Wait until Kafka resources are Ready and the ISR is complete. For KRaft, wait for stable controller quorum and NodePool status. For ZooKeeper mode, wait for all ZooKeeper Pods, stable ensemble membership, connected broker sessions, and exactly one active Kafka controller.
4. Repeat the test at least three times with the same topic data state, client concurrency, and load.
5. Return to the previous validated configuration if the gain is unstable or health metrics deteriorate.

## 14. Monitoring and Evidence Collection

### 14.1 Kafka health checks

Run these checks before the test, during the steady-state window, and after the test. Discover a broker Pod by label:

```bash
export BROKER_POD="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-kafka" \
  -o jsonpath='{.items[0].metadata.name}')"
test -n "$BROKER_POD"
```

For KRaft, record controller-quorum status:

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-metadata-quorum.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  describe --status \
  | tee "$OUT/metadata-quorum-after.txt"
```

For ZooKeeper mode, `kafka-metadata-quorum.sh` is not applicable. Record the generated StatefulSets, every ZooKeeper Pod, and current resource status instead:

```bash
kubectl -n "$NS" get statefulset \
  "${CLUSTER}-kafka" "${CLUSTER}-zookeeper" -o wide \
  | tee "$OUT/kafka-zookeeper-statefulsets-after.txt"
kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-zookeeper" -o wide \
  | tee "$OUT/zookeeper-pods-after.txt"
kubectl -n "$NS" get kafka "$CLUSTER" -o yaml \
  >"$OUT/kafka-resource-after.yaml"
```

Run these broker and topic checks in both metadata modes:

```bash
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --under-replicated-partitions \
  | tee "$OUT/under-replicated-after.txt"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --group "$GROUP" \
  | tee "$OUT/consumer-group-after.txt"

kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-log-dirs.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --describe --topic-list "$TOPIC" \
  >"$OUT/log-dirs-after.txt"
```

`--under-replicated-partitions` can produce no output in a healthy state. Also save its exit code, or have the orchestrator record successful completion, so a connection failure is not misclassified as no under-replicated partitions.

`kafka-log-dirs.sh` prints status text before its JSON data, so the example saves raw text. Before parsing it programmatically, validate and remove the non-JSON prefix. Do not pass the whole file directly to a JSON parser.

### 14.2 Required Kafka metrics

The following Java Management Extensions (JMX) managed beans (MBeans), or their Prometheus mappings, must cover the complete steady-state window:

| Category | Metric or JMX MBean | Purpose |
| --- | --- | --- |
| Write/read | `BytesInPerSec`, `BytesOutPerSec`, `MessagesInPerSec` | Cross-check client throughput |
| Replica health | `UnderReplicatedPartitions`, `UnderMinIsrPartitionCount` | The first shows ISR count below the configured replication factor; the second shows ISR count below `min.insync.replicas` |
| Log directory | `OfflineLogDirectoryCount` | Detect unavailable storage directories |
| Network threads | `NetworkProcessorAvgIdlePercent` | Determine network-processor thread utilization |
| Request threads | `RequestHandlerAvgIdlePercent` | Determine request-handler thread utilization |
| Request latency | Produce/Fetch `TotalTimeMs`, `RequestQueueTimeMs`, `LocalTimeMs`, `RemoteTimeMs`, `ResponseQueueTimeMs`, and `ResponseSendTimeMs` | Identify the request stage where time is spent |
| Consumer group | Current position, LEO, per-partition lag, and total lag | Determine whether consumers keep up with production |
| ZooKeeper-mode controller | `ActiveControllerCount`, `OfflinePartitionsCount`, and leader-election metrics | Confirm that exactly one broker is the active controller and detect controller or partition instability |
| ZooKeeper-mode broker session | `SessionState` | Detect a broker that is disconnected from ZooKeeper or has an expired session |

Prometheus metric names from JMX Exporter depend on the instance metric-mapping rules. Do not assume all environments use the same names. Save raw metrics from the broker `/metrics` endpoint and inspect the names first:

```bash
kubectl -n "$NS" exec "$BROKER_POD" -- \
  curl -fsS http://127.0.0.1:9404/metrics \
  >"$OUT/broker-jmx-metrics.txt"

grep -m 100 -E 'bytesin|bytesout|messagesin|underreplicated|underminisr|avgidle' \
  "$OUT/broker-jmx-metrics.txt"
```

If Kafka Exporter is enabled, discover its Pod and save its raw metrics:

```bash
export EXPORTER_PODS="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/cluster=${CLUSTER},strimzi.io/name=${CLUSTER}-kafka-exporter" \
  -o jsonpath='{.items[*].metadata.name}')"

if test -n "$EXPORTER_PODS"; then
  export EXPORTER_POD="${EXPORTER_PODS%% *}"
  kubectl -n "$NS" exec "$EXPORTER_POD" -- \
    curl -fsS http://127.0.0.1:9404/metrics \
    >"$OUT/kafka-exporter-metrics.txt"
else
  printf '%s\n' 'Kafka Exporter Pod not found' \
    >"$OUT/kafka-exporter-not-found.txt"
fi
```

Raw endpoint output proves only that the exporter exposes metrics; it does not prove that the platform is collecting time-series data. Before formal testing, query broker metrics for the last 15 minutes in platform monitoring or Prometheus and confirm continuous samples for every broker. If the query is empty or has collection gaps, stop the test and correct the ServiceMonitor or PodMonitor and metric mapping for the current platform. Selector labels depend on the current Prometheus configuration; do not copy labels from another cluster.

For ZooKeeper mode, enable the `spec.zookeeper.metricsConfig` mapping and collect at least:

| ZooKeeper evidence | Purpose |
| --- | --- |
| `QuorumSize` | Confirm the observed ensemble size remains equal to the configured replica count |
| `NumAliveConnections` | Detect connection loss or an unexpected connection increase |
| `OutstandingRequests` | Detect work arriving faster than a server can process it |
| `MinRequestLatency`, `AvgRequestLatency`, `MaxRequestLatency` | Correlate metadata-service latency with Kafka controller events and storage latency |
| `NodeCount` and `WatchCount` | Preserve metadata and watch-set scale for comparability |
| ZooKeeper Pod CPU, memory, restart count, JVM GC, and PVC usage | Exclude resource pressure and restarts |
| ZooKeeper volume latency, utilization, queue depth, and free space | Detect synchronous-write or storage-capacity constraints |

The exact Prometheus names depend on the installed mapping. In the reviewed legacy mapping they are lower-case names such as `zookeeper_quorumsize`, `zookeeper_numaliveconnections`, `zookeeper_outstandingrequests`, and `zookeeper_avgrequestlatency`. Confirm names from every ZooKeeper Pod's raw endpoint before querying them:

```bash
export ZOOKEEPER_PODS="$(kubectl -n "$NS" get pod \
  -l "strimzi.io/name=${CLUSTER}-zookeeper" \
  -o jsonpath='{.items[*].metadata.name}')"
test -n "$ZOOKEEPER_PODS"

for pod in $ZOOKEEPER_PODS; do
  kubectl -n "$NS" exec "$pod" -- \
    curl -fsS http://127.0.0.1:9404/metrics \
    >"$OUT/${pod}-jmx-metrics.txt"
done
```

Do not copy example alert thresholds into the capacity acceptance criteria. Establish a pre-test baseline and use the customer's SLOs. A request-latency increase, sustained outstanding-request growth, quorum change, broker session loss, or active-controller count other than one invalidates the point even when producer throughput remains high.

### 14.3 Kubernetes and infrastructure metrics

Collect at least the following time-series data rather than only a post-test snapshot:

- broker, controller, ZooKeeper, and client Pods, as applicable: CPU use, CPU throttling, memory working set, network transmit and receive, restarts, and OOM events;
- nodes: CPU, memory, network bandwidth and packet loss, disk throughput, input/output operations per second (IOPS), average and percentile latency, utilization, and queue depth;
- PVCs: used bytes, capacity, utilization, and growth rate;
- Kubernetes events, Pod placement, and resource requests and limits.

`kubectl top` provides only a near-real-time snapshot. Use it for a quick check, not as a substitute for a Prometheus range query:

```bash
kubectl -n "$NS" top pod --containers \
  | tee "$OUT/top-pods-after.txt"
kubectl -n "$NS" get events --sort-by=.lastTimestamp \
  >"$OUT/events.txt"
kubectl -n "$NS" get pod -o wide \
  >"$OUT/pods-after.txt"
kubectl -n "$NS" get pvc -o wide \
  >"$OUT/pvc-after.txt"
```

The following Prometheus Query Language (PromQL) expressions show calculation intent only. Inspect actual metric names and labels in the current Prometheus instance before replacing `$NS`, `$TOPIC`, `$GROUP`, and cluster labels. Save each expression, time range, step, and raw response.

```text
sum(rate(kafka_server_brokertopicmetrics_messagesin_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(rate(kafka_server_brokertopicmetrics_bytesin_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(rate(kafka_server_brokertopicmetrics_bytesout_total{namespace="$NS",topic="$TOPIC"}[5m]))

sum(kafka_server_replicamanager_underreplicatedpartitions{namespace="$NS"})

sum(kafka_server_replicamanager_underminisrpartitioncount{namespace="$NS"})

sum(kafka_controller_kafkacontroller_activecontrollercount{namespace="$NS"})

min(kafka_network_socketserver_networkprocessoravgidle_percent{namespace="$NS"})

min(kafka_server_kafkarequesthandlerpool_requesthandleravgidle_percent{namespace="$NS"})

sum(kafka_consumergroup_lag{namespace="$NS",consumergroup="$GROUP",topic="$TOPIC"})

sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="$NS",container!="",image!=""}[5m])
)

max by (pod) (
  container_memory_working_set_bytes{namespace="$NS",container!="",image!=""}
)

sum by (pod) (
  rate(container_network_receive_bytes_total{namespace="$NS"}[5m])
)

sum by (pod) (
  rate(container_network_transmit_bytes_total{namespace="$NS"}[5m])
)

kubelet_volume_stats_used_bytes{namespace="$NS"}
/
kubelet_volume_stats_capacity_bytes{namespace="$NS"}

max(zookeeper_quorumsize{namespace="$NS",strimzi_io_cluster="$CLUSTER"})

max(zookeeper_outstandingrequests{namespace="$NS",strimzi_io_cluster="$CLUSTER"})

max(zookeeper_avgrequestlatency{namespace="$NS",strimzi_io_cluster="$CLUSTER"})
```

CPU-throttling and node-disk metric names vary by container runtime, cgroup version, and monitoring stack. If the platform has no corresponding time series, add collection before testing or export equivalent evidence from the node runtime, cgroup, and storage system. Do not record an empty query as zero.

### 14.4 Redis or other related components

If the application path also includes Redis, use the same `RUN_ID`, UTC interval, and node-event record for Redis, and attach a separate Redis performance report. Kafka and Redis throughput, latency, and saturation points are different metrics. Do not combine them or infer causation from timing correlation alone. The Kafka report should retain only the related report link, versions, test interval, and verified dependency.

## 15. Result Summary and Validity Checks

### 15.1 Fields for each test point

Record at least:

```text
run_id,start_utc,end_utc,measurement_seconds,test_mode,reliability_profile,
kafka_version,operator_version,metadata_mode,kraft_roles,broker_count,controller_count,
zookeeper_replicas,broker_cpu,broker_memory,jvm_xms,jvm_xmx,storage_class,pvc_size,
topic,partitions,replication_factor,min_insync_replicas,
record_count_target,producer_records_sent,consumer_records_consumed,
record_size,compression,compression_ratio,key_distribution,
producer_processes,consumer_processes,acks,idempotence,batch_size,linger_ms,
throughput_target,fetch_min_bytes,fetch_max_wait_ms,max_partition_fetch_bytes,
producer_records_s,producer_mib_s,producer_avg_ms,producer_p50_ms,
producer_p95_ms,producer_p99_ms,producer_p999_ms,
consumer_records_s,consumer_mib_s,max_lag,final_lag,error_count,timeout_count,
broker_cpu_cores_max,broker_memory_bytes_max,broker_network_bps_max,pvc_used_bytes_max,
network_idle_min,request_idle_min,under_replicated_max,under_min_isr_max,
active_controller_count,zookeeper_quorum_size,zookeeper_request_latency_max,
zookeeper_outstanding_requests_max,zookeeper_pvc_used_bytes_max,
client_cpu_cores_max,client_cpu_throttling_ratio_max,result_valid,invalid_reason
```

Kafka script output uses the column label `MB/sec`. Preserve the original label in the report. To normalize the value to MiB/s, calculate actual payload bytes divided by seconds and by `2^20`, record the formula, and keep the original value. Do not only rename the column.

Resource peak fields record the maximum for one Pod or PVC by default. If a sum, average, or other aggregation is used, document the aggregation function, unit, interval, and sampling step in the field definition.

### 15.2 Requirements for a valid result

Mark a result `valid` only when all of the following are true:

- command exit codes are zero and producer and consumer record counts reach their targets;
- warmup and steady-state windows complete as planned and their clock intervals are explicit;
- Kafka, operator, metadata mode, configuration, topic, client, and infrastructure snapshots are complete;
- no broker, controller, ZooKeeper, or client Pod restart, OOM event, node pressure, volume anomaly, or unplanned maintenance occurs;
- `UnderReplicatedPartitions=0`, `UnderMinIsrPartitionCount=0`, and `OfflineLogDirectoryCount=0`;
- the production reliability baseline preserves `acks=all`, idempotence, and minimum ISR requirements;
- the client is not a confirmed bottleneck, or the result is explicitly labeled as a client limit;
- monitoring covers the complete steady-state window without collection gaps;
- in ZooKeeper mode, ensemble size is stable, the sum of `ActiveControllerCount` is 1, broker sessions remain connected, and ZooKeeper request latency and outstanding requests stay within the predefined test criteria;
- variation between repetitions is explained or uncertainty is retained in the conclusion.

Mark a result `invalid` and repeat the test if any of the following occur:

- the topic contains unknown data, a consumer group is reused, or the actual record count is insufficient;
- a rolling restart, reassignment, frequent partition-leader change, controller election, ZooKeeper ensemble reconfiguration, or replica catch-up occurs during the test;
- a PVC approaches capacity or storage or node pressure occurs;
- a client is CPU-throttled, network-saturated, or exits abnormally;
- more than one key variable changes between test points;
- only averages are available, without raw output, percentile latency, or time-series monitoring.

### 15.3 Writing conclusions

Separate conclusions into:

- **Facts:** Direct observations from raw output, configuration snapshots, and monitoring.
- **Inferences:** Bottleneck diagnoses supported by multiple metrics, including evidence against the diagnosis.
- **Recommendations:** The next tuning, scaling, or retest action.
- **Items to verify:** Conclusions that cannot yet be made because storage, network, production message model, or long steady-state evidence is missing.

Also report:

1. the last usable-capacity point that satisfies all SLOs;
2. the first unstable saturation point and its triggering conditions;
3. the median, range, and coefficient of variation from at least three repetitions;
4. the relative change from the baseline while holding reliability and environment constant;
5. applicability boundaries, especially the message model, storage, network, authentication, retention policy, and test duration.

## 16. Cleanup

Archive and verify `$OUT` before deleting resources dedicated to the run. Do not delete shared resources with ambiguous labels or wildcards.

```bash
# Delete only the dedicated topic created by this guide. Recheck its name first.
kubectl -n "$NS" exec kafka-producer-perf -- \
  /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --command-config /opt/perf-config/admin.properties \
  --delete --topic "$TOPIC"

kubectl -n "$NS" delete pod \
  kafka-producer-perf kafka-consumer-perf --ignore-not-found
kubectl -n "$NS" delete configmap \
  kafka-perf-client-config --ignore-not-found
kubectl -n "$NS" delete secret \
  kafka-perf-client-config --ignore-not-found
```

If the entire namespace was created for this run and contains no shared resources, delete it through the change process. Before deleting an instance or namespace, check PVC `deleteClaim` and the StorageClass reclaim policy and confirm that data retention or destruction meets requirements.

## 17. References

- [Apache Kafka 4.2 Broker Configuration](https://kafka.apache.org/42/configuration/broker-configs/)
- [Apache Kafka 4.2 Producer Configuration](https://kafka.apache.org/42/configuration/producer-configs/)
- [Apache Kafka 4.2 Consumer Configuration](https://kafka.apache.org/42/configuration/consumer-configs/)
- [Apache Kafka 4.2 Monitoring](https://kafka.apache.org/42/operations/monitoring/)
- [Apache Kafka 4.2 Hardware and Operating System](https://kafka.apache.org/42/operations/hardware-and-os/)
- [Apache Kafka 2.8 ZooKeeper Operations](https://kafka.apache.org/28/operations/zookeeper/)
- [Apache Kafka 2.8 Monitoring](https://kafka.apache.org/28/operations/monitoring/)
- [Strimzi 0.25 Deploying and Upgrading Guide](https://strimzi.io/docs/operators/0.25.0/deploying)
- [Strimzi 0.48 Deploying and Managing Guide](https://strimzi.io/docs/operators/0.48.0/deploying.html)
- [Prometheus Operator API Reference](https://prometheus-operator.dev/docs/api-reference/api/)
