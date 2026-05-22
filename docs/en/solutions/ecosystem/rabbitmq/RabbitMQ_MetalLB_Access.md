---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ MetalLB Access

:::info Applicable Versions
Validated for ACP 3.16.
:::

## Problem

Expose RabbitMQ through MetalLB when the environment already provides a MetalLB-based `LoadBalancer` implementation.

## Prerequisites

- MetalLB is already deployed and working in the cluster.

## Configuration

Set the RabbitMQ service type to `LoadBalancer` and disable node port allocation for the Service override:

```yaml
spec:
  service:
    type: LoadBalancer
  override:
    service:
      spec:
        allocateLoadBalancerNodePorts: false
```

## Verification

1. Create or update the instance.
2. Confirm that the cluster status becomes ready.
3. Check the Service:

```bash
kubectl get svc -n <namespace> | grep <cluster-name>
```

Use the Service external IP with the standard RabbitMQ ports:

| Access Type | Address |
| --- | --- |
| Client connection | `<external-ip>:5672` |
| Management UI | `<external-ip>:15672` |

## Validation

- Open the management UI through the external IP.
- Publish and consume a test message through the exposed endpoint.

## Notes

The assigned MetalLB IP stays stable as long as the Service is not deleted and recreated.
