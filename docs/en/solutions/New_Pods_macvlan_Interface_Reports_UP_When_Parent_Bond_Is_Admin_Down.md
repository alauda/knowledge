---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# New Pod's macvlan Interface Reports UP When Parent Bond Is Admin-Down
## Issue

A CNF pod uses a macvlan **secondary network** whose master is a VLAN sub-interface on top of a bonded physical interface (for example, `bond0.100` on top of `bond0`). The application inside the pod watches `/sys/class/net/net1/operstate` and expects to see `lowerlayerdown` if the underlying physical uplink is down, so that it can take its own failover action.

The observed behaviour splits by pod lifecycle:

- **Pods that already existed** when `bond0` is set administratively down correctly see `net1` transition to `lowerlayerdown`. Their applications detect the link failure and respond.
- **Pods created after** `bond0` is already down come up with `net1` reporting `up`. The application sees an apparently healthy link, transmits, and the traffic is silently black-holed.

Expected behaviour: any pod whose macvlan master has no carrier should see `lowerlayerdown`, regardless of whether the master went down before or after the pod was created.

Inside a newly created pod:

```text
$ cat /sys/class/net/net1/operstate
up

$ cat /sys/class/net/net1/carrier
1
```

Whereas an existing pod on the same node returns `lowerlayerdown` / `0`. On the node itself, `bond0` and `bond0.100` both show `state DOWN`.

## Root Cause

The macvlan driver maintains its operational state by listening for `NETDEV_CHANGE` notifier events from the master device. This is **reactive**: the macvlan interface's carrier is updated only when a state change event fires on the master. For already-existing macvlan interfaces this works — setting `bond0` down triggers a `NETDEV_CHANGE` propagated through `bond0.100`, and the driver updates each macvlan slave's carrier to `lowerlayerdown`.

When the CNI plumbing creates a **new** macvlan interface on a master that is already down, there is no `NETDEV_CHANGE` event to listen for. The macvlan driver initialises the slave interface and brings it up in the default state (`operstate: up`, `carrier: 1`) without checking the master's current carrier. The slave therefore lies about the link state until the next time `bond0` flaps — if that never happens, the lie persists for the life of the pod.

This is a kernel-side initialisation bug in the macvlan driver; the macvlan CNI plugin, NMState/NNCP, and Multus are all behaving correctly. A comparison clarifies where the bug lives: if `bond0.100` itself (rather than `bond0`) is set admin-down, new macvlan slaves on top of it report `lowerlayerdown` correctly. The difference is that an admin-down VLAN has its own `DOWN` state, while a VLAN that is down because its lower device is down carries the additional `M-DOWN` flag — and the initialisation path does not inspect the `M-DOWN` case.

## Resolution

ACP's node-level network declarative configuration is delivered through the **Immutable Infrastructure** extension using NMState/NNCP; secondary-network wiring inside pods uses Multus with the macvlan CNI. Because the bug is in the kernel driver's interface-creation path, there is no cluster-side workaround that makes the newly created slave honestly report `lowerlayerdown` while the master is admin-down. The practical fixes fall into two categories: avoid the window where a slave is created on a down master, or change how the application decides the link is healthy.

### Preferred: kernel fix for the macvlan initialisation path

The proper fix is for the macvlan driver to inspect the master device's carrier at initialisation time and carry the `LOWERLAYERDOWN` state forward into the new slave. Work is in progress upstream in the Linux kernel to do exactly that; the cluster will pick the fix up through a node-OS update once it merges and ships. Once the fixed node image is rolled out across the relevant worker pool, the bug disappears — no application or CNI changes are necessary.

Track the node-OS bump through the Immutable Infrastructure rollout:

```bash
kubectl get machineconfigpool
kubectl get node -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.osImage}{"\n"}{end}'
```

Compare `osImage` against the image known to carry the fix. Once every target node is on the new image, re-run the reproduction (admin-down bond, scale pod, read `operstate`) to confirm.

### Operational mitigation until the node-OS fix lands

These measures reduce the blast radius of the latent bug without eliminating it.

