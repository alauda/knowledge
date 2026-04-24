---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Workloads on a node intermittently drop network packets and `ethtool -S <iface>` reports growing counters such as `ring full` on the transmit side and `pkts rx OOB` on the receive side:

```text
Rx Queue#: 2
  ucast pkts rx: 7903511
  pkts rx OOB: 632
Tx Queue#: 0
  ring full: 88209
Tx Queue#: 1
  ring full: 87586
```

The default NIC ring buffer is too small for the burst rate that the workload presents. Raising it requires a kernel-level `ethtool` call that has to be re-applied across reboots and across new nodes joining the pool — exactly the kind of node-level configuration that should be expressed declaratively rather than scripted by hand.

## Root Cause

Linux NIC drivers expose two queue rings — receive (RX) and transmit (TX) — sized in descriptors. Each descriptor parks one packet between the driver and the host. When traffic arrives in bursts faster than the kernel can drain the ring, descriptors fill up; the next packet is either dropped (`pkts rx OOB`) or the TX path stalls (`ring full`). Increasing the ring size buys time for the host to catch up, at the cost of slightly higher latency and pinned DMA memory.

`ethtool -G <iface> rx N tx N` is the right kernel call, but issuing it imperatively on a node leaves no record of the desired state, gets reverted on reboot if the driver re-initialises, and has to be repeated for every freshly provisioned node. The platform's declarative node-tuning surface (`configure/clusters/nodes`, backed by the **Immutable Infrastructure** extension) is built precisely for this: an admin declares the tunable, the platform converts it into a per-node profile that survives reboots and re-applies to new nodes that match the selector.

## Resolution

1. **Identify the interface and confirm a higher ring size is supported.** From inside the node, the maximum supported value is what the driver reports; setting beyond that silently caps:

   ```bash
   NODE=<worker-node>
   IFACE=ens192
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host ethtool -g $IFACE
   ```

   The output lists `Pre-set maximums` (driver ceiling) and `Current hardware settings` (running values).

2. **Author a node-tuning profile for the chosen pool.** ACP runs the upstream Tuned daemon under its node-tuning surface; the same profile schema works. Target the worker pool (or a subset selected by label) and pin the device by udev regex so the profile only fires on the right NIC name.

   ```yaml
   apiVersion: tuned.alauda.io/v1
   kind: Tuned
   metadata:
     name: increase-ring-buffer
     namespace: cluster-node-tuning-operator
   spec:
     profile:
       - name: increase-ring-buffer
         data: |
           [main]
           summary=Raise NIC ring buffer to 4096/4096 on bursty workloads
           include=cluster-node
           [net]
           type=net
           devices_udev_regex=^INTERFACE=ens192
           ring=rx 4096 tx 4096
     recommend:
       - machineConfigLabels:
           node-role.kubernetes.io/worker: ""
         priority: 20
         profile: increase-ring-buffer
   ```

   Apply with `kubectl apply -f`. The Tuned DaemonSet picks up the new profile, evaluates the recommend rule on every selected node, and runs the equivalent of `ethtool -G ens192 rx 4096 tx 4096` once the kubelet is up.

3. **Limit blast radius before rolling cluster-wide.** Move one or two test nodes into a labelled sub-pool (`workload-class=ring-tuned`) and switch the recommend rule to that label first. Watch packet drops disappear from those nodes, then widen the selector.

4. **Plan around the boot window.** The new ring size only takes effect once the Tuned DaemonSet runs after kubelet start. For a few seconds at boot the NIC keeps the driver default. This is normally fine — nodes that need an enlarged ring at the very first packet should set the value through a kernel cmdline / module parameter via a node-configuration MachineConfig-equivalent instead.

5. **Avoid sysctl-only and ad-hoc service workarounds.** Hand-rolled systemd units that call `ethtool` on every boot drift out of sync with the platform's reconcile loop and survive past their useful life. Express the tunable through the node-tuning CR so the same selector that drains/uncordons the node also rolls the change.

## Diagnostic Steps

Confirm the profile landed on the target node:

```bash
kubectl -n cluster-node-tuning-operator get profile.tuned.alauda.io/<node>
kubectl -n cluster-node-tuning-operator logs ds/tuned -c tuned \
  | grep -i increase-ring-buffer
```

Verify the ring size took effect:

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ethtool -g $IFACE
```

`Current hardware settings` should now show `RX: 4096` and `TX: 4096` (or the requested value, capped at `Pre-set maximums`). Re-run `ethtool -S $IFACE` after the workload exercises the link; `ring full` and `pkts rx OOB` should stop incrementing. If they continue, the bottleneck is downstream of the ring (CPU softirq saturation, NUMA-misaligned IRQs, qdisc) and a larger ring will only mask the symptom briefly.
