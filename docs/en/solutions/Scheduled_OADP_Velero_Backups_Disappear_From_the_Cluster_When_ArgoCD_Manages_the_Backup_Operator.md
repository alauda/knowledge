---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cluster-managed backup pipeline (OADP / Velero with a `Schedule`) is configured through GitOps: ArgoCD owns the Application that contains the backup operator's configuration. Scheduled backups succeed — the backup artifacts land in object storage — but the corresponding `Backup` custom-resource objects in the cluster vanish shortly after each schedule fires:

- The OADP / console UI shows no recent backups.
- Object storage's bucket directory contains the backup blobs.
- `kubectl get backup -n <backup-ns>` returns only **manually-created** Backup CRs; scheduled ones are absent.
- A new backup briefly appears (seconds) after the `Schedule` fires, then disappears within minutes.

The paradox: the backups exist as storage artifacts (the Schedule is genuinely running) but not as Kubernetes objects, so the cluster's own console cannot list or restore them even though the data is preserved.

## Root Cause

ArgoCD's automatic pruning (`prune: true` on the Application sync policy) deletes any cluster resource that is **not** declared in the Git source. That is normally the correct behaviour for GitOps — it catches drift. But it interacts badly with controllers that **generate** resources dynamically.

The backup operator's `Schedule` object creates a fresh `Backup` resource every time it fires. These generated `Backup` objects live in the cluster; they are not and should not be in Git (each one is dated and named uniquely at fire time). ArgoCD's next reconcile sees the `Backup` resource, cannot find it in Git, classifies it as drift, and prunes it.

The prune happens after the backup has already been created and dispatched to object storage — so the backup **data** is preserved — but the `Backup` CR that names and tracks it is gone. The UI lists backups by querying `Backup` objects; with them gone, the backup is invisible to the UI even though the storage artifact exists.

The same mechanism affects `Restore`, `PodVolumeBackup`, `PodVolumeRestore`, and any other resource the operator generates dynamically during its lifecycle.

## Resolution

Teach ArgoCD to ignore the runtime resources the backup operator generates, so they are not pruned. Two scopes, pick based on how deeply ArgoCD is used.

### Scope 1 — narrow the Application's sync policy

In the ArgoCD Application that manages the backup operator, add `ignoreDifferences` entries for each generated resource kind, or use a broader sync option to exclude them from managed-state comparison:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: backup-operator
  namespace: argocd
spec:
  # ... source / destination ...
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - "ApplyOutOfSyncOnly=true"
  # Do not compare these resource kinds against Git — they are
  # runtime-managed by the operator.
  ignoreDifferences:
    - group: velero.io
      kind: Backup
      jsonPointers: ["/"]
    - group: velero.io
      kind: Restore
      jsonPointers: ["/"]
    - group: velero.io
      kind: PodVolumeBackup
      jsonPointers: ["/"]
    - group: velero.io
      kind: PodVolumeRestore
      jsonPointers: ["/"]
```

`ignoreDifferences` prevents the drift-detection loop from flagging them; combined with ArgoCD's default behaviour of not pruning un-listed resources, the generated objects survive.

### Scope 2 — cluster-wide ArgoCD resource exclusions

If the cluster runs a single ArgoCD instance that should never manage runtime-generated backup resources, configure ArgoCD's global `resource.exclusions` list (typically through the `argocd-cm` ConfigMap):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.exclusions: |
    - apiGroups:
        - velero.io
      kinds:
        - Backup
        - Restore
        - PodVolumeBackup
        - PodVolumeRestore
      clusters:
        - "*"
```

ArgoCD ignores these resource kinds entirely — no drift detection, no pruning, regardless of which Application manages the operator. Prefer this scope when the exclusion is the same across every Application that could touch backup resources.

### After applying the change

Force a fresh ArgoCD sync so the new settings take effect, then let the next scheduled backup fire:

```bash
# Sync the Application with the new ignoreDifferences.
argocd app sync backup-operator

# Watch a scheduled backup through its full lifecycle.
kubectl get backup -n <backup-ns> -w
```

The scheduled `Backup` CR should now persist beyond the first ArgoCD reconcile cycle. Manually-triggered backups also persist (they always did; ArgoCD does prune them too after a reconcile window, but the manual flow is short enough that it was less visible).

### What does not work

- **Setting `prune: false` on the Application**. This disables prune for **every** resource the Application manages, which defeats the GitOps guarantee elsewhere (drift in the operator's own configuration stops being corrected).
- **Adding backup resources to Git and keeping them there**. The `Backup` names are dynamically generated with timestamps; they are not stable identifiers a Git source can describe ahead of time.
- **Running the backup operator in a namespace outside the Application's scope**. Possible but usually inappropriate — the operator expects to be configured from the same place as its workloads and scheduling.

## Diagnostic Steps

Confirm the backup exists in storage but not in the cluster:

```bash
# In the cluster:
kubectl get backup -n <backup-ns>
# Should show manually-created backups only; scheduled ones absent.

# In object storage (via the operator's configured backend — substitute
# for the actual client / credentials):
aws --endpoint-url <s3-endpoint> s3 ls s3://<backup-bucket>/backups/
# A directory per scheduled backup exists, named with the schedule's
# backup prefix and a timestamp.
```

Verify the `Schedule` itself is healthy:

```bash
kubectl get schedule -n <backup-ns> -o \
  custom-columns='NAME:.metadata.name,LAST_BACKUP:.status.lastBackup,PHASE:.status.phase'
```

`LAST_BACKUP` timestamp in the recent past confirms the Schedule is firing; `PHASE` should be `Enabled`.

Watch a scheduled backup's lifecycle to see ArgoCD prune it in real time:

```bash
# In one terminal:
kubectl get backup -n <backup-ns> -w

# In another, force the schedule to fire:
kubectl -n <backup-ns> create backup \
  --from-schedule=<schedule-name> \
  <adhoc-test-backup-name>    # or use the operator's CLI equivalent
```

The backup appears, completes (reaches `Completed` phase), and then — within a few minutes — is deleted by ArgoCD's next sync. Pair with ArgoCD's application events to confirm the prune source:

```bash
argocd app get backup-operator --show-operation
argocd app history backup-operator
```

After the fix, repeat the watch. The backup should persist indefinitely (or until the operator's own retention policy expires it).
