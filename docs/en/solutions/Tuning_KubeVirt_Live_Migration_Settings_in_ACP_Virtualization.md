---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Running virtual machines on the ACP virtualization stack (`docs/en/virtualization/`, built on KubeVirt) are migrated between nodes whenever the host goes into maintenance, is drained, or fails a health check. The default migration policy is deliberately conservative — two parallel outbound migrations per node, five in flight cluster-wide, a 150-second progress timeout, and auto-converge disabled — which suits a small mixed-workload cluster but becomes a bottleneck once many VMs share the cluster, or when a large VM's working set mutates faster than the migration pre-copy stream can converge.

Typical symptoms that warrant tuning:

- A rolling node drain takes hours because only two VMs per source node can move at once.
- A busy database VM never converges — `VirtualMachineInstanceMigration` objects report `Running` for a long period, then time out at the 150 s `progressTimeout` boundary and are retried from scratch.
- Migrations saturate the primary pod network and interfere with application traffic on the same interface.

## Root Cause

The KubeVirt control plane exposes live-migration knobs through the cluster-scoped operator CR. On ACP this is the HyperConverged-style CR that the virtualization operator reconciles; the subfield that carries the migration tunables is `spec.liveMigrationConfig`. Every running `virt-handler` DaemonSet pod reads that block at migration time and applies it to the `virt-launcher` pair it is coordinating.

The individual fields matter for different regimes:

- `parallelMigrationsPerCluster` / `parallelOutboundMigrationsPerNode` — concurrency caps. Raising them speeds up a drain at the cost of network and CPU headroom on the source host.
- `completionTimeoutPerGiB` — an upper bound on total migration time, scaled by VM memory size. A VM whose memory is changing faster than the pre-copy stream can keep up will otherwise never finish.
- `progressTimeout` — abort threshold when no forward progress is observed. Low values catch genuinely stuck migrations; high values let pre-copy finish on write-heavy workloads.
- `allowAutoConverge` — slows down the VM's vCPU when pre-copy is losing ground, letting the dirty-page rate fall under the send rate. Raises convergence probability but degrades guest latency for the duration of the migration.
- `allowPostCopy` — switches to a post-copy fault-in mode when pre-copy cannot converge. Fast but risky: a network partition during the post-copy phase loses the VM.
- `network` — selects a dedicated NetworkAttachmentDefinition so migration traffic does not compete with pod traffic on the primary interface.

## Resolution

Edit the hyperconverged CR and patch `spec.liveMigrationConfig`. The name of the CR and its namespace are produced by the virtualization operator install; on a typical ACP cluster they are `kubevirt-hyperconverged` in the virtualization operator namespace. Confirm the exact names on the cluster before patching:

```bash
kubectl get hyperconverged -A
```

Then patch the migration block. The example below widens concurrency, stretches the timeouts so large VMs have room to converge, enables auto-converge as a safety net, and routes migration traffic onto a dedicated network attachment named `migration-network`:

```bash
kubectl -n <hco-namespace> patch hyperconverged kubevirt-hyperconverged \
  --type=merge \
  -p '{
    "spec": {
      "liveMigrationConfig": {
        "allowAutoConverge": true,
        "allowPostCopy": false,
        "bandwidthPerMigration": "0Mi",
        "completionTimeoutPerGiB": 800,
        "parallelMigrationsPerCluster": 5,
        "parallelOutboundMigrationsPerNode": 2,
        "progressTimeout": 150,
        "network": "migration-network"
      }
    }
  }'
```

Key tuning guidance:

- **`bandwidthPerMigration: 0Mi`** means unthrottled. Cap it (`"64Mi"`, `"256Mi"`) only if migrations are observed to starve application traffic on the chosen network.
- **`parallelOutboundMigrationsPerNode`** is the per-source cap; raising it above four tends to saturate a single 10 GbE link with large VMs. Prefer adding a dedicated migration network over over-subscribing the primary one.
- **`completionTimeoutPerGiB`** defaults to 800 s/GiB. A 32 GiB VM with a busy workload may need this raised to 1200–1500 to converge. It is a soft multiplier, so raising it is cheap; lowering it below the default is not recommended.
- **Auto-converge vs post-copy**: enable `allowAutoConverge` first for write-heavy workloads. `allowPostCopy` is faster but a network blip mid-migration is fatal to the VM — only turn it on if the migration network is dedicated and reliable.

Per-VM overrides are possible through a `MigrationPolicy` CR that matches VMs by label and overrides the cluster default. Prefer this to bumping the cluster setting for a single VM family.

### Dedicated migration network

Migration traffic routed onto a secondary NetworkAttachmentDefinition requires:

1. An NAD named `migration-network` (matching the `network:` field above) in the same namespace the virt-handler runs in.
2. Pod network plumbing that lets virt-handler reach the peer virt-launcher on that NAD. ACP's Kube-OVN CNI supports multi-network via Multus for this pattern.
3. Equivalent MTU on both endpoints of the NAD — migrations are bulk transfers and suffer heavily from path MTU discovery failures.

Verify the setting stuck and the operator has reconciled it:

```bash
kubectl -n <hco-namespace> get hyperconverged kubevirt-hyperconverged \
  -o jsonpath='{.spec.liveMigrationConfig}{"\n"}'
```

## Diagnostic Steps

Trigger a migration and watch the VMI migration object report back:

```bash
kubectl -n <vm-namespace> create -f - <<EOF
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstanceMigration
metadata:
  generateName: migrate-${VM_NAME}-
spec:
  vmiName: ${VM_NAME}
EOF

kubectl -n <vm-namespace> get vmim -w
```

Follow the two virt-launcher pods (source and target) as migration proceeds:

```bash
kubectl -n <vm-namespace> get pod -l vm.kubevirt.io/name=${VM_NAME} -o wide
```

Inspect the VMI's migration state for why a migration ended the way it did:

```bash
kubectl -n <vm-namespace> get vmi ${VM_NAME} \
  -o jsonpath='{.status.migrationState}{"\n"}'
```

Fields that commonly explain failures:

- `.failed: true` with `.failureReason: "Live migration didn't converge"` — raise `completionTimeoutPerGiB`, enable `allowAutoConverge`, or both.
- `.failed: true` with `"timeout reached while attempting migration"` — raise `progressTimeout`.
- `.mode: PostCopy` observed while `allowPostCopy: false` — reconciliation race; re-read the CR to confirm the field is actually set.

Node-level view of concurrency at the source:

```bash
kubectl get vmim -A \
  -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.status.migrationState.sourceNode}{"\n"}{end}' \
  | sort | uniq -c
```

Any source node with more in-flight migrations than `parallelOutboundMigrationsPerNode` is the wrong direction — the operator may not have rolled the change to virt-handler yet; restart the DaemonSet pods on that node if the discrepancy persists.
</content>
</invoke>