---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500038
---

# Node NotReady on ACP with kubelet "PLEG is not healthy"

## Issue

On an Alauda Container Platform cluster (kube v1.34.5, container runtime `containerd://2.2.1-5`), a worker node flips to `NotReady` while the kubelet reports the message "container runtime is down, PLEG is not healthy" on the node's `Ready` condition. The Ready condition exposes the standard upstream `NodeCondition` fields (`type`, `status`, `reason`, `message`, `lastHeartbeatTime`, `lastTransitionTime`); on a healthy node `type=Ready`, `status=True`, `reason=KubeletReady`, with the message carrying the kubelet's free-form text. The same fields surface the PLEG-not-healthy text when the kubelet's Pod Lifecycle Event Generator cannot complete its periodic relist against the container runtime [ev:c1].

## Root Cause

The kubelet's PLEG runs a continuous relist loop against the CRI socket (`/run/containerd/containerd.sock` on ACP) to keep an in-memory cache of pod and container state. The `kubelet_pleg_last_seen_seconds` metric is the relist heartbeat — it advances roughly one-for-one with wallclock on a healthy node, and the kubelet considers PLEG unhealthy when the heartbeat ages past the relist threshold; a `kubelet_pleg_discard_events` counter tracks dropped events when the loop falls behind [ev:c2].

Per-relist work scales with the number of pods on the node, independent of host spec: across four otherwise-identical nodes (same kernel, container runtime, kube version), the `kubelet_pleg_relist_duration_seconds_sum` cumulative counter is higher on the nodes carrying more pods (33 pods produced about 8967 s; 48 and 49 pods produced about 9501 s and 10785 s respectively). The relist interval itself stays close to the 1 s upstream cadence — what scales is the per-pass cost, not the loop frequency [ev:c3].

Runtime latency, deadlocks, or timeouts on remote CRI requests push relist work past the kubelet's `runtimeRequestTimeout` (live value `2m0s`) and surface as `kubelet_runtime_operations_errors_total{operation_type=…}` increments — broken out per CRI verb (`container_status`, `exec_sync`, `pull_image`, `run_podsandbox`, `remove_container`, `start_container`). A degraded runtime drives these counters up and starves the relist loop in the same window [ev:c4].

A second class of stall sits in the CNI plugin chain. The node uses Multus as the meta-plugin (`00-multus.conf`) delegating to `kube-ovn` (`01-kube-ovn.conflist`), and the kube-ovn plugin reaches a local socket at `/run/openvswitch/kube-ovn-daemon.sock` on every CNI invocation. A bug or stall in that daemon blocks the CRI's `PodSandbox` network-status callback inside the same `runtimeRequestTimeout` window and contributes to PLEG unhealthiness [ev:c5].

## Resolution

Evacuate the node before touching the kubelet or the runtime. `kubectl drain` cordons the target node first, then evicts non-DaemonSet pods. With `--ignore-daemonsets`, per-node agents (CNI, storage, monitoring) stay during maintenance; standalone pods (no controller) are refused without `--force`, which acts as a safety gate against evicting workloads that have no scheduler-managed replacement [ev:c6]:

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

With the node drained, restart the kubelet and the container runtime via systemd; the runtime daemon on ACP nodes is `containerd.service` (loaded, enabled, active in the live capture) and the kubelet unit name matches upstream [ev:c6]:

```bash
systemctl restart kubelet
systemctl restart containerd
```

Prune exited containers with `crictl`. ACP nodes ship the runtime-agnostic `crictl` CLI wired to the containerd socket via `/etc/crictl.yaml` (`runtime-endpoint: unix:///run/containerd/containerd.sock`); `crictl version` reports `RuntimeName: containerd / RuntimeVersion: v2.2.1-5`. `crictl ps -a --state exited` enumerates exited containers — the canary node observed 43 — and `crictl rm` accepts CONTAINER-IDs with the upstream `--all` / `--force` / `--keep-logs` flags [ev:c8]:

