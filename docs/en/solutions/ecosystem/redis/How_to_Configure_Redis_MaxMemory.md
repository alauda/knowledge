---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# How to Configure Redis MaxMemory

## Introduction

By default, the Redis Operator sets the Redis `maxmemory` directive to approximately **80%** of the container memory limit. The remaining 20% acts as a safety margin so the container is not OOM-killed by spikes in non-data memory usage (replication buffers, COW during persistence, client buffers, etc.).

For a Redis instance configured with 1 CPU and 2 GiB memory, this typically results in a `maxmemory` of around 1.6 GiB, as visible from `INFO memory`:

```
maxmemory:1717986918
maxmemory_human:1.60G
```

In some cases you may need to override this default — for example, to free more memory for the safety margin on smaller pods, or to dedicate more memory to data on larger pods. This guide describes how to override the operator's default calculation.

:::info Applicable Version
redis-operator 3.12 and later (the technique is also valid on current versions of the operator)
:::

## Prerequisites

- A running Redis instance managed by the Redis Operator.
- Permission to edit the instance via the web console or `kubectl`.

## Procedure

There are two ways to change `maxmemory` on a running instance.

### Option 1: Runtime Override (Temporary)

Connect to the Redis pod and use `CONFIG SET`:

```bash
redis-cli -h <host> -p 6379 -a <password> CONFIG SET maxmemory <bytes>
```

For example, set `maxmemory` to 1 GiB:

```bash
redis-cli CONFIG SET maxmemory 1073741824
```

:::warning
This change is **temporary**. It is lost when the pod restarts because the operator regenerates the Redis configuration from the CR on each reconcile.
:::

### Option 2: Persistent Override via `customConfig` (Recommended)

Add a `maxmemory` entry under `spec.customConfig` of the Redis CR. This change is persisted by the operator and survives pod restarts.

#### Edit via the Web Console

1. Navigate to the Redis instance details page.
2. Open the **Parameter Configuration** (or equivalent) section.
3. Add or update the `maxmemory` parameter with the desired value.
4. Save the change.

#### Edit the CR Directly

```bash
kubectl -n <namespace> edit redis <instance-name>
```

Add `maxmemory` under `spec.customConfig`:

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  customConfig:
    maxmemory: "1073741824"   # 1 GiB, expressed in bytes (or "1gb" if your operator version supports unit suffixes)
    # ... other custom-config entries
```

The operator reconciles the change on the running pods. The new `maxmemory` is applied immediately without requiring a pod restart on supported versions; older operator releases may restart the pod.

## Important Considerations

- Always leave headroom for non-data memory. Setting `maxmemory` equal to the container's memory limit will cause the container to be OOM-killed under load.
- The recommended ratio is roughly 70–80% of the container memory limit for `maxmemory`. Adjust based on your replication, persistence, and connection load.
- When you change the container `resources.limits.memory`, also re-evaluate your `maxmemory` setting.
- Use `INFO memory` from `redis-cli` to verify the actual `maxmemory` and `used_memory` after the change.
