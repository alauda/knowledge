---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Operator Startup Exception After ACP 3.14 Upgrade

:::info Applicable Versions
ACP 3.14 operator upgrade paths affected by the referenced issue.
:::

## Problem

After upgrading the Kafka operator, the operator can start abnormally when an `RdsTopic` custom resource exists but the corresponding `KafkaTopic` custom resource does not exist. The operator may hit a null pointer panic during startup.

## Resolution

Identify the `RdsTopic` resource named in the operator error logs and remove its finalizers, then delete the stale resource.

```bash
kubectl -n <namespace> get rdstopic
kubectl -n <namespace> patch rdstopic <topic-cr-name> \
  --type=merge \
  -p '{"metadata":{"finalizers":[]}}'
kubectl -n <namespace> delete rdstopic <topic-cr-name>
```

Restart the operator if it does not recover automatically:

```bash
kubectl delete pods --all-namespaces -l strimzi.io/kind=cluster-operator
```

## Important Considerations

- Patch only the stale `RdsTopic` reported by the logs.
- Confirm whether a real Kafka topic still exists before deleting product-layer resources.
- Collect operator logs before remediation if this needs escalation.
