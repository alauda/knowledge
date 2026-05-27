---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500214
---

# Defunct Processes From Exec Probes Driving Worker Node Pressure

## Issue

On Alauda Container Platform worker nodes running Kubernetes v1.34.5, defunct (zombie) processes can accumulate in the node process table when failing exec probes keep spawning short-lived helper processes that the container's main process does not reap. Exec probes are an actively used surface on this platform — across the workload set, eight pods declare a `livenessProbe.exec` and nine declare a `readinessProbe.exec`, covering components such as the `argocd` redis-ha pods, the `kube-system` Kube-OVN and OVS pods, and the `kubevirt` CDI pods — so the trigger pattern lands on real worker process trees.

The accumulation correlates with elevated node load and degraded responsiveness on the affected worker. The kubelet `stats/summary` endpoint exposes Pressure Stall Information for system containers, with `cpu.psi` reporting `full` and `some` averages over the standard `avg10` / `avg60` / `avg300` windows alongside `memory.availableBytes`, which is the native kubelet surface where the high-load signal becomes visible while zombies pile up.

## Root Cause

A defunct entry is a child process that has exited but whose parent has not collected its exit status, so the kernel keeps a slim task entry in the process table until reaping happens. When an exec probe re-fires on a tight interval and the container's main process does not reap the probe-spawned children, every failed probe iteration leaves another defunct entry behind, and the count grows for as long as the probe keeps firing against an unresponsive command. The probe-spawned children sit inside the container's process subtree under the container monitor / shim process that the kubelet drives through the CRI; the surviving subtree continues to accrue defunct rows for the same parent as the probe interval keeps re-firing.

Because each zombie occupies a PID-table slot and the kubelet stays busy driving probes and container lifecycle work, the per-node PSI counters climb as the count grows, which is the same `cpu.psi` signal surfaced by `stats/summary` for the kubelet system containers.

## Resolution

Restart the pod that is generating the defunct processes once it is identified, provided the workload tolerates a restart. The `pods` resource exposes the `delete` verb on this server (`VERBS [create delete deletecollection get list patch update watch]`), so a single `kubectl delete pod` is sufficient — the owning controller recreates the pod and the new container starts with a clean process table, no platform-specific primitive needed.

```bash
# Identify the offending pod, then delete it; the controller recreates it.
kubectl -n <namespace> delete pod <pod-name>

# Wait for the recreated pod to become Ready before re-measuring.
kubectl -n <namespace> wait --for=condition=Ready pod/<pod-name> --timeout=120s
```

If the same workload keeps re-producing defunct entries after the restart, address the underlying source: fix the application so its main process reaps its children, or correct the failing exec probe so it stops re-spawning commands that never get collected.

## Diagnostic Steps

List the defunct rows on the worker node and read the parent PID from the fifth field of the `ps -elfL` output. The ACP worker nodes run Ubuntu 22.04.1 with kernel 5.15 and the procps-ng `ps`, whose `ps -elfL` header is `F S UID PID PPID LWP C NLWP ...`, so the PPID column is the fifth field on every worker — that PPID identifies the parent process that is failing to reap its children.

```bash
# On the worker (via kubectl debug node), list defunct processes and read PPID (5th field).
kubectl debug node/<node-name> -- chroot /host ps -elfL | grep defunct

# Walk the process tree from that PPID to confirm the owning parent.
kubectl debug node/<node-name> -- chroot /host pstree -lp <ppid>
```

Walk the tree from the PPID with `pstree -lp` to confirm which container subtree owns the parent — the defunct rows sit under the container monitor / shim process that anchors the container's process hierarchy, with the parent being the container's own main process.

Watch the high-load signal on the affected worker through the kubelet `stats/summary` endpoint, which returns `systemContainers[].cpu.psi` with `full` and `some` `avg10` / `avg60` / `avg300` values plus `memory.availableBytes`, so the rising PSI averages can be tracked while the defunct count keeps climbing.

```bash
# Read PSI from the kubelet stats/summary endpoint via the apiserver proxy.
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/stats/summary"
```

If the count keeps climbing after a restart, the source workload is still active — the trigger surface remains the same set of pods that declare exec probes (for example the `argocd` redis-ha, `kube-system` Kube-OVN / OVS, and `kubevirt` CDI pods), so re-check whether one of those probes is failing in a tight loop.
