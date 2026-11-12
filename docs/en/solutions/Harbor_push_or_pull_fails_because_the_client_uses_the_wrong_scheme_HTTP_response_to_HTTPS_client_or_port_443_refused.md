---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Harbor push or pull fails because the client uses the wrong scheme: HTTP response to HTTPS client, or port 443 refused

## Issue

`docker login`, `docker push`, `crictl pull`, Buildah, Skopeo, Jenkins, or a pipeline reaches a Harbor or registry address and fails before any repository permission check. A request such as "images cannot be imported into the image registry" often lands here: run `docker login <registry-host>:<port>` on the host that pushes and read the first error.

| Client error | Cause |
| --- | --- |
| `Error response from daemon: Get "https://<registry-host>:<port>/v2/": http: server gave HTTP response to HTTPS client` | Cause 1 |
| After the cluster comes up, most Pods cannot pull from an HTTP registry, and `/etc/containerd/certs.d` has no directory for that registry | Cause 1 |
| Login, or Skopeo authentication, fails although the registry port is open; the token realm points at a different scheme or host | Cause 2 |
| `dial tcp <registry-ip>:443: connect: connection refused` while the builder always uses HTTPS | Cause 3 |

The kubelet and `crictl` use containerd. A `daemon.json` change does not affect them, and `docker login` does not test the runtime that starts Pods. For x509 errors, see [Harbor or registry image pull fails with x509 certificate signed by unknown authority or certificate has expired](Harbor_or_registry_image_pull_fails_with_x509_certificate_signed_by_unknown_authority_or_certificate_has_expired.md).

## Root Cause

### Cause 1: the registry serves HTTP and the client uses HTTPS

containerd, Docker, Buildah, and Skopeo open an HTTPS connection when the image reference has no scheme. If Harbor is published as HTTP, the TCP connection succeeds and the client aborts as soon as it reads a clear-text HTTP response. Adding `skip_verify` does not change the scheme. containerd can try HTTPS first even when an HTTP fallback exists, and a Docker pull succeeds only when the reference includes the HTTP port that Harbor actually listens on. A `daemon.json` edit takes effect only after `dockerd` restarts, has no effect when it names a different host or port than the image reference, and never applies to containerd.

The same missing host configuration shows up right after a cluster starts: most Pods cannot pull, and `/etc/containerd/certs.d` has no directory for the registry those images use. Adding the registry host configuration restores the pulls. Nodes can also differ: one control-plane node pulls the HTTP registry while the others cannot, because their containerd host configuration differs. Pods that stay in `CrashLoopBackOff` after pulls work are application faults, not a second registry fault.

### Cause 2: the Harbor external URL scheme does not match the client

Harbor builds its token and redirect responses from its external URL. When the external URL is `http` while containerd is configured for `https` (or the reverse), or a redirect proxy in front of Harbor rewrites the host, the client follows the token realm to a URL it did not authenticate against, and the failure looks like a bad password. The same mistake leaves the UI unreachable after a new Harbor instance is deployed with an access address that clients do not use, while the Pods stay `Running`.

### Cause 3: nothing listens on port 443

After a platform upgrade, Jenkins and BuildKit can keep requesting `https://<harbor-host>:443` for a local Harbor that does not listen there. The build log shows `connect: connection refused` while loading base-image metadata. This is not a certificate or permission problem.

containerd can report the same line, `failed to do request: Head "https://<registry-ip>/v2/.../manifests/<tag>": dial tcp <registry-ip>:443: connect: connection refused`, when the requested tag does not exist in the registry. Check that the tag exists before changing the builder or the Harbor listener.

## Resolution

### Cause 1

1. On every node that pulls, create a host directory that matches the image reference exactly, including a non-default port. For an image `192.0.2.10:5000/team/app:1.0` the file is `/etc/containerd/certs.d/192.0.2.10:5000/hosts.toml`:

   ```toml
   server = "http://192.0.2.10:5000"

   [host."http://192.0.2.10:5000"]
     capabilities = ["pull", "resolve", "push"]
   ```

2. Check that `/etc/containerd/config.toml` loads that directory:

   ```bash
   grep -n "config_path" /etc/containerd/config.toml
   ```

   containerd 1.x (`io.containerd.grpc.v1.cri` present):

   ```toml
   [plugins."io.containerd.grpc.v1.cri".registry]
     config_path = "/etc/containerd/certs.d"
   ```

   containerd 2.x (`version = 3` or `io.containerd.cri.v1.images` present):

   ```toml
   [plugins."io.containerd.cri.v1.images".registry]
     config_path = "/etc/containerd/certs.d"
   ```

   Change `config.toml` only to add a missing `config_path` that a healthy node of the same platform version already has. Do not regenerate it with `containerd config default`, and do not add `registry.mirrors` or `configs` blocks for the registry: a hand-added Harbor mirror block can break pulls from the platform registry. For extra insecure registries, the platform procedure is "Configure trust for insecure image registries" in the ACP documentation.

3. Retry `crictl pull` on the node. When `config_path` was already loaded and only a `hosts.toml` was added or changed, containerd 1.5 and later read it on the next pull without a restart. A `config.toml` change needs a containerd restart.

   > **Warning:** Only when `config.toml` was changed. Impact: restarting containerd interrupts the CRI socket on the node; the kubelet cannot start, stop, or probe containers meanwhile and the node can report `NotReady`. With the standard unit (`KillMode=process`, check with `systemctl show containerd -p KillMode`) running containers keep running; with `control-group` or `mixed` every container on the node stops. Precondition: drain the node, one node at a time, in a maintenance window, after copying `/etc/containerd/config.toml` and `/etc/containerd/certs.d` aside. Rollback: restore the copies and restart containerd again.

   ```bash
   kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
   systemctl restart containerd
   kubectl uncordon <node>
   ```

