---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x
  - 4.x
---

# Node unstable from a GPU NVRM log flood, a faulty memory module, or a read-only cpuset cgroup on ACP

## Issue

Typical reports:

- A node is abnormal, services cannot be deployed to it, and `journalctl -u kubelet` prints nothing. The node is `NotReady` with `PLEG is not healthy`, and a reboot does not fix it.
- A memory fault on a node caused a service disruption.
- The business network on one worker (for example an ARM node) is unreachable although the switch configuration is fine, and the kube-ovn Pods fail with `/sys/fs/cgroup/cpuset/kubepods.slice/kubepods-burstable.slice: no such file or directory`.

These are faults in the GPU, memory, or OS configuration of the host. Kubernetes only shows their effect; each cause gives the host-side signature that identifies it. Disk I/O errors and a hanging root filesystem are covered in [Node runtime or kubelet directories return Input/output error, or df hangs, on ACP](Node_runtime_or_kubelet_directories_return_Input_output_error_or_df_hangs_on_ACP.md). A PLEG problem without a GPU log flood is covered in [Node NotReady on ACP with kubelet "PLEG is not healthy"](Node_NotReady_with_PLEG_is_not_healthy.md).

## Root Cause

### Cause 1: A GPU that failed to initialise floods the kernel log

On a GPU node, `journalctl -fu kubelet` and `journalctl -fu docker` print nothing. `systemctl status systemd-journald` shows a continuous stream of `systemd-journald[<pid>]: Missed <N> kernel messages`, with journald using several GiB of memory. `dmesg -T` is full of `NVRM` errors. The node looks like a PLEG or runtime problem:

```text
Ready False KubeletNotReady PLEG is not healthy: pleg was last seen active 38m36.485032165s ago; threshold is 3m0s
"PLEG: Write status" err="rpc error: code = DeadlineExceeded desc = operation timeout: context deadline exceeded"
```

while `MemoryPressure`, `DiskPressure`, `PIDPressure`, `KernelDeadlock`, and `NetworkUnavailable` are all `False`. The kernel messages identify the card:

```text
NVRM: gpuHandleSanityCheckRegReadError_GM107: Possible bad register read: addr: 0x110100, regvalue: 0xbadf5620, error code: Unknown SYS_PRI_ERROR_CODE
NVRM: kflcnWaitForHalt_TU102: Timeout waiting for Falcon to halt
NVRM: GSP failed to halt with GFW_BOOT: (progress 0xff)
NVRM: failed to wait for GFW boot complete: 0x65 VBIOS version <version>
NVRM: (the GPU may be in a bad state and may need to be reset)
NVRM: RmInitAdapter: Cannot initialize GSP firmware RM
NVRM: GPU <0000:BB:DD.F>: RmInitAdapter failed! (0x62:0x65:2015)
NVRM: rm_init_adapter failed, device minor number 0
```

One GPU card failed to initialise. Its very frequent `NVRM` messages overflow the kernel log buffer, journald drops the journal, runtime, and kubelet logs, and the node becomes unstable.

### Cause 2: Faulty memory module

Services on one node are disrupted at a specific moment and may recover on their own. The hardware log (BMC, iLO, iDRAC, or IaaS events) or the kernel log reports memory errors for that host. A failing memory module (DIMM) crashes or stalls whatever was using the bad memory. Taking the faulty memory offline or replacing it during a planned shutdown makes the node healthy again.

### Cause 3: `/sys/fs/cgroup/cpuset` is read-only, so kube-ovn Pods cannot start

On one node `/sys/fs/cgroup/cpuset` has become read-only, so the cpuset path for Pods cannot be used. The OVN Pods fail with:

```text
/sys/fs/cgroup/cpuset/kubepods.slice/kubepods-burstable.slice: no such file or directory
```

and the node's Pod network fails, although the physical network is fine. Why the cgroup filesystem became read-only is not known; a reboot restores it.

## Resolution

### Cause 1: A GPU that failed to initialise floods the kernel log

1. Raise the GPU errors with the hardware vendor before continuing Kubernetes-level troubleshooting.
2. Identify the faulty card from the PCI address in the `RmInitAdapter failed!` line, or with `nvidia-smi`.
3. Reset that card with a PCIe Function Level Reset, which recovers the card and the node.

