---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM live migration hangs at 99% when memory dirty rate exceeds bandwidth
## Issue

A live migration of a VirtualMachineInstance on ACP virtualization reports progress but never converges. The migration sits at roughly 99% for an extended period; `DataRemaining` and `MemoryRemaining` oscillate up and down rather than trending towards zero, and the `virt-launcher` source pod eventually logs an abort of the form `Live migration abort detected with reason: Live migration stuck for <N> sec`.

Representative source-pod log excerpt from `virt-launcher`:

```text
Migration info for <domain-uid>:
  TimeElapsed:561972ms DataProcessed:167182MiB DataRemaining:2350MiB
  DataTotal:24597MiB MemoryProcessed:167181MiB MemoryRemaining:2350MiB
  MemoryTotal:24596MiB MemoryBandwidth:38Mbps DirtyRate:41Mbps
  Iteration:80 PostcopyRequests:0 ConstantPages:1543059
  NormalPages:42711515 ...

Live migration stuck for 181006630894 sec
Live migration abort detected with reason: Live migration stuck for
  181004616448 sec and has been aborted
```

The `DirtyRate` in the log is consistently higher than the `MemoryBandwidth`, so pages are being dirtied faster than the copy stream can ship them to the destination node. The migration is effectively chasing its own tail.

## Root Cause

KubeVirt's default live-migration algorithm is **pre-copy**: memory pages are streamed to the destination while the VM keeps running on the source, with dirty pages resent iteratively until the remaining delta is small enough for a final brief pause ("cutover"). Convergence is only possible when, per iteration, bandwidth × time > dirty-bytes — in other words, when `MemoryBandwidth` exceeds `DirtyRate` for long enough to drive `MemoryRemaining` down to the cutover threshold.

For memory-intensive workloads (databases, caching tiers, VMs under heavy write load) the dirty rate can stay above the migration bandwidth ceiling for the full duration of the migration. Pre-copy then never converges; eventually KubeVirt's progress timeout fires and the migration is aborted. The symptom is exactly the `DataRemaining` oscillation seen in the log.

## Resolution

Give the migration a convergence strategy other than pure pre-copy. KubeVirt exposes three practical options; pick based on whether the VM is mid-migration, whether a brief pause is acceptable, and whether the change should apply cluster-wide or per-VM.

1. **Pause the running VM to force cutover.** For a migration that is already in progress and almost converged, temporarily pausing the source VM lets the final copy round finish because no more pages are dirtied. The VM auto-resumes on the destination once cutover completes. This imposes a short downtime window but requires no configuration change. Use `virtctl`:

   ```bash
   virtctl pause vm <name> -n <namespace>
   ```

2. **Enable post-copy as a cluster-wide fallback.** Post-copy flips the model: after a bounded pre-copy phase, the VM is resumed on the destination, and page faults for not-yet-shipped memory are pulled on demand across the network. This always converges for any dirty rate, at the cost of a brief period where the VM's memory latency depends on network round-trips.

   Post-copy is an OSS KubeVirt feature (`allowPostCopy` on the migration configuration) and is available on ACP virtualization. Turn it on at the KubeVirt cluster-config level:

   ```yaml
   apiVersion: kubevirt.io/v1
   kind: KubeVirt
   metadata:
     name: kubevirt
     namespace: <kubevirt-namespace>
   spec:
     configuration:
       migrations:
         bandwidthPerMigration: 64Mi
         completionTimeoutPerGiB: 800
         parallelMigrationsPerCluster: 5
         parallelOutboundMigrationsPerNode: 2
         progressTimeout: 150
         allowPostCopy: true
   ```

   Apply with:

   ```bash
   kubectl -n <kubevirt-namespace> edit kubevirt kubevirt
   ```

   After enabling post-copy, cancel any hung migration so the next retry picks up the new policy:

   ```bash
   kubectl -n <namespace> delete virtualmachineinstancemigration <name>
   ```

   Once post-copy is active, lowering `completionTimeoutPerGiB` in the same block accelerates the transition from pre-copy into post-copy — the pre-copy phase ends sooner and the VM resumes on the destination faster. The default timeout is tuned for converging pre-copy workloads; trimming it is what makes post-copy actually kick in for dirty VMs.

3. **Enable post-copy only for a specific VM with a MigrationPolicy.** When cluster-wide post-copy is too broad, a `MigrationPolicy` object selects individual VMs by label and applies a tailored migration configuration:

   ```yaml
   apiVersion: migrations.kubevirt.io/v1alpha1
   kind: MigrationPolicy
   metadata:
     name: my-vm-post-copy
   spec:
     allowPostCopy: true
     selectors:
       virtualMachineInstanceSelector:
         kubevirt.io/domain: <vm-domain-label>
   ```

   ```bash
   kubectl apply -f migrationpolicy.yaml
   ```

   KubeVirt matches each migration against the `MigrationPolicy` set and uses the first matching policy's settings in preference to cluster defaults.

For migrations that must complete during a drain (planned node maintenance, rolling upgrade of the hypervisor fleet), the generally safer option is post-copy enabled at the cluster level: it guarantees forward progress regardless of workload, so drains do not stall on a single busy VM. Where a bounded-downtime window is acceptable, the `virtctl pause` option is the least invasive.

## Diagnostic Steps

1. Confirm the migration is actually failing on convergence (rather than a network or storage error). Examine the `virt-launcher` source pod for the stuck VM:

   ```bash
   kubectl logs -n <namespace> <virt-launcher-source-pod> \
     | grep -E "Migration info|stuck|abort"
   ```

   Convergence failure shows `DirtyRate` greater than `MemoryBandwidth` and `MemoryRemaining` oscillating across iterations.

2. Check the `VirtualMachineInstanceMigration` object for the abort reason:

   ```bash
   kubectl -n <namespace> get virtualmachineinstancemigration
   kubectl -n <namespace> get virtualmachineinstancemigration <name> -o yaml \
     | sed -n '/status:/,$p'
   ```

3. Verify whether post-copy is permitted on the current cluster configuration:

   ```bash
   kubectl -n <kubevirt-namespace> get kubevirt kubevirt \
     -o jsonpath='{.spec.configuration.migrations.allowPostCopy}{"\n"}'
   ```

   An empty output or `false` means pre-copy is the only strategy the cluster will attempt.

4. After changing `allowPostCopy` or applying a `MigrationPolicy`, re-trigger the migration and watch the `Migration info` lines. A successful post-copy transition shows `PostcopyRequests` climbing from zero and `MemoryRemaining` completing instead of oscillating. `MemoryBandwidth` may temporarily drop after switchover because the VM is now paging on demand across the network — that is expected for the post-copy phase.

5. If `parallelMigrationsPerCluster` or `parallelOutboundMigrationsPerNode` is saturated during a node drain, migrations queue rather than abort. Inspect outstanding migrations cluster-wide:

   ```bash
   kubectl get virtualmachineinstancemigration -A
   ```

   Tune the migration parallelism limits in the KubeVirt `migrations` block to match the available cross-node bandwidth so queued VMs pick up the new policy promptly.
</content>
</invoke>