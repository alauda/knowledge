---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# virt-launcher Pods Stuck Terminating When a Worker Node Goes Unreachable
## Issue

A worker node drops off the network (power loss, NIC failure, hypervisor panic) and enters `NotReady` with `Kubelet stopped posting node status`. VirtualMachineInstances that were running on that node do **not** fail over to healthy workers:

- Their `virt-launcher` pods stay in `Terminating` indefinitely.
- The VMI objects are not recreated elsewhere.
- Any attempt to live-migrate the affected VMs times out (the source agent is no longer reachable).

Applications running inside those VMs are down for as long as the node is `NotReady`, even though other workers have ample capacity.

## Root Cause

Kubernetes is deliberately conservative about declaring a pod dead when its host stops responding. When a node's kubelet goes silent:

1. The control plane marks the node `NotReady` after `node-monitor-grace-period`.
2. The `taint-manager` applies the `node.kubernetes.io/unreachable:NoExecute` taint after the monitor grace period and evicts pods only after `tolerationSeconds` (default 300s).
3. Pods on the dead node move to `Terminating`, but their `deletionTimestamp` **cannot be acknowledged** because the kubelet (which would normally finalize termination) is unreachable. They stay in `Terminating` forever until the node object is deleted or the kubelet recovers.

VMIs inherit this behaviour from their `virt-launcher` pods. The VMI controller considers the VM to still be "running on" the old node until the pod is fully terminated; no replacement virt-launcher is created while that is true. This protects against split-brain — recreating the VM on another node while the original host is alive but partitioned would result in two hypervisors writing the same disk — but it means HA is not automatic when the node is genuinely dead.

## Resolution

Once you are certain the node is truly gone (powered off, hardware failed, hypervisor crashed), the remedy is to remove the node from the cluster's view. Removing the node forces the control plane to garbage-collect the stranded pods, which in turn unblocks the VMI controller to schedule replacement `virt-launcher` pods.

1. **Confirm the node is not coming back soon.** The sequence below is destructive to failover ordering; do not run it if there's a chance the node will rejoin in the near term.

   ```bash
   kubectl get node <node> -o wide
   kubectl describe node <node> | sed -n '/Conditions/,/Addresses/p'
   # verify out-of-band: is the host actually powered off?
   ```

2. **Delete the node.** This causes the controller manager to tear down the stranded pods:

   ```bash
   kubectl delete node <node>
   ```

   Within a few seconds the `Terminating` `virt-launcher` pods transition to `Terminated` and are garbage-collected. The VMI controller then notices the VMIs are no longer running and recreates their `virt-launcher` pods on healthy nodes (obeying affinities, tolerations, PDBs, and capacity).

3. **When the node returns, rejoin cleanly.** Once the underlying issue is fixed, power the host back on and let it re-register with the cluster. The rejoin flow is the standard node-join process — nothing extra is needed from the virtualization side.

4. **Protect long-term against repeat incidents.** `kubectl delete node` is a manual-intervention workflow. For clusters that need automatic VM failover:

   - Enable the platform's node-health-check feature (where available) to fence unresponsive nodes and delete the node object after a configurable window. This converts the manual step above into an automated one with safety checks.
   - Shorten `tolerationSeconds` on unreachable taint for VMI-hosting workloads if your storage can safely take the split-brain risk; raise it for workloads that must never be double-run.
   - Run stateless front-ends that can absorb the ~10–15 minute failover window behind a Service, so the application-facing impact is soaked by the rest of the topology.

5. **Do not `--force` delete the pods directly.** `kubectl delete pod --force --grace-period=0` removes the pod object but does not wake up the VMI controller's reconciliation cleanly, and if the node ever comes back you'll have two virt-launcher pods competing for the same disk. Delete the node, not the pods.

## Diagnostic Steps

Confirm the node is marked as stopped reporting:

```bash
kubectl get node <node> -o jsonpath='{.status.conditions[?(@.type=="Ready")]}' | jq
# {"lastHeartbeatTime":"...","lastTransitionTime":"...","message":"Kubelet stopped posting node status.",
#  "reason":"NodeStatusUnknown","status":"Unknown","type":"Ready"}
```

List the stuck pods bound to it:

```bash
kubectl get pod -A -o wide \
  --field-selector spec.nodeName=<node>,status.phase=Running | grep -i Terminating
kubectl get pod -A -o wide \
  --field-selector spec.nodeName=<node> | grep -i Terminating
```

Verify the VMIs that were running on the dead node:

```bash
kubectl get vmi -A -o wide | awk -v n=<node> '$NF==n'
```

After deleting the node, confirm the VMI controller recreates `virt-launcher` pods within a minute or two:

```bash
kubectl get vmi -A -o wide --watch
kubectl get pod -A -l kubevirt.io=virt-launcher --watch
```

If VMIs do not reschedule even after the node is removed, check for pinned affinities, missing tolerations on the replacement nodes, or PDB-driven blocks: `kubectl get vmi <vmi> -o yaml | grep -A20 -E 'affinity:|tolerations:'` and `kubectl -n <ns> get pdb`.
