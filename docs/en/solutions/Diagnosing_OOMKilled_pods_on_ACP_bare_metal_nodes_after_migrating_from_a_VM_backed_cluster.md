---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Diagnosing OOMKilled pods on ACP bare-metal nodes after migrating from a VM-backed cluster

## Issue

A workload that ran cleanly on a hypervisor-backed Kubernetes cluster can start hitting intermittent CrashLoopBackOff on Alauda Container Platform bare-metal nodes, with the killed containers exiting with code 137 and `lastState.terminated.reason=OOMKilled`. On a representative ACP cluster (server v1.34.5, kubelet v1.34.5, Ubuntu 22.04.1 LTS, kernel 5.15.0-56-generic, containerd 2.2.1-5) the upstream kubelet behavior the diagnosis depends on is present unchanged: the `pod.status.containerStatuses[].lastState.terminated` block exposes `exitCode` (required), `reason`, `signal`, `containerID`, `startedAt`, and `finishedAt` exactly as the upstream Kubernetes API documents, and 137-exits surface in the wild on this cluster across multiple namespaces (cpaas-system, kube-system).

The exit code 137 is the Linux `128 + SIGKILL(9)` convention — the kernel cgroup memory controller's OOM-killer sends SIGKILL when a container's resident working set crosses its memory limit, the runtime reports that to the kubelet, and the kubelet stamps `OOMKilled` into the terminated reason for that specific failure mode. The same containers also drive the `state.waiting.reason=CrashLoopBackOff` indicator on repeated restart, which is the field `kubectl describe pod` surfaces as the visible symptom.

## Root Cause

ACP worker nodes enforce per-container memory limits strictly via cgroup v2. Reading the kubelet config and stats summary on a worker shows `cgroupDriver=systemd`, `enforceNodeAllocatable=['pods']`, `failSwapOn=true`, and an empty `memorySwap` map, and the node-level memory accounting block exposes a `psi` (Pressure Stall Information) field — PSI is a cgroup-v2-only signal, so its presence independently confirms the unified hierarchy through the API server alone, without execing on the node. With swap off, there is no headroom for an overcommitted limit to be silently absorbed: every byte of the container's working set counts against `memory.max`, and the kernel triggers the OOM-killer the moment the working set crosses that ceiling. A workload whose previous cluster did not present the same strict ceiling — for instance, because the underlying host allowed allocation patterns to drift past an undersized limit without an OOM-kill — surfaces the mismatch immediately on ACP bare-metal, since the same pod with the same memory limit now gets killed for the same allocation pattern. The fix lives on the workload manifest, not the cluster: the limit has to accommodate the real working set the workload demands on this node.

The Kubernetes object surface for the fix is the standard upstream pod spec. `kubectl explain pod.spec.containers.resources.limits` confirms `limits` and `requests` are both `map[string]Quantity` keyed by `cpu`, `memory`, and `ephemeral-storage`, with memory expressed in binary SI units (`Ki`, `Mi`, `Gi`, …) and the documented constraint that requests cannot exceed limits. The kubelet derives the pod's QoS class (Guaranteed / Burstable / BestEffort) from that requests-vs-limits relationship, and a live ACP pod that sets both fields reports `status.qosClass=Burstable` exactly as upstream computes it.

## Resolution

Raise the affected container's `resources.limits.memory` to match the working set the workload actually needs on this node, and bring `resources.requests.memory` up in line — it cannot exceed `limits.memory` and is what the scheduler uses to place the pod onto a node with enough memory to begin with. A standard merge-patch on the workload manifest is the change:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
        - name: my-app
          image: my-app:latest
          resources:
            requests:
              memory: "2Gi"
            limits:
              memory: "4Gi"
