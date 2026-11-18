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

# Kafka broker memory looks high, or a memory change or new broker Pod is blocked by quota on ACP

## Issue

On a running Data Services Kafka instance:

- An inspection reports that a Kafka broker pod uses more than 80 percent of its memory, and someone asks whether that is a fault.
- Kafka memory usage climbs to about 90 percent no matter how much memory it is given.
- Updating the node spec (memory) of the instance fails, and rolling the change back fails too. The `RdsKafka` events show `ErrorKafkaStatus: Error while waiting for restarted pod <cluster>-kafka-0 to become ready`, and the StatefulSet reports:

  ```text
  pods "<cluster>-kafka-0" is forbidden: exceeded quota: default, requested: limits.memory=8Gi,requests.memory=8Gi, used: limits.memory=28800Mi,requests.memory=28800Mi, limited: limits.memory=32Gi,requests.memory=32Gi
  ```

- The instance shows abnormal, its `Kafka` resource is `NotReady` with `Exceeded timeout of 300000ms while waiting for Pods resource <cluster>-kafka-0 in namespace <namespace> to be ready`, and clients log `Timed out waiting for a node assignment. Call: fetchMetadata`.

Related articles: [Kafka config change does not roll brokers, a broker restart hangs, or the instance stays processing on ACP](Kafka_config_change_does_not_roll_brokers_a_broker_restart_hangs_or_the_instance_stays_processing_on_ACP.md) covers rollouts and restarts that stall for reasons other than quota. Create-time failures are covered in [Kafka instance creation times out on the entity-operator, shows failed, or the cluster operator restarts on ACP](Kafka_instance_creation_times_out_on_the_entity-operator_shows_failed_or_the_cluster_operator_restarts_on_ACP.md).

## Root Cause

### Cause 1: Inspection flags broker memory above 80 percent

A routine inspection reports broker memory above 80 percent of the limit (for example 87 percent). The pod is not restarting and is not `OOMKilled`. That level is normal for Kafka, not a fault, and no leak is involved. If the inspection threshold must be met, the broker memory limit is raised.

### Cause 2: Memory usage reaches about 90 percent whatever the limit is (page cache)

After the memory is expanded, usage again climbs to about 90 percent, with no message backlog behind it. This is expected: Kafka relies on the operating system page cache for throughput, and that cache grows into whatever memory the container is given, so the percentage stays high after every increase. No action is needed as long as the pods are not restarting because of OOM.

### Cause 3: Spec update and rollback both fail with exceeded quota

A memory change makes the operator stop a broker (`Killing: Stopping container kafka`) and recreate it with the new request. The StatefulSet `<cluster>-kafka` then reports `FailedCreate` with the quota error, because the namespace `ResourceQuota` `default` is nearly full: in the example, 28800Mi of 32Gi is used by the other pods, so neither the new 8Gi request nor the old 4Gi request (more than the 3968Mi left) can be admitted for the pod being recreated. That is why the rollback fails the same way. The project quota on that cluster can also be fully allocated, which prevents raising the namespace quota.

### Cause 4: The namespace LimitRange and ResourceQuota leave the broker pods without resources

The cluster operator log repeats `Exceeded timeout of 300000ms while waiting for Pods resource <cluster>-kafka-<n> ... to be ready`, `createOrUpdate failed io.strimzi.operator.common.TimeoutException`, and `Failed to reconcile`. Clients log `Error connecting to node <cluster>-kafka-2.<cluster>-kafka-brokers.<namespace>.svc:9091` and `Timed out waiting for a node assignment. Call: fetchMetadata`. The broker pods of the Kafka `StrimziPodSet` did not come up because the namespace container limits (`LimitRange`) and `ResourceQuota` did not leave them enough resources to start (for example Kafka 3.8.0 in ZooKeeper mode with 3 brokers at CPU `500m` and memory `10Gi`, limits equal to requests).

## Resolution

### Cause 1: Inspection flags broker memory above 80 percent

```bash
kubectl -n <namespace> top pod <cluster>-kafka-0 --containers
kubectl -n <namespace> describe pod <cluster>-kafka-0 | grep -E 'Last State|Reason|Restart Count'
kubectl -n <namespace> get kafka <cluster> -o jsonpath='{.spec.kafka.resources}{"\n"}{.metadata.ownerReferences}{"\n"}'
```

If the pod is not `OOMKilled` and not restarting, the usage is normal. To bring it under the inspection threshold, raise the broker memory. When `ownerReferences` names an `RdsKafka`, change the memory on the Data Services instance (its update page or its spec) so a direct edit of `Kafka` is not reverted.

> **Warning:** Raising the broker memory rolls the broker pods one by one. Do it in a maintenance window, only when the flagged pod is a broker and it is not crash-looping. First confirm that the namespace quota has room for the larger request (Cause 3). Roll back by restoring the previous memory values.

```bash
kubectl -n <namespace> get kafka <cluster> -o yaml > kafka.bak.yaml
kubectl -n <namespace> edit kafka <cluster>     # only when the Kafka resource has no RdsKafka owner
```

