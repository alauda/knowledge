---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500359
---

# Scheduled Velero backups pruned by Argo CD on ACP

## Issue

On Alauda Container Platform with the `velero` ModulePlugin v4.1.0 installed into namespace `cpaas-system` (image `registry.alauda.cn:60080/3rdparty/velero/velero:v1.15.2-v4.1.0`) and the `argocd` ModulePlugin (argocd-operator v4.2.0, chart `chart-argocd-installer`) installed into namespace `argocd`, administrators observe that `Backup` resources produced by a Velero `Schedule` disappear from the cluster shortly after each scheduled tick, even though the `Schedule` itself reports the tick as successful. The affected kinds are the ones the Velero data path materializes dynamically — all under the `velero.io` API group on this platform.

The Velero `Schedule` CR (`velero.io/v1`, kind `Schedule`) carries a cron expression and a `Backup` template; the Schedule controller creates a fresh `Backup` CR every time the cron expression fires. Those dynamically-created `Backup` CRs are cluster state with no corresponding manifest in the Git repository that Argo CD tracks as the source of truth.

## Root Cause

Argo CD's `Application` CR (`argoproj.io/v1alpha1`) is shipped on ACP through the `argocd` ModulePlugin alongside `applicationsets.argoproj.io`, `appprojects.argoproj.io`, and `argocds.argoproj.io` (`v1beta1`) — the full upstream CRD set. When an `Application` has `syncPolicy.automated.prune` enabled (the field is a boolean and defaults to `false`), Argo CD treats any live cluster resource that falls inside the Application's tracking scope but has no corresponding manifest in the configured Git source as drift, and deletes it on the next reconciliation.

Velero `Schedule`-spawned `Backup` CRs match exactly that pattern: they are cluster state that the Schedule controller injects on each cron fire, and they never exist in Git. As soon as Argo CD's automated sync next reconciles the tracking Application, any such `Backup` CR within scope is pruned.

## Resolution

Configure Argo CD to exclude `velero.io` resources from reconciliation so that prune does not delete the dynamically-generated CRs. The CRDs needing exclusion are the ones the Schedule controller and the Velero data path create: `Backup`, `Restore`, `Schedule`, `PodVolumeBackup`, `PodVolumeRestore`, `BackupStorageLocation`, `DataUpload`, and `DataDownload` — all present on ACP under the `velero.io` group.

Cluster-wide exclusions are configured on the singleton `ArgoCD` CR (`argoproj.io/v1beta1`) installed by the `argocd` ModulePlugin. On a fresh ACP install the live `ArgoCD/argocd-gitops` CR in namespace `argocd` has the `spec.resourceExclusions` field present but empty; the field carries a YAML-encoded string listing exclusion entries, and setting it to a block that names the `velero.io` API group removes those kinds from Argo CD's reconciler scope:

```bash
kubectl patch argocd -n argocd argocd-gitops --type merge -p '{
  "spec": {
    "resourceExclusions": "- apiGroups:\n  - velero.io\n  kinds:\n  - Backup\n  - Restore\n  - Schedule\n  - PodVolumeBackup\n  - PodVolumeRestore\n  - BackupStorageLocation\n  - DataUpload\n  - DataDownload\n  clusters:\n  - \"*\"\n"
  }
}'
```

The equivalent declarative form on the `ArgoCD` CR — note that `resourceExclusions` is a YAML-encoded string field, not a typed list — is:

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: argocd-gitops
  namespace: argocd
spec:
  resourceExclusions: |
    - apiGroups:
      - velero.io
      kinds:
      - Backup
      - Restore
      - Schedule
      - PodVolumeBackup
      - PodVolumeRestore
      - BackupStorageLocation
      - DataUpload
      - DataDownload
      clusters:
      - "*"
```

For narrower scoping when a cluster-wide exclusion is too broad, configure the override on the tracking `Application` itself — either through `spec.ignoreDifferences[]` or by narrowing the `Application`'s tracked resource set so that `velero.io` kinds fall outside scope.

## Diagnostic Steps

Confirm the prune pattern before changing any configuration. The Velero `Schedule` CRD records the most recent fire time in `Schedule.status.lastBackup` (a string field; the `phase` enum is `{New, Enabled, FailedValidation}`), so a `Schedule` whose `phase` is `Enabled` and whose `lastBackup` is advancing while no corresponding `Backup` CR is visible via `kubectl get backup` is the diagnostic signature of an external actor deleting the `Backup` CR after creation:

```bash
kubectl get schedule -n cpaas-system <schedule-name> \
  -o jsonpath='{.status.phase}{"  "}{.status.lastBackup}{"\n"}'
kubectl get backup -n cpaas-system
```

Watch the namespace through a scheduled fire and observe the `Backup` CR appear briefly then disappear within minutes — that transient lifetime is the live signature of an external deleter acting on the `Backup` CR between fire and the next reconciliation cycle:

```bash
kubectl get backup -n cpaas-system -w
```

After applying the `resourceExclusions` change to the `ArgoCD` CR, repeat the same watch through a subsequent scheduled fire: the `Backup` CR should now persist past the next Argo CD reconciliation cycle.
