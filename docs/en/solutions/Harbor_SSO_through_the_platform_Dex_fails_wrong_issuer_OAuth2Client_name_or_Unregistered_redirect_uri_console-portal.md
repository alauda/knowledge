---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.1.7"
  - "4.2"
  - "4.3"
  - "4.3.2"
---

# Harbor SSO through the platform Dex fails: wrong issuer, OAuth2Client name, or Unregistered redirect_uri console-portal

## Issue

Single sign-on from Alauda Build of Harbor through the platform Dex does not work. One of these symptoms is shown:

- SSO was turned on in the Harbor instance and has no effect, or an already installed Harbor should be switched to SSO.
- The Harbor login page shows the OIDC button, and clicking it opens the ACP login page even though the user is already logged in to ACP, so Harbor single sign-on never completes.
- After a platform upgrade, clicking the OIDC login on Harbor ends on `The authorization code is invalid`. In the browser developer tools the Dex `authorize` request returns HTTP 400 with:

  ```text
  status: Failure
  reason: "ErrReqInvalid"
  message: "Unregistered redirect_uri (\"https://<harbor-address>/console-portal/\")"
  ```

  The `authorize` URL carries `client_id=alauda-auth` (the ACP console client) and a callback under `/console-portal/` on the Harbor host, not the Harbor client id and `/c/oidc/callback`.

Related articles: "GitLab or Argo CD login through the platform Dex fails: host required, certificate verify, invalid_client, LDAP groups" and "OIDC clients and pages are sent to the wrong Dex issuer address on ACP".

## Root Cause

### Cause 1: Harbor's issuer is the Harbor address plus `/dex`

The issuer in the Harbor SSO settings was set to the Harbor access address plus `/dex`. The issuer must be the platform access address plus `/dex`, whether or not platform SSO is otherwise used by end users.

### Cause 2: OIDC is not enabled on an already installed Harbor

A Harbor that is already deployed can be switched to SSO without a reinstall. OIDC is enabled with `helmValues.oidc.enable: true` on the instance, and the remaining OIDC fields follow the Configure SSO section of the Alauda Build of Harbor deployment documentation, with the issuer from Cause 1.

### Cause 3: the Harbor `OAuth2Client` name is not derived from its id, or its redirect is mis-indented

The Dex `OAuth2Client` for Harbor (`apiVersion: dex.coreos.com/v1`, namespace `cpaas-system`) must have a `metadata.name` computed from its `id`. In upstream Dex Kubernetes storage, the object name is the lowercase base32 encoding of the client id bytes followed by the FNV-64 hash of empty input, with `=` padding removed; Dex finds a client by computing that name from `client_id`. For `id: harbor-dex` the name is `nbqxeytpoiwwizlyzpzjzzeeeirsk`. A manifest copied from another client without recomputing the name (for example the name for `gitlab-dex`, `m5uxi3dbmiwwizlyzpzjzzeeeirsk`) is not found by Dex. A `redirectURIs` entry for `/c/oidc/callback` that is indented incorrectly is not a valid list item either. Either error sends the browser to the ACP login page instead of completing Harbor SSO.

### Cause 4: the Harbor domain reaches the platform access address, so the login runs the console flow

The login is not running Harbor's OIDC flow at all. Requests for the Harbor domain reach the platform access address instead of the Ingress that serves Harbor, so the platform answers them, and the browser goes into the ACP console login with `client_id=alauda-auth` and a `/console-portal/` callback on the Harbor host. That redirect is not registered on `alauda-auth`, so Dex rejects it with `Unregistered redirect_uri`. The Harbor OIDC values, the Harbor `OAuth2Client` (with `redirectURIs` of `<harbor-address>/c/oidc/callback`), and the Harbor Ingress can all be correct. Correcting the address that the Harbor domain is forwarded to restores Harbor SSO; nothing in Harbor, its `OAuth2Client`, or `alauda-auth` needs to change.

## Resolution

### Cause 1: Harbor's issuer is the Harbor address plus `/dex`

Set the Harbor SSO issuer to `https://<platform-address>/dex`, not the Harbor address with `/dex` appended. Save the instance and retry the OIDC login.

### Cause 2: OIDC is not enabled on an already installed Harbor

Enable OIDC on the Harbor instance values:

```yaml
helmValues:
  oidc:
    enable: true
```

Then complete the issuer, client id, client secret, and redirect URLs from the Configure SSO section of the Alauda Build of Harbor documentation, using the issuer from Cause 1.

### Cause 3: the Harbor `OAuth2Client` name is not derived from its id, or its redirect is mis-indented

1. List the clients with their ids and compute the name the Harbor client must have:

   ```bash
   kubectl get oauth2clients.dex.coreos.com -n cpaas-system -o custom-columns=NAME:.metadata.name,ID:.id
   python3 -c 'import base64,struct,sys; print(base64.b32encode(sys.argv[1].encode()+struct.pack(">Q",0xcbf29ce484222325)).decode().lower().rstrip("="))' harbor-dex
   ```

   Use the id that your Harbor configuration sends as its client id. This cause applies only when the `NAME` of the Harbor client differs from the computed value, or its `redirectURIs` is not a proper YAML list.

