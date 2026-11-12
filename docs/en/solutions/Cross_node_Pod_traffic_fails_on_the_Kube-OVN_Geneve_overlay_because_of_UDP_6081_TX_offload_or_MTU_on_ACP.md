---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.10.x
  - 3.16.x
  - 4.0.x
  - 4.3.x
---

# Cross-node Pod traffic fails on the Kube-OVN Geneve overlay because of UDP 6081, TX offload or MTU on ACP

## Issue

Pods on one node cannot reach Pods on other nodes, while the hosts can reach each other and Services sometimes still answer. Typical reports:

- Pod IP and Service access fail on and off from a few nodes, with no clear pattern.
- A new node joins, and its Pods (or CoreDNS on it) cannot reach the API server Service. `kube-ovn-pinger` on the new node logs `failed to parse config` and times out against the API.
- NodePort access through a second node is unstable, and a capture of Geneve traffic shows `IP/TCP Checksum Bad`.
- Pods fail only on physical machines while VM nodes are fine.
- After the node operating system was upgraded (for example to Kylin), some Pods fail to start because they cannot resolve or connect to Service names.
- Engineers ask how to see and change the Kube-OVN MTU and why the standard value is `1400`.
- After an MTU change, operations become slow; after the change is rolled back, containers still cannot reach external Redis or MySQL, or `ovn0` stays at `1350` instead of returning to `1400`.

All of these involve the overlay path between nodes: Geneve on UDP `6081`, the offload settings of the encapsulation NIC, and the MTU.

## Root Cause

### Cause 1: the new node receives no Geneve traffic on UDP 6081

Kube-OVN carries Pod traffic between nodes in Geneve tunnels on UDP `6081`. When a firewall, security group or switch ACL blocks that port, `tcpdump` on the new node shows no UDP `6081` from the existing nodes, the tunnel never comes up, the new node's OVN components stay abnormal, and `kube-ovn-pinger` logs `failed to parse config` because it cannot reach the API through the overlay.

### Cause 2: tx-checksum-ip-generic is on and Geneve packets are damaged

With checksum offload on, the kernel leaves the checksum of encapsulated packets for the NIC to fill in. When `ethtool -k <encap-iface>` shows `tx-checksum-ip-generic: on` (not `off [fixed]`) and the NIC fills it in wrongly, cross-node encapsulated traffic fails or the encapsulation NIC counts checksum errors, while tiny pings still pass. In extreme cases the offload also makes connection tracking drop connections, which shows up as loss and retransmissions.

Situations fixed by turning this offload off:

- Pod IPs and Services intermittently unreachable from only some nodes.
- NodePort access unstable when a node forwards to another node.
- Pods in a new cluster unable to reach the `kubernetes` Service or any node while node-to-node traffic works.
- On a global cluster, `kubectl` on two of three masters unable to reach the API server, Harbor (sharing the global ALB VIP) unreachable, `console-portal` returning `500`, and `apollo` logging `Get router manager error {"error": "cluster not found"}` and `net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)`. All OVN Pods were `Running`, and restarting OVN and platform components did not help.

Two cautions:

- A flag that is already `off [fixed]` rules this cause out (look at Cause 1), and a flag that is `on` while the `genev_sys_6081` counters do not move is an idle tunnel interface, not a checksum fault.
- `IP/TCP Checksum Bad` on inner packets in a capture on the sending node is not proof of corruption by itself: with the offload on, `tcpdump` sees the packet before the NIC fills in the checksum. Only a capture on the receiving side is evidence.

### Cause 3: transmit offload on a physical or Kylin node rewrites encapsulated packets

On some physical NICs and on Kylin and other domestic operating systems, a NIC validation defect is incompatible with OVN encapsulation and modifies transmitted packets. UDP `6081` can already be open, and the node still cannot use the Pod network. Turning all transmit offload off (`ethtool -K <nic> tx off`) recovers it. This is broader than Cause 2, which turns off only `tx-checksum-ip-generic`.

Situations fixed this way:

