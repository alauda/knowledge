---
kind:
   - Solution
products:
  - Alauda DevOps
ProductsVersion:
   - 4.x
id: TODO
---

# How to Perform Disaster Recovery for GitLab

## Issue

This solution describes how to build a GitLab disaster recovery solution based on Ceph and PostgreSQL disaster recovery capabilities. The solution implements a **hot data, cold compute** architecture, where data is continuously synchronized to the secondary cluster through Ceph and PostgreSQL disaster recovery mechanisms. When the primary cluster fails, a secondary GitLab instance is deployed, and the secondary GitLab will quickly start using the disaster recovery data and provide services. The solution primarily focuses on data disaster recovery processing, and users need to implement their own GitLab access address switching mechanism.

## Environment

GitLab CE Operator: >=v17.11.1

## Terminology

| Term                    | Description                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| **Primary GitLab**      | The active GitLab instance that serves normal business operations and user requests. This instance is fully operational with all components running. |
| **Secondary GitLab**    | The standby GitLab instance planned to be deployed in a different cluster/region, remaining dormant until activated during disaster recovery scenarios. |
| **Primary PostgreSQL**  | The active PostgreSQL database cluster that handles all data transactions and serves as the source for data replication to the secondary database. |
| **Secondary PostgreSQL**| The hot standby PostgreSQL database that receives real-time data replication from the primary database. It can be promoted to primary role during failover. |
| **Primary Object Storage**| The active S3-compatible object storage system that stores all GitLab attachment data and serves as the source for object storage replication. |
| **Secondary Object Storage**| The synchronized backup object storage system that receives data replication from the primary storage. It ensures data availability during disaster recovery. |
| **Gitaly**              | Responsible for Git repository storage. |
| **Rails Secret**| The encryption key used by the GitLab Rails application to encrypt sensitive data. Primary GitLab and Secondary GitLab instances **must use the same key**. |
| **Recovery Point Objective (RPO)** | The maximum acceptable amount of data loss measured in time (e.g., 5 minutes, 1 hour). It defines how much data can be lost during a disaster before it becomes unacceptable. |
| **Recovery Time Objective (RTO)** | The maximum acceptable downtime measured in time (e.g., 15 minutes, 2 hours). It defines how quickly the system must be restored after a disaster. |
| **Failover**            | The process of switching from the primary system to the secondary system when the primary system becomes unavailable or fails. |
| **Data Synchronization**| The continuous process of replicating data from primary systems to secondary systems to maintain consistency and enable disaster recovery. |
| **Hot Data, Cold Compute**| An architectural pattern where data is continuously synchronized (hot), while compute resources remain inactive (cold) until failover. |

## Architecture

![gitlab dr](../../public/gitlab-disaster-recovery.drawio.svg)

The GitLab disaster recovery solution implements a **hot data, cold compute architecture** for GitLab services. This architecture provides disaster recovery capabilities through near-real-time data synchronization and manual GitLab service failover procedures. The architecture consists of two GitLab instances deployed across different clusters or regions, with the secondary GitLab instance not deployed in advance until activated during disaster scenarios, while the database and storage layers maintain continuous synchronization.

### Core Components

- **Primary GitLab**: Active instance serving normal business operations and user requests, with all components running (webservice, sidekiq, gitlab-shell, gitaly)
- **Secondary GitLab**: Standby instance with zero replicas for all components, ready for failover scenarios
- **Primary PostgreSQL**: Active database handling all data transactions, including GitLab application data and Praefect metadata
- **Secondary PostgreSQL**: Hot standby database with real-time data replication from the primary database
- **Primary Object Storage**: Active S3-compatible storage for GitLab attachments and uploads
- **Secondary Object Storage**: Synchronized backup storage with data replication from the primary storage
- **Primary Gitaly Storage**: Block storage on the primary cluster for Git repository data
- **Secondary Gitaly Storage**: Block storage synchronized through Ceph disaster recovery mechanisms

### Data Synchronization Strategy

The solution leverages three independent data synchronization mechanisms:

1. **Database Layer**: PostgreSQL streaming replication ensures real-time transaction log synchronization between primary and secondary databases, including GitLab application database and Praefect metadata database
2. **Gitaly Storage Layer**: Block storage replication through Ceph disaster recovery mechanisms ensures Git repository data synchronization to the secondary cluster
3. **Attachment Storage Layer**: Object storage replication maintains GitLab attachment data consistency between primary and secondary storage systems

