---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.1"
---

# HAMi GPU resource semantics on ACP: gpualloc gives whole cards, compute share is not a hard cap, and exclusive cards

## Issue

Questions and surprises about what the HAMi resource values mean on Alauda Container Platform:

- A model was given `nvidia.com/gpualloc: 5` to get a fraction of one card, and the container sees 5 cards. The node shows a very large `nvidia.com/gpualloc`, for example `384` on a node with L20 cards (48G each) and `NVIDIA Device Split Count` set to `48` (Cause 1).
- Does "compute 20%" (`vgpu 算力` 20, meaning vGPU compute 20 in the console) mean the application can only ever use 20% of the card? How is the overcommit ratio set? (Cause 2)
- How does a task get whole GPUs exclusively under HAMi? Does HAMi-core still intercept CUDA calls in that mode? Can HAMi call remote GPUs? (Cause 3)
- On ACP 3.18, the physical GPU (pGPU) plugin only hands out whole cards, and the vGPU feature cannot be used to split them (Cause 4).

Related articles: *HAMi workload requests the wrong GPU resource name on ACP* (`Insufficient nvidia.com/gpu`, `limits.` prefixes, workbench GPU type), and *HAMi NVIDIA GPU Pod Pending with CardInsufficientMemory because gpumem was set as the total across cards*.

## Root Cause

### Cause 1: nvidia.com/gpualloc above 1 on a Pod requests that many whole cards

This is by design. `nvidia.com/gpualloc` means different things on a node and on a Pod:

- On the node, it is task capacity. The split count of the NVIDIA GPU device (install form field `NVIDIA Device Split Count`) is the number of tasks that can share one GPU at the same time. With a split count of 10, one card takes 10 Pods that each request 1 card at 10% compute; with 100, a card takes 100 Pods at 1% compute each. The node value adds that capacity up over its GPUs, which is why a node can show `384`.
- On a Pod, it is the number of physical cards. `nvidia.com/gpualloc: 5` asks for 5 cards.

`nvidia.com/gpucores` is the compute percentage on each card, and `nvidia.com/gpumem` is the memory on each card in MiB (for example `nvidia.com/gpucores: "50"` and `nvidia.com/gpumem: 8000`). Two Pods placed on one card, each with `gpucores` 50 and `gpumem` 24G, can together use all of that card's compute.

### Cause 2: vGPU compute is a logical share, and overcommit comes from the Scaling parameters

The HAMi compute value (`nvidia.com/gpucores`) is a logical allocation, not hard isolation:

- A workload allocated 20% compute is not held to 20% at all times. When no other workload uses the card, it can use more.
- When every Pod on the card runs at full load, each workload gets roughly its allocated share.
- Whether the allocations on one card can add up to more than 100% depends on the overcommit ratios. `NVIDIA Device Core Scaling` is the compute overcommit ratio and `NVIDIA Device Memory Scaling` the memory overcommit ratio. With a core ratio of 2, one GPU is allocatable as 200%. With both at `1` there is no overcommit, and the compute and memory allocated across workloads cannot exceed the physical card.

These values are part of the Alauda Build of HAMi plugin configuration, together with `NVIDIA Device Split Count`, `Node Scheduler Policy` (for example `binpack`), and `GPU Scheduler Policy` (for example `spread`).

### Cause 3: Exclusive whole-card use, HAMi-core interception, and remote GPUs

- Exclusive GPU use, the default behavior of nvidia-k8s-device-plugin, is a request for the GPU count resource with no compute or memory fields. The "use exclusive GPU" example of Alauda Build of HAMi writes it as `nvidia.com/gpu: 2`, which allocates two whole GPUs. On a cluster whose HAMi `resourceCountName` is `nvidia.com/gpualloc` (the default of the ACP install), the count resource to request is `nvidia.com/gpualloc`.
- In exclusive mode HAMi-core still intercepts the CUDA API, without enforcing compute and memory limits. Setting the environment variable `CUDA_DISABLE_CONTROL=true` in the workload Pod disables that interception.
- HAMi has no feature for calling remote GPU resources.

### Cause 4: On ACP 3.18, pGPU allocates whole cards only, and the vGPU feature needs CUDA below 12.4

On ACP 3.18, the physical GPU (pGPU) plugin allocates whole GPU cards only and cannot partition them; partitioning needs a sharing solution. The 3.18 vGPU feature requires a CUDA version lower than 12.4, so it cannot be used with, for example, NVIDIA A100 at CUDA 12.8. MPS or HAMi can partition cards instead. The pGPU and vGPU plugins can be deployed in the same cluster, and each node can use only one GPU scheduling method.

