---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Storage Migration Leaves Orphan PVCs Consuming Double Capacity — Source PVCs Must Be Deleted After Migration Completes
## Issue

After running a VM storage migration (`updateVolumesStrategy: Migration` in the `VirtualMachine` spec), the cluster's backing storage shows roughly double the expected capacity consumed:

- The VM runs correctly on the new PVCs — the migration is functionally successful.
- The old (source) PVCs remain in the namespace, still `Bound` to their original Persistent Volumes.
- The storage backend's dashboard shows the old PVs still consuming capacity — deduplication / compression do not reclaim the space because the PVs are still considered in-use from the cluster's perspective.

The net effect is that every VM subjected to storage migration permanently occupies twice its intended footprint until manual cleanup.

## Root Cause

The VM storage-migration strategy is an online-copy strategy. It provisions new PVCs of the target storage class, copies data block-by-block from each source PV to its new destination, and — once every block is replicated and the VM is quiesced — atomically updates the VM's `spec.template.spec.volumes` to reference the new PVCs. The live virt-launcher pod then reads and writes from the new PVs going forward.

What the migration strategy **does not do** by design is delete the source PVCs. Two reasons:

1. **Safety net**: if the administrator discovers data corruption on the target (for any reason — from bad hardware to a bug in the copy path), the source PV is still intact and can be reattached to restore service.
2. **Snapshot / lineage**: some administrators run storage migration as a way to repartition data across classes while keeping a read-only archive of the original. Auto-deleting the source would defeat that use case.

The trade-off is that the administrator now owns the decision — and the follow-through — to reclaim the source PVs after confirming the migration is sound. If nobody performs that cleanup, the storage accumulates orphaned PVCs proportional to the migration volume.

The fix is the administrator cleanup step, after verification that the VM is stable on the new PVCs.

## Resolution

### Step 1 — confirm the VM is now using the new PVCs

Inspect the VirtualMachine CR to read its current volume references:

```bash
NS=<vm-namespace>
VM=<vm-name>
kubectl -n "$NS" get vm "$VM" -o=yaml | \
  yq '.spec.template.spec.volumes[]'
```

Expected output after a successful migration — every volume references a PVC whose name carries the migration suffix (naming is tool-specific; commonly includes `-mig-` or `-migrated-`):

```yaml
- name: vol-0
  persistentVolumeClaim:
    claimName: app-vm-1234-1j1az-mig-abcd
- name: vol-1
  persistentVolumeClaim:
    claimName: app-vm-1234-pqrs-mig-xyz
updateVolumesStrategy: Migration
```

Also check the VirtualMachineInstance (the live runtime object) to confirm it has consumed the new volumes — the VM spec may lag the VMI briefly:

```bash
kubectl -n "$NS" get vmi "$VM" -o=yaml | yq '.spec.volumes[]'
```

Both CRs should match.

### Step 2 — enumerate the orphan PVCs

The source PVCs are easiest to find by excluding the migrated ones from the full PVC list in the namespace:

```bash
NS=<vm-namespace>

# Listing all PVCs the VM currently uses (the keep set):
KEEP=$(kubectl -n "$NS" get vm "$VM" -o=jsonpath='{.spec.template.spec.volumes[*].persistentVolumeClaim.claimName}' | tr ' ' '\n' | sort -u)

# All PVCs associated with this VM (label patterns vary by platform):
ALL=$(kubectl -n "$NS" get pvc -l vm.kubevirt.io/name="$VM" -o=name | sed 's@^persistentvolumeclaim/@@')

# The orphans are in ALL but not in KEEP:
echo "$ALL" | while read -r pvc; do
  echo "$KEEP" | grep -q "^$pvc$" || echo "$pvc (orphan)"
done
```

Review each candidate against the VM's current spec one more time to be sure it is truly unreferenced.

### Step 3 — verify the orphan PVCs are not attached

A PVC still bound to a running pod cannot be safely deleted. Confirm each candidate is unattached:

```bash
for pvc in <orphan-1> <orphan-2>; do
  echo "=== $pvc ==="
  kubectl -n "$NS" describe pvc "$pvc" | grep -E 'Used By|Status|Bound'
done
```

`Used By: <none>` is the desired line. If a PVC is still shown as used by a virt-launcher pod, the VM has not fully cut over — re-run Step 1 and wait before continuing.

### Step 4 — delete the orphan PVCs

Delete one at a time. Allow the storage backend a few seconds between deletions to process the release:

```bash
for pvc in <orphan-1> <orphan-2>; do
  kubectl -n "$NS" delete pvc "$pvc"
  sleep 5
done
```

What happens next depends on the PV's `reclaimPolicy`:

- **Delete** (default for many storage classes): the PV is deleted, and the backing block / object / filesystem is released to the backend's free pool.
- **Retain**: the PV transitions to `Released` state but remains; the backend space is not reclaimed until the PV is also deleted. Follow up with `kubectl delete pv <pv-name>` on each retained PV after capturing any data you need.

### Step 5 — confirm the storage backend reclaims space

The backend's reclamation behaviour depends on the driver. For Rook-Ceph, the PV is released immediately but the underlying RBD image is deleted asynchronously by the provisioner — expect a delay of seconds to minutes for dashboard numbers to update. Verify:

```bash
# For Rook-Ceph via a toolbox pod:
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- rados -p <rbd-pool> df
```

For storage classes backed by a CSI driver that provisions from a vSAN / dedupe-aware array, the array may take longer to dedupe-crawl — watch the array's administrative UI for the free-space number to climb.

### Step 6 — make the cleanup a standard part of the migration runbook

Migration without a scheduled cleanup step leaves a persistent capacity tax. Add an explicit "Step N — delete source PVCs after 24 h of stable run" line to the VM-migration runbook. Alternatively, add a cron job that scans for PVCs labelled as migration-source, checks whether they are bound, and logs a reminder (not auto-delete — the safety rationale is still good).

## Diagnostic Steps

Spot the capacity problem at scale:

```bash
# Total bound storage the namespace is consuming:
kubectl -n "$NS" get pvc -o=jsonpath='{range .items[*]}{.status.capacity.storage}{"\n"}{end}' | \
  awk 'BEGIN{total=0} {s=$1; gsub(/Gi/,"",s); total+=s} END{print total " Gi total"}'
```

Compare to the sum the running VMs actually need (sum over the volumes referenced in their VM CRs). A large delta is the orphan inventory.

Show orphan history over time by age:

```bash
kubectl -n "$NS" get pvc -o=jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}' | \
  sort -k2 | column -t
```

PVCs older than the last migration date, not referenced by any current VM, are the orphans.

For each VM, audit whether its volumes come from a migrated set by looking at the VMI's annotations — some virtualization platforms annotate with the migration session ID:

```bash
kubectl -n "$NS" get vmi -o=custom-columns='NAME:.metadata.name,ANNOTATION:.metadata.annotations'
```

An annotation like `kubevirt.io/storage-migration: <session>` or `migrated-at: <timestamp>` is a reliable breadcrumb back to when the cleanup is overdue.

After Steps 3–4, confirm the `kubectl get pvc` count matches the number of volumes the VM expects — for a two-disk VM, two PVCs. Anything more is still an orphan.
