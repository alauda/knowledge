---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500035
---
## Issue

A cluster component that establishes TLS connections to an external endpoint starts failing to parse the server's certificate after a platform upgrade:

```text
tls: failed to parse certificate from server: x509: invalid certificate policies
```

The failure presents in multiple contexts depending on what does the outbound connection — the most visible is an LDAP-backed login flow that returns `AuthenticationError` / `Network Error` with the same parse error:

```text
LDAP Result Code 200 "Network Error":
  tls: failed to parse certificate from server:
  x509: invalid certificate policies
```

Other components that reach through TLS to external services (catalog fetches, webhook callbacks, telemetry endpoints) surface the same message. The certificate itself looks fine to `openssl s_client`, loads in browsers, and worked against the same endpoint before the upgrade — nothing visibly wrong with the chain, the expiry dates, or the CA bundle.

The common thread is **which runtime** the failing component was built against.

## Root Cause

[RFC 5280 §4.2.1.4](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.4) specifies that a certificate's `certificatePolicies` extension **must not** repeat a `policyIdentifier` OID. Each policy OID appears at most once within the extension.

Historically, Go's `crypto/x509` parser tolerated certificates that violated this rule — the parse would succeed and callers could fall through to their own validation, most of which did not notice. As of **Go 1.24**, the parser enforces the constraint strictly: a certificate whose `certificatePolicies` extension contains a duplicate OID is rejected at `ParseCertificate` time, returning `x509: invalid certificate policies`.

The failure is therefore not triggered by the cluster or by the endpoint. It is triggered by components being rebuilt on Go 1.24+ and suddenly refusing a certificate they were happy with under Go 1.23 or earlier. Two corollaries:

1. Client-side TLS options (`InsecureSkipVerify`, custom verify callbacks, additional trust bundles) cannot hide the error. The parse fails before verification runs.
2. The failure is certificate-specific, not endpoint-specific. Every caller that reaches the same certificate and is built on Go 1.24+ will fail identically. LDAP is a common early surface because corporate LDAP servers often sit behind certificates issued by internal CAs whose tooling emitted the duplicate OID years ago without anyone noticing.

## Resolution

The durable fix is on the **certificate issuer** side. The client cannot work around a parser that strictly enforces the RFC; the only remedy is to present a RFC-compliant certificate.

### Reissue the server certificate without the duplicate OID

Ask the team that owns the endpoint (LDAP operator, internal PKI, appliance vendor) to reissue the certificate with its `certificatePolicies` extension deduplicated. Each policy OID must appear once. Concretely:

- The issuer's certificate generation configuration often has a field for policy OIDs that accepts a list. Audit that list for duplicates (sometimes the same OID is inherited from a parent CA profile and also listed in the leaf's configuration — the renderer concatenates without dedup).
- On some commercial appliances, a "RFC 5280 strict" toggle exists; enabling it causes the appliance to reject its own duplicates rather than emit them.
- If the certificate was signed by an internal CA tool (cfssl, step-ca, scripted openssl), regenerate with a profile that lists each OID exactly once.

Deploy the reissued certificate to the endpoint. The next connection from the Go-1.24 client completes the handshake; the component comes back healthy.

### Audit other endpoints the cluster depends on

One endpoint's certificate almost never carries the duplicate alone. When an internal CA has been emitting the duplicate for a while, **every** certificate it signed over that period has the same issue. Enumerate the cluster's outbound TLS dependencies and pre-emptively inspect each certificate before its dependent component is built on Go 1.24:

- LDAP endpoints
- OIDC / SAML identity providers
- External image registries
- External Git servers (GitOps source, webhooks)
- External webhook receivers (Slack, PagerDuty, custom integrations)
- Syslog / log-forwarding endpoints
- Backup storage endpoints (S3-compatible, NFS-over-TLS)

Reissue any that carry duplicated OIDs before Go-1.24 components start pointing at them.

### There is no safe client-side bypass

Downgrading a component to a pre-Go-1.24 build is a stop-gap at best — the moment another component in the chain upgrades to Go 1.24, the problem reappears. Pinning `InsecureSkipVerify` is not a mitigation because the parse error happens before verification. Building a custom TLS dialer that accepts the certificate manually requires reimplementing TLS parsing, which is not reasonable.

The right fix is always certificate reissue.

## Diagnostic Steps

Capture the exact certificate the failing endpoint presents. From a workstation that can reach the endpoint:

```bash
echo Q | openssl s_client -showcerts -connect <endpoint>:<port> 2>/dev/null | \
  awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' > /tmp/server-chain.pem
```

Walk the chain and check each certificate's `certificatePolicies` extension for duplicates:

```bash
awk '/-----BEGIN CERTIFICATE-----/{i++; f="/tmp/chain-"i".pem"} {print > f}' < /tmp/server-chain.pem

for f in /tmp/chain-*.pem; do
  echo "=== $f ==="
  openssl x509 -in "$f" -ext certificatePolicies -noout 2>/dev/null | \
    awk '/Policy:/ {print $2}' | sort | uniq -c | awk '$1 > 1 {print "DUPLICATE: " $0}'
done
```

Any output line starting with `DUPLICATE:` identifies the specific OID that appears more than once and names the certificate file that carries it. That certificate is the one the issuer must reissue.

Verify on the cluster side that the failing component is indeed compiled against Go 1.24+ (sometimes the failure is coming from a different source than expected):

```bash
# Identify the pod running the failing component.
kubectl -n <ns> logs <pod> --tail=200 | grep -E 'x509: invalid certificate policies'

# Inspect the binary's Go build info if possible.
kubectl -n <ns> exec <pod> -- sh -c '
  for b in /usr/bin /usr/local/bin; do
    for exe in $b/*; do
      go version "$exe" 2>/dev/null
    done
  done' 2>/dev/null | grep -E 'go1\.[0-9]+'
```

A `go1.24.x` (or newer) line confirms the component's runtime is the Go version that introduced the strict enforcement. A line showing `go1.23.x` or earlier while still producing the parse error indicates a different root cause — revisit whether the certificate has some other shape issue (negative serial, malformed extension) rather than the policy duplication this note addresses.

After reissuing the certificate, retry the failing operation. A healthy response confirms the fix; audit the issuer's generation template to ensure new certificates will not reintroduce the duplicate.
