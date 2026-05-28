---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Diagnosing "x509 certificate has expired" caused by an expired CA in the chain

## Issue

A TLS client reports `certificate has expired` even though the leaf (server) certificate is still well within its validity window. On Alauda Container Platform nodes (kube-apiserver Server v1.34.5), the failure surfaces as `x509: certificate has expired or is not yet valid: current time ... is after 2021-01-01` from Go's `crypto/x509`, or as a curl exit code 60 with `SSL certificate problem: certificate has expired` after a TLS alert `certificate expired (557)`; in each case the error is attributed to the chain rather than to the still-valid leaf. The wording is misleading because the leaf the client connected for is not the certificate that expired — a CA higher in the trust path is.

## Root Cause

x509 chain verification requires every certificate in the chain to be currently valid, so an expired intermediate or root CA makes verification fail even when the leaf certificate has not yet reached its `notAfter` date. The concrete shape of the symptom is that the server presents only the leaf certificate while the intermediate or root CA the local machine relies on to complete the chain is expired, invalid, or missing. Under `openssl verify` and `openssl s_client`, this manifests as `verify error:num=10:certificate has expired` (`X509_V_ERR_CERTIFICATE_HAS_EXPIRED`) reported at a non-zero depth — depth 1, the CA — while depth 0, the leaf, validates cleanly.

## Resolution

Because chain verification requires every certificate in the path to be currently valid, the failure clears only once the whole chain — leaf plus every intermediate and root — is valid; an expired CA in the path keeps the error even though the leaf is still within its window. So the resolution is diagnostic first: use the steps below to identify which certificate in the presented chain has expired, then ensure that the source supplying it presents or trusts a fully-valid chain.

For a serving certificate stored in a Kubernetes TLS secret (Alauda Container Platform ships cert-manager, and serving-cert secrets such as `base-api-cert` live in the `cpaas-system` namespace), extract the certificate from the secret and check its dates directly. Read the `tls.crt` entry from the secret, base64-decode it, and feed it into `openssl x509 -dates`, which prints the `notBefore`/`notAfter` of the certificate so an operator can confirm whether it is expired:

```bash
kubectl get secret <tls-secret> -n <namespace> \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -dates -subject -noout
```

Because `openssl x509` parses only the first certificate in a multi-cert PEM, the dates printed for a bundle reflect just one certificate; to date-check every certificate in a bundle, enumerate the full set first by piping `openssl crl2pkcs7` into `openssl pkcs7 -print_certs`, then check each one:

```bash
openssl crl2pkcs7 -nocrl -certfile <bundle.pem> | \
  openssl pkcs7 -print_certs -noout
```

## Diagnostic Steps

Inspect the per-depth verify results presented by the server to find the expired certificate's position in the chain. `openssl s_client -connect <host>:<port> -showcerts` prints `verify error:num=10:certificate has expired` keyed to the depth at which it occurs, so a non-zero depth pinpoints which CA — not the leaf at depth 0 — is the expired certificate:

```bash
openssl s_client -connect <host>:<port> -showcerts
```

Distinguish what the server actually sent from what the local trust store supplied. The certificates the server presents appear under the `Certificate chain` indexes (`0`, `1`, ...) in the `openssl s_client` output; a certificate that participates in verification but is absent from that index list was supplied by the local trust store rather than by the server.

Identify which local trust-store files to inspect. `curl -v` prints the CAfile and CApath the client used, naming the local trust-store locations to search for an expired CA:

```bash
curl -v https://<host>/
```

Rule out a TLS-terminating intermediary in the path. If `curl --noproxy '*' -v <url>` succeeds while the proxied request fails with `certificate has expired`, an intermediate network device — a TLS-terminating proxy or load balancer — is presenting an expired certificate of its own:

```bash
curl --noproxy '*' -v https://<host>/
```

Once a candidate certificate is located, confirm its dates with `openssl x509 -dates -subject -noout` (or `-enddate`) on that single certificate, which prints its `notBefore`/`notAfter` and subject so the expired CA can be confirmed before it is renewed.