- On ACP 4.3.2 ARM, Pods on a new physical machine cannot complete cross-node requests, while the masters are virtual machines. In a cluster mixing VMs and physical machines, Pods fail only on the physical machines.
- On a new Kylin node, Pods cannot reach Pods on other nodes while Services still work. A capture shows Geneve-encapsulated ICMP requests and replies between nodes with no kernel drops. `ethtool -K <bond> tx off` on the cluster bond fixes it.
- On a new node, `cert-manager-cainjector`, `kube-ovn-pinger`, `sentry` and other Pods are `CrashLoopBackOff`, and `coredns` is `Running` but `0/1`, logging `plugin/kubernetes: waiting for Kubernetes API before starting server`, `plugin/ready: Plugins not ready: "kubernetes"` and `starting server with unsynced Kubernetes API`. From the node, the API server Service on `443` answers; from inside the `coredns` network namespace it hangs. `ethtool -k <nic>` shows `tx-checksumming: on`.
- On a new workload cluster of arm64 physical machines with bonded NICs, every `kube-ovn-pinger` Pod is `CrashLoopBackOff` with `failed to get self pod ... context deadline exceeded`. The physical NICs under the bond compute wrong checksums for Geneve packets; `tx off` is needed on every slave NIC of the bond, and the permanent fix is a NIC firmware update. The step-by-step procedure is in [kube-ovn-pinger CrashLoopBackOff context deadline exceeded on bonded NICs due to Geneve TX checksum offload on ACP](kube-ovn-pinger_CrashLoopBackOff_context_deadline_exceeded_on_bonded_NICs_due_to_Geneve_TX_checksum_offload_on_ACP.md).
- After the node OS was upgraded to Kylin, some Pods fail to start because they cannot resolve or connect to Service names. With older kernels and some domestic NICs, checksum offload makes the NIC compute wrong checksums, and the receiving NIC drops the packets as invalid. There are two fixes: upgrade the kernel to `4.19.90-25.16.v2101` or later, or turn checksum offload off with `ethtool -K <nic> tx off`.

### Cause 4: which MTU Kube-OVN uses, and why the standard value is 1400

By default Kube-OVN reads the MTU of the host NIC and sets the Pod and OVS interface MTU from it, reduced in overlay networks by the encapsulation overhead:

| Encapsulation | Pod MTU |
|---|---|
| Geneve over IPv4 | physical MTU - 100 |
| Geneve over IPv6 | physical MTU - 120 |
| VXLAN over IPv4 | physical MTU - 50 |
| VXLAN over IPv6 | physical MTU - 70 |

The standard value of `1400` is the usual `1500` physical MTU minus `100` bytes for Geneve, which avoids fragmentation. Underlay Pods are not encapsulated, so their MTU follows the physical NIC (`1500` on a `1500` NIC). On ACP 4.x the Kube-OVN MTU can be customized, globally for overlay networks or per subnet, with the product procedure **Networking > How To > Kube-OVN > Configure MTU**. ACP 3.16 has no supported way to change the default OVN MTU.

### Cause 5: after an MTU change is rolled back, ovn0 and some Pod interfaces keep the old MTU

When the OVN MTU is changed (for example from `1400` to `1350`) and then rolled back, Pods created while the MTU was `1350` keep `1350` on their interfaces. In OVS an internal port such as `ovn0` cannot have a larger MTU than the other interfaces attached to the same bridge, so those Pods also hold `ovn0` at `1350`. Workloads on those Pods can fail to connect to external databases such as Redis or MySQL. This is default behavior: once every Pod with the old MTU is restarted, all interfaces become `1400` and `ovn0` and the other internal ports follow.

## Resolution

### Cause 1: the new node receives no Geneve traffic on UDP 6081

