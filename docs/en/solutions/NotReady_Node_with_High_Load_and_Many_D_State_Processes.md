---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
---

# Node NotReady with high load average and D-state processes on ACP

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`, nodes running Ubuntu 22.04.1 LTS with kernel `5.15.0-56-generic` and stock upstream sunrpc / NFS client modules), a node can flip to `STATUS=NotReady` in `kubectl get nodes` while `uptime` on the same host reports a 1/5/15-minute load average roughly equal to a large number of processes stuck in the `D` (uninterruptible sleep) task state, with negligible actual CPU consumption. The Linux kernel includes uninterruptible-sleep tasks in the load-average accounting, so a wave of blocked tasks inflates the load number even when no process is on a CPU. The Node object's Ready condition follows the upstream `.status.conditions[?(@.type=='Ready')]` shape on ACP, so a healthy node prints `reason=KubeletReady` / `status=True` / `message=kubelet is posting ready status`; the NotReady transition surfaces on the same field when the kubelet's host is starved of forward progress.

## Root Cause

The blocked tasks are sleeping in the kernel sunrpc client. Sampling per-thread state with `ps -elfL` exposes a `WCHAN` column for each thread, and the WCHAN value `rpc_wa` (a truncation of the kernel symbol `rpc_wait_bit_killable`) marks a thread that is parked inside the sunrpc client waiting for an RPC reply. Threads sleeping in `rpc_wait_bit_killable` are typically waiting for a response from an NFS server. A non-responsive NFS server prints matching lines into the node's kernel ring buffer: `nfs: server <ip> not responding, timed out` and `nfs: server <ip> not responding, still trying` are the canonical kernel log strings for the stalled mount. As more application threads touch the hung mount, more of them are taken into D state, the load average climbs in proportion to the backlog, and the host eventually carries enough uninterruptible work that the kubelet's Ready condition flips off `True` and the node surfaces as NotReady.

The persistence of the pileup is a property of the NFS hard-mount semantics: on a hard mount (the default), threads waiting on the server cannot be interrupted by any signal, so `kill -9` against a D-state thread blocked in `rpc_wait_bit_killable` has no effect. Mounting NFS with the `soft` option instead causes the client to return an error to the calling application after `retrans` retransmissions instead of blocking indefinitely; the trade-off is the possibility of silent data corruption when a request that did reach the server is reported as failed, which is why `hard` is the upstream default.

## Resolution

Repair the underlying NFS server / network fault first — these steps live outside the cluster (restore the NFS server, fix the network path, or unexport the volume). Because a hard mount retries indefinitely rather than failing, threads parked in `rpc_wait_bit_killable` resume once the server answers their outstanding RPCs, so once the server is reachable again a portion of the D-state backlog typically clears on its own without further action. Reboot the affected node only when threads remain stuck in `D` after the server is confirmed reachable, or when the accumulated backlog has already driven the node to NotReady and you need to return it to service promptly; in that case reboot strictly after the fault is repaired, otherwise the same backlog rebuilds on the next mount access. Drain the node, reboot it, and return it through the normal cordon / uncordon flow.

For workloads that can tolerate an application-visible error instead of an indefinite wait, remount the affected NFS volume with the `soft` option so the client returns to userspace after `retrans` retransmissions; accept that this exposes the workload to silent data corruption on partially completed writes, which is the reason `hard` is the upstream default. The same `hard`/`soft`/`retrans` semantics apply uniformly to NFS-backed PVs on this platform: the catalog ships an NFS CSI ModulePlugin (`chart-csi-driver-nfs`, default channel `v4.4.0-beta.7`) that mounts via the standard Linux NFS client, so kernel-side mount options carry through unchanged on Kubernetes `v1.34.5` clusters.

## Diagnostic Steps

Confirm the node-level symptom from the cluster side first. `kubectl get nodes` shows `STATUS=NotReady` for the affected node, and the Ready condition on `.status.conditions[?(@.type=='Ready')]` carries the upstream NodeCondition fields (`type`, `status`, `reason`, `message`, `lastHeartbeatTime`, `lastTransitionTime`); a healthy peer prints `reason=KubeletReady` / `message=kubelet is posting ready status`, so a comparison against any Ready peer is the quickest sanity check:

```bash
kubectl get nodes
kubectl get node <node-name> -o jsonpath="{.status.conditions[?(@.type=='Ready')]}{'\n'}"
```

Open a host-level shell on the affected node through the cluster's standard node-access method — typically a `kubectl debug node/<name>` debug pod, direct SSH from the installer host, or whatever node-admin path the platform documents; the host-side diagnostic commands themselves (`uptime`, `ps -elfL`, `dmesg`) are unchanged across entry paths. From that host shell, inspect the load average and the count / WCHAN of D-state threads. A load average far above the runnable-process count combined with `ps -elfL` rows whose state column is `D` and whose `WCHAN` column reads `rpc_wa` confirms threads blocked inside the sunrpc client:

```bash
uptime
ps -elfL | awk '{if($2~"D"){print $13}}' | sort | uniq -c
```

Read the kernel ring buffer for NFS-server timeout messages — the `nfs: server <ip> not responding, timed out` and `nfs: server <ip> not responding, still trying` lines identify which server is stalled:

```bash
dmesg -T | grep -E 'nfs: server .* not responding'
```

Attempting to clear the backlog with signals is expected to fail: sending `SIGKILL` to a thread blocked in `rpc_wait_bit_killable` on an NFS hard mount does not interrupt the sleep, so `kill -9 <pid>` against such a thread leaves it in `D`. Once the underlying NFS fault has been repaired, reboot the node to drain the accumulated D-state tasks.
