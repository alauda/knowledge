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

# Kafka broker PVC full or still too small after expansion on ACP

## Issue

A Kafka broker Pod is evicted or crash-loops, and its events or logs say the volume is full. Variants of the same problem:

- A log Kafka volume fills its PVC (for example 30Gi) and the broker stops. The log-plugin Kafka that is created together with Elasticsearch is often requested at 20Gi; on a busy cluster that volume can reach about 18Gi in under two days.
- After someone expands the PVC, the broker still cannot create files under `/kafka`, or the Data Services page shows the instance abnormal while the broker Pod is `Running`.
- A self-managed Kafka (not created by the platform log plugin) fills `data-kafka-kafka-0`, with topic directories such as `ALAUDA_LOG_TOPIC-*` of several gigabytes each under `/var/lib/kafka/data/kafka-log0`.

Related articles: *Kafka log disk grows to hundreds of gigabytes or topic retention differs from the configured value on ACP* (large disk use with little lag, retention, one broker holding all leaders), and *Kafka KRaft broker and controller fail with No space left on device: expand storage through the RdsKafka CR* (KRaft instances managed by `RdsKafka`).

## Root Cause

### Cause 1: The broker PVC has no free bytes

The PVC used by one broker reaches 100 percent, and the broker cannot write. When the StorageClass allows volume expansion, expanding the PVC restores the broker. A single broker filling faster than its peers still needs a follow-up on which topics landed there; when that broker also holds almost every partition leader and the ISR lists only its id, see the leader-skew cause in the related retention article.

### Cause 2: PVC capacity and the Kafka CR size disagree

The PVC was expanded (for example from 30Gi to 60Gi), but the instance stays abnormal, or the broker still fails to create files under `/kafka`. `spec.kafka.storage.size` on the `Kafka` custom resource still holds the old value. The operator reconciles the broker storage from that field. Kubernetes refuses changes to `volumeClaimTemplates` on an existing StatefulSet, so a patch aimed at the broker StatefulSet does not update the size the operator uses.

### Cause 3: A self-managed Kafka keeps historic log segments

`data-kafka-kafka-0` is large (for example 250Gi requested and about 80 percent used), and `/var/lib/kafka/data/kafka-log0` holds `ALAUDA_LOG_TOPIC` partitions of several gigabytes each. The Kafka and the Elasticsearch next to it were deployed by the site, not by the platform log plugin, and historic Elasticsearch indices were still retained. Expanding the PVC brings the broker back; deleting the indices that the data owner has approved stops the growth.

## Resolution

### Cause 1: The broker PVC has no free bytes

Use this only when `df` inside the broker, or the PVC metrics, show the Kafka volume at 100 percent, and the StorageClass has volume expansion enabled.

```bash
kubectl -n <namespace> get pvc
kubectl -n <namespace> exec <cluster>-kafka-0 -- df -h /var/lib/kafka/data
kubectl get sc <storage-class> -o jsonpath='{.allowVolumeExpansion}{"\n"}'
```

> **Warning:** A PVC can be expanded but never shrunk. Precondition: `allowVolumeExpansion` is `true`, the storage backend has the extra capacity, and you are expanding the PVC of the broker that is full. There is no rollback to the smaller size.

```bash
kubectl -n <namespace> patch pvc data-<cluster>-kafka-0 --type merge \
  -p '{"spec":{"resources":{"requests":{"storage":"<new-size>"}}}}'
kubectl -n <namespace> get pvc data-<cluster>-kafka-0 -o jsonpath='{range .status.conditions[*]}{.type}{" "}{.status}{" "}{.message}{"\n"}{end}'
```

Wait until `status.capacity.storage` equals the request and `df` inside the Pod shows the new size. A condition `FileSystemResizePending` means the volume has grown but the filesystem has not yet:

- With a CSI driver that supports online expansion, the kubelet finishes the resize while the Pod runs.
- With a driver that supports only offline expansion, the condition stays until the volume is mounted again; restart that one broker Pod.

