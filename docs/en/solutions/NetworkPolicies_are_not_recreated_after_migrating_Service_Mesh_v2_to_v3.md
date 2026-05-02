---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# NetworkPolicies are not recreated after migrating Service Mesh v2 to v3
## Issue

When migrating the platform's Service Mesh from v2 to v3, the auto-managed `NetworkPolicy` resources that v2 wrote into mesh-member namespaces are removed and not recreated:

- Pre-migration `NetworkPolicies` (typically named after the mesh's control plane and managed by the operator) disappear from each namespace that previously carried the `maistra.io/member-of:` label.
- The `maistra.io/member-of:` label itself is removed from those namespaces.
- Workloads that depended on the auto-generated policies — for example, traffic from the control plane to sidecars, or sidecar-to-sidecar inside the mesh — see traffic refused once the namespace's existing default policies take effect.

## Root Cause

In Service Mesh v2, the operator owns `NetworkPolicy` lifecycle when `spec.security.manageNetworkPolicy: true` is set on the `ServiceMeshControlPlane` (SMCP) — it creates, edits, and deletes a curated set of `NetworkPolicy` objects across mesh-member namespaces.

The v3 control plane changes the default for the same field to `false`. During an in-place migration, the operator follows the new spec, deletes the v2-owned policies it can identify, and does **not** recreate equivalent v3-owned policies. The migration also clears `maistra.io/member-of:` from member namespaces, so the operator's namespace selectors no longer match — even if `manageNetworkPolicy` is flipped back to `true` afterwards, there is nothing to reconcile.

The net effect is that migration leaves a clean slate: any `NetworkPolicy` the cluster needs after the upgrade has to be recreated explicitly.

## Resolution

Three patterns, depending on where in the migration timeline you are.

### Option 1 — Already on v3, recreate the policies manually

If the migration has completed and `NetworkPolicy` is gone, write the policies back yourself. The minimum set typically includes:

- An ingress allow-from for the namespace selector that matches the v3 mesh members (e.g., `istio.io/rev=<revision>`), so sidecar-to-sidecar traffic crosses the namespace boundary.
- An ingress allow-from for the v3 control plane's namespace, so `istiod` can reach sidecars.
- Whatever app-specific allow-from rules your v2 policies added on top of the operator-managed defaults.

There is no automatic conversion path — the v2 names and the v3 namespace selector pattern differ. Use `kubectl get networkpolicy -A -o yaml` from a snapshot of the pre-migration cluster as the source of truth for what to recreate, then port the namespace selectors to the v3 label keys.

### Option 2 — Not yet migrated, take ownership of the policies first

When the migration is upcoming, disable operator-managed `NetworkPolicy` on the v2 SMCP **before** upgrading. This freezes the existing policies in place — the v2 operator stops touching them, and your team owns the lifecycle from then on:

```bash
SM_NS=<service-mesh-control-plane-namespace>
kubectl -n "$SM_NS" patch smcp <smcp-name> --type=merge \
  -p '{"spec":{"security":{"manageNetworkPolicy":false}}}'
```

The migration proceeds without the operator deleting policies it no longer owns, and the policies you froze remain in their namespaces.

### Option 3 (recommended) — Recreate first, then disable management

When strict NetworkPolicy coverage is non-negotiable (regulated environments, default-deny baseline), recreate every required policy by hand **before** the migration, set `manageNetworkPolicy: false` so the operator does not interfere, and then run the migration. This guarantees the cluster is never in a window where it is in the mesh but uncovered by policy:

```bash
# 1) Apply your hand-written set of NetworkPolicies (from your git source, etc.).
kubectl apply -f netpols/

# 2) Hand ownership over to your manifests.
kubectl -n "$SM_NS" patch smcp <smcp-name> --type=merge \
  -p '{"spec":{"security":{"manageNetworkPolicy":false}}}'

# 3) Run the migration to v3.
```

Note: during the recreation window, both control planes need access to all workloads and all workloads need access to both control planes. Plan the recreation order so this constraint holds.

## Diagnostic Steps

1. Check whether the SMCP is currently asking the operator to manage policies:

   ```bash
   SM_NS=<service-mesh-control-plane-namespace>
   kubectl -n "$SM_NS" get smcp <smcp-name> \
     -o jsonpath='{.spec.security.manageNetworkPolicy}'
   ```

   `true`, `false`, or absent (defaults differ between v2 and v3) — the value plus the version of the SMCP tells you which policies the operator owns.

2. List existing `NetworkPolicy` objects in mesh-member namespaces to baseline what is in place today:

   ```bash
   for ns in $(kubectl get ns -l istio.io/rev -o name | cut -d/ -f2); do
     echo "=== $ns ==="
     kubectl -n "$ns" get networkpolicy
   done
   ```

3. After the migration, inspect each previously-mesh-member namespace's labels — the loss of `maistra.io/member-of:` is the canonical breadcrumb that the migration ran:

   ```bash
   kubectl get ns --show-labels | grep -E 'maistra.io|istio.io' || echo "none"
   ```

4. If post-migration traffic is failing, capture the `NetworkPolicy`-driven denies from a sample sidecar pod's logs — the v2 policies' specific allow rules are visible by their absence:

   ```bash
   kubectl logs -n <app-ns> <pod> -c istio-proxy --tail=200 | grep -iE 'denied|RBAC'
   ```
