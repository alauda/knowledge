---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Workloads and platform components running in a cluster that claims FIPS 140-3 compliance must negotiate TLS, sign data, hash payloads, and derive keys using **only** the algorithms that NIST approves under the standard. When a cluster operator flips the platform-wide FIPS mode on, the kernel crypto module, the Go/OpenSSL runtimes, and the Java security provider all narrow their allowed algorithm set — any connection that tries to use a non-approved primitive fails the handshake outright, usually with `no cipher suites in common` or `unsupported algorithm`.

This reference groups the common symmetric ciphers, hashes, key exchanges, and signature algorithms into FIPS 140-3 "approved" and "non-approved" buckets so that platform operators can audit workload configurations (Ingress certificates, service-mesh mTLS profiles, application JKS keystores, database client drivers) before turning FIPS mode on.

## Root Cause

FIPS 140-3 is a catalogue of cryptographic algorithms that NIST has validated through CAVP (Cryptographic Algorithm Validation Program). The standard both *approves* algorithms (explicitly listed) and *retires* algorithms (removed from the approved list because of known weaknesses, insufficient key length, or collision exposure). A FIPS-validated module rejects any primitive outside the approved list, regardless of the reason the workload might want to use it.

Two frequent misreads on ACP clusters:

- **ChaCha20-Poly1305 is *not* FIPS-approved.** It is widely deployed (Android, modern browsers, TLS 1.3 libraries) and is considered cryptographically strong, but it has not been validated through CAVP. A FIPS-enabled workload trying to negotiate a `TLS_*_CHACHA20_POLY1305_*` cipher suite will fail.
- **SHA-1 is approved for HMAC and legacy verification, not for new digital signatures or certificate signing.** The distinction is common source of drift between the compliance tool's verdict and what the runtime actually does.

## Resolution

Use the matrix below when reviewing cluster-hosted workload crypto configurations. Anything listed as non-approved must be removed from the cluster's effective cipher/algorithm list before enabling FIPS mode.

| Category | Non-approved (reject before FIPS-on) | FIPS-approved |
|---|---|---|
| Symmetric ciphers | RC4, DES, 3DES (deprecated as of FIPS 140-3), Blowfish, ChaCha20 | AES-128, AES-192, AES-256 (GCM, CCM, CBC with HMAC), 3-key Triple DES (legacy only) |
| Hash / digest | MD5, SHA-1 (for signing / cert creation) | SHA-224, SHA-256, SHA-384, SHA-512, SHA-3 family |
| MAC | HMAC-MD5 | HMAC-SHA-224 and above, KMAC |
| Key exchange | Diffie-Hellman with modulus < 2048 bits, static DH, ChaCha20-Poly1305 as a KEM surrogate | ECDHE (P-256 / P-384 / P-521), Diffie-Hellman (≥ 2048 bits), ML-KEM (Kyber) where supported |
| Signature / public key | RSA < 2048 bits, DSA (all), ECDSA over Brainpool | RSA (≥ 2048 bits, PSS and PKCS#1 v1.5), ECDSA (P-256 / P-384 / P-521), EdDSA (Ed25519 / Ed448, approved in FIPS 186-5) |
| TLS cipher suites | `TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256`, `TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256`, any `_RC4_` / `_DES_` / `_3DES_` / `_MD5` suite | `TLS_AES_128_GCM_SHA256`, `TLS_AES_256_GCM_SHA384`, `TLS_ECDHE_*_AES_128_GCM_SHA256`, `TLS_ECDHE_*_AES_256_GCM_SHA384` |

Practical enforcement steps on ACP:

1. **Audit inbound-TLS-facing cluster components.** Ingress controllers (ALB listeners), the cluster API server, internal Service Mesh mTLS profiles, registry endpoints. Remove any cipher-suite allow-list that references non-approved primitives.
2. **Audit outbound clients baked into workload images.** Java KeyStores using MD5-signed certificates, older Python `requests` installs pinning `DEFAULT@SECLEVEL=0`, Node.js with `--tls-cipher-list` overrides.
3. **Validate at runtime.** After turning FIPS mode on, probe each listener with `openssl s_client -connect <host>:443 -tls1_3 -ciphersuites <...>` and confirm the non-approved suites are actively rejected, not silently accepted.
4. **Pin image variants where possible.** Many upstream container images ship a FIPS variant (`-fips` tag) whose Go binary is linked against the platform FIPS module and whose OpenSSL build honours `OPENSSL_FIPS=1`. Prefer those over the generic image when FIPS mode is on.

## Diagnostic Steps

Confirm which cipher suites a given TLS listener offers after FIPS mode is enabled:

```bash
openssl s_client -connect <host>:443 -tls1_3 -ciphersuites \
  'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256' \
  -servername <host> </dev/null 2>&1 | grep -E 'Cipher|error'
```

A FIPS-on cluster must pick `TLS_AES_128_GCM_SHA256` and refuse `TLS_CHACHA20_POLY1305_SHA256`. If the ChaCha20 suite is picked, the listener is not using the FIPS-validated provider — double-check the image variant and the `OPENSSL_FIPS` environment on the pod.

Check the certificate signature algorithms used in cluster-issued certificates:

```bash
kubectl get secret <tls-secret> -n <ns> -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl x509 -noout -text \
  | grep -E 'Signature Algorithm|Public Key Algorithm'
```

Anything signed with `md5WithRSAEncryption` or `sha1WithRSAEncryption` must be reissued (cert-manager ClusterIssuer settings typically control this) before FIPS mode will accept the chain.

Audit Java workloads by dumping the effective security providers inside the pod:

```bash
kubectl exec -n <ns> <pod> -- \
  java -XshowSettings:properties -version 2>&1 | grep -E 'fips|security.provider'
```

On a FIPS-on cluster, the first provider should be the system FIPS module; otherwise the JVM will accept non-approved algorithms even though the host claims FIPS mode.
