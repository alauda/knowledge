---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.16"
  - "4.0"
  - "4.2"
  - "4.3"
---

# Kube-OVN fixed IP occupied or not released: held by another Pod, node down, duplicate entry or RollingUpdate on ACP

## Issue

A workload with a fixed IP cannot start because its address is taken. Typical reports:

- The console says the IP is in use and cannot be released, or the event is `FailedCreatePodSandBox ... plugin type="kube-ovn" failed (add): RPC failed; request ip return 500 no address allocated to pod <namespace>/<pod> provider ovn`.
- A fixed IP looks stuck and is reassigned only after about 40 seconds.
- After a node dropped off the network, the replacement Pod cannot take the same fixed address.
- Two applications in one namespace list the same IP.
- A new Pod fails with `AddressOutOfRange` and its annotations show the same address twice.
- A pipeline release fails because the new Pod wants an address the old Pod still holds, or a third Pod appears that never starts after a namespace quota was raised.
- On a Calico cluster, a second replica reports `failed to allocate ... from IPAM: resource already exists` while the IP object's `containerID`, `nodeName` and `podName` are empty.

Related articles: "Kube-OVN fixed IP NoAvailableAddress: spaces in the list, ip_pool not reserved, several subnets or leftover port on ACP"; "Kube-OVN fixed IP rejected or no address allocated because a stale IP object or logical switch port holds it on ACP" (when no running Pod holds the address).

## Root Cause

### Cause 1: another running application holds the address

`kubectl get ip` and `kubectl get pods -A -o wide | grep <fixed-ip>` show a live owner: a Pod of another application, possibly in another namespace and running for days, already uses the address pinned with `ovn.kubernetes.io/ip_pool` or `ovn.kubernetes.io/ip_address`. The address is not leaked; it is in use.

A fixed IP can also only look stuck. The `kube-ovn-controller` log shows the new Pod failing for a while with `static address <ip> for <namespace>/<new-pod> has been assigned to <namespace>/<old-pod>` and `acquire address from ippool <ip> ... failed`, then `release v4 <ip> from subnet <subnet> for <namespace>/<old-pod>, add ip to released list`, and later `allocate v4 <ip> ... for <namespace>/<new-pod>`. The new Pod gets the same IP and MAC about 40 seconds after the first failure.

### Cause 2: the node is down and the terminating Pod still holds the fixed IP

When the node running a fixed-IP Pod loses contact, the Pod stays `Terminating` and is not deleted, so its fixed-IP lease is not released. The replacement on another node fails network setup with an address conflict.

### Cause 3: two applications in the same namespace are configured with the same IP

Both workloads pin the same address, so whichever starts second fails.

### Cause 4: Calico IP object with empty containerID, nodeName and podName

On a Calico cluster, a second replica fails at the CNI with `failed to allocate ... from IPAM: resource already exists`. `kubectl get ip <address>` shows empty `containerID`, `nodeName` and `podName` while `workload` still names the application, and a live Pod already uses the address. The `raven` logs in `kube-system` show nothing. The platform IP status and Calico IPAM are out of step.

### Cause 5: AddressOutOfRange after a duplicate IP assignment

A new Pod fails with `AddressOutOfRange`, and its annotations show the same address assigned twice. Removing the duplicate assignment lets the Pod be created.

### Cause 6: RollingUpdate creates the new Pod while the fixed IP is still taken

With `strategy.type: RollingUpdate`, the new Pod is created before the old one is deleted, so the fixed address is still in use; a single-instance service with one fixed IP fails the same way on every update. A stalled rollout causes the same shortage later: a Deployment with `replicas: 2`, the default `maxSurge: 25%` and two addresses in `ovn.kubernetes.io/ip_pool` was restarted while the namespace quota was full, so the surge Pod could not be created and the rollout never finished. Deleting Pods by hand does not cancel the rollout. When the quota was raised, the rollout resumed and created a third Pod (`deployment.kubernetes.io/max-replicas: "3"` on the ReplicaSet) that could never start because both pinned addresses were in use.

## Resolution

### Cause 1: another running application holds the address

Stop the application that holds the address, or change this workload's fixed IP to a free address. When the log shows the release-and-reallocate sequence above, wait for the reallocation before treating the address as leaked.

> **Warning:** Changing `ovn.kubernetes.io/ip_pool` in the Pod template rolls the Deployment onto a different address; anything that reaches it by the old address breaks. Pick an address inside the namespace's subnet, outside `excludeIps`, with no IP object. Save the Deployment; restoring it is the rollback.

