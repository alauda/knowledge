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
  - "4.3"
  - "4.4"
---

# Kafka operator mismatch: wrong create page version, Kafka 2.x instance skipped, or ZooKeeper mode blocks upgrade on ACP

## Issue

One of these appears after a platform upgrade or after the Kafka operator version was changed:

- The Kafka component is reported abnormal, with no error text, on a platform 4.2 cluster that still runs Kafka operator 4.1.0.
- The Data Services **Create Kafka Instance** page offers only `Kafka 4.1` or `Kafka 4.2`, although the operator was switched to a version that should offer `Kafka 3.8`. Reinstalling the operator does not change the list, and in some environments no Kafka instance can be created at all.
- A Kafka 2.x instance does not react to the console: a stop leaves it in "Stopping" with every pod still `Running`, configuration changes never reach the pods, or a broker is reported offline and nothing repairs it. `kubectl get event` in the namespace shows nothing. The cluster operator log repeats one of:

  ```text
  skip reconcile (Paused), kafka version is 2.8.2
  skip reconcile , kafka version is 2.7.0
  io.vertx.core.impl.NoStackTraceThrowable: skip reconcile, not match
  ```

- During a business-cluster upgrade, the upgrade log of the kafka functional component says the Kafka instance operator version does not match. The marketplace already shows the operator at 4.2 and the instance has not been updated.
- Questions: can the 4.3 Kafka Operator be used on a 4.1 platform, and on 4.4.0 and later are Data Services Essentials and RDS Framework still needed for Kafka?

Operator install and publish failures (no Kafka menu, Alauda Build of Kafka 2 unpublished or failing to deploy on 4.1) are covered in [No Kafka in Data Services, or Alauda Build of Kafka 2 unpublished or failing to deploy on ACP](No_Kafka_in_Data_Services_or_Alauda_Build_of_Kafka_2_unpublished_or_failing_to_deploy_on_ACP.md).

## Environment

- Kafka operator package: Alauda Streaming Service for Kafka, Subscription `strimzi-kafka-operator`, CSV `strimzi-kafka-operator.v<version>`, channel `stable`, Deployment `strimzi-cluster-operator`. It is usually installed in `kafka-system`; on clusters upgraded from 3.x it can be in another namespace such as `operators`. Find it with `kubectl get csv -A | grep -i kafka`.
- Kafka 2.x instances are served by a separate operator, Alauda Build of Kafka 2.
- The Kafka versions offered on the create page come from `ImageVersion` objects (`imageversion.middleware.alauda.io`), one per Kafka operator artifact, for example `kafka-artifact-v4.1.2` or `kafka-artifact-v4.2.0`.

## Root Cause

### Cause 1: Kafka operator 4.1.0 on platform 4.2 leaves the Kafka component abnormal

`strimzi-kafka-operator.v4.1.0` is not compatible with platform 4.2. Replacing it with operator 4.1.2, the latest release of that line at the time, fixes the component: OperatorHub then shows `strimzi-kafka-operator.v4.1.2` with status `Succeeded`, and a Kafka 3.8 instance (ZooKeeper mode) runs with its broker pods `Running (1/1)` and its PVCs `Bound`.

### Cause 2: A leftover ImageVersion from another operator version controls the create page

`kubectl get imageversion` lists two Kafka artifacts, for example `kafka-artifact-v4.1.2` and `kafka-artifact-v4.2.0`, or `kafka-artifact-v4.1.0` and `kafka-artifact-v4.3.2`.

The Kafka operator was moved to a different version (for example 4.2.0 to 4.1.2 on platform 4.2.4 to get Kafka 3.8, or a 4.3 operator was installed, uninstalled, and replaced by 4.1.0). The new operator installed cleanly (`Succeeded`, `InstallSucceeded`, "install strategy completed with no errors"), but the `ImageVersion` of the previous operator stayed in the cluster. The higher version takes priority, so the create page keeps offering the Kafka versions of the removed operator. When a lower Kafka Operator version is installed after a higher one, the leftover resources of the higher version must be cleaned up by hand.

### Cause 3: No Kafka 2 operator reconciles the Kafka 2.x instance

After an upgrade to platform 4.0 (for example from 3.16 to 4.0.9), only Alauda Streaming Service for Kafka is installed. Alauda Build of Kafka 2, the operator for Kafka 2.x instances, was not published or installed. The installed operator skips every Kafka 2.x instance on each timer reconciliation (`skip reconcile ... kafka version is 2.<x>`, `skip reconcile, not match`) and then logs it as `reconciled`. Nothing manages the instance any more: a stop from the console never reaches the pods, configuration changes are not applied, and a broker that drops out is not repaired by an operator. Alauda Build of Kafka 2 operator `v4.0.3` supports platform `v4.0` and `v4.1` and Kafka `2.5`, `2.7`, and `2.8`.

A `tlsSidecar ... has been deprecated` warning in the same log is unrelated and can be ignored.

### Cause 4: Kafka operator upgraded to 4.2 while instances still run in ZooKeeper mode

