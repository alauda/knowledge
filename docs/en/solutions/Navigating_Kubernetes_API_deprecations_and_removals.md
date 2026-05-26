---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500011
---

# Handling removed Kubernetes API versions before and after a cluster upgrade

## Issue

Alauda Container Platform runs the upstream Kubernetes API server and follows the upstream API lifecycle, so beta API versions are eventually removed as the cluster advances across Kubernetes minor releases. On a cluster at Kubernetes v1.34.5, the flow-control group serves only the GA version `flowcontrol.apiserver.k8s.io/v1`; no `v1beta*` versions of that group are served, reflecting the upstream rule that a beta API version is retained for a defined window after deprecation and then removed in a later minor release. Once a version reaches that point and is dropped, requests from workloads, tools, or other components that still target the removed version begin to fail.

```text
Error from server (NotFound): the server could not find the requested resource
```

A direct request against a removed version such as `flowcontrol.apiserver.k8s.io/v1beta3` is answered with HTTP `404 Not Found` by the API server, because that version is no longer served.

## Root Cause

The set of served API versions is governed entirely by the upstream Kubernetes API machinery for the running minor version. When the cluster reaches a release in which a beta version has aged past its deprecation window, that version is removed from the served set; at v1.34.5 the flow-control group exposes only `flowcontrol.apiserver.k8s.io/v1`, and any client still issuing calls against a removed `v1beta*` form has no served endpoint to reach. The failures are therefore not a misconfiguration of the cluster but the expected result of a client continuing to use an API version that the upgraded API server no longer recognizes.

## Resolution

Before upgrading a cluster across a release where API removals occur, identify which workloads, manifests, controllers, and client tools still target the soon-to-be-removed API versions, and migrate them to the appropriate replacement version ahead of the upgrade. The commands below show only which versions the API server currently serves; they do not by themselves list which clients are still calling a given version, so the workload-side review must be done by inspecting manifests, Helm charts, GitOps repos, controller images, and any other sources of API traffic that are known to reference the deprecated version. For the flow-control group, the surviving served version on a v1.34.5 cluster is the GA `flowcontrol.apiserver.k8s.io/v1`; manifests and clients should be updated to that version so they continue to resolve after the upgrade.

Confirm which versions a group currently serves on the running cluster, then update resources to target the GA version:

```bash
kubectl api-versions | grep flowcontrol.apiserver.k8s.io
```

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
```

## Diagnostic Steps

To identify whether a failure stems from a removed API version, inspect the API server response to the affected request. A removed version returns `404 Not Found` and the API server reports that it could not find the requested resource, distinguishing a removed-version call from an authorization or admission failure. Cross-check the served versions for the affected group against the GA-only set present on the v1.34.5 cluster: this confirms whether the version named in the failing request is still served on the running minor and which version remains as the migration target. The query reports served versions, not in-use callers, so it confirms the diagnosis of a removed-version call but does not by itself enumerate every client still issuing the old version — that enumeration has to come from inspecting the workloads, manifests, and tools known to send the failing request.

```bash
kubectl get --raw /apis/flowcontrol.apiserver.k8s.io
```