::: tip
The following data is stored in attachment storage. If you assess that this data is not important, you can choose not to perform disaster recovery.

| Object Type           | Function Description | Default Bucket Name |
|--------------------|----------|--------------------|
| uploads            | User uploaded files (avatars, attachments, etc.) | gitlab-uploads |
| lfs                | Git LFS large file objects | gitlab-lfs |
| artifacts          | CI/CD Job artifacts | gitlab-artifacts |
| packages           | Package management data (e.g., PyPI, Maven, NuGet) | gitlab-packages |
| external_mr_diffs     | Merge Request diff data | gitlab-mr-diffs |
| terraform_state    | Terraform state files | gitlab-terraform-state |
| ci_secure_files    | CI secure files (sensitive certificates, keys, etc.) | gitlab-ci-secure-files |
| dependency_proxy   | Dependency proxy cache | gitlab-dependency-proxy |
| pages              | GitLab Pages content | gitlab-pages |

:::

### Disaster Recovery Configuration

1. **Deploy Primary GitLab**: Configure the primary instance in high availability mode, configure domain access, connect to the primary PostgreSQL database (GitLab and Praefect databases), use primary object storage for attachments, and configure Gitaly to use block storage
2. **Prepare Secondary GitLab Deployment Environment**: Configure the PV, PVC, and Secret resources required for the secondary instance to enable rapid recovery when disasters occur

### Failover Procedure

When a disaster occurs, the following steps ensure transition to the secondary environment:

1. **Verify Primary Failure**: Confirm that all primary GitLab components are unavailable
2. **Promote Database**: Use database failover procedures to promote secondary PostgreSQL to primary
3. **Promote Object Storage**: Activate secondary object storage as primary
4. **Promote Ceph RBD**: Promote secondary Ceph RBD to primary
5. **Restore PVCs Used by Gitaly**: According to the Ceph block storage disaster recovery documentation, restore the PVCs used by Gitaly in the secondary cluster
6. **Deploy Secondary GitLab**: Quickly deploy the GitLab instance in the secondary cluster using disaster recovery data
7. **Update Routing**: Switch external access addresses to point to the secondary GitLab instance

## GitLab Disaster Recovery Configuration

::: warning

To simplify the configuration process and reduce configuration difficulty, it is recommended to use consistent information in both primary and secondary environments, including:

- Consistent database instance names and passwords
- Consistent Redis instance names and passwords
- Consistent Ceph storage pool names and storage class names
- Consistent GitLab instance names
- Consistent namespace names

:::

### Prerequisites

