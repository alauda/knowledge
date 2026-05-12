---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Expose Kafka with MetalLB

:::info Applicable Versions
ACP 3.16.x with MetalLB deployed.
:::

## Introduction

When MetalLB is available in the Kubernetes cluster, Kafka can expose broker services through `LoadBalancer` services and receive stable external IP addresses from the MetalLB address pool.

## Prerequisites

- MetalLB is installed and configured.
- Kafka operator is deployed.
- The MetalLB address pool has enough IPs for the bootstrap service and broker services.

## Configure the Kafka Listener

Switch the external Kafka listener to `loadbalancer`:

```yaml
spec:
  kafka:
    listeners:
      plain: {}
      external:
        type: loadbalancer
        tls: false
```

Create or update the Kafka instance and wait until it becomes running.

## Get External Addresses

List the services created for the Kafka instance:

```bash
kubectl -n <namespace> get svc -l middleware.instance/name=<cluster-name>
```

Find the broker services and their `EXTERNAL-IP` values. Clients can connect to broker endpoints such as:

```text
<external-ip>:9094
```

## Test Access

From a Kafka client environment:

```bash
./bin/kafka-console-producer.sh \
  --broker-list <external-ip>:9094 \
  --topic my-cluster-topic
```

Then consume from the same topic to confirm end-to-end access.

## Important Considerations

- Keep the LoadBalancer services. MetalLB IPs remain stable as long as the services are not deleted.
- Kafka external access requires every advertised broker endpoint to be reachable from the client network.
- Confirm firewalls and routing allow TCP access to the MetalLB IPs and Kafka port.
- For TLS listeners, use the appropriate client truststore and protocol settings.
