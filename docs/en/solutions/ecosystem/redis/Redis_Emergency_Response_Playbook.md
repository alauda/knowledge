---
products:
  - Alauda Application Services
kind:
  - Solution
---

# Redis Emergency Response Playbook

## Introduction

This playbook collects the most common emergency-response procedures for Alauda Cache Service for Redis OSS deployments running on Kubernetes. It is intended for on-call engineers and platform operators who need fast, deterministic steps when a Redis instance, the redis-operator, or a Cluster-mode topology is in a degraded state.

:::info Applicable Version
All currently supported versions of Alauda Cache Service for Redis OSS.
:::

:::note
This document uses "Primary" and "Replica" to refer to the main Redis node and its replicas, respectively, replacing the previously used "Master"/"Slave" terminology.
:::

The playbook covers four scenarios:

1. redis-operator fails to deploy
2. A Redis instance fails to deploy
3. Cluster-mode slots are missing
4. Manually removing a stale node from a Cluster-mode topology

For deeper recovery procedures, refer to:

- *How to Recover From a Redis Cluster Crash* (resetting an unreachable Replica)
- *How to Recover From Cross-Shard Primary Corruption in Cluster Mode*
- *How to Recover Sentinel Instances That Have Merged Due to IP Recycling*

## Architecture Overview

Understanding the deployment topology is essential before triggering recovery actions. Both Sentinel mode and Cluster mode are deployed on Kubernetes using the patterns below.

### Sentinel Architecture

- **Data nodes** (`rfr-<instance>-*`) run as a `StatefulSet` to provide stable identity and storage.
- **Sentinel pods** (`rfs-<instance>-*`) run as a `Deployment` because they are stateless and benefit from rolling updates.
- **Anti-affinity** rules schedule data and Sentinel pods on different nodes.
- **Persistent storage** is provided by `PersistentVolume` / `PersistentVolumeClaim` for data nodes.
- **Configuration and credentials** are stored in `Secret` and `ConfigMap`.

### Cluster Architecture

- **Data nodes** are deployed as multiple `StatefulSets`, one per shard. Slots are distributed across Primaries by the operator.
- Each shard's Primary is paired with one or more Replicas via anti-affinity, so a single node failure cannot take down a shard.
- A `Service` is exposed for each instance to provide a stable client endpoint.

## Procedure

### Scenario 1: redis-operator Fails to Deploy

**Symptom**: redis-operator stays in `Unknown` or `Pending` state and never becomes `Running`. Subsequent Redis CRs cannot be reconciled.

**Recovery**:

1. Delete the redis-operator deployment / CSV:
   ```bash
   kubectl -n <operator-namespace> delete csv <redis-operator-csv>
   ```
2. Confirm there are no leftover resources from a previous install:
   ```bash
   kubectl -n <operator-namespace> get csv,subscription,installplan | grep -i redis
   ```
   Remove any stale entries before proceeding.
3. Restart the OLM catalog operator so it re-evaluates the operator catalog:
   ```bash
   kubectl delete pods -n cpaas-system -l app=catalog-operator
   ```
4. Reinstall the redis-operator from the catalog.

If the operator still fails to come up, check the catalog-operator logs and the cluster's namespace quotas, image-pull credentials, and CRD installation status (`kubectl get crd | grep -i redis`).

### Scenario 2: A Redis Instance Fails to Deploy

**Symptom**: A Redis CR has been created but stays in `Processing` indefinitely, or its pods stay in `Pending`/`CrashLoopBackOff`.

**Recovery**:

1. Inspect the data-node pod logs:
   ```bash
   kubectl -n <namespace> logs <pod-name> -c redis
   ```

2. Inspect pod events:
   ```bash
   kubectl -n <namespace> describe pod <pod-name>
   ```

3. Common causes and remedies:

   | Symptom | Likely Cause | Remedy |
   |---------|--------------|--------|
   | `0/N nodes available: ... insufficient cpu/memory` | Insufficient cluster capacity | Scale the cluster or reduce instance resource requests. |
   | `pod has unbound immediate PersistentVolumeClaims` | StorageClass missing or PV not provisioned | Verify the `StorageClass` and provisioner. For HostPath setups see *Create Redis Instances With HostPath*. |
   | `failed to pull image` | Registry credentials missing or image not mirrored | Configure imagePullSecret; for air-gapped environments mirror the image into the in-cluster registry. |
   | Repeating `LOADING Redis is loading the dataset` | Large RDB on cold start | Wait for load to complete; do not delete the pod mid-load. |

