---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Changing a StorageClass's fsType — StorageClass Objects Are Immutable, Recreate Instead
## Issue

A CSI-backed StorageClass provisions PersistentVolumes with a default `fsType` (commonly `ext4`). Operators want to change that default for future PVs — for example, to `xfs` for a workload that expects xfs features, or to a vendor-specific filesystem for performance. The question is whether the change can be applied as a day-2 operation and what happens to existing PVs when it is.

`kubectl edit sc <name>` refuses to save changes to `spec.parameters` fields with a helpful but curt error:

```text
The StorageClass "<name>" is invalid:
  parameters: Forbidden: updates to parameters are forbidden.
```

## Root Cause

`StorageClass` objects are **immutable** in `spec.parameters`, `spec.provisioner`, and several other fields. This is a deliberate Kubernetes design decision: PVs bound to a StorageClass carry a reference back to it, and changing the StorageClass's parameters in place could create ambiguity about what guarantees those existing PVs actually have. Binding a PV to the name while the parameters mean something different would lead to confusion about what has been provisioned.

The supported pattern to change parameters is **delete the StorageClass and recreate it** with the new configuration. Deleting a StorageClass object does **not** delete the PVs already provisioned against it — those PVs continue to exist, keep their data, and remain bound to their PVCs. Only the StorageClass object itself is replaced; PVs that were provisioned from it before the deletion keep their original parameters; PVs provisioned after the recreation get the new parameters.

The side effect to be aware of: the storage provisioned through this StorageClass becomes **heterogeneous**. Some PVs will have the old `fsType`, others the new one. That is usually acceptable, but any tooling that assumes "every PV on SC `fast-block` is xfs" has to tolerate the transition period.

## Caveat: operator-managed StorageClasses

Some CSI operators create and own their StorageClass objects. Deleting an operator-managed SC causes the operator to recreate it from its own desired state — so your edits get reverted as soon as the operator reconciles. Identify operator-managed StorageClasses before trying this procedure:

```bash
kubectl get storageclass <name> -o jsonpath='{.metadata.ownerReferences}{"\n"}'
```

If the output lists an ownerReference (often a CSIDriver or a CSI operator CR), the SC is not safely hand-modifiable. Instead, change the underlying CR's desired state so the operator renders the SC with the new parameters. The specific shape depends on the operator.

For **manually-created** StorageClasses (no ownerReference), the recreation procedure below is the supported path.

## Resolution

### Procedure: backup, delete, recreate

**Step 1 — back up the current StorageClass spec.** Strip ephemeral fields so the backup can be cleanly re-applied:

```bash
SC=<storageclass-name>
kubectl get storageclass "$SC" -o yaml | \
  yq 'del(.metadata.creationTimestamp, .metadata.resourceVersion,
          .metadata.uid,             .metadata.generation,
          .metadata.managedFields)' > sc-backup.yaml
```

Inspect `sc-backup.yaml` to verify the file is complete (has `provisioner`, `parameters`, `reclaimPolicy`, `volumeBindingMode`, etc.).

**Step 2 — edit `sc-backup.yaml` to apply the new parameters:**

```yaml
# sc-backup.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-block
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: csi.vsphere.vmware.com
parameters:
  fsType: xfs                    # was: ext4
  storagepolicyname: "gold-tier"
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

**Step 3 — delete the existing StorageClass**. Existing PVs / PVCs are unaffected:

```bash
kubectl delete storageclass "$SC"

# Confirm the PVs still exist and stay Bound.
kubectl get pv | grep "$SC"
```

**Step 4 — apply the modified spec:**

```bash
kubectl apply -f sc-backup.yaml
```

**Step 5 — verify**. Create a small test PVC against the class and check the resulting PV's parameters:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fstype-test
  namespace: default
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
  storageClassName: $SC
EOF

kubectl get pvc fstype-test -o yaml | yq '.status.phase'
# Should bind within seconds.

PV=$(kubectl get pvc fstype-test -o jsonpath='{.spec.volumeName}')
kubectl get pv "$PV" -o jsonpath='{.spec.csi.fsType}{"\n"}'
# xfs
```

If the PV's `fsType` reflects the new value, the change took effect.

### Mixed fsType consideration

After the recreation, new PVs on this SC will have the new `fsType`; old PVs keep their original. This is usually fine — `fsType` is a provision-time choice — but audit or policy tooling that assumes uniform type on a SC should be updated. If uniformity really matters for the workload (e.g. a stateful application that expects specific file-system semantics), consider creating a second StorageClass with a different name for the new type and migrating PVCs gradually by cloning data onto fresh PVs.

### Default-class flag and alpha annotations

If the StorageClass was the cluster default (carried `storageclass.kubernetes.io/is-default-class: "true"`), make sure the replacement also carries the annotation — a brief window where no default class exists can cause PVC creation failures on workloads that don't specify a storage class explicitly.

## Diagnostic Steps

Before attempting the procedure, confirm the StorageClass is not managed by an operator:

```bash
kubectl get storageclass <name> -o json | \
  jq '{ownerReferences: .metadata.ownerReferences, csiOperator: .metadata.annotations["storageclass.kubernetes.io/managed-by"] // "(none)"}'
```

Empty `ownerReferences` and no `managed-by` annotation → safe to hand-modify. Otherwise, modify through the owning CR instead.

Capture a snapshot of PVs that were provisioned by the SC (so you can confirm they survive the recreation):

```bash
kubectl get pv -o custom-columns='NAME:.metadata.name,SC:.spec.storageClassName,PHASE:.status.phase' | \
  grep "^\S\+\s\+<sc-name>\s"
```

After the StorageClass is deleted, re-run the same query; the PVs should still be listed, in `Bound` phase. Their PVCs and the workloads using them should report no disruption — `kubectl get pod -A | grep -v Running` should not grow as a result of the SC change.

After recreation and a test PVC, confirm the new PV's parameters match the intended change. The old PVs retain their original parameters; this is expected.

For operators that resist direct modification, the specific CR path varies; consult the storage operator's own documentation for how its generated StorageClass's `fsType` is configured.
