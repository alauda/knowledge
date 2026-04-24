---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Operators sometimes need to grow (or refresh) the CPU and memory budget allocated to a worker or control-plane node — typically because workload pressure has outgrown the initial node sizing, or because the underlying hypervisor profile has been changed. The naive approach of editing the VM in vCenter while the kubelet is still running risks live workload corruption, half-drained pods, and an indefinite `NotReady` state once the node is powered back on.

The procedure below works for any node backed by a hypervisor VM (vSphere being the common case). It assumes the cluster is not using a Machine API integration that recreates the node from a template; if it is, the change must be made on the template / MachineSet instead so the new sizing survives the next reconcile.

## Resolution

Resize **one node at a time**. Never drain two control-plane nodes in parallel — etcd quorum cannot tolerate it. The loop for each node is: cordon, drain, power off, resize on the hypervisor, power on, wait for `Ready`, uncordon, wait for cluster stability, then move on.

1. **Cordon and drain the node.** Cordon prevents new pods from being scheduled; drain evicts everything that is not a DaemonSet or static mirror pod.

   ```bash
   NODE=<node-name>
   kubectl cordon "$NODE"
   kubectl drain "$NODE" \
     --delete-emptydir-data \
     --grace-period=1 \
     --ignore-daemonsets \
     --timeout=10m
   ```

   If the drain stalls on a stuck `terminationGracePeriodSeconds`, identify the offending pod with `kubectl get pod -A --field-selector spec.nodeName=$NODE` and either let it finish or force-delete it explicitly — do not extend the grace period blindly across the cluster.

2. **Power off the node.** From the hypervisor manager, issue a graceful shutdown (or `kubectl debug node/$NODE -- chroot /host shutdown -h now` if the hypervisor lacks an in-band shutdown control). Wait for the VM to reach `poweredOff` in the inventory before editing settings.

3. **Resize the VM.** In vCenter (or the equivalent control surface for the hypervisor in use), edit the VM hardware to increase vCPU and memory. Stay within the ratios validated for the node OS — for example, do not assign more vCPU than the underlying ESXi host has physical cores, and keep memory reservations consistent if the VM was previously over-provisioned.

4. **Power the VM back on and wait for the node to register.** A healthy node returns to the API server in under a minute:

   ```bash
   kubectl get node "$NODE" -o wide --watch
   ```

   Expected sequence: `NotReady,SchedulingDisabled` → `Ready,SchedulingDisabled`. The `SchedulingDisabled` flag is left over from the cordon and is removed in the next step.

5. **Uncordon the node.**

   ```bash
   kubectl uncordon "$NODE"
   ```

6. **Wait for the platform to settle.** Before touching the next node, let any cluster-level controllers re-converge. A simple gate is:

   ```bash
   kubectl get nodes
   kubectl get pods -A -o wide --field-selector=status.phase!=Running,status.phase!=Succeeded
   ```

   No node should be `NotReady`, and no critical control-plane pod should be in `CrashLoopBackOff` or `ContainerCreating`. If the cluster does not stabilise within a reasonable window, stop the loop, capture diagnostics (`kubectl describe node`, `kubectl -n kube-system logs <relevant-pod>`), and investigate before proceeding.

7. **Persist the change at the node-pool level.** A one-shot resize on the live VM survives only until that node is replaced. Update the corresponding node template, MachineSet, or hypervisor VM template so that any node *created* in the future inherits the new sizing — otherwise the next replacement reverts to the old shape and the cluster gradually drifts back.

## Diagnostic Steps

Confirm the new resource budget is visible to the kubelet after the reboot:

```bash
kubectl get node "$NODE" -o jsonpath='{.status.capacity}{"\n"}'
kubectl get node "$NODE" -o jsonpath='{.status.allocatable}{"\n"}'
```

`allocatable` is what the scheduler will actually offer to pods; it is `capacity` minus reserved overhead. If `capacity` did not grow after the resize, the hypervisor change did not take effect — power-cycle the VM rather than just rebooting from inside the guest, since hot-add of vCPU sometimes requires a full power state transition.

Verify nothing remained pinned to the node during the drain:

```bash
kubectl get pod -A --field-selector spec.nodeName="$NODE",status.phase!=Running
```

Empty output (or only DaemonSet / mirror pods) confirms the drain completed cleanly. Stuck pods at this stage usually indicate a PDB blocking eviction or a finalizer that the application controller never clears.
