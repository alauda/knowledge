---
kind:
   - Solution
products:
  - Alauda DevOps
ProductsVersion:
   - 4.x
id: TODO
---

# How to Perform Disaster Recovery for SonarQube

## Issue

This solution describes how to build a SonarQube disaster recovery solution based on PostgreSQL disaster recovery capabilities. The solution implements a **hot data, cold compute** architecture, where data is continuously synchronized to the secondary cluster through PostgreSQL disaster recovery mechanisms. When the primary cluster fails, a secondary SonarQube instance is deployed, and the secondary SonarQube will quickly start using the disaster recovery data and provide services. The solution primarily focuses on data disaster recovery processing, and users need to implement their own SonarQube access address switching mechanism.

## Environment

SonarQube Operator: >=v2025.1.0

## Terminology

| Term                    | Description                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| **Primary SonarQube**      | The active SonarQube instance that serves normal business operations and user requests. This instance is fully operational with all components running. |
| **Secondary SonarQube**    | The standby SonarQube instance planned to be deployed in a different cluster/region, remaining dormant until activated during disaster recovery scenarios. |
| **Primary PostgreSQL**  | The active PostgreSQL database cluster that handles all data transactions and serves as the source for data replication to the secondary database. |
| **Secondary PostgreSQL**| The hot standby PostgreSQL database that receives real-time data replication from the primary database. It can be promoted to primary role during failover. |
| **Recovery Point Objective (RPO)** | The maximum acceptable amount of data loss measured in time (e.g., 5 minutes, 1 hour). It defines how much data can be lost during a disaster before it becomes unacceptable. |
| **Recovery Time Objective (RTO)** | The maximum acceptable downtime measured in time (e.g., 15 minutes, 2 hours). It defines how quickly the system must be restored after a disaster. |
| **Failover**            | The process of switching from the primary system to the secondary system when the primary system becomes unavailable or fails. |
| **Data Synchronization**| The continuous process of replicating data from primary systems to secondary systems to maintain consistency and enable disaster recovery. |
| **Hot Data, Cold Compute**| An architectural pattern where data is continuously synchronized (hot), while compute resources remain inactive (cold) until failover. |

## Architecture

The SonarQube disaster recovery solution implements a **hot data, cold compute architecture** for SonarQube services. This architecture provides disaster recovery capabilities through near-real-time data synchronization and manual SonarQube service failover procedures. The architecture consists of two SonarQube instances deployed across different clusters or regions, with the secondary SonarQube instance not deployed in advance until activated during disaster scenarios, while the database layer maintains continuous synchronization.

### Data Synchronization Strategy

The solution ensures real-time transaction log synchronization between primary and secondary databases through PostgreSQL streaming replication, including all SonarQube application data

### Disaster Recovery Configuration

1. **Deploy Primary SonarQube**: Configure domain access, connect to the primary PostgreSQL database
2. **Prepare Secondary SonarQube Deployment Environment**: Configure the Secret resources required for the secondary instance to enable rapid recovery when disasters occur

### Failover Procedure

When a disaster occurs, the following steps ensure transition to the secondary environment:

1. **Verify Primary Failure**: Confirm that all primary SonarQube components are unavailable
2. **Promote Database**: Use database failover procedures to promote secondary PostgreSQL to primary
3. **Deploy Secondary SonarQube**: Quickly deploy the SonarQube instance in the secondary cluster using disaster recovery data
4. **Update Routing**: Switch external access addresses to point to the secondary SonarQube instance

## SonarQube Disaster Recovery Configuration

::: warning

To simplify the configuration process and reduce configuration difficulty, it is recommended to use consistent information in both primary and secondary environments, including:

- Consistent database instance names and passwords
- Consistent SonarQube instance names
- Consistent namespace names

:::

### Prerequisites

1. Prepare a primary cluster and a disaster recovery cluster (or a cluster containing different regions) in advance.
2. Complete the deployment of `Alauda support for PostgreSQL` disaster recovery configuration.

### Building PostgreSQL Disaster Recovery Cluster with `Alauda support for PostgreSQL`

Refer to `PostgreSQL Hot Standby Cluster Configuration Guide` to build a disaster recovery cluster using `Alauda support for PostgreSQL`.

Ensure that Primary PostgreSQL and Secondary PostgreSQL are in different clusters (or different regions).

