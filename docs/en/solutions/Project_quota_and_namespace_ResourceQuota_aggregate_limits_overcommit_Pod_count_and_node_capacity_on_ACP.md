---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.16"
  - "4.1"
---

# Project quota and namespace ResourceQuota: aggregate limits, overcommit, Pod count, and node capacity on ACP

## Issue

Quota behavior looks wrong, or the quota model needs explaining:

- A project has CPU and memory quota on a cluster. Two namespaces are created in it without quota numbers, and their combined usage is expected to stay inside the project quota.
- A project has a storage quota, the namespace was created without one, and the Container Platform view of the namespace shows no storage quota.
- A namespace cannot hold more than 1000 Pods, and the console offers no field to raise that number.
- The namespace Pod limit "does not take effect": the limit is 20, yet more than 30 Pods exist in the namespace, many of them `Completed`, and the quota shows something like `pods: 4/20`.
- Cluster resources are almost fully allocated to projects while real utilization is below 10 percent. Can projects be overcommitted?
- A node has 96 physical CPU cores but `Allocatable` shows 92. How do project quotas map to physical node resources, and why do the CPU and memory totals on the project page not match real usage?
- How are business Pods kept off the nodes that host logging and monitoring components?
- A namespace has more than one quota object, for example the platform quota `default` and a hand-made `<namespace>-quota`, with different values for the same resource. Which one applies?

## Root Cause

### Cause 1: Namespaces without their own quota do not share the project quota as a combined limit

The project quota is a configuration boundary for allocation. Resource limits are enforced per namespace, by the namespace `ResourceQuota`. Namespaces cannot be left without quota numbers and still have their combined usage bounded by the project quota.

### Cause 2: A namespace without its own storage quota shows none

When only the project has a storage quota and none is allocated to the namespace, the Container Platform view shows no storage quota for the namespace. This is expected. The namespace storage limit is then determined by the maximum available storage.

### Cause 3: The 1000 Pods per namespace cap is `spec.hard.pods` of the namespace ResourceQuota

On ACP 3.16 the cap of 1000 Pods per namespace is the `spec.hard.pods` value of the namespace's `ResourceQuota`. The console does not expose that value, but it can be changed on the `ResourceQuota` directly.

### Cause 4: The Pod quota does not count Completed Pods

The `pods` entry of a `ResourceQuota` counts only Pods in a non-terminal state. A Pod whose `.status.phase` is `Succeeded` or `Failed` is terminal, and `Completed` Pods are in that state. On ACP 4.1.2, for example, the quota `default` shows `pods: 4/20` while 31 Pods exist. Native `ResourceQuota` cannot be made to count completed Pods; this is Kubernetes design (see the Kubernetes `ResourceQuota` object count documentation).

### Cause 5: Project quotas may add up to more than the cluster has

The platform supports overcommit between projects. With 200 CPU cores in the cluster, projects A, B, and C can each be allocated 80 cores, 240 in total. Inside one project the namespace quotas are bounded by the project quota: with namespaces `ns1` and `ns2` in project A, `ns1` can have 30 cores and `ns2` 50 cores, as long as `ns1 + ns2 <= 80`.

### Cause 6: Project quotas are administrator limits, not node capacity, and Allocatable excludes reserved resources

- Project quotas are based on Kubernetes `ResourceQuota`, which limits `requests.cpu`, `requests.memory`, `limits.cpu`, `limits.memory`, Pod and PVC counts, and extended resources. The effective values are those in `status.hard`.
- A `ResourceQuota` is an upper limit set by an administrator. It is not calculated from physical resources and is not bound to nodes. The platform does not keep the sum of project quotas within the schedulable capacity (that is the overcommit in Cause 5).
- Pods are scheduled by their `requests` against node `Allocatable`. Business capacity is the total `Allocatable` of the worker nodes that run business workloads, minus system components, DaemonSets, a reserve for node failures, and a reserve for rolling upgrades.
- `Allocatable` lower than `Capacity` (92 of 96 cores) is the resource reserved for the system and Kubernetes components through the kubelet `kubeReserved`, `systemReserved`, or `reservedSystemCPUs` settings.
- The CPU and memory totals on the project page are a resource overview. They do not combine actual usage and, with many projects, cannot be calculated accurately.

