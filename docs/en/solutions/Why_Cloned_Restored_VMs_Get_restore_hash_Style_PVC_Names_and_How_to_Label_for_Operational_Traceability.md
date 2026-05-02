---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Why Cloned / Restored VMs Get `restore-<hash>`-Style PVC Names — and How to Label for Operational Traceability
## Overview

Creating a fresh VM produces a PVC whose name mirrors the VM's name — for example, a VM named `app-server` gets a root disk PVC called `app-server-disk`. Storage operations are easy to reason about because disk names clearly say which VM owns them.

Cloning a VM or restoring one from a snapshot breaks that pattern. The resulting PVC is named `restore-<random-hash>`:

```yaml
# Fresh VM — readable PVC name.
spec:
  template:
    spec:
      volumes:
        - name: rootdisk
          dataVolume:
            name: app-server-disk

# Cloned / restored VM — opaque PVC name.
spec:
  template:
    spec:
      volumes:
        - name: rootdisk
          dataVolume:
            name: restore-abcd1234-5678-90ab-cdef-0123456789ab
```

The opaque name makes day-2 operations harder: `kubectl get pvc -A` is no longer scannable, storage dashboards do not group disks by VM, and backup / audit tooling that pins identity by PVC name cannot trace back to the owning VM without an extra lookup.

## Why the Naming Is Random

The randomized `restore-<hash>` naming for cloned and restored PVCs is a deliberate safety measure. Two situations it prevents:

1. **Collision with an existing PVC.** If a clone were named `app-server-disk` and a PVC of that name already exists (from the source VM, or from an earlier restore attempt), the restore would either fail at creation or, worse, overwrite existing data. The random suffix guarantees a unique name regardless of what else lives in the namespace.
2. **Partial-state races.** A clone-in-progress that aborts midway, combined with a rename of the source VM, can leave a stale "supposed target" PVC around. Random naming ensures a retry allocates a fresh PVC rather than picking up the stale one.

The randomization solves a correctness problem. The operational inconvenience (opaque names) is the cost.

## How to Restore Traceability Today

Until the RFE for predictable cloned-PVC naming ships, the practical path is to label the PVCs at clone / restore time with metadata that lets tooling group them by their owning VM.

### Pattern 1 — label the PVC with the VM name

Add a label to the cloned VM's PVC / DataVolume template that names the owning VM. The VM owns the DataVolume; label it in the VM's spec:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: app-server-cloned
spec:
  dataVolumeTemplates:
    - metadata:
        name: restore-placeholder   # will be regenerated, but labels persist
        labels:
          app.kubernetes.io/name: app-server
          app.kubernetes.io/part-of: app-server-cloned
          vm.kubevirt.io/name: app-server-cloned
      spec:
        source:
          snapshot:
            name: <snapshot-name>
            namespace: <snapshot-namespace>
        # ... rest of the DataVolume spec ...
  template:
    # ... template ...
```

`dataVolumeTemplates` labels propagate to the rendered DataVolume and its backing PVC. After the restore runs:

```bash
kubectl -n <ns> get pvc -l vm.kubevirt.io/name=app-server-cloned
# Shows the opaquely-named PVC, but under a label that maps it back.
```

### Pattern 2 — add an annotation for backup tooling that needs a plain-text owner

Labels are key/value-restricted; for a longer human-readable owner hint, use annotations:

```yaml
metadata:
  annotations:
    vm.kubevirt.io/owner-vm: app-server-cloned
    vm.kubevirt.io/source-snapshot: weekly-backup-2026-03-12
```

Annotations do not index for label selectors, but reporting / audit tools can pick them up through API queries.

### Pattern 3 — query by DataVolume source to infer ownership

The DataVolume (which owns the PVC) records its source in `.spec.source` — the snapshot, clone source, or URL. Querying from the VM → DataVolume → PVC is straightforward:

```bash
VM=app-server-cloned
NS=my-project

# Find the DataVolumes owned by the VM via their labels or controller reference.
kubectl -n "$NS" get dv -o json | \
  jq -r --arg vm "$VM" '.items[]
         | select(.metadata.ownerReferences[]?.name == $vm)
         | "\(.metadata.name)  ← source: \(.spec.source | keys[0])"'

# And the PVCs those DataVolumes are backing.
kubectl -n "$NS" get pvc -o json | \
  jq -r '.items[]
         | select(.metadata.ownerReferences[]?.kind == "DataVolume")
         | "\(.metadata.name)  ← DV: \(.metadata.ownerReferences[0].name)"'
```

The ownerReference chain is the reliable way to say "this PVC belongs to this DataVolume, which belongs to this VM" even when the names are not informative.

### Pattern 4 — rename after the clone completes

If a human-readable PVC name is essential (some storage tooling cannot parse labels), **create a new PVC from the restored one and copy the data**. Direct rename of a PVC is not supported — PVC names are immutable — but a snapshot-and-restore cycle inside the cluster can produce a differently-named PVC:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: tmp-snapshot
  namespace: <ns>
spec:
  source:
    persistentVolumeClaimName: restore-abcd...
  volumeSnapshotClassName: <your-class>
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-server-cloned-disk           # the human-readable target name
  namespace: <ns>
spec:
  dataSource:
    name: tmp-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  # ... rest of the PVC spec ...
```

After the target PVC is `Bound`, update the VM's volume reference to the new PVC and delete both the temporary snapshot and the original `restore-<hash>` PVC. This is heavy-handed — lots of copy and two rounds of pod restart — so prefer labels + ownerReference queries for everyday traceability.

## Diagnostic Steps

List PVCs and see which ones are `restore-*`:

```bash
kubectl get pvc -A -o \
  custom-columns='NS:.metadata.namespace,NAME:.metadata.name,SIZE:.status.capacity.storage,CLASS:.spec.storageClassName' | \
  awk 'NR==1 || /^\S+\s+restore-/'
```

For each `restore-*` PVC, trace back to the owning VM through the DataVolume ownerReference:

```bash
NS=<ns>
PVC=<restore-pvc-name>

# PVC's controller DV name.
DV=$(kubectl -n "$NS" get pvc "$PVC" \
       -o jsonpath='{.metadata.ownerReferences[0].name}')
echo "PVC $PVC -> DV $DV"

# DV's owner VM (or VMClone / VMRestore).
OWNER=$(kubectl -n "$NS" get dv "$DV" \
          -o jsonpath='{.metadata.ownerReferences[0].kind} {.metadata.ownerReferences[0].name}')
echo "DV $DV -> $OWNER"
```

The chain gives the full lineage even without human-readable PVC names.

Label the existing `restore-*` PVCs so future queries are index-based:

```bash
for pvc in $(kubectl -n "$NS" get pvc -o name | grep restore-); do
  # Identify owner through the chain above, then:
  kubectl -n "$NS" label "$pvc" vm.kubevirt.io/name=<vm-name> --overwrite
done
```

Once labelled, `kubectl get pvc -l vm.kubevirt.io/name=<vm>` produces the clear view the RFE will eventually deliver natively.
