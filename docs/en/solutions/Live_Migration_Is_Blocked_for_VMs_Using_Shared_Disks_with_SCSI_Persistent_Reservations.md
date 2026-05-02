---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Live Migration Is Blocked for VMs Using Shared Disks with SCSI Persistent Reservations
## Overview

Virtual machines that use shared iSCSI disks with SCSI Persistent Reservations (SPR) — most commonly a pair of Windows guests running a Failover Cluster — cannot be live-migrated on ACP Virtualization. The VMI status makes the reason explicit rather than silently failing the migration:

```yaml
status:
  conditions:
    - type: LiveMigratable
      status: "False"
      reason: PersistentReservationNotLiveMigratable
      message: VMI uses SCSI persistent reservation
```

This is not a bug or a missing feature. It is a deliberate safety gate — migrating a VM that holds an SPR lock would either lose the lock on the destination (breaking the cluster that depends on it) or extend the lock ambiguously across two hosts (risking the data corruption SPR exists to prevent).

## Root Cause

SCSI Persistent Reservations are a SCSI-3 primitive that lets one initiator take exclusive ownership of a LUN and, optionally, grant a specific access mode (write-exclusive, exclusive-access, and several variants) to other initiators. A shared-disk cluster relies on SPR to coordinate who is allowed to write to the disk at any moment — typically each cluster node registers with the LUN at start-up and the active node holds a reservation that peers can see but not preempt.

Live migration, by contrast, depends on the VM's storage ownership being transferable between the source hypervisor host and the destination hypervisor host without an in-guest restart. The in-flight VM state (memory, CPU, device registers) hops across; the storage connection is expected to follow. With SPR:

1. The source host's initiator holds the active reservation on the LUN.
2. A live migration would pause the VM on the source, serialize its state across to the destination, and resume on the destination.
3. The destination host's initiator has a different initiator identity. Taking over the reservation requires a deliberate SPR operation (`RELEASE` + `RESERVE`, or a `PREEMPT` with a specific key) that cannot be done transparently without the guest OS participating.

Because there is no way to transfer the reservation *during* a single migration step without risking either breaking the in-guest cluster's assumption or leaving the LUN in an ambiguous state, KubeVirt refuses the migration up-front and records the status condition. The alternative — attempting the migration and discovering the problem halfway through — would be worse.

## Resolution

Two operational paths are available. Neither enables live migration for the specific VM configuration; the choice is about how maintenance on the host is handled instead.

### Path A — remove SPR from the shared-disk design

If the application or OS that runs on the VM does not actually require SPR-based coordination (some applications use shared storage but rely on application-level locks), drop SPR from the configuration. The VM becomes live-migratable again as soon as its `VirtualMachine` no longer requests persistent reservations.

Concretely:

- On the VM's `spec.template.spec.domain.devices.disks[].persistentReservation` entry (or the equivalent field your manifest uses), remove the reservation flag.
- Restart the VM so the new disk configuration takes effect.
- Verify the `LiveMigratable` condition flips to `True`:

  ```bash
  kubectl -n <ns> get vmi <vm-name> \
    -o jsonpath='{range .status.conditions[?(@.type=="LiveMigratable")]}{.type}={.status} {.reason} {.message}{"\n"}{end}'
  ```

Note that removing SPR may break whatever in-guest cluster relied on it. Confirm with the application owners before changing.

### Path B — accept that the VM is pinned and plan maintenance around restarts

For VMs that legitimately need SPR (Windows Failover Cluster with shared storage being the textbook example), leave the configuration alone and adjust operational procedure. During node maintenance:

1. Drain the node the normal way. The SPR-holding VM does not evict through live migration — it evicts through a **stop-and-restart**: KubeVirt shuts the VM down on the original host and restarts it on a new host.
2. The in-guest cluster sees the node as "down" for the duration of the restart and fails over to its peer, which is the intended cluster-aware behaviour.
3. Once the node is back, the VM can either stay on its new host or be rebalanced back by a subsequent stop/start — whichever is friendlier to the cluster's own failover policy.

Document which VMs cannot live-migrate so the maintenance procedure for the node they live on includes an explicit "expect this VM to restart" step, and so monitoring / paging rules around the guest cluster's failover events do not fire unnecessarily.

### Pair with a node-selector or PodAntiAffinity

If two SPR-holding VMs form a cluster, place them on different nodes so a single maintenance event only restarts one cluster member at a time. A `nodeSelector` or `podAntiAffinity` on the VM's underlying `virt-launcher` pod keeps them separated:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app.kubernetes.io/component: windows-failover-cluster
              topologyKey: kubernetes.io/hostname
```

The labels are applied to both cluster-member VMs; the anti-affinity keeps them on separate nodes so draining one never disrupts both simultaneously.

## Diagnostic Steps

Read the `LiveMigratable` condition on the VMI to confirm the specific reason:

```bash
kubectl -n <ns> get vmi <vm-name> -o yaml | \
  yq '.status.conditions[] | select(.type=="LiveMigratable")'
```

`reason: PersistentReservationNotLiveMigratable` is the specific reason this note addresses. Other reasons (`DisksNotLiveMigratable`, `HotplugNotSupported`, etc.) are different root causes and have different fixes.

Confirm the VM's disk configuration actually requests SPR:

```bash
kubectl -n <ns> get vm <vm-name> -o json | \
  jq '.spec.template.spec.domain.devices.disks[] | select(.persistentReservation != null)'
```

If no disk has `persistentReservation` set and the status still reports the SPR reason, the VM was recently migrated off SPR at the spec level but the VMI has not been restarted yet — delete the VMI so the VM controller recreates it:

```bash
kubectl -n <ns> delete vmi <vm-name>
kubectl -n <ns> get vmi <vm-name> -w
```

Once the fresh VMI reports `LiveMigratable=True`, migrations on the VM work as normal. If the VM continues to require SPR, use Path B: plan maintenance around a stop-and-restart for that specific VM and keep anti-affinity in place to protect the in-guest cluster during node events.
