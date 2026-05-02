---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A new worker is added to the cluster but the node never transitions from `NotReady` to `Ready`. The kubelet on the affected node reports:

```text
container runtime network not ready: NetworkReady=false
reason: NetworkPluginNotReady
message: Network plugin returns error: No CNI configuration file in /etc/cni/net.d/
```

The networking-layer DaemonSet pods that should write the CNI configuration on the new node — `kube-ovn-cni`, `kube-multus-ds`, and `ovs-ovn` — never reach the node, or reach it but fail to register with the OVN control plane. As a result `/etc/cni/net.d/` stays empty, the kubelet refuses to admit any workload, and `kubectl describe node <new-node>` shows the matching condition:

```text
Conditions:
  Type             Status  Reason                       Message
  Ready            False   KubeletNotReady              container runtime network not ready: …
  NetworkUnavailable  True  NoRouteCreated              … (only on some installers)
```

If the OVN control-plane is the bottleneck, a pod listing in `kube-system` shows healthy `kube-ovn-cni` pods on the existing nodes but a missing or `Pending` one on the new node, while `kube-ovn-controller` and `ovn-central` look healthy on the surface but their logs report stale leader / DB connection problems.

## Root Cause

The per-node CNI agent (`kube-ovn-cni`) cannot write `/etc/cni/net.d/01-kube-ovn.conflist` until it has obtained the node's logical-port configuration from `kube-ovn-controller`, which in turn reads from the OVN northbound and southbound databases hosted by `ovn-central`. When the control plane is in a stale state — typically after the previous `ovn-central` leader crashed, lost contact with NBDB/SBDB, or the `kube-ovn-controller` watch on the apiserver desynchronised — the controller stops servicing registrations for newly added nodes even though existing nodes continue to work.

From the new node's perspective the symptom is simple: the CNI node pod comes up, asks the controller for its node configuration, never gets a response, and therefore never writes the CNI conflist. The kubelet sees no CNI config, so every pod (including the networking DaemonSets themselves on later restart) is unschedulable with `NetworkPluginNotReady`.

Restarting the control-plane Deployments (`kube-ovn-controller` and, if needed, `ovn-central`) refreshes the apiserver watches and the OVN DB connections, and lets the controller process the pending node registration.

## Resolution

The pattern is: confirm the per-node CNI pod is the proximate failure, roll the OVN control plane in `kube-system`, then verify the new node goes Ready. The pod and Deployment names below are the ACP defaults (Kube-OVN in `kube-system`); a customised install may use a different namespace, but the workload names are stable.

1. **Confirm the per-node CNI agent state.**

   ```bash
   kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide
   ```

   Existing nodes show one Ready `kube-ovn-cni-<hash>` pod each; the new node either has no pod yet (DaemonSet has not scheduled there because the node is `NotReady`) or has a pod stuck in `ContainerCreating` / `CrashLoopBackOff`.

2. **Inspect the controller log for the node-registration failure.**

   ```bash
   kubectl -n kube-system logs deploy/kube-ovn-controller --tail=200 \
     | grep -E '<new-node>|register|node-port|allocate' | tail -40
   ```

   Look for repeated lines like `failed to register node <new-node>` or `timeout waiting for OVN NB`. Either of these confirms the control-plane is the bottleneck, not the node itself.

3. **Roll the Kube-OVN controller.**

   Use a rollout restart — it preserves the Deployment's PDB and does not leave the cluster without an OVN controller:

   ```bash
   kubectl -n kube-system rollout restart deployment/kube-ovn-controller
   kubectl -n kube-system rollout status  deployment/kube-ovn-controller --timeout=5m
   ```

   If the controller's rollout itself stalls (the new pods come up but log the same DB errors), also roll `ovn-central`, which hosts the NB/SB databases:

   ```bash
   kubectl -n kube-system rollout restart deployment/ovn-central
   kubectl -n kube-system rollout status  deployment/ovn-central --timeout=5m
   ```

   `ovn-central` runs as a 3-replica Deployment with leader election; rolling it is safe as long as a quorum survives at any moment, which `rollout restart` enforces.

4. **Watch the new node register.**

   Within a couple of minutes the per-node CNI pod should complete its registration, write the CNI conflist, and the kubelet should pick it up:

   ```bash
   kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide | grep <new-node>
   kubectl get nodes <new-node>
   ```

   The node moves to `Ready`, `kube-multus-ds` and `ovs-ovn` schedule on it, and newly created pods on that node get IPs from the OVN subnet they are assigned to.

If rolling the control plane does not clear the problem, the OVN databases themselves may be corrupt or unreachable. That is a separate troubleshooting path — inspect the NB/SB leader via `ovn-nbctl`/`ovn-sbctl` inside an `ovn-central` pod before attempting any cluster-wide action.

## Diagnostic Steps

Check node and key Deployment / DaemonSet state:

```bash
kubectl get nodes | grep -i notready
kubectl -n kube-system get deploy/kube-ovn-controller deploy/ovn-central
kubectl -n kube-system get ds/kube-ovn-cni ds/ovs-ovn ds/kube-multus-ds
```

Inspect the NotReady node's conditions:

```bash
kubectl describe node <new-node> | sed -n '/Conditions:/,/Addresses:/p'
```

Look for networking pods in `Pending`/`ContainerCreating` on the affected node:

```bash
kubectl get pod -A -o wide | grep -E "<new-node>.*(Pending|ContainerCreating)"
```

Confirm from the node itself that `/etc/cni/net.d/` is empty (proves the CNI conflist was never written, rather than corrupted):

```bash
kubectl debug node/<new-node> -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ls -la /etc/cni/net.d/
```

Sample the kubelet journal on the node for the recurring "No CNI configuration file" error:

```bash
kubectl debug node/<new-node> -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl -u kubelet --no-pager | tail -100 \
  | grep -E "NetworkPluginNotReady|No CNI configuration file"
```

After the resolution steps, expect the node to transition to `Ready` within a couple of minutes and new pods on that node to get IPs from the OVN subnet they are assigned to.
