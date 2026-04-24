---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A pod stays stuck in `CreateContainerConfigError` and the events show the kubelet refusing to mount or expand a referenced object:

```text
Warning  Failed   Error: secret    "<name>" not found
Warning  Failed   Error: configmap "<name>" not found
```

The object does exist in the cluster — `kubectl get secret/configmap --all-namespaces | grep <name>` finds it — but in **another** namespace. A workload in namespace `app-a` is referencing a `Secret` or `ConfigMap` defined in namespace `app-b`, and the mount fails because Kubernetes resolves the reference inside the pod's own namespace only.

The pattern shows up most often when an operator wants a single source of truth for shared material (a CA bundle, an image-pull secret, a feature-flag map) and assumes the kubelet will look across namespaces.

## Root Cause

`ConfigMap` and `Secret` are namespaced API resources. The two ways a pod consumes them — `envFrom`/`env.valueFrom.{configMapKeyRef,secretKeyRef}` and `volumes.{configMap,secret}` — both resolve the reference inside the pod's own namespace. There is no cross-namespace selector for either field. A pod in `app-a` cannot mount a `Secret` from `app-b` directly.

This is a deliberate isolation boundary: a namespace is the unit Kubernetes uses to scope RBAC and quota, and letting any pod read any `Secret` cluster-wide by reference would defeat that boundary. Some special-case mechanisms (image-pull secrets attached to a `ServiceAccount` are still resolved per-namespace; the platform's certificate signers expose CA material through cluster-scoped objects) exist precisely because the general rule is so strict.

## Resolution

Pick the pattern that matches the operational story — copy, sync, or surface through a controller.

1. **Copy the object into the target namespace.** This is the simplest answer when the source rarely changes. A `kubectl apply -f` against a YAML extracted from the source namespace works; for an ad-hoc copy:

   ```bash
   kubectl get secret shared-tls -n app-b -o yaml \
     | sed -e 's/namespace: app-b/namespace: app-a/' \
           -e '/resourceVersion:/d' -e '/uid:/d' -e '/creationTimestamp:/d' \
     | kubectl apply -f -
   ```

   The downside is drift: when the source is rotated, every copy must be re-applied. For a CA bundle that rotates yearly this is acceptable; for an API key that rotates daily it is not.

2. **Run a small sync controller for objects that change often.** Two open-source projects fit cleanly:

   - **Reflector** (annotation-driven): annotate the source `Secret` with the list of namespaces (or a regex) that should receive a copy, and the controller mirrors it on every change.
   - **External Secrets** (with a `ClusterSecretStore`): for material that lives in an upstream vault, `External Secrets` reads from the vault and writes per-namespace `Secret` objects that match the pod's reference.

   Both run as a controller in a single namespace and require only `get`/`watch` cluster-wide on the source kind plus `create`/`update` on the destinations.

3. **For TLS material specifically, prefer the cert-manager flow.** A `Certificate` resource per namespace, signed by a shared `ClusterIssuer`, gives each namespace its own `Secret` with a key it owns. This avoids the copy-the-private-key pattern entirely.

4. **Surface shared configuration through a CRD instead of a `ConfigMap`.** When the shared object is read by a controller (not by the pod's kubelet), the controller can consume a cluster-scoped CRD directly and there is no namespace-resolution step. This is the right pattern for cluster-wide policy or feature-flag data.

5. **Do not try to grant cross-namespace `secret` reads to all ServiceAccounts.** RBAC allows it, but it is a maintenance and audit liability — every workload that ever runs in any namespace then has read access to the source. The copy or sync patterns above are far easier to reason about during an incident review.

## Diagnostic Steps

Confirm the object exists somewhere in the cluster and identify the source namespace:

```bash
kubectl get secret --all-namespaces | grep <name>
kubectl get configmap --all-namespaces | grep <name>
```

Confirm the consuming pod's namespace and the reference it is making:

```bash
kubectl -n app-a describe pod <pod> | grep -A2 -i -E "secret|configmap"
kubectl -n app-a get pod <pod> -o yaml \
  | yq '.spec.containers[].envFrom, .spec.containers[].env, .spec.volumes'
```

Check that any sync controller actually wrote a copy (when using Reflector or External Secrets):

```bash
kubectl -n app-a get secret <name>
kubectl -n app-a get secret <name> -o jsonpath='{.metadata.annotations}{"\n"}'
```

If the copy exists but the pod is still failing, the next layer to check is the data: the keys inside the destination `Secret`/`ConfigMap` must match the keys the pod references in `key:`. A copy of a `Secret` between namespaces is byte-identical only when the controller wrote it; a hand-edited copy that re-encoded the values often introduces a key mismatch instead.
