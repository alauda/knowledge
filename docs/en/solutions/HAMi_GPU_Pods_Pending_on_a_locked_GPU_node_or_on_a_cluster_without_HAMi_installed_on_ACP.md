---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# HAMi GPU Pods Pending on a locked GPU node or on a cluster without HAMi installed on ACP

## Issue

GPU Pods that should be served by HAMi stay `Pending` in one of these two forms:

- A newly added GPU node shows as `locked` when Pods are scheduled to it, and Pods for that node do not start (Cause 1).
- The project quota still has HAMi GPU capacity left, but newly created containers cannot start. The event is `FailedScheduling` with, for example, `0/7 nodes are available: 1 Insufficient nvidia.com/gpucore, 1 Insufficient nvidia.com/gpumem, 1 Insufficient nvidia.com/gpu, ...`. On the node that should take the Pod, `nvidia-smi` prints `bash: nvidia-smi: command not found`. The cluster plugin page of another cluster can show Alauda Build of HAMi as published, while it is absent here (Cause 2).

Related articles: *HAMi GPU Pods stay Pending while GPUs are free: expired certificate or default-scheduler on ACP* (HAMi is installed and running, the page shows free GPU), and *HAMi or NVIDIA device-plugin Pod missing, Pending, or failing on a GPU node on ACP* (the device-plugin Pod itself does not run on the node).

## Root Cause

### Cause 1: A leftover hami.io/mutex.lock annotation keeps the GPU node locked

HAMi records its per-node allocation lock (NodeLock) as the node annotation `hami.io/mutex.lock`. In rare cases a residual `hami.io/mutex.lock` stays on a newly added node and blocks Pods scheduled there; the node is reported as `locked`. Waiting for the lock to time out, restarting the device plugin on that node, or removing the annotation by hand releases it. HAMi 2.7 and later contain a NodeLock fix. HAMi 2.7.1 still has the certificate and `schedulerName` defects described in the related article, so if those also match, upgrade to 2.8.0 or later rather than stopping at 2.7.1.

### Cause 2: Alauda Build of HAMi is not installed on the cluster that owns the Pending Pod

The project quota is not the blocker: HAMi NVIDIA vGPU count, vGPU cores, vGPU memory, and physical GPU count all have capacity left, and CPU, memory, and Pod quotas are fine. The node's GPU availability is 0, and `nvidia-smi` is not found on the node. The plugin was uninstalled earlier, and a later reinstall was applied to a different cluster. A plugin listed as published on another cluster's plugin page (for example the marketplace version `v3.9.0`, which is the listing version, not the upstream HAMi image tag) does not register any device on this cluster. Reinstalling Alauda Build of HAMi on the cluster that owns the Pending Pod restores scheduling; no PersistentVolume change and no separate host driver installation are part of that recovery.

The resource names in this event (`nvidia.com/gpucore`, `nvidia.com/gpu`) are what the event printed; on a cluster where the plugin is running, HAMi advertises `nvidia.com/gpualloc`, `nvidia.com/gpucores`, and `nvidia.com/gpumem`.

## Resolution

### Cause 1: A leftover hami.io/mutex.lock annotation keeps the GPU node locked

Use this only when the node carries `hami.io/mutex.lock` or the scheduling message says the node is locked, and the certificate and `schedulerName` checks of the related article do not match. Waiting for the lock to time out is non-disruptive. If it does not clear, restart the device-plugin Pod on that node.

> **Warning:** Deleting the `hami-device-plugin` Pod on the locked node unregisters that node's HAMi devices until the DaemonSet recreates the Pod. Running GPU containers are not deleted; new GPU Pods for that node wait during the restart. Only when the node carries `hami.io/mutex.lock` and Pods for that node are stuck. Rollback is the DaemonSet recreating the Pod.

```bash
kubectl get pod -n kube-system -o wide --field-selector spec.nodeName=<node> | grep hami-device-plugin
kubectl delete pod -n kube-system <hami-device-plugin-pod-on-that-node>
```

