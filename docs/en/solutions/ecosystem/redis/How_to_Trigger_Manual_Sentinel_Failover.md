---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# How to Trigger a Manual Sentinel Failover

## Introduction

This guide explains how to manually trigger a Primary/Replica failover on a Redis Sentinel-mode instance using the `SENTINEL FAILOVER` command. Manual failover is useful for verifying that client applications correctly handle Primary changes, validating Sentinel quorum behavior, and performing planned maintenance on the current Primary node.

:::info Applicable Version
All versions of Alauda Cache Service for Redis OSS that support Sentinel mode.
:::

:::note
This document uses the term "Primary" to refer to the main Redis node in a replication setup. This is the current standard terminology, replacing the previously used term "Master".
:::

## Prerequisites

- A running Redis Sentinel-mode instance with at least one Replica.
- `kubectl` access to the namespace that hosts the instance, or terminal access to one of the Sentinel pods.
- The Redis password (if the instance is password-protected). Sentinel command access on the default port (`26379`) does not require the data-node password unless Sentinel authentication is configured.

## Procedure

### 1. Identify the Current Primary

Identify which pod is currently serving as the Primary so that you can confirm the failover afterwards. Use either of the following methods.

**Option A: Use the platform UI**

Open the Redis instance detail page on the platform and view the topology panel. The current Primary node is displayed in the topology view.

**Option B: Use the `INFO replication` command**

Connect to any data node and run:

```bash
redis-cli -a <your-password> INFO replication
```

The output `role:master` identifies the current Primary; `role:slave` identifies a Replica. Replicas also report `master_host` and `master_port`, which point to the current Primary.

### 2. Trigger the Failover from a Sentinel Pod

Sentinel pods are typically named with an `rfs-` prefix. Open a shell on any Sentinel pod, then run:

```bash
redis-cli -p 26379 SENTINEL FAILOVER mymaster
```

`mymaster` is the default monitored cluster name used by the operator. Do not change it unless your instance was deliberately configured with a different name.

A successful failover response returns `OK`. The actual transition typically completes in under 10 seconds.

:::tip
You can run `SENTINEL FAILOVER` from any Sentinel pod — the Sentinel quorum will coordinate the election. Successive `SENTINEL FAILOVER` calls within a short window may be rejected with `NOGOODSLAVE` if Sentinel does not consider the cluster ready for another failover.
:::

### 3. Verify the New Primary

Re-run the verification from step 1. The pod that was previously a Replica should now report `role:master`, and the previous Primary should report `role:slave` and follow the new Primary.

You can also monitor failover events from a Sentinel pod:

```bash
redis-cli -p 26379 SENTINEL MASTERS
```

Inspect the `flags` and `ip`/`port` fields to confirm the new Primary.

## Important Considerations

- **Brief unavailability window**: Clients may receive errors during the few seconds it takes for Sentinel to promote the new Primary and for Replicas to reconnect. Use this procedure to validate that your application's reconnect logic behaves correctly.
- **Quorum requirement**: Sentinel must have a healthy quorum (the majority of Sentinel pods reachable) to perform a failover. If quorum is lost, `SENTINEL FAILOVER` will not succeed.
- **Cooldown**: Sentinel enforces a failover timeout (default 3 minutes). A second manual failover may be rejected during this period — wait for the timeout to expire or check `SENTINEL MASTERS` output.
- **Sentinel password**: If you have configured a Sentinel password (see *How to Set a Password on Redis Sentinel Nodes*), pass it with `-a <sentinel-password>` when running `redis-cli` on port `26379`.
- **Production use**: Manual failover is intended for testing and planned maintenance. Do not use it as a substitute for automated failover during real outages.
