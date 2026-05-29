---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500818
---

# KubeVirt VM Loses Bridge Network Connectivity When br_netfilter Is Loaded on the Worker

## Issue

On Alauda Container Platform (Kubernetes v1.34.5 with Ubuntu 22.04 worker nodes running Linux 5.15.0-56-generic), a KubeVirt VirtualMachine attached to a Linux Bridge secondary network through a Multus `NetworkAttachmentDefinition` experiences periodic or permanent loss of network connectivity. Ingress traffic such as ICMP reaches the worker's physical bond or interface but never appears on the VM's veth interface, and egress traffic such as ARP from the VM reaches the bridge but is not forwarded out the bridge port. The data path involved is the standard KubeVirt secondary-network shape on ACP: a `NetworkAttachmentDefinition` (`network-attachment-definitions.k8s.cni.cncf.io`, `k8s.cni.cncf.io/v1`) of CNI `type: bridge` referenced from `virtualmachineinstance.spec.networks[].multus.networkName` and bound on the VM side by `virtualmachineinstance.spec.domain.devices.interfaces[].bridge` (`InterfaceBridge connects to a given network via a linux bridge`), with KubeVirt running in namespace `kubevirt` and `virt-handler` shipped as `3rdparty/kubevirt/virt-handler:v1.7.0-alauda.2`.

## Root Cause

The trigger is the `br_netfilter` Linux kernel module becoming loaded on the worker that hosts the VM. On the Ubuntu 22.04 + Linux 5.15.0-56-generic kernel that ACP worker nodes run, loading `br_netfilter` registers three sysctls under `/proc/sys/net/bridge/` and sets each of them to 1; a privileged probe on an ACP worker shows the live values `net.bridge.bridge-nf-call-arptables = 1`, `net.bridge.bridge-nf-call-ip6tables = 1`, and `net.bridge.bridge-nf-call-iptables = 1` exactly as the module documents.

When the corresponding `bridge-nf-call-*` sysctl is 1, frames traversing a Linux bridge are pushed up to the host's `iptables`, `ip6tables`, and `arptables` chains for filtering decisions instead of being switched purely at layer 2 — the kernel's sysctl carrier through which the bridged-frame iptables hook is gated is the same `/proc/sys/net/bridge/` keyset observed live on the worker. KubeVirt does not install host-side `iptables` ALLOW rules that whitelist secondary-bridge VM traffic: `virt-handler` and `virt-launcher` (image `3rdparty/kubevirt/virt-handler:v1.7.0-alauda.2`) only wire the VM's tap into the existing Linux bridge created by the upstream `bridge` CNI delegate. With the `bridge-nf-call-*` sysctls forcing bridged frames through iptables, the VM's bridged traffic is therefore subjected to whatever the host's iptables policy decides — and on a Kubernetes cluster whose pod-network agents own their own FORWARD-chain rules, the default outcome for unrelated bridged frames is to be silently dropped.

The kernel-level coupling is what produces the symptom: a worker on which `br_netfilter` is loaded with `bridge-nf-call-*` = 1, plus a KubeVirt VM whose secondary NIC is bridged through a Linux Bridge `NetworkAttachmentDefinition` on that same worker, plus the absence of any explicit iptables ALLOW for that traffic. Ingress ICMP arriving on the physical NIC traverses the bridge, is handed to iptables, and is dropped before reaching the VM's veth/tap; egress ARP from the VM traverses the bridge port, is handed to arptables, and never leaves through the physical NIC.

## Diagnostic Steps

Confirm whether `br_netfilter` is currently loaded on the worker hosting the affected VM, and read the live values of the bridge sysctls. Open a privileged debug pod against the node and inspect kernel module state and `/proc/sys/net/bridge/` directly; on a tested ACP worker this returns `br_netfilter` loaded with the dependent `bridge` module, all three `bridge-nf-call-*` sysctls = 1, and the corresponding files under `/proc/sys/net/bridge/`:

```bash
kubectl debug node/<worker> -it=false \
  --image=registry.alauda.cn:60080/acp/container-debug:v4.3.2 \
  --profile=sysadmin -- \
  chroot /host bash -c \
    "lsmod | grep -E 'br_netfilter|bridge' ; \
     echo --- ; \
     sysctl -a 2>/dev/null | grep bridge-nf-call ; \
     echo --- ; \
     ls /proc/sys/net/bridge/"
```