```bash
crictl ps -a --state exited
crictl ps -a | grep -i Exited | awk '{print $1}' | xargs -r crictl rm
```

Prune untagged images the same way. `crictl images` returns the standard IMAGE / TAG / IMAGE ID / SIZE columns; untagged images appear with `TAG=<none>`. `crictl rmi` accepts IMAGE-IDs with `--all` / `--prune`, so the upstream cleanup form ports verbatim [ev:c9]:

```bash
crictl images
crictl images | awk '$2=="<none>" {print $3}' | xargs -r crictl rmi
```

Set `requests` and `limits` on workloads to guard the node against OOM and CPU starvation that degrade node processes including the runtime. The standard `pod.spec.containers.resources` `ResourceRequirements` struct exposes `requests<map[string]Quantity>` and `limits<map[string]Quantity>`. The kubelet's `evictionHard` thresholds — live values `memory.available: 100Mi` and `pid.available: 10%` — are the signals that flip the node's `MemoryPressure` and `PIDPressure` conditions; on a healthy cluster all nodes report both as `False/KubeletHasSufficientMemory` and `False/KubeletHasSufficientPID` [ev:c10]:

```yaml
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

After the kubelet and containerd come back, uncordon the node:

```bash
kubectl uncordon <node-name>
```

## Diagnostic Steps

Confirm the node's `Ready` condition is the surface carrying the PLEG message — the standard upstream NodeCondition shape applies on ACP, with `type=Ready` and the kubelet's free-form text in `.message` [ev:c1]:

```bash
kubectl get node <node-name> -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\t"}{.message}{"\n"}{end}'
```

Read the kubelet's PLEG metrics through the node's proxy `/metrics` endpoint to verify the heartbeat is advancing and watch the per-relist latency distribution; on a degraded node `kubelet_pleg_last_seen_seconds` will stop tracking wallclock and `kubelet_pleg_discard_events` will increment [ev:c2]:

```bash
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/metrics" \
  | grep -E '^kubelet_pleg_(last_seen_seconds|discard_events|relist_duration_seconds_(sum|count))'
```

Correlate the relist load with per-node pod density. Higher pod counts produce higher cumulative `kubelet_pleg_relist_duration_seconds_sum` across nodes that share the same hardware profile; this is the data point that distinguishes a sizing problem (move pods off) from a runtime problem (investigate containerd) [ev:c3]:

```bash
kubectl get pods -A --field-selector spec.nodeName=<node-name> -o name | wc -l
```

Read the live kubelet config (`/configz` proxy) for the runtime knobs governing CRI calls — `containerRuntimeEndpoint`, `runtimeRequestTimeout` (live `2m0s`), `maxPods` (live `255`) — and the `kubelet_runtime_operations_errors_total{operation_type=…}` counter to see which CRI verbs are failing [ev:c4]:

```bash
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/configz" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['kubeletconfig']; \
                print({k:d[k] for k in ('runtimeRequestTimeout','containerRuntimeEndpoint','maxPods')})"
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/metrics" \
  | grep '^kubelet_runtime_operations_errors_total'
```

Inspect the CNI plugin chain on the node. The configuration lives in `/etc/cni/net.d/` (`00-multus.conf` + `01-kube-ovn.conflist`); a stalled kube-ovn daemon socket at `/run/openvswitch/kube-ovn-daemon.sock` will block the CRI's PodSandbox network-status callback. Check the daemon pod's health on the affected node before assuming the kubelet itself is at fault [ev:c5]:

```bash
kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide --field-selector spec.nodeName=<node-name>
```

Check the node's pressure conditions to decide whether `requests`/`limits` tuning is part of the fix. `MemoryPressure=True` or `PIDPressure=True` means workloads have overrun the eviction thresholds and the kubelet itself is competing for resources [ev:c10]:

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{range .status.conditions[?(@.type=="MemoryPressure")]}{.type}={.status}{end}{"  "}{range .status.conditions[?(@.type=="PIDPressure")]}{.type}={.status}{end}{"\n"}{end}'
```