2. Build the corrected object from the existing one:

   ```bash
   kubectl get oauth2clients.dex.coreos.com -n cpaas-system <current-name> -o yaml > /tmp/harbor-oauth2client.bak.yaml
   cp /tmp/harbor-oauth2client.bak.yaml /tmp/harbor-oauth2client.yaml
   vi /tmp/harbor-oauth2client.yaml
   ```

   In the copy, set `metadata.name` to the computed value, delete `metadata.resourceVersion`, `metadata.uid`, and `metadata.creationTimestamp`, and keep `id`, `name`, the secret, and every other field. Write the Harbor callback as a list item:

   ```yaml
   redirectURIs:
     - https://<harbor-address>/c/oidc/callback
   ```

3. Replace the client.

   > **Warning:** Deleting the old `OAuth2Client` removes that client from Dex; anything that logs in through it fails until the new object exists. Precondition: only when the name check above confirms this cause and the backup is saved. Rollback: `kubectl delete -f /tmp/harbor-oauth2client.yaml`, then apply the backup after removing `resourceVersion` and `uid` from it.

   ```bash
   kubectl apply -f /tmp/harbor-oauth2client.yaml
   kubectl delete oauth2clients.dex.coreos.com -n cpaas-system <current-name>
   kubectl get oauth2clients.dex.coreos.com -n cpaas-system -o custom-columns=NAME:.metadata.name,ID:.id
   ```

4. Make Harbor pick up the client again: remove the OIDC section from the Harbor instance, wait until the instance is ready, and add the same OIDC section back.

   > **Warning:** Each save of the Harbor instance makes the operator reconcile Harbor; OIDC login is off while the section is removed, and Harbor can be briefly unavailable. Precondition: only after the corrected `OAuth2Client` exists, with the instance YAML backed up. Rollback: `kubectl apply -f /tmp/harbor-instance.bak.yaml`.

   ```bash
   kubectl api-resources | grep -i harbor
   kubectl get <harbor-kind> -n <harbor-namespace> <instance-name> -o yaml > /tmp/harbor-instance.bak.yaml
   kubectl edit <harbor-kind> -n <harbor-namespace> <instance-name>
   ```

5. Click the OIDC button on the Harbor login page. The Harbor `oidc-onboard` page opens with the dialog "You must create a Harbor username the first time when authenticating via a third party(OIDC)". Set the Harbor username there once.

### Cause 4: the Harbor domain reaches the platform access address, so the login runs the console flow

Apply this only when the failing `authorize` request carries `client_id=alauda-auth` and a `redirect_uri` under `/console-portal/` on the Harbor host (see Diagnostic Steps).

> **Warning:** Changing where the Harbor domain is forwarded moves every Harbor client (browsers, `docker login`, image pulls from nodes) to the new target; a wrong target makes Harbor unreachable. Precondition: only when Diagnostic Steps confirm that the Harbor domain reaches the platform access address and that the Harbor Ingress address serves the Harbor portal. Plan a maintenance window if image pulls depend on Harbor. Record the current value first. Rollback: restore the previous forwarding address.

1. Change whichever of the DNS record, external load balancer, or hosts entry sends the Harbor domain to the platform access address, so that it points at the Harbor Ingress address (`status.loadBalancer.ingress` of the Harbor Ingress).

2. Confirm the result and retry Harbor's OIDC button:

   ```bash
   getent hosts <harbor-domain>
   curl -k -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<harbor-domain>/
   ```

   The request returns the Harbor portal and does not redirect to the ACP login. Harbor SSO works again.

## Diagnostic Steps

1. Capture the failing `authorize` request in the browser developer tools and note `client_id` and `redirect_uri`. `client_id=alauda-auth` with `https://<harbor-address>/console-portal/` is Cause 4. The Harbor client id with `/c/oidc/callback` points to Causes 1 to 3.

2. Check the issuer and client settings of the Harbor instance and the Harbor client in Dex:

   ```bash
   curl -k -sS "https://<platform-address>/dex/.well-known/openid-configuration"
   kubectl api-resources | grep -i harbor
   kubectl get <harbor-kind> -n <harbor-namespace> <instance-name> -o yaml | grep -n -A8 -i oidc
   kubectl get oauth2clients.dex.coreos.com -n cpaas-system -o custom-columns=NAME:.metadata.name,ID:.id
   ```

   - The issuer ends in the Harbor host plus `/dex`: Cause 1. No OIDC values at all: Cause 2.
   - The Harbor client's name is not the encoding of its id (for `harbor-dex`, `nbqxeytpoiwwizlyzpzjzzeeeirsk`), or its `redirectURIs` is mis-indented: Cause 3.

3. For Cause 4, compare where the Harbor domain resolves with the address the Harbor Ingress is served on, then compare the two paths without changing anything:

   ```bash
   kubectl get ingress -n <harbor-namespace> -o wide
   kubectl get ingress -n <harbor-namespace> <harbor-ingress> -o jsonpath='{.status.loadBalancer.ingress}{"\n"}'
   getent hosts <harbor-domain>
   curl -k -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<harbor-domain>/
   curl -k -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
     --resolve <harbor-domain>:443:<ingress-lb-ip> https://<harbor-domain>/
   ```

   The domain resolving to the platform access address instead of the Ingress address, the first request redirecting toward the ACP login, and the second request returning the Harbor portal confirm Cause 4. A successful ping to the domain does not rule it out.
