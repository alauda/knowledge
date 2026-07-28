---
title: CPU throttling on JVM and multi-threaded pods on Alauda Container Platform
component: observability
scenario: troubleshooting
tags: [cpu, cfs, throttling, cadvisor, cgroup, jvm, resource-limits]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# CPU throttling on JVM and multi-threaded pods on Alauda Container Platform

## Issue

JVM workloads and other heavily multi-threaded applications running on Alauda Container Platform can exhibit sluggish or stalled processing while showing CPU usage well below the container's CPU request — a symptom of Linux CFS (Completely Fair Scheduler) bandwidth throttling. When a container's `spec.containers[*].resources.limits.cpu` is set, the kernel enforces the limit by capping how much CPU time the container's threads can collectively consume within each scheduling period; once the quota is exhausted, the kernel preempts all of the container's threads until the next period begins [ev:c1][ev:c2_b]. On ACP `lab-base` (Kubernetes `v1.34.5-1`, containerd `2.2.1-5`, Linux kernel `5.15.0-56-generic`), this manifests directly in cAdvisor counters and in the kernel's cgroup `cpu.stat` for any container with a tight CPU limit [ev:c1].

The impact is most visible on workloads with many concurrent threads — JVMs (application threads plus GC and JIT workers), Go programs with many goroutines mapped onto OS threads, and similar runtimes — because more threads compete for the same per-period quota and exhaust it more quickly. On a representative ACP worker node, a Go-based control-plane container (`olm-operator`, image `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.2`, `limits.cpu=100m`) accrues tens of thousands of throttled scheduling periods over a single day of normal operation [ev:c3].

## Root Cause

When a container declares `limits.cpu`, the kubelet writes the corresponding CFS bandwidth controls into the container's cgroup: `cpu.cfs_quota_us` (cgroup v1) or the quota half of `cpu.max` (cgroup v2) is set to the limit expressed in microseconds per default 100000-microsecond period, and `cpu.cfs_period_us` / the period half of `cpu.max` remains at the kernel default `100000` [ev:c1]. On ACP, this mapping is directly observable: a container whose pod spec carries `"limits":{"cpu":"128m"}` shows `container_spec_cpu_quota=12800` with `container_spec_cpu_period=100000` at the kubelet's `/metrics/cadvisor` endpoint, and the same cgroup's `cpu.max` file confirms the per-period quota at the kernel level [ev:c1].

Once the cgroup has consumed its full quota within a period, the kernel removes all of that cgroup's tasks from the CPU runqueue and they do not run again until the next period starts. This is the throttling step. It increments `container_cpu_cfs_throttled_periods_total` and accumulates blocked wall time in `container_cpu_cfs_throttled_seconds_total` (cAdvisor), and increments `nr_throttled` and `throttled_usec` in the cgroup's `cpu.stat` file — directly visible on ACP for a real throttled container as `nr_periods=127322 / nr_throttled=70609 / throttled_usec=8518759715` (approximately 55% of periods spent at least partially throttled, and roughly 8519 seconds of cumulative blocked wall time) [ev:c2_b][ev:c1].

