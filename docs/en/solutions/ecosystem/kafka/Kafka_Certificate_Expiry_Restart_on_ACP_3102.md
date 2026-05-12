---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Restarts After Client CA Certificate Expiry on ACP 3.10.2

:::info Applicable Versions
ACP 3.10.2.
:::

## Problem

A Kafka cluster is recreated or restarted unexpectedly around one year after creation. Operator logs indicate certificate renewal activity, and the Kafka client CA certificate shows a one-year validity period.

In the affected setup, the operator creates Kafka clusters with a one-year `clientsCa` validity. Near expiry, certificate renewal can trigger Kafka pod restarts.

## Diagnosis

Export and inspect the client CA certificate:

```bash
kubectl -n <namespace> get secret <kafka-name>-clients-ca-cert -o jsonpath='{.data.ca\.crt}' | base64 -d > client-ca.crt
openssl x509 -in client-ca.crt -noout -dates
```

Review Kafka and operator events around the restart time:

```bash
kubectl -n <namespace> get events --sort-by=.lastTimestamp | grep -i kafka
kubectl -n <operator-namespace> logs deploy/<cluster-operator-deployment>
```

## Resolution

Add `clientsCa.validityDays` to the Kafka resource so both cluster and client CA certificates use a longer validity period:

```yaml
spec:
  clusterCa:
    validityDays: 3650
  clientsCa:
    validityDays: 3650
```

Then manually trigger client CA renewal:

```bash
kubectl -n <namespace> annotate secret <kafka-name>-clients-ca-cert \
  strimzi.io/force-renew=true --overwrite
```

Verify the new certificate dates:

```bash
kubectl -n <namespace> get secret <kafka-name>-clients-ca-cert -o jsonpath='{.data.ca\.crt}' | base64 -d > client-ca.crt
openssl x509 -in client-ca.crt -noout -dates
```

## Important Considerations

- Updating the product-level Kafka resource can cause the generated community Kafka YAML to revert. Confirm the final generated YAML still contains the desired CA settings.
- Certificate renewal can restart clients or brokers depending on the configuration. Schedule the change in a maintenance window when possible.
- Keep application truststores aligned with the renewed CA material.
