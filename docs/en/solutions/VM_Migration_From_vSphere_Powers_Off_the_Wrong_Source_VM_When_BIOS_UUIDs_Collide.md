---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Migration From vSphere Powers Off the Wrong Source VM When BIOS UUIDs Collide
## Issue

A VM migration plan that targets a single source VM in vSphere ends with a *different* VM being powered off. The vCenter audit log records a guest-OS shutdown against an unrelated VM ("ALTERNATEVM") at the time the migration plan transitioned to the `PowerOffSource` phase, while the migration controller's own logs only ever mention the intended source ("ORIGINALVM").

The two VMs share the same BIOS UUID — typically because one was cloned from the other without regenerating the UUID:

```text
ORIGINALVM    uuid: 420938ee-663f-364e-dc6f-e6508edf5a6a
ALTERNATEVM   uuid: 420938ee-663f-364e-dc6f-e6508edf5a6a
```

## Root Cause

The migration controller asks vSphere to locate the source VM via a `FindByUuid()` lookup. When more than one VM in the inventory shares the same BIOS UUID, vSphere returns only the first match. The controller then issues a guest-OS shutdown against that match — which may not be the VM the operator selected.

This is a vSphere-side data-integrity problem (duplicate UUIDs are not legal in a normal inventory) that the migration controller is not currently defensive against. The mismatch is invisible from the migration plan's own logs, because the controller honestly believes it is acting on the intended VM.

## Resolution

Two parallel fixes:

1. **Eliminate the duplicate UUID on the source side.** Whoever cloned the VM should have used the hypervisor's "regenerate UUID" option; do that retroactively before re-running the migration.
2. **Power the source VM off manually before the migration plan runs.** Cold-migrating a VM that is already powered off skips the controller's `PowerOffSource` step entirely and removes the failure mode from the run.

### Step 1: Confirm the Duplicate UUID in vSphere

From a vCenter session, search for VMs sharing the BIOS UUID of the intended source:

```text
# vCenter PowerCLI
Get-VM | Where-Object { $_.ExtensionData.Config.Uuid -eq '<bios-uuid>' } |
  Select-Object Name, Folder, @{N='Uuid';E={$_.ExtensionData.Config.Uuid}}
```

A correct inventory returns one row. Two or more rows confirm the collision.

### Step 2: Regenerate the BIOS UUID on the Cloned VM

Power the *cloned* (not the original) VM off, then in vCenter open its **Edit Settings -> VM Options -> Advanced -> Configuration Parameters** and add (or edit) the `uuid.action` and `uuid.bios` keys:

- `uuid.action = create` — instructs vSphere to regenerate the UUID on next power-on;
- delete the `uuid.bios` row entirely so vSphere produces a fresh value.

Power the VM back on. Re-run the PowerCLI query from Step 1 and confirm only one VM holds the original UUID.

If powering the cloned VM down is not acceptable for business reasons, the alternative is to power the *intended* source VM off manually and rerun the plan in cold-migrate mode (Step 4 below).

### Step 3: Validate the Source-Inventory Listing in the Migration Tool

Most migration tooling caches the source provider's inventory. After fixing the UUID, refresh the inventory cache so the controller sees the corrected VM:

```bash
# Use whichever VM-migration CLI the platform exposes; this snippet is
# illustrative.
vm-migrator inventory refresh --provider <vmware-provider> --namespace <ns>
vm-migrator get inventory vm --provider <vmware-provider> --namespace <ns> \
  --output=json > inventory.json

jq '[.[] | {name, uuid: .uuid}] | group_by(.uuid)
   | map(select(length > 1))' inventory.json
```

The `group_by` filter prints any UUID still shared by multiple VMs; an empty array confirms the inventory is now clean.

### Step 4: Workaround — Cold Migrate Powered-Off VMs

Until the source UUID is fixed, cold-migrate the source VM by powering it off in vSphere first and changing the migration plan's type to `cold`:

```yaml
type: cold
vms:
  - id: vm-31641
    name: ORIGINALVM
    map: <network-and-storage-map>
```

A cold migration skips the controller's `PowerOffSource` phase, so the FindByUuid race never happens. The trade-off is a longer downtime window for the source VM.

## Diagnostic Steps

Confirm which VM the controller actually shut down by cross-referencing the vCenter audit log against the migration plan's logs:

```bash
# Migration controller logs:
kubectl -n <migration-ns> logs -l app=forklift-controller --tail=500 | \
  grep -E '(PowerOffSource|WaitForPowerOff)' | head

# vCenter audit (PowerCLI):
Get-VIEvent -Start (Get-Date).AddHours(-2) -Types VmGuestShutdownEvent |
  Select-Object CreatedTime, UserName, FullFormattedMessage
```

If a `VmGuestShutdownEvent` lands at the same timestamp the migration logs show `PowerOffSource` start, but the event's `Vm.Name` differs from the migration's `vm.name`, the FindByUuid collision is confirmed.

Inspect the controller's local cache of the source VM:

```bash
kubectl -n <migration-ns> get virtualmachine.<source-provider-crd> \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.providerRef}{"\t"}{.status.uuid}{"\n"}{end}' \
  | sort -k3
```

Adjacent rows with the same UUID expose the duplicates the controller is operating on.
