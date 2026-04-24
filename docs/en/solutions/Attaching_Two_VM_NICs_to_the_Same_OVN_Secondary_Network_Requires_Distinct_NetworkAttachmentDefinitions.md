---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A KubeVirt `VirtualMachine` declares two NICs intended to connect to the same OVN-backed secondary network — for example, a VM with a primary data NIC and a redundant management NIC on the same L2 segment. The shape that feels natural is to reference the same `NetworkAttachmentDefinition` (NAD) twice:

```yaml
spec:
  template:
    spec:
      networks:
        - name: net-0
          multus:
            networkName: default/ovn-l2-network   # <== same NAD
        - name: net-1
          multus:
            networkName: default/ovn-l2-network   # <== same NAD
      domain:
        devices:
          interfaces:
            - name: net-0
              bridge: {}
            - name: net-1
              bridge: {}
```

The VM starts but one (or both) of the interfaces fails to attach. `virt-launcher` logs report that the OVN-K8s CNI cannot reconcile a second attachment to the same logical switch, and the second NIC ends up with no IP or stays in a degraded state. The cluster appears fine — pods using the same NAD singly work — but the dual-attach pattern from a single VM does not.

## Root Cause

OVN's secondary-network CNI (`ovn-k8s-cni-overlay`) binds the NAD reference to a per-pod logical switch port allocation keyed on the NAD's fully qualified name. When the same pod (a `virt-launcher` pod is one pod, regardless of how many VM NICs it fronts) requests two ports against the same NAD, the CNI cannot allocate two distinct logical-switch ports under one NAD reference — the binding is one-to-one by NAD, not one-per-interface.

The supported pattern for "two NICs on the same L2 segment" is two NADs with **distinct `metadata.name`** values but identical `spec.config` targeting the same OVN logical switch. From OVN's perspective each NAD is a different attachment identifier and each gets its own port allocation; from the VM's perspective each NIC appears on the same network because the underlying OVN configuration (topology, VLAN ID, logical-switch name) is the same across both NADs.

## Resolution

Create a second NAD in the same namespace that mirrors the first NAD's `spec.config` but has a different `metadata.name`. Then change the VM's second network reference to point at the new NAD name.

### Define two NADs with identical config and distinct names

```yaml
# First NAD — already exists on the cluster, unchanged.
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: ovn-l2-network
  namespace: default
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name":       "vlan1044",
      "type":       "ovn-k8s-cni-overlay",
      "netAttachDefName": "default/ovn-l2-network",
      "topology":   "localnet",
      "vlanID":     1044,
      "ipam":       {}
    }
---
# Second NAD — same topology, same VLAN, same CNI, different name.
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: ovn-l2-network-02
  namespace: default
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name":       "vlan1044",
      "type":       "ovn-k8s-cni-overlay",
      "netAttachDefName": "default/ovn-l2-network-02",
      "topology":   "localnet",
      "vlanID":     1044,
      "ipam":       {}
    }
```

Two fields in the inner `spec.config` JSON matter for the distinctness:

- The outer `metadata.name` must be unique within the namespace — that is what Multus indexes by.
- The `netAttachDefName` field inside `spec.config` must reflect the NAD it lives in (`<namespace>/<name>`). If left pointing at the first NAD, OVN treats both as the same attachment and the allocation conflict returns.

Everything else — `topology`, `vlanID`, `type`, `name` — should be identical so both NICs land on the same L2 network.

### Update the VM to reference the two distinct NADs

```yaml
spec:
  template:
    spec:
      networks:
        - name: net-0
          multus:
            networkName: default/ovn-l2-network       # unchanged
        - name: net-1
          multus:
            networkName: default/ovn-l2-network-02    # new NAD name
      domain:
        devices:
          interfaces:
            - name: net-0
              bridge: {}
            - name: net-1
              bridge: {}
```

Restart the VM so `virt-launcher` creates a new pod with two separate OVN-K8s NIC attachments:

```bash
kubectl -n <ns> delete vmi <vm-name>   # the VM will recreate the VMI
kubectl -n <ns> get vmi <vm-name> -w
```

Once the VMI is `Running`, both NICs should have IPv4/IPv6 addresses from the segment's IPAM (or from the VM's own DHCP client, depending on `ipam: {}` vs an explicit plugin). Inside the guest OS both NICs participate in the same broadcast domain and can resolve each other.

### If more than two NICs on the same network are needed

Extend the pattern: one NAD per NIC, all with the same `spec.config` except for `metadata.name` and `netAttachDefName`. Keep the naming scheme predictable (`ovn-l2-network`, `ovn-l2-network-02`, `ovn-l2-network-03`, …) so the VM spec is obvious on inspection.

### What does not work

- Referencing the same NAD twice in `spec.networks`. OVN-K8s CNI rejects the second attachment.
- Duplicating the `spec.config` on the same NAD `metadata.name`. NADs are singletons by name; the second `kubectl apply` just updates the existing object.
- Using `name` (inside `spec.config`) to differentiate. That field is a CNI-level identifier and does not separate the NAD-level attachment.

## Diagnostic Steps

Inspect `virt-launcher` for the specific failure mode when the NADs collide:

```bash
kubectl -n <ns> get pod -l kubevirt.io/domain=<vm-name> -o name
kubectl -n <ns> logs <virt-launcher-pod> \
  | grep -E 'ovn-k8s|Multus|NetworkAttachmentDefinition'
```

Typical signatures:

- `failed to allocate logical switch port …` — the CNI could not allocate a port against the NAD the second request names.
- `multus: […] Error running pod: network attachment: conflict` — Multus rejected the request before it reached the CNI.

Confirm the two NADs are distinct at the API level before re-running the VM:

```bash
kubectl get networkattachmentdefinition -n <ns> -o \
  custom-columns='NAME:.metadata.name,CONFIG_NAME:.spec.config' \
  | head -40
```

Both rows should have the same inner `"name"` field inside `spec.config` (so they land on the same L2 network) but different outer `metadata.name` values.

Inspect the running VMI's effective network status to confirm each NIC has been reconciled on its own port:

```bash
kubectl -n <ns> get vmi <vm-name> -o jsonpath='{.status.interfaces}' | jq
```

Two entries should appear, each with its own MAC / IP and a `name` that matches the VM spec. If one entry is missing, the second NAD either did not apply cleanly or the VM spec is still pointing both NICs at the first NAD — re-check.

Finally, from inside the guest OS, verify the two NICs are on the same L2 and can reach each other via ARP:

```bash
# inside the guest
ip -br addr show                          # both NICs have IPs on the same subnet
ping -c3 -I <nic1-name> <nic2-ip>          # second NIC answers on the same L2
```

If the NICs see each other at Layer 2 but traffic does not cross beyond the node, inspect the OVN logical-switch configuration to confirm both ports are bound to the same chassis; that is an OVN-level issue separate from the NAD duplication this note addresses.
