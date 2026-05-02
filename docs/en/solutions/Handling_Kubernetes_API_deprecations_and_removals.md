---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Handling Kubernetes API deprecations and removals
## Overview

Kubernetes follows a strict API versioning policy. Across releases, many `v1beta1` and `v2beta1` APIs are progressively deprecated and then removed. The policy guarantees that a beta API version must remain supported for at least 9 months or three releases (whichever is longer) after deprecation; once that window closes, the version may be removed entirely.

When an API version is removed, every workload, controller, CI pipeline, GitOps tool, or operator that still issues requests against that version starts failing — typically with `404 Not Found` or `the server could not find the requested resource`. Cluster administrators must therefore inventory all consumers of soon-to-be-removed APIs **before** the upgrade that drops them, migrate those consumers to the new API version, and only then proceed with the upgrade.

This article describes how to discover which deprecated APIs are still in use on a cluster, how to plan the migration to the replacement APIs, and how to verify that no consumers remain before performing the cluster upgrade.

## Resolution

### 1. Inventory in-use API versions

The API server exposes counters for each (group, version, resource) tuple it serves, both for read and write operations. Compare those against the list of deprecated APIs documented for the target Kubernetes minor version.

```bash
# List every API resource the cluster currently serves, grouped by version.
kubectl api-resources --verbs=list -o wide | sort
```

Audit logs and the `apiserver_requested_deprecated_apis` metric series narrow the scan from "what the cluster could serve" to "what is actually being called":

```bash
# Show only requests against APIs flagged as deprecated.
kubectl get --raw /metrics \
  | grep -E '^apiserver_requested_deprecated_apis' \
  | grep -v '# '
```

A non-zero counter for a `(group, version, resource)` tuple means at least one client called that exact version recently. The metric labels include `removed_release`, which tells you the Kubernetes minor in which the version disappears.

### 2. Identify the calling clients

Once a problematic API version is known, enable apiserver audit logging (or query an existing audit pipeline) to learn **who** is calling it. Filter on `objectRef.apiVersion` and on the offending group:

```text
{
  "verb": "create",
  "objectRef": {
    "apiGroup": "policy",
    "apiVersion": "v1beta1",
    "resource": "poddisruptionbudgets"
  },
  "user": { "username": "system:serviceaccount:my-app:controller" },
  "userAgent": "my-controller/v1.2.3 (linux/amd64) kubernetes/abcdef"
}
```

The `userAgent` typically pinpoints the binary and version that needs an update; `user` identifies whether the caller is a human, an in-cluster controller, or a CI agent.

### 3. Migrate manifests and controllers

Replace each in-use deprecated API with its replacement and re-apply, or roll out a new controller image that has been rebuilt against the current `client-go`. Common patterns:

```yaml
# Before — flannel/calico CRD shipped against deprecated apiextensions.k8s.io/v1beta1
apiVersion: apiextensions.k8s.io/v1beta1
kind: CustomResourceDefinition
metadata:
  name: example.example.com

---
# After — apiextensions.k8s.io/v1
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: example.example.com
spec:
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
```

For Helm charts, bump the chart version and verify with `helm template` that the rendered output uses the migrated API. For GitOps repositories, push the migrated manifests through the same review and sync flow as any other change so that the deployed state matches what the cluster will accept after upgrade.

### 4. Verify that no consumers remain

After migration, watch the deprecated-APIs counter trend to zero before scheduling the upgrade:

```bash
# Repeat over a window long enough to cover periodic reconciles
# (24 hours catches most controller back-off and CronJob cycles).
kubectl get --raw /metrics \
  | grep apiserver_requested_deprecated_apis \
  | grep -v ' 0$'
```

A clean run — no surviving non-zero series for the (group, version) pairs that the next minor release removes — is the gate that admins should require before signing off on an upgrade window.

### 5. Acknowledge and proceed with the upgrade

When the cluster upgrade tooling exposes an admin-acknowledgement gate (for example, an annotation or admin-confirmation custom resource), set it after the verification above. The acknowledgement is the operator's signal to the upgrade controller that no further consumers depend on the about-to-be-removed APIs and that the upgrade may proceed.

## Diagnostic Steps

1. List the API versions the cluster currently advertises:

   ```bash
   kubectl api-versions
   ```

2. List deprecated APIs the apiserver has actually been asked to serve recently. Each non-zero series identifies a (group, version, resource) tuple that still has callers:

   ```bash
   kubectl get --raw /metrics \
     | grep apiserver_requested_deprecated_apis \
     | grep -v ' 0$'
   ```

3. Cross-reference each surviving series with the official Kubernetes deprecation guide (`kubernetes.io/docs/reference/using-api/deprecation-guide/`) to learn which release removes it and what to migrate to.

4. Inspect audit logs around the surviving series to learn which user agent is still calling it:

   ```bash
   # Example: extract userAgent values from a JSON-line audit feed
   jq -r 'select(.objectRef.apiGroup=="policy" and .objectRef.apiVersion=="v1beta1") | .userAgent' \
     /var/log/kubernetes/audit.log | sort -u
   ```

5. Re-run step 2 after migrating each consumer; only proceed with the cluster upgrade once every series for the targeted removal release reads zero across a representative window.
