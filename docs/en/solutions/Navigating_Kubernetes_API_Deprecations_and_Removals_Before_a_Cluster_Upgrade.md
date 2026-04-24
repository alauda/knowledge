---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Kubernetes follows a strict API-versioning policy: an API served under a **beta** version must continue to be served for 9 months or 3 minor releases after deprecation, whichever is longer, after which it may be removed. When an upgrade crosses a Kubernetes minor version that drops a `v1beta1` or `v2beta1` API that is still in use somewhere — by a workload, an operator, a GitOps pipeline, an admission webhook, or a piece of tooling that talks to the cluster — calls to the removed API version start to fail. The cluster is otherwise healthy, but manifests apply with `no matches for kind` errors, controllers log "unknown API version", and upgrade preflight tooling refuses to acknowledge readiness.

Operators must therefore audit each cluster for usage of APIs that are about to be removed and migrate the relevant consumers to the replacement version **before** initiating the upgrade.

## Root Cause

Two independent facts combine:

1. Beta APIs have an expiry window baked into the Kubernetes deprecation policy, so any cluster running long enough will eventually cross a minor-version boundary that removes one.
2. Removal is a hard break: the removed `apiVersion` returns `404` from `kubectl`, and any client that still issues requests under the old version errors out rather than silently falling back to the replacement.

Because the client is usually *not* the cluster itself (it is a workload, a Helm chart, an Argo CD `Application`, a CI pipeline pushing YAML), the surface area of "what might still use the old API" spans everything talking to the cluster, not just what runs inside it.

## Resolution

The upgrade hygiene checklist is:

1. **Identify the removals in the target Kubernetes minor.** Every Kubernetes minor's release notes enumerate the APIs being removed, in the form "`<apiVersion>/<kind>` removed, use `<replacement>` instead". Treat that list as the inventory of things to migrate.

2. **Find where each deprecated API is actually being requested.** The cluster's API server already tracks this with two instrumentation signals:

   - The metric `apiserver_requested_deprecated_apis` — a gauge labelled by `group`, `version`, `resource`, and `removed_release` — is `1` for every (group,version,resource) tuple that has been requested under a deprecated version in the recent window. Query it against the cluster's monitoring stack.
   - The audit log records every request with its `apiVersion`. If audit logging is enabled, a filter on the target removed versions enumerates offenders with their `user`/`userAgent` attribution.

   A quick Prometheus expression to check for any hits:

   ```text
   apiserver_requested_deprecated_apis{removed_release="1.XX"} == 1
   ```

   Replace `1.XX` with the Kubernetes minor version of the upcoming upgrade. Each returned series tells you a `group/version/resource` tuple that is still receiving traffic.

3. **Attribute each hit to a concrete consumer.** The metric alone does not tell you *who* is calling. Cross-reference with the audit log (filtered on the deprecated `apiVersion`) and with `kubectl get <resource> -A --show-kind -o yaml` to find in-cluster objects still defined under the old `apiVersion`. Typical sources are:

   - Static manifests in a Git repo rendered by a GitOps controller,
   - Helm charts pinned to an old chart version,
   - Operators that have not been upgraded to a release aware of the replacement API,
   - Internal tooling / scripts that construct the `apiVersion` string literally.

4. **Migrate each consumer to the replacement API and re-apply.** For in-cluster objects that were created under the old version, re-applying the same object under the new `apiVersion` is usually a no-op on the wire — the API server has been serving the object under multiple versions. The storage version is set by the server; the client-side migration is about making sure no one is still *writing* the old version.

5. **Gate the upgrade on zero deprecated usage.** Once the Prometheus expression above returns empty for a sustained window (long enough to be sure any cron-driven or infrequent caller has had a chance to fire), the cluster is safe to upgrade across the removal boundary. Until then, acknowledge that upgrading will break the unmigrated caller and decide whether that is acceptable.

## Diagnostic Steps

Enumerate every in-cluster object currently stored with an `apiVersion` that is about to be removed:

```bash
kubectl api-resources --verbs=list --namespaced=true -o name \
  | xargs -I {} kubectl get {} -A -o json \
  | jq -r '.items[]? | [.apiVersion, .kind, .metadata.namespace, .metadata.name] | @tsv' \
  | grep -E 'v1beta1|v2beta1'
```

Prune the regex to the specific `apiVersion`s called out in the target release's removal list; the command above errs on the side of noisy.

Confirm the runtime signal has dropped to zero across all deprecated (group,version,resource) tuples:

```bash
kubectl -n <monitoring-namespace> exec -c prometheus prometheus-k8s-0 -- \
  curl -sG --data-urlencode \
    'query=apiserver_requested_deprecated_apis == 1' \
    http://localhost:9090/api/v1/query \
  | jq '.data.result[].metric'
```

An empty `result` array is the green light. Every remaining series is a caller that still has to be migrated before crossing the minor-version boundary.
