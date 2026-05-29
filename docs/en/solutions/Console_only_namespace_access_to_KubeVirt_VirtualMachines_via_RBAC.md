---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Console-only namespace access to KubeVirt VirtualMachines via RBAC

## Issue

A non-admin user needs to open the serial console or VNC display of `VirtualMachine` objects in one namespace, list those VMs and their backing `VirtualMachineInstance` pods, and see the supporting workload resources — but must not be able to start, stop, edit, or delete any VM, and must have no access in any other namespace.

The built-in aggregated role `kubevirt.io:view` grants `get`/`list`/`watch` on `virtualmachines` and `virtualmachineinstances` in the `kubevirt.io` API group, but it deliberately omits the console and VNC subresources, so a user bound to it can see VM objects yet cannot open their console. A custom namespace-scoped `Role` that adds those two subresources solves the problem without granting any mutating verb.

## Resolution

Apply two objects in the target namespace: a `Role` that defines the console-only permission set, and a `RoleBinding` that grants it to a single user (or service account). Both are standard `rbac.authorization.k8s.io/v1` resources; the underlying authorizer is the upstream Kubernetes RBAC mechanism, where each `PolicyRule` is an additive allow-list — verbs not listed are denied.

Optionally bind the stock cluster-scoped `view` role first, so the user has the usual namespace-wide baseline visibility (configmaps, pods, services, events, and so on with `get`/`list`/`watch`). The `view` ClusterRole is present on Alauda Container Platform and covers `pods`, `pods/log`, `services`, `endpoints`, `events` in the core API group:

```bash
kubectl create rolebinding view-baseline \
  --clusterrole=view \
  --user=<username> \
  -n <namespace>
```

Then create the console-only `Role` and `RoleBinding`. The first rule grants the read verbs on the VM and VMI objects themselves. The second rule grants the two console subresources from the aggregated `subresources.kubevirt.io` group — `virtualmachineinstances/console` (serial console) and `virtualmachineinstances/vnc` (VNC). The third rule grants the read verbs on the supporting core resources:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: kubevirt-console-access
  namespace: <namespace>
rules:
- apiGroups: ["kubevirt.io"]
  resources: ["virtualmachines", "virtualmachineinstances"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["subresources.kubevirt.io"]
  resources:
  - virtualmachineinstances/console
  - virtualmachineinstances/vnc
  verbs: ["get", "update"]
- apiGroups: [""]
  resources: ["pods", "pods/log", "services", "endpoints", "events"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: kubevirt-console-access-binding
  namespace: <namespace>
subjects:
- kind: User
  name: <username>
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: kubevirt-console-access
  apiGroup: rbac.authorization.k8s.io
```

To bind to a `ServiceAccount` instead of a user, replace the `subjects` entry with `{kind: ServiceAccount, name: <sa>, namespace: <namespace>}` (drop `apiGroup`).

Two properties of this configuration are worth highlighting. First, the second rule's `apiGroups: ["subresources.kubevirt.io"]` is required — `virtualmachineinstances/console` and `virtualmachineinstances/vnc` are served by the KubeVirt aggregated API server under that group, not under `kubevirt.io`; a rule that lists those subresource paths under `kubevirt.io` will not authorize them. Second, because the `Role` lists only `get`/`list`/`watch` on `virtualmachines`/`virtualmachineinstances` and `get`/`update` on the two console subresources, every other verb — `create`, `update`, `patch`, `delete` on the VM/VMI objects, and the mutating subresources `virtualmachines/start`, `virtualmachines/stop`, `virtualmachineinstances/pause`, `virtualmachineinstances/addvolume`, and so on — is denied by default.

## Diagnostic Steps

Confirm that the bound subject actually has the granted permissions and is denied the omitted ones. The reliable way to ask the authorizer "is this verb allowed for that subject" is to authenticate as the subject (real token) and run `kubectl auth can-i`, which issues a `SelfSubjectAccessReview`. Impersonated `SubjectAccessReview` via `--as=<user>` from an admin context is not a reliable probe on this platform — it can return `yes` for verbs the target subject does not actually have.

Bind the `Role` to a `ServiceAccount` (or rewrite the existing `RoleBinding`'s `subjects` to point at one), then mint a token for it and run the checks against the API server with that token. The expected outcome is the matrix that the article's `Role` defines:

```bash
NS=<namespace>
TOK=$(kubectl -n $NS create token <sa-name>)
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')

# Granted reads — expect 'yes' for each
for v in get list watch; do
  echo -n "$v vm: "
  kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
    -n $NS auth can-i $v virtualmachines.kubevirt.io
done

# Omitted verbs — expect 'no' for each
for v in create update patch delete; do
  echo -n "$v vm: "
  kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
    -n $NS auth can-i $v virtualmachines.kubevirt.io
done

# Mutating VM subresources — expect 'no'
kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
  -n $NS auth can-i update virtualmachines --subresource=start

# Cross-namespace — expect 'no'
kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
  -n default auth can-i get virtualmachines.kubevirt.io
```

The `console` and `vnc` subresources live under `subresources.kubevirt.io`, not `kubevirt.io`, so `kubectl auth can-i` with the resource-shortname form may probe the wrong API group. Issue the `SelfSubjectAccessReview` directly via the raw API to pin the group explicitly:

```bash
for sub in console vnc; do
  echo -n "get vmi/$sub in $NS: "
  cat <<EOF | kubectl --token=$TOK --server=$SERVER --insecure-skip-tls-verify \
    create -f - --validate=false -o jsonpath='{.status.allowed}'
apiVersion: authorization.k8s.io/v1
kind: SelfSubjectAccessReview
spec:
  resourceAttributes:
    namespace: $NS
    group: subresources.kubevirt.io
    resource: virtualmachineinstances
    subresource: $sub
    verb: get
EOF
  echo
done
```

Expected output on a correctly bound subject:

```text
get vmi/console in <namespace>: true
get vmi/vnc in <namespace>: true
```

For an end-to-end check, hit the live VNC subresource endpoint with the subject's token. The distinction between RBAC denial and a missing object is visible in the HTTP status: `403 Forbidden` is the authorizer rejecting the request, `404 NotFound` means the request was authorized and the `VirtualMachineInstance` simply does not exist:

```bash
curl -k -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOK" \
  "$SERVER/apis/subresources.kubevirt.io/v1/namespaces/$NS/virtualmachineinstances/<vmi>/console"
```

A `403` response with the message `virtualmachineinstances.subresources.kubevirt.io ".." is forbidden: User ".." cannot get resource "virtualmachineinstances/console"` indicates the binding is missing (or the request is being made in the wrong namespace); a `404` with `virtualmachineinstance.kubevirt.io ".." not found` confirms the RBAC path is clear and only the VMI name needs attention.

The same probe in a different namespace will return `403` even for the bound subject, confirming the `RoleBinding` is namespace-scoped:

```bash
curl -k -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOK" \
  "$SERVER/apis/subresources.kubevirt.io/v1/namespaces/default/virtualmachineinstances/<vmi>/console"
```
