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

# OIDC clients and pages are sent to the wrong Dex issuer address on ACP

## Issue

The platform Dex advertises an issuer address that does not match how users or OIDC clients reach the platform. One of these is reported:

- Users open the platform through one address (for example a floating IP in front of the HA VIP), and Service Mesh v2 pages such as Kiali or Jaeger, each with its own access address, redirect to the VIP for Dex.
- SonarQube reports `Issuer URL in provider metadata doesn't match the issuer URI specified in plugin configuration`, and other OIDC clients (GitLab, Harbor, Nexus) fail the same way when they are configured with `https://<platform-dns>/dex`. The Dex discovery document on the DNS name still returns `"issuer": "https://<platform-ip>/dex"`.

Related articles: "Dex login options, CORS, SSO user identity, and the Dex deployment layout on ACP" and "Dex update fails on ACP 3.10 or account login returns 401 after the Dex permanent token changes".

## Root Cause

### Cause 1: Dex does not switch the issuer when more than one access address is in use

Dex publishes one issuer and does not change it dynamically according to the address the browser used. Registering extra callback URLs does not make the issuer follow the browser host. When the console and the Mesh pages are opened on different addresses, the pages that use Dex are sent to the issuer address. The supported layout is one domain name for access.

### Cause 2: Dex still advertises the IP issuer after the platform moved to a DNS name

The platform was installed with an IP address as its platform access address. A DNS name and a new certificate were added later by rotating the TLS certificates of the platform access addresses. That rotation lets browsers reach the DNS name; it does not change the Dex issuer. The current product does not support converting an IP-based platform access address to a DNS name in place, so there is no in-place fix on the existing platform. The way to get a DNS issuer is to redeploy the platform with the domain name as the access address.

On ACP 4.3.2 the default platform access address cannot be changed after installation, and neither can the internal registry address; additional access addresses can still be added.

## Resolution

### Cause 1: Dex does not switch the issuer when more than one access address is in use

Publish one domain name and open the platform, Service Mesh, Kiali, and Jaeger on that domain.

Only when a product page must stay up without Dex, and its owners accept an unauthenticated UI, these per-product changes remove the dependency on the issuer:

> **Warning:** Kiali with `spec.auth.strategy: anonymous` no longer asks who the user is; anyone who can open the Kiali address can use it. Precondition: only when Kiali's OpenID redirect to the VIP is the confirmed problem and a single domain is not available. Rollback: `kubectl apply -f /tmp/kiali.bak.yaml`.

```bash
kubectl get kiali -A
kubectl get kiali -n <kiali-namespace> <kiali-name> -o yaml > /tmp/kiali.bak.yaml
kubectl patch kiali -n <kiali-namespace> <kiali-name> --type=merge -p '{"spec":{"auth":{"strategy":"anonymous"}}}'
```

> **Warning:** Removing `spec.additionalContainers` removes the `oauth2-proxy` container from the OpenTelemetryCollector, and pointing the Ingress at `jaeger-collector-extension:16686` serves Jaeger without that proxy, unauthenticated. Precondition: only when Jaeger is the page that bounces to the VIP for Dex. Rollback: `kubectl apply -f /tmp/otelcol.bak.yaml` and restore the previous Ingress backend.

```bash
kubectl get opentelemetrycollector -A
kubectl get opentelemetrycollector -n <namespace> <collector-name> -o yaml > /tmp/otelcol.bak.yaml
kubectl patch opentelemetrycollector -n <namespace> <collector-name> --type=json \
  -p='[{"op":"remove","path":"/spec/additionalContainers"}]'
```

Then change the backend of the Jaeger Ingress to the Service `jaeger-collector-extension`, port `16686`.

### Cause 2: Dex still advertises the IP issuer after the platform moved to a DNS name

1. Confirm the issuer that OIDC clients receive on the DNS name, and the certificate that name presents:

   ```bash
   curl -k -sS https://<platform-dns>/dex/.well-known/openid-configuration | jq -r .issuer
   openssl s_client -connect <platform-dns>:443 -servername <platform-dns> </dev/null 2>/dev/null \
     | openssl x509 -noout -subject -ext subjectAltName
   ```

   `issuer` is `https://<platform-ip>/dex`: the platform was installed on the IP, and the issuer cannot be changed in place.

2. Plan a redeployment of the platform with the domain name as the platform access address, and configure the OIDC clients with `https://<platform-dns>/dex` after that. Redeploying is not realistic once user clusters already run workloads. Until then, OIDC clients that require an exact issuer match can only use the IP issuer that the platform already advertises.

3. If the certificate subject or SAN does not contain the DNS name, also replace the platform access certificate with one that contains it. A browser warning such as `Not secure` on the DNS name with a certificate CN for a different name is a separate certificate problem.

Adding a domain only for toolchain callbacks, without changing the issuer, is covered in "Toolchain SSO on a domain name after an IP-based install, and kube-apiserver OIDC for an external UI on ACP".

## Diagnostic Steps

```bash
curl -k -sS https://<platform-address>/dex/.well-known/openid-configuration | jq -r .issuer
kubectl -n cpaas-system get cm dex-configmap -o yaml | grep -n issuer
kubectl get oauth2clients.dex.coreos.com -n cpaas-system
```

- Several browser hosts are in use, and the console or Mesh pages jump to the VIP for Dex: Cause 1.
- An OIDC client reports `Issuer URL in provider metadata doesn't match`, and the discovery `issuer` on the DNS name is still the install-time IP: Cause 2.
- `Unregistered redirect_uri` for `/console-portal/` on a toolchain host, with `client_id=alauda-auth`: not an issuer problem; see "Harbor SSO through the platform Dex fails: wrong issuer, OAuth2Client name, or Unregistered redirect_uri console-portal".
