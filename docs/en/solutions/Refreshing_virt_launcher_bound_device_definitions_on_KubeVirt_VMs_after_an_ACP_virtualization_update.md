---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Refreshing virt-launcher-bound device definitions on KubeVirt VMs after an ACP virtualization update

## Issue

On Alauda Container Platform, virtualization is provided by the upstream KubeVirt distribution installed into the `kubevirt` namespace through the OperatorBundle `kubevirt-hyperconverged-operator.v4.3.5`; the cluster runs the HyperConverged custom resource and a deployed `KubeVirt` custom resource that owns the `virt-controller` / `virt-api` / `virt-handler` / `virt-launcher` workloads. The observed KubeVirt build on this environment is `v1.7.0-alauda.2`, and the `virt-controller` Deployment is started with the `--launcher-image` argument pinned to a single virt-launcher image tag (`3rdparty/kubevirt/virt-launcher:v1.7.0-alauda.2`); every new VirtualMachineInstance launched while that Deployment is in its current state spawns a virt-launcher pod from that exact image tag.

A VirtualMachine whose template carries the `hooks.kubevirt.io/hookSidecars` annotation relies on libvirtd inside the virt-launcher container to select a virtio-family display device; the device choice is bound to the contents of the virt-launcher container image at the moment the VirtualMachineInstance is created. Because the image used for a running VirtualMachineInstance is fixed at VMI creation time, an already-running VMI continues to use the device definition that was generated against the virt-launcher image present at that earlier time, even after the cluster's virt-controller is now configured to launch new VMIs from a different virt-launcher image tag.

## Root Cause

The display-device packaging that libvirtd resolves against lives inside the virt-launcher container image; the configured device for a given VirtualMachineInstance follows the virt-launcher image that was current when that VMI was created. Because virt-controller is launched with a single `--launcher-image` argument that all new VMIs inherit, the source of truth for the device definition shifts as soon as that argument is updated to a different tag — but only for VMIs created from that point onward.

KubeVirt live migration on this cluster is enabled — the `KubeVirt` resource carries an active `spec.configuration.migrations` block (`parallelMigrationsPerCluster: 5`, `completionTimeoutPerGiB: 150`) and the `VideoConfig` feature gate is present in the configured feature-gate list, so virtio video device selection is in scope for the running build. A KubeVirt live migration streams device state from the source virt-launcher pod to the destination virt-launcher pod, and the destination pod must instantiate a PCI device of the same type for the incoming state to map onto matching hardware. When the source virt-launcher pod was created from an earlier virt-launcher image and a fresh destination virt-launcher pod is started from the currently configured image, the two pods can carry different display-device packaging, leaving the destination unable to load the streamed state cleanly.

## Resolution

Cold-restarting affected VirtualMachines (stop, then start) re-creates the VirtualMachineInstance from the virt-launcher image that virt-controller is currently configured to use — `--launcher-image: registry.alauda.cn:60080/3rdparty/kubevirt/virt-launcher:v1.7.0-alauda.2` in the present state of this cluster — so the device definition for the new VMI is generated against the currently shipped virt-launcher contents.

After the cold restart, the source and destination virt-launcher pods for any subsequent live migration are both produced from the same `--launcher-image` tag, which keeps the device packaging consistent across the migration endpoints.

```bash
# Inspect the virt-launcher image tag the controller currently uses
kubectl -n kubevirt get deploy virt-controller \
  -o jsonpath='{.spec.template.spec.containers[*].args}'

# Stop and start an affected VM to regenerate its VMI from the current image
kubectl -n <vm-namespace> patch virtualmachine <vm-name> \
  --type=merge -p '{"spec":{"runStrategy":"Halted"}}'
kubectl -n <vm-namespace> patch virtualmachine <vm-name> \
  --type=merge -p '{"spec":{"runStrategy":"Always"}}'
```

## Diagnostic Steps

Affected VirtualMachines are those that carry the hook-sidecar annotation used to drive virtio display-device selection. List them by selecting on `spec.template.metadata.annotations` for the `hooks.kubevirt.io/hookSidecars` key.

```bash
# Find VMs that use the hookSidecars annotation (cluster-wide)
kubectl get vm -A -o json | jq -r '
  .items[]
  | select(.spec.template.metadata.annotations
           | has("hooks.kubevirt.io/hookSidecars"))
  | "\(.metadata.namespace)/\(.metadata.name)"'
```

Confirm the KubeVirt build and virt-launcher image tag currently in effect, so that any VMI created from this point matches that pinned tag:

```bash
kubectl -n kubevirt get kubevirt kubevirt-kubevirt-hyperconverged \
  -o jsonpath='{.status.observedKubeVirtVersion}'
kubectl -n kubevirt get deploy virt-controller \
  -o jsonpath='{.spec.template.spec.containers[*].args}'
```

Confirm that the live-migration controller is configured and that the relevant feature gate is enabled before scheduling migrations of the regenerated VirtualMachineInstances:

```bash
kubectl -n kubevirt get kubevirt kubevirt-kubevirt-hyperconverged \
  -o jsonpath='{.spec.configuration.migrations}'
kubectl -n kubevirt get kubevirt kubevirt-kubevirt-hyperconverged \
  -o jsonpath='{.spec.configuration.developerConfiguration.featureGates}'
```
