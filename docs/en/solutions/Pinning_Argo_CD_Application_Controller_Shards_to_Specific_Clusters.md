---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Pinning Argo CD Application-Controller Shards to Specific Clusters
## Issue

When Argo CD is wired to manage many remote clusters, the `application-controller` StatefulSet is scaled out and each replica owns a slice of the registered clusters. By default, the shard a given cluster lands on is decided by a hash over the cluster server URL — which means a busy cluster may end up co-located with another busy cluster on the same controller pod, while quieter shards sit idle. Operators sometimes need to override that placement: route a heavy production cluster onto a dedicated shard, or pin a flaky environment to a known controller for easier log scoping.

The question is whether shard assignment can be controlled by hand instead of left to the hash, and how to express that pinning declaratively.

## Root Cause

The Argo CD application-controller discovers managed clusters by listing Kubernetes Secrets that carry the label `argocd.argoproj.io/secret-type: cluster` in the Argo CD instance namespace. Each such Secret describes one external API endpoint and its credentials. When the controller starts, every replica reads all cluster secrets and uses a hash of the server URL modulo the replica count to decide ownership; if two URLs hash to the same shard, both clusters are reconciled by the same replica.

This implicit assignment is fine at small scale but becomes opaque once the replica count or cluster set changes — adding a single cluster can re-shard everything. The controller therefore honours an explicit `shard` field in the cluster secret: when present, the integer is used directly and the hash is ignored for that secret. ACP's GitOps surface is built on the same upstream Argo CD, so the same Secret schema applies.

## Resolution

Add a `shard` key to the cluster secret's `stringData`. The value is the zero-based index of the target replica; it must be less than the controller's `replicas` count or the secret falls through to the hash-based path.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: prod-cluster-east
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: prod-cluster-east
  server: https://api.prod-east.example.com:6443
  shard: "1"
  config: |
    {
      "bearerToken": "<redacted>",
      "tlsClientConfig": { "insecure": false, "caData": "<base64-ca>" }
    }
```

Apply it the usual way:

```bash
kubectl -n argocd apply -f prod-cluster-east-secret.yaml
```

Plan the shard map ahead of time. If the controller runs three replicas (`shard 0`, `shard 1`, `shard 2`), pick a target per cluster secret and keep the assignment in source control so re-applies are idempotent. Avoid editing one secret without knowing what the other secrets do — pinning one cluster does not move the rest, so a poorly-balanced map can be worse than the default hash.

When scaling the controller up or down, audit every secret that carries an explicit `shard`. Reducing replicas from three to two leaves any secret with `shard: "2"` orphaned and its applications unreconciled until the value is corrected.

For multi-tenant Argo CD installs that ship through ACP's gitops surface, prefer treating the cluster secret as a managed manifest: keep it in the same Git source the rest of the platform reconciles from, so the shard pinning travels with the cluster registration rather than living as a one-off `kubectl edit`.

## Diagnostic Steps

Confirm a cluster secret carries the field and the value parses as an integer:

```bash
kubectl -n argocd get secret prod-cluster-east \
  -o jsonpath='{.data.shard}' | base64 -d ; echo
```

Identify which application-controller pod currently owns a given cluster by inspecting controller logs for the cluster server URL:

```bash
kubectl -n argocd logs statefulset/argocd-application-controller \
  --all-containers --prefix --tail=2000 \
  | grep -F 'prod-east.example.com' | tail
```

The replica index is part of the pod name (`argocd-application-controller-0`, `-1`, `-2`); a pinned cluster should only show up in the matching replica's log stream. If it appears in another pod, either the `shard` field was not parsed (check that the value is quoted in `stringData` so it survives as a string), or the replica count is lower than the requested shard.

List all cluster secrets and their explicit shard values to spot conflicts before scaling:

```bash
kubectl -n argocd get secret \
  -l argocd.argoproj.io/secret-type=cluster \
  -o custom-columns=NAME:.metadata.name,SHARD:.data.shard \
  | awk 'NR==1 || $2!="<none>"'
```

If the controller does not pick up the change after the secret is updated, restart the StatefulSet — the controller caches cluster definitions in memory and re-reads them on pod start:

```bash
kubectl -n argocd rollout restart statefulset/argocd-application-controller
```
