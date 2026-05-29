---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# ArgoCD CR stuck in Pending phase after install on ACP

## Issue

On Alauda Container Platform, the `argocd` ModulePlugin (catalog `gitops`) deploys an `ArgoCD` custom resource named `argocd-gitops` into the `argocd` namespace, reconciled by `argocd-operator-controller-manager` (image `build-harbor.alauda.cn/3rdparty/argoprojlabs/argocd-operator:v4.2.0`, the unforked upstream argoproj-labs operator). After installation, reading the CR sometimes shows `.status.phase` stuck at `Pending`, while every per-component status field (`applicationController`, `applicationSetController`, `server`, `repo`, `redis`, `sso`) reports `Running` and `.status.conditions[]` carries a `type: Reconciled / status: "True" / reason: Success` entry.

The CR served at `argoproj.io/v1beta1` exposes exactly that mix of fields: an aggregate `.status.phase` plus per-component summaries plus a `conditions[]` array — verified live on the `argocd-gitops` instance, where the CR currently reads phase `Available` with all per-component fields `Running` and `Reconciled=True`. The CRD ships identically on independent ACP clusters (CRD `argocds.argoproj.io`, served versions `v1alpha1` + `v1beta1`, `olm.managed=true`) so the field shape is platform-wide, not cluster-specific.

```bash
kubectl -n argocd get argocd argocd-gitops -o jsonpath='{.status.phase}{"\n"}'
kubectl -n argocd get argocd argocd-gitops -o yaml | sed -n '/^status:/,$p'
```

## Root Cause

The `.status.phase` field is operator-computed and operator-set during reconcile, not driven directly by live Pod health. `kubectl explain argocd.status.phase` documents it as "a simple, high-level summary of where the ArgoCD is in its lifecycle" with exactly four values — `Pending`, `Available`, `Failed`, `Unknown` — and notably no `Running` value (the `Running` token is per-component, not per-phase). The operator writes that summary at the end of each reconcile pass; if a reconcile races with workload-readiness transitions, the stored value can lag behind reality. Once all required component resources are ready, the next reconcile flips phase to `Available`; absent a triggering event, however, a transiently-incorrect `Pending` can persist on the CR until the operator reconciles again.

The per-component fields and `.status.conditions[]` reflect the same reconcile-time snapshot. The corollary is that disagreement between an aggregate phase of `Pending` and per-component fields of `Running` is internally consistent with the operator's bookkeeping model — it just means the last summary write was taken before the components reached steady state, and no further reconcile has happened to refresh it.

## Resolution

The cosmetic discrepancy does not impair Argo CD: workload Pods are independently reconciled and serve traffic regardless of the stored summary value, and the verified live capture shows `argocd-gitops-*` component Pods (`application-controller-0/1`, `applicationset-controller`, `repo-server`, `server`, `redis-ha-*`) all `1/1` or `2/2` `Running` with the `argocd-operator-controller-manager` reconcile pod itself `1/1` `Running`. Confirm component health first — if every per-component status field is `Running`, every relevant `argocd-gitops-*` workload Pod is in `Running` / `Ready`, and `.status.conditions[]` carries `Reconciled=True / reason=Success`, the install is functional and the stale `Pending` is a post-reconcile summary that the next reconcile will overwrite.

To refresh the summary value, trigger a fresh reconcile of the `ArgoCD` CR by either of the following:

Restart the `argocd-operator-controller-manager` Deployment so the controller re-evaluates every watched CR on startup; that controller is the one that owns the `.status.phase` write, and the live image is the unforked upstream argoproj-labs `argocd-operator` v4.2.0, so the reconcile-on-restart semantic matches the upstream operator:

```bash
kubectl -n argocd rollout restart deploy/argocd-operator-controller-manager
```

Or scale the operator Deployment down then back up:

```bash
kubectl -n argocd scale deploy/argocd-operator-controller-manager --replicas=0
kubectl -n argocd scale deploy/argocd-operator-controller-manager --replicas=1
```

Or, leaving the operator running, apply a trivial mutation to the `ArgoCD` CR itself — adding or removing a label or annotation, or tweaking and reverting a benign field — to enqueue a reconcile for that specific object; updating an annotation increments `.metadata.generation` and is the standard controller-runtime event-trigger pattern that argocd-operator already watches:

```bash
kubectl -n argocd annotate argocd argocd-gitops reconcile-nudge=$(date +%s) --overwrite
kubectl -n argocd annotate argocd argocd-gitops reconcile-nudge- --overwrite
```

After the reconcile completes, re-read `.status.phase`; on a healthy install where every required component resource is ready, the operator overwrites the summary with `Available` per the CRD-documented enum semantic.

## Diagnostic Steps

Confirm the CR is the upstream argoproj.io shape and the controller is the expected unforked operator — both are cross-checked against the CRD and Deployment metadata to rule out a different operator distribution being installed.

```bash
kubectl get crd argocds.argoproj.io -o jsonpath='{.spec.versions[*].name}{"\n"}'
kubectl -n argocd get deploy argocd-operator-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
```

Read the full `.status` block and the workload Pods in one pass; the diagnostic is the disagreement between the aggregate `phase` (which is operator-computed) and the per-component fields plus Pod readiness (which reflect real workload state).

```bash
kubectl -n argocd get argocd argocd-gitops -o yaml | sed -n '/^status:/,$p'
kubectl -n argocd get pods -l app.kubernetes.io/part-of=argocd
```

A healthy steady state on ACP reads `phase: Available` with each per-component field `Running` (the `sso` field can read `Unknown` if SSO/Dex was not configured at install — that is independent of the phase question and is not the stale-Pending symptom). If `phase` reads `Pending` while components are `Running` and the workload Pods are `Ready`, apply one of the reconcile-trigger steps above; if `phase` reads `Failed`, that indicates a real reconcile error and should be diagnosed from `.status.conditions[]` and the `argocd-operator-controller-manager` container logs rather than treated as the cosmetic case.