If the annotation is still there after the new device-plugin Pod is Ready, remove it by hand.

> **Warning:** Removing `hami.io/mutex.lock` releases HAMi's allocation lock on that node. If an allocation is genuinely in progress on the node at that moment, two allocations can race for the same device. Only when the lock is leftover: no GPU Pod for that node is being admitted, and the lock has stayed after the device-plugin restart. Record the value first. There is nothing to restore by hand; HAMi manages the annotation itself on later allocations.

```bash
kubectl get node <node> -o jsonpath='{.metadata.annotations.hami\.io/mutex\.lock}{"\n"}'
kubectl annotate node <node> hami.io/mutex.lock-
```

If the installed HAMi is older than 2.7, upgrade Alauda Build of HAMi to 2.7 or later for the NodeLock fix, or to 2.8.0 or later if the certificate or `schedulerName` defects also apply.

### Cause 2: Alauda Build of HAMi is not installed on the cluster that owns the Pending Pod

Use this only when this cluster has no `hami-scheduler` and no `hami-device-plugin` Pod. Confirm you are working on the cluster that owns the Pending Pod before installing.

```bash
kubectl get pods -A -o wide | grep -E 'hami-scheduler|hami-device-plugin'
kubectl get ds,deploy -A | grep -i hami
```

> **Warning:** Installing or reinstalling the HAMi cluster plugin starts HAMi admission and device registration on this cluster; new GPU Pods stay Pending until `hami-scheduler` and the device-plugin Pods are Ready. Running containers are not deleted by the install itself. Only on this cluster, and only after the Pod list confirms the plugin workloads are absent here. Take a maintenance window if production GPU scheduling must continue. Rollback is uninstalling the plugin from the same cluster plugin page. Leave the copy on the other cluster as it is.

Install Alauda Build of HAMi from Administrator > Marketplace > Cluster Plugin, with the cluster that owns the Pending Pod selected. After the new Pods are Ready, read the node allocatable again:

```bash
kubectl get node -o custom-columns='NAME:.metadata.name,GPUALLOC:.status.allocatable.nvidia\.com/gpualloc,GPUMEM:.status.allocatable.nvidia\.com/gpumem,GPUCORES:.status.allocatable.nvidia\.com/gpucores'
```

If the only remaining event is `didn't find available persistent volumes`, that is a storage problem, not this cause. If `nvidia-smi` is still `command not found` after the plugin is Ready, do not repeat the reinstall; collect the node driver state instead. A node with no working NVIDIA driver, where the plugin is installed but its Pod does not run, is covered in *HAMi or NVIDIA device-plugin Pod missing, Pending, or failing on a GPU node on ACP*.

## Diagnostic Steps

1. List the HAMi workloads on the cluster that owns the Pending Pod. An empty list is Cause 2; stop the certificate checks.

```bash
kubectl config current-context
kubectl get pods -A -o wide | grep -E 'hami-scheduler|hami-device-plugin|hami-webui|hamiwebui'
```

2. For a locked node, read the annotation and when it appeared. A node that is cordoned or tainted is a different problem.

```bash
kubectl describe node <node> | grep -i -E 'Taint|lock|mutex|unschedulable'
kubectl get node <node> -o jsonpath='{.metadata.annotations}' | tr ',' '\n' | grep -i mutex
```

Expected for Cause 1: a `hami.io/mutex.lock` annotation that stays while no GPU Pod is being admitted to the node.

3. Read the scheduler and device-plugin logs around the failure:

```bash
kubectl logs -n kube-system <hami-scheduler-pod> --since=30m --tail=200
kubectl logs -n kube-system <hami-device-plugin-pod> --since=30m --tail=200
```

4. On the node, check the driver:

```bash
nvidia-smi
```

`command not found` together with no HAMi Pods on the cluster is Cause 2. `command not found` while HAMi is installed and its device-plugin Pod does not run on that node is a driver problem, covered in the device-plugin article.
