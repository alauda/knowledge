---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.2"
  - "4.3"
---

# Kube-OVN subnet stuck Terminating or Pods use the wrong subnet: finalizers, namespace binding or uppercase IPv6 on ACP

## Issue

- A subnet stays in deleting (`Terminating`) forever, and `kubectl describe subnet` still lists `Finalizers: kubeovn.io/kube-ovn-controller`.
- After namespaces were bound to `ovn-default`, Pods in other namespaces stop getting addresses; or Pod restarts in a namespace fail with `AddressOutOfRange` because the namespace was never bound to the subnet it should use.
- The MetalLB address pool and BGP peer pages say MetalLB is not installed although it was never uninstalled, containers cannot resolve the registry domain, and the default subnet `ovn-default` is stuck in deleting.
- A namespace was moved from an overlay to an underlay subnet, and its Pods (and the fixed-IP picker) still use the overlay range.

Related articles: "Kube-OVN subnet planning: CIDR changes, overlaps, subnet type, per-namespace IPPool and an underlay global cluster on ACP".

## Root Cause

### Cause 1: the subnet is stuck in Terminating because its finalizer was never removed

Kubernetes removes a deleted object only after every entry in `metadata.finalizers` is gone. `kube-ovn-controller` did not complete its cleanup, so `kubeovn.io/kube-ovn-controller` stayed and the subnet never disappeared. `kubectl describe subnet` shows `Deletion Timestamp` set, `Finalizers: kubeovn.io/kube-ovn-controller`, and conditions `Validated` and `Ready` still `True`.

### Cause 2: namespace binding decides which subnet a Pod uses

Once namespaces are listed on `ovn-default`, its addresses (other than reserved IPs) are allocated only to Pods of those namespaces, so Pods elsewhere cannot get an address from it. Keep `ovn-default` unbound and give business workloads their own subnets; assigning a business subnet to the project when it is created is the way to keep business workloads off `ovn-default`.

In the other direction, a namespace that was never bound to its intended subnet keeps getting addresses from the default subnet: `kubectl describe ns` shows `ovn.kubernetes.io/logical_switch: ovn-default` and the `ovn-default` CIDR in `ovn.kubernetes.io/cidr`, and restarts of Pods with addresses from the intended subnet fail with `AddressOutOfRange`.

### Cause 3: ovn-default was deleted and is stuck in deleting

Someone tried to delete `ovn-default` (and another subnet), and the deletion never completed. A half-deleted default subnet breaks the cluster: every `ars` is abnormal, containers cannot resolve the private registry domain, and the MetalLB pages report that MetalLB is not installed. Without an etcd backup, rolling back is not possible. Stopping `kube-ovn-controller`, removing the finalizer so the deletion completes, and starting the controller again brings `ovn-default` back as the default subnet with its original CIDR; other deleted subnets do not come back. Leftover interfaces from a previously tested CNI (for example `cilium_host@cilium_net`) on a node are a separate cleanup.

### Cause 4: v6 ip address can not contain upper case, so the subnet fails validation

A namespace was assigned to an underlay dual-stack subnet, but restarted Pods still received overlay addresses and the Pod events were clean. The `kube-ovn-controller` log shows:

```text
subnet <subnet> U2O interconnection ip <ipv4>,<ipv6-with-uppercase> v6 ip address can not contain upper case
failed to validate subnet <subnet>
```

and the Subnet has a `Warning` event `ValidateLogicalSwitchFailed`. The subnet failed validation and was not usable, so the namespace kept using the overlay subnet.

## Resolution

### Cause 1: the subnet is stuck in Terminating because its finalizer was never removed

Remove the finalizers of a subnet that is really meant to be deleted, after its Pods and IP objects are gone.

> **Warning:** Removing finalizers skips the controller's cleanup and is irreversible: the object is deleted as soon as the list is empty. Keep the YAML so the subnet can be recreated if needed.

```bash
kubectl get subnet <subnet> -o yaml > /root/subnet-<subnet>.before.yaml
kubectl get subnet <subnet> -o jsonpath='{.metadata.deletionTimestamp}{"\n"}{.metadata.finalizers}{"\n"}'
kubectl get ip | grep <subnet> || true
kubectl patch subnet <subnet> --type=merge -p '{"metadata":{"finalizers":null}}'
```

