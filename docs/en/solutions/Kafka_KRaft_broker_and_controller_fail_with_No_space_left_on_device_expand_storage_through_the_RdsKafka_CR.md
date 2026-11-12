---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - "4.4"
---

# Kafka KRaft broker and controller fail with No space left on device: expand storage through the RdsKafka CR

## Issue

Kafka shows no data after a certain day and the platform logs stop updating. The Kafka broker Pod restarts because it exits during startup, and the KRaft controller Pods of the same instance fail as well. The previous broker log ends with:

```text
ERROR [main] Kafka$:28 - Exiting Kafka due to fatal exception during startup.
java.nio.file.FileSystemException: /var/lib/kafka/data/kafka-log1/__cluster_metadata-0/00000000000000000000.log: No space left on device
[BrokerServer id=1] Transition from SHUTTING_DOWN to SHUTDOWN
App info kafka.server for 1 unregistered
```

The `kafka-log<broker-id>` directory and the `BrokerServer id` change with the broker. `__cluster_metadata` is the KRaft metadata log. A controller whose volume is full can report the same condition while it flushes that log, for example `KafkaStorageException: Error while flushing log for __cluster_metadata-0 in dir /var/lib/kafka/data/kafka-log<N> ...` followed by `Caused by: java.io.IOException: No space left on device`.

This applies to a Kafka instance managed by an `RdsKafka` custom resource in KRaft mode (`spec.mode: KRaft`, broker and controller Pods, no ZooKeeper). On ACP 4.4 the platform log Kafka can be deployed from the command line this way, for example as `log-kafka` in `cpaas-system`. In the ACP 4.4 `RdsKafka` API:

- broker storage is `spec.storage.size`, and the KRaft controller storage is `spec.controller.storage.size`; each has its own PVCs;
- the broker data mount is `/var/lib/kafka/data` (log directory `kafka-log<broker-id>`);
- the Kafka operator creates the broker and controller Pods and their PVCs from that resource, so storage changes are made on the resource.

## Root Cause

### Cause 1: The broker and controller PVCs are full

The broker cannot append to its KRaft metadata log (`__cluster_metadata-0/00000000000000000000.log`) because its PVC has no free space. It throws `FileSystemException ... No space left on device`, shuts down during startup, and unregisters. The KRaft controller volumes are full at the same time, so the controller containers fail too. With no broker running, nothing is written to or read from Kafka, which is why Kafka shows no data and the logs stop.

Small controller volumes (for example `1Gi`) fill first. Expanding both sizes on the `RdsKafka` object (for example broker `50Gi` to `100Gi` and controller `1Gi` to `5Gi`) returns Kafka to normal. No data directory has to be deleted.

## Resolution

### Cause 1: The broker and controller PVCs are full

Use this only when the broker's previous log shows `No space left on device` under `/var/lib/kafka/data` and the PVC or `df` confirms the volume is full. A full node-local `/cpaas/data/kafka0`, a hung storage path, or a volume that does not attach is a different fault; see Diagnostic Steps.

1. Find the instance, its mode, and the two configured sizes:

```bash
kubectl get rdskafka -A -o custom-columns="NAME:.metadata.name,NAMESPACE:.metadata.namespace,MODE:.spec.mode,PHASE:.status.phase,BROKER:.spec.storage.size,CONTROLLER:.spec.controller.storage.size"
```

If `rdskafka` is not a known resource name on the cluster, `kubectl api-resources | grep -i kafka` lists the kind. The resource type is one word, `rdskafka`; `kubectl edit rds kafka ...` does not work.

2. List the broker and controller PVCs of the instance and confirm the StorageClass allows expansion:

```bash
kubectl -n <namespace> get pvc | grep <instance>
kubectl get sc <storage-class> -o jsonpath='{.allowVolumeExpansion}{"\n"}'
```

`true` is required. If the data sits on a node-local volume that cannot grow through the PVC, the logical volume on the node has to be extended instead; a PVC whose size changed while the directory still reports `No space left on device` is that case.

3. Save the object, then raise both sizes on it.

> **Warning:** Expanding storage on the `RdsKafka` object grows every broker PVC (`spec.storage.size`) or every controller PVC (`spec.controller.storage.size`) of the instance, and the operator may restart broker or controller Pods while it applies the change; log transport pauses until they are Ready. Run it only when the `No space left on device` signature is confirmed and the StorageClass reports `allowVolumeExpansion: true`, and the storage backend has the extra capacity for every replica. Expansion is one-way: Kubernetes does not accept a smaller request on an existing PVC, so there is no rollback to the old size; the saved YAML restores the other fields only. Choose the new size with retention and ingest rate in mind, and keep all brokers at the same size.

