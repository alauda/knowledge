---
kind:
   - Solution
products:
  - Alauda DevOps
ProductsVersion:
   - 4.x
id: KB251200004
---

# How to Perform Disaster Recovery for Nexus

## Issue

This solution describes how to build a Nexus disaster recovery solution based on Ceph block storage disaster recovery capabilities. The solution implements a **hot data, cold compute** architecture, where data is continuously synchronized to the secondary cluster through Ceph block storage disaster recovery mechanisms. When the primary cluster fails, a secondary Nexus instance is deployed, and the secondary Nexus will quickly start using the disaster recovery data and provide services. The solution primarily focuses on data disaster recovery processing, and users need to implement their own Nexus access address switching mechanism.

## Environment

Nexus Operator: >=v3.81.1

## Terminology

| Term                    | Description                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| **Primary Nexus**      | The active Nexus instance that serves normal business operations and user requests. This instance is fully operational with all components running. |
| **Secondary Nexus**    | The standby Nexus instance planned to be deployed in a different cluster/region, remaining dormant until activated during disaster recovery scenarios. |
| **Primary Block Storage**| The active block storage system that stores all Nexus data, serving as the source for block storage replication. |
| **Secondary Block Storage**| The synchronized backup block storage system that receives data replication from the primary block storage. It ensures data availability during disaster recovery. |
| **Recovery Point Objective (RPO)** | The maximum acceptable amount of data loss measured in time (e.g., 5 minutes, 1 hour). It defines how much data can be lost during a disaster before it becomes unacceptable. |
| **Recovery Time Objective (RTO)** | The maximum acceptable downtime measured in time (e.g., 15 minutes, 2 hours). It defines how quickly the system must be restored after a disaster. |
| **Failover**            | The process of switching from the primary system to the secondary system when the primary system becomes unavailable or fails. |
| **Data Synchronization**| The continuous process of replicating data from primary systems to secondary systems to maintain consistency and enable disaster recovery. |
| **Hot Data, Cold Compute**| An architectural pattern where data is continuously synchronized (hot), while compute resources remain inactive (cold) until failover. |

## Architecture

The Nexus disaster recovery solution implements a **hot data, cold compute architecture** for Nexus services. This architecture provides disaster recovery capabilities through near-real-time data synchronization and manual Nexus service failover procedures. The architecture consists of two Nexus instances deployed across different clusters or regions, with the secondary Nexus instance not deployed in advance until activated during disaster scenarios, while the storage layer maintains continuous synchronization.

### Data Synchronization Strategy

The solution ensures Nexus data synchronization to the secondary cluster through Ceph RBD Mirror block storage replication. All Nexus data is stored in PVCs, which are periodically synchronized to the secondary cluster through the Ceph RBD Mirror mechanism.

### Disaster Recovery Configuration

1. **Deploy Primary Nexus**: Configure domain access, use primary block storage for data storage
2. **Prepare Secondary Nexus Deployment Environment**: Configure PV, PVC, and Secret resources required for the secondary instance to enable rapid recovery when disasters occur

### Failover Procedure

When a disaster occurs, the following steps ensure transition to the secondary environment:

1. **Verify Primary Failure**: Confirm that all primary Nexus components are unavailable
2. **Promote Ceph RBD**: Promote secondary Ceph RBD to primary Ceph RBD
3. **Restore PVC and PV Resources**: According to the Ceph block storage disaster recovery documentation, restore the PVCs used by Nexus in the secondary cluster
4. **Deploy Secondary Nexus**: Quickly deploy the Nexus instance in the secondary cluster using disaster recovery data
5. **Update Routing**: Switch external access addresses to point to the secondary Nexus instance

## Nexus Disaster Recovery Configuration

::: warning

To simplify the configuration process and reduce configuration difficulty, it is recommended to use consistent information in both primary and secondary environments, including:

- Consistent Ceph storage pool names and storage class names
- Consistent Nexus instance names
- Consistent namespace names

:::

### Prerequisites

1. Prepare a primary cluster and a disaster recovery cluster (or a cluster containing different regions) in advance.
2. Complete the deployment of `Alauda Build of Rook-Ceph` block storage disaster recovery configuration.

:::warning
The `Alauda Build of Rook-Ceph` block storage disaster recovery configuration requires setting a reasonable [synchronization interval](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass), which directly affects the RPO metric of disaster recovery.
:::

### Building Block Storage Disaster Recovery Cluster with `Alauda Build of Rook-Ceph`

