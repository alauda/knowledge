---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VMs With the Same Name in Different Namespaces Inherit Identical Firmware UUID
## Issue

Two VMs created in **different namespaces** but with the **same** `metadata.name` end up with identical firmware UUIDs. A VM cloned from one namespace into another keeps the same UUID that cloud-init sees as the instance-id, and cloud-init consequently treats the new VM as "already initialised" — skipping the user-data / cloud-config steps that were meant to re-apply on the clone:

```bash
kubectl -n project-a get vmi app-server -o yaml | yq '.spec.domain.firmware'
# uuid: 556789f6-e976-5e52-97c5-5bfeca8f9d48

kubectl -n project-b get vmi app-server -o yaml | yq '.spec.domain.firmware'
# uuid: 556789f6-e976-5e52-97c5-5bfeca8f9d48      <-- same
```

Beyond cloud-init, any in-guest software that uses the firmware UUID as a unique identity (license activation, monitoring-agent host ID, node registration tokens) misbehaves — the "second" VM is indistinguishable from the "first" as far as that software can tell.

## Root Cause

On affected virt-operator versions, the logic that derives the firmware UUID for a VM hashes the VM's `metadata.name` and takes the first several bytes as the UUID. The **namespace** is not included in the hash input. Two VMs named `app-server` in different namespaces therefore produce the same UUID — the hash function is deterministic, and identical inputs produce identical outputs.

The intent behind making the UUID derive from the name is that restarting or recreating a VM with the same name keeps the same identity (useful when the guest OS pins things to that UUID). The defect is that the scope was "name" instead of "(namespace, name)".

A fix that hashes both namespace and name together landed in newer virt-operator versions. On fixed versions, the same clone across namespaces produces different UUIDs.

## Resolution

### Preferred — upgrade the virtualization operator

The fix ships with newer operator releases. Upgrade through the platform's operator-management surface; the next VMI reconcile on any freshly-started VM picks up the corrected UUID derivation. Existing VMIs keep their old UUID until they are restarted.

Verify after the upgrade by deleting and re-creating one of the colliding VMs:

```bash
# Stop and restart one of the VMs so it goes through the firmware-UUID
# derivation under the new code path.
kubectl -n project-b delete vmi app-server
kubectl -n project-b get vmi app-server -w   # wait for recreate

kubectl -n project-a get vmi app-server -o yaml | yq '.spec.domain.firmware'
kubectl -n project-b get vmi app-server -o yaml | yq '.spec.domain.firmware'
```

After the upgrade, the two UUIDs should differ.

### Workaround — set `firmware.uuid` explicitly on the VM spec

Until the upgrade rolls out, avoid the collision by pinning each VM's UUID explicitly:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: app-server
  namespace: project-b
spec:
  template:
    spec:
      domain:
        firmware:
          uuid: 8c9e0000-0000-0000-0000-000000000042    # explicit, unique per VM
```

Generate a fresh UUID with any standard UUID tool (`uuidgen`, `python3 -c 'import uuid; print(uuid.uuid4())'`) and set it in the spec. An explicit `firmware.uuid` overrides the operator's name-based derivation, so the collision does not recur regardless of what other VMs are named.

For many VMs, embed UUID generation into whatever templating / GitOps tool produces the VM manifests so each rendered manifest carries a unique value.

### If a cloned VM's guest is already misbehaving

The cloned guest's cloud-init sees the same instance-id and declines to re-run. Two recovery paths:

1. **Re-provision the VM with an explicit `firmware.uuid`** (as above). Cloud-init on next boot sees a different instance-id and re-runs.
2. **Reset cloud-init state inside the guest** and reboot:
   ```bash
   # Inside the guest, as root:
   cloud-init clean --logs
   reboot
   ```
   Cloud-init treats the next boot as a fresh initialisation and runs its configured modules. This works around the UUID collision without changing the VM spec, but relies on having guest access — less durable than the explicit-UUID path.

### Do not

- **Do not rely on in-guest hostname differences as the workaround.** cloud-init's instance-id check is specifically against the firmware UUID via DMI (`/sys/class/dmi/id/product_uuid`), not against the hostname. Changing the VM's name without changing the firmware UUID does not help.
- **Do not edit the running VMI's firmware UUID.** The VMI spec is immutable while it runs; any change requires a restart. Stop the VM, edit the VM (not the VMI), start it again.

## Diagnostic Steps

Identify colliding UUIDs across namespaces:

```bash
kubectl get vmi -A -o json | \
  jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)\t\(.spec.domain.firmware.uuid)"' | \
  sort -k2 | \
  awk -F'\t' 'prev==$2{if(!p){print prev_line; p=1}print; next}{p=0}{prev=$2; prev_line=$0}'
```

Any group of rows with the same UUID in the right column indicates a collision across namespaces (or, more rarely, within a namespace when something else went wrong).

Check the cluster's virt-operator version to decide between upgrade and workaround:

```bash
kubectl -n <virtualization-ns> get csv -o \
  custom-columns='NAME:.metadata.name,VERSION:.spec.version' | grep -iE 'virt|hyperconverged'
```

Versions at or above the fix line should no longer produce the collision; older versions need the explicit-UUID workaround.

After applying the workaround to one of the affected VMs, re-run the collision detection query — the row for the reconfigured VM now has a unique UUID and the collision disappears from the group.

For guests where cloud-init has already made wrong decisions, confirm the fix reaches them by checking the guest's cloud-init status:

```bash
# Inside the guest.
cloud-init query instance-id
cat /run/cloud-init/instance-data.json | jq '.v1.instance_id'
```

Both should now return the VM's unique UUID (matching `firmware.uuid` in the VM spec). On the next cloud-init-aware reboot, the initialisation modules run against the corrected instance-id.
