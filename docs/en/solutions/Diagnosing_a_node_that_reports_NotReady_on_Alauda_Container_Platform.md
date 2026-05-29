---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500429
---

# Diagnosing a node that reports NotReady on Alauda Container Platform

## Issue

A node (`core/v1` Node) shows status `NotReady` in the cluster. The Ready condition on a healthy node is sourced from the kubelet on that node host: on an observed Ready node (kubelet `v1.34.5`) the condition carries reason `KubeletReady` with the message `kubelet is posting ready status`. The same kubelet-posted status also drives the companion node conditions reported with reasons `KubeletHasSufficientMemory`, `KubeletHasNoDiskPressure`, `KubeletHasSufficientPID`, and `KubeletReady`. The kubelet's heartbeat is observable as the live `renewTime` on the node's `Lease` in `kube-node-lease`, which advances about every 10 seconds on a healthy node. When the kubelet stops posting status, that heartbeat stops advancing; after the configured `--node-monitor-grace-period` (50 seconds on this cluster) of missed heartbeats, the node-lifecycle controller transitions the Ready condition away from `True` and the node is reported `NotReady`.

```bash
kubectl get nodes
kubectl describe node <node-name>
```

## Root Cause

Because the Ready condition depends on the kubelet successfully posting status, a `NotReady` node usually points back to the kubelet on that node host. On the inspected worker nodes (kubelet `v1.34.5`, Ubuntu 22.04.1 LTS, `containerd://2.2.1-5`) the kubelet runs as a host `systemd` unit — `kubelet.service`, the Kubernetes Node Agent — observed `active (running)`, serving on port `10250`, and acting as the source component for node-level events. A common cause of `NotReady` is that this kubelet service on the node host is not running, so no status is posted. A second common cause is that the kubelet is running but cannot reach the API server endpoint (the in-cluster `kubernetes` Service endpoint, observed at `192.168.135.152:6443`, `https`), so its status updates do not arrive.

## Resolution

When a node is `NotReady`, confirm the kubelet on that node host is running and, if it is, that it can reach the API server endpoint; restoring either path lets the kubelet resume posting status and the node return to Ready.

Check the kubelet service state on the node host (the kubelet is a host `systemd` unit, observed `active (running)` on the healthy worker nodes). When the kubelet is not running, restoring the service is what lets it resume posting status:

```bash
systemctl status kubelet
journalctl -u kubelet -n 200 --no-pager
```

If the kubelet is running, confirm it can reach the API server endpoint on the cluster (the kubelet must be able to connect to the API server to post status). From the node host, the apiserver liveness endpoint responded `ok` over `https`, confirming the network path the kubelet uses to post status:

```bash
curl -k --max-time 5 https://192.168.135.152:6443/livez
```

## Diagnostic Steps

Inspect the node's reported conditions; on a healthy node the Ready condition is `KubeletReady` with message `kubelet is posting ready status`. The live heartbeat is the node's `Lease` `renewTime` in `kube-node-lease`, which advances about every 10 seconds while the kubelet posts; a `renewTime` that stops advancing for longer than `--node-monitor-grace-period` (50 seconds on this cluster) is what drives the node to `NotReady`.

```bash
kubectl get node <node-name> \
  -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\n"}{end}'
kubectl get lease <node-name> -n kube-node-lease \
  -o jsonpath='renew={.spec.renewTime} dur={.spec.leaseDurationSeconds}{"\n"}'
```

On the node host, confirm the kubelet service is up; on the inspected worker nodes `systemctl is-active kubelet` returned `active`, with `journalctl -u kubelet` showing live log lines from the running kubelet.

```bash
systemctl is-active kubelet
journalctl -u kubelet -n 50 --no-pager
```

From the node host, verify connectivity to the API server endpoint so the kubelet can post status; the apiserver liveness endpoint returns `ok` over `https` when the path is healthy.

```bash
curl -k --max-time 5 https://192.168.135.152:6443/livez
```