Build a block storage disaster recovery cluster using `Alauda Build of Rook-Ceph`. Refer to the [Block Storage Disaster Recovery](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html) documentation to build the disaster recovery cluster.

### Set Up Primary Nexus

Deploy the Primary Nexus instance by following the Nexus instance deployment guide. Configure domain access, use primary block storage for data storage.

Configuration example (only includes configuration items related to disaster recovery, see product documentation for complete configuration items):

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Nexus
metadata:
  name: <NEXUS_NAME>
  namespace: <NEXUS_NAMESPACE>
spec:
  externalURL: http://nexus-ddrs.alaudatech.net
  helmValues:
    pvc:
      storage: 5Gi
      volumeClaimTemplate:
        enabled: true
    storageClass:
      name: ceph-rdb # Set the configured storage class name
```

After deploying the primary Nexus, you need to configure RBD Mirror for the PVCs used by Nexus components. After configuration, PVC data will be periodically synchronized to the secondary Ceph cluster. For specific parameter configuration, refer to [Ceph RBD Mirror](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#enable-mirror-for-pvc).

```bash
export NEXUS_NAMESPACE=<ns-of-nexus-instance>
export NEXUS_NAME=<name-of-nexus-instance>
export NEXUS_PVC_NAME=nexus-data-${NEXUS_NAME}-nxrm-ha-0

cat << EOF | kubectl apply -f -
apiVersion: replication.storage.openshift.io/v1alpha1
kind: VolumeReplication
metadata:
  name: ${NEXUS_PVC_NAME}
  namespace: ${NEXUS_NAMESPACE}
spec:
  autoResync: true # Auto sync
  volumeReplicationClass: rbd-volumereplicationclass
  replicationState: primary # Mark as primary cluster
  dataSource:
    apiGroup: ""
    kind: PersistentVolumeClaim
    name: ${NEXUS_PVC_NAME}
EOF
```

Check the Ceph RBD Mirror status to see that the Nexus PVC has been configured with Ceph RBD Mirror.

```bash
❯ kubectl -n $NEXUS_NAMESPACE get volumereplication
NAME                                      AGE   VOLUMEREPLICATIONCLASS       PVCNAME                                   DESIREDSTATE   CURRENTSTATE
nexus-data-nexus-ddrs-nxrm-ha-0           15s   rbd-volumereplicationclass   nexus-data-nexus-ddrs-nxrm-ha-0           primary        Primary
```

View the Ceph RBD Mirror status from the Ceph side. `CEPH_BLOCK_POOL` is the name of the Ceph RBD storage pool. The `SCHEDULE` column indicates the synchronization frequency (the example below shows synchronization every 1 minute).

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror snapshot schedule ls --pool $CEPH_BLOCK_POOL --recursive
POOL     NAMESPACE  IMAGE                                         SCHEDULE
myblock             csi-vol-459e6f28-a158-4ae9-b5da-163448c35119  every 1m
```

Check the Ceph RBD Mirror status. When state is `up+stopped` (primary cluster normal) and peer_sites.state is `up+replaying` (secondary cluster normal), it indicates normal synchronization.

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror image status $CEPH_BLOCK_POOL/$NEXUS_BLOCK_IMAGE_NAME
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

### Set Up Secondary Nexus

:::warning
When Ceph RBD is in secondary state, the synchronized storage blocks cannot be mounted, so Nexus in the secondary cluster cannot be deployed successfully.

If you need to verify whether Nexus in the secondary cluster can be deployed successfully, you can temporarily promote the Ceph RBD of the secondary cluster to primary, and after testing is complete, set it back to secondary state. At the same time, you need to delete all Nexus, PV, and PVC resources created during testing.
:::

1. Backup Secrets Used by Primary Nexus
2. Backup PVC and PV Resource YAMLs of Primary Nexus Components
3. Backup Primary Nexus Instance YAML

#### Backup Secrets Used by Primary Nexus

Get the Password Secret YAML used by the primary Nexus and create the Secret in the secondary cluster with the same namespace name.

```bash
apiVersion: v1
data:
  password: xxxxxx
kind: Secret
metadata:
  name: nexus-root-password
  namespace: nexus-dr
type: Opaque
```

#### Backup PVC and PV Resources of Primary Nexus Components

:::tip
The PV resource contains volume attribute information, which is critical information for disaster recovery restoration and needs to be backed up properly.

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

Execute the following command to backup the PVC and PV resources of the primary Nexus components to the current directory:

