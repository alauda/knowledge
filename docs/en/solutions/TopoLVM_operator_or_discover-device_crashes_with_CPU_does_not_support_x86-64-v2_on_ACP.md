---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# TopoLVM operator or discover-device crashes with CPU does not support x86-64-v2 on ACP

## Issue

TopoLVM cannot be deployed or does not discover disks on some nodes of Alauda Container Platform. One of the following is seen in namespace `nativestor-system`:

- The TopoLVM deployment in the console stays at `installing`. The `topolvm-operator` pod is `0/1` `CrashLoopBackOff` with a large restart count, and its log is a single line:

  ```text
  Fatal glibc error: CPU does not support x86-64-v2
  ```

- Deploying TopoLVM fails with an error that the CPU version is not supported, and the nodes are virtual machines.
- The navigation configuration looks empty, and the `discover-device` pods crash-loop on the control-plane nodes while the same pods on the workers are Running. Their log repeats:

  ```text
  discover: can not list disk err:failed to list all devices: exit status 127
  discover: failed to update device configmap: failed to list all devices: exit status 127
  ```

- `discover-device` pods run on control-plane nodes that must stay free of workloads, and the goal is to keep them off for good.

## Root Cause

### Cause 1: the virtual machine has no CPU passthrough, and deploy reports that the CPU version is not supported

The nodes are virtual machines with CPU passthrough turned off, so the guest sees a generic CPU model instead of the host CPU. TopoLVM requires a CPU that the generic model does not provide, and deploy fails with the unsupported CPU version error.

### Cause 2: discover-device crash-loops on control-plane nodes because their CPUs lack x86-64-v2

`discover-device` is the disk inventory pod. Its image needs the x86-64-v2 instruction set. On the control-plane nodes, `/proc/cpuinfo` lacks flags such as `sse4_1`, `sse4_2`, `popcnt`, and `ssse3`, while the workers have them. A test discover pod scheduled onto such a node logs `Fatal glibc error: CPU does not support x86-64-v2`. Because the pod cannot start there, it never creates the lvmd ConfigMap for that node: `kubectl get cm -n nativestor-system` lists `lvmdconfig-<worker-node>` for each worker and `nativestor-setting`, and nothing for the control-plane nodes.

The required host tools can all be present (`lvm`, `pvs`, `vgs`, `lvs`, `nsenter`, `lsblk`, from the `lvm2` and `util-linux` packages); `exit status 127` here is not a missing package.

### Cause 3: topolvm-operator exits with Fatal glibc error: CPU does not support x86-64-v2

The CPU of the node that runs `topolvm-operator` does not expose x86-64-v2, which the glibc in the operator image requires, so the process exits at startup. The console stays at `installing`, the pod crash-loops, and Service `topolvm-cluster-metric` (selector `name=topolvm-operator`) has no endpoints because the operator never becomes ready. This is the same CPU baseline as Cause 2, hit by the operator instead of `discover-device`.

### Cause 4: discover-device runs on control-plane nodes because of DISCOVER_DEVICE_TOLERATIONS

The tolerations of `discover-device` come from the key `DISCOVER_DEVICE_TOLERATIONS` in ConfigMap `nativestor-setting` in `nativestor-system`:

```yaml
DISCOVER_DEVICE_TOLERATIONS: |
  - operator: Exists
```

A toleration with only `operator: Exists` tolerates every taint, including the control-plane taint, so `discover-device` is also placed on those nodes.

## Resolution

### Cause 1: the virtual machine has no CPU passthrough, and deploy reports that the CPU version is not supported

1. Compare the CPU flags with a node where TopoLVM already runs, if there is one. A short, generic flag list together with the unsupported CPU version error is this cause.

```bash
grep -m1 flags /proc/cpuinfo
```

2. Enable CPU passthrough for the virtual machine in the hypervisor that owns it (the setting name depends on the hypervisor), then deploy TopoLVM again. No Kubernetes setting replaces this.

```bash
kubectl -n nativestor-system get pods
```

