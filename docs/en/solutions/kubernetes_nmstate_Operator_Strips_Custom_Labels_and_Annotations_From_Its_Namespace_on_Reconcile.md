---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

ArgoCD shows the namespace holding the kubernetes-nmstate operator (typically `cpaas-nmstate` or `nmstate`) as **OutOfSync**. Labels or annotations defined in Git for that namespace disappear shortly after ArgoCD syncs — the next reconcile from ArgoCD reapplies them, the nmstate operator strips them again, and the "OutOfSync ↔ Synced" flapping continues indefinitely. Common victims are cost-center labels, monitoring-scrape-scope annotations, and compliance metadata applied by cluster operators.

The break is not a race with ArgoCD; ArgoCD is correctly reapplying the desired state from Git. The namespace keeps losing fields because a second controller — the nmstate operator — is actively **rewriting** the namespace object, and its reconciled shape omits anything the operator did not itself set.

## Root Cause

The operator owns the namespace it installs into and reconciles its own view of that namespace's metadata. In affected operator versions, the reconcile logic rewrites the namespace with only the labels and annotations the operator considers mandatory — it does not merge user-added fields onto the base, it replaces. Labels added by ArgoCD (or by any other actor) are therefore silently dropped on the next operator reconcile tick.

The operator's log carries a specific signature when the reconcile runs:

```text
level=info logger=controllers.NMState
  msg="failed strategic patch but succeeded fallback …"
  Namespace=""

level=dpanic logger=controllers.NMState
  msg="odd number of arguments passed as key-value pairs for logging"
  ignored key="cpaas-nmstate"
```

The `dpanic`-level log line confirms the namespace reconciliation code path; the `fallback` in the first line is where the non-merging replacement happens.

A fix to make the reconciler merge rather than replace landed in newer operator versions. Until the cluster runs a fixed operator, the right mitigation is either to upgrade or to stop reconciling external metadata into that namespace from Git.

## Resolution

### Preferred — upgrade the kubernetes-nmstate operator

Follow the operator-upgrade path to a version that ships the namespace-preserve fix. After the upgraded pod reconciles, apply the ArgoCD Application again — the custom labels and annotations now persist across subsequent operator reconciles.

Verify:

```bash
NS=<nmstate-ns>
kubectl get namespace "$NS" -o yaml | yq '.metadata.labels, .metadata.annotations'
```

Wait a few operator reconcile cycles (a minute or two) and re-read; the output should be stable with the Git-declared labels / annotations still present.

### Workaround — exclude namespace metadata from ArgoCD sync

Until the upgrade is available, stop the flap by instructing ArgoCD not to compare (and not to prune) the specific fields the operator rewrites. Two shapes of exclusion work:

**Use `ignoreDifferences` on the Application** so ArgoCD keeps the namespace's operator-managed metadata stable:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nmstate-installation
spec:
  # ... source / destination ...
  ignoreDifferences:
    - group: ""
      kind: Namespace
      name: cpaas-nmstate
      jsonPointers:
        - /metadata/labels
        - /metadata/annotations
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

ArgoCD no longer flags the namespace as out-of-sync when the operator strips a label; it keeps applying everything else from Git as normal.

Trade-off: the labels / annotations ArgoCD intended to set on the namespace won't stick. They are effectively lost until the operator upgrade. Most teams prefer the flap to stop at the cost of temporarily giving up those fields.

**Exclude the namespace from ArgoCD's managed scope entirely** by moving the namespace out of the Application's `source` and creating it through a different, non-ArgoCD channel until the operator is upgraded. This is the heavy-handed version; do it only if the labels / annotations in question are important enough to set imperatively.

### If you absolutely need specific labels to persist

If a specific label is critical (e.g. a monitoring system's scrape-target label), you can attempt to apply it through a controller-managed resource **other than** the namespace itself:

- Apply the label to the workloads inside the namespace (pods, deployments). The monitoring tool then scrapes by pod label instead of namespace label.
- Use a separate ValidatingAdmissionPolicy or small mutating webhook to re-inject the label after the operator strips it. Heavy engineering for a workaround; prefer the upgrade.

Neither workaround is durable — schedule the operator upgrade as soon as the release cadence allows.

## Diagnostic Steps

Confirm the namespace keeps losing metadata:

```bash
NS=<nmstate-ns>
# Take a reference snapshot.
kubectl get namespace "$NS" -o yaml | yq '.metadata' > /tmp/ns-before.yaml

# Force ArgoCD to re-apply the namespace from Git.
argocd app sync <nmstate-app> --resource "Namespace/$NS"

# Watch the namespace for a minute, then re-read.
sleep 90
kubectl get namespace "$NS" -o yaml | yq '.metadata' > /tmp/ns-after.yaml

diff /tmp/ns-before.yaml /tmp/ns-after.yaml
```

If labels that ArgoCD just reapplied are missing from the `after` snapshot, the operator has stripped them.

Inspect the operator log for the reconcile signature:

```bash
kubectl -n "$NS" logs -l name=nmstate-operator --tail=500 | \
  grep -iE 'NMState|apply|namespace' | tail -20
```

The `failed strategic patch but succeeded fallback` entry for `Namespace` confirms the operator is the actor replacing the namespace metadata.

After applying either the upgrade (preferred) or the workaround, re-run the snapshot comparison. In the upgraded case the `after` snapshot equals the `before` snapshot (all custom metadata preserved). In the workaround case ArgoCD reports Synced regardless of the operator's edits — the flap stops, but the custom metadata the operator rewrote is gone.
