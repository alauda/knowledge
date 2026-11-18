---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - 4.0.x
  - 4.2.x
---

# Planning an ACP upgrade to 4.2.6: the 4.0.12 starting version, PostgreSQL operator order and Kafka 2.x instances

## Issue

A platform is upgraded in several hops, for example from ACP 3.18.1 to 4.0 and then to 4.2.6, and the plan is blocked by one of these questions:

- The 4.2 documentation says the supported path is `4.0` → `4.2`, but the published upgrade path for 4.2.6 shows 4.0.12 as its starting version. Can a cluster on an earlier 4.0 patch, such as 4.0.10, go straight to 4.2.6?
- After the platform reaches 4.0.12 the PostgreSQL operator is on its 4.0 line (for example 4.0.25). The compatibility lists seem to block both orders: the PostgreSQL operator 4.0 line is not listed for ACP 4.2, the 4.1 line is not listed for ACP 4.0, and the operator itself is upgraded one minor line at a time (4.0 → 4.1 → 4.2 → 4.3). Which goes first: the platform upgrade to 4.2.6, or the operator upgrade to 4.1?
- Kafka instances still run Kafka 2.x (for example 2.5), and the Kafka operator that comes with the 4.2.6 platform is on the 4.3 line (for example 4.3.3 or 4.3.5). Does that operator support Kafka 2.x?

## Root Cause

### Cause 1: the published upgrade path for 4.2.6 starts from 4.0.12

The documentation describes supported upgrades between minor versions (`4.0` → `4.2`). The recommended upgrade path published for a target release is more specific: it names the patch version that the upgrade to that release starts from. For 4.2.6 that starting version is 4.0.12. A cluster on an earlier 4.0 patch is first upgraded to 4.0.12 and then to 4.2.6; from 3.18.1 the path is 3.18.1 → 4.0.12 → 4.2.6. A plan made for an earlier 4.2 patch (for example 3.18.1 → 4.0.10 → 4.2.5) is adjusted when the target changes to 4.2.6.

### Cause 2: upgrade the PostgreSQL operator to 4.1 before the platform upgrade

With the constraints above, neither order keeps every component inside its compatibility list for the whole upgrade. The recommended order is to upgrade the PostgreSQL operator from 4.0 to 4.1 first, while the platform is still on 4.0.12, and to upgrade the platform to 4.2.6 afterwards. Upgrading the operator first has the smaller impact.

### Cause 3: Kafka 2.x is not managed by the 4.2 and later Kafka operator lines

The Kafka operator lines from 4.2 on no longer manage Kafka 2.x instances, so the 4.3 operator that comes with the 4.2.6 platform does not cover an existing Kafka 2.5 instance. On ACP 4.2, Kafka 2.x instances run when the Kafka operator 4.1 line (`kafka-operator` 4.1) is deployed together with the Kafka 2 operator (`kafka-operator-2x`). This combination has been verified only to the point that the Kafka 2.x Pods run; other functions were not tested on ACP 4.2.

Both of these operators are past the end of their support: they receive no further support and no vulnerability fixes. Running Kafka 2.x on ACP 4.2 this way is a stopgap until the instances are moved to a Kafka version that the current operator line supports.

## Resolution

### Cause 1

1. Check the current platform version and compare it with the starting version in the recommended upgrade path published for the target release.
2. If the cluster is on a 4.0 patch earlier than 4.0.12, upgrade it to 4.0.12 first, following the ACP 4.0 upgrade documentation, and validate it.
3. Then upgrade from 4.0.12 to 4.2.6, following the ACP 4.2 upgrade documentation.

> **Warning:** Each platform upgrade restarts platform components and upgrades every cluster, `global` first. Precondition: the pre-upgrade checks of the target version pass. Rollback: follow the recovery guidance in the upgrade documentation of the target version, and take the backups it requires before you start.

### Cause 2

1. On ACP 4.0.12, back up every PostgreSQL instance and confirm that all instances are `Running` (Diagnostic Steps, step 2).
2. Upgrade the PostgreSQL operator from the 4.0 line to the 4.1 line in OperatorHub.

   > **Warning:** While the operator is replaced, no PostgreSQL instance is reconciled, and the new operator reconciles every instance when it starts. OLM does not downgrade an operator in place, so the way back is restoring the instance backups taken in step 1. Do this in a maintenance window, and only when every instance is healthy beforehand.

3. Wait until the 4.1 operator is `Succeeded` and every instance is `Running` again.
4. Upgrade the platform from 4.0.12 to 4.2.6 (Cause 1).
5. Continue the operator upgrade one minor line at a time (4.1 → 4.2 → 4.3) as the target platform version requires, checking the instances after each step.

### Cause 3

1. Before the platform upgrade, list the Kafka instances and their versions (Diagnostic Steps, step 3). If any instance runs Kafka 2.x, do not let the Kafka operator move to the 4.2 or 4.3 line on that cluster while the instance exists.
2. To keep Kafka 2.x instances running on ACP 4.2, deploy the Kafka operator 4.1 line together with the Kafka 2 operator (`kafka-operator-2x`) instead of the 4.3 operator. Expect only the Pods to be covered by testing on ACP 4.2, and no support or vulnerability fixes for either operator.
3. Plan the move of every Kafka 2.x instance to a Kafka version supported by a current operator line, following the product upgrade documentation of the Kafka operator (moving to the 4.2 line also requires KRaft mode; see the product document "Migrate from ZooKeeper to KRaft mode").

## Diagnostic Steps

1. Platform version: check the current platform version in the platform console and compare it with the starting version of the published upgrade path for the target release.

2. PostgreSQL operator and instances:

   ```bash
   kubectl get csv -A | grep -i postgres
   kubectl get postgresql -A \
     -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,VER:.spec.postgresql.version,STATUS:.status.PostgresClusterStatus
   ```

   The CSV version shows the operator line (`4.0.x`, `4.1.x`, ...). Every instance should show `Running` before and after each operator step.

3. Kafka operators and instance versions:

   ```bash
   kubectl get csv -A | grep -i kafka
   kubectl get rdskafka -A -o yaml | grep -nE '^\s+(name|namespace|version):'
   ```

   A `version` of `2.x` on any instance means the cluster needs the Kafka 4.1 operator plus the Kafka 2 operator on ACP 4.2 (Cause 3). A Kafka CSV on the `4.2.x` or `4.3.x` line with such an instance present is the combination to avoid.
