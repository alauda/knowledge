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

# No Kafka in Data Services, or Alauda Build of Kafka 2 unpublished or failing to deploy on ACP

## Issue

Kafka cannot be offered to business namespaces because its operator is missing or unhealthy:

- The Data Services menu lists other services (for example MySQL, Redis, PostgreSQL) but no Kafka, so there is no **Create Kafka Instance** button. `kubectl get po -A | grep kafka` lists only `cpaas-kafka-0/1/2` in `cpaas-system`. Often the request started as "connect a Kafka web UI such as kafka-ui to the platform Kafka".
- OperatorHub shows Alauda Build of Kafka 2 as not published (`未上架`), or its install fails on ACP 4.1.
- After the global cluster was upgraded (for example from 3.18 to 4.0.12), a business cluster no longer lists MySQL or Kafka, while they still appear on the global cluster.
- Kafka, MySQL, and RabbitMQ operators all show abnormal at the same time.

Related articles: [Kafka instance creation times out on the entity-operator, shows failed, or the cluster operator restarts on ACP](Kafka_instance_creation_times_out_on_the_entity-operator_shows_failed_or_the_cluster_operator_restarts_on_ACP.md) covers create failures once the operator is installed. A Kafka 2.x instance that the installed operator skips is covered in [Kafka operator mismatch: wrong create page version, Kafka 2.x instance skipped, or ZooKeeper mode blocks upgrade on ACP](Kafka_operator_mismatch_wrong_create_page_version_Kafka_2x_instance_skipped_or_ZooKeeper_mode_blocks_upgrade_on_ACP.md).

## Root Cause

### Cause 1: Data Services has no Kafka menu because the Kafka operator is not deployed

The `cpaas-kafka-*` pods in `cpaas-system` are the platform's own Kafka, used by platform components, not a business instance. The Data Services Kafka feature switch is off and the Kafka operator (Alauda Streaming Service for Kafka) is not installed, so Data Services offers no Kafka. A web UI or business traffic should use a Data Services Kafka instance; the platform Kafka is not reconfigured for that.

### Cause 2: Alauda Build of Kafka 2 fails to deploy on ACP 4.1 because Kafka Operator 3.x earlier than 4.2 is not deployed first

On ACP 4.1 (for example 4.1.3), installing Alauda Build of Kafka 2 fails at the operator deployment. On platform 4.1, Kafka Operator 3.x must be deployed before Kafka Operator 2.x, and that 3.x operator must be a version earlier than 4.2: Kafka Operator 3.x 4.2 and later no longer supports Kafka 2.x.

### Cause 3: The Alauda Build of Kafka 2 package has not been pushed with the matching violet

OperatorHub shows Alauda Build of Kafka 2 (for example `4.0.3` on a 4.0.9 cluster) as not published, and no `kafka-operator-2x` `artifactversion` exists yet. The operator package has to be uploaded with `violet push`, using the `violet` version that matches the package rather than simply the `violet` that came with the platform.

### Cause 4: The Kafka 2 bundle artifact name does not match OperatorHub

The package is uploaded, `artifactversion` for `kafka-operator-2x` is `Present` and `Success`, and `packagemanifest` `strimzi-kafka-operator-2x` exists, but the marketplace still shows Alauda Build of Kafka 2 as not published. OperatorHub does not accept an artifact named `kafka-operator-2x`; the name needs the `operatorhub-` prefix.

### Cause 5: Global and business clusters are on incompatible versions

The global cluster is 4.0.12 after an upgrade from 3.18 (Data Services Essentials `v4.0.23` on the global side) while the business cluster is still on the previous version. MySQL and Kafka disappear from the business cluster view. Errors in other products (for example service mesh) in the same window come from the same version skew.

### Cause 6: MySQL (MGR) operator 4.4.4 with MySQL 8.0 makes several middleware operators abnormal

Kafka, MySQL, and RabbitMQ operators show abnormal together. MGR Operator 4.4.4 does not support MySQL 8.0. The Kafka operator status clears after the MySQL operator and Data Services Essentials are moved back to the 4.3 line, not after a Kafka restart.

## Resolution

### Cause 1: Data Services has no Kafka menu because the Kafka operator is not deployed

```bash
kubectl get po -A | grep -i kafka
kubectl get csv -A | grep -i kafka
kubectl get packagemanifest -A | grep -i kafka
```

If the only Kafka pods are `cpaas-kafka-*` in `cpaas-system` and no Kafka operator CSV exists:

1. Enable the Kafka feature switch for Data Services.
2. Install Alauda Streaming Service for Kafka from **OperatorHub**: target cluster, channel `stable`, namespace `kafka-system`, and the operator version that matches your platform (for example `4.1.0`). On clusters that still need Kafka 2.x, respect the version limit in Cause 2.
3. Confirm the operator is running, then reload Data Services. The Kafka menu and **Create Kafka Instance** appear.

   ```bash
   kubectl -n kafka-system get pods
   kubectl get csv -A | grep -i kafka
   ```

4. Create the business instance. For an SSL client such as kafka-ui, the create form offers in-cluster access with link encryption (Plain/SCRAM-SHA-512, or TLS with SCRAM-SHA-512 or TLS authentication) and out-of-cluster `NodePort` access with TLS. Deploy the community web UI separately and point it at the instance. Client certificates and users are covered in [Kafka client connection failures: timeouts, TLS certificates, authorization, NodePort, and reverse DNS on ACP](Kafka_client_connection_failures_timeouts_TLS_certificates_authorization_NodePort_and_reverse_DNS_on_ACP.md).

