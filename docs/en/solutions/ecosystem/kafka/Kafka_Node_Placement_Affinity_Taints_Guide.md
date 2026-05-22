---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Schedule Kafka on Dedicated Middleware Nodes with Affinity, Taints, and Tolerations

:::info Applicable Versions
ACP 3.8 and later. YAML examples are based on Strimzi Kafka resources.
:::

## Scenario

A business cluster already runs customer applications such as Harbor and other workloads. New nodes are added for middleware products, and Kafka must run only on those dedicated nodes. Other applications should not be scheduled onto the middleware nodes.

Use taints to repel general workloads, labels to identify middleware nodes, tolerations so Kafka can use those nodes, and node affinity so Kafka is scheduled only there.

## Implementation Plan

1. Add a taint to each middleware node.
2. Add a label to each middleware node.
3. Configure Kafka and ZooKeeper pod tolerations for the taint.
4. Configure Kafka and ZooKeeper node affinity for the label.
5. Keep pod anti-affinity enabled so highly available replicas do not land on the same node.

## Label and Taint Nodes

Example label:

```bash
kubectl label node <node-name> middleware.alauda.io/dedicated=true
```

Example taint:

```bash
kubectl taint node <node-name> middleware.alauda.io/dedicated=true:NoSchedule
```

## Kafka YAML Example

Add affinity and tolerations under both Kafka and ZooKeeper pod templates:

```yaml
apiVersion: kafka.strimzi.io/v1beta1
kind: Kafka
metadata:
  name: my-cluster
  namespace: operators
spec:
  kafka:
    replicas: 3
    template:
      pod:
        affinity:
          nodeAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              nodeSelectorTerms:
                - matchExpressions:
                    - key: middleware.alauda.io/dedicated
                      operator: In
                      values:
                        - "true"
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    strimzi.io/cluster: my-cluster
                    strimzi.io/kind: Kafka
                topologyKey: kubernetes.io/hostname
        tolerations:
          - key: middleware.alauda.io/dedicated
            operator: Equal
            value: "true"
            effect: NoSchedule
  zookeeper:
    replicas: 3
    template:
      pod:
        affinity:
          nodeAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              nodeSelectorTerms:
                - matchExpressions:
                    - key: middleware.alauda.io/dedicated
                      operator: In
                      values:
                        - "true"
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    strimzi.io/cluster: my-cluster
                    strimzi.io/kind: Kafka
                topologyKey: kubernetes.io/hostname
        tolerations:
          - key: middleware.alauda.io/dedicated
            operator: Equal
            value: "true"
            effect: NoSchedule
```

## Verify Scheduling

```bash
kubectl -n <namespace> get pod -o wide | grep <cluster-name>
kubectl describe node <middleware-node> | grep -E 'Taints|middleware.alauda.io/dedicated'
```

Confirm Kafka brokers and ZooKeeper pods are placed only on the dedicated middleware nodes and are spread across different hosts.

## Important Considerations

- A three-broker Kafka cluster and three-node ZooKeeper ensemble require at least three dedicated nodes when hard anti-affinity is used.
- If there are not enough dedicated nodes, pods remain pending. Decide whether to add nodes or relax anti-affinity.
- Apply the same node placement policy to Kafka, ZooKeeper, entity operator, and exporter if the whole instance must stay on dedicated nodes.
- Keep labels and taints stable. Removing them can cause unexpected scheduling during pod recreation.
