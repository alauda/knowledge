---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500027
---

# Generate a New kubeconfig for ACP Cluster Access

## Issue

A platform administrator needs a fresh `kubeconfig` for an Alauda Container Platform cluster — for handing access to a new automation system, replacing a leaked file, or rotating a long-lived credential. Directly revoking the contents of an existing kubeconfig is risky because the same file may be shared by system components, CI jobs, or other administrators; instead the supported workflow is to mint a new credential and retire the old one in a controlled fashion.

## Root Cause

A kubeconfig is just a YAML document that bundles a cluster endpoint, a user identity (a client certificate, a bearer token, or an exec credential plugin), and a context that pairs the two. Because the same identity may be embedded in many kubeconfig files distributed to many users, removing access requires invalidating the underlying identity (rotating its certificate, deleting its ServiceAccount token Secret, or removing its RBAC bindings) — not editing one local file. New access is therefore created by generating a brand-new identity and exporting a kubeconfig that references it.

## Resolution

Choose the credential type that matches how the kubeconfig will be used:

### Option 1 — long-lived ServiceAccount token (recommended for automation)

A ServiceAccount with a manually provisioned token Secret gives a stable bearer-token identity that can be revoked by deleting the Secret without affecting any other user.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-readonly
  namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: ci-readonly-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: ci-readonly
type: kubernetes.io/service-account-token
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ci-readonly-view
subjects:
- kind: ServiceAccount
  name: ci-readonly
  namespace: kube-system
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

Apply, then export the credential into a kubeconfig:

```bash
kubectl apply -f sa.yaml
TOKEN=$(kubectl -n kube-system get secret ci-readonly-token \
          -o jsonpath='{.data.token}' | base64 -d)
CA=$(kubectl -n kube-system get secret ci-readonly-token \
          -o jsonpath='{.data.ca\.crt}')
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CLUSTER=acp

kubectl config --kubeconfig=new-kubeconfig set-cluster "$CLUSTER" \
  --server="$SERVER" --certificate-authority=<(echo "$CA" | base64 -d) \
  --embed-certs=true
kubectl config --kubeconfig=new-kubeconfig set-credentials ci-readonly \
  --token="$TOKEN"
kubectl config --kubeconfig=new-kubeconfig set-context ci-readonly \
  --cluster="$CLUSTER" --user=ci-readonly
kubectl config --kubeconfig=new-kubeconfig use-context ci-readonly
```

### Option 2 — short-lived TokenRequest (recommended for humans)

For interactive users who already have an identity in the platform's authentication backend, request a bounded-lifetime token and have the user import that into their kubeconfig:

```bash
kubectl -n kube-system create token ci-readonly --duration=8h > token.txt
```

Distribute the token alongside the cluster CA bundle and server URL. The user runs the same `kubectl config set-cluster / set-credentials / set-context` sequence as above, substituting the token from `token.txt`.

### Option 3 — TLS client certificate

If the cluster authenticator is configured to accept client certs (verify with the platform owner before using):

```bash
openssl genrsa -out user.key 2048
openssl req -new -key user.key -out user.csr -subj "/CN=jane/O=devs"

cat <<EOF | kubectl apply -f -
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata: { name: jane-csr }
spec:
  request: $(base64 -w0 < user.csr)
  signerName: kubernetes.io/kube-apiserver-client
  usages: [client auth]
EOF

kubectl certificate approve jane-csr
kubectl get csr jane-csr -o jsonpath='{.status.certificate}' \
  | base64 -d > user.crt
```

Then build the kubeconfig with `kubectl config set-credentials jane --client-certificate=user.crt --client-key=user.key --embed-certs=true`.

### Retire the old kubeconfig

After the new file is verified to work, invalidate the old credential:

- ServiceAccount token: `kubectl delete secret <old-token-secret>`. The next API call from the old kubeconfig will return 401.
- Bound TokenRequest: nothing to do — the token expires on its own.
- Client certificate: revoke in your CA/PKI; until rotated, also strip RBAC bindings (`kubectl delete clusterrolebinding <name>`).

## Diagnostic Steps

If a freshly generated kubeconfig does not work:

```bash
kubectl --kubeconfig=new-kubeconfig auth can-i get nodes
kubectl --kubeconfig=new-kubeconfig get --raw='/api'
```

- 401 → the token / certificate is wrong or has been deleted.
- 403 → identity is valid but RBAC is missing; double-check the `RoleBinding`/`ClusterRoleBinding` and the `subjects[].name`/`namespace` matches the SA you used.
- TLS error → the embedded CA does not match the cluster API server; re-fetch the CA from the SA token Secret or from the platform's certificate distribution mechanism.
