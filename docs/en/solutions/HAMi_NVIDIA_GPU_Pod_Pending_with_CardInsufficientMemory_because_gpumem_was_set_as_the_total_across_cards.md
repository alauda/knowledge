---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# HAMi NVIDIA GPU Pod Pending with CardInsufficientMemory because gpumem was set as the total across cards

## Issue

A GPU container that needs a lot of GPU memory is scheduled by HAMi and never starts:

- The Pod stays `Pending`, and `hami-scheduler` reports `CardInsufficientMemory` for it.
- The Pod requests more than one card with `nvidia.com/gpualloc` and sets `nvidia.com/gpumem` to the memory of all those cards added together, for example `nvidia.com/gpualloc: 2` with `nvidia.com/gpumem: 163840` (160 GiB) on a node with NVIDIA A100 80GB cards.
- The cards on the node can be completely idle, and the HAMi components are healthy.

A request that fits the total memory of one card but not what is still free on the cards, or `CardInsufficientMemory` on an Ascend NPU, is a different problem. A node that does not advertise `nvidia.com/gpumem`, or a Pod that keeps `schedulerName: default-scheduler`, is covered in *HAMi GPU Pods stay Pending while GPUs are free: expired certificate or default-scheduler on ACP*.

## Root Cause

### Cause 1: nvidia.com/gpumem is per card, and the request is larger than one card

In HAMi, `nvidia.com/gpumem` is a per-card value in MiB. It applies to every card that `nvidia.com/gpualloc` asks for; it is not divided across them. A Pod written as if `163840` were the memory of both cards combined asks for 163840 MiB on each of two cards. An A100 80GB card has about 81920 MiB, so no card can ever satisfy the request, `hami-scheduler` reports `CardInsufficientMemory`, and the Pod stays `Pending`. Free cards on the node do not change this: the request is larger than any single card, not larger than what is left.

`nvidia.com/gpucores` follows the same rule. It is a percentage of each card, so a Pod that wants two whole cards keeps `gpucores` at `100`, not `200`.

The console can carry the same mistake into a workload: a `HAMi NVIDIA` extended resource entered in the console as GPU count 2 and vGPU memory 163840 Mi appears with the same numbers in the container limits (`nvidia.com/gpualloc: "2"`, `nvidia.com/gpumem: "163840"`). Read the generated YAML, not only the form.

## Resolution

### Cause 1: nvidia.com/gpumem is per card, and the request is larger than one card

Use this only when `hami-scheduler` reports `CardInsufficientMemory` for an NVIDIA GPU Pod and the Pod's `nvidia.com/gpumem` is larger than the total memory (`memory.total`) of one card on the node it is meant for. Set the per-card value to no more than the capacity of one card.

For a Pod that needs two whole A100 80GB cards:

- keep `nvidia.com/gpualloc` at `2` and `nvidia.com/gpucores` at `100`;
- change `nvidia.com/gpumem` to `81920` or slightly less, for example `80000`;
- make the same change in both `requests` and `limits`;
- update the workload, then check that the rebuilt Pod leaves `Pending`.

```yaml
resources:
  requests:
    nvidia.com/gpualloc: "2"
    nvidia.com/gpucores: "100"
    nvidia.com/gpumem: "80000"
  limits:
    nvidia.com/gpualloc: "2"
    nvidia.com/gpucores: "100"
    nvidia.com/gpumem: "80000"
```

The memory the Pod gets in total is `gpualloc` multiplied by `gpumem`, here 2 x 80000 MiB. A model that needs more than one card's memory has to be spread across the cards by the application itself, for example with tensor parallelism; raising `gpumem` above one card does not create a bigger card.

For a Deployment or StatefulSet, edit the template.

> **Warning:** Saving a changed Pod template rolls the workload: old Pods are replaced, in-flight requests on them end, and the new Pods get the corrected per-card memory. Only when the `CardInsufficientMemory` signature and the per-card overflow are both confirmed. Record the current resources first. Rollback is `kubectl rollout undo -n <namespace> deploy/<workload>` (or `sts/<workload>`), which brings the `Pending` state back.

```bash
kubectl get deploy -n <namespace> <workload> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\t"}{.resources}{"\n"}{end}' > "$HOME/<workload>-resources.txt"
kubectl edit deploy -n <namespace> <workload>
kubectl get pod -n <namespace> -o wide | grep <workload>
```

A Kubernetes Job cannot have its Pod template changed in place, so a Job is recreated from a corrected copy.

> **Warning:** Deleting the Job deletes its Pods and its run history; anything the Job had not written to persistent storage is lost. Only for a Job whose Pod is still `Pending` with this signature. Before re-creating from a saved copy, remove `spec.selector`, the `controller-uid` and `batch.kubernetes.io/controller-uid` labels in the template, and the `status` block, or the API server rejects it. Rollback is re-creating the Job from the original saved copy after the same cleanup; the deleted run history is not restored.

```bash
kubectl get job -n <namespace> <job> -o yaml > "$HOME/<job>-original.yaml"
cp "$HOME/<job>-original.yaml" "$HOME/<job>-fixed.yaml"
# edit $HOME/<job>-fixed.yaml: per-card nvidia.com/gpumem in requests and limits; drop selector, controller-uid labels and status
kubectl delete job -n <namespace> <job>
kubectl apply -f "$HOME/<job>-fixed.yaml"
```

If the plugin's `NVIDIA Device Memory Scaling` is above `1`, upstream HAMi registers each card with its physical memory multiplied by that ratio. Read that value before choosing the ceiling; with the ratio at `1`, the ceiling is the physical memory of one card.

## Diagnostic Steps

1. Read what the Pod requests in both `requests` and `limits`. Note `nvidia.com/gpualloc`, `nvidia.com/gpucores`, and `nvidia.com/gpumem`.

```bash
kubectl get pod -n <namespace> <pod> -o jsonpath='scheduler={.spec.schedulerName}{"\n"}{range .spec.containers[*]}{.name}{"\trequests="}{.resources.requests}{"\tlimits="}{.resources.limits}{"\n"}{end}'
```

2. Confirm the signature in the Pod events and the `hami-scheduler` log:

```bash
kubectl get events -n <namespace> --field-selector involvedObject.name=<pod> --sort-by=.lastTimestamp
kubectl logs -n kube-system deploy/hami-scheduler --all-containers --since=30m | grep -E 'CardInsufficientMemory|<pod>'
```

3. Compare the per-card request with one card. Node allocatable `nvidia.com/gpumem` is a node-wide sum; the comparison that matters is against a single card's `memory.total` on the target node:

```bash
kubectl get node -o custom-columns='NAME:.metadata.name,GPUALLOC:.status.allocatable.nvidia\.com/gpualloc,GPUMEM:.status.allocatable.nvidia\.com/gpumem,GPUCORES:.status.allocatable.nvidia\.com/gpucores'
nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv
```

4. Decide:
   - per-card `gpumem` above one card's `memory.total`: this article;
   - per-card `gpumem` within one card's total, but the cards are partly used by other Pods: there is not enough free memory left on any card;
   - the request fits an idle card and the Pod is still `Pending`: see *HAMi GPU Pods stay Pending while GPUs are free: expired certificate or default-scheduler on ACP*.
