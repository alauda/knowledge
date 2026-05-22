---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Run Kafka Pods as the Root User

:::info Applicable Versions
ACP 3.12 and later.
:::

## Problem

Kafka components normally run with a non-root user for security. Some storage integrations or legacy environments require Kafka and ZooKeeper pods to run as UID 0 and use root-owned filesystems.

Use this only when the storage integration cannot work with the default non-root security context.

## Procedure

When creating the Kafka instance, switch to the YAML view and add pod security context settings under both `spec.kafka.template.pod` and `spec.zookeeper.template.pod`:

```yaml
spec:
  kafka:
    template:
      pod:
        securityContext:
          runAsUser: 0
          fsGroup: 0
  zookeeper:
    template:
      pod:
        securityContext:
          runAsUser: 0
          fsGroup: 0
```

Create or update the instance, then enter a pod and verify the effective user:

```bash
kubectl -n <namespace> exec -it <kafka-pod> -- id
kubectl -n <namespace> exec -it <zookeeper-pod> -- id
```

## Important Considerations

- Running as root weakens the default security posture. Use it only when storage requirements make it necessary.
- Confirm the namespace security policy, admission policy, or Pod Security Admission level allows UID 0.
- Re-test volume permissions after storage class or CSI driver changes.
- Document the exception for security review.
