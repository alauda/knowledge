---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.0"
  - "4.3"
---

# DevOps Node.js or apt downloads fail: gnutls_handshake failed, npm install hangs, or the Nexus connection is reset

## Issue

A Node.js stage, or a Maven stage that installs operating system packages, fails in a DevOps pipeline while downloading dependencies. One of these symptoms is shown:

- npm cannot download a front-end dependency that lives on GitHub. The stage dies while running `git`, and the log contains `gnutls_handshake() failed: Error in the pull function.` and `error code: 128`. A workstation using the same Nexus npm proxy still installs.
- The Node.js stage hangs while pulling dependencies until the stage times out, although the same dependencies can be pulled from outside the cluster. The log stops after a line such as `npm warn deprecated wrench@1.3.9: wrench.js is deprecated! ...`.
- `apt update` in a build command fails with `Clearsigned file isn't valid, got 'NOSPLIT' (does the network require authentication?)` and `The repository 'http://archive.ubuntu.com/ubuntu jammy InRelease' is not signed.`
- A custom build image whose Yarn registry points at a private Nexus npm repository over HTTPS keeps timing out on package pulls.

Related articles: "Maven stage misses Nexus: mirrorOf stays central after mavenMirrorURL, or 501 HTTPS Required after generate-settings" covers Maven mirror settings.

## Root Cause

### Cause 1: `gnutls_handshake() failed`: the git subprocess that npm starts does not use npm's proxy

npm starts `/usr/bin/git ls-remote -h -t https://github.com/<owner>/<repo>.git` for dependencies declared as GitHub URLs (directly, or inside a parent `package.json`), and git exits `128` during the TLS handshake. The stage has an npm proxy and a Nexus npm repository, but those settings never reach git, because the git subprocess does not load npm's proxy configuration. The cluster has no direct path to GitHub, so the Git URLs fail. The Node.js dependency cache is not involved.

### Cause 2: npm or `apt` downloads time out because the build Pod cannot reach the external network

The build Pod, or the nodes of the cluster where the build runs, have no connectivity to the external repository. Reachability from a workstation does not matter; the path from inside the cluster does.

- For `apt update`, the Pod requests the external Ubuntu repositories, cannot reach them, and receives something other than the signed `InRelease` file, which produces the `NOSPLIT` error for `jammy`, `jammy-updates`, and `jammy-backports`.
- For npm, the registry may redirect tarball downloads to an external host, or a dependency is fetched from GitHub. A deprecation warning such as `wrench@1.3.9` is not the error: it is the last line printed before npm tries to fetch a dependency that it cannot reach. Unlike Cause 1, no `git ls-remote` or `gnutls_handshake()` line is printed.

### Cause 3: `curl: (56) OpenSSL SSL_read: Connection reset by peer, errno 104` between the nodes and the private Nexus

Package pulls from the private Nexus npm registry time out. A `curl` from a cluster node to one tarball in that repository negotiates TLS and verifies the certificate (`SSL certificate verify ok.`), and right after the GET is sent it fails with `OpenSSL SSL_read: Connection reset by peer, errno 104`, `Failed receiving HTTP2 data`, `OpenSSL SSL_write: Broken pipe, errno 32`, and finally `curl: (56)`. The timeouts are a network fault on the path between the nodes and Nexus. Unlike Cause 2, the target is the site's own Nexus, and TCP and TLS succeed before the reset. Changing the Yarn registry, the lock file, or the build image does not change a reset on this path.

## Resolution

### Cause 1: `gnutls_handshake() failed`: the git subprocess that npm starts does not use npm's proxy

Apply this only when the stage log shows `/usr/bin/git ls-remote` to a GitHub URL together with `gnutls_handshake() failed: Error in the pull function.`

1. Put the proxy in the environment of that stage's shell, before `npm install`. Registry-only npm configuration can stay as it is; it is not sufficient for the git child process. Replace `192.0.2.10:3128` with the real proxy, and keep the in-cluster Nexus Service in `NO_PROXY`.

   > **Warning:** The proxy then applies to the rest of that shell, including fetches that are not GitHub. Precondition: only when the handshake error above is in the log and the proxy is one the site already trusts for GitHub. Rollback: remove the export lines.

   ```bash
   export http_proxy="http://192.0.2.10:3128"
   export https_proxy="http://192.0.2.10:3128"
   export HTTP_PROXY="http://192.0.2.10:3128"
   export HTTPS_PROXY="http://192.0.2.10:3128"
   export no_proxy="nexus-nxrm-ha.devops-system.svc.cluster.local,localhost,127.0.0.1"
   export NO_PROXY="nexus-nxrm-ha.devops-system.svc.cluster.local,localhost,127.0.0.1"
   npm install
   ```

