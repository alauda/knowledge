---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A VirtualMachine running on ACP Virtualization suddenly loses network connectivity — periodically or permanently — on an interface backed by a `NetworkAttachmentDefinition` of type `bridge` (Linux bridge). Symptoms the administrator typically sees:

- Ingress traffic (e.g., ICMP ping from outside the node) reaches the physical interface on the worker but never surfaces on the VM's `veth` (visible with `tcpdump -i <phys>` but not on `tcpdump -i <vnet-X>`).
- Egress traffic from the VM reaches the Linux bridge interface on the host, but ARP requests are silently dropped and do not appear on the bridge port's upstream neighbors.
- The worker node hosting the VM shows a working L3 path to the outside world; only VM-level traffic is affected.
- A neighbouring worker in the same cluster running a similar VM works fine.

## Root Cause

The root cause is that the Linux kernel module `br_netfilter` has been loaded on the affected worker node. The module typically arrives one of two ways:

1. **A Docker-in-Docker (DinD) pod** — a privileged container that runs a `dockerd` process inside the worker's kernel namespace. The `dockerd` start-up code calls `modprobe br_netfilter` so its own bridge networking can enforce iptables rules. Common offenders: self-hosted GitHub Actions runners, GitLab runners, Kaniko-like build pods, or any CI pod that needs "docker build" semantics.
2. **A deliberate `modprobe br_netfilter`** run by a one-off debug session on the node.

When `br_netfilter` is loaded, it sets three sysctls to `1`:

```
net.bridge.bridge-nf-call-arptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables  = 1
```

With these on, the kernel routes every frame that traverses a Linux bridge through the host's `iptables` / `nftables` / `arptables` chains — including frames between a VM's tap interface and the physical uplink. The ACP Virtualization data plane expects those frames to stay in L2 and never touch the host's netfilter tables. When iptables kicks in, the default `FORWARD` chain of the host (populated by Kube-OVN, kube-proxy, and the node's own firewall) drops packets that were never meant to pass through it — hence the one-way or total drop.

The affected pods need not be on the same worker as the VM. The module is loaded globally on the kernel of whichever worker hosts the DinD pod, and all VMs on that node share the broken behaviour. Other workers are unaffected.

## Resolution

### Step 1 — confirm the module is loaded and the sysctls are on

Pick the worker node that hosts the affected VM:

```bash
NS=<vm-namespace>
VM=<vm-name>
NODE=$(kubectl -n "$NS" get vmi "$VM" -o=jsonpath='{.status.nodeName}')
echo "Node: $NODE"
```

Open a debug shell into the node:

```bash
kubectl debug node/"$NODE" --image=docker.io/library/ubuntu:22.04 -it -- chroot /host bash
```

Inside the node's chroot:

```bash
lsmod | grep br_netfilter
# Output when the module is loaded:
# br_netfilter           32768  0
# bridge                307200  1 br_netfilter

sysctl -a 2>/dev/null | grep bridge-nf-call
# Expected (module absent): no output, or all values 0
# Observed (module loaded): all three values = 1
```

If `br_netfilter` shows in `lsmod` and the three sysctls are `1`, the problem is confirmed.

### Step 2 — identify the pod that loaded the module

The module is loaded by whichever privileged pod ran `modprobe br_netfilter`. Usual suspects:

```bash
# Look for privileged pods that mention 'dind' / 'docker' / 'runner' on this node:
kubectl get pod -A -o wide --field-selector=spec.nodeName=$NODE | \
  grep -Ei 'dind|docker|runner|kaniko'
```

Inspect a candidate's container spec for `privileged: true` and for a `modprobe br_netfilter` in the entrypoint / image:

```bash
NS_CAND=<pod-namespace>
POD=<pod-name>
kubectl -n "$NS_CAND" get pod "$POD" -o=yaml | \
  yq '.spec.containers[] | {name: .name, image: .image, privileged: .securityContext.privileged}'
```

A pod running as `privileged: true` with `dockerd` or a DinD-flavoured image (`docker:dind`, `gitlab-runner-docker-machine`, self-hosted `actions-runner-controller` with DinD) is the likely culprit.

### Step 3 — remove or reconfigure the DinD workload

