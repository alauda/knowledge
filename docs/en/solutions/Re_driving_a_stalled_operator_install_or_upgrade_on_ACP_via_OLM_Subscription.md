---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500464
---

# Re-driving a stalled operator install or upgrade on ACP via OLM Subscription

## Issue

On Alauda Container Platform clusters that run the Operator Lifecycle Manager (OLM) control plane, an operator install or upgrade can stop making progress and stay parked at its current version. The OLM control-plane components — `catalog-operator` and `olm-operator` — run in the `cpaas-system` namespace, so that namespace is where the install machinery itself lives; an operator's own `Subscription`, `InstallPlan`, and `ClusterServiceVersion` (CSV) live in the operator's own namespace, not in `cpaas-system`. Confirm the control-plane pods are healthy before treating a stall as an OLM-level problem:

```bash
kubectl get pods -n cpaas-system | grep -E 'catalog-operator|olm-operator'
```

A `1/1 Running` line for each component indicates the control plane itself is up, so a stuck upgrade is more likely a stalled resolution against an individual operator's resources than an OLM outage.

## Root Cause

An operator's progression through install and upgrade is driven by three OLM resources reconciled in the operator's own namespace: the `Subscription` (`subscriptions.operators.coreos.com`) carries a `status.installPlanRef` pointing at the resolved `InstallPlan`, plus a resolution `state` such as `AtLatestKnown`; the `InstallPlan` (`installplans.operators.coreos.com`) records an approval mode and approval status; and the resulting CSV advances through a phase up to `Succeeded`. OLM reconciles InstallPlans under both `Automatic` and `Manual` approval modes. When resolution gets wedged, the Subscription continues to reference a stale or unfulfilled InstallPlan and the CSV never reaches `Succeeded`, so the operator stays at its current version.

## Resolution

Deleting and recreating the operator's `Subscription` forces OLM to re-resolve the operator and re-attempt the install or upgrade: OLM clears the old InstallPlan reference and generates a fresh `InstallPlan` for the recreated Subscription, which lets a stalled resolution proceed. Capture the current Subscription spec first, then delete and recreate it in the operator's own namespace (substitute the operator's actual Subscription name and namespace):

```bash
kubectl get subscription -n <operator-namespace> <subscription-name> -o yaml > sub-backup.yaml
kubectl delete subscription -n <operator-namespace> <subscription-name>
kubectl apply -f sub-backup.yaml
```

After recreation, OLM produces a new `InstallPlan` in the same namespace; for a `Manual`-approval Subscription, approve the generated InstallPlan so resolution can continue, then watch the CSV advance to `Succeeded`.

## Diagnostic Steps

Read the Subscription status to see which `InstallPlan` it currently references and its resolution `state`; an unfulfilled reference or a state that never settles points at the stalled resolution. These resources live in the operator's own namespace — for example, an `acp-storage` operator's Subscription reports `status.installPlanRef.namespace` of `acp-storage` and a `state` of `AtLatestKnown` once settled:

```bash
kubectl get subscription -n <operator-namespace> <subscription-name> \
  -o jsonpath='{.status.installPlanRef.name}{"\n"}{.status.state}{"\n"}'
```

Then inspect the referenced `InstallPlan` for its approval mode and approval status, and confirm the CSV phase — a healthy chain ends with the CSV at `Succeeded`, as seen for `acp-storage-operator.v4.3.2` in namespace `acp-storage`:

```bash
kubectl get installplan -n <operator-namespace>
kubectl get csv -n <operator-namespace>
```

These steps were validated on a cluster running Alauda Container Platform `v4.3.13` (Kubernetes `v1.34.5`).
