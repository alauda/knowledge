---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500218
---

# Safely resizing CPU and memory on Alauda Container Platform nodes

## Issue

On Alauda Container Platform (Kubernetes server `v1.34.5`), the CPU or memory capacity of a worker or control-plane node sometimes needs to be increased without disrupting running workloads. The safe shape of this change is to move through the cluster one node at a time, so the remaining nodes continue to host the evicted pods while a single node is being modified. Treating the procedure as a per-node loop — rather than draining many nodes at once — keeps cluster capacity available and bounds the blast radius of any mistake during the resize.

## Resolution

For each node, mark the node unschedulable and evict its workloads before the underlying machine is touched. The `cordon` subcommand operates on a single node argument and sets the node into an unschedulable state so the scheduler stops placing new pods on it:

```bash
kubectl cordon <node-name>
```

Then drain the same node so its pods are evicted and rescheduled onto the remaining nodes. `kubectl drain` first cordons the node and then runs an eviction loop over the pods on it, which is the standard preparation step for node maintenance:

```bash
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

The drain command exposes the `--delete-emptydir-data` flag for evicting pods backed by `emptyDir` volumes; the older `--delete-local-data` flag is no longer present on current `kubectl` versions and must not be used. The `--ignore-daemonsets` flag is required whenever DaemonSet-managed pods are present, because without it the drain refuses to proceed; with the flag set, DaemonSet pods are skipped by the eviction loop and only pods that declare no controller block the drain.

Once the drain has completed, the now-empty node can be taken out for the underlying resize. Perform the underlying resize on the machine and return it to service when the change is complete. Because the earlier `cordon` set `spec.unschedulable=true` on the Node API object, that spec field continues to drive the `SchedulingDisabled` column shown by `kubectl get node -o wide` independently of the node's `Ready` condition, so the node remains unschedulable until it is explicitly uncordoned regardless of when it rejoins the cluster:

```bash
kubectl get node <node-name> -o wide
```

Return the node to active service with `uncordon`, which is the inverse of `cordon` and marks the node schedulable again so the scheduler can place new pods on it:

```bash
kubectl uncordon <node-name>
```

Repeat the cordon → drain → resize → uncordon sequence for the next node, keeping to one node at a time so the cluster always retains enough capacity to absorb the evicted workload.

## Diagnostic Steps

Inspect the node's state with `kubectl get node -o wide` at each step of the cycle. While the node is cordoned, the Node object reports `Ready` together with `SchedulingDisabled`, because the `Ready` condition is reported via `.status.conditions[type=Ready]` and the `SchedulingDisabled` column is driven by `spec.unschedulable` on the Node API:

```bash
kubectl get node -o wide
```

After `uncordon` runs, the `spec.unschedulable` field is cleared and the node returns to plain `Ready`, confirming that workloads can be scheduled on it again before the next node enters maintenance.
