---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Node Placement Affinity and Taints Guide

## Scenario

Some customer clusters run both business applications and middleware. In those cases, RabbitMQ should run only on dedicated middleware nodes, and unrelated workloads should be kept away from those nodes.

## Goals

1. Reserve selected nodes for middleware workloads.
2. Ensure RabbitMQ pods schedule only onto those reserved nodes.
3. Spread RabbitMQ replicas across different nodes for high availability.

## Recommended Approach

1. Add taints to the dedicated middleware nodes.
2. Add labels to the same nodes.
3. Configure RabbitMQ node affinity to match the labels.
4. Configure RabbitMQ tolerations to accept the taints.
5. Configure pod anti-affinity so replicas do not land on the same node.

## Example Configuration

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: rabbitmq3816
  namespace: operators
spec:
  replicas: 3
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: rabbitmq3816
          topologyKey: kubernetes.io/hostname
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: middleware
                operator: In
                values:
                  - "enable"
  tolerations:
    - key: middleware
      operator: Equal
      value: enable
      effect: NoSchedule
```

## Expected Result

- Only RabbitMQ workloads that tolerate the middleware taint can use the dedicated nodes.
- RabbitMQ replicas are scheduled only on nodes labeled for middleware.
- Anti-affinity prevents multiple replicas of the same cluster from landing on one node.

## Notes

- Keep label keys and taint keys aligned across teams.
- Verify node capacity before pinning multiple middleware clusters to the same node pool.
