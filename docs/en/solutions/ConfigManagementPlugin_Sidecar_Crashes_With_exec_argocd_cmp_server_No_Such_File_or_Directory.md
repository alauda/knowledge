---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# ConfigManagementPlugin Sidecar Crashes With "exec argocd-cmp-server No Such File or Directory"
## Issue

A custom Argo CD `ConfigManagementPlugin` (CMP) — for example a Helm-template wrapper, a Kustomize-with-secrets bootstrapper, or any sidecar that exposes `argocd-cmp-server` to the repo-server — refuses to start. The container terminates immediately, and the logs show:

```text
exec /var/run/argocd/argocd-cmp-server: no such file or directory
```

The binary is plainly mounted into the container by Argo CD's init mechanism — `kubectl exec` into a sister sidecar shows it sitting at the expected path. Yet the kernel still reports it as missing when it tries to launch the process.

## Root Cause

The "no such file or directory" message in this case is misleading. The binary file exists; what is missing is the dynamic loader the binary expects. The `argocd-cmp-server` binary copied into the sidecar by the init container is dynamically linked against `glibc`. When the CMP container is built on a base image that ships with a different libc (musl in Alpine, BusyBox's stripped C library, distroless images without `ld-linux`), the `execve` syscall fails because the dynamic linker referenced inside the ELF header is not present on the filesystem. Linux surfaces that as `ENOENT` against the binary itself, not against the missing loader, which is what makes the error confusing.

Recent Argo CD releases additionally require the sidecar's runtime to be FIPS-compatible. A FIPS-validated `argocd-cmp-server` cannot complete its self-test in a container whose crypto stack does not honour FIPS mode, and the resulting failure surfaces with the same exec error.

## Resolution

Use a base image that satisfies both requirements:

- a glibc-based userland that includes the dynamic loader (`/lib64/ld-linux-x86-64.so.2` on x86-64, equivalent on other architectures);
- a crypto stack that supports FIPS mode if the cluster runs in FIPS mode.

There are three recommended approaches, in order of preference.

### Option A: Reuse the upstream Argo CD base image

The simplest path is to extend the official Argo CD image so the CMP sidecar already has every shared library `argocd-cmp-server` requires:

```yaml
# Containerfile
FROM quay.io/argoproj/argocd:v2.13.0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      <plugin-dependencies> \
    && rm -rf /var/lib/apt/lists/*
USER 999
```

This is the path with the smallest support surface — the runtime is the one the upstream project tests against.

### Option B: Build on a glibc-based, FIPS-capable distribution

If the security policy mandates a custom base image, choose one whose libc is glibc and whose OpenSSL build supports FIPS:

```yaml
FROM <internal-registry>/ubi9-minimal:latest
RUN microdnf install -y <plugin-dependencies> && microdnf clean all
COPY my-plugin /usr/local/bin/my-plugin
USER 1000
```

Universal-base images of the UBI 9 family ship glibc + an OpenSSL build that enters FIPS mode automatically when the host kernel reports FIPS mode. If the cluster is not in FIPS mode, no further configuration is needed; if it is, the OpenSSL provider picks it up at process start.

### Option C: Force FIPS mode at image-build time

For images that need to satisfy FIPS compliance regardless of host configuration, switch the crypto policy explicitly inside the Containerfile:

```yaml
FROM <fips-capable-base>
RUN update-crypto-policies --set FIPS
COPY my-plugin /usr/local/bin/my-plugin
```

This step is safe to run at build time and bakes the policy into the image so that the resulting container behaves the same way regardless of the node policy.

After rebuilding the plugin image, restart the repo-server pod so it picks up the new sidecar:

```bash
kubectl -n argocd rollout restart statefulset argocd-application-controller
kubectl -n argocd rollout restart deployment argocd-repo-server
```

The CMP sidecar should now reach `Running` and Argo CD should report the plugin healthy.

## Diagnostic Steps

To confirm the root cause before rebuilding, exec into the failing sidecar (or a sister container that shares the volume) and inspect the binary:

```bash
kubectl -n argocd exec -it deploy/argocd-repo-server -c <cmp-sidecar> -- \
  /var/run/argocd/argocd-cmp-server --version || true
```

If the binary fails the same way, dump its dynamic-loader requirement and check whether that loader is present on the filesystem:

```bash
kubectl -n argocd exec -it deploy/argocd-repo-server -c <cmp-sidecar> -- sh -c '
  head -c 100 /var/run/argocd/argocd-cmp-server | strings | head -5
  ls -l /lib64/ld-linux-x86-64.so.2 2>/dev/null || echo "loader missing"
'
```

A `loader missing` line confirms the libc mismatch. Switch to a glibc-based base image as described above.

For FIPS-mode mismatches, check the kernel and the container OpenSSL provider report the same state:

```bash
# host
cat /proc/sys/crypto/fips_enabled

# inside the sidecar
kubectl -n argocd exec -it deploy/argocd-repo-server -c <cmp-sidecar> -- \
  openssl list -providers
```

The container should advertise the `fips` provider when the host enables FIPS; if it does not, the image is not FIPS-capable and needs to be replaced or rebuilt with `update-crypto-policies --set FIPS`.
