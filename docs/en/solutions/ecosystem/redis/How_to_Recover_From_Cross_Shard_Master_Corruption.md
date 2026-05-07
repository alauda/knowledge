---
products:
  - Alauda Application Services
kind:
  - Solution
---

# How to Recover From Cross-Shard Primary Corruption in Cluster Mode

## Introduction

This guide describes how to recover a Redis Cluster-mode instance whose state shows healthy at the Redis level but whose pod-to-shard mapping has become inconsistent — typically observed when the platform reports the instance status stuck at "Processing" indefinitely after a password update. The root cause is that a Primary role from one shard's StatefulSet has been adopted by a pod that belongs to a *different* shard's StatefulSet, so the operator cannot complete reconciliation.

:::info Applicable Version
This is a low-probability defect that can occur on any Cluster-mode Alauda Cache Service for Redis OSS instance. The procedure below is mode-agnostic and works on all current operator versions.
:::

:::note
This document uses "Primary" and "Replica" to refer to the main Redis node and its replicas, respectively, replacing the previously used "Master"/"Slave" terminology.
:::

## Symptoms

- After a password update (or another reconcile-triggering operation) the Redis CR remains stuck in `Processing` and never returns to `Healthy`.
- `redis-cli --cluster check` reports the cluster as healthy and slots as fully covered.
- The Primary IP reported by `cluster nodes` for one shard belongs to a pod that is part of a *different* shard's StatefulSet.
- The operator log shows no errors but does not progress.

## Diagnosis

1. Check cluster health from any data pod:

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster check 127.0.0.1:6379
   ```

   Expected: `[OK] All 16384 slots covered.` Cluster health alone does **not** rule out the misalignment.

2. List pods with their IPs and StatefulSet:

   ```bash
   kubectl -n <namespace> get pods -o wide
   ```

3. List the Redis cluster topology and inspect Primary IPs:

   ```bash
   redis-cli -a $REDIS_PASSWORD CLUSTER NODES
   ```

4. Cross-reference the Primary IP from step 3 against the pod-to-StatefulSet mapping from step 2. If the pod that holds the Primary role for shard *N* is not part of shard *N*'s StatefulSet (`drc-<instance>-N-*`), the cluster is in the misaligned state described here.

The root cause is suspected to be related to pod IP changes; reproducing it deterministically has not been possible. Operator restarts and pod restarts will not fix it.

## Recovery Procedure

The repair requires two manual steps per affected shard: re-electing the correct Primary on the shard that lost its Primary, then demoting the misplaced pod back to a Replica of its own shard.

:::warning
- All commands must run from inside the Redis pods or from a workstation with `redis-cli` access to the cluster.
- The procedure briefly causes the affected shard to perform a controlled failover. Plan the operation during a maintenance window.
:::

For each shard that is affected:

1. **Identify the players**:
   - Let `PodA` be the pod that *currently* holds the Primary role but belongs to the wrong StatefulSet.
   - Let `PodB` be a pod (any of them) in the StatefulSet that *should* own this shard but currently has no Primary.
   - Record the Redis cluster node ID of `PodB`. You will use it as `<PodBID>` below.

   ```bash
   # On PodB:
   redis-cli -a $REDIS_PASSWORD CLUSTER MYID
   ```

2. **Failover to PodB** so that the correct StatefulSet regains a Primary in the shard:

   ```bash
   # On PodB:
   redis-cli -a $REDIS_PASSWORD CLUSTER FAILOVER
   ```

   Wait until `CLUSTER NODES` reports `PodB` as `master`.

3. **Re-attach PodA as a Replica of `PodB`**:

   ```bash
   # On PodA:
   redis-cli -a $REDIS_PASSWORD CLUSTER REPLICATE <PodBID>
   ```

4. Repeat for any additional misaligned shards.

5. Wait for the operator to reconcile. The Redis CR status should transition out of `Processing` to `Healthy`.

## Important Considerations

- **Always perform a `--cluster check` before the failover** to confirm slot coverage is intact. If slots are missing, see *How to Recover From a Redis Cluster Crash* and the slot-recovery procedure in the *Redis Emergency Response Playbook* before continuing.
- **Do not delete pods to "force" recovery** — the misaligned topology will persist across pod restarts because Redis Cluster state is held in `nodes.conf` on each node.
- **Capture diagnostics before recovery**: keep a copy of `kubectl get pods -o wide`, `redis-cli CLUSTER NODES`, and operator logs for post-incident analysis. Root cause is currently undetermined; collected evidence helps trace the underlying trigger.
- **Password rotation**: if the trigger was a password rotation that hung, retry the rotation only after the cluster reports `Healthy`.
