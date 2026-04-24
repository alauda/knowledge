---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Operator Lifecycle Manager (OLM) keeps the canonical `ClusterServiceVersion` (CSV) for each installed operator in the namespace that owns the `Subscription`. When an operator is installed cluster-wide, OLM also writes a **copy** of that CSV into every other namespace in the cluster so that namespace-local tooling can discover the operator. On a busy cluster, these copies multiply the CSV count by the number of namespaces and can add visible load on the API server and on `kubectl` tooling that lists CSVs cluster-wide.

The `OLMConfig` singleton exposes a feature switch that suppresses these copies:

```yaml
apiVersion: operators.coreos.com/v1
kind: OLMConfig
metadata:
  name: cluster
spec:
  features:
    disableCopiedCSVs: true
```

This note describes what that switch changes, what it does not, and how the status condition it emits should be read.

## Root Cause

Two orthogonal OLM resources govern operator reach and operator visibility:

- **`OperatorGroup` (OG)** declares the *scope* of an operator installation — which namespaces the operator is allowed to watch and act against. An `AllNamespaces`-mode install has an empty `targetNamespaces`; a namespace-scoped install lists specific targets.
- **`OLMConfig`** is a cluster-scoped singleton (name always `cluster`) that holds global OLM behaviour flags. `disableCopiedCSVs` is one such flag.

When `disableCopiedCSVs: false` (the default), OLM reconciles every `AllNamespaces`-mode operator into a shadow CSV in each non-owning namespace. The shadow is marked with `olm.copiedFrom` on the owner namespace and exists purely for discovery — deleting or editing it has no effect on the operator.

When `disableCopiedCSVs: true`, OLM stops writing those copies and removes the ones it already wrote. The canonical CSV in the install namespace is untouched.

Crucially, flipping the switch does **not** change what an operator can do. Operator scope is owned entirely by the `OperatorGroup`. A cluster-wide operator can still reconcile Custom Resources in any namespace whether or not the copies exist; likewise, restricting the operator's reach requires editing the `OperatorGroup`, not the `OLMConfig`.

## Resolution

### Enable `disableCopiedCSVs` on the cluster

The `OLMConfig` object is created by OLM itself during install and is always named `cluster`. Apply the feature flag:

```bash
kubectl apply -f - <<'EOF'
apiVersion: operators.coreos.com/v1
kind: OLMConfig
metadata:
  name: cluster
spec:
  features:
    disableCopiedCSVs: true
EOF
```

OLM reconciles the change asynchronously. When reconciliation finishes, the singleton's status carries a `DisabledCopiedCSVs` condition. Two condition shapes are expected:

```yaml
# Clean state — all copied CSVs have been removed.
status:
  conditions:
    - type: DisabledCopiedCSVs
      status: "True"
      reason: CopiedCSVsDisabled
      message: Copied CSVs are disabled

# Transient / anomalous state — flag is on but OLM still finds
# a copied CSV it did not expect (typically left over from an
# AllNamespaces install that has not yet been re-reconciled).
status:
  conditions:
    - type: DisabledCopiedCSVs
      status: "False"
      reason: CopiedCSVsDisabled
      message: >-
        Copied CSVs are disabled and at least one unexpected copied CSV
        was found for an operator installed in AllNamespaces mode
```

If the condition stays in the second shape, either OLM has not finished reconciling (give it one or two install-plan cycles) or an operator's owner namespace itself was deleted — the copy survives because its owner reference no longer resolves. Grep for stray copies and reconcile:

```bash
kubectl get csv -A -l olm.copiedFrom -o \
  custom-columns='NS:.metadata.namespace,NAME:.metadata.name,COPIED_FROM:.metadata.labels.olm\.copiedFrom'
```

### Observe the reduction in CSV count

Compare CSV count before and after. On a cluster with N namespaces and K cluster-wide operators installed in `AllNamespaces` mode, the expected drop is `(N-1) × K` entries:

```bash
# Before (default behaviour)
kubectl get csv -A --no-headers | wc -l

# After (with disableCopiedCSVs=true)
kubectl get csv -A --no-headers | wc -l
```

Namespaces that are newly created after the flag is on also receive no copy, so the reduction compounds over time on dynamically provisioned namespaces.

### What this flag does not do

- It does **not** reduce the reach of a cluster-wide operator. Workloads in any namespace can still create a Custom Resource of a type the operator owns, and the operator will reconcile it:

  ```bash
  # Operator installed cluster-wide in `operators` namespace.
  kubectl get csv -A --no-headers | grep example-operator
  # → only the main CSV in `operators`, no copies (flag on).

  # A new namespace with no CSV — CR creation still works.
  kubectl create namespace example-workloads
  kubectl apply -n example-workloads -f - <<'EOF'
  apiVersion: example.com/v1
  kind: Example
  metadata: { name: demo }
  spec: { replicas: 1 }
  EOF
  kubectl -n example-workloads get example demo -o yaml | head
  ```

  The CR is reconciled normally; the operator's scope is unchanged.

- It does **not** affect the authoritative CSV in the operator's own namespace.
- It does **not** interact with `OperatorGroup` targeting. Namespace-scoped installs were never copied in the first place — they are invisible to the flag.

### When to prefer this flag

Turn `disableCopiedCSVs: true` on when the cluster runs a meaningful number of cluster-wide operators (rule of thumb: more than two or three) and the namespace count is large or growing. The reduction in CSV row count makes cluster-wide `kubectl get csv -A`, dashboards that index CSVs, and admission-time lookups noticeably faster. The trade-off is that a user running `kubectl get csv -n <arbitrary-ns>` no longer sees a local row for a cluster-wide operator and has to be aware that operator visibility lives in the install namespace.

## Diagnostic Steps

Read the current `OLMConfig` state:

```bash
kubectl get olmconfig cluster -o yaml
```

The `spec.features.disableCopiedCSVs` field is the request; `status.conditions` with `type: DisabledCopiedCSVs` is the reconciled state.

Enumerate which CSVs are canonical versus copied:

```bash
kubectl get csv -A -o json | jq -r '
  .items[]
  | "\(.metadata.namespace)\t\(.metadata.name)\t\(.metadata.labels["olm.copiedFrom"] // "canonical")"
'
```

Rows where the third column is `canonical` live in the operator's install namespace; rows with a namespace name in that column are copies from that namespace. With `disableCopiedCSVs: true` and a clean reconcile, no row should show a namespace name in the third column.

Check `OperatorGroup` scope per operator (to confirm that reach is what you expect, independent of the copy flag):

```bash
kubectl get operatorgroup -A -o \
  custom-columns='NS:.metadata.namespace,NAME:.metadata.name,TARGETS:.status.namespaces'
```

`TARGETS: []` means `AllNamespaces`-mode (no copy target list). A comma-separated list of namespace names means scoped install. The `OLMConfig` flag has no effect on the reach this field encodes.

After changing the flag, watch a single install cycle to confirm the behaviour. Install a test operator cluster-wide, verify the canonical CSV is created in the install namespace, then verify no copies appear in other namespaces:

```bash
kubectl -n operators get csv -l operators.coreos.com/<package-name>.operators=
kubectl get csv -A | grep <package-name>
```

The first command should return one row; the second should return the same single row.
