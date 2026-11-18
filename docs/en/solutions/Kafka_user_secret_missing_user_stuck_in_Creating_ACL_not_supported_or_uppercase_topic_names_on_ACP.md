---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
---

# Kafka user secret missing, user stuck in Creating, ACL not supported, or uppercase topic names on ACP

## Issue

A Kafka user was created from Data Services, but opening its secret (`保密字典`, Secret) says the resource does not exist. The user shows one of these:

- `Simple authorization ACL rules are configured but not supported in the Kafka cluster configuration.` The same is often reported as "works on Kafka 2.8, fails on Kafka 2.7".
- `status.phase` stays `Creating` with `Events: <none>`, on an instance that uses `SCRAM-SHA-512` and where user creation used to work. Other Kafka instances in the same cluster create users normally, and other recently created users of the same instance also have an empty `READY` column in `kubectl get kafkauser`.

Also covered: client applications fail with a permission error after Kafka users and topics were migrated, and the topic creation form rejects uppercase letters in the topic name.

A client whose user and secret exist but which gets `TopicAuthorizationException: Not authorized to access topics` needs the ACL and listener setup in [Kafka client connection failures: timeouts, TLS certificates, authorization, NodePort, and reverse DNS on ACP](Kafka_client_connection_failures_timeouts_TLS_certificates_authorization_NodePort_and_reverse_DNS_on_ACP.md).

## Environment

- A Data Services Kafka user is an `RdsKafkaUser` (`middleware.alauda.io/v1`, label `middleware.alauda.io/cluster: <instance>`). The operator creates a Strimzi `KafkaUser` (`kafka.strimzi.io/v1beta2`, label `strimzi.io/cluster: <instance>`) with the same name and spec.
- The `KafkaUser` is reconciled by the `user-operator` container of the Deployment `<instance>-entity-operator`, which also runs `topic-operator` and `tls-sidecar`.
- The password of a SCRAM user is kept in a Secret named `<user>-password`, which the `RdsKafkaUser` references.

## Root Cause

### Cause 1: Simple authorization ACL rules are configured but not supported in the Kafka cluster configuration

The user carries `authorization.type: simple` with ACL rules, but the instance was created without an authentication method, so authorization is not enabled in the cluster configuration. The user is not provisioned and its secret is never created. The Kafka version is not the cause: a Kafka 2.8 instance created the same way shows the same error. To use ACLs, `authorization.type: simple` must be enabled on the instance before topic or group ACLs are configured.

### Cause 2: A user with the same name already exists

The name entered in the Data Services form is already taken, for example by a `KafkaUser` created earlier directly through the Kafka Operator. Creating a user with the same name from Data Services fails.

### Cause 3: The user-operator is hung while its Deployment still reports Ready

The `user-operator` container of `<instance>-entity-operator` stops reconciling users, while the Deployment still shows `READY 1/1` and the pod is Running. Its log repeats:

```text
WARNING: A connection to https://<apiserver>/ was leaked. Did you forget to close a response body?
WARN  WatcherWebSocketListener:76 - Exec Failure java.io.FileNotFoundException /home/strimzi/.kube/config (No such file or directory)
```

Every new user of that instance stays in `Creating` and gets no secret. Authorization being disabled and a duplicate name are ruled out. Restarting the entity operator restores user creation.

### Cause 4: Client permission error after migrating users and topics: the `<user>-password` secret is missing

The `<user>-password` secret that the `RdsKafkaUser` references was not migrated, so client authentication fails.

### Cause 5: Can a Kafka topic name contain uppercase letters?

Yes. Kafka topic names allow uppercase letters, and so does the topic resource; only the creation form rejects them.

## Resolution

### Cause 1: Simple authorization ACL rules are configured but not supported in the Kafka cluster configuration

```bash
kubectl -n <namespace> get kafkauser <user> -o jsonpath='{.spec.authorization}{"\n"}{.status.conditions}{"\n"}'
kubectl -n <namespace> get kafka <instance> -o jsonpath='{.spec.kafka.authorization}{"\n"}{.spec.kafka.listeners}{"\n"}'
```

An empty `spec.kafka.authorization` together with the error confirms this cause. Choose one fix:

- If the user does not need ACLs, remove `spec.authorization` from the `RdsKafkaUser`. The user is then provisioned and its secret appears.
- If ACLs are required, enable authorization on the instance through the platform, so that the cluster runs with `authorization.type: simple` and an authentication method on its listeners, and then configure the topic and group ACLs.

Edit the `RdsKafkaUser`, not the `KafkaUser`: the operator writes the `RdsKafkaUser` spec over the `KafkaUser`.

```bash
kubectl -n <namespace> edit rdskafkauser <user>
kubectl -n <namespace> get rdskafkauser,kafkauser <user>
```

### Cause 2: A user with the same name already exists

```bash
kubectl -n <namespace> get kafkauser,rdskafkauser
kubectl -n <namespace> get kafkauser <user> -o jsonpath='{.metadata.creationTimestamp}{"\n"}'
```

A `KafkaUser` older than the Data Services request was created earlier, outside this request. Create the Data Services user with a name that is not used in that namespace.

### Cause 3: The user-operator is hung while its Deployment still reports Ready

