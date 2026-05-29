---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500774
---

# RBAC ClusterRole with wildcard apiGroups still denies when resources lists qualified resource.group strings

## Issue

On Alauda Container Platform (server `v1.34.5-1`, RBAC served at `rbac.authorization.k8s.io/v1`), a custom `ClusterRole` written to mimic the canonical wildcard role — paired with a `ClusterRoleBinding` to a user or `ServiceAccount` — can still return Forbidden on resources its rules appear to list, when the rule's `resources` field uses qualified `<resource>.<group>` strings instead of bare resource names. The apiserver authorizer then emits a generic Forbidden response of the form `<resource>.<group> is forbidden: User "<subject>" cannot list resource "<bare-resource>" in API group "<group>" at the cluster scope` for cluster-scoped resources, and the namespaced-scope variant `... in the namespace "<ns>"` for namespaced resources. The presence of `apiGroups: ["*"]` in the same rule does not rescue the request because the resource match has already failed.

## Root Cause

A `PolicyRule` embedded in a `ClusterRole` (group `rbac.authorization.k8s.io/v1`) has three independent fields — `apiGroups`, `resources`, and `verbs` — and the authorizer matches the incoming request against each one separately. The `apiGroups` field carries "the name of the APIGroup that contains the resources" with `"*"` standing for all API groups; `resources` is "a list of resources this rule applies to" with `"*"` standing for all resources; `verbs` is the verb token list with `"*"` standing for all verbs. The kube-apiserver indexes every served resource by its bare name with the group carried separately in `APIVERSION` — for example `kubectl api-resources` lists `NAME=servicemonitors APIVERSION=monitoring.coreos.com/v1`; no resource is literally named `servicemonitors.monitoring.coreos.com`. The `resources` field is matched literally against that bare name, so a rule entry like `servicemonitors.monitoring.coreos.com` never equals the bare token `servicemonitors` and therefore matches no real resource. Wildcarding the group dimension (`apiGroups: ["*"]`) does not change this — the group match always passes, but the resource match still fails on the qualified-string entry, and the rule contributes no authorization.

The same independence applies to `verbs`: a rule whose `verbs` field is `[""]` (the empty string) does not authorize the verbs `get`/`list`/`watch`/`create`/`update`/`patch`/`delete`/`deletecollection` — the empty string is not a member of the apiserver's verb token space, so verbs:[""] grants nothing to its listed resources. Real `ClusterRole` rules on the cluster use concrete tokens — for example `system:basic-user` uses `verbs: [create]`, and the canonical wildcard role `cluster-admin` uses `apiGroups: ["*"]` paired with `resources: ["*"]` and `verbs: ["*"]`, never qualified `<resource>.<group>` strings in `resources`. Existing platform `ClusterRole` definitions follow the same shape — their `resources` entries are bare names (or `name/subresource`), never `name.group` — with the API group carried in the rule's `apiGroups` field.

## Resolution

Rewrite the rule so each entry under `resources` is the bare resource name, and the API group lives in `apiGroups` (either the literal group name or `"*"`). For example, replace this rule:

```yaml
rules:
- apiGroups:
  - '*'
  resources:
  - servicemonitors.monitoring.coreos.com   # qualified string — does not match
  verbs:
  - get
  - list
  - watch
```

with this rule:

```yaml
rules:
- apiGroups:
  - '*'
  resources:
  - servicemonitors                          # bare resource name — matches
  verbs:
  - get
  - list
  - watch
```

After the bare-name rewrite, a fresh `ServiceAccount` bound to the corrected `ClusterRole` can list the resource cluster-wide — `kubectl auth can-i list servicemonitors.monitoring.coreos.com` returns `yes` and the corresponding `kubectl get servicemonitors.monitoring.coreos.com -A` succeeds. To restrict the same rule to a single group, replace `apiGroups: ["*"]` with the explicit group name (here `monitoring.coreos.com`); the resource match still keys off the bare name in `resources`.

If any rule carries `verbs: [""]`, replace the empty string with the concrete verb tokens the binding needs — `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`, or `"*"` for all of them. A rule with `verbs: [""]` authorizes nothing on its listed resources, so removing or replacing it is required for the binding to take effect.

## Diagnostic Steps

Confirm the field semantics on the cluster against the `ClusterRole` CRD itself — `apiGroups` is the group dimension (with `"*"` for all groups), `resources` is the bare-name dimension (with `"*"` for all resources), and `verbs` is the verb-token dimension (with `"*"` for all verbs):

```bash
kubectl explain clusterrole.rules.apiGroups
kubectl explain clusterrole.rules.resources
kubectl explain clusterrole.rules.verbs
```

Inspect the suspect `ClusterRole` and look for `resources` entries containing a dot followed by the API group (`<resource>.<group>`). Compare against a real platform `ClusterRole` such as `cluster-admin` to see the canonical wildcard shape (bare `"*"`, never qualified strings):

```bash
kubectl get clusterrole <name> -o yaml
kubectl get clusterrole cluster-admin -o yaml
```

Confirm that the apiserver registers the disputed resource under its bare name with the group carried in `APIVERSION`; the bare token here is what the `resources` field must list:

```bash
kubectl api-resources -o wide | grep <resource>
```

Reproduce the authorization decision as the bound subject, without changing any platform RBAC, by minting a bound token for the `ServiceAccount` named in the binding and issuing a request through that token. The bare-name `resources` entry will succeed and the qualified-string entry will return the Forbidden message the user reported:

```bash
TOKEN=$(kubectl create token <serviceaccount> -n <namespace> --duration=3600s)
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
kubectl --server="$SERVER" --token="$TOKEN" --insecure-skip-tls-verify get <resource> -A
```

Cross-check the same subject's decision through the SubjectAccessReview path — both `auth can-i` answers must agree with the live request (and with each other) for a correctly-shaped rule:

```bash
kubectl --server="$SERVER" --token="$TOKEN" --insecure-skip-tls-verify auth can-i list <bare-resource>
kubectl --server="$SERVER" --token="$TOKEN" --insecure-skip-tls-verify auth can-i list <resource>.<group>
```

For namespaced resources, the same authorizer emits the namespaced-scope variant of the Forbidden message — `<resource> is forbidden: User "<subject>" cannot <verb> resource "<bare-resource>" in API group "<group>" in the namespace "<ns>"` — so a rule with `verbs: [""]` on `secrets` denies `list secrets` and returns that exact message:

```bash
kubectl --server="$SERVER" --token="$TOKEN" --insecure-skip-tls-verify get secrets -n <namespace>
```
