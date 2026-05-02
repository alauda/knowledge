---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Preventing VMs from Scheduling onto Master Nodes — When Master Schedulability Is Allowed and Restricting VMs to Workers
## Issue

An administrator wants to know whether VMs scheduled by the virtualization control plane (KubeVirt / CPaaS virtualization) can or should be prevented from running on master (control-plane) nodes, and what mechanism enforces that decision.

Typical triggers:

- A compact / converged cluster in which master nodes are schedulable by design — VMs can land there by default.
- An operator wants to keep the control plane dedicated to cluster services and is surveying the enforcement options.

The question has two parts: "is it currently possible for VMs to land on masters?" (depends on the cluster's scheduling configuration) and "how do I keep them off?" (depends on whether the administrator wants a cluster-wide rule or a per-VM rule).

## Root Cause

Kubernetes by default taints master nodes with `node-role.kubernetes.io/control-plane:NoSchedule` and `node-role.kubernetes.io/master:NoSchedule`. A pod needs an explicit toleration to be scheduled onto a tainted master. Two common configurations change this behaviour:

1. **Compact clusters**. In a compact cluster (a single-node or three-node cluster where masters double as workers), the cluster's bootstrap process removes the master-role `NoSchedule` taint so regular workloads can land on masters. In this mode any pod — including virt-launcher pods that back VMs — can schedule on masters. The cluster is working as designed.

2. **Highly available clusters with masters deliberately tainted**. Production clusters usually keep the `NoSchedule` taint on masters. VMs cannot land on masters unless the VM spec explicitly tolerates the taint. In this mode no additional configuration is needed to "prevent" VMs from landing on masters — the default taint already does.

A third configuration exists on some platforms: an explicit scheduler CR (or equivalent) that exposes a `mastersSchedulable` field. Setting the field to `false` applies the master taint cluster-wide; setting it to `true` removes it. This is the toggle that tells you, for a given cluster, whether the default enforces master-isolation or not.

The fix path is driven by the administrator's intent:

- If the intent is "follow the cluster's scheduling policy" → no change needed, the default taint does the work when present.
- If the intent is "never schedule this VM on a master regardless of cluster setup" → add a `nodeSelector` or `affinity` rule to the VM's pod template that targets workers.

## Resolution

### Step 1 — determine the cluster's current master-schedulable state

```bash
# Check for the cluster-wide scheduler configuration (if the platform exposes one):
kubectl get schedulers cluster -o=yaml 2>/dev/null | yq '.spec.mastersSchedulable' 2>/dev/null

# Check the actual taints on master nodes:
kubectl get node -l node-role.kubernetes.io/master \
  -o=jsonpath='{range .items[*]}{.metadata.name}{"\n"}{range .spec.taints[*]}    {.key}={.value}:{.effect}{"\n"}{end}{end}'
```

Interpretation:

- `mastersSchedulable: false` and taints show `node-role.kubernetes.io/control-plane:NoSchedule` → masters are isolated; VMs land on workers by default.
- `mastersSchedulable: true` (or no taints) → masters are schedulable; VMs can land there unless you add a per-VM or per-fleet restriction.

On compact clusters, the expected state is `mastersSchedulable: true` — do not flip it to false, because you have no worker-only nodes to run pods on.

### Step 2a — highly available cluster: enforce or re-assert master isolation

If masters should be isolated and you find they are not:

```bash
# Apply the cluster-wide setting:
kubectl patch schedulers cluster --type=merge -p '{"spec":{"mastersSchedulable":false}}'
```

On distributions that do not expose a Scheduler CR, reapply the taint directly:

```bash
for node in $(kubectl get node -l node-role.kubernetes.io/master -o=name); do
  kubectl taint "$node" node-role.kubernetes.io/control-plane=:NoSchedule --overwrite
done
```

After this change, existing VMs may continue running on masters until they are stopped / restarted — the taint only affects new scheduling decisions.

### Step 2b — compact cluster (or when you only want to restrict VMs, not all workloads): per-VM nodeSelector

If the cluster's general scheduling allows masters but you want this specific VM (or all VMs in a tenant namespace) to land only on workers, add a nodeSelector to the VM:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: app-vm
  namespace: my-tenant
spec:
  template:
    spec:
      nodeSelector:
        node-role.kubernetes.io/worker: ""
      # … rest of the VM spec …
```

The `node-role.kubernetes.io/worker: ""` selector matches any node labelled with the worker role. Combined with a master-node that lacks the worker role, this guarantees the VM's virt-launcher pod lands on a worker.

### Step 2c — tenant-wide: node affinity via a namespace policy

For a fleet of VMs that should all be pinned to workers, managing per-VM nodeSelectors is fragile. Better: use a Kyverno / Gatekeeper / OPA policy, or a `GlobalNodeSelector` / `pod-preset`-style mechanism (varies by platform) to inject the nodeSelector into every VM pod created in a namespace:

```yaml
# Example Kyverno policy (abbreviated):
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: vms-to-workers
spec:
  rules:
    - name: inject-worker-selector
      match:
        resources:
          kinds: [Pod]
          selector:
            matchLabels:
              kubevirt.io: virt-launcher
      mutate:
        patchStrategicMerge:
          spec:
            nodeSelector:
              node-role.kubernetes.io/worker: ""
```

### Step 3 — verify placement

After any change, confirm by reading where new VMs land:

```bash
NS=<tenant-namespace>
kubectl -n "$NS" get vmi -o=custom-columns='NAME:.metadata.name,NODE:.status.nodeName'
```

Cross-reference node names against `kubectl get node` — nodes appearing should be workers only.

### Step 4 — document the chosen policy

Whatever the cluster's mode, document:

- Cluster type (compact / HA).
- Whether masters are schedulable.
- Per-VM selectors vs namespace-wide mutation.

Having this written down stops the next administrator from applying a "fix" that conflicts with the current mode — for example, setting `mastersSchedulable: false` on a compact cluster would break every workload.

## Diagnostic Steps

Confirm the cluster mode by checking node counts and roles:

```bash
kubectl get node -o=custom-columns='NAME:.metadata.name,ROLES:.metadata.labels.node-role\.kubernetes\.io/master,.metadata.labels.node-role\.kubernetes\.io/worker,SCHEDULABLE:.spec.unschedulable'
```

A cluster with only 3 nodes, all labelled master and worker, is a compact cluster.

Find any VM currently running on a master:

```bash
kubectl get vmi -A -o=json | jq -r '.items[] | select(.status.nodeName as $n | $n != null) |
  "\(.metadata.namespace)/\(.metadata.name) -> \(.status.nodeName)"' | \
  while read -r line; do
    node=$(echo "$line" | awk '{print $3}')
    if kubectl get node "$node" -o=jsonpath='{.metadata.labels}' | grep -q 'node-role.kubernetes.io/master'; then
      echo "$line (ON MASTER)"
    fi
  done
```

Inspect a single VM's placement decision — what selectors / tolerations caused it to land there:

```bash
VM=<vm-name>
NS=<ns>
kubectl -n "$NS" get vmi "$VM" -o=yaml | yq '.spec.nodeSelector, .spec.tolerations'
```

A VM with no selector and tolerations that include `node-role.kubernetes.io/master:NoSchedule` will land on masters if they are schedulable. Remove the toleration or add a selector to prevent this.

After applying the chosen constraint, monitor the VMI status during a VM restart to confirm it lands where expected. If it does not, the diagnosis usually falls into one of: the selector does not match any node labels (fix by relabelling nodes), or a higher-priority scheduling constraint (taint, pod anti-affinity) pins it elsewhere (re-read the VMI events for the scheduler's denial reason).
