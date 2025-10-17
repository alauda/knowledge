---
products: 
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
   - 4.1.0,4.2.x
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

Applicable Versions: ACP 4.1.0+, PostgreSQL Operator 4.1.7+

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

- ACP v4.1.0 or later with PostgreSQL Operator v4.1.7+
- PostgreSQL plugin deployed following the [installation guide](https://docs.alauda.io/postgresql/4.1/installation.html)
- Basic understanding of PostgreSQL operations and Kubernetes concepts
- Sufficient storage and network resources for replication

### Important Limitations

- Source and target clusters must run the same PostgreSQL version
- Standby clusters initially support single replica instances only
- Multi-replica high availability on standby clusters requires configuration adjustments after promotion
- Monitoring and alerting for replication status require additional setup

## Configuration Guide

### Intra-cluster Setup

#### Primary Cluster Configuration

**Using Web Console:**

1. Navigate to Applications → Create Instance
2. Complete basic PostgreSQL configuration
3. Switch to YAML view and enable cluster replication:

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

Verify cluster status:
```bash
kubectl -n $NAMESPACE get postgresql $PRIMARY_CLUSTER -ojsonpath='{.status.PostgresClusterStatus}{"\n"}'
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
- Use base64 encoding for the credentials (e.g., `echo -n "postgres" | base64`)
- The secret name should be referenced in the standby cluster configuration as `bootstrapSecret`

3. Execute checkpoint on primary cluster to ensure WAL consistency:
```sql
CHECKPOINT;
```

**Using Web Console:**

1. Create instance with single replica configuration
2. Switch to YAML view and configure replication:

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
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
```

### Cross-cluster Setup

#### Primary Cluster Configuration

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

#### Standby Cluster Configuration

Configure standby cluster to connect via NodePort:

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

## Normal Operations

### Switchover Procedure

To avoid split-brain scenarios, perform planned switchovers in two phases:

#### Phase 1: Demote Primary to Standby

```bash
kubectl -n $NAMESPACE patch pg $PRIMARY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":true},"numberOfInstances":1}}'
```

Verify demotion:
```bash
kubectl -n $NAMESPACE exec $PRIMARY_CLUSTER-0 -- patronictl list
```

#### Phase 2: Promote Standby to Primary

```bash
kubectl -n $NAMESPACE patch pg $STANDBY_CLUSTER --type=merge -p '{"spec":{"clusterReplication":{"isReplica":false},"numberOfInstances":2}}'
```

Verify promotion:
```bash
kubectl -n $NAMESPACE exec $STANDBY_CLUSTER-0 -- patronictl list
```

### Monitoring Replication Status

Check replication status on primary cluster:

```bash
kubectl exec $(kubectl -n $NAMESPACE get pod -l spilo-role=master,cluster-name=$PRIMARY_CLUSTER | tail -n+2 | awk '{print $1}') -- curl -s localhost:8008 | jq
```

## Disaster Recovery

### Primary Cluster Failure

When the primary cluster fails and cannot be recovered promptly:

1. **Manual Intervention Required**: Promote the standby cluster using the manual failover procedure
2. Update application connections to point to the new primary
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

**Symptoms**: 
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

**Cause**: Known bug in the current Patroni version that will be fixed in future releases

**Solution**: Manually drop the problematic replication slot:

```sql
SELECT pg_catalog.pg_drop_replication_slot('xdc_hotstandby');
```

#### Standby Join Failures

**Symptoms**: Standby cluster fails to join replication, data synchronization issues

**Cause**: Excessive data drift between clusters preventing WAL-based recovery

**Solution**:
1. Delete the failed standby cluster
2. Remove cluster metadata from primary:
```sql
DELETE FROM sys_operator.multi_cluster_info WHERE cluster_name='<failed-cluster-name>';
```
3. Recreate the standby cluster following initial setup procedures

#### Data Synchronization Issues

**Symptoms**: Replication lag increases, standby falls behind

**Solutions**:
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
- `clusterReplication.replSvcType`: Service type (ClusterIP/NodePort)
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

