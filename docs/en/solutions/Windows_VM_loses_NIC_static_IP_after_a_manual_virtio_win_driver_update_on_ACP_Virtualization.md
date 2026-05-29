---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500636
---

# Windows VM loses NIC static IP after a manual virtio-win driver update on ACP Virtualization

## Issue

On Alauda Container Platform Virtualization for KubeVirt (KubeVirt `v1.7.0-alauda.2`, HyperConverged Cluster Operator in namespace `kubevirt`), a Windows guest can lose the static IP configuration on its network interface after the virtio-win drivers are manually updated inside the guest. The affected NIC is the emulated virtio-net device that KubeVirt presents to the VM, against which the in-guest `netkvm` (virtio-win) network driver binds. The virtio-win driver media is delivered to the guest through the `virtio-container-disk:v1.7.0-alauda.2` image that ships with the KubeVirt operator bundle, but the static-IP loss is a guest-internal effect of the driver update rather than a change in how the platform schedules or emulates the VM.

## Root Cause

Updating the virtio-win drivers prompts the Windows device-install subsystem to register a fresh instance of the virtio network device. The static IP that was bound to the previous device instance is left associated with the now-superseded (hidden) device rather than carried over to the new one, so the active interface comes up without its configured address. The Windows `setupapi` device-install log records the device that fails to configure cleanly with error code `0x38` (`CM_PROB_NEED_CLASS_CONFIG`), which marks a device whose class configuration has not yet been finalized.

This pattern is consistent with a device whose class configuration was left in a pending state — typically when a guest reboot had not completed the previous driver-class change before the next update was attempted. The platform substrate (the KubeVirt-emulated virtio-net NIC and its default `virtio` interface model) is unchanged across the update; the orphaned address lives entirely inside the guest's device tree.

## Resolution

The virtio NIC the guest `netkvm` driver binds to corresponds to the `virtio` interface model, which is first-class and the default `model` value for KubeVirt interfaces on ACP KubeVirt `v1.7.0-alauda.2`. Before attempting a virtio-win upgrade inside the Windows guest, inspect the Windows Device Manager for any device that shows a yellow warning sign — a device in that state has a configuration that has not been finalized and is the one at risk during the next driver update.

If a device is found in the warning state, reboot the VM and let it come up cleanly before starting the virtio-win upgrade. The reboot finalizes the pending device-class configuration for the virtio NIC so that the subsequent driver update applies to a settled device instance, which avoids leaving the static IP stranded on a superseded device.

A VM can be restarted through the standard KubeVirt VirtualMachine controls in the `kubevirt` namespace; for example, stop and start the VM to force a clean boot:

```bash
kubectl patch virtualmachine -n <vm-namespace> <vm-name> \
  --type merge -p '{"spec":{"running":false}}'
kubectl patch virtualmachine -n <vm-namespace> <vm-name> \
  --type merge -p '{"spec":{"running":true}}'
```

## Diagnostic Steps

After a NIC loses its static IP, confirm the symptom from inside the guest by reviewing the Windows `setupapi` device-install log for a device recorded with error code `0x38` (`CM_PROB_NEED_CLASS_CONFIG`); that entry identifies the device whose class configuration did not finalize during the update. The default `setupapi` log lives under the Windows system directory inside the guest:

```text
C:\Windows\INF\setupapi.dev.log
```

Cross-check the same device in the Windows Device Manager — the virtio network adapter is the `virtio`-model interface KubeVirt presents to the VM, so a yellow warning sign there points at the NIC instance that needs a clean reboot before any further driver change. A reboot of the guest before retrying the virtio-win upgrade resolves the pending-configuration state and restores normal binding for the static IP.
