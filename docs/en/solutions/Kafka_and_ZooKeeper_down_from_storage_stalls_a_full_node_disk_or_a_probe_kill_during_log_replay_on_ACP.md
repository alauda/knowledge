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

# Kafka and ZooKeeper down from storage stalls, a full node disk, or a probe kill during log replay on ACP

## Issue

Applications lose Kafka, the Data Services page shows the Kafka instance as failed, or a create or reconcile error says:

```text
Exceeded timeout of 300000ms while waiting for Pods resource <cluster>-zookeeper-<n> to be ready
```

Two instances can report that timeout at the same time. Broker Pods and ZooKeeper Pods restart together. On a KRaft-mode instance, the broker and the KRaft controller Pods both fail to come up instead, and the Kafka Pods keep restarting with no application change in that window. Check the KRaft controller Pods with the same disk and storage checks as ZooKeeper.

Typical shapes of this failure:

- A complete outage: ZooKeeper is gone, restarted ZooKeeper Pods cannot mount their storage, node load is in the hundreds, and Ceph raises alerts at the same time (Cause 1).
- On the log nodes, ZooKeeper and Kafka containers never start while `/cpaas` or `/cpaas/data` is at 100 percent, sometimes with the Elasticsearch API returning 503 (Cause 2).
- Only `kafka-0` fails: it is killed by its health check during startup after a JVM memory failure, with a large backlog of log segments to load (Cause 3).
- The log Kafka and Elasticsearch Pods were deleted or restarted while several nodes of the global cluster were `NotReady` (Cause 4).
- The broker PVC reports `FailedAttachVolume`, and Huawei CSI reports that `Add iscsi initiator to host` failed (Cause 5).
- The 300000 ms timeout names one ZooKeeper Pod that is not Ready, with no `OOMKilled` and no storage fault (Cause 6).

When the report is only "Kafka is down", check Ceph and node iowait first, before reading Kafka logs or deleting any data.

## Root Cause

### Cause 1: Ceph OSD processes freeze and ZooKeeper misses syncLimit

ZooKeeper is down and Kafka clients fail. Restarting ZooKeeper does not mount storage. Ceph alerts show the internal op processing of every OSD frozen in the same second, the RBD volumes behind the Kafka and ZooKeeper Pods hang, and the node load climbs very high (around 300). ZooKeeper followers must stay in sync with the leader within `syncLimit` ticks; with `syncLimit=2` and the default `tickTime` of 2000 ms that is a 4-second window, and a follower whose disk hangs exceeds it. Broker CPU is not the limiting factor.

### Cause 2: The node directory that holds container data is full

`/cpaas` or `/cpaas/data` on the node is at 100 percent. ZooKeeper does not start, Kafka does not start, and the Elasticsearch log API can return 503. Cleaning log files in the `/cpaas` directory of the node that runs ZooKeeper lets the containers start. The ZooKeeper data directory is not one of the files to clean.

When the bytes are almost all `/cpaas/data/kafka0`, Kafka itself is holding them. Kafka deletes segments only when the retention time or size limit is reached, whether or not they were consumed, and the platform log topic keeps 48 hours by default.

### Cause 3: kafka-0 is killed by the health check while replaying a large log

The previous broker start failed because the JVM did not have enough memory. After the restart, the broker spends a long time loading accumulated segments, the health check kills the container before it becomes ready, and the cycle repeats. Stopping Kafka and ZooKeeper and deleting their data directories breaks the loop, at the cost of the topic data on those volumes.

### Cause 4: Log Kafka and Elasticsearch were restarted because nodes were NotReady

Several nodes of the global cluster are `NotReady`, and the log components on them are deleted or restarted. They come back by themselves once those nodes are `Ready` again.

### Cause 5: Huawei CSI cannot attach the broker volume

Broker Pods stay pending, or the broker Pod reports `FailedAttachVolume`. Huawei CSI returns a failure for `Add iscsi initiator to host` against a storage host object that already holds a large number of historical initiators in `offline` state. The count has reached the initiator limit of that storage host. The node IQNs themselves are unique; this is not a duplicate IQN registration.

Other Kafka Pods can crash-loop in the same window because an application client certificate has expired. That is a separate fault and has to be fixed separately.

### Cause 6: ZooKeeper Pod not Ready, no OOM, and a restart clears the timeout

The 300000 ms error names one ZooKeeper Pod, that Pod is not Ready, and its events do not show `OOMKilled`. A manual restart of that Pod returns the instances to normal. The underlying reason has not been identified.

## Resolution

### Cause 1: Ceph OSD processes freeze and ZooKeeper misses syncLimit

Confirm the signature before touching any broker disk:

```bash
kubectl get pod -A | grep -Ei 'osd|ceph'
kubectl -n <namespace> logs <cluster>-zookeeper-0 --tail=300 | grep -Ei 'sync|fsync|timeout'
iostat -x 1 3
```

