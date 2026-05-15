---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Operator Is Blocked by an Abnormal Instance

:::info Applicable Versions
ACP 3.x Kafka operator versions before the fix included in ACP 3.15.
:::

## Problem

During an operator upgrade or reconciliation, all Kafka instances may become abnormal and the upgrade can be blocked. Operator logs show previous API server connection errors, followed by repeated messages similar to `Reconciliation is in progress`. After that, instances no longer reconcile normally.

## Resolution

Restart the Strimzi cluster operator and wait for reconciliation to resume:

```bash
kubectl delete pods --all-namespaces -l strimzi.io/kind=cluster-operator
```

After the operator pod is recreated, monitor Kafka instance status:

```bash
kubectl get kafka --all-namespaces
kubectl get pod --all-namespaces | grep cluster-operator
```

## Root Cause

This matches a known upstream Strimzi issue where reconciliation can remain blocked after API server connectivity problems. The issue is fixed in the ACP 3.15 Kafka operator line.

## Important Considerations

- Restart only the operator pod; do not delete Kafka broker pods unless a separate recovery step requires it.
- Check operator logs after restart to confirm reconciliation is progressing.
- If reconciliation remains blocked, collect operator logs and Kafka custom resource status before further changes.
