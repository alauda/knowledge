---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500012
---
## Issue

A namespace has been deleted but remains visible in `kubectl get ns` with the phase `Terminating`. The usual follow-up command lists no workload resources in the namespace, yet the namespace object itself refuses to go away:

```bash
kubectl get all -n scheduling
# No resources found.

kubectl describe namespace scheduling
# Status:  Terminating
```

Waiting does not help — the namespace will stay in `Terminating` for as long as it takes for every namespaced object that still carries a finalizer to have that finalizer cleared. This state often blocks recreating a namespace of the same name, breaks GitOps reconcile loops, and quietly retains quotas that count against the cluster budget.

## Root Cause

Namespace deletion in Kubernetes is cooperative: the API server removes the namespace object only after every resource inside it has been deleted. "Every resource" is broader than what `kubectl get all` prints — `all` is a curated alias that only lists a small set of kinds (Pod, Deployment, Service, and a handful more). Custom resources defined by CRDs, certificate requests, webhook configurations, policy objects, and many other namespaced kinds are not covered by that alias.

Deletion of those hidden resources is itself asynchronous because Kubernetes uses finalizers to coordinate teardown. A finalizer is a string on `metadata.finalizers` that blocks the API server from actually removing the object; the controller that owns the finalizer is expected to do its cleanup work and then strip its entry from the list. Once the list is empty, the object is garbage-collected, and once the namespace contains no more blocked objects, the namespace itself completes its own termination.

A namespace wedged in `Terminating` therefore means at least one finalizer is not being cleared. The three common reasons:

- The controller that installs the finalizer has been uninstalled or scaled to zero, so nothing is watching to remove it.
- The controller is running but cannot complete its cleanup (a downstream API unreachable, a missing credential, a webhook timing out).
- The object is a custom resource whose CRD itself has been deleted; without the CRD the controller is gone, leaving orphaned instances.

## Resolution

The safe fix is to find the specific resources holding finalizers, identify the owning controller, and let that controller finish its job. Forcing the finalizer off should be reserved for the case where the controller is known to be gone and its residual state is confirmed to be safe to drop.

Step 1 — enumerate every namespaced API resource kind the cluster knows about:

```bash
kubectl api-resources --namespaced --verbs=list -o name
```

Step 2 — list every object across every namespaced kind inside the stuck namespace and print the ones that still have finalizers:

```bash
NS=scheduling
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -n 1 kubectl get --show-kind --ignore-not-found -n "$NS" \
      -o jsonpath='{range .items[*]}{.kind}/{.metadata.name}: {.metadata.finalizers}{"\n"}{end}' \
  | awk -F: '$2 ~ /finalizer/'
```

Each non-empty line is a blocker. The kind and name tell you which controller should be removing the finalizer. Go fix the controller's view of the world first — for example, if `externalsecrets.external-secrets.io/foo: [external-secrets.io/finalizer]` shows up, verify the External Secrets operator is running, its webhook is reachable, and its credentials are valid. Resolving the controller's problem lets it drain its own work and the namespace completes on its own.

Step 2b — if the controller is genuinely gone and the object is known to be safe to drop (CRD uninstalled, operator removed, no external state that still matters), strip the finalizer by hand. Do this only when you are sure no downstream cleanup is missed:

```bash
kubectl patch <kind>/<name> -n "$NS" \
  --type=merge \
  -p '{"metadata":{"finalizers":null}}'
```

Repeat until every lingering object is gone. The namespace then transitions out of `Terminating` within a few seconds.

## Diagnostic Steps

Before forcing anything, gather evidence so you can justify the decision to remove a finalizer:

Inspect the namespace object itself for its own finalizer — the `kubernetes` finalizer on the namespace spec means the API server is still waiting for content cleanup, not for an external controller. If you see other finalizers on the namespace (rare), they come from custom admission / namespace-lifecycle controllers and should be cleared only after verifying the controller's intent:

```bash
kubectl get ns scheduling -o yaml | grep -A3 finalizers
```

Check whether any CRD has been deleted while instances still exist; orphaned CRs are a very common cause:

```bash
kubectl get crd -o name \
  | xargs -I{} sh -c 'kubectl get {} -n scheduling --ignore-not-found -o name 2>/dev/null'
```

Look at the events in the namespace and in the owning operator's namespace — controllers usually emit a reconcile error explaining exactly why they cannot remove their finalizer:

```bash
kubectl get events -n scheduling --sort-by=.lastTimestamp
kubectl logs -n <operator-namespace> deploy/<operator-deployment> --tail=200
```

For each problematic object, decide: is the external state this finalizer protects still present? For a `PersistentVolume` finalizer the answer might be a real storage volume that needs manual deprovision; for an operator-managed resource whose CRD has been removed, the state it guarded is usually already gone with the CRD. When in doubt, contact the author of the operator that created the resource before patching the finalizer away — forcing deletion of a resource whose external state is still live leaks that state.
