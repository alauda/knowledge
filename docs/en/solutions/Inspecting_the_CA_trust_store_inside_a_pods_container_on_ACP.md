---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Inspecting the CA trust store inside a pod's container on ACP

## Issue

On Alauda Container Platform clusters (observed on `jingguo-7gm6m` running kubelet `v1.34.5`, containerd `2.2.1-5`, and ACP base install package `v4.3.5`), an operator needs to confirm whether a given root CA is present in the trust store of a running pod's container — but the workload images on a single cluster span several base-image families and therefore lay out their trust stores at different filesystem paths. Live pods on this cluster draw from at least three base families: UBI (for example `ubi9/ubi`), alpine (for example `haproxy:2.0.34-alpine-2`, `redis:7.2-alpine.dfd3ac10`), and ACP platform images. The path under `/etc/pki/tls/certs/` that works for a UBI-based pod is absent in an alpine- or Ubuntu-based pod, so the operator must first identify the pod's base image and then look up the trust store at the path that base image ships with.

## Root Cause

The in-container CA trust store is a property of the container image's filesystem, populated at image build time by the base image's `ca-certificates` package, and is not injected or rewritten by the orchestrator. All four nodes on this cluster run Ubuntu 22.04.1 LTS, yet pods include UBI9-based images that present `/etc/pki/tls/certs/...` inside the container, alongside alpine-based images that do not — confirming that the trust store path is image-defined, not host-defined. The `containerd://2.2.1-5` CRI runtime is generic and does not rewrite `/etc/pki/` or `/etc/ssl/` inside containers, so the layout the operator observes inside a pod is exactly what the base image ships. ACP does not enforce a single base image for workload containers, so the trust store path is whatever the chosen base ships: UBI-family images carry the bundle under `/etc/pki/tls/certs/`, while Ubuntu (and other Debian/Alpine-style) bases carry it under `/etc/ssl/`.

## Resolution

Identify the pod's container image first, then exec into the pod and read the trust store at the path that matches the base-image distribution. Because the path is base-image-dependent, an operator must inspect the trust store at the location that corresponds to the pod's distribution rather than assume a single fixed path across all workloads.

Read the container image reference from the PodSpec — the standard `spec.containers[].image` field surfaces the image (registry, repository, tag), from which the base image and therefore the expected trust store layout can be identified:

```bash
kubectl get pod <pod-name> -n <namespace> -o yaml
kubectl get pod <pod-name> -n <namespace> \
    -o jsonpath='{.spec.containers[*].image}'
```

For a pod whose container is built from a UBI-family base image (for example `ubi9/ubi`, observed as a Completed pod on this cluster), the system CA trust bundle is shipped by the `ca-certificates` RPM at image build time at `/etc/pki/tls/certs/ca-bundle.crt`, and the trust-format variant of the same bundle is shipped at `/etc/pki/tls/certs/ca-bundle.trust.crt`. Both files are part of the image's CA trust chain as shipped at build time and are not altered by the orchestrator.

For a pod whose container is built from an Ubuntu base image, the system trust store is not under `/etc/pki/tls/certs/` at all — the Debian/Ubuntu trust chain conventionally resides under `/etc/ssl/` (see the image's own documentation for the exact bundle filename). An operator who runs the UBI-style lookup against an Ubuntu-based pod will see the path missing; that absence is expected and is itself the signal to switch to the `/etc/ssl/` location.

To run shell commands against the container's filesystem, use `kubectl exec` against the target pod and inspect the trust store at the path that matches the base image. This is the generic Kubernetes verb for the same operation and works uniformly across all workload pods on ACP:

```bash
# UBI-family container — system bundle and trust-format bundle
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    ls -l /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.trust.crt

# Ubuntu / Debian / Alpine container — bundle lives under /etc/ssl/
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    ls -l /etc/ssl/certs/ca-certificates.crt
```

## Diagnostic Steps

Start from the pod's PodSpec to determine which trust-store layout applies. `kubectl get pod -o yaml` returns the standard PodSpec on ACP, with `spec.containers[].image` carrying the literal `registry/repo:tag` for each container — the field operators inspect to look up the base image and from there the expected PKI path. This is the same field path as on any conformant Kubernetes cluster:

```bash
kubectl get pod <pod-name> -n <namespace> \
    -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.image}{"\n"}{end}'
```

Once the base image is known, exec into the container and inspect the trust store at the matching path. For a UBI-family image, list the two `ca-bundle*.crt` files and, if the container has a shell with `grep`, search the bundle for the subject string of the root CA in question:

```bash
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    ls -l /etc/pki/tls/certs/
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    sh -c "grep -i '<CA Subject CN>' /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.trust.crt || true"
```

For an Ubuntu-based image, run the equivalent inspection against the Debian/Ubuntu location instead:

```bash
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    ls -l /etc/ssl/certs/
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    sh -c "grep -i '<CA Subject CN>' /etc/ssl/certs/ca-certificates.crt || true"
```

If the chosen path does not exist inside the container, the container is built from a different base family — return to the PodSpec, re-check `spec.containers[].image`, and switch to the trust-store path that the new base ships. The path is image-defined; the orchestrator does not provide a uniform alternative.
