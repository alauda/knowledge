---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A VM needs a fixed IP address on a user-defined network — typically because downstream systems (firewalls, application allow-lists, monitoring tools, databases with hostname pinning) reference the VM by IP and cannot tolerate a dynamically-assigned value. Configuring the static IP inside the guest OS after the VM is created does not work: the network plumbing at the pod / VM level rejects unknown source IPs, so the VM loses connectivity the moment its guest OS applies the manual address.

The correct approach is to declare the static IP at **VM creation time**, through the networking CRs the platform exposes, so the cluster's IPAM allocates the requested address and the VM's networking layer (virt-launcher, ovn-controller, whichever CNI is in play) plumbs the path consistently.

## Resolution

ACP Virtualization runs KubeVirt on top of Kube-OVN. Kube-OVN provides the IPAM primitives the VM needs; static IP assignment goes through the `Subnet` / `IP` CRs it exposes, consumed by the VM's pod spec.

### Path 1 — pod-level annotation on the VM spec

The most direct path is to set Kube-OVN's IP-request annotation on the VM's pod template. Kube-OVN reads the annotation during pod scheduling and reserves the requested IP from the `Subnet`'s pool before the pod starts:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: app-fixed-ip
  namespace: my-vms
spec:
  template:
    metadata:
      annotations:
        # Request a specific IP from the subnet the VM's network lives in.
        # Kube-OVN reserves this IP at pod creation; the VM's interface
        # receives it from DHCP / ARP on the guest side.
        ovn.kubernetes.io/ip_address: 192.168.50.42
        ovn.kubernetes.io/logical_switch: tenant-subnet
    spec:
      # ... rest of the VM spec (domain, devices, volumes) ...
      networks:
        - name: default
          pod: {}
      domain:
        devices:
          interfaces:
            - name: default
              bridge: {}
```

Constraints:

- The requested IP must be inside the `Subnet`'s `cidr` and not already reserved to another pod / VM.
- The `Subnet` must allow static IP requests (the `Subnet.spec.allowSubnets` and `.gateway` fields should be consistent with the value requested).
- Migration-capable VMs inherit their IP across live migrations — the same IP is honoured on the destination node.

Apply and the VM comes up on the requested IP:

```bash
kubectl apply -f vm-fixed-ip.yaml
kubectl -n my-vms get vmi app-fixed-ip -o jsonpath='{.status.interfaces[0].ipAddress}{"\n"}'
# 192.168.50.42
```

### Path 2 — per-VM `IP` CR for durable reservations

When the reservation needs to survive VM recreation (e.g. as part of a disaster-recovery runbook that rebuilds VMs from templates), create a standalone `IP` CR that holds the reservation independently of any single VM:

```yaml
apiVersion: kubeovn.io/v1
kind: IP
metadata:
  name: app-fixed-ip-reservation
spec:
  subnet: tenant-subnet
  podName: app-fixed-ip                # binds to a specific pod name
  namespace: my-vms
  v4IpAddress: 192.168.50.42
```

The reservation holds regardless of whether the VM's pod currently exists. When the VM is recreated with the matching pod name, Kube-OVN assigns the reserved IP.

### Path 3 — integrate with an external IPAM system

For environments that centralise IP assignment through a corporate IPAM (Infoblox, phpIPAM, SolidServer, etc.), stand up a small integration service that:

1. Receives a request for a VM's IP from the cluster (a ValidatingAdmissionWebhook on VM creation, or a controller reconciling a custom CR).
2. Asks the IPAM for the next available IP in the target network.
3. Writes the returned IP into the VM's pod-template annotation (Path 1) or into an `IP` CR (Path 2) before the pod is scheduled.

The integration stays out of the data path — once the annotation is in place, Kube-OVN handles the rest — but it ensures that the cluster and the corporate IPAM stay in sync on IP ownership. Without the integration, it is easy for someone to assign an IP in the cluster that the IPAM then hands out to a VM outside the cluster, causing a duplicate-IP conflict.

### What does not work

- **Configuring the static IP inside the guest only.** The guest can set any IP it wants, but the cluster's network layer only allows traffic that matches the IP Kube-OVN allocated. A guest-set IP that differs from the allocated one leads to dropped traffic (`arp reply timeouts`, connection refused, or silent packet loss).
- **Reusing an IP allocated to another pod.** Two pods cannot share an IP; Kube-OVN rejects the second request. Free the IP first (delete the other pod / release the reservation) before re-requesting.
- **Relying on in-guest DHCP to request a specific IP.** DHCP negotiation does not let the client dictate the IP — the Kube-OVN-backed DHCP server hands out what the `Subnet` allocation says, not what the guest's DHCP client requests.

## Diagnostic Steps

Confirm the VM's interface actually received the requested IP:

```bash
NS=my-vms; VM=app-fixed-ip
kubectl -n "$NS" get vmi "$VM" -o json | \
  jq '.status.interfaces[] | {name, ipAddress, ipAddresses, mac}'
```

If `ipAddress` does not match the requested value, the annotation either did not propagate to the pod template or Kube-OVN rejected the request. Inspect the pod:

```bash
kubectl -n "$NS" get pod -l kubevirt.io/domain="$VM" \
  -o jsonpath='{.items[0].metadata.annotations}{"\n"}' | jq
```

The `ovn.kubernetes.io/ip_address` annotation should be present. If missing, the VM's template did not carry it — edit the `VirtualMachine` spec to include the annotation on `spec.template.metadata.annotations`, not on the outer `metadata.annotations`.

Inspect the Kube-OVN subnet for the requested IP's reservation state:

```bash
kubectl get subnet tenant-subnet -o jsonpath='{.status.usingIPs}{"\n"}'
kubectl get ip -o custom-columns='NAME:.metadata.name,IP:.spec.v4IpAddress,POD:.spec.podName' \
  | grep 192.168.50.42
```

The row should be the VM's pod (or, if Path 2 was used, the reservation CR). If the IP is taken by an unrelated pod, free it first before re-trying.

Finally, connectivity-test from inside the guest and from outside:

```bash
# Inside the guest OS (via the VM's console or a temporary shell).
ip -4 addr show
ping -c3 192.168.50.1        # gateway should respond

# Outside, from any pod in the cluster that can reach the VM's network.
kubectl run ping-probe --image=busybox --rm -it --restart=Never -- \
  ping -c3 192.168.50.42
```

Both directions should work. If the guest reports the expected IP but outside traffic does not reach it, re-check the `Subnet`'s gateway and the route tables on the guest.
