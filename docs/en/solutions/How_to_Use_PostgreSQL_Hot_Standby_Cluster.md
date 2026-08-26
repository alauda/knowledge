---
kind:
   - Solution
products: 
  - Alauda Application Services
ProductsVersion:
   - 4.x
id: KB251000009
---

# PostgreSQL Hot Standby Cluster Configuration Guide

## Background

### The Challenge

Modern applications require high availability and disaster recovery capabilities for their PostgreSQL databases. Traditional backup solutions often involve significant downtime and data loss. Manual replication setups are complex to configure and maintain.

### The Solution

This guide provides comprehensive instructions for setting up PostgreSQL hot standby clusters using Alauda Container Platform (ACP). The solution supports both intra-cluster and cross-cluster replication, enabling:

- **Minimal Data Loss**: Continuous streaming replication ensures minimal data loss (typically seconds of data at most)
- **Manual Failover**: High availability with controlled promotion of standby clusters when needed
- **Geographic Redundancy**: Cross-cluster replication for disaster recovery
- **Operational Simplicity**: Automated configuration through Kubernetes custom resources

## Environment Information

Applicable Versions: >=ACP 4.1.0, PostgreSQL Operator: >=4.1.8 (LoadBalancer support requires PostgreSQL Operator >=4.2.0)

## Quick Reference

### Key Concepts
- **Primary Cluster**: The master PostgreSQL cluster that accepts read/write operations
- **Standby Cluster**: The replica cluster that continuously syncs from the primary
- **Streaming Replication**: Real-time WAL (Write-Ahead Log) replication between clusters
- **Switchover**: Planned promotion/demotion of clusters during maintenance
- **Failover**: Emergency promotion when the primary cluster becomes unavailable

### Common Use Cases