```bash
kubectl -n <namespace> get rdskafka <instance> -o yaml > /tmp/<instance>.before.yaml
kubectl -n <namespace> edit rdskafka <instance>
```

```yaml
spec:
  storage:
    size: 100Gi        # broker PVCs
  controller:
    storage:
      size: 5Gi        # KRaft controller PVCs
```

Or with one patch:

```bash
kubectl -n <namespace> patch rdskafka <instance> --type merge \
  -p '{"spec":{"storage":{"size":"100Gi"},"controller":{"storage":{"size":"5Gi"}}}}'
```

For the platform log Kafka the command is `kubectl -n cpaas-system edit rdskafka log-kafka`. The controller volume holds only metadata and needs far less than the brokers. Change the sizes on the `RdsKafka` object, not on the StatefulSet: Kubernetes rejects edits to `volumeClaimTemplates`.

4. Wait until every PVC reports the new capacity and the Pods are Running:

```bash
kubectl -n <namespace> get pvc | grep <instance>
kubectl -n <namespace> get pvc <pvc-name> -o jsonpath='{.status.capacity.storage}{" "}{range .status.conditions[*]}{.type}{" "}{end}{"\n"}'
kubectl -n <namespace> get pod | grep <instance>
```

A PVC that shows `FileSystemResizePending` has a larger volume but not yet a larger filesystem. With a CSI driver that supports only offline expansion, restart that one Pod so the volume is mounted again.

5. Confirm the broker starts and has free space:

```bash
kubectl -n <namespace> exec <broker-pod> -- df -h /var/lib/kafka/data
kubectl -n <namespace> logs <broker-pod> --tail=200 | grep -E 'No space left on device|Exiting Kafka|Transition from'
kubectl -n <namespace> get rdskafka <instance> -o jsonpath='{.status.phase}{"\n"}'
```

Then check that new log data appears in Kafka and on the log query page. Once the brokers and controllers are Running, the consumers work through the backlog; query current logs after the lag has drained. If the broker volume fills again within days, review topic retention against the new size (see *Kafka log disk grows to hundreds of gigabytes or topic retention differs from the configured value on ACP*).

## Diagnostic Steps

1. Read the broker log from the failed start:

```bash
kubectl get pod -A | grep -Ei 'kafka|controller'
kubectl -n <namespace> logs <broker-pod> --previous | grep -E 'No space left on device|Exiting Kafka due to fatal exception|KafkaStorageException' | tail -5
```

`No space left on device` on a path under `/var/lib/kafka/data/kafka-log<N>`, often on `__cluster_metadata-0`, with full PVCs owned by an `RdsKafka` resource, is Cause 1.

2. Find each Pod's data mount and measure it. Print the mounts first, because controller Pods do not necessarily use the broker path:

```bash
kubectl -n <namespace> get pod <pod> -o jsonpath='{range .spec.containers[0].volumeMounts[*]}{.name}{" "}{.mountPath}{"\n"}{end}'
kubectl -n <namespace> exec <pod> -- df -h <data-mount>
kubectl -n <namespace> exec <broker-pod> -- du -sh /var/lib/kafka/data/*
```

If the container restarts too quickly for `exec`, compare the PVC capacity with the sizes on the `RdsKafka` object and read the PVC usage in monitoring.

3. Compare the `RdsKafka` sizes with what the PVCs actually have:

```bash
kubectl -n <namespace> get rdskafka <instance> -o jsonpath='{.spec.storage.size}{" "}{.spec.controller.storage.size}{"\n"}'
kubectl -n <namespace> get pvc | grep <instance>
```

4. Rule out the neighbouring faults before expanding:
   - A full node-local `/cpaas/data/kafka0`, or a host `/cpaas` at 100 percent: a node disk problem (see *Kafka and ZooKeeper down from storage stalls, a full node disk, or a probe kill during log replay on ACP*).
   - The node kernel log shows iSCSI path loss, multipath `Failing path`, or EXT4 `Aborting journal`: the volume itself failed.
   - The Pod reports `FailedAttachVolume`: the volume never attached.

```bash
kubectl -n <namespace> describe pod <broker-pod> | grep -E 'FailedAttachVolume|FailedMount'
journalctl -k | grep -E 'Failing path|Aborting journal'
```
