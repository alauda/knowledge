---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2.2"
  - "4.3"
---

# GitLab toolchain integration fails: token-gitlab not found, Internal error, projects API 500, or an extra bot project

## Issue

A GitLab toolchain integration of DevOps v3 is configured and does not work in pipelines. One of these symptoms is shown:

- Creating a CI pipeline says the GitLab token cannot be found, or updating a build returns `Secret "token-gitlab" not found` (`"reason": "NotFound"`, `"code": 404`), while the token page does not show the token and the toolchain integration page shows no error.
- A GitLab 17 (or later) integration reports an error and cannot be used.
- After the GitLab credential is updated, requests intermittently return `Internal error`.
- `GET /integrations/v1alpha1/namespaces/<ns>/integrations/<gitlab-integration>/projects/<ns>` returns `500 (Internal Server Error)` on every call.
- After GitLab projects are assigned, the code management list shows an extra entry named like `project_<id>_bot_<hash>` that does not exist as a project in GitLab.
- The integration instance shows an abnormal status with `gitlab returned error: GET .../api/v4/todos: 403 {message: 403 Forbidden - Your account has been blocked.}`.

These integrations are served by katanomi (`katanomi-api` and `katanomi-plugin` in `cpaas-system`). Each platform project is expected to have a namespace of the same name in the cluster. Related articles: "Harbor toolchain integration fails: images not selectable, katanomi-plugin timeout, or push asks for credentials" covers the Harbor integration.

## Root Cause

### Cause 1: `Secret "token-gitlab" not found` because the integration uses the external GitLab address

The GitLab integration was registered with an external network address, while the platform's internal authentication goes through the internal network address. The front end and the back end validate against different addresses, so pipeline creation cannot find the token and pipeline execution fails. The error body is `"status": "Failure"`, `"reason": "NotFound"`, `"details": {"name": "token-gitlab", "kind": "Secret"}`, `"code": 404`.

### Cause 2: GitLab 17 or later integration error because incremental job logging needs object storage

GitLab 17 and later turn on incremental job logging, which uploads archived job logs incrementally to object storage. When the GitLab instance has no object storage configured, the DevOps integration fails. Turning off **Turn on incremental logging** in GitLab fixes the integration.

### Cause 3: intermittent `Internal error` after the GitLab credential is updated

After the credential is updated, requests sometimes work and sometimes return `Internal error`. The error comes from GitLab, not from the platform. The old GitLab credentials left behind by the update cause it; deleting them recovers the integration.

### Cause 4: the integration projects API returns 500 because node DNS is broken

The DNS server configured on the node is malfunctioning. katanomi cannot resolve the GitLab address, and the projects API returns 500 on every call.

### Cause 5: an extra `project_<id>_bot_<hash>` entry with subtype `GitUser`

When an external GitLab is integrated with root permissions and projects are assigned, the code management list of the project can show an extra entry named like `project_62_bot_<hash>`, labelled as platform-assigned, whose code repository tab is empty. GitLab creates a bot user of that name when a project access token is created for project ID `<id>`. The platform syncs GitLab user (personal) namespaces as well as groups, so the bot user's personal namespace is synced as a tool project with `subType: GitUser`. The entry does not affect usage.

### Cause 6: `403 Forbidden - Your account has been blocked` because the credential password no longer matches the GitLab account

The password stored in the integration's credential no longer matches the GitLab account's current password, for example because the password was changed in GitLab. GitLab rejects the integration's API requests with `403 Forbidden - Your account has been blocked.`, and logging in to the GitLab web console with the same account and password returns `Invalid login or password.`

## Resolution

### Cause 1: `Secret "token-gitlab" not found` because the integration uses the external GitLab address

1. Compare the integration's address with the address the cluster uses to reach GitLab:

   ```bash
   kubectl get pods -A | grep katanomi-api
   kubectl -n <katanomi-namespace> exec deploy/<katanomi-api-deploy> -- getent hosts <gitlab-internal-host>
   ```

2. Create a new GitLab integration with the internal network address, assign it to the project, and point the pipeline at it. Keep the external-address integration until the new one works, then remove it.

3. Create the pipeline again. Pipeline creation finds the token and the pipeline runs.

### Cause 2: GitLab 17 or later integration error because incremental job logging needs object storage

> **Warning:** Turning the option off changes how every project on that GitLab stores CI job logs. Precondition: only when GitLab is 17 or later, has no object storage configured, and the integration fails. Note the current settings first. Rollback: turn the option on again after object storage is configured.

