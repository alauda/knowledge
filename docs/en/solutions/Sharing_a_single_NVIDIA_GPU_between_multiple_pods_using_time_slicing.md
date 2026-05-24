---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Sharing a single NVIDIA GPU between multiple pods using time-slicing
## Issue

A node carries a single NVIDIA accelerator (for example one Tesla T4) but several workloads need GPU access at the same time — interactive notebooks, low-throughput inference pods, smoke tests. Without further configuration the device plugin advertises one `nvidia.com/gpu` resource on that node, the scheduler hands the device to a single pod, and any other pod that requests `nvidia.com/gpu` stays Pending. The goal is to declare that the device may be shared between N pods so multiple workloads can co-exist on a single physical card.

## Root Cause

The NVIDIA GPU device plugin reports one resource per physical GPU by default. Time-slicing is an opt-in feature on the device plugin: the operator must be told to advertise the GPU as N replicas instead of one. CUDA contexts on the host are scheduled in a round-robin fashion across the replicas, so the workloads share GPU time but not memory — every replica still sees the full memory of the device.

The wiring lives in two pieces:

- A ConfigMap holds one or more named replica recipes (for example `tesla-t4: replicas: 4`).
- The ClusterPolicy that drives the GPU operator points its device-plugin section at that ConfigMap and picks one of the recipes as default. Per-node overrides are applied through a node label.

If either side is missing, the plugin reverts to the single-replica default and time-slicing has no effect.

## Resolution

Define one ConfigMap per recipe in the namespace where the GPU operator runs. The example below splits the T4 into four time-sliced replicas:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  tesla-t4: |-
    version: v1
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4
```

Apply it:

```bash
kubectl apply -f time-slicing-config.yaml
```

Edit the existing ClusterPolicy (typically `gpu-cluster-policy`) and wire the device-plugin section to the ConfigMap. Setting `default` is what makes the recipe apply cluster-wide; the per-node label is only needed when nodes need different recipes.

```yaml
apiVersion: nvidia.com/v1
kind: ClusterPolicy
metadata:
  name: gpu-cluster-policy
spec:
  devicePlugin:
    config:
      name: time-slicing-config
      default: tesla-t4
```

Apply the change and watch the device-plugin DaemonSet pick it up:

```bash
kubectl apply -f gpu-cluster-policy.yaml
kubectl -n gpu-operator rollout status daemonset nvidia-device-plugin-daemonset
```

For mixed clusters where each node generation runs a different recipe, label the node and the device plugin will pick the matching recipe instead of the default:

```bash
kubectl label node <node> nvidia.com/device-plugin.config=tesla-t4 --overwrite
```

After the device plugin re-registers, the node advertises `replicas` worth of `nvidia.com/gpu`. Pods then consume `nvidia.com/gpu: 1` and the scheduler will pack up to N onto the same card.

## Diagnostic Steps

Confirm the node now exposes the multiplied capacity:

```bash
kubectl describe node <node> | grep -A2 'Allocatable'
# nvidia.com/gpu: 4   <- replicas count, not 1
```

Verify the device plugin pod read the new ConfigMap. The plugin logs the active config name on startup:

```bash
kubectl -n gpu-operator logs daemonset/nvidia-device-plugin-daemonset \
  -c nvidia-device-plugin | grep -i 'config'
```

If the node still reports `nvidia.com/gpu: 1`, restart the plugin pod on that node so it re-reads the ConfigMap:

```bash
kubectl -n gpu-operator delete pod -l app=nvidia-device-plugin-daemonset \
  --field-selector spec.nodeName=<node>
```

Two caveats worth keeping visible to consumers of the shared GPU:

- All replicas share device memory. A single workload that pins memory close to the card limit will starve its co-tenants — set application-level memory budgets accordingly.
- Time-slicing does not isolate failures. A CUDA fault in one workload may impact the others sharing the same physical device. For stricter isolation, prefer MIG on cards that support it, or move the workload to a dedicated card.
