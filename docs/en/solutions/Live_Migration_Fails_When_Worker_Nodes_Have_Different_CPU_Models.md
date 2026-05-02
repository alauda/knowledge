---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Live Migration Fails When Worker Nodes Have Different CPU Models
## Issue

A VirtualMachine live migration stops with:

```text
Migration cannot proceed since no node is suitable to run the required CPU model
```

The source node is healthy, the candidate target nodes are not cordoned, and the VM runs fine. The error appears only during migration, typically in clusters whose worker pool is not CPU-homogeneous (e.g. a first wave of Skylake hosts plus a newer wave of Sapphire Rapids).

## Root Cause

KubeVirt schedules VMs based on two separate sets of node labels that describe CPU capabilities:

- `cpu-model.node.kubevirt.io/<model>=true` — CPU models the node can **run** natively. Used when scheduling a VM for the first time.
- `cpu-model-migration.node.kubevirt.io/<model>=true` — CPU models the node can accept as a **live-migration target**. A subset of, or sometimes larger than, the run list.

A VM whose `spec.template.spec.domain.cpu.model` is `host-model` (the common default) is pinned to the CPU generation of the node it originally landed on. During live migration, KubeVirt looks for a target that carries a compatible `cpu-model-migration.node.kubevirt.io/<model>` label. If every candidate target runs on a different generation — or the candidate is newer but migration compatibility was not labelled — the scheduler returns the error above and the migration fails.

This is a hypervisor-level constraint, not a KubeVirt bug: migrating a guest expecting AVX-512 onto a host without AVX-512 would SIGILL the guest at the next vectorised instruction.

## Resolution

Pick a stable lowest-common-denominator CPU model across the worker fleet and pin every VM to it explicitly. The label-based approach scales across heterogeneous clusters.

1. **Survey the available CPU models.** Intersect `cpu-model-migration.node.kubevirt.io/*` labels across workers. The lowest model that every worker supports is the one to standardise on:

   ```bash
   kubectl get node -l node-role.kubernetes.io/worker= -o yaml \
     | grep 'cpu-model-migration.node.kubevirt.io' \
     | sort | uniq -c | sort -rn \
     | awk -v workers="$(kubectl get node -l node-role.kubernetes.io/worker= --no-headers | wc -l)" \
           '$1 == workers {print $2}'
   ```

   The list returned is the set of models every worker supports for migration — any entry here is a safe choice.

2. **Set the cluster-wide default.** Configure the KubeVirt/HyperConverged default CPU model so new VMs inherit a compatible setting. Use a value from the survey above, leaning toward the newest common model to avoid giving up features needlessly:

   ```yaml
   apiVersion: kubevirt.io/v1
   kind: KubeVirt
   metadata:
     name: kubevirt
     namespace: kubevirt
   spec:
     configuration:
       cpuModel: Cascadelake-Server-v5   # example; substitute the intersection result
   ```

   Changing the default only affects VMs created afterwards. Existing VMs keep whatever `cpu.model` they were created with — including `host-model`, which is the thing causing the migration failure.

3. **Convert existing VMs away from `host-model`.** For each VM that needs to live-migrate, pin it to the common model:

   ```yaml
   spec:
     template:
       spec:
         domain:
           cpu:
             model: Cascadelake-Server-v5  # use the common model you picked
   ```

   Apply the change and schedule a graceful reboot of the VM (`virtctl restart`). Live migration will not succeed while the VM is still running against `host-model` — the existing libvirt process has already committed to the source's CPU generation.

4. **Avoid configuring `defaultCPUModel` to something only present in the migration labels.** If the chosen model is in `cpu-model-migration.node.kubevirt.io/<model>` but absent from `cpu-model.node.kubevirt.io/<model>` on every worker, new VMs will fail to schedule initially — the migration-compatibility set is *larger* than the native-run set on some QEMU versions.

5. **Plan the fleet upgrade path.** Adding a new generation of workers is a planning moment: pre-label them with the migration compatibility labels before scheduling VMs onto them. Otherwise the first drain of the old generation will find no migration target.

## Diagnostic Steps

Check the current CPU model of the failing VM:

```bash
kubectl -n <ns> get vm <vm> -o jsonpath='{.spec.template.spec.domain.cpu}{"\n"}'
# likely prints: {"cores":4,"model":"host-model"}
```

Look at each worker's migration labels for the model the VM demands:

```bash
MODEL=$(kubectl -n <ns> get vmi <vm> \
          -o jsonpath='{.status.currentCPUModel}')
echo "VM wants: $MODEL"

kubectl get node -l node-role.kubernetes.io/worker= \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.cpu-model-migration\.node\.kubevirt\.io/'"$MODEL"'}{"\n"}{end}'
```

Nodes that return `true` are valid targets; nodes that return an empty string are not. If no node returns `true`, the migration cannot succeed until the fleet is either labelled or the VM is repinned.

If all workers appear to have the label but migration still fails, check whether the target is under other constraints — taints, resource pressure, PDBs, or affinity rules that exclude it from this VM's candidate set:

```bash
kubectl get vmim -n <ns> <migration-object> -o yaml
kubectl describe vmi -n <ns> <vm>
```

Events on the VMI describe the scheduler's refusal more specifically than the generic "no node suitable" message.
