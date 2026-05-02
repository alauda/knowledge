---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Operator-Driven Deployment Stuck — PVCs Pending Due to Missing Default StorageClass
## Issue

An Operator-installed product (an automation platform, a database operator, any CR that transitively creates internal stateful components) does not finish deploying. Its custom resource stays in a pre-ready phase, and the controller continually re-queues. Inspection shows the leaf pods are stuck on `Pending` because their `PersistentVolumeClaims` are also `Pending`.

Listing the PVCs, every Pending entry reports that no `StorageClass` has been specified and no default is set in the cluster. This is characteristic of bare-metal and user-provisioned clusters, where the installer does not provision a storage CSI driver automatically.

## Root Cause

Kubernetes has two ways a PVC can bind:

1. The PVC specifies `spec.storageClassName` explicitly, pointing at an installed `StorageClass`.
2. The PVC leaves `storageClassName` unset, and the cluster has a default `StorageClass` — the one annotated with `storageclass.kubernetes.io/is-default-class: "true"`.

Many Operators do not expose a field for the StorageClass used by their internal components (the Redis cache, a PostgreSQL store, an embedded scheduler queue). When they omit `storageClassName` on the PVCs they stamp out, path 2 is the only way binding can succeed. In clusters where no default `StorageClass` exists — the common case on brand-new bare-metal installs — the PVCs stay `Pending` forever and the Operator's readiness condition never flips.

There is nothing wrong with the Operator: it is behaving correctly for the contract Kubernetes gives it. The fix is to give the cluster the default it lacks.

## Resolution

1. Inspect the Operator's PVCs to confirm the failure mode is the missing-default variant:

   ```bash
   ns=<operator-ns>
   kubectl -n "$ns" get pvc
   kubectl -n "$ns" describe pvc <one-of-the-pending-pvcs> | tail -n 20
   ```

   The `Events` at the bottom will read something like `no persistent volumes available for this claim and no storage class is set`. If the message instead references a specific unavailable StorageClass, the root cause is different — see the variant at the end of this section.

2. Enumerate the cluster's available `StorageClasses`:

   ```bash
   kubectl get storageclass
   ```

   Zero entries means you need to install a CSI driver first — see the ACP storage area (`storage/storagesystem_ceph`, `storage/storagesystem_minio`, `storage/storagesystem_topolvm`) for supported options on the target environment. Pick the one that fits the workload (block with RWO for typical DB/cache, file with RWX for shared-access workloads, object for archival) and complete that installation before proceeding.

   One or more entries, but none marked `(default)`, means the CSI driver is installed — only the default annotation is missing. Go to step 3.

3. Annotate the preferred `StorageClass` as the cluster default:

   ```bash
   kubectl patch storageclass <name> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
   ```

   Re-list and verify the `(default)` marker appears next to it:

   ```bash
   kubectl get storageclass
   ```

   A healthy layout has exactly one default. If two `StorageClasses` are annotated as default, the scheduler picks one deterministically but operators and humans both get confused — remove the extra annotation from the one you don't want:

   ```bash
   kubectl patch storageclass <other-name> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
   ```

4. Wait for binding. The PVC controller re-evaluates Pending claims on each resync; once the default exists, binding happens within a few seconds:

   ```bash
   kubectl -n "$ns" get pvc -w
   ```

   The Operator's CR should transition to its ready state without further intervention. If a downstream pod is still Pending after its PVC bound, the next failure mode (scheduler constraint, node taint, affinity rule) is independent from the storage one.

### Variant — Operator requires RWX access, default class is RWO

Some products require `ReadWriteMany` for their shared state. If the default you set is a block driver (RWO only), the Operator's RWX PVCs will still fail to bind even with the default in place. Two options:

- Install an RWX-capable storage backend (e.g. Ceph with CephFS via `storage/storagesystem_ceph`, or MinIO-backed volumes via `storage/storagesystem_minio` for object-mode workloads), mark it default, and re-deploy the Operator.
- If the Operator *does* expose per-component storage class overrides in its CR, point the RWX-requiring components at a separate RWX class and leave the default as the block class for everything else.

## Diagnostic Steps

1. Confirm the PVC is in `Pending` for the missing-default reason:

   ```bash
   kubectl -n "$ns" describe pvc <pvc> | grep -A3 Events
   ```

2. Confirm the cluster actually has no default `StorageClass`:

   ```bash
   kubectl get storageclass \
     -o custom-columns='NAME:.metadata.name,DEFAULT:.metadata.annotations.storageclass\.kubernetes\.io/is-default-class'
   ```

   Every entry shows `<none>` in the `DEFAULT` column means no default is set.

3. After patching, confirm binding:

   ```bash
   kubectl -n "$ns" get pvc -o wide
   ```

   `STATUS: Bound` and a populated `VOLUME` column mean the default is working. Remove-then-recreate of any PVC that was created before the default was set is only necessary if you need to retarget the claim at a *different* class — a claim that is already binding against the new default does not need to be touched.

4. If only some PVCs bind and others stay Pending under the same default, check the specific claim's `accessModes` and `resources.requests.storage` against the class's capabilities. RWX-against-block and oversize-against-local are the two most common residual mismatches.

Once binding succeeds, the Operator's reconciler completes its next iteration and the product finishes bringing itself up.
