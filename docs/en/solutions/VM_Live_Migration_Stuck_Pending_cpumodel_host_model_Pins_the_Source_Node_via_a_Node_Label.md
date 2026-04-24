---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A VM live migration queues up a new `virt-launcher` pod on the destination, but the pod never reaches `Running` — it stays in `Pending` with a scheduling failure:

```text
virt-launcher-<vm-name>-<hash>   0/1   Pending   0   3m53s

Warning  FailedScheduling  pod/virt-launcher-<vm>
  0/15 nodes are available:
    1 node(s) didn't match Pod's node affinity/selector,
    1 node(s) didn't match pod anti-affinity rules,
    4 node(s) had untolerated taint {node-role.kubernetes.io/master:},
    9 node(s) were unschedulable.
  preemption: 0/15 nodes are available: No preemption victims found.
```

The confusing part: the cluster has **multiple worker nodes with the same CPU model** (for example, several nodes all running Granite Rapids). The source and target hosts are, by any reasonable reading, compatible. But the scheduler insists no node matches the new pod's affinity. When the scheduler says "didn't match pod's node affinity/selector", it is reporting literal truth — the pod's nodeSelector is narrower than the CPU-model compatibility suggests.

## Root Cause

KubeVirt's `cpu.model: host-model` is convenient: it lets a VM use the exact CPU features of its current host without manually enumerating them. But `host-model` is not an automatic migration-compatibility promise. At VM start time, KubeVirt inspects the host's CPU, records the model (as a node label), and pins the VM's `virt-launcher` pod to nodes carrying that specific model label.

When a live migration is initiated, the target pod inherits the source's `cpu.model: host-model` — which now encodes the **source host's** discovered model as a hard `nodeSelector`. The target `virt-launcher` pod therefore only schedules on a node that advertises:

```text
cpu-model-migration.node.kubevirt.io/<model-name>: "true"
```

Exactly one node can advertise this — the one whose `host-model-cpu.node.kubevirt.io/<model-name>` label is the matching host-model **and** whose `cpu-model-migration` label is set. Other nodes with the same CPU family but a slightly different discovered-model string, or with the `cpu-model-migration` label missing, are filtered out. Even on a homogeneous cluster, subtle differences in discovered CPU features (microcode revision, virtualization extensions, security-mitigation flag set) can cause one node to label differently from its peers — and the pod then has nowhere to schedule.

The fix is to specify the VM's CPU model explicitly so KubeVirt does not pin the pod to a host-specific label. A common stable choice is the CPU family name (a shared ancestor of all the cluster's CPUs) rather than `host-model`.

## Resolution

The VM has to be **stopped** to change `cpu.model` — KubeVirt does not allow CPU changes on a running VMI. The change is durable; once applied, migrations between compatible hosts work.

### Edit the VM's CPU model

```bash
kubectl -n <ns> stop vm <vm-name>
# Wait for VMI to disappear.
kubectl -n <ns> get vmi <vm-name> -w

# Edit the VM to replace host-model with a shared CPU model.
kubectl -n <ns> edit vm <vm-name>
```

In the editor, change the CPU block:

```yaml
spec:
  template:
    spec:
      domain:
        cpu:
          # Before:
          # model: host-model
          # After — pin to a model that every intended target node supports.
          # Common stable choices:
          #   - a specific family: Skylake-Server, EPYC-Rome, GraniteRapids-Server
          #   - a looser baseline: qemu64, Westmere, SandyBridge-IBRS
          model: Skylake-Server
          cores: 1
          maxSockets: 4
          sockets: 1
          threads: 1
```

Start the VM back up:

```bash
kubectl -n <ns> start vm <vm-name>
```

The VMI boots, and its `virt-launcher` pod is now selectable on any node that advertises `cpu-model.node.kubevirt.io/<selected-model>: "true"` — typically a broader set than the `host-model` label.

### Picking the CPU model

List the CPU-model labels each node advertises and pick one that every intended target node has in common:

```bash
kubectl get node -o json | \
  jq -r '.items[] |
         .metadata.name as $n |
         .metadata.labels |
         to_entries[] |
         select(.key | test("cpu-model\\.node\\.kubevirt\\.io/"))
         | "\($n)\t\(.key | sub(".*/"; ""))"' | \
  sort | uniq
```

The intersection of per-node labels is the set of models safe to pin. For a mixed-generation cluster, pick an older model in the intersection — VMs lose access to newer CPU features but gain migration mobility.

For a homogeneous cluster where you know every node is the same silicon, pick the specific family (`Skylake-Server`, `EPYC-Rome`, etc.). This gives the VM the newer instruction set while still letting it migrate across the cluster.

### `cpu.model: host-passthrough` has the same issue

`host-passthrough` passes every feature of the current host's CPU into the VM, which pins the VM just as tightly. Use only for VMs that will never migrate.

### `cpu.model` unset (default)

Leaving `cpu.model` off picks a safe, widely-compatible default (historically `qemu64` on older KubeVirt, now often the distribution's own baseline). This is the most migration-friendly choice but trades away CPU features the guest could otherwise use.

## Diagnostic Steps

Confirm the target `virt-launcher` pod's nodeSelector:

```bash
# Capture the specific pending pod's spec.
POD=$(kubectl -n <ns> get pod -l kubevirt.io/domain=<vm-name> \
        --field-selector=status.phase=Pending \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n <ns> get pod "$POD" -o jsonpath='{.spec.nodeSelector}{"\n"}' | jq
```

A `cpu-model-migration.node.kubevirt.io/<model-name>: "true"` entry is the pinning that blocks scheduling. Compare with the nodes' labels:

```bash
# Which nodes advertise the matching migration label?
MODEL=<model-name-from-selector>
kubectl get node -l "cpu-model-migration.node.kubevirt.io/${MODEL}=true" -o name
```

If that list is empty (or the only node that matches is the source, which is already running the VM), migration has nowhere to go — and the fix is to change the VM's model as above.

Inspect which CPU-model labels each potential target node advertises to understand what fallback is available:

```bash
kubectl get node -o json | \
  jq -r '.items[] |
         "=== \(.metadata.name) ===\n" +
         (.metadata.labels | to_entries |
          map(select(.key | test("cpu-model|host-model-cpu"))) |
          map("\(.key)=\(.value)") | join("\n")) + "\n"'
```

Nodes with an `host-model-cpu.node.kubevirt.io/<model>` label but without the corresponding `cpu-model-migration.node.kubevirt.io/<model>` label are ineligible as migration targets. Investigate why the migration label is missing — it is usually a labeling controller that timed out during node bring-up.

After applying the fix, start the VM and watch the pod land on the destination:

```bash
kubectl -n <ns> start vm <vm-name>
kubectl -n <ns> get pod -l kubevirt.io/domain=<vm-name> -w
```

`Running` on a node other than the original source confirms the VM is migration-capable again. Trigger a live migration (`VirtualMachineInstanceMigration`) to confirm end-to-end mobility.
