---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Mounting a custom CA bundle into Argo CD's repo-server on ACP

## Issue

On Alauda Container Platform, Argo CD ships as the `argocd` ModulePlugin (catalog entry `gitops`) and the installer chart deploys an `ArgoCD` custom resource into the `argocd` namespace under the name `argocd-gitops`. When the cluster needs to reach a Git remote whose HTTPS certificate is signed by a private (internal) Certificate Authority that is not part of the repo-server image's default trust store, the `argocd-repo-server` pod cannot verify the peer and the `Application` reports a synchronization failure. Pre-patch, the `Application.status` carries a `ComparisonError` condition that contains the verbatim string `x509: certificate signed by unknown authority`, and the matching `argocd-repo-server` container emits a `grpc.error` log line with the same `x509: certificate signed by unknown authority` text — the HTTPS endpoint itself is reachable from inside the pod, so the only barrier is trust.

## Root Cause

A cluster-wide trusted-CA auto-injection path — a ConfigMap labeled with an `inject-trusted-cabundle` flag and populated upstream from a cluster trust bundle — is not available on ACP because the dedicated platform-config namespace that mechanism depends on is not present, so the auto-populated bundle path cannot run on this platform. The portable path is an explicit-content ConfigMap, where the operator places the PEM data itself into a regular ConfigMap in the `argocd` namespace and mounts it into the repo-server container.

## Resolution

On the ACP install package shipping `argocd` ModulePlugin `v4.2.0-beta.59.g188c8116` (argocd-operator CSV upgraded from `beta.3` to `v4.2.0` through an OLM `REPLACES` edge), the `ArgoCD` CR is served at `argoproj.io/v1beta1` and exposes `.spec.repo.volumes` (the standard Kubernetes `Volume` shape, including a `configMap` source) and `.spec.repo.volumeMounts` (the standard `VolumeMount` shape with `mountPath` / `subPath` / `name`) as the operator-supported way to add files into the `argocd-repo-server` container. Editing those fields is preferred over patching the downstream Deployment directly, because the operator reconciles its own Deployment and any drift would be reverted.

The `argocd-repo-server` container image consults the OS-level trust path `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem` for the certificate pool used by its Go HTTP client; this path is image-defined, not distribution-defined, so overlaying a ConfigMap key `ca-bundle.crt` onto that exact file (via `subPath: ca-bundle.crt`) replaces the default bundle for the repo-server only. The replacement file should therefore contain the additional root CAs the workload needs to trust — concatenated with any existing roots the operator still requires — because subPath mounts are file-granularity overlays and the original content is shadowed.

Create the ConfigMap and patch the `ArgoCD` CR with a two-step shape: (1) create the ConfigMap from the PEM file in the `argocd` namespace, (2) merge-patch the CR's `.spec.repo` block to add both the volume and the volumeMount. ACP admission accepts the patch on `argocd.argoproj.io/v1beta1` (a `ResourcePatch` audit-allow notice is emitted, e.g. `rp-4wk9c`), the argocd-operator then reconciles the `argocd-repo-server` Deployment from revision 2 to revision 3, and a fresh ReplicaSet rolls out with both replicas Ready.

```bash
kubectl -n argocd create configmap cluster-root-ca-bundle \
 --from-file=ca-bundle.crt=<path-to-bundle>.pem
```

```bash
kubectl -n argocd patch argocd argocd-gitops --type merge -p '{
 "spec": {
 "repo": {
 "volumes": [
 {
 "name": "cluster-root-ca-bundle",
 "configMap": { "name": "cluster-root-ca-bundle", "optional": true }
 }
 ],
 "volumeMounts": [
 {
 "name": "cluster-root-ca-bundle",
 "mountPath": "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
 "subPath": "ca-bundle.crt"
 }
 ]
 }
 }
}'
```

After the operator reconciles, the new repo-server pods serve the patched trust store: a `git ls-remote` issued from inside the container against the private-CA endpoint returns a `refs/heads/main` SHA, the on-disk `tls-ca-bundle.pem` at the mount path matches the PEM source byte-for-byte, and a fresh log window over the `argocd-repo-server` container contains zero `x509` entries; the previously-reported `ComparisonError` on the `Application` clears, with the `x509: certificate signed by unknown authority` string no longer present in `.status.conditions`.

## Diagnostic Steps

Inspect the existing repo-server state before patching. The argocd-operator owns a `Deployment/argocd-gitops-repo-server` in the `argocd` namespace; its baseline `volumes` list does not include a `cluster-root-ca-bundle` entry, and the container's `volumeMounts` reflect the operator's default layout.

```bash
kubectl -n argocd get deploy argocd-gitops-repo-server \
 -o jsonpath='{.spec.template.spec.volumes}'
kubectl -n argocd get deploy argocd-gitops-repo-server \
 -o jsonpath='{.spec.template.spec.containers[?(@.name=="argocd-repo-server")].volumeMounts}'
```

When inspecting failing Argo CD `Application` objects on ACP, use the fully-qualified resource name `applications.argoproj.io`. The short name `application` can resolve to a different CRD that also lives on ACP (`app.k8s.io`), and scripts that rely on `kubectl get application` without the FQN will read the wrong object. The verbatim trust failure surfaces in two places — the `Application` resource and the repo-server container log:

```bash
kubectl -n argocd get applications.argoproj.io <app-name> \
 -o jsonpath='{.status.conditions}'
kubectl -n argocd logs deploy/argocd-gitops-repo-server \
 --tail=200 | grep -i x509
```

A pre-patch run of either command surfaces the literal text `x509: certificate signed by unknown authority`; the same commands after the rollout completes show the condition cleared and the log window free of `x509` entries. To confirm the bundle actually landed inside the new pod, read the mounted file and compare its size and contents to the source PEM — the trusted-store overlay is a file-granularity mount, so a mismatch points at a stale ConfigMap or a wrong `subPath` key rather than at trust policy.

```bash
kubectl -n argocd exec deploy/argocd-gitops-repo-server -- \
 cat /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem | wc -c
```

If the `Application` still reports a non-trust error after the rollout (for example a transport-level disconnect on the Git endpoint), that class of symptom is outside the scope of this trust-bundle fix and should be investigated as a separate Service / routing issue rather than re-patching the CA bundle.
