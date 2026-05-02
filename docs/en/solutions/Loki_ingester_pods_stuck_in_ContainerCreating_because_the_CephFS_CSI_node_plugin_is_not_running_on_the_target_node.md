---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Loki components (`ingester`, `distributor`, `querier`) deployed on top of an ACP cluster that uses Rook-Ceph for shared storage stay stuck in `ContainerCreating`. The kubelet event log on the affected pods reports a CSI driver lookup miss:

```text
MountVolume.MountDevice failed for volume "pvc-...":
  kubernetes.io/csi: attacher.MountDevice failed to create newCsiDriverClient:
  driver name <namespace>.cephfs.csi.ceph.com not found in the list of registered CSI drivers
Unable to attach or mount volumes: unmounted volumes=[storage]
```

Listing the ingester StatefulSet shows the same pattern:

```bash
kubectl -n logging get pods
# loki-ingester-0     0/1   ContainerCreating   0   12m
# loki-distributor-…  0/1   ContainerCreating   0   12m
# loki-querier-…      0/1   ContainerCreating   0   12m
```

The Loki workload is healthy in every other respect — the only blocker is the missing CSI driver registration on the node the pods landed on.

## Root Cause

The `cephfs.csi.ceph.com` driver is registered on a node only by the `csi-cephfsplugin` DaemonSet pod that runs there. If the DaemonSet never schedules on a given node, the kubelet's internal driver registry never learns about CephFS and any pod with a CephFS-backed PVC will block at MountDevice with the error above.

Two scheduling controls inside Rook-Ceph decide whether `csi-cephfsplugin` lands on a node:

- The plugin DaemonSet inherits tolerations from the `CSI_PLUGIN_TOLERATIONS` value in the `rook-ceph-operator-config` ConfigMap. If a node carries a taint that is not covered by these tolerations, the DaemonSet is silently filtered out and the node is left without the driver.
- The DaemonSet may also be steered by `CSI_PLUGIN_NODE_AFFINITY`. A label-based affinity that excludes the target node has the same effect — no plugin pod, no driver registration.

When Loki is placed on infra/dedicated nodes (often through label selectors plus taints), these two controls usually need to be widened. The taint that admits Loki must also be tolerated by the CSI plugin, otherwise Loki schedules but its volumes never mount.

## Resolution

Edit the Rook-Ceph operator ConfigMap and add a toleration that matches the taint applied to the nodes hosting Loki:

```bash
kubectl -n rook-ceph edit configmap rook-ceph-operator-config
```

The `CSI_PLUGIN_TOLERATIONS` value is a YAML list serialised as a string; keep the tolerations Rook ships by default and append one entry per taint that the plugin must clear. For example, when Loki runs on nodes tainted `nodetype=infra:NoSchedule`:

```yaml
data:
  CSI_PLUGIN_TOLERATIONS: |
    - key: node.rook-ceph.io/storage
      operator: Equal
      value: "true"
      effect: NoSchedule
    - key: nodetype
      operator: Equal
      value: infra
      effect: NoSchedule
```

If the plugin pods do not appear on the target nodes within a minute or so after the ConfigMap update, restart the Rook operator so it re-renders the DaemonSet:

```bash
kubectl -n rook-ceph rollout restart deployment rook-ceph-operator
```

Once `csi-cephfsplugin` is `Running` on every node that Loki may schedule onto, delete the stuck Loki pods so the StatefulSet recreates them. The new pods mount the PVCs cleanly:

```bash
kubectl -n logging delete pod -l app.kubernetes.io/name=loki
```

Going forward, treat `CSI_PLUGIN_TOLERATIONS` as a hard dependency of any workload that uses CephFS. Whenever a new taint is introduced on nodes that may host CSI-mounted workloads, mirror it into the operator ConfigMap before scheduling consumer workloads there.

## Diagnostic Steps

Confirm the kubelet on the affected node has not registered the CephFS driver. From a debug pod on that node, list the CSI socket plugins:

```bash
kubectl debug node/<node-name> -it --image=busybox -- \
  ls /var/lib/kubelet/plugins_registry/
```

The output should contain a `<namespace>.cephfs.csi.ceph.com-reg.sock` entry; if it is missing, no plugin pod has registered on this node.

Verify whether `csi-cephfsplugin` actually scheduled on the target node:

```bash
kubectl -n rook-ceph get pods -o wide \
  -l app=csi-cephfsplugin
```

Cross-check the node's taints against the operator's tolerations:

```bash
kubectl get node <node-name> -o jsonpath='{.spec.taints}' ; echo
kubectl -n rook-ceph get configmap rook-ceph-operator-config \
  -o jsonpath='{.data.CSI_PLUGIN_TOLERATIONS}'
```

If the node carries a taint that does not appear on either side of the configured tolerations, the plugin DaemonSet is being filtered out. The same review applies to `CSI_PROVISIONER_TOLERATIONS` for the central provisioner and `CSI_RBDPLUGIN_TOLERATIONS` if RBD-backed PVCs are also affected.
