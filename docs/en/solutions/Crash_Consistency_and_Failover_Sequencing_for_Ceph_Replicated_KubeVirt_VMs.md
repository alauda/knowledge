---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A KubeVirt virtual machine whose disk PVC sits on Ceph RBD or CephFS can be protected by either of the two replication topologies that Ceph supports — synchronous (a single stretched cluster) or asynchronous (RBD-mirror between two clusters). The DR runbook is a sequence with two correctness concerns:

1. The volume snapshot used at the moment of failover must be **at least crash-consistent**, ideally application-quiesced through the in-guest QEMU agent.
2. The Pod that attaches to the secondary copy must not start until the secondary side has completed `promote` and the primary side has been fully fenced — otherwise the same RBD image risks being writable on both sites.

This article focuses on the runbook ordering for those two concerns; refer to the Ceph cluster's own `rbd mirror` documentation for image-mirror enablement details.

## Resolution

### Step 1 — Install qemu-guest-agent in every guest image

Without the in-guest agent, KubeVirt cannot drive a filesystem freeze before the snapshot. Snapshots are still safe at the block level, but inflight database writes inside the guest will need replay on restart.

For Linux guests (any modern distribution: Fedora, CentOS Stream, Rocky, AlmaLinux, Ubuntu, Debian, openSUSE), install `qemu-guest-agent` and enable the systemd unit. The KubeVirt VM template must expose the agent channel:

```yaml
spec:
  template:
    spec:
      domain:
        devices:
          channels:
            - source: { mode: bind }
              target:
                type: virtio
                name: org.qemu.guest_agent.0
```

Verify the agent is reachable from the host once the VM is running:

```bash
kubectl get vmi app-vm -o jsonpath='{.status.agentConnected}'
```

`true` means the agent is up; the snapshot freeze hook will work.

### Step 2 — Take an application-quiesced VirtualMachineSnapshot before failover

```yaml
apiVersion: snapshot.kubevirt.io/v1beta1
kind: VirtualMachineSnapshot
metadata:
  name: app-vm-pre-failover
  namespace: vms
spec:
  source:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: app-vm
```

KubeVirt invokes `qemu-guest-agent` `fsfreeze-freeze` before the underlying CSI snapshot is requested, then `fsfreeze-thaw` immediately after the snapshot is captured. Confirm that `.status.readyToUse` flips to `true`:

```bash
kubectl -n vms get virtualmachinesnapshots.snapshot.kubevirt.io app-vm-pre-failover \
  -o jsonpath='{.status.readyToUse}'
```

### Step 3 — Fence the failing site before promoting the secondary

This is the step that prevents split-brain. For RBD-mirror in `image` mode:

1. On the failing site, demote the image:

   ```bash
   rbd mirror image demote rbd/vm-app-disk-pvc-uuid
   ```

   If the failing site is unreachable, force-demote from the surviving side (only after the primary is genuinely down — there is no automatic referee):

   ```bash
   rbd mirror image promote --force rbd/vm-app-disk-pvc-uuid
   ```

2. On the surviving site, promote (idempotent if force-promote was used above):

   ```bash
   rbd mirror image promote rbd/vm-app-disk-pvc-uuid
   ```

3. Confirm the resync completes before letting Pods attach:

   ```bash
   rbd mirror image status rbd/vm-app-disk-pvc-uuid
   ```

   Expect `state: up+stopped` (or `up+replaying` on the new primary).

### Step 4 — Recreate the VM at the surviving site

The simplest portable approach is to keep the VM manifest under git and `kubectl apply` it at the surviving cluster. When using the `VolumeReplication` CRD (csi-addons), flip the corresponding object's `replicationState` to `primary`:

```bash
kubectl patch volumereplication app-vm-pvc-replication \
  --type=merge -p '{"spec":{"replicationState":"primary"}}'
```

Then apply the VM:

```bash
kubectl apply -f app-vm.yaml
kubectl wait --for=condition=Ready vmi/app-vm --timeout=300s
```

### Step 5 — Reattach networks and external services

The VM's `interfaces` reference `NetworkAttachmentDefinition` objects. The destination cluster must have a NAD with the same name and an equivalent topology — same VLAN, same bridge, equivalent IPAM range. Pre-stage these NADs so the runbook does not need to author Multus configuration on the failover path.

External services (LoadBalancers, Ingress entries) must be re-pointed at the surviving site. Use a global DNS or a GSLB to abstract this; the article does not cover the GSLB layer.

## Diagnostic Steps

If `VirtualMachineSnapshot` never becomes `readyToUse`, the in-guest agent likely could not freeze the filesystem in time:

```bash
kubectl describe virtualmachinesnapshot app-vm-pre-failover -n vms
```

The condition message names the freeze step that timed out. Either install/repair `qemu-guest-agent` inside the guest, or accept a crash-consistent snapshot by setting `.spec.failureDeadline: 0s`.

If the failover-side VM Pod stays in `ContainerCreating`:

```bash
kubectl describe pod virt-launcher-app-vm-xxxxx -n vms
```

The most common reason is the underlying RBD image still being marked replication target — confirm the image is now `primary` (`rbd mirror image status`) before re-applying the VM.
