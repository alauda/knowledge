---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.10"
  - "3.10.2"
  - "3.16"
  - "4.0"
  - "4.2"
  - "4.2.1"
  - "4.3"
  - "4.3.2"
  - "4.3.3"
---

# Dex login options, CORS, SSO user identity, and the Dex deployment layout on ACP

## Issue

One of these is reported about the platform Dex:

- After SSO authentication completes and the user selects the platform, the browser stops on the ACP login page and the user has to click the login button again. Or a security drill needs username/password login turned off without removing OIDC.
- A security scan reports that the Dex SSO API reflects any `Origin`: `POST /dex/api/v1/authorize/sso` with `Origin: https://<untrusted-site>` returns `Access-Control-Allow-Origin: https://<untrusted-site>` and `Access-Control-Allow-Credentials: true`.
- A custom tool reached through the platform SSO redirect can see that a user arrived, but cannot tell which user it was.
- After a fresh install, or after the global cluster moves from 3.16 to 4.0, there is no `dex` Deployment in `cpaas-system`.

The Dex configuration is held in the ConfigMap `dex-configmap` in `cpaas-system` on the global cluster. Related articles: "OIDC clients and pages are sent to the wrong Dex issuer address on ACP" and "Dex update fails on ACP 3.10 or account login returns 401 after the Dex permanent token changes".

## Root Cause

### Cause 1: SSO users must click the login button again because local login is still enabled

Local user authentication (the Dex password database) and OIDC authentication are both enabled, so the login page offers two methods and waits for a choice. Setting `enablePasswordDB` to `false` in `dex-configmap` turns local user authentication off and leaves OIDC as the only login method, which gives direct access.

### Cause 2: the Dex SSO API reflects any Origin because `allowedOrigins` is not set

`allowedOrigins` is not configured under the `web` section of the Dex configuration in `dex-configmap`, so the request `Origin` is echoed back. Adding `allowedOrigins` with the platform's real access URLs restricts CORS to those addresses.

### Cause 3: a custom tool behind SSO cannot see the current user

A tool that calls Harbor (or a similar API) after the platform SSO redirect has no check of the user who clicked it, so one user can act on another user's project. With the UI redirect kept, the page carries `id_token` only when the frontend is started with `--enable-redirect-with-token=true`. Integrating the tool as an OIDC client of the platform avoids depending on that redirect flag.

### Cause 4: ACP 4.x has no standalone Dex Deployment

On 3.x, Dex runs as its own Pod. From 4.0 onward, Dex runs inside the `apollo` Deployment in `cpaas-system`. Nothing failed to install, and no separate Dex chart or plugin is required. OIDC is still configured in `dex-configmap`.

## Resolution

### Cause 1: SSO users must click the login button again because local login is still enabled

1. On the global cluster, find the key in the Dex configuration:

   ```bash
   kubectl -n cpaas-system get cm dex-configmap -o yaml | grep -n enablePasswordDB
   ```

2. Set `enablePasswordDB: false`.

   > **Warning:** `enablePasswordDB: false` removes local account/password login from the platform login page, including local accounts such as `admin`; only OIDC users can log in afterwards. Restarting Dex briefly interrupts logins. Precondition: only when OIDC login already works end to end and at least one platform administrator can log in through OIDC. Back up the ConfigMap first. Rollback: `kubectl apply -f /tmp/dex-configmap.bak.yaml` and restart Dex again.

   ```bash
   kubectl -n cpaas-system get cm dex-configmap -o yaml > /tmp/dex-configmap.bak.yaml
   kubectl -n cpaas-system edit cm dex-configmap
   ```

   Set `enablePasswordDB: false` in the Dex configuration held by the ConfigMap, keeping the existing indentation.

3. Upstream Dex reads its configuration at startup, so if the login page still offers local login after the edit, restart the workload that runs Dex (`apollo` on 4.x, the `dex` Deployment on 3.x):

   ```bash
   kubectl -n cpaas-system get deploy | grep -Ei 'apollo|dex'
   kubectl -n cpaas-system rollout restart deploy/<dex-or-apollo-deployment>
   kubectl -n cpaas-system rollout status deploy/<dex-or-apollo-deployment>
   ```

4. Check `enablePasswordDB` again after each platform upgrade.

Editing `dex-configmap` creates an `rpch` object that stores the override. To turn password login back on, delete that `rpch`.

