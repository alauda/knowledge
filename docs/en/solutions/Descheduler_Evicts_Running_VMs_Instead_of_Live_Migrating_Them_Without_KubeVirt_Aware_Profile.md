---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The descheduler is running on a cluster that also hosts virtual machines (ACP Virtualization, upstream KubeVirt, or an equivalent deployment). An alert similar to `HCOMisconfiguredDescheduler` (or the vendor-neutral equivalent: misconfigured-descheduler-for-KubeVirt) fires warning that the descheduler's current profile is not safe for VM workloads. The operational symptoms that follow are:

- Running VMs occasionally restart on another node instead of being **live-migrated** when the descheduler evicts their `virt-launcher` pod.
- Some long-running VMs resist eviction entirely because their `virt-launcher` pod ignores the descheduler's eviction attempt, leading to repeated no-op eviction loops in the descheduler log.

This is a configuration problem, not a bug in either component — the default descheduler profiles are built for stateless pods and do not know how to let KubeVirt handle a VM's relocation through its own live-migration path.

## Root Cause

The descheduler uses the standard Kubernetes eviction API to reshape the workload across nodes. For a normal Deployment-managed pod, eviction → delete → reschedule is harmless (or even the whole point). For a VM represented as a `virt-launcher` pod, an eviction **must** trigger a live migration: the VM keeps running on a new node with the guest state intact. A plain eviction instead terminates the pod, losing any guest state that was not persisted, and the VM restarts cold on the destination.

KubeVirt expresses this by marking `virt-launcher` pods with an `evictionStrategy: LiveMigrate` (on the VM object) and implementing the eviction hand-off itself: the descheduler asks to evict, KubeVirt intercepts, a live migration is triggered, and only after the VM has reached the target does the source pod actually terminate.

Three descheduler profile configurations cooperate with that contract correctly:

- `KubeVirtRelieveAndMigrate` — the current preferred profile on recent descheduler releases. Purpose-built for KubeVirt workloads; pairs descheduler's "relieve pressure" strategies with VM migration.
- `DevKubeVirtRelieveAndMigrate` — the development/preview variant of the above, available on earlier descheduler versions before the stable profile shipped.
- `LongLifecycle` with the `profileCustomizations.devEnableEvictionsInBackground: true` knob — the legacy path used before any KubeVirt-aware profile existed. `devEnableEvictionsInBackground` lets the descheduler run its eviction loop asynchronously so long-running pods (VMs) do not block the descheduler's main reconciliation.

The alert fires when none of these are configured. Any other profile (`AffinityAndTaints`, `TopologyAndDuplicates`, `HighNodeUtilization` on their own) will do the wrong thing on a VM-hosting cluster.

## Resolution

Reconfigure the descheduler CR (the `KubeDescheduler` resource managed by the descheduler operator) to use a VM-aware profile. The exact one depends on which descheduler release is installed. Check which values the CRD accepts:

```bash
kubectl get crd $(kubectl get crd -o name | grep -i kubedescheduler | head -1 | cut -d/ -f2) -o json | \
  jq '.spec.versions[] | select(.name=="v1").schema.openAPIV3Schema.properties.spec.properties.profiles.items.enum[]'
```

The enum printed is the complete list of profiles the installed descheduler recognises. Pick from that list in this order of preference:

1. **`KubeVirtRelieveAndMigrate`** (recommended on recent releases):

   ```yaml
   apiVersion: operator.acp.io/v1   # substitute the apiVersion used by the installed descheduler CRD
   kind: KubeDescheduler
   metadata:
     name: cluster
     namespace: descheduler-operator
   spec:
     profiles:
       - KubeVirtRelieveAndMigrate
   ```

2. **`DevKubeVirtRelieveAndMigrate`** — pick this only if `KubeVirtRelieveAndMigrate` is not in the enum:

   ```yaml
   spec:
     profiles:
       - DevKubeVirtRelieveAndMigrate
   ```

3. **`LongLifecycle` + `devEnableEvictionsInBackground`** — legacy fallback when neither of the above is available:

   ```yaml
   spec:
     profiles:
       - LongLifecycle
     profileCustomizations:
       devEnableEvictionsInBackground: true
   ```

Apply with `kubectl apply -f <file>` and wait for the descheduler pods to restart. The descheduler operator reconciles the change — no manual restart is required.

### When no supported profile is available

On a cluster where the descheduler is older than any of the profiles above and cannot be upgraded (for whatever operational reason), the only safe option is to **uninstall the descheduler** on that cluster. Running the descheduler with a stateless-pod profile alongside VMs risks cold restarts of production guests — worse than no descheduler at all. Remove the `KubeDescheduler` CR (or the operator itself) and revisit after the platform is upgraded.

### ACP Virtualization note

ACP Virtualization exposes the VM-aware descheduler profile through its standard platform surface; check the `virtualization` documentation for whether the `KubeDescheduler` resource is managed by the virtualization operator directly or needs to be set by the cluster administrator. The CR shape on the wire is the same regardless.

## Diagnostic Steps

1. **Confirm the alert is about the descheduler's profile.** The warning message will refer to KubeVirt / VMs not being safely handled — if the body is a different eviction-related alert, stop here, the fix below does not apply.

2. **Print the current profile configuration.**

   ```bash
   kubectl get KubeDescheduler cluster \
     -n descheduler-operator -o yaml
   ```

   Look at `spec.profiles` and `spec.profileCustomizations`. If neither `KubeVirtRelieveAndMigrate` / `DevKubeVirtRelieveAndMigrate` is listed and there is no `LongLifecycle` + `devEnableEvictionsInBackground` combination, the cluster is in the misconfigured state.

3. **List the available profile names** (as above):

   ```bash
   kubectl get crd $(kubectl get crd -o name | grep -i kubedescheduler | head -1 | cut -d/ -f2) -o json | \
     jq '.spec.versions[] | select(.name=="v1").schema.openAPIV3Schema.properties.spec.properties.profiles.items.enum[]'
   ```

4. **Confirm VMs are actually being migrated after the fix.** The descheduler logs its eviction attempts and KubeVirt logs the resulting migrations. After the profile change, observe at least one live migration triggered by descheduler pressure:

   ```bash
   kubectl -n descheduler-operator logs deploy/descheduler --tail=200 | grep -i evict
   kubectl get vmim -A --watch
   ```

   A `vmim` object appearing shortly after an eviction decision in the descheduler log confirms the hand-off is working.

5. **If evictions still terminate VMs instead of migrating,** check the VM object itself:

   ```bash
   kubectl -n <ns> get vm <vm> -o jsonpath='{.spec.evictionStrategy}{"\n"}'
   ```

   A value of `LiveMigrate` is required for KubeVirt to intercept the eviction. If the field is empty, set it on the VM (or at the cluster default level in the KubeVirt CR) so migration is the response to eviction.
