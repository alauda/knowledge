---
title: PVC restore from VolumeSnapshot stays Pending with ProvisioningFailed when the snapshot is missing
component: storage
scenario: troubleshooting
tags: [pvc, volumesnapshot, csi-provisioner, topolvm]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# PVC restore from VolumeSnapshot stays Pending with ProvisioningFailed when the snapshot is missing

## Issue

A PersistentVolumeClaim that names a `VolumeSnapshot` as its `spec.dataSource` stays `Pending` indefinitely. The object record shows a `Normal` event with reason `Provisioning` and message `External provisioner is provisioning volume for claim "<ns>/<pvc>"`, immediately followed by a `Warning` event with reason `ProvisioningFailed` and message `error getting handle for DataSource Type VolumeSnapshot by Name <snap-name>: error getting snapshot <snap-name> from api server: volumesnapshots.snapshot.storage.k8s.io "<snap-name>" not found` — observed on Alauda Container Platform with Kubernetes server `v1.34.5-1` against the default `topolvm-hdd` StorageClass (TopoLVM `v4.3.3` in namespace `nativestor-system`, whose `topolvm-controller` Deployment bundles the upstream `k8scsi/csi-provisioner` sidecar) [ev:c1].

The same failing pair of events keeps repeating against the same PVC on an exponential backoff until something changes upstream of the provisioner — the PVC itself is the trigger, not a one-shot reconcile [ev:c2][ev:c3].

## Root Cause

The PVC's `spec.dataSource` references a `snapshot.storage.k8s.io/VolumeSnapshot` object that does not exist in the PVC's namespace. The external CSI provisioner sidecar inside the storage driver controller cannot resolve a content handle for a `DataSource Type VolumeSnapshot` whose name returns `NotFound` from the API server, so it surfaces the failure as a `Warning/ProvisioningFailed` event on the PVC [ev:c1][ev:c2].

The provisioner controller's syncloop reschedules the same PVC on its workqueue and the failure repeats; in the controller log the same condition shows up as `controller.go:986] "Retrying syncing claim" key="<pvc-uid>" failures=N` followed by an `Unhandled Error` line with the same `not found` text, on a roughly `1s, 2s, 4s, 8s, 16s` exponential backoff for the first several attempts [ev:c2].

Because the workqueue entry is keyed by the PVC, the loop only stops when the PVC is removed from the API server — or when the named `VolumeSnapshot` is restored so the next retry can resolve a content handle. As long as the same PVC continues to exist with the same dangling `dataSource`, the warnings keep coming [ev:c3].

## Resolution

Recover the missing snapshot. If the `VolumeSnapshot` named in `spec.dataSource` should still exist, recreate it from the source `PersistentVolumeClaim` it was originally taken against; once the snapshot reaches `READYTOUSE=true` the existing PVC's next retry binds and the warnings stop [ev:c1].

```bash
kubectl -n <ns> get pvc <pvc> -o jsonpath='{.spec.dataSource}{"\n"}'
# Expected: a map with apiGroup=snapshot.storage.k8s.io, kind=VolumeSnapshot, name=<snap>

kubectl -n <ns> get volumesnapshot <snap>
# If NotFound, recreate it from the original source PVC:
cat <<EOF | kubectl apply -f -
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: <snap>
  namespace: <ns>
spec:
  volumeSnapshotClassName: topolvm-snapshot
  source:
    persistentVolumeClaimName: <source-pvc>
EOF
```

If the snapshot is genuinely gone and is not recoverable, delete the stuck PVC (and any Pod that was holding it as a `WaitForFirstConsumer` trigger). The provisioner workqueue entry is keyed by the PVC, so removing the PVC removes the entry; after the delete, no further `Retrying syncing claim` lines are emitted for that PVC and the event stream stops [ev:c3].

```bash
# Drop any consumer Pod first so the PVC isn't held in WaitForFirstConsumer
kubectl -n <ns> delete pod <consumer-pod>
kubectl -n <ns> delete pvc <pvc>
```

## Diagnostic Steps

Look at the recent events scoped to the affected PVC's namespace; the `Normal/Provisioning` + `Warning/ProvisioningFailed` pair is the canonical signature [ev:c1].

```bash
kubectl -n <ns> get events --sort-by=.lastTimestamp \
  --field-selector involvedObject.kind=PersistentVolumeClaim,involvedObject.name=<pvc>
```

Tail the `csi-provisioner` sidecar on the controller Deployment that fronts the StorageClass and grep for the PVC's UID; the `Retrying syncing claim` line plus the matching `Unhandled Error ... error getting handle for DataSource Type VolumeSnapshot by Name <snap>` is the in-process view of the same failure, and the `failures=N` counter shows the backoff is still active [ev:c2].

```bash
# For workloads on the default topolvm-hdd StorageClass:
kubectl -n nativestor-system logs \
  -l app.kubernetes.io/name=topolvm-controller \
  -c csi-provisioner --tail=200 \
  | grep -E '<pvc>|Retrying syncing claim'
```

Confirm the named `VolumeSnapshot` itself is the missing piece, not (for example) a snapshot stuck `READYTOUSE=false`. A clean `NotFound` response from the API server here matches the error string in the PVC event verbatim [ev:c1].

```bash
kubectl -n <ns> get volumesnapshot <snap-name>
kubectl -n <ns> get volumesnapshotcontent | grep <snap-name>
```

After the resolution step, observe that no new `Retrying syncing claim` lines appear for the affected PVC over a short window (~20s); silence in the provisioner log for that key is the positive signal that the workqueue entry has actually been dropped [ev:c3].

```bash
kubectl -n nativestor-system logs \
  -l app.kubernetes.io/name=topolvm-controller \
  -c csi-provisioner --since=30s \
  | grep -c '<pvc>'
# 0 = workqueue entry cleared.
```
