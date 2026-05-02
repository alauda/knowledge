---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM From CX Instance Type Stuck in FailedScheduling Without Hugepages
## Issue

A new virtual machine declared from one of the compute-exclusive (CX) cluster instance types — for example `cx1.large` — never reaches `Running`. The `virt-launcher` pod is created but the scheduler refuses to bind it, returning events along the lines of:

```text
Warning  FailedScheduling  default-scheduler
  0/4 nodes are available:
  1 Insufficient hugepages-2Mi,
  3 node(s) didn't match Pod's node affinity/selector.
  preemption: 0/4 nodes are available:
  1 No preemption victims found for incoming pod,
  3 Preemption is not helpful for scheduling.
```

A second variant of the same failure cites pod anti-affinity, which surfaces when more than one CX VM is targeting the same node:

```text
Warning  FailedScheduling  Pod/virt-launcher-test-xxxx
  0/1 nodes are available: 1 node(s) didn't match pod anti-affinity rules.
```

The VM definition itself is valid and the platform's virtualization stack is healthy; the problem is exclusively at scheduling time.

## Root Cause

CX instance types in the ACP virtualization area (`virtualization`) under the KubeVirt foundation are designed for high-performance VMs. They imply, in their `spec`, the full set of dedicated-resource flags:

```yaml
cpu:
  dedicatedCPUPlacement: true
  guest: 2
  isolateEmulatorThread: true
  numa:
    guestMappingPassthrough: {}
ioThreadsPolicy: auto
memory:
  guest: 4Gi
  hugepages:
    pageSize: 2Mi
```

`dedicatedCPUPlacement: true` requires the kubelet's CPU Manager to be enabled in `static` policy on the target node. `hugepages.pageSize: 2Mi` requires the node to have pre-allocated 2Mi hugepages and to expose them as `hugepages-2Mi` in `node.status.allocatable`. If neither prerequisite is configured on any node in the pool, the scheduler honestly reports `Insufficient hugepages-2Mi` and there is no node it can bind the `virt-launcher` pod to.

The anti-affinity variant is a side-effect: KubeVirt adds a soft anti-affinity to keep two performance-critical VMs from landing on the same NUMA node. On a small cluster with one capable host, the second VM gets stuck because its only candidate is already taken.

## Resolution

The platform-preferred path is to declare hugepages and CPU Manager through the node-configuration surface of ACP (`configure/clusters/nodes`) so that a labelled subset of nodes is provisioned for high-performance VMs. Operating closer to the OSS layer, the same change is made on the kubelet and on the kernel command-line of the chosen nodes.

1. **Pick a node pool that will host CX VMs** and label it. Limit the change to a subset of nodes — hugepages reserve memory at boot time and CPU Manager pins cores out of the general scheduler pool, so applying these settings cluster-wide wastes capacity on workloads that do not need them.

   ```bash
   kubectl label node <worker-01> <worker-02> workload-class=hp-vm
   ```

2. **Configure 2Mi hugepages on the chosen nodes.** Through the platform's node-configuration surface, add a kernel-args customisation targeted to the `workload-class=hp-vm` selector. A typical reservation is 8 GiB of 2Mi pages (4096 pages) per host; size to the total of `memory.guest` across the VMs the host will run, plus headroom for the `virt-launcher` overhead.

   ```text
   default_hugepagesz=2M hugepagesz=2M hugepages=4096
   ```

   The platform reboots each matching node as it rolls the change out. After the reboot, `/proc/meminfo` should show `HugePages_Total` and `HugePages_Free` matching the reservation, and the kubelet should report the resource:

   ```bash
   kubectl get node <worker-01> -o jsonpath='{.status.allocatable.hugepages-2Mi}{"\n"}'
   ```

3. **Enable the static CPU Manager policy.** On the same node pool, declare a kubelet customisation that switches `cpuManagerPolicy` to `static` and reserves a small system slice:

   ```yaml
   kubeletConfiguration:
     cpuManagerPolicy: static
     cpuManagerReconcilePeriod: 5s
     reservedSystemCPUs: "0,1"
   ```

   The kubelet must be restarted by the platform for the policy change to take effect. With static CPU Manager active, pods that request integer CPU under the `Guaranteed` QoS class (which `virt-launcher` for a CX VM does) will receive pinned cores; the scheduler will then admit them.

4. **Reschedule the VM.** Delete the stuck `virt-launcher` pod (or, for a `RunStrategy: Always` VM, restart the VM itself) and watch the new pod bind to the labelled node:

   ```bash
   kubectl -n <vm-namespace> delete pod -l vm.kubevirt.io/name=<vm-name>
   kubectl -n <vm-namespace> get pod -l vm.kubevirt.io/name=<vm-name> -o wide
   ```

5. **Match the instance type to the workload.** CX is for latency-sensitive, NUMA-aware VMs. For general-purpose workloads (web servers, batch jobs, dev environments), use the U-series instance types instead — they do not require dedicated CPUs or hugepages and will schedule onto any worker.

## Diagnostic Steps

Confirm the instance type the VM is using and the resources it implies:

```bash
kubectl get vm <vm-name> -n <vm-namespace> -o jsonpath='{.spec.instancetype}{"\n"}'
kubectl get virtualmachineclusterinstancetype <type-name> -o yaml | yq '.spec'
```

If `cpu.dedicatedCPUPlacement` is `true` or `memory.hugepages` is set, the host must be pre-provisioned for both.

Check whether any node in the cluster has the resources advertised:

```bash
kubectl get node -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.allocatable.hugepages-2Mi}{"\t"}{.status.allocatable.cpu}{"\n"}{end}'
```

A column of `0` for `hugepages-2Mi` across every node confirms the missing reservation. Verify the kubelet's CPU Manager state:

```bash
kubectl get --raw /api/v1/nodes/<node>/proxy/configz | jq '.kubeletconfig.cpuManagerPolicy'
```

A value of `none` instead of `static` means the dedicated-CPU pin will fail on that node even after hugepages are configured.

Inspect the `virt-launcher` pod's resource requests to see exactly what the scheduler is trying to satisfy:

```bash
kubectl get pod -l vm.kubevirt.io/name=<vm-name> -o jsonpath='{.items[0].spec.containers[*].resources}{"\n"}'
```

Once both the hugepages reservation and the static CPU Manager policy are active on the labelled nodes, the next pod-bind attempt should succeed within seconds.