The `lsmod` row reports the module's name, size, and reference count; a non-zero third column means a process inside some pod is holding the bridge subsystem and the module cannot be unloaded until that process exits. The `sysctl -a | grep bridge-nf-call` lines printing `= 1` confirm that the kernel is in the state that subjects bridged VM frames to the host's iptables chains, which is the state in which the article's silent-drop symptom occurs.

Inspect the module's reference count and holders directly to see whether anything is currently keeping it loaded. A `refcnt` of `0` and an empty `holders/` directory mean the module is loaded but unreferenced, so an unload call will succeed; a non-zero `refcnt` identifies that some kernel subsystem (typically a container runtime running inside a privileged pod) is preventing unload:

```bash
kubectl debug node/<worker> -it=false \
  --image=registry.alauda.cn:60080/acp/container-debug:v4.3.2 \
  --profile=sysadmin -- \
  chroot /host bash -c \
    "cat /sys/module/br_netfilter/refcnt ; \
     ls -la /sys/module/br_netfilter/holders/"
```

Inspect the cluster for privileged workloads that could have loaded `br_netfilter` on the affected worker. The typical pattern is a privileged pod that runs its own container daemon (for example, a self-hosted CI runner with an embedded daemon for service containers); confirm pod placement on the worker via `nodeName` and confirm pod privilege via `spec.containers[*].securityContext.privileged` before treating it as the loader:

```bash
kubectl get pods -A -o json \
  | jq -r '.items[] | select(.spec.containers[]?.securityContext.privileged==true)
      | "\(.metadata.namespace)/\(.metadata.name)\t\(.spec.nodeName)"'
```

## Resolution

Restore VM connectivity by removing the workload that loaded `br_netfilter`, unloading the module on the worker, and verifying the bridge sysctls are no longer active. Each step is per-worker, because `br_netfilter` is a per-node kernel state — repeat the procedure on every worker that hosts a KubeVirt VM with a Linux Bridge `NetworkAttachmentDefinition` attachment.

Stop the privileged workload that has the bridge subsystem held — the workload identified in Diagnostic Steps whose `nodeName` is the affected worker and whose container is privileged. The kernel unload step in the next paragraph succeeds only once the holder process exits and the module's reference count drops to 0:

```bash
kubectl delete pod -n <ns> <runner-pod>
```

Unload `br_netfilter` on the worker by calling `modprobe -r` from a privileged debug pod. The unload returns 0 only when the module's reference count is 0; if it returns `EBUSY`, return to the previous step and ensure no privileged pod on the node is still holding the bridge subsystem:

```bash
kubectl debug node/<worker> -it=false \
  --image=registry.alauda.cn:60080/acp/container-debug:v4.3.2 \
  --profile=sysadmin -- \
  chroot /host modprobe -r br_netfilter
```

Verify the `bridge-nf-call-*` sysctls are no longer = 1. After `br_netfilter` is unloaded, the same probe used in Diagnostic Steps should report the three `bridge-nf-call-*` keys as absent from `/proc/sys/net/bridge/` (or, on some configurations, present with value 0); the goal is that no key reports value 1, which is the state the kernel is in when bridged VM frames are no longer pushed up to host iptables:

```bash
kubectl debug node/<worker> -it=false \
  --image=registry.alauda.cn:60080/acp/container-debug:v4.3.2 \
  --profile=sysadmin -- \
  chroot /host bash -c \
    "sysctl -a 2>/dev/null | grep net.bridge.bridge-nf-call ; \
     ls /proc/sys/net/bridge/ 2>&1"
```

Once the sysctls are no longer = 1, the KubeVirt VM's Linux Bridge attachment regains connectivity through the same upstream data path (`NetworkAttachmentDefinition` → `bridge` CNI delegate → host Linux bridge → bridge port → VM tap/veth bound via `virtualmachineinstance.spec.domain.devices.interfaces[].bridge`) that the article describes — none of the platform-level binding changes, only the kernel-level filtering toggle does.
