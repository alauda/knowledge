---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda AI
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.1"
---

# HAMi workload requests the wrong GPU resource name on ACP

## Issue

On a cluster that uses Alauda Build of HAMi, a GPU workload stays `Pending` or does not start because of the resource names it requests:

- Workloads that use the native GPU resource cannot get a GPU after HAMi vGPU custom extended resources were configured as documented. GPU nodes report only `nvidia.com/gpualloc` and no `nvidia.com/gpu`, and the event is `0/6 nodes are available: 1 Insufficient nvidia.com/gpu, ...` (Cause 1).
- A HAMi GPU Pod fails with `FailedScheduling: 0/1 nodes are available: 1 Insufficient nvidia.com/gpu`, and its YAML carries an extra `nvidia.com/gpu: 2` next to the HAMi resources (Cause 2).
- An Alauda AI workbench does not start after it is deployed with a PVC mounted (Cause 3).
- A workload deployed from the console with HAMi extended resources stays `Pending` with `FailedScheduling: 0/3 nodes are available: 3 Insufficient limits.nvidia.com/gpualloc, 3 Insufficient limits.nvidia.com/gpucores, 3 Insufficient limits.nvidia.com/gpumem` (Cause 4).

Related articles: *HAMi GPU resource semantics on ACP: gpualloc gives whole cards, compute share is not a hard cap, and exclusive cards* (what the resource values mean), *HAMi NVIDIA GPU Pod Pending with CardInsufficientMemory because gpumem was set as the total across cards*, and *HAMi GPU Pods stay Pending while GPUs are free: expired certificate or default-scheduler on ACP* (the Pod requests the right resources and the node advertises them).

## Root Cause

### Cause 1: Nodes report only nvidia.com/gpualloc, and the workload asks for native nvidia.com/gpu

Alauda Build of HAMi, installed by its installation guide, uses the custom extended resource `nvidia.com/gpualloc` instead of the native `nvidia.com/gpu`: the `hami-scheduler-device` ConfigMap in `kube-system` has `resourceCountName: nvidia.com/gpualloc` in the `nvidia` section of `device-config.yaml`. HAMi nodes therefore report only `nvidia.com/gpualloc` in Capacity and Allocatable (for example `nvidia.com/gpualloc: 32`).

A Deployment that requests `nvidia.com/gpu: "1"` together with `nvidia.com/gpucores` and `nvidia.com/gpumem-percentage` cannot be placed:

```text
"Unable to schedule pod; no fit; waiting" err="0/6 nodes are available: 1 Insufficient nvidia.com/gpu, 2 node(s) didn't match Pod's node affinity/selector, 3 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }. ..."
```

The Pod condition is `PodScheduled` `False` with reason `Unschedulable`. HAMi and the physical-GPU (pGPU) plugin cannot run on the same node, so while HAMi owns a node a Pod that requests `nvidia.com/gpu` cannot be served there. Restarting `hami-scheduler`, or making sure the Pod's `schedulerName` is `hami-scheduler`, does not help. This applies on ACP 4.1 with HAMi 2.7.1 and on any HAMi node configured the same way.

### Cause 2: A HAMi Pod also carries nvidia.com/gpu

A container whose limits carry `nvidia.com/gpu: "2"` next to `nvidia.com/gpualloc: "2"`, `nvidia.com/gpucores: "200"`, and `nvidia.com/gpumem: "163840"` fails with `Insufficient nvidia.com/gpu`, because the HAMi node does not advertise `nvidia.com/gpu`. The NVIDIA GPU count and the HAMi parameters (`gpualloc`, `gpucores`, `gpumem`) are mutually exclusive on one container. Removing the `nvidia.com/gpu` entry lets the container be created and run.

If the Pod then reports `CardInsufficientMemory`, compare its per-card `nvidia.com/gpumem` with the memory of one card; see the related `CardInsufficientMemory` article.

### Cause 3: An Alauda AI workbench was created with a physical GPU instead of HAMi

The workbench fails to start after it is deployed with a PVC mounted, but the PVC is not the cause. The workbench was created with a physical GPU selected, not HAMi, and no node has enough allocatable physical GPU for that request.

### Cause 4: The console added a limits. prefix to the resource names

The workload was created from the Container Platform deployment form with the extended resource type `HAMi NVIDIA`, and the generated YAML carries, under the container's `resources.limits`, names such as `limits.nvidia.com/gpualloc: "2"`, `limits.nvidia.com/gpucores: "25"`, and `limits.nvidia.com/gpumem: "20480"`. No node advertises resources with those names, so the Pod cannot be scheduled. This is a console defect, fixed in ACP 4.1.4.

The `limits.` prefix is the key form used in a `ResourceQuota`. In a container's `resources.limits` the names are `nvidia.com/gpualloc`, `nvidia.com/gpucores`, and `nvidia.com/gpumem` without a prefix.

## Resolution

### Cause 1: Nodes report only nvidia.com/gpualloc, and the workload asks for native nvidia.com/gpu

Use this only when the node lists `nvidia.com/gpualloc` and no `nvidia.com/gpu`, the node is a HAMi node (`gpu=on`), and the failing Pod requests `nvidia.com/gpu`. The simplest fix is to change the workload to request `nvidia.com/gpualloc` together with `nvidia.com/gpucores` and `nvidia.com/gpumem`.

When the site wants HAMi to accept the native name instead, change every `nvidia.com/gpualloc` to `nvidia.com/gpu` in two places:

- `hami-scheduler-device` in `kube-system`: `device-config.yaml`, field `nvidia.resourceCountName`.
- The custom extended resource ConfigMap from the installation documentation, `cf-crl-hami-nvidia-gpualloc` in `kube-public` (labels `features.cpaas.io/group: hami-nvidia` and `features.cpaas.io/type: CustomResourceLimitation`): the corresponding `nvidia.com/gpualloc` fields.

