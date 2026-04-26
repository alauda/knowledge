---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Sizing a Kubernetes cluster that will host virtual machine workloads is fundamentally different from sizing one for pure container workloads. Each VM is launched inside a `virt-launcher` pod, and the pod's resource requests must cover not just the guest's CPU and memory but also the QEMU process's overhead, infrastructure components on the node (CNI agent, kubelet, monitoring exporters), and a safety margin so live migration has somewhere to go.

This guide describes a practical methodology for sizing a cluster that will host KubeVirt-based VMs: how to translate VM specs into per-node capacity requirements, how to reserve headroom for migrations and platform agents, and how to validate the sizing under realistic load.

## Resolution

### Step 1: Catalogue the VM Workloads

For each class of VM that will run on the cluster, write down five numbers. Without these, capacity planning is guesswork.

| Field | Meaning | Notes |
|---|---|---|
| `vcpu` | Guest virtual CPU count | Maps roughly 1:1 to host CPU when CPU pinning is disabled |
| `memory_gib` | Guest RAM in GiB | The platform reserves this on the node as a hard floor |
| `disk_gib` | Total disk capacity (root + data) | Per-VM PVC capacity request |
| `iops_p99` | Peak IOPS the VM is expected to drive | Drives storage class selection |
| `count` | How many such VMs will run concurrently | Includes the +1 needed for live-migration headroom |

Round up everywhere; under-sizing is catastrophic for VM workloads, over-sizing is merely expensive.

### Step 2: Compute Per-VM Resource Footprint

The pod that hosts a VM consumes more than the guest's nominal resources. For a `vcpu=4, memory_gib=16` VM, plan for:

- **CPU:** `vcpu + 0.25` cores → 4.25 cores requested. The 0.25 covers the QEMU emulator thread, KubeVirt's compute container, and brief spikes from the libvirt agent.
- **Memory:** `memory_gib + max(0.5, memory_gib * 0.05)` → roughly 16.8 GiB requested. The overhead absorbs QEMU memory, KubeVirt's `compute` container, and page-table growth.
- **Disk:** `disk_gib + 5 GiB` of node-local ephemeral storage for `cloud-init`, container disk caches, and crash dumps.

If you enable dedicated CPU pinning (`spec.template.spec.domain.cpu.dedicatedCpuPlacement: true`), reserve full physical cores per vCPU and budget an additional emulator-thread CPU per VM.

### Step 3: Determine the Per-Node Capacity Budget

A node never gives 100% of its physical resources to VM workloads. The platform-managed daemons take a fixed slice, and live migration requires unallocated headroom.

| Reservation | Typical fraction of node | Reason |
|---|---|---|
| Operating system + kernel | 1 vCPU + 2 GiB | Constant overhead |
| Kubelet + container runtime | 0.5 vCPU + 1 GiB | Per node |
| CNI agent (Kube-OVN) | 0.5 vCPU + 1 GiB | Per node |
| Monitoring exporters, log shipper | 0.5 vCPU + 1 GiB | Per node |
| Live-migration headroom | 25% of remaining | So one node draining can land its VMs elsewhere |

The remaining capacity is the *VM-allocatable* budget. For a 32-core, 256 GiB worker:

- After daemons: `32 - 2.5 = 29.5` vCPU, `256 - 5 = 251` GiB.
- After 25% migration headroom: `29.5 * 0.75 = 22.1` vCPU, `251 * 0.75 = 188` GiB available for VMs.

### Step 4: Compute the Cluster-Level Total

```
total_vcpu_required = Σ over VM classes of count_i × vcpu_i × 1.0625      # +6.25% pod overhead
total_memory_required = Σ over VM classes of count_i × memory_gib_i × 1.05
node_count = ceil(total_vcpu_required / per_node_vcpu_allocatable)
node_count = max(node_count, ceil(total_memory_required / per_node_memory_allocatable))
```

Take the larger of the two `node_count` results — VM workloads are usually memory-bound, but CPU-bound mixes do exist.

Add at least one extra worker node beyond the calculated minimum so that one node taken down for maintenance does not leave the cluster without migration capacity.

### Step 5: Storage Sizing

PVC capacity adds linearly: total cluster PVC capacity must be at least `Σ disk_gib_i × count_i`, plus 30% headroom for snapshots and clone operations the Virtualization stack performs during day-2 operations.

Match the storage class to the IOPS profile. As a rule of thumb:

| Workload class | Recommended storage |
|---|---|
| OS disks, low-IOPS apps | Distributed-storage RWX class with `volumeMode: Block` |
| High-IOPS DBs | Local SSD via TopoLVM, sized 1.5× expected DB capacity |
| Scratch/data disks for stateless guests | Object-backed PVC if available, otherwise NFS RWX |

### Step 6: Worked Example

Plan: 30 web app VMs (2 vCPU, 4 GiB, 30 GiB disk), 8 database VMs (8 vCPU, 32 GiB, 200 GiB disk), 4 cache VMs (4 vCPU, 16 GiB, 50 GiB disk).

```
web   total: 30 × 2.125 = 63.75 vCPU, 30 × 4.2  = 126 GiB,  30 × 35  =   1050 GiB disk
db    total:  8 × 8.25  = 66    vCPU,  8 × 33.6 = 268 GiB,   8 × 205 =   1640 GiB disk
cache total:  4 × 4.25  = 17    vCPU,  4 × 16.8 = 67.2 GiB,  4 × 55  =    220 GiB disk
                       = 146.75 vCPU             = 461.2 GiB             = 2910 GiB disk
```

With 32-core / 256 GiB workers (22.1 vCPU and 188 GiB allocatable each):

- vCPU-bound node count: `ceil(146.75 / 22.1) = 7`
- Memory-bound node count: `ceil(461.2 / 188) = 3`

Pick 7 + 1 (headroom) = **8 worker nodes**. Storage capacity: `2910 × 1.3 = 3783 GiB`, rounded up to a 4 TiB pool.

## Diagnostic Steps

Validate the sizing by inspecting per-node allocations once the cluster is up:

```bash
# Aggregate VM-launcher pod requests per node
kubectl get pods -A -l kubevirt.io=virt-launcher \
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,\
CPU:.spec.containers[0].resources.requests.cpu,\
MEM:.spec.containers[0].resources.requests.memory \
  | sort -k2

# Compare against node allocatable
kubectl describe nodes | grep -A2 "Allocated resources" | head -40
```

If allocated CPU on any node is above ~75% of allocatable, that node will not be able to absorb evacuees during a planned migration; rebalance VMs or add a worker before maintenance.

Confirm live migration actually has a target during a drain rehearsal:

```bash
# Pick a worker, drain it, watch VMI reschedule
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --pod-selector='kubevirt.io=virt-launcher' --dry-run=server
```

If the dry-run reports VMs that would be evicted and you have not provisioned enough headroom on the remaining nodes, the actual drain will block — the sizing model needs another worker.
</content>