Importantly, CFS throttling is a performance signal, not a termination signal. The throttled container keeps running between periods; it is not killed by the kernel, and it is not subject to an OOMKill (which is a memory-cgroup OOM event, orthogonal to the CPU cgroup's bandwidth control). On ACP `lab-base`, the same heavily-throttled container (`discover-device-vnsjm`, 89% throttle rate) is still `Running` with `restartCount=0` and an empty `lastState`; a cluster-wide sweep of 187 running container statuses shows zero `OOMKilled` `lastState` reasons in the same window [ev:c2_a].

## Resolution

The supported mitigation is to raise (or in narrowly-scoped cases remove) the affected container's `spec.containers[*].resources.limits.cpu`. Raising the CPU limit increases `cpu.cfs_quota_us`, which gives the container's threads more CPU time per scheduling period before they are preempted, and reduces or eliminates throttling [ev:c4]. On ACP, the prescription is supported by direct observation across the lab-base node: containers with a cgroup quota of `12800us` (`limits.cpu=128m`) accumulate ~89% throttling, while containers with quota `>=100000us` (`limits.cpu>=1` whole CPU) on the same node accumulate 0% throttling over the same window [ev:c4].

Set or update the limit on the workload's controller (Deployment, StatefulSet, etc.). For example, to raise a JVM workload's CPU limit to 2 whole CPUs:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-jvm-app
spec:
  template:
    spec:
      containers:
        - name: app
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
```

Apply with:

```bash
kubectl apply -f my-jvm-app.yaml
```

After the pods roll, the new quota becomes visible immediately in `container_spec_cpu_quota` and in the cgroup's `cpu.max` file, and the throttling counters stop incrementing as long as the container's actual CPU demand stays under the new quota [ev:c1][ev:c4].

Pair every CPU limit change with a matching review of `requests.cpu` so the scheduler still places the pod on a node with adequate headroom. For latency-sensitive multi-threaded workloads it is also legitimate to set `requests.cpu` to a value close to or equal to the peak working set and either set a generous `limits.cpu` (substantially above peak) or omit `limits.cpu` entirely so that the cgroup runs without a CFS quota cap — at the cost of giving up the strict resource ceiling [ev:c4].

## Diagnostic Steps

Identify whether a slow JVM or multi-threaded pod is hitting CFS throttling on ACP by reading cAdvisor's CFS counters directly from the kubelet of the node hosting the pod. The kubelet exposes them at `/metrics/cadvisor` and the kube-apiserver proxies the endpoint, so no extra agent or monitoring stack is required [ev:c5]:

```bash
# Find the node and container name for the suspected pod.
kubectl get pod <pod-name> -n <namespace> -o wide

# Pull throttling counters for that container from the node's kubelet.
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/metrics/cadvisor" \
  | grep -E '^container_cpu_cfs_(periods|throttled_periods|throttled_seconds)_total\{container="<container-name>"' \
  | grep '<pod-name>'
```

A meaningful ratio of `container_cpu_cfs_throttled_periods_total` to `container_cpu_cfs_periods_total` (anything above a few percent for a steady workload) indicates the container is being throttled by its CPU limit [ev:c5][ev:c1].

For confirmation at the kernel level, read the cgroup's `cpu.stat` and `cpu.max` directly on the node — `nr_throttled` and `throttled_usec` are the same signal cAdvisor surfaces, and `cpu.max` shows the active quota and period [ev:c2_b][ev:c1]:

```bash
kubectl debug node/<node-name> \
  --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -i -- chroot /host bash -c \
  'cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<pod-uid-with-underscores>.slice/cpu.stat; \
   echo ---; \
   cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<pod-uid-with-underscores>.slice/cpu.max'
```

The output is the canonical Linux CFS view: `nr_periods` / `nr_throttled` / `throttled_usec` from `cpu.stat`, and `<quota_us> <period_us>` from `cpu.max` (the pair `13000 100000` means 13000us of CPU time is available per 100000us period, i.e. a 130m effective quota for the pod cgroup) [ev:c2_b][ev:c1].

Confirm the symptom is throttling and not a crash by checking the container's lifecycle state: a CFS-throttled container keeps `status.containerStatuses[*].state.running` set and accumulates no `lastState.terminated.reason`, while an `OOMKilled` event would appear in `lastState.terminated.reason` and trigger a restart [ev:c2_a]:

```bash
kubectl get pod <pod-name> -n <namespace> \
  -o jsonpath='{.status.containerStatuses[*].state}{"\n"}{.status.containerStatuses[*].restartCount}{"\n"}{.status.containerStatuses[*].lastState}'
```

If the Prometheus ModulePlugin (`prometheus`, chart `ait/chart-kube-prometheus`, default version `v4.4.0-beta.8.g5d7d2fcf`) is installed on the ACP cluster, the same cAdvisor counters back the standard PromQL pattern for fleet-wide throttling visibility — for example, `rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])` as a per-container throttling ratio [ev:c5]. On clusters where the bundled kube-prometheus chart's scrape config drops the CFS counter names from its ingestion allow-list, the raw-kubelet probe and the `cpu.stat` probe above remain authoritative and can be used regardless of monitoring-stack state [ev:c5].
