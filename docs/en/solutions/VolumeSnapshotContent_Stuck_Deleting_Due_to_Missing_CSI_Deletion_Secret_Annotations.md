---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VolumeSnapshotContent Stuck Deleting Due to Missing CSI Deletion-Secret Annotations
## Issue

`VolumeSnapshot` and `VolumeSnapshotContent` objects created by an external orchestrator (a third-party backup product, an in-house snapshot scheduler, or any controller that builds `VolumeSnapshotContent` directly via the API) accumulate in a `Terminating` / pending-delete state. The CSI driver targeted by these snapshots requires authentication against the storage backend, but the stuck `VolumeSnapshotContent` objects have a `deletionTimestamp` set and never finish deletion. Side effects observed cluster-wide:

- the `csi-snapshotter` sidecar logs repeated `failed to delete snapshot content` errors,
- the api-server records aggressive client-side throttling against the snapshot CRDs,
- unrelated PVC provisioning slows down because the same CSI controller queue is saturated.

## Root Cause

To delete a snapshot from a backend that needs credentials, the upstream `csi-snapshotter` reads the credential reference from two annotations on the `VolumeSnapshotContent`:

- `snapshot.storage.kubernetes.io/deletion-secret-name`
- `snapshot.storage.kubernetes.io/deletion-secret-namespace`

The standard snapshot-controller flow injects these annotations automatically, copying them from the `VolumeSnapshotClass.parameters` block (`csi.storage.k8s.io/snapshotter-secret-name` / `-namespace`). When an external workflow constructs the `VolumeSnapshotContent` directly — bypassing the snapshot-controller — those annotations are absent. The CSI driver has no Secret to authenticate with, so every delete attempt fails with `Failed to get storage provider from secrets, no secrets have been provided`. The snapshot-controller retries indefinitely, draining its rate-limit token bucket and starving every other CSI request through the same controller.

A representative `VolumeSnapshotContent` is annotated only with the standard markers and lacks the deletion-secret pair:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  annotations:
    snapshot.storage.kubernetes.io/allow-volume-mode-change: "true"
    snapshot.storage.kubernetes.io/volumesnapshot-being-deleted: "yes"
    # deletion-secret-name and deletion-secret-namespace are MISSING
  deletionTimestamp: "2026-03-22T00:45:07Z"
  deletionGracePeriodSeconds: 0
  name: snapshot-copy-example-content
```

## Resolution

The durable fix lives outside the cluster: the external orchestrator must inject the deletion-secret annotation pair on every `VolumeSnapshotContent` it creates. Owners of that orchestrator should mirror what the standard snapshot-controller does — copy `csi.storage.k8s.io/snapshotter-secret-name` / `-namespace` from the relevant `VolumeSnapshotClass.parameters` into the `VolumeSnapshotContent.metadata.annotations` at creation time.

While that is being shipped, unblock the cluster by annotating the orphaned objects in place. The annotation values come from the `VolumeSnapshotClass` the snapshots were created against — the same Secret the CSI driver uses for the create path is generally the right Secret for the delete path.

1. Identify the snapshot-creation Secret used by the relevant CSI driver:

   ```bash
   kubectl get volumesnapshotclass <class> -o yaml
   ```

   Inside `spec.parameters` look for two keys:

   ```text
   csi.storage.k8s.io/snapshotter-secret-name: <secret-name>
   csi.storage.k8s.io/snapshotter-secret-namespace: <secret-namespace>
   ```

2. Annotate one stuck `VolumeSnapshotContent` to validate end-to-end:

   ```bash
   kubectl annotate volumesnapshotcontent <vsc-name> \
     snapshot.storage.kubernetes.io/deletion-secret-name=<secret-name> \
     snapshot.storage.kubernetes.io/deletion-secret-namespace=<secret-namespace>
   ```

   The `VolumeSnapshotContent` should disappear within a snapshot-controller resync interval (seconds to a couple of minutes). If it doesn't, check the `csi-snapshotter` sidecar log for the next failure mode — usually a stale Secret reference, an account that lost permissions, or a backend that already lost the snapshot.

3. Bulk-annotate the rest once one succeeds:

   ```bash
   for vsc in $(kubectl get volumesnapshotcontent \
       -o jsonpath='{range .items[?(@.metadata.deletionTimestamp)]}{.metadata.name}{"\n"}{end}'); do
     kubectl annotate volumesnapshotcontent "$vsc" \
       snapshot.storage.kubernetes.io/deletion-secret-name=<secret-name> \
       snapshot.storage.kubernetes.io/deletion-secret-namespace=<secret-namespace> \
       --overwrite
   done
   ```

This is a workaround, not a fix. The throttling and the slow PVC provisioning will return the next time the orchestrator creates a fresh batch of `VolumeSnapshotContent` without the annotations. Track the upstream change separately and re-test once that ships.

## Diagnostic Steps

Confirm the failure pattern before annotating anything. The signature is "stuck delete + missing annotation pair + repeated `no secrets have been provided` in the sidecar log":

```bash
# 1. List VolumeSnapshotContent that have a deletionTimestamp but won't go away
kubectl get volumesnapshotcontent \
  -o custom-columns='NAME:.metadata.name,DELETED:.metadata.deletionTimestamp' \
  | grep -v '<none>'

# 2. For one of them, confirm the deletion-secret annotation pair is absent
kubectl get volumesnapshotcontent <vsc-name> -o yaml \
  | grep -E 'deletion-secret-(name|namespace)' || echo "annotations missing"

# 3. Tail the csi-snapshotter sidecar that owns this driver's snapshots
kubectl -n <csi-driver-ns> logs <csi-controller-pod> -c csi-snapshotter --tail=200 \
  | grep -E 'failed to delete snapshot content|no secrets have been provided'

# 4. Watch for client-side throttling on the snapshot path
kubectl -n <csi-driver-ns> logs <csi-controller-pod> -c csi-snapshotter --tail=200 \
  | grep -E 'Waited before sending request.*DELETE.*VolumeSnapshotContent'
```

If all four signals match, the workaround above resolves the deadlock for the existing objects. If only signals 3 and 4 are present without signal 2, the missing-annotation case is not the root cause — investigate whether the configured Secret is empty, expired, or referenced from the wrong namespace.
