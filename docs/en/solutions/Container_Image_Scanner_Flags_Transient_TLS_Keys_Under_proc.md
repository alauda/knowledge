---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Container Image Scanner Flags Transient TLS Keys Under /proc
## Issue

A container image scanner (for example, Prisma Cloud) reports **"Private keys stored in image"** findings against many platform and add-on images. The reported file paths all live under `/proc/<pid>/root/...` rather than inside the image's static layers, for example:

```text
/proc/4281/root/tmp/serving-cert-1854743501/serving-signer.key
/proc/7102/root/var/lib/haproxy/conf/default_pub_keys.pem
/proc/3604/root/usr/share/doc/perl-Net-SSLeay/examples/server_key.pem
```

Findings appear across many namespaces and many controller images (api-server controllers, ingress routers, GitOps, logging, cert-manager, pipelines, and similar workloads).

## Root Cause

The matched files are not part of any image layer. They are observed by the scanner because it walks the host's `/proc` tree and indexes every file mounted into a running container's mount namespace through `/proc/<pid>/root/`.

Two distinct categories produce the hits:

1. **Runtime-generated serving certificates.** Many control-plane controllers use a small Go helper that, at process start, materialises an in-memory keypair into a tmpfs path such as `/tmp/serving-cert-<random>/`. The key exists only for the lifetime of the process and is never written back into the image. The same controller library is used by upstream Kubernetes-style controllers more broadly, so the pattern shows up across vendor add-ons.
2. **Documentation and example payloads embedded in OS packages.** Files like `/usr/share/doc/perl-Net-SSLeay/examples/server_key.pem` are sample keys shipped by upstream packages for testing. They are never used as production credentials and have no value to an attacker.

In both cases the key material is either ephemeral (category 1) or a public sample (category 2). Neither represents a leaked production secret.

## Resolution

Treat the findings as a scanner false-positive on `/proc` walking, not as a vulnerability that requires an image change.

1. **Confirm the path is under `/proc/<pid>/root/`.** Anything that resolves through `/proc/<pid>/root/...` is a view of a *running container's* mount namespace, not a file shipped in the image. The same image inspected at rest (for example with `skopeo inspect` or `crane`) will not contain the path.

2. **Filter the scanner.** Exclude `/proc/*` from the scan target list, or add a per-rule suppression for the "Private keys stored in image" finding when the matched path begins with `/proc/`. Most image scanners support a path allowlist or a file-glob exclusion at the rule level.

3. **Spot-check the actual image layers.** If verification is still required, inspect the underlying image without running it:

   ```bash
   IMAGE=<image-ref>
   skopeo copy "docker://$IMAGE" "dir:/tmp/img"
   for layer in /tmp/img/*.tar*; do
     tar -tf "$layer" | grep -E '\.(key|pem)$' || true
   done
   ```

   Real keys baked into a layer would appear here; transient `serving-cert-*` paths under `/tmp` will not.

4. **Keep watching for genuine hits.** Scanner findings that do **not** start with `/proc/` (for instance, a key copied into `/etc/pki/...` inside the image filesystem) still need to be triaged. Only the `/proc/...` paths are safe to suppress.

## Diagnostic Steps

Identify the running container that owns a flagged PID and confirm the file is process-scoped:

```bash
# On the affected node:
PID=4281
sudo readlink "/proc/${PID}/cwd"
sudo cat "/proc/${PID}/cgroup"
sudo ls -l "/proc/${PID}/root/tmp/" 2>/dev/null | grep -i 'serving-cert' || true
```

Map the PID back to a pod, then verify the key vanishes when the pod is restarted:

```bash
kubectl get pods -A -o wide | grep <node>
POD=<pod>
NS=<namespace>
kubectl -n "$NS" delete pod "$POD"
# After the new pod starts, the serving-cert directory is regenerated
# under a different random suffix; the previous path no longer exists.
```

If the same finding persists across pod restarts and the path resolves to a fixed location *outside* `/proc` (for example `/etc/pki/tls/private/server.key` inside the image rootfs), the file is genuinely shipped in the image and the responsible component owner should be engaged for review.
