---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An operator writes a custom `ClusterRole` intended to mimic full cluster admin privileges except for `secrets`. The rule uses `apiGroups: ["*"]` to span every API group in the cluster and then **lists each resource explicitly** — `pods`, `deployments.apps`, `alertmanagers.monitoring.coreos.com`, `prometheusrules.monitoring.coreos.com`, `servicemonitors.monitoring.coreos.com`, and so on — with `verbs: ["*"]`, so that `secrets` can be excluded by simply not being present in the list.

After binding the `ClusterRole` to a test user with a `ClusterRoleBinding`, the user receives `forbidden` for most of the listed resources:

```text
alertmanagers.monitoring.coreos.com is forbidden: User "user0" cannot list resource
  "alertmanagers" in API group "monitoring.coreos.com" at the cluster scope
```

The administrator confirms the resource string is present verbatim in the role:

```bash
kubectl get clusterrole my-cluster-admin -o yaml | grep alertmanagers
# -  alertmanagers.monitoring.coreos.com    <-- it is there
```

…and yet the authorizer still denies the call.

## Root Cause

The `resources` field of a `PolicyRule` is **not** a fully qualified resource name — it is a **short resource name**, relative to whatever `apiGroups` are listed in the same rule. The RBAC authorizer joins each entry in `apiGroups` with each entry in `resources` to form the set of (group, resource) pairs that the rule matches. When the role lists `alertmanagers.monitoring.coreos.com` in `resources`, the authorizer treats that literal string as a resource name — it does **not** split it on the dot and infer the group. So the rule ends up matching the pair `(group="*", resource="alertmanagers.monitoring.coreos.com")`, which no API server ever exposes.

Real traffic shows up as `(group="monitoring.coreos.com", resource="alertmanagers")`, which does not match, and the authorizer denies. This is a semantic mismatch rather than a bug.

Two lessons fall out of this:

1. The short name (`alertmanagers`) and the group (`monitoring.coreos.com`) live in **different** fields. Combining them into one string makes the entry inert.
2. `apiGroups: ["*"]` is a legitimate expression, but the resources listed alongside it must be short names. Because many short names collide across groups (e.g. `ingresses` exists in both `networking.k8s.io` and `extensions`), rules that use `apiGroups: ["*"]` should generally also use `resources: ["*"]` for the same reason — otherwise the operator has to enumerate every short name once per group and keep it in sync with new CRDs.

## Resolution

ACP's RBAC is standard Kubernetes RBAC; the same `Role` / `ClusterRole` / `RoleBinding` / `ClusterRoleBinding` objects apply unchanged. The fix is to rewrite the rule so that group and resource live in their own fields.

### Preferred pattern: "wildcard everything, deny a specific resource"

Instead of trying to enumerate every resource in every group, grant a broad allow rule and let the bind rule grant it, then rely on the fact that this user is **not** bound to the built-in role that grants `secrets`.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: almost-admin
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: ["*"]
  - nonResourceURLs: ["*"]
    verbs: ["*"]
```

This grants the union of every (group, resource) pair in the cluster, including new CRDs added later — which is what "cluster-admin minus secrets" really wants.

RBAC itself has no native "deny" rule; subtracting `secrets` happens at a different layer. Two supported options:

1. **Admission-policy denial.** Deploy a `ValidatingAdmissionPolicy` (or a Gatekeeper/Kyverno policy) that rejects any request from the bound user to `/api/v1/secrets` or `/api/v1/namespaces/*/secrets` with the verbs you want to block:

   ```yaml
   apiVersion: admissionregistration.k8s.io/v1
   kind: ValidatingAdmissionPolicy
   metadata:
     name: deny-secrets-for-almost-admin
   spec:
     matchConstraints:
       resourceRules:
         - apiGroups:   [""]
           apiVersions: ["v1"]
           operations:  ["CREATE","UPDATE","DELETE","GET","LIST","WATCH","PATCH"]
           resources:   ["secrets"]
     validations:
       - expression: |-
           request.userInfo.username != "user0"
         messageExpression: '"almost-admin role cannot access secrets"'
   ```

   Bind it with a `ValidatingAdmissionPolicyBinding` against the cluster scope. This layer enforces the "except secrets" intent that RBAC alone cannot express.

2. **Two-role split.** Grant `almost-admin` (wildcard) to everyone who needs it, and grant a separate, narrower role (`secrets-reader` / `secrets-writer`) only to the subset of identities that should reach `Secret`. This sidesteps RBAC's lack of deny and also keeps the admission policy out of the picture.

### If the current role must be retained: fix the rule shape

If the existing role has to stay, expand the rule so each apiGroup gets its own entry and the resources are the short names RBAC expects:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-cluster-admin
rules:
  # Core API group.
  - apiGroups: [""]
    resources:
      - pods
      - services
      - configmaps
      - persistentvolumeclaims
      # ...list every core resource except "secrets"
    verbs: ["*"]

  # apps.
  - apiGroups: ["apps"]
    resources: ["deployments","statefulsets","daemonsets","replicasets","controllerrevisions"]
    verbs: ["*"]

  # batch.
  - apiGroups: ["batch"]
    resources: ["jobs","cronjobs"]
    verbs: ["*"]

  # monitoring.
  - apiGroups: ["monitoring.coreos.com"]
    resources: ["alertmanagers","prometheuses","prometheusrules","servicemonitors","podmonitors"]
    verbs: ["*"]

  # ...one rule per apiGroup, resources listed by short name only
```

Each rule's `apiGroups` must contain real group names (use `""` for the core group, not `"core"`). Each rule's `resources` must contain **short names**, not group-qualified names. No mixing of the two.

This pattern is tedious, drifts as new CRDs are added, and the "almost-admin" approach above is usually the right answer. But when a security team requires an allow-list rather than an admission-based deny, the pattern is the correct shape.

### Fallback: cluster without ACP security extensions

The defect is pure standard Kubernetes RBAC behaviour; everything above applies to any Kubernetes cluster. `ValidatingAdmissionPolicy` requires a recent enough Kubernetes version; on older clusters, substitute a Gatekeeper or Kyverno policy to enforce the "not secrets" clause at admission time. The role shape guidance is version-independent.

## Diagnostic Steps

Confirm the rule really is of the broken shape. Dump the role and look for dotted strings in `resources`:

```bash
kubectl get clusterrole <role> -o json \
  | jq '.rules[] | {apiGroups,resources,verbs}' \
  | grep -E '".*\..*"'
```

Any hit (a resource name containing a dot) is a smoking gun for the misconfiguration described above.

Ask the authorizer directly — `SelfSubjectAccessReview` answers "can user X do Y" using the same code path the API server uses during a real request:

```bash
kubectl auth can-i list alertmanagers.monitoring.coreos.com \
  --as user0 -A
# no  <-- denied

kubectl auth can-i list alertmanagers \
  --as user0 -A
# no  <-- also denied
```

If the first check returns `no` for a resource that appears in the role's `resources` list, RBAC is honestly reporting that no matching rule was found. A wider check confirms the user has **something**:

```bash
kubectl auth can-i --list --as user0
```

If the only line that mentions the intended broad permissions is absent, the role never became effective at all and the bug is in the rule shape (as described). If those lines are present but a specific resource is missing, then that resource's rule specifically has the dotted-string problem — rewrite only that rule.

Verify the `ClusterRoleBinding` actually points at the intended role and user:

```bash
kubectl get clusterrolebinding -o json \
  | jq '.items[] | select(.roleRef.name=="my-cluster-admin")
                | {name:.metadata.name, subjects}'
```

If the binding is correct and the rule is still denying, the rule-shape fix is the remaining variable.