> **Warning:** Renaming the HAMi resource changes what every HAMi node advertises. Running Pods keep their devices, but any Pod or template that still requests `nvidia.com/gpualloc` cannot be scheduled again until it is changed, and project or namespace quotas keyed on `nvidia.com/gpualloc` stop matching. Only when the site has decided to use the native name everywhere. Save both ConfigMaps first; rollback is `kubectl apply -f` of the saved files. Re-check both edits after every HAMi upgrade, because an upgrade can reset them.

```bash
kubectl get cm -n kube-system hami-scheduler-device -o yaml > "$HOME/hami-scheduler-device.yaml"
kubectl get cm -n kube-public cf-crl-hami-nvidia-gpualloc -o yaml > "$HOME/cf-crl-hami-nvidia-gpualloc.yaml"
kubectl edit cm -n kube-system hami-scheduler-device
kubectl edit cm -n kube-public cf-crl-hami-nvidia-gpualloc
```

If the nodes still advertise only `nvidia.com/gpualloc` afterwards, restart `hami-scheduler` and the `hami-device-plugin` Pods, with the warning and commands in *HAMi GPU Pods stay Pending while GPUs are free: expired certificate or default-scheduler on ACP*, Cause 1.

### Cause 2: A HAMi Pod also carries nvidia.com/gpu

Use this only when the Pod requests HAMi resources and also `nvidia.com/gpu`, on a node that HAMi owns. Remove the `nvidia.com/gpu` entry from the workload template and let it roll out.

> **Warning:** Saving the template rolls the workload and replaces its Pods. Only when the extra `nvidia.com/gpu` entry is confirmed. Rollback is putting the entry back, which brings the failure back.

```bash
kubectl get deploy -n <namespace> <workload> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\t"}{.resources}{"\n"}{end}'
kubectl edit deploy -n <namespace> <workload>
```

### Cause 3: An Alauda AI workbench was created with a physical GPU instead of HAMi

Use this only when the workbench Pod requests `nvidia.com/gpu` and no node has enough allocatable `nvidia.com/gpu`. Create the workbench again with HAMi selected as the GPU type, or make sure a node has enough allocatable physical GPU for the request.

```bash
kubectl get pod -n <namespace> <workbench-pod> -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.limits}{"\n"}{end}'
kubectl describe node <node> | grep -A8 Allocatable
```

### Cause 4: The console added a limits. prefix to the resource names

Use this only when the event or the container `resources.limits` shows `limits.nvidia.com/gpualloc`, `limits.nvidia.com/gpucores`, or `limits.nvidia.com/gpumem`. Remove the `limits.` prefix from those names in the workload YAML.

```bash
kubectl get deploy -n <namespace> <workload> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\t"}{.resources.limits}{"\n"}{end}' | grep 'limits.nvidia.com'
kubectl edit deploy -n <namespace> <workload>
```

> **Warning:** Saving the edited template rolls the Deployment and replaces its Pods. Here the new Pod is already Pending, so only replicas that are still Running are affected. Only when the `limits.` prefix is confirmed in the container limits. Rollback is `kubectl rollout undo -n <namespace> deploy/<workload>`, which brings the failure back.

The corrected container limits keep the values and drop the prefix:

```yaml
resources:
  limits:
    nvidia.com/gpualloc: "2"
    nvidia.com/gpucores: "25"
    nvidia.com/gpumem: "20480"
```

`ResourceQuota` objects keep their `limits.` keys; this concerns container limits only. Upgrade to ACP 4.1.4 or later for the console fix; until then, check the YAML of every workload created from the form with HAMi extended resources.

## Diagnostic Steps

1. Read what the node advertises and which plugin owns it. `gpu=on` with only `nvidia.com/gpualloc` is a HAMi node; `nvidia-device-enable=pgpu` with `nvidia.com/gpu` is a physical-GPU node.

```bash
kubectl get node -L gpu,nvidia-device-enable
kubectl get node -o custom-columns='NAME:.metadata.name,GPUALLOC:.status.allocatable.nvidia\.com/gpualloc,GPUCORES:.status.allocatable.nvidia\.com/gpucores,GPUMEM:.status.allocatable.nvidia\.com/gpumem,GPU:.status.allocatable.nvidia\.com/gpu'
```

2. Read what the Pod asks for and the scheduling events:

```bash
kubectl get pod -n <namespace> <pod> -o jsonpath='{.spec.schedulerName}{"\n"}{range .spec.containers[*]}{.name}{"\t"}{.resources.limits}{"\n"}{end}'
kubectl get events -n <namespace> --field-selector involvedObject.name=<pod> --sort-by=.lastTimestamp
```

| What the Pod requests | Cause |
| --- | --- |
| `nvidia.com/gpu` only, on a HAMi node | Cause 1 |
| `nvidia.com/gpu` together with HAMi resources | Cause 2 |
| A workbench Pod with `nvidia.com/gpu` and no node capacity | Cause 3 |
| Names that start with `limits.` | Cause 4 |

3. Read the HAMi resource name the scheduler is configured with, and the custom extended resource ConfigMaps. `resourceCountName: nvidia.com/gpualloc` with a Pod that requests `nvidia.com/gpu` is Cause 1.

```bash
kubectl get cm -n kube-system hami-scheduler-device -o yaml | grep -n -E 'resourceCountName|nvidia.com/gpu'
kubectl get cm -n kube-public -l features.cpaas.io/type=CustomResourceLimitation --show-labels
```

4. For Cause 4, note the platform version; the console fix is in 4.1.4.
