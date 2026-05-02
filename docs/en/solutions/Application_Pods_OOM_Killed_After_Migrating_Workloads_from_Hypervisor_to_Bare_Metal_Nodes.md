---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Application Pods OOM-Killed After Migrating Workloads from Hypervisor to Bare-Metal Nodes
## Issue

After moving an application off a hypervisor-backed cluster onto a bare-metal cluster, application pods start crashing intermittently with exit code 137 (OOM-killed). The pods enter `CrashLoopBackOff`, and the kubelet's pod events show `OOMKilled` against one or more containers. The same workload manifest, with the same memory request/limit values, was stable on the hypervisor cluster but is unstable on bare metal.

The mismatch is often invisible at first glance — CPU graphs look healthier, latency may even improve — but `kubectl describe pod` reveals repeated kills when allocation peaks.

## Root Cause

Memory `requests` and `limits` that were calibrated against a hypervisor environment are not a reliable reference for bare-metal nodes:

- On a hypervisor, the guest sees a virtualised memory subsystem; ballooning, page sharing, and host-level over-commit smooth out short bursts at the cost of latency. Allocations that briefly exceed the guest's working set can be absorbed by the host before the kernel reaches an OOM situation.
- On bare metal, every allocation hits the host kernel directly. There is no balloon driver in front of the cgroup limit; once the container's memory cgroup hits the configured `limits.memory`, the kernel OOM-killer reaps the container immediately, regardless of whether the rest of the node is idle.
- Allocator behaviour, NUMA effects, and per-process resident-set sizes also differ — many runtimes resolve `cgroup` memory limits more aggressively when the underlying CPU count and node topology are larger.

Net effect: a workload that ran "comfortably" with `limits.memory=1Gi` on a 4-vCPU virtual node may briefly request 1.05 Gi on a 64-core bare-metal node, and that single moment is enough to be killed.

## Resolution

Recalibrate memory limits and requests against the bare-metal target instead of porting hypervisor values verbatim.

1. **Measure actual usage on the new node**. Watch the pod under representative load and capture the working-set high-water mark:

   ```bash
   kubectl top pod <pod> -n <ns> --containers
   ```

   For longer-running studies, take samples at intervals (or scrape the underlying cgroup metrics through the cluster monitoring stack) and chart `container_memory_working_set_bytes` for the container.

2. **Set `requests.memory` to the steady-state working set** so the scheduler reserves enough headroom on the node and so that the QoS class becomes `Burstable` or `Guaranteed`. Pods in `BestEffort` are first to be evicted under node pressure.

3. **Set `limits.memory` to peak observed working set + a safety margin**. A common starting point is 25–50 % above the observed peak; tighten downwards once the workload has run a full business cycle without kills.

4. **Match `requests` and `limits` for `Guaranteed` QoS** when the workload cannot tolerate kills (databases, stateful services, latency-critical pods):

   ```yaml
   resources:
     requests:
       cpu: "2"
       memory: "2Gi"
     limits:
       cpu: "2"
       memory: "2Gi"
   ```

5. **Consider runtime tuning** for managed runtimes (JVM, Node.js, .NET) — many of them read `cgroup` memory limits at start-up and scale heap accordingly. If a JVM heap is set with `-Xmx1g` while the container limit is `1Gi`, a small amount of off-heap memory is enough to cross the limit. Either lower `-Xmx` to leave the off-heap room, or raise the container limit.

6. **Avoid blind over-provisioning**. Do not respond to OOM-kills by raising every container's limit to a very large value — that just hides the leak (or undersizing) and pushes the failure mode to node-level memory pressure, which is worse.

## Diagnostic Steps

Identify the OOM event chain:

```bash
kubectl describe pod <pod> -n <ns>
```

In the events section, the relevant entries are:

```text
Last State:    Terminated
  Reason:      OOMKilled
  Exit Code:   137
```

Inspect the kubelet's view of the kill:

```bash
kubectl get events -n <ns> --field-selector involvedObject.name=<pod>
```

Confirm the container's resource requests/limits actually applied:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.containers[*].resources}{"\n"}'
```

Pull a small in-cluster summary of recent memory pressure on the node hosting the pod:

```bash
kubectl describe node <node>
```

Look at the `Allocatable` block (the kernel-reserved overhead is excluded), the `Non-terminated Pods` table, and the bottom of the output for `MemoryPressure` conditions or recent `SystemOOM` events. A node showing `MemoryPressure=True` indicates the cluster, not just the workload, is undersized.

If using a metrics back end such as Prometheus, the historical OOM rate can be charted with `container_memory_working_set_bytes` and `container_memory_failures_total{type="oom"}`. Compare the working set against the configured limit to see how close to the ceiling the workload runs in normal operation — workloads that consistently run above ~80 % of their limit are at risk and should be re-sized.
