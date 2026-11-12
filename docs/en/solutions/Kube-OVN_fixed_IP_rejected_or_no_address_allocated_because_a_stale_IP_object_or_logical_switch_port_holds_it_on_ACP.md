---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Kube-OVN fixed IP rejected or no address allocated because a stale IP object or logical switch port holds it on ACP

## Issue

One of the following happens on a Kube-OVN cluster:

- A business Pod with a fixed IP stays in `ContainerCreating`, and its sandbox event says `request ip return 500 no address allocated to pod`. The used-IP page lists the address as used by two containers, one of which no longer exists.
- When a container is created with a fixed IP, the console says the fixed IP cannot be used, and the address turns out to belong to a CronJob Pod that finished long ago.
- In a namespace bound to two underlay subnets, Pods take addresses from the older subnet until it is nearly full and then stay stuck with `NoAvailableAddress`, while the newer subnet has more than a thousand free addresses:

  ```text
  FailedCreatePodSandBox: Failed to create pod sandbox: rpc error: code = Unknown desc = failed to setup network for sandbox "<id>": plugin type="kube-ovn" failed (add): RPC failed; request ip return 500 no address allocated to pod <namespace>/<pod> provider ovn, please see kube-ovn-controller logs to find errors
  ```

In each case the address is held by Kube-OVN bookkeeping, not by a running Pod: an `ips.kubeovn.io` object (IP object) or an OVN logical switch port left behind by a deleted Pod, or a u2o interconnection IP object that was never created for an old subnet. If `kubectl get pod -A -o wide | grep -w <address>` returns a running Pod, the address is really in use and this article does not apply.

## Root Cause

### Cause 1: a deleted Pod's IP object and logical switch port remain on the fixed address

A defect in the automatic garbage collection (GC) of some newer Kube-OVN versions leaves the IP object and the logical switch port of a deleted Pod on its fixed address. Environments upgraded from older versions are more likely to hit it; later versions improve the GC logic.

The new Pod then fails with `request ip return 500 no address allocated to pod`, and the controller logs report the address pool as exhausted. The used-IP view first lists only one container on the address; after `kube-ovn-controller` restarts, it lists two, one of which no longer exists. The OVN southbound database is healthy. Deleting the stale IP object lets the new Pod start; the used-IP page shows two users until the stale logical switch port is also deleted and `kube-ovn-controller` is restarted.

### Cause 2: the console rejects the fixed IP because IP objects of finished CronJob Pods remain

`kubectl get pod -A -o wide | grep -w <fixed-ip>` returns nothing, but `kubectl get ip | grep <fixed-ip>` returns an IP object named after a historical CronJob Pod (`<cronjob-pod>.<namespace>`). One address can carry many such objects (dozens from the same CronJob) next to the valid object of the Pod that really uses it.

On Kube-OVN `v1.12.35`, these objects are residue from before the current controller started; cleanup of recent CronJob Pods is normal. That version does not clean up existing residue: its cleanup deletes the OVN port first and then the IP object, and if the IP object delete fails it only logs the error and still releases the IPAM address without requeuing the object. The periodic GC iterates only existing ports and does not check IP object owners. That is why the objects persist and why several of them can record one address. The residue affects only the console, which reads IP objects rather than subnet status.

### Cause 3: NoAvailableAddress in a namespace bound to two underlay subnets because the older subnet has no u2o IP object

A namespace is bound to an older underlay subnet created before an upgrade (for example a `/23` with 508 used and 1 available) and a newer one (for example a `/22` with 1 used and 1020 available). Pods take addresses from the older subnet first, and once it runs out the remaining Pods stay stuck instead of using the newer one; their events repeat `AcquireAddressFailed: NoAvailableAddress`.

`kubectl get ip | grep u2o` shows a u2o interconnection IP object for the newer subnet and none for the older one. The older subnet was carried over from an earlier version, and its u2o IP object was not created automatically during the upgrade. Its u2o address usage records are incomplete, and when the subnet is close to exhaustion the allocation state becomes inconsistent.

This is different from a subnet whose u2o address is the default `.2`, which has no IP object by design. Here a sibling subnet of the same cluster has one, the subnet without it predates an upgrade, and allocation fails as it fills.

## Resolution

### Cause 1: a deleted Pod's IP object and logical switch port remain on the fixed address

1. Prove that the Pod named by the IP object and the port is gone:

   ```bash
   kubectl get ip -o wide | grep <fixed-ip>
   kubectl get pod -A -o wide | grep -w <fixed-ip>
   kubectl ko nbctl list logical_switch_port | grep -B3 -A8 <fixed-ip>
   kubectl ko sb status
   ```

2. Delete the stale IP object and logical switch port, then restart `kube-ovn-controller`. The logical switch port of a Pod is named `<pod-name>.<namespace>`.

   > **Warning:** Deleting an IP object frees the address for the next allocation, and `lsp-del` removes the port from the OVN northbound database at once. If the Pod named in them is in fact running, it loses its network and the address can be handed out twice. Only when the Pod named in the IP object and the port does not exist. Save both objects first. There is no undo other than recreating the Pod. Restarting `kube-ovn-controller` pauses allocation cluster-wide until the new leader is ready.

   ```bash
   kubectl get ip <stale-ip-object> -o yaml > /root/ip-<stale-ip-object>.yaml
   kubectl delete ip <stale-ip-object>
   kubectl ko nbctl list logical_switch_port <pod-name>.<namespace> > /root/lsp-<pod-name>.txt
   kubectl ko nbctl lsp-del <pod-name>.<namespace>
   kubectl -n kube-system delete pod -l app=kube-ovn-controller
   ```

   After the delete the new Pod starts, and after the controller restart the used-IP page shows one user again. A Kube-OVN release with the improved GC prevents a recurrence.

