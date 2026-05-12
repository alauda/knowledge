---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Avoid Kafka Topic Data Loss When Deleting an Abnormal Topic CR

:::info Applicable Versions
Affected versions: ACP 3.10.x, <= 3.12.3, <= 3.14.2, <= 3.16.1. Fixed in ACP 3.12.4, 3.14.3, 3.16.2, and 3.18.
:::

## Problem

If a Kafka topic named `test` already exists, and a user creates a second topic custom resource whose `spec.topicName` is also `test`, the second topic custom resource enters an abnormal state. In affected versions, deleting that abnormal custom resource can delete or clear data from the existing topic.

The issue is triggered by a community deletion logic bug that does not correctly verify the relationship between the private topic and the custom resource being deleted.

## Trigger Conditions

The issue requires both of these actions:

1. A user creates a topic custom resource and manually sets `spec.topicName` to a topic name already used by another topic custom resource.
2. The user deletes the abnormal topic custom resource.

If `spec.topicName` is not set manually, the topic name defaults to the custom resource name and the issue is less likely to be triggered.

## Workaround

Before deleting the abnormal topic custom resource, change its `spec.topicName` to a new unused topic name. Then delete the abnormal custom resource.

```bash
kubectl -n <namespace> edit rdstopic <abnormal-topic-cr>
```

Update the topic name to a disposable unused name:

```yaml
spec:
  topicName: unused-topic-name-for-cleanup
```

Then delete the custom resource:

```bash
kubectl -n <namespace> delete rdstopic <abnormal-topic-cr>
```

## Important Considerations

- Do not delete an abnormal topic CR if its `spec.topicName` points to an existing valid topic.
- Prefer leaving `spec.topicName` empty so the operator uses the CR name as the topic name.
- Upgrade to a fixed version where available.
- Before deleting topic resources in affected versions, confirm both the CR name and `spec.topicName` relationship.
