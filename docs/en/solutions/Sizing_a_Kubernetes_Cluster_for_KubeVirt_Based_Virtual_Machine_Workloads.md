---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Sizing a Kubernetes cluster that hosts KubeVirt virtual machines is fundamentally different from sizing a container-only cluster. Each VM Pod (`virt-launcher`) reserves the guest's full vCPU + memory + a constant overhead, regardless of whether the guest is busy. This article walks through the worked example of a 100-VM workload and pulls out the per-resource-class formulas.

## Resolution

### Worked example — assumptions

- 100 virtual machines, average shape 2 vCPU / 4 GiB RAM / 80 GB disk.
- 80 % VM concurrency at peak (i.e. roughly 80 of the 100 VMs are powered on at once).
- Block storage on a Ceph RBD `StorageClass` (`volumeMode: Block`, `accessMode: RWX`).
- Live-migration head-room: maintain enough free memory across nodes to evacuate any single worker.
- Three control-plane nodes, dedicated; sized for cluster-management overhead only (no VM Pods).

### Step 1 — Per-VM resource accounting

KubeVirt's `virt-launcher` Pod consumes:

- vCPU: equal to `.spec.template.spec.domain.cpu.cores * sockets * threads`. Every vCPU is pinned to a logical host CPU. Plan node `allocatable.cpu` against this 1:1.
- Memory: guest memory + a fixed overhead per VM (typically ~150–250 MiB for the QEMU process + `virt-launcher` agent). For the 4 GiB guest used in the example: ~4.25 GiB Pod memory.
- Storage: one PVC per disk. The CSI driver provisions the requested capacity from the `StorageClass`.

For 100 × `2 vCPU / 4 GiB`:

| Resource | Per VM | Total at 100 % | Total at 80 % concurrency |
|---|---|---|---|
| vCPU | 2 | 200 | 160 |
| Memory | ~4.25 GiB | 425 GiB | 340 GiB |
| Disk | 80 GB | 8 TB | 8 TB (always provisioned) |

### Step 2 — Worker node sizing

Aim for a node count that:

- **Accommodates the 80 % concurrent footprint** with comfortable headroom (~70 % of `allocatable`).
- **Has spare capacity equal to the largest single node** so a node can be drained for live-migration without rejecting pending evacuations.

Two illustrative shapes for the same 100-VM workload:

| Shape | vCPU/node | Mem/node | Worker count | Notes |
|---|---|---|---|---|
| Dense | 64 | 256 GiB | 4 | Cheaper hardware density; loss of one node strands 25 % of capacity. |
| Wide | 32 | 128 GiB | 7 | Smaller blast radius; better fit for live-migration headroom. |

Either shape covers the 160 vCPU + 340 GiB peak, but the wide layout absorbs a single-node failure without exceeding `allocatable` across the surviving fleet.

### Step 3 — Storage sizing

Block-mode RBD provides RWX for live-migration. Each PVC consumes its full requested capacity in the Ceph pool (thin-provisioning is opt-in via Ceph layer features). For 100 × 80 GB:

- Raw Ceph capacity: `100 × 80 × replica` (typical `replica=3` = 24 TB) or `(k+m)/k` for erasure-coded pools.
- Add 20 % free-space headroom for snapshots, recovery, and cluster healing on disk loss.

Match `StorageClass.parameters.imageFeatures` to `layering, exclusive-lock, journaling` if RBD-mirror or snapshots are required.

### Step 4 — Network sizing

VM workloads tend to need richer networking than container workloads:

- Each VM has at least one `pod` interface (the standard CNI). For VMs that need a flat L2 network, attach a `multus` secondary interface backed by a `NetworkAttachmentDefinition`.
- Live-migration traffic flows over the in-cluster network; budget at least 10 Gb/s between any two VM-host workers, and prefer 25 Gb/s if average guest memory is greater than 8 GiB (migration time scales linearly with guest memory).
- Reserve a routable IP range per `NetworkAttachmentDefinition` per VM tier.

### Step 5 — Control plane

The KubeVirt controllers (`virt-controller`, `virt-api`, `virt-handler` DaemonSet) are lightweight — `virt-handler` runs on every node and consumes ~50 mCPU / ~100 MiB. Plan the control-plane node memory primarily against etcd (which scales with the total object count: VirtualMachine, VirtualMachineInstance, DataVolume, PVC, Pod). For 100 VMs the etcd footprint stays well under 2 GiB; control-plane nodes of `8 vCPU / 16 GiB` are comfortable.

### Step 6 — Validate before scale-up

For any new shape, validate with the `kubectl drain --force=false` exercise: drain one worker, watch all its VMs live-migrate, confirm cluster stays under 70 % `allocatable` afterwards. Repeat for memory by deliberately scaling out one extra heavy-RAM VM and confirming no `Pending` Pods remain after a few minutes.

## Diagnostic Steps

When a node refuses to schedule additional VMs:

```bash
kubectl describe node <node> | sed -n '/Allocatable:/,/Allocated resources:/p'
```

Compare `allocatable.cpu` and `allocatable.memory` against the running `virt-launcher` Pods' requests:

```bash
kubectl get pods -A -l kubevirt.io=virt-launcher \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\t"}{.metadata.name}{"\t"}{.spec.containers[0].resources.requests}{"\n"}{end}' | sort
```

If the sum-of-requests exceeds 70 % of `allocatable`, the cluster is at the headroom limit defined in step 2. Add a worker or rebalance VMs by triggering `migrate` on the densest node:

```bash
virtctl migrate <vm-name>
```
