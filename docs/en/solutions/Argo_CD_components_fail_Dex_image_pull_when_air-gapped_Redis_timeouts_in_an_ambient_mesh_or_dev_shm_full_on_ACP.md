---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Argo CD components fail: Dex image pull when air-gapped, Redis timeouts in an ambient mesh, or dev shm full on ACP

## Issue

Argo CD on ACP is reconciled by `argocd-operator` from an `ArgoCD` resource (`argoproj.io/v1beta1`); direct edits to the Deployments and StatefulSets it owns are reverted. One of these is reported:

- In an air-gapped cluster, `argocd-dex-server` cannot pull `ghcr.io/dexidp/dex@sha256:...`, and SSO (for example through a Keycloak OIDC connector) fails with `i/o timeout`.
- After the Dex image is mirrored, the Dex Pod still fails with `failed to pull and unpack image "<platform-registry>/3rdparty/dex:2.43.0": failed to resolve reference ... x509: certificate signed by unknown authority`, or the `argocd-dex-server` Deployment returns to the `ghcr.io` image after it was edited.
- Every Argo CD component fails to reach Redis with `connection reset by peer`, `EOF`, `context deadline exceeded`, or `i/o timeout`; `application-controller` logs `Failed to save cluster info: i/o timeout` and `Failed to cache app resources: i/o timeout`; SSO is broken too.
- The Argo CD UI shows `failed to write manifest: write /dev/shm/...: no space left on device`.

Related articles: "Argo CD Application sync not permitted, repository Not Found, InvalidSpecError, or empty GitOps project list on ACP".

## Root Cause

### Cause 1: the Dex image is referenced from `ghcr.io`, or the mirrored image is set in the wrong place or with the wrong tag

An instance with `spec.sso.provider: dex` references the external image `ghcr.io/dexidp/dex@sha256:b08a58c9731c693b8db02154d7afda798e1888dc76db30d34c4a0d0b8a26d913` (Dex `v2.43.0`, linux/amd64). Without internet access no Dex Pod runs. `argocd-server` is always started with the `--dex-server` flag, so a running Dex Pod is required. Two mistakes keep Dex failing after the image is mirrored:

- **Tag without `v`:** the image is pushed as `3rdparty/dex:v2.43.0`, but the Pod references `3rdparty/dex:2.43.0`. The pull fails with `failed to resolve reference ... x509: certificate signed by unknown authority`. Although the message names a certificate, correcting the tag to `v2.43.0` lets the Pod start.
- **Image edited in the Deployment:** the operator reconciles the `argocd-dex-server` Deployment back to the `ghcr.io` image. The image must be set in the Dex section of the `ArgoCD` resource (`spec.sso.dex.image` and `spec.sso.dex.version`).

### Cause 2: the Argo CD namespace is in an Istio ambient mesh with STRICT mTLS

The Argo CD namespace carries the label `istio.io/dataplane-mode=ambient`, and a global `PeerAuthentication` in `istio-system` sets mTLS to `STRICT`. ztunnel enforces mTLS on the node, without sidecars, and silently blocks the plain TCP traffic between Argo CD components. This surfaces as timeouts across Redis, Dex, and repo-server.

The Redis TLS setup looks like the cause but is not. The operator starts Redis with TLS when a Redis TLS Secret exists and configures components with `--redis-use-tls`; the resource has no option to disable Redis TLS, and `spec.redis.disableTLSVerification` only skips certificate verification. Deleting `argocd-repo-server-tls`, the Argo CD server Deployment, or the Redis StatefulSet to force reconfiguration leaves Redis stuck on `MountVolume.SetUp failed for volume "redis-tls" : secret "<argocd-name>-redis-tls" not found` and does not address the mesh.

### Cause 3: `/dev/shm` of the repo server is too small

The repo server writes generated manifests to `/dev/shm`. The default shared memory is too small for the manifests of the instance.

## Resolution

### Cause 1: the Dex image is referenced from `ghcr.io`, or the mirrored image is set in the wrong place or with the wrong tag