### Cause 2: namespace binding decides which subnet a Pod uses

Leave `ovn-default` unbound. Bind each business namespace to its own subnet; add a namespace that is missing from its intended subnet.

> **Warning:** Changing `spec.namespaces` changes where new Pods of those namespaces get addresses; running Pods keep theirs until recreated. Save the subnet first; restoring `spec.namespaces` is the rollback.

```bash
kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,NAMESPACES:.spec.namespaces'
kubectl describe ns <namespace> | grep ovn.kubernetes.io
kubectl get subnet <business-subnet> -o yaml > /root/subnet-<business-subnet>.before.yaml
kubectl patch subnet <business-subnet> --type=json -p='[{"op":"add","path":"/spec/namespaces/-","value":"<namespace>"}]'
```

If `spec.namespaces` does not exist yet, use a merge patch that sets the whole list.

### Cause 3: ovn-default was deleted and is stuck in deleting

Only when `ovn-default` itself has a `deletionTimestamp` and there is no etcd backup to roll back to: let the deletion complete while `kube-ovn-controller` is stopped, then start the controller so it recreates the default subnet.

> **Warning:** While `kube-ovn-controller` is at `0` replicas, no Pod in the cluster gets an address. Removing the finalizers is irreversible. Work in a maintenance window from a session that does not depend on Pod networking, and save the Subnet YAML and the replica count. If the subnet does not come back, recreate it from the saved YAML after removing `status`, `metadata.uid`, `metadata.resourceVersion`, `metadata.deletionTimestamp` and `metadata.finalizers`.

```bash
kubectl get subnet ovn-default -o yaml > /root/subnet-ovn-default.before.yaml
kubectl -n kube-system get deploy kube-ovn-controller -o jsonpath='{.spec.replicas}{"\n"}'
kubectl -n kube-system scale deploy kube-ovn-controller --replicas=0
kubectl patch subnet ovn-default --type=merge -p '{"metadata":{"finalizers":null}}'
kubectl get subnet ovn-default -w
kubectl -n kube-system scale deploy kube-ovn-controller --replicas=<recorded-replicas>
kubectl get subnet ovn-default -o jsonpath='{.spec.cidrBlock} {.spec.default}{"\n"}'
```

Stop the watch when the subnet is gone. Treat other subnets stuck in deleting the same way only if they are meant to be deleted. Check nodes for leftovers of other CNIs: `ip -br link | grep -i cilium`.

### Cause 4: v6 ip address can not contain upper case, so the subnet fails validation

Rewrite the IPv6 address the controller rejects in lowercase on the Subnet, then recreate the Pods that received overlay addresses.

> **Warning:** Editing the Subnet affects allocation for every bound namespace. Change only the letter case of the address named in the log. Save the Subnet first; restoring it is the rollback.

```bash
kubectl -n kube-system logs deploy/kube-ovn-controller --tail=2000 | grep -E 'can not contain upper case|failed to validate subnet'
kubectl get subnet <subnet> -o yaml > /root/subnet-<subnet>.before-lowercase.yaml
kubectl edit subnet <subnet>
kubectl -n <namespace> delete pod <pod-with-overlay-address>
```

In a mixed overlay and underlay deployment where an overlay subnet's IPv6 address also contains uppercase letters, leave that one unchanged as long as Kube-OVN reports no errors and it works, because changing it involves Service CIDR changes.

## Diagnostic Steps

```bash
kubectl get subnet
kubectl get subnet <subnet> -o jsonpath='{.metadata.deletionTimestamp}{"\n"}{.metadata.finalizers}{"\n"}'
kubectl get ns <namespace> -o yaml | grep -i ovn
kubectl get events -A --field-selector reason=ValidateLogicalSwitchFailed
```

- A subnet with a `deletionTimestamp` and `kubeovn.io/kube-ovn-controller` in `finalizers`: Cause 1 (Cause 3 if it is `ovn-default`, together with broken MetalLB pages and registry resolution).
- `AddressOutOfRange` on restart with the namespace annotation still `ovn.kubernetes.io/logical_switch: ovn-default` and the namespace absent from the intended subnet, or Pods elsewhere failing after namespaces were bound to `ovn-default`: Cause 2.
- `can not contain upper case` or `ValidateLogicalSwitchFailed`: Cause 4.
