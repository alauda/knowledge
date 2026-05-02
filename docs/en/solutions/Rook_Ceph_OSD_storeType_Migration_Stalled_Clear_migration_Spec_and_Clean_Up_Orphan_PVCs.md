---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Rook Ceph OSD storeType Migration Stalled — Clear `migration` Spec and Clean Up Orphan PVCs
## Issue

During a Rook-Ceph major-version upgrade, the operator attempts to migrate OSDs from one `storeType` (for example `bluestore_rdr`) to another (`bluestore`). Two concrete symptoms appear together:

- One or more OSDs go missing or never come back up after a restart.
- The `rook-ceph-operator` logs contain `op-osd: osd migration is requested` but the migration never finishes — PG state stays mixed `active+undersized+degraded+remapped+backfill_wait`.

A sample log excerpt from the operator pod:

```text
op-osd: osd migration is requested
op-osd: waiting for PGs to be healthy. PG status: "cluster is not fully clean.
  PGs: [{StateName:active+undersized+degraded+remapped+backfill_wait Count:129}
        {StateName:active+clean                                     Count:54}]"
```

The cluster remains degraded until the migration completes, and the migration does not complete on its own.

## Root Cause

When a Rook upgrade requires transitioning OSDs to a new on-disk `storeType`, the operator looks at two fields on the `CephCluster` CR:

```yaml
spec:
  storage:
    migration:
      confirmation: yes-really-migrate-osds
```

Those fields are **one-shot gates**. They tell the operator the administrator has acknowledged the rebuild and allow it to start. The expected steady state after the migration begins is that the admin removes those fields — but if the `confirmation:` value was captured into the CR at install time (or copied from a sample CR) and never removed, the operator keeps re-reading the gate on every reconcile, re-queues the migration intent without actually driving it forward, and the OSDs stop making progress.

A secondary factor: when the operator recreates an OSD pod with the new `storeType`, it provisions a fresh PVC from the configured storage class. Occasionally the **old** PVC is not cleaned up — it stays bound but no OSD deployment references it. The orphan PVC holds the OSD id and blocks the new pod from taking over, so the migration stalls after the first OSD and never completes the set.

Resolving the stall requires two actions: removing the stale `migration:` block so the operator sees a clean desired state, and identifying and deleting orphan OSD PVCs so new OSDs can claim their slots.

## Resolution

> **Warning:** steps 2–3 touch OSD PVCs. Deleting the wrong PVC will destroy one replica of OSD data. On a cluster with replica 3 or EC, this is recoverable — but only one PVC at a time, and only after confirming it is genuinely orphaned. If in doubt, open a support case before proceeding.

### Step 1 — scale down operators to get a quiet state

The `rook-ceph-operator` (and any higher-level operator that manages it, such as the storage-system operator) must be paused before you can safely clean up spec fields and PVCs:

```bash
NS=rook-ceph

kubectl -n "$NS" scale deployment rook-ceph-operator --replicas=0
kubectl -n "$NS" scale deployment storage-system-operator --replicas=0 2>/dev/null || true
```

Delete any migration jobs that may be stuck mid-run:

```bash
kubectl -n "$NS" delete jobs --all
```

### Step 2 — identify orphan OSD PVCs

An orphan OSD PVC is one that is `Bound` but has no corresponding `rook-ceph-osd` Deployment referencing it.

```bash
NS=rook-ceph

# List all OSD PVCs (they have a "deviceset" annotation in their name).
kubectl -n "$NS" get pvc -o=jsonpath='{range .items[?(@.metadata.labels.ceph\.rook\.io/DeviceSet)]}{.metadata.name}{"\n"}{end}'

# List all OSD deployments (these own the PVCs that are in use).
kubectl -n "$NS" get deploy -l app=rook-ceph-osd -o=jsonpath='{range .items[*]}{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}{"\n"}{end}' | sort -u

# The PVCs in the first list but not the second are orphans.
```