### Cause 7: Keeping business Pods off logging and monitoring nodes needs taints and tolerations

Without taints, any Pod can be scheduled on the logging and monitoring nodes. Node labels, `NoSchedule` taints, tolerations, and node affinity make those nodes a separate infrastructure pool. Components that already tolerate the taint keep running there (for example, ClickHouse carries an `infra` toleration, as do most platform components); ordinary business Pods are no longer scheduled there. Components deployed later, such as MetalLB, must be checked for the toleration separately.

### Cause 8: Several ResourceQuota objects in one namespace all apply

Kubernetes evaluates every `ResourceQuota` in the namespace. Creating or scaling a Pod must fit all of them, so for each resource the effective limit is the smallest hard value among the quotas that list it. Resources listed in only one quota are limited by that quota alone. The platform-managed quota is the one named `default`. For example, with `default` at `pods: 1k`, `requests.cpu: 128` and a second quota `<namespace>-quota` at `pods: 10k`, `cpu: 120`, the namespace can run at most 1000 Pods and CPU requests up to 120 cores. In a `ResourceQuota`, `cpu` and `requests.cpu` (and `memory` and `requests.memory`) both limit the sum of requests, so they count as the same resource when comparing quotas.

## Resolution

### Cause 1: Namespaces without their own quota do not share the project quota as a combined limit

Give each namespace its own quota, with the namespace values adding up to no more than the project quota (Cause 5).

```bash
kubectl get resourcequota -n <namespace-1> -o yaml
kubectl get resourcequota -n <namespace-2> -o yaml
```

### Cause 2: A namespace without its own storage quota shows none

No action is needed. To confirm, look for a storage entry (`requests.storage` or a per-StorageClass entry) in the namespace quota:

```bash
kubectl get resourcequota -n <namespace> -o yaml | grep -i storage
```

No output means the namespace has no storage quota of its own.

### Cause 3: The 1000 Pods per namespace cap is `spec.hard.pods` of the namespace ResourceQuota

Find the quota object (on ACP 4.1 the namespace quota is normally named `default`) and save it:

```bash
kubectl get resourcequota -n <namespace>
kubectl get resourcequota <quota-name> -n <namespace> -o yaml > "$HOME/resourcequota-<namespace>.yaml"
```

> **Warning:** This changes how many non-terminal Pods the namespace may run. A value below the current count blocks new Pods until existing ones end; a higher value lets the namespace create more Pods on the cluster. Do it only when the cap comes from `spec.hard.pods` of this `ResourceQuota`. Roll back with `kubectl apply -f` of the saved file or by patching the previous value back.

```bash
kubectl patch resourcequota <quota-name> -n <namespace> --type=merge -p '{"spec":{"hard":{"pods":"<new-limit>"}}}'
kubectl get resourcequota <quota-name> -n <namespace> -o jsonpath='{.spec.hard.pods}{"\t"}{.status.hard.pods}{"\n"}'
```

Both values should show the new limit. It is not known whether a later quota save in the console keeps this value; read `spec.hard.pods` again after any console edit of that quota.

### Cause 4: The Pod quota does not count Completed Pods

No fix exists in native `ResourceQuota`. Confirm the numbers agree:

```bash
kubectl get resourcequota -n <namespace>
kubectl get pods -n <namespace> --field-selector=status.phase!=Succeeded,status.phase!=Failed --no-headers | wc -l
kubectl get pods -n <namespace> --field-selector=status.phase=Succeeded --no-headers | wc -l
```

The first count matches the used `pods` value of the quota; the second is the `Completed` Pods it does not count.

### Cause 5: Project quotas may add up to more than the cluster has

Overcommit between projects is allowed. Within one project, keep the sum of namespace quotas at or below the project quota.

```bash
kubectl get resourcequota -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,LIMITS_CPU:.status.hard.limits\.cpu,USED_LIMITS_CPU:.status.used.limits\.cpu'
```

Pods are still placed only where node `Allocatable` has room for their `requests` (Cause 6).

