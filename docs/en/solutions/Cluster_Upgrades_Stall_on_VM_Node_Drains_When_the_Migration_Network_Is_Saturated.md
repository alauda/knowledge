---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Cluster Upgrades Stall on VM Node Drains When the Migration Network Is Saturated
## Issue

A cluster upgrade stalls when the upgrade controller tries to drain a node that hosts ACP Virtualization workloads. The drain proceeds quickly for ordinary pods but gets stuck evicting the VMs: live migrations start, make progress for a while, and then fail to converge — the VM stays on the source node and the node cannot be taken out of service.

Each affected VM's migration shows a dirty-page rate (rate at which the VM's guest memory changes) higher than the migration network's transfer bandwidth. Live migration cannot complete because the source VM is writing pages faster than the network can copy them to the target host, so the final switchover window never opens. The upgrade controller gives up after its drain timeout, moves on with a half-drained node, or pauses the whole upgrade.

## Root Cause

Live migration needs two invariants before the VM switches hosts:

1. A consistent snapshot of the guest's memory has been copied to the target host.
2. The remaining *dirty* memory can be copied within the configured downtime budget — the short window during which the VM is paused for the final byte-for-byte reconciliation.

A busy VM dirties pages continuously. The migration engine sends pages, then reacts to the dirty bitmap by resending the pages that changed while it was sending the first pass, and iterates until the remaining dirty set fits inside the downtime budget. If the dirty rate ever exceeds the network's transfer rate, the engine never catches up: each pass of the copy leaves more dirty than the last finished, and the migration never converges.

On a dedicated high-bandwidth migration network (10 Gbps+, ideally a physically-separate fabric), typical VMs converge easily. On a shared data-plane network that also carries pod traffic, live migrations compete with application traffic; under sustained load the migration bandwidth is a fraction of the nominal link speed and busy VMs can outrun it.

The durable fix is a dedicated migration network with sufficient bandwidth. When that is not possible in the timeframe of a pending upgrade, the migration engine's knobs offer a trade-off: accept a longer guest pause in exchange for convergence.

## Resolution

### Durable fix — dedicated migration network

Configure a dedicated migration network sized for the cluster's VM population. The platform's virtualization configuration exposes this as a `HyperConverged`/virt-operator field (details depend on the operator version). Point it at a physical network capable of saturating the expected migration traffic — 10 Gbps is a common baseline, 25/100 Gbps for clusters hosting memory-heavy VMs.

After a dedicated network is in place, re-run the problematic migration. Convergence should be routine. The `virtctl`/`virsh domjobinfo` output (see Diagnostic Steps) shows the migration copy rate ramp up to the dedicated network's capacity rather than the shared-fabric fraction.

### Tuning fix — raise the per-migration downtime budget

If network changes cannot happen in time for the upgrade, raise the acceptable switchover downtime so the migration engine can converge by pausing the VM longer during the final sync. The default downtime budget is conservative (hundreds of milliseconds) to minimise guest disruption; raising it to a few seconds accepts a short guest pause in exchange for the migration actually completing.

Drive this through the migration's `virsh migrate-setmaxdowntime` for running migrations in progress:

```bash
# Find VMs currently migrating.
kubectl get virtualmachineinstancemigrations -A -o json | \
  jq -r '.items[] | select(.status.phase=="Running") |
         "\(.metadata.namespace) \(.status.migrationState.sourcePod) \(.metadata.name)"'
```

For each in-progress migration, set a larger downtime in the source `virt-launcher`:

```bash
# 5000 ms downtime — busy VMs that did not converge at the default usually do at 5s.
kubectl exec -n <ns> <virt-launcher-pod> -- \
  virsh migrate-setmaxdowntime 1 5000
```

The migration ID in `virsh` is `1` for the active migration inside a `virt-launcher` pod. Use a helper script to apply this to every active migration in a loop during the upgrade:

```bash
while true; do
  kubectl get virtualmachineinstancemigrations -A -o json | \
    jq -r '.items[] | select(.status.phase=="Running") |
           "\(.metadata.namespace) \(.status.migrationState.sourcePod) \(.metadata.name)"' | \
  while read -r ns pod vm; do
    kubectl exec -n "$ns" "$pod" -- virsh migrate-setmaxdowntime 1 5000 >/dev/null 2>&1 \
      && echo "Set downtime=5s on $vm"
  done
  sleep 10
done
```

Run this on a bastion host with cluster access for the duration of the upgrade. Leave it running until every VM has migrated off the drained nodes; stop it once the upgrade completes so the cluster reverts to the default downtime budget for steady-state migrations.

Very busy or memory-heavy VMs may need a larger value (10s, occasionally 30s). Start at 5s and raise only for the specific VMs that still fail to converge.

### Switch migration policy to PostCopy — limited applicability

The VM operator supports a `PostCopy` migration policy that, after a fixed timeout, flips the VM to run on the target while pages are still being copied on-demand. It works well for individual migrations that are pathologically slow, but it does not help with node drains: the switch to PostCopy happens only after the migration has **timed out** on the normal (pre-copy) path, so each VM still consumes its full timeout before draining. For upgrade-driven drains, the `migrate-setmaxdowntime` approach acts immediately and is more useful.

### AutoConverge — also limited

AutoConverge throttles guest CPU while a migration is in progress to reduce the dirty-page rate. It can help if the dirty rate is CPU-limited on the guest side, but the throttle may slow the guest excessively on memory-intensive workloads. Combine cautiously with the downtime tuning above, and never on latency-critical VMs.

### Last resort — shut down or quiesce the VMs

If no amount of tuning converges a migration, the only remaining option is to shut down (or significantly reduce the workload of) the VM before the upgrade starts that node's drain. A stopped VM drains in the time it takes the kubelet to evict the pod; the cost is a workload outage that the in-guest application has to accept.

## Diagnostic Steps

Confirm the dirty-page rate is indeed exceeding the migration bandwidth. `virsh domjobinfo` on the source `virt-launcher` prints both:

```bash
kubectl get virtualmachineinstancemigrations -A -o json | \
  jq -r '.items[] | select(.status.phase=="Running") |
         "\(.metadata.namespace) \(.status.migrationState.sourcePod) \(.metadata.name)"' | \
while read -r ns pod vm; do
  echo "--> $vm"
  kubectl exec -n "$ns" "$pod" -- virsh domjobinfo 1 | \
    grep -E 'Memory (bandwidth|processed|remaining)|Dirty rate|Downtime'
done
```

Compare `Dirty rate` (KiB/s) against `Memory bandwidth` (KiB/s). A dirty rate persistently higher than the bandwidth is the signature of a non-converging migration. `Memory remaining` staying flat or growing across successive polls confirms it.

Check whether the migration network is saturated by something other than the migration itself. On the node hosting the source VM:

```bash
NODE=<source-node>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c '
    ifstat -b 1 3   # 3 samples of bandwidth per interface, bits/sec
  '
```

If a non-migration interface is near its link capacity while the migration interface shows modest throughput, the bandwidth is being consumed by pod traffic or replication. Dedicate a network as described above.

After applying the downtime tuning, re-poll `domjobinfo` and look for `Memory remaining` trending to zero. Once the remaining dirty pages fit inside the configured downtime budget, the migration completes and the source node can be drained. Expect the final `Downtime` field to reflect the value set (up to 5s in the example above).
