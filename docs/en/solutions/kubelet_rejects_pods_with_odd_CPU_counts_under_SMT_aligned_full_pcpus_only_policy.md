---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A pod with a `Guaranteed` QoS class (`requests` equal to `limits` on integer CPU) requesting an odd number of CPUs is repeatedly admitted by the scheduler and immediately rejected by the kubelet on the chosen node. The pod's events / logs carry:

```text
SMT Alignment Error: requested 5 cpus not multiple cpus per core = 2
```

This affects KubeVirt `virt-launcher` pods (when the `VirtualMachine`'s `spec.template.spec.domain.cpu.cores` resolves to an odd guaranteed CPU count) and any other workload that requests an odd integer CPU count on a node where the kubelet is configured for SMT-aligned static CPU pinning.

When the cluster uses a NUMA-aware scheduler (e.g., a topology-aware scheduler plugin paired with `topologyManagerPolicy: single-numa-node`), the symptom compounds: the scheduler keeps generating new replicas in a tight loop, every replica is rejected on admission, and the workload appears to spawn `Pending` and `ContainerStatusUnknown` pods endlessly:

```text
$ kubectl get po -n test-numa-aware-scheduler
NAME                                 READY   STATUS                   RESTARTS   AGE
numa-deployment-1-7969c497b8-728jc   0/2     Pending                  0          1s
numa-deployment-1-7969c497b8-7rmdl   0/2     ContainerStatusUnknown   0          10s
...
```

## Root Cause

The kubelet's `cpuManagerPolicyOptions: full-pcpus-only=true` (combined with `cpuManagerPolicy: static`) requires every Guaranteed-QoS container's CPU request to be a whole number of physical cores — both SMT siblings of every assigned core must belong to the same container. On a node with SMT enabled, that is a multiple of `cpus per core = 2`. An odd CPU count cannot be satisfied without splitting a core's siblings across two containers, which the policy forbids — so the kubelet refuses admission with the `SMT Alignment Error`.

The NUMA-aware scheduler is unaware of this admission rule. It selects a node with the right per-NUMA capacity, the kubelet rejects, the deployment controller spawns a replacement, the cycle repeats. There is no upstream support today for the scheduler to query per-node SMT alignment requirements as a predicate; treating odd CPU counts as a configuration error on the workload side is the only path that does not flap pods.

## Resolution

Two paths — fix the workload's CPU sizing, or relax the kubelet's SMT alignment.

### Option 1 — Make every Guaranteed-QoS container's CPU count even

For plain pods, edit the workload spec so each container's `requests.cpu` and `limits.cpu` are an even integer:

```yaml
containers:
  - name: app
    resources:
      requests:
        cpu: "6"
        memory: "1Gi"
      limits:
        cpu: "6"
        memory: "1Gi"
```

For KubeVirt VMs whose virt-launcher inherits `spec.template.spec.domain.cpu.cores`, pin to an even core count and set `dedicatedCpuPlacement: true` so the kubelet's static manager owns the cores:

```yaml
spec:
  template:
    spec:
      domain:
        cpu:
          cores: 6                       # must be even when full-pcpus-only=true
          dedicatedCpuPlacement: true
          isolateEmulatorThread: true
```

The kubelet now admits the pod because `6 % 2 == 0`.

### Option 2 — Disable full-pcpus-only on the affected node pool

If the workload genuinely needs an odd CPU count and is willing to share SMT siblings with another container, drop the `full-pcpus-only` policy option from the kubelet config on the relevant node pool. Edit the kubelet configuration CR (or kubelet config file) for those nodes:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerPolicyOptions: {}              # remove full-pcpus-only
```

After applying, drain the node, restart the kubelet, and uncordon. The kubelet will accept odd CPU counts but no longer guarantees that each pod owns whole physical cores — a measurable regression for latency-sensitive workloads.

### Option 3 — Disable SMT in firmware

When odd CPU counts are required cluster-wide and full-pcpus-only must remain on, disabling SMT in the BIOS turns every physical core into a single logical CPU; the alignment requirement collapses to "multiple of 1" and odd counts work. This halves the per-node logical-CPU count and is rarely the right trade-off, but it is the only fully-aligned answer when the workload size is not negotiable.

## Diagnostic Steps

1. Confirm the rejection is the SMT alignment policy and not, say, the topology manager:

   ```bash
   kubectl describe pod <stuck-pod> | sed -n '/Events:/,$p'
   # expect:  SMT Alignment Error: requested N cpus not multiple cpus per core = 2
   ```

2. Inspect the kubelet's CPU manager configuration on the affected node:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host bash -c '
       grep -E "cpuManagerPolicy|cpuManagerPolicyOptions|topologyManagerPolicy" \
         /etc/kubernetes/kubelet.conf || true
       cat /var/lib/kubelet/cpu_manager_state | head -20
     '
   ```

3. Confirm SMT is on — the rejection only happens when there are 2 logical CPUs per physical core:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host bash -c '
       lscpu | grep -E "Thread|Socket|Core|CPU\(s\)"
       cat /sys/devices/system/cpu/smt/active
     '
   ```

   `Thread(s) per core: 2` and `smt/active = 1` are the SMT-on signature.

4. For a VM-side rejection, inspect the rendered virt-launcher pod's spec for the actual CPU request — KubeVirt computes it from `cpu.cores * cpu.threads * cpu.sockets`, plus a small overhead, and the resulting integer is what the kubelet evaluates:

   ```bash
   kubectl get vmi <vmi> -o jsonpath='{.status.activePods}'
   kubectl get pod <virt-launcher-pod> -o jsonpath='{.spec.containers[0].resources.requests.cpu}'
   ```