1. Open UDP `6081` from every existing node's encapsulation address to the new node, and the reverse path. Check the host firewall and any security group or switch ACL between the nodes. Restrict the source to the node CIDR.

   > **Warning:** The rule opens the Geneve port on the node. Limit the source to the cluster node prefix, apply it in a maintenance window, and keep console access. To roll back, delete the same rule (`iptables -D INPUT ...`). A network ACL outside the host has to be rolled back on that device.

   ```bash
   iptables -I INPUT -p udp -s <node-cidr> --dport 6081 -j ACCEPT
   iptables -I OUTPUT -p udp -d <node-cidr> --dport 6081 -j ACCEPT
   ip6tables -I INPUT -p udp -s <node-ipv6-cidr> --dport 6081 -j ACCEPT
   ```

2. Persist the rule with the mechanism the node already uses (`iptables-save`, `firewall-cmd --permanent --add-rich-rule`, or the cloud security group).
3. After packets show up in `tcpdump`, delete the unready `kube-ovn-cni` and `kube-ovn-pinger` Pods on that node only, so they rebuild the tunnel.

### Cause 2: tx-checksum-ip-generic is on and Geneve packets are damaged

1. Disable the generic IP checksum offload on the encapsulation NIC. Skip this when the driver already reports `off [fixed]` or when error counters are not increasing.

   > **Warning:** Disabling offload raises CPU use on that NIC and can lower throughput. Apply it to the encapsulation interface only, in a maintenance window. To roll back, run `ethtool -K <encap-iface> tx-checksum-ip-generic on` if the driver allows it.

   ```bash
   ethtool -K <encap-iface> tx-checksum-ip-generic off
   ethtool -k <encap-iface> | grep tx-checksum-ip-generic
   ```

2. The setting does not survive a reboot. To keep it, add a udev rule (replace `<encap-iface>` in both places), reboot in a window, and confirm the flag afterwards.

   > **Warning:** A udev rule runs on every add event for that interface. A wrong interface name turns offload off on another NIC or does nothing. To roll back, delete the rule file and reload udev.

   ```bash
   cat > /etc/udev/rules.d/99-ovn-fix-checksum.rules <<'RULE'
   ACTION=="add", SUBSYSTEM=="net", KERNEL=="<encap-iface>", RUN+="/sbin/ethtool -K <encap-iface> tx-checksum-ip-generic off"
   RULE
   udevadm control --reload-rules && udevadm trigger
   ethtool -k <encap-iface> | grep tx-checksum-ip-generic
   ```

### Cause 3: transmit offload on a physical or Kylin node rewrites encapsulated packets

1. Only when cross-node Pod traffic fails on a physical node, a newly added Kylin node, or a node whose OS has the NIC validation defect, and UDP `6081` is open (otherwise it is Cause 1), turn transmit offload off on the encapsulation NIC.

   > **Warning:** `tx off` disables transmit offload on that NIC, raises CPU use and can lower throughput. Apply it to the encapsulation NIC only, in a maintenance window. To roll back, run `ethtool -K <nic> tx on` if the driver accepts it. A healthy VM node does not need this.

   ```bash
   ethtool -k <nic> | grep -E '^tx|tx-checksum|tx-udp'
   ethtool -K <nic> tx off
   ethtool -k <nic> | grep -E 'tx-checksumming|tcp-segmentation-offload'
   ```

   Expected after the change: `tx-checksumming: off`, `tx-checksum-ip-generic: off`, `tcp-segmentation-offload: off`.

2. On a bond, apply `tx off` to the bond and to every slave NIC (`cat /proc/net/bonding/<bond>` lists them). To keep the setting on nodes that use network-scripts files, add it to each NIC's file (keep a copy first; to roll back, restore it):

   ```bash
   cp -a /etc/sysconfig/network-scripts/ifcfg-<nic> /root/ifcfg-<nic>.before
   echo 'ETHTOOL_OPTS="-K <nic> tx off"' >> /etc/sysconfig/network-scripts/ifcfg-<nic>
   ```

3. Crash-looping Pods retry on their own once the path works; `kubectl -n kube-system delete pod -l app=kube-ovn-pinger` only skips the back-off wait. Ask the NIC vendor for a firmware update that fixes the offloaded checksum.