The product document "Migrate from ZooKeeper to KRaft mode" states that the v4.2.x Kafka operator supports only KRaft mode and has removed ZooKeeper mode. Before upgrading to Alauda Streaming Service for Kafka v4.2.x, every instance must be migrated to KRaft mode with the v4.1.x operator; the v4.2.x operator cannot perform that migration. Upgrading the operator to 4.2 while a ZooKeeper-mode instance exists leaves that instance behind the operator, and the cluster upgrade reports the version mismatch.

### Cause 5: Can the 4.3 Kafka Operator be used on a 4.1 platform?

The 4.3 operator is documented as compatible with 4.0, 4.1, and 4.2, but it gives a usable create page only when the conditions in the Resolution are met.

### Cause 6: On 4.4.0 and later, are Data Services Essentials and RDS Framework still needed?

The question is whether only Kafka 2 and ClickHouse Operator need to be deployed on v4.4.0 and later, without the web console plugins Alauda Container Platform Data Services Essentials and Alauda Container Platform Data Services RDS Framework.

## Resolution

### Cause 1: Kafka operator 4.1.0 on platform 4.2 leaves the Kafka component abnormal

```bash
kubectl get csv -A | grep strimzi-kafka-operator
kubectl -n <operator-namespace> get subscription strimzi-kafka-operator -o jsonpath='{.status.installedCSV}{"\n"}'
```

When the CSV is `strimzi-kafka-operator.v4.1.0` and the platform is 4.2, replace it with operator 4.1.2 in **Administrator > App Marketplace Management > OperatorHub** (Alauda Streaming Service for Kafka, channel `stable`). If 4.1.2 is not offered, upload that operator package to the platform first with `violet push`.

> **Warning:** Replacing the operator restarts `strimzi-cluster-operator`. Reconciliation of every Kafka instance on the cluster pauses until the new CSV is `Succeeded`, and the new operator can then roll broker pods if it changes their images or configuration. Do it only when the installed CSV is 4.1.0 on a platform 4.2 cluster. Roll back by installing 4.1.0 again from OperatorHub.

```bash
kubectl get csv -n <operator-namespace> -w
kubectl get kafka -A
kubectl -n <namespace> get pods,pvc | grep <instance>
```

If an instance still does not recover and its data is not needed, it can be recreated after the 4.1.2 operator is `Succeeded`.

> **Warning:** Recreating an instance deletes its topics and messages; this cannot be undone. Do it only for an instance whose data is not needed.

### Cause 2: A leftover ImageVersion from another operator version controls the create page

```bash
kubectl get imageversion
kubectl get csv -A | grep strimzi-kafka-operator
```

The `ImageVersion` to remove is the Kafka artifact whose version does not match the installed CSV, for example `kafka-artifact-v4.2.0` while the CSV is `strimzi-kafka-operator.v4.1.2`.

> **Warning:** Deleting an `ImageVersion` removes the Kafka versions it provides from the create page. Do it only when two `kafka-artifact-*` objects exist, the one you delete belongs to an operator version that is no longer installed, and no instance is meant to use the versions it offers. Export it first; roll back by re-creating it from that file after removing `metadata.resourceVersion`, `metadata.uid`, and `metadata.creationTimestamp`.

```bash
kubectl get imageversion kafka-artifact-v4.2.0 -o yaml > kafka-artifact-v4.2.0.yaml
kubectl delete imageversion kafka-artifact-v4.2.0
kubectl get imageversion
```

Refresh the create page. It then offers `Kafka 3.8`, and with the 4.1.x operator `ZooKeeper 模式` (ZooKeeper mode) is available. When a 4.3 operator had been installed first, clean up all leftover resources of that higher-version package, including `kafka-artifact-v4.3.2`.

### Cause 3: No Kafka 2 operator reconciles the Kafka 2.x instance

1. Confirm the instance version, the skip message, and that no Kafka 2 operator is installed:

   ```bash
   kubectl get kafka -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,VERSION:.spec.kafka.version
   kubectl get csv -A | grep -i kafka
   kubectl -n <operator-namespace> logs deploy/strimzi-cluster-operator -c strimzi-cluster-operator --tail=500 | grep 'skip reconcile'
   ```

   A Kafka `2.<x>` instance, `skip reconcile ... kafka version is 2.<x>` for it, and only `strimzi-kafka-operator.v<version>` (Alauda Streaming Service for Kafka) in the CSV list confirm this cause.

2. Upload the Alauda Build of Kafka 2 operator package to the platform with `violet push`. Use the `violet` version that matches the operator package, not simply the `violet` binary that came with the platform. Use a package version that supports both the platform and the Kafka version, for example `v4.0.3` for platform 4.0 or 4.1 with Kafka 2.5, 2.7, or 2.8.

3. Publish it and install it from **OperatorHub** (Alauda Build of Kafka 2, channel `stable`). If the package is uploaded but OperatorHub still shows it as not published, or the deployment fails on 4.1, see the article on Alauda Build of Kafka 2 publishing linked in the Issue section. Do not uninstall Alauda Streaming Service for Kafka for this.

4. Restart the Kafka 2.x instance from the console (or repeat the stop that did nothing) so the Kafka 2 operator takes it over.

