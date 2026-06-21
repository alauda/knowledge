---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Warm Migration DiskTransfer Fails — VDDK Cannot Find the VM Disk in the Snapshot Chain
## Issue

A warm migration from a VMware-backed source to ACP Virtualization fails in the **DiskTransfer** phase, with an error that names the missing disk but does not explain why it is missing:

```text
Unable to connect to vddk data source:
  disk '[data store] vm_name/vm_disk.vmdk' is not present in VM hardware
  config or snapshot list
```

The importer pod's log shows the CDI `vddk-datasource` enumerating the source VM's disks, looking them up against the VMware snapshot chain, and failing to locate one — despite the disk being visible on the source VM's VMware configuration:

```text
vddk-datasource_amd64.go:298] Current VM power state: poweredOn
vddk-datasource_amd64.go:855] Could not find VM disk [data store] vm_name/vm_disk.vmdk:
  disk '[data store] vm_name/vm_disk.vmdk' is not present in VM hardware config or snapshot list
importer.go:348] disk '[data store] vm_name/vm_disk.vmdk' is not present in VM hardware config or snapshot list
```

**Cold migration of the same VM succeeds.** Only the warm-migration path trips on this — because warm migration uses the snapshot chain to transfer changes while the source stays online.

## Root Cause

Warm migration works by taking iterative snapshots on the source hypervisor and replaying the delta between snapshots onto the destination. The migration toolkit's CDI `vddk-datasource` walks the VM's VMware snapshot chain to find the specific VMDK file it should read for a given iteration.

In affected toolkit versions, the lookup logic for the backing-snapshot chain has a bug that causes it to miss disks in certain chain shapes — typically when the VM has an intermediate snapshot whose disk reference does not match the exact path the lookup computes. The lookup returns "not found" even though the disk is listed in the VMware config; the DiskTransfer phase aborts.

The bug requires coordinated fixes on both the migration toolkit (which authors the lookup) and CDI (which hosts the `vddk-datasource` binary). Upgrading either component alone is not sufficient — both must carry the paired fix.

## Resolution

### Preferred — upgrade both MTV / migration-toolkit and CDI / the virtualization stack

Follow the operator-upgrade path for both components so the paired fix is in place:

- Migration toolkit / Forklift operator → version **2.10.3** or later.
- CDI / ACP Virtualization → an aligned version carrying the companion fix.

After both upgrades reconcile, re-run the failed warm migration. The DiskTransfer phase should complete normally.

Verify:

```bash
# MTV / Forklift operator CSV.
kubectl get csv -n <forklift-ns> -o custom-columns='NAME:.metadata.name,VERSION:.spec.version'

# CDI CSV (lives in the virtualization ns).
kubectl get csv -n <virt-ns> -o custom-columns='NAME:.metadata.name,VERSION:.spec.version' | \
  grep -i cdi
```

The versions should be at or above the fix line announced by the release notes.

### Workaround — switch to cold migration

Cold migration does not walk the snapshot chain — the VM is stopped on the source, a single VMDK is transferred in full, and the VM is started on the destination. It is immune to the chain-lookup bug.

If the workload can tolerate a brief outage during migration:

1. Edit the migration plan (or the pre-migration migration-plan template) to use **cold** rather than warm:

   ```yaml
   apiVersion: forklift.konveyor.io/v1beta1
   kind: Plan
   metadata:
     name: my-vm-migration
   spec:
     type: Cold         # was: Warm
     # ... rest of spec ...
   ```

2. Shut the VM down on the source hypervisor (or let the migration shut it down, depending on the toolkit's configuration).
3. Run the migration. DiskTransfer completes in one pass without consulting the snapshot chain.
4. Bring the VM up on the destination.

The outage lasts only for the disk-transfer duration. For VMs whose downtime budget accommodates that, this is the simpler path.

### Workaround — avoid complex snapshot chains on the source

If an upgrade is not feasible and the workload cannot tolerate cold-migration downtime, pre-process the source VM to simplify its snapshot chain before starting the warm migration:

1. On the source hypervisor, consolidate all snapshots on the VM (a snapshot "coalesce" or "delete all and keep the data" operation, depending on the VMware tooling).
2. Confirm the VM has **no** snapshots remaining (a clean, single-VMDK state).
3. Start the warm migration immediately — the toolkit's first snapshot of the pristine VM does not hit the chain-lookup bug because the chain is trivial.

This is fragile: any snapshot taken by a backup tool or a management system between the consolidation and the migration's first iteration may reintroduce the bug. It is a last-resort stopgap while scheduling the upgrade.

## Diagnostic Steps

Confirm the failure is specifically the VDDK lookup (rather than a generic connectivity or credential issue):

```bash
MIG_NS=<migration-ns>
POD=$(kubectl -n "$MIG_NS" get pod -l app=containerized-data-importer \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$MIG_NS" logs "$POD" --tail=500 | \
  grep -E 'vddk-datasource|Could not find VM disk|snapshot list'
```

The `Could not find VM disk …: disk '…' is not present in VM hardware config or snapshot list` signature confirms this note. If the log instead shows `vddk: authentication failure` or `connection refused`, the issue is credentials / reachability, not the lookup bug.

Check the source VM's snapshot state on the VMware side to understand chain complexity:

```bash
# From a workstation with govc (VMware CLI) or equivalent.
govc snapshot.tree -vm '<vm-path>'
```

A tree with multiple nested branches indicates a complex chain — more likely to trip the bug. A flat tree or no snapshots should migrate cleanly.

Read the migration plan's status to see which disk specifically failed:

```bash
kubectl -n "$MIG_NS" get plan <plan-name> -o yaml | \
  yq '.status.migration.vms[] | select(.error != null) | {name, phase, error}'
```

The `error` field echoes the VDDK message with the exact disk path. That identifies which disk — useful if only one of several is affected and the VM could be partially migrated with the others already online.

After applying the fix or workaround, retry and watch the plan progress:

```bash
kubectl -n "$MIG_NS" get plan <plan-name> -o \
  jsonpath='{range .status.migration.vms[*]}{.name}{"\t"}{.phase}{"\n"}{end}'
```

All VMs should reach `Completed`; the DiskTransfer phase no longer stalls.
