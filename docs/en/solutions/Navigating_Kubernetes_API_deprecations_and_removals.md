---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Kubernetes follows a strict API versioning policy. Every beta API (`v1beta1`, `v2beta1`, and so on) is guaranteed to be supported for nine months or three Kubernetes releases — whichever is longer — after it is marked deprecated, and is then free to be removed from the server entirely. When that removal happens, any workload, controller, tool or pipeline that still talks to the old version stops working.

Upstream maintains the canonical timeline in the [API deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/) and the per-release [deprecated API migration guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/). Administrators should expect to audit their clusters for deprecated versions in use at every minor-version upgrade, migrate affected manifests to the new version, and then unblock the upgrade explicitly once the audit is clean.

This article describes how to identify deprecated API usage on an ACP cluster, how to migrate to the successor versions, and what the cluster exposes as signals that usage has not yet been cleaned up.

## Resolution

Treat every minor-version upgrade as an API audit. The workflow below generalises across any Kubernetes-based platform:

1. **Inventory every removed API in the target release.** The upstream [deprecated API migration guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/) lists exactly which `group/version/kind` triples are removed in each minor release (for example, Kubernetes 1.22 removed a large batch of `v1beta1` APIs that had been deprecated in 1.16). Build a list of the kinds that the target release will stop serving.

2. **Scan all stored objects for those kinds.** Every deprecated object has two dimensions: the `storedVersion` (what etcd keeps on disk, returned by `kubectl get --raw /apis/<group>`) and the `served` version (what clients and controllers submit). Both need to be upgraded:

   ```bash
   # Which versions does the cluster still serve?
   kubectl api-resources -o wide
   kubectl api-versions

   # What versions are stored in etcd per resource?
   kubectl get apiservices.apiregistration.k8s.io \
     -o custom-columns=NAME:.metadata.name,AVAILABLE:.status.conditions[?(@.type=="Available")].status
   ```

   Use `kubectl get <kind> -A -o yaml` for each deprecated kind and look at the `apiVersion` in the returned YAML. Anything still bound to the deprecated version will not survive the next upgrade.

3. **Rewrite manifests, charts, and automation to the successor version.** Typical migrations include:

   - `extensions/v1beta1` Ingress → `networking.k8s.io/v1` Ingress
   - `policy/v1beta1` PodDisruptionBudget → `policy/v1` PodDisruptionBudget
   - `autoscaling/v2beta2` HorizontalPodAutoscaler → `autoscaling/v2`
   - `batch/v1beta1` CronJob → `batch/v1`
   - `apiregistration.k8s.io/v1beta1` APIService → `apiregistration.k8s.io/v1`

   For CRD-backed workloads, bump `apiVersion` across the whole toolchain: raw manifests, Helm charts, GitOps application source, CI pipeline fixtures, and any admission-webhook client code. Leaving even one generator on the old version means the next `kubectl apply` will silently recreate a deprecated object.

4. **Re-run the scan until it is clean,** then proceed with the upgrade. Do not rely on post-upgrade repair scripts; once the server stops serving the old version, existing controllers that use it simply begin to error.

5. **Prefer `apiVersion`-agnostic tooling** when possible. `conversion webhooks` on CRDs, `kustomize` `apiVersion` patches, and Helm templates keyed off the running Kubernetes minor version let you roll out a single source tree across a fleet of clusters on different versions without a separate manifest per server version.

## Diagnostic Steps

On a running cluster, two signals tell you whether deprecated API usage is still in play:

```bash
# Every deprecated request bumps this counter. A non-zero rate after
# migration work is complete means some controller or cronjob is still
# dragging on the old version.
kubectl get --raw '/metrics' | grep apiserver_requested_deprecated_apis
```

Query Prometheus for the same counter to see *which* resource is still being used:

```text
sum by (group, version, resource) (
  rate(apiserver_requested_deprecated_apis[5m])
)
```

The group/version/resource labels identify the offender — often a controller or operator that has not been upgraded. Upgrade the component (or, if it is in-house, bump its client-go dependency) until the counter drops to zero.

Audit stored resources against the removed list for the next release:

```bash
for api in \
  ingresses.extensions \
  podsecuritypolicies.policy \
  cronjobs.batch \
  horizontalpodautoscalers.autoscaling \
  ; do
  echo "=== $api ==="
  kubectl get "$api" -A -o json 2>/dev/null | jq -r '.items[] | "\(.apiVersion) \(.metadata.namespace)/\(.metadata.name)"' | sort -u
done
```

Any line showing a deprecated `apiVersion` is a migration candidate. Re-apply the object in the successor version to rewrite the stored copy in etcd. Once the output only contains successor versions, the cluster is safe for the upgrade that removes the old ones.
