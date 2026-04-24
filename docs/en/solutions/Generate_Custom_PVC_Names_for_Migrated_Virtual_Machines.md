---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

When virtual machines are migrated into ACP Virtualization from an external hypervisor (typically VMware vSphere) using the VM-migration workflow, each source disk is materialized as a `PersistentVolumeClaim` in the target namespace. Two operational issues come up almost immediately on real migration backlogs:

1. **Hashed suffix on the PVC name.** The default naming scheme appends a hash to every generated PVC — for example `vm01-disk-0-7f3a9b`. The hash makes the names safe (collision-free across re-runs and across VMs sharing a similar template) but it also makes downstream automation that expects a deterministic `vm-name + disk-index` template more fragile, and it makes the PVCs hard to cross-reference back to the source disk visually.
2. **No source-side disk identity in the PVC name.** From the post-migration view, a PVC such as `vm01-disk-0` no longer carries the original drive letter (`E:`, `F:`) for a Windows source or the mount point (`/var/lib/data`) for a Linux source. Operators have to keep an external mapping spreadsheet or re-derive the relationship from the PVC's contents to know which application data lives on which volume.

Both problems land on the same surface — the PVC name template the migration controller uses — but they are solved by separate enhancements rolled into recent versions of the VM migration controller for ACP Virtualization.

## Root Cause

Both behaviors are by design in earlier versions of the VM migration workflow.

The hashed suffix exists because the migration controller cannot assume that PVC names are unique on its own — multiple migration plans can run concurrently, the same source VM can be re-migrated after an aborted attempt, and the conversion produces transient as well as final-state PVCs. A hash guarantees that two simultaneous attempts to create `vm01-disk-0` do not collide. The downside is that downstream tooling cannot construct the expected PVC name without inspecting the migration plan after the fact.

The lack of source-disk metadata in the PVC name is a separate gap: the controller historically uses an opaque disk index (`disk-0`, `disk-1`) instead of either the Windows drive-letter assignment or the Linux mount-point label that the operator actually uses to refer to the volume. The information is available in the source VM inventory (vSphere reports drive letters for Windows guests and mount paths for Linux guests via VMware Tools) but was not propagated into the destination naming.

Both behaviors have been changed in newer revisions of the controller — first the hashed-suffix removal, then the drive-letter / mount-point injection — and both are exposed via the migration plan spec without code changes on the operator side.

## Resolution

Upgrade the VM migration controller to a build that includes both fixes, then opt into the richer naming on a per-plan basis.

### 1. Upgrade the migration controller

The two enhancements landed in distinct controller releases. Confirm the running version before relying on either feature:

```bash
# The migration operator typically runs in a dedicated namespace
kubectl get pods -A -l app.kubernetes.io/name=forklift-controller \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}  {.spec.containers[0].image}{"\n"}{end}'
```

If the running image predates the enhancement that removes hashed suffixes, follow the standard operator upgrade flow for the migration component before continuing. The two changes are additive — older plans keep the old naming behavior; only plans created after the upgrade can opt into the new templates.

### 2. Define the PVC name template on the migration plan

The migration plan exposes a `targetPVCNameTemplate` (or equivalent field, depending on the controller version). It is a string template evaluated against per-disk context the controller already collects from the source inventory. Common variables include the VM name, the disk index, and — once the second enhancement is in place — the per-disk drive letter / mount point.

A plan that produces deterministic, human-readable PVC names looks like the following:

