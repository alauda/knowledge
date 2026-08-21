---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM storage migration marked Failed because of an unrelated VM with a missing DataVolume
## Issue

A KubeVirt virtual-machine storage migration completes its data copy
successfully, but the migration object is reported as `Failed`. The error
message points at a virtual machine that is **not** in the migration plan
(possibly even one explicitly skipped):

```text
NAME              READY  PLAN          STAGE      ROLLBACK  ITINERARY  PHASE
migmigration-x    false  migplan-y     Completed                       Failed
```

```text
- Failed updating PVC references on VirtualMachines [<ns>/<unrelated-vm>]
```

The migration controller logs:

```text
"msg":"failed getting DataVolume",
"phase":"SwapPVCReferences",
"namespace":"<ns>",
"name":"<unrelated-vm>",
"error":"datavolumes.cdi.kubevirt.io \"<unrelated-vm>\" not found"
```

The VM that was actually being migrated has its data on the new storage
class and is healthy. The Failed status is purely cosmetic in that respect,
but it blocks any downstream automation that gates on the migration plan
reaching `Succeeded`.

## Root Cause

During the `SwapPVCReferences` phase the workload-migration controller
walks every `VirtualMachine` object in the source namespace and updates the
PVC references that point at the old storage. The walk is not restricted to
the VMs listed in the migration plan — it scans the whole namespace.

If any VM in the namespace references a `DataVolume` that has been deleted
out from under it (a common state for stale VMs whose DataVolume was pruned
but whose VM object was kept), the controller cannot resolve the reference
and the entire reconcile errors out. The migration of the targeted VM has
already finished by the time `SwapPVCReferences` runs, so the data is safe
on the new storage; only the namespace-wide reference scan fails, which
flips the migration object to `Failed`.

The class of bug — namespace-wide reconciliation that errors on an
unrelated, orphaned VM — has been corrected in newer migration-controller
revisions that scope the reference scan to the VMs in the migration plan.
Until that fix is rolled out, the workaround is to leave no orphaned
DataVolume references in the source namespace.

## Resolution

Pick one of:

### Option A — clean up the orphaned VM

If the VM named in the error is no longer needed, delete it:

```bash
kubectl delete vm <unrelated-vm> -n <source-ns>
```

Re-run the migration. With the orphaned reference gone, the
namespace-wide scan passes and the migration object reaches `Succeeded`.

### Option B — repair the orphaned reference

If the VM must stay around, recreate the missing DataVolume so the
reference resolves. The simplest path is to create an empty DataVolume of
the same name pointing at any backing PVC:

```yaml
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata:
  name: <unrelated-vm>
  namespace: <source-ns>
spec:
  pvc:
    accessModes:
      - ReadWriteOnce
    resources:
      requests:
        storage: 1Gi
  source:
    blank: {}
```

The controller's reference scan now succeeds. After the migration, decide
whether the orphaned VM should be repaired more thoroughly or removed.

### Option C — sweep the namespace before migrations

As a preventative practice, run a check in any namespace that hosts
production VMs before kicking off a storage migration:

```bash
# List VMs whose disks point at non-existent DataVolumes
for vm in $(kubectl get vm -n <ns> -o name); do
  for dv in $(kubectl get $vm -n <ns> \
                -o jsonpath='{.spec.template.spec.volumes[*].dataVolume.name}'); do
    kubectl get datavolume $dv -n <ns> >/dev/null 2>&1 \
      || echo "$vm references missing DataVolume $dv"
  done
done
```

Repair or delete any reported entries before starting the migration plan.

## Diagnostic Steps

1. Inspect the migration object's `status.errors` and `status.conditions`
   to confirm the failure is in `SwapPVCReferences`, not in the data-copy
   phase:

   ```bash
   kubectl get migmigration <name> -n <migration-ns> -o yaml \
     | yq '.status.errors, .status.conditions'
   ```

2. Confirm the named VM is real and the named DataVolume is missing:

   ```bash
   kubectl get vm <unrelated-vm> -n <source-ns>
   kubectl get datavolume <unrelated-vm> -n <source-ns>
   # Error from server (NotFound): ... not found
   ```

3. Inspect the source-side migration controller log for the exact
   `failed getting DataVolume` line and confirm it lists the unrelated VM
   rather than the migrated one — this is the giveaway that the failure is
   the namespace-wide scan, not the migration of the targeted VM.

4. After applying one of the resolutions, restart the migration. The
   `SwapPVCReferences` phase finishes cleanly and the migration object
   transitions to `Succeeded`.
