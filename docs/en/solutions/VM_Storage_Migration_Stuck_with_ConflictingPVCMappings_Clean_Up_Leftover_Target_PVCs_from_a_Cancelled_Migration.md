---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Storage Migration Stuck with ConflictingPVCMappings — Clean Up Leftover Target PVCs from a Cancelled Migration
## Issue

A VM storage migration never reaches execution. The `MigMigration` resource stays in `Pending`, and its status reports a critical `ConflictingPVCMappings` condition:

```yaml
status:
  conditions:
    - category: Critical
      type: ConflictingPVCMappings
      status: "True"
      reason: PvNameConflict
      message: >-
        Source PVCs [...] are mapped to destination PVCs which result in
        conflicts. Please ensure that each source PVC is mapped to a distinct
        destination PVC in the Migration Plan.
```

Every VM's storage migration in the affected namespace hits the same conflict, so the backlog grows. The condition cannot be resolved from the `MigPlan` side because the controller regenerates the conflicting mapping on every reconcile.

## Root Cause

When a storage migration is initiated, the migration controller scans the source namespace and adds **every** PVC it finds to the generated `MigPlan`. Each PVC is tagged with an `action`:

- `copy` — this PVC is actually being migrated (the VM's live disk).
- `skip` — this PVC exists in the namespace but is not part of the current migration.

The controller then validates the plan — checking, among other things, that each **source** PVC maps to a **distinct destination** PVC name. The validation applies to every PVC in the plan regardless of its `action`.

If a previous storage migration was cancelled or failed mid-flight, it typically leaves behind a partially-provisioned target PVC named something like `<original-vm-name>-mig-XXXX`. That leftover PVC still exists in the source namespace, and when a new migration is planned, the controller picks it up:

1. Original VM disk: `rhel9-app-xyz` → mapped to `rhel9-app-xyz-mig-<new-suffix>`.
2. Leftover from prior cancel: `rhel9-app-xyz-mig-<old-suffix>` → also mapped to `rhel9-app-xyz-mig-<new-suffix>` (the controller applies the same naming algorithm to both).
3. Two distinct sources → one destination → conflict → validation fails.
4. The entire namespace's migrations queue up behind the failed validation, because the controller will not proceed on any migration if any of its planned PVCs conflicts.

The fix is to remove the leftover PVCs so the namespace's PVC inventory no longer contains duplicates that collide on the target-name algorithm.

## Resolution

### Identify the leftover PVCs

Extract the PVC-name-to-target mapping from the stuck `MigPlan` and find any destination named by more than one source:

```bash
PLAN_NS=<migration-ns>        # typically the migration operator's own ns
PLAN_NAME=<stuck-plan-name>

kubectl -n "$PLAN_NS" get migplan "$PLAN_NAME" -o yaml | \
  grep -oE 'name: [^:]+:[^ ]+' | \
  sed 's/name: //' | \
  awk -F: '{print $2"\t"$1}' | \
  sort -t$'\t' -k1,1 | \
  awk -F'\t' '
    {
      if ($1 == prev_target) {
        if (!printed) { print prev_target " <- " prev_source; printed=1 }
        print $1 " <- " $2
      } else {
        printed=0
      }
      prev_target=$1; prev_source=$2
    }'
```

Example output:

```text
rhel9-app-xyz-mig-cddm <- rhel9-app-xyz
rhel9-app-xyz-mig-cddm <- rhel9-app-xyz-mig-qxrj
```

The first source (`rhel9-app-xyz`) is the VM's actual disk. The second source (`rhel9-app-xyz-mig-qxrj`) is the leftover from a cancelled migration — that is the one to remove.

### Confirm the leftover is not used by any VM

Before deleting, double-check that the identified PVC is not referenced by any VM in the namespace:

```bash
VM_NS=<source-vm-ns>
kubectl -n "$VM_NS" get vm -o yaml | \
  yq '.items[] |
      "\(.metadata.name): " +
      (.spec.template.spec.volumes[]? | (.dataVolume.name // .persistentVolumeClaim.claimName // "none"))'
```

The VM's active disks appear as the values after each colon. The leftover PVC name should **not** appear in this output. If it does — unexpected — the PVC is in fact in use; investigate before deleting.

### Delete the leftover PVC

```bash
kubectl -n "$VM_NS" delete pvc rhel9-app-xyz-mig-qxrj
```

Apply the same procedure to any other leftovers identified in the first step. Leave only the PVCs that are either actively in use by a VM or that represent a currently-pending valid migration target.

### Restart the failed migration

Delete the stuck `MigMigration` (not the `MigPlan` — the plan can still be used after the conflict is resolved), and initiate a fresh migration request:

```bash
kubectl -n "$PLAN_NS" delete migmigration <stuck-migmigration-name>
# Initiate a new MigMigration against the now-clean namespace.
kubectl -n "$PLAN_NS" apply -f new-migmigration.yaml
```

The new migration's plan enumeration picks up only the legitimate source PVCs; the conflict condition does not recur. Watch the plan and migration progress:

```bash
kubectl -n "$PLAN_NS" get migplan "$PLAN_NAME" -o \
  jsonpath='{.status.conditions[*]}{"\n"}' | jq
kubectl -n "$PLAN_NS" get migmigration -w
```

### Prevent recurrence

Cancelled migrations should clean up their half-created target PVCs automatically, but in the affected controller version they sometimes don't. As a preventive posture:

- After any cancelled or failed migration, sweep the source namespace for `*-mig-*` PVCs and remove any that are not referenced by a VM.
- Watch the upstream migration-toolkit's fix roadmap; the orphan cleanup is a tracked issue with a fix coming in a newer controller version. Upgrade when available.

## Diagnostic Steps

Confirm the specific error is `PvNameConflict` (rather than a different mapping or RBAC issue):

```bash
kubectl -n "$PLAN_NS" get migmigration <migmigration-name> -o yaml | \
  yq '.status.conditions[] | select(.type=="ConflictingPVCMappings")'
```

`status: "True"` and `reason: PvNameConflict` is this pattern.

List every PVC in the source namespace to visualise what the controller is seeing:

```bash
kubectl -n "$VM_NS" get pvc -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,CAPACITY:.status.capacity.storage'
```

Look for rows whose name follows a `-mig-XXXX` suffix pattern — those are candidates for leftover cleanup. Cross-reference against VM spec before deleting (see above).

After the cleanup and restart, re-inspect the plan's status:

```bash
kubectl -n "$PLAN_NS" get migplan "$PLAN_NAME" -o \
  jsonpath='{range .status.conditions[*]}{.type}={.status}{" "}{end}{"\n"}'
```

The `ConflictingPVCMappings` condition should no longer be `True`. Migrations then proceed normally through the plan.
