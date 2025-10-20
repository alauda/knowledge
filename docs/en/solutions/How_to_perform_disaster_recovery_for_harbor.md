---
products: 
  - Alauda DevOps
kind:
  - Solution
ProductsVersion:
   - 4.1.0
---

# How to Perform Disaster Recovery for Harbor

## Issue

This solution describes how to build a Harbor disaster recovery solution based on Object Storage and PostgreSQL disaster recovery capabilities. The solution primarily focuses on data disaster recovery processing, and users need to implement their own Harbor access address switching mechanism.

## Environment

Harbor CE Operator: >=v2.12.4

## Terminology

| Term                    | Description                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| **Primary Harbor**      | The active Harbor instance that serves normal business operations and user requests. This instance is fully operational with all components running. |
| **Secondary Harbor**    | The standby Harbor instance deployed in a different cluster/region with zero replicas. It remains dormant until activated during disaster recovery scenarios. |
| **Primary PostgreSQL**  | The active PostgreSQL database cluster that handles all data transactions and serves as the source for data replication to the secondary database. |
| **Secondary PostgreSQL**| The hot standby PostgreSQL database that receives real-time data replication from the primary database. It can be promoted to primary role during failover. |
| **Primary Object Storage**| The active S3-compatible object storage system that stores all Harbor registry data and serves as the source for storage replication. |
| **Secondary Object Storage**| The synchronized backup object storage system that receives data replication from the primary storage. It ensures data availability during disaster recovery. |
| **Recovery Point Objective (RPO)** | The maximum acceptable amount of data loss measured in time (e.g., 5 minutes, 1 hour). It defines how much data can be lost during a disaster before it becomes unacceptable. |
| **Recovery Time Objective (RTO)** | The maximum acceptable downtime measured in time (e.g., 15 minutes, 2 hours). It defines how quickly the system must be restored after a disaster. |
| **Failover**            | The process of switching from the primary system to the secondary system when the primary system becomes unavailable or fails. |
| **Data Synchronization**| The continuous process of replicating data from primary systems to secondary systems to maintain consistency and enable disaster recovery. |
| **Cold Standby**        | A standby system that is not continuously synchronized with the primary system and requires manual activation with potential data loss during disaster recovery. |

## Architecture

![harbor](/harbor-disaster-recovery.drawio.svg)

### Architecture Overview

The Harbor disaster recovery solution implements a **cold-standby architecture** for Harbor services with **hot-standby database replication**. This hybrid approach provides disaster recovery capabilities through real-time database synchronization and manual Harbor service failover procedures. The architecture consists of two Harbor instances deployed across different clusters or regions, with the secondary Harbor instance remaining dormant until activated during disaster scenarios, while the database layer maintains continuous synchronization.

#### Core Components

- **Primary Harbor**: Active instance serving normal business operations and user requests
- **Secondary Harbor**: Standby instance with zero replicas, ready for failover scenarios
- **Primary PostgreSQL**: Active database handling all data transactions
- **Secondary PostgreSQL**: Hot standby database with real-time data replication
- **Primary Object Storage**: Active S3-compatible storage for registry data
- **Secondary Object Storage**: Synchronized backup storage with data replication

#### Data Synchronization Strategy

The solution leverages two independent data synchronization mechanisms:

1. **Database Layer**: PostgreSQL streaming replication ensures real-time transaction log synchronization between primary and secondary databases
2. **Storage Layer**: Object storage replication maintains data consistency across primary and secondary storage systems

#### Disaster Recovery Configuration

1. **Deploy Primary Harbor**: Configure the primary instance to connect to the primary PostgreSQL database and use primary object storage as the registry backend
2. **Deploy Secondary Harbor**: Configure the secondary instance to connect to the secondary PostgreSQL database and use secondary object storage as the registry backend
3. **Initialize Standby State**: Set replica count of all secondary Harbor components to 0 to prevent unnecessary background operations and resource consumption

#### Failover Procedure

When a disaster occurs, the following steps ensure transition to the secondary environment:

1. **Verify Primary Failure**: Confirm that all primary Harbor components are non-functional
2. **Promote Database**: Elevate secondary PostgreSQL to primary role using database failover procedures (no data loss due to hot standby)
3. **Promote Storage**: Activate secondary object storage as the primary storage system
4. **Activate Harbor**: Scale up secondary Harbor components by setting replica count greater than 0
5. **Update Routing**: Switch external access addresses to point to the secondary Harbor instance

## Harbor Disaster Recovery Setup Procedure with `Alauda Build of Rook-Ceph` and `Alauda support for PostgreSQL`

### Prerequisites