4. For the Kylin kernel case, the alternative to `tx off` is a kernel at `4.19.90-25.16.v2101` or later.

   > **Warning:** A kernel upgrade needs a drain and a reboot of each node. Upgrade one node at a time and keep the previous kernel in the boot menu as the rollback.

   ```bash
   uname -r
   kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
   # install the vendor kernel package and reboot the node
   kubectl uncordon <node-name>
   ```

### Cause 4: which MTU Kube-OVN uses, and why the standard value is 1400

Read the MTU in effect before changing anything. On ACP 4.x, follow the product procedure **Configure MTU**; on ACP 3.16 keep the default.

```bash
kubectl -n kube-system exec <ovs-ovn-pod> -- ovs-vsctl list interface | grep -E "name|mtu"
kubectl -n <namespace> exec <pod> -- ip link show eth0
ip link show <encap-iface>
```

`ip link show eth0` inside the Pod is the value the Pod really uses.

### Cause 5: after an MTU change is rolled back, ovn0 and some Pod interfaces keep the old MTU

1. After the MTU setting itself is back at `1400`, find the interfaces that still carry the old value. The list also prints `lo` and the physical NICs, whose MTU is legitimately different; look at the Pod veths and `ovn0`.

   ```bash
   ip -o link show | awk '{for(i=1;i<=NF;i++) if($i=="mtu") print $2, $(i+1)}' | grep -v ' 1400$'
   ip link show ovn0
   kubectl get pod -A -o wide --field-selector spec.nodeName=<node-name>
   ```

2. Restart the Pods whose `eth0` still reports the old MTU. When no Pod interface on the bridge is below `1400` any more, `ovn0` follows.

   > **Warning:** Restarting the Pods interrupts those workloads; roll them in a window, spare replicas first. Only after the MTU setting itself has been restored; otherwise the new Pods get the wrong value again.

   ```bash
   kubectl -n <namespace> exec <pod> -- ip link show eth0
   kubectl -n <namespace> rollout restart deploy/<deploy>
   ip link show ovn0
   ```

## Diagnostic Steps

Compare a failing node with a healthy one. Check that Geneve arrives, then read the offload flags on the encapsulation NIC (often a bond):

```bash
tcpdump -ni any -c 20 'udp and port 6081'
iptables -S | grep 6081 || true
ethtool -k <encap-iface> | grep -E '^tx-checksumming|tx-checksum-ip-generic|tcp-segmentation-offload'
ip -s link show genev_sys_6081
netstat -us | grep -i InCsumErrors
kubectl -n kube-system exec <ovs-ovn-pod-on-this-node> -- ovs-vsctl show | grep -C5 remote_ip
```

Test from a Pod network namespace as well as from the host. The host path working while the Pod path fails is typical for Causes 2 and 3:

```bash
crictl ps -a | grep coredns
crictl inspect <container-id> | grep -i '"pid"'
nsenter -n -t <pid> -- timeout 5 bash -c '</dev/tcp/<kubernetes-service-ip>/443' && echo open || echo blocked
timeout 5 bash -c '</dev/tcp/<kubernetes-service-ip>/443' && echo open || echo blocked
kubectl -n <namespace> exec <pod> -- curl -k -m 5 https://<kubernetes-service-ip>:443/healthz
```

- No UDP `6081` from the other nodes is Cause 1.
- `tx-checksum-ip-generic: on` with failing cross-node traffic or climbing errors is Cause 2.
- A physical or newly added Kylin node that works only after `tx off`, Pods that cannot resolve Service names after an OS upgrade to Kylin, or bonded physical NICs where API clients crash-loop with `context deadline exceeded` to the `kubernetes` Service, is Cause 3. `InCsumErrors` increasing while the Pods fail supports it. Rule out a node firewall first: if the node itself cannot reach the API server on `6443`, the problem is in the host network, not in the overlay.
- Interfaces still at an old MTU after a rollback, with `ovn0` below `1400`, are Cause 5.
