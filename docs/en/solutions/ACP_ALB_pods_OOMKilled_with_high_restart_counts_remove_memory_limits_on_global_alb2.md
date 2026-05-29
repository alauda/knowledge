---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# ACP ALB pods OOMKilled with high restart counts — remove memory limits on global-alb2

## Issue

On Alauda Container Platform the ingress data-plane is provided by the ALB plugin (CRD `alaudaloadbalancer2.crd.alauda.io`, short name `alb2`), deployed as the `global-alb2` Deployment in the `cpaas-system` namespace. Each `global-alb2-*` pod runs two containers — `nginx` (image `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1`) and `alb2` (image `registry.alauda.cn:60080/acp/alb2:v4.3.1`) — and both ship with a `resources.limits.memory` of `2Gi` by default. If the working set of either container approaches or crosses its cgroup memory limit, the standard OOMKilled mechanism applies: the kernel OOM-killer terminates the container with SIGKILL and the kubelet restarts it; the symptom that reaches the operator is `global-alb2-*` pods with elevated `restartCount` values.

## Root Cause

The two ALB containers are bounded by `spec.template.spec.containers[*].resources.limits.memory=2Gi` on the `global-alb2` Deployment, with matching `resources.requests` of `cpu=50m, memory=128Mi`; the `nginx` container additionally carries `cpu=2` and the `alb2` container `cpu=200m` on its limits block. When a container's resident set grows past its memory limit, the Linux cgroup memory controller invokes the OOM-killer, which sends SIGKILL — the container exits with code 137 (128 + 9) and is restarted in place by the kubelet, incrementing `containerStatuses[*].restartCount` on the pod. Once the limit is removed, the container is bounded only by node capacity and its `requests` floor, so the standard OOMKill mechanism no longer fires on the 2Gi headroom and any associated restart loop stops.

## Resolution

Remove the `resources.limits` block from both containers of the `global-alb2` Deployment in `cpaas-system`. The `spec.template.spec.containers[*].resources` field uses the standard apps/v1 shape with `limits` and `requests` subkeys for `cpu` and `memory`, so a JSON-Patch `remove` op on the `limits` path is sufficient and accepted by the apiserver.

Patch container index 0 (`nginx`):

```bash
kubectl patch deployment global-alb2 -n cpaas-system \
  --type=json \
  -p='[{"op":"remove","path":"/spec/template/spec/containers/0/resources/limits"}]'
```

Patch container index 1 (`alb2`) the same way:

```bash
kubectl patch deployment global-alb2 -n cpaas-system \
  --type=json \
  -p='[{"op":"remove","path":"/spec/template/spec/containers/1/resources/limits"}]'
```

After the patch lands, the Deployment rolls out new pods with no `resources.limits` on either container; the `requests` remain in place so the scheduler still reserves the floor on each node. Validate that the new pods stay up and `restartCount` no longer climbs.

## Diagnostic Steps

List the ALB pods and watch `RESTARTS` for the `global-alb2-*` set. The pod's `containerStatuses[*].restartCount` field is exposed directly by `kubectl get pods` and increments each time the kubelet restarts a container in place after termination.

```bash
kubectl get pods -n cpaas-system -l service_name=alb2-global-alb2
```

Inspect a single pod's last-termination state. A container terminated by the cgroup OOM-killer shows `Last State: Terminated` with `Reason: OOMKilled` and an exit code of 137 in `kubectl describe pod`; `Reason: OOMKilled` is the kubelet label set specifically when the cgroup memory limit was hit, so its presence is the authoritative confirmation that the restart loop is memory-limit-driven rather than a generic crash.

```bash
kubectl describe pod -n cpaas-system <global-alb2-pod-name>
```

Read the current `resources` blocks on the Deployment to confirm what is configured before patching. The `nginx` container's limits should show `cpu=2, memory=2Gi` and the `alb2` container's limits `cpu=200m, memory=2Gi`, with both requests at `cpu=50m, memory=128Mi` on the v4.3.1 ALB plugin.

```bash
kubectl get deployment global-alb2 -n cpaas-system -o yaml \
  | grep -A4 resources:
```

If `kubectl describe` shows a generic `Reason: Error` and exit code 137 rather than `Reason: OOMKilled`, the container was killed by SIGKILL from another source (for example, a node-level eviction or an external signal) — only the kubelet's `OOMKilled` reason string conclusively attributes the termination to the cgroup memory limit, so treat the two surfaces separately when triaging.
