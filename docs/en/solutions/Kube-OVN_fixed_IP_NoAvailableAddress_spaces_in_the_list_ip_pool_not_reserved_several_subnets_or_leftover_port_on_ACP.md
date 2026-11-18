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

# Kube-OVN fixed IP NoAvailableAddress: spaces in the list, ip_pool not reserved, several subnets or leftover port on ACP

## Issue

A Kube-OVN workload with fixed IPs, or in a namespace bound to several subnets, cannot get an address although free addresses exist. Typical reports:

- A new fixed-IP Deployment on ACP 3.16.2 fails with `AcquireAddressFailed: NoAvailableAddress` even though the address is free.
- Addresses named in `ovn.kubernetes.io/ip_pool` are taken by other Pods before the fixed-IP workload starts.
- A restarted StatefulSet Pod gets no IP in a namespace bound to two subnets, while the other subnet has plenty of free addresses.
- After a restart, a StatefulSet Pod gets no IP and the controller log says `port already exists but in switch <other-subnet>`.
- A Pod was given an address from the subnet's reserved range, and another workload's fixed-IP Pod then failed.

Related articles: "Kube-OVN fixed IP occupied or not released: held by another Pod, node down, duplicate entry or RollingUpdate on ACP".

## Root Cause

### Cause 1: spaces in the fixed IP list

On ACP 3.16.2 with Kube-OVN 1.12.35, fixed-IP parsing is not consistent across the create and update paths. A list with spaces after the commas (`192.0.2.10, 192.0.2.11`) fails on some paths with `AcquireAddressFailed: NoAvailableAddress` and works on others. The address is inside the subnet, not in `excludeIps`, and no Pod uses it. Restarting `kube-ovn-controller`, waiting, or restarting the workload several times can clear the error temporarily.

### Cause 2: ovn.kubernetes.io/ip_pool does not reserve addresses that no Pod is using

An address listed in `ovn.kubernetes.io/ip_pool` and not currently held by a Pod is still free for dynamic allocation, so another Pod can take it first. Listing those addresses in the Subnet's `spec.excludeIps` stops dynamic allocation from using them, while the fixed-IP mechanism can still assign them.

### Cause 3: a namespace bound to several overlay subnets

A Kube-OVN overlay namespace can be bound to more than one Subnet. A Pod that does not select a Subnet may get an address from any of them; `ovn.kubernetes.io/logical_switch` selects exactly one. The CIDRs must not overlap.

On ACP 3.16.2 (Kube-OVN v1.12.35) a confirmed defect makes a restarted StatefulSet Pod fail to get an IP when all three conditions hold: the namespace is bound to two or more subnets, the Pod template does not name a subnet, and the Pod's original subnet has no free address at that moment. The Pod does not fall back to the other subnet. The event is `AcquireAddressFailed` `NoAvailableAddress`, and the controller log repeats `allocate v4 , v6 , mac for <namespace>/<pod>-0 from subnet <original-subnet>` followed by `error syncing '<namespace>/<pod>-0': NoAvailableAddress, requeuing`.

### Cause 4: port already exists but in switch <other-subnet>

A StatefulSet Pod keeps its name across restarts. In a namespace bound to several subnets, the first chosen subnet had no free address, and OVN had not removed the old Pod's logical switch port in the other subnet, so the new port with the same name was refused. The controller log shows an allocation from one subnet followed by `port already exists but in switch <other-subnet>`. This is an OVN cleanup issue and is rarely seen.

### Cause 5: a Pod received an address from the subnet's reserved range

After an image update a workload restarted and was given an address inside the reserved range of its subnet, which was another workload's fixed IP, so the fixed-IP Pod could not start. This is an IPAM defect in the Kube-OVN component of that release, fixed in ACP 3.18 and later.

## Resolution

### Cause 1: spaces in the fixed IP list

Write the list comma-separated with no blanks (`192.0.2.10,192.0.2.11`). Restart `kube-ovn-controller` only as a temporary recovery when the addresses are free and the list still contains spaces.

> **Warning:** Restarting `kube-ovn-controller` pauses address allocation in the cluster until the new Pod is Ready. It does not rewrite the annotation, so the next create can fail again while spaces remain. Save the Deployment first.

