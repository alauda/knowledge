---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Corruption After Scaling Ceph/Rook Storage — LocalVolumeSet Filters Picked Up RBD Partitions
## Issue

After adding a new worker node and scaling a Ceph / Rook–backed storage cluster to absorb the new capacity, ACP Virtualization VMs running on the cluster fail to boot, report filesystem corruption on existing disks, or stop serving. The Ceph cluster itself simultaneously reports `slow ops` and reduced data availability. The two symptoms arrive together and are not a coincidence: the same physical blocks underneath are being written to by two independent layers of the stack.

The trigger is the cluster's `LocalVolumeSet` configured with filters broad enough that it picked up **RBD devices** presented to the worker — the virtual disks of running VMs — and allocated PersistentVolumes (PVs) on top of them. When Ceph scaled and claimed new OSDs, it consumed those PVs and began writing OSD data directly onto the VMs' still-in-use virtual disks.

## Root Cause

KubeVirt-backed VMs on a Ceph-RBD storage class run their guest disks as RBD images. On each worker node hosting a running VM, the RBD image is attached to the node as a block device at `/dev/rbdN`, and the VM's guest partitions appear as `/dev/rbdNpM` beneath it. These are perfectly normal Linux block devices from the node's perspective — they just happen to be mounted through the `rbd` kernel module.

A `LocalVolumeSet` scans the node for block devices matching its filters (`deviceTypes`, `minSize`/`maxSize`, `vendors`, etc.) and creates a local PV for each matching device. When the filters were written without the expectation that RBD devices could appear:

- `deviceTypes: [disk, part]` matches partitions. Partitions of the VM's virtual disk therefore match.
- No `vendors` filter — RBD has no vendor string, but the absence of the filter allows any device.
- `minSize` / `maxSize` sized to cover "typical local SSDs" — the VM's virtual disk often falls in the same range.

The Local Storage Operator creates PVs for these "local devices", expressly unaware that they are in fact shared block devices backed by Ceph RBD and already mounted by a running VM. Initially these PVs sit in `Available` state, which masks the problem until something claims them.

When the Ceph / Rook cluster scales and requests new OSDs, the operator matches its `storageClassDeviceSets` against `Available` PVs with the right storage class. The PVs that were incorrectly created on top of RBD devices match — and new OSDs get provisioned directly onto the VMs' virtual disks. Ceph then begins writing cluster metadata and newly-distributed placement-group replicas to blocks that the running VM is simultaneously writing its application data to.

The destruction is immediate and bidirectional: the VMs see their filesystems corrupted, and Ceph's new OSDs contain garbage that other VMs (through their normal RBD mounts) will later read.

## Resolution

### If the cluster is already corrupt — stop and recover deliberately

Corruption of an in-flight OSD plus a live VM disk cannot be recovered automatically; it needs a careful cluster-side recovery (remove the incorrect OSDs, restore affected VMs from backup, rebalance Ceph). Involve the storage team before attempting any further writes — additional writes may amplify the damage.

Assume every VM on an RBD-backed storage class is potentially affected. Cross-reference with the problematic PVs identified in Diagnostic Steps below; VMs whose disk paths match the paths consumed by the OSDs are the most directly affected.

### If the PVs exist but no OSD claimed them yet — prevent

Act immediately before any scale-up claims the PVs:

1. **Enumerate the mistakenly-created PVs** (Diagnostic Steps has the exact query).
2. **Delete the PVs** that point at RBD paths. This is safe only if they are in `Available` state and not bound to a PVC. Check the `status.phase` before deleting:

   ```bash
   kubectl get pv -o json | \
     jq -r '.items[] | select(.spec.local.path // "" | test("rbd[0-9]+"))
            | "\(.metadata.name)\t\(.status.phase)\t\(.spec.local.path)"'
   ```

   Delete only rows whose phase is `Available`:

   ```bash
   kubectl delete pv <pv-name>
   ```

