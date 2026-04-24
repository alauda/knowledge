---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An operator-managed `StorageClass` (for example a Ceph RBD class provisioned by the ACP `storagesystem_ceph` stack) shows up as the cluster default. Attempts to clear the default flag — patching the `storageclass.kubernetes.io/is-default-class` annotation to `"false"` via `kubectl patch`, editing the object directly, or toggling it from the UI — all appear to succeed momentarily, but within seconds the annotation reverts to `"true"` and the class is again the default.

## Root Cause

The annotation on the `StorageClass` object is not the source of truth. The class is shipped by a higher-level operator (the one reconciling the Ceph-backed storage system) from a spec field that declares "this class should be the cluster default". On every reconcile tick the operator reads that spec and writes the annotation back. Any edit made directly against the `StorageClass` is therefore transient — the next reconciliation loop overwrites it within the operator's resync interval, which is why the flag "snaps back" no matter how it is flipped.

Fixing this at the annotation layer is structurally wrong; the edit has to happen at the layer the operator actually reads from. Additionally, if a GitOps controller (Argo CD or similar) owns the storage-system CR, direct edits against that CR will also be reverted — in that case the change must be made at the git source of truth, or the controller must be paused while the correction is applied.

## Resolution

### Preferred: update the Ceph storage system CR managed by ACP

Ceph-backed block and filesystem classes in ACP are provisioned by the `storage/storagesystem_ceph` operator from a cluster-scoped CR that describes the Ceph cluster and the pools/classes it should expose. The "is this the default class" decision lives on that CR, not on the `StorageClass` itself.

Edit the managed storage-system resource and set the block-pool entry so that it does not declare itself default. Concretely, locate the `managedResources.cephBlockPools` section (or the pool entry that backs the class being deprecated as default) and remove the `defaultStorageClass: true` line — or set it to `false`, depending on the operator schema in use. After the CR is saved, the operator's next reconcile will rewrite the `StorageClass` annotation to `"false"` and stop reverting it.

```yaml
# cluster-scoped CR managed by the Ceph storage operator
spec:
  managedResources:
    cephBlockPools: {}        # no default requested, or:
    # cephBlockPools:
    #   defaultStorageClass: false
```

If the cluster uses a different class as the intended default, set that one explicitly — either by flipping `defaultStorageClass: true` on the correct pool entry, or (if the new default is not Ceph-managed at all) by adding the annotation directly on that other `StorageClass` once the Ceph operator has released control of its own class.

If a GitOps controller manages the storage-system CR, make the change in the source repository and let the sync apply it. Do not edit the live CR if sync is enabled — the controller will revert. If a one-off correction must be applied immediately, pause the Argo CD `Application` (or set `syncPolicy.automated: null`), apply the fix, then restore the sync mode after verifying the storage operator has settled.

### Fallback: raw Kubernetes annotation, only when no operator owns the class

If a `StorageClass` is **not** managed by an operator — for example a hand-written class for a CSI driver that no higher-level controller tracks — the standard Kubernetes annotation is authoritative and can be flipped directly:

```bash
kubectl patch storageclass <name> \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
```

This path will not stick for operator-managed classes because of the reconcile loop described above; use it only when the class has no owning controller.

## Diagnostic Steps

Confirm which class currently carries the default flag:

```bash
kubectl get storageclass
```

The class whose row shows `(default)` is the one carrying the annotation. Then inspect the annotations on that specific object to confirm the flag and see whether it has an owner:

```bash
kubectl get storageclass <name> -o yaml | \
  grep -E 'is-default-class|ownerReferences' -A3
```

If the output contains an `ownerReferences` block pointing at a storage-system CR (or if the object has labels like `app.kubernetes.io/managed-by: ...` naming the Ceph operator), the annotation is operator-controlled — do not fight it at the `StorageClass` level, go to the CR.

Watch the annotation get rewritten to confirm the reconcile loop is the cause:

```bash
kubectl patch storageclass <name> \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
kubectl get storageclass <name> \
  -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}'
# … wait a reconcile interval (typically 30s–5m) …
kubectl get storageclass <name> \
  -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}'
```

If the second read shows `true` again, the fix must move up to the storage-system CR as described above.

If a GitOps controller is suspected of reverting changes to the storage-system CR, check the `Application` resource that tracks it:

```bash
kubectl -n <argocd-ns> get applications.argoproj.io -o wide
```

Look for an application whose target namespace matches the storage operator and whose sync status was `OutOfSync` briefly after the edit — that confirms the revert came from the GitOps layer, not from the storage operator.
