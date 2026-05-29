---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500790
---

# VolumeSnapshot creation latency from stale VolumeSnapshotContent objects on ACP

## Issue

On Alauda Container Platform with the `snapshot` ModulePlugin installed (`ClusterPluginInstance/snapshot`, chart `chart-volume-snapshot` v4.4.0-beta.4), the upstream Kubernetes CSI snapshot API group `snapshot.storage.k8s.io` is registered on the cluster: `VolumeSnapshot` (namespaced), `VolumeSnapshotContent` (cluster-scoped), and `VolumeSnapshotClass` (cluster-scoped) all serve at `v1`. The `snapshot-controller` Deployment runs in the `cpaas-system` namespace (image `registry.alauda.cn:60080/3rdparty/k8scsi/snapshot-controller:v8.5.0-bea122af`, upstream `kubernetes-csi/external-snapshotter` v8.5.0), watching both `VolumeSnapshot` and `VolumeSnapshotContent` objects and reconciling the binding by driving the CSI driver to provision the backing snapshot.

Symptom: creating a `VolumeSnapshot` resource takes an unexpectedly long time — frequently several minutes — and occasionally times out before the snapshot becomes `READYTOUSE=true`. In a healthy state on this cluster the same workflow completes in seconds (a freshly created `VolumeSnapshot` against the `topolvm-snapshot` `VolumeSnapshotClass` reports `READYTOUSE=true` and `RESTORESIZE=1Gi` within about four seconds), so multi-minute latency signals that the snapshot-controller is no longer processing new requests through its watch loop and is instead progressing only on its periodic informer resync.

## Root Cause

The snapshot-controller is a single upstream `external-snapshotter` binary (v8.5.0 on ACP), running in the `cpaas-system` namespace with container args `--v=5 --leader-election=true --http-endpoint=:8080` — no `--resync-period` override is set, so the in-binary `SharedInformerFactory` default applies. When the controller's reflector on `VolumeSnapshotContent` cannot stay attached to the apiserver watch — for example because the requested `resourceVersion` has aged out of the apiserver watch cache and the apiserver returns `Expired: too old resource version` — client-go's reflector stops the watch and falls back to a periodic full LIST relist. While the watch is down, real-time updates are not delivered to the controller; new `VolumeSnapshot` objects are only picked up on the next forced resync tick. Observed on this cluster, the snapshot-controller's `Forcing resync` events on the `external-snapshotter` informer factory occur on a fixed 900-second (15-minute) cadence, so a newly created `VolumeSnapshot` can sit unprocessed until the next resync rather than being handled immediately.

An excessive number of stale, unbound, or invalid `VolumeSnapshotContent` objects amplifies this pattern: the larger the working set the watch is replaying, the more pressure on watch-cache liveness, and the more likely the relist path is what's actually driving snapshot creation. Stale `VolumeSnapshotContent` objects are easy to identify by inspecting the listing — `RESTORESIZE` of `0` (combined with an old `AGE` and a missing or dangling `VolumeSnapshot` reference) marks an entry that no longer corresponds to a real backing snapshot.

## Resolution

Identify the stale `VolumeSnapshotContent` objects, confirm they are genuinely orphaned, and delete them. On ACP, `VolumeSnapshotContent` is a standard upstream CRD operated on with `kubectl`; the declared printer columns are (in order) `ReadyToUse`, `RestoreSize`, `DeletionPolicy`, `Driver`, `VolumeSnapshotClass`, `VolumeSnapshot`, `VolumeSnapshotNamespace`, `Age`, and `kubectl get` prepends `NAME` from `.metadata.name` and uppercases the rest, so the live table header is `NAME READYTOUSE RESTORESIZE DELETIONPOLICY DRIVER VOLUMESNAPSHOTCLASS VOLUMESNAPSHOT VOLUMESNAPSHOTNAMESPACE AGE`.

List the objects and pick out those with `RESTORESIZE=0`. The third whitespace-delimited column in the default table is `RESTORESIZE`, so an `awk` filter on `$3=="0"` keeps the header line plus only the candidate rows:

```bash
kubectl get volumesnapshotcontent | awk 'NR==1 || $3=="0"'
```

Before deleting, confirm each candidate is genuinely stale: inspect its age, its `RESTORESIZE`, and whether its `.spec.volumeSnapshotRef` still points at a live `VolumeSnapshot` object. The `kubectl get` table already shows the bound `VolumeSnapshot` name and namespace columns; cross-check by retrieving the `VolumeSnapshot` it references:

```bash
kubectl get volumesnapshotcontent <name> -o yaml | grep -A4 volumeSnapshotRef
kubectl -n <vs-namespace> get volumesnapshot <vs-name>
```

Then delete the confirmed-stale `VolumeSnapshotContent` objects. With the cluster-default `topolvm-snapshot` `VolumeSnapshotClass` (driver `topolvm.cybozu.com`, deletion policy `Delete`), the snapshot-controller responds to the delete event in real time when its watch is healthy — verified end-to-end on this cluster as the bound `VolumeSnapshotContent` being removed within a few seconds of deleting its parent `VolumeSnapshot`:

```bash
kubectl delete volumesnapshotcontent <name>
```

Once the stale entries are cleared and the watch can stay attached to a smaller, healthier set, new `VolumeSnapshot` creations are processed through the live watch path again rather than waiting for the periodic resync, and creation latency returns to the seconds-scale baseline.

## Diagnostic Steps

Confirm the `snapshot` capability is in fact installed on the cluster — the CSI snapshot CRDs and the `snapshot-controller` Deployment only exist when the ACP `snapshot` ModulePlugin / `ClusterPluginInstance/snapshot` is active. The CRDs serve at `snapshot.storage.k8s.io/v1` and the controller Deployment lives in `cpaas-system` with image `snapshot-controller:v8.5.0-bea122af`:

```bash
kubectl api-resources --api-group=snapshot.storage.k8s.io
kubectl -n cpaas-system get deploy snapshot-controller
kubectl -n cpaas-system get deploy snapshot-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

Inspect the `snapshot-controller` Deployment's container args to confirm what flags govern its reflector behavior. On ACP the chart ships only `--v=5 --leader-election=true --http-endpoint=:8080`, with no `--resync-period` override, so the upstream `SharedInformerFactory` default takes effect:

```bash
kubectl -n cpaas-system get deploy snapshot-controller \
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}'
```

Check the `snapshot-controller` logs for evidence that the controller is progressing via periodic resyncs rather than via real-time watch events. Recurring `Forcing resync` log lines from the `external-snapshotter` informer factory on a fixed cadence indicate the controller is being driven by the reflector resync — not by individual watch events for newly created `VolumeSnapshot` resources:

```bash
kubectl -n cpaas-system logs deploy/snapshot-controller --tail=2000 \
  | grep -E 'Forcing resync|Watch close|too old resource version'
```

List `VolumeSnapshotContent` and identify the stale candidates by `RESTORESIZE`, `AGE`, and `VOLUMESNAPSHOT` / `VOLUMESNAPSHOTNAMESPACE` columns. Rows where `RESTORESIZE` is `0` (column `$3` in the default table) with old age and no live `VolumeSnapshot` partner are the working set the cleanup targets:

```bash
kubectl get volumesnapshotcontent
kubectl get volumesnapshotcontent | awk 'NR==1 || $3=="0"'
```
