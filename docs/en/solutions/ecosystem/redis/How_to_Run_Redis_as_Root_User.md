---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# How to Run Redis as the Root User

:::info Applicable versions
- Operator: `>= 3.10.3` or `>= 3.12.2`
- Architectures: Sentinel, Cluster
:::

## Introduction

By default, Alauda Cache Service for Redis OSS runs containers as the non-root user **`UID 999` / `GID 1000`** for security. Certain external storage backends require Redis to run as the root user to mount or write to volumes correctly. This guide explains how to configure the Redis Pod's `securityContext` so the container runs as root, enabling integration with these storage systems.

## Storage Backends That Require Root

| Storage Type | Requires Root | Notes |
|--------------|---------------|-------|
| CephFS | — (deprecated) | CephFS integration was discontinued in operator 3.8. Use NFS, EFS, or a CSI-based block-storage class instead. |
| NFS | Conditional | Required only if the export does not grant `others` read/write permissions. Prefer fixing the export over enabling root. |
| EFS | Yes | The default AWS EFS Persistent Volume requires the root user. |

If your storage class does not require root access, **do not** enable this option — running as root weakens the container's security posture.

## Procedure

The configuration is identical for Sentinel and Cluster modes. When creating a new Redis instance, switch to YAML view and add `spec.securityContext` to run the container as root.

### Example

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  securityContext:
    runAsUser: 0
    runAsGroup: 0
    fsGroup: 0
  # ... remaining fields (arch, replicas, resources, persistent, etc.)
```

Apply the resource:

```bash
kubectl apply -f <redis-instance>.yaml
```

After the instance is created, verify the Pods are running as root:

```bash
kubectl -n <namespace> exec -it <redis-pod> -- id
# Expected output: uid=0(root) gid=0(root) groups=0(root)
```

## Important Considerations

:::note
When you patch `spec.securityContext` on an **existing** instance, the operator updates the underlying StatefulSet immediately, but the running Pods are **not** restarted automatically. To apply the change to running Pods, delete each Pod manually (the StatefulSet controller recreates them with the new security context) or trigger a rolling restart by also bumping a resource field such as CPU/memory.
:::

- Running as root expands the container's privileges. Apply this configuration only when the underlying storage strictly requires it.
- For NFS, prefer adjusting the export permissions (granting `others` read/write) over running as root when feasible.
- Combine this configuration with PodSecurity policies that explicitly allow privileged Pods in the Redis namespace, since most cluster-wide security baselines disallow root containers.