```

After the rollout, confirm the pod no longer terminates with exit 137. The kubelet stops stamping the terminated reason as `OOMKilled` and `state.waiting.reason` ceases to flip to `CrashLoopBackOff` for that failure mode. If the workload's true working set is not yet known, observe it under load and size the limit to the high-water mark with headroom — the previous cluster's memory baseline is not an authoritative reference for an ACP bare-metal node, because the enforcement surface (strict cgroup v2, no swap) does not necessarily match what the workload experienced before.

## Diagnostic Steps

Confirm the failure mode the article is about. The terminated reason and exit code are the deterministic signal — a SIGKILL from the kernel OOM-killer surfaces as `reason=OOMKilled, exitCode=137`, while other SIGKILL sources (probe failures, container shutdown) surface as `reason=Error, exitCode=137`. The distinction is in the reason field, not the exit code:

```bash
kubectl get pod <pod> -n <ns> -o yaml
kubectl describe pod <pod> -n <ns>
```

The `describe` output renders the Last State / Reason / Exit Code fields directly from `status.containerStatuses[].lastState.terminated`. ACP runs a vanilla upstream apiserver with no platform-specific overlay on the pod status surface, so the Last State / Reason / Exit Code fields render exactly as `kubectl` would on any upstream Kubernetes cluster.

To inventory every 137-exit on the cluster (useful when the symptom is intermittent across many pods rather than one known offender), pull all pods and filter on the terminated state:

```bash
kubectl get pods -A -o json | \
  python3 -c 'import json, sys
data = json.load(sys.stdin)
for p in data["items"]:
    ns, name = p["metadata"]["namespace"], p["metadata"]["name"]
    for cs in p.get("status", {}).get("containerStatuses", []) or []:
        t = (cs.get("lastState", {}) or {}).get("terminated") or {}
        if t.get("exitCode") == 137:
            print(ns, name, cs["name"], t.get("reason"))'
```

Containers with `reason=OOMKilled` are the cgroup-OOM cases — those need limit raises. Containers with `reason=Error` and `exitCode=137` are SIGKILL from elsewhere (probe failure, manual delete grace expiry) and need a different investigation path. The same listing on the reference ACP cluster turned up four live 137-exits (`cpaas-system/apollo`, `cpaas-system/global-alb2` nginx, `kube-system/kube-apiserver`, `kube-system/kube-ovn-monitor`), all with `reason=Error` and not the cgroup-OOM mode — illustrative of why filtering by reason and not by exit code alone matters.

To verify directly that the node enforces cgroup v2 memory limits strictly (and so that a too-small `limits.memory` will produce the OOMKilled mode this article addresses rather than being silently overrun), read the kubelet config and stats summary through the API server:

```bash
NODE=<node-name>
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" | \
  python3 -c 'import json,sys; kc=json.load(sys.stdin)["kubeletconfig"]; \
print({k: kc.get(k) for k in ["cgroupDriver","enforceNodeAllocatable","failSwapOn","memorySwap"]})'
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/stats/summary" | \
  python3 -c 'import json,sys; print(list(json.load(sys.stdin)["node"]["memory"].keys()))'
```

`cgroupDriver=systemd`, `enforceNodeAllocatable=['pods']`, `failSwapOn=true`, and `memorySwap={}` together mean the node enforces pod memory against the cgroup `memory.max` with no swap headroom. The presence of `psi` in the `node.memory` keys of `stats/summary` confirms the node is on the cgroup v2 unified hierarchy (PSI is a cgroup-v2-only counter on Linux).

The QoS class the kubelet computes from `requests` vs `limits` is visible on the pod itself and is what governs eviction order and OOM-score adjustment under node memory pressure:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.status.qosClass}{"\n"}'
```

A pod with `requests.memory < limits.memory` reports `Burstable`; matching requests-and-limits yields `Guaranteed`; omitting both yields `BestEffort`. Guaranteed pods are the last to be evicted on node-level memory pressure but a Guaranteed pod still gets OOM-killed if its own working set crosses its own `limits.memory` — the QoS class governs ordering across pods, not whether the per-pod cgroup ceiling fires.
