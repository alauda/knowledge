---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Kiali login fails with HTTP 504 when egress restrictions block the auth provider
## Issue

Loading the Kiali console returns `HTTP 504 Gateway Timeout` after the user authenticates, and login fails for every user. The Kiali pod log records timeouts when exchanging the auth code for a token:

```text
ERR Authentication rejected: Unable to exchange the code for a token: could not exchange the code for a token: Post "<auth-token-endpoint>": context canceled
```

Kiali itself runs (HTTP /healthz returns 200), the auth-server pods are healthy, and reaching the auth endpoint from outside the cluster works.

## Root Cause

An `EgressFirewall` (or equivalent egress `NetworkPolicy`) defined in the Kiali namespace was blocking outbound traffic from the Kiali pod to the platform's auth-server endpoint. Kiali completes the user-redirect leg of the OAuth/OIDC flow successfully — that traffic reaches Kiali via ingress — but the **server-side** code that exchanges the authorisation code for a token has to dial out to the auth-server's token endpoint. When egress to that host is denied, the dial blocks until the request context expires, Kiali surfaces a 5xx, and the proxying gateway turns it into a 504 for the browser.

This is a generic "auth-flow needs egress" pattern: any in-cluster OIDC/OAuth client whose namespace has restrictive egress rules will fail in the same way.

## Resolution

1. Identify egress restrictions in the Kiali namespace:

   ```bash
   kubectl get egressfirewall -n <kiali-ns>
   kubectl get networkpolicy -n <kiali-ns>
   ```

2. Read the existing rules and confirm whether the auth-server endpoint and the API server endpoint are reachable. The Kiali pod needs to reach:

   - The cluster's auth-server token endpoint (the host that issues OIDC/OAuth tokens for in-cluster clients).
   - The Kubernetes API server (Kiali also reads cluster state through it).
   - Any external metric endpoint (Prometheus / Tempo) configured in Kiali.

3. Update the egress rules to allow the required destinations. Example with an `EgressFirewall`-style policy that denies most egress but allows the auth and API hosts:

   ```yaml
   apiVersion: k8s.ovn.org/v1
   kind: EgressFirewall
   metadata:
     name: default
     namespace: <kiali-ns>
   spec:
     egress:
       - type: Allow
         to:
           dnsName: <auth-server-host>
       - type: Allow
         to:
           cidrSelector: <api-server-vip>/32
       - type: Deny
         to:
           cidrSelector: 0.0.0.0/0
   ```

   If a `NetworkPolicy` is in use, allow egress to those hosts via `egress.to` blocks (CIDRs are required because `NetworkPolicy` does not resolve DNS).

4. Verify connectivity from the Kiali pod after the rule lands:

   ```bash
   kubectl exec -n <kiali-ns> deploy/kiali -- \
     curl -sS -m 5 -o /dev/null -w '%{http_code}\n' <auth-server-token-url>
   ```

   A response of `200`, `400` or `405` indicates reachability (the endpoint expects a POST). A timeout means the egress rule still blocks the destination.

5. Reload the Kiali login flow and confirm authentication succeeds.

## Diagnostic Steps

1. Verify the Kiali pod log around the failed login:

   ```bash
   kubectl logs -n <kiali-ns> deploy/kiali --tail=200 | grep -i auth
   ```

2. Confirm the auth-server pods are healthy:

   ```bash
   kubectl get pods -n <auth-server-ns>
   ```

3. Test connectivity from the Kiali pod to the token endpoint to distinguish between an egress block (timeout) and a DNS resolution error (`could not resolve host`):

   ```bash
   kubectl exec -n <kiali-ns> deploy/kiali -- \
     getent hosts <auth-server-host>
   kubectl exec -n <kiali-ns> deploy/kiali -- \
     curl -kvv -m 5 <auth-server-token-url>
   ```

4. Inspect the namespace-level egress configuration:

   ```bash
   kubectl get egressfirewall -n <kiali-ns> -o yaml
   kubectl get networkpolicy -n <kiali-ns> -o yaml
   ```