DinD is not supported on ACP (and on Kubernetes in general) because a container loading kernel modules at the node level affects every other workload on the same node. Preferred fixes, in order of preference:

**Option A — switch to a rootless / buildkit-based build path**

`buildkit`, `kaniko`, and `img` build OCI images without needing a privileged container or the `br_netfilter` module. For GitLab / GitHub runners, switch the runner's build stage to one of these. For ACP-native pipelines, use the cluster's built-in image-build CRD if one is provisioned (varies by cluster plugin).

**Option B — pin DinD workloads to dedicated, VM-free nodes**

If the DinD workload is required and cannot be rewritten:

1. Label a subset of workers as `role.dind=yes` and taint them `dind=yes:NoSchedule`.
2. Add a matching nodeSelector + toleration to the DinD pod.
3. Add an opposite nodeAntiAffinity to every VM in the cluster so `virt-launcher` pods never land on `role.dind=yes` nodes.

This isolates the side-effect: DinD workers carry `br_netfilter`; VM workers do not.

**Option C — evict the pod and unload the module manually (one-time relief)**

After stopping or rescheduling the offending pod, the module remains loaded until the next reboot. Unload it from the node debug shell:

```bash
modprobe -r br_netfilter
sysctl -a | grep bridge-nf-call   # expect no output or all zeros
```

This is a per-node manual step. If DinD is re-scheduled onto the same node later, the module will reload. Treat this as relief, not as the fix.

### Step 4 — verify VM connectivity

From a pod or external host, ping the VM's IP:

```bash
kubectl -n "$NS" get vmi "$VM" -o=jsonpath='{.status.interfaces[*].ipAddress}'
# Then ping the surfaced IP from a test client on the same L2.
```

Expected: ICMP replies resume. ARP requests from the VM reach the bridge's upstream interface. `tcpdump -i vnet-X` inside the virt-launcher namespace sees both directions of traffic.

### Step 5 — prevent recurrence

Document in the cluster's node-level policy:

- DinD / `modprobe br_netfilter` is forbidden on any node that schedules VMs.
- Add an admission webhook (Kyverno / Gatekeeper) that denies pods with `securityContext.privileged: true` and a container image matching known DinD image names, unless they land on a `role.dind=yes` worker.
- Add a Prometheus rule that alerts when any worker with the `role.vm=yes` label exposes `node_netfilter_bridge_nf_call_iptables == 1` — the node-exporter surfaces this sysctl.

```yaml
# Example PrometheusRule snippet:
- alert: VMWorkerBrNetfilterActive
  expr: node_sysctl{unit="net.bridge.bridge-nf-call-iptables"} == 1
        and on(instance) node_labels{label_role_vm="yes"}
  for: 5m
  labels: {severity: warning}
  annotations:
    summary: "br_netfilter active on VM worker {{ $labels.instance }}"
    description: "A privileged workload has loaded br_netfilter; VM L2 traffic will be silently dropped until the module is unloaded."
```

## Diagnostic Steps

Confirm that the issue is the module and not a broken NAD / VM interface:

```bash
# 1) VM sees the interface in its guest OS (virsh console or SSH):
ip link
ip addr

# 2) The bridge on the node has the VM's tap as a port:
kubectl debug node/"$NODE" --image=docker.io/library/ubuntu:22.04 -it -- chroot /host bash
bridge link show | grep br1   # or your bridge name

# 3) tcpdump on the phys interface vs. the tap:
tcpdump -i eno1 -nn icmp and host <vm-ip>   # upstream side
tcpdump -i vnet1 -nn icmp and host <vm-ip>  # tap side
```

A working VM shows traffic on both; a VM affected by `br_netfilter` shows traffic on the phys side only.

Correlate the timeline: when `br_netfilter` is loaded (you can find the timestamp with `dmesg -T | grep br_netfilter`), does connectivity break for the VM on that node? If the timestamps align within seconds, the diagnosis is confirmed.

Check whether the node's netfilter tables contain any rule that would drop VM traffic when bridge frames route through them:

```bash
iptables -L FORWARD -vn | head -30
```

Expect a mix of kube-proxy / Kube-OVN rules that do not anticipate bridge-forwarded VM frames — their default-drop at the end of the chain is what silently consumes the traffic.
