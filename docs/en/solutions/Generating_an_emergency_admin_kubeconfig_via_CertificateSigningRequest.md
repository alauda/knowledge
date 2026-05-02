---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Generating an emergency admin kubeconfig via CertificateSigningRequest

## Issue

The original administrator kubeconfig produced at install time can be lost, leaked, or fail with `x509: certificate signed by unknown authority` after a control-plane CA rotation. When that happens — and the operator no longer has any working cluster-admin path through the OIDC / OAuth identity provider — the cluster still has to be reachable.

This procedure mints a fresh, short-lived client certificate that authenticates as the conventional admin identity (`CN=system:admin`, group `system:masters`) using the standard Kubernetes CSR API. It is a recovery path of last resort: the resulting credential bypasses the IdP and inherits the full `cluster-admin` ClusterRoleBinding that ships with every conformant cluster. Treat the generated key as a sensitive secret and rotate it immediately after the incident is closed.

If a non-CSR signing path (custom CA appended to the apiserver `client-ca-file`) is available, prefer that — its expiry is bounded by the operator's own CA, not by the cluster signer's 14-month rotation horizon.

## Resolution

### Generate a key + CSR

Create a 4096-bit RSA key and a PKCS#10 CSR whose subject embeds the recovery identity:

```bash
openssl req -new -newkey rsa:4096 -nodes \
  -keyout admin-recovery.key \
  -out admin-recovery.csr \
  -subj "/CN=system:admin/O=system:masters"
```

The Common Name is the username the apiserver will see; the Organization is the group, and `system:masters` is the group bound to the built-in `cluster-admin` ClusterRole.

### Submit the CSR to the cluster

The CSR resource references the upstream `kube-apiserver-client` signer, which is what every standard cluster uses to sign client-auth certificates:

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: admin-recovery
spec:
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400          # 1 day; cap to the shortest acceptable
  groups:
    - system:authenticated
  request: <BASE64_OF_admin-recovery.csr>
  usages:
    - client auth
```

Inline the encoded CSR and create it:

```bash
REQUEST=$(base64 -w0 admin-recovery.csr)
sed "s|<BASE64_OF_admin-recovery.csr>|${REQUEST}|" csr.yaml | kubectl apply -f -
```

`expirationSeconds` is honoured by the apiserver as long as the chosen signer accepts it; the cluster's signing CA may further cap the lifetime. The default — when omitted — is one year, and most platform-managed signers cap individual certificates to far less than the signer's own validity.

### Approve and harvest the certificate

A user that already holds `certificates.k8s.io/certificatesigningrequests/approval` permission must approve the CSR. From a session that does have that permission:

```bash
kubectl get csr
kubectl certificate approve admin-recovery
kubectl get csr admin-recovery \
  -o jsonpath='{.status.certificate}' | base64 -d > admin-recovery.crt
```

If no such session exists — meaning the operator has no working admin path at all — the recovery becomes a node-local operation: SSH to a control-plane node, present a kubeconfig that points at `https://localhost:6443` with the localhost serving CA, and approve from there. That out-of-band path is platform-specific and should be treated as the last fallback.

### Assemble the recovery kubeconfig

Build a fresh kubeconfig containing the new certificate, the cluster's serving CA bundle, and a context that selects the recovery user. Pull the apiserver CA from a service-account token secret in any system namespace:

```bash
KUBECTL=kubectl
$KUBECTL get secret \
  -n kube-system \
  -l kubernetes.io/service-account.name=default \
  -o jsonpath='{.items[0].data.ca\.crt}' | base64 -d > apiserver-ca.crt
```

If the cluster fronts the apiserver with custom-CA-signed certificates that are not part of the in-cluster CA bundle, append them:

```bash
cat custom-apiserver-ca.crt >> apiserver-ca.crt
```

Then assemble the kubeconfig with three `kubectl config` calls so the file lays itself out idiomatically:

```bash
KCFG=/tmp/recovery.kubeconfig
SERVER=$($KUBECTL config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CLUSTER=$($KUBECTL config view --minify -o jsonpath='{.clusters[0].name}')

kubectl config set-cluster "$CLUSTER" \
  --server="$SERVER" \
  --certificate-authority=apiserver-ca.crt \
  --embed-certs \
  --kubeconfig="$KCFG"

kubectl config set-credentials system:admin \
  --client-certificate=admin-recovery.crt \
  --client-key=admin-recovery.key \
  --embed-certs \
  --kubeconfig="$KCFG"

kubectl config set-context system:admin \
  --cluster="$CLUSTER" \
  --namespace=default \
  --user=system:admin \
  --kubeconfig="$KCFG"

kubectl config use-context system:admin --kubeconfig="$KCFG"
```

### Verify the credential

Authenticate against the cluster and confirm the principal:

```bash
kubectl --kubeconfig="$KCFG" auth whoami -o yaml
kubectl --kubeconfig="$KCFG" get nodes
```

`auth whoami` should report `username: system:admin` plus `system:masters` and `system:authenticated` group membership. Once the recovery kubeconfig is verified working, immediately:

1. Re-establish the long-term admin identity through the regular IdP / OAuth path.
2. Rotate the cluster-signer if there is any reason to believe the apiserver CA was compromised.
3. Delete the recovery key (`shred -u admin-recovery.key`) and revoke the CSR record.

## Diagnostic Steps

If `kubectl certificate approve` returns `Forbidden`, the executing identity does not hold the `approve` verb on `signers/kubernetes.io/kube-apiserver-client`. Check it explicitly:

```bash
kubectl auth can-i approve certificatesigningrequests \
  --subresource=approval
```

If false, no recovery is possible from that session — escalate to a node-local approval path or use a backup of the long-term admin kubeconfig if one is on file.

If the resulting kubeconfig still fails with `x509: certificate signed by unknown authority`, the embedded CA bundle does not include the chain that signs the apiserver's serving cert. Confirm what the apiserver actually presents:

```bash
echo Q | openssl s_client -connect "${SERVER#https://}" -showcerts 2>/dev/null \
  | awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/'
```

Compare the issuer of the leaf certificate against the bundle in `apiserver-ca.crt`. If they don't match, append the missing intermediate or root.

If `kubectl auth whoami` reports `system:anonymous` or fails, the certificate is being rejected before being mapped to a user. Re-decode the CSR's status and confirm the `Subject` matches what was requested:

```bash
openssl x509 -in admin-recovery.crt -noout -subject -issuer -dates
```

Subject must be `CN=system:admin, O=system:masters`; if `O=` was dropped during signing, the cluster will authenticate the user but not grant cluster-admin (that ClusterRoleBinding is keyed by group, not by user).

To inspect the binding that confers admin rights:

```bash
kubectl get clusterrolebinding cluster-admin -o yaml
```

The default upstream binding maps `Group: system:masters` to `ClusterRole: cluster-admin`; if that binding has been edited or replaced (some hardened distributions do), adjust the recovery CSR's subject to whatever group the local cluster trusts for admin.