> **Warning:** Restarting the instance rolls its broker and ZooKeeper pods; clients reconnect and partitions led by a restarting broker move. Do it only after the Alauda Build of Kafka 2 CSV is `Succeeded`, in a maintenance window. There is nothing to roll back; if the operator does not take the instance over, collect the operator logs before further changes.

5. Check that the Kafka 2 CSV is listed and that `skip reconcile` no longer appears for the instance in the Alauda Streaming Service for Kafka log.

Alauda Build of Kafka 2 is supported only on platform v4.0 and v4.1 (see Cause 6).

### Cause 4: Kafka operator upgraded to 4.2 while instances still run in ZooKeeper mode

```bash
kubectl get kafka -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,VERSION:.spec.kafka.version,METADATA:.status.kafkaMetadataState,OPERATOR:.status.operatorLastSuccessfulVersion
kubectl get csv -A | grep strimzi-kafka-operator
```

Any instance whose `METADATA` is `ZooKeeper` blocks the v4.2.x operator. The supported order is: keep the v4.1.x operator, migrate every instance to KRaft mode following "Migrate from ZooKeeper to KRaft mode", and only then upgrade to v4.2.x.

When the operator has already been upgraded and the cluster upgrade is waiting on this mismatch, a possible workaround is to uninstall the Kafka operator temporarily so the cluster upgrade can continue. This workaround is not a verified procedure; prefer the supported order above whenever the upgrade can wait.

> **Warning:** While the Kafka operator is uninstalled, nothing reconciles any Kafka instance on the cluster: configuration changes, stop and start, users, and topics are not applied, and a deleted or evicted broker pod is not recreated by the operator. Do it only when the cluster upgrade is blocked by this mismatch and at least one instance is still in ZooKeeper mode. Reinstall the operator version that matches the instances (v4.1.x for ZooKeeper-mode instances) from OperatorHub as soon as the cluster upgrade finishes; that reinstall is the rollback.

Uninstall it from **OperatorHub** (Alauda Streaming Service for Kafka), or remove its Subscription and CSV:

```bash
kubectl -n <operator-namespace> get subscription strimzi-kafka-operator -o yaml > strimzi-kafka-operator-sub.yaml
kubectl -n <operator-namespace> delete subscription strimzi-kafka-operator
kubectl -n <operator-namespace> delete csv <installed-csv>
```

### Cause 5: Can the 4.3 Kafka Operator be used on a 4.1 platform?

Only when both conditions of the official upgrade documentation are met. First, v4.2.x and later support only KRaft mode, so every instance must already run in KRaft mode; ZooKeeper-mode instances must be migrated with the v4.1.x operator first (Cause 4). Second, Kafka 4.2.0 requires Alauda Container Platform Data Services RDS Framework 4.2.2 or later. If the 4.3 operator is later removed in favor of a lower one, clean up its leftover resources as in Cause 2.

### Cause 6: On 4.4.0 and later, are Data Services Essentials and RDS Framework still needed?

Yes for the Kafka Operator: on v4.4.0 and later it depends on Alauda Container Platform Data Services Essentials and Alauda Container Platform Data Services RDS Framework, and both must be installed to support upgrades and troubleshooting. Kafka 2 Operator does not apply there: it is supported only on v4.0 and v4.1. ClickHouse Operator does not depend on these two plugins and can be deployed without them.

```bash
kubectl get csv -A | grep -Ei 'kafka|rds-operator|clickhouse'
```

## Diagnostic Steps

1. Record the platform version, the installed Kafka operator CSVs, and the Kafka artifacts:

   ```bash
   kubectl get csv -A | grep -i kafka
   kubectl get imageversion
   kubectl -n <operator-namespace> get operatorcondition
   ```

   An `operatorcondition` with `CatalogSourcesUnhealthy` `Status: False` and `Reason: AllCatalogSourcesHealthy` is healthy; it does not explain a wrong version list.

2. The create page offers a Kafka version of a different operator version, and two `kafka-artifact-*` objects exist: Cause 2.

3. CSV `strimzi-kafka-operator.v4.1.0` on a platform 4.2 cluster with the component reported abnormal: Cause 1.

4. A Kafka 2.x instance ignores console actions or keeps a broker down, the operator log says `skip reconcile ... kafka version is 2.<x>`, and no Alauda Build of Kafka 2 CSV exists: Cause 3. Before treating a broker as offline, check its pod and the cluster state; all broker pods `1/1 Running` with the `Kafka` resource `Ready` does not by itself prove a broker failure.

5. Operator at 4.2 or later, the instance not updated, and `status.kafkaMetadataState` is `ZooKeeper`: Cause 4. A direct platform hop from 4.0 to 4.2 with the operator stuck has the same KRaft requirement.

6. Several middleware operators abnormal together, the operator crash-looping, or no Kafka menu at all: see the operator install article linked in the Issue section, or [Kafka instance creation times out on the entity-operator, shows failed, or the cluster operator restarts on ACP](Kafka_instance_creation_times_out_on_the_entity-operator_shows_failed_or_the_cluster_operator_restarts_on_ACP.md).
