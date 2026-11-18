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

# violet push fails with no package found, code 000, HTTP 500 or 502, or invalid reference format on ACP

## Issue

Uploading an extension package or operator with `violet push` stops with an error:

- `Error: no package found in ./plugins/<name>.gz`, although the archive opens fine in an archive tool (for example `edp-keycloak-operator-v1.23.0.gz` downloaded from Alauda Marketplace), or `Error: no package found in installer-core-v4.3.2-hybrid.tar`.
- The push to the platform repository returns `code 000`, and afterwards ModuleInfo reports `moduleconfig <version> not found`, although the previous version pushed to the same repository worked.
- A batch `violet push` of every extension package before an upgrade succeeds for most packages and fails for some with `500 Internal Server Error`.
- `violet push` skips the images that already exist and then repeats `copy error: writing blob: uploading layer chunked: received unexpected HTTP status: 502 Bad Gateway`.
- `violet push ... --dest-repo "https://<registry>:<port>"` fails with `invalid destination name docker://https://<registry>:<port>/...: invalid reference format`, and `docker login` to the platform registry on the same host fails with an X509 error.
- Pushing a chart package to the platform's built-in public chart repository with the platform address, username, and password fails with an invalid username or password.

Related articles: "violet push goes to the wrong global cluster, a wrong package cannot be deleted, or violet or kubectl is missing on ACP" covers pushes that complete in the wrong place or cannot be undone; "violet push fails to parse a package, or a new operator version is skipped or missing on ACP" covers `unexpected EOF`; "violet push succeeds but the plugin is not published: Artifact, ModuleConfig, or chart missing on ACP" covers pushes that report success.

## Root Cause

### Cause 1: Error: no package found, the file is not in the violet package layout

`violet push` accepts only packages in the Violet package layout. A package produced by the standard Violet process (`violet create`, then `violet package <plugin-name>`) is named `PLUGIN_NAME.BUNDLE_VERSION.tgz`, for example `edp-keycloak-operator.v1.23.0.tgz`, and pushes successfully. A `.gz` downloaded from Alauda Marketplace that differs in structure gives `no package found`; renaming or repacking it as `.tgz` or `.tar.gz` gives the same error. The error also appears when the file is not a plugin package at all: `installer-core-v4.3.2-hybrid.tar` is an installer archive, so `violet` finds no package metadata in it.

### Cause 2: code 000, the platform repository could not be reached, and ModuleInfo reports moduleconfig not found

`code 000` means that no HTTP response was received: the host running `violet` could not reach the repository. The plugin artifact was never stored, so the ModuleConfig for that version was never created, and ModuleInfo cannot find it. Once the repository is reachable again, the push succeeds and the ModuleConfig appears.

A host that cannot resolve the registry name fails the same way before any HTTP exchange, with an error such as `dial tcp: lookup <registry-domain>: no such host`.

### Cause 3: some packages of a batch push fail with 500 Internal Server Error

Most images print `found image ... already exists, skip push`; the failing ones print:

```text
copy error: copying image 2/2 from manifest list: writing blob: uploading layer chunked: received unexpected HTTP status: 500 Internal Server Error
push artifact <package>.v<version> to cluster global failed. error: copying image 2/2 from manifest list: ...
failed to push images via skopeo mode for package <dir>/<package>.tgz
```

The same error can name `copying image 1/2`. After a failure, `violet push` continues with the remaining packages. The registry rejected individual layer uploads; pushing only the failed packages again after the run has finished completes them.

### Cause 4: 502 Bad Gateway while uploading layers, the platform registry is OOMKilled and restarting

The push skips the images that already exist and fails on the first layer it has to upload, again and again. The registry Pod that receives the push keeps restarting: its `registry` container shows `Last State: Terminated`, `Reason: OOMKilled`, `Exit Code: 137` (for example with limits `cpu: 1`, `memory: 2Gi`). Each restart cuts off the layer upload in progress, and the gateway in front of the registry answers `502`. After the registry's CPU and memory limits are raised, it stops restarting and the push completes.

### Cause 5: invalid reference format because --dest-repo has https://, and docker login fails with X509

```text
ERRO invalid destination name docker://https://<registry>:<port>/<repository>:<tag>: invalid reference format
WARN failed to push images via skopeo mode for package <package>.tgz, error: invalid reference format
Error: failed to push one or more packages.
```

Two separate problems on the host that runs the push:

- `violet` builds the destination image name from `--dest-repo`. An image reference cannot contain a URL scheme, so `--dest-repo https://<registry>:<port>` makes every image fail with `invalid reference format`. Passwords that contain shell special characters also break when they are not single-quoted.
- `docker login` to the platform registry fails with an X509 error when the registry address is not configured in Docker's `daemon.json` on that host.

### Cause 6: a chart push to the built-in public chart repository is rejected as invalid username or password

Pushing the raw chart to the built-in `public chart` repository with the platform credentials is rejected as an invalid username or password. Packaging the chart with `violet` and pushing it with `violet push` succeeds.

## Resolution

### Cause 1: Error: no package found, the file is not in the violet package layout

1. If you already have a `.tgz` named `PLUGIN_NAME.BUNDLE_VERSION.tgz` (for example from Alauda technical support), push that file:

   ```bash
   violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' edp-keycloak-operator.v1.23.0.tgz
   ```

2. Otherwise build the package with the standard process and push the generated `.tgz`:

   ```bash
   violet create
   violet package <plugin-name>
   ls *.tgz
   ```

Repacking a Marketplace `.gz` by hand does not help. Do not push installer archives such as `installer-core-<version>-<arch>.tar` with `violet push`; they are not plugin packages.

### Cause 2: code 000, the platform repository could not be reached, and ModuleInfo reports moduleconfig not found

1. From the host that runs `violet`, check name resolution and reachability of the repository. Any HTTP status means the host is reachable; `000` or a connection error means it is not:

   ```bash
   getent hosts <platform-repository-host>
   curl -k -s -o /dev/null -w '%{http_code}\n' https://<platform-repository-host>:<port>/v2/
   ```

2. Restore access to the repository: the network path, DNS (or an `/etc/hosts` entry on the push host), the proxy, or the repository service itself.
3. Push the same package again, then check that the ModuleConfig exists on `global`:

   ```bash
   kubectl get moduleconfigs | grep <plugin-name>
   kubectl get moduleinfo | grep <plugin-name>
   ```

   `moduleconfig <version> not found` clears once the version has actually been pushed.

### Cause 3: some packages of a batch push fail with 500 Internal Server Error

1. Let the running push finish completely.
2. Collect the failed packages from its output (the `push artifact <name> to cluster <cluster> failed` and `failed to push images via skopeo mode for package <file>` lines).
3. Push only those:

   ```bash
   mkdir -p ./retry
   cp <failed-package-1>.tgz <failed-package-2>.tgz ./retry/
   violet push ./retry --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>'
   ```

If the same packages fail again with `500`, check the registry Pod as in Cause 4.

### Cause 4: 502 Bad Gateway while uploading layers, the platform registry is OOMKilled and restarting

1. Find the registry Pod on the cluster that the push targets and read why it restarted:

   ```bash
   kubectl get pods -A | grep -i registry
   kubectl -n <registry-namespace> describe pod <registry-pod> | grep -E -A6 'Last State|Limits|Requests|Controlled By'
   ```

   `Reason: OOMKilled` with `Exit Code: 137` on the `registry` container, while the push repeats `502 Bad Gateway`, is this cause.

2. Save the workload before changing it:

   ```bash
   kubectl -n <registry-namespace> get deploy <registry-deployment> -o yaml > "$HOME/<registry-deployment>.before.yaml"
   ```

3. Raise the registry CPU and memory limits.

   > **Warning:** Changing the registry resources restarts the registry Pod; image pulls and pushes against it fail until the new Pod is Ready, and Pods scheduled in that window can be in `ImagePullBackOff` for a while. Precondition: only when the `registry` container's last state is `OOMKilled` (exit code `137`) and the push fails with `502 Bad Gateway`; do it when no push or large rollout is running. Rollback: `kubectl apply -f "$HOME/<registry-deployment>.before.yaml"`.

   ```bash
   kubectl -n <registry-namespace> set resources deploy <registry-deployment> -c registry --limits=cpu=<cpu-limit>,memory=<memory-limit>
   kubectl -n <registry-namespace> rollout status deploy <registry-deployment>
   ```

   Size the memory limit above the peak the container reached before the OOM.

4. After a few minutes, check that the Deployment still carries the new limits. If they went back, the values are managed by the component that deploys the registry; collect the Deployment's labels and annotations and ask Alauda technical support where to set them.
5. When the registry stays Running, push the package again; images that already exist are skipped.

### Cause 5: invalid reference format because --dest-repo has https://, and docker login fails with X509

1. Give `--dest-repo` as `host:port` with no scheme, and single-quote the passwords:

   ```bash
   violet push <package>.tgz \
     --platform-address <platform-access-address> \
     --platform-username <platform-admin-name> \
     --platform-password '<platform-admin-password>' \
     --dest-repo "<registry>:<port>" \
     --username "<registry-user>" \
     --password '<registry-password>' \
     --debug
   ```

   The output should end with `successfully create artifact resources for package <package>`. If an earlier failed attempt left an artifact behind, the push may need `--force`; read the Warning about `--force` in the related article on wrong packages before using it.

2. For the X509 error on `docker login`, check the Docker daemon configuration on the push host:

   ```bash
   cat /etc/docker/daemon.json
   docker login <registry>:<port>
   ```

   For a registry whose certificate the host does not trust, the Docker setting that takes a registry address is `insecure-registries`:

   ```json
   {
     "insecure-registries": ["<registry>:<port>"]
   }
   ```

   > **Warning:** Docker reads `daemon.json` only when it starts. Restarting Docker stops the containers on this host unless `live-restore` is enabled, and an invalid `daemon.json` keeps Docker from starting. `insecure-registries` also turns off TLS verification for that registry from this host. Precondition: only on the host that runs `violet`, when `docker login` to the platform registry fails with an X509 error. Back the file up and merge the key into the existing content instead of replacing it. Rollback: restore the backup and restart Docker again.

   ```bash
   cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
   vi /etc/docker/daemon.json
   systemctl restart docker
   docker login <registry>:<port>
   ```

### Cause 6: a chart push to the built-in public chart repository is rejected as invalid username or password

Package the chart with the packaging flow of the `violet` version that matches the platform, then push the resulting package with `violet push` instead of pushing the raw chart with the platform credentials:

```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' <chart-package>.tgz
```

## Diagnostic Steps

```bash
violet version
getent hosts <platform-repository-host>
curl -k -s -o /dev/null -w '%{http_code}\n' https://<platform-repository-host>:<port>/v2/
kubectl get pods -A | grep -i registry
```

- `no package found` on a Marketplace `.gz` or an installer `.tar`: Cause 1.
- `code 000`, or `lookup ... no such host`, then `moduleconfig <version> not found`: Cause 2. Expected: the `curl` above prints `000` or a connection error.
- `500 Internal Server Error` for some packages of a batch push while the registry Pod is stable: Cause 3.
- `502 Bad Gateway` while uploading layers, with the registry Pod `OOMKilled`: Cause 4.
- `invalid reference format` with `docker://https://` in the destination name, or an X509 error on `docker login`: Cause 5.
- A raw chart push to `public chart` rejected as invalid credentials: Cause 6.
