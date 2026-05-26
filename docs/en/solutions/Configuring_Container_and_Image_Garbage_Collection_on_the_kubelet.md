---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500005
---

# Default kubelet garbage collection on ACP nodes

## Issue

Cluster operators planning capacity, disk headroom, or eviction policy on Alauda Container Platform nodes need to know what kubelet does by default for image and container garbage collection — whether it runs at all, which signals it watches, and what the inherited thresholds are before any node-side override. Because every ACP node runs the upstream kubelet, garbage collection is enabled out of the box and continues to run unless the node administrator changes it.

## Root Cause

There is no single "GC on/off" switch. The kubelet exposes a fixed set of tunables grouped into image GC (driven by `imageGCHighThresholdPercent` / `imageGCLowThresholdPercent` and the image-age fields) and pod eviction (driven by the `evictionHard` and `evictionSoft` signal maps), and every node inherits the upstream defaults for those fields unless an administrator changes them on the node. The eviction half of the policy is built around the standard kubelet signal definitions: `memory.available` is derived from the node's memory capacity minus the working set, `nodefs.available` and `nodefs.inodesFree` come from the node filesystem stats, and `imagefs.available` and `imagefs.inodesFree` come from the container-runtime image filesystem stats — exactly the shape the upstream `kubelet.config.k8s.io/v1beta1` KubeletConfiguration declares.

## Resolution

Treat the inherited defaults as the baseline policy. The set of knobs the kubelet exposes for garbage collection breaks down into three independent groups, any combination of which may be tuned: a soft-eviction policy for containers, a hard-eviction policy for containers, and an image garbage-collection policy keyed off image-filesystem usage. The standard upstream form for those tunables is the `KubeletConfiguration` struct under `kubelet.config.k8s.io/v1beta1`; on ACP nodes the same struct shape is honored, and any override is applied at the node level (for example, by editing `/var/lib/kubelet/config.yaml` and restarting the kubelet) rather than via a cluster-scoped custom resource.

A typical edit on a single node, with the fields kept inside the upstream struct shape:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
evictionHard:
  memory.available: "100Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
  imagefs.inodesFree: "5%"
```

## Diagnostic Steps

Before changing anything, read the live, effective kubelet configuration off the running node — this returns the merged view (upstream defaults plus any node-local override) and includes all the GC and eviction fields described above:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig'
```

Narrow the projection to the garbage-collection and eviction subset when only those fields are of interest:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig | {imageGCHighThresholdPercent, imageGCLowThresholdPercent, imageMinimumGCAge, imageMaximumGCAge, evictionSoft, evictionHard, evictionPressureTransitionPeriod, evictionMinimumReclaim, kubeReserved, systemReserved}'
```

The endpoint is served by the kubelet itself and is independent of any cluster-side configuration delivery; it answers the operator's question "what is this kubelet actually using right now" directly, which is the right diagnostic for verifying both the inherited defaults and the effect of any node-level change. Cross-checking the same projection on more than one node confirms whether the values are uniform across the cluster or have drifted on a single node.
