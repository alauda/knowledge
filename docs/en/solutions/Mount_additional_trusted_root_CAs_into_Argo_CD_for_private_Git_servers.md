---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Mount additional trusted root CAs into Argo CD for private Git servers
## Issue

Argo CD cannot clone from a Git server that is fronted by a private or enterprise Root Certificate Authority. When the `argocd-repo-server` tries to pull the repository it fails with:

```text
x509: certificate signed by unknown authority
```

The CA bundle baked into the Argo CD container image only contains the common public roots, so the enterprise CA that signs the Git server's TLS certificate is rejected and every `Application` that references that repo stays in `Unknown` or `Error` sync state.

## Resolution

Mount the enterprise CA bundle into the `argocd-repo-server` container so Go's default trust store picks it up. The ACP `gitops` component is Argo CD, so any standard Argo CD trust-bundle pattern works; the steps below are the canonical one.

1. **Create a ConfigMap with the CA bundle.**

   Place the extra root CAs (PEM-concatenated) under the key `ca-bundle.crt`:

   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: cluster-root-ca-bundle
     namespace: <argocd-namespace>
   data:
     ca-bundle.crt: |
       -----BEGIN CERTIFICATE-----
       MIID... (your enterprise root CA) ...
       -----END CERTIFICATE-----
   ```

   If your platform already exposes a cluster-wide proxy / trust bundle injector (a controller that watches ConfigMaps with a known label and merges the node-level CA bundle into them), label an empty ConfigMap and let the controller populate it:

   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: cluster-root-ca-bundle
     namespace: <argocd-namespace>
     labels:
       config.alauda.io/inject-trusted-cabundle: "true"
   ```

   Only one of the two styles is needed — either ship the PEM yourself, or use the injector. Do not mix both into the same ConfigMap.

2. **Create it.**

   ```bash
   kubectl apply -f cluster-root-ca-bundle.yaml
   ```

3. **Patch the `ArgoCD` custom resource** so the repo-server container mounts the bundle over `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem` (the path the Argo CD base image trusts by default):

   ```yaml
   apiVersion: argoproj.io/v1beta1
   kind: ArgoCD
   metadata:
     name: argocd
     namespace: <argocd-namespace>
   spec:
     repo:
       volumeMounts:
         - name: cluster-root-ca-bundle
           mountPath: /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem
           subPath: ca-bundle.crt
       volumes:
         - name: cluster-root-ca-bundle
           configMap:
             name: cluster-root-ca-bundle
             optional: true
   ```

   The Argo CD operator rolls the change onto the `argocd-repo-server` Deployment. Because the mount replaces the default trust store, set `optional: true` on the ConfigMap — if the bundle is ever missing, the container can still start with its embedded roots rather than crash-looping.

4. **Wait for the rollout and retry a sync.**

   ```bash
   kubectl -n <argocd-namespace> rollout status deploy/argocd-repo-server
   kubectl -n <argocd-namespace> logs deploy/argocd-repo-server | \
     grep -Ei "x509|unknown authority"
   ```

   A successful retry should produce a clean `git ls-remote` without the x509 error, and the dependent `Application` resources should reconcile.

For Git repositories that use SSH rather than HTTPS, this procedure is not needed — SSH host keys are configured through the Argo CD SSH repository credentials, not the TLS trust bundle. For self-signed certificates that are **not** anchored under an enterprise CA, prefer storing the leaf certificate in the `Repository` credential rather than extending the cluster-wide trust store.

## Diagnostic Steps

Confirm the current repo-server trust store does not include the enterprise CA:

```bash
kubectl -n <argocd-namespace> exec deploy/argocd-repo-server -- \
  sh -c 'awk -v cmd="openssl x509 -noout -subject" \
         "/BEGIN CERT/{c=\"\"} {c=c\"\\n\"\$0} /END CERT/{print c | cmd; close(cmd)}" \
         /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem' \
  | grep -i '<your-org-name>'
```

Reproduce the x509 error from inside the pod against the actual Git endpoint:

```bash
kubectl -n <argocd-namespace> exec deploy/argocd-repo-server -- \
  git ls-remote https://git.internal.example.com/platform/app.git
```

After the ConfigMap is mounted, the same `git ls-remote` should succeed. If it still fails:

- verify the PEM in the ConfigMap decodes (`openssl x509 -in ca-bundle.crt -text`),
- confirm the mountPath matches the base image — on some rebuilds the trust bundle lives under `/etc/ssl/certs/ca-certificates.crt` instead; mount to whichever path `argocd-repo-server` actually reads.
