---
title: Meaning of an Empty apiGroups Field in a Role or ClusterRole
component: security
scenario: information
tags: [rbac, role, clusterrole, apigroups, core-api]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Meaning of an Empty apiGroups Field in a Role or ClusterRole

## Overview

In a Role or ClusterRole on Alauda Container Platform, a `PolicyRule` whose `apiGroups` entry is the empty string `""` targets the Kubernetes core API group. The apiserver's own field description states this verbatim: `"" represents the core API group and "*" represents all API groups` [ev:c1]. The same wording appears in the live OpenAPI v3 schema served by the cluster at `/openapi/v3/apis/rbac.authorization.k8s.io/v1` for the `PolicyRule` type [ev:c1].

The core API group is the legacy unnamed group whose resources are served at the REST path `/api/v1` (named groups live under `/apis/<group>/<version>`). On the verification cluster (Kubernetes v1.34.5), `kubectl get --raw=/api/v1` returns `groupVersion: v1` with no group prefix, confirming the core group's distinct REST root [ev:c1].

## Core API Group Resources

The resources that belong to the core group use the `v1` apiVersion (no group prefix). The set can be listed directly:

```bash
kubectl api-resources --api-group=""
```

The output names each core resource, its short name, the `v1` apiVersion, whether it is namespaced, and its Kind [ev:c3]. On the verification cluster the command returned the following 17 resources, all at APIVERSION `v1` [ev:c2][ev:c3]:

```text
NAME                     SHORTNAMES   APIVERSION   NAMESPACED   KIND
bindings                              v1           true         Binding
componentstatuses        cs           v1           false        ComponentStatus
configmaps               cm           v1           true         ConfigMap
endpoints                ep           v1           true         Endpoints
events                   ev           v1           true         Event
limitranges              limits       v1           true         LimitRange
namespaces               ns           v1           false        Namespace
nodes                    no           v1           false        Node
persistentvolumeclaims   pvc          v1           true         PersistentVolumeClaim
persistentvolumes        pv           v1           false        PersistentVolume
pods                     po           v1           true         Pod
podtemplates                          v1           true         PodTemplate
replicationcontrollers   rc           v1           true         ReplicationController
resourcequotas           quota        v1           true         ResourceQuota
secrets                               v1           true         Secret
serviceaccounts          sa           v1           true         ServiceAccount
services                 svc          v1           true         Service
```

The cluster-shipped `view` ClusterRole already demonstrates the same idiom: one of its rules carries `apiGroups: [""]` and lists `configmaps`, `endpoints`, `persistentvolumeclaims`, `pods`, `replicationcontrollers`, `serviceaccounts`, and `services` (plus the `/status` subresources) [ev:c1][ev:c2].

## How the Rule Grants Access

A PolicyRule authorizes a request when its three dimensions — `apiGroups`, `resources`, and `verbs` — each match the inbound request. Listing the core group in `apiGroups` only opens the group dimension; the `resources` list still narrows access to the named resources, and the rule remains namespaced when written into a Role (cluster-scoped when written into a ClusterRole) [ev:c4].

The article's reference Role illustrates the pattern:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "watch", "list"]
```

A binding of this Role to a subject grants that subject `get / watch / list` on Pods in the Role's namespace, and nothing more — no other core resource (Service, ConfigMap, Secret), no resource in any named API group (Deployment in `apps`, NetworkPolicy in `networking.k8s.io`), and no Pod in any other namespace [ev:c4].

On the verification cluster, applying the Role above (with a ServiceAccount bound to it) and probing with the ServiceAccount's own token showed exactly this scope [ev:c4]:

```text
== can-i list pods (in-ns):           yes
== can-i list services (in-ns):       no
== can-i list deployments (apps):     no
== can-i list pods cross-namespace:   no
```

The apiserver's `Forbidden` response surfaces the apiGroup literally, which is useful when diagnosing RBAC denials: for a core-group resource the message ends `... cannot list resource "services" in API group ""`, while for a named-group resource it ends `deployments.apps is forbidden: ... in API group "apps"` [ev:c4]. Seeing the empty string `API group ""` in the error confirms that the request targeted the core group and the rule's group dimension is the one to widen.

## Summary

In `apiGroups`, the empty string `""` is the canonical reference to the Kubernetes core API group — the group served at `/api/v1` whose resources use the bare `v1` apiVersion [ev:c1]. Listing those resources with `kubectl api-resources --api-group=""` enumerates the kinds a rule with `apiGroups: [""]` can grant verbs over [ev:c3], and the rule's authorization scope is still constrained by the `resources`, `verbs`, and (for Role) namespace dimensions of the PolicyRule [ev:c4].