### Cause 2: discover-device crash-loops on control-plane nodes because their CPUs lack x86-64-v2

1. Confirm the split between control-plane nodes and workers:

```bash
kubectl get pods -A -o wide | grep discover-device
kubectl get cm -n nativestor-system | grep -i lvmd
```

2. Check the CPU flags on a crashing node. Any `MISSING` line means the CPU does not meet x86-64-v2. The loop checks the flags x86-64-v2 needs (`pni` is how `/proc/cpuinfo` names SSE3):

```bash
for f in ssse3 sse4_1 sse4_2 popcnt cx16 lahf_lm pni; do grep -qw "$f" /proc/cpuinfo && echo "$f present" || echo "$f MISSING"; done
```

3. Provide x86-64-v2 on those CPUs. For virtual machines this is the hypervisor CPU model or passthrough change from Cause 1. Wiping disks, restarting the pod, or reinstalling host packages does not add CPU instructions.

Until the CPU meets the baseline, a node that cannot run `discover-device` does not appear as a selectable disk node. Place TopoLVM data disks on the nodes where discovery works. To keep the pods off those nodes entirely, see Cause 4.

### Cause 3: topolvm-operator exits with Fatal glibc error: CPU does not support x86-64-v2

1. Find the node the operator runs on and confirm the log line:

```bash
kubectl get pod -n nativestor-system -l name=topolvm-operator -o wide
kubectl get ep topolvm-cluster-metric -n nativestor-system
kubectl -n nativestor-system logs <topolvm-operator-pod>
```

2. On that node, run the CPU flag loop from Cause 2.
3. Fix it on the IaaS side: enable CPU passthrough for the virtual machine, or change the guest CPU model so that it exposes x86-64-v2. No switch inside the cluster works around it.
4. Run the flag loop again; every line should say `present`. Then check that the operator pod becomes Running and the console leaves `installing`:

```bash
kubectl -n nativestor-system get pods
```

### Cause 4: discover-device runs on control-plane nodes because of DISCOVER_DEVICE_TOLERATIONS

The `- operator: Exists` entry under `DISCOVER_DEVICE_TOLERATIONS` can be deleted so that `discover-device` is no longer scheduled onto control-plane nodes. Do this only when there is a specific reason, for example nodes that must not run workloads or whose pod network cannot reach the management network.

> **Warning:** After the toleration is removed, `discover-device` no longer runs on tainted nodes, so their disks are not discovered or offered to TopoLVM. Precondition: no TopoLVM data disk is meant to be used on those nodes, and the ConfigMap is saved. Rollback: put the saved `DISCOVER_DEVICE_TOLERATIONS` value back.

```bash
kubectl -n nativestor-system get cm nativestor-setting -o yaml > /tmp/nativestor-setting.before.yaml
kubectl -n nativestor-system edit cm nativestor-setting
kubectl get pods -A -o wide | grep discover-device
```

If `discover-device` pods are still on those nodes after the edit, collect the output and the DaemonSet YAML before deleting anything.

## Diagnostic Steps

```bash
kubectl -n nativestor-system get pods -o wide
kubectl -n nativestor-system logs <discover-device-pod> --tail=50
kubectl -n nativestor-system logs <topolvm-operator-pod>
grep -m1 flags /proc/cpuinfo
```

- An unsupported CPU version error on a virtual machine during deploy: Cause 1.
- `failed to list all devices: exit status 127` only on control-plane nodes, with the glibc `x86-64-v2` line or missing CPU flags: Cause 2, even when every host tool is installed.
- The same glibc line in the `topolvm-operator` log, usually reported as a console stuck at `installing` with the operator in `CrashLoopBackOff` and no endpoints behind `topolvm-cluster-metric`: Cause 3. Read the operator log first.
- `discover-device` pods on control-plane nodes that must stay free of workloads: Cause 4.
- `failed to list all devices: exit status 127` on nodes whose CPU flags are all present can also come from a damaged disk partition table (for example `Invalid CRC on main header data` in a GPT check). Check the CPU flags first, then the disk.
