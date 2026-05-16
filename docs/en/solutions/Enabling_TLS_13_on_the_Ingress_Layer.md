---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Enabling TLS 1.3 on the Ingress Layer
## Overview

TLS 1.3 removes a class of legacy weaknesses (RSA key exchange, CBC-mode ciphers, static Diffie-Hellman) that TLS 1.2 still supports. Compliance regimes increasingly require it on anything user-facing. Platforms ship with a conservative default (TLS 1.2) for broader compatibility; enabling TLS 1.3 on the ingress layer is a matter of picking a stricter profile or declaring a custom one.

## Resolution

### Understand the Levels

The ingress layer typically exposes three pre-defined profiles, plus a custom option:

- **Old** — accepts TLS 1.0+ for very old clients. Avoid outside specific legacy scenarios.
- **Intermediate** — the usual default. Requires TLS 1.2 minimum. Broad compatibility.
- **Modern** — requires TLS 1.3 minimum. Rejects anything older.
- **Custom** — hand-specified minimum version and cipher suite list.

Match the profile to who you expect to connect:

| Client population | Recommended profile |
|---|---|
| Public-internet browsers (last 3–4 years) | Modern |
| Internal services / modern gRPC clients | Modern |
| Mixed fleet with some TLS-1.2-only legacy clients | Intermediate + specific TLS 1.3 vhost |
| Known ancient endpoints (audit first, fix when possible) | Custom with explicit minimum + allowlist |

### Flip the Ingress Layer to Modern (TLS 1.3 Minimum)

Configure the ALB (or platform equivalent ingress layer) to use the Modern profile. Mechanism varies by platform, but the underlying setting is always a `tlsSecurityProfile`-shaped field on the ingress/gateway resource:

```yaml
spec:
  tlsSecurityProfile:
    type: Modern
```

Changing the profile rolls the ingress pods. During the rollout the platform serves with both the old and new config so existing connections are not cut abruptly; a small window where new connections briefly try both profiles is normal.

### Use a Custom Profile for Per-Listener Control

If you need TLS 1.3 for one hostname but TLS 1.2 compatibility for another (for example, a public API migrating to 1.3 while a partner integration stays on 1.2 for a quarter), use a Custom profile and list the exact ciphers:

```yaml
spec:
  tlsSecurityProfile:
    type: Custom
    custom:
      minTLSVersion: VersionTLS13
      ciphers:
        - TLS_AES_256_GCM_SHA384
        - TLS_CHACHA20_POLY1305_SHA256
        - TLS_AES_128_GCM_SHA256
```

Leaving `ciphers` empty under TLS 1.3 is also acceptable — the 1.3 cipher suite set is narrow and standardised. TLS 1.2 ciphers listed under a 1.3-minimum profile are silently ignored.

### Keep the Control Plane Separate

The cluster control plane (API server, etcd, kubelet) typically enforces its own TLS minimum, separately from the ingress layer. Changing the ingress profile to Modern does **not** imply control-plane TLS 1.3. Platform policy controls that surface; do not assume an ingress change covers it.

### Check Before Broadcasting the Change

Before rolling this out widely, run a probe from a client that speaks TLS 1.3 and one that does not, against a test hostname served by the reconfigured ingress:

```bash
# Should succeed
openssl s_client -connect app.example.com:443 -tls1_3 -servername app.example.com < /dev/null

# Should now fail (client limited to TLS 1.2)
openssl s_client -connect app.example.com:443 -tls1_2 -servername app.example.com < /dev/null
```

Watch ingress logs for `unsupported protocol` spikes in the hour after the rollout — that is the population of clients your change just broke. Decide whether to carve them an allowlist with a Custom profile, or push them to upgrade.

## Diagnostic Steps

Confirm the current profile on the ingress resource (exact resource path depends on platform; the field names are standardised):

```bash
kubectl get <ingress-resource> -n <ingress-ns> -o yaml \
  | grep -A5 tlsSecurityProfile
```

Inspect the actual TLS versions a live endpoint negotiates:

```bash
# enumerate supported versions
for v in tls1 tls1_1 tls1_2 tls1_3; do
  result=$(echo | openssl s_client -$v -connect app.example.com:443 \
             -servername app.example.com 2>/dev/null \
             | awk '/Protocol/{print $3}')
  printf "%-10s -> %s\n" "$v" "${result:-rejected}"
done
```

Expected after Modern: `tls1_3` connects, everything older is rejected.

If you rolled out Modern but `tls1_2` still connects, the change has not yet taken effect on every ingress pod — check the rollout status of the ingress deployment and, if the ingress layer runs as a DaemonSet, confirm every pod has the new version of its config mounted. Reloading the running process is not enough in most ingress implementations; a pod-restart rollout is required.

If clients unexpectedly fail with `handshake failure` after the switch, read the ingress access log for the SNI of the failing request and run the `openssl s_client` probe against that SNI from the same client. Frequently the client sends `sslv3` or `tls1_0` and the ingress is right to reject it — the fix belongs on the client side (upgrade their TLS library) not on the ingress.
