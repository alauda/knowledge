---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Expose Kafka on AWS EKS with Network Load Balancer

:::info Applicable Versions
ACP 3.x Kafka on AWS EKS with Strimzi load balancer listeners.
:::

## Introduction

On AWS EKS, Kafka can be exposed externally through AWS Network Load Balancers (NLBs). NLB provides Layer 4 TCP forwarding and static external endpoints managed by the AWS Load Balancer Controller.

## Prerequisites

- An EKS cluster imported into ACP.
- Kafka operator deployed in the target namespace.
- AWS Load Balancer Controller installed and configured.
- Subnets, security groups, and IAM permissions prepared for NLB creation.

AWS controller setup reference:

```text
https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html
```

## Kafka Listener Configuration

Set the external listener type to `loadbalancer` and add AWS NLB annotations to the bootstrap service and each broker service.

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: my-cluster-nlb
spec:
  kafka:
    replicas: 3
    listeners:
      - name: plain
        port: 9092
        tls: false
        type: internal
      - name: external
        port: 9094
        tls: false
        type: loadbalancer
        configuration:
          bootstrap:
            annotations:
              service.beta.kubernetes.io/aws-load-balancer-type: external
              service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
              service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
          brokers:
            - broker: 0
              annotations:
                service.beta.kubernetes.io/aws-load-balancer-type: external
                service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
                service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
            - broker: 1
              annotations:
                service.beta.kubernetes.io/aws-load-balancer-type: external
                service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
                service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
            - broker: 2
              annotations:
                service.beta.kubernetes.io/aws-load-balancer-type: external
                service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
                service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
```

The number of broker entries must match the broker replica count.

## Verify Services

```bash
kubectl -n <namespace> get svc | grep <cluster-name>
```

Use the `EXTERNAL-IP` or DNS name of the bootstrap load balancer with port `9094`. Broker load balancers are also created because Kafka clients need broker-specific addresses after metadata discovery.

## Test Producer and Consumer

```bash
./bin/kafka-console-producer.sh \
  --bootstrap-server <nlb-dns-name>:9094 \
  --topic my-topic

./bin/kafka-console-consumer.sh \
  --bootstrap-server <nlb-dns-name>:9094 \
  --topic my-topic \
  --from-beginning
```

## Important Considerations

- Kafka clients must be able to reach every advertised broker endpoint, not only the bootstrap endpoint.
- Use security groups to restrict external Kafka access.
- For private clusters, use an internal NLB scheme instead of `internet-facing`.
- DNS propagation and load balancer provisioning can take several minutes.