1. On a master node of the global cluster, load the image and push it to the platform registry. Use `nerdctl` there, because Docker is not running on the masters (for example on ACP 4.2.1). The loaded image has no name (`<none>`), so tag it by image ID:

   ```bash
   nerdctl -n k8s.io load -i dex.tar
   nerdctl -n k8s.io images | grep '<none>'
   cat /etc/kubernetes/registry/auth.yaml        # platform registry credentials
   nerdctl -n k8s.io login <platform-registry>
   nerdctl -n k8s.io tag <image-id> <platform-registry>/3rdparty/dex:v2.43.0
   nerdctl -n k8s.io push <platform-registry>/3rdparty/dex:v2.43.0
   ```

2. Set the image in the `ArgoCD` resource, not in the Deployment. The tag must be exactly the pushed tag, `v2.43.0`:

   ```yaml
   spec:
     sso:
       provider: dex
       dex:
         image: <platform-registry>/3rdparty/dex
         version: v2.43.0
   ```

   In the instance form these are the **Image** and **Version** fields of the Dex section.

   ```bash
   kubectl -n <argocd-namespace> edit argocd <argocd-name>
   ```

3. The Dex Pod starts and SSO works.

### Cause 2: the Argo CD namespace is in an Istio ambient mesh with STRICT mTLS

1. Take the Argo CD namespace out of the ambient mesh.

   > **Warning:** Removing the label takes every Pod in the namespace out of the Istio ambient mesh: traffic to and from them is no longer mTLS-protected by ztunnel, and mesh policies stop applying to them. Precondition: only when the label and the STRICT `PeerAuthentication` are confirmed (Diagnostic Steps, step 2) and no workload in the namespace depends on the mesh. Rollback: `kubectl label ns <argocd-namespace> istio.io/dataplane-mode=ambient`.

   ```bash
   kubectl label ns <argocd-namespace> istio.io/dataplane-mode-
   ```

2. Keep Argo CD in a namespace without the ambient label; the operator does not support opting individual Argo CD Pods out of the mesh.

3. If Redis TLS Secrets or Argo CD workloads were deleted during troubleshooting, let the operator recreate them and check that the Redis Pod mounts its TLS volume.

### Cause 3: `/dev/shm` of the repo server is too small

1. Mount a memory-backed `emptyDir` at `/dev/shm` for the repo server through the `ArgoCD` resource, leaving the rest of the configuration unchanged.

   > **Warning:** The change rolls the repo server; manifest generation and syncs pause until the new Pod is Ready. An `emptyDir` with `medium: Memory` counts against the Pod's memory, so a large `sizeLimit` can push the repo server into OOM. Precondition: memory headroom in the repo server limit. Rollback: remove the volume and the mount again.

   ```yaml
   spec:
     repo:
       volumeMounts:
       - mountPath: /dev/shm
         name: shm-volume
       volumes:
       - name: shm-volume
         emptyDir:
           medium: Memory
           sizeLimit: 1Gi   # 512Mi or 1Gi recommended
   ```

   ```bash
   kubectl -n <argocd-namespace> edit argocd <argocd-name>
   ```

2. `df -h /dev/shm` in the `argocd-repo-server` container shows a `tmpfs` mount with free space, and the error does not return.

## Diagnostic Steps

1. For SSO failures, check the Dex image and pull events:

   ```bash
   kubectl -n <argocd-namespace> get deploy <argocd-name>-dex-server -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
   kubectl -n <argocd-namespace> get events --field-selector reason=Failed | grep -i dex
   kubectl -n <argocd-namespace> get argocd <argocd-name> -o jsonpath='{.spec.sso.dex.image}:{.spec.sso.dex.version}{"\n"}'
   ```

   An image that still starts with `ghcr.io` is Cause 1. For an `x509: certificate signed by unknown authority` pull error on the mirrored image, first compare the referenced tag with the pushed tag (`v2.43.0`).

2. For timeouts across components, check the mesh before touching Redis TLS:

   ```bash
   kubectl get ns <argocd-namespace> --show-labels
   kubectl get peerauthentication -A
   kubectl -n <argocd-namespace> logs <argocd-name>-application-controller-0 --tail=50 | grep -i timeout
   ```

   `istio.io/dataplane-mode=ambient` on the namespace plus a `STRICT` `PeerAuthentication` is Cause 2.

3. For the manifest write error, check the repo server mount:

   ```bash
   kubectl -n <argocd-namespace> exec deploy/<argocd-name>-repo-server -c argocd-repo-server -- df -h /dev/shm
   ```

   A full `/dev/shm` (`Use%` near `100%`) is Cause 3.
