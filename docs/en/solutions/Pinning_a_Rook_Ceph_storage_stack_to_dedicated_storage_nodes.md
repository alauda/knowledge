---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Pinning a Rook-Ceph storage stack to dedicated storage nodes
## Issue

A Rook-Ceph-based storage stack — operator pods, MON/MGR/OSD daemons, MDS for CephFS, RGW for object, NooBaa for S3 gateway, plus the CSI provisioner / plugin pods — usually starts out scheduled across whatever cluster nodes happen to fit. Operators eventually want to:

- Move every Ceph daemon onto a dedicated set of "storage" nodes that have the right local disks.
- Keep general workloads off those nodes so Ceph's CPU and disk IO are predictable.
- Move the operator pods (`rook-ceph-operator`, `noobaa-operator`, the storage CR's reconciler) onto the same dedicated nodes so the management plane lives next to the data plane.

The mechanism is a combination of node labels, a `node-role` taint, OLM Subscription `config.nodeSelector` for the operator pods, and `placement` blocks on the StorageCluster CR for the data-plane pods.

## Resolution

Updating the node selector below terminates pods currently running on nodes that don't carry the new label and starts replacements on the labeled nodes. Plan for storage-pod restarts and verify Ceph health between batches.

To force-only the storage stack onto a node (and prevent any other workload from landing there), pair `nodeSelector` with a matching `taint` on the same nodes — the taint repels everything else, the nodeSelector pulls Ceph in.

### Step 1 — label and taint the storage nodes

Pick the worker nodes that have the local disks Ceph will consume and label them with both the storage role and the platform's standard storage label:

```bash
NODES=(strg1.lab.example.com strg2.lab.example.com strg3.lab.example.com)
for n in "${NODES[@]}"; do
  kubectl label   node "$n" node-role.kubernetes.io/infra=""               --overwrite
  kubectl label   node "$n" cluster.alauda.io/storage="true"               --overwrite
  kubectl taint   node "$n" cpaas.io/storage=true:NoSchedule               --overwrite
done
```

The taint is the gate that prevents non-storage workloads from co-residing. Daemons like the cluster's CoreDNS, CSI plugins for other storage classes, and node-local agents need a matching toleration if they have to keep running on these nodes — review existing DaemonSets first:

```bash
kubectl get daemonset -A \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,\
TOLERATIONS:.spec.template.spec.tolerations | column -t
```

Anything missing the storage taint toleration will be evicted at the next sync; either accept that (for scoring agents that should not run on storage nodes) or add the toleration to the DaemonSet.

### Step 2 — pin the operator pods via Subscription `config.nodeSelector`

OLM-managed operators (the `Alauda Build of Rook-Ceph` and `Alauda Build of Ceph` operators, plus the surrounding marketplace operators) are scheduled by their Subscription. Edit each Subscription in the storage namespace to add a `config.nodeSelector` and a matching toleration:

```bash
NS=cpaas-storage
kubectl -n "$NS" get subscription
```

For each Subscription listed (operator-by-operator), patch in a `config` stanza:

```yaml
spec:
  channel: stable
  name: rook-ceph-operator
  source: community-catalog
  sourceNamespace: cpaas-marketplace
  installPlanApproval: Automatic
  config:
    nodeSelector:
      cluster.alauda.io/storage: "true"
    tolerations:
      - key: cpaas.io/storage
        value: "true"
        operator: Equal
        effect: NoSchedule
```

The set of operator Subscriptions to touch depends on the version installed. Inventory by listing Subscriptions in the storage namespace and patching each in turn:

```bash
for sub in $(kubectl -n "$NS" get subscription -o name); do
  kubectl -n "$NS" patch "$sub" --type=merge -p '
spec:
  config:
    nodeSelector:
      cluster.alauda.io/storage: "true"
    tolerations:
      - key: cpaas.io/storage
        value: "true"
        operator: Equal
        effect: NoSchedule
'
done
```

OLM rolls each operator pod after the patch — confirm with `kubectl -n "$NS" get pods -o wide` that operator pods land on the labeled nodes only.

### Step 3 — pin the storage-stack data plane via the StorageCluster CR

The Rook/Ceph operator schedules its managed daemons (MON, MGR, OSD, MDS, RGW, NooBaa) according to `placement` rules in the StorageCluster (or whichever top-level storage CR the platform exposes). Add a `placement` block for each component, mirroring the same selector + toleration:

```yaml
apiVersion: ocs.alauda.io/v1
kind: StorageCluster
metadata:
  name: cpaas-storagecluster
  namespace: cpaas-storage
spec:
  placement:
    all:                          # mon, mgr, mds, rgw, default for everything
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: cluster.alauda.io/storage
                  operator: In
                  values: ["true"]
      tolerations:
        - key: cpaas.io/storage
          value: "true"
          operator: Equal
          effect: NoSchedule
    osd:                          # OSDs follow PVs; usually inherit `all`
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: cluster.alauda.io/storage
                  operator: In
                  values: ["true"]
      tolerations:
        - key: cpaas.io/storage
          value: "true"
          operator: Equal
          effect: NoSchedule
    noobaa-core:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: cluster.alauda.io/storage
                  operator: In
                  values: ["true"]
      tolerations:
        - key: cpaas.io/storage
          value: "true"
          operator: Equal
          effect: NoSchedule
    metrics-exporter:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: cluster.alauda.io/storage
                  operator: In
                  values: ["true"]
      tolerations:
        - key: cpaas.io/storage
          value: "true"
          operator: Equal
          effect: NoSchedule
```

Apply it and watch the storage operator re-roll daemons one at a time. Restart the rook-ceph-operator pod if a placement update doesn't propagate within a couple of reconcile cycles:

```bash
kubectl -n "$NS" rollout restart deploy/rook-ceph-operator
```

### Step 4 — verify Ceph health throughout the move

Storage daemon migration is a live re-shuffle; do not start the next batch until Ceph reports `HEALTH_OK`. Use the Ceph toolbox pod:

```bash
kubectl -n "$NS" exec -it deploy/rook-ceph-tools -- ceph -s
```

Wait for `HEALTH_OK` and a fully-mapped PG list before draining the next non-storage node or repeating the process for another component.

## Diagnostic Steps

Confirm where storage pods are actually scheduled:

```bash
kubectl -n "$NS" get pods \
  -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,NODE:.spec.nodeName \
  | sort -k3
```

Expect every Rook/Ceph daemon (mon-*, mgr-*, osd-*, mds-*, rgw-*, noobaa-*, ocs-metrics-exporter, csi-cephfsplugin-provisioner, csi-rbdplugin-provisioner) on the labeled storage nodes, and the per-node CSI driver DaemonSet pods (csi-cephfsplugin / csi-rbdplugin) on **every** worker — including non-storage nodes — because they handle in-pod mount on whichever node a workload runs.

If a CSI plugin pod refuses to schedule on a non-storage node after the change, it lacks a toleration for **other** workloads' taints (or for the storage taint when running on a storage node). Edit the DaemonSet's `spec.template.spec.tolerations` to include `Exists`-style tolerations for the platform's standard taints, or use the storage operator's `placement.csi-plugin` block.

If an OSD pod is `Pending`, the most common cause is mismatched `nodeAffinity`: the storage CR points at one label key while the nodes carry another. Check the unschedulable reason:

```bash
kubectl -n "$NS" describe pod <osd-pod> | grep -A3 'FailedScheduling\|node selector'
```

Reconcile the label key in either direction (relabel nodes, or edit the storage CR).

If operator pods land on storage nodes but Subscription patches don't seem to take effect, OLM may have re-rolled before the patch was committed. Re-issue the patch and force a reconciliation:

```bash
kubectl -n "$NS" annotate subscription rook-ceph-operator \
  cpaas.io/force-reresolve="$(date +%s)" --overwrite
kubectl -n "$NS" rollout restart deploy/rook-ceph-operator
```

Once everything looks right, the StorageCluster `status.phase` should report `Ready` and the Ceph dashboard (or `ceph -s`) should show all daemons healthy. Document the labels and tolerations chosen so the next StorageCluster (or the next platform upgrade) starts from the same baseline.
