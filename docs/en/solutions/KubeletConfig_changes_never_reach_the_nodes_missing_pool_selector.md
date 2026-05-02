---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `KubeletConfig` custom resource is created (or patched) to raise `systemReserved`, change eviction thresholds, or otherwise tune kubelet behaviour. Despite the CR existing and showing the new spec values, the kubelets on the nodes never pick the change up — `/var/lib/kubelet/config.yaml` on each host still has the old values, and `kubectl describe node` shows the unchanged `Allocatable`.

The CR's `status` carries the explanation:

```text
status:
  conditions:
    - lastTransitionTime: "2026-04-24T18:33:07Z"
      message: "Error: could not find any MachineConfigPool set for KubeletConfig"
```

The CR is accepted, but the controller has nothing to apply it to.

## Root Cause

A `KubeletConfig` CR does not directly write `/var/lib/kubelet/config.yaml`. It declares a *desired kubelet configuration*; the cluster's node-configuration controller then has to decide which node pool that desired configuration applies to. The selector that wires the two together is `spec.machineConfigPoolSelector` (or, on platforms that have renamed it, the equivalent label-selector field on the same CR).

When the selector is **missing** or its labels do not match any existing pool, the controller has no pool to render the kubelet config into. It records `could not find any MachineConfigPool set for KubeletConfig` and stops. The CR stays in the API but never produces a node-level rollout — which is why the nodes never see the change.

Two common shapes of the mistake:

- The CR was created with `spec.kubeletConfig:` but no `machineConfigPoolSelector:` block at all.
- The selector matches a label that no pool actually has — for example `pools.<group>/master: ""` when the cluster has renamed the master pool, or a custom label that was never added to a pool.

## Resolution

Add a `machineConfigPoolSelector` whose `matchLabels` line up with at least one existing pool. The fix is a one-key edit on the CR.

### 1. Find the labels of the pools you want to target

List the pools and their labels:

```bash
kubectl get machineconfigpool --show-labels
# or whatever the equivalent pool resource is on this platform; the
# concept is the same — list the pools and pick one's labels.
```

A typical control-plane pool carries a label like:

```text
pools.<group>/master=""
```

and a worker pool carries `pools.<group>/worker=""` or a custom name.

### 2. Add the selector to the KubeletConfig

Patch the CR so its `machineConfigPoolSelector.matchLabels` matches the pool:

```yaml
apiVersion: <group>/<version>
kind: KubeletConfig
metadata:
  name: master-systemreserved
spec:
  machineConfigPoolSelector:
    matchLabels:
      pools.<group>/master: ""
  kubeletConfig:
    systemReserved:
      cpu: 1000m
      memory: 3Gi
```

Apply with `kubectl apply -f <file>` (or `kubectl edit kubeletconfig <name>`).

### 3. Watch the rollout

After the selector matches, the node-configuration controller renders the kubelet config and triggers a node-by-node rollout. The pool's `status` reports the progress:

```bash
kubectl get machineconfigpool -w
kubectl get kubeletconfig <name> -o yaml | yq '.status.conditions'
```

`Updated: True / Updating: False` on the pool means every node in it has restarted its kubelet with the new config.

### Targeting multiple pools

Each `KubeletConfig` selects exactly one pool's labels. To apply the same kubelet tuning to multiple pools, create multiple CRs with different names and selectors — that keeps the rendering deterministic and lets you roll back one pool independently.

## Diagnostic Steps

1. Read the CR status — it tells you directly whether the controller found a pool to apply to:

   ```bash
   kubectl get kubeletconfig <name> -o yaml | yq '.spec, .status.conditions'
   ```

   The condition `could not find any MachineConfigPool set for KubeletConfig` is the signature of this issue.

2. Check that the labels in `spec.machineConfigPoolSelector.matchLabels` actually exist on at least one pool:

   ```bash
   kubectl get machineconfigpool -o json \
     | jq '.items[] | {name: .metadata.name, labels: .metadata.labels}'
   ```

   A typo in the label key or value (one trailing space, wrong group prefix) is enough to make the selector match nothing.

3. After the rollout is reported `Updated`, prove the change reached the nodes by reading the live kubelet config from a node:

   ```bash
   NODE=<node>
   kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" \
     | jq '.kubeletconfig.systemReserved'
   ```

   If the value is what the CR asked for, the selector fix has rolled all the way to the kubelet runtime.

4. Confirm the kubelet has actually restarted in the rollout window — `kubectl describe node` shows the kubelet's start time alongside the kubelet version, and a fresh start time after the CR change is the most reliable evidence the new config was loaded:

   ```bash
   kubectl describe node ${NODE} | grep -E 'Kubelet|System Info|Created'
   ```