2. Alternatively, if the manifest pins the dependency to a GitHub URL, switch it to a version that the npm repository already serves, so that git is no longer invoked.

   > **Warning:** This edits application source and selects a different artifact. Precondition: only when the version exists in the npm repository selected for the pipeline. Rollback: revert the manifest in Git.

   ```json
   {
     "dependencies": {
       "<package>": "<published-version>"
     }
   }
   ```

3. As a temporary bridge while the Git URL is removed or the proxy export is added, the installed `node_modules` tree can be copied to a PVC that is mounted on the next runs, with the npm prefix set to it:

   > **Warning:** Later builds reuse whatever is on that volume, including packages that were replaced upstream. Precondition: only when Cause 1 is confirmed and a trusted `node_modules` tree already exists. Rollback: detach the PVC.

   ```bash
   npm config set prefix "/workspace/tmp/node_modules"
   ```

### Cause 2: npm or `apt` downloads time out because the build Pod cannot reach the external network

Apply this only when the checks in Diagnostic Steps fail from a Pod in the build namespace and the log has no `git ls-remote` (that is Cause 1).

1. Run the front-end build in the pipeline's Node.js stage, not in an ad hoc shell step or a Dockerfile.
2. Give the cluster network access to the external dependency repository, including the host that the registry redirects tarballs to, and GitHub when a dependency is fetched from there. If that path cannot be opened, switch the dependency source to a mirror that the cluster can reach, such as an npm proxy repository inside the cluster (for example the Nexus npm proxy selected as the dependency repository). If the site uses an HTTP forward proxy, export it in the stage as shown for Cause 1.
3. Stop running `apt` at build time. Install the packages into the Java build image on a machine that has network access, and use that image for the Maven stage. For a build that needed the Chinese locale:

   ```dockerfile
   FROM <java-build-image>
   USER root
   RUN apt-get update \
    && apt-get install -y --no-install-recommends language-pack-zh-hans \
    && rm -rf /var/lib/apt/lists/*
   ENV LC_ALL=zh_CN.UTF-8
   USER <original-user>
   ```

   Read `<original-user>` with `docker inspect --format '{{.Config.User}}' <java-build-image>`; if it prints nothing, the image runs as root and the last `USER` line can be dropped. Check the image before pushing it: `docker run --rm --entrypoint /bin/sh <new-image> -c 'locale -a | grep -i zh_CN'` should list `zh_CN.utf8`. Push the image, point the build node or task at it, and remove the `apt` commands from the stage, so that the command is only the Maven part, for example `mvn -DskipTests package -B -T 4`.

### Cause 3: `curl: (56) OpenSSL SSL_read: Connection reset by peer, errno 104` between the nodes and the private Nexus

1. Give the `curl` output from Diagnostic Steps to the team that owns the network path between the nodes and Nexus (firewalls, load balancers, or proxies in front of Nexus), and have the reset removed there.
2. After the network change, run the same `curl` again. A complete download (HTTP `200` and the expected size) is the condition for running the build again.

## Diagnostic Steps

Cause 1, in the Node.js stage log:

```text
/usr/bin/git ls-remote -h -t https://github.com/<owner>/<repo>.git
gnutls_handshake() failed: Error in the pull function.
error code: 128
```

In a debug Pod that uses the build image, check whether git and npm disagree:

```bash
npm config get registry
npm config get proxy
command -v git && git --version
```

Cause 2, from a Pod in the build namespace that uses the build image:

```bash
kubectl run netcheck -n <namespace> --rm -it --restart=Never --image=<nodejs-build-image> -- sh
# inside the shell
npm config get registry
npm view <package> dist.tarball
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 "$(npm config get registry)"
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 <tarball-url-printed-above>
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://github.com
```

A timeout here, while the same URL works from a workstation, is Cause 2. A tarball URL on a host other than the registry is a redirect that also needs a network path. For `apt`, list the sources and test one of them:

```bash
cat /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null | grep -v '^#'
curl -sS --max-time 10 http://archive.ubuntu.com/ubuntu/dists/jammy/InRelease | head -3
```

A signed file starts with `-----BEGIN PGP SIGNED MESSAGE-----`. A timeout, or an HTML page from a gateway, matches the `NOSPLIT` error.

Cause 3: read the registry URL in the build image with `yarn config get registry` (it ends with `/`). Then, from a cluster node, request one tarball that the build fails to pull, over HTTP/2 and over HTTP/1.1:

```bash
curl -v -o /dev/null <registry-url><package>/-/<package>-<version>.tgz
curl -v --http1.1 -o /dev/null <registry-url><package>/-/<package>-<version>.tgz
```

`SSL certificate verify ok.`, then `Connection reset by peer, errno 104` and `curl: (56)`, is Cause 3. The second command shows whether the reset also happens over HTTP/1.1; give both outputs to the network team.