1. Prepare a primary cluster and a disaster recovery cluster (or a cluster containing different regions) in advance.
2. Complete the deployment of `Alauda Build of Rook-Ceph` and `Alauda support for PostgreSQL`.
3. Refer to `Alauda Build of Rook-Ceph`, `Alauda support for PostgreSQL` and [Harbor Instance Deployment guide](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html) to plan the system resources needed in advance.

### Building PostgreSQL Disaster Recovery Cluster with `Alauda support for PostgreSQL`

Refer to `PostgreSQL Hot Standby Cluster Configuration Guide` to build a disaster recovery cluster using `Alauda support for PostgreSQL`.

Ensure that Primary PostgreSQL and Secondary PostgreSQL are in different clusters (or different regions).

You can search for `PostgreSQL Hot Standby Cluster Configuration Guide` on [Alauda Knowledge](https://cloud.alauda.io/knowledges#/) to obtain it.

:::warning

`PostgreSQL Hot Standby Cluster Configuration Guide` is a document that describes how to build a disaster recovery cluster using `Alauda support for PostgreSQL`. Please ensure compatibility with the appropriate ACP version when using this configuration.

:::

### Building Object Storage Disaster Recovery Cluster with `Alauda Build of Rook-Ceph`

Build a disaster recovery cluster using `Alauda Build of Rook-Ceph`. Refer to [Object Storage Disaster Recovery](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html) to build a disaster recovery cluster.

You need to create a CephObjectStoreUser in advance to obtain the access credentials for Object Storage, and prepare a Harbor registry bucket on Primary Object Storage:

1. Create a CephObjectStoreUser on Primary Object Storage to obtain access credentials: [Create CephObjectStoreUser](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/create_object_user.html).

   :::info
   You only need to create the CephObjectStoreUser on the Primary Object Storage. The user information will be automatically synchronized to the Secondary Object Storage through the disaster recovery replication mechanism.
   :::

2. This `PRIMARY_OBJECT_STORAGE_ADDRESS` is the access address of the Object Storage, you can get it from the step [Configure External Access for Primary Zone](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#configure-external-access-for-primary-zone) of `Object Storage Disaster Recovery`.

3. Create a Harbor registry bucket on Primary Object Storage using mc, in this example, the bucket name is `harbor-registry`.

    ```bash
    $ mc alias set primary-s3 <PRIMARY_OBJECT_STORAGE_ADDRESS> <PRIMARY_OBJECT_STORAGE_ACCESS_KEY> <PRIMARY_OBJECT_STORAGE_SECRET_KEY>
    Added `primary-s3` successfully.
    $ mc alias list
    primary-s3  
    URL       : <PRIMARY_OBJECT_STORAGE_ADDRESS> 
    AccessKey : <PRIMARY_OBJECT_STORAGE_ACCESS_KEY>
    SecretKey : <PRIMARY_OBJECT_STORAGE_SECRET_KEY>
    API       : s3v4
    Path      : auto
    Src       : /home/demo/.mc/config.json
    $ mc mb primary-s3/harbor-registry
    Bucket created successfully `primary-s3/harbor-registry`
    $ mc ls primary-s3/harbor-registry
    ```

### Set Up Primary Harbor

Deploy the Primary Harbor instance by following the [Harbor Instance Deployment](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html) guide. Configure it to connect to the Primary PostgreSQL database and use the Primary Object Storage as the [Registry storage backend](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html#storage-yaml-snippets).

Configuration example:

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Harbor
metadata:
  name: dr-harbor
spec:
  externalURL: http://dr-harbor.example.com
  helmValues:
    core:
      replicas: 1
      resources:
        limits:
          cpu: 400m
          memory: 512Mi
        requests:
          cpu: 200m
          memory: 256Mi
    database:
      external:
        coreDatabase: harbor
        existingSecret: primary-pg
        existingSecretKey: password
        host: acid-primary-pg.harbor.svc
        port: 5432
        sslmode: require
        username: postgres
      type: external
    existingSecretAdminPassword: harbor-account
    existingSecretAdminPasswordKey: password
    expose:
      ingress:
        hosts:
          core: dr-harbor.example.com
      tls:
        enabled: false
      type: ingress
    jobservice:
      replicas: 1
      resources:
        limits:
          cpu: 400m
          memory: 512Mi
        requests:
          cpu: 200m
          memory: 256Mi
    persistence:
      enabled: true
      imageChartStorage:
        disableredirect: true
        s3:
          existingSecret: object-storage-secret
          bucket: harbor-registry
          regionendpoint: <PRIMARY_OBJECT_STORAGE_ADDRESS>
          v4auth: true
        type: s3
      persistentVolumeClaim:
        jobservice:
          jobLog:
            accessMode: ReadWriteMany
            size: 10Gi
            storageClass: nfs
        trivy:
          accessMode: ReadWriteMany
          size: 10Gi
          storageClass: nfs
    portal:
      replicas: 1
      resources:
        limits:
          cpu: 400m
          memory: 512Mi
        requests:
          cpu: 200m
          memory: 256Mi
    redis:
      external:
        addr: primary-redis-0.primary-redis-hl.harbor.svc:26379
        existingSecret: redis-redis-s3-default-credential
        existingSecretKey: password
        sentinelMasterSet: mymaster
      type: external
    registry:
      controller:
        resources:
          limits:
            cpu: 200m
            memory: 410Mi
          requests:
            cpu: 100m
            memory: 200Mi
      registry:
        resources:
          limits:
            cpu: 600m
            memory: 1638Mi
          requests:
            cpu: 300m
            memory: 419Mi
      replicas: 1
    trivy:
      offlineScan: true
      replicas: 1
      resources:
        limits:
          cpu: 800m
          memory: 2Gi
        requests:
          cpu: 400m
          memory: 200Mi
      skipUpdate: true
  version: 2.12.4
```

### Set Up Secondary Harbor

Deploy the Secondary Harbor instance by following the [Harbor Instance Deployment](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html) guide. Configure it to connect to the Secondary PostgreSQL database and use the Secondary Object Storage as the [Registry storage backend](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html#storage-yaml-snippets).

:::info

The instance names for both Primary Harbor and Secondary Harbor must be identical.
:::

Set the replica count of all Secondary Harbor instances to 0 to prevent Secondary Harbor from performing unnecessary background operations.

Configuration YAML snippet example:

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Harbor
metadata:
  name: dr-harbor
spec:
  helmValues:
    core:
      replicas: 0
    portal:
      replicas: 0
    jobservice:
      replicas: 0
    registry:
      replicas: 0
    trivy:
      replicas: 0
```

### Primary-Standby Switchover Procedure in Disaster Scenarios

1. First confirm that all Primary Harbor components are not in working state, otherwise stop all Primary Harbor components first.
2. Promote Secondary PostgreSQL to Primary PostgreSQL. Refer to `PostgreSQL Hot Standby Cluster Configuration Guide`, the switchover procedure.
3. Promote Secondary Object Storage to Primary Object Storage. Refer to [Alauda Build of Rook-Ceph Failover](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#procedures-1), the switchover procedure.

4. Scale up all Secondary Harbor components by modifying the replica count to greater than 0:

    Configuration YAML snippet example:

    ```yaml
    apiVersion: operator.alaudadevops.io/v1alpha1
    kind: Harbor
    metadata:
      name: dr-harbor
    spec:
      helmValues:
        core:
          replicas: 1
        portal:
          replicas: 1
        jobservice:
          replicas: 1
        registry:
          replicas: 1
        trivy:
          replicas: 1
    ```

5. Test image push and pull to verify that Harbor is working properly.
6. Switch external access addresses to Secondary Harbor.

### Disaster Recovery Data Check

Check the synchronization status of Object Storage and PostgreSQL to ensure that the disaster recovery is successful.

- Check Ceph Object Storage Synchronization Status: [Object Storage Disaster Recovery](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#check-ceph-object-storage-synchronization-status)
- Check PostgreSQL Synchronization Status: Refer to `PostgreSQL Hot Standby Cluster Configuration Guide` for status check section.

### Recovery Objectives

#### Recovery Point Objective (RPO)

The RPO represents the maximum acceptable data loss during a disaster recovery scenario. In this Harbor disaster recovery solution:

- **Database Layer**: Near-zero data loss due to PostgreSQL hot standby with streaming replication
- **Storage Layer**: Near-zero data loss due to synchronous object storage replication
- **Overall RPO**: Near-zero data loss due to synchronous replication of both database and object storage layers

**Factors affecting RPO:**

- Network latency between primary and secondary clusters
- Object storage synchronous replication and consistency model
- Database replication lag and commit acknowledgment settings

#### Recovery Time Objective (RTO)

The RTO represents the maximum acceptable downtime during disaster recovery. This solution provides:

- **Manual Components**: Harbor service activation and external routing updates require manual intervention
- **Typical RTO**: 5-15 minutes for complete service restoration

**RTO Breakdown:**

- Database failover: 1-2 minutes (manual)
- Storage failover: 1-2 minutes (manual)
- Harbor service activation: 2-5 minutes (manual, cold standby requires startup time)
- External routing updates: 1-5 minutes (manual, depends on DNS propagation)

## Building Harbor Disaster Recovery Solution with Other Object Storage and PostgreSQL

The operational steps are similar to building a Harbor disaster recovery solution with `Alauda Build of Rook-Ceph` and `Alauda support for PostgreSQL`. Simply replace Object Storage and PostgreSQL with other object storage and PostgreSQL solutions.

Ensure that the Object Storage and PostgreSQL solutions support disaster recovery capabilities.
