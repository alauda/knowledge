---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - "3.6"
  - "3.12"
  - "3.14"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
---

# Kafka instance creation times out on the entity-operator, shows failed, or the cluster operator restarts on ACP

## Issue

A Data Services Kafka instance does not come up, or the operator behind it is unhealthy:

- The create fails, or the new instance sits failed, with:

  ```text
  Exceeded timeout of 300000ms while waiting for Deployment resource <instance>-entity-operator in namespace <namespace> to be ready
  ```

- The Kafka service looks deployed, yet the instance still shows a creation failure in the console.
- The Kafka cluster operator pod restarts continuously (for example after an upgrade to ACP 3.14), so the console cannot create an instance or pick a namespace.
- A parameter change saved in the console never rolls the broker pods until the cluster operator pod is deleted.
- On a running instance, the memory of the entity-operator pod keeps rising and a resource increase has to be justified.

Related articles: [No Kafka in Data Services, or Alauda Build of Kafka 2 unpublished or failing to deploy on ACP](No_Kafka_in_Data_Services_or_Alauda_Build_of_Kafka_2_unpublished_or_failing_to_deploy_on_ACP.md) covers the operator install and marketplace side. A ZooKeeper or broker pod named in the 300000 ms timeout is covered in [Kafka and ZooKeeper down from storage stalls, a full node disk, or a probe kill during log replay on ACP](Kafka_and_ZooKeeper_down_from_storage_stalls_a_full_node_disk_or_a_probe_kill_during_log_replay_on_ACP.md) and in [Kafka broker memory looks high, or a memory change or new broker Pod is blocked by quota on ACP](Kafka_broker_memory_looks_high_or_a_memory_change_or_new_broker_Pod_is_blocked_by_quota_on_ACP.md). A rollout blocked by `is currently not rollable` is covered in [Kafka config change does not roll brokers, a broker restart hangs, or the instance stays processing on ACP](Kafka_config_change_does_not_roll_brokers_a_broker_restart_hangs_or_the_instance_stays_processing_on_ACP.md).

## Root Cause

### Cause 1: The entity-operator Deployment never becomes Ready

The create error names Deployment `<instance>-entity-operator` and the 300000 ms wait. On ACP 3.6 and 3.6.1 the containers of that Deployment inherit a very small namespace default limit and never become Ready (see [Kafka Entity Operator Fails to Start Because Container Limits Are Too Small](ecosystem/kafka/Kafka_Entity_Operator_Startup_Failure_Due_to_Container_Limits.md)). Later versions set explicit resources on the entity operator; the same timeout then means the pod is Pending, failing to pull its image, or crash-looping for another reason. The 300000 ms text only says that the Deployment did not become Ready in time.

### Cause 2: The namespace quota blocks the Kafka exporter

The Kafka brokers are running, but the instance shows creation failed. The namespace `ResourceQuota` is at its hard limit, so the Kafka exporter pod cannot be created. Raising the quota lets the exporter start, and the instance returns to normal.

### Cause 3: The cluster operator is crash-looping or not reconciling

Two different states:

- On ACP 3.14 the operator pod restarts continuously. The startup failure for that upgrade is a null pointer when an `RdsTopic` exists and the matching `KafkaTopic` does not (see [Kafka Operator Startup Exception After ACP 3.14 Upgrade](ecosystem/kafka/Kafka_Operator_Startup_Exception_After_314_Upgrade.md)).
- The operator logs `Reconciliation is in progress` after an API server outage and then never moves instances; a parameter edit in the console then waits until the operator pod is deleted. This was fixed in the ACP 3.15 operator line; deleting the operator pod is the recovery on earlier builds (see [Kafka Operator Is Blocked by an Abnormal Instance](ecosystem/kafka/Kafka_Operator_Blocked_By_Abnormal_Instance.md)).

