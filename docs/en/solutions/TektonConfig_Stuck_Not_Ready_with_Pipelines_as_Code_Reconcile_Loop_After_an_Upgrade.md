---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# TektonConfig Stuck "Not Ready" with Pipelines-as-Code Reconcile Loop After an Upgrade
## Issue

After upgrading the Tekton-based pipelines operator across a minor release boundary (for example, `v1.20` → `v1.21`), the `TektonConfig` CR fails to reconcile and stays in a `Not Ready` state. The status message points specifically at the Pipelines-as-Code (PAC) sub-component and keeps repeating the same reconcile line:

```text
NAME     VERSION  READY  REASON
config   1.21.0   False  Components not in ready state:
                         PipelinesAsCode: reconcile again and proceed
```

The rest of the cluster looks healthy — new `PipelineRun` objects can still be scheduled on the already-running controllers, and the operator pod itself is `Running` — but the `TektonConfig` object never goes `Ready`, which blocks downstream automation and any further version bump.

## Root Cause

The Tekton operator manages the full set of components (Pipelines, Triggers, Chains, PAC, Dashboard, Results) through a set of `TektonInstallerSets`. Each installer set is a declarative bundle of resources the operator applies on behalf of a component. During an upgrade the operator diffs the set of installer sets it *wants* against the set currently present and reconciles — delete stale ones, create or update the rest.

When the upgrade leaves **PAC installer sets from the old version** behind (particularly the `main-deployment`, the `main-static-...` configmap bundle, and the `post-...` post-install hook set), the new operator cannot progress past the PAC reconcile. It keeps logging `reconcile again and proceed`, because it can neither adopt the stale set nor recreate a fresh one cleanly — the object already exists with an owner reference that no longer matches.

Root cause, stated plainly: leftover `TektonInstallerSets` from the pre-upgrade version that the new operator cannot take over.

## Resolution

### Preferred path on ACP

ACP **DevOps** (`docs/en/devops/`, Tekton-based) delivers PipelineRun / TaskRun / Pipelines-as-Code through its own operator lifecycle. When the same symptom appears after an ACP DevOps upgrade — `TektonConfig` stuck with a PAC reconcile loop — the remediation is structurally identical: remove the stale installer sets so the new operator can apply a clean set. Upgrade-path issues of this kind are reported against the DevOps area and the operator's reinstallation flow is the supported escape hatch.

### Underlying mechanics — unblock the reconcile

The instructions below assume two important pre-conditions; do **not** skip them:

- The operator is reinstalled **without deleting the operands**. Simply removing the operator Subscription and CSV leaves the running `PipelineRun`/`TaskRun`/`Repository` objects intact.
- Any existing PAC `Repository` CR is backed up or has its PAC deployment nudged, so that the reconcile loop clears without losing live configuration.

1. **Un-install the operator, keep the operands.** Remove the operator's ClusterServiceVersion and Subscription (whether from the CLI or from the cluster's operator-management surface) without checking any "delete operand instances" option. Running `PipelineRun`, `TaskRun`, and `Repository` objects continue to exist and the controller pods keep running until the operator-owned Deployment is re-created.

2. **Confirm whether PAC `Repository` CRs exist.**

   ```bash
   kubectl get repository -A
   ```

   - **If `Repository` CRs exist**, back each one up and then nudge the PAC controller rather than deleting the installer sets:

     ```bash
     kubectl -n <repo-namespace> get repository <repo-name> -o yaml > repo-<repo-name>.bak.yaml
     kubectl -n pipelines delete deployment pipelines-as-code-controller
     ```

     Deleting the controller deployment is a safe restart — the operator will re-create it on the next reconcile.

   - **If no `Repository` CR exists**, delete the three stale PAC installer sets:

     ```bash
     kubectl get tektoninstallerset | grep -E 'pipelinesascode|pipelines-as-code'

     kubectl delete tektoninstallerset <pipelinesascode-main-deployment-xxxx>
     kubectl delete tektoninstallerset <pipelinesascode-main-static-xxxx>
     kubectl delete tektoninstallerset <pipelinesascode-post-xxxx>
     ```

     The exact names carry a random suffix — substitute what the cluster actually reports.

3. **If deletion stalls, strip finalizers.** A deleted installer set may hang if a finalizer refers to a controller that is no longer able to run. Patch the finalizer out and re-run the delete:

   ```bash
   kubectl patch tektoninstallerset <name> \
     --type=merge -p '{"metadata":{"finalizers":null}}'
   ```

4. **Re-install the operator and let it reconcile.** Re-apply the `Subscription` (or the operator bundle, whichever is the source of truth in the target environment). The operator will create fresh installer sets that match its current version, the PAC components will come up, and `TektonConfig` will flip to `Ready`.

5. **Verify the end state.**

   ```bash
   kubectl get tektonconfig
   kubectl get tektoninstallerset
   kubectl get repository -A
   kubectl -n pipelines get pods
   ```

   The `TektonConfig` object should report `Ready=True`, every installer set should be `Ready`, all pods in the pipelines namespace should be `Running`, and any previously backed-up `Repository` CR should still be present (restore from the backup if not).

## Diagnostic Steps

Inspect the `TektonConfig` reason line — the blocking component is named in plain text:

```bash
kubectl get tektonconfig -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.version}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\t"}{.status.conditions[?(@.type=="Ready")].reason}{"\n"}{end}'
```

List the installer sets that belong to the blocking component (PAC in this case):

```bash
kubectl get tektoninstallerset -l operator.tekton.dev/component=pipelines-as-code
```

Tail the operator log to see the reconcile loop itself — the log explicitly mentions `reconcile again and proceed` on each iteration until the stale set is removed:

```bash
kubectl -n pipelines logs -l app=tekton-operator --tail=200 | grep -i 'installerset\|reconcile'
```

Check for lingering finalizers on individual installer sets:

```bash
kubectl get tektoninstallerset <name> -o jsonpath='{.metadata.finalizers}{"\n"}'
```

If none of the steps above clear the condition, collect the operator's leader-elected pod log at `--tail=1000` and inspect the last successful reconcile timestamp — a large gap between "last successful" and "now" means the operator is stuck on a single resource; the resource name will appear just before the failure.
