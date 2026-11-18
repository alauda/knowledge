---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - "3.12"
  - "3.14"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
---

# Kafka config change does not roll brokers, a broker restart hangs, or the instance stays processing on ACP

## Issue

On a running Data Services Kafka instance:

- A parameter change saved on the Data Services page does not restart the broker pods, so the new configuration never takes effect. Restarting the cluster operator lets stop, start, and restart work again for a while. The operator log shows:

  ```text
  Failed to reconcile ... KafkaRoller$UnforceableProblem: Pod <cluster>-kafka-2 is currently not rollable
  Could not roll pod 2 due to ...ForceableProblem: Error getting broker config, retrying after at least 250ms
  <topic>/<partition> will be underreplicated (|ISR|=1 and min.insync.replicas=1) if broker 2 is restarted.
  ```

- A broker pod does not become ready after a restart, the instance reports `Error while trying to restart pod <cluster>-kafka-<n> to become ready`, and the operator shows `.status.phase (Failed) != Active` for the `RdsKafka`.
- After a node change, the instance stays in processing (`处理中`) although the Kafka pods have already moved to the new node.

Related articles: [Kafka broker memory looks high, or a memory change or new broker Pod is blocked by quota on ACP](Kafka_broker_memory_looks_high_or_a_memory_change_or_new_broker_Pod_is_blocked_by_quota_on_ACP.md) covers rollouts that fail with `exceeded quota`. A cluster operator stuck on `Reconciliation is in progress` with no ISR line is covered in [Kafka instance creation times out on the entity-operator, shows failed, or the cluster operator restarts on ACP](Kafka_instance_creation_times_out_on_the_entity-operator_shows_failed_or_the_cluster_operator_restarts_on_ACP.md). A broker that is down because its disk is full is covered in [Kafka broker PVC full or still too small after expansion on ACP](Kafka_broker_PVC_full_or_still_too_small_after_expansion_on_ACP.md).

## Root Cause

### Cause 1: Rolling restart blocked because ISR is at min.insync.replicas

The operator will not restart a broker if that would drop any partition below `min.insync.replicas`. When some partitions already have only one replica in ISR, and that replica is on the broker to be rolled, the `KafkaRoller` marks the pod `not rollable` and keeps retrying; `KafkaAvailability` lists the protected partitions with `will be underreplicated (|ISR|=1 and min.insync.replicas=1)`. `kafka-topics.sh --describe --topic __consumer_offsets` then shows partitions whose ISR is shorter than the replica list, for example `Replicas: 2,0,1 Isr: 2` and `Replicas: 1,0,2 Isr: 2,1`, while most partitions have all three in ISR. This was seen with Strimzi cluster operator 0.25.0 (the Kafka 2.7 and 2.8 era); the published procedure for this block is written for Kafka 2.7.0 and 2.8.2 on ACP 3.x (see [Resolve Kafka ISR Synchronization Issues That Block Broker Restart](ecosystem/kafka/Kafka_ISR_Synchronization_Issues.md)). Restarting the operator does not remove the ISR gap; restoring ISR does.

### Cause 2: A broker does not become ready after a restart and the topic-store changelog has no leader

On ACP 3.16.2 the instance logs repeat:

```text
Cannot get current offset of topic __strimzi-topic-operator-kstreams-topic-store-changelog partition 0: kafka server: In the middle of a leadership election, there is currently no leader for this partition and hence it is unavailable for writes
```

The stuck restart is attributed to that operator-internal changelog partition having no leader. Deleting the stuck broker pod so it starts again restores service.

### Cause 3: The datapool keeps the old node after Kafka has moved

After a node change, Kafka is rescheduled onto the new node, but the datapool pod is not: its node selector still names the old node, so it cannot schedule on the remaining nodes and the instance stays in processing. The datapool belongs to the MinIO component, and Kafka's scheduling change does not update MinIO.

## Resolution

### Cause 1: Rolling restart blocked because ISR is at min.insync.replicas

1. Confirm the log lines and the ISR gap:

   ```bash
   kubectl get pods -A -l strimzi.io/kind=cluster-operator
   kubectl -n <operator-namespace> logs deploy/<cluster-operator-deployment> --tail=500 | grep -E 'not rollable|will be underreplicated|Error getting broker config|Failed to reconcile'
   kubectl -n <namespace> exec <cluster>-kafka-0 -- /opt/kafka/bin/kafka-topics.sh \
     --bootstrap-server localhost:9092 --describe --topic __consumer_offsets
   ```

   Use the topic named in the operator log if it is not `__consumer_offsets`. If the listener on `localhost:9092` requires SASL, add `--command-config <client-file>` to every Kafka command here. Take the broker ids from the `Replicas` line of a partition that lists every replica (ids such as `0`, `1`, `2`, or larger ids such as `1100`).

2. Generate a reassignment plan. Create `/tmp/topic-generate.json`:

   ```json
   {"topics": [{"topic": "__consumer_offsets"}], "version": 1}
   ```

   ```bash
   kubectl -n <namespace> cp /tmp/topic-generate.json <cluster>-kafka-0:/tmp/topic-generate.json
   kubectl -n <namespace> exec <cluster>-kafka-0 -- /opt/kafka/bin/kafka-reassign-partitions.sh \
     --bootstrap-server localhost:9092 \
     --topics-to-move-json-file /tmp/topic-generate.json \
     --broker-list "<id-0>,<id-1>,<id-2>" --generate
   ```

   Save the "Current partition replica assignment" from the output for rollback, and save the "Proposed partition reassignment configuration" as `/tmp/partition-replica-reassignment.json`.

