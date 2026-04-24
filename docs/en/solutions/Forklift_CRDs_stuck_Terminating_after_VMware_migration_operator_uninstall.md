---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After uninstalling the VMware-to-KubeVirt migration operator (Forklift — the upstream project that powers ACP `virtualization`'s "migrate virtual machines from VMware" workflow) following the documented procedure, the cleanup never completes. Several of its `CustomResourceDefinition` objects remain visible on the cluster in the `Terminating` phase indefinitely:

```bash
$ kubectl get crd -o name | grep 'forklift'
customresourcedefinition.apiextensions.k8s.io/forkliftcontrollers.forklift.konveyor.io
customresourcedefinition.apiextensions.k8s.io/hosts.forklift.konveyor.io
customresourcedefinition.apiextensions.k8s.io/migrations.forklift.konveyor.io
customresourcedefinition.apiextensions.k8s.io/plans.forklift.konveyor.io
customresourcedefinition.apiextensions.k8s.io/providers.forklift.konveyor.io
...

$ kubectl get crd forkliftcontrollers.forklift.konveyor.io \
    -o jsonpath='{.status.conditions}'
[{"type":"Terminating","status":"True",...}]
```

Because at least one Forklift CRD is stuck, any subsequent reinstall of the migration component or cluster cleanup workflow cannot proceed cleanly.

## Root Cause

The Forklift CRDs carry one or more **finalizers** that the operator's controller is supposed to clear during its shutdown sequence. The finalizer pattern is the standard Kubernetes way to guarantee "run cleanup code before the object actually disappears" — the API server refuses to remove the object from etcd while any string remains in `metadata.finalizers`.

When the operator is removed (or crashes, or is scaled to zero) before it gets a chance to clear its finalizers, there is nobody left to drain them. The CRDs then sit in `Terminating` forever, waiting for a reconciliation that will never happen.

Inspect one stuck CRD to confirm:

```bash
kubectl get crd forkliftcontrollers.forklift.konveyor.io -o yaml | \
  grep -A2 finalizers
```

You will see an entry such as `forklift.konveyor.io/controller-finalizer` still attached.

## Resolution

Once you have confirmed the operator itself is gone — and there are no remaining Forklift CRs (`Provider`, `Plan`, `Migration`, `Host`, `ForkliftController`) that you still want to preserve — it is safe to drop the blocking finalizers manually so the API server can complete deletion.

### 1. Verify the operator is actually uninstalled

The finalizer only needs to be cleared by hand when the controller is no longer running. If the operator is still present, the correct action is to let it finish its teardown.

```bash
# No deployment/pod from the migration operator should remain.
kubectl get pods -A | grep -iE 'forklift|konveyor|mtv'

# No Subscription/ClusterServiceVersion should reference it either.
kubectl get subscriptions.operators.coreos.com -A | grep -iE 'forklift|mtv'
kubectl get csv -A | grep -iE 'forklift|mtv'
```

If any of those return rows, do the proper operator uninstall (remove the `Subscription` + corresponding CSV / `OperatorGroup` artifacts that ACP `extend` placed when the operator was installed) before touching finalizers.

### 2. Drop any residual Forklift CRs that might block the CRDs

CRDs cannot finish `Terminating` if instances of the CRD still exist. Clear the residual CRs first:

```bash
for kind in providers plans migrations hosts forkliftcontrollers; do
  kubectl get "${kind}.forklift.konveyor.io" -A -o name 2>/dev/null
done

# For anything that shows up, patch its finalizers off too:
kubectl -n <ns> patch <kind>/<name> --type=merge \
  -p '{"metadata":{"finalizers":[]}}'
kubectl -n <ns> delete <kind>/<name> --wait=false
```

### 3. Strip the finalizer from each stuck CRD

Loop over the Forklift CRDs and null out their `metadata.finalizers`:

```bash
for crd in $(kubectl get crd -o name | grep 'forklift'); do
  kubectl patch "$crd" --type=merge \
    -p '{"metadata":{"finalizers":[]}}'
done
```

For a single CRD the same command looks like:

```bash
kubectl patch crd/forkliftcontrollers.forklift.konveyor.io \
  --type=merge -p '{"metadata":{"finalizers":[]}}'
```

As soon as the last finalizer is removed, the API server reaps the CRDs.

### 4. Verify the cleanup completed

```bash
kubectl get crd -o name | grep 'forklift' || echo "all forklift CRDs gone"
```

The command should return no Forklift entries. At this point the migration component is fully uninstalled and it is safe to reinstall (or proceed with cluster cleanup).

## Diagnostic Steps

If a CRD will not terminate even after the finalizer is cleared, inspect it for other blockers:

```bash
# 1. What exactly is holding the CRD?
kubectl get crd <crd-name> -o yaml | \
  grep -EA2 'finalizers:|conditions:|deletionTimestamp:'

# 2. Are there still CR instances of that kind?
kubectl get <crd-kind> -A

# 3. Is the API server refusing because the discovery cache is stale?
kubectl api-resources --api-group=forklift.konveyor.io
```

An instance of the CRD's own kind still existing is the most common reason `kubectl patch crd ... finalizers: []` does not immediately clear the object — remove the child CRs (step 2 above) and the CRD will then be reaped.
