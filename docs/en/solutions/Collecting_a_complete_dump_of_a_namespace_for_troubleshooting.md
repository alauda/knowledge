---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500002
---

# Collecting namespace resources and pod logs on ACP with kubectl

## Issue

On Alauda Container Platform, gathering a complete picture of a single namespace for diagnosis means capturing two things: the manifests of every namespaced resource in that namespace [ev:c3], and the logs of every container in every pod [ev:c5]. Doing this efficiently — without firing one API request per resource type or missing a crashed container's prior logs — relies on a small, repeatable sequence of `kubectl` calls rather than ad-hoc per-object commands. This recipe scopes the gather to one namespace (optionally extended to cluster-scoped objects for a privileged identity); a cluster-wide diagnostic sweep across platform components is a separate exercise not covered here [ev:c3].

## Resolution

Enumerate the namespaced resource types that support listing, then dump them all in a single request. The set of listable namespaced types is produced with `api-resources`, and that comma-joined list is fed straight into one `get` invocation [ev:c3]. Combining the enumerated types into a single `get` call keeps the dump to one request, instead of issuing a separate `get` per resource type [ev:c4].

```bash
NS=<namespace>
TYPES=$(kubectl api-resources --namespaced=true --verbs=list -o name | paste -sd, -)
kubectl get "$TYPES" -n "$NS" -o yaml
```

Collect container logs for the whole namespace by listing its pods, reading each pod's container names from its spec, and pulling logs per container with timestamps. The container names come from `.spec.containers[*].name`, and `logs --container=<c> --timestamps` emits RFC3339-prefixed lines for each one [ev:c5].

```bash
for pod in $(kubectl get pods -n "$NS" -o name); do
  for c in $(kubectl get "$pod" -n "$NS" -o jsonpath='{.spec.containers[*].name}'); do
    kubectl logs "$pod" -n "$NS" --container="$c" --timestamps
  done
done
```

For a container that has restarted, the logs of the prior terminated instance are retrieved separately with the `-p/--previous` flag, which returns the previous run's log rather than the current one [ev:c6].

```bash
kubectl logs <pod> -n "$NS" --container=<c> --previous --timestamps
```

## Diagnostic Steps

Before attempting the log dump, confirm the current identity is permitted to read pod logs in the namespace. A self RBAC check answers this without trial and error [ev:c7].

```bash
kubectl auth can-i get pods/log -n "$NS"
```

When the identity additionally holds cluster-reader or cluster-admin — detectable with a self check against a cluster-scoped verb — extend the gather to cluster-scoped objects as well. On this environment (Kubernetes `v1.34.5`), a `get nodes` self check resolves to yes for such an identity, and nodes, clusterrolebindings, storageclasses, persistentvolumes, and csrs all exist as listable objects on the cluster [ev:c8]. These cluster-scoped kinds are typically reachable to a cluster-reader/admin; if you are unsure of a specific kind, run the same `auth can-i` check against it before adding it to the dump.

```bash
kubectl auth can-i get nodes
kubectl get nodes,clusterrolebindings,storageclasses,persistentvolumes,csr -o yaml
```