```bash
kubectl get pods -A -o wide | grep <fixed-ip>
kubectl get ip -o wide | grep <new-free-address>
kubectl get deploy <deploy> -n <namespace> -o yaml > /root/deploy-<deploy>.before.yaml
kubectl -n <namespace> patch deploy <deploy> --type=merge -p '{"spec":{"template":{"metadata":{"annotations":{"ovn.kubernetes.io/ip_pool":"<new-free-address>"}}}}}'
kubectl -n kube-system logs deploy/kube-ovn-controller --tail=2000 | grep <fixed-ip> | grep -E 'has been assigned to|acquire address|release v4|allocate v4'
```

### Cause 2: the node is down and the terminating Pod still holds the fixed IP

Force-delete the stuck Pod so the lease is released. For the longer term, pin more addresses than replicas and spread the replicas with Pod anti-affinity, so one node loss cannot use up the pins.

> **Warning:** A force delete skips the grace period and `preStop`. Only when the node is confirmed down and unreachable; otherwise the old process may still use the address and you create a duplicate. The delete cannot be undone.

```bash
kubectl get node <node-name>
kubectl get pod <stuck-pod> -n <namespace> -o wide
kubectl delete pod <stuck-pod> -n <namespace> --force --grace-period=0
```

### Cause 3: two applications in the same namespace are configured with the same IP

Change one of the two settings so they no longer overlap, then restart both applications.

```bash
kubectl get deploy,sts -n <namespace> -o yaml | grep -n -E 'ip_address|ip_pool'
```

### Cause 4: Calico IP object with empty containerID, nodeName and podName

Restart the `raven` Pods in `kube-system`, then restart the application.

> **Warning:** Restarting `raven` pauses IP status updates until the new Pod is Ready, and restarting the application drops its connections. Only when the IP object has the empty fields, a live Pod uses the address, and the CNI says `resource already exists`.

```bash
kubectl get ip <address> -o yaml
kubectl -n kube-system get pod -o wide | grep raven
kubectl -n kube-system delete pod <raven-pod>
kubectl -n <namespace> rollout restart deploy/<deploy>
```

### Cause 5: AddressOutOfRange after a duplicate IP assignment

Inspect the annotations, keep one assignment of the duplicated address, and recreate the Pod.

```bash
kubectl get pod <pod> -n <namespace> -o jsonpath='{.metadata.annotations}{"\n"}'
```

### Cause 6: RollingUpdate creates the new Pod while the fixed IP is still taken

Switch the workload to `Recreate`. If the service does not need a fixed IP, removing the fixed-IP setting also works.

> **Warning:** `Recreate` stops the current replicas before starting new ones, so requests fail during the gap. Setting `RollingUpdate` back is the rollback and brings the failure back while the pin list is only as long as `replicas`.

```bash
kubectl patch deploy <deploy> -n <namespace> --type=merge -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
```

For a stalled rollout that left an extra Pod, scale the Deployment to `0` and back to clear the rollout state. To prevent it, pin at least `replicas + maxSurge` addresses (three for two replicas at `25%`), or set `maxSurge: 0` and accept one fewer replica during updates.

> **Warning:** Scaling to `0` stops every replica until the new Pods are Ready. Run it in a window.

```bash
kubectl -n <namespace> get rs -o yaml | grep -E 'desired-replicas|max-replicas'
kubectl -n <namespace> scale deploy <deploy> --replicas=0
kubectl -n <namespace> scale deploy <deploy> --replicas=<replicas>
kubectl -n <namespace> patch deploy <deploy> --type=merge -p '{"spec":{"strategy":{"rollingUpdate":{"maxSurge":0,"maxUnavailable":1}}}}'
```

## Diagnostic Steps

```bash
kubectl get ip -o wide
kubectl get pod -A -o wide | grep <address>
kubectl describe pod <pod> -n <namespace>
kubectl get events -n <namespace> --field-selector involvedObject.name=<pod>
```

- A running Pod of another workload on the address, or `no address allocated to pod` with the pinned address owned elsewhere: Cause 1. A release-then-reallocate sequence in the controller log: Cause 1, wait.
- The previous owner is `Terminating` on a `NotReady` node: Cause 2.
- Two workloads in the namespace with the same address in their annotations: Cause 3.
- A Calico IP object with empty `containerID`, `nodeName` and `podName` plus `resource already exists`: Cause 4.
- `AddressOutOfRange` with a duplicated address in the annotations: Cause 5.
- A failure during an update with `RollingUpdate`, or an extra Pod after a quota change: Cause 6.