1. In GitLab, open **Admin Area > Settings > CI/CD** (`/admin/application_settings/ci_cd`) and expand **Job logs** (the last section).
2. Under **Incremental logging configuration**, clear **Turn on incremental logging** and save. GitLab answers "Application settings saved successfully".
3. Retry the integration. Its status in DevOps becomes healthy.

### Cause 3: intermittent `Internal error` after the GitLab credential is updated

1. Test the token that GitLab sees. `<decoded-token>` is the token saved in the integration's Secret, base64-decoded:

   ```bash
   curl -v "https://<gitlab-domain>/api/v4/version" -H "PRIVATE-TOKEN: <decoded-token>"
   ```

   A JSON version answer means the token and connectivity are fine.

2. Delete the old GitLab credentials that the update left behind.

   > **Warning:** Deleting a credential that a pipeline still references breaks that pipeline. Precondition: only when `Internal error` started after a credential update and the new credential works with the `curl` check. Confirm which pipelines use the old credential first. Rollback: recreate the credential with its previous token.

3. The error no longer returns.

### Cause 4: the integration projects API returns 500 because node DNS is broken

1. Resolve the GitLab host from the node and from a Pod:

   ```bash
   # on the node
   getent hosts <gitlab-host>
   cat /etc/resolv.conf
   # from a Pod
   kubectl -n <katanomi-namespace> exec deploy/<katanomi-api-deploy> -- getent hosts <gitlab-host>
   ```

   A failed or wrong answer is this cause.

2. Repair the DNS server that the node uses. As a temporary workaround, add a hosts entry for GitLab on the node (`192.0.2.20` stands for the real GitLab address).

   > **Warning:** A hosts entry pins the name on that node only and goes stale if GitLab moves. Precondition: only when the node's DNS server fails for the GitLab name. Back up `/etc/hosts`. Rollback: remove the line. Remove the entry after the DNS service is repaired.

   ```bash
   cp /etc/hosts /tmp/hosts.bak
   echo '192.0.2.20 <gitlab-host>' >> /etc/hosts
   ```

3. The projects API returns data instead of 500.

### Cause 5: an extra `project_<id>_bot_<hash>` entry with subtype `GitUser`

Confirm that the entry is a GitLab bot user, not a project:

```bash
kubectl get projects.meta.katanomi.dev -A -o yaml | grep -n -B4 -A8 '_bot_'
```

The object shows `subType: GitUser`. In GitLab, open `/projects/<id>` for the ID in the name; it redirects to the project whose access token created the bot. No action is required. The DevOps v4 GitLab integration, available from ACP 4.1, is the alternative when this listing is not wanted.

### Cause 6: `403 Forbidden - Your account has been blocked` because the credential password no longer matches the GitLab account

1. Log in to the GitLab web console with the account and password stored in the integration's credential. `Invalid login or password.` confirms the mismatch.
2. Find out the account's current password from its owner, or reset it in GitLab.
3. Update the credential used by the integration with the current password, then check the integration status again. It returns to normal once GitLab accepts the credential.
4. If GitLab still answers `Your account has been blocked`, a GitLab administrator checks the account in **Admin Area > Users** and unblocks it.

## Diagnostic Steps

```bash
kubectl get pods -A | grep -E 'katanomi-api|katanomi-plugin'
kubectl -n <katanomi-namespace> logs deploy/<katanomi-api-deploy> --tail=100 | grep -Ei 'gitlab|timeout|500'
```

Capture the failing request in the browser developer tools; the path and the status code identify the cause.

- Token not found at pipeline creation, and the integration uses an external address: Cause 1.
- GitLab 17 or later without object storage: Cause 2.
- Intermittent `Internal error` after a credential update: Cause 3.
- `500` on the integration projects API, and DNS resolution of the GitLab host fails on the node: Cause 4.
- An extra `project_<id>_bot_<hash>` tool project with subtype `GitUser`: Cause 5.
- `403 Forbidden - Your account has been blocked` from the integration, and the same account gets `Invalid login or password.` on the GitLab login page: Cause 6.

When katanomi logs domain resolution timeouts for a platform Service name such as `katanomi-plugin.cpaas-system`, rather than for the GitLab host, the fault is cluster DNS, not GitLab. Check the node `/etc/resolv.conf` for a `search` line with site domains, and the CoreDNS log for that Service name being forwarded upstream:

```bash
kubectl get ep -A | grep katanomi
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=200 | grep -iE 'katanomi|i/o timeout'
cat /etc/resolv.conf
```
