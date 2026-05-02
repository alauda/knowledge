---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Virtualization Operator Upgrade Impact on Running Virtual Machines
## Issue

Does upgrading the ACP Virtualization Operator, or upgrading ACP itself, shut down or pause virtual machines that are currently running? And does it put applications running inside those VMs at risk?

## Resolution

Upgrading the Virtualization Operator does not restart or pause running VMs on its own. The operator only reconciles its controllers and CRDs; existing `virt-launcher` pods — and the guest workloads inside them — keep running across the operator upgrade itself.

Cluster-wide maintenance that occurs as part of an ACP upgrade can still require VMs to leave the node being worked on. That movement is handled by KubeVirt live migration, which you opt into on the VM spec:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
spec:
  template:
    spec:
      evictionStrategy: LiveMigrate
```

With `LiveMigrate`, KubeVirt transfers the running VM to another eligible node before the source node is drained. Guest memory and CPU state are preserved, so applications inside the VM continue without disconnection provided the workload tolerates a brief CPU-quiesce window at handover time.

VMs that declare `evictionStrategy: None`, or that omit the field entirely, are held in place while their node is drained and will be cold-restarted only if you explicitly allow it.

Before upgrading the Virtualization Operator, review the release notes for the target version. Some releases document migration constraints — for example, changes in reported CPU models, storage class requirements, or network-attachment semantics — that are best addressed in advance rather than mid-upgrade.