4. If the operator log shows reconcile errors that mention Sentinel or Cluster topology, refer to the corresponding solution document for the affected mode.

### Scenario 3: Redis Cluster Slots Are Missing

**Symptom**: `redis-cli --cluster check` reports `Not all 16384 slots are covered by nodes`. Clients receive `CLUSTERDOWN` errors.

**Recovery**:

1. Identify the missing slots and the failing shard from any data pod:

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster check 127.0.0.1:6379
   ```

   The output highlights the slot ranges that are not covered.

2. Open a shell on the failing pod (the Primary that lost the slot range):

   ```bash
   kubectl -n <namespace> exec -it <pod-name> -- bash
   ```

3. Find the failing node's IP and the cluster node IDs of healthy Replicas. From a healthy pod:

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster check 127.0.0.1:6379
   ```

4. Remove the abandoned slot mapping from the failing Primary:

   ```bash
   redis-cli -a $REDIS_PASSWORD -h <failing-primary-ip> CLUSTER DELSLOTS <slot-id>
   ```

   If multiple slots are missing, repeat or pass a range — for example using a small loop in your shell.

5. Assign the slot to the Replica that should own it (run on a node that can reach the affected Replica):

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster call 127.0.0.1:6379 \
     CLUSTER SETSLOT <slot-id> NODE <replica-node-id>
   ```

6. Promote that Replica to take over the shard:

   ```bash
   # Run on the Replica targeted in step 5:
   redis-cli -a $REDIS_PASSWORD CLUSTER FAILOVER TAKEOVER
   ```

7. Re-run the `--cluster check`. All 16384 slots should now be covered.

:::warning
`CLUSTER FAILOVER TAKEOVER` is a forceful operation that bypasses the usual majority requirement. Use it only after confirming the original Primary is unrecoverable; otherwise prefer the regular `CLUSTER FAILOVER` to avoid divergent histories.
:::

### Scenario 4: Manually Remove a Failed Node From a Cluster

**Symptom**: A pod has been permanently destroyed or rebuilt, but its node ID still appears in `CLUSTER NODES` as `fail` or `disconnected`. The operator has not yet pruned it.

**Recovery**:

1. List the cluster nodes and identify the stale entry:

   ```bash
   redis-cli -a $REDIS_PASSWORD CLUSTER NODES
   ```

2. Capture the failed node's `<node-id>` from the first column.

3. Remove the node from every node's view of the cluster. Run from any data pod:

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster call 127.0.0.1:6379 CLUSTER FORGET <node-id>
   ```

   `--cluster call` propagates the command to every node in the cluster; this is required because `CLUSTER FORGET` is local to each node.

4. Re-run `CLUSTER NODES` from any pod. The forgotten node should be gone within 60 seconds (the gossip timeout).

:::warning
- `CLUSTER FORGET` only forgets the entry; it does **not** delete the underlying pod. Verify that the pod is genuinely gone before running this command, or the gossip protocol will simply re-discover the node.
- Do not `FORGET` a node that still owns slots. Reassign its slots first using the procedure in Scenario 3.
:::

## Important Considerations

- **Always capture diagnostics before destructive recovery**: `kubectl get pods -o wide`, `kubectl describe pod`, `redis-cli CLUSTER NODES`, `redis-cli INFO replication`, and operator logs. Many of these procedures lose information about the prior incorrect state once they succeed.
- **Run destructive commands only on the affected pod**. `CLUSTER RESET`, `FLUSHALL`, `SLAVEOF NO ONE`, and `CLUSTER FAILOVER TAKEOVER` are powerful and irrevocable.
- **Restore order before retrying**: After a successful recovery, wait for the operator to mark the Redis CR as `Healthy` before issuing further operations such as password rotations or backups.
- **Air-gap environments**: All commands above are local to the cluster and do not require external connectivity. The redis-operator container image and Redis images must already be available in the in-cluster registry.
- **Escalate when stuck**: If the cluster remains unhealthy after these procedures, gather the diagnostics listed above and engage the supporting product team. Do not loop destructive commands hoping for a different result.
