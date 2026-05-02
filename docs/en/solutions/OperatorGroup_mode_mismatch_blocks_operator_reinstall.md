---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Reinstalling an operator into a namespace that previously hosted an older version of the same operator fails. The marketplace UI rejects the install with:

```text
The OperatorGroup in the cpaas-logging Namespace does not support the
global installation mode. Select a different installation Namespace
that supports this mode.
```

The CLI variant carries the same message in the Subscription's status:

```yaml
status:
  conditions:
    - type: ResolutionFailed
      status: "True"
      reason: ConstraintsNotSatisfiable
      message: "OperatorGroup ... does not support installation mode AllNamespaces"
```

The user did not configure anything different — they simply uninstalled the previous version and clicked install on the new one.

## Root Cause

OLM uses an `OperatorGroup` (OG) object in the install namespace to define which namespaces an operator's controllers should watch. The OG carries a `spec.targetNamespaces` list, and OLM derives an "installation mode" from that list:

- Empty list (`spec.targetNamespaces: []`) → `AllNamespaces` mode (cluster-wide).
- One namespace listed → `OwnNamespace` mode (just the install namespace).
- Multiple namespaces listed → `MultiNamespace` mode.
- A namespace different from the OG's own → `SingleNamespace` mode.

An operator's bundle declares which modes it supports in `spec.installModes` of its CSV. OLM checks the OG's mode against the operator's `installModes` at resolve time. If they don't match, the install is rejected.

The mode an operator supports can change between releases. A frequent flip is when an operator that once was scoped per-namespace gets refactored into a cluster-wide controller, and the new bundle declares `AllNamespaces: true` while dropping `OwnNamespace: true`. If the user uninstalls the old version through the marketplace UI but the OG that was created for the old version is left behind (the UI sometimes deletes the Subscription and CSV but not the OG), the leftover OG still encodes `targetNamespaces: [<install-ns>]` — i.e. `OwnNamespace` mode. The new operator's bundle no longer supports that mode, and the resolver refuses to proceed.

## Resolution

Delete the leftover OperatorGroup in the install namespace, then reinstall. The marketplace controller will create a fresh OG with the right mode for the new operator bundle.

```bash
NS=cpaas-logging

# 1. List every OG currently in the namespace.
kubectl -n "$NS" get operatorgroup
# NAME                  AGE
# cpaas-logging-5bvj6   97d

# 2. Inspect the leftover OG's targetNamespaces to confirm the mode mismatch.
kubectl -n "$NS" get operatorgroup cpaas-logging-5bvj6 -o yaml \
  | yq '.spec.targetNamespaces'
# - cpaas-logging        # this is OwnNamespace mode

# 3. Delete the leftover OG.
kubectl -n "$NS" delete operatorgroup cpaas-logging-5bvj6
```

Re-issue the install. If installing through the marketplace UI, the operator wizard will create a new OG with the right mode (`AllNamespaces` → empty `targetNamespaces` list). If installing via manifest, write the OG explicitly first:

```yaml
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: cpaas-logging-og
  namespace: cpaas-logging
spec: {}                # empty spec ⇒ AllNamespaces mode
```

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: cluster-logging
  namespace: cpaas-logging
spec:
  channel: stable
  name: cluster-logging
  source: community-catalog
  sourceNamespace: cpaas-marketplace
  installPlanApproval: Automatic
```

Apply both and watch the Subscription advance through `UpgradePending` → `Installing` → `Complete`.

### Why deleting the OG is safe

The OG itself owns nothing in the data plane. Deleting it does not remove the operator's CRs, its workloads, or its CRDs. What an OG controls is purely the visibility scope OLM grants to the operator's ServiceAccount through generated RBAC. A fresh OG with the right mode regenerates the same RBAC. The data plane survives the brief window between OG delete and re-create — it is the operator's control loop that pauses, not the workloads it manages.

That said, there is a small RBAC-coverage gap during the swap. Pods that depend on the operator continuing to reconcile (e.g. log-collector DaemonSets that rely on the logging operator validating their config) can see transient errors during the few seconds the operator's RBAC is missing. Schedule the swap during a maintenance window if any controller-of-controllers chain runs through the operator.

## Diagnostic Steps

To confirm the mode mismatch before deleting anything, line up the OG's effective mode against the operator bundle's supported modes.

The OG's mode (derived):

```bash
kubectl -n "$NS" get operatorgroup -o yaml \
  | yq '.items[].spec.targetNamespaces' \
  | head
```

- A `null` or empty list → `AllNamespaces`.
- A single entry equal to `$NS` → `OwnNamespace`.
- A single entry different from `$NS` → `SingleNamespace`.
- Multiple entries → `MultiNamespace`.

The operator bundle's supported modes (from the bundle CSV in the catalog):

```bash
CATALOG=community-catalog
PKG=cluster-logging

kubectl exec -n cpaas-marketplace deploy/<catalog-pod> -- \
  grpcurl -plaintext localhost:50051 api.Registry.GetBundle \
  -d '{"pkgName":"'"$PKG"'","channelName":"stable"}' \
  2>/dev/null | jq '.csvJson | fromjson | .spec.installModes'
```

Cross-reference: any mode the OG sits in that is not `supported: true` in the bundle is the conflict.

If the OG looks right but the install still fails, check whether two OGs exist in the same namespace — OLM only allows one OG per namespace and rejects installs when multiple are present:

```bash
kubectl -n "$NS" get operatorgroup --no-headers | wc -l
```

A count > 1 is the second cause of this error class. Delete the duplicates, leaving only the OG whose mode matches the operator.

For installs that succeed but the operator pod still doesn't get the right RBAC (silent half-state where the operator deploys but its reconciles fail with `Forbidden`), inspect the cluster role bindings the OG generated:

```bash
kubectl get clusterrolebinding -l olm.owner.namespace="$NS" -o name
```

Each role binding reflects one entry in the OG's effective scope. A missing binding for an expected target namespace means the OG's mode and the operator's expectations still differ — re-run the swap with the OG explicitly set to `AllNamespaces`.
