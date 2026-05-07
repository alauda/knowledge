---
products:
  - Alauda Application Services
kind:
  - Solution
---

# Manually Remove Failed Redis Cluster Nodes

## Introduction

When a Redis Cluster node has been permanently removed (for example, after a pod has been deleted or relocated and its IP is no longer in use), the cluster's gossip view may still hold stale entries with `fail` status. To clean these up the operator needs to issue `CLUSTER FORGET` against **every other node** in the cluster, because each node tracks the cluster topology independently.

This guide provides a small helper script that fans the `CLUSTER FORGET` command out across all healthy nodes.

:::tip
For a related but distinct case - cleaning up orphaned IP-recycling artifacts (e.g. with the Calico CNI), see [Cleanup Invalid Redis Cluster Nodes](./How_to_Cleanup_Invalid_Cluster_Nodes.md).
:::

## Prerequisites

1. A healthy Redis Cluster with at least one reachable primary node (status not `fail`).
2. The cluster password (referred to as `<password>` below).
3. `redis-cli` available on the machine running the script. If not present, install it from your distribution's package repository (for example `yum install -y redis` or use the version bundled in the platform Redis pod image).
4. Network connectivity from the script host to **every** node in the cluster.

## Procedure

### 1. List Cluster Nodes

Pick any healthy node and list the cluster topology:

```bash
redis-cli -h <node-ip> -a '<password>' cluster nodes
```

Sample output:

```text
e457476882acfaebcc860466da141a32972eace4 10.33.1.33:6379@16379 master - 0 1616656953463 0 connected 10923-16383
73cb7a3c3c5c1db1a43c7483eacc1fc261757cec 10.33.0.218:6379@16379 slave e457476882acfaebcc860466da141a32972eace4 0 1616656955466 1 connected
8bba60e0ed2c0cf33395399c2b8951dd0b9c0f57 10.33.0.50:6379@16379 slave 9023b45408c79a0f5e7434dad6547e59ff487b77 0 1616656950455 4 connected
5f2a6fab812ffb29e59456ff3b987ba68d0af46b 10.33.1.229:6379@16379 myself,slave 0b0e62b3dfdb5c55fd203ef01160c752c60e48bf 0 1616656952000 3 connected
9023b45408c79a0f5e7434dad6547e59ff487b77 10.33.0.217:6379@16379 master - 0 1616656952460 4 connected 5461-10922
0b0e62b3dfdb5c55fd203ef01160c752c60e48bf 10.33.0.49:6379@16379 master - 0 1616656954464 5 connected 0-5460
```

The first column is the node ID. Identify the IDs whose flags include `fail` or `disconnected`.

### 2. Create the Helper Script

Save the following as `forget.sh`:

```bash
#!/bin/sh
ANY_NODE=$1
PASSWORD=$2
FORGET_NODE_ID=$3

redis-cli -h "${ANY_NODE}" -a "${PASSWORD}" cluster nodes \
  | grep -v "${FORGET_NODE_ID}" \
  | awk '{print $2}' \
  | awk -F: '{print $1}' \
  | xargs -I {} redis-cli -h {} -a "${PASSWORD}" cluster forget "${FORGET_NODE_ID}"
```

The script:

1. Lists all known nodes from a single healthy node.
2. Filters out the node we want to forget (otherwise we would tell the failed node to forget itself).
3. Extracts the IPs of the remaining nodes.
4. Sends `CLUSTER FORGET <node-id>` to each of them.

Make it executable:

```bash
chmod +x forget.sh
```

### 3. Run the Script Once Per Failed Node

For each node ID in the `fail` state, run:

```bash
sh forget.sh <healthy-master-ip> <password> <failed-node-id>
```

For example:

```bash
sh forget.sh 10.33.0.49 'mypass' e457476882acfaebcc860466da141a32972eace4
```

`<healthy-master-ip>` must be the IP of a primary that is **not** currently in `fail` state.

### 4. Verify the Cluster

```bash
redis-cli -h <node-ip> -a '<password>' cluster info
```

A healthy result looks like:

```text
cluster_state:ok
cluster_slots_assigned:16384
cluster_slots_ok:16384
cluster_slots_pfail:0
cluster_slots_fail:0
cluster_known_nodes:6
cluster_size:3
...
```

`cluster_state:ok`, `cluster_slots_assigned:16384`, and a `cluster_known_nodes` count that matches the live topology indicate the stale entries have been removed across the cluster.

## Important Considerations

### `CLUSTER FORGET` Has a 60-Second Timeout

Each `CLUSTER FORGET` adds the target node to a 60-second blacklist on the node that received the command. If the gossip protocol re-announces the failed node before all peers have forgotten it, the entry will reappear on those peers. Run the script across all nodes within the same minute - the helper above is fast enough to do this in a single execution.

### Don't Forget Live Nodes

If you accidentally invoke `CLUSTER FORGET` against a healthy node ID, that node will be temporarily severed from the cluster's view (it will rejoin after the 60-second blacklist expires). Always validate the target node ID is in `fail` state before running the script.

### Don't Forget the Replica of a Healthy Primary

If the failed node is the primary of a still-healthy shard, removing it without first promoting a replica leaves the shard's slots without a primary. Use `CLUSTER FAILOVER` from the surviving replica before forgetting the old primary.

### When This Procedure Is Not Enough

If the cluster has many stale entries from IP recycling (for example with the Calico CNI), the orphaned records may not all be in `fail` state and may need a different cleanup approach. See [Cleanup Invalid Redis Cluster Nodes](./How_to_Cleanup_Invalid_Cluster_Nodes.md).
