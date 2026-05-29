---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500663
---

# CX-series KubeVirt VM fails to start with FailedScheduling on dedicated CPU and hugepages

## Issue

On Alauda Container Platform with KubeVirt v1.7.0-alauda.2 (HCO operator 1.17.0) deployed in the `kubevirt` namespace, a VirtualMachine that references a CX-series cluster instancetype such as `cx1.large` stays in `ErrorUnschedulable` and its VirtualMachineInstance never reaches `Running`. The associated `virt-launcher-<vm>-xxxxx` pod is stuck `Pending`, and the default scheduler emits a `Warning FailedScheduling` event like `0/4 nodes are available: 4 node(s) didn't match Pod's node affinity/selector` — sometimes followed in larger clusters by `1 Insufficient hugepages-2Mi, 3 node(s) didn't match Pod's node affinity/selector`.

```bash
kubectl get vm,vmi -n <ns>
kubectl get events -n <ns> --field-selector reason=FailedScheduling
```

## Root Cause

The CX (Compute Exclusive) series of `virtualmachineclusterinstancetypes.instancetype.kubevirt.io` is shipped by the kubevirt-operator bundle as part of the common-instancetypes set (version `v1.5.1`) alongside the M, N, O, RT, and U series. The `cx1.large` object carries `spec.cpu.dedicatedCPUPlacement: true`, `spec.cpu.isolateEmulatorThread: true`, `spec.cpu.numa.guestMappingPassthrough: {}`, and `spec.memory.hugepages.pageSize: 2Mi` — every CX-series workload therefore demands pinned CPUs, vNUMA passthrough, and 2 MiB hugepages.

When a VirtualMachine references such an instancetype, virt-controller translates those requirements 1:1 into the virt-launcher Pod spec. The compute container is built with `requests.hugepages-2Mi: 4Gi` (mirroring `memory.guest`), `requests.cpu: 3` (guest cores plus an IO/emulator-thread reserve from `isolateEmulatorThread` + `ioThreadsPolicy: auto`), and the resulting Pod runs at `qosClass: Guaranteed` — the only QoS class that kubelet's CPU Manager static policy can pin. virt-controller additionally injects a hard `nodeSelector` with `cpumanager=true`, `kubevirt.io/schedulable=true`, `machine-type.node.kubevirt.io/q35=true`, and `kubernetes.io/arch=amd64`. The `cpumanager=true` label is set on a node only by the KubeVirt node-labeller / virt-handler once kubelet on that node runs with `--cpu-manager-policy=static`.

Out of the box, ACP nodes carry `cpuManagerPolicy: none` and advertise `allocatable.hugepages-2Mi: 0` — verified across every node in a fresh cluster. With no node carrying `cpumanager=true`, the kube-scheduler eliminates all nodes at the node-affinity/selector stage and never reaches the hugepages predicate — that is the `4 node(s) didn't match Pod's node affinity/selector` form of the event. If at least one node has been relabelled `cpumanager=true` but still has zero `hugepages-2Mi`, the scheduler narrows to that node and emits `Insufficient hugepages-2Mi` for it while reporting the remaining nodes as affinity mismatches — that is the mixed `1 Insufficient hugepages-2Mi, 3 node(s) didn't match Pod's node affinity/selector` form. The `cx1.large` CRD itself states the prerequisite verbatim in its `instancetype.kubevirt.io/description` annotation: *Requirements for CX series instance types: CPU manager has to be enabled. Huge pages have to be available on the nodes.*

## Resolution

Pick at least one worker that will host CX-series VMs and prepare it at the node-OS layer. ACP does not ship any operator-managed CRD for either hugepages reservation or kubelet CPU Manager — both knobs are configured outside the catalog, directly on the node.

Reserve 2 MiB hugepages on the chosen node by adding the Linux kernel cmdline reservation (for example `hugepagesz=2M hugepages=N` where `N` is the page count to cover all CX VMs scheduled there), then reboot the node so kubelet starts reporting the pages. After the reboot, the reservation is visible in `node.status.allocatable.hugepages-2Mi`:

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.allocatable.hugepages-2Mi}{"\n"}{end}'
```

Enable the kubelet CPU Manager static policy on the same node by setting `cpuManagerPolicy: static` in that node's kubelet config file and restarting the kubelet. Confirm the policy through the kubelet `/configz` endpoint:

```bash
kubectl get --raw /api/v1/nodes/<node-name>/proxy/configz | python3 -c 'import sys,json; print(json.load(sys.stdin)["kubeletconfig"]["cpuManagerPolicy"])'
```

Once kubelet runs with `cpuManagerPolicy: static`, the KubeVirt node-labeller / virt-handler on that node sets the `cpumanager=true` label, which is what virt-controller's launcher `nodeSelector` filters on:

```bash
kubectl get nodes -L cpumanager
```

With both the hugepages reservation and `cpumanager=true` present on at least one node, the next reconciliation of the CX-bound VirtualMachine clears the `FailedScheduling` event and the launcher Pod is bound.

For general-purpose workloads that do not need pinned cores, vNUMA, or hugepages, reference a U-series instancetype (`u1.medium`, `u1.large`, `u1.xlarge`, ...) instead of CX. The U-series body carries only `spec.cpu.guest` and `spec.memory.guest` — no `dedicatedCPUPlacement`, no `isolateEmulatorThread`, no `numa`, no `hugepages` block — so virt-launcher schedules under normal Burstable-QoS placement without any node-side preparation:

```bash
kubectl get virtualmachineclusterinstancetype u1.medium -o yaml
```

## Diagnostic Steps

Confirm the VirtualMachine references a CX-series instancetype:

```bash
kubectl get vm <vm-name> -n <ns> -o jsonpath='{.spec.instancetype}{"\n"}'
```

Inspect the instancetype to see whether it demands pinned CPUs and hugepages — every CX variant does:

```bash
kubectl get virtualmachineclusterinstancetype cx1.large -o yaml
```

Read the `FailedScheduling` events on the stuck launcher Pod and look at the launcher's `nodeSelector` to see the `cpumanager=true` requirement that filters out unprepared nodes:

```bash
kubectl get events -n <ns> --field-selector reason=FailedScheduling
kubectl get pod -n <ns> -l kubevirt.io/created-by=<vmi-uid> \
  -o jsonpath='{.items[0].spec.nodeSelector}{"\n"}'
```

Check whether any node currently carries `cpumanager=true` and what hugepages they advertise:

```bash
kubectl get nodes -L cpumanager
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\thugepages-2Mi="}{.status.allocatable.hugepages-2Mi}{"\n"}{end}'
```

If every node reports `cpumanager=false` and `hugepages-2Mi=0`, the cluster has no node that satisfies any CX-series launcher — either prepare a node as described above, or rebind the VirtualMachine to a U-series instancetype.