> **Warning:** Resetting a GPU kills every process using it. Do it only when no workload uses the card (cordon the node and drain or stop the GPU Pods) and the PCI address is confirmed as the faulty card. The reset itself cannot be undone; if it does not recover the card, the card needs vendor service.

```bash
kubectl cordon <node-name>
nvidia-smi -q | grep -E 'Bus Id|Product Name'
# by PCI address (domain:bus:device.function, from dmesg or nvidia-smi):
echo 1 > /sys/bus/pci/devices/<0000:BB:DD.F>/reset
# or with the NVIDIA tool:
nvidia-smi --gpu-reset -i <gpu-index>
```

4. Confirm that `dmesg` stops showing new `NVRM` errors and that the journal shows kubelet and runtime logs again, then `kubectl uncordon <node-name>`.

### Cause 2: Faulty memory module

Take the faulty memory offline or replace it in a planned shutdown. Follow [Shutting down or rebooting ACP nodes for maintenance](Shutting_down_or_rebooting_ACP_nodes_for_maintenance.md): evict Pods, back up etcd if it is a control-plane node, shut down, repair, boot, and check that the platform and applications recover.

### Cause 3: `/sys/fs/cgroup/cpuset` is read-only, so kube-ovn Pods cannot start

Reboot the host; this restores write access to `/sys/fs/cgroup/cpuset/`, and the OVN components and business network recover. Ask the OS owner to check the cgroup filesystem afterwards.

> **Warning:** A reboot restarts every Pod on the node. Do it only when `/sys/fs/cgroup/cpuset` is confirmed read-only on that node and the kube-ovn Pods fail with the `kubepods-burstable.slice: no such file or directory` error. Drain the node first if it still runs workloads. A reboot cannot be undone.

```bash
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data --timeout=10m
systemctl reboot
# after boot:
mount | grep 'cgroup/cpuset'
kubectl -n kube-system get pods -o wide --field-selector spec.nodeName=<node-name> | grep -E 'kube-ovn|ovs'
kubectl uncordon <node-name>
```

The cpuset mount should show `rw`, and the kube-ovn Pods on the node should be Running.

## Diagnostic Steps

1. GPU log flood (Cause 1):

   ```bash
   kubectl describe node <node-name> | grep -E 'Ready|PLEG'
   systemctl status systemd-journald --no-pager | grep -iE 'Missed .* kernel messages|Memory'
   journalctl -u systemd-journald --since "-1h" --no-pager | grep -iE 'lost|missed|overrun'
   dmesg -T | grep -c NVRM
   dmesg -T | grep -E 'RmInitAdapter failed|rm_init_adapter failed|may need to be reset' | tail -n 10
   ```

   A large `NVRM` count together with `Missed ... kernel messages` is Cause 1. The PCI address in `RmInitAdapter failed!` is the card to reset. `PLEG is not healthy` with a clean kernel log is not this cause.

2. Memory errors (Cause 2):

   ```bash
   dmesg -T | grep -iE 'EDAC|Hardware Error|mce|memory error' | tail -n 20
   ras-mc-ctl --errors 2>/dev/null | tail -n 20
   ```

   Also check the server BMC event log or the IaaS host events for the same time. Corrected or uncorrected memory errors for that host point at Cause 2.

3. cpuset cgroup state (Cause 3):

   ```bash
   mount | grep 'cgroup/cpuset'          # "ro" in the options means read-only
   ls /sys/fs/cgroup/cpuset/kubepods.slice/ 2>&1 | head
   kubectl -n kube-system get pods -o wide --field-selector spec.nodeName=<node-name> | grep kube-ovn
   ```

   `ro` on the cpuset mount with failing kube-ovn Pods is Cause 3. A node whose kube-ovn CNI fails after a NIC rename or a clock change is covered in [kube-ovn-cni fails on one node after a NIC rename, clock skew or hostname change on ACP](kube-ovn-cni_fails_on_one_node_after_a_NIC_rename_clock_skew_or_hostname_change_on_ACP.md).
