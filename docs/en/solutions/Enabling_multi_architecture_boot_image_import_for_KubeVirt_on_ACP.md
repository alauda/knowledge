---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Enabling multi-architecture boot-image import for KubeVirt on ACP

## Issue

On Alauda Container Platform running the Virtualization for KubeVirt plugin (`kubevirt-hyperconverged-operator.v4.3.5`, HCO operator version 1.17.0), the singleton `HyperConverged` CR in the `kubevirt` namespace exposes a boolean feature gate at `spec.featureGates.enableMultiArchBootImageImport` (group `hco.kubevirt.io/v1beta1`) that governs how golden boot images are imported for different CPU architectures. On a freshly installed cluster this gate is disabled — `spec.featureGates.enableMultiArchBootImageImport=false` on the `kubevirt-hyperconverged` HyperConverged in the `kubevirt` namespace — which is the default, pre-configuration state for this surface.

## Root Cause

A VirtualMachine carries a guest architecture at `spec.template.spec.architecture` (a string field) that, when left unset, defaults to the compiled architecture of the KubeVirt components on the cluster. When the multi-architecture boot-image-import gate is left in its default disabled state, the HyperConverged operator does not maintain per-architecture golden images, so the bootable source feeding VM creation is not differentiated by architecture.

## Resolution

To have per-architecture golden boot images managed for a heterogeneous (mixed CPU architecture) cluster, set the feature gate on the singleton HyperConverged CR. Setting `spec.featureGates.enableMultiArchBootImageImport` to `true` directs the HyperConverged operator to create golden images for different CPU architectures on heterogeneous clusters.

Patch the `kubevirt-hyperconverged` HyperConverged CR in the `kubevirt` namespace:

```bash
kubectl patch hyperconverged -n kubevirt kubevirt-hyperconverged \
  --type merge \
  -p '{"spec":{"featureGates":{"enableMultiArchBootImageImport":true}}}'
```

The field is a plain boolean on `hco.kubevirt.io/v1beta1`, so the same merge-patch shape toggles it back to `false` when per-architecture golden images are no longer wanted.

## Diagnostic Steps

Read the current value of the gate on the singleton HyperConverged CR before changing it; a freshly installed cluster reports `false`:

```bash
kubectl get hyperconverged -n kubevirt kubevirt-hyperconverged \
  -o jsonpath='{.spec.featureGates.enableMultiArchBootImageImport}'
```

Confirm the field shape and semantics against the HyperConverged CRD, where `enableMultiArchBootImageImport` is defined as a boolean whose `true` value allows the operator to create golden images for different CPU architectures:

```bash
kubectl get crd hyperconvergeds.hco.kubevirt.io \
  -o jsonpath='{.spec.versions[*].schema.openAPIV3Schema.properties.spec.properties.featureGates.properties.enableMultiArchBootImageImport}'
```

A VirtualMachine's effective guest architecture can be read from its spec; an unset value falls back to the compiled architecture of the KubeVirt components:

```bash
kubectl get virtualmachine -n <namespace> <vm-name> \
  -o jsonpath='{.spec.template.spec.architecture}'
```
