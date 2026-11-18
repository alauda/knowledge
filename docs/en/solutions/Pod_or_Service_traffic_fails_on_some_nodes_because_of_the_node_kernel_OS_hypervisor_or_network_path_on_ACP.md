---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# Pod or Service traffic fails on some nodes because of the node kernel, OS, hypervisor or network path on ACP

## Issue

The report names the network plugin (Kube-OVN or Calico), but the CNI Pods are healthy or recover by themselves. Typical descriptions:

- An Istio sidecar fails its startup probe because DNS lookups of `istiod` time out: `lookup istiod.istio-system.svc on <dns>:53: read udp <pod-ip>:<port>-><dns>:53: i/o timeout`.
- A load test fails a few times a day with `Internal Server Error` while no Pod restarts, and log collection drops to zero for a few seconds.
- One Pod of a Deployment cannot reach a ClusterIP (`curl -v` stays at `Trying <cluster-ip>:<port>...`) while its sibling can.
- Kube-OVN components alert and restart together while the cluster looks fine, or the whole business cluster misbehaves for hours.
- Pods fail with `FailedCreatePodSandBox ... failed to reserve sandbox name`, and the kernel log repeats `unregister_netdevice: waiting for lo to become free`.
- A platform component cannot connect to a Service even though a test from inside the container works.
- Pods on one node cannot reach the apiserver Service while the host can, or newly added nodes behind an ALB return `504`.

Each cause below lies in the node operating system, the kernel, the virtualization layer or the physical network, not in the CNI configuration.

Related articles: "calico-node fails to start or Pods hang in ContainerCreating: dummy module, corrupted image, clock skew or x509 on ACP".

## Root Cause

### Cause 1: Kylin V10 kernel nf_conntrack defect drops NAT replies

Kylin V10 kernels older than `4.19.90-52.33.v2207.ky10` have a connection-tracking defect, confirmed by the OS vendor, that breaks reverse NAT translation. Replies that need reverse NAT, such as DNS replies and Service traffic, are dropped by the kernel. It has appeared on `4.19.90-52.22.v2207.ky10.x86_64` and `4.19.90-24.4.v2101.ky10.aarch64`, in three forms:

- Intermittent Istio sidecar startup failures for some microservices, with `istiod` lookups timing out and `citadelclient failed to sign CSR` and `sds failed to warm certificate` following. `nslookup` of the same name from another container on the node works. Restarting OVS on the node clears it only temporarily.
- Under heavy load, readiness probes fail for a moment and Pods are removed from the Service Endpoints, so the external load balancer has no backend. No Pod restarts.
- One Pod cannot reach a ClusterIP while a sibling can, with DNS, routes, NetworkPolicy, Endpoints and the OVN load balancer all correct. Restarting the Pod helps temporarily; after the kernel upgrade it stayed normal.

### Cause 2: the node intermittently loses the apiserver VIP

The node log shows lease renewals failing with `dial tcp <vip>:6443: connect: no route to host`. The VIP and its backends are healthy; the node itself cannot reach the VIP, goes `NotReady`, and the OVN components on it restart as a consequence. Continuous ping probes from nodes to the VIP show rounds of heavy or total packet loss and RTT spikes of seconds, aligned with `NodeNotReady` events. Uneven traffic graphs and gaps in node monitoring are side effects. The fault is in the underlying network between the nodes and the VIP.

### Cause 3: unregister_netdevice: waiting for lo to become free

A kernel network-namespace leak keeps the loopback device of old Pod sandboxes busy, so those sandboxes are never torn down. On the affected nodes:

- Platform Pods show `FailedCreatePodSandBox: ... context deadline exceeded`, then repeat `failed to reserve sandbox name "<pod>_<namespace>_<uid>_0": name ... is reserved for "<sandbox-id>"`.
- Fixed-IP workloads fail with `AcquireAddressFailed` / `NoAvailableAddress`, and `kube-ovn-controller` logs `static address <ip> has been assigned to <namespace>/<old-pod>`, because the old Pods holding the fixed IPs cannot be removed.
- `dmesg` keeps printing `unregister_netdevice: waiting for lo to become free. Usage count = <n>`.

The OS vendor (Kylin) confirmed it as a known kernel issue. Restarting `ovn-controller` does not help; nodes without the message are unaffected.

### Cause 4: the VM source/destination check is enabled on the virtualization platform

The hypervisor drops traffic whose source or destination is a Pod address when the source/destination check (anti-spoofing) is enabled on the node VMs. A platform component that needs a Service fails to start while a test from inside its container succeeds, and cleaning the node or restarting kubelet and the container runtime does not help.

### Cause 5: one node uses a different iptables backend or has leftover legacy rules

- A node whose iptables runs in nf_tables mode (for example TencentOS `3.1`, kernel `5.4`, iptables `1.8.5`) joined a cluster whose other nodes use legacy mode (TencentOS `2.4`, kernel `4.19`, iptables `1.4.21`). nf_tables and legacy rule tables are separate, so the rules written by Calico and kube-proxy do not apply to that node's traffic: its host reaches the apiserver Service, every Pod on it times out, and the Calico Pods on it fail to start. Flushing iptables and restarting `calico-node` and `kube-proxy` does not help. Node admission does not check OS or iptables consistency.
- On TencentOS `3.1` with the ACP `3.12` Calico, after an upgrade one Pod (for example `calico-kube-controllers`) cannot be reached from its own node: `ip r get <pod-ip>` returns `local ... dev lo`. Leftover `iptables-legacy` rules that this `calico-node` version does not clean up are the cause; later versions clean them up.
- Newly added TencentOS Server 3 nodes could not carry Calico container traffic at all (ALB `504`, NodePort, Pod IP and Service access to their Pods all failing) while `tunl0` and `cali*` routes looked normal. The mechanism was not determined; replacing them with nodes on the OS version the rest of the cluster runs restored service.

