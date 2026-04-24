---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Creating a `VolumeSnapshot` in the cluster takes an unexpectedly long time — typically 3–5 minutes — and sometimes times out entirely:

```text
$ kubectl create -f vs.yaml
volumesnapshot.snapshot.storage.k8s.io/app-snap created

# …5 minutes later…
$ kubectl describe volumesnapshot app-snap
Status:
  Bound Volume Snapshot Content Name:  (not set)
  Ready To Use:                         false
  Error:
    Message:   Failed to set default snapshot class with error: ...
    Time:      2026-02-10T11:05:00Z
```

Unlike the usual failure modes (missing VolumeSnapshotClass, driver unavailable, source PVC not ready), the underlying CSI driver is healthy — if you delete the stalled VolumeSnapshot and create a fresh one a few minutes later, it eventually succeeds. The latency appears to come from **how soon the controller notices** the new VolumeSnapshot, not from the snapshot creation itself.

## Root Cause

The `snapshot-controller` (and the companion sidecar that drives the CSI driver) watches the API server for changes to `VolumeSnapshot` and `VolumeSnapshotContent` objects. Each watch connection carries a `resourceVersion`: the API server replays events newer than that version to the controller, which reacts to each event as it arrives.

If the controller's watch fails — often with the error `too old resource version: 12345 (67890)` logged — the controller stops receiving live events and falls back to a **full resync**, re-listing every VolumeSnapshot and every VolumeSnapshotContent. The resync interval defaults to 5 minutes. During the interval nothing new gets processed, which is why fresh requests sit unresolved for minutes.

What makes the watch fail: the API server has a bounded watch-cache budget. When the cache is under pressure — large numbers of objects of the watched kind, many of them stale (`ReadyToUse: true` with a `0` restoreSize, no VolumeSnapshot referent, aged by hundreds of days) — the etcd/cache history gets compacted past the watch's resource version. The watch sees `too old resource version`, disconnects, and tries to re-establish. Under steady load, the re-established watch also disconnects at the next compaction. The controller never stays connected long enough to process events in real time.

The stale VolumeSnapshotContent objects typically arrive via:

- Backup products that provision a snapshot, copy it off-cluster, and leave a "zero size placeholder" VSC behind because their cleanup handler didn't run.
- Manual experiments that created VolumeSnapshot objects, had them fail, and left the VSC behind because the VSC's `deletionPolicy` was set to `Retain`.
- CSI drivers that in older versions created VSCs with no `driverHandle` back-reference, so snapshot-controller cannot reconcile or delete them through the normal path.

The fix is to identify and delete those stale objects. Once the controller's watch cache holds a manageable set of active VSCs, the watch stays healthy, events flow, and fresh VolumeSnapshots complete in seconds.

## Resolution

### Step 1 — confirm the watch-based failure mode

Check the snapshot-controller logs for `too old resource version`:

```bash
# Locate the snapshot-controller Deployment. On ACP with the snapshot
# moduleplugin installed, it typically runs in kube-system or a dedicated ns:
kubectl get deploy -A -o=jsonpath='{range .items[?(@.spec.template.spec.containers[*].name=="snapshot-controller")]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'

NS=<snapshot-controller-ns>
kubectl -n "$NS" logs deploy/snapshot-controller --tail=500 | \
  grep -E 'too old resource version|reflector|resync'
```

A log line containing `too old resource version` followed by `watch: reflector: ... resource version: too old` is the definitive match.

### Step 2 — enumerate and categorise VolumeSnapshotContents

```bash
kubectl get volumesnapshotcontent -A -o=custom-columns='NAME:.metadata.name,READY:.status.readyToUse,RESTORESIZE:.status.restoreSize,VOLSNAPSHOT:.spec.volumeSnapshotRef.name,AGE:.metadata.creationTimestamp' | \
  awk 'NR==1 || $3 == "0" || $4 == ""'
```

The filter keeps:

- The header row.
- Rows where `RESTORESIZE` is 0 (a zero-size VSC carries no data).
- Rows where `VOLSNAPSHOT` is empty (the parent VolumeSnapshot has been deleted, leaving the VSC orphaned).

Cross-reference the `VOLSNAPSHOT` value (namespace + name) with the `VolumeSnapshot` resource itself:

```bash
# For each suspicious VSC, confirm the VolumeSnapshot still exists:
for vsc in $(kubectl get volumesnapshotcontent -o=jsonpath='{range .items[?(@.spec.volumeSnapshotRef.name!="")]}{.metadata.name} {.spec.volumeSnapshotRef.namespace}/{.spec.volumeSnapshotRef.name}{"\n"}{end}' | awk '$3 == 0 {print}'); do
  vs_ref=$(echo $vsc | awk '{print $2}')
  vsc_name=$(echo $vsc | awk '{print $1}')
  ns=$(echo $vs_ref | cut -d/ -f1)
  name=$(echo $vs_ref | cut -d/ -f2)
  if ! kubectl -n "$ns" get volumesnapshot "$name" >/dev/null 2>&1; then
    echo "$vsc_name is orphaned (parent $vs_ref is gone)"
  fi
done
```

### Step 3 — delete the orphans

One at a time. After each deletion, pause ~5 seconds so the controller can process the change:

```bash
for vsc in <orphan-1> <orphan-2> <orphan-3>; do
  kubectl delete volumesnapshotcontent "$vsc"
  sleep 5
done
```

If a VSC resists deletion (has a finalizer that the snapshot-controller is not processing because its watch is broken), remove the finalizer manually after confirming the VSC is genuinely stale:

```bash
kubectl patch volumesnapshotcontent <name> --type=json -p='
[{"op":"remove","path":"/metadata/finalizers"}]'
```

**Do not** remove finalizers on VSCs that back a VolumeSnapshot you still need — the finalizer is what blocks the underlying storage from being deleted before the snapshot is no longer needed.

### Step 4 — verify snapshot-controller recovery

Watch the log until the `too old resource version` lines stop, then test a fresh VolumeSnapshot:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: probe-snapshot
  namespace: default
spec:
  volumeSnapshotClassName: <your-class>
  source:
    persistentVolumeClaimName: <existing-pvc>
EOF

# Should bind within a few seconds on a healthy controller:
kubectl -n default wait --for=jsonpath='{.status.readyToUse}'=true \
  volumesnapshot/probe-snapshot --timeout=60s
```

A return within 60 seconds is a healthy state. If it still takes minutes, either the controller is still re-syncing (wait another cycle) or there is a separate CSI-level issue.

### Step 5 — clean up the producer

A one-time cleanup is not enough if whatever produced the orphans keeps producing them. Check for:

- **A backup / data-protection product** whose snapshot lifecycle is incomplete. Work with the product's cleanup knob to reclaim snapshots after transfer.
- **A CSI driver bug** that leaves the VSC behind when a snapshot is deleted. Check the driver vendor's release notes.
- **A manual process** (engineer-run snapshots from runbooks) that does not clean up — update the runbook with an explicit `kubectl delete volumesnapshotcontent` step.

## Diagnostic Steps

Count VolumeSnapshot vs VolumeSnapshotContent:

```bash
echo -n "VolumeSnapshot:        "; kubectl get volumesnapshot -A --no-headers | wc -l
echo -n "VolumeSnapshotContent: "; kubectl get volumesnapshotcontent --no-headers | wc -l
```

On a healthy cluster these two numbers are close to equal (each VolumeSnapshot has one VolumeSnapshotContent). A large disparity — VSC count 10× or more the VS count — is the signature of orphaning at scale.

Check VSC age distribution:

```bash
kubectl get volumesnapshotcontent \
  -o=jsonpath='{range .items[*]}{.metadata.creationTimestamp}{"\n"}{end}' | \
  awk -F'-' '{print $1,$2}' | sort | uniq -c
```

A pile of VSCs from months ago that nobody is watching is a strong signal.

Measure end-to-end VolumeSnapshot latency by timing a fresh create:

```bash
t0=$(date +%s)
kubectl apply -f <sample-vs>.yaml
kubectl -n <ns> wait --for=jsonpath='{.status.readyToUse}'=true \
  volumesnapshot/<name> --timeout=300s
t1=$(date +%s)
echo "Elapsed: $((t1-t0)) seconds"
```

Latency under 30 seconds: healthy. Latency of 5 minutes exactly: resync-cycle match, Step 1's confirmation. Latency that varies wildly: a mix of watch-cache issues and CSI-driver issues — investigate CSI driver logs in parallel.

Watch the snapshot-controller metrics for reconnect counts:

```bash
NS=<snapshot-controller-ns>
kubectl -n "$NS" exec deploy/snapshot-controller -- \
  wget -qO- http://localhost:8080/metrics 2>/dev/null | \
  grep -E 'reflector_watch|watcher_errors_total|resync_period'
```

Frequent `reflector_watch` restarts are the metric-level signature. The count should stabilise once Step 3 is done.
