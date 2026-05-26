---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500143
---

# Pods stay Pending with Insufficient memory while kubectl top shows free RAM on ACP

## Issue

On Alauda Container Platform running upstream Kubernetes v1.34.5, new Pods can sit in `Pending` with a `FailedScheduling` event reporting `0/N nodes are available: N Insufficient memory`, even though `kubectl top node` shows healthy free RAM on every Node. The scheduling component on ACP is the upstream `kube-scheduler` binary, deployed as a static Pod `kube-scheduler-<node-ip>` in the `kube-system` namespace using image `registry.alauda.cn:60080/tkestack/kube-scheduler:v1.34.5`, so the fit-predicate logic and the `Insufficient <resource>` reason string come straight from upstream kube-scheduler code. The scheduler reaches that verdict by comparing each Pod's `spec.containers[*].resources.requests` against each Node's `status.allocatable` minus the sum of already-scheduled Pods' requests (a residual computed in the scheduler's in-memory cache, not republished on the Node object), and a Pod that cannot fit any Node's remaining headroom stays Pending with the `0/N nodes are available: N Insufficient <resource>` `FailedScheduling` event.

## Root Cause

`status.allocatable` is strictly less than `status.capacity` because the kubelet subtracts `kubeReserved`, `systemReserved`, and the hard-eviction threshold from Capacity before publishing Allocatable. On the affected ACP cluster the kubelet config sets `kubeReserved={cpu:100m, memory:902Mi}`, `systemReserved={cpu:100m, memory:902Mi}`, and `evictionHard.memory.available=100Mi` uniformly across the control-plane Node and the three worker Nodes; the resulting Node status shows Capacity memory `16384568Ki` and Allocatable memory `14434872Ki`, a delta of `1904Mi` that matches the reservation arithmetic exactly (`902Mi + 902Mi + 100Mi = 1904Mi`).

Scheduling is bookkeeping over `requests`, not over actual utilization. Once a Pod is scheduled the full `requests` value is subtracted from the Node's Allocatable for scheduling purposes, even when the Pod is consuming far less RAM at runtime, so the scheduler treats a Node as full when the sum of Pod requests reaches Allocatable. `kubectl top node` reads from the `metrics.k8s.io/v1beta1` `NodeMetrics` API (served on ACP by `cpaas-monitor-prometheus-adapter`), which reports current instantaneous CPU and memory **utilization** sampled by the metrics pipeline — it does not report scheduled `requests`. Because top measures utilization while the scheduler reasons about requests, a Node can appear to have plenty of free memory in `kubectl top node` while the scheduler still rejects new Pods with `Insufficient memory`; the two surfaces measure different things.

## Resolution

The first-line remediation is to right-size each Pod's `resources.requests` to match real application memory usage, so the scheduler's bookkeeping reflects reality and frees Allocatable headroom on existing Nodes. When right-sizing requests is not feasible, the alternative is to add memory to existing workers or add more worker Nodes; both grow the cluster's aggregate Allocatable and give the scheduler more room without changing Pod specs.

Edit the workload's Pod template to lower over-stated requests. The mechanism is fixed (the scheduler reads `.spec.containers[*].resources.requests` literally, so lower requests free Allocatable headroom); the specific Mi / cpu numbers below are illustrative placeholders and should be replaced with values that reflect the workload's measured usage:

```yaml
spec:
  containers:
    - name: app
      resources:
        requests:
          memory: 256Mi
          cpu: 100m
        limits:
          memory: 512Mi
          cpu: 500m
```

After the change, the scheduler re-evaluates pending Pods on its next cycle and the `FailedScheduling` event clears once a Node has enough remaining Allocatable to fit the new request.

## Diagnostic Steps

Inspect the Node's accounting first. `kubectl describe node <name>` prints an `Allocated resources` block listing per-resource Requests and Limits as percentages of the Node's **Allocatable** (not Capacity); this is the column that matches what the scheduler sees and is the right place to look when a Pod is stuck Pending with `Insufficient memory` while top shows free RAM. On a Node from the affected ACP cluster the block shows entries shaped like `cpu 6120m (78%) ... memory 7728Mi (54%) ... limits 32928m (422%) / 51174Mi (363%)` — percentages computed against Allocatable, with the Limits column exceeding 100% because limits do not gate scheduling:

```bash
kubectl describe node <node-name>
```

Compare Capacity to Allocatable to confirm the reservation arithmetic:

```bash
kubectl get node <node-name> -o jsonpath='{.status.capacity}{"\n"}{.status.allocatable}{"\n"}'
```

The Capacity-minus-Allocatable delta equals `kubeReserved + systemReserved + evictionHard.memory.available`; on the affected cluster that is `1904Mi` (`902Mi + 902Mi + 100Mi`), consistent across all four Nodes.

Cross-check utilization against scheduled requests. `kubectl top node` reports instantaneous utilization from the `metrics.k8s.io/v1beta1` `NodeMetrics` API and will routinely show a much lower number than the `describe node` Requests column when workloads request more than they actually use:

```bash
kubectl top node <node-name>
```

A wide gap between the top reading and the `describe node` Requests percentage is the canonical signature of the utilization-vs-requests confusion behind this symptom; trust the Requests column for scheduling decisions.