### Cause 6: Project quotas are administrator limits, not node capacity, and Allocatable excludes reserved resources

Plan project quotas from business capacity as defined above, and read the node reserve from the kubelet configuration:

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU_CAPACITY:.status.capacity.cpu,CPU_ALLOCATABLE:.status.allocatable.cpu,MEM_CAPACITY:.status.capacity.memory,MEM_ALLOCATABLE:.status.allocatable.memory'
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" | jq '.kubeletconfig | {kubeReserved, systemReserved, reservedSystemCPUs}'
```

The difference between capacity and allocatable should match the reserved values (plus any eviction threshold for memory). Use monitoring, not the project page totals, for real CPU and memory usage.

### Cause 7: Keeping business Pods off logging and monitoring nodes needs taints and tolerations

Before tainting, read the tolerations of every Pod that must stay on those nodes, and use the key those tolerations already match (`infra` for ClickHouse):

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=<node>
kubectl get pod -n <namespace> <pod> -o jsonpath='{.spec.tolerations}{"\n"}'
```

> **Warning:** A `NoSchedule` taint stops new Pods without a matching toleration from being scheduled on the node, including platform add-ons deployed later that lack it. Running Pods are not evicted. Taint only after confirming that every component that must run on these nodes tolerates it. Roll back by removing the taint with the trailing `-` command.

```bash
kubectl label nodes <node> <label-key>=<label-value>
kubectl taint nodes <node> <taint-key>=<taint-value>:NoSchedule
# rollback
kubectl taint nodes <node> <taint-key>=<taint-value>:NoSchedule-
```

Afterwards, check that the logging and monitoring Pods still schedule on those nodes, and check later components such as MetalLB for the toleration.

### Cause 8: Several ResourceQuota objects in one namespace all apply

List what each quota limits and compare the hard values per resource:

```bash
kubectl get resourcequota -n <namespace>
kubectl get resourcequota -n <namespace> -o custom-columns='NAME:.metadata.name,HARD:.status.hard,USED:.status.used'
```

For each resource, the smallest hard value is the one that blocks a new Pod. To make one value authoritative, change the quota that is stricter, or remove the extra quota object and keep `default`.

> **Warning:** Deleting a `ResourceQuota` removes the limits it alone enforces. Delete only a quota that was added by hand, never `default`, and save it first (`kubectl get resourcequota <quota> -n <namespace> -o yaml > <quota>.yaml`). Roll back with `kubectl apply -f <quota>.yaml`.

After an edit, compare `spec.hard` with `status.hard`: the quota controller updates `status.hard` shortly after `spec.hard` changes, and admission uses the new value once it is there.

## Diagnostic Steps

1. Decide whether the question is about enforcement or display. List the quota objects and the project quota:

   ```bash
   kubectl get resourcequota -A
   kubectl get projectquotas.auth.alauda.io -A
   ```

   Namespaces with no `ResourceQuota` that are expected to share the project limit: Cause 1. A namespace quota without a storage entry: Cause 2. More than one `ResourceQuota` in a namespace: Cause 8.

2. For a Pod count question, read `spec.hard.pods` and `status.used.pods`:

   ```bash
   kubectl get resourcequota -n <namespace> -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.hard.pods}{"\t"}{.status.used.pods}{"\n"}{end}'
   kubectl get pods -n <namespace> --no-headers | awk '{print $3}' | sort | uniq -c
   ```

   A cap at 1000 that the console cannot change: Cause 3. More Pods listed than `status.used.pods`, the extra ones `Completed`: Cause 4.

3. For allocation questions, compare the sum of project quotas with cluster capacity (Cause 5), and node `Capacity` with `Allocatable` and the kubelet reserve (Cause 6).

4. For placement of business Pods, list node taints:

   ```bash
   kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints'
   ```

   No taint on the logging and monitoring nodes: Cause 7.

5. A rollout that stalls with `FailedCreate ... exceeded quota` is covered in [Deployment rollout stalls with FailedCreate exceeded quota and no built-in alert on ACP](Deployment_rollout_stalls_with_FailedCreate_exceeded_quota_and_no_built_in_alert_on_ACP.md).
