---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# Repair Redis Cluster Slot Anomalies

## Introduction

A Redis Cluster distributes its key space across **16384 slots**. When the cluster reports `cluster_state:fail` or when `redis-cli --cluster check` flags missing or misassigned slots, the cluster cannot serve requests for the affected key ranges. This guide covers two common repair scenarios:

1. A primary node has lost a contiguous range of slots.
2. Slots have been incorrectly assigned to a replica node.

:::note Terminology
This document uses **primary** and **replica** for the Redis roles formerly known as master and slave. The Redis CLI subcommands (`CLUSTER ADDSLOTS`, `CLUSTER DELSLOTS`, `CLUSTER FAILOVER`) retain their original names.
:::

## Prerequisites

1. `kubectl` access to the namespace where the Redis Cluster instance runs.
2. The Redis password (referred to as `<password>` below). It is typically stored in the `<instance-name>-default-credentials` Secret.
3. A working `redis-cli` inside the pod (the platform image bundles it).

## Procedure

### Scenario 1: Primary Node Has Lost Slots

#### 1. Inspect the cluster

Exec into any Redis pod and run a cluster check:

```bash
kubectl -n <namespace> exec -it <redis-pod> -- \
  redis-cli -a '<password>' --cluster check 127.0.0.1:6379
```

The output will list the distribution of slots per primary. If a primary reports zero or fewer slots than expected, the missing range needs to be re-added. For a 3-shard cluster, the typical default ranges are:

| Shard | Slots |
|-------|-------|
| 0 | 0-5461 |
| 1 | 5462-10922 |
| 2 | 10923-16383 |

#### 2. Re-add the missing slots on the primary

Exec into the **affected primary's** pod and add each missing slot. For a missing range of `0-5460`:

```bash
for i in $(seq 0 5460); do
  redis-cli -a '<password>' -h 127.0.0.1 -p 6379 cluster addslots $i
done
```

Adjust the range to match your environment. `CLUSTER ADDSLOTS` only succeeds when the slot is currently unassigned across the cluster; if a slot is held by another node, free it there first with `CLUSTER DELSLOTS`.

#### 3. Verify

Re-run the cluster check:

```bash
redis-cli -a '<password>' --cluster check 127.0.0.1:6379
```

The slot count should now total 16384, and `cluster_state` should be `ok`.

### Scenario 2: Replica Has Incorrectly Assigned Slots

In a healthy cluster, only primaries own slots. If a `--cluster check` shows that a replica owns one or more slots while its primary is missing them, the assignment is corrupt and needs to be reverted.

#### 1. Confirm the cluster state

```bash
redis-cli -h <node-ip> -p <port> -a '<password>' cluster info
redis-cli -a '<password>' --cluster check 127.0.0.1:6379
```

Identify the slot(s) owned by the replica and which primary they belong to.

#### 2. Move the slot back to the primary

Exec into the **primary** pod for the affected shard and remove the stale slot ownership:

```bash
redis-cli -a '<password>' -h 127.0.0.1 -p 6379 CLUSTER DELSLOTS <slot>
```

Then exec into the **replica** pod that currently owns the slot and remove it there too:

```bash
redis-cli -a '<password>' -h 127.0.0.1 -p 6379 CLUSTER DELSLOTS <slot>
```

The slot is now unassigned. Add it back on the primary:

```bash
# On the primary pod
redis-cli -a '<password>' -h 127.0.0.1 -p 6379 CLUSTER ADDSLOTS <slot>
```

#### 3. (If needed) Trigger a controlled failover

If the cluster topology drifted because of the wrong assignment, you can request the replica to take over its primary's role using a manual failover. From the **replica** pod:

```bash
redis-cli -a '<password>' -h 127.0.0.1 -p 6379 CLUSTER FAILOVER
```

Use `CLUSTER FAILOVER FORCE` only when the primary is unreachable - it bypasses replication checks and may lose in-flight writes.

#### 4. Verify

```bash
redis-cli -a '<password>' --cluster check 127.0.0.1:6379
redis-cli -a '<password>' cluster info
```

`cluster_state:ok` and `cluster_slots_assigned:16384` confirm the cluster is healthy.

## Important Considerations

### Slot Ownership Is Cluster-Wide

`CLUSTER ADDSLOTS` and `CLUSTER DELSLOTS` operate on the local node's view but are gossiped to peers. After running them, allow a few seconds for the cluster to converge before re-checking.

### Don't Reassign Slots That Hold Live Data

`CLUSTER DELSLOTS` does **not** migrate the keys that live in those slots. If keys exist in a slot you are about to remove, they become unreachable. Use `CLUSTER COUNT-KEYS-IN-SLOT <slot>` first to confirm the slot is empty, or use `redis-cli --cluster reshard` to migrate keys before changing ownership.

### Always Repair From the Primary

Run `ADDSLOTS` on the primary that should own the slot, not the replica. Replicas inherit slot ownership from their primary; manually adding slots on a replica is what causes Scenario 2 in the first place.

### When Repair Is Not Enough

If the cluster has lost so much state that `--cluster check` reports many overlapping slot owners, prefer:

```bash
redis-cli -a '<password>' --cluster fix 127.0.0.1:6379
```

This drives the cluster through a guided repair, including key migration. Use the manual `ADDSLOTS` / `DELSLOTS` workflow only for surgical fixes on otherwise healthy clusters.
