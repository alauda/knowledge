---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Deploying and configuring the Kube Descheduler Operator
## Overview

The default Kubernetes scheduler places pods at the moment they are admitted to the cluster. Once a pod is bound to a node, no controller revisits the placement, so over time the pod-to-node distribution drifts away from any policy the operator might want to enforce — for example, after a node has been drained and re-added, after a long-running pod's resource profile changes, or after taints and labels are updated.

The Kube Descheduler closes that gap. It evicts running pods that violate a configured set of policies, leaving re-scheduling to the regular scheduler. The descheduler itself is the upstream `kubernetes-sigs/descheduler` project; ACP packages it as the **Kube Descheduler Operator**, and the operator manages a `KubeDescheduler` custom resource that selects the policies and the run cadence.

This article walks through installing the operator and configuring a typical policy mix.

## Resolution

### 1. Install the operator

Install the Kube Descheduler Operator from the platform extension catalog into a dedicated namespace:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: kube-descheduler-operator
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: cluster-kube-descheduler-operator
  namespace: kube-descheduler-operator
spec:
  channel: stable
  name: cluster-kube-descheduler-operator
  source: <catalog-source>
  sourceNamespace: <catalog-source-namespace>
```

Apply and wait for the operator pod to be Running:

```bash
kubectl apply -f kube-descheduler-operator.yaml
kubectl -n kube-descheduler-operator get pod
```

### 2. Configure the policies

Create a `KubeDescheduler` custom resource. The example below enables a typical operations mix: rebalance the pods, evict pods that are violating taint/toleration, and remove duplicates from the same node.

```yaml
apiVersion: operator.alauda.io/v1
kind: KubeDescheduler
metadata:
  name: cluster
  namespace: kube-descheduler-operator
spec:
  managementState: Managed
  deschedulingIntervalSeconds: 3600     # run hourly
  profiles:
    - LifecycleAndUtilization            # rebalance + lifecycle policies
    - SoftTopologyAndDuplicates          # de-duplicate pods on a node
  profileCustomizations:
    podLifetime: 168h                    # evict pods older than a week
    devEnableEvictionsInBackground: false
```

> The `apiVersion` shown is the API group that the platform's descheduler operator publishes the CRD under; align it with what the cluster actually serves (`kubectl api-resources | grep KubeDescheduler`). The `spec` shape is stable across packagings.

The built-in profiles cover most needs:

| Profile | What it evicts |
|---|---|
| `AffinityAndTaints` | Pods that no longer satisfy node affinity or are running on a tainted node they no longer tolerate. |
| `TopologyAndDuplicates` | Hard topology-spread violations and duplicate pods of the same controller on a node. |
| `LifecycleAndUtilization` | Long-running pods (per `podLifetime`) and low-utilisation pods that block bin-packing. |
| `SoftTopologyAndDuplicates` | Same as `TopologyAndDuplicates`, but treats soft `TopologySpreadConstraints` as hard. |
| `EvictPodsWithLocalStorage` | Permits eviction of pods that use `emptyDir` or local volumes. Off by default — enabling it discards pod-local state on eviction. |
| `EvictPodsWithPVC` | Permits eviction of pods with PVCs attached. Off by default — enabling it forces a re-attach cycle, which costs latency and can fail if the storage class is `ReadWriteOnce`. |

### 3. Verify the descheduler is running

Apply the CR and confirm both the operator and the descheduler workload it spawns:

```bash
kubectl apply -f kube-descheduler.yaml
kubectl -n kube-descheduler-operator get pod
kubectl -n kube-descheduler-operator logs deploy/descheduler --tail=200
```

A healthy descheduler logs a heartbeat every cycle (`Beginning descheduler ...` / `Strategies ...`) and prints the eviction decisions. A misconfigured policy is logged as a strategy error rather than a crash, so check the descheduler log first if no evictions occur.

### 4. Add safety guards

The descheduler has three independent guards that prevent it from destabilising the cluster:

- **`PodDisruptionBudget`** — the descheduler honours every PDB the workload owners declare. A pod that would violate its controller's PDB is skipped this cycle.
- **`evictFailedBarePods` / `evictLocalStoragePods` / `evictSystemCriticalPods`** — disabled by default; only enable them when the policy genuinely needs them.
- **`maxNoOfPodsToEvictPerNode` / `maxNoOfPodsToEvictPerNamespace`** — caps how many pods the descheduler can evict in a single cycle. Set this to a small fraction of the node's capacity (5 to 10 pods) to avoid a stampede after a long quiet window.

A reasonable starting policy customisation:

```yaml
spec:
  profileCustomizations:
    podLifetime: 168h
    namespaces:
      excluded:
        - kube-system
        - cattle-system
        - rook-ceph
    thresholds:
      cpu: 20
      memory: 20
      pods: 20
    targetThresholds:
      cpu: 50
      memory: 50
      pods: 50
```

The thresholds tell the `LowNodeUtilization` strategy what counts as "underused" (below `thresholds`) and "overused" (above `targetThresholds`); the descheduler only evicts pods from the second class to make room on the first.

### 5. Tune the cadence

`deschedulingIntervalSeconds` defaults to 3600 (one hour). For an actively churning cluster a shorter interval (10 to 15 minutes) keeps the distribution closer to the policy at the cost of more eviction noise. For a steady fleet, an hour or longer is sufficient and produces fewer pod restarts visible to applications.

## Diagnostic Steps

1. Check the descheduler's last run and any errors:

   ```bash
   kubectl -n kube-descheduler-operator logs deploy/descheduler --tail=500 | grep -E 'Beginning|evicted|error'
   ```

2. List recent eviction events the descheduler emitted:

   ```bash
   kubectl get events --sort-by=.lastTimestamp \
     --field-selector reason=Evicted,reportingComponent=descheduler -A
   ```

3. Confirm the operator is reconciling the `KubeDescheduler` CR:

   ```bash
   kubectl -n kube-descheduler-operator get kubedescheduler cluster -o yaml \
     | sed -n '/status:/,$p'
   ```

4. If pods are being evicted that should be left alone, add their namespace to `profileCustomizations.namespaces.excluded` and re-apply; the change takes effect on the next cycle.

5. If no pods are being evicted but the policy expects some, confirm:
   - PDBs for the workloads do not block every eviction (`kubectl get pdb -A`).
   - The relevant profile is listed under `spec.profiles`.
   - `managementState` is `Managed`, not `Unmanaged` or `Removed`.
