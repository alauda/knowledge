---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM application traffic times out behind kube-ovn Geneve overlay when the secondary-network MTU exceeds 1400 on ACP

## Issue

On Alauda Container Platform (kube `v1.34.5-1`) running `acp/kube-ovn:v1.15.11` as the CNI and KubeVirt (`kubevirt-kubevirt-hyperconverged` Deployed in ns `kubevirt`), a workload inside a pod or KubeVirt VM cannot complete an application-level connection to an external endpoint even though basic `ping` of the same address succeeds. A `tcpdump` taken at the VM/pod interface shows the same TLS Server Hello / Certificate segment (`Len=1448`) being retransmitted repeatedly, eventually followed by a `[RST]`, while small ICMP echoes and ARP traffic continue to flow.

The symptom appears whenever the MTU of the interface the workload is bound to is larger than the overlay can carry — most commonly when a Multus `NetworkAttachmentDefinition` declares an `mtu` in its embedded CNI-JSON that exceeds the kube-ovn Geneve overlay MTU.

## Root Cause

ACP's overlay CNI is `kube-ovn`, configured to use Geneve encapsulation end-to-end. Both `kube-ovn-controller` and the `kube-ovn-cni` DaemonSet on every node start with `--network-type=geneve` and `--encap-checksum=true`, and pods attach via `--pod-nic-type=veth-pair` to OVS `br-int` with the Geneve tunnel egressing on `--iface=eth0`.

Geneve adds an outer L2 / IP / UDP / Geneve header to every encapsulated packet, so the maximum payload the overlay can deliver is the node's egress-interface MTU minus that overhead. On ACP this gap is a fixed 100 bytes, so on a default install with a 1500-byte node interface MTU the kube-ovn pod/VM eth0 MTU is 1400. Measured directly on this cluster, on VM-capable node `192.168.139.158` the node `eth0` carries `mtu 1500`, every kube-ovn veth host-end (`<id>_h`) on that node carries `mtu 1400`, and a default-network probe pod's own `eth0` also reports `mtu 1400`:

```text
# from a hostNetwork pod on the node
/sys/class/net/eth0/mtu                  : 1500
/sys/class/net/04eccd882d72_h/mtu        : 1400
/sys/class/net/074693ea3c2d_h/mtu        : 1400
...  (23 of 23 kube-ovn veth host-ends all 1400)
# from a default-network kube-ovn pod
/sys/class/net/eth0/mtu                  : 1400
```

If a secondary interface is then attached to a VM or pod whose MTU declares it can carry more than 1400 bytes — for example a Multus `NetworkAttachmentDefinition` whose CNI-JSON embeds `"mtu": 1500`, or a `kubeovn.io/v1` `Subnet` whose `spec.mtu` is set higher than the node interface MTU minus the Geneve overhead — full-size IP packets emitted from the guest cannot be encapsulated and are dropped at the overlay. Small ICMP echoes still fit, which is why `ping` succeeds, but full-MSS TCP segments (1448-byte payload here, derived from the MSS the SYN announced) hit the ceiling on the way out and the receiver retransmits them indefinitely until the connection times out.

The `kubeovn.io/v1` `Subnet` CRD exposes the per-subnet override directly:

```text
GROUP:      kubeovn.io
KIND:       Subnet
VERSION:    v1

FIELD: mtu <integer>
    Maximum transmission unit for the subnet.
```

On a default ACP install the field is unset on both `ovn-default` (`10.3.0.0/16`) and `join` (`100.64.0.0/16`), so the platform-derived 1400 is in effect — the value measured above is the value the data path uses, not a config choice.

When Multus is also installed on the cluster, the `network-attachment-definitions.k8s.cni.cncf.io/v1` CRD provides a second control point: its `spec.config` is a JSON-formatted CNI configuration string, and any `mtu` field embedded inside that JSON has to obey the same ceiling.

## Resolution

The overlay MTU on ACP is `node interface MTU − 100 B` for Geneve. It cannot be raised independently — the underlying node interface MTU must rise first, and then the kube-ovn subnet (and any matching NAD) can follow.

If the failing workload is on a kube-ovn subnet, lower the subnet's `spec.mtu` to a value ≤ `(node iface MTU − 100)` or leave it unset so kube-ovn derives the default:

