---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# How to Run RabbitMQ as Root User

:::info Applicable Versions
ACP 3.12 and later.
:::

## Background

RabbitMQ normally runs internal processes as a non-root user. Some environments need root-level access to integrate with existing storage or platform constraints.

## Configuration

Add the following override to the `RabbitmqCluster`:

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: my-rabbitmq
spec:
  override:
    statefulSet:
      spec:
        template:
          spec:
            securityContext:
              runAsUser: 0
```

## Verification

Check the running user in a RabbitMQ pod:

```bash
kubectl -n <namespace> exec -ti my-rabbitmq-server-0 -- id
```

Expected result includes:

```text
uid=0(root)
```

## Notes

- Use root only when the environment requires it.
- Review storage permissions, init container behavior, and security policy impact before applying this change.
