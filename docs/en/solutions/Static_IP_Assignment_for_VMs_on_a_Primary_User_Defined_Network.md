---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A VM attached to a **primary** user-defined network (UDN or CUDN) — i.e. the UDN replaces the default pod network as the VM's only network — often needs a predictable IP. Typical reasons: a firewall upstream whitelists by IP, an application config file hard-codes its own address, or a cluster-external monitoring system addresses the VM by a pinned value.

The standard UDN / CUDN CR (`UserDefinedNetwork`, `ClusterUserDefinedNetwork`) exposes IPAM shape (`subnet`, `excludeSubnets`) but does not offer a **per-VM static-IP** field in the CR itself. Operators who expect a "static IP" field find nothing that fits, and reach for a workaround. Two paths work today, one does not.

## What does not work

- Hand-assigning the IP inside the guest OS after boot. The cluster's SDN enforces source-IP ACL at the VM's network edge; a guest-set IP that differs from the IP the SDN allocated is dropped. The VM loses connectivity the moment the guest reconfigures its interface.
- Forcing the UDN's `ipam` to issue a specific address. The IPAM inside the UDN hands out IPs from its configured pool without a pinning hook — there is no per-VM `wantedIP` field on the UDN CR.

## What works — pod-level annotation on the VM spec

The primary UDN uses the cluster's Kube-OVN stack to plumb the VM's NIC. Kube-OVN honours a pod-level annotation that requests a specific IP from the subnet the pod lands on. The VM's pod template is the right place to set it:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: app-static
  namespace: app-ns
spec:
  template:
    metadata:
      annotations:
        # Ask Kube-OVN for a specific IP on the UDN's primary subnet.
        ovn.kubernetes.io/ip_address: 10.128.50.42
        # Optional: also request a specific MAC (useful when a
        # firewall also pins by MAC).
        ovn.kubernetes.io/mac_address: 02:00:00:AA:BB:42
    spec:
      # ... domain, devices, networks definition follows ...
```

Kube-OVN reserves the IP at pod creation and hands the VM's NIC that address. The VM's first boot under this VM object comes up with `10.128.50.42` already assigned — no in-guest re-IP step required.

Constraints:

- The IP has to lie inside the UDN's `subnet` CIDR. Check with `kubectl get userdefinednetwork` / `kubectl get clusteruserdefinednetwork`.
- The IP must not be already allocated to another pod / VM. Check with `kubectl get ip` and grep the requested value.
- The annotation must live on `spec.template.metadata.annotations` (pod template), not on the outer `metadata.annotations` of the `VirtualMachine`. The latter is the VM object's own annotations; the pod derives from the former.

Live migrations preserve the requested IP — the destination `virt-launcher` pod inherits the same annotation, and Kube-OVN re-reserves the address on the target host.

## What works — `IP` CR for durable reservations

If the reservation needs to outlive the VM (for example, the VM is periodically re-created from a template during disaster recovery), create a standalone `IP` CR in the Kube-OVN system. It binds the reservation to a specific `(namespace, pod-name)` tuple:

```yaml
apiVersion: kubeovn.io/v1
kind: IP
metadata:
  name: app-static-reservation
spec:
  subnet: <udn-subnet-name>
  podName: app-static          # binds by exact pod name
  namespace: app-ns
  v4IpAddress: 10.128.50.42
```

The reservation persists across `VirtualMachine` / `VirtualMachineInstance` recreations. When the VM is re-provisioned with the matching pod name, Kube-OVN hands it the reserved IP without any further configuration.

## Using an external IPAM to drive the allocations

For environments where IP ownership is centrally managed by a corporate IPAM (Infoblox, phpIPAM, SolidServer), keep the IPAM as the source of truth by running a small integration that:

1. Responds to VM creation events (a `ValidatingAdmissionWebhook` on the VM kind, or a custom controller watching a CRD).
2. Asks the IPAM for the next free IP in the target network.
3. Writes the returned IP into the VM's pod-template annotation (or creates a matching `IP` CR).

The VM is then created by the tenant through the normal path; the annotation is already populated by the time the pod is scheduled, and Kube-OVN honours it exactly as a manually-set annotation.

## RFE status on first-class CR support

The Request-for-Enhancement for first-class static-IP fields inside the UDN / CUDN CR is tracked by the VM networking team. The annotation-and-`IP`-CR approach above is the supported way to achieve static IPs today; the future first-class path will eventually let an IP be requested declaratively inside a VM's spec without touching the pod template.

Until that RFE lands, use the annotation path — it is durable, survives live migrations, and is the same mechanism any other Kube-OVN-backed workload uses for static IPs.

## Diagnostic Steps

Confirm the VM picked up the annotation and the IP landed:

```bash
NS=app-ns; VM=app-static
kubectl -n "$NS" get pod -l kubevirt.io/domain="$VM" \
  -o jsonpath='{.items[0].metadata.annotations}{"\n"}' | jq '."ovn.kubernetes.io/ip_address"'
kubectl -n "$NS" get vmi "$VM" -o json | \
  jq '.status.interfaces[] | {name, ipAddress, ipAddresses, mac}'
```

`ipAddress` matching the requested annotation confirms the path worked end-to-end.

If the pod exists but Kube-OVN did not honour the annotation, inspect the subnet the pod landed on:

```bash
kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,NAMESPACE:.spec.namespaces,USING:.status.usingIPs' | \
  grep -E "$NS|<udn-subnet>"
```

Verify the requested IP is within the subnet's CIDR and not already allocated:

```bash
kubectl get ip -o custom-columns='NAME:.metadata.name,IP:.spec.v4IpAddress,POD:.spec.podName,NS:.spec.namespace' \
  | grep 10.128.50.42
```

If the IP is already taken, choose a different one or release the existing reservation. If the subnet does not cover the requested IP, the request silently falls back to a dynamically-assigned IP; correct the annotation's value to something within the subnet.

After the VM has started successfully with the requested IP, run an end-to-end connectivity test from both sides — inside the guest and from an external client — to confirm the upstream firewall / allowlist is receiving traffic with the expected source IP.
