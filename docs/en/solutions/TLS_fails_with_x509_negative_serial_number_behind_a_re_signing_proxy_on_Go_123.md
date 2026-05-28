---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500343
---

# TLS fails with x509 negative serial number behind a re-signing proxy on Go 1.23+

## Issue

On Alauda Container Platform 4.3.x (base-v4.3.5 / acp-business-v4.3.6 ModuleConfigs), a workload or platform component built with Go 1.23 or later can fail to establish a TLS connection to an endpoint that sits behind a TLS-intercepting proxy, surfacing the error `tls: failed to parse certificate from server: x509: negative serial number`. A TLS-intercepting proxy terminates the upstream connection and re-signs it, substituting its own CA-signed certificate into the chain presented to the client; when that substituted certificate carries a negative serial number, the Go 1.23+ TLS client rejects the re-signed certificate and cannot parse it. RFC 5280 §4.1.2.2 requires the certificate `serialNumber` to be a non-negative integer, so a certificate with a negative serial is non-compliant.

## Root Cause

The Go standard library certificate parser `crypto/x509.ParseCertificate` (Go 1.23+) rejects certificates with a negative serial number by default, refusing to parse them. Components built with Go 1.22 or earlier did not reject a certificate with a negative serial number, so the same proxy-presented certificate parsed successfully before the runtime was upgraded. The rejection is therefore Go-version-gated behavior in the standard library parser rather than a universal X.509 rule enforced by every tool: the connection that previously succeeded begins to fail only once the client is built on the stricter runtime, even though the proxy certificate itself is unchanged.

## Resolution

Replace the certificate that the TLS-intercepting proxy presents with an RFC 5280-compliant one whose serial number is non-negative; a positive-serial certificate parses cleanly with no negative-integer encoding, which removes the parse failure. Because RFC 5280 §4.1.2.2 mandates a non-negative `serialNumber`, re-issuing the proxy's re-signed leaf with a compliant positive serial restores conformance and lets the Go 1.23+ parser accept the chain.

## Diagnostic Steps

Dump the certificate chain that the proxied endpoint actually returns to confirm a non-trusted custom CA is re-signing the connection — a sign of TLS interception:

```bash
openssl s_client -connect <host>:443 -showcerts
```

Replace `<host>` with the proxied endpoint being diagnosed — the hostname the affected Go client is trying to reach through the intercepting proxy.

A custom CA appearing in the returned chain instead of the endpoint's expected issuer indicates the proxy is intercepting and re-signing the TLS session. Note that the inspection tooling itself still displays such a certificate, including one carrying a negative serial number — the rejection is specific to the Go 1.23+ standard-library parser, so the failure reproduces from the affected Go client rather than from the chain dump.