3. **Tighten the `LocalVolumeSet` filters** so this never reoccurs. The edits below eliminate the categories that let RBD devices through:

   ```yaml
   apiVersion: local.storage.alauda.io/v1alpha1
   kind: LocalVolumeSet
   metadata:
     name: local-block-osds
     namespace: local-storage
   spec:
     storageClassName: local-block
     deviceInclusionSpec:
       # Remove `part` — RBD partitions appear as /dev/rbdNpM and match `part`.
       # Restrict strictly to whole disks.
       deviceTypes:
         - disk
       # Vendors filter — only pick up physical disks of known vendors.
       # Exact values depend on the node hardware; `nvme` / `ATA` / disk-vendor
       # strings as reported by `lsblk -o NAME,VENDOR` on the node.
       vendors:
         - ATA
         - NVMe
       # Size constraints — tight to the physical OSD disks, not "any disk".
       minSize: 1Ti
       maxSize: 8Ti
     nodeSelector:
       nodeSelectorTerms:
         - matchExpressions:
             - key: storage-role
               operator: In
               values: [osd]
   ```

   After applying, re-list the PVs. No new RBD-backed PVs should be created on the next Local Storage Operator reconcile cycle.

4. **Audit before any future scale-up**. Each time the Ceph cluster is scaled, re-run the PV query above to confirm no RBD-backed PVs have crept into the `Available` pool.

### Defensive posture — segregate RBD nodes from LocalVolumeSet scan

A stronger defence: use a `nodeSelector` on the `LocalVolumeSet` that restricts scanning to nodes that are **dedicated** to local-storage OSDs and never host VM workloads. If VM workloads are mixed with OSD-eligible nodes, keep the filters tight; otherwise, exclude VM-hosting nodes entirely from the `LocalVolumeSet` selector so RBD devices are invisible to the operator.

## Diagnostic Steps

List the PVs the Local Storage Operator has created and look for any whose backing path points at an RBD device:

```bash
kubectl get pv -o json | \
  jq -r '.items[]
         | select(.metadata.annotations["storage.local/local-volume-owner-name"] != null
                  or (.metadata.name | test("local-pv")))
         | [.metadata.name, .status.phase, (.spec.local.path // "")]
         | @tsv'
```

Rows with `spec.local.path` containing `/dev/rbd` or `/mnt/local-storage/.../rbd[0-9]+` are the problematic PVs. Examples:

```text
local-pv-abc123   Available   /mnt/local-storage/lso-volumeset/rbd60p3
local-pv-def456   Bound       /mnt/local-storage/lso-volumeset/rbd17p1
```

For any `Bound` row, the PV has already been claimed — the corresponding workload is potentially corrupt. For `Available` rows, the PV exists but no claim has consumed it yet; delete immediately before scale-up.

Cross-check the Ceph cluster's OSD-to-PV mapping:

```bash
kubectl -n rook-ceph get cephcluster <name> -o yaml | \
  yq '.spec.storage.storageClassDeviceSets'
```

Any `deviceSet` referring to the `local-block` storage class consumes `LocalVolumeSet`-produced PVs. If the set's replica count has grown since the problem started, new OSDs may have consumed the problematic PVs.

Check node-side for currently-active RBD mounts to know which VMs are at risk:

```bash
NODE=<node>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c '
    lsblk | grep rbd
    echo ---
    for r in /sys/class/block/rbd*; do
      name=$(basename "$r")
      image=$(cat "$r/rbd_image"   2>/dev/null)
      pool=$(cat  "$r/rbd_pool"    2>/dev/null)
      echo "$name  pool=$pool  image=$image"
    done
  '
```

Each listed `rbdN` corresponds to a VM whose disk is mapped to this node. Those are the VMs whose data is at risk if the LocalVolumeSet ever adopted the partitions.

After the fix (tightened filters + stale PVs removed), rerun the PV query and confirm no RBD-backed PVs exist. Any future Ceph scale should only pick up PVs backed by physical disks.
