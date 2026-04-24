---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A new worker is added to the cluster but the node never transitions from `NotReady` to `Ready`. The kubelet reports:

```text
container runtime network not ready: NetworkReady=false
reason:NetworkPluginNotReady
message:Network plugin returns error: No CNI configuration file in /etc/kubernetes/cni/net.d/
```

Networking-layer daemonset pods (the OVN CNI node pod, Multus node pod, network-diagnostics pods) do not become Ready on the new node, so no CNI config is ever written to `/etc/kubernetes/cni/net.d/` and kubelet refuses workloads. `kubectl describe node` on the affected node shows the matching condition:

```text
DaemonSet "<ovn-ns>/ovnkube-node" rollout is not making progress
- last change 2023-04-17T13:04:53Z
reason: RolloutHung
```

The cluster network operator is also unhappy:

```text
kubectl get co network
network   <ver>   True    True    True    19m
```

## Root Cause

The per-node OVN CNI pod (`ovnkube-node` / the equivalent Kube-OVN node agent in ACP) depends on the OVN control-plane pods to register the new node in the OVN database before it can write the CNI configuration file. When the control-plane pods get into a stale state — typically after the previous control-plane leader crashed or lost contact with NBDB/SBDB — they stop servicing registrations for newly added nodes even though existing nodes continue to work.

From the new node's perspective the symptom is simple: the CNI node pod comes up, asks the control plane for its node configuration, never gets a response, and therefore never writes `/etc/kubernetes/cni/net.d/<cni>.conf`. The kubelet sees no CNI config, so every pod (including the networking daemonset itself) is unschedulable with `NetworkPluginNotReady`.

Restarting the control-plane pods refreshes their connection to the OVN database and lets them process the pending node-registration.

## Resolution

ACP's CNI is **Kube-OVN**. The control-plane component and namespace differ between Kube-OVN versions and platform variants — check which pods are actually running before restarting. The pattern is: identify the OVN control-plane deployment, roll it, then verify the new node goes Ready.

1. **Find the OVN control-plane namespace and workload.**

   ```bash
   kubectl get pod -A | grep -E "ovn|kube-ovn" | head
   ```

   On a Kube-OVN install the control-plane workload is typically `kube-ovn-controller` (Deployment) in the `kube-system` namespace (or a dedicated `kube-ovn` namespace, depending on how the cluster was installed). On deployments that still use an older OVN-Kubernetes-style control plane, look for `ovnkube-control-plane` (recent releases) or `ovnkube-master` (older releases).

2. **Roll the control-plane pods.**

   Use a rollout restart — it is graceful, honours the PDB if one is set, and does not leave the cluster without a leader:

   ```bash
   OVN_NS=<ovn-namespace>        # e.g. kube-system
   CTRL=<control-plane-workload> # e.g. deploy/kube-ovn-controller

   kubectl -n "$OVN_NS" rollout restart "$CTRL"
   kubectl -n "$OVN_NS" rollout status  "$CTRL" --timeout=5m
   ```

   If you must delete pods manually (legacy installs without a rollout controller), delete them one at a time and wait for each replacement to become Ready before moving to the next:

   ```bash
   for pod in $(kubectl -n "$OVN_NS" get pod -l <ovn-control-plane-label> -o name); do
     kubectl -n "$OVN_NS" delete "$pod"
     # wait for a replacement to reach 1/1 Running before the next delete
     kubectl -n "$OVN_NS" wait --for=condition=Ready pod \
       -l <ovn-control-plane-label> --timeout=120s
   done
   ```

3. **Watch the new node register.**

   Within a couple of minutes the per-node OVN CNI pod should complete its registration, write the CNI config, and the kubelet should pick it up:

   ```bash
   kubectl get pod -n "$OVN_NS" -o wide | grep <new-node>
   kubectl get nodes | grep <new-node>
   ```

   The node moves to `Ready`, Multus and the network-diagnostics daemonsets schedule, and newly created pods get IPs.

If restarting the control plane does not clear the problem, the OVN databases themselves may be corrupt or unreachable. That is a separate troubleshooting path — inspect the NB/SB leader via the OVN tooling inside the control-plane pod before attempting any cluster-wide action.

## Diagnostic Steps

Check node and network-operator state:

```bash
kubectl get nodes | grep -i notready
kubectl get co network
```

Inspect the NotReady node condition:

```bash
kubectl describe node <node> | sed -n '/Conditions:/,/Addresses:/p'
```

Look for networking pods in `Pending`/`ContainerCreating` on the affected node:

```bash
kubectl get pod -A -o wide | grep -E "<node>.*(Pending|ContainerCreating)"
```

Confirm from the node itself that `/etc/kubernetes/cni/net.d/` is empty (proves the CNI config was never written rather than corrupted):

```bash
kubectl debug node/<node> -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ls -la /etc/kubernetes/cni/net.d/
```

Sample the kubelet journal on the node for the recurring "Has your network provider started?" error:

```bash
kubectl debug node/<node> -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl -u kubelet --no-pager | tail -100 \
  | grep -E "NetworkPluginNotReady|No CNI configuration file"
```

After the resolution steps, expect the node to transition to `Ready` within a couple of minutes and new pods on that node to get IPs from the OVN subnet they are assigned to.
