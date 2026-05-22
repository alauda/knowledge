---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# Cleanup Invalid Redis Cluster Nodes

## Introduction

In environments where pod IPs change after a restart - notably when using a CNI such as **Calico** that does not preserve pod IPs - a Redis Cluster may accumulate orphaned node entries. Each surviving node still tracks the cluster's previous topology by node ID and IP, and these stale entries are not always cleaned up automatically.

Symptoms include:

- The `/data/nodes.conf` file inside a Redis pod contains entries with `fail` status.
- `CLUSTER NODES` lists entries with `fail` status whose IPs no longer belong to any current pod.

This guide explains how to identify and remove those orphaned entries.

:::note Auto-cleanup on current operator
On **redis-operator 3.18+** the controller reconciles cluster membership during pod restarts and cleans up most stale entries automatically. The manual procedure below is intended as a **fallback** for cases where the orphan persists (for example, multiple simultaneous IP recycles or an operator outage during recovery). On legacy operator versions (`<= 3.16`) this is the routine recovery path.
:::

:::tip Related
For removing a single failed node where the IP and node ID are known, see [Manually Remove Failed Redis Cluster Nodes](./How_to_Manually_Remove_Failed_Cluster_Nodes.md).
:::

## Prerequisites

1. `kubectl` access to the namespace running the Redis Cluster.
2. The Redis password.
3. `redis-cli` access either inside a Redis pod or from a host that can reach all Redis pods.

## Procedure

### 1. Identify Stale Entries

For each Redis pod in the StatefulSet, list the cluster topology:

```bash
kubectl -n <namespace> exec -it <redis-pod> -- \
  redis-cli -a '<password>' cluster nodes
```

Build a list of the **current** pod IPs:

```bash
kubectl -n <namespace> get pod -l <selector-for-redis> -o wide
```

Apply the following decision rules to each entry returned by `CLUSTER NODES`:

| Entry state | Action |
|------------|--------|
| Status is healthy and IP belongs to a current pod | Keep |
| Status is `fail` or `pfail`, and IP is **not** the IP of any current pod | **Remove** with `CLUSTER FORGET` |
| Status is abnormal but IP **does** match a current pod | Do **not** forget. Investigate the pod first. |
| Status is `disconnected` and there is no IP recorded | **Remove** with `CLUSTER FORGET` |

### 2. Remove the Stale Entries

For every stale entry, run `CLUSTER FORGET` on every healthy node:

```bash
redis-cli -h <healthy-node-ip> -a '<password>' cluster forget <stale-node-id>
```

The `<stale-node-id>` is the first column of the `CLUSTER NODES` output for the entry to be removed.

:::warning Run on All Healthy Nodes Within 60 Seconds
Cluster nodes gossip their topology to each other. If you only forget a node on some peers, the surviving peers will re-announce it and the entry will reappear. `CLUSTER FORGET` blacklists the target for 60 seconds; you must execute it against all healthy nodes within that window.
:::

A simple shell loop covers this. From a host that can reach all pods:

```bash
HEALTHY_IPS=(<ip-1> <ip-2> <ip-3> <ip-4> <ip-5>)
STALE_ID=<stale-node-id>
PASSWORD=<password>

for ip in "${HEALTHY_IPS[@]}"; do
  redis-cli -h "$ip" -a "$PASSWORD" cluster forget "$STALE_ID"
done
```

Repeat for each stale node ID.

### 3. Verify

After cleanup, confirm the cluster state:

```bash
redis-cli -h <node-ip> -a '<password>' cluster info
redis-cli -h <node-ip> -a '<password>' cluster nodes
```

`cluster_state:ok` and a `cluster_known_nodes` count that matches the actual pod count indicate the cleanup is complete. The `nodes.conf` file inside each pod should also no longer reference the removed IDs.

## Important Considerations

### Do Not Forget Entries Whose IP Belongs to a Live Pod

If an abnormal entry's IP matches a current pod, the right fix is to investigate that pod (CNI issue, network partition, replication lag) rather than forget the node. Forgetting it would split the live pod from the cluster's view temporarily.

### Apply To Healthy Nodes Only

Always invoke `CLUSTER FORGET` from a healthy node's perspective. Sending the command to the failing node itself does nothing useful and risks confusing the cluster.

### Why This Happens With Calico

Calico assigns a fresh IP from its pool when a pod restarts. The previous IP enters Calico's recycle pool but the cluster's gossip view still references the old IP under the old node ID. Until the entry is forgotten cluster-wide, it lingers as a stale `fail` record.

For environments where this becomes routine, consider using a CNI plugin that supports IP preservation across pod restarts (for example Kube-OVN with persistent pod IPs).
