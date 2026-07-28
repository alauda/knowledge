---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Trunking Multiple Tagged VLANs to a VM NIC over a Single Bridge
## Issue

A virtual machine — typically a virtual appliance such as a load balancer or firewall — must terminate **multiple** tagged VLANs on a single NIC, the way a physical appliance plugged into a tagged trunk port would. The default Bridge CNI `NetworkAttachmentDefinition` (NAD) only attaches the VM NIC to one VLAN at a time: setting `vlan: 120` carries that one tag, and the VM cannot see frames tagged for other VLANs.

Splitting the appliance across several NICs (one per VLAN) is operationally awkward — many virtual appliances assume a single trunked interface and configure their own subinterfaces internally — so a NAD that passes through *several* tags on one NIC is required.

## Root Cause

The Bridge CNI plugin in the Multus stack supports a less-publicised option, `vlanTrunk`, that maps directly to the same concept on a Linux bridge: instead of stamping one VLAN ID onto the veth port and stripping the tag, the bridge admits a **list** of VLAN IDs and passes the frames through with their tags intact. The VM kernel then handles each VLAN with a normal subinterface (`ip link add link eth0 name eth0.120 type vlan id 120`).

The option is documented as available but historically without a complete worked example, so most NADs are built without it and teams discover the limitation only after deploying the appliance.

## Resolution

ACP delivers KubeVirt VM workloads through the `virtualization` capability area, including the `network` sub-area that defines secondary networks via Multus NADs. Build the trunk in two layers — node-level bridge first (managed by the platform's declarative node configuration), then a NAD that selects multiple VLANs:

### Step 1 — Declare the host bridge once, on every relevant worker

The bridge must already exist on each worker that will host the VM. The declarative way is an NMState NodeNetworkConfigurationPolicy (NNCP), which the platform reconciles on every matching node:

```yaml
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: br0-eno33np0
spec:
  nodeSelector:
    node-role.kubernetes.io/worker: ""
  desiredState:
    interfaces:
      - name: br0
        description: "br0 on eno33np0"
        type: linux-bridge
        bridge:
          options:
            stp:
              enabled: false
          port:
            - name: eno33np0
        state: up
        ipv4:
          enabled: false
```

Notes:

- Disable STP on the in-host bridge — the upstream switch already runs spanning tree and the in-host bridge should not participate.
- Leave IPv4 disabled on `br0` itself; the bridge is a transparent L2 trunk, addresses live on subinterfaces inside the VMs.
- The same NNCP can list multiple ports if the bridge needs LACP/bond inputs.

### Step 2 — Author the trunking NAD

The NAD lives in the **same namespace** as the VirtualMachine. A NAD in another namespace is not visible to the VM, even cluster-wide ones — Multus deliberately scopes the lookup.

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: br0-trunk
  namespace: your-vm-namespace
spec:
  config: |
    {
      "cniVersion": "0.4.0",
      "type": "bridge",
      "name": "br0-trunk",
      "bridge": "br0",
      "vlanTrunk": [
        {"id": 120},
        {"id": 130},
        {"id": 140}
      ],
      "ipam": null
    }
```

Important fields:

- `bridge` matches the in-host bridge name from step 1 exactly.
- `vlanTrunk` is a list of objects; each entry is a single VLAN. Use ranges by listing each ID — the plugin does not parse `120-140`.
- `ipam` is null because the VM (not Multus) owns L3 on each VLAN — the appliance configures `eth0.120`, `eth0.130`, etc. and assigns IPs there.
- Do **not** also set `vlan: <id>`; that is the single-VLAN path and conflicts with `vlanTrunk`.

### Step 3 — Attach the NAD to the VM

In the VirtualMachine spec, reference the NAD as a secondary network and bind one NIC to it:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: appliance-1
  namespace: your-vm-namespace
spec:
  template:
    spec:
      domain:
        devices:
          interfaces:
            - name: trunk0
              bridge: {}
              model: virtio
      networks:
        - name: trunk0
          multus:
            networkName: br0-trunk
```

### Step 4 — Configure subinterfaces inside the guest

Inside the VM, the trunked NIC appears as a single device (e.g. `eth1`). Bring up one subinterface per VLAN ID listed in the NAD; only the IDs in `vlanTrunk` will receive frames:

```bash
# Inside the VM
ip link add link eth1 name eth1.120 type vlan id 120
ip link add link eth1 name eth1.130 type vlan id 130
ip link add link eth1 name eth1.140 type vlan id 140
ip link set eth1.120 up
ip addr add 10.120.0.10/24 dev eth1.120
```

For F5 BIG-IP, Cisco ASA, or similar appliances the same configuration is done through the appliance's own VLAN-on-trunk dialog — they internally create the equivalent subinterfaces.

## Diagnostic Steps

Confirm the NAD is parsable and present in the VM's namespace:

```bash
kubectl -n your-vm-namespace get net-attach-def br0-trunk -o yaml \
  | yq '.spec.config' | jq .
```

The output must show `vlanTrunk` with the list of IDs. A YAML/JSON typo in the inline `spec.config` is the most common failure — Multus rejects the attachment silently and the VM ends up with the trunk NIC missing.

Inspect the launcher pod that backs the VM and verify the secondary interface exists with the right MAC:

```bash
POD=$(kubectl -n your-vm-namespace get pod -l vm.kubevirt.io/name=appliance-1 \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n your-vm-namespace exec "$POD" -c compute -- ip -d link show
```

The annotation `k8s.v1.cni.cncf.io/network-status` on the same pod lists every attached secondary network — the trunk NAD must appear there.

On the host, verify the bridge admits the right VLANs on the veth port that connects the launcher:

```bash
HOST_NODE=$(kubectl -n your-vm-namespace get pod "$POD" -o jsonpath='{.spec.nodeName}')
kubectl debug node/$HOST_NODE -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host bridge vlan show dev br0
```

Each veth that backs a VM with the trunk NAD should list IDs 120, 130, 140 (no `PVID`, no `Egress Untagged` flags). If only one VLAN shows up, the NAD is using the single-VLAN `vlan` field instead of `vlanTrunk`.

If frames at a specific VLAN do not arrive in the VM, packet-capture on the host bridge first to isolate whether the upstream switch is delivering the tagged frames at all:

```bash
kubectl debug node/$HOST_NODE -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host tcpdump -nn -i eno33np0 vlan 120 -c 50
```

If the host sees the frames but the VM does not, the NAD is the culprit; if the host does not see them either, the upstream port is not configured as a trunk for that VLAN.
