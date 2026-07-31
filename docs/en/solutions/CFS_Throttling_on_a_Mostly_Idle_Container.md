---
title: CFS throttling on a mostly-idle container with a CPU limit
component: observability
scenario: troubleshooting
tags: [kubelet, cgroup, cpu, cfs, throttling, cadvisor]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# CFS throttling on a mostly-idle container with a CPU limit

## Issue

A container with a `resources.limits.cpu` set can show non-zero CFS-throttled periods even when its average CPU usage measured over a long window is far below both its CPU request and its CPU limit [ev:c1]. On Alauda Container Platform 4.x (verified against kubelet `v1.34.5-1` on Ubuntu 22.04 / kernel `5.15.0-56-generic` workers) the throttling counter increments are visible against ordinary low-traffic system pods running in `cpaas-system` and other workload namespaces, so the symptom is not specific to user workloads [ev:c1].

Average-rate metrics such as `kubectl top pod` are not sufficient to rule out throttling, because short bursts that exceed the quota inside a single 100 ms CFS period are smoothed out of any per-minute rate while the per-period throttle counter still increments [ev:c5].

For example, a `Burstable`-QoS pod with `requests.cpu=100m` / `limits.cpu=500m` was observed on a worker node consuming roughly 168.7 CPU-seconds across about 86,094 CFS periods (around 8,610 seconds of wall time, i.e. an average of about 0.02 CPU against a 0.5 CPU limit), yet `container_cpu_cfs_throttled_periods_total` reported 12 throttled periods over the same window [ev:c1][ev:c5]. The same observation reproduces against several other low-activity controllers on the same node (`tekton-events-controller` with 14 throttled periods, `tekton-operator-webhook` with 73), confirming the effect is general rather than tied to one pod [ev:c1].

## Root Cause

The Linux CFS bandwidth controller accounts CPU quota per fixed scheduling period rather than as a long-window average. The kubelet on ACP worker nodes is configured with stock upstream defaults: `cpuCFSQuota: true`, `cpuCFSQuotaPeriod: "100ms"`, `cgroupDriver: "systemd"` (read live from `/configz` on a worker) [ev:c2_a]. A container's CPU limit is translated into a per-period quota recorded in cgroup v2's `cpu.max` file. For the example pod above, `cpu.max` reads literally `"50000 100000"` — i.e. 50,000 microseconds of quota per 100,000-microsecond period (= 0.5 CPU) [ev:c2_b].

If the container briefly consumes more than its quota's share within a single 100 ms period — even by a few microseconds — the kernel preempts the process until the next period starts, and that period is counted as throttled. This is independent of the container's longer-term average CPU usage [ev:c2_b]. The kernel-side counters live in the same cgroup directory in `cpu.stat`: for the same example pod the file reads `nr_periods 86142`, `nr_throttled 17`, `throttled_usec 828838`, which agrees (to within a few sample periods) with the cAdvisor-reported counter [ev:c1].

## Resolution

Raise (or unset) the affected container's CPU limit so that its per-period quota in `cpu.cfs_quota_us` is large enough to absorb the sub-second bursts produced by the workload — or remove the limit entirely if the workload tolerates running without an upper bound [ev:c4]. The patch path is the standard upstream Kubernetes resource field `spec.template.spec.containers[].resources.limits.cpu` on the owning Deployment / StatefulSet / DaemonSet — no ACP-specific wrapper [ev:c4].

For the Deployment used as the example above, raising the CPU limit from `500m` to `1000m` can be applied with a strategic-merge patch (server-side dry-run shown — drop `--dry-run=server` to apply):

```bash
kubectl patch deployment marketplace-controller -n cpaas-system \
    --type=strategic --dry-run=server \
    -p '{"spec":{"template":{"spec":{"containers":[{"name":"marketplace-controller","resources":{"limits":{"cpu":"1000m"}}}]}}}}'
```

The apiserver accepts that patch against the live cluster and returns the new value `1` (= 1 CPU) on the affected container [ev:c4].

Tune the new limit to the workload's actual burst size, not to its average; if throttling persists at a higher limit, raise it again until `container_cpu_cfs_throttled_periods_total` stops incrementing for the container [ev:c4].

## Diagnostic Steps

Confirm the kubelet is enforcing CFS quota and what its period is, by reading `/configz` from a worker node through the apiserver proxy [ev:c2_a]:

```bash
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/configz" \
    | python3 -m json.tool \
    | grep -iE "cgroupDriver|cpuCFSQuota|cpuCFSQuotaPeriod|cpuManagerPolicy"
```

Expected on a default ACP worker:

```text
"cgroupDriver": "systemd",
"cpuManagerPolicy": "none",
"cpuCFSQuota": true,
"cpuCFSQuotaPeriod": "100ms",
```

Pull the cAdvisor CFS counters directly from the kubelet `/metrics/cadvisor` endpoint (also through the apiserver proxy). cAdvisor exposes three counters for CFS throttling: `container_cpu_cfs_periods_total`, `container_cpu_cfs_throttled_periods_total`, and `container_cpu_cfs_throttled_seconds_total`, each declared as a Prometheus counter type on the kubelet's metrics endpoint [ev:c3]:

```bash
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/metrics/cadvisor" \
    | grep -E "^container_cpu_cfs_(throttled_)?periods_total" \
    | grep -v 'container=""' \
    | grep "pod=\"<pod-name>\""
```

Sample output for one throttled container [ev:c1]:

```text
container_cpu_cfs_periods_total{container="marketplace-controller",...,pod="marketplace-controller-..."} 86094
container_cpu_cfs_throttled_periods_total{container="marketplace-controller",...,pod="marketplace-controller-..."} 12
container_cpu_usage_seconds_total{container="marketplace-controller",cpu="total",...,pod="marketplace-controller-..."} 168.676295
container_spec_cpu_quota{container="marketplace-controller",...,pod="marketplace-controller-..."} 50000
```

Compare `container_cpu_usage_seconds_total` against the elapsed product `container_cpu_cfs_periods_total * 0.1 s` to express the container's long-window average CPU; a value well below `container_spec_cpu_quota / cpu.cfs_period_us` while `container_cpu_cfs_throttled_periods_total > 0` is the article's exact symptom [ev:c5].

For the kernel-side ground truth (independent of cAdvisor), read the cgroup v2 `cpu.stat` and `cpu.max` files directly from the host on the node where the pod is scheduled, using the `node debug` flow with the pre-baked debug image [ev:c2_b]:

```bash
kubectl debug node/<node-name> -it=false --profile=sysadmin \
    --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
    -- sh -c 'POD_UID_=$(echo <pod-uid> | tr - _); \
              SLICE=/host/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${POD_UID_}.slice; \
              cat ${SLICE}/cpu.stat; echo ---max---; cat ${SLICE}/cpu.max'
```

Sample output (cgroup v2; matches cAdvisor to within a few sample periods) [ev:c1]:

```text
usage_usec 169040139
user_usec 139560351
system_usec 29479787
nr_periods 86142
nr_throttled 17
throttled_usec 828838
---max---
50000 100000
```

The path layout differs by QoS class. The example above is for a `Burstable` pod. `Guaranteed` pods sit directly under `kubepods.slice` with no QoS sub-slice; `BestEffort` pods sit under `kubepods-besteffort.slice` and have no CFS quota at all, so CFS throttling does not apply to them [ev:c2_b]. Pick the correct slice for the pod's QoS before reading `cpu.stat`.
