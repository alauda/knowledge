---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Argo CD applications drift after annotation tracking conflict on ACP

## Issue

On Alauda Container Platform the Argo CD instance is installed by the `argocd` ModulePlugin and surfaces as the upstream `argocds.argoproj.io` CR `argocd-gitops` in the `argocd` namespace, with `applications.argoproj.io` reconciled by the same operator; the platform `argocd-cm` ConfigMap lives in that same namespace and is operator-tracked (label `operator.argoproj.io/tracked-by=argocd`). After installing or upgrading to chart `chart-argocd-installer` v4.2.0 (application controller image `argocd:v3.1.9-2`), administrators observe that previously healthy `Application` resources begin reporting `OutOfSync` even though no manifest in Git has changed and `kubectl diff` on the target objects shows only label additions made by other controllers on the cluster.

## Root Cause

Argo CD supports two resource tracking methods. Label-based tracking compares only the `app.kubernetes.io/instance` label to determine ownership and ignores changes to other labels on the live object. Annotation-based tracking, by contrast, uses the `argocd.argoproj.io/tracking-id` annotation as the ownership marker and computes drift against the entire resource manifest including the full label and metadata set. Under annotation-based tracking, when other controllers on the cluster — OLM, cert-manager, admission webhooks, or operators owning the same target object — add or modify labels post-deployment, the live manifest no longer matches the desired manifest in Git and the owning `Application` is reported as `OutOfSync`, even though the change was not authored by the Argo CD user.

On this ACP install the live `argocd-cm` ConfigMap carries both keys at the same time. Inspection of `argocd-cm.data` on this cluster's `argocd-gitops` instance shows `application.resourceTrackingMethod: annotation` and `application.instanceLabelKey: app.kubernetes.io/instance` present together. With both keys set, Argo CD is asked to track resources by annotation while also being told that the `app.kubernetes.io/instance` label key carries instance identity; resources continue to surface as `OutOfSync` even after the tracking annotation has been applied to them. The `argocd-cm` ConfigMap on ACP is operator-owned — its `ownerReferences` point at the `ArgoCD/argocd-gitops` CR with `controller=true` and `blockOwnerDeletion=true`, so the operator reconciles its `.data` from the CR; a direct `kubectl edit configmap argocd-cm` to delete `application.instanceLabelKey` is reverted on the next reconcile loop unless the CR or the chart source is updated as well.

## Resolution

Two paths converge on a stable state; pick one and apply it via the `argocd-gitops` CR or the chart values so the change survives operator reconciliation of `argocd-cm`.

Path A — keep annotation-based tracking and remove the conflicting `instanceLabelKey` override. On this install `spec.extraConfig` on the `argocd-gitops` CR is empty (`{}`), and the `application.instanceLabelKey` override is carried in `argocd-cm.data` rather than under `spec.extraConfig`. The durable fix is to ensure neither the chart values nor `spec.extraConfig` re-injects `application.instanceLabelKey` into `argocd-cm` on the next reconcile; once the key is no longer present in `argocd-cm.data`, sync the affected applications with the `ApplyOutOfSyncOnly=true` sync option so Argo CD adds the tracking annotation incrementally to only the resources currently flagged `OutOfSync` rather than re-deploying the full application.

The `ApplyOutOfSyncOnly=true` sync option is declared on the `Application.spec.syncPolicy.syncOptions` list (a free-form `[]string` recognized by the application controller) and causes the controller to act only on the resources currently `OutOfSync`, which lets the tracking annotation be added without a full re-deployment of the application's healthy resources:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  syncPolicy:
    syncOptions:
      - ApplyOutOfSyncOnly=true
```

Path B — revert to label-based tracking on the CR. Set `spec.resourceTrackingMethod: label` on the `argocd-gitops` `ArgoCD` CR (the chart currently sets this field to `annotation`); under label-based tracking the controller compares only `app.kubernetes.io/instance` and ignores label additions made by other controllers:

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: argocd-gitops
  namespace: argocd
spec:
  resourceTrackingMethod: label
```

In either path, persist the change at the CR / chart layer rather than editing `argocd-cm` in place — the ConfigMap is reconciled from the `argocd-gitops` CR, so direct ConfigMap edits are reverted.

## Diagnostic Steps

Confirm the live tracking configuration on the platform `argocd-cm` ConfigMap. The same upstream YAML keys (`application.resourceTrackingMethod`, `application.instanceLabelKey`) appear at top-level under `.data` of the ConfigMap on ACP, so the standard grep recipe works verbatim after substituting the ACP namespace:

```bash
kubectl get configmap argocd-cm -n argocd -o yaml | grep resourceTrackingMethod
kubectl get configmap argocd-cm -n argocd -o yaml | grep instanceLabelKey
```

A response that includes both `application.resourceTrackingMethod: annotation` and `application.instanceLabelKey: app.kubernetes.io/instance` matches the conflict shape and indicates the drift is being driven by the default-config conflict rather than by genuine in-Git changes. Cross-check ownership before attempting to edit the ConfigMap directly — if `metadata.ownerReferences` on `argocd-cm` lists `ArgoCD/argocd-gitops` with `controller=true`, the durable fix has to land on the CR or in the chart values rather than on the ConfigMap itself.