> **Warning:** Restarting an OSD pauses I/O for every volume on that OSD, and rebooting a node restarts every Pod on it. Do this only when Ceph shows the OSD op freeze in the same second, the Kafka and ZooKeeper RBD volumes are hung, and ZooKeeper has missed `syncLimit`. Restart the frozen OSD Pods first, and reboot a node only if it stays in iowait after its OSDs are restarted. No Kafka data is touched by this step, so there is nothing to roll back on the Kafka side.

```bash
kubectl -n <ceph-namespace> delete pod <frozen-osd-pod>
```

If the node load stays extreme and the RBD is still hung, reboot that node in a maintenance window. After the OSDs are healthy, ZooKeeper and the brokers mount their volumes again and clients reconnect. Leave the Kafka data directories in place.

### Cause 2: The node directory that holds container data is full

```bash
df -h /cpaas /cpaas/data
du -sh /cpaas/* /cpaas/data/* | sort -h
```

> **Warning:** Deleting files under `/cpaas` or `/cpaas/data` is permanent. Do it only when `df` shows that filesystem at 100 percent and ZooKeeper or Kafka fails to start because of it. Remove log files that are safe to drop, not the ZooKeeper data directory and not live Kafka volume contents. There is no undo for a deleted file.

1. Clear the log files that `du` shows filling the filesystem until `df` reports free space.
2. The log collector queues under `/cpaas/audit`, `/cpaas/event`, and `/cpaas/log` hold logs that have not been shipped yet. Delete only inside their `diskqueue` directories, and only when the gap in collected logs is accepted.
3. Confirm the ZooKeeper and Kafka Pods reach Ready. If Kafka still logs `ZooKeeperClientTimeoutException` after space is freed, restart ZooKeeper first and then Kafka.
4. If Elasticsearch was also returning 503, recover Elasticsearch after the disk has free space; that is a log-storage step, not a Kafka topic operation.

If the bytes are almost all `/cpaas/data/kafka0`:

- Letting a lagging consumer catch up keeps records from being lost, but does not release space by itself.
- To get space back, expand the volume or lower retention (see *Kafka log disk grows to hundreds of gigabytes or topic retention differs from the configured value on ACP*).
- Do not delete segment files by hand on a running broker.
- Clearing `/cpaas/data/kafka0` entirely is only acceptable with Kafka, ZooKeeper, and Elasticsearch scaled to 0 and the owner accepting the loss of the whole log store, including the ZooKeeper data.

If the full Kafka disk is a different disk from the Elasticsearch disk, deleting Elasticsearch indices does not help.

### Cause 3: kafka-0 is killed by the health check while replaying a large log

> **Warning:** This deletes the Kafka and ZooKeeper data directories and cannot be undone. Run it only when the previous container log shows the JVM ran out of memory, the current container is killed by the liveness or readiness probe while still loading segments, and the data owner has accepted losing the records stored in this Kafka cluster. A full disk (Cause 2) or an OSD stall (Cause 1) does not use this step.

1. Tell a probe kill from an OOM kill with `kubectl describe pod`: a `Liveness probe failed` event versus an `OOMKilled` last state. Then print the previous log, the mounts, and the PVC names:

```bash
kubectl -n <namespace> logs <cluster>-kafka-0 --previous | tail -100
kubectl -n <namespace> describe pod <cluster>-kafka-0 | grep -E 'Liveness|Readiness|OOMKilled|Last State'
kubectl -n <namespace> get pod <cluster>-kafka-0 -o jsonpath='{range .spec.containers[0].volumeMounts[*]}{.name}{" "}{.mountPath}{"\n"}{end}'
kubectl -n <namespace> get pvc
```

The broker data mount on a Data Services instance is `/var/lib/kafka/data`; the platform log Kafka (`cpaas-kafka-*` in `cpaas-system`) uses `/cpaas/data/kafka0`.

2. Stop Kafka and ZooKeeper so nothing writes. The stop action in the console can leave Pods `Running`, so check `kubectl get pods` before removing files. The data lives on the PVC, so deleting a Pod does not remove it; the delete has to reach the mount.

3. When the broker container stays up long enough:

```bash
kubectl -n <namespace> exec <cluster>-kafka-0 -- ls -ld /var/lib/kafka/data
kubectl -n <namespace> exec <cluster>-kafka-0 -- sh -c 'rm -rf /var/lib/kafka/data/*'
```

Repeat for each ZooKeeper Pod, using the data mount printed for that Pod rather than the broker path.

4. If the container restarts too quickly for `exec`, mount the claim (`data-<cluster>-kafka-<ordinal>`) on a one-off Pod that uses the broker image, remove the files under the data mount, and delete the one-off Pod. Do the same for the ZooKeeper volume only as part of the same accepted data loss.

5. Start Kafka and ZooKeeper again. `kafka-0` starts normally once both data directories are empty. The JVM heap can be reviewed afterwards; no specific heap size is part of this recovery.

