---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.2"
---

# ACP login shows an internal error from a bad Dex cache, or the standby global cluster cannot log in

## Issue

One of these is reported:

- The platform login page shows an internal error, and the Dex log repeats `ERROR error handling request {"error": "Internal error occurred: login error."}`. A variant shows `no matches for kind "Secret" in version "v1"` in the Dex log.
- On a primary/standby deployment the standby console does not log in. The browser developer tools show no error, and restarts of frontend, Apollo, and erebus do not help.

Related articles: "ACP login loops or returns to the login page because erebus or frontend is unhealthy" covers redirect loops. An `invalid authorization code` or `Unregistered redirect_uri` page is a different failure.

## Root Cause

### Cause 1: Dex answers login from erroneous cached content

The Dex log shows the captcha check passing (`check captcha verifyResult:{NeedReturnCaptcha:false IsLoginError:false CaptchaNotMatch:false CaptchaExpired:false}, err:<nil>`) and then, repeatedly:

```text
ERROR decrypt password The encryption timestamp has expired
ERROR error handling request {"error": "Internal error occurred: login error."}
ERROR Failed to get auth request: authrequests.dex.coreos.com "<id>" not found
Failed to get auth request: authrequests.dex.coreos.com "undefined" not found
WARN database inconsistent, refresh token missing: <token>
```

or, in the variant, for each login:

```text
error handling request {"error": "Internal error occurred: no matches for kind \"Secret\" in version \"v1\""}
decrypt password failed to login user: no matches for kind "Secret" in version "v1"
error handling request {"error": "Internal error occurred: login error."}
Failed to get auth request: authrequests.dex.coreos.com "<id>" not found
```

Dex holds erroneous cached content and serves it on the login request; the exact mechanism is not confirmed. Restarting the Dex Pod on the global cluster drops the cache, and login works again. No ConfigMap edit is needed. Periodic `garbage collection run, delete auth requests=...` lines are normal background output.

### Cause 2: the standby cluster token in `tke-cluster-global` does not match the current `k8sadmin` token

On the standby global cluster, `cpaas-system` holds several rotated `kubernetes.io/service-account-token` Secrets named `k8sadmin-<timestamp>`, labeled `cpaas.io/managed-by: k8sadmin-token-rotator` and annotated with `cpaas.io/cluster-token-expires-at`. The Secret `tke-cluster-global` in `cpaas-system` (label `platform.tkestack.io/clustercredential: cc-global`) still carries a much older creation time, and its token no longer matches the newest `k8sadmin-<timestamp>` token. A request to `/kubernetes/global/api/v1/namespaces` with the `tke-cluster-global` token returns 403 `forbidden: User "system:anonymous" cannot get path ...`, which shows that the token is not accepted as any identity. Copying the current `k8sadmin` token into `tke-cluster-global` restores login.

The Dex signing key `signingkeies.dex.coreos.com/openid-connect-keys` in `cpaas-system` has the same `signingKeyPub` and `verificationKeys` on both sides in this case, so the signing key is not the mismatch.

## Resolution

### Cause 1: Dex answers login from erroneous cached content

1. Confirm the Dex log lines. On 4.x, Dex runs inside the `apollo` Deployment in `cpaas-system`; on a cluster that still has a `dex` Deployment, read and restart that one instead.

   ```bash
   kubectl get deploy -n cpaas-system | grep -Ei 'apollo|dex'
   kubectl logs -n cpaas-system deploy/apollo --tail=300 | grep -E 'login error|encryption timestamp|no matches for kind|Failed to get auth request|refresh token missing'
   ```

2. Restart the workload that runs Dex.

   > **Warning:** Restarting Apollo (or Dex) interrupts logins until the Pod is Ready. Precondition: only when the page is an internal error and the Dex log shows the lines above. Rollback: wait for the rollout; the cache is discarded by design.

   ```bash
   kubectl -n cpaas-system rollout restart deploy/apollo
   kubectl -n cpaas-system rollout status deploy/apollo
   ```

3. Log in again, and keep watching the Dex log for a recurrence.

### Cause 2: the standby cluster token in `tke-cluster-global` does not match the current `k8sadmin` token

Apply this only when restarts of frontend, Apollo, and erebus did not help, the Dex public keys match on both sides, and the `tke-cluster-global` token is rejected while a current `k8sadmin-<timestamp>` token exists.

1. Compare the Secrets on the standby global cluster:

   ```bash
   kubectl get signingkeies.dex.coreos.com openid-connect-keys -n cpaas-system -o yaml
   kubectl -n cpaas-system get secret --sort-by=.metadata.creationTimestamp | grep k8sadmin
   kubectl -n cpaas-system get secret tke-cluster-global -o yaml | grep -E 'creationTimestamp|clustercredential'
   ```

2. Decode the `tke-cluster-global` token and test it against the platform proxy. List the keys first and use the key that holds the token:

   ```bash
   kubectl -n cpaas-system get secret tke-cluster-global -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}'
   TOKEN=$(kubectl -n cpaas-system get secret tke-cluster-global -o jsonpath='{.data.<token-key>}' | base64 -d)
   curl -k -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer ${TOKEN}" \
     https://<platform-address>/kubernetes/global/api/v1/namespaces
   ```

   A `403` that names `system:anonymous`, or a `401`, means the token is not valid. Compare it with the `token` key of the newest `k8sadmin-<timestamp>` Secret:

   ```bash
   kubectl -n cpaas-system get secret <newest-k8sadmin-secret> -o jsonpath='{.data.token}' | base64 -d; echo
   ```

3. Replace the token in `tke-cluster-global`.

   > **Warning:** Replacing the token in `tke-cluster-global` changes the credential that the platform uses for the global cluster; a wrong value keeps login broken. Precondition: only when the decoded tokens differ and the other checks above have ruled out erebus and the Dex signing key. Rollback: `kubectl apply -f /tmp/tke-cluster-global.bak.yaml`.

   ```bash
   kubectl -n cpaas-system get secret tke-cluster-global -o yaml > /tmp/tke-cluster-global.bak.yaml
   kubectl -n cpaas-system edit secret tke-cluster-global
   ```

   Set its token to the token from the newest `k8sadmin-<timestamp>` Secret, keeping the encoding the key already uses (base64 under `data`), and save.

4. Log in to the standby console again. The portal loads normally.

## Diagnostic Steps

```bash
kubectl get deploy,po -n cpaas-system | grep -Ei 'apollo|dex|frontend|erebus'
kubectl -n cpaas-system get secret | grep -E 'tke-cluster-global|k8sadmin'
kubectl get signingkeies.dex.coreos.com openid-connect-keys -n cpaas-system
```

- Login internal error, and the Dex log shows `Internal error occurred: login error.` with `The encryption timestamp has expired` and `Failed to get auth request`: Cause 1.
- Login internal error, and the Dex log shows `decrypt password failed to login user: no matches for kind "Secret" in version "v1"` after a passing captcha check: Cause 1.
- Standby login still fails after frontend, Apollo, and erebus restarts, and the `tke-cluster-global` token is rejected while a newer `k8sadmin-<timestamp>` exists: Cause 2.