You can search for `PostgreSQL Hot Standby Cluster Configuration Guide` on [Alauda Knowledge](https://cloud.alauda.io/knowledges#/) to obtain it.

:::warning

`PostgreSQL Hot Standby Cluster Configuration Guide` is a document that describes how to build a disaster recovery cluster using `Alauda support for PostgreSQL`. Please ensure compatibility with the appropriate ACP version when using this configuration.

:::

### Set Up Primary SonarQube

Deploy the Primary SonarQube instance by following the SonarQube instance deployment guide. Configure domain access, connect to the primary PostgreSQL database.

Configuration example (only includes configuration items related to disaster recovery, see product documentation for complete configuration items):

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Sonarqube
metadata:
  name: <SONARQUBE_NAME>
  namespace: <SONARQUBE_NAMESPACE>
spec:
  externalURL: http://dr-sonar.alaudatech.net # Configure domain and resolve to primary cluster
  helmValues:
    ingress:
      enabled: true
      hosts:
        - name: dr-sonar.alaudatech.net
    jdbcOverwrite:
      enable: true
      jdbcSecretName: sonarqube-pg
      jdbcUrl: jdbc:postgresql://sonar-dr.sonar-dr:5432/sonar_db? # Connect to primary PostgreSQL
      jdbcUsername: postgres
```

### Set Up Secondary SonarQube

:::warning
When PostgreSQL is in secondary state, the secondary database cannot accept write operations, so SonarQube in the secondary cluster cannot be deployed successfully.

If you need to verify whether SonarQube in the secondary cluster can be deployed successfully, you can temporarily promote the PostgreSQL of the secondary cluster to primary, and after testing is complete, set it back to secondary state. At the same time, you need to delete `sonarqube` resource created during testing.
:::

1. Create Secrets Used by Secondary SonarQube
2. Backup Primary SonarQube Instance YAML

#### Create Secrets Used by Secondary SonarQube

Secondary SonarQube requires two secrets, one for database connection (connect to secondary PostgreSQL) and one for root password. Refer to [SonarQube Deployment Documentation](https://docs.alauda.cn/alauda-build-of-sonarqube/2025.1/install/02_sonarqube_credential.html#pg-credentials) to create them (keep the Secret names consistent with those used in Primary SonarQube configuration).

Example:

```bash
apiVersion: v1
stringData:
  host: sonar-dr.sonar-dr
  port: "5432"
  username: postgres
  jdbc-password: xxxx
  database: sonar_db
kind: Secret
metadata:
  name: sonarqube-pg
  namespace: $SONARQUBE_NAMESPACE
type: Opaque
---
apiVersion: v1
stringData:
  password: xxxxx
kind: Secret
metadata:
  name: sonarqube-root-password
  namespace: $SONARQUBE_NAMESPACE
type: Opaque
```

#### Backup Primary SonarQube Instance YAML

```bash
kubectl -n "$SONARQUBE_NAMESPACE" get sonarqube "$SONARQUBE_NAME" -oyaml > sonarqube.yaml
```

Modify the information in `sonarqube.yaml` according to the actual situation of the disaster recovery environment, including PostgreSQL connection address, etc.

:::warning
The `sonarqube` resource **does not need** to be created in the disaster recovery environment immediately. It only needs to be created in the secondary cluster when a disaster occurs and disaster recovery switchover is performed.
:::

:::warning
If you need to perform disaster recovery drills, you can follow the steps in [Primary-Secondary Switchover Procedure in Disaster Scenarios](#disaster-switchover) for drills. After the drill is complete, you need to perform the following cleanup operations in the disaster recovery environment:

- Delete the `sonarqube` instance in the disaster recovery environment
- Switch the PostgreSQL cluster to secondary state

:::

### Recovery Objectives

#### Recovery Point Objective (RPO)

The RPO represents the maximum acceptable data loss during a disaster recovery scenario. In this SonarQube disaster recovery solution:

- **Database Layer**: Near-zero data loss due to PostgreSQL hot standby streaming replication
- **Overall RPO**: The overall RPO is near-zero, depending on the delay of PostgreSQL streaming replication

#### Recovery Time Objective (RTO)

The RTO represents the maximum acceptable downtime during disaster recovery. This solution provides:

- **Manual Components**: SonarQube service activation and external routing updates require manual intervention
- **Typical RTO**: 5-20 minutes for complete service restoration

**RTO Breakdown:**

- Database failover: 1-2 minutes (manual)
- SonarQube service activation: 3-15 minutes (manual)
- External routing updates: 1-3 minutes (manual, depends on DNS propagation)

## Disaster Switchover

1. **Confirm Primary SonarQube Failure**: Confirm that all primary SonarQube components are in non-working state, otherwise stop all primary SonarQube components first.

2. **Promote Secondary PostgreSQL**: Promote Secondary PostgreSQL to Primary PostgreSQL. Refer to the switchover procedure in `PostgreSQL Hot Standby Cluster Configuration Guide`.

3. **Deploy Secondary SonarQube**: Restore the backed up `sonarqube.yaml` to the disaster recovery environment with the same namespace name. SonarQube will automatically start using the disaster recovery data.

4. **Verify SonarQube Components**: Verify that all SonarQube components are running and healthy. Test SonarQube functionality (project access, code analysis, user authentication) to verify that SonarQube is working properly.

5. **Switch Access Address**: Switch external access addresses to Secondary SonarQube.

## Building SonarQube Disaster Recovery Solution with Other PostgreSQL

The operational steps are similar to building a SonarQube disaster recovery solution with `Alauda support for PostgreSQL`. Simply replace PostgreSQL with other PostgreSQL solutions that support disaster recovery.

:::warning
Ensure that the selected PostgreSQL solution supports disaster recovery capabilities, and perform sufficient disaster recovery drills before using in production environments.
:::