1. **Avoid admin-down on the bond itself. Prefer admin-down of the VLAN sub-interface.** Setting `bond0.100` admin-down (rather than `bond0`) causes new macvlan slaves to see `lowerlayerdown` correctly because the VLAN has a direct `DOWN` state, not `M-DOWN`. If the maintenance procedure can target the VLAN instead of the bond, the bug is sidestepped.

   In NNCP form:

   ```yaml
   apiVersion: nmstate.io/v1
   kind: NodeNetworkConfigurationPolicy
   metadata:
     name: down-vlan-on-nodeX
   spec:
     nodeSelector:
       kubernetes.io/hostname: <nodeX>
     desiredState:
       interfaces:
         - name: bond0.100
           type: vlan
           state: down
   ```

2. **Drain the node before admin-downing the bond.** If taking the bond down is intentional (e.g. for cable maintenance), cordon and drain the node first. With no pods on that node, no new macvlan slave will be created while the bond is down, so the bug has nothing to misreport.

   ```bash
   kubectl cordon <nodeX>
   kubectl drain <nodeX> --ignore-daemonsets --delete-emptydir-data --grace-period=60
   ```

3. **Augment the application's health check.** Since the reported `operstate` is unreliable when the master is admin-down, have the application watch a second signal:

   - `/sys/class/net/net1/carrier` shows `1` on the misreporting slave but still agrees that the slave is active only if the application also ARPs or pings a well-known neighbour on the secondary network. A one-shot ARP probe on startup catches the bug even when `operstate` lies.
   - Alternatively, have the CNF subscribe to netlink notifications directly — the first carrier event after pod start resynchronises the state, so a pod that stays alive long enough to see a bond flap will recover automatically.

### Fallback: plain upstream Multus (no NMState/NNCP management)

If the cluster manages host networking through something other than NMState (for example, static `ifcfg` files or another declarative tool), the bug surface is identical because it originates in the kernel. The same mitigations apply: prefer admin-down on the VLAN rather than the bond, drain the node before admin-down operations, and harden the application's liveness check so it does not trust `operstate` alone during a maintenance window.

## Diagnostic Steps

Confirm the NNCP that declares `bond0` and the VLAN sub-interface is applied:

```bash
kubectl get nncp
```

A healthy policy shows `STATUS=Available` and `REASON=SuccessfullyConfigured`. A policy stuck in `FailedToConfigure` is an independent problem — resolve it before investigating the macvlan slave state.

Verify the NetworkAttachmentDefinition is correct (macvlan in bridge mode, master set to the VLAN sub-interface):

```bash
kubectl get net-attach-def -n <ns>
kubectl get net-attach-def <nad-name> -n <ns> -o jsonpath='{.spec.config}{"\n"}'
```

The JSON should show `"type":"macvlan"` and `"master":"bond0.100"` (or whatever the target VLAN is).

Confirm the pod is actually attached to this NAD:

```bash
kubectl get pod <podname> -n <ns> \
  -o jsonpath='{.metadata.annotations.k8s\.v1\.cni\.cncf\.io/networks}{"\n"}'
```

On the worker node, inspect the bond and VLAN state:

```bash
kubectl debug node/<nodename> -- chroot /host bash -c '
  cat /sys/class/net/bond0/operstate
  cat /sys/class/net/bond0.100/operstate
  ip -d link show bond0.100
'
```

The `ip -d link show` output should show the VLAN with `state DOWN` plus `M-DOWN` when the bond (not the VLAN) is the admin-downed interface. Absence of `M-DOWN` with the VLAN in `DOWN` means it was admin-downed directly — in which case the bug does not apply.

Finally, reproduce the bug definitively: scale the Deployment by one replica while the bond is down, then read `net1/operstate` inside the new pod:

```bash
kubectl scale -n <ns> deploy/<dep> --replicas=<current+1>
kubectl exec -it -n <ns> <new-pod> -- cat /sys/class/net/net1/operstate
```

If the new pod's `net1` says `up`, the kernel initialisation bug is the root cause and no cluster-side knob will change that — apply the mitigations above and track the node-OS fix.
