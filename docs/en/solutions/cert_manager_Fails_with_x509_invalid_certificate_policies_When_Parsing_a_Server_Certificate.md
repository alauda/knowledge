---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

`cert-manager` reports it cannot parse the certificate served by an `Issuer` endpoint (ACME server, CA webhook, remote `https://…` target) and logs an error of the form:

```text
failed to parse certificate from server: x509: invalid certificate policies
```

The `Issuer` stays in a not-ready state, `Certificate` resources dependent on it never progress, and ACME account registration fails with the same error surfacing in the cert-manager controller log. The remote endpoint itself is healthy and can be reached with other TLS clients — browsers, `curl`, `openssl s_client` all negotiate TLS and show the certificate fine. Only Go-based clients trip.

## Root Cause

The error originates in the Go standard library's `crypto/x509` package. Older releases of that library (prior to Go 1.22) reject an X.509 `certificatePolicies` extension that contains a `policyIdentifier` whose ASN.1 OID uses component values large enough to overflow a machine `int` on the path the parser took. Valid-per-RFC certificates that happen to use long OIDs therefore fail to parse with "invalid certificate policies", even though every other TLS tool accepts them without complaint.

Because cert-manager (and many other Kubernetes-ecosystem components) is written in Go and links against the standard library, any cert-manager build that pre-dates the Go 1.22 fix exhibits this symptom when the endpoint it talks to serves such a certificate. The fix is upstream: cert-manager releases built against Go 1.22+ parse the same certificate cleanly. The same class of bug affects any Go program that links an older `crypto/x509`; it is not specific to cert-manager.

## Resolution

1. **Upgrade cert-manager to a release built against Go 1.22 or later.** On ACP, cert-manager is the supported certificate-lifecycle mechanism (`ClusterIssuer` / `Issuer` / `Certificate` CRDs are all directly available), and the tracked cert-manager build advances with the product. Upgrade the cert-manager installation to the currently supported channel on the cluster; do not stay on a release older than Go 1.22's ship date unless there is a strong reason to.

2. **Check any other Go-based component that talks to the same endpoint.** The same parsing error will re-appear in Argo CD repo-server talking to a Git server, a Prometheus `remote_write` talking to a receiver, a webhook client talking to an admission webhook endpoint — anywhere an older Go binary parses the problematic server certificate. Upgrading just cert-manager does not insulate the rest of the cluster from the issue if they share the target endpoint.

3. **As a temporary mitigation, re-issue the offending server certificate without the problematic policy.** If upgrading the Go-based client is not immediately possible, ask the CA that issued the server certificate to remove or shorten the OIDs under `certificatePolicies`. This is an endpoint-side fix, not a client-side one, and it unblocks every affected client at once. It is not always available (some CAs will not re-issue on request), which is why upgrading is the durable fix.

4. **Do not work around this by disabling TLS verification.** Suppressing the error — for example by telling cert-manager to skip verification against the endpoint, or routing traffic through a proxy that re-terminates TLS with a different certificate — hides the diagnostic signal for an underlying Go-standard-library bug and leaves other clients exposed. Upgrade the binary or re-issue the certificate; do not paper over the parser error.

## Diagnostic Steps

Confirm cert-manager is logging exactly this error and attributing it to the target `Issuer`:

```bash
kubectl -n <cert-manager-namespace> logs deploy/cert-manager | grep -i "invalid certificate policies"
```

Expected shape:

```text
E... cert-manager/issuers "msg"="failed to register an ACME account"
"error"="Get \"https://<endpoint>/acme/server\":
tls: failed to parse certificate from server: x509: invalid certificate policies"
"resource_kind"="Issuer" "resource_name"="<name>" "resource_namespace"="<ns>"
```

Retrieve the certificate chain that the endpoint is actually presenting, so you can inspect what is upsetting the parser:

```bash
true | openssl s_client -showcerts -connect <endpoint-host>:443 </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/,/END CERT/'
```

Save each PEM block to a separate file, then ask OpenSSL to show the `certificatePolicies` extension — OpenSSL parses it without trouble, which makes it the right tool for this specific check:

```bash
openssl x509 -in server.crt -ext certificatePolicies -noout
```

Expected shape on an affected certificate:

```text
X509v3 Certificate Policies:
    Policy: <very-long-dotted-OID-string>
      CPS: http://www.example.com/CPS
```

The combination of the cert-manager error above and a `certificatePolicies` extension with long OIDs on the same certificate confirms the Go-parser-vs-OID interaction. Remediate via resolution step 1 (upgrade) or step 3 (re-issue without the long OID).
