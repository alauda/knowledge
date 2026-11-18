---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.10"
  - "3.14"
  - "3.16"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Which operating systems, kernels, and CPU architectures can run in an ACP cluster

## Issue

Before adding a node, upgrading a node kernel, or mixing node types, the following questions come up:

- Is a newer Kylin kernel (for example for a security patch) supported? A newer openEuler release? Rocky Linux 10.1? An Ubuntu HWE kernel?
- Can CentOS and Kylin nodes, or Kylin and Ubuntu nodes, share one cluster, with some nodes running only ALB?
- Can x86 and ARM nodes share one 4.x cluster? Does a Hygon C86 cluster accept x86 nodes? Can an ARM global cluster manage Intel x86 servers? Are Kunpeng 920 (aarch64) hosts supported?
- The kernel of a new node changed after a reboot and its NIC stopped working. Did the platform initialization upgrade the kernel?

Related articles: "Preparing a host before adding it to an ACP cluster: node check items, disks, init script, DefaultTasksMax, root access"; "Shutting down or rebooting ACP nodes for maintenance" covers rebooting nodes one by one for a kernel or OS upgrade.

## Root Cause

### Cause 1: only the OS releases and kernels in the version's baseline are supported

Each platform release documents its own verified OS and kernel list in the node preprocessing section of its installation documentation. A node outside that list can fail the availability check or run with components that do not work on it.

Known baselines and answers:

- **3.14.2**, on both ARM (Kunpeng 920) and x86: Kylin Linux Advanced Server V10, V10-SP1, and V10-SP2, with the official built-in kernels of those releases only. The kernel `A.B.C` must be `4.19.90`; the suffix after `-` may differ, so the full build string does not have to match a tested kernel. Tested kernels include `4.19.90-11.ky10`, `4.19.90-23.8.v2101.ky10`, and `4.19.90-24.4.v2101.ky10` on both architectures, and `4.19.90-17.ky10.aarch64` on ARM. SP1 `4.19.90-23.72` and SP2 `4.19.90-25.63` fit the rule when each is the official built-in kernel of its release. V10-SP3 is not in the 3.14 baseline, so an SP3 kernel such as `4.19.90-52.64` is not supported on 3.14.2 even though its `A.B.C` is `4.19.90`. A vendor-fixed or already-installed kernel that is not an official built-in kernel of V10, V10-SP1, or V10-SP2 (for example `4.19.90-52.22.v2207.ky10` on aarch64) is outside the tested list, and stable operation is not guaranteed.
- **3.14.1**: Kylin V10 / SP1 / SP2, Ubuntu 20.04 / 22.04, and CentOS 7.6–7.9 with a kernel from `3.10.0-1127` up to but not including 3.11. Oracle Linux 9.7 is not adapted (`kube-ovn-cni` crashes on its ipset), and Ubuntu 24.04 is not verified.
- **4.2.3** supports a broader OS and kernel list, which adds Kylin V10-SP3 and MicroOS 5.5, among others.
- **Ubuntu**: the stock kernels `5.4.0-135-generic` (Ubuntu 20.04) and `5.15.0-56-generic` (Ubuntu 22.04) are the baseline; HWE kernels such as `6.8.0-106-generic` are not supported (on 4.1.2, such a server was reinstalled with a 5.15 kernel).
- **Rocky Linux 10.1** is not on the supported OS list of ACP 4.3. The availability check shows `检查操作系统：未支持的操作系统: Rocky Linux 10.1` (OS check: unsupported operating system), `EnsurePrepareNode` passes, and the add stops at `EnsureContainerRuntime` with `FailedInit`.
- **openEuler 24.03 (LTS-SP4)** is reported as an unsupported version by the 4.x availability check.
- On ACP 4.2.1, a failure prompt shown while adding a node whose OS version is listed as supported is non-blocking; the deployment can be continued past it.

### Cause 2: mixed operating systems or CPU architectures in one cluster

- Nodes of different operating systems can share a cluster as long as every node has the same CPU architecture and an OS within the version's baseline; the platform does not require one OS for all nodes. On 3.16 and 3.10, CentOS and Kylin nodes can share a cluster. One cluster may contain both Kylin and Ubuntu nodes, and dedicating some Kylin nodes to ALB only is feasible.
- On ACP 4.x, x86 and ARM nodes in one cluster need the multi-architecture (heterogeneous) images, uploaded once from the multi-architecture product package of the matching version. The 3.x-era step of setting the label `cpaas.io/node-arch-constraint` to `""` on the cluster's `clusters.platform.tkestack.io` resource on global is no longer needed on 4.x; the label is not present by default. An x86-only installation rejects ARM nodes with `硬件架构不匹配` (hardware architecture mismatch).
- A Hygon C86 cluster supports adding x86 nodes.
- A platform whose global cluster runs on ARM, with a business cluster of ARM and C86 servers, can manage Intel x86 servers by putting them in a separately created cluster instead of adding them to the existing mixed business cluster; the x86 package is compatible for managing those servers.
- Hosts with the aarch64 instruction set on Kunpeng 920 are supported in principle; no validated configuration or version is stated for that answer, and it says nothing about mixing x86 and aarch64 in one cluster.

