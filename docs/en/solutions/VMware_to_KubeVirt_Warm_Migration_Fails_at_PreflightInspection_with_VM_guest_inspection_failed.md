---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Windows virtual machine is being migrated from a VMware source into ACP's virtualization platform using the "migrate from VMware" workflow. The migration `Plan` starts, but stops early during the **PreflightInspection** stage with an error surfaced on the plan:

```text
VM guest inspection failed
```

Because the inspection step runs *before* the disk transfer, the plan halts before any data has been copied — there is no half-migrated VM to clean up, but the migration cannot progress past validation either.

## Root Cause

The warm-migration workflow runs an optional guest-inspection step on the VMware-side VM before the disk-transfer phase starts. The step uses the Forklift inventory / virt-v2v inspector to probe the guest filesystem and OS metadata; the results feed downstream conversion hints. When the inspector fails (because the guest OS, the VMware Tools version, the disk layout, or the network path from the migration controller to the ESXi host prevents a successful probe), the migration `Plan` surfaces a generic `VM guest inspection failed` message and does not proceed.

The inspection is gated by a single boolean on the plan: `runPreflightInspection`. When set to `true` (the default for warm migrations), the inspection is mandatory — a failure blocks the plan. When set to `false`, the phase is skipped entirely and the migration moves straight to the disk-transfer stage.

There is no Forklift-side reconfiguration that *repairs* the inspection for a particular guest; the documented mitigation is to turn the inspection off and rely on the post-migration virt-v2v conversion to handle guest adjustments.

## Resolution

### Preferred: disable the preflight inspection step on the migration plan

Edit the migration `Plan` CR and set the preflight toggle to `false`. In ACP's virtualization UI, the plan can be edited directly (Plan → YAML). Via the CLI:

```bash
kubectl -n <migration-namespace> get plan <plan-name> -o yaml > plan.yaml
```

In `plan.yaml`, set or add:

```yaml
spec:
  warm: true
  runPreflightInspection: false
```

Apply the edit:

```bash
kubectl apply -f plan.yaml
```

Then re-trigger the migration. The plan will skip the inspection step and proceed to cold-snapshot / warm-sync of the source disks. Cleanup, conversion, and VMI creation run unchanged.

Two practical notes:

- **The inspection is useful when it works.** Disabling it removes one layer of early validation; the virt-v2v conversion at the end of the transfer has its own checks, but those fail *after* disk bytes have been copied rather than before. If the plan covers many VMs, consider re-enabling inspection after the problematic VM has migrated so future plans fail fast for other reasons.
- **It is a plan-scoped flag, not a global toggle.** Disabling inspection on one plan does not affect other plans in the same project.

### Fallback: self-managed Forklift / virt-v2v directly

When running Forklift outside the ACP virtualization workflow (for example, an open-source Forklift deployment driving migrations directly), the same flag exists on the upstream `forklift.konveyor.io/Plan` CRD and takes effect the same way:

```yaml
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: windows-vm-migration
spec:
  warm: true
  runPreflightInspection: false
  # ... provider / vmList / mapping refs ...
```

The behaviour on warm migrations is identical: `false` skips the inspection phase, any other value keeps it as a hard gate.

## Diagnostic Steps

Inspect the plan CR to locate the current toggle value:

```bash
kubectl -n <migration-namespace> get plan <plan-name> -o yaml \
  | grep -E 'runPreflightInspection|warm|phase'
```

Expected pattern when the inspection is the gate:

```text
  runPreflightInspection: true
  warm: true
status:
  phase: PreflightInspection
  conditions:
    ...
    message: VM guest inspection failed
```

Look for the specific reason the inspection failed before deciding whether to disable it. The controller responsible for the inspection logs the underlying VMware error (often a timeout querying ESXi, or a VMware Tools version the inspector does not understand). Grep the migration controller pod:

```bash
# Namespace of the forklift / virtualization migration controller varies by deployment.
kubectl -n <mig-controller-ns> logs deploy/forklift-controller \
  | grep -E "$(kubectl -n <migration-namespace> get plan <plan-name> \
      -o jsonpath='{.metadata.uid}')" \
  | tail -n 40
```

If the underlying reason is environmental (ESXi unreachable, credentials stale, DNS from controller to vCenter broken), fix that and the inspection will succeed with `runPreflightInspection: true`. If the reason is guest-side (unsupported Windows build, missing VMware Tools, exotic disk layout), the supported path is to disable the inspection as shown above and let the post-transfer virt-v2v convert the guest.

Verify the migration proceeds past the previous halt point after the edit:

```bash
kubectl -n <migration-namespace> get migration -w
```

The sequence should now progress through `Started → Initializing → DiskTransfer → CutOver` rather than stopping at `PreflightInspection`.
