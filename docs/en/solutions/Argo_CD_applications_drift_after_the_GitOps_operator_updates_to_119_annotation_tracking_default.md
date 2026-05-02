---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After the GitOps operator updates to Argo CD 1.19 (which aligns with upstream Argo CD 3.0), every previously-synced `Application` flips to `OutOfSync` for changes that are not changes — typically `app.kubernetes.io/*` labels or `operators.coreos.com/*` labels added by the platform's controllers after the application syncs.

- Workloads that worked unchanged before the upgrade now show persistent drift.
- The drift is on metadata only — labels added to a Deployment / Service / ConfigMap by an admission webhook, by OLM, or by another operator that runs *after* Argo CD applied the resource.
- The git source has not changed; the live cluster state has not changed in any meaningful way.

## Root Cause

Argo CD 3.0 changed the default *resource tracking method* from `label` (matching upstream Argo CD's old default) to `annotation`:

- **Label-based tracking** compares only the `app.kubernetes.io/instance` label to decide whether Argo CD owns a resource. Other labels are ignored, so post-deploy mutations from operators do not register as drift.
- **Annotation-based tracking** writes an `argocd.argoproj.io/tracking-id` annotation on every managed resource. The diff that drives `OutOfSync` is computed against the **whole** rendered manifest — including all labels and metadata. Any label a downstream controller adds (`operators.coreos.com/<name>`, sidecar-injection labels, mesh-injection labels) is now drift.

The annotation tracking is strictly safer (it disambiguates ownership when two `Application` resources reference the same target), but the change of default at upgrade time is what makes existing apps light up `OutOfSync` overnight.

## Resolution

Three options, in order of how aggressively they embrace the new default.

### Option 1 (recommended) — Adopt annotation tracking, sync once with `ApplyOutOfSyncOnly`

Sync each affected application once with `ApplyOutOfSyncOnly=true`. This applies only resources that are flagged out-of-sync (rather than re-applying the whole manifest set), allowing Argo CD to write the new `tracking-id` annotation onto the resources without churning rolling-restarts:

```yaml
spec:
  syncPolicy:
    syncOptions:
      - ApplyOutOfSyncOnly=true
```

Sync the application once with this option set; subsequent reconciles see the annotation in place and the diff settles.

### Option 2 — Remove `application.instanceLabelKey` if you are also keeping label tracking (don't mix the two)

If `application.instanceLabelKey: app.kubernetes.io/instance` is set in the `argocd-cm` ConfigMap (or in the `extraConfig` block of the `ArgoCD` CR) **and** you want annotation tracking, remove it. Mixing the two tracking methods is a known foot-gun — Argo CD detects both, decides one of them disagrees, and flags out-of-sync.

```bash
GITOPS_NS=<gitops-namespace>
kubectl -n "$GITOPS_NS" edit argocd <argocd-name>     # remove the instanceLabelKey line under spec.extraConfig
# or:
kubectl -n "$GITOPS_NS" edit cm argocd-cm             # remove the same key under data:
```

Restart the application controller so the change takes effect:

```bash
kubectl -n "$GITOPS_NS" rollout restart deployment <argocd-name>-application-controller
```

### Option 3 — Revert to label-based tracking

If too many existing applications depend on the lenient label-tracking semantics and a re-sync of all of them is unacceptable, set `resourceTrackingMethod: label` on the `ArgoCD` CR:

```bash
kubectl -n "$GITOPS_NS" edit argocd <argocd-name>
```

```yaml
spec:
  resourceTrackingMethod: label
```

The change should propagate into the `argocd-cm` ConfigMap. Restart the application controller and refresh the affected applications:

```bash
kubectl -n "$GITOPS_NS" rollout restart deployment <argocd-name>-application-controller
argocd app refresh '<app-name>'        # or use the UI's Refresh button
```

Label-based tracking compares only the `app.kubernetes.io/instance` label; mutations to other labels are ignored, so the OLM-added and operator-added labels stop registering as drift.

## Diagnostic Steps

1. Confirm which tracking method is actually in effect — both the operator default and any override in the ConfigMap matter:

   ```bash
   kubectl -n "$GITOPS_NS" get cm argocd-cm -o yaml | grep -E 'resourceTrackingMethod|instanceLabelKey'
   ```

   `application.resourceTrackingMethod: annotation` (or absent → defaults to annotation in 1.19+) confirms the new behavior.

2. Pick one drifted application and inspect what Argo CD believes is changed. The diff in the UI (or via CLI) should show metadata-only changes — labels added post-apply by other controllers:

   ```bash
   argocd app diff <app-name>
   ```

3. Confirm the offending labels are operator-added rather than written by your manifests. A common signature is `operators.coreos.com/<package>=` on resources you authored:

   ```bash
   kubectl get <kind> <name> -o jsonpath='{.metadata.labels}' | jq
   ```

4. After applying Option 1, watch the `tracking-id` annotation appear on the resources Argo CD owns:

   ```bash
   kubectl get deploy <name> -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/tracking-id}'
   ```

   A non-empty value referencing the application name is the post-sync success signal.
