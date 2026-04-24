---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A user cannot sign in to the Argo CD web console. The browser is redirected back to a page showing one of these errors:

```text
Invalid redirect URL: the protocol and host (including port) must match
and the path must be within allowed URLs if provided
```

or

```text
Failed to query provider "https://<external-host>/api/dex":
oidc: issuer did not match the issuer returned by provider,
expected "https://<external-host>/api/dex"
got "https://argocd-server/api/dex"
```

The SSO flow never completes and the user never reaches the dashboard.

## Root Cause

The OIDC/Dex connector running inside Argo CD has a `redirectURI` that is not the URL the browser actually visits. At login, Dex builds the callback from the request it received (the external host served by the Ingress) and compares it to the `redirectURI` registered on the connector. If the two do not match exactly on scheme + host + port, the provider rejects the redirect. Similarly, the issuer advertised by Dex must match the external URL Argo CD knows itself by (`server.host`); if Argo CD was started with the in-cluster Service name but the browser hit it through an external Ingress host, the issuer check fails.

## Resolution

Make three values agree on the external host:

1. `ArgoCD.spec.server.host` — the public host Argo CD tells clients it lives at.
2. The host of the Ingress that fronts `argocd-server`.
3. `redirectURI` in the Dex connector (inside `ArgoCD.spec.sso.dex.config`).

Find the external host from the Ingress that exposes `argocd-server`:

```bash
kubectl -n <argocd-namespace> get ingress
```

Take the host value from the rule that points at the `argocd-server` backend — call it `$ARGOCD_HOST`.

Edit the `ArgoCD` custom resource so both `server.host` and `sso.dex.config.connectors[].redirectURI` use that host. Keep every other field in the Dex connector intact; change only the host portion of `redirectURI`:

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: <argocd-instance>
  namespace: <argocd-namespace>
spec:
  server:
    # External host must match the Ingress host
    host: <ARGOCD_HOST>
  sso:
    provider: dex
    dex:
      config: |
        connectors:
        - config:
            clientID: <oidc-client-id>
            clientSecret: $oidc.dex.clientSecret
            groups: []
            insecureCA: true
            issuer: https://kubernetes.default.svc
            redirectURI: https://<ARGOCD_HOST>/api/dex/callback
          id: <connector-id>
          name: <connector-display-name>
          type: <connector-type>
```

Apply the change and wait for the Argo CD operator to roll the new configuration into `argocd-server` and the Dex sidecar. After the pods restart, retry the login in a fresh browser window (or clear the stored OIDC session) — the callback will now match.

If the deployment is driven by plain manifests instead of the `ArgoCD` CR, the same rule applies: the `redirectURI` embedded in the `argocd-cm` ConfigMap (under `dex.config`) must match `url:` in the same ConfigMap and must match the host on the Ingress.

## Diagnostic Steps

Confirm the Ingress host that the browser actually hits:

```bash
kubectl -n <argocd-namespace> get ingress -o wide
```

Confirm the `ArgoCD` CR's `server.host` and `redirectURI` agree with that host:

```bash
kubectl -n <argocd-namespace> get argocd <argocd-instance> -o yaml \
  | grep -E 'host:|redirectURI:'
```

Inspect the issuer returned by the Dex endpoint — this is the value Argo CD compares against `server.host`:

```bash
curl -sk https://<ARGOCD_HOST>/api/dex/.well-known/openid-configuration \
  | jq .issuer
```

If the issuer still comes back as `https://argocd-server/...` after the edit, the operator has not rolled the new config yet — check the status of the `ArgoCD` CR and restart `argocd-server` and the Dex deployment/pod to force a fresh load. If the issuer matches but the browser still shows `Invalid redirect URL`, the external identity provider (the upstream OIDC) may also be holding a stale callback URL on its side — register the new `https://<ARGOCD_HOST>/api/dex/callback` there too.
