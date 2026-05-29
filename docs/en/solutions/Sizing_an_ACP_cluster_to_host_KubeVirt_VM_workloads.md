---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500557
---

# Sizing an ACP cluster to host KubeVirt VM workloads

## Issue

Planning an Alauda Container Platform cluster that will run virtual machines via the Alauda Virtualization (KubeVirt) module on kube-version v1.34.5 with `kubevirt-hyperconverged-operator.v4.3.5` (KubeVirt operatorVersion v1.7.0-alauda.1-dirty) in namespace `kubevirt` requires sizing each worker so the sum of every VirtualMachineInstance's resource requests plus per-VMI launcher overhead fits inside the node's allocatable capacity, not its raw hardware capacity. The same plan must also include enough spare worker headroom to absorb a single-node failure or drain without evicting any running VM.

## Root Cause

Worker-node allocatable is what the scheduler actually offers to pods; it is the node's raw capacity reduced by kubelet `kubeReserved`, `systemReserved`, and the `evictionHard` memory threshold before any workload is placed. On the reference cluster each node reports capacity of 8 CPU cores and ~16.0 GiB of memory but allocatable of 7800m CPU and ~14.1 GiB, reflecting `kubeReserved` and `systemReserved` of 100m / 902Mi each plus `evictionHard.memory.available: 100Mi`; `cpuManagerPolicy` is `none`, so no cores are pinned out of the shared pool. With three worker nodes carrying VM workload, that yields roughly 23.4 CPU cores and ~42.3 GiB of allocatable available for the VMs plus their launcher overhead.

Every VirtualMachineInstance is realized as a virt-launcher pod, and the guest's declared CPU and memory appear on that pod under `VMI.spec.domain.resources` as standard `requests` and `limits` for the `cpu` and `memory` keys — that is the shape the scheduler sees when binding the VMI to a node. With `VMI.spec.domain.resources.overcommitGuestOverhead` left at its default of `false`, the scheduler also accounts for the per-VMI launcher overhead on top of the guest's declared values, so node capacity planning must budget for both the guest request and the overhead surface that KubeVirt adds. On ACP, the `HyperConverged` CR exposes the tunables that govern that overhead surface: `vmiCPUAllocationRatio` defaults to `10` (each vCPU translates into one-tenth of a physical thread of CPU request on the launcher pod), and `higherWorkloadDensity.memoryOvercommitPercentage` defaults to `100` (no memory overcommit), so the "overhead added on top of guest memory" rule holds at default settings. The KubeVirt per-node agent runs as a `virt-handler` DaemonSet selected by `kubernetes.io/os=linux`, so launcher overhead applies on every node that participates in the VM workload.

Control-plane sizing has to grow with the same workload because every VirtualMachine, VirtualMachineInstance, and DataVolume CR — and their continuous status updates — funnel through kube-apiserver and etcd. On ACP the control plane runs as kubeadm-style static pods in `kube-system` (etcd, kube-apiserver, kube-controller-manager, kube-scheduler), with baseline container requests of `cpu=100m, memory=100Mi` on etcd and `cpu=250m` on kube-apiserver — these are floors, not steady-state under VM load, and 34 CRDs across the `kubevirt.io`, `cdi.kubevirt.io`, `hco.kubevirt.io`, `snapshot.kubevirt.io`, `migrations.kubevirt.io`, and `instancetype.kubevirt.io` groups add to the reconcile loops the control plane must absorb.

## Resolution

Size the worker pool against allocatable, not capacity, and budget per-VMI launcher overhead on top of every guest request. For each planned VM, take the guest CPU and memory declared on the VirtualMachine, treat them as the pod-level `requests` that will appear on the virt-launcher pod, and add the KubeVirt launcher overhead before summing — the sum across all VMIs that a node is expected to host must fit inside that node's allocatable. Leave `overcommitGuestOverhead` at its default `false` so the scheduler keeps accounting for that overhead; if `vmiCPUAllocationRatio` or `memoryOvercommitPercentage` are tuned on the `HyperConverged` CR, recompute the per-VMI request footprint against the new ratios before sizing.

Provision enough spare worker capacity for an N+1 failure domain: when a worker is lost or drained, the remaining workers in the pool must together hold the allocatable headroom needed to re-host every VMI that was running on the missing node. On a small cluster — for example, three workers plus one control-plane node — that means each individual worker should run no more than `(total VM footprint) / (workers − 1)` of the workload, so the surviving two workers can still absorb the third worker's share.

Size the control plane for the API write rate the workload generates, not just for the baseline container requests; the etcd and kube-apiserver floors observed in `kube-system` are the minimum, and CPU and memory headroom for both pods should be raised in line with the number of VM, VMI, and DataVolume objects and the rate at which their status fields change.

A representative VMI spec — the shape the scheduler will see on the virt-launcher pod — fits the standard upstream form:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstance
spec:
  domain:
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
      overcommitGuestOverhead: false
```

## Diagnostic Steps

Confirm per-node allocatable before committing to a sizing plan — this is the value the scheduler will use to admit virt-launcher pods, and it is already net of `kubeReserved`, `systemReserved`, and `evictionHard`:

```bash
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,\
CPU_CAP:.status.capacity.cpu,\
CPU_ALLOC:.status.allocatable.cpu,\
MEM_CAP:.status.capacity.memory,\
MEM_ALLOC:.status.allocatable.memory
```

Inspect the merged kubelet configuration to verify the reservation and eviction values that explain the capacity-to-allocatable delta:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig | {kubeReserved, systemReserved, evictionHard, cpuManagerPolicy}'
```

List existing VMIs and the resource requests on their virt-launcher pods to see the realized scheduler view of the VM workload — note the columns below project `.spec.containers[0]`, which is the launcher container on the standard virt-launcher pod shape; if the pod carries container-disk or other sidecars, project by container name (e.g. `compute`) instead to be sure the launcher's own requests are read:

```bash
kubectl get vmi -A
kubectl get pod -A -l kubevirt.io=virt-launcher \
  -o custom-columns=\
NS:.metadata.namespace,\
POD:.metadata.name,\
NODE:.spec.nodeName,\
CPU_REQ:.spec.containers[0].resources.requests.cpu,\
MEM_REQ:.spec.containers[0].resources.requests.memory
```

Verify that the per-node KubeVirt agent is healthy on every node that is expected to carry VMIs, since launcher overhead depends on it:

```bash
kubectl -n kubevirt get ds virt-handler
```

Check control-plane static-pod resource footprints in `kube-system` against the expected API and etcd write rate from the VM, VMI, and DataVolume objects the workload will create:

```bash
kubectl -n kube-system get pod \
  -l 'tier=control-plane' \
  -o custom-columns=\
NAME:.metadata.name,\
NODE:.spec.nodeName,\
CPU_REQ:.spec.containers[*].resources.requests.cpu,\
MEM_REQ:.spec.containers[*].resources.requests.memory
kubectl get crd \
  -o name | grep -E '(kubevirt|cdi|hco|snapshot|migrations|instancetype)\.kubevirt\.io$' \
  | wc -l
```