The log-plugin volume that starts at 20Gi uses the same patch. After the broker is up, check whether retention will fill the new size again (see the related retention article). If the Kafka CR size is still the old number once the PVC is larger, continue with Cause 2.

### Cause 2: PVC capacity and the Kafka CR size disagree

Compare the CR size with the PVC capacity:

```bash
kubectl get kafka -A
kubectl -n <namespace> get kafka <cluster> -o jsonpath='{.spec.kafka.storage.size}{"\n"}'
kubectl -n <namespace> get pvc data-<cluster>-kafka-0 -o jsonpath='{.status.capacity.storage}{"\n"}'
```

> **Warning:** Updating `spec.kafka.storage.size` restarts the Kafka instance. Run it in a maintenance window, and only when the PVC capacity is already the new size and the CR still shows the old size (instance abnormal while the Pod runs, or the broker cannot create files under `/kafka` after expansion). Set the field to the PVC's current capacity. Putting the old, smaller size back recreates the mismatch, so the only rollback is to keep the CR equal to the PVC capacity.

```bash
kubectl -n <namespace> patch kafka <cluster> --type merge \
  -p '{"spec":{"kafka":{"storage":{"size":"<pvc-capacity>"}}}}'
kubectl -n <namespace> rollout status statefulset/<cluster>-kafka
kubectl -n <namespace> get kafka <cluster>
```

Do not patch `volumeClaimTemplates` on the StatefulSet; the API server rejects it, and the operator reads the size from the `Kafka` object.

### Cause 3: A self-managed Kafka keeps historic log segments

1. Expand the PVC with the Cause 1 procedure so the broker can start.
2. Remove only the Elasticsearch indices that the data owner has listed as disposable. Deleting Kafka topics is not part of this cleanup; the space is released on the Elasticsearch side after the volume is already larger.
3. Repeat `du` on `/var/lib/kafka/data/kafka-log0` after those indices are gone and the consumers have caught up:

```bash
kubectl -n <namespace> exec <kafka-pod> -- sh -c 'du -sh /var/lib/kafka/data/kafka-log0/* | sort -h | tail -20'
```

## Diagnostic Steps

1. Decide which disk is full. The log-plugin data on the node is `/cpaas/data/kafka0`; a broker PVC is mounted at `/var/lib/kafka/data`. A full host `/cpaas` or `/cpaas/data` that keeps ZooKeeper down is a node disk problem (see *Kafka and ZooKeeper down from storage stalls, a full node disk, or a probe kill during log replay on ACP*), even when the files are Kafka logs.

2. Compare four numbers: the PVC requested size, the PVC capacity, the filesystem size inside the Pod, and `spec.kafka.storage.size`. For a KRaft `RdsKafka`, the sizes are `spec.storage.size` and `spec.controller.storage.size` (see the related KRaft article).

```bash
kubectl -n <namespace> get pvc data-<cluster>-kafka-0 -o yaml
kubectl -n <namespace> get kafka <cluster> -o jsonpath='{.spec.kafka.storage.size}{"\n"}'
kubectl -n <namespace> exec <cluster>-kafka-0 -- df -h /var/lib/kafka/data
```

Expected for Cause 2: PVC capacity is the new size and `spec.kafka.storage.size` is still the old one.

3. If the Pod never stays up long enough for `df`, read the previous log and the PVC events:

```bash
kubectl -n <namespace> logs <cluster>-kafka-0 --previous
kubectl -n <namespace> describe pvc data-<cluster>-kafka-0
```

4. Check consumer lag before deleting anything. Lag near zero with a large directory is retention, not a fault (see the related retention article).

5. `FailedAttachVolume` on the broker PVC is not a full disk; the volume never attached. See the Huawei CSI initiator cause in *Kafka and ZooKeeper down from storage stalls, a full node disk, or a probe kill during log replay on ACP*.
