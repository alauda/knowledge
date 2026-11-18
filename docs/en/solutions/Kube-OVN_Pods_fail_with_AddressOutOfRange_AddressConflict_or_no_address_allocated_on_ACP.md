---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# Kube-OVN Pods fail with AddressOutOfRange, AddressConflict or no address allocated on ACP

## Issue

On a Kube-OVN cluster, a Pod stays in `ContainerCreating` or comes up with the wrong address. Typical reports:

- The Pod event is `AcquireAddressFailed` with `AddressOutOfRange`, or a pinned address flaps `AddressConflict` after a fast delete.
- Pods in some namespaces fail while other namespaces work, with `request ip return 500 no address allocated to pod <namespace>/<pod> provider ovn, please see kube-ovn-controller logs to find errors`.
- `arping` from a Pod gets a reply from an external host, or an external host on the underlay VLAN stops answering while a Pod holds the same address.
- In the console's fixed-IP dropdown, the subnet's `.2` address is offered although it is the u2o interconnection address.
- On ACP 3.18.2 the console does not allow adding a second IPv4 CIDR to an existing Subnet.
- The question is whether the fixed IP field takes a range such as `<start-ip>..<end-ip>`.

Restarting `ovs-ovn` fixes none of these.

Related articles: "Calico Pods get no address: disabled default IPPool, Raven fixed IP mismatch, reserved IPs or deleted raven on ACP"; "Multus secondary networks: unexpected end of JSON input, duplicated addresses or several addresses on one NIC on ACP"; "Kube-OVN fixed IP rejected or no address allocated because a stale IP object or logical switch port holds it on ACP".

## Root Cause

### Cause 1: on ACP 3.18.2, Subnet spec.cidrBlock holds one IPv4 CIDR

A single-stack Subnet stores one CIDR in `spec.cidrBlock`; a dual-stack Subnet stores one IPv4 and one IPv6 CIDR. The console can edit that value but cannot append another IPv4 block. Editing the original CIDR in place strands the Pods that already use it. Likewise, `spec.protocol` cannot be changed after creation, so a Subnet created as `IPv4` cannot serve a workload that asks for an IPv6 address.

### Cause 2: AddressOutOfRange in an underlay fixed-IP Deployment

Two problems appear together:

- The Subnet's NIC binding is wrong, so allocation is refused until the VLAN or ProviderNetwork points at the right interface.
- The number of pinned addresses equals `spec.replicas` while `strategy.type` is `RollingUpdate`. The new Pod asks for an address the old Pod has not released, and `kube-ovn-controller` still holds the old IP object.

The same race makes a pinned address on a Deployment flap `AddressConflict` after a fast delete, because the ReplicaSet starts the replacement immediately. A StatefulSet waits until the previous ordinal is gone.

### Cause 3: an external device or a previous platform still uses addresses in the underlay CIDR

Dynamic allocation hands out any address of the underlay CIDR that is not listed in `spec.excludeIps`. When an external host, the gateway, or an old platform sharing the VLAN uses such an address, a Pod can be given it: `arping` from the Pod gets a reply from the external host, ICMP to that host stops returning, and OVN logs `MAC_Binding` conflicts for one `logical_port` and IP, sometimes with `OVNSB commit failed`. An address that is "usually free" is not free.

### Cause 4: the u2o interconnection address is offered as a free static IP

With `u2oInterconnection` enabled, the subnet's second address (`.2`) is by default the u2o interconnection address. Kube-OVN creates a `u2o-interconnection.<vpc>.<subnet>` IP object only when the u2o address cannot use `.2` (for example because `.2` is in `excludeIps`); when `.2` is used, there is no IP object for it, which is expected. The defect is that the console then offers `.2` as a free fixed IP, and a workload pinned to it collides with the interconnection hop. It is fixed in versions after 4.2.3.

### Cause 5: failed to patch resource ... spec.initContainers[n].lifecycle: Forbidden

Pods in a few namespaces fail with `FailedCreatePodSandBox ... plugin type="kube-ovn" failed (add): RPC failed; request ip return 500 no address allocated to pod <namespace>/<pod> provider ovn`, and `kube-ovn-controller` may also re-elect its leader. The controller log shows its annotation patch (`ovn.kubernetes.io/allocated`, `ovn.kubernetes.io/ip_address`, `ovn.kubernetes.io/logical_switch` and related keys) rejected:

```text
failed to patch resource <pod> with json merge patch ... Pod "<pod>" is invalid: [spec.initContainers[1].lifecycle: Forbidden: may not be set for init containers without restartPolicy=Always, spec.initContainers[1].readinessProbe: Forbidden: ..., spec: Forbidden: pod updates may not change fields other than ...]
```

The diff in the message shows `RestartPolicy: &"Always"` changed to `nil` on the Istio native sidecar init container. The affected namespaces ran workloads into which a monitoring operator (`datakit-operator`) injected annotations alongside the Istio sidecar. The spec submitted with the annotation patch had `restartPolicy` cleared from the sidecar init container, so the API server rejected the update and no IP annotation was written. How the injector altered the spec was not determined. Restarting the injecting operator restored allocation.

### Cause 6: the fixed IP field does not accept a range

The fixed IP field accepts individual addresses only. Several addresses can be configured, one entry each; range notation is not accepted. This is a product limitation.

## Resolution

### Cause 1: on ACP 3.18.2, Subnet spec.cidrBlock holds one IPv4 CIDR

Leave the existing `cidrBlock` unchanged. Create a second Subnet for the new prefix, bind the same namespaces with `spec.namespaces` (or set `ovn.kubernetes.io/logical_switch` on the workloads that should move), and migrate by recreating those Pods. Use the same create-and-migrate path for a protocol mismatch.