## Resolution

### Cause 1: nvidia.com/gpualloc above 1 on a Pod requests that many whole cards

Use this when the Pod requests `nvidia.com/gpualloc` above 1 and the intent was a share of one card. Request one card and set the share with `gpucores` and `gpumem`:

```yaml
resources:
  limits:
    nvidia.com/gpualloc: "1"
    nvidia.com/gpucores: "50"
    nvidia.com/gpumem: "8000"
```

To fit more tasks on each card, raise the split count in the HAMi plugin configuration. Keep `gpualloc` above 1 only for workloads that really need several cards, such as tensor parallelism across cards. One Pod cannot get more cards than a single node has.

### Cause 2: vGPU compute is a logical share, and overcommit comes from the Scaling parameters

Read the overcommit ratios in Administrator > Marketplace > Cluster Plugin > the target cluster > Alauda Build of HAMi: `NVIDIA Device Core Scaling` and `NVIDIA Device Memory Scaling`. Both at `1` means the allocations on a card cannot exceed the card. A value above `1` means the sum of allocations can exceed 100% of the card, so a workload can get less than its nominal share when all of them run at full load.

Upstream HAMi documents a container environment variable `GPU_CORE_UTILIZATION_POLICY` (`force` caps utilization at `gpucores` even when the card is idle). Test it on a non-production workload before relying on it.

### Cause 3: Exclusive whole-card use, HAMi-core interception, and remote GPUs

For exclusive cards, request only the count resource the node advertises:

```yaml
resources:
  limits:
    nvidia.com/gpualloc: "2"
```

To stop HAMi-core from intercepting CUDA calls in that workload, add:

```yaml
env:
- name: CUDA_DISABLE_CONTROL
  value: "true"
```

Set the variable only on workloads that request whole cards. HAMi-core is what enforces `gpucores` and `gpumem`, so a fractional workload with interception disabled is no longer held to its share. Remote GPU calls have no HAMi answer.

### Cause 4: On ACP 3.18, pGPU allocates whole cards only, and the vGPU feature needs CUDA below 12.4

Check the CUDA version on the node. At CUDA 12.4 or later, the 3.18 vGPU feature is not an option; deploy Alauda Build of HAMi on the nodes that need sharing, following its installation documentation, and keep the pGPU plugin on nodes that stay on whole cards.

```bash
nvidia-smi | grep -E 'CUDA Version|Driver Version'
kubectl get node -L gpu,nvidia-device-enable
```

> **Warning:** Moving a node from the pGPU plugin to HAMi changes which resource it advertises (`nvidia.com/gpu` versus `nvidia.com/gpualloc`), so Pods that request the old resource can no longer be scheduled on it. Each node can be owned by only one GPU manager (`gpu=on` for HAMi, `nvidia-device-enable=pgpu` for pGPU). Move nodes in a maintenance window, after the workloads that will run there are changed. Rollback is restoring the node's previous label.

## Diagnostic Steps

1. Read what the node advertises and which plugin owns it:

```bash
kubectl get node -L gpu,nvidia-device-enable
kubectl get node -o custom-columns='NAME:.metadata.name,GPUALLOC:.status.allocatable.nvidia\.com/gpualloc,GPUCORES:.status.allocatable.nvidia\.com/gpucores,GPUMEM:.status.allocatable.nvidia\.com/gpumem,GPU:.status.allocatable.nvidia\.com/gpu'
```

A very large `nvidia.com/gpualloc` on a node is the split count times the number of cards, not a card count.

2. Read what the Pod asks for. `gpualloc` above 1 for a share of one card is Cause 1.

```bash
kubectl get pod -n <namespace> <pod> -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.limits}{"\n"}{end}'
```

3. For a question about compute shares or overcommit, read `NVIDIA Device Core Scaling`, `NVIDIA Device Memory Scaling`, and `NVIDIA Device Split Count` on the plugin configuration page before answering (Cause 2).

4. For exclusive cards and interception, check whether the workload sets `CUDA_DISABLE_CONTROL` (Cause 3):

```bash
kubectl get pod -n <namespace> <pod> -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.env}{"\n"}{end}' | grep -E 'CUDA_DISABLE_CONTROL|GPU_CORE_UTILIZATION_POLICY'
```

5. On ACP 3.18, a node that serves `nvidia.com/gpu` through the pGPU plugin cannot split cards; record the CUDA version for Cause 4.
