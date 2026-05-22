---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 4.x
---

# How to Set a Password on Redis Sentinel Nodes

## Introduction

This guide explains how to configure a password on the Sentinel nodes of a Redis Sentinel-mode instance. While Sentinel nodes do not store user data, they can manipulate the topology of the Redis cluster (for example, by triggering failover). Protecting them with a password prevents unauthorized clients from interfering with the cluster.

Native password support on Sentinel was introduced in Redis 5.0.1. Alauda Cache Service for Redis OSS exposes this capability starting from redis-operator 3.18.

:::info Applicable Version
redis-operator >= 3.18 (Sentinel mode only)
:::

:::warning
- Sentinel node credentials are independent of data-node credentials. They are managed as two separate password chains.
- Changing the Sentinel password causes **all instance pods to restart**.
- On **redis-operator 3.18**, S3 backup is incompatible with a Sentinel-protected instance. Verify your operator release notes before relying on this combination on later versions.
:::

## Prerequisites

- redis-operator 3.18 or later is installed in the target cluster.
- The Redis instance is using Sentinel architecture.
- You have permission to create Secrets in the target namespace.

## Procedure

### Setting the Sentinel Password at Instance Creation

1. Create a Secret in the same namespace as the Redis instance:

   ```bash
   kubectl -n <namespace> create secret generic <sentinel-password-secret> \
     --from-literal=password=<your-password>
   ```

   :::note
   The Secret must live in the **same namespace** as the Redis instance. Do **not** reuse the data-node password Secret for the Sentinel password — they must be distinct Secrets.
   :::

2. On the instance creation page, switch to the YAML tab and add the Sentinel password reference:

   ```yaml
   spec:
     sentinel:
       passwordSecret: "<sentinel-password-secret>"
   ```

3. Submit the form to create the instance.

### Updating the Sentinel Password

To rotate the Sentinel password:

1. Create a new Secret with the new password:

   ```bash
   kubectl -n <namespace> create secret generic <new-sentinel-password-secret> \
     --from-literal=password=<new-password>
   ```

2. Update `spec.sentinel.passwordSecret` on the Redis CR to reference the new Secret.

:::warning
- You must rotate to a **new** Secret. Updating the value inside an existing Secret without changing the reference will not be picked up by the operator.
- All instance pods restart when the Sentinel password is rotated. Plan the operation accordingly.
:::

## Important Considerations

- Sentinel and data-node passwords are managed independently. Changing one does not affect the other.
- S3 backup compatibility: confirmed incompatible on **redis-operator 3.18**. Later releases may have lifted this limitation — check your operator's release notes before assuming the restriction still applies.
- Switching from the form view back to the YAML view in the UI may overwrite manual edits. Make Sentinel password changes via direct CR edits or via the YAML tab without round-tripping through the form.
