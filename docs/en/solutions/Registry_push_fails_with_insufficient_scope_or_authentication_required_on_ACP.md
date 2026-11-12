---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda DevOps
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Registry push fails with insufficient_scope or authentication required on ACP

## Issue

Login reaches the registry, but the account is not allowed to push, or the push carries no credential:

- `nerdctl` or `ctr` push fails, after the registry address itself is correct, with:

  ```text
  push access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed
  ```

  The account is the registry user entered when the platform was deployed (for example `cpaas`). A push as `admin` is not rejected.
- A pipeline Buildah task pulls the base image, then the push fails with:

  ```text
  Error: pushing image "<registry>/<project>/<repository>:<tag>" to "docker://<registry>/<project>/<repository>:<tag>": trying to reuse blob sha256:<digest> at destination: checking whether a blob sha256:<digest> exists in <registry>/<project>/<repository>: authentication required
  ```
- A new global cluster cannot reuse a Harbor that was deployed with the previous platform version.

A `docker login` or push that fails with `http: server gave HTTP response to HTTPS client` never reaches the account check; see [Harbor push or pull fails because the client uses the wrong scheme: HTTP response to HTTPS client, or port 443 refused](Harbor_push_or_pull_fails_because_the_client_uses_the_wrong_scheme_HTTP_response_to_HTTPS_client_or_port_443_refused.md). For pull denials from the platform registry, see [Platform registry pull fails with authorization failed or insufficient_scope: auth.yaml targets or node login](Platform_registry_pull_fails_with_authorization_failed_or_insufficient_scope_auth.yaml_targets_or_node_login.md).

## Root Cause

### Cause 1: the platform-deployment registry user has only pull permission

In `/etc/kubernetes/registry/auth.yaml` on the global control-plane nodes, the registry user entered during platform deployment has only `pull` on target `.*`, while `admin` has `pull`, `push`, and `delete` on `.*`. A push with that user fails with `insufficient_scope: authorization failed`. Pushing with an account that has push permission (`admin`) is the fix.

### Cause 2: the Buildah task has no registry credentials bound for the push

In an ACP UI pipeline that uses the built-in Buildah task, the base-image pull succeeds and the push fails with `authentication required` on the blob check, because the task has no registry credentials for the push. The task has an optional `registry-config` workspace that provides a `config.json` at the workspace root, which Buildah uses to authenticate to the registry. Binding that workspace to the docker-credentials Secret of the target Harbor integration supplies the credentials.

### Cause 3: the Harbor integration on the new global cluster has wrong credentials

When a new global cluster is set up to reuse the Harbor deployed with the previous platform version, the integration does not work if the credentials configured for the existing Harbor are wrong. Removing the integration and adding it again with the correct credentials restores access.

## Resolution

### Cause 1

1. With the registry address in `/etc/containerd/certs.d` already correct, read the actions granted to the account you pushed with (password lines filtered out):

   ```bash
   grep -n -B2 -A8 '<username>' /etc/kubernetes/registry/auth.yaml | grep -v -i password
   ```

   Only `pull` for that user, and `pull`, `push`, `delete` for `admin`, confirms the cause.

2. Push as `admin`:

   ```bash
   printf '%s' "$REGISTRY_ADMIN_PASSWORD" | nerdctl login <registry-host>:<port> --username admin --password-stdin
   nerdctl push <registry-host>:<port>/<project>/<repository>:<tag>
   ```

   Do not put the `admin` password into a workload image pull Secret. For pipelines, use an account that has push permission on the target project.

### Cause 2

1. Open the pipeline stage that runs the Buildah task and check its settings: `skipPush` must be `false`, and the `source` workspace is bound to the build workspace.

2. Find the docker-credentials Secret of the Harbor integration for the target registry. In the UI it appears as `<integration-name> (harbor) - docker-credentials`; the Secret is named `docker-credentials-<suffix>`. Print its type and key names only:

   ```bash
   kubectl get secret -n <pipeline-namespace> | grep docker-credentials
   kubectl get secret -n <pipeline-namespace> <docker-credentials-secret> \
     -o go-template='{{.type}}{{"\n"}}{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
   ```

3. Bind the task's `registry-config` workspace to that Secret and run the pipeline again.

4. If the push still fails with `authentication required`, confirm that the account in the credential can push to the Harbor project (log in and push with it from the command line).

### Cause 3

1. Confirm a login with the credentials you intend to use:

   ```bash
   printf '%s' "$HARBOR_PASSWORD" | docker login <harbor-host>:<port> --username <username> --password-stdin
   ```

   A failed login means the credentials are still wrong; do not re-add the integration until it succeeds.

2. On the new global cluster, remove the Harbor integration and add it again with those credentials, from the same platform integration screen used to add it.

   > **Warning:** Impact: while the integration is removed, pipelines and projects that use it cannot reach Harbor. Precondition: the login in step 1 succeeded, and the integration settings (name, address, assigned projects) are recorded so they can be entered again. Rollback: add the integration again with the recorded settings.

## Diagnostic Steps

1. Separate a permission denial from a missing tag or a scheme error. An `http: server gave HTTP response to HTTPS client` or x509 error happens before the account check.

2. `insufficient_scope: authorization failed` on push with the platform-deployment user selects Cause 1. Check the user's actions in `auth.yaml` for `push`.

3. A Buildah task whose pull works and whose push fails with `authentication required` on the blob check selects Cause 2. Check the task's `registry-config` workspace binding first.

4. A new global cluster that cannot open an older Harbor selects Cause 3. Test the configured username and password with `docker login` before changing anything else.

5. A UI upload through a toolchain integration that fails with `unauthorized to access repository: ..., action: push` while the same account pushes from the command line is covered in [Harbor returns 401 because of time skew, the node auth container, Harbor Core, or a shared integration credential](Harbor_returns_401_because_of_time_skew_the_node_auth_container_Harbor_Core_or_a_shared_integration_credential.md).
