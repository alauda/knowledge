---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# How to Recover From a Redis Cluster Crash

## Introduction

This guide explains how to recover a Redis Cluster-mode pod whose cluster state file (`nodes.conf`) has been deleted or corrupted, leaving the node unable to rejoin its cluster. The most common indicator is a Replica that starts up but never reattaches — its IP and port appear as `0@0` in `CLUSTER NODES` output instead of the expected `IP:6379@16379`.

:::info Applicable Version
All Cluster-mode versions of Alauda Cache Service for Redis OSS.
:::

:::note
This document uses "Primary" and "Replica" to refer to the main Redis node and its replicas, respectively, replacing the previously used "Master"/"Slave" terminology.
:::

## Symptoms

A Replica pod starts but cannot rejoin the cluster. From any healthy pod, run:

```bash
redis-cli -a <password> CLUSTER NODES
```

A healthy node entry looks like:

```text
<node_id> <IP>:6379@16379 master|slave ...
```

A node with a deleted/corrupted cluster configuration file looks like:

```text
<node_id> 0@0 ...
```

The bad pod also reports it is "not in cluster" and has no slot assignments.

## Recovery Procedure

The recovery resets the node's local cluster state and re-attaches it as a Replica of the appropriate Primary.

:::warning
- `cluster reset` and `flushall` are destructive: they discard the node's local cluster state and *all data* on that pod. Run them **only on the broken Replica pod**. Never run them on a healthy Primary or on a pod whose data you have not confirmed is replaceable.
- Confirm that the data on the bad pod is no longer authoritative. Because Cluster mode replicates Primary writes to Replicas, a Replica's data can normally be regenerated from its Primary; this is what makes the procedure safe **only on a Replica**.
:::

### 1. Confirm the Affected Pod is a Replica

```bash
kubectl -n <namespace> exec -it <broken-pod> -- redis-cli -a <password> ROLE
```

The first line of output must be `slave`. If it returns `master`, do **not** continue with this procedure — investigate slot coverage and refer to *How to Recover From Cross-Shard Primary Corruption in Cluster Mode* or the slot-loss procedure in the *Redis Emergency Response Playbook* instead.

### 2. Reset the Node and Clear Its Local Data

Open a shell on the broken Replica pod and run:

```bash
kubectl -n <namespace> exec -it <broken-pod> -- bash

redis-cli -a <password>
> CLUSTER RESET
> FLUSHALL
> QUIT
```

After reset, `CLUSTER NODES` from a healthy pod should show the broken node with a real IP and port, but it will still report itself as a standalone (no slots, no Primary).

### 3. Attach the Node as a Replica of the Correct Primary

Identify the Primary that lacks a Replica. From any healthy pod:

```bash
redis-cli -a <password> CLUSTER NODES | grep master
```

Pick the Primary whose shard is missing the Replica being recovered, and capture its node ID — referred to below as `<primary-node-id>`.

On the broken pod, attach it as a Replica:

```bash
redis-cli -a <password>
> CLUSTER REPLICATE <primary-node-id>
> QUIT
```

### 4. Verify

From any healthy pod:

```bash
redis-cli -a <password> CLUSTER NODES
```

The recovered pod should now appear as `slave` with the chosen Primary's node ID listed as its master, and its `IP:6379@16379` populated correctly. Wait for the initial sync (`INFO replication` shows `master_sync_in_progress:0`) before treating the recovery as complete.

## Important Considerations

- **Operator reconciliation**: After recovery, the operator should treat the cluster as healthy and stop attempting to redeploy the affected pod. If the operator continues to recreate the pod, capture its log and the Redis CR status before any further action.
- **Repeated occurrences** of `0@0` in cluster output indicate something is removing or corrupting `nodes.conf`. Common causes include manual edits, host-path PV deletion, or scripts that wipe the data directory. Investigate and remove the trigger before applying this fix repeatedly.
- **Backup before reset**: If you are unsure whether the broken pod is genuinely a Replica or holds the only copy of some data, take a copy of the pod's data directory before running `CLUSTER RESET` / `FLUSHALL`.
- **Password handling**: All `redis-cli` invocations require the instance password if one is configured. Use `-a <password>` or set `REDISCLI_AUTH` to avoid leaking the password in process listings.