### Cause 4: Log Kafka and Elasticsearch were restarted because nodes were NotReady

```bash
kubectl get nodes
kubectl get pod -A | grep -E 'kafka|zookeeper|elasticsearch'
```

When the Kafka and Elasticsearch Pods were removed only because their nodes were `NotReady`, wait until those nodes are `Ready`. The log components return to normal with no further Pod deletion. A Kafka Pod that stays `Pending` on `DiskPressure` after its node is `Ready` is different: free the node disk, then delete that Pod so it is scheduled again.

### Cause 5: Huawei CSI cannot attach the broker volume

> **Warning:** Removing initiators from the storage host disconnects the matching node from that storage. Delete only initiators that are `offline` and that the storage owner has confirmed are unused. If a live initiator is removed by mistake, register it again and retry the attach.

1. On the Huawei storage host mapped to the failing nodes, remove the historical `offline` initiators that pushed the host to its initiator limit.
2. Retry the attach:

```bash
kubectl -n <namespace> describe pod <cluster>-kafka-0 | grep -A5 FailedAttachVolume
kubectl -n <namespace> delete pod <cluster>-kafka-0
```

The new Pod should mount, `FailedAttachVolume` and the initiator error should stop, and the initiator of that node should show `online`. Also replace any expired application client certificate found in the same window; otherwise the Pod can be Running while the client still fails.

### Cause 6: ZooKeeper Pod not Ready, no OOM, and a restart clears the timeout

Use this only when the 300000 ms error names a ZooKeeper Pod, that Pod is not Ready, there is no `OOMKilled`, the node filesystem is not full, Ceph is not frozen, and the volume is attached.

```bash
kubectl -n <namespace> describe pod <cluster>-zookeeper-<n> | grep -E 'OOMKilled|State:|Ready'
kubectl -n <namespace> get pods | grep zookeeper
```

> **Warning:** Deleting a ZooKeeper Pod restarts that ensemble member and briefly removes it from the quorum. Do it only when the other ZooKeeper Pods are Running and the signature above is confirmed. The StatefulSet recreates the Pod, and its data directory is kept. If the new Pod fails the same way, stop and check Causes 1, 2, and 5 instead of deleting data.

```bash
kubectl -n <namespace> delete pod <cluster>-zookeeper-<n>
kubectl -n <namespace> rollout status statefulset/<cluster>-zookeeper
```

## Diagnostic Steps

1. Separate "Pod not Ready" from "client not authorized". A running broker that returns `TopicAuthorizationException` is a client authorization problem, not this article.

2. Read the object named in the 300000 ms error. For a ZooKeeper Pod:

```bash
kubectl -n <namespace> describe pod <cluster>-zookeeper-<n>
kubectl -n <namespace> get events --sort-by=.lastTimestamp | tail -40
```

`FailedAttachVolume` is Cause 5. `FailedScheduling` or a disk-pressure taint points to Cause 2 or node disk pressure. Broker Pods that are rejected or never created while the namespace has a `LimitRange` or `ResourceQuota` are a quota problem. A container that starts and is then killed is Cause 3 only if the previous log shows a JVM memory failure during segment loading.

3. Before any data-directory delete, check storage latency and free space. Causes 1 and 2 recover without removing Kafka segments.

```bash
df -h
kubectl get pod -A | grep -Ei 'osd|ceph'
kubectl -n <namespace> exec <cluster>-kafka-0 -- df -h /var/lib/kafka/data
```

4. For a KRaft broker and controller crash loop, describe the controller Pod and its volume the same way and read the kernel log of its node. iSCSI `detected conn error (1022)`, `rejecting I/O to offline device`, multipath `Failing path`, and EXT4 `Aborting journal on device ...` or `Detected aborted journal` lines mean the volume behind the Pods failed; the service recovers once that volume problem is corrected, and no Kafka data has to be removed.

```bash
journalctl -k | grep -E 'detected conn error|rejecting I/O to offline device|Failing path|Aborting journal|Detected aborted journal'
```

5. One broker restarting while its peers stay up, with that node's `kafka0` hundreds of gigabytes larger than the peers and an ISR that lists only that broker, is the leader-skew case in *Kafka log disk grows to hundreds of gigabytes or topic retention differs from the configured value on ACP*. Cause 3 here requires a JVM memory failure in the previous log and also deletes ZooKeeper data.

6. For the platform log Kafka in `cpaas-system`, read the Kafka log before deleting anything. `read-only file system` on a `chmod`, `Corrupt time index found` with nothing listening on `9092`, or a snapshot restore timeout at startup are different faults and are not covered here.

7. If the broker PVC is mounted and simply 100 percent full, expand it (see *Kafka broker PVC full or still too small after expansion on ACP*) instead of deleting the data directory.

8. If the 300000 ms error names a ZooKeeper Pod, describe shows no `OOMKilled`, and Causes 1, 2, and 5 do not match, it is Cause 6: restart that Pod only.
