---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.3
id: KB260720001
---

# PostgreSQL Instance Cross-Cluster Migration Guide (Operator v4.3.3)

## Background

### The Challenge

Sometimes a running PostgreSQL instance must move to a different Kubernetes cluster — cluster decommissioning, hardware refresh, moving a workload between ACP platforms, or consolidating environments. Dump-and-restore migrations require downtime proportional to database size and lose writes made after the dump.

### The Solution

This guide migrates a PostgreSQL instance across clusters using the operator's hot standby (cross-cluster replication) feature: the target instance is created as a *standby cluster* that bootstraps directly from the source via streaming replication, stays continuously in sync, and is then promoted in a controlled two-phase switchover. Downtime is limited to the switchover itself (seconds to a couple of minutes), and data integrity is verified with checksums before and after cutover.

This procedure was validated end-to-end with PostgreSQL Operator v4.3.3 on two separate ACP platforms (source and target in different platforms, connected via NodePort). It builds on the [PostgreSQL Hot Standby Cluster Configuration Guide](./How_to_Use_PostgreSQL_Hot_Standby_Cluster.md) (KB251000009); read that first for concept background.

## Environment Information

- PostgreSQL Operator: v4.3.3 on **both** source and target clusters (see [Important Limitations](#important-limitations))
- ACP: any 4.x cluster able to run the v4.3.3 operator; source and target may be in different ACP platforms
- PostgreSQL: same major version on both sides (this guide uses 16)

## Important Limitations

- **The operator version must match on both sides.** Cross-version pairing (e.g. a v4.2+/v4.3 standby against a primary managed by v4.1.x) fails with `pq: column "external_ip" does not exist` and — dangerously — leaves the "standby" running as an empty independent primary (tracked as ECO-703). See [Troubleshooting](#troubleshooting).
- Source and target must run the same PostgreSQL major version.
- The standby cluster must initially be created with `numberOfInstances: 1`; scale it up after promotion.
- `replSvcType` must be identical on both clusters.
- The target cluster must be able to reach the source cluster's node IP + NodePort (standby pulls from primary). Verify this before starting — see Step 2. If there is **no network path between the clusters**, the streaming approach cannot work — use the [workstation-relayed logical migration](#alternative-migration-without-inter-cluster-connectivity) instead.
- On mixed-architecture target clusters, pin the instance (and ideally the operator) to nodes matching the source architecture. Streaming replication copies the data directory bit-for-bit; PostgreSQL does not support mixed-architecture replication.

## Migration Overview

```
Step 1  Prepare source: enable clusterReplication, record NodePort, baseline checksums
Step 2  Preflight: network reachability, version/arch checks
Step 3  Create standby on target (bootstraps from source, stays streaming)
Step 4  Verify sync: identity, lag, checksums
Step 5  Cutover: two-phase switchover (demote source, promote target)
Step 6  Post-migration: repoint clients; keep reverse standby or dismantle
```

## Step 1: Prepare the Source Instance

If the source instance does not yet have cluster replication enabled, patch it (this is an online change; the operator creates the replication metadata and exposes the master service):

```bash
SRC_NS="pg-migrate"
SRC_CLUSTER="acid-mig"

kubectl -n $SRC_NS patch postgresql $SRC_CLUSTER --type merge -p '{
  "spec": {
    "clusterReplication": {"enabled": true, "replSvcType": "NodePort"},
    "postgresql": {"parameters": {"max_slot_wal_keep_size": "10GB"}}
  }
}'
```

> `max_slot_wal_keep_size` bounds WAL retained for the replication slot if the standby disconnects. Size it to your volume: it must fit in the instance's free disk space, and it defines how long a standby outage you can tolerate before a re-bootstrap is needed.

Record the connection coordinates the standby will use:

```bash
# NodePort of the source master service
kubectl -n $SRC_NS get svc $SRC_CLUSTER -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'

# A node IP hosting the instance (any node IP of the cluster works for NodePort)
kubectl -n $SRC_NS get pod -l cluster-name=$SRC_CLUSTER -o jsonpath='{range .items[*]}{.status.hostIP}{"\n"}{end}'
```

Confirm the source registered itself in the replication metadata (role `primary`, correct `node_port`):

```bash
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -x \
  -c "SELECT * FROM sys_operator.multi_cluster_info;"
```

Take a data integrity baseline. Adapt the checksum query to your schema — the point is a number you can compare after migration:

```bash
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -d <yourdb> -tA -c "
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
# Example per-table checksum:
#   SELECT count(*), sum(hashtext(id::text || payload)) FROM your_table;
```

Finally, force a checkpoint so the standby's basebackup starts from a consistent point:

```bash
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -c "CHECKPOINT;"
```

## Step 2: Preflight Checks on the Target

**Network reachability** — the standby (operator pod *and* PostgreSQL pods) must reach the source NodePort. Test from a pod on the overlay network of the target cluster, on the node(s) where the instance will run:

```bash
# From any pod with bash on the target cluster:
kubectl exec <some-pod> -- bash -c 'timeout 4 bash -c "echo > /dev/tcp/<SRC_NODE_IP>/<SRC_NODEPORT>" && echo OPEN || echo CLOSED'
```

If this prints `CLOSED`, stop and fix connectivity first. Note that reachability can differ per node (broken egress on individual nodes has been observed); test from the nodes you will schedule onto.

**Version check** — both operators must be v4.3.3 (or at least the same version):

```bash
kubectl -n operators get csv | grep postgres-operator
```

**Architecture** — on mixed-architecture targets, decide the node set now and pin with `nodeAffinity` (shown in Step 3).

## Step 3: Create the Standby on the Target Cluster

Create the namespace and a bootstrap secret holding the **source** cluster's admin credentials:

```bash
TGT_NS="pg-migrate"

# Read the admin password from the source cluster:
kubectl --context <source-ctx> -n $SRC_NS get secret \
  postgres.${SRC_CLUSTER}.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d
```

```yaml
kind: Secret
apiVersion: v1
metadata:
  name: standby-bootstrap-secret
  namespace: pg-migrate
type: kubernetes.io/basic-auth
stringData:
  username: postgres
  password: "<SOURCE-ADMIN-PASSWORD>"
```

Create the standby instance. Keep PostgreSQL version, parameters, and volume size aligned with the source; start with a single replica:

```yaml
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: acid-mig            # name may differ from the source
  namespace: pg-migrate
spec:
  teamId: acid
  numberOfInstances: 1      # required initially for standby clusters
  postgresql:
    version: "16"           # must match the source major version
    parameters:
      max_slot_wal_keep_size: '10GB'
  volume:
    size: 5Gi               # same capacity as source
    storageClass: <target-storageclass>
  # Only needed on mixed-architecture clusters — match the source arch:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: "<SRC_NODE_IP>"
    peerPort: <SRC_NODEPORT>
    replSvcType: NodePort
    bootstrapSecret: standby-bootstrap-secret
```

What happens on creation: the operator connects to the source, copies the database user credential secrets into the target namespace, creates a local `<name>-xcr` service whose endpoints point at the source nodes, and bootstraps the pod with `pg_basebackup` from the source. `patronictl list` shows `creating replica` during the basebackup (duration depends on database size and link bandwidth), then `Standby Leader | streaming`.

## Step 4: Verify Synchronization

All three checks below must pass before cutover.

**1. Streaming state and shared identity** — the cluster identifier printed by `patronictl list` must be *identical* on source and target (it is the PostgreSQL system identifier). If the target shows a different identifier, it bootstrapped as an independent cluster and contains none of your data — see [Troubleshooting](#troubleshooting).

```bash
# Target — expect: Standby Leader | streaming
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- patronictl list

# Source — expect the standby connected, plus the slot active:
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -c \
  "SELECT application_name, client_addr, state FROM pg_stat_replication;
   SELECT slot_name, active FROM pg_replication_slots WHERE slot_name='xdc_hotstandby';"
```

**2. Replication lag** — write on the source, confirm it appears on the target within seconds, and compare LSNs:

```bash
kubectl -n $SRC_NS exec ${SRC_CLUSTER}-0 -c postgres -- psql -U postgres -tA -c "SELECT pg_current_wal_lsn();"
kubectl -n $TGT_NS exec acid-mig-0     -c postgres -- psql -U postgres -tA -c "SELECT pg_last_wal_replay_lsn();"
```

**3. Data checksums** — rerun the Step 1 baseline queries on the target; every value must match.

## Step 5: Cutover (Two-Phase Switchover)

Perform the switchover in the documented order — demote first, then promote — so there is never a moment with two writable primaries.

1. **Stop application writes** to the source (scale writers down, or hold traffic at the application layer).

2. **Confirm zero lag** (Step 4, check 2 — the two LSNs must be equal once writes stop).

3. **Phase 1 — demote the source** to a standby:

```bash
kubectl --context <source-ctx> -n $SRC_NS patch postgresql $SRC_CLUSTER --type merge \
  -p '{"spec":{"clusterReplication":{"isReplica":true},"numberOfInstances":1}}'
```

Wait until the source shows `Standby Leader` (it may pass through `stopped` briefly). The demoted source finds the target automatically through the replication metadata — no `peerHost` needs to be added to its spec.

4. **Phase 2 — promote the target** and scale it to full size:

```bash
kubectl --context <target-ctx> -n $TGT_NS patch postgresql acid-mig --type merge \
  -p '{"spec":{"clusterReplication":{"isReplica":false},"numberOfInstances":2}}'
```

5. **Gate on the real promotion signal.** Do not rely on `pg_is_in_recovery()` alone — during promotion and scale-up the cluster status can read `Running` while Patroni is still converting roles. Wait until **all** of the following hold:

```bash
# a) Patroni shows a Leader in state running (a timeline increase here is normal):
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- patronictl list
# b) the CR reports Running:
kubectl -n $TGT_NS get postgresql acid-mig -o jsonpath='{.status.PostgresClusterStatus}{"\n"}'
# c) the new replica is streaming (after scale-up):
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- psql -U postgres -c \
  "SELECT application_name, state FROM pg_stat_replication;"
```

6. **Verify writes and integrity** on the new primary: insert a marker row, rerun the checksum queries, compare with the baseline.

> A leadership change between the target's pods during promote+scale-up (with an extra timeline bump) is normal operator rolling behavior and does not indicate a problem.

## Step 6: Post-Migration

- **Repoint clients** to the target cluster's service (and update any external access such as NodePort/LoadBalancer/ingress used by applications).
- The demoted source is now a live **reverse DR standby** of the target: writes on the target replicate back to it. Choose one:
  - **Keep it** as disaster-recovery / rollback insurance (recommended for at least a soak period). Rolling back is the same two-phase switchover in the opposite direction.
  - **Dismantle it** and remove the replication setup entirely — see below.
- Scale/tune the target (replica count, resources, backup schedule, monitoring) to match what the source had.

### Dismantling the Source and Removing the Replication Configuration

Perform these steps **in order** — the standby must be gone before the primary's replication configuration is removed, otherwise the standby loses its upstream while still streaming.

**1. Delete the demoted source instance** (on the source cluster):

```bash
kubectl --context <source-ctx> -n $SRC_NS delete postgresql $SRC_CLUSTER
# PVC retention on CR deletion depends on operator configuration — check and
# remove any leftovers to reclaim storage:
kubectl --context <source-ctx> -n $SRC_NS get pvc -l cluster-name=$SRC_CLUSTER
kubectl --context <source-ctx> -n $SRC_NS delete pvc -l cluster-name=$SRC_CLUSTER --ignore-not-found
```

The operator deletes the credential secrets it owns along with the CR.

**2. Convert the target to a normal (non-replicated) instance** by removing the `clusterReplication` block:

```bash
kubectl --context <target-ctx> -n $TGT_NS patch postgresql acid-mig --type json \
  -p '[{"op":"remove","path":"/spec/clusterReplication"}]'
```

The operator handles this transition: it re-applies normal-primary Patroni configuration, drops the `sys_operator` metadata schema from the database, and removes the `xdc_hotstandby` slot from the replication configuration. (The reverse — converting an existing normal instance *into* a standby — is not a supported transition; standbys must be created as standbys.)

**3. Clean up leftover objects** that the operator does not remove:

```bash
# Bootstrap secret (user-created, never operator-owned):
kubectl --context <target-ctx> -n $TGT_NS delete secret standby-bootstrap-secret

# The <name>-xcr service lingers after the role change (it is only removed
# with the CR itself) — delete it:
kubectl --context <target-ctx> -n $TGT_NS delete svc acid-mig-xcr --ignore-not-found

# The physical replication slot can also linger even though it was removed
# from the Patroni configuration — drop it if the Step 4 check finds it:
kubectl --context <target-ctx> -n $TGT_NS exec acid-mig-0 -c postgres -- psql -U postgres -c \
  "SELECT pg_drop_replication_slot('xdc_hotstandby')
     WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='xdc_hotstandby' AND NOT active);"
```

**4. Verify the target is a clean standalone instance:**

```bash
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- psql -U postgres -tA -c \
  "SELECT count(*) FROM pg_replication_slots WHERE slot_name='xdc_hotstandby';
   SELECT count(*) FROM pg_namespace WHERE nspname='sys_operator';"
# Both counts must be 0
kubectl -n $TGT_NS exec acid-mig-0 -c postgres -- patronictl list
# Expect a plain Leader/Replica cluster, no Standby Leader
```

## Alternative: Migration Without Inter-Cluster Connectivity

When the clusters have **no network path between them** but your workstation can reach both Kubernetes API servers, the migration can be relayed through the workstation as a logical dump/restore piped between two `kubectl exec` sessions — the clusters never talk to each other. Downtime equals the full copy duration (versus seconds for the streaming switchover), but there are no operator-version or CPU-architecture constraints, and the PostgreSQL major only needs to be the same or newer on the target.

The full validated procedure is a separate solution: [How to Migrate a PostgreSQL Instance Between Network-Isolated Clusters](./How_to_Migrate_a_PostgreSQL_Instance_Between_Network_Isolated_Clusters.md) (KB260721001).

## Troubleshooting

### Standby fails with `pq: column "external_ip" does not exist` — and runs as an empty independent primary

**Cause:** operator version mismatch between source and target (e.g. source primary managed by v4.1.x, target operator v4.2+/v4.3). The replication metadata table schema differs between these lines and is never migrated (ECO-703). The standby create hook aborts midway and the pod falls through to a normal bootstrap: it comes up as a *fresh, empty, writable* primary while its CR still says `isReplica: true`.

**Detection:** compare the cluster identifier in `patronictl list` on both sides — different identifier means independent cluster, not a standby.

**Fix:** upgrade both operators to the same version (preferred). If the source operator cannot be upgraded immediately, add the missing column on the source primary (safe for both versions — all statements reference columns by name):

```sql
ALTER TABLE sys_operator.multi_cluster_info ADD COLUMN IF NOT EXISTS external_ip CHAR(64) DEFAULT '';
```

Then recreate the standby cleanly — see the next item.

### Recreating a failed standby: create hook fails with secret "already exists"

The operator copies the source's credential secrets into the target namespace *before* bootstrapping, and the copy step fails hard if they already exist from a previous attempt. To retry a standby creation from scratch, delete all of:

```bash
kubectl -n $TGT_NS delete postgresql acid-mig
kubectl -n $TGT_NS delete pvc -l cluster-name=acid-mig     # data from the failed attempt must go
kubectl -n $TGT_NS delete secret \
  postgres.acid-mig.credentials.postgresql.acid.zalan.do \
  standby.acid-mig.credentials.postgresql.acid.zalan.do
```

then re-apply the standby manifest.

### Standby stuck in `creating replica`

The basebackup is either still copying (large database — check network throughput) or cannot connect. Verify Step 2 reachability *from the node the standby pod landed on*; per-node egress differences are a real failure mode. Also confirm the bootstrap secret contains the current source admin password.

### Replication slot errors (`TypeError ... 'int' and 'NoneType'`) in standby logs

Known Patroni issue; replication generally continues. See the [Hot Standby guide's troubleshooting section](./How_to_Use_PostgreSQL_Hot_Standby_Cluster.md#troubleshooting) — drop the `xdc_hotstandby` slot if needed.

## Verification Checklist

| Check | When | Pass condition |
|---|---|---|
| Network preflight | before Step 3 | target overlay pod reaches `SRC_NODE_IP:NODEPORT` |
| Operator versions | before Step 3 | identical on both clusters |
| Shared system identifier | after Step 3 | `patronictl list` identifier equal on both sides |
| Streaming | after Step 3 | target `Standby Leader / streaming`; source slot `xdc_hotstandby` active |
| Checksums (pre-cutover) | Step 4 | all values match baseline |
| LSN parity | Step 5, writes stopped | `pg_current_wal_lsn()` == `pg_last_wal_replay_lsn()` |
| Promotion | Step 5 | Patroni Leader running + CR Running + replica streaming |
| Checksums (post-cutover) | Step 5 | all values match baseline; new write on target succeeds |
| Reverse replication (if source kept) | Step 6 | target write appears on demoted source |
