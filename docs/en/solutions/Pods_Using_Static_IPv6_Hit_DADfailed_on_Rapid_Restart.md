---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Pods Using Static IPv6 Hit DADfailed on Rapid Restart
## Issue

A workload runs as a `Deployment` and its pod template pins a specific IPv6 address (via a CNI attachment, a static allocator, or an equivalent mechanism). When the pod is deleted or restarted, the replacement pod either takes up to roughly 30 seconds before it begins replying on the network, or fails sandbox setup entirely with a CNI error like:

```text
failed to settle addresses for "net1": link net1 has address
2001:db8::1 in DADFAILED state
```

The same symptom is observed consistently when the pod's IPv6 address is intended to be stable across restarts of a `Deployment`.

## Root Cause

IPv6 Duplicate Address Detection (DAD) is a kernel-level safeguard: when a NIC comes up with an address, the stack sends a Neighbor Solicitation for that address and waits for a brief window to make sure nothing else on the segment claims it. The address is `tentative` during that window and unusable for traffic. If any other interface on the segment answers — including the *previous* tenant of the address — DAD fails and the new tenant's address is marked `DADFAILED`, which is exactly the state the CNI log is reporting.

This is where `Deployment` semantics matter. A `Deployment`'s default `RollingUpdate` strategy, and its behavior on a direct pod delete, does not guarantee that the old pod has finished terminating before the new pod starts. The ReplicaSet creates the replacement immediately — while the outgoing pod is still in `Terminating`, its sandbox may still hold the network namespace, its veth may still be attached to the node bridge, and the neighbor cache upstream may still be advertising the pod's IPv6 address. The new pod powers up on that same address and the kernel legitimately refuses it.

Even the `Recreate` strategy only guarantees termination before creation on *upgrades* (a rollout triggered by pod-template change); a manual `kubectl delete pod` falls back to ReplicaSet-driven replacement with immediate creation.

The correct fit for "a workload that needs a stable network identity preserved across restarts" is not `Deployment` at all — it is `StatefulSet`. A `StatefulSet` with its default `rollingUpdate` strategy guarantees that pod N terminates fully and is removed before pod N is recreated. That ordering is exactly what DAD needs: the old neighbor entry ages out (or is explicitly released by the CNI on sandbox teardown) before the new pod claims the same address.

## Resolution

Switch the workload from `Deployment` to `StatefulSet` whenever the pod identity — static IP, stable hostname, persistent volume binding — must survive restarts. This is not a performance optimization; it is the object the Kubernetes API provides for this exact requirement.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ipv6-pinned
  namespace: example
spec:
  serviceName: ipv6-pinned-headless
  replicas: 1
  selector:
    matchLabels:
      app: ipv6-pinned
  template:
    metadata:
      labels:
        app: ipv6-pinned
      annotations:
        # Replace with the CNI attachment annotation your network plugin uses.
        # The point is that the address is pinned via the pod template.
        k8s.v1.cni.cncf.io/networks: '[{"name":"example-net","ips":["2001:db8::1/64"]}]'
    spec:
      terminationGracePeriodSeconds: 10
      containers:
        - name: app
          image: ghcr.io/example/app:1.2.3
```

Two adjustments help the DAD window close cleanly even with the right controller shape:

- **Keep `terminationGracePeriodSeconds` short but non-zero** (around 10 seconds is usually enough for a clean shutdown plus sandbox teardown). Forcing `0` risks leaving the veth attached just long enough to collide with the recreate.
- **Let the CNI release the address on pod delete.** Most CNI plugins already do this as part of `CNI DEL`; confirm the plugin in use is not configured to "lease" addresses across pod generations, which would keep the neighbor entry alive and re-trigger DADFAILED on the next scheduling cycle.

If moving to `StatefulSet` is genuinely impossible (for example, the workload must scale horizontally with unique-but-rotating IPv6 addresses), do not pin the address. Use a pool-allocated dynamic address and let the CNI issue a fresh one on each recreate; the DAD stall only shows up when the same address is re-used within its neighbor-cache lifetime.

## Diagnostic Steps

Reproduce and confirm the shape of the failure:

```bash
# Watch CNI events for the offending pod
kubectl describe pod <pod> -n <ns> | grep -iE 'failed|dad'
```

On the node hosting the recreated pod, the kernel exposes the DAD state directly:

```bash
# Run inside the host network namespace of the affected node
ip -6 addr show | grep -E 'tentative|dadfailed'

# Neighbor cache entries that still advertise the old tenant
ip -6 neigh show | grep -i '<your-ipv6>'
```

If an entry shows up as `DADFAILED`, the address is pinned somewhere else on the L2 segment — either the terminating pod's veth has not been cleaned up, or another node's workload is claiming the same address. Kill the first possibility by confirming the previous pod is truly gone:

```bash
kubectl get pod -n <ns> -w
```

and verify the new replacement is only scheduled after the old one has left `Terminating`. If the old pod lingers, investigate its finalizers; if the new pod appears before the old one is removed, the controller is a `Deployment` and the fix is the one above — migrate to `StatefulSet`.
