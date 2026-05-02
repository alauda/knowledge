---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A Multus-related container image (the multus-network-policy controller, a
custom CNI plugin packaged from a vendor base, or any in-cluster Multus
add-on built locally) ends up several hundred megabytes larger than
expected. Symptoms include:

- private registry storage requirements ballooning,
- worker node disk pressure during image pulls,
- noticeably long pod-initialisation time on first scheduling.

The cause is invariably the same: the image was built by a Dockerfile
that runs a `dnf install` step but does not clean up the package
manager's metadata and cached RPMs in the same layer. The cache survives
into the final image and adds tens to hundreds of megabytes of dead
weight.

## Resolution

Combine the package install and the cache cleanup into a single
`RUN` statement so the cleanup happens in the same layer as the install.
Layer commits are immutable in Docker / OCI image formats — running
`dnf clean all` in a later layer does not actually shrink the image,
because the previous layer already captured the cached files.

### Wrong (cache survives in the previous layer)

```dockerfile
RUN dnf install -y nft iptables iproute jq
RUN dnf clean all && rm -rf /var/cache/dnf/*
```

### Right (single RUN, cleanup in the same layer)

```dockerfile
RUN dnf install -y nft iptables iproute jq \
    && dnf clean all \
    && rm -rf /var/cache/dnf/*
```

For images that already exist and cannot be rebuilt (for example a vendor
base image you depend on), an alternative is to `squash` the image to
collapse the layers and then run a `dnf clean` in the squashed image:

```bash
docker build --squash -t myimage:slim .
```

Squashing requires Docker daemon support; it is usually simpler to fix
the source Dockerfile.

### Going further

Apply the same pattern to other commonly bloated artefacts:

- `pip install --no-cache-dir <pkgs>` instead of `pip install <pkgs>`
- `npm ci --omit=dev && npm cache clean --force` for Node images
- `apt-get install ... && apt-get clean && rm -rf /var/lib/apt/lists/*`
  for Debian-based images
- multi-stage builds: do compilation in a builder stage, copy only the
  produced binaries into a minimal runtime stage (e.g.
  `gcr.io/distroless/static`).

For network-plugin images specifically, the runtime usually only needs a
small set of static binaries (`nft`, `iptables`, `iproute2`, the plugin
binary itself); a multi-stage build with a `scratch` or distroless final
stage typically cuts an image from 800 MiB down to under 100 MiB.

## Diagnostic Steps

1. Inspect the layer breakdown of the offending image to confirm the
   bloat lives in a single, identifiable layer:

   ```bash
   docker history --no-trunc --format "table {{.Size}}\t{{.CreatedBy}}" <image>
   ```

   The bad layer is typically the one whose `CreatedBy` line contains
   `dnf install` (or the equivalent for your base distro) and whose size
   accounts for most of the image.

2. Pull the image and exec into a derived container to confirm the
   cache directory is present:

   ```bash
   docker run --rm -it --entrypoint sh <image>
   du -sh /var/cache/dnf
   ```

3. Apply the corrected Dockerfile, rebuild, and confirm the size
   reduction:

   ```bash
   docker build -t <image>:slim .
   docker images | grep <image>
   ```

4. Roll the slimmer image into the cluster's node-side daemonset (the
   Multus-related controller, the custom plugin's daemonset) and confirm
   pod startup time on a representative node drops:

   ```bash
   kubectl get pods -n <multus-ns> -o wide
   kubectl describe pod -n <multus-ns> <pod>
   ```

   The `Pulled` event timestamp minus the `Scheduled` event timestamp is
   the wall-clock cost of the pull; a slimmer image cuts that time
   proportionally.
