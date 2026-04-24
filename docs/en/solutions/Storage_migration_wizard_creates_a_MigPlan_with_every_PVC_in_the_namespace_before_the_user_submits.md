---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On ACP Virtualization, opening the **Migration > Storage** wizard in the web console creates a `MigPlan` Custom Resource immediately — before the user fills in any fields or clicks **Create**. The mig-controller reconciles the empty-shaped plan by sweeping in every `PersistentVolumeClaim` in the target namespace.

If any other `MigPlan` already exists for that namespace, the new auto-created plan collides with it because both plans try to map the same PVCs. The second plan ends up stuck in a `Pending` state with validation errors, and subsequent attempts to create new plans for that namespace also fail validation until the stray plan is cleared.

Symptom line, from a `MigPlan` listing for the namespace:

```bash
kubectl -n <migration-namespace> get migplan
```

Output shows two or more plans for the same namespace, at least one of them in a non-Ready state with a `Conflict` condition referencing overlapping PVC mappings.

## Root Cause

The storage migration wizard posts a `MigPlan` CR as soon as the wizard is opened, to back the UI state. The controller reconciles any `MigPlan` it sees, regardless of whether the UI has finished filling it in. Because the controller's default when the plan has no explicit PVC list is "include all PVCs in the namespace", the stub plan immediately expands to reference every volume in the namespace.

If another `MigPlan` already references those PVCs — for example, an earlier in-progress migration or a plan that was left behind from a previous session — the validation logic fires a conflict. The conflict is raised *after* the CR has already been admitted, so the object is not rolled back; it stays in the cluster in a failed state. From then on, any fresh plan the user tries to create for that namespace hits the same conflict because the half-configured stub is still holding the PVC mappings.

## Resolution

Two things to do in order: clean up the stray plan, then keep it from coming back.

### Clean up the stray MigPlan

Delete any `MigPlan` resources in the migration namespace that were created by the wizard and never completed. List them first to be sure you are not deleting an in-progress migration:

```bash
kubectl -n <migration-namespace> get migplan \
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,READY:.status.conditions[?(@.type==\"Ready\")].status
```

Identify the plans whose `Ready` condition is `False` with a conflict reason, or whose age matches the wizard-open time. Then remove them:

```bash
kubectl -n <migration-namespace> delete migplan <plan-name>
```

If the namespace is known to contain only stale plans and nothing is actively migrating, it is safe to delete them all at once:

```bash
kubectl -n <migration-namespace> delete migplan --all
```

Once the conflicting plan is gone, retry the new plan either through the wizard or directly by applying a hand-written `MigPlan` YAML — the validation passes because there is no longer an overlapping PVC mapping.

### Prevent the premature creation

The long-term fix is in the UI / controller layer: the wizard should stage the plan locally and only POST on submission. Once that fix lands, simply upgrading the virtualization component removes the behaviour.

Until then, two practical mitigations:

1. **Create plans via the API, not the wizard.** Author the `MigPlan` YAML by hand (or as part of a GitOps manifest) and apply it with `kubectl apply`. The wizard's side-effect only fires when the wizard is opened in the console, so bypassing it cleanly avoids the race:

   ```yaml
   apiVersion: migration.<group>/v1alpha1
   kind: MigPlan
   metadata:
     name: <plan-name>
     namespace: <migration-namespace>
   spec:
     # explicit persistentVolumeClaims list here — not the namespace-wide sweep
     persistentVolumeClaims:
       - name: <pvc-name>
         namespace: <workload-namespace>
     # ... rest of the plan (source/destination, destination namespace, etc.)
   ```

2. **If the wizard must be used**, open it only when no other `MigPlan` already exists for the target namespace. Run the `kubectl get migplan` query above first; if the result is empty, the wizard's auto-create will not collide with anything and the flow completes normally. If any plans are present, either finish / delete them first, or use the API path.

**Diagnostic note on blast radius.** The stray `MigPlan` does not actually migrate anything — it is stuck in validation. Deleting it is safe as long as no migration is genuinely in progress for the same namespace. Never delete a `MigPlan` whose `Ready` is `True` unless the migration it represents has already completed.

## Diagnostic Steps

1. Confirm the symptom: a `MigPlan` exists that the user did not submit, and it holds every PVC in the namespace.

   ```bash
   kubectl -n <migration-namespace> get migplan -o yaml \
     | yq '.items[] | {name: .metadata.name, ready: .status.conditions, pvcs: .spec.persistentVolumeClaims}'
   ```

   If a plan has `status.conditions[?].reason=Conflict` and its `spec.persistentVolumeClaims` list matches the full set of PVCs in the namespace (compare against `kubectl get pvc -A`), this KB applies.

2. Check the creation timestamps against the UI access time. The stray plan's `creationTimestamp` will be within seconds of whenever the user opened **Migration > Storage**:

   ```bash
   kubectl -n <migration-namespace> get migplan -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}'
   ```

3. After the cleanup, re-list and confirm no leftover `MigPlan` for the namespace is in a `Pending` state:

   ```bash
   kubectl -n <migration-namespace> get migplan
   ```

   Then re-run the migration either via the API or the wizard and verify the new plan reaches `Ready: True` without a conflict condition.