`Reconciliation is in progress` alone does not prove a stuck operator. When the same log also has `KafkaRoller$UnforceableProblem: Pod <cluster>-kafka-<n> is currently not rollable` and `will be underreplicated (|ISR|=1 and min.insync.replicas=1) if broker <n> is restarted`, the operator is deliberately holding the roll because of ISR, which is a different problem.

### Cause 4: Entity operator memory keeps rising on a running instance

The entity-operator pod of a running instance shows memory usage climbing steadily, for example from 67 percent to 92 percent of its limit, with `strimzi-kafka-operator.v4.2.0`, an entity operator sized at 1 CPU and 1000 MiB, two users, and one topic. No memory leak is known in that Kafka version and no root cause was established. Raising the entity operator to 2 CPU and 2 GiB and continuing to observe was sufficient: the instance kept operating normally.

## Resolution

### Cause 1: The entity-operator Deployment never becomes Ready

```bash
kubectl -n <namespace> get deploy <instance>-entity-operator
kubectl -n <namespace> describe pod -l strimzi.io/name=<instance>-entity-operator
kubectl -n <namespace> get limitrange -o yaml
```

When the described containers show a tiny CPU or memory limit inherited from the namespace `LimitRange` on ACP 3.6 or 3.6.1 (or the pod is clearly throttled or `OOMKilled` on that limit), raise the namespace default limit to a size the entity operator can start with, then recreate the pod. Deleting the pod only restarts topic and user reconciliation; brokers are not affected.

```bash
kubectl -n <namespace> delete pod -l strimzi.io/name=<instance>-entity-operator
kubectl -n <namespace> rollout status deploy/<instance>-entity-operator
```

On later platforms, follow the `describe` output instead: image pull failures, unschedulable pods, and crashes in the `topic-operator` or `user-operator` container are ordinary workload faults.

### Cause 2: The namespace quota blocks the Kafka exporter

```bash
kubectl -n <namespace> get pods | grep <instance>
kubectl -n <namespace> get rs | grep <instance>-kafka-exporter
kubectl -n <namespace> describe rs <instance>-kafka-exporter-<hash>
kubectl -n <namespace> describe resourcequota
```

The exporter ReplicaSet event names the exceeded quota (`exceeded quota: <quota>, requested: ..., used: ..., limited: ...`). The exporter is normally named `<instance>-kafka-exporter`.

> **Warning:** Raising a namespace `ResourceQuota` lets that namespace consume more CPU, memory, or pods than before. Do it only when the exporter event says the quota is exceeded and the instance is failed because that pod is not running. Save the quota first; roll back by re-applying the saved file.

```bash
kubectl -n <namespace> get resourcequota <quota> -o yaml > resourcequota.bak.yaml
kubectl -n <namespace> edit resourcequota <quota>
```

Raise the exhausted hard value so it covers current usage plus the exporter request. On a project with a project quota, the namespace quota cannot exceed what the project has left; raise the project quota first if needed. After the exporter is Running, the instance status returns to normal.

### Cause 3: The cluster operator is crash-looping or not reconciling

```bash
kubectl get pods -A -l strimzi.io/kind=cluster-operator
kubectl -n <operator-namespace> logs deploy/<cluster-operator-deployment> --tail=200
kubectl -n <operator-namespace> logs deploy/<cluster-operator-deployment> --tail=500 | grep -E 'not rollable|will be underreplicated|Error getting broker config'
```

If the ISR lines are present, stop here and use the config-rollout article linked in the Issue section.

For the ACP 3.14 null pointer on an `RdsTopic` without a `KafkaTopic`:

> **Warning:** Clearing finalizers and deleting an `RdsTopic` drops that custom resource. Do it only when the operator log names that `RdsTopic` and the failure is the startup null pointer with no matching `KafkaTopic`. Back it up first and roll back by re-creating it from the backup. On versions affected by the topic deletion defect, change `spec.topicName` to an unused name before the delete if it still points at a live topic (see [Avoid Kafka Topic Data Loss When Deleting an Abnormal Topic CR](ecosystem/kafka/Kafka_Topic_Delete_Data_Loss_Issue.md)).

