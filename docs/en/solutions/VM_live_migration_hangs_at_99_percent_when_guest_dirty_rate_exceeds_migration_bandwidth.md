---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM live migration hangs at 99 percent when guest dirty rate exceeds migration bandwidth

## Issue

On Alauda Container Platform running KubeVirt v1.7.0-alauda.2 (HCO operator 1.17.0, CSV `kubevirt-hyperconverged-operator.v4.3.6`, ns `kubevirt`) on Kubernetes v1.34.5, a `VirtualMachineInstanceMigration` (`kubevirt.io/v1`) reports progress but does not converge. Migration time-elapsed climbs, `DataRemaining` and `MemoryRemaining` oscillate up and down across iterations instead of monotonically falling, and the source `virt-launcher` pod eventually logs the migration was aborted as stuck.

The per-iteration progress JSON is emitted by the source `virt-launcher` from `live-migration-source.go:736` on this build (the upstream KubeVirt v1.7.0 source line shifted from earlier `:780`); fields include `TimeElapsed`, `DataProcessed`, `DataRemaining`, `DataTotal`, `MemoryProcessed`, `MemoryRemaining`, `MemoryTotal`, `MemoryBandwidth`, `DirtyRate`, `Iteration`, `PostcopyRequests`, `ConstantPages`, `NormalPages`, `NormalData`, `ExpectedDowntime`, `DiskMbps`. A direct on-cluster repro on this build emitted the following line during a busy-guest migration test:

```text
Migration info for <uuid>: TimeElapsed:8061ms DataProcessed:908MiB
  DataRemaining:0MiB DataTotal:2352MiB MemoryProcessed:619MiB MemoryRemaining:0MiB
  MemoryTotal:2064MiB MemoryBandwidth:320Mbps DirtyRate:9385Mbps Iteration:12
  PostcopyRequests:0 ...
```

`DirtyRate=9385Mbps` against `MemoryBandwidth=320Mbps` is the convergence signature the article describes: guest writes outpace the per-iteration copy budget. On a fast link a small guest still converges in a few iterations (above example completed in 8 s), but a large or write-busier guest keeps oscillating and eventually hits KubeVirt's progress timeout.

## Root Cause

KubeVirt's default migration method is pre-copy: memory pages stream to the destination while the VM keeps running on the source, and dirty pages are resent each iteration until the remaining delta is small enough to cut over within the configured downtime budget. The HCO singleton `kubevirt-hyperconverged` (in ns `kubevirt`) carries `.spec.liveMigrationConfig` with defaults `allowPostCopy=false`, `completionTimeoutPerGiB=150`, `progressTimeout=150`, so the cluster will only attempt pre-copy and will give up once the per-GiB completion or progress budget is exhausted.

When `DirtyRate` stays above `MemoryBandwidth` for the full pre-copy window, no iteration ever brings `MemoryRemaining` below the cutover threshold; iteration count climbs, the same dirty pages are recopied, and the budget expires without convergence.

The `HyperConverged` openAPIV3Schema documents this exact knob and its semantics on this build: `completionTimeoutPerGiB` is "calculated based on completionTimeoutPerGiB times the size of the guest ... Use a lower completionTimeoutPerGiB to induce quicker failure, so that another destination or post-copy is attempted. Use a higher completionTimeoutPerGiB to let workload with spikes in its memory dirty rate to converge"; `allowPostCopy` is "When enabled, KubeVirt attempts to use post-copy live-migration in case it reaches its completion timeout while attempting pre-copy live-migration. Post-copy migrations allow even the busiest VMs to successfully live-migrate".

## Resolution

Three convergence strategies are available; on this ACP build only the first two are functional today. The MigrationPolicy override path is structurally present and applied by the migration controller, but post-copy itself currently fails at the QEMU layer on this build (see the post-copy note below).

### 1. Pause the VM mid-migration to force cutover

For a migration already in flight that is close to converging (small `MemoryRemaining`, oscillating only slightly), pausing the guest stops new pages from being dirtied. The next pre-copy round therefore completes, and KubeVirt cuts over to the destination, at which point the guest is automatically resumed on the destination — no manual unpause. The subresource is exposed by the kubevirt aggregated API as `virtualmachineinstances/pause` (verb PUT) and is reachable via the kubevirt CLI plugin:

```bash
virtctl pause vm <vmi-name> -n <namespace>
```

This costs a short downtime window for the final memory transfer but requires no cluster-level configuration change.

### 2. Lower `completionTimeoutPerGiB` on the HyperConverged singleton

Shortening the per-GiB completion window does not enable post-copy on its own, but it makes the migration controller declare convergence-failure faster, so the operator (or the drain controller) knows sooner that this VM needs a different strategy. The CRD documentation on this build calls out exactly this use ("induce quicker failure, so that another destination or post-copy is attempted"):

```bash
kubectl patch hyperconverged -n kubevirt kubevirt-hyperconverged \
  --type merge \
  -p '{"spec":{"liveMigrationConfig":{"completionTimeoutPerGiB":30}}}'
```

The HCO singleton is `kubevirt-hyperconverged` in ns `kubevirt` on this build (HCO reconciles the change down into the KubeVirt CR). The change applies cluster-wide and to all subsequent migrations; in-flight migrations are not retro-fitted.

### 3. Scope migration overrides to one namespace or VM via `MigrationPolicy`

