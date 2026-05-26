---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500033
---

# Pod stays Pending with scheduler message "didn't find available persistent volumes to bind" on local PVs

## Issue

On Alauda Container Platform 4.x (kube v1.34.5; topolvm CSI driver `topolvm.cybozu.com`, StorageClass `topolvm-hdd`), a Pod that consumes a PersistentVolumeClaim backed by a node-local PersistentVolume can stay in `Pending` indefinitely when the Pod template's `spec.nodeSelector` (or `spec.affinity.nodeAffinity`) narrows scheduling to a set of nodes that does not include the node named in the PV's `spec.nodeAffinity`. The kube-scheduler then reports a two-clause `FailedScheduling` event of the form `0/N nodes are available: X node(s) didn't find available persistent volumes to bind, Y node(s) didn't match Pod's node affinity/selector`, and the Pod never schedules — the same root mechanism applies whether the candidate PV is still `Available` (this exact message) or already `Bound` (the variant `X node(s) didn't match PersistentVolume's node affinity, Y node(s) didn't match Pod's node affinity/selector`) [ev:c1].

## Root Cause

A local PV's `spec.nodeAffinity` is a hard constraint: the PV cannot be bound or mounted on any node other than the one named in its affinity, because the underlying disk lives on that single machine. On ACP the default local-block storage path is TopoLVM (CSI driver `topolvm.cybozu.com`, StorageClass `topolvm-hdd`, `volumeBindingMode: WaitForFirstConsumer`); TopoLVM PVs also carry `nodeAffinity` pinning each volume to a single node, but the affinity key is `topology.topolvm.cybozu.com/node` rather than `kubernetes.io/hostname`. When the Pod's scheduling constraints exclude that single node, the VolumeBinding and NodeAffinity predicates run on disjoint node sets and the scheduler emits the two-clause failure shown above [ev:c3].

## Resolution

Align the Pod's scheduling constraints with the node that owns the local PV. The two-clause scheduler message itself names the two predicates and their disjoint node populations: the `didn't find available persistent volumes to bind` clause counts the nodes the PVC could bind on, and the `didn't match Pod's node affinity/selector` clause counts the nodes the Pod template allowed; only their intersection is schedulable, and the PV's `nodeAffinity` is a hard pin to a single node [ev:c1][ev:c3].

The standard remedy follows directly from that mechanism: either drop the Pod's `nodeSelector` / `affinity.nodeAffinity` if it was incidental, or change the selector so it matches a label the PV-owning node actually carries. When the PVC is provisioned dynamically through the `topolvm-hdd` StorageClass, the StorageClass's `volumeBindingMode: WaitForFirstConsumer` defers PV creation until the scheduler has picked a feasible node for the Pod, so the binding step typically lands on a node that already satisfies the Pod template's other constraints; pre-creating a node-pinned PV by hand and then constraining the Pod to a disjoint set is the configuration that reproduces the failure mode in the Issue section [ev:c3].

## Diagnostic Steps

Confirm the symptom on the Pod itself before changing anything — the two-clause message is the load-bearing signal, and the wording on the `FailedScheduling` event is what distinguishes the local-PV mismatch from a generic scheduling miss [ev:c1]:

```bash
kubectl -n <ns> describe pod <pod-name>
```

The relevant lines surface under `Events:` as the `FailedScheduling` reason; both clauses (the PV-availability clause and the node-affinity clause) appear on a single line and together name the disjoint node populations [ev:c1].

Inspect the candidate PVs to determine which node each is pinned to. On ACP the affinity is keyed by `topology.topolvm.cybozu.com/node` for TopoLVM-provisioned volumes, so a generic walk over `spec.nodeAffinity.required.nodeSelectorTerms[].matchExpressions[]` is the portable way to read the pinning rather than filtering on a specific label key [ev:c3]:

```bash
kubectl get pv -o yaml
```

Cross-check the Pod's effective scheduling constraints against the PV-owning node's labels — the intersection must be non-empty for the Pod to schedule, since both predicates (VolumeBinding and NodeAffinity) must accept the same node [ev:c1]:

```bash
kubectl get pod <pod-name> -n <ns> -o jsonpath='{.spec.nodeSelector}{"\n"}{.spec.affinity}{"\n"}'
kubectl get node <pv-owner-node> --show-labels
```

If the two sets do not overlap, adjust the Pod's selector / affinity (or the PV-provisioning side, for a `WaitForFirstConsumer` SC) so they do; the Pod will then be re-evaluated by the scheduler on the next sync [ev:c1].