> **Warning:** Recreating a Pod moves it to the new Subnet and drops its connections. Keep the old Subnet until every migrated workload is Ready.

```bash
kubectl get subnet <existing-subnet> -o yaml > /root/subnet.before.yaml
kubectl apply -f - <<'EOF'
apiVersion: kubeovn.io/v1
kind: Subnet
metadata:
  name: <new-subnet>
spec:
  protocol: IPv4
  cidrBlock: 203.0.113.0/24
  gateway: 203.0.113.1
  excludeIps:
    - 203.0.113.1
  namespaces:
    - <project-namespace>
EOF
```

Replace the documentation prefix with the real one. On releases newer than 3.18.2, check whether multiple IPv4 CIDRs are accepted before assuming this limit.

### Cause 2: AddressOutOfRange in an underlay fixed-IP Deployment

1. Fix the NIC binding of the underlay Subnet first if it is wrong.
2. Switch the Deployment to `strategy.type: Recreate`, or pin more addresses than `replicas` so a rolling surge has a free one. For a workload that must keep stable addresses across deletes, use a StatefulSet.
3. If an IP object is still owned by a deleted Pod, delete it only after the old Pod is gone and no running Pod uses the address.

> **Warning:** `Recreate` stops every replica before starting new ones. Deleting an IP object frees the address for anyone; if a live Pod still uses it, you create a duplicate. Save the IP object first. Setting `RollingUpdate` back is the rollback, and brings the race back if the pin list is still as long as `replicas`.

```bash
kubectl get pod <pod> -n <namespace> -o jsonpath='{.metadata.annotations.ovn\.kubernetes\.io/ip_address}{"\n"}'
kubectl get ip -o wide | grep <address>
kubectl get ip <ip-object> -o yaml > /root/ip-object.before.yaml
kubectl delete ip <stale-ip-object>
kubectl patch deploy <deploy> -n <namespace> --type=merge -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
```

### Cause 3: an external device or a previous platform still uses addresses in the underlay CIDR

Add the external hosts, the gateway, and every address still used by a previous platform or planned for another purpose to `spec.excludeIps`, then delete the Pods that hold a conflicting address so they are allocated again outside the list.

> **Warning:** Deleting the Pods restarts them and, if they are not pinned, gives them new addresses. `excludeIps` does not take back an address that is already allocated; the Pod delete does. Save the Subnet and restore `excludeIps` if you excluded too much.

```bash
kubectl get subnet <underlay-subnet> -o yaml > /root/subnet.before.yaml
kubectl patch subnet <underlay-subnet> --type=json -p='[{"op":"add","path":"/spec/excludeIps/-","value":"198.51.100.12"}]'
kubectl delete pod <pod-holding-conflicting-address> -n <namespace>
```

Repeat the patch for each address. If `excludeIps` does not exist yet, create the array with a merge patch instead of `add` on `/-`.

### Cause 4: the u2o interconnection address is offered as a free static IP

Add the u2o address and the gateway to `excludeIps` so the console cannot offer them. No Pod restart is needed; the exclusion applies to the next allocation. Upgrading past 4.2.3 removes the need for this workaround.

```bash
kubectl get subnets.kubeovn.io <underlay-subnet> -o jsonpath='{.status.u2oInterconnectionIP}{"\n"}{.spec.excludeIps}{"\n"}'
kubectl patch subnet <underlay-subnet> --type=json -p='[{"op":"add","path":"/spec/excludeIps/-","value":"<u2o-address>"}]'
```

### Cause 5: failed to patch resource ... spec.initContainers[n].lifecycle: Forbidden

Find the operator that injects into the affected namespaces, restart it, and recreate the failed Pods. Compare a failing Pod with one from a working namespace: look for the injector's annotations and for `restartPolicy: Always` on the sidecar init container.

> **Warning:** While the injecting operator restarts, Pods created in that window miss its injection. Recreating the failed Pods restarts those workloads. Only when the controller log shows the init-container `Forbidden` rejection.

```bash
kubectl -n kube-system logs deploy/kube-ovn-controller --tail=2000 | grep -A3 'failed to patch resource'
kubectl -n <namespace> get pod <pod> -o yaml | grep -n -A3 -E 'initContainers|restartPolicy'
kubectl get deploy -A | grep -i datakit
kubectl -n <operator-namespace> rollout restart deploy/<injecting-operator>
kubectl -n <namespace> delete pod <failed-pod>
```

### Cause 6: the fixed IP field does not accept a range

Enter each address of the range as a separate entry, then check the addresses the workload actually carries:

```bash
kubectl -n <namespace> get deploy <deploy> -o jsonpath='{.spec.template.metadata.annotations}{"\n"}'
kubectl -n <namespace> get pod -o wide
```

## Diagnostic Steps

```bash
kubectl describe pod <pod> -n <namespace>
kubectl get subnet <subnet> -o yaml
kubectl get ip -o wide
kubectl -n kube-system logs deploy/kube-ovn-controller --tail=500 | grep -E 'AddressOutOfRange|AddressConflict|has been assigned to|failed to patch'
```

- `AddressOutOfRange`: the requested address is outside `cidrBlock`, or the NIC binding made the Subnet unusable, or the pin list is as long as `replicas` (Cause 2). A missing second CIDR on 3.18.2 is Cause 1.
- `AddressConflict`: an IP object or a live owner already has the address (Cause 2). If no running Pod holds it, see "Kube-OVN fixed IP rejected or no address allocated because a stale IP object or logical switch port holds it on ACP".
- An external host answering for a Pod address, or `MAC_Binding` conflicts: Cause 3.
- `.2` offered as a fixed IP while `status.u2oInterconnectionIP` is `.2`: Cause 4.
- `failed to patch resource` with init-container `Forbidden` text: Cause 5.
