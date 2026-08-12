---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a node with an NVIDIA RTX 6000 card and the NVIDIA GPU Operator installed, the GPU Operator's validator pods enter `CrashLoopBackOff` shortly after the cluster policy applies. The driver DaemonSet, the container toolkit, and the device plugin all report `Running`, but the `nvidia-cuda-validator` init container and the `nvidia-operator-validator` pod restart repeatedly:

```text
NAME                                               READY   STATUS                  RESTARTS   AGE
gpu-feature-discovery-l8n58                        1/1     Running                 0          9m20s
gpu-operator-6596bbddd4-8cf2l                      1/1     Running                 3          22h
nvidia-container-toolkit-daemonset-kwdcx           1/1     Running                 0          9m20s
nvidia-cuda-validator-5ltm6                        0/1     Init:CrashLoopBackOff   4          2m41s
nvidia-dcgm-6dnmh                                  1/1     Running                 0          9m20s
nvidia-device-plugin-daemonset-vfsvk               1/1     Running                 0          9m20s
nvidia-driver-daemonset-...                        2/2     Running                 2          22h
nvidia-mig-manager-r4995                           1/1     Running                 0          9m20s
nvidia-node-status-exporter-4mg5p                  1/1     Running                 1          22h
nvidia-operator-validator-dlvsc                    0/1     Init:2/4                3          9m20s
```

The validator is the component that exercises each layer (driver present → container toolkit available → device plugin reachable → CUDA sample runs) before the node is considered GPU-ready. The crash is specifically inside the CUDA validation step, and the pod's exit is not a plain GPU-access error — it is a kernel-level fault that resets the container whenever it tries to use the GPU.

## Root Cause

The node's kernel version introduces a regression in how it lays out certain device-memory mappings under **KASLR** (Kernel Address Space Layout Randomization). The NVIDIA driver uses memory ranges that overlap a region whose randomized placement changed in the affected kernel; the overlap is rare but deterministic for RTX 6000 on the affected kernel lines. When the driver tries to map the GPU's memory, the kernel returns an address that the device cannot DMA against, the validator's CUDA sample faults, and the container restarts.

The fault is at the kernel/driver boundary, not in the GPU Operator or the validator container itself. Neither a newer GPU Operator release nor a different validator image resolves it — the fix is either a kernel that repositions the conflicting region, or disabling KASLR so the conflicting region returns to its legacy (non-randomized) placement.

Newer kernel revisions in the affected distribution lines carry the fix. Until those roll out to the cluster, disabling KASLR on affected worker nodes is the supported workaround.

## Resolution

### Preferred — upgrade the node kernel

Follow the platform's node-OS upgrade channel. Once the worker nodes pick up a kernel version that carries the KASLR fix, the validator completes successfully and the RTX 6000 GPUs become available to workloads. Verify after the upgrade:

```bash
# Watch the validator pods come up green.
kubectl -n nvidia-gpu-operator get pod -l app=nvidia-operator-validator -w
kubectl -n nvidia-gpu-operator get pod -l app=nvidia-cuda-validator -w
```

A `Ready=True` / `Running` state for both, maintained across the cluster's next few reconciles, confirms the kernel path works without the workaround.

### Workaround — disable KASLR on affected nodes

If the kernel upgrade cannot happen in time, add `nokaslr` to the kernel argument set on the worker nodes that host RTX 6000 cards. The boot-time parameter prevents the kernel from randomizing its address layout, which keeps the conflicting region at its legacy address and out of the driver's path.

How to apply the change depends on the platform's node-configuration surface:

- If the platform exposes a per-node-pool kernel-argument configuration resource (a CR that the platform's node operator reconciles down to boot configuration), add `nokaslr` to its `kernelArguments` list and let the node operator roll the nodes.
- If nodes are provisioned from a golden image or a kickstart / cloud-init template, append `nokaslr` to the default kernel command line in the template and redeploy the affected nodes.
- For single-node or lab environments, edit the bootloader's default entry directly and reboot (not a production pattern, but useful for validation).

### Order of operations matters

The GPU Operator installs its own validator that runs before the GPU DaemonSet declares the node healthy. If KASLR is disabled *while* the validator is crashlooping, the operator's reconcile logic may get stuck deciding whether the node is recovering or still broken. The safer sequence is:

1. **Remove the cluster policy** that drives the GPU Operator:

   ```bash
   kubectl delete clusterpolicies.nvidia.com gpu-cluster-policy
   ```

2. Apply the `nokaslr` change to the worker nodes, let them reboot, and confirm `uname -a` reflects the change once they come back (the kernel command line should include `nokaslr`).

3. **Re-apply the cluster policy** so the GPU Operator re-runs its reconcile loop cleanly on the now-workarounded nodes:

   ```bash
   kubectl apply -f gpu-cluster-policy.yaml
   ```

The validator should complete on each node within one reconcile cycle. Monitor:

```bash
kubectl -n nvidia-gpu-operator get pod -o wide -w
```

### Scope of the workaround

`nokaslr` is a security-hardening trade-off — KASLR exists to make kernel exploits harder by randomising addresses each boot. Disabling it is acceptable for GPU worker nodes that are already running privileged GPU drivers (the driver's access to raw physical memory is a far greater attack surface than the one KASLR mitigates), but it is not an acceptable default for the whole cluster. Apply the change only to the node pool that contains the RTX 6000 workers; leave other nodes with KASLR enabled.

Revisit after the kernel fix lands: once a fixed kernel is rolled out across the GPU nodes, remove the `nokaslr` entry so future boots run with KASLR active.

## Diagnostic Steps

Confirm the validator's specific failure signature (not a different GPU problem):

```bash
# The cuda-validator is the usual first failure; capture its logs.
POD=$(kubectl -n nvidia-gpu-operator get pod -l app=nvidia-cuda-validator \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n nvidia-gpu-operator logs "$POD" -c cuda-validation
kubectl -n nvidia-gpu-operator describe pod "$POD" | grep -E 'Last State|Reason|Exit Code'
```

A CUDA sample failure that reports a memory mapping error (rather than a plain "device not available" or "permission denied") suggests the KASLR issue. Check the node's kernel version to correlate:

```bash
NODE=$(kubectl -n nvidia-gpu-operator get pod "$POD" -o jsonpath='{.spec.nodeName}')
kubectl debug node/$NODE --image=busybox -- chroot /host uname -a
```

Kernels in the affected distribution lines (check the platform's release notes against the published fix matrix) are the candidates; newer kernels should have the fix. Confirm the card's model is an RTX 6000 via the NVIDIA device plugin's state:

```bash
kubectl get node $NODE -o json | jq '.status.capacity | with_entries(select(.key | startswith("nvidia.com/")))'
kubectl -n nvidia-gpu-operator exec -it nvidia-driver-daemonset-XXX -c nvidia-driver-ctr -- \
  nvidia-smi -L
```

After applying the workaround (kernel arg + reboot + policy reapply), the validator should complete. If it still fails, inspect the driver's logs for a different error:

```bash
kubectl -n nvidia-gpu-operator logs nvidia-driver-daemonset-XXX -c nvidia-driver-ctr --tail=200
```

An error unrelated to KASLR / memory mapping suggests the validator is failing for a different reason — that is a different investigation, not covered by the workaround here.
