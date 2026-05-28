---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500407
---

# Pinning a VM live-migration destination via nodeSelector on ACP Virtualization

## Issue

On Alauda Container Platform with the `kubevirt-operator` bundle installed (CSV `kubevirt-hyperconverged-operator.v4.3.5`, KubeVirt `v1.7.0-alauda.2`, HCO operator `1.17.0`, HyperConverged singleton in the `kubevirt` namespace), a virtualization administrator sometimes needs to live-migrate a specific `VirtualMachineInstance` onto a chosen target node — for evacuation rehearsal, hardware-affinity validation, or working around a noisy neighbour — rather than letting the scheduler pick any eligible node. The `VirtualMachine` CRD (`kubevirt.io/v1`) carries a `.spec.template.spec.nodeSelector` field of type `map[string]string` whose documented role is "selector which must match a node's labels for the VMI to be scheduled on that node", and the same `nodeSelector` field appears on the projected `VirtualMachineInstance` shape that virt-controller produces from the template.

## Root Cause

`VirtualMachineInstanceMigration` (`kubevirt.io/v1`) triggers a live migration of a named VMI; one supported path for steering the migration-target virt-launcher pod is to let the standard Kubernetes scheduler decide against the VMI's own scheduling constraints. The VMI inherits `.spec.nodeSelector` from `.spec.template.spec.nodeSelector` on the parent `VirtualMachine`, so the set of nodes the migration target is allowed to land on is exactly the set selected by that map. Narrowing the map to labels matched by only one node therefore narrows the migration's candidate set to that node. (On the KubeVirt v1.7.0-alauda.2 build referenced in the Issue section the `VirtualMachineInstanceMigration` CRD also exposes a first-class `spec.addedNodeSelector` map as a surgical alternative restrictor on the migration object itself; the recipe below stays on the template-side `nodeSelector` path because that is the field the rest of this article anchors against.)

## Resolution

The supported sequence is: edit the parent `VirtualMachine` to add a `nodeSelector` whose labels match only the intended destination node, create a `VirtualMachineInstanceMigration` to trigger the migration, then edit the `VirtualMachine` again to remove the `nodeSelector` once the VMI reports landing on the new node. The first edit narrows the candidate set so the migration target pod can only schedule onto the chosen node; the final un-edit restores cluster-wide scheduling for any subsequent migrations or restarts.

Label the destination node (skip if a suitable label already exists):

```bash
kubectl label node <destination-node-name> migration-target=true --overwrite
```

Patch the `VirtualMachine` to add the `nodeSelector` matching that label. The field path is `.spec.template.spec.nodeSelector`; placing the selector here causes the projected VMI to carry the same constraint, which the KubeVirt-driven scheduling path then honours when picking the virt-launcher pod's host:

```bash
kubectl patch vm <vm-name> -n <vm-namespace> --type merge -p \
  '{"spec":{"template":{"spec":{"nodeSelector":{"migration-target":"true"}}}}}'
```

Trigger the migration by creating a `VirtualMachineInstanceMigration` referencing the VMI:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstanceMigration
metadata:
  name: pin-to-target
  namespace: <vm-namespace>
spec:
  vmiName: <vm-name>
```

After the VMI reports the new node in `.status.nodeName`, remove the `nodeSelector` from the `VirtualMachine` so the VM is free to schedule cluster-wide on future migrations or restarts. Without this final step the constraint would persist, and subsequent migration or restart events would still be funnelled to the labelled node:

```bash
kubectl patch vm <vm-name> -n <vm-namespace> --type json -p \
  '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'
```

## Diagnostic Steps

Confirm the projected VMI carries the intended `nodeSelector` before creating the migration object — the field on the running VMI is what the migration-target pod's scheduling is filtered against, not the VM template directly:

```bash
kubectl get vmi <vm-name> -n <vm-namespace> -o jsonpath='{.spec.nodeSelector}'
```

Track migration progress and confirm the new host once the VMI moves:

```bash
kubectl get vmim -n <vm-namespace> pin-to-target -o jsonpath='{.status.phase}'
kubectl get vmi <vm-name> -n <vm-namespace> -o jsonpath='{.status.nodeName}'
```

After removing the `nodeSelector`, re-read `.spec.template.spec.nodeSelector` on the `VirtualMachine` and `.spec.nodeSelector` on the `VirtualMachineInstance`; both should be empty or absent, indicating the VM is back to unconstrained scheduling for the next migration or restart:

```bash
kubectl get vm <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.template.spec.nodeSelector}'
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.nodeSelector}'
```
