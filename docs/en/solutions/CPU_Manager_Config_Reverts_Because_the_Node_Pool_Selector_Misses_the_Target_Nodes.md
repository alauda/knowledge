---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cluster operator enables the static CPU Manager policy through a declarative kubelet customisation — the resource carries `cpuManagerPolicy: static` and a selector that is meant to target a subset of workers labelled with an extra role (`worker-hp`, `worker-latency-sensitive`, or similar). Immediately after the rollout finishes, affected nodes report `cpumanager: "false"` in their kubelet config and never pin CPUs for Guaranteed pods.

Restarting the kubelet does not help. Re-applying the customisation does not help. The nodes look labelled correctly, the resource exists, but its content is silently not landing.

## Root Cause

The declarative kubelet customisation — a `KubeletConfig`-style CR — targets nodes indirectly, via a **node pool selector**. A node is considered in scope only if the selector matches *exactly* the labels on the pool itself (the node pool object under `configure/clusters/nodes`, or the upstream MachineConfigPool that a MachineConfig-style reconciler watches). Labels on the individual `Node` objects are irrelevant.

When a node carries more than one role — for example it belongs to the default `worker` pool **and** also to a custom `worker-hp` pool — the pool selector on the kubelet customisation must match the custom pool's label set, not the role label stamped on the node. A selector keyed by `machineconfiguration/role: worker-hp` on the customisation is ignored by a pool whose own labels are `{pools.operator.machineconfiguration/worker-hp: ""}`, and the render step falls back to the default (CPU Manager disabled).

The trap is that `kubectl get nodes` reports both role labels on the node and the selector *looks* plausible, yet the custom pool never picks the customisation up, so the rendered kubelet config revert to the default when the pool reconciles.

## Resolution

Align the selector on the kubelet customisation with the labels on the target node pool — not the labels on the node. Treat the pool as a first-class object:

1. **Read the pool's own labels.** Use them as the source of truth for the selector:

   ```bash
   kubectl get <nodepool-kind> <worker-hp> -o jsonpath='{.metadata.labels}' | jq .
   ```

   On ACP, the `<nodepool-kind>` is the node pool CR from `configure/clusters/nodes`. On upstream Kubernetes with the MCO, it is `machineconfigpool`.

2. **Rewrite the selector on the kubelet customisation to match that exact label set.** For a pool whose labels include `pools.operator.machineconfiguration/worker-hp: ""`, the customisation's pool selector must carry that key, not a `role:` label:

   ```yaml
   spec:
     machineConfigPoolSelector:
       matchLabels:
         pools.operator.machineconfiguration/worker-hp: ""
     kubeletConfig:
       cpuManagerPolicy: static
       cpuManagerReconcilePeriod: 5s
   ```

3. **Reconcile the pool and watch the rollout.** After the selector is corrected, the pool controller renders a new kubelet drop-in, drains each node in the pool, and restarts the kubelet with the static policy enabled. Do not hand-edit `/etc/kubernetes/kubelet.conf` on the node; the next reconcile will revert it.

4. **Keep the pool boundary clean.** If a node legitimately needs to belong to both the default pool *and* a custom pool, make sure the custom pool is the one that carries the more specific kubelet configuration — pool membership is additive, but the customisations are merged in a defined precedence and overlapping pools produce surprising results. When in doubt, give the high-performance nodes their own dedicated pool with no default role label.

## Diagnostic Steps

Confirm the target node carries the pool role label as expected:

```bash
kubectl get node <node> -o jsonpath='{.metadata.labels}' | jq .
```

Look at the pool's own labels — these are the labels the selector must match:

```bash
kubectl get <nodepool-kind> worker-hp -o yaml | grep -A5 '^  labels:'
```

Inspect the kubelet customisation's selector:

```bash
kubectl get kubeletconfig cpumanager-enabled -o yaml | grep -A5 machineConfigPoolSelector
```

Verify the kubelet on the node actually ended up with the static policy:

```bash
kubectl get --raw /api/v1/nodes/<node>/proxy/configz \
  | jq '.kubeletconfig | {cpuManagerPolicy, cpuManagerReconcilePeriod}'
```

If the policy is still `none`, the pool has not picked the customisation up and the selector is still wrong — re-check the pool's label set rather than the node's role labels. Only after the pool successfully renders and rolls out the drop-in will Guaranteed pods scheduled onto the affected nodes receive exclusive CPUs.