Cross-reference with the `ceph osd df tree` view to confirm which OSD IDs are actually in the Ceph cluster. PVCs whose OSD id no longer appears in the tree are safe to delete.

To query Ceph while the operator is down, exec into a toolbox pod (if present) or into the last remaining OSD pod:

```bash
kubectl -n "$NS" exec deploy/rook-ceph-tools -- \
  ceph osd df tree -c /var/lib/rook/rook-ceph/rook-ceph.config
```

Record every orphan PVC name before moving on.

### Step 3 — delete the orphan PVCs

One at a time. After each deletion, wait for the cluster's PGs to recover (Step 6's monitoring loop) before deleting the next.

```bash
kubectl -n "$NS" delete pvc <orphan-pvc-name>
```

### Step 4 — clear the `migration` block from the CephCluster CR

The stale gate is what causes the operator to loop on migration intent. Edit the CR and delete the `migration:` subtree entirely:

```bash
kubectl -n "$NS" edit cephcluster <cluster-name>
```

Remove these lines:

```yaml
spec:
  storage:
    migration:                     # <-- delete this line
      confirmation: yes-really-migrate-osds   # <-- and this line
```

Save. Verify the field is gone:

```bash
kubectl -n "$NS" get cephcluster <cluster-name> -o yaml | grep -A2 migration || echo "migration block is gone"
```

### Step 5 — scale the Rook operator back up (only the Rook operator)

```bash
kubectl -n "$NS" scale deployment rook-ceph-operator --replicas=1
```

Leave any higher-level `storage-system-operator` scaled to zero for now — a two-operator reconcile loop during migration can reintroduce the `migration:` block if the higher-level controller has it in its template.

### Step 6 — watch the OSD migration progress

```bash
kubectl -n "$NS" logs deploy/rook-ceph-operator -f | grep -E 'op-osd|orchestrate'
```

Healthy progress looks like a new OSD deployment appearing with a fresh `creationTimestamp`, the Ceph tree showing the new OSD with the expected `storeType`, and PGs trending toward `active+clean`.

If the operator complains about an orphan PVC again (`OSD id X is already taken`), repeat Step 2 — another orphan has surfaced now that more OSDs are under migration.

### Step 7 — scale the higher-level operator back up

Once every OSD has the new `storeType` and PGs are fully clean, re-enable the higher-level operator so it resumes normal reconciliation:

```bash
kubectl -n "$NS" scale deployment storage-system-operator --replicas=1 2>/dev/null || true
```

## Diagnostic Steps

Confirm migration is in fact requested but not progressing:

```bash
NS=rook-ceph

kubectl -n "$NS" logs deploy/rook-ceph-operator --tail=300 | \
  grep -E 'op-osd: osd migration is requested|waiting for PGs'
```

Verify the current `storeType` mix on the cluster — before a migration all OSDs report the same type; during a stuck migration the set is mixed:

```bash
kubectl -n "$NS" get cephcluster -o yaml | grep -A1 storeType
```

Example of a stuck state (three OSDs still on the old type, new deployments never launched):

```yaml
storeType: bluestore_rdr: 3
```

Check that the OSD deployments are running and not in `CrashLoopBackOff`:

```bash
kubectl -n "$NS" get deploy -l app=rook-ceph-osd
kubectl -n "$NS" get pod -l app=rook-ceph-osd
```

Inspect the nodes hosting OSDs for disk pressure or I/O errors before migrating — a failing disk will kill the migration with a fresh, unrelated error:

```bash
kubectl describe node <osd-node> | grep -E 'DiskPressure|MemoryPressure'
```

After the migration completes, confirm with one final Ceph status check:

```bash
kubectl -n "$NS" exec deploy/rook-ceph-tools -- \
  ceph status -c /var/lib/rook/rook-ceph/rook-ceph.config
```

`cluster is HEALTH_OK` and every OSD reporting the new `storeType` is the target state.
