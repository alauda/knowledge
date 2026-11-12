---
kind:
  - Troubleshooting
products:
  - Alauda Application Services
ProductsVersion:
  - "4.3"
---

# Keycloak shows HTTPS required, the CR warns about hostname-strict, or login shows Invalid parameter redirect_uri

## Issue

A Keycloak 26.4 instance, managed by the Keycloak operator through a `Keycloak` custom resource, is running, but:

- The admin console is opened through a NodePort address over plain HTTP, and the login page (`realms/master`, client `security-admin-console`) shows `We are sorry...` `HTTPS required`.
- The `Keycloak` CR is `Ready` (`status: "True"`), but its `HasErrors` condition says `warning: You need to specify these fields as the first-class citizen of the CR: hostname-strict`.
- An application or connector that signs in through Keycloak gets the realm login page with `We are sorry...` `Invalid parameter: redirect_uri`.

## Root Cause

### Cause 1: `HTTPS required`: the realm's `sslRequired` setting rejects the plain HTTP request

Every Keycloak realm has an `sslRequired` setting with the values `none`, `external` (recommended for production), and `all`. With `external`, Keycloak requires HTTPS for requests from external addresses; with `all`, it requires HTTPS for every request. A request that the setting covers and that arrives over plain HTTP gets the `HTTPS required` page. Access through a NodePort over plain HTTP falls under that rule. Keycloak should be accessed over HTTPS.

### Cause 2: `hostname-strict` is passed as a generic option instead of a first-class CR field

The `hostname-strict` option was passed as a generic option of the instance (for example under `additionalOptions`) instead of through the dedicated fields of the CR. The operator expects hostname settings in `spec.hostname`; `spec.hostname.strict` is the entry point for `hostname-strict`. The CR stays `Ready`; the condition is a warning.

### Cause 3: `Invalid parameter: redirect_uri`: the client's redirect URI is not registered

Keycloak returns this page when it rejects the `redirect_uri` that the client sends in the authorization request. In standard Keycloak behavior that happens when the value is not covered by the **Valid redirect URIs** of the client named in `client_id`. Keycloak compares the URI exactly, except that a registered entry can end with a `*` wildcard.

## Resolution

### Cause 1: `HTTPS required`: the realm's `sslRequired` setting rejects the plain HTTP request

1. Access Keycloak over HTTPS, for example through an Ingress with TLS or the instance's HTTPS endpoint, instead of an HTTP NodePort.

2. For realms that you create, set `sslRequired` when the realm is imported through a `KeycloakRealmImport`:

   ```yaml
   apiVersion: k8s.keycloak.org/v2alpha1
   kind: KeycloakRealmImport
   metadata:
     name: <realm>-import
     namespace: <keycloak-namespace>
   spec:
     keycloakCRName: <keycloak-name>
     realm:
       realm: <realm>
       enabled: true
       sslRequired: external
   ```

   ```bash
   kubectl api-resources | grep -i keycloak
   kubectl apply -f <realm>-import.yaml
   kubectl -n <keycloak-namespace> get keycloakrealmimports
   ```

   Use the API version that `kubectl api-resources` lists for `KeycloakRealmImport` in your cluster. `external` is the value recommended for production.

### Cause 2: `hostname-strict` is passed as a generic option instead of a first-class CR field

Move the hostname options into `spec.hostname` and remove `hostname-strict` from the generic options.

> **Warning:** Changing the hostname settings restarts Keycloak and changes the URLs that Keycloak issues in redirects and tokens; clients that use a different address can stop working. Precondition: the external hostname that clients use is known and resolves to the Keycloak entry point. Save the CR first. Rollback: `kubectl apply -f keycloak-before.yaml`.

```bash
kubectl -n <keycloak-namespace> get keycloak <keycloak-name> -o yaml > keycloak-before.yaml
kubectl -n <keycloak-namespace> edit keycloak <keycloak-name>
```

```yaml
spec:
  hostname:
    hostname: <external-hostname>
    strict: true
    strictBackchannel: false   # depending on the scenario
```

After saving, check that the `HasErrors` warning is gone (Diagnostic Steps, step 1).

### Cause 3: `Invalid parameter: redirect_uri`: the client's redirect URI is not registered

1. Take the `client_id` and the decoded `redirect_uri` from the failing request and compare them with the client registered in the realm (Diagnostic Steps, step 4).

2. Make them match: either add the exact callback address that the application sends to the client's **Valid redirect URIs** in the realm, or change the application's callback address to one that is already registered.

   > **Warning:** Adding broad wildcard redirect URIs lets tokens be sent to any matching address. Precondition: register only the callback addresses that the application actually uses. Rollback: remove the added entry from the client.

3. Retry the sign-in.

## Diagnostic Steps

1. Read the CR conditions:

   ```bash
   kubectl -n <keycloak-namespace> get keycloak <keycloak-name> -o jsonpath='{range .status.conditions[*]}{.type}{"="}{.status}{" "}{.message}{"\n"}{end}'
   ```

   `HasErrors` with `first-class citizen of the CR: hostname-strict` is Cause 2.

2. Check how Keycloak is exposed and with which scheme the console is opened:

   ```bash
   kubectl -n <keycloak-namespace> get svc,ingress
   curl -sk -o /dev/null -w '%{http_code}\n' "https://<keycloak-address>/realms/master/protocol/openid-connect/auth?client_id=security-admin-console"
   ```

   A console opened through an `http://` NodePort address that shows `HTTPS required` is Cause 1.

3. Read the `sslRequired` value of a realm from inside the Keycloak Pod, after logging in with an admin account:

   ```bash
   kubectl -n <keycloak-namespace> exec -it <keycloak-pod> -- sh -c \
     '/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/kcadm.config --server http://localhost:8080 --realm master --user <admin-user> &&
      /opt/keycloak/bin/kcadm.sh get realms/<realm> --config /tmp/kcadm.config --fields sslRequired'
   ```

   If the instance serves only TLS, use `--server https://localhost:8443` with `--truststore` or the instance certificate instead.

4. For `Invalid parameter: redirect_uri`, copy the full URL of the failing login page from the browser address bar, decode it, and read the parameters:

   ```bash
   python3 -c 'import sys, urllib.parse as u; q = u.parse_qs(u.urlsplit(sys.argv[1]).query); print(q.get("client_id"), q.get("redirect_uri"))' '<failing-login-url>'
   ```

   Then list the redirect URIs registered for that client, with the same `kcadm.sh` session as in step 3:

   ```bash
   kubectl -n <keycloak-namespace> exec -it <keycloak-pod> -- \
     /opt/keycloak/bin/kcadm.sh get clients -r <realm> -q clientId=<client-id> --fields clientId,redirectUris --config /tmp/kcadm.config
   ```

   A `redirect_uri` that does not appear in `redirectUris` (and is not covered by a trailing `*` entry) is Cause 3.