1. Prepare a primary cluster and a disaster recovery cluster (or a cluster containing different regions) in advance.
2. Complete the deployment of `Alauda support for PostgreSQL` disaster recovery configuration.
3. Complete the deployment of `Alauda Build of Rook-Ceph` object storage disaster recovery configuration ([optional if conditions are met](#data-synchronization-strategy)).
4. Complete the deployment of `Alauda Build of Rook-Ceph` block storage disaster recovery configuration.

:::warning
For `Alauda Build of Rook-Ceph` block storage disaster recovery configuration, you need to set a reasonable [synchronization interval](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass), which directly affects the RPO metric of disaster recovery.
:::

### Building PostgreSQL Disaster Recovery Cluster with `Alauda support for PostgreSQL`

Refer to `PostgreSQL Hot Standby Cluster Configuration Guide` to build a disaster recovery cluster using `Alauda support for PostgreSQL`.

Ensure that Primary PostgreSQL and Secondary PostgreSQL are in different clusters (or different regions).

You can search for `PostgreSQL Hot Standby Cluster Configuration Guide` on [Alauda Knowledge](https://cloud.alauda.io/knowledges#/) to obtain it.

:::warning

`PostgreSQL Hot Standby Cluster Configuration Guide` is a document that describes how to build a disaster recovery cluster using `Alauda support for PostgreSQL`. Please ensure compatibility with the appropriate ACP version when using this configuration.

:::

### Building Block Storage Disaster Recovery Cluster with `Alauda Build of Rook-Ceph`

Build a block storage disaster recovery cluster using `Alauda Build of Rook-Ceph`. Refer to [Block Storage Disaster Recovery](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html) documentation to build a disaster recovery cluster.

### Building Object Storage Disaster Recovery Cluster with `Alauda Build of Rook-Ceph`

Build an object storage disaster recovery cluster using `Alauda Build of Rook-Ceph`. Refer to [Object Storage Disaster Recovery](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html) documentation to build an object storage disaster recovery cluster.

You need to create a CephObjectStoreUser in advance to obtain the access credentials for Object Storage, and prepare a GitLab object storage bucket on Primary Object Storage:

1. Create a CephObjectStoreUser on Primary Object Storage to obtain access credentials: [Create CephObjectStoreUser](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/create_object_user.html).

   :::info
   You only need to create the CephObjectStoreUser on the Primary Object Storage. The user information will be automatically synchronized to the Secondary Object Storage through the disaster recovery replication mechanism.
   :::

2. Obtain the object storage access address `PRIMARY_OBJECT_STORAGE_ADDRESS`. You can get it from the step [Configure External Access for Primary Zone](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#configure-external-access-for-primary-zone) of `Object Storage Disaster Recovery`.

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
    ```

3. Use mc to create GitLab object storage buckets on Primary Object Storage. In this example, two buckets `gitlab-uploads` and `gitlab-lfs` are created.

    ```bash
    # Create
    mc mb primary-s3/gitlab-uploads
    mc mb primary-s3/gitlab-lfs

    # Check
    mc ls primary-s3/gitlab-uploads
    mc ls primary-s3/gitlab-lfs
    ```

    :::info
    Depending on the GitLab features used, you may also need to use [other buckets](#data-synchronization-strategy), which can be created as needed.
    :::

### Set Up Primary GitLab

Deploy the Primary GitLab instance by following the [GitLab Instance Deployment](https://docs.alauda.io/alauda-build-of-gitlab/17.11/en/install/03_gitlab_deploy.html#deploying-from-the-gitlab-high-availability-template) guide. Configure it in high availability mode, configure domain access, connect to the Primary PostgreSQL database (GitLab application database and Praefect database), use Primary Object Storage for attachments, and configure Gitaly to use Primary block storage.

Configuration example (only includes configuration items related to disaster recovery, see product documentation for complete configuration items):

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: GitlabOfficial
metadata:
  name: <GITLAB_NAME>
  namespace: <GITLAB_NAMESPACE>
spec:
  externalURL: http://gitlab-ha.example.com # GitLab access domain
  helmValues:
    gitlab:
      gitaly:
        persistence: # Configure gitaly storage, use ceph RBD storage class, high availability mode will automatically create 3 replicas
          enabled: true
          size: 5Gi
          storageClass: ceph-rdb # Storage class name, specify as the storage class configured for disaster recovery
      webservice:
        ingress:
          enabled: true
    global:
      appConfig:
        object_store:
          connection: # Configure object storage, connect to primary object storage
            secret: gitlab-object-storage
            key: connection
          enabled: true
      praefect: # Configure praefect database, connect to primary PostgreSQL database
        dbSecret:
          key: password
          secret: gitlab-pg-prefact
        enabled: true
        psql:
          dbName: gitlab_prefact
          host: acid-gitlab.test.svc
          port: 5432
          sslMode: require
          user: postgres
        virtualStorages:
          - gitalyReplicas: 3
            maxUnavailable: 1
            name: default
      psql: # Configure application database, connect to primary PostgreSQL database
        database: gitlab
        host: acid-gitlab.test.svc
        password:
          key: password
          secret: gitlab-pg
        port: 5432
        username: postgres
```

After deploying Primary GitLab, you need to configure RBD Mirror for the PVCs used by the Gitaly component. After configuration, PVC data will be periodically synchronized to the secondary Ceph cluster. For specific parameter configuration, refer to [Ceph RBD Mirror](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#enable-mirror-for-pvc).

```bash
cat << EOF | kubectl apply -f -
apiVersion: replication.storage.openshift.io/v1alpha1
kind: VolumeReplication
metadata:
  name: <GITALY_PVC_NAME>
  namespace: <GITLAB_NAMESPACE>
spec:
  autoResync: true # Auto resync
  volumeReplicationClass: rbd-volumereplicationclass
  replicationState: primary # Mark as primary cluster
  dataSource:
    apiGroup: ""
    kind: PersistentVolumeClaim
    name: <GITALY_PVC_NAME>
EOF
```

Check the Ceph RBD Mirror status. You can see that all three PVCs of Gitaly have been configured with Ceph RBD Mirror.

```bash
❯ kubectl -n $GITLAB_NAMESPACE get volumereplication
NAME                                      AGE   VOLUMEREPLICATIONCLASS       PVCNAME                                   DESIREDSTATE   CURRENTSTATE
repo-data-dr-gitlab-ha-gitaly-default-0   15s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-0   primary        Primary
repo-data-dr-gitlab-ha-gitaly-default-1   15s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-1   primary        Primary
repo-data-dr-gitlab-ha-gitaly-default-2   14s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-2   primary        Primary
```

Check the Ceph RBD Mirror status from the Ceph side. `CEPH_BLOCK_POOL` is the name of the Ceph RBD storage pool. The `SCHEDULE` column indicates the synchronization frequency (the example below shows synchronization every 1 minute).

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror snapshot schedule ls --pool $CEPH_BLOCK_POOL --recursive
POOL     NAMESPACE  IMAGE                                         SCHEDULE
myblock             csi-vol-135ec569-0a3a-49c1-a0b1-46d669510200  every 1m
myblock             csi-vol-459e6f28-a158-4ae9-b5da-163448c35119  every 1m
myblock             csi-vol-7f13040d-d543-40ed-b416-3ecf639cf4c9  every 1m
```

Check the Ceph RBD Mirror status. A state of `up+stopped` (primary cluster normal) and peer_sites.state of `up+replaying` (secondary cluster normal) indicates normal synchronization.

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror image status $CEPH_BLOCK_POOL/$GITALY_BLOCK_IMAGE_NAME
csi-vol-459e6f28-a158-4ae9-b5da-163448c35119:
  global_id:   98bbf3bf-7c61-42b4-810b-cb2a7cd6d6b1
  state:       up+stopped
  description: local image is primary
  service:     a on 192.168.129.233
  last_update: 2025-11-19 01:42:07
  peer_sites:
    name: ecf558fa-1e8a-43f1-bf6b-1478e73f272e
    state: up+replaying
    description: replaying, {"bytes_per_second":0.0,"bytes_per_snapshot":5742592.0,"last_snapshot_bytes":5742592,"last_snapshot_sync_seconds":0,"local_snapshot_timestamp":1763516344,"remote_snapshot_timestamp":1763516344,"replay_state":"idle"}
    last_update: 2025-11-19 01:42:27
  snapshots:
    75 .mirror.primary.98bbf3bf-7c61-42b4-810b-cb2a7cd6d6b1.3d3402a5-f298-4048-8c50-84979949355d (peer_uuids:[66d8fb19-c610-438c-ae73-42a95ea4e86e])
```

### Set Up Secondary GitLab

:::warning
When Ceph RBD is in secondary state, the synchronized storage blocks cannot be mounted, so GitLab in the secondary cluster cannot be deployed successfully.

If you need to verify whether GitLab in the secondary cluster can be deployed successfully, you can temporarily promote the Ceph RBD of the secondary cluster to primary, and after testing is complete, set it back to secondary state. At the same time, you need to delete all gitlabofficial, PV, and PVC resources created during testing.
:::

1. Backup the Secrets used by Primary GitLab
2. Backup the PVC and PV resource YAMLs of the Primary cluster GitLab Gitaly component (note: high availability mode will have at least 3 PVC and PV resources)
3. Backup the Primary cluster GitLab gitlabofficial resource YAML
4. Deploy the Redis instance used by Secondary GitLab

#### Backup Secrets Used by Primary GitLab

Obtain the PostgreSQL Secret YAML used by Primary GitLab and create the Secret in the secondary cluster with the same namespace name.

```bash
export GITLAB_NAMESPACE=<ns-of-gitlab-instance>
export GITLAB_NAME=<name-of-gitlab-instance>
```

```bash
# PostgreSQL Secret
PG_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.psql.password.secret}')
[[ -n "$PG_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$PG_SECRET" -o yaml > pg-secret.yaml

# Praefect PostgreSQL Secret
PRAEFECT_PG_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.praefect.dbSecret.secret}')
[[ -n "$PRAEFECT_PG_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$PRAEFECT_PG_SECRET" -o yaml > praefect-secret.yaml

# Rails Secret
RAILS_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.railsSecrets.secret}' || echo "${GITLAB_NAME}-rails-secret")
[[ -z "$RAILS_SECRET" ]] && export RAILS_SECRET="${GITLAB_NAME}-rails-secret" # use default secret name if not found
[[ -n "$RAILS_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$RAILS_SECRET" -o yaml > rails-secret.yaml

# Object Storage Secret
OBJECT_STORAGE_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.appConfig.object_store.connection.secret}')
[[ -n "$OBJECT_STORAGE_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$OBJECT_STORAGE_SECRET" -o yaml > object-storage-secret.yaml

# Root Password Secret
ROOT_USER_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.initialRootPassword.secret}')
[[ -n "$ROOT_USER_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$ROOT_USER_SECRET" -o yaml > root-user-secret.yaml
```

Make the following modifications to the backed up files:

- pg-secret.yaml: Change the `host` and `password` fields to the PostgreSQL connection address and password of the secondary cluster
- praefect-secret.yaml: Change the `host` and `password` fields to the Praefect PostgreSQL connection address and password of the secondary cluster
- object-storage-secret.yaml: Change the `endpoint` field in `connection` to the object storage connection address of the secondary cluster

Create the backed up YAML files in the disaster recovery environment with the same namespace name.

#### Backup PVC and PV Resources of Primary GitLab Gitaly Component

:::tip
PV resources contain volume attribute information, which is critical information for disaster recovery restoration and needs to be backed up properly.

```bash
    volumeAttributes:
      clusterID: rook-ceph
      imageFeatures: layering
      imageFormat: "2"
      imageName: csi-vol-459e6f28-a158-4ae9-b5da-163448c35119
      journalPool: myblock
      pool: myblock
      storage.kubernetes.io/csiProvisionerIdentity: 1763446982673-7963-rook-ceph.rbd.csi.ceph.com
```

:::

Execute the following command to backup the PVC and PV resources of the Primary GitLab Gitaly component to the current directory (if other PVCs are used, they need to be backed up manually):

```bash
kubectl -n "$GITLAB_NAMESPACE" \
  get pvc -l app=gitaly,release="$GITLAB_NAME" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
| while read -r pvc; do

  echo "=>  Exporting PVC $pvc"

  # Export PVC
  kubectl -n "$GITLAB_NAMESPACE" get pvc "$pvc" -o yaml > "pvc-${pvc}.yaml"

  # Get PV
  PV=$(kubectl -n "$GITLAB_NAMESPACE" get pvc "$pvc" -o jsonpath='{.spec.volumeName}')

  if [[ -n "$PV" ]]; then
    echo "   ↳ Exporting PV $PV"
    kubectl get pv "$PV" -o yaml > "pv-${PV}.yaml"
  fi

  echo ""
done
```

Modify the three backed up PV files and delete all `spec.claimRef` fields in the yaml.

Create the backed up PVC and PV YAML files directly in the disaster recovery environment with the same namespace name.

#### Backup Primary GitLab Instance YAML

```bash
kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -oyaml > gitlabofficial.yaml
```

Modify the information in `gitlabofficial.yaml` according to the actual situation of the disaster recovery environment, including PostgreSQL connection address, Redis connection address, etc.

:::warning
The `GitlabOfficial` resource **does not need** to be created in the disaster recovery environment immediately. It only needs to be created in the secondary cluster when a disaster occurs and disaster recovery switchover is performed.
:::

:::warning
If you need to perform disaster recovery drills, you can follow the steps in [Primary-Secondary Switchover Procedure in Disaster Scenarios](#primary-secondary-switchover-procedure-in-disaster-scenarios) for drills. After the drill is complete, you need to perform the following cleanup operations in the disaster recovery environment:

- Delete the `GitlabOfficial` instance in the disaster recovery environment
- Delete the created PVCs and PVs
- Switch the PostgreSQL cluster to secondary state
- Switch the Ceph object storage to secondary state
- Switch the Ceph RBD to secondary state

:::

#### Deploy Redis Instance Used by Secondary GitLab

Refer to the Redis instance configuration of the primary cluster, and deploy a Redis instance in the disaster recovery environment with the same namespace name using the same instance name and password.

### Recovery Objectives

#### Recovery Point Objective (RPO)

The RPO represents the maximum acceptable data loss during a disaster recovery scenario. In this GitLab disaster recovery solution:

- **Database Layer**: Near-zero data loss due to PostgreSQL hot standby streaming replication (applicable to GitLab application database and Praefect metadata database)
- **Attachment Storage Layer**: Near-zero data loss due to object storage streaming replication used by GitLab attachment storage
- **Gitaly Storage Layer**: Due to Ceph RBD block storage replication for Git repository data, synchronized through scheduled snapshots, data loss depends on the synchronization interval, which can be [configured](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)
- **Overall RPO**: The overall RPO depends on the synchronization interval of Ceph RBD block storage replication.

#### Recovery Time Objective (RTO)

The RTO represents the maximum acceptable downtime during disaster recovery. This solution provides:

- **Manual Components**: GitLab service activation and external routing updates require manual intervention
- **Typical RTO**: 6-16 minutes for complete service restoration

**RTO Breakdown:**

- Database failover: 1-2 minutes (manual)
- Object storage failover: 1-2 minutes (manual)
- Ceph RBD failover: 1-2 minutes (manual)
- GitLab service activation: 2-5 minutes (manual)
- External routing updates: 1-5 minutes (manual, depends on DNS propagation)

## Primary-Secondary Switchover Procedure in Disaster Scenarios

1. **Confirm Primary GitLab Failure**: Confirm that all primary GitLab components are in non-working state, otherwise stop all primary GitLab components first.

2. **Promote Secondary PostgreSQL**: Promote Secondary PostgreSQL to Primary PostgreSQL. Refer to the switchover procedure in `PostgreSQL Hot Standby Cluster Configuration Guide`.

3. **Promote Secondary Object Storage**: Promote Secondary Object Storage to Primary Object Storage. Refer to the switchover procedure in [Alauda Build of Rook-Ceph Failover](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#procedures-1).

4. **Promote Secondary Ceph RBD**: Promote Secondary Ceph RBD to Primary Ceph RBD. Refer to the switchover procedure in [Alauda Build of Rook-Ceph Failover](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#procedures-1).

5. **Restore PVC and PV Resources**: Restore the backed up PVC and PV resources to the disaster recovery environment with the same namespace name, and check whether the PVC status in the secondary cluster is `Bound`:

   ```bash
   ❯ kubectl -n $GITLAB_NAMESPACE get pvc,pv
   NAME                                                            STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
   persistentvolumeclaim/repo-data-dr-gitlab-ha-gitaly-default-0   Bound    pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            ceph-rdb       <unset>                 45s
   persistentvolumeclaim/repo-data-dr-gitlab-ha-gitaly-default-1   Bound    pvc-2995a8a7-648c-4e99-a3d3-c73a483a601b   5Gi        RWO            ceph-rdb       <unset>                 30s
   persistentvolumeclaim/repo-data-dr-gitlab-ha-gitaly-default-2   Bound    pvc-e4a94d84-d5e2-419f-bbbd-285fa88b6b5e   5Gi        RWO            ceph-rdb       <unset>                 19s

   NAME                                                        CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                                             STORAGECLASS   VOLUMEATTRIBUTESCLASS   REASON   AGE
   persistentvolume/pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            Delete           Bound    fm-1-ns/repo-data-dr-gitlab-ha-gitaly-default-0   ceph-rdb       <unset>                          63s
   persistentvolume/pvc-2995a8a7-648c-4e99-a3d3-c73a483a601b   5Gi        RWO            Delete           Bound    fm-1-ns/repo-data-dr-gitlab-ha-gitaly-default-1   ceph-rdb       <unset>                          30s
   persistentvolume/pvc-e4a94d84-d5e2-419f-bbbd-285fa88b6b5e   5Gi        RWO            Delete           Bound    fm-1-ns/repo-data-dr-gitlab-ha-gitaly-default-2   ceph-rdb       <unset>                          19s
   ```

6. **Deploy Secondary GitLab**: Restore the backed up `gitlabofficial.yaml` to the disaster recovery environment with the same namespace name. GitLab will automatically start using the disaster recovery data.

7. **Verify GitLab Components**: Verify that all GitLab components are running and healthy. Test GitLab functionality (repository access, CI/CD pipelines, user authentication) to verify that GitLab is working properly.

8. **Switch Access Address**: Switch external access addresses to Secondary GitLab.

## Building GitLab Disaster Recovery Solution with Other Object Storage and PostgreSQL

The operational steps are similar to building a GitLab disaster recovery solution with `Alauda Build of Rook-Ceph` and `Alauda support for PostgreSQL`. Simply replace storage and PostgreSQL with other object storage and PostgreSQL solutions that support disaster recovery.

:::warning
Ensure that the selected storage and PostgreSQL solutions support disaster recovery capabilities, and perform sufficient disaster recovery drills before using in production environments.
:::

