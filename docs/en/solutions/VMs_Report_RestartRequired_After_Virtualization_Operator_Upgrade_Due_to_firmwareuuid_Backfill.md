---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After a minor-version upgrade of the platform virtualization operator, every pre-existing VM suddenly shows a `RestartRequired` banner in the console and a `RestartRequired` condition on the `VirtualMachine`:

```text
RestartRequired - a non-live-updatable field was changed in the template spec
```

No one edited the VM. The VM is still running on the original pod, live migration still works, but the controller insists the VM template has drifted from the revision currently in effect. While this condition is set, memory-hotplug and CPU-hotplug operations are blocked because the controller refuses to amend a VM whose template is flagged as desynchronized.

## Root Cause

A recent release of the virtualization operator enforces that every VM carries `spec.template.spec.domain.firmware.uuid`. On upgrade, the controller backfills the missing `firmware.uuid` into each existing `VirtualMachine` that did not already have one set. In isolation this is harmless — the UUID backfill is deterministic and the guest sees the same firmware UUID it always did — but the VM controller then compares the live `spec.template.spec` against the `ControllerRevision` stored when the VM was last started. The newly-injected `uuid` field registers as "the template changed in a field that cannot be live-updated," and the controller adds `RestartRequired`.

The only correct interpretation is: the template did change, but the change was a cosmetic backfill by the operator itself, not a user intent to reconfigure the VM. Clearing the condition is safe; the VM does not actually need to restart. A downstream fix prevents the condition from being set in this specific backfill path in a later point release of the operator.

## Resolution

### Preferred: upgrade to a point release that includes the fix

Upgrade the platform virtualization operator to the point release that ships the fix for this UUID-backfill-vs-ControllerRevision interaction. After the upgrade, *new* VMs and any VM that has not yet been annotated will not acquire the false `RestartRequired` condition. Note that any VM that already has the condition set from an earlier upgrade still needs the condition cleared manually — the fix prevents the condition from being re-introduced, it does not retroactively clear existing ones.

### Clear the condition on already-affected VMs

This is a one-time bulk operation against the `status.conditions` subresource. The status clear is persistent because the fixed operator version will not re-add the condition on the next reconcile.

Start with a single VM to confirm the patch shape, then run the batch script per namespace. A minimal clear script:

```bash
#!/bin/bash
set -euo pipefail
NAMESPACE="${1:-default}"
echo "Clearing VM status.conditions in namespace: ${NAMESPACE}"
for vm in $(kubectl get vm -n "${NAMESPACE}" -o jsonpath='{.items[*].metadata.name}'); do
  echo "Patching VM: ${vm}"
  kubectl patch vm "${vm}" -n "${NAMESPACE}" \
    --subresource=status \
    --type=merge \
    -p '{"status":{"conditions":[]}}'
done
echo "Done."
```

Run it:

```bash
chmod +x clear-vm-conditions.sh
./clear-vm-conditions.sh <namespace>
```

Confirm the condition is gone:

```bash
kubectl -n <namespace> get vm -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="RestartRequired")].status}{"\n"}{end}'
```

An empty `status` column for each VM means the controller is no longer flagging a restart. Hotplug operations are unblocked immediately.

### Caveat for clusters not yet on the fixed version

If the cluster is still on the pre-fix operator release, running the clear script will work, but the condition will be re-added on the next reconcile of any affected VM. Wait until the operator is upgraded to the fixed version before clearing in bulk — otherwise the operation has to be repeated. For a single VM that urgently needs to accept a hotplug amendment before the upgrade lands, the clear is a valid short-term unblock; just expect the condition to reappear.

## Diagnostic Steps

Confirm the `RestartRequired` is caused by the UUID backfill — not by an actual template edit — before clearing it.

1. Dump the current `spec.template.spec` and the `spec.template.spec` from the most recent `ControllerRevision` for that VM:

   ```bash
   kubectl -n <ns> get vm <name> -o yaml | yq '.spec.template.spec' > vm.spec
   kubectl -n <ns> get controllerrevision \
     -l kubevirt.io/owner-name=<name> \
     --sort-by=.metadata.creationTimestamp \
     -o yaml | yq '.items[-1].data.object.spec.template.spec' > revision.spec
   diff vm.spec revision.spec
   ```

2. The expected diff is a single new `uuid` field under `domain.firmware`:

   ```text
   < uuid: 623fd308-012b-5ca4-8dd5-48d75e4ce2aa
   ```

   Any other drift (CPU count, memory, interfaces, volumes) would be a genuine template edit and the `RestartRequired` condition is doing its job — do **not** clear it in that case.

3. Confirm the condition message is the backfill form, not a user-driven field change:

   ```bash
   kubectl -n <ns> get vm <name> \
     -o jsonpath='{.status.conditions[?(@.type=="RestartRequired")].message}{"\n"}'
   ```

   The expected text is `a non-live-updatable field was changed in the template spec`. When the diff is only `firmware.uuid`, that message is benign.

4. Verify which operator version introduced the backfill by inspecting the virtualization operator deployment image tag in the virtualization namespace. This helps estimate how many VMs across the fleet will need the one-time clear versus being recreated naturally.