## Resolution

### Cause 1: Kylin V10 kernel nf_conntrack defect drops NAT replies

Upgrade the kernel on all nodes to `4.19.90-52.33.v2207.ky10` or later; the recommended stable version is `kernel-4.19.90-52.44.v2207.ky10`. Until then, restarting OVS on an affected node (deleting its `ovs-ovn` Pod) is a temporary mitigation. Collect `/var/log/kube-ovn` and `/var/log/openvswitch` from the node before restarting if the cause is not yet confirmed.

> **Warning:** A kernel upgrade needs a reboot. Drain each node first, upgrade one node at a time, and keep the previous kernel in the boot menu as the rollback. Deleting the `ovs-ovn` Pod interrupts Pod traffic on that node until the new Pod is Ready.

```bash
uname -r
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
# install the vendor kernel package, reboot the node, then:
kubectl uncordon <node-name>
kubectl -n kube-system delete pod <ovs-ovn-pod-on-this-node>
```

### Cause 2: the node intermittently loses the apiserver VIP

Hand the path between the nodes and the VIP to the network or IaaS team with evidence. Run a continuous probe from several nodes and keep it until the next alert:

```bash
journalctl -u kubelet --since '-2h' | grep -E 'no route to host|lease' | tail
mkdir -p /var/log/network_check
while true; do ping -c 50 -i 0.2 -q <vip> | tail -2 | sed "s/^/$(date '+%F %T') /"; done >> /var/log/network_check/vip_ping.log
```

Stop the loop with `Ctrl-C`. Rounds with non-zero loss, matched against `kubectl get events -A --field-selector reason=NodeNotReady`, are the evidence. See also "Node NotReady caused by network, storage or host-level faults on ACP".

### Cause 3: unregister_netdevice: waiting for lo to become free

Upgrade the kernel to the vendor version that fixes the leak, only on nodes where the `waiting for lo` message repeats.

> **Warning:** The kernel upgrade needs a drain and a reboot of each node. Keep the old kernel as the boot fallback.

```bash
dmesg -T | grep 'waiting for lo to become free' | tail -3
uname -r
```

### Cause 4: the VM source/destination check is enabled on the virtualization platform

Disable the source/destination check for every VM that is a cluster node, on the virtualization platform, then retry the component. No cluster change is needed.

### Cause 5: one node uses a different iptables backend or has leftover legacy rules

Keep the same OS version, kernel and iptables backend on all nodes of a cluster; replace or reinstall the odd node to match the others.

For the TencentOS `3.1` variant on ACP `3.12`, flush the leftover legacy rules from inside the `calico-node` Pod on that node. Upgrading `calico-node` to a version that cleans them up is the permanent fix.

> **Warning:** The flush removes every rule in the `iptables-legacy` filter, raw, mangle and nat tables of the host. Felix rewrites its own rules, but other software on the node that relies on legacy rules loses them. Only when the node matches this variant and `iptables-legacy-save` shows rules. Save them first; restoring the file brings the fault back.

```bash
kubectl -n kube-system exec <calico-node-pod-on-this-node> -c calico-node -- iptables-legacy-save > /root/iptables-legacy.before
kubectl -n kube-system exec <calico-node-pod-on-this-node> -c calico-node -- sh -c 'iptables-legacy -F; iptables-legacy -F -t raw; iptables-legacy -F -t mangle; iptables-legacy -F -t nat'
curl -m 5 <pod-ip>:<port>
```

When new nodes on a different OS version cannot carry Pod traffic and no cause is found, replace them with nodes on the OS version the rest of the cluster runs.

## Diagnostic Steps

Before changing the CNI, check whether the fault follows a node property:

```bash
kubectl get nodes -o wide
uname -r; grep -E '^(NAME|VERSION)=' /etc/os-release
dmesg -T | grep -E 'nf_conntrack|waiting for lo' | tail
journalctl -u kubelet --since '-1h' | grep -E 'no route to host|timeout' | tail
iptables --version
iptables-legacy-save 2>/dev/null | wc -l
iptables-nft-save 2>/dev/null | wc -l
```

- A Kylin V10 kernel older than `4.19.90-52.33` with DNS timeouts to `istiod`, Endpoint flaps under load, or one Pod that cannot reach a correct ClusterIP: Cause 1.
- `no route to host` toward the VIP in the kubelet log, with `NodeNotReady` events: Cause 2.
- `waiting for lo to become free` together with `failed to reserve sandbox name`: Cause 3.
- Pod traffic failing only on VMs whose source/destination check is on: Cause 4.
- `iptables v1.8.x (nf_tables)` on the failing node and `(legacy)` on the others, or a TencentOS `3.1` node whose `calico-node` still sees `iptables-legacy` rules: Cause 5.

For Pods that cannot reach the apiserver Service because a host `FORWARD` rule or firewall drops cross-node traffic, see "Cross-node traffic fails in the host network path: default route, firewall, lost tunnel packets or iptables on ACP".
