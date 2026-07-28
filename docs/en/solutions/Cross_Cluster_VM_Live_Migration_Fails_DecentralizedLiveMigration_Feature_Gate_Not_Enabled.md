---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Cross-Cluster VM Live Migration Fails — DecentralizedLiveMigration Feature Gate Not Enabled
## Issue

When using the VMware-migration workflow (or any cross-cluster KubeVirt migration path) to live-migrate a Virtual Machine between two ACP Virtualization clusters, plan creation is rejected by a KubeVirt admission webhook with the following signature:

```text
admission webhook "migration-create-validator.kubevirt.io" denied the request:
DecentralizedLiveMigration feature gate is not enabled in kubevirt resource
```

Even if an operator has toggled the feature gate on the cluster's top-level virtualization CR, the migration plan still fails. Some plans instead progress partway and then hang indefinitely in a `WaitForStateTransfer` phase.

## Root Cause

Cross-cluster live migration in KubeVirt relies on a multi-piece control plane:

- the `DecentralizedLiveMigration` feature gate on the `KubeVirt` CR of **both** source and target clusters,
- a `VirtualMachineInstanceMigration` handshake that crosses cluster boundaries (the "state transfer" phase),
- the underlying libvirt / virt-handler negotiation that agrees on a target node to receive the VMI.

On the `Technology Preview` generation of cross-cluster migration (the code that first shipped the feature behind a gate), three restrictions apply simultaneously:

1. The gate must be enabled on the virtualization top-level CR before any component reads it — if the gate is flipped after the source and target controllers are running, those controllers keep the pre-flip config and continue rejecting plans. A restart of the virt-controller pods is required for the new gate value to take effect. The admission webhook message is literally correct: from its point of view the gate is not enabled for *this* request.
2. In the Tech Preview generation, the workflow depends on a workload-migration controller (the container-migration tooling), which added operational fragility: a migration plan can be admitted but then stall in `WaitForStateTransfer` because two separate controllers have to hand the VM state back and forth.
3. Once the feature reached general availability in the next minor release, the dependency on the separate container-migration controller was removed and the transfer became fully owned by the virtualization stack. Plans no longer stall in `WaitForStateTransfer` for the same reason.

So there are two distinct failure modes under the same symptom: (a) the gate is not actually observed by the running controllers; (b) the plan enters state transfer but the container-migration dependency either isn't healthy or isn't present.

## Resolution

### Preferred path — run ACP Virtualization at a version where cross-cluster live migration is GA

Cross-cluster live migration is designated Technology Preview in the generation where the `DecentralizedLiveMigration` gate first appears. Upgrade both clusters (source and target) to the release where the feature is GA and the workflow no longer depends on an external container-migration controller. After the upgrade:

- the `DecentralizedLiveMigration` behaviour is enabled by default without a feature-gate toggle,
- `VirtualMachineInstanceMigration` transitions directly between the two clusters,
- `WaitForStateTransfer` resolves within the normal transfer window (seconds to minutes depending on memory size and network bandwidth),
- the VMware-migration workflow reuses the same underlying plumbing for its live cold-switchover handoff, so migration plans that were failing at plan-create succeed without code changes.

Verify the upgrade on both sides before retrying the plan:

```bash
kubectl -n <virt-ns> get kubevirts.kubevirt.io -o jsonpath='{.items[*].status.observedKubeVirtVersion}{"\n"}'
kubectl -n <virt-ns> get virtualmachineinstances.kubevirt.io -A | head
```

### Workaround when an upgrade isn't yet possible

If both clusters are still on the Tech Preview generation, all three conditions must hold:

1. **Gate enabled on the `KubeVirt` CR on source and target.** Confirm with:

   ```bash
   kubectl -n <virt-ns> get kubevirt kubevirt -o jsonpath='{.spec.configuration.developerConfiguration.featureGates}{"\n"}'
   ```

   The list must include `DecentralizedLiveMigration`.

2. **Virt-controller and virt-api rollout after flipping the gate.** Restart the controller Deployment so the new config is picked up:

   ```bash
   kubectl -n <virt-ns> rollout restart deploy virt-controller
   kubectl -n <virt-ns> rollout restart deploy virt-api
   ```

   Wait for both to return `READY`. Until this rollout completes, admission of new migration plans will continue to reject with the "feature gate is not enabled" message.

3. **The separate container-migration controller is reachable from both clusters.** On Tech Preview, the cross-cluster transfer depends on this controller to coordinate state hand-off. Its controller pod must be healthy on each side, and the two sides must be able to reach the transfer endpoint the other cluster exposes. A plan that reaches `WaitForStateTransfer` and stays there is almost always this leg failing: check the controller log, then the inter-cluster networking (cluster egress, TLS handshake, and any intermediate firewall).

Plans that consistently succeed after the upgrade path and consistently fail on the Tech Preview path are the expected shape — running two different clusters on the GA generation is the supported configuration for cross-cluster live migration going forward.

## Diagnostic Steps

1. Capture the webhook rejection message exactly — the text of the admission denial changed between generations and tells you which controller is vetoing:

   ```bash
   kubectl -n <plan-ns> get virtualmachinemigrations.forklift.konveyor.io <plan> \
     -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}{"\n"}'
   ```

2. Check the gate value as the controllers see it (not as the spec claims):

   ```bash
   kubectl -n <virt-ns> logs deploy/virt-controller \
     | grep -i DecentralizedLiveMigration | tail
   ```

   If the logs don't mention the gate after a restart, the virt-controller did not reload — repeat the rollout.

3. If the plan reaches `WaitForStateTransfer`, trace the transfer leg on both sides:

   ```bash
   kubectl -n <virt-ns> get virtualmachineinstancemigrations.kubevirt.io -A
   kubectl -n <virt-ns> logs deploy/virt-handler -l kubevirt.io=virt-handler \
     | grep -iE 'decentralized|state.transfer|cross.cluster' | tail
   ```

   A transfer that never starts indicates the container-migration controller leg is unhealthy or unreachable; a transfer that starts and then stalls indicates the network or TLS path between clusters is degraded.

4. Compare versions on both sides — an asymmetric pair (one cluster on Tech Preview, one on GA) is a known unsupported configuration for this path:

   ```bash
   kubectl -n <virt-ns> get kubevirt kubevirt -o jsonpath='{.status.observedKubeVirtVersion}{"\n"}'
   ```

Matching versions at or above the GA cut-off resolve the entire class of failures without individual knob-twisting. Treat the Tech Preview workaround as a stopgap, not a steady state.
