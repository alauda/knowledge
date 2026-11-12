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

# Platform registry pull fails with authorization failed or insufficient_scope: auth.yaml targets or node login

## Issue

Nodes reach the platform image registry (the built-in registry of the global cluster, often addressed as `<registry-host>:11443`), but pulls are denied:

- After the core environment is upgraded, custom-built images stored under the `/solution` path fail to pull.
- Plugin images newly added to the built-in registry on port `11443` fail to pull in Pods and with `crictl pull` on the node, with `authorization failed`.
- Images uploaded to the platform registry cannot be pulled in a business cluster, although they are present in the registry storage:

  ```text
  PullImage from image service failed ... pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed
  ```

Related articles: [Registry push fails with insufficient_scope or authentication required on ACP](Registry_push_fails_with_insufficient_scope_or_authentication_required_on_ACP.md).

## Root Cause

The platform registry authorizes requests with `/etc/kubernetes/registry/auth.yaml` on the global control-plane nodes. Each user entry grants `actions` (`pull`, `push`, `delete`) on one or more `target` patterns (regular expressions when `useRegexp: true`). A node that presents no credential is handled by the `_anonymous` entry, which by default grants `pull` only on a few repositories (for example `tkestack/.*` and `windows/.*`).

### Cause 1: the user's pull target does not include the solution repository

The user's `pull` entry lists the platform prefixes only, for example `target: (acp|ait|devops|asm|alauda|3rdparty|ops|middleware|automation|frontend|developer\-platform)/.*` with `useRegexp: true`, and the `_anonymous` entry covers only `tkestack/.*` and `windows/.*`. Neither matches `solution/...`, so pulls of custom-built images under `/solution` are denied. Adding `solution` to the user's `target` and restarting the registry fixes it.

### Cause 2: the repository of newly added images has no anonymous pull entry

Node pulls without an image pull secret go through the `_anonymous` entry. When new images are added to a repository that no anonymous `target` covers (for example `3rdparty`), the pulls fail with `authorization failed`. Adding an anonymous pull target for that repository in `auth.yaml` is the fix.

### Cause 3: the business-cluster node has no valid credential for the repository

On a business-cluster node, `crictl pull <registry-host>:11443/<repository>/<image>:<tag>` returns `insufficient_scope: authorization failed`, while DNS resolution and TCP to port `11443` work and the image is present in the registry storage (MinIO under `/cpaas/minio` on each global control-plane node). Adding an anonymous pull entry to `auth.yaml` does not help. Logging the node in to the registry again with `nerdctl -n k8s.io login <registry-host>:11443 --insecure-registry` makes the pulls work. The underlying mechanism has not been identified.

## Resolution

Before any edit of `auth.yaml`: the file exists on every global control-plane node, and all copies must stay identical. Compare them first:

```bash
md5sum /etc/kubernetes/registry/auth.yaml
```

### Cause 1

1. Find the entry of the affected user:

   ```bash
   grep -n -B3 -A8 'useRegexp' /etc/kubernetes/registry/auth.yaml
   ```

2. Add `solution` to the user's `target` alternation, in the same form as the other prefixes, for example `(acp|ait|...|developer\-platform|solution)/.*`, then restart the registry so it reads the file.

   > **Warning:** Only when the failing images are under `/solution` and no `target` of the user or of `_anonymous` matches `solution/`. Impact: a wrong edit can deny pulls of platform images to every cluster that uses this registry, and the restart interrupts pushes and pulls until the registry is Ready. Precondition: a copy of the file on each node, only the `target` of the affected user changes, and every global control-plane node gets the same change. Rollback: restore the copies and restart the registry again.

   ```bash
   cp -a /etc/kubernetes/registry/auth.yaml /root/auth.yaml.bak
   vi /etc/kubernetes/registry/auth.yaml
   kubectl get pods -A | grep -i registry
   kubectl rollout restart deploy/<registry-deploy> -n <registry-namespace>
   kubectl rollout status deploy/<registry-deploy> -n <registry-namespace>
   ```

3. Retry the pull of a custom-built image under `/solution`. A pull from another repository is not the check.

### Cause 2

1. Read the `_anonymous` entry on each global control-plane node:

   ```bash
   grep -n -A12 '_anonymous' /etc/kubernetes/registry/auth.yaml
   ```

2. Add an anonymous pull target for the failing repository in the same format as the existing ones (for example a target `3rdparty/.*` with action `pull` next to `tkestack/.*`), change nothing else, and restart the registry as in Cause 1.

   > **Warning:** Only when the failing repository is not covered by any anonymous target and the pulls are made without an image pull secret. Impact: anyone who can reach the registry can then pull every image in that repository without credentials; a YAML error in the file can stop the registry from authenticating anyone. Precondition: the images in that repository may be readable by anyone who reaches the registry, a copy of the file is kept on each node, and every node gets the same edit. Rollback: restore the copies and restart the registry.

3. Retry `crictl pull` of one of the new images on a node. If it still fails with `insufficient_scope`, continue with Cause 3.

### Cause 3

1. Confirm the image is in the registry storage, on a global control-plane node:

   ```bash
   du -sh /cpaas/minio
   ls /cpaas/minio/*/registry/docker/registry/v2/repositories/<repository>/
   ```

2. From the failing node, confirm name resolution and the port, and reproduce the error:

   ```bash
   nslookup <registry-host>
   nc -vz -w 3 <registry-host> 11443
   crictl pull <registry-host>:11443/<repository>/<image>:<tag>
   ```

3. Log the node in to the registry again.

   > **Warning:** Only when the image is present, the port answers, and the pull returns `insufficient_scope: authorization failed`. Impact: `nerdctl login` stores the registry credential, base64-encoded, in the Docker config file of the user who runs it (`/root/.docker/config.json` for root), and the kubelet then sends it for pulls from that registry; `--insecure-registry` skips certificate verification for this login. Precondition: the account is one the registry owner approves for node pulls, and the existing config file is copied aside. Rollback: `nerdctl -n k8s.io logout <registry-host>:11443`, or restore the copied file.

   ```bash
   cp -a /root/.docker/config.json /root/docker-config.json.bak 2>/dev/null
   nerdctl -n k8s.io login <registry-host>:11443 --insecure-registry
   crictl pull <registry-host>:11443/<repository>/<image>:<tag>
   ```

4. Repeat on every node that must pull the image. If you added an anonymous entry to `auth.yaml` while testing and it is not part of the intended configuration, remove it again on every global control-plane node.

## Diagnostic Steps

1. Separate a permission denial from a missing tag: list the tags with an account that can read the repository. An empty list means the image is not there.

2. Read the entries that could match the failing repository:

   ```bash
   grep -n -B2 -A12 -E '_anonymous|useRegexp' /etc/kubernetes/registry/auth.yaml | grep -v -i password
   ```

   - Custom-built images under `/solution`, with no `target` matching `solution/`: Cause 1.
   - A repository with newly added images, pulled without an image pull secret, with no anonymous `target` covering it: Cause 2.

3. `insufficient_scope: authorization failed` on a business-cluster node, with the image present under `/cpaas/minio` and port `11443` reachable: Cause 3. Try the node login before editing `auth.yaml`.

4. A `401` from Harbor rather than from the platform registry is covered in [Harbor image pull returns 401 because of the pull Secret, the project account, or node credentials](Harbor_image_pull_returns_401_because_of_the_pull_Secret_the_project_account_or_node_credentials.md).