Under `spec.kafka.resources`, raise `requests.memory` and `limits.memory` above the current limit and leave CPU unchanged. If usage climbs back to the same percentage afterwards, that is Cause 2. Growth in `<cluster>-entity-operator` is an entity-operator issue, covered in the creation article linked in the Issue section.

### Cause 2: Memory usage reaches about 90 percent whatever the limit is (page cache)

```bash
kubectl -n <namespace> get pods | grep <cluster>-kafka
kubectl -n <namespace> describe pod <cluster>-kafka-0 | grep -E 'Last State|Reason|Restart Count'
kubectl -n <namespace> top pod <cluster>-kafka-0 --containers
```

If the restart count is not growing and the last state is not `OOMKilled`, the usage is page cache and needs no action; more memory does not lower the percentage. If the broker restarts with `OOMKilled`, the limit really is too small: raise it as in Cause 1.

### Cause 3: Spec update and rollback both fail with exceeded quota

```bash
kubectl -n <namespace> get events --sort-by=.lastTimestamp | grep -E 'FailedCreate|ErrorKafkaStatus' | tail -20
kubectl -n <namespace> describe sts <cluster>-kafka | grep -A3 FailedCreate
kubectl -n <namespace> describe resourcequota default
```

The `FailedCreate` text names the quota, the request, the usage, and the limit. A rollback does not help when the hard limit minus `used` is below the old request as well. Check the project quota of that cluster on the project page.

> **Warning:** Raising the project quota, and then the namespace quota `default`, lets the project and namespace schedule more CPU, memory, or storage than before. Do it only when `FailedCreate` names `exceeded quota` for a broker pod of this instance. Note the current values first; roll back by setting them again once the instance is stable.

1. Raise the project quota for that cluster if it is fully allocated.
2. Make sure the hard limit minus `used` of the namespace quota `default` covers the broker request; raise it within the project quota if not.
3. Watch the brokers roll:

   ```bash
   kubectl -n <namespace> describe resourcequota default
   kubectl -n <namespace> rollout status sts/<cluster>-kafka
   kubectl -n <namespace> get pods | grep -E '<cluster>-(kafka|zookeeper)'
   ```

The StatefulSet then completes its rolling update and all brokers run at the new spec.

### Cause 4: The namespace LimitRange and ResourceQuota leave the broker pods without resources

```bash
kubectl -n <namespace> get kafka <cluster> -o jsonpath='{.status.conditions}{"\n"}'
kubectl -n <namespace> get strimzipodset
kubectl -n <namespace> get pods | grep <cluster>-kafka
kubectl -n <namespace> get events --sort-by=.lastTimestamp | tail -40
kubectl -n <namespace> describe limitrange
kubectl -n <namespace> describe resourcequota
```

Compare the broker requests and limits with the `LimitRange` maximums and with the quota hard limits minus `used`. A missing broker pod, an `exceeded quota` or LimitRange `forbidden` message, or a broker killed for lack of memory points at this cause. With `StrimziPodSet` the cluster operator creates the pods itself, so a rejected create shows up in the operator log and the namespace events, not as a StatefulSet `FailedCreate`.

> **Warning:** Raising the namespace `LimitRange` and `ResourceQuota` lets the namespace consume more CPU and memory than before. Do it only when the events or the operator log name the quota or limit for the broker pods of this instance. Save both objects first and roll back by re-applying them once the instance is stable.

```bash
kubectl -n <namespace> get limitrange -o yaml > limitrange.bak.yaml
kubectl -n <namespace> get resourcequota -o yaml > resourcequota.bak.yaml
kubectl -n <namespace> edit limitrange <limitrange>
kubectl -n <namespace> edit resourcequota <quota>
```

Raise the container maximums so they cover the broker request and limit, and the quota hard values so they cover current usage plus every broker pod of the instance. The same limits can be changed from the namespace settings in the console. Then watch the brokers start and the condition become `Ready`:

```bash
kubectl -n <namespace> get pods -w | grep <cluster>-kafka
kubectl -n <namespace> get kafka <cluster>
```

## Diagnostic Steps

1. Identify which pod the memory figure belongs to:

   ```bash
   kubectl -n <namespace> top pod --containers | grep <cluster>
   ```

   A broker container: Cause 1 or Cause 2. `<cluster>-entity-operator`: not this article.

2. Memory around 90 percent that stays there after an increase, no `OOMKilled`, no backlog: Cause 2.

3. A memory change that fails, a rollback that fails too, and `FailedCreate` with `exceeded quota: default`: Cause 3.

4. `Kafka` condition `NotReady` with `Exceeded timeout of 300000ms while waiting for Pods resource <cluster>-kafka-<n>`, broker pods not running, and a `LimitRange` or `ResourceQuota` in the namespace: Cause 4. The same `Timed out waiting for a node assignment` text from a CLI tool while the `Kafka` resource is `Ready` and every broker pod is Running is a different problem (often a SASL listener used without client credentials).

5. Quota pressure at a glance:

   ```bash
   kubectl -n <namespace> get resourcequota -o custom-columns='NAME:.metadata.name,HARD:.status.hard,USED:.status.used'
   ```

   Usage close to hard on memory or CPU confirms there is no room for a recreated broker.