A `MigrationPolicy` (`migrations.kubevirt.io/v1alpha1`, cluster-scoped) selects a subset of VMs by label and applies a tailored live-migration configuration. The reconciler stamps the chosen policy onto `vmim.status.migrationState.migrationPolicyName` and merges `migrationState.migrationConfiguration` from the policy's fields on top of the HCO defaults:

```yaml
apiVersion: migrations.kubevirt.io/v1alpha1
kind: MigrationPolicy
metadata:
  name: busy-vm-policy
spec:
  completionTimeoutPerGiB: 30
  allowPostCopy: true
  selectors:
    namespaceSelector:
      kubernetes.io/metadata.name: my-vm-namespace
    virtualMachineInstanceSelector:
      workload-class: write-heavy
```

```bash
kubectl apply -f migrationpolicy.yaml
```

The supported tunables on `MigrationPolicy.spec` are `allowAutoConverge`, `allowPostCopy`, `allowWorkloadDisruption`, `bandwidthPerMigration`, and `completionTimeoutPerGiB`; the supported selectors are `namespaceSelector` and `virtualMachineInstanceSelector` (label maps) — verified directly against the CRD shape on this build. A migration's `status.migrationState.migrationConfiguration` reflects the merged policy values once the policy is in effect, which is the audit-trail confirming the override took.

### Note on post-copy on this build

Although `allowPostCopy=true` is accepted by both `HyperConverged.spec.liveMigrationConfig` and by `MigrationPolicy.spec`, the actual post-copy switchover currently **fails at the QEMU layer** on this ACP build. An on-cluster repro that applied `allowPostCopy: true` via a MigrationPolicy and triggered a migration of a busy guest produced:

```text
internal error: unable to execute QEMU command 'migrate-set-capabilities':
Postcopy is not supported: Userfaultfd not available: Operation not permitted
```

The `vmim.status.migrationState.failureReason` carries this exact error, the migration's `mode` stays `PreCopy`, the VMI never moves to the destination, and `phase` transitions to `Failed`.

Root cause of this failure is an upstream Linux + container-runtime interaction: post-copy migration relies on the kernel's `userfaultfd(2)` mechanism to demand-page guest memory from the source, and per upstream Linux policy creating a userfaultfd requires the `CAP_SYS_PTRACE` capability when the node sysctl `vm.unprivileged_userfaultfd` is set to `0`. The KubeVirt seccomp profile shipped at `/var/lib/kubelet/seccomp/kubevirt/kubevirt.json` does allow the `userfaultfd` syscall (`SCMP_ACT_ALLOW`), but the `virt-launcher` compute container's capability set on this build does not include `CAP_SYS_PTRACE`, so the capability check rejects the call before the seccomp filter is consulted. Until either (a) the node sysctl is set to `vm.unprivileged_userfaultfd=1`, or (b) the virt-launcher compute container is granted `CAP_SYS_PTRACE`, `allowPostCopy=true` is structurally accepted by KubeVirt's API surface but the CRD-documented post-copy switchover does not take effect on this build.

Practically, that means options 1 (pause mid-migration) and 2 (shorter completion-timeout to fail-fast and retry) are the working levers today; option 3's MigrationPolicy selector mechanism still works for the non-post-copy tunables (`allowAutoConverge`, `bandwidthPerMigration`, `completionTimeoutPerGiB`).

## Diagnostic Steps

Inspect the current cluster-wide live-migration policy on the HCO singleton — values here apply by default to every migration on the cluster:

```bash
kubectl get hyperconverged -n kubevirt kubevirt-hyperconverged \
  -o jsonpath='{.spec.liveMigrationConfig}{"\n"}'
```

List the per-migration tracking objects across the cluster. `VirtualMachineInstanceMigration` lives in the same namespace as its target VMI; `.status.phase` shows the migration lifecycle and `.status.migrationState.sourcePod` names the source virt-launcher pod that hosts the migration log lines:

```bash
kubectl get vmim -A
```

For a stuck migration, pull the per-iteration progress JSON from the source virt-launcher to see if the workload is convergence-bound. A non-converging migration shows `DirtyRate` higher than `MemoryBandwidth` and `MemoryRemaining` flat or oscillating across iterations:

```bash
kubectl logs -n <vmi-ns> <virt-launcher-source-pod> -c compute \
  | grep -E 'Migration info|Live migration stuck|Live migration abort'
```

Read the merged migration configuration the controller actually applied to the in-flight migration. If a `MigrationPolicy` matched, this is where its overrides show up; if not, these are the HCO defaults:

```bash
kubectl get vmim -n <vmi-ns> <vmim-name> \
  -o jsonpath='{.status.migrationState.migrationConfiguration}{"\n"}'
kubectl get vmim -n <vmi-ns> <vmim-name> \
  -o jsonpath='migrationPolicy={.status.migrationState.migrationPolicyName}{"\n"}'
```

After enabling `allowPostCopy` (cluster-wide or via MigrationPolicy), inspect the next migration's `vmim.status.migrationState` for either `mode: PostCopy` (success) or the `failureReason` quoted above (the userfaultfd capability gate on this build). The MigrationPolicy applied correctly when `migrationPolicyName` and `migrationConfiguration.allowPostCopy: true` both appear in the merged state, even if the QEMU layer then rejects the capability negotiation.

Cancel any in-flight migration before re-issuing it under new settings — a running migration is not retro-fitted with the new `liveMigrationConfig` values; the next `VirtualMachineInstanceMigration` created after the change is the one that picks them up:

```bash
kubectl delete vmim -n <vmi-ns> <stuck-vmim-name>
```