> **Warning:** Deleting the `rpch` removes the stored `dex-configmap` override, including `enablePasswordDB: false`. Precondition: only when password login should return and this `rpch` is the object the edit created. Rollback: edit `dex-configmap` again and set `enablePasswordDB: false`, which creates a new `rpch`.

```bash
kubectl get rpch -A
kubectl get rpch -n <namespace> <rpch-name> -o yaml > /tmp/rpch.bak.yaml
kubectl delete rpch -n <namespace> <rpch-name>
```

When a drill requires the whole login page to be unreachable, scaling the `frontend` Deployment to zero does that; the page then returns an HTTP 500-class error, and OIDC login is down as well.

> **Warning:** `frontend` at 0 replicas removes the console until it is scaled back; business workloads keep running. Precondition: only when the drill requires the login page to be unreachable and a maintenance window covers the outage. Record the current replica count. Rollback: scale back to the recorded count.

```bash
kubectl -n cpaas-system get deploy frontend -o jsonpath='{.spec.replicas}{"\n"}'
kubectl scale deployment -n cpaas-system frontend --replicas=0
# restore:
kubectl scale deployment -n cpaas-system frontend --replicas=<previous-count>
```

### Cause 2: the Dex SSO API reflects any Origin because `allowedOrigins` is not set

1. Reproduce the finding:

   ```bash
   curl -k -sS -o /dev/null -D - -X POST -H 'Origin: https://untrusted.example.com' \
     https://<platform-address>/dex/api/v1/authorize/sso | grep -i '^access-control-allow'
   ```

2. Add `allowedOrigins` under the existing `web` section of the Dex configuration.

   > **Warning:** Once `allowedOrigins` is set, browsers on origins that are not in the list lose cross-origin access to Dex; an access address left out of the list can break login pages served from that address. Precondition: only when the response above echoes the untrusted Origin and you have the complete list of platform access addresses, including additional access addresses. Back up the ConfigMap first. Rollback: `kubectl apply -f /tmp/dex-configmap.bak.yaml` and restart Dex.

   ```bash
   kubectl -n cpaas-system get cm dex-configmap -o yaml > /tmp/dex-configmap.bak.yaml
   kubectl -n cpaas-system edit cm dex-configmap
   ```

   ```yaml
   web:
     allowedOrigins:
       - https://<platform-address>
       - https://<additional-platform-address>
   ```

   Keep the other keys already under `web`.

3. Restart Dex as in Cause 1 if the response does not change, then run the `curl` again. The untrusted Origin no longer appears in `Access-Control-Allow-Origin`.

### Cause 3: a custom tool behind SSO cannot see the current user

Register the tool as an OIDC client of the platform, with the platform as the OIDC server, and have the tool check the user from the token it receives. Alternatively, start the frontend with `--enable-redirect-with-token=true` so that the redirect carries `id_token`, which contains part of the logged-in user's identity, and use it for the tool's own permission check. The OIDC client integration is the recommended option because it does not depend on the redirect flag.

### Cause 4: ACP 4.x has no standalone Dex Deployment

Read the embedded configuration and follow the product OIDC documentation:

```bash
kubectl get deploy -n cpaas-system apollo -o yaml | grep dex
kubectl get configmap dex-configmap -n cpaas-system -o yaml
```

The absence of a `dex` Deployment on 4.0 and later is expected. On 3.x, a missing Dex Deployment is not this cause.

## Diagnostic Steps

```bash
kubectl -n cpaas-system get cm dex-configmap -o yaml | grep -n -E 'enablePasswordDB|allowedOrigins|issuer'
kubectl -n cpaas-system get deploy | grep -Ei 'apollo|dex|frontend'
kubectl get rpch -A
```

- After SSO the ACP login page asks for another click, and `enablePasswordDB` is not `false`: Cause 1.
- Password login must be disabled for a drill, or an `rpch` was left behind by a `dex-configmap` edit: Cause 1.
- `Access-Control-Allow-Origin` echoes an arbitrary Origin on `/dex/api/v1/authorize/sso` with credentials allowed, and `web.allowedOrigins` is absent: Cause 2.
- A custom UI behind SSO has no user identity: Cause 3.
- No `dex` Deployment in `cpaas-system` on 4.x while `apollo` is running: Cause 4.
