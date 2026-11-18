---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
---

# kubectl returns the server has asked for the client to provide credentials after ac login, or ac login fails, on ACP

## Issue

One of the following happens with the `ac` CLI or with platform API tokens:

- The day after `ac login`, `kubectl` fails while the console still works:

  ```text
  error: You must be logged in to the server (the server has asked for the client to provide credentials)
  ```

- `ac login` returns HTTP 400, while `curl` against the platform address returns 302.
- The question is whether `ac login --idp` works with an Azure AD account.
- On ACP 4.2, a user token is needed from the command line or an API instead of the console.

Related articles: "Forgotten local admin password on ACP: reset the password hash, set a chosen password, and password policy limits" covers local passwords. "ACP console session survives cookie deletion or a browser close, or the login page shows the previous account" covers browser sessions.

## Root Cause

### Cause 1: the kubeconfig written by `ac login` carries a one-day token

`ac login`, as described in the Configure ACP CLI documentation, writes a kubeconfig whose token is valid for one day. After it expires, every `kubectl` call is rejected with the credentials error, while the console session is unaffected.

### Cause 2: the installed `ac` binary is too old

An old `ac` build sends a login request the platform rejects with 400, although the platform itself answers (`curl` returns 302). Reinstalling `ac` makes login succeed.

### Cause 3: `ac login --idp` supports Windows AD, not Azure AD

`ac login --idp` works with a Windows AD identity provider. Azure AD is not supported by that command.

### Cause 4: on ACP 4.2 a user token is created with an API call and shown only once

On ACP 4.2 a user token can be created with `POST /api/v1/users/{userId}/tokens`, authenticated, with a body that includes the token name and the expiration time. The response contains the token string, which cannot be read again after creation.

## Resolution

### Cause 1: the kubeconfig written by `ac login` carries a one-day token

1. Create a long-lived token on the user's personal information page in the console.
2. In the kubeconfig written by `ac login`, replace the token of that user:

   ```yaml
   users:
     - name: <user-name>
       user:
         token: <long-lived-token>
   ```

3. Confirm that a call succeeds:

   ```bash
   kubectl get --raw=/readyz
   ```

   It should print `ok` instead of the credentials error.

### Cause 2: the installed `ac` binary is too old

1. Compare the CLI and the platform response:

   ```bash
   ac version
   curl -k -sS -o /dev/null -w '%{http_code}\n' https://<platform-address>/
   ```

   A 302 from `curl` with a 400 from `ac login` matches this cause.

2. Download and install `ac` again as described in the Configure ACP CLI documentation for this platform version, then log in again.

### Cause 3: `ac login --idp` supports Windows AD, not Azure AD

Use `ac login --idp` for Windows AD identity providers. Azure AD users log in through the console.

### Cause 4: on ACP 4.2 a user token is created with an API call and shown only once

Send an authenticated `POST` to `/api/v1/users/<userId>/tokens` with a JSON body that contains the token name and the expiration time. Take the exact field names from the API reference of your platform version.

```bash
curl -k -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '<body with the token name and the expiration time>' \
  "https://<platform-address>/api/v1/users/<userId>/tokens"
```

Copy the token string out of the response and store it securely; it cannot be retrieved later. Put it in a kubeconfig as in Cause 1 if `kubectl` should use it.

## Diagnostic Steps

```bash
kubectl config view --minify -o jsonpath='{.users[0].name}{"\n"}'
kubectl get --raw=/readyz
ac version
```

| What you see | Cause |
| --- | --- |
| `kubectl` credentials error about a day after `ac login`, console still works | 1 |
| `ac login` returns 400, `curl` to the platform returns 302 | 2 |
| Azure AD account cannot log in with `ac login --idp` | 3 |
| A user token is needed without the console on ACP 4.2 | 4 |
| The credentials error comes from a node's `/root/.kube/config` or `admin.conf`, not from `ac login` | Not this article |