1. Rule out Cause 1 and Cause 2 with the commands above, then confirm the signature:

   ```bash
   kubectl -n <namespace> describe rdskafkauser <user>
   kubectl -n <namespace> logs deploy/<instance>-entity-operator -c user-operator --tail=300 | grep -E 'Exec Failure|was leaked'
   kubectl -n <namespace> get deploy <instance>-entity-operator
   ```

   Repeated `Exec Failure java.io.FileNotFoundException /home/strimzi/.kube/config` lines, with the Deployment at `1/1`, confirm this cause. A `READY 1/1` Deployment does not prove the user-operator works.

2. Restart the entity operator.

> **Warning:** Restarting the entity operator restarts the `topic-operator`, `user-operator`, and `tls-sidecar` containers; topic and user reconciliation pauses until the new pod is Ready. Brokers are not restarted and clients are not affected. Do it only when users stay in `Creating` and the `user-operator` log shows the `Exec Failure ... /home/strimzi/.kube/config` lines. No rollback is needed; the Deployment recreates the pod with the same spec.

   ```bash
   kubectl -n <namespace> rollout restart deploy/<instance>-entity-operator
   kubectl -n <namespace> rollout status deploy/<instance>-entity-operator
   ```

3. Check every user of the instance, not only the one reported. Each user that was stuck in `Creating` should become `Active`, and its secret should open:

   ```bash
   kubectl -n <namespace> get rdskafkauser
   kubectl -n <namespace> get kafkauser
   kubectl -n <namespace> get secret | grep <user>
   ```

If the `Exec Failure` lines come back later, collect the user-operator log and the operator version before restarting again.

### Cause 4: Client permission error after migrating users and topics: the `<user>-password` secret is missing

```bash
kubectl -n <namespace> get rdskafkauser <user> -o jsonpath='{.spec.authentication}{"\n"}'
kubectl -n <namespace> get secret <user>-password
```

`Error from server (NotFound)` for `<user>-password` confirms this cause. Reset the password of the user on its Data Services user page; the reset recreates the `<user>-password` secret and restores access.

> **Warning:** A reset gives the user a new password. Every client that authenticates as this user must be updated, and clients that keep the old password fail. Do it only when the `<user>-password` secret of that user is missing. The old password cannot be restored, so plan the client updates first.

```bash
kubectl -n <namespace> get secret <user>-password
kubectl -n <namespace> get secret <user> -o jsonpath='{.data.sasl\.jaas\.config}' | base64 -d
```

When users are migrated again, migrate each `<user>-password` secret together with its `RdsKafkaUser`.

### Cause 5: Can a Kafka topic name contain uppercase letters?

Create the topic from YAML instead of the form. A Kubernetes object name cannot contain uppercase letters, so keep `metadata.name` lowercase and put the real topic name in `spec.topicName`. Start from an existing topic of the same instance so labels and fields match your operator version:

```bash
kubectl -n <namespace> get rdstopic <existing-topic> -o yaml > new-topic.yaml
```

In `new-topic.yaml`, delete `metadata.resourceVersion`, `metadata.uid`, `metadata.creationTimestamp`, `metadata.generation`, `metadata.managedFields`, and the `status` block, then change only the two names:

```yaml
metadata:
  name: <lowercase-object-name>
spec:
  topicName: <TopicNameWithUppercase>
```

```bash
kubectl -n <namespace> create -f new-topic.yaml
kubectl -n <namespace> get rdstopic <lowercase-object-name> -o jsonpath='{.spec.topicName}{"\n"}'
```

Do not reuse a `spec.topicName` that another topic resource already uses; on some versions deleting the duplicate resource can clear the existing topic (see [Avoid Kafka Topic Data Loss When Deleting an Abnormal Topic CR](ecosystem/kafka/Kafka_Topic_Delete_Data_Loss_Issue.md)).

## Diagnostic Steps

1. Read the user objects:

   ```bash
   kubectl -n <namespace> get rdskafkauser <user> -o yaml
   kubectl -n <namespace> get kafkauser <user> -o yaml
   kubectl -n <namespace> get secret | grep <user>
   ```

2. Match the signature:

   - `Simple authorization ACL rules are configured but not supported in the Kafka cluster configuration.`: Cause 1.
   - A `KafkaUser` with that name existed before the Data Services request: Cause 2.
   - `phase: Creating` with no events, `spec.kafka.authorization` is `{"type":"simple"}`, no older user of that name, and `Exec Failure java.io.FileNotFoundException /home/strimzi/.kube/config` in the `user-operator` log: Cause 3.
   - The user is `Active` but `<user>-password` is missing after a migration: Cause 4.
   - The user and its secrets exist and the client gets `TopicAuthorizationException`: the client connection article linked above.

3. Check that the entity operator is running at all. A Deployment that is not Ready, or whose memory keeps rising, is covered in [Kafka instance creation times out on the entity-operator, shows failed, or the cluster operator restarts on ACP](Kafka_instance_creation_times_out_on_the_entity-operator_shows_failed_or_the_cluster_operator_restarts_on_ACP.md).

   ```bash
   kubectl -n <namespace> get deploy <instance>-entity-operator
   kubectl -n <namespace> top pod --containers | grep entity-operator
   ```
