---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# NVIDIA GPU Operator validator pod fails on RTX 6000 with kernel KASLR regression
## Issue

The NVIDIA GPU Operator deploys cleanly on a node with an NVIDIA RTX 6000 (Ada Generation) card, but the validator pod loops in `Init:CrashLoopBackOff`:

```text
$ kubectl get pod -n nvidia-gpu-operator
NAME                                              READY   STATUS                       RESTARTS         AGE
gpu-feature-discovery-l8n58                       1/1     Running                      0                9m20s
gpu-operator-6596bbddd4-8cf2l                     1/1     Running                      3                22h
nvidia-container-toolkit-daemonset-kwdcx          1/1     Running                      0                9m20s
nvidia-cuda-validator-5ltm6                       0/1     Init:CrashLoopBackOff        4 (78s ago)      2m41s
nvidia-dcgm-6dnmh                                 1/1     Running                      0                9m20s
nvidia-dcgm-exporter-2wbhq                        1/1     Running                      0                9m20s
nvidia-device-plugin-daemonset-vfsvk              1/1     Running                      0                9m20s
nvidia-driver-daemonset-9.6.20251008-0-mlbsx      2/2     Running                      2                22h
nvidia-mig-manager-r4995                          1/1     Running                      0                9m20s
nvidia-node-status-exporter-4mg5p                 1/1     Running                      1                22h
nvidia-operator-validator-dlvsc                   0/1     Init:2/4                     3 (2m41s ago)    9m20s
```

Every other Operator-managed component is healthy; only the validator and any CUDA workload that follows it fail. The driver daemonset reports the kernel module loads, but the validator's CUDA init step segfaults or hangs.

## Root Cause

The kernel that ships with the affected node OS introduces a regression in the Kernel Address Space Layout Randomization (KASLR) path that misplaces certain GPU driver mappings on RTX 6000 (Ada) cards. The driver itself loads, but CUDA initialization touches a region whose virtual layout no longer matches what the user-space CUDA library expects, and the validator (which is the first non-trivial CUDA workload) crashes.

The fix is upstream in the kernel and ships in a later z-stream of the platform; until the cluster is updated to a kernel build that includes the fix, KASLR can be disabled on the affected nodes via a kernel argument (`nokaslr`). With KASLR off, the driver mappings land in their canonical positions and the validator works.

## Resolution

Two paths — apply the kernel update if available, or disable KASLR on the affected node pool until it is.

### Permanent fix — update the node OS kernel

Track the platform's release notes for a node-OS image that ships the fixed kernel. Drain the GPU nodes one at a time, let the platform's node-image roll-out apply the new image, reboot, uncordon. The validator should then run without the KASLR workaround.

### Workaround — disable KASLR on RTX 6000 nodes

When a kernel update is not yet available, add `nokaslr` to the kernel command line of the affected nodes via the platform's node configuration mechanism. With the platform's Machine Configuration / Immutable Infrastructure operator, apply a node configuration CR that targets the GPU node pool:

```yaml
apiVersion: kubelet.config.alauda.io/v1
kind: NodeConfiguration
metadata:
  name: rtx6000-nokaslr
spec:
  nodeSelector:
    matchLabels:
      node-role.kubernetes.io/gpu: ""
  kernelArguments:
    - nokaslr
```

The exact CR name and apiVersion depends on the node-config operator the cluster runs (check `kubectl api-resources | grep -iE 'kubelet|machineconfig|nodeconfig'`). The conceptual shape — a CR that selects the GPU node pool and sets `kernelArguments` — applies regardless.

Order of operations:

1. Remove the GPU `ClusterPolicy` so the operator stops trying to start GPU workloads while the kernel argument rolls out:

   ```bash
   kubectl delete clusterpolicy gpu-cluster-policy
   ```

2. Apply the node-config CR; watch the node pool roll through:

   ```bash
   kubectl apply -f rtx6000-nokaslr.yaml
   kubectl get nodes -l node-role.kubernetes.io/gpu="" --watch
   ```

   Each node drains, reboots, returns; `cat /proc/cmdline` on the rebooted node should include `nokaslr`.

3. Re-create the `ClusterPolicy`. The validator should now reach `Completed`:

   ```bash
   kubectl apply -f gpu-cluster-policy.yaml
   kubectl get pod -n nvidia-gpu-operator -w
   ```

`nokaslr` is a security regression — KASLR is one of the kernel's hardening features. Treat the workaround as a time-boxed bridge to the fixed kernel, not a permanent operating mode.

## Diagnostic Steps

1. Confirm the affected hardware is RTX 6000 (Ada) — the regression is specific to that family:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host bash -c 'lspci -nn | grep -i nvidia'
   # 0000:c1:00.0 VGA compatible controller [0300]: NVIDIA Corporation AD102GL [RTX 6000 ...]
   ```

2. Inspect the validator pod's init container log — the CUDA init failure is reproducible there:

   ```bash
   kubectl logs -n nvidia-gpu-operator <nvidia-cuda-validator-pod> -c cuda-validation --previous
   ```

3. Confirm the kernel command line in use on the affected node:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host cat /proc/cmdline
   ```

   Absence of `nokaslr` (and absence of the fixed-kernel build) on a node where the validator fails is the fingerprint.

4. After the workaround rolls out, validate that CUDA itself is now functional independently of the operator's validator. The `nvidia-smi` daemonset is the simplest probe:

   ```bash
   kubectl -n nvidia-gpu-operator exec -it <nvidia-driver-daemonset-pod> -c nvidia-driver-ctr \
     -- nvidia-smi
   ```

   GPU enumerated with non-zero utilization headroom and no driver error is the success signal.
