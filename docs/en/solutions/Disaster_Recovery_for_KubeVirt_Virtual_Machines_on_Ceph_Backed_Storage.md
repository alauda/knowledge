---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

KubeVirt virtual machines whose disks live on a Ceph-backed `StorageClass` (RBD or CephFS) can participate in two distinct disaster-recovery topologies:

- **Stretched (Metropolitan) DR** — one Ceph cluster spans multiple sites with synchronous replication. Cluster-level Kubernetes objects (the VM spec, DataVolumes, Services) are recovered from a backup; the underlying volume stays available because Ceph never lost a quorum.
- **Regional DR** — two independent Ceph clusters in different sites, with asynchronous RBD-mirror replication of selected pools. On failover, the surviving site promotes its mirrored images and Kubernetes recreates the VMs against the now-primary Ceph.

The KubeVirt VM CRD itself does not know about either pattern. The DR mechanics live in Ceph + the Kubernetes data plane (PVC, VolumeReplication, VolumeReplicationGroup). The VM-specific concerns are: (a) crash consistency at the moment a snapshot is taken, (b) handling of the `runStrategy`/`running` field across the failover window, and (c) reattachment of secondary network resources at the destination site.

This article collects the operational guardrails for using either DR topology with KubeVirt-managed VMs.

## Resolution

### Step 1 — Confirm the storage profile is RWX-capable

VM disks attached as `volumeMode: Block` over RBD work in either topology. CephFS (`volumeMode: Filesystem`) is supported but the live-migration path for `RWX` volumes is the safer default:

```bash
kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.provisioner}{"\t"}{.parameters}{"\n"}{end}'
```

The provisioner should be one of `rbd.csi.ceph.com` or `cephfs.csi.ceph.com`. Confirm the VM `DataVolume` references that StorageClass.

### Step 2 — Use file-system freeze before snapshot

For crash-consistent (or, with the in-guest agent, application-quiesced) snapshots, install `qemu-guest-agent` in every guest and let KubeVirt drive the freeze through the agent:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: app-vm
spec:
  template:
    spec:
      domain:
        devices:
          channels:
            - source:
                mode: bind
              target:
                type: virtio
                name: org.qemu.guest_agent.0
```

Trigger the snapshot through the `VirtualMachineSnapshot` CRD. KubeVirt cooperates with the in-guest agent to flush filesystem buffers before the underlying RBD/CephFS snapshot is taken:

```yaml
apiVersion: snapshot.kubevirt.io/v1beta1
kind: VirtualMachineSnapshot
metadata:
  name: app-vm-pre-failover
spec:
  source:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: app-vm
```

### Step 3 — Stretched topology — coordinate Pod fencing

In a stretched cluster the surviving zone's worker nodes pick up the VM Pods automatically once the failed zone is fenced. To avoid split-brain on the RBD images, fence the failed zone at the Ceph layer (mark its OSDs `out`) BEFORE letting the Kubernetes scheduler reschedule the VM Pods on the surviving zone:

```bash
ceph osd set noout       # freeze rebalancing while the zone is being declared dead
ceph osd reweight-by-utilization
```

Once Ceph reports `HEALTH_OK` from the surviving site, scale the VM back up:

```bash
kubectl patch vm app-vm --type=merge -p '{"spec":{"runStrategy":"Always"}}'
```

### Step 4 — Regional topology — mirror the RBD pool

In the regional pattern, replicate only the pool that backs VM disks (typical name `rbd` or `vm-disks`):

```bash
# On the primary cluster
rbd mirror pool enable rbd image
# Per-image, from the VirtualMachine's DataVolume PVC
rbd mirror image enable rbd/vm-app-disk-pvc-uuid snapshot
```

Wrap each VM PVC in a `VolumeReplication` so the failover sequence is declarative:

```yaml
apiVersion: replication.storage.csi-addons.io/v1alpha1
kind: VolumeReplication
metadata:
  name: app-vm-pvc-replication
  namespace: vms
spec:
  volumeReplicationClass: ceph-rbd-vrc
  replicationState: primary
  dataSource:
    apiGroup: ""
    kind: PersistentVolumeClaim
    name: app-vm-disk
```

On failover, change `replicationState: primary` on the destination cluster's `VolumeReplication` and reapply the VM manifest. The KubeVirt VM-Import controller (or Velero, or `kubectl apply` from a stored manifest) recreates the VM against the now-primary PVC.

### Step 5 — Network-attached devices at the destination site

VM `interfaces` whose `networkName` references a `NetworkAttachmentDefinition` from a primary site network must have a corresponding NAD with the same name (and equivalent topology) at the destination site. Pre-create them as part of the DR runbook; otherwise the VM Pod stays in `ContainerCreating` after recreation.

### Step 6 — Test the runbook

Periodically:

1. Take a snapshot, reboot the VM into the snapshot point on a sandbox cluster.
2. For regional DR: trigger a planned failover (demote primary, promote secondary, recreate the VM at secondary), then fail back.

Tracking the recovery-time objective from "primary considered dead" to "VM reachable at secondary" is the value the runbook produces.

## Diagnostic Steps

If the failed-over VM Pod stays in `ContainerCreating` for more than a few minutes:

```bash
kubectl describe pod virt-launcher-app-vm-xxxxx
kubectl describe pvc app-vm-disk
kubectl get volumereplication app-vm-pvc-replication -o yaml
```

Confirm the `VolumeReplication.status.state` is `primary` on the surviving cluster and the underlying RBD image is no longer marked `peer-syncing`:

```bash
rbd mirror image status rbd/vm-app-disk-pvc-uuid
```

If the in-guest agent never confirms freeze, the snapshot is crash-consistent only — fine for many workloads, but for databases inside the VM, prefer an application-aware snapshot driven from inside the guest.
