---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Creation Rejected by `mutatevirtualmachines.kubemacpool.io` When Multiarch Is Enabled
## Issue

Creating a new VM through the ACP console fails with an admission-webhook rejection that names `kubemacpool.io`:

```text
admission webhook "mutatevirtualmachines.kubemacpool.io" denied the request:
  json: cannot unmarshal array into Go struct field
  VirtualMachineInstanceTemplateSpec.spec.template.spec of type v1.Devices
```

The error is specifically about a JSON-shape mismatch: the webhook expects an object in a particular position of the VM's spec, but the UI is sending an array. The same VM can be created without error by bypassing the UI and submitting the manifest directly through `kubectl` — confirming that the payload the UI constructs is the problem, not the VM definition itself.

## Root Cause

The admission webhook `mutatevirtualmachines.kubemacpool.io` is part of the MAC-address-pool subsystem that reconciles VM NIC MACs. When a VM is created, the webhook unmarshals the incoming request into its own Go struct to apply MAC-related mutations. The struct expects `spec.template.spec.devices` as an object; the affected console build sends it as an array — the UI's payload assembly regresses when a specific combination of features is enabled.

The trigger is the **multiarch** feature (the ability to have VMs of different CPU architectures on the same cluster, typically arm64 alongside amd64). When multiarch is on, the console wraps certain fields in a container structure that the older kubemacpool webhook cannot unmarshal. The webhook rejects the request, and the VM never gets created.

The CLI path does not go through the console's payload assembly, so it submits a well-shaped manifest and the webhook accepts it. That is why `kubectl apply -f vm.yaml` works while "Create VM" in the UI does not.

The fix is at the console: render the payload in a shape the webhook accepts. Both the ACP Virtualization operator releases and the upstream virt-operator carry the fix in recent versions. Until the cluster is upgraded to a fixed build, two workarounds are available.

## Resolution

### Preferred — upgrade the virtualization operator

The fix has been delivered in recent operator releases. Upgrade the virtualization operator through the platform's operator-management surface, then re-test VM creation from the console. The webhook's mutator is updated at the same time as the console's payload shape, so both halves of the interaction become compatible.

Verify after the upgrade:

```bash
# CSV version of the virtualization operator.
kubectl -n cpaas-virtualization get csv | grep -iE 'virt|hyperconverged|kubevirt'
```

Check the version against the fix's release notes. Once the upgraded pods reconcile, creating a fresh VM from a template in the UI should succeed without the kubemacpool rejection.

### Workaround 1 — use the CLI

Submit the VM manifest directly. A VM template can be rendered and piped into `kubectl apply`:

```bash
# Render a VM from a template manifest (substitute your template engine's flags).
# The exact rendering command depends on how your VM templates are authored.
cat vm.yaml | envsubst | kubectl apply -f -
```

Or:

```bash
kubectl apply -f vm.yaml
```

The CLI path is unaffected by the UI payload assembly.

### Workaround 2 — disable guest-log access before creating VMs in the UI

The specific UI-side payload divergence is tied to the console's **guest-log access** feature being enabled. Disabling it makes the console fall back to a payload shape the webhook can unmarshal:

1. In the ACP console, open the Virtualization → Overview / cluster-wide settings.
2. Locate the **Guest log access** toggle.
3. Set it to **Disabled**.
4. Save. Reload the template-based VM creation flow.

Creating the VM through the same template now succeeds. Re-enable guest-log access after the cluster upgrade is in place if the feature is desired.

### Do not

- **Do not disable the `kubemacpool` webhook.** The webhook is what prevents MAC collisions across the cluster; removing it opens a real conflict window. Use one of the workarounds above instead.
- **Do not edit the console's payload by hand through browser tooling.** Any success is temporary — the next template select re-renders with the same broken payload.

## Diagnostic Steps

Confirm the rejection is from `kubemacpool` specifically, not a different webhook:

```bash
kubectl describe vm <vm-name> -n <ns> 2>&1 | \
  grep -A3 -E 'mutatevirtualmachines|kubemacpool|webhook'
```

The exact error message with `json: cannot unmarshal array into Go struct field` is the unique signature.

Verify the CLI path works on the same VM definition:

```yaml
# minimal-vm.yaml — exercises only the fields the console would also set.
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: cli-probe
  namespace: <ns>
spec:
  runStrategy: Manual
  template:
    spec:
      domain:
        devices:
          disks:
            - name: root
              disk:
                bus: virtio
        resources:
          requests:
            memory: 512Mi
      # ... volumes / networks appropriate for the cluster ...
```

```bash
kubectl apply -f minimal-vm.yaml
```

If the CLI succeeds and the console still fails, the issue is confirmed on the UI side. If the CLI also fails, the issue is different — read the webhook's log for the actual denial reason.

Inspect the kubemacpool webhook pod log for context:

```bash
kubectl -n <kubemacpool-ns> logs -l app=kubemacpool --tail=200 | \
  grep -E 'mutatevirtualmachines|denied|unmarshal'
```

The log entries confirm which VM creation request tripped the webhook; cross-reference with the console's creation attempts to confirm timing.

After applying the workaround (either CLI or disabled guest-log access), re-run the VM creation flow and confirm the VM appears in the namespace's listing, transitions through the normal boot sequence, and the webhook's denial events stop.