| Scenario | Recommended Approach | Section Reference |
|----------|---------------------|------------------|
| **High Availability** | Intra-cluster replication | [Intra-cluster Setup](#intra-cluster-setup) |
| **Disaster Recovery** | Cross-cluster replication | [Cross-cluster Setup](#cross-cluster-setup) |
| **Planned Maintenance** | Switchover procedure | [Normal Operations](#normal-operations) |
| **Emergency Recovery** | Manual failover procedure | [Disaster Recovery](#disaster-recovery) |

## Prerequisites

Before implementing PostgreSQL hot standby, ensure you have:

- ACP v4.1.0 or later with PostgreSQL Operator v4.1.8 or later
- PostgreSQL plugin deployed following the [installation guide](https://docs.alauda.io/postgresql/4.1/installation.html)
- Basic understanding of PostgreSQL operations and Kubernetes concepts
- Read the [PostgreSQL Operator Basic Operations Guide](https://docs.alauda.io/postgresql/4.1/functions/index.html) to understand basic operations such as creating instances, backups, and monitoring
- **Storage Resources**:
  - Primary cluster: Storage capacity should accommodate database size plus Write-Ahead Log (WAL) files (typically 10-20% additional space)
  - Standby cluster: Same storage capacity as primary cluster to ensure complete data replication. Ensure the **StorageClass performance (IOPS/Throughput)** matches the primary cluster to prevent performance degradation after failover.
  - Consider future growth and set appropriate `max_slot_wal_keep_size` (minimum 10GB recommended)
- **Network Resources**:
  - Intra-cluster: Standard Kubernetes network performance
  - Cross-cluster: Low-latency connection (<20ms) with sufficient bandwidth (at least 1 Gbps for production workloads)
  - Stable network connectivity to prevent replication interruptions
- **Compute Resources**:
  - Primary cluster: Adequate CPU and memory for both database operations and replication processes
  - Standby cluster: Similar CPU and memory allocation as primary to handle read operations and potential promotion

### Important Limitations

- Source and target clusters must run the same PostgreSQL version
- The `replSvcType` of the primary and standby clusters must be the same
- Standby clusters initially support single replica instances only
- Multi-replica high availability on standby clusters requires configuration adjustments after promotion
- Monitoring and alerting for replication status require additional setup

## Configuration Guide

### Intra-cluster Setup

#### Primary Cluster Configuration

**Using Web Console:**

Refer to the [Create Instance documentation](https://docs.alauda.io/postgresql/4.1/functions/01_create_instance.html) for detailed instructions on creating a PostgreSQL instance. Then, to enable primary cluster configuration for hot standby:

1. Complete basic PostgreSQL configuration
2. Switch to YAML view and enable cluster replication:

```yaml
spec:
  clusterReplication:
    enabled: true
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

4. Complete instance creation and wait for Running status

**Using Command Line:**

Use the following command to create a primary cluster with replication enabled:

```bash
PRIMARY_CLUSTER="acid-primary"
NAMESPACE="your-namespace"

cat << EOF | kubectl -n $NAMESPACE create -f -
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: $PRIMARY_CLUSTER
spec:
  teamId: ACID
  postgresql:
    version: "16"
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 2
  clusterReplication:
    enabled: true
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
  volume:
    size: 50Gi
EOF
```

Verify cluster status (expected output: "Running"):

```bash
$ kubectl -n $NAMESPACE get postgresql $PRIMARY_CLUSTER -ojsonpath='{.status.PostgresClusterStatus}{"\n"}'
Running
```

#### Standby Cluster Configuration

**Preparation:**
1. Obtain primary cluster admin credentials
2. Create bootstrap secret in the standby cluster namespace containing the primary cluster's admin credentials:

```yaml
kind: Secret
apiVersion: v1
metadata:
  name: standby-bootstrap-secret
  namespace: standby-namespace  # Replace with your standby cluster namespace
type: kubernetes.io/basic-auth
stringData:
  username: postgres
  password: "<YOUR-PRIMARY-ADMIN-PASSWORD>"
```

**Important Notes:**
- Replace the namespace with your standby cluster's namespace
- The username and password must match the primary cluster's admin credentials
- The secret name should be referenced in the standby cluster configuration as `bootstrapSecret`

3. Execute checkpoint on primary cluster to ensure WAL consistency:
```bash
kubectl exec -n <primary-namespace> <primary-pod-name> -- psql -c "CHECKPOINT;"
```

**Using Web Console:**

1. Create instance with single replica configuration
2. Switch to YAML view and configure replication:

> **Note**: Replace `peerHost` with the actual Service IP of your Primary cluster.

```yaml
spec:
  numberOfInstances: 1
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 10.96.140.172  # Primary cluster read-write service IP
    peerPort: 5432
    replSvcType: ClusterIP
    bootstrapSecret: standby-bootstrap-secret
```

**Using Command Line:**

```bash
STANDBY_CLUSTER="acid-standby"
NAMESPACE="standby-namespace"

cat << EOF | kubectl -n $NAMESPACE create -f -
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: $STANDBY_CLUSTER
spec:
  teamId: ACID
  postgresql:
    version: "16"
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 10.96.140.172
    peerPort: 5432
    replSvcType: ClusterIP
    bootstrapSecret: standby-bootstrap-secret
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
  volume:
    size: 50Gi
EOF
```

Verify standby status:
```bash
$ kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
+ Cluster: acid-standby (7562204126329651274) -------+-----------+----+-----------+
| Member         | Host             | Role           | State     | TL | Lag in MB |
+----------------+------------------+----------------+-----------+----+-----------+
| acid-standby-0 | fd00:10:16::29b8 | Standby Leader | streaming |  1 |           |
+----------------+------------------+----------------+-----------+----+-----------+
```

### Cross-cluster Setup

#### Primary Cluster Configuration

**Option 1: Using NodePort**

Configure primary cluster with NodePort service type for cross-cluster access:

```yaml
spec:
  clusterReplication:
    enabled: true
    replSvcType: NodePort
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

**Option 2: Using LoadBalancer (Requires Operator v4.2.0+)**

Configure primary cluster with LoadBalancer service type:

```yaml
spec:
  clusterReplication:
    enabled: true
    replSvcType: LoadBalancer
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
```

#### Standby Cluster Configuration

**Preparation:**

1. Obtain primary cluster admin credentials
2. Create bootstrap secret in the standby cluster namespace containing the primary cluster's admin credentials:

```yaml
kind: Secret
apiVersion: v1
metadata:
  name: standby-bootstrap-secret
  namespace: standby-namespace  # Replace with your standby cluster namespace
type: kubernetes.io/basic-auth
stringData:
  username: postgres
  password: "<YOUR-PRIMARY-ADMIN-PASSWORD>"
```

3. Execute checkpoint on primary cluster to ensure WAL consistency:
```bash
kubectl exec -n <primary-namespace> <primary-pod-name> -- psql -c "CHECKPOINT;"
```

**Option 1: Connecting via NodePort**

Configure standby cluster to connect via NodePort:

> **Note**: Replace `peerHost` with the actual Node IP of the Primary cluster and `peerPort` with the NodePort.

```yaml
spec:
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 192.168.130.206  # Primary cluster node IP
    peerPort: 31661            # Primary cluster NodePort
    replSvcType: NodePort
    bootstrapSecret: standby-bootstrap-secret
```

**Option 2: Connecting via LoadBalancer (Requires Operator v4.2.0+)**

Obtain the External IP from the primary cluster's service after creation, then configure the standby:

```yaml
spec:
  postgresql:
    parameters:
      max_slot_wal_keep_size: '10GB'
  numberOfInstances: 1
  clusterReplication:
    enabled: true
    isReplica: true
    peerHost: 203.0.113.10     # Primary cluster LoadBalancer External IP
    peerPort: 5432             # Standard PostgreSQL port (or the specific LB port)
    replSvcType: LoadBalancer
    bootstrapSecret: standby-bootstrap-secret
```

**Verification Step:**

After the standby cluster is successfully running, verify that its External IP is correctly recorded in the primary cluster's `sys_operator.multi_cluster_info` table.

1. Check the table content on the primary cluster:
   ```bash
   kubectl exec <primary-pod> -- psql -x -c "SELECT * FROM sys_operator.multi_cluster_info;"
   ```

2. If the `external_ip` field for the standby cluster record is empty, manually update it with the standby cluster's LoadBalancer IP.

   First, retrieve the LoadBalancer IP of the standby cluster:
   ```bash
   kubectl get svc -n <standby-namespace> <standby-cluster-name>
   ```
   Note the `EXTERNAL-IP` from the output.

   Then, execute the update:
   ```bash
   kubectl exec <primary-pod> -- psql -c "UPDATE sys_operator.multi_cluster_info SET external_ip='<STANDBY-LB-IP>' WHERE cluster_name='<standby-cluster-name>';"
   ```

## Normal Operations

### Switchover Procedure

To avoid split-brain scenarios, perform planned switchovers in three phases. **Phase 3 is not optional** — promoting the new primary does not change where the application sends its database connections.

> **Important**: For Cross-cluster setups, ensure you switch your `kubectl` context to the appropriate cluster before executing commands.

:::info Confirm the replication metadata is clean before switching over
Phase 1 demotes the current primary **in place**. The demoted cluster obtains its new peer's
connection details from the `sys_operator.multi_cluster_info` table, so a switchover is only as
reliable as the contents of that table.

If either cluster has ever been deleted and recreated, verify that exactly one row exists per
cluster before proceeding — see
[Stale replication metadata](#stale-replication-metadata-after-recreating-a-cluster).

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role, node_port, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```
:::

#### Phase 1: Demote Primary to Standby

```bash
kubectl -n $NAMESPACE patch pg $PRIMARY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":true},"numberOfInstances":1}}'
```

Verify demotion:
```bash
$ kubectl -n $NAMESPACE exec $PRIMARY_CLUSTER-0 -- patronictl list
+ Cluster: acid-primary (7562204126329651274) -------+---------+----+-----------+
| Member         | Host             | Role           | State   | TL | Lag in MB |
+----------------+------------------+----------------+---------+----+-----------+
| acid-primary-0 | fd00:10:16::29b3 | Standby Leader | running |  1 |           |
+----------------+------------------+----------------+---------+----+-----------+
```

#### Phase 2: Promote Standby to Primary

```bash
kubectl -n $NAMESPACE patch pg $STANDBY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":false},"numberOfInstances":2}}'
```

Verify promotion:
```bash
$ kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
+ Cluster: acid-standby (7562204126329651274) -----+-----------+----+-----------+
| Member         | Host             | Role         | State     | TL | Lag in MB |
+----------------+------------------+--------------+-----------+----+-----------+
| acid-standby-0 | fd00:10:16::29b8 | Leader       | running   |  2 |           |
| acid-standby-1 | fd00:10:16::2a2e | Sync Standby | streaming |  2 |         0 |
+----------------+------------------+--------------+-----------+----+-----------+
```

#### Phase 3: Repoint the Application to the New Primary

⚠ **The switchover does not do this for you.** After Phases 1 and 2, the former primary is a
**read-only standby**, and the application's database connection still points at it. Writes keep
failing:

```
ERROR: cannot execute UPDATE in a read-only transaction
ERROR: cannot execute INSERT in a read-only transaction
```

Healthy replication does not mean the service is restored — **the application connection must be
repointed explicitly.**

**1. Confirm the new primary is writable**

```bash
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- psql -Atc "select pg_is_in_recovery()"
# expected: f
```

**2. Get the new primary's connection endpoint**

```bash
# Intra-cluster: use the master service directly
echo "$STANDBY_CLUSTER.$NAMESPACE.svc.cluster.local:5432"

# Cross-cluster: the application reaches it via NodePort / LoadBalancer
kubectl -n $NAMESPACE get svc $STANDBY_CLUSTER -o wide
```

> In a cross-cluster setup this is the same class of path as the `peerHost` / `peerPort` used when
> configuring the standby — confirm the firewall permits it as well.

**3. Confirm credentials**

Database credentials live in a Secret named **after the cluster**, so the Secret name changes with
the cluster:

```bash
kubectl -n $NAMESPACE get secret \
  <username>.$STANDBY_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

**4. Update the application configuration and restart**

Update the database endpoint however the application is configured (ConfigMap / Secret / environment
variable / connection string), then restart its pods so the new connection takes effect.

**5. Verify**

```bash
# Connections from the application should appear on the new primary
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- \
  psql -x -c "select client_addr, usename, state, query_start from pg_stat_activity
                where backend_type = 'client backend'"
```

Confirm that `read-only transaction` errors no longer appear in either the application or the
database logs.

> **Recommendation**: where the application supports it, connect through an indirection that is
> decoupled from the cluster name (a stable Service alias, an external DNS name, or a connection
> pooler), so future switchovers only require repointing that indirection rather than editing
> application configuration.

### Monitoring Replication Status

Check replication status on primary cluster:

```bash
$ kubectl exec $(kubectl -n $NAMESPACE get pod -l spilo-role=master,cluster-name=$PRIMARY_CLUSTER | tail -n+2 | awk '{print $1}') -- curl -s localhost:8008 | jq
{
  "state": "running",
  "postmaster_start_time": "2025-10-18 02:52:03.144373+00:00",
  "role": "standby_leader",
  "server_version": 160010,
  "xlog": {
    "received_location": 503637736,
    "replayed_location": 503637736,
    "replayed_timestamp": "2025-10-18 02:55:37.197686+00:00",
    "paused": false
  },
  "timeline": 2,
  "replication_state": "streaming",
  "dcs_last_seen": 1760756364,
  "database_system_identifier": "7562204126329651274",
  "patroni": {
    "version": "3.2.2",
    "scope": "acid-primary",
    "name": "acid-primary-0"
  }
}

$ kubectl exec $(kubectl -n $NAMESPACE get pod -l spilo-role=master,cluster-name=$STANDBY_CLUSTER | tail -n+2 | awk '{print $1}') -- curl -s localhost:8008 | jq
{
  "state": "running",
  "postmaster_start_time": "2025-10-17 14:57:25.629615+00:00",
  "role": "master",
  "server_version": 160010,
  "xlog": {
    "location": 503640096
  },
  "timeline": 2,
  "replication": [
    {
      "usename": "standby",
      "application_name": "acid-primary-0",
      "client_addr": "fd00:10:16::29b3",
      "state": "streaming",
      "sync_state": "async",
      "sync_priority": 0
    },
    {
      "usename": "standby",
      "application_name": "acid-standby-1",
      "client_addr": "fd00:10:16::2a2e",
      "state": "streaming",
      "sync_state": "sync",
      "sync_priority": 1
    }
  ],
  "dcs_last_seen": 1760756544,
  "database_system_identifier": "7562204126329651274",
  "patroni": {
    "version": "3.2.2",
    "scope": "acid-standby",
    "name": "acid-standby-0"
  }
}
```

## Disaster Recovery

### Primary Cluster Failure

When the primary cluster fails and cannot be recovered promptly:

1. **Manual Intervention Required**: Promote the standby cluster using the manual failover procedure
2. Update application connections to point to the new primary (see *Normal Operations → Phase 3*)
3. When the original primary recovers, reconfigure it as a standby
4. **Note**: Some data loss may occur depending on replication lag at the time of failure

### Standby Cluster Failure

Standby cluster failures don't affect primary operations. Recovery is automatic:

1. Fix the underlying issue causing standby failure
2. The standby will automatically reconnect and resynchronize
3. Monitor replication status to ensure catch-up completes

## Troubleshooting

### Common Issues

#### Replication Slot Errors

##### Symptoms

- "Exception when changing replication slots" errors in standby node logs
- Specific error traceback showing TypeError with '>' not supported between 'int' and 'NoneType'
- Example error log:
```text
2025-10-10T09:06:19.452Z ERROR: Exception when changing replication slots
Traceback (most recent call last):
  ...
  File "/usr/local/lib/python3.10/dist-packages/patroni/postgresql/slots.py", line 383, in _ensure_physical_slots
    if lsn and lsn > value['restart_lsn']:  # The slot has feedback in DCS and needs to be advanced
TypeError: '>' not supported between instances of 'int' and 'NoneType'
```
- Cluster operations and replication may continue to function normally despite these errors

##### Cause

Known bug in the current Patroni version that will be fixed in future releases

##### Solution

Manually drop the problematic replication slot:

```sql
SELECT pg_catalog.pg_drop_replication_slot('xdc_hotstandby');
```

#### Standby Join Failures

##### Symptoms

Standby cluster fails to join replication, data synchronization issues

##### Cause

Two different conditions produce the same symptom, and they have different remedies. Identify which
one you have before acting.

- **The standby is behind, and the WAL it needs has been recycled.** The standby log repeats
  `requested WAL segment ... has already been removed`. The data is intact and consistent; the
  standby simply cannot obtain the WAL required to catch up.
- **The standby has diverged.** The standby log reports
  `requested starting point ... is not in this server's history`, or the two clusters report
  different `system identifier` values. Streaming replication cannot reconcile this.

##### Diagnosis

```bash
# 1. Same lineage? The two values must match. Different values mean these are unrelated databases.
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- \
  pg_controldata /home/postgres/pgdata/pgroot/data | grep -i "system identifier"

# 2. What is the standby actually reporting? Read the error, not just the symptom.
kubectl -n <ns> exec <standby-pod> -c postgres -- \
  tail -200 /home/postgres/pgdata/pgroot/pg_log/postgresql-*.csv | grep -iE "removed|history"

# 3. Does the primary still hold the WAL the standby needs, and is anything retaining it?
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -x \
  -c "select substr(name,1,8) as timeline, count(*) as segments,
             min(name) as oldest, max(name) as newest
        from pg_ls_waldir() where name ~ '^[0-9A-F]{24}$' group by 1 order by 1;" \
  -c "select slot_name, active, restart_lsn, wal_status,
             pg_size_pretty(safe_wal_size) as safe
        from pg_replication_slots;"
```

Use the primary's **current leader**, which is not necessarily pod `-0`. Determine it with
`patronictl list`.

##### Solution

:::warning Rebuilding discards your ability to recover any other way
The procedure below deletes the standby cluster. Deleting it removes `spec.clusterReplication`, so
the operator drops the `xdc_hotstandby` replication slot on the primary, and **all WAL retention for
that peer is released immediately**. Any WAL the standby still needed becomes eligible for recycling
at the primary's next checkpoint.

If the standby was only behind rather than diverged, applying this procedure converts a recoverable
situation into one that requires a full base backup, and destroys the evidence needed to determine
why replication stopped.

**Before deleting anything:**

1. Complete the Diagnosis steps above and record the output.
2. If the missing WAL still exists — in the primary's `pg_wal`, in a WAL archive, or on another
   member of the primary cluster — the standby can be repaired by making those segments available
   to it instead. Copy the complete segments into the standby's `pg_wal` directory (owned by
   `postgres`, mode `600`) and restart it. Verify each copied file against its source by checksum:
   a standby that is stuck often already holds a **partial** copy of the very segment it is failing
   on, and that partial file is a full 16 MiB, so file size does not indicate completeness.
3. Take a storage-level snapshot of the primary's volumes.
:::

1. Delete the failed standby cluster
2. Remove cluster metadata from primary:
```sql
DELETE FROM sys_operator.multi_cluster_info WHERE cluster_name='<failed-cluster-name>';
```

   **Step 2 must be completed before step 3, and must not be skipped.** Each cluster's row is keyed
   by an ID derived from the cluster's Kubernetes UID, so a recreated cluster registers under a
   *new* ID. If the old row is still present, the table ends up holding two rows for the same
   cluster — one current, one obsolete. See
   [Stale replication metadata](#stale-replication-metadata-after-recreating-a-cluster).

3. Recreate the standby cluster following initial setup procedures
4. Verify that exactly one row exists per cluster:

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role, node_port, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```

5. After the standby is running, confirm that replication is actually retained — not merely
   connected. The slot must exist, be active, and track the standby:

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -x -c \
  "select slot_name, active, restart_lsn, wal_status from pg_replication_slots
    where slot_name = 'xdc_hotstandby';"
```

An empty `restart_lsn` means the slot is reserving nothing, and WAL will be recycled regardless of
`max_slot_wal_keep_size`. A missing row means no slot exists and the peer has no retention at all.

#### Stale Replication Metadata After Recreating a Cluster

##### Symptoms

Replication does not resume after a switchover or after recreating a cluster, even though both
clusters are running and the network path between them is open. The demoted or recreated cluster
may address the peer on a port or address that is no longer in use.

##### Cause

Cross-cluster replication stores each participating cluster's connection details in the
`sys_operator.multi_cluster_info` table on the primary. Each row's ID is derived from the cluster's
Kubernetes UID, so **a recreated cluster registers under a new ID rather than updating the existing
row**. If the previous row was not removed first, the table holds two rows describing the same
cluster, one of which is obsolete.

On **PostgreSQL Operator versions earlier than v4.3.4**, the query that reads peer details applies
no ordering and the first row returned is used, so an obsolete row may be selected in preference to
the current one. Those versions also do not refresh a row's `last_update` timestamp when re-registering,
so the timestamps give no reliable indication of which row is current.

**PostgreSQL Operator v4.3.4 and later** refresh `last_update` on every registration and select the
most recently updated row, so a leftover row no longer takes precedence.

##### Diagnosis

```bash
kubectl -n <ns> exec <primary-leader-pod> -c postgres -- psql -U postgres -c \
  "select id, trim(cluster_name) as cluster_name, trim(role) as role,
          repl_svc_ip, node_port, trim(member_hosts) as member_hosts, last_update
     from sys_operator.multi_cluster_info order by cluster_name, last_update desc;"
```

Expect exactly one row per cluster. More than one row for the same `cluster_name` indicates leftover
metadata. Compare `node_port` against the peer's current master Service:

```bash
kubectl -n <ns> get svc <peer-cluster-name> -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'
```

##### Solution

1. Remove the obsolete rows, keeping only the row whose `node_port` and `member_hosts` match the
   peer's current master Service:

```sql
DELETE FROM sys_operator.multi_cluster_info WHERE id = <obsolete-id>;
```

2. Allow the operator to reconcile, then confirm the `-xcr` Service endpoints now address the peer's
   current port:

```bash
kubectl -n <ns> get endpoints <cluster-name>-xcr -o yaml
```

3. Where practical, run PostgreSQL Operator v4.3.4 or later, which selects the most recently updated
   row and so is not affected by leftover metadata.

#### Data Synchronization Issues

##### Symptoms

Replication lag increases, standby falls behind

##### Solutions

- Verify network connectivity between clusters
- Check storage performance on both clusters
- Monitor `max_slot_wal_keep_size` setting to ensure sufficient WAL retention
- Consider increasing resources if under-provisioned
- **Important**: Regular monitoring is crucial to minimize potential data loss during failover

### Diagnostic Commands

Check replication status:
```bash
# On standby cluster
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list

# On primary cluster  
kubectl -n $NAMESPACE exec $PRIMARY_CLUSTER-0 -- patronictl list
```

Verify streaming replication:
```bash
kubectl exec -it <primary-pod> -- psql -c "SELECT * FROM pg_stat_replication;"
```

Check WAL settings:
```bash
kubectl exec -it <primary-pod> -- psql -c "SHOW max_slot_wal_keep_size;"
```

## Best Practices

### Configuration Recommendations

- Set `max_slot_wal_keep_size` appropriately (10GB minimum for production)
- Use dedicated storage classes with sufficient IOPS for database workloads
- Implement monitoring for replication lag and cluster health
- Regular testing of failover procedures in non-production environments

### Operational Guidelines

- Perform switchovers during maintenance windows with application coordination
- Monitor disk space on both primary and standby clusters
- Keep PostgreSQL versions synchronized across clusters
- Maintain recent backups in addition to replication

## Reference

### Custom Resource Parameters

**Primary Cluster Configuration:**
- `clusterReplication.enabled`: Enable replication (true/false)
- `clusterReplication.replSvcType`: Service type (ClusterIP/NodePort/LoadBalancer)
- `postgresql.parameters.max_slot_wal_keep_size`: WAL retention size

**Standby Cluster Configuration:**
- `clusterReplication.isReplica`: Mark as standby (true)
- `clusterReplication.peerHost`: Primary cluster endpoint
- `clusterReplication.peerPort`: Primary cluster port
- `clusterReplication.bootstrapSecret`: Authentication secret

### Useful Links

- [PostgreSQL Operator Documentation](https://docs.alauda.io/postgresql/4.1/functions/index.html)
- [PostgreSQL Operator Installation Guide](https://docs.alauda.io/postgresql/4.1/installation.html)

## Summary

This guide provides comprehensive instructions for implementing PostgreSQL hot standby clusters on Alauda Container Platform. The solution delivers enterprise-grade high availability and disaster recovery capabilities through streaming replication and manual failover management.

Key benefits achieved:
- **Minimal Data Loss**: Continuous WAL replication minimizes potential data loss (typically seconds)
- **Controlled Failover**: Manual promotion ensures proper validation and reduces risk
- **Flexible Deployment**: Support for both intra-cluster and cross-cluster scenarios
- **Production Ready**: Battle-tested configuration patterns for enterprise workloads

By following these practices, organizations can ensure their PostgreSQL databases meet stringent availability and recovery objectives while maintaining control over critical failover operations.

