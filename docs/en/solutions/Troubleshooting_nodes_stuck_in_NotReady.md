---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Troubleshooting nodes stuck in NotReady
## Issue

A node reports `Status: NotReady` in `kubectl get nodes`. Pods scheduled on the node go into `Unknown` or `Terminating`; new pods cannot be placed on it; existing workloads on the node may keep running for a while but become invisible to the cluster.

The same surface symptom (`NotReady`) covers very different underlying problems. The two most common roots are:

- The `kubelet` process on the node is **not running** at all (crashed, stopped, or its dependency — the container runtime — is down).
- The `kubelet` process is running but **cannot reach the API server**, so it cannot post status heartbeats and the apiserver downgrades the node after the configured grace window.

This article walks through how to distinguish the two, and how to fix each.

## Resolution

### 1. Confirm the node is genuinely NotReady

From a control-plane host, look at the node and the conditions block:

```bash
kubectl get node <node>
kubectl describe node <node> | sed -n '/Conditions:/,/Addresses:/p'
```

The output shows one row per condition; the relevant ones are `Ready`, `MemoryPressure`, `DiskPressure`, `PIDPressure`, `NetworkUnavailable`. If `Ready=Unknown`, the kubelet is not posting heartbeats — focus on connectivity (step 4). If `Ready=False` with a specific message, the kubelet is reporting the failure itself — focus on the kubelet (step 2 and 3).

### 2. Inspect the kubelet on the node

Open a shell on the affected node — either over SSH, or via a privileged debug pod with a host shell:

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image>
chroot /host
```

Then check the kubelet unit:

```bash
systemctl status kubelet
journalctl -u kubelet -n 200 --no-pager
```

If the unit is `inactive` or repeatedly restarting:

- Look for `failed to start container manager` or `failed to start kubelet` errors with the runtime endpoint mentioned — that points at the container runtime (step 3).
- Look for `runtime is unable to ...` or `node not found` messages — that points at apiserver connectivity (step 4).
- Look for `out of memory` / `killed` messages — the node ran out of resources; clean up before restarting kubelet.

If the unit is healthy, restart it once to clear transient state:

```bash
systemctl restart kubelet
journalctl -u kubelet -f
```

### 3. Inspect the container runtime

The kubelet depends on a CRI runtime (typically `cri-o` or `containerd`). If the runtime is down, the kubelet refuses to declare the node Ready:

```bash
systemctl status crio       # or: systemctl status containerd
journalctl -u crio -n 200   # or: journalctl -u containerd -n 200
crictl info | head -40
```

A failing runtime is usually one of:

- Disk pressure: `/var/lib/containers/` (cri-o) or `/var/lib/containerd/` is full.
- A leaked container blocking startup: clean it with `crictl rm -f <id>`.
- A configuration drift: confirm `/etc/crio/crio.conf` (or `/etc/containerd/config.toml`) matches the rest of the fleet.

After restoring the runtime, the kubelet usually recovers on its own; if not, restart it explicitly.

### 4. Confirm kubelet-to-apiserver connectivity

Even when the kubelet is running, the node only reports `Ready` if it can post heartbeats to the apiserver. From the affected node:

```bash
# From the node, hit the apiserver URL the kubelet uses
curl -k --resolve api.<cluster-domain>:6443:<vip> \
     https://api.<cluster-domain>:6443/livez
```

Failures here mean a network problem between the node and the control plane: cluster VIP, route, MTU, firewall, or TLS expiry. Resolve the underlying network issue, then watch the kubelet log come unblocked. If the kubelet client certificate has expired (look for `x509: certificate has expired or is not yet valid` in the kubelet log), rotate it via the cluster's certificate-rotation mechanism before the kubelet can re-register.

### 5. Verify the node returns to Ready

Once the underlying cause is addressed, watch the node from a control-plane host:

```bash
kubectl get node <node> -w
```

The node should transition `NotReady` → `Ready` within one or two heartbeat intervals (a few tens of seconds). If it does not, repeat steps 2–4 with the latest logs — multiple failures often stack (for example, a runtime that came back but with a stale image cache that breaks the next pod sandbox).

## Diagnostic Steps

1. List nodes and their last-heartbeat times:

   ```bash
   kubectl get nodes -o wide
   kubectl get node <node> -o jsonpath='{.status.conditions[?(@.type=="Ready")]}{"\n"}'
   ```

2. Capture the apiserver's view of the node's recent events:

   ```bash
   kubectl describe node <node> | sed -n '/Events:/,$p'
   ```

3. From the node itself, capture kubelet and runtime state for the symptomatic window:

   ```bash
   journalctl -u kubelet --since "30 minutes ago"
   journalctl -u crio    --since "30 minutes ago"   # or containerd
   ```

4. If suspecting connectivity, trace the path from node to apiserver:

   ```bash
   ip route get <apiserver-vip>
   ss -tnp | grep <apiserver-port>
   curl -kv --max-time 5 https://<apiserver-vip>:6443/livez
   ```

5. If the same node keeps flipping `Ready ↔ NotReady`, look at memory and PID pressure on the node — kubelet evicts itself from Ready when the node crosses the eviction thresholds, so a node that flaps is sometimes simply oversubscribed.