### Cause 2: the console rejects the fixed IP because IP objects of finished CronJob Pods remain

1. List every IP object whose Pod does not exist. Node IP objects, u2o interconnection objects and VIP objects have no Pod by design; they are printed for review and must be left alone.

   ```bash
   kubectl get ip -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.namespace}{"\t"}{.spec.podName}{"\t"}{.spec.ipAddress}{"\n"}{end}' > /root/ip-objects.txt
   while IFS=$'\t' read -r name ns pod addr; do
     [ -z "$ns" ] && { echo "review (no namespace): $name $addr"; continue; }
     kubectl -n "$ns" get pod "$pod" >/dev/null 2>&1 || echo "orphan: $name $ns/$pod $addr"
   done < /root/ip-objects.txt
   kubectl get pod -A -o wide | grep -w <fixed-ip>
   ```

2. Delete the orphan objects after review.

   > **Warning:** Deleting an IP object whose Pod is still running, or is being created at that moment, lets the address be allocated twice. Only delete objects printed as `orphan` whose Pod is confirmed absent, and keep `/root/ip-objects.txt` plus a YAML copy of each object. The delete is irreversible; recreating the Pod is the only way to get a valid object back.

   ```bash
   kubectl get ip <orphan-ip-object> -o yaml > /root/ip-<orphan-ip-object>.yaml
   kubectl delete ip <orphan-ip-object>
   ```

3. Retry the fixed IP in the console. A CronJob whose Pods are cleaned up normally on the current version needs no change.

### Cause 3: NoAvailableAddress in a namespace bound to two underlay subnets because the older subnet has no u2o IP object

1. Confirm the pattern: both subnets list the namespace, the older one is nearly full, and only the newer one has a u2o IP object.

   ```bash
   kubectl get subnet <old-subnet> <new-subnet> -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,VLAN:.spec.vlan,NS:.spec.namespaces,U2O:.spec.u2oInterconnection,U2OIP:.status.u2oInterconnectionIP,USED:.status.v4usingIPs,AVAIL:.status.v4availableIPs'
   kubectl get ip | grep u2o-interconnection
   kubectl -n kube-system logs deploy/kube-ovn-controller --tail=3000 > /root/kube-ovn-controller.log
   ```

2. Export the existing object as a template, and read the values for the older subnet: its u2o address from the Subnet status, its UID for the owner reference, and the MAC of its u2o router port from the northbound database.

   ```bash
   kubectl get ip u2o-interconnection.ovn-cluster.<new-subnet> -o yaml > /root/u2o-ip-template.yaml
   kubectl get subnet <old-subnet> -o jsonpath='{.status.u2oInterconnectionIP} {.metadata.uid}{"\n"}'
   kubectl ko nbctl show ovn-cluster | grep -B2 -A2 '<old-subnet-u2o-ip>'
   ```

3. In a copy of the template, change every field that names the newer subnet, its address, its MAC or its UID to the older subnet's values, and remove `metadata.uid`, `metadata.resourceVersion`, `metadata.creationTimestamp` and `status`. Use the template's name pattern (`u2o-interconnection.ovn-cluster.<old-subnet>`). Then create the object and check its ownership and the subnet counters.

   > **Warning:** An IP object with a wrong address or MAC records a false allocation in the subnet, and other Pods can then collide with the real u2o address or be refused a free one. Only when the sibling subnet's object exists and this subnet's is missing. Keep the template and the new file. To roll back, delete the object you created.

   ```bash
   cp /root/u2o-ip-template.yaml /root/u2o-ip-<old-subnet>.yaml
   vi /root/u2o-ip-<old-subnet>.yaml
   kubectl apply -f /root/u2o-ip-<old-subnet>.yaml
   kubectl get ip u2o-interconnection.ovn-cluster.<old-subnet> -o yaml | grep -A6 ownerReferences
   kubectl get subnet <old-subnet> -o jsonpath='{.status.u2oInterconnectionIP} {.status.v4usingIPs} {.status.v4availableIPs}{"\n"}'
   ```

4. Recreate one stuck Pod and watch its events. If Pods still do not fall back to the newer subnet when the older one is full, pin the workload to the newer subnet with the Pod annotation `ovn.kubernetes.io/logical_switch: <new-subnet>`.

## Diagnostic Steps

```bash
kubectl describe pod <pod> -n <namespace> | grep -A3 -E 'FailedCreatePodSandBox|AcquireAddressFailed'
kubectl get ip -o wide | grep <address>
kubectl get pod -A -o wide | grep -w <address>
kubectl ko nbctl list logical_switch_port | grep -B3 -A8 <address>
kubectl get ip | grep u2o-interconnection
```

- An IP object or logical switch port for the address whose Pod does not exist, with `no address allocated to pod` on the new Pod, is Cause 1.
- A console rejection of a fixed IP whose IP object is named after a finished CronJob Pod, often with several objects for one address, is Cause 2.
- `NoAvailableAddress` in a namespace bound to two underlay subnets, with a u2o IP object for only one of them, is Cause 3.
- If `kubectl get pod -A -o wide | grep -w <address>` returns a running Pod, the address is really in use by that Pod.