### Cause 2: Alauda Build of Kafka 2 fails to deploy on ACP 4.1 because Kafka Operator 3.x earlier than 4.2 is not deployed first

```bash
kubectl get packagemanifest,artifact,artifactversion -A | grep kafka
kubectl get csv -A | grep -i kafka
```

If `artifactversion` `kafka-operator-2x.*` is `Present` and `Success` and the only problem is that the marketplace shows the package as not published, use Cause 4. If the Kafka Operator 2.x deployment fails and no Kafka Operator 3.x is installed, or the installed 3.x is 4.2 or later:

1. Deploy Kafka Operator 3.x at a version earlier than 4.2 from the marketplace.
2. Deploy Kafka Operator 2.x (Alauda Build of Kafka 2) after the 3.x operator is running.
3. Confirm both CSVs are `Succeeded` with `kubectl get csv -A | grep -i kafka`.

Do not upgrade the 3.x operator to 4.2 or later on a cluster that still needs Kafka 2.x.

### Cause 3: The Alauda Build of Kafka 2 package has not been pushed with the matching violet

1. Confirm the package objects are missing:

   ```bash
   kubectl get packagemanifest,artifact,artifactversion -A | grep kafka
   ```

2. Push the Alauda Build of Kafka 2 package with the `violet` version that matches it (check with `violet version`), choosing a package version that supports the platform and the Kafka version (`v4.0.3` supports platform 4.0 and 4.1 with Kafka 2.5, 2.7, and 2.8):

   ```bash
   violet push <kafka-2-operator-package>.tgz \
     --platform-address "https://<platform-address>" \
     --platform-username "<platform-user>" \
     --platform-password "<platform-password>" \
     --clusters "<cluster>"
   ```

3. Publish it and install it from **OperatorHub** (channel `stable`). If `artifactversion` is now `Present`/`Success` and the package is still not published, continue with Cause 4.

### Cause 4: The Kafka 2 bundle artifact name does not match OperatorHub

> **Warning:** Deleting the `artifactversion` and the old `artifact` removes the objects OperatorHub is currently ignoring. Do it only when `kafka-operator-2x` is `Present` and `Success` but Alauda Build of Kafka 2 still shows as not published, and only after both objects are saved to YAML. Roll back by re-applying the backup files.

```bash
kubectl get packagemanifest,artifact,artifactversion -A | grep kafka
kubectl -n cpaas-system get artifactversion <kafka-operator-2x-artifactversion> -o yaml > artifactversion.bak.yaml
kubectl -n cpaas-system get artifact kafka-operator-2x -o yaml > artifact.bak.yaml
kubectl -n cpaas-system delete artifactversion <kafka-operator-2x-artifactversion>
```

Use the `artifactversion` name in your cluster (for the 4.0.3 bundle it is `kafka-operator-2x.v4.0.3`). Copy `artifact.bak.yaml` to `operatorhub-kafka-operator-2x.yaml` and edit it:

- Remove `resourceVersion`, `uid`, `creationTimestamp`, `generation`, `managedFields`, and the whole `status` block.
- Set `metadata.name` to `operatorhub-kafka-operator-2x`.
- Set the `spec.artifactVersionSelector.matchLabels` key `cpaas.io/artifact-version` to `operatorhub-kafka-operator-2x`.
- Keep the existing `registry`, `repository`, and `type: bundle` values.

```bash
kubectl -n cpaas-system apply -f operatorhub-kafka-operator-2x.yaml
kubectl -n cpaas-system delete artifact kafka-operator-2x
```

Publish the bundle again the same way it was first uploaded. Confirm that `kubectl -n cpaas-system get artifact operatorhub-kafka-operator-2x -o yaml` reports a synced `status` and that OperatorHub lists the Kafka 2 operator as available.

### Cause 5: Global and business clusters are on incompatible versions

Upgrade the business cluster, and the middleware components on it, to versions compatible with the global cluster. No configuration change brings the menus back while the business cluster stays on the old version. Data Services Essentials `v4.0.23` is the global version in this situation, not a downgrade target.

### Cause 6: MySQL (MGR) operator 4.4.4 with MySQL 8.0 makes several middleware operators abnormal

> **Warning:** Moving the MySQL operator to 4.3.2 and Data Services Essentials to 4.3.3 downgrades those two components and restarts their workloads. Do it only when Kafka, MySQL, and RabbitMQ operators went abnormal together and the installed MGR or MySQL operator is 4.4.4 with MySQL 8.0. Returning to 4.4.4 brings the incompatibility back.

Install MySQL operator 4.3.2 and Data Services Essentials 4.3.3 through the same marketplace path used for 4.4.4. The Kafka operator status recovers with them.

```bash
kubectl get csv -A | grep -Ei 'mysql|kafka|rabbit'
```

## Diagnostic Steps

1. Is any business Kafka operator installed?

   ```bash
   kubectl get csv -A | grep -i kafka
   kubectl get po -A | grep -i kafka
   ```

   No Kafka operator CSV and only `cpaas-kafka-*` pods in `cpaas-system`: Cause 1.

2. Marketplace state of the Kafka 2 package:

   ```bash
   kubectl get packagemanifest,artifact,artifactversion -A | grep kafka
   ```

   No `kafka-operator-2x` objects at all: Cause 3. `Present` plus `Success` with a name that lacks `operatorhub-`: Cause 4. The package is published but its deployment fails on 4.1: Cause 2.

3. Menus missing only on business clusters right after a global upgrade: compare the cluster versions on the cluster list. Different minor versions: Cause 5.

4. Several middleware operators abnormal on the same day as a MySQL operator change: compare the CSV versions with Cause 6 before restarting Kafka.