```bash
kubectl -n <namespace> get rdstopic <topic-cr> -o yaml > rdstopic.bak.yaml
kubectl -n <namespace> patch rdstopic <topic-cr> --type merge -p '{"metadata":{"finalizers":[]}}'
kubectl -n <namespace> delete rdstopic <topic-cr>
```

For reconciliation stuck after an API server outage, or a console parameter change that never rolls the brokers with no ISR line in the log, restart only the cluster operator. This does not restart brokers; reconciliation resumes when the new pod is up.

```bash
kubectl delete pods -A -l strimzi.io/kind=cluster-operator
kubectl get kafka -A
```

Wait until each `Kafka` returns to its previous ready state.

### Cause 4: Entity operator memory keeps rising on a running instance

```bash
kubectl get csv -A | grep -i strimzi
kubectl -n <namespace> top pod --containers | grep entity-operator
kubectl -n <namespace> get kafka <cluster> -o jsonpath='{.spec.entityOperator}{"\n"}'
kubectl -n <namespace> get kafka <cluster> -o jsonpath='{.metadata.ownerReferences}{"\n"}'
```

Raise the entity operator to 2 CPU and 2 GiB. On a Strimzi `Kafka` the resources are set per container, under `spec.entityOperator.topicOperator.resources` and `spec.entityOperator.userOperator.resources`; give the larger limit to the container that `kubectl top` shows growing. If `ownerReferences` shows the `Kafka` is owned by an `RdsKafka`, make the change on that instance (its update page or its spec) so the operator does not revert a direct edit.

> **Warning:** Changing the entity operator resources recreates the entity-operator pod. Topic and user reconciliation pauses until the new pod is Ready; brokers are not restarted. Do it only when the growing pod is the entity operator. Roll back by restoring the previous `resources` values.

```bash
kubectl -n <namespace> patch kafka <cluster> --type merge -p '{"spec":{"entityOperator":{"<topicOperator-or-userOperator>":{"resources":{"requests":{"cpu":"1","memory":"2Gi"},"limits":{"cpu":"2","memory":"2Gi"}}}}}}'
kubectl -n <namespace> rollout status deploy/<cluster>-entity-operator
```

If usage keeps climbing toward the new limit with an unchanged number of topics and users, collect the operator logs and the CSV version for escalation. Broker memory above an inspection threshold is covered in the broker memory article linked in the Issue section.

## Diagnostic Steps

1. Read the resource named in the 300000 ms sentence. A Deployment ending in `-entity-operator` is Cause 1. A ZooKeeper or broker pod, or a `Service`, is a different problem (see the related articles).

2. Operator and instance health:

   ```bash
   kubectl get pods -A -l strimzi.io/kind=cluster-operator
   kubectl get kafka,rdskafka -A
   kubectl -n <namespace> get deploy,sts,po | grep <instance>
   ```

   A cluster operator pod with a growing restart count is Cause 3.

3. Instance failed, brokers Running, exporter pod absent, and an `exceeded quota` event on its ReplicaSet: Cause 2.

4. A console parameter change that does not roll brokers: check the operator log for `not rollable`. Present means an ISR block; absent with `Reconciliation is in progress` after an API server outage means Cause 3.

5. Memory growth on a running instance: `kubectl -n <namespace> top pod --containers`. Growth in `<cluster>-entity-operator` is Cause 4; growth in a broker is not.

6. Version skew between operator and instance (an upgraded operator leaving the instance on an old version, a Kafka 2.x instance that ignores the console):

   ```bash
   kubectl -n <namespace> get kafka <cluster> -o yaml | grep -n -i version
   ```

   See [Kafka operator mismatch: wrong create page version, Kafka 2.x instance skipped, or ZooKeeper mode blocks upgrade on ACP](Kafka_operator_mismatch_wrong_create_page_version_Kafka_2x_instance_skipped_or_ZooKeeper_mode_blocks_upgrade_on_ACP.md).