3. Execute it.

> **Warning:** Partition reassignment moves replicas and adds disk and network load until it finishes. Run it only when the operator log says the broker `is currently not rollable` with `will be underreplicated`, and describe shows ISR shorter than Replicas on the topic you pass in. Use a maintenance window. Roll back by executing the saved current assignment. The alternative in the same procedure, force-deleting the stuck broker pod (`kubectl delete pod <stuck-broker> --force --grace-period=0`), can lose the latest records when ISR has a single replica; use it only when the business accepts that loss, which cannot be rolled back.

   ```bash
   kubectl -n <namespace> cp /tmp/partition-replica-reassignment.json <cluster>-kafka-0:/tmp/partition-replica-reassignment.json
   kubectl -n <namespace> exec <cluster>-kafka-0 -- /opt/kafka/bin/kafka-reassign-partitions.sh \
     --bootstrap-server localhost:9092 \
     --reassignment-json-file /tmp/partition-replica-reassignment.json --execute
   kubectl -n <namespace> exec <cluster>-kafka-0 -- /opt/kafka/bin/kafka-reassign-partitions.sh \
     --bootstrap-server localhost:9092 \
     --reassignment-json-file /tmp/partition-replica-reassignment.json --verify
   ```

4. When describe shows ISR equal to Replicas, apply the parameter change again; the brokers can roll.

### Cause 2: A broker does not become ready after a restart and the topic-store changelog has no leader

```bash
kubectl get rdskafka -A
kubectl -n <namespace> get pods | grep <cluster>
kubectl -n <namespace> logs deploy/<cluster>-entity-operator --all-containers --tail=300 | grep -i 'topic-store-changelog'
kubectl -n <namespace> logs <cluster>-kafka-<n> --tail=300
kubectl -n <operator-namespace> logs deploy/<cluster-operator-deployment> --tail=500 | grep -E 'not rollable|will be underreplicated'
```

The changelog error can appear in the entity-operator, broker, or exporter logs of the instance. If the operator log has `not rollable` with `will be underreplicated`, use Cause 1 instead: deleting the pod there can lose records.

> **Warning:** Deleting the stuck broker pod restarts that broker; partitions it leads move to other brokers and clients reconnect. Do it only when the instance reports `Error while trying to restart pod <cluster>-kafka-<n> to become ready`, the logs show no leader for `__strimzi-topic-operator-kstreams-topic-store-changelog`, the other brokers are Running, and the operator log has no `not rollable` line. The pod is recreated with the same PVC, so there is nothing to roll back. Add `--force --grace-period=0` only if the pod stays `Terminating`.

```bash
kubectl -n <namespace> delete pod <cluster>-kafka-<n>
kubectl -n <namespace> get pods -w | grep <cluster>-kafka-<n>
kubectl get rdskafka -A
```

The pod should become `1/1 Running` and the `RdsKafka` phase should return to `Active`.

### Cause 3: The datapool keeps the old node after Kafka has moved

```bash
kubectl get pods -A -o wide | grep -i datapool
kubectl -n <namespace> describe pod <datapool-pod> | grep -E 'Node-Selectors|Status:|Controlled By|Warning'
kubectl -n <namespace> get pod <datapool-pod> -o jsonpath='{.metadata.ownerReferences}{"\n"}'
```

A Pending datapool pod whose node selector names a node Kafka has already left confirms this cause. Change the scheduling node of the MinIO component separately, to the node Kafka now runs on, with the same scheduling setting used for Kafka.

> **Warning:** Changing the MinIO scheduling node reschedules the datapool pod. Do it only when that pod is Pending, its node selector names a node Kafka has left, and the target node is Ready. Roll back by pointing MinIO back at the previous node if that node is still schedulable.

After the datapool pod is Running on the new node, the instance leaves processing.

## Diagnostic Steps

1. A console parameter change that does not roll brokers: read the operator log. `is currently not rollable` with `will be underreplicated (|ISR|=1 and min.insync.replicas=1)` and an `Isr` list shorter than `Replicas` in describe is Cause 1. Only `Reconciliation is in progress`, with no ISR line, is the stuck-operator case in the creation article.

2. List only the partitions with a gap:

   ```bash
   kubectl -n <namespace> exec <cluster>-kafka-0 -- /opt/kafka/bin/kafka-topics.sh \
     --bootstrap-server localhost:9092 --describe --under-replicated-partitions
   ```

   Empty output means no partition is under-replicated, so an ISR block is unlikely. A `Timed out waiting for a node assignment` from this command while every broker pod is Running usually means the listener needs SASL settings (`--command-config`).

3. `Error while trying to restart pod <cluster>-kafka-<n> to become ready` with no leader for `__strimzi-topic-operator-kstreams-topic-store-changelog`, and no `not rollable` line: Cause 2.

4. Instance in processing after a node change: compare the nodes of the Kafka pods and the datapool pod. Kafka moved, datapool Pending with the old node selector: Cause 3.
