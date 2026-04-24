---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `Subscription` that previously held an operator at an earlier version stops advancing to a newer channel or patch level. The `InstallPlan` queue empties out, `CSV` transitions stall, and operator upgrades across the cluster quietly freeze. Inspecting the relevant `CatalogSource` reveals that its registry pod is not running, and the object's `status.message` field names the specific failure — typically a `PodSecurity` admission refusal against the registry pod's security context, for example:

```text
couldn't ensure registry server: error ensuring updated catalog source pod:
creating update catalog source pod: pods "<catalog-name>-xxxxx" is
forbidden: violates PodSecurity "baseline:latest": seLinuxOptions
(pod set forbidden securityContext.seLinuxOptions: type "container_logreader_t")
```

Because the catalog registry pod cannot start, OLM has no index to read from, and every `Subscription` pointing at this `CatalogSource` is effectively disconnected from its package source until the pod comes up.

## Root Cause

OLM renders the catalog registry `Pod` template from the `CatalogSource.spec.grpcPodConfig`. When that template contains a security context that violates the namespace's active `PodSecurity` admission level, the API server rejects the pod at admission time. OLM logs the rejection into the `CatalogSource` status and keeps retrying on the next reconcile cycle — it does not fall back to a relaxed pod template on its own.

Two common origins for the violation:

1. **A cluster-level security mutator leaves the registry pod with a non-compliant `seLinuxOptions`, capability, or `runAsUser` shape.** The pod template starts out compliant but a mutating admission chain rewrites part of the security context before the API server's `PodSecurity` enforcement gate sees it. The registry pod then lands with, for example, `seLinuxOptions.type: container_logreader_t`, which the `baseline` profile does not permit.
2. **The namespace hosting the `CatalogSource` has been tightened to `restricted` or `baseline` without the registry pod's template having been tightened alongside it.** Older index-image pods were written against a more permissive default and do not self-tighten; they violate the moment the namespace is raised.

Both origins surface as the same `PodSecurity` error in the CatalogSource status. The fix differs, but the diagnostic starts in the same place.

## Resolution

Fix in three parts: inspect the rejected pod template, relax the pod's security context or raise the namespace label, and confirm the registry pod comes up clean.

### Inspect the current template versus the namespace's PodSecurity level

```bash
kubectl get catalogsource -A -o \
  custom-columns='NS:.metadata.namespace,NAME:.metadata.name,READY:.status.connectionState.lastObservedState'
```

Any row whose `READY` is not `READY` is a candidate. Read the rejected `CatalogSource` in full:

```bash
kubectl -n <ns> get catalogsource <name> -o yaml
```

Note the `spec.grpcPodConfig` block (if present) and the `status.message` that names the exact admission violation. Then read the namespace label set:

```bash
kubectl get ns <ns> -o jsonpath='{.metadata.labels}{"\n"}' | jq
```

The relevant labels are:

- `pod-security.kubernetes.io/enforce`
- `pod-security.kubernetes.io/enforce-version`
- `pod-security.kubernetes.io/warn`
- `pod-security.kubernetes.io/audit`

If `enforce=baseline` or `enforce=restricted` is set, the registry pod must satisfy that level. If no enforce label exists, the cluster's default PodSecurity policy applies.

### Option A — tighten the registry pod template to match the namespace

Edit the `CatalogSource` to declare a security context compatible with the namespace's `PodSecurity` level:

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: <name>
  namespace: <ns>
spec:
  sourceType: grpc
  image: <catalog-index-image>
  grpcPodConfig:
    securityContextConfig: restricted
    nodeSelector:
      kubernetes.io/os: linux
```

The `securityContextConfig: restricted` value tells OLM to render a pod template that satisfies the `restricted` PodSecurity profile — no privilege escalation, no host namespaces, a non-root user, an explicit seccomp profile. `legacy` (or an unset field) produces the historical permissive shape; `restricted` is the modern default on namespaces that enforce tight PodSecurity.

Apply and watch:

```bash
kubectl -n <ns> get pod -l olm.catalogSource=<name> -w
```

The registry pod should reach `Running` within one reconcile cycle; `status.connectionState.lastObservedState` on the `CatalogSource` flips to `READY` shortly after.

### Option B — loosen the namespace's PodSecurity enforcement

If the catalog pod genuinely needs privileges the active PodSecurity level refuses (rare; typically only legacy index images), relax the namespace label instead of the pod. This is the less preferred path because it weakens the namespace for every workload in it, not just the catalog:

```bash
# Only if Option A is not feasible — and only for the namespace that
# specifically hosts the CatalogSource, never cluster-wide.
kubectl label namespace <ns> \
  pod-security.kubernetes.io/enforce=privileged --overwrite
```

Prefer to dedicate a narrowly scoped namespace to catalog workloads so this relaxation does not spill over to application workloads.

### Option C — remove the offending mutation

If a mutating admission webhook is rewriting the pod's security context after OLM submits a compliant template, the correct fix is at the webhook: narrow its match conditions so it does not select catalog registry pods, or change its mutation to a compliant value. Identify the mutator by looking at the accepted-vs-rejected diff on the catalog pod's AdmissionReview:

```bash
kubectl get mutatingwebhookconfiguration -o \
  custom-columns='NAME:.metadata.name,WEBHOOKS:.webhooks[*].name'
```

Narrow the selector on any webhook whose scope includes the catalog namespace. After adjusting the webhook, re-reconcile OLM by deleting the pending catalog pod; the new one will come up without the rewritten security context.

## Diagnostic Steps

Confirm the `CatalogSource`'s most recent failure message:

```bash
kubectl -n <ns> get catalogsource <name> -o jsonpath='{.status}' | jq
```

`connectionState.lastObservedState: READY` means the registry is serving; any other state (`CONNECTING`, `TRANSIENT_FAILURE`) combined with a non-empty `message` names the admission error that needs resolving.

List the pods that OLM tried to create for this catalog (they appear with an `olm.catalogSource` label):

```bash
kubectl -n <ns> get pod -l olm.catalogSource=<name> \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,REASON:.status.reason'
```

If no pod is listed, the admission refusal happened before a pod object was even created — inspect the `Events` on the `CatalogSource`:

```bash
kubectl -n <ns> describe catalogsource <name>
```

Events with `Reason: FailedCreate` and the PodSecurity message in `Message` pinpoint the fix.

After reconciling, validate the end-to-end path by pinning a `Subscription` to the just-repaired catalog and confirming its `InstallPlan` progresses through `Pending` to `Complete`:

```bash
kubectl -n <subscription-ns> get subscription <name> \
  -o jsonpath='{.status}' | jq '{currentCSV, state, installedCSV, installPlanRef}'
kubectl -n <subscription-ns> get installplan -o \
  custom-columns='NAME:.metadata.name,PHASE:.status.phase'
```

Once the catalog is serving again, every previously stalled subscription resumes reconciling in one of the next few install-plan cycles.
