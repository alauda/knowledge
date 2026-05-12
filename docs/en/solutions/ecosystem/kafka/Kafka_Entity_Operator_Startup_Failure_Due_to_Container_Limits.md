---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Entity Operator Fails to Start Because Container Limits Are Too Small

:::info Applicable Versions
ACP 3.6 and 3.6.1.
:::

## Problem

When creating a Kafka instance, the `kafka-entity-operator` pod fails to start. The pod receives only the namespace default container limit, for example a very small CPU limit, because the deployment template in the affected version does not set explicit resources for this component.

## Diagnosis

Check the entity operator pod and deployment:

```bash
kubectl -n <namespace> get pod | grep kafka-entity-operator
kubectl -n <namespace> describe pod <kafka-entity-operator-pod>
kubectl -n <namespace> get deploy <kafka-entity-operator-deploy> -o yaml
```

If the container resources are inherited from the namespace default limit and are too small for startup, the pod can repeatedly restart or stay unhealthy.

## Resolution

Increase the default container limit for the project or namespace, then recreate the affected pod so it is scheduled with the larger resource limit:

```bash
kubectl -n <namespace> delete pod <kafka-entity-operator-pod>
```

After the pod is recreated, verify that it receives the updated resource limits and becomes ready:

```bash
kubectl -n <namespace> describe pod <new-kafka-entity-operator-pod>
kubectl -n <namespace> get pod <new-kafka-entity-operator-pod>
```

## Important Considerations

- This is a template issue in the affected 3.6 releases. Later versions define standard resource parameters for the entity operator.
- Increase namespace defaults only to a value appropriate for the workload. Avoid setting broadly excessive defaults.
- If the pod still fails after resource adjustment, inspect its container logs for a second failure cause.