```bash
export NEXUS_PVC_NAME=<PVC_NAME>

echo "=>  Exporting PVC $NEXUS_PVC_NAME"

# Export PVC
kubectl -n "$NEXUS_NAMESPACE" get pvc "$NEXUS_PVC_NAME" -o yaml > "pvc-${NEXUS_PVC_NAME}.yaml"

# Get PV
PV=$(kubectl -n "$NEXUS_NAMESPACE" get pvc "$NEXUS_PVC_NAME" -o jsonpath='{.spec.volumeName}')

if [[ -n "$PV" ]]; then
  echo "   ↳ Exporting PV $PV"
  kubectl get pv "$PV" -o yaml > "pv-${PV}.yaml"
fi
```

Modify the backed up PV file and delete all `spec.claimRef` fields in the yaml.

Create the backed up PVC and PV YAML files directly in the disaster recovery environment with the same namespace name.

#### Backup Primary Nexus Instance YAML

```bash
kubectl -n "$NEXUS_NAMESPACE" get nexus "$NEXUS_NAME" -oyaml > nexus.yaml
```

Modify the information in `nexus.yaml` according to the actual situation of the disaster recovery environment.

:::warning
The `Nexus` resource **does not need** to be created in the disaster recovery environment immediately. It only needs to be created in the secondary cluster when a disaster occurs and disaster recovery switchover is performed.
:::

:::warning
If you need to perform disaster recovery drills, you can follow the steps in [Disaster Switchover](#disaster-switchover) for drills. After the drill is complete, you need to perform the following cleanup operations in the disaster recovery environment:

- Delete the `Nexus` instance in the disaster recovery environment
- Delete the created PVCs and PVs
- Switch Ceph RBD back to secondary state

:::

### Recovery Objectives

#### Recovery Point Objective (RPO)

The RPO represents the maximum acceptable data loss during a disaster recovery scenario. In this Nexus disaster recovery solution:

- **Storage Layer**: Due to Ceph RBD block storage replication for Nexus data, through periodic snapshot synchronization, data loss depends on the synchronization interval, which can be [configured](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)
- **Overall RPO**: The overall RPO depends on the synchronization interval of Ceph RBD block storage replication.

#### Recovery Time Objective (RTO)

The RTO represents the maximum acceptable downtime during disaster recovery. This solution provides:

- **Manual Components**: Nexus service activation and external routing updates require manual intervention
- **Typical RTO**: 4-10 minutes for complete service restoration

**RTO Breakdown:**

- Ceph RBD failover: 1-2 minutes (manual)
- Nexus service activation: 2-5 minutes (manual)
- External routing updates: 1-3 minutes (manual, depends on DNS propagation)

## Disaster Switchover

1. **Confirm Primary Nexus Failure**: Confirm that all primary Nexus components are in non-working state, otherwise stop all primary Nexus components first.

2. **Promote Secondary Ceph RBD**: Promote secondary Ceph RBD to primary Ceph RBD. Refer to the switchover procedure in [Alauda Build of Rook-Ceph Failover](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#procedures-1).

3. **Restore PVC and PV Resources**: Restore the backed up PVC and PV resources to the disaster recovery environment with the same namespace name, and check that the PVC status in the secondary cluster is `Bound`:

   ```bash
   ❯ kubectl -n $NEXUS_NAMESPACE get pvc,pv
   NAME                                                            STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
   persistentvolumeclaim/nexus-data-nexus-ddrs-nxrm-ha-0          Bound    pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            ceph-rdb       <unset>                 45s

   NAME                                                        CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                                             STORAGECLASS   VOLUMEATTRIBUTESCLASS   REASON   AGE
   persistentvolume/pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            Delete           Bound    nexus-dr/nexus-data-nexus-ddrs-nxrm-ha-0   ceph-rdb       <unset>                          63s
   ```

4. **Deploy Secondary Nexus**: Restore the backed up `nexus.yaml` to the disaster recovery environment with the same namespace name. Nexus will automatically start using the disaster recovery data.

5. **Verify Nexus Components**: Verify that all Nexus components are running and healthy. Test Nexus functionality (repository access, package upload/download, user authentication) to verify that Nexus is working properly.

6. **Switch Access Address**: Switch external access addresses to Secondary Nexus.

## Building Nexus Disaster Recovery Solution with Other Block Storage

The operational steps are similar to building a Nexus disaster recovery solution with `Alauda Build of Rook-Ceph`. Simply replace block storage with other block storage solutions that support disaster recovery.

:::warning
Ensure that the selected block storage solution supports disaster recovery capabilities, and perform sufficient disaster recovery drills before using in production environments.
:::