```bash
kubectl get deploy <deploy> -n <namespace> -o yaml > /root/deploy-ip.before.yaml
kubectl edit deploy <deploy> -n <namespace>
kubectl -n kube-system rollout restart deploy/kube-ovn-controller
```

### Cause 2: ovn.kubernetes.io/ip_pool does not reserve addresses that no Pod is using

Add each pool address to the Subnet's `spec.excludeIps` before dynamic Pods can take it.

> **Warning:** `excludeIps` changes which addresses dynamic Pods may receive; an address already allocated is not taken back. Save the Subnet; restoring `excludeIps` is the rollback.

```bash
kubectl get subnet <subnet> -o yaml > /root/subnet-reserve.before.yaml
kubectl patch subnet <subnet> --type=json -p='[{"op":"add","path":"/spec/excludeIps/-","value":"192.0.2.10"}]'
```

If `excludeIps` does not exist yet, create the array with a merge patch instead of `add` on `/-`.

### Cause 3: a namespace bound to several overlay subnets

Pin workloads that must stay on one prefix, and every StatefulSet, to one Subnet with `ovn.kubernetes.io/logical_switch` in the Pod template (or give them fixed IPs). If a Pod is already stuck, free addresses in its original subnet, or restart `kube-ovn-controller` as a temporary fix.

> **Warning:** Changing the StatefulSet Pod template restarts its Pods one ordinal at a time. Restarting `kube-ovn-controller` pauses allocation cluster-wide. Removing the annotation is the rollback and brings the defect back.

```bash
kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,NS:.spec.namespaces,AVAIL:.status.v4availableIPs'
kubectl patch sts <sts> -n <namespace> --type=merge -p '{"spec":{"template":{"metadata":{"annotations":{"ovn.kubernetes.io/logical_switch":"<subnet-name>"}}}}}'
```

### Cause 4: port already exists but in switch <other-subnet>

Restart the StatefulSet Pod. If the error returns, delete only the leftover logical switch port named after the Pod, then restart the Pod. Pinning the StatefulSet to one subnet (Cause 3) prevents it.

> **Warning:** `lsp-del` removes the port from the OVN northbound database; deleting a port of a running Pod cuts its network until it is recreated. Only when the Pod named in the port is not running. Record the `list` output first.

```bash
kubectl ko nbctl list logical_switch_port | grep -B5 -A5 <pod-name>
kubectl ko nbctl lsp-del <port-name-from-previous-output>
kubectl -n <namespace> delete pod <pod-name>
```

### Cause 5: a Pod received an address from the subnet's reserved range

Upgrade to ACP 3.18 or later, which contains the fix. To unblock the fixed-IP Pod before that, recreate the Pod that took the reserved address so it is allocated again; on an affected version the wrong allocation can recur. Collect the `ovs-ovn` logs from all nodes and `kubectl get pod -A -o wide` first if the allocation needs to be traced.

> **Warning:** Deleting the Pod that holds the address interrupts that workload and gives it a new address. Confirm it is not the workload that is supposed to own the address.

```bash
kubectl get subnet <subnet> -o jsonpath='{.spec.excludeIps}{"\n"}'
kubectl get pod -A -o wide | grep <reserved-address>
kubectl -n <namespace> delete pod <pod-that-took-the-reserved-address>
```

## Diagnostic Steps

```bash
kubectl describe pod <pod> -n <namespace>
kubectl get subnet <subnet> -o yaml
kubectl get ns <namespace> -o yaml | grep -i ovn
kubectl -n kube-system logs deploy/kube-ovn-controller --tail=2000 | grep -E 'NoAvailableAddress|port already exists|allocate v4'
```

- `NoAvailableAddress` with spaces in the fixed-IP list: Cause 1.
- An `ip_pool` address held by a Pod of another workload that never had it pinned: Cause 2.
- A StatefulSet in a multi-subnet namespace failing with `NoAvailableAddress` only when its original subnet is full: Cause 3.
- `port already exists but in switch`: Cause 4.
- An address inside `excludeIps` assigned to a dynamic Pod: Cause 5.
