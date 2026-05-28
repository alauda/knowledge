---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Controlling Copied CSVs on ACP with the OLMConfig disableCopiedCSVs feature

## Overview

On Alauda Container Platform, Operator Lifecycle Management exposes a cluster-scoped singleton `OLMConfig` (apiVersion `operators.coreos.com/v1`, kind `OLMConfig`, name `cluster`) whose `spec.features.disableCopiedCSVs` boolean controls whether a cluster-wide operator's ClusterServiceVersion is copied into other namespaces. On the cluster managed by the marketplace chart (chart version `v4.3.7`, OLM controllers `olm-operator` and `catalog-operator` running in `cpaas-system`), this singleton ships with `spec.features.disableCopiedCSVs` already set to `true` out of the box.

The `disableCopiedCSVs` feature governs only the Copied CSV behavior for operators that are already cluster-scoped via an AllNamespaces OperatorGroup; it does not define the reach of an operator install. The boundaries of an operator install — namespace-scoped versus cluster-wide — are determined by the OperatorGroup, not by this field.

## Root Cause

When `disableCopiedCSVs` is `false`, OLM copies a cluster-wide (AllNamespaces) operator's ClusterServiceVersion into every namespace, producing one Copied CSV per namespace. Setting `disableCopiedCSVs` to `true` stops that copying, so the ClusterServiceVersion remains only in the operator's install namespace and no copies are created elsewhere.

The original, non-copied ClusterServiceVersion lives in the namespace that holds the operator's Subscription, since the Subscription is what drives the install. On the managed cluster the `argocd-operator.v4.2.0` ClusterServiceVersion resides in the `argocd` namespace alongside its Subscription, with no copy in any other namespace.

## Resolution

Inspect the current setting by reading the singleton directly:

```bash
kubectl get OLMConfig cluster -o yaml
```

To change the feature, apply a manifest that sets the field on the `cluster` singleton:

```yaml
apiVersion: operators.coreos.com/v1
kind: OLMConfig
metadata:
  name: cluster
spec:
  features:
    disableCopiedCSVs: true
```

```bash
kubectl apply -f olm-config.yaml
```

Disabling Copied CSVs does not affect the operator's reach. The operator's reconcile scope is set by its OperatorGroup, not by this field, so an operator whose OperatorGroup targets all namespaces still acts on every namespace even when no Copied CSV is present there. Because reach is set by the AllNamespaces OperatorGroup rather than by this field, an operator with an AllNamespaces OperatorGroup watches every namespace even while Copied CSVs are disabled.

## Diagnostic Steps

The `OLMConfig` singleton reports the Copied CSV state through a status condition of type `DisabledCopiedCSVs`. When Copied CSVs are disabled the condition carries reason `CopiedCSVsDisabled`; `CopiedCSVsEnabled` is the other value of this condition's reason field — the reason the status would report were `disableCopiedCSVs` set to `false`. Read the singleton to inspect this condition:

```bash
kubectl get OLMConfig cluster -o yaml
```

To confirm that no copies exist, list ClusterServiceVersions across namespaces. With `disableCopiedCSVs=true` each ClusterServiceVersion appears only in its own install namespace, and no ClusterServiceVersion is a copy of another. For the AllNamespaces `argocd-operator.v4.2.0` operator, its ClusterServiceVersion is present only in the `argocd` namespace, the same namespace as its Subscription.