### Cause 3: the kernel of a new node changed after a reboot because of automatic OS updates, not the platform

The platform initialization script does not upgrade the node kernel. When a node comes up on a newer kernel after a reboot (for example `5.15.0-187` instead of `5.15.0-119` on Ubuntu) and its NIC then fails on a kernel compatibility problem, the operating system's automatic updates are the likely source: the Unattended Upgrades service installs new kernel packages, and the next reboot boots them.

## Resolution

### Cause 1: only the OS releases and kernels in the version's baseline are supported

1. Before adding a node or upgrading its kernel, read the OS and kernel on every node and compare them with the supported list of your platform version:

   ```bash
   kubectl get nodes -o custom-columns=NAME:.metadata.name,OS:.status.nodeInfo.osImage,KERNEL:.status.nodeInfo.kernelVersion
   cat /etc/os-release
   uname -r
   ```

2. On 3.14.2, an official built-in kernel of Kylin V10 / SP1 / SP2 is within the baseline when the `A.B.C` in `uname -r` is `4.19.90`. A kernel from another `A.B.C`, any SP3 kernel, or a vendor-fixed kernel outside the tested list is not.
3. For an OS that is not in the list of your version (for example Rocky Linux 10.1 on 4.3), reinstall the host with a supported OS before adding it; the add cannot be completed on it.
4. Reboot nodes one at a time for a kernel upgrade, as described in "Shutting down or rebooting ACP nodes for maintenance".

### Cause 2: mixed operating systems or CPU architectures in one cluster

1. Read the architecture of each host; `uname -m` prints `x86_64` on Hygon C86 and Intel x86 hosts and `aarch64` on Kunpeng hosts, and that value decides which product package a node needs:

   ```bash
   uname -m
   kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
   ```

2. For mixed CPU architectures on 4.x, install or upgrade from the multi-architecture product package of your version and upload its images; there is no label to change. To confirm the label is absent on an existing 4.x cluster, run on the global cluster:

   ```bash
   kubectl get clusters.platform.tkestack.io <cluster-name> -o jsonpath='{.metadata.labels}' | grep -o 'cpaas.io/node-arch-constraint[^,]*' || echo "no node-arch-constraint label"
   ```

3. For mixed operating systems, check that every node's OS and kernel are in the version's baseline (Cause 1).

### Cause 3: the kernel of a new node changed after a reboot because of automatic OS updates, not the platform

1. Confirm the source of the kernel change on the node:

   ```bash
   uname -r
   ls /boot | grep -E 'vmlinuz|initrd'
   systemctl status unattended-upgrades --no-pager
   cat /etc/apt/apt.conf.d/20auto-upgrades
   grep -h -E 'Start-Date|linux-image' /var/log/apt/history.log 2>/dev/null | tail -n 20
   sudo zgrep -h -i 'linux-image' /var/log/unattended-upgrades/unattended-upgrades.log* 2>/dev/null | tail -n 20
   ```

   `APT::Periodic::Unattended-Upgrade "1";` in `20auto-upgrades` means automatic upgrades are enabled, and a `linux-image` package in the logs with a date matching the change confirms the source.

2. Hand the NIC recovery and the kernel analysis to the owners of the OS and the infrastructure. Whatever way a kernel got onto a node, it still has to be in the version's baseline (Cause 1).

## Diagnostic Steps

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,OS:.status.nodeInfo.osImage,KERNEL:.status.nodeInfo.kernelVersion,ARCH:.status.nodeInfo.architecture
cat /etc/os-release; uname -r; uname -m
```

- The availability check reports `未支持的操作系统` (unsupported operating system), or the planned OS or kernel is not in the supported list of the version: Cause 1.
- A question about mixing operating systems or architectures, or an add rejected with `硬件架构不匹配`: Cause 2.
- A kernel in `uname -r` that differs from the one the node had at initialization, with no platform action in between, and Unattended Upgrades enabled: Cause 3.
