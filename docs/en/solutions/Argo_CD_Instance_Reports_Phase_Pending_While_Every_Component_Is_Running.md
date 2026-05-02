---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Argo CD Instance Reports Phase Pending While Every Component Is Running
## Issue

After installing the GitOps operator on ACP, the `ArgoCD` custom resource sits with `.status.phase: Pending` indefinitely, even though every sub-component is healthy and the `Reconciled` condition shows `status: "True"`:

```text
applicationController:    Running
applicationSetController: Running
conditions:
  - lastTransitionTime: "..."
    message: ""
    reason: Success
    status: "True"
    type:   Reconciled
phase: Pending
redis:  Running
repo:   Running
server: Running
sso:    Running
```

The Argo CD pods themselves are serving traffic — `Applications` sync, the UI renders, webhooks fire — but the top-level `phase` on the CR never flips to `Available`. Any automation that polls `.status.phase` (admission-style gates, integration tests, progressive delivery promotion) therefore never unblocks.

## Root Cause

The `ArgoCD` CR's `.status.phase` is a **derived** summary field that the GitOps operator writes at the end of a successful reconcile loop. If the operator has already reconciled the component deployments to `Running` but the phase-writing branch did not execute on that same pass — for example, when the operator pod restarted between provisioning the workloads and the final status write — the phase string gets stuck on its previous value (`Pending`) despite every underlying component being ready.

This is a status-reporting quirk, not a functional outage:

- The Argo CD control plane itself is unaffected — sync, rollback, RBAC, repo-server cache, Redis, Dex/SSO all work.
- The `conditions[]` block is the real source of truth. `Reconciled = True` with `reason: Success` means the operator has fully reconciled the spec; only the bookkeeping field lags.
- Recreating the CR or force-deleting pods is unnecessary and risks unrelated downtime.

## Resolution

### ACP-preferred path: trigger a no-op reconcile on the `ArgoCD` CR

The simplest fix is to force the operator to run one more reconcile pass on the CR; the phase-write branch then executes and the string flips to the correct value.

Option A — add a harmless annotation and remove it:

```bash
kubectl -n <gitops-ns> annotate argocd <name> \
  reconcile-nudge=$(date +%s) --overwrite

# a few seconds later:
kubectl -n <gitops-ns> annotate argocd <name> \
  reconcile-nudge-

kubectl -n <gitops-ns> get argocd <name> -o jsonpath='{.status.phase}'
```

Option B — restart the operator so it re-enqueues every `ArgoCD` CR on startup:

```bash
kubectl -n <operator-ns> rollout restart deployment/<gitops-operator-deployment>
```

Option C — a manual edit with a one-character no-op tweak on the spec followed by a revert also kicks a reconcile:

```bash
kubectl -n <gitops-ns> edit argocd <name>
```

Any of the three produces the same result: the operator re-runs its reconcile, the final status block is rewritten, and `phase` moves to `Available`.

### OSS fallback: the same approach on upstream Argo CD Operator

On clusters running the community Argo CD Operator without the ACP bundle, the behavior and the fix are identical — the CRD definitions are shared upstream, and the stale-phase path is the same. Use either the annotation-nudge or the operator rollout-restart.

Operational note: if a CI gate is blocking on `phase: Available`, consider switching it to check `conditions[?(@.type=="Reconciled")].status == "True"` instead. The condition is the semantically correct signal; `phase` is a summarized view that can lag.

## Diagnostic Steps

- Confirm all component workloads are actually healthy before treating this as the stale-phase case — if any pod is stuck on a `CrashLoopBackOff` or `Pending` of its own, the root cause is different:

  ```bash
  kubectl -n <gitops-ns> get pods
  ```

- Inspect the full status block to see that the stuck field is only `phase`, not any of the component status fields:

  ```bash
  kubectl -n <gitops-ns> get argocd <name> -o yaml \
    | sed -n '/status:/,$p'
  ```

  Expected shape: every component line shows `Running`, and `conditions[0].status` is `True` with `reason: Success`.

- Tail the GitOps operator logs and look for the last reconcile entry for this CR. A successful reconcile line followed by silence usually confirms the operator thought it was done and skipped the phase write:

  ```bash
  kubectl -n <operator-ns> logs deploy/<gitops-operator-deployment> \
    | grep -E '"namespace":"<gitops-ns>"'
  ```

- After the nudge, confirm the field has moved:

  ```bash
  kubectl -n <gitops-ns> get argocd <name> \
    -o jsonpath='{.status.phase}{"\n"}'
  ```

  `Available` is the expected terminal value for a healthy instance.
