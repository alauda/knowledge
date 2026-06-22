---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.0,4.1,4.2,4.3
id: KB260515007
---

# How to Migrate a PostgreSQL Instance to Another Node

## Issue

A PostgreSQL cluster managed by the PostgreSQL Operator uses node-local storage
(for example TopoLVM). One or more instances must be moved off their current
node — because the node is being decommissioned, or an instance must run on a
specific compute node. Because the data lives in a node-local PersistentVolume,
the pod cannot simply be rescheduled; the volume is pinned to its node.

## Environment

- Alauda Application Services PostgreSQL Operator (Zalando-based,
  `acid.zalan.do/v1` `postgresql` resource).
- Node-local storage such as TopoLVM (each PVC is bound to one node).
- At least one target node with enough free capacity. Because migration
  re-clones data, the target node should have capacity for roughly **twice** the
  instance's PVC size during the transition.

## Resolution

The migration relies on a property of the Operator: when an instance's PVC and
pod are deleted, the StatefulSet recreates the pod, a fresh PVC is provisioned
wherever the pod is scheduled, and Patroni re-clones the data from the current
leader. Data is preserved through streaming replication, not by moving the
volume.

> Validated on ACP 4.2 and 4.3: after deleting a replica's PVC and pod, the
> member was recreated on a node, re-synced from the leader, and previously
> written rows were present on the resynced member.

In the examples below set `$NAMESPACE` and `$CLUSTER_NAME` for the target
cluster. Replace placeholder node names with your own.

### 1. Confirm the current placement

```bash
kubectl get pod -n $NAMESPACE -o wide | grep $CLUSTER_NAME
kubectl get pvc -n $NAMESPACE -o wide | grep $CLUSTER_NAME
```

Note which member is the leader (do not delete the leader's volume first):

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- patronictl list
```

### 2. Restrict scheduling to the target node(s)

So the recreated pod lands only on a desired node, cordon the other eligible
nodes (or use a `nodeSelector`/label that only the target nodes carry). Keep at
least the target node schedulable.

```bash
# Label ONLY the target node(s) so the recreated pod can land there and nowhere else
kubectl label node <target-node> target=true --overwrite
```

Do **not** label the source node — labeling both source and target would let the
pod reschedule back onto the source. If you prefer cordoning over labels, cordon
all non-target nodes instead and skip the `nodeSelector` step below.

If you use a label-based selector, set it on the instance:

```bash
kubectl patch postgresql -n $NAMESPACE $CLUSTER_NAME --type merge \
  -p '{"spec":{"nodeSelector":{"target":"true"}}}'
```

### 3. Migrate one member at a time

Always migrate a **non-leader** member first. Delete its PVC and pod together —
the PVC deletion blocks until the pod that mounts it is gone, so delete the pod
in parallel:

```bash
# Delete the data PVC (it will stay in Terminating until the pod is gone)
kubectl delete pvc pgdata-$CLUSTER_NAME-1 -n $NAMESPACE --wait=false

# Delete the pod to release the PVC
kubectl delete pod $CLUSTER_NAME-1 -n $NAMESPACE
```

The StatefulSet recreates `$CLUSTER_NAME-1`; a new PVC is provisioned on the
scheduled node and Patroni re-clones from the leader.

### 4. Verify the member rejoined with its data

```bash
kubectl get pod -n $NAMESPACE -o wide | grep $CLUSTER_NAME-1
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- patronictl list
```

The migrated member should return to role `Replica`, state `running`/`streaming`
with `Lag in MB` `0`. Spot-check data on the member (it is read-only / in
recovery):

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-1 -c postgres -- \
  psql -U postgres -tAc "SELECT pg_is_in_recovery();"   # expect t
```

### 5. Migrate the (former) leader if required

To move the leader, first perform a switchover so another member becomes leader,
then repeat steps 3–4 for the old leader:

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- \
  patronictl switchover $CLUSTER_NAME --force
```

### 6. Restore scheduling

Uncordon any nodes you cordoned and remove temporary labels/`nodeSelector` once
all members are on their intended nodes.

## Notes

- Migrate members one at a time and wait for each to fully re-sync (`Lag = 0`)
  before moving the next, so the cluster always retains a healthy quorum.
- For a single-instance cluster, temporarily scale to two instances, let the new
  member sync on the target node, switch over, then scale back to one — this
  avoids downtime that a delete-and-reclone of the sole instance would cause.
