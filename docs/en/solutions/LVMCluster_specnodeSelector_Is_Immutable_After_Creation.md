---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# LVMCluster spec.nodeSelector Is Immutable After Creation
## Issue

An operator wants to change which nodes are included in an LVM-based local storage cluster after the cluster has been rolled out. Editing the `LVMCluster` CR to add (or remove) a `nodeSelectorTerm` is rejected by the API server:

```text
LVMCluster.lvm.topolvm.io "lvmcluster" is invalid:
spec.storage.deviceClasses[].nodeSelector: Invalid value: ...
nodeSelector cannot be changed
```

The resource as currently persisted looks like:

```yaml
spec:
  storage:
    deviceClasses:
    - default: true
      fstype: xfs
      name: vg1
      nodeSelector:
        nodeSelectorTerms:
        - matchExpressions:
          - key: nvidia.com/gpu.present
            operator: Exists
      thinPoolConfig:
        ...
```

Any `kubectl edit` / `kubectl patch` that touches `spec.storage.deviceClasses[*].nodeSelector` is refused.

## Root Cause

`spec.storage.deviceClasses[*].nodeSelector` on the `LVMCluster` CRD is declared immutable. This is intentional: the selector determines which nodes had their physical devices scanned, claimed, and assembled into a VG/thin pool when the cluster was first bootstrapped. Changing the selector after the fact would either leave a VG behind on a node that is now out of scope (orphaning data) or claim devices on a newly-in-scope node that never went through the provisioning lifecycle — both of which break the operator's guarantees about where volumes can be provisioned and attached.

The CRD's validating admission enforces immutability so the operator never has to reason about the half-migrated state.

## Resolution

There is no in-place edit path. The selector is a bootstrap-time decision. Two choices, depending on the cluster's state:

1. **If the LVMCluster has not yet hosted any data you need to keep** (fresh install, test cluster, development environment): delete the `LVMCluster` object and re-create it with the desired `nodeSelector`. The controller will tear down the VG/thin pool artefacts on the previously-selected nodes and provision them on the new set.

   ```bash
   kubectl -n <lvm-ns> get lvmcluster
   kubectl -n <lvm-ns> delete lvmcluster <name>
   # wait for the controller to finalise teardown before re-applying
   kubectl -n <lvm-ns> apply -f <updated-lvmcluster.yaml>
   ```

2. **If there is live data** on PVs backed by the existing device classes, a destructive recreate is not appropriate. Instead:

   - Plan a data migration first. Use whatever backup/restore or volume-replication tooling is in place to capture a consistent copy of the PVCs that live on device classes whose selector you want to change.
   - Drain those PVCs (scale workloads down, restore them elsewhere on a StorageClass that is not affected by the selector change, or migrate them to a different `deviceClass` via application-level replication).
   - Only then delete and re-create the `LVMCluster` with the new selector, and finally restore the PVCs.

If only *part* of the device-class layout needs to change and the rest should stay untouched, consider keeping the current `deviceClass` as-is and defining an **additional** `deviceClass` with a different name and the new selector — device classes in the same `LVMCluster` are addressed independently and the new one will be provisioned on its own node set without disturbing the old one. This avoids the teardown entirely for the subset that should not move.

## Diagnostic Steps

1. **Confirm the current selector.** Read it back from the live object so the plan is based on what is actually in etcd, not on the YAML someone has in a git repo:

   ```bash
   kubectl -n <lvm-ns> get lvmcluster <name> -o yaml | \
     yq '.spec.storage.deviceClasses[] | {name, nodeSelector}'
   ```

2. **Understand which nodes currently back the selector.** The selector resolves to a set of nodes at reconciliation time. Cross-reference to be sure the nodes you expect are the ones actually holding VGs:

   ```bash
   kubectl get nodes -l <selector-key>=<selector-value> -o name
   ```

3. **List the PVs that are placed on each device class.** Any PV whose StorageClass points at this `LVMCluster` is in scope for a migration plan before you delete the CR:

   ```bash
   kubectl get pv -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.storageClassName}{"\n"}{end}' | \
     grep <lvm-storageclass>
   ```

4. **Check the controller is healthy before recreate.** A stuck or CrashLoop controller will make the delete appear to hang; it is easier to notice this before deleting anything than after:

   ```bash
   kubectl -n <lvm-ns> get pods
   kubectl -n <lvm-ns> logs deploy/<lvm-operator> | tail -50
   ```

5. **After recreate, verify the new layout.** The `status` of the new `LVMCluster` should report `Ready` for each device class on each targeted node, and new PVCs should bind to the expected nodes:

   ```bash
   kubectl -n <lvm-ns> get lvmcluster <name> -o jsonpath='{.status}{"\n"}' | jq
   kubectl get storageclass
   ```

Treat the immutability as a safety feature, not a bug: any workflow that relies on mutating `nodeSelector` post-hoc is papering over a data-placement decision that should be made at provisioning time.
