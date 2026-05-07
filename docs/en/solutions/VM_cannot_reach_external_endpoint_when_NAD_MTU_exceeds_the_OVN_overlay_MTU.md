---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM cannot reach external endpoint when NAD MTU exceeds the OVN overlay MTU
## Issue

A VM running on the cluster's virtualization stack cannot reach an external endpoint when its primary network attaches over the cluster's overlay (Geneve-based) CNI through a `NetworkAttachmentDefinition`. The shape of the failure is:

- ICMP `ping <external-ip>` succeeds. The IP is reachable.
- TCP / TLS / HTTP from the same VM to the same endpoint hangs and eventually times out at the application layer.
- A `tcpdump` on the VM interface shows the TCP three-way handshake completes, the TLS Client Hello goes out, and after that the same data segment is retransmitted repeatedly with no ACK from the peer.

In other words: small packets get through, large ones do not.

## Root Cause

The VM has its NAD configured with an MTU equal to the underlying physical NIC's MTU (commonly 1500). When the NAD is a Linux-bridge attachment (`type: bridge`, no encapsulation), that is correct — the path is `VM → tap → br0 → physical NIC → network`, no headers are added, a 1500-byte IP packet stays 1500 bytes.

When the NAD attaches over the cluster's overlay CNI (the equivalent of `type: ovn-k8s-cni-overlay` — i.e. the path runs through OVS / OVN with **Geneve encapsulation**), the path becomes `VM → tap → OVS (br-int) → OVN bridge → br-ex → NIC`. Each frame the VM emits is wrapped in a Geneve tunnel before it leaves the host. The Geneve header costs roughly 50–58 bytes of overhead per packet (Ethernet + IP + UDP + Geneve, plus optional options). The overlay's effective MTU therefore has to be **at least ~58 bytes smaller** than the underlay MTU; the conventional default is 1400 against an underlay of 1500.

If the NAD advertises 1500 to the VM, the guest kernel computes a TCP MSS of 1460 and starts sending 1500-byte frames. Those frames overflow the overlay encapsulation budget. ICMP ping with the default 56-byte payload still fits — that is why ping appears to "work" — but the moment the application starts pushing real data the segments are too large, they get dropped at the encapsulation hop, and the TCP stack on both sides hangs in retransmits.

In a `tcpdump` capture, the typical signature is:

```text
1  SYN          90B    OK
2  SYN, ACK     90B    OK
3  ACK          90B    OK
4  Client Hello 607B   OK   (still fits)
5  ACK          90B    OK
… application pushes a full segment …
6  TCP segment  1448B  retransmit, retransmit, retransmit, no ACK
```

Anything below the threshold is fine; everything at or above it is dropped silently.

## Resolution

Set the NAD MTU equal to or smaller than the cluster's overlay MTU. Two ways to discover what the overlay's MTU actually is:

### 1. Read the overlay MTU

The cluster CNI publishes its overlay MTU on the controller-side configuration (the field name varies by CNI; `mtu` on the cluster network operator / `kube-ovn` configuration is conventional):

```bash
# kube-ovn-style:
kubectl get cm -n kube-system kube-ovn-controller -o jsonpath='{.data}' | grep -i mtu
# or read it from the join interface on a node:
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
  -- ip -d link show ovn0
```

A typical value is 1400 against an underlay of 1500.

### 2. Set the NAD MTU to that value (or lower)

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: vm-overlay-net
  namespace: <ns>
spec:
  config: |
    {
      "cniVersion": "0.4.0",
      "name": "vm-overlay-net",
      "type": "<your-overlay-cni-type>",
      "mtu": 1400,
      ...
    }
```

Re-apply the NAD, then re-create the affected VM(s) (or hot-detach/re-attach the secondary interface) so the new MTU is propagated into the guest. Inside the guest, confirm:

```text
ip a                                           # MTU 1400 on the VM NIC
```

After the change, the guest's TCP MSS clamps to `1400 - 40 = 1360` and the previously-dropped large segments fit cleanly inside Geneve.

### Alternative — raise the underlay so the overlay can stay 1500

If applications cannot tolerate a 1400-byte path MTU (legacy protocol, third-party load balancer that does not honour ICMP fragmentation needed), raise the **underlying physical-interface MTU** to ≥ 1558 cluster-wide and bump the overlay MTU to 1500. This is a node-by-node operation that must be coordinated across every node in the cluster and across the upstream switches; it is not a per-NAD change. Until the underlay supports the larger frame, the overlay must stay below it.

### Linux bridge attachments are unaffected

If the NAD is a `type: bridge` attachment with no overlay (the VM goes directly out the physical NIC), the 1500 MTU is correct and this issue does not arise. The fix above only applies to overlay-encapsulated NADs.

## Diagnostic Steps

1. Localise the failure to the MTU class. Inside the VM, run a packet-size sweep with the *don't fragment* bit set (`-M do` on Linux ping). The smallest size that fails is one byte above the path's effective MTU:

   ```bash
   for s in 1000 1300 1400 1470 1580 1680 2080; do
     echo "size $s"
     ping -M do -c 2 -W 6 -s $s <external-ip>
   done
   ```

   Sizes up to ~1372 (= 1400 − 28) will succeed; sizes above that will fail with "frag needed but DF set" or simply silent drops. That is the smoking gun.

2. Capture the TCP retransmit pattern on the VM interface to confirm the application-level hang is the same MTU class (large segments retransmitted, no ACK):

   ```text
   tcpdump -nnni any -w mtu.pcap host <external-ip>
   ```

   In the capture, look for repeated 1448-byte segments without the corresponding ACK from the peer.

3. Confirm the NAD's MTU and the overlay's MTU on the cluster are consistent. The expected relationship is `NAD MTU ≤ overlay MTU ≤ underlay MTU − Geneve overhead`:

   ```bash
   kubectl get net-attach-def -n <ns> <nad> -o yaml | grep -i mtu
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- ip -d link show ovn0
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- ip -d link show <physical-iface>
   ```

4. After the fix, re-run the packet-size sweep from step 1. Every size up to the new NAD MTU should pass; the application-level connection should complete its TLS handshake and start moving real data within seconds.
