---
title: Recovering from a PVC online expansion that stalls between spec and status on ACP
component: storage
scenario: troubleshooting
tags: [pvc, storage, csi, topolvm, expansion, resize]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Recovering from a PVC online expansion that stalls between spec and status on ACP

## Issue

On Alauda Container Platform (kube v1.34.5, default `StorageClass` `topolvm-hdd` provisioned by `topolvm.cybozu.com`, the only Container Storage Interface (CSI) driver registered out of the box), a `PersistentVolumeClaim` (PVC) carries two separately-tracked size fields: `spec.resources.requests.storage` is the size the user is asking for, and `status.capacity.storage` is what the CSI stack has actually delivered down to the underlying volume [ev:c2_a]. After patching the request to a larger value the two fields can disagree for a window — `status.capacity` lags `spec.resources.requests.storage`, and during that window the filesystem mounted inside the pod also still reports the old size [ev:c2_b].

The corollary on the metrics side: kubelet exposes a per-mount `kubelet_volume_stats_capacity_bytes` series labeled by `namespace` and `persistentvolumeclaim`, scraped via the standard `monitoring.coreos.com` `ServiceMonitor` / `PodMonitor` machinery, and the value reported there tracks the live mounted filesystem — not `spec.resources.requests.storage` — so a stalled expansion shows up as a metric value that has not moved even though the PVC object claims the larger size [ev:c4_a].

## Root Cause

In-place expansion of a PVC requires the backing `StorageClass` to carry `allowVolumeExpansion: true`. The ACP default class `topolvm-hdd` does — visible in `kubectl get sc` as the `ALLOWVOLUMEEXPANSION` column reading `true` — so the request is accepted by the API server [ev:c1_a]. From there the CSI flow is the standard upstream two-phase resize: the external resizer calls `ControllerExpandVolume` against the controller plugin to grow the underlying volume, and the node plugin's `NodeExpandVolume` grows the filesystem on the node where the volume is currently mounted [ev:c9_b]. The PVC's `status.conditions` block carries a `Resizing` condition while the volume is being grown by the controller, and a separate `FileSystemResizePending` condition with the message `Waiting for user to (re-)start a pod to finish file system resize of volume on node.` once the controller side has finished but the node-side filesystem grow still needs the mount to be reopened [ev:c2_b].

A stall therefore has two distinct surfaces. Either the controller side never grew the underlying volume (the `Resizing` condition stays True and `status.capacity` never moves), or the controller side completed and the node side is waiting on a pod restart to actually resize the filesystem (`FileSystemResizePending` is True and the in-pod `df -h` still shows the old size while `status.capacity` may have already advanced) [ev:c9_b].

## Resolution

Request expansion by editing the PVC's `spec.resources.requests.storage` to a strictly larger quantity than the current value; never decrease the request [ev:c9_a]:

```bash
kubectl patch pvc -n <ns> <pvc-name> --type=merge \
 -p '{"spec":{"resources":{"requests":{"storage":"3Gi"}}}}'
```

Re-running the patch with the same value as the request currently held is a no-op for the controller — only a strictly larger request re-arms `ControllerExpandVolume`. The same patch shape also drives the recovery path when an earlier expansion stalled: bumping the request a small increment higher (for example 250Gi to 251Gi) is enough to re-trigger the full resize sequence [ev:c9_a].

After the patch, observe the two PVC fields and the condition block to confirm progress [ev:c2_a][ev:c2_b]:

```bash
kubectl get pvc -n <ns> <pvc-name> \
 -o jsonpath='{"spec.req="}{.spec.resources.requests.storage}{" status.cap="}{.status.capacity.storage}{" cond="}{.status.conditions}'
```

If the conditions show `FileSystemResizePending=True` with the message about waiting for a pod restart, the controller side has finished and the only remaining step is to recycle the pod that has the PVC mounted; the next `NodePublishVolume` will trigger the filesystem grow on the node [ev:c9_b]:

```bash
kubectl rollout restart statefulset -n <ns> <statefulset-name>
# or, for a bare Pod:
kubectl delete pod -n <ns> <pod-name>
```

## Diagnostic Steps

Confirm the StorageClass backing the PVC permits expansion before issuing a patch — a class without `allowVolumeExpansion: true` rejects the request at admission [ev:c1_a]:

```bash
kubectl get sc
# Look for ALLOWVOLUMEEXPANSION=true on the class named in pvc.spec.storageClassName.
```

Read the live `spec` vs `status` divergence and the conditions on the PVC; a non-empty `Resizing` or `FileSystemResizePending` condition pinpoints which side of the two-phase resize is in flight [ev:c2_b]:

```bash
kubectl get pvc -n <ns> <pvc-name> -o yaml | yq '{
  "request": .spec.resources.requests.storage,
  "capacity": .status.capacity.storage,
  "conditions": .status.conditions
}'
```

Locate the CSI node plugin pod on the same node as the workload and inspect its log for a resize event matching the PVC's underlying volume id; on ACP that plugin is the per-node `topolvm-node-<nodeIP>` pod in `nativestor-system` and the relevant container is `csi-topolvm-plugin` [ev:c7]:

```bash
NODE=$(kubectl get pod -n <ns> <pod-name> -o jsonpath='{.spec.nodeName}')
PLUGIN=$(kubectl get pods -n nativestor-system \
  -o jsonpath='{range .items[?(@.spec.nodeName=="'$NODE'")]}{.metadata.name}{"\n"}{end}' \
  | grep topolvm-node | head -1)
kubectl logs -n nativestor-system "$PLUGIN" -c csi-topolvm-plugin \
  | grep -E 'ResizeLV|expanded LV|resized'
```

A successful controller-side grow appears as a `lvservice request - ResizeLV ... requested=<bytes> current=<bytes>` log line followed by `Logical volume ... successfully resized.` and `expanded LV ... original status.currentSize=<old> status.currentSize=<new>`. If those lines are present but the in-pod filesystem is still small, the controller side is done and the stall is on the node-side `NodeExpandVolume` — restart the consuming pod and the filesystem will catch up to `status.capacity` on the next mount [ev:c9_b].

For the metrics-side cross-check, query the kubelet series scraped by any ACP Prometheus instance that watches the cluster (the `ServiceMonitor` / `PodMonitor` API group `monitoring.coreos.com` is registered on every ACP cluster) [ev:c4_a]:

```text
kubelet_volume_stats_capacity_bytes{namespace="<ns>", persistentvolumeclaim="<pvc-name>"}
```

The value of that series reflects the mounted filesystem, so a stall on the node side keeps the series at the pre-expansion byte count even while `kubectl get pvc` shows the larger `status.capacity` — the metric is the most direct signal that the node-side filesystem grow has not yet completed [ev:c4_a].