```yaml
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: migrate-windows-batch-1
  namespace: <migration-namespace>
spec:
  provider:
    source:
      name: vsphere-source
      namespace: <migration-namespace>
    destination:
      name: acp-target
      namespace: <migration-namespace>
  targetNamespace: vm-prod
  # Template for the destination PVC name. Variables resolve per-disk:
  #   {{.VmName}}     - VM name as known on the destination
  #   {{.DiskIndex}}  - 0-based source disk index
  #   {{.WinDriveLetter}} - Windows drive letter (e.g. "C", "E")
  #                          empty for non-Windows guests
  #   {{.LinuxMountPoint}} - Linux mount point with separators sanitised
  #                          (e.g. "var-lib-data") — empty for Windows
  targetPVCNameTemplate: "{{.VmName}}-{{ if .WinDriveLetter }}drive-{{ lower .WinDriveLetter }}{{ else if .LinuxMountPoint }}mnt-{{ .LinuxMountPoint }}{{ else }}disk-{{ .DiskIndex }}{{ end }}"
  vms:
    - id: <source-vm-id-1>
    - id: <source-vm-id-2>
```

The template above produces names like `web01-drive-c` for Windows boot volumes, `web01-drive-e` for additional Windows volumes, `db01-mnt-var-lib-data` for Linux data disks, and falls back to the index-based form when neither piece of metadata is available. Adjust the template to whatever convention downstream automation expects, but keep it deterministic.

### 3. Validate on a single VM before running the full plan

Before flipping a 200-VM migration plan to a new template, dry-run the result on a single VM to confirm the rendered names. Migration controllers expose this either through a "preview" subcommand or by running a single-VM plan first:

```bash
# Run a small, scoped plan
kubectl apply -f preview-plan.yaml
kubectl get plan -n <migration-namespace> migrate-preview -o yaml | grep -A 20 'status:'
kubectl get pvc -n vm-prod -l vm-migration.alauda.io/plan=migrate-preview
```

The PVCs should be named exactly as the template predicts. If the template fails to render (typo, missing variable in the controller version actually running), the plan stays in `Pending` and the controller logs a templating error — fix the template and re-apply rather than letting it cascade into a real migration.

### 4. Opt into the new naming for in-flight backlogs

For VMs already migrated under the hashed-suffix scheme, the new template does not retroactively rename their PVCs (which would break in-cluster workloads bound to those PVCs). Two options exist:

- **Leave the old VMs alone.** The old names still work; the new template only governs new migrations. This is usually the right choice.
- **Re-migrate selectively.** If the old naming is genuinely blocking automation, re-migrate the affected VMs with the new template after a maintenance window, decommissioning the old PVCs once the new ones have validated. Treat this as a normal data-migration task with the usual backup discipline.

## Diagnostic Steps

If the rendered PVC names do not match the template, narrow the cause in this order.

1. **Check that the controller version actually exposes the variables you used.**

   ```bash
   kubectl get pods -n <migration-namespace> -l app.kubernetes.io/name=forklift-controller \
     -o jsonpath='{.items[0].spec.containers[0].image}{"\n"}'
   ```

   An older controller silently treats unknown template variables as empty strings — `{{ .WinDriveLetter }}` against a build that does not collect it will yield `web01-drive-` with a dangling separator. Either upgrade or simplify the template.

2. **Check that the source inventory carries the metadata you are templating against.** Drive letters require working VMware Tools (or the source-side equivalent) to be installed in the guest; Linux mount points require a properly mounted filesystem at scan time. A VM in a powered-off state with no recent inventory refresh will have neither.

   ```bash
   kubectl get vm -n <migration-namespace> <source-vm-name> \
     -o jsonpath='{.status.inventory}{"\n"}' | jq '.disks'
   ```

   The output should list per-disk attributes including `driveLetter` (Windows) or `mountPoint` (Linux). If those fields are empty, the source VM needs an inventory refresh before the template can use them.

3. **Look at the plan status for templating errors.** A bad template surfaces in the plan's `status.conditions`:

   ```bash
   kubectl get plan -n <migration-namespace> <plan-name> \
     -o jsonpath='{.status.conditions}{"\n"}' | jq '.[] | select(.type=="Ready" or .type=="Failed")'
   ```

   A `Failed` condition with a message about template parsing is the smoking gun; fix the template syntax (Go template, not shell) and re-apply.