4. Docker clients ignore `hosts.toml`. Put the same host:port in `insecure-registries` in `/etc/docker/daemon.json` and use that host:port in the image reference; a reference without the port still uses 443.

   ```json
   {
     "insecure-registries": ["192.0.2.10:5000"]
   }
   ```

   > **Warning:** `insecure-registries` turns off TLS verification for that host:port and allows clear-text pulls; limit it to the HTTP registry. Impact: restarting Docker stops containers that run under `dockerd`. Precondition: a copy of `daemon.json` and a maintenance window. Rollback: restore the copy and restart Docker. This does not change kubelet pulls.

   ```bash
   cp -a /etc/docker/daemon.json /root/daemon.json.bak
   systemctl restart docker
   ```

   After the restart, the first `docker login` can return `unauthorized: authentication required`; entering the credentials again returns `Login Succeeded`, and `docker tag` and `docker push` then complete. Retry the login once before treating it as a credential fault.

5. Skopeo and Buildah default to HTTPS. For an HTTP Harbor, pass the TLS flags. If a pipeline task hides the CLI, set the task's TLS parameter so it adds them.

   > **Warning:** These flags disable certificate checks for that command. Use them for an HTTP registry only, not as a default for an HTTPS registry. Rollback: run the command without the flags.

   ```bash
   skopeo copy --src-tls-verify=false --dest-tls-verify=false \
     docker://192.0.2.10:5000/team/app:1.0 docker://192.0.2.10:5000/team/app:1.0
   buildah pull --tls-verify=false docker://192.0.2.10:5000/team/app:1.0
   buildah push --tls-verify=false <local-image> docker://192.0.2.10:5000/team/app:1.0
   ```

### Cause 2

1. Read and save the Harbor resource:

   ```bash
   kubectl get harbor -A
   kubectl get harbor -n <harbor-namespace> <harbor-name> -o yaml > /tmp/harbor-before.yaml
   ```

2. Set the external URL to the scheme, host, and port that clients actually open. If a redirect proxy rewrites the host, use the URL the client uses, not an internal Service URL. After a reinstall, set the access address back to the address clients have always used.

   > **Warning:** Saving the Harbor resource makes the operator roll Harbor components; login, push, and pull pause until the Pods are Ready. Precondition: a maintenance window and `/tmp/harbor-before.yaml`. Rollback: apply that file.

   ```bash
   kubectl edit harbor -n <harbor-namespace> <harbor-name>
   ```

3. Point containerd at the same URL in `hosts.toml`. Prefer a `ca` entry with the registry CA (see the x509 article linked under Issue). Use `skip_verify = true` only when the CA is not available and `openssl s_client` from the node has shown which certificate the port presents.

   > **Warning:** `skip_verify = true` accepts any certificate for that host. Precondition: copy `/etc/containerd/certs.d` aside first. Rollback: restore the copy.

   ```toml
   server = "https://<harbor-host>:443"

   [host."https://<harbor-host>:443"]
     capabilities = ["pull", "resolve", "push"]
     skip_verify = true
   ```

### Cause 3

1. Confirm what is listening:

   ```bash
   curl -sv --connect-timeout 10 https://<harbor-host>/v2/
   curl -sv --connect-timeout 10 http://<harbor-host>:<port>/v2/
   ```

2. If 443 is refused and the HTTP port returns `401 Unauthorized` (the anonymous probe reached the registry), point Jenkins or BuildKit at `http://<harbor-host>:<port>` and allow HTTP for that host in `buildkitd.toml`:

   ```toml
   [registry."<harbor-host>:<port>"]
     http = true
   ```

   Or publish Harbor on 443. Do not add a TLS skip flag: nothing presents a certificate on the refused port.

3. Retry the build with the same base-image reference.

## Diagnostic Steps

1. Record the exact image reference, the client, the node, and the first error line. Keep the port: `registry.example:5000` and `registry.example` are different registry keys.

2. From the failing node, probe both schemes without `-k`:

   ```bash
   curl -sv --connect-timeout 10 https://<harbor-host>:<port>/v2/
   curl -sv --connect-timeout 10 http://<harbor-host>:<port>/v2/
   ```

   `401 Unauthorized` on one scheme means that scheme reached a registry; it is not evidence of a wrong password. `server gave HTTP response to HTTPS client` selects Cause 1. `connection refused` on 443 selects Cause 3. An `x509` line belongs to the x509 article.

3. See what containerd uses for this host, and compare with a node that can pull:

   ```bash
   containerd --version
   grep -n "config_path\|certs.d" /etc/containerd/config.toml
   sed -n '1,80p' /etc/containerd/certs.d/<harbor-host>:<port>/hosts.toml
   containerd config dump | grep -n config_path
   ```

4. Separate runtime pulls from Docker pulls:

   ```bash
   crictl pull <harbor-host>:<port>/<project>/<repository>:<tag>
   docker pull <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

   `crictl pull` failing while `docker pull` works means the node runtime configuration is wrong: fix `hosts.toml`, not `daemon.json`.

5. For a pipeline Skopeo or Buildah push, read the task log for the registry URL it contacted. An authentication error that names a different host than the image reference selects Cause 2, even when TLS succeeded.

6. If a 401 remains after the scheme is correct, see [Harbor image pull returns 401 because of the pull Secret, the project account, or node credentials](Harbor_image_pull_returns_401_because_of_the_pull_Secret_the_project_account_or_node_credentials.md).
