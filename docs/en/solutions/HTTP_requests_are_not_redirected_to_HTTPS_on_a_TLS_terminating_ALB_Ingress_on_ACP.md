---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# HTTP requests are not redirected to HTTPS on a TLS-terminating ALB Ingress on ACP

## Issue

On Alauda Container Platform, an Ingress that terminates TLS is reached over plain HTTP and the request is served (or refused) on the insecure port instead of being sent to the secure HTTPS URL. This surprises operators who expect a TLS-terminating front end to move clients onto HTTPS on its own. On the ALB data plane (ALB v4.3.1, image `registry.alauda.cn:60080/acp/alb2:v4.3.1`, Kubernetes server v1.34.5), a TLS-terminating Ingress does not redirect plain HTTP requests to HTTPS unless an HTTP-to-HTTPS redirect has been configured explicitly; there is no redirect by default.

## Root Cause

The redirect is opt-in rather than on by default. Across the Ingress objects fronted by the `global-alb2` instance in the `cpaas-system` namespace, only the one Ingress that carries an explicit redirect annotation issues a redirect; the rest serve their insecure HTTP port with no automatic redirect to HTTPS. Because the behavior is annotation-driven, an Ingress that has not been annotated to redirect simply answers on the insecure port, which is exactly the observed symptom.

## Resolution

Configure a redirect on the TLS-terminating Ingress whose target is the HTTPS URL. The ALB honors nginx-style Ingress annotations, so the redirect is requested by adding the corresponding redirect annotation (`nginx.ingress.kubernetes.io/temporal-redirect`) to the Ingress that terminates TLS. The annotation does not by itself force the HTTPS scheme; it issues a 302 to whatever redirect target is configured for it, so for an HTTP-to-HTTPS redirect the configured target must be the secure HTTPS URL (or endpoint) the client should be sent to.

For the redirect to be issued at all, the insecure HTTP port must be served and reachable by clients: the redirect response is materialized on the ALB's insecure HTTP frontend (port 80), so a client must be able to reach that port for the redirect to be returned. If the insecure port is closed or unreachable, the redirect cannot be delivered.

Once the redirect is configured, a request to the plain-HTTP URL no longer returns the resource content; instead the insecure frontend answers with an HTTP 302 (a 30x redirect) pointing the client at the secure HTTPS URL.

## Diagnostic Steps

Confirm whether the plain-HTTP URL is being redirected by requesting it with `curl` using the `-L` (`--location`) option, which makes `curl` follow redirect responses through to their target.

```bash
curl -L -i http://<ingress-host>/
```

Inspect the response on the insecure HTTP URL. A correctly configured redirect returns an HTTP 302 (30x) on the plain-HTTP request and points the `Location` header at the HTTPS URL, rather than serving the resource body directly on the insecure port. If no redirect is configured, the same request is answered on the insecure port with no 30x status, indicating the redirect annotation is absent.

Verify that the insecure HTTP port is reachable as part of the check; the 302 is issued by the ALB's insecure HTTP frontend, so a request that cannot reach the insecure port will never observe the redirect even when it is configured.
