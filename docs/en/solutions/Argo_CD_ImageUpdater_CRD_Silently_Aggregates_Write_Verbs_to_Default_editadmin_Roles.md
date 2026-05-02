---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Argo CD ImageUpdater CRD Silently Aggregates Write Verbs to Default edit/admin Roles
## Issue

After installing the Argo CD **ImageUpdater** extension (the component that automatically patches `Application` manifests when a new container image tag appears in a registry), users who are **not** meant to have administrator privileges on the GitOps control plane can create, update, and delete `ImageUpdater` resources. In particular, users whose only grant is the cluster-wide `edit` or `admin` aggregated roles — which most namespace owners and developer identities receive by default — gain full write access to `ImageUpdater` objects without that being an explicit decision by the cluster administrator.

Concretely, from a developer account a request like:

```bash
kubectl auth can-i create imageupdater
```

returns `yes`, and listing permissions confirms the full write verb set (`create/update/patch/delete/*`) on the `imageupdaters.argocd-image-updater.argoproj.io` resource — even though the administrator never granted that.

## Root Cause

Kubernetes supports **aggregated `ClusterRole`s**: a `ClusterRole` can declare itself an aggregate member of another `ClusterRole` by carrying a label the aggregator watches. The two standard aggregation labels are:

- `rbac.authorization.k8s.io/aggregate-to-edit: "true"`
- `rbac.authorization.k8s.io/aggregate-to-admin: "true"`

Any `ClusterRole` carrying one of these labels is automatically merged into the built-in `edit` / `admin` aggregated roles that most clusters (and most RBAC policies) already grant broadly.

The problem here is that the ImageUpdater CRD bundle ships **opinionated** `ClusterRole`s that carry those aggregation labels — including write verbs on `imageupdaters`. The moment the CRD is installed, those `ClusterRole`s appear on the cluster, and the aggregator silently extends the built-in `edit` and `admin` roles with the ImageUpdater write verbs. There is no spec field to turn this off; it is a static fact of the shipped manifests.

The effect is security-meaningful: namespace-level write access now implies the ability to mutate objects that, when reconciled, can deploy arbitrary container images into the cluster. A tenant whose only intended scope is their own namespace can, without touching Argo CD's own RBAC or the `AppProject` policy engine, steer image rollouts through an `ImageUpdater` object. This is effectively a privilege-escalation path from namespace-edit to cluster-wide-deploy.

The upstream Argo CD ImageUpdater project is aware of the issue and it is being tracked for a future release; until a release ships that either removes the aggregation labels or makes them opt-in, the cluster operator has to clamp the aggregation at install time.

## Resolution

### Preferred: strip the aggregation labels from the ImageUpdater-shipped ClusterRoles

ACP's `gitops` capability bundles Argo CD and, when the ImageUpdater extension is enabled, the same CRD and RBAC set is deployed. The mitigation is to remove the aggregation labels from the two aggregated `ClusterRole`s the extension ships, so the built-in `edit` / `admin` roles no longer inherit write verbs on `imageupdaters`. Access to ImageUpdater objects then has to be granted explicitly — the correct shape of least-privilege.

1. Identify the aggregated `ClusterRole`s the extension installs. They have names of the form `imageupdaters.argocd-image-updater.argoproj.io-<version>-edit` and `...-admin`:

   ```bash
   kubectl get clusterrole -l \
     rbac.authorization.k8s.io/aggregate-to-edit=true \
     -o name | grep imageupdaters
   kubectl get clusterrole -l \
     rbac.authorization.k8s.io/aggregate-to-admin=true \
     -o name | grep imageupdaters
   ```

2. Remove the aggregation labels from those roles. This makes each `ClusterRole` self-contained — it still exists, and can be bound explicitly — but it no longer folds into the built-in `edit` / `admin`:

   ```bash
   kubectl label clusterrole \
     <imageupdaters-...-edit>  rbac.authorization.k8s.io/aggregate-to-edit-
   kubectl label clusterrole \
     <imageupdaters-...-admin> rbac.authorization.k8s.io/aggregate-to-admin-
   ```

3. Create an explicit `ClusterRoleBinding` (or namespace-scoped `RoleBinding`) for the specific identities that should be allowed to manage `ImageUpdater` objects — typically only the platform-admin group or the team running the GitOps control plane.

4. If the cluster uses a GitOps controller (Argo CD itself, typically) to manage the gitops extension manifests, apply the label removal at the source — otherwise the next sync will re-add the labels. One robust approach is to wrap the extension's `Application` with a `kustomize` overlay that patches the `ClusterRole`s to drop the aggregation labels on every render; the sync then converges on the clamped form.

5. Verify that a non-admin identity no longer has write access:

   ```bash
   kubectl auth can-i create imageupdater --as=<non-admin-user>
   kubectl auth can-i delete imageupdater --as=<non-admin-user>
   ```

   Both should return `no` after the labels are removed (assuming no other binding has granted those verbs).

### Fallback: admission-level policy if manifest patching is not possible

If patching the shipped `ClusterRole`s is blocked — for example because the operator managing the extension re-asserts the manifests on every reconcile and cannot be overlaid — the alternative is an admission-level guard: a Kyverno, Gatekeeper, or Validating Admission Policy rule that denies `CREATE/UPDATE/PATCH/DELETE` on `imageupdaters.argocd-image-updater.argoproj.io` unless the requesting identity matches an explicit allow-list (group membership, specific ServiceAccount, etc.). This does not fix the RBAC surface but it does neutralize the escalation path.

Admission-level mitigation is a second-best; the aggregation label is still present in `kubectl auth can-i` output, which is confusing for operators reading the cluster state. Prefer the label removal whenever it is sustainable.

## Diagnostic Steps

Confirm whether the aggregation is currently active on the cluster:

```bash
kubectl get clusterrole -l \
  rbac.authorization.k8s.io/aggregate-to-edit=true \
  -o custom-columns=NAME:.metadata.name \
  | grep -i imageupdater
```

Any result here means the aggregation is live and the built-in `edit` role currently inherits the listed verbs on `imageupdaters`.

From a non-privileged account, enumerate what that account can do to `imageupdaters`:

```bash
kubectl auth can-i --list --as=<test-user> \
  | grep -i imageupdater
```

The healthy output after mitigation is either no line at all, or a line listing only `get/list/watch`. The unhealthy output carries `create/update/patch/delete` — confirming the escalation is still reachable.

Inspect the rules actually contributed by the extension-shipped `ClusterRole` so the correct label can be stripped:

```bash
kubectl get clusterrole <imageupdaters-...-edit> -o yaml
```

Look for the `metadata.labels` block and the `rules` stanza: the rules enumerate the write verbs on `imageupdaters` that are being aggregated. After removing the aggregation label, the `rules` block is preserved — the role continues to exist and can be bound deliberately; it just no longer merges into the built-in roles.
