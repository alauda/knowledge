---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka 2.4.x Is Not Supported After Upgrading to ACP 3.12

:::info Applicable Versions
ACP 3.8 to 3.12 upgrade path.
:::

## Problem

The Kafka operator version used by ACP 3.12 does not support Kafka 2.4.x. ACP 3.12 supports newer Kafka versions such as 2.5.x, 2.6.x, and 2.7.x. Kafka instances that remain on 2.4.x before the platform upgrade can become abnormal after the operator is upgraded.

Management-view Kafka resources also need to be imported into the RDS business view before upgrading to ACP 3.12. Otherwise, fields can be lost because the newer CRD schema differs from the older 3.8-era schema.

## Resolution

### 1. Upgrade Kafka Before the Platform Upgrade

Before upgrading ACP to 3.12, upgrade each Kafka instance from 2.4.x to 2.5.0 or later.

You can use the product UI to perform a step-by-step version upgrade, or edit the resource YAML and update `spec.version` directly:

```yaml
spec:
  kafka:
    version: 2.5.0
```

The Kafka instance restarts brokers one by one during the version upgrade. With healthy replicas and ISR, the rolling upgrade should not interrupt service or lose data.

### 2. Import Management-View Resources

If the Kafka instance was created directly from the management view in ACP 3.8, import it into the business view before upgrading to ACP 3.12.

Use the `rdskafka-sync` tool described in the import guide:

```bash
./rdskafka-sync check cluster -n <namespace>
./rdskafka-sync sync cluster <name> -n <namespace>
```

## Impact

After a successful Kafka version upgrade and resource import, clients can continue to use the Kafka cluster normally. The operation is designed as a rolling update and should not cause data loss when the cluster is healthy.

## Important Considerations

- Do not upgrade the platform while Kafka instances are still on 2.4.x.
- Import management-view resources before the ACP 3.12 upgrade.
- Confirm all Kafka brokers and ZooKeeper pods are ready before and after the rolling update.
- Validate topic availability and consumer lag after the upgrade.