```bash
# read the current per-subnet override (empty = platform default applies)
kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,MTU:.spec.mtu,PROVIDER:.spec.provider'

# remove an over-large override on a custom subnet
kubectl patch subnet <subnet> --type=json \
  -p='[{"op":"remove","path":"/spec/mtu"}]'
```

If the failing workload is a KubeVirt VM with a Multus secondary interface, edit the NAD's CNI-JSON `mtu` (in `spec.config`) so it does not exceed the overlay ceiling, then restart the VM (the tap-backed interface is recreated against the new NAD MTU):

```bash
# inspect the NAD's CNI JSON
kubectl get net-attach-def <name> -n <ns> -o jsonpath='{.spec.config}{"\n"}'

# patch the embedded mtu (example: 1500 -> 1400 on a 1500-byte underlay)
kubectl patch net-attach-def <name> -n <ns> --type=merge \
  -p '{"spec":{"config":"<new-cni-json-with-mtu-1400>"}}'

# restart the VM so its tap re-attaches at the new MTU
virtctl restart <vm> -n <ns>   # or: kubectl delete vmi <name>
```

If a higher overlay MTU is genuinely required, raise the underlay first (raise the node `eth0` MTU on every node, on every L2 hop, and on the upstream switch ports), then raise `Subnet.spec.mtu` on the kube-ovn subnet to the new ceiling, then raise any NAD `mtu` to match. Raising any one of those three layers without the others reproduces this exact symptom from a different direction.

## Diagnostic Steps

Confirm the platform-derived overlay MTU on a node. From a hostNetwork pod pinned to a VM-capable node, the node interface MTU and every kube-ovn veth host-end MTU can be read out of sysfs without touching the node directly. The expected pattern is node `eth0` `1500` and every `<id>_h` `1400` on a default install:

```bash
kubectl run node-mtu-probe -n default --rm -i --restart=Never --overrides='
{"spec":{"hostNetwork":true,"nodeName":"<vm-node>"}}
' --image=registry.alauda.cn:60080/acp/kube-ovn:v1.15.11 \
  -- sh -c 'cat /sys/class/net/eth0/mtu; for i in /sys/class/net/*/mtu; do echo "$i: $(cat $i)"; done'
```

Confirm the pod-side overlay MTU from inside any default-network pod (the same value the workload's eth0 will see). Expected: `1400` on a default install:

```bash
kubectl run mtu-probe -n default --rm -i --restart=Never \
  --image=registry.alauda.cn:60080/acp/kube-ovn:v1.15.11 \
  -- sh -c 'cat /sys/class/net/eth0/mtu'
```

Inside the failing pod or VM, read the interface MTU and walk the packet-size sweep with the don't-fragment bit set to find the size at which connectivity breaks:

```bash
ip a
for s in 1000 1300 1400 1470 1580 1680 2080; do
  echo "testing size $s"
  ping -M do -c 2 -W 6 -s $s <external-ip>
done
```

A sweep that succeeds up to `~1372` bytes (`1400 − 28` for the ICMP+IP header) and fails from `~1473` onward localises the break point to the kube-ovn 1400 overlay ceiling, not to the upstream network. Combined with the node-side and pod-side readings above, that is sufficient to attribute the failure to an MTU misconfiguration at one of the three layers — NAD CNI-JSON `mtu`, `Subnet.spec.mtu`, or the node interface MTU — and to point at which one to lower.

 phase2 ev10 (lab-base / global)
 phase4 ev2 (lab-base) + phase2 ev2/ev7/ev8 (global)
 phase5 ev7 (lab-base) — `--network-type=geneve`, `--encap-checksum=true`
 phase5 ev5 + ev6 (lab-base) — pod eth0 mtu 1400 / node eth0 mtu 1500
 phase5 ev6 (lab-base) — 23 veth host-ends all mtu 1400
 phase2 ev11 (mechanism) + phase5 ev5/ev6/ev7 (lab-base ceiling proved)
 phase2 ev11 (generic Geneve/TCP/PMTU behavior)
 phase2 ev11 (generic TCP retransmit capture shape)
 phase4 ev3 (lab-base) — KubeVirt Deployed
 phase4 ev3 (lab-base) — KubeVirt Deployed
 phase2 ev3 (NAD CRD on global) — note: on lab-base Multus is not installed, see phase4 ev4
 phase5 ev8 (lab-base) — `subnet.spec.mtu` CRD field
