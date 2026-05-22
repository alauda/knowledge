---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# How to Recover Sentinel Instances That Have Merged Due to IP Recycling

:::warning Most users on the current operator can skip this document
If you are running **redis-operator 3.18+ with Redis 6.0 or later** (the default for new instances), you are **not affected** by this failure mode. Redis 6 introduced built-in user authentication that prevents cross-instance authentication even when pod IPs collide.

Read this document only if (a) you operate **legacy instances on Redis 4.x/5.x**, or (b) you are on operator **<= 3.16** for unrelated reasons.
:::

## Introduction

This guide explains how to recover from a rare but disruptive failure mode in which two independent Redis Sentinel-mode instances merge into a single cluster after pod restarts cause IP addresses to be recycled across instances. The Replica nodes from one instance attach to the other, and the Sentinel quorums from both instances see all six data nodes, producing a single 4-replica / 6-Sentinel "super-cluster".

:::info Applicable Version
- redis-operator `<= 3.14` (all Redis versions)
- redis-operator `>= 3.16` running Redis `4.x` or `5.x`

Redis 6.0 and later — including all instances created on operator 3.18+ with the default version — are immune.
:::

:::note
This document uses "Primary" and "Replica" to refer to the main Redis node and its replicas, respectively, replacing the previously used "Master"/"Slave" terminology.
:::

## Background

Redis Sentinel and Cluster modes use IPs (not DNS) to discover and form their quorum. This avoids dependency on DNS but exposes the system to IP recycling. The merge sequence is:

1. After a pod restart, an instance's data pod is assigned an IP that previously belonged to a pod from a *different* Redis instance.
2. The new pod boots and discovers the Primary advertised by the cluster it is now reachable on, then registers itself as a Replica there.
3. Concurrently, the Sentinel pods of the original instance keep probing the lost IP. When the IP becomes reachable again, Sentinel re-attaches it as a Replica — but the IP now belongs to a pod from the other instance.
4. Once the operator's reconciliation tries to repair the multi-Primary state, both instances converge into a single merged cluster.

Two preconditions are required:

- **Identical passwords** on both instances. Authentication succeeds across instance boundaries.
- **A network plugin that recycles pod IPs**. This is most commonly observed in Calico-based environments; Kube-OVN with stable IPs largely avoids the issue.

## Recovery Procedure

The recovery procedure differs between operator versions. Identify your operator version before proceeding.

:::warning
Recovery removes redundant Replicas and may lose data that was only present on Replicas of one instance. Identify which copy of the data is authoritative **before** running the procedure.
:::

### Recovery on redis-operator 3.12 and 3.14

1. **Stop the redis-operator** so it does not keep re-applying the merged topology while you repair the cluster.

2. **Delete the Sentinel pods of the affected instance(s)**. Sentinel pods are named with the `rfs-` prefix:

   ```bash
   kubectl -n <namespace> delete pod -l app.kubernetes.io/component=sentinel,redissentinels.databases.spotahome.com/name=<instance-name>
   ```

3. **Inspect each data pod's role**. Data pods are named with the `rfr-` prefix:

   ```bash
   kubectl -n <namespace> exec -it <rfr-pod> -- redis-cli -a <password> ROLE
   ```

4. **Promote the correct Primary**. On every pod that reports `slave`, run:

   ```bash
   redis-cli -a <password> SLAVEOF NO ONE
   ```

   :::warning
   Only one data copy should remain authoritative. Confirm with the application owner which Replica holds the correct data **before** running `SLAVEOF NO ONE`. All other data copies will be reset by the operator after restart.
   :::

5. **Restart the redis-operator**. The operator will rebuild the Sentinel quorum and the Primary/Replica topology automatically.

6. **Once the instances are healthy, change the password on at least one of the affected instances** so that the two instances no longer share credentials. This prevents recurrence:

   ```bash
   kubectl -n <namespace> create secret generic <new-password-secret> \
     --from-literal=password=<new-password>
   ```

   Then update `spec.passwordSecret` on the Redis CR to reference the new Secret.

### Behavior on redis-operator 3.16 and later (with Redis 4 or 5)

Starting from 3.16, the operator includes post-incident reconciliation logic that breaks the merged cluster automatically. **However, recovery is destructive — data that exists only on the merged side may be lost.** Set distinct passwords on each instance to avoid the problem entirely.

## Important Considerations

- **Mitigation, not prevention on Redis 4 / 5**: The only reliable prevention on Redis 4.x / 5.x is to ensure that no two Sentinel-mode instances in the same network share the same password.
- **Upgrade path**: If feasible, upgrade affected instances to Redis 6.0 or later. Redis 6 has built-in users, so cross-instance authentication is rejected even when IPs collide.
- **Network plugin**: If you operate at scale on Calico, plan password segregation per instance. Kube-OVN with persistent pod IPs reduces but does not fully eliminate the risk.
- **Detection**: Monitor for `redis_connected_slaves` greater than the configured Replica count, and alert on Sentinel pods discovering more Primaries than the operator declared.
