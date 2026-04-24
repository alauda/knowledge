---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a cluster with mixed CPU architectures (for example, some nodes on `amd64` and others on `arm64`), a newly created Virtual Machine fails to boot when its disk is provisioned from a "bootable source" template image. The VM starts, but the UEFI firmware prints an access-denied error and falls through to the boot manager:

```text
BdsDxe: loading Boot0001 "UEFI Misc Device" from PciRoot(0x0)/Pci(0x2,0x6)/Pci(0x0,0x0)
BdsDxe: failed to load Boot0001 "UEFI Misc Device" from PciRoot(0x0)/Pci(0x2,0x6)/Pci(0x0,0x0): Access Denied
BdsDxe: No bootable option or device was found.
BdsDxe: Press any key to enter the Boot Manager Menu.
```

On single-architecture clusters the same template creates a bootable VM without any additional action. The failure is limited to clusters where the control plane advertises multiple node architectures and the VM is scheduled on a node whose architecture differs from the source image's.

## Root Cause

KubeVirt's bootable-source importer picks a container disk (or DataVolume) for a given template without automatically filtering by architecture. On a single-architecture cluster every image is compatible by construction, so there is nothing to filter. On a multi-arch cluster the importer still resolves the template name to a single image digest, which may be built for a different architecture than the target node. The VM starts, OVMF loads, and the firmware correctly refuses to execute a binary for the wrong architecture — hence the `Access Denied` message and the fall-through to the boot manager.

Filtering bootable sources by node architecture requires the importer to know the per-arch variants of each image and to pick the one matching the scheduled node. That behaviour is gated behind an opt-in feature — `enableMultiArchBootImageImport` in the virtualization stack's configuration — because the multi-arch story for VM image delivery is still maturing upstream and has operational caveats (existing imports don't back-fill, image mirrors need per-arch content, etc.).

## Resolution

ACP delivers virtualization through **`virtualization`** (`docs/en/virtualization/`). For multi-arch clusters, the fix is to turn on the multi-arch boot-image feature gate on the virtualization CR, then re-import or re-create the bootable sources so the importer materialises per-architecture variants.

### Preferred: enable the multi-arch feature gate and re-import sources

The exact CR shape depends on the ACP virtualization version; the feature gate lives on the top-level virtualization CR that the operator reconciles. A typical manifest looks like:

```yaml
apiVersion: virtualization.alauda.io/v1alpha1
kind: Virtualization
metadata:
  name: virtualization
  namespace: cpaas-system
spec:
  featureGates:
    enableMultiArchBootImageImport: true
  # ...other fields unchanged
```

(Field names and the CRD group/version may differ across ACP versions — cross-check against the virtualization CR already present in the cluster. The feature-gate field is the only change required.)

Apply and let the virtualization operator reconcile:

```bash
kubectl edit virtualization virtualization -n cpaas-system
# set spec.featureGates.enableMultiArchBootImageImport: true

kubectl get virtualization virtualization -n cpaas-system \
  -o jsonpath='{.status.conditions[*]}{"\n"}'
```

Once the gate is on:

1. **Re-import existing bootable sources.** Imports performed before the gate was enabled are single-arch and are not auto-upgraded. Delete the corresponding DataImportCron / DataVolume objects for each template and let the virtualization stack rebuild them; the rebuild will pick up per-arch variants where they exist.

   ```bash
   kubectl get dataimportcron -A
   # identify the templates of interest, then:
   kubectl delete dataimportcron <name> -n <ns>
   ```

2. **Verify a newly created VM reaches `Running` on a node whose architecture matches the source.** The importer should schedule a VMI on a node whose architecture has a matching boot image. If the cluster has both `amd64` and `arm64` workers and both variants are published, a VM should boot on either.

   ```bash
   kubectl get vmi -A -o wide
   ```

3. **Be aware of the migration caveat for pre-imported sources.** Flipping the gate on a cluster that already has a large inventory of single-arch boot images does not retroactively multi-arch them; only re-import does. If the old images are still referenced by existing VMs, leave those in place — they still boot on nodes of the original architecture — and restrict new multi-arch imports to freshly created templates.

### Fallback: pin VMs to matching-architecture nodes

If enabling the feature gate is not acceptable yet (for example, the ACP version in the cluster does not expose it, or multi-arch image mirrors are not ready), work around the failure by making the placement explicit. Add a node selector to the VM spec so it is only scheduled on nodes whose architecture matches the single-arch image:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: myvm
  namespace: ns
spec:
  template:
    spec:
      nodeSelector:
        kubernetes.io/arch: amd64
      # ...domain and volumes
```

This is effectively single-arch on a multi-arch cluster — not a real multi-arch solution — but it removes the firmware-refusal failure deterministically until the feature gate is available.

### Fallback: plain KubeVirt (no ACP virtualization operator)

On a raw KubeVirt install without ACP's virtualization operator CR, the equivalent feature gate is set on the `KubeVirt` CR (the `kubevirt.io/v1` object) under `spec.configuration.featureGates`. KubeVirt's feature-gate name tracks the upstream project and may evolve across releases; consult the KubeVirt release notes for the cluster's installed version. The diagnostic-and-re-import pattern above applies identically.

## Diagnostic Steps

Confirm the firmware error is architecture, not disk-content, related. Compare the VMI's scheduled node architecture with the architecture tag of the backing image:

```bash
kubectl get vmi <name> -n <ns> \
  -o jsonpath='{.status.nodeName}{"\n"}'

kubectl get node <nodeName> \
  -o jsonpath='{.metadata.labels.kubernetes\.io/arch}{"\n"}'
```

Then locate the DataVolume or ContainerDisk feeding the VM and inspect its source tag/digest:

```bash
kubectl get datavolume -n <ns>
kubectl get datavolume <dv-name> -n <ns> -o jsonpath='{.spec}{"\n"}' | jq .
```

If the image tag or digest maps to an architecture different from the node's `kubernetes.io/arch`, the diagnosis is confirmed.

Check the cluster actually has multi-arch nodes and therefore actually needs the feature gate:

```bash
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.kubernetes\.io/arch}{"\n"}{end}' \
  | sort -u -k2
```

If all nodes share one architecture, the multi-arch gate is not the right tool — investigate the template's own image instead; it may simply be built for an incompatible CPU variant.

Inspect the virtualization operator status to confirm the feature gate was accepted:

```bash
kubectl get virtualization virtualization -n cpaas-system \
  -o jsonpath='{.status}{"\n"}' | jq .
```

A `conditions` entry of `Available=True` with the feature-gate echoed back in `status.observedConfiguration` (or equivalent) means reconciliation applied the flag. Persistently `Degraded` or `Progressing` conditions after the edit point at a lower-layer issue (webhooks, RBAC, CDI controller) — address those before continuing the re-import step.
