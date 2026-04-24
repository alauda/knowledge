---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Applications exposed through Istio's ingress gateway are suddenly unreachable from outside the mesh after a fresh install or an upgrade to the v3-line control plane. Observed symptoms:

- Curl / browser clients receive a TCP reset immediately after the `ClientHello` — no HTTP response ever comes back.
- `istiod` logs repeatedly print an authorization failure for the Secret referenced by the `Gateway` resource:

  ```text
  attempted to access unauthorized certificates test-istio-secret:
  default/istio-system is not authorized to read secrets
  ```

- The `Gateway` CR itself is admitted and visible, the ingress pods are `Running`, and the backing TLS Secret is present in the gateway's namespace.

## Root Cause

Starting with Istio's control-plane split where the ingress gateway runs in a **separate namespace** from `istiod`, the gateway pulls its TLS material from Kubernetes Secrets via SDS (Secret Discovery Service). The gateway's ServiceAccount — in the cluster where the problem appears, the `default` ServiceAccount of the gateway namespace — must therefore have `get` / `watch` / `list` permission on `secrets` in the namespace where the Secret referenced by the `Gateway` lives.

When that Role / RoleBinding pair is missing:

- The gateway's envoy has no way to fetch the server certificate/key bytes.
- During the TLS handshake Envoy closes the connection right after the `ClientHello`, producing the observed TCP reset.
- `istiod` logs the `attempted to access unauthorized certificates ...` line because the SDS authorization check in its config distribution layer refused the read attempt on behalf of the gateway's ServiceAccount.

In other words: the mesh knows about the Secret, but the gateway's identity cannot read it.

## Resolution

ACP's `service_mesh` capability (Istio v1 and v2 packaging) follows the same SDS + RBAC contract as upstream Istio. Create the missing `Role` and `RoleBinding` in the **ingress gateway's namespace** so its ServiceAccount can read the TLS Secret referenced by the `Gateway`. The manifest below is the minimum permission required — do not widen it to `secrets: "*"` across the cluster.

```yaml
# Apply in the namespace where the istio-ingressgateway Deployment runs,
# e.g. `istio-ingress` or a tenant-specific gateway namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: istio-ingressgateway-sds
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: istio-ingressgateway-sds
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: istio-ingressgateway-sds
subjects:
  - kind: ServiceAccount
    name: default
```

Notes on adapting the manifest:

- The `subjects[].name` must match the ServiceAccount that the ingress gateway Deployment runs under. The platform's default gateway install uses `default`; custom installs may use `istio-ingressgateway`. Check with
  `kubectl -n <gateway-ns> get deploy istio-ingressgateway -o jsonpath='{.spec.template.spec.serviceAccountName}'`.
- If the TLS Secret lives in a **different namespace** from the gateway, create the `Role`/`RoleBinding` pair in the **Secret's** namespace and keep the `subjects[].namespace` pointing at the gateway's namespace. A `RoleBinding` is namespace-local; granting read in the Secret's namespace to a ServiceAccount that lives elsewhere is the intended pattern here.
- Do not substitute a `ClusterRole`/`ClusterRoleBinding` unless you also want every namespace's Secrets accessible to the gateway. The Role is deliberately tight.

Apply and verify:

```bash
kubectl -n <gateway-ns> apply -f istio-ingressgateway-sds-rbac.yaml

# Envoy should stop logging the authorization failure.
kubectl -n istio-system logs deploy/istiod --tail=200 | \
  grep -i 'attempted to access unauthorized certificates' || echo "clean"

# The gateway should now serve the TLS handshake end-to-end.
curl -vkI https://<gateway-host>/ 2>&1 | head -20
```

Requests should now reach the backend service, and `istiod` should no longer log SDS authorization denials.

## Diagnostic Steps

```bash
# 1. Confirm which ServiceAccount the ingress gateway actually runs under.
kubectl -n <gateway-ns> get pods -l istio=ingressgateway \
  -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.spec.serviceAccountName}{"\n"}{end}'

# 2. Confirm the Secret referenced by the Gateway exists and is in the
#    namespace you think it is.
kubectl get gateway <gw> -n <app-ns> \
  -o jsonpath='{.spec.servers[*].tls.credentialName}{"\n"}'
kubectl get secret <credential-name> -n <gateway-ns>

# 3. Check whether the gateway's SA can actually read the Secret today.
kubectl auth can-i get secrets \
  --as=system:serviceaccount:<gateway-ns>:<sa-name> \
  -n <gateway-ns>

# 4. Watch istiod's SDS/auth log while issuing a test TLS request.
kubectl -n istio-system logs deploy/istiod --tail=50 -f | \
  grep -iE 'secret|unauthorized|sds'

# 5. Pull the live Envoy SDS view from the gateway to confirm it now
#    has a valid secret loaded.
kubectl -n <gateway-ns> exec deploy/istio-ingressgateway -- \
  pilot-agent request GET config_dump | \
  jq '.configs[] | select(."@type"|contains("SecretsConfigDump"))'
```

`kubectl auth can-i get secrets --as=system:serviceaccount:...` is the fastest way to bisect the problem: if it returns `no`, the RBAC pair from **Resolution** above is missing or misaligned; if it returns `yes` but Envoy still has no secret, the issue is upstream — check the `Gateway`'s `credentialName` spelling and that the Secret's type is `kubernetes.io/tls` with non-empty `tls.crt` and `tls.key`.
