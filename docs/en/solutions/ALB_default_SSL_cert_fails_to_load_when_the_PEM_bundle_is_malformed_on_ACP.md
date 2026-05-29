---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500589
---

# ALB default SSL cert fails to load when the PEM bundle is malformed on ACP

## Issue

On Alauda Container Platform, the platform load balancer is the ALB2 instance (`alaudaloadbalancer2.crd.alauda.io`), whose `spec.config.defaultSSLCert` field points at a Kubernetes Secret of type `kubernetes.io/tls` carrying `tls.crt` and `tls.key`. After replacing that default TLS Secret with a freshly generated wildcard or SAN certificate bundle, components consuming the ALB default SSL cert can log Go `x509` / `crypto/tls` PEM parse errors at startup — the bundle is structurally invalid even though it looks correct in a text editor. The data plane runs on the nginx-based engine (`alb-nginx:v4.3.1` and `alb2:v4.3.1` in the `cpaas-system` namespace on a Kubernetes v1.34.5 cluster), and the consuming code path is Go's standard `encoding/pem` and `crypto/tls`, so any Go-based component that resolves the same Secret would reject the same malformed inputs through the same parser.

## Root Cause

The PEM bundle in a `kubernetes.io/tls` Secret's `tls.crt` is expected to be a concatenation of certificates in a fixed order: the leaf (wildcard or SAN) certificate first, followed by any intermediate CA certificates, and the root CA last. The Go `encoding/pem` parser is strict about block framing: a block whose `-----BEGIN <type>-----` and `-----END <type>-----` markers have been collapsed onto a single line — for example from a copy-paste that stripped the newline between them — is not recognized as a PEM block at all, and the certificate or key it was meant to carry is silently dropped from the parser's view. Trailing non-PEM bytes at the end of the file have the same effect on the final block: when a shell prompt is accidentally captured into the file so the last line reads `-----END CERTIFICATE-----[user@host ~]$` instead of `-----END CERTIFICATE-----` alone, the terminating marker no longer matches and the loader rejects the input. Within a multi-block bundle, consecutive PEM blocks should be separated by exactly one blank line, and there must be no trailing blank line at end of file.

## Resolution

Reconstruct the Secret so that `tls.crt` holds the wildcard or SAN leaf certificate, then any intermediate CAs, then the root CA, in that order; `tls.key` must hold the matching private key in a recognizable `-----BEGIN ... PRIVATE KEY-----` block (for example `RSA PRIVATE KEY` for a PKCS#1 RSA key, or `PRIVATE KEY` for a PKCS#8 key). Each block's `-----BEGIN`/`-----END` markers must sit on their own lines, blocks must be separated by exactly one blank line, and the file must not have trailing bytes after the final `-----END CERTIFICATE-----`.

Recreate the Secret in the ALB's namespace and point `spec.config.defaultSSLCert` at it. With the cleaned files in hand (`tls.crt` and `tls.key`):

```bash
kubectl -n cpaas-system create secret tls <secret-name> \
  --cert=tls.crt --key=tls.key \
  --dry-run=client -o yaml | kubectl apply -f -
```

The Secret carries `tls.crt` and `tls.key` of type `kubernetes.io/tls`; the ALB2 CR references it by `namespace/name` on `spec.config.defaultSSLCert` (for example `cpaas-system/<secret-name>`), the same reference shape verified on the live ALB instance running `alb2:v4.3.1` with `alb-nginx:v4.3.1`.

## Diagnostic Steps

Pull the current `tls.crt` out of the Secret and inspect its framing. The first line must be `-----BEGIN CERTIFICATE-----` and the last non-empty line must be `-----END CERTIFICATE-----` exactly, with no trailing prompt bytes; collapsed BEGIN/END markers on the same line are the most common defect:

```bash
kubectl -n cpaas-system get secret <secret-name> \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/tls.crt
head -1 /tmp/tls.crt
tail -1 /tmp/tls.crt
grep -c '^-----BEGIN CERTIFICATE-----$' /tmp/tls.crt
grep -c '^-----END CERTIFICATE-----$' /tmp/tls.crt
```

The two `grep -c` counts must be equal and must match the number of certificates in the bundle (leaf + intermediates + root); a leaf-only self-signed bundle has count 1, while a leaf plus one intermediate plus root has count 3. Consecutive blocks must be separated by exactly one blank line and there must be no trailing blank line at end of file.

Verify the private-key block. The `tls.key` payload's first line must be a `-----BEGIN ... PRIVATE KEY-----` marker that ends in `PRIVATE KEY` — this is the exact substring the Go `crypto/tls` loader matches when locating the key block; a file containing only `CERTIFICATE` blocks and no `PRIVATE KEY` block in the key input is what surfaces as the PEM parser's "find PEM block with type ending in PRIVATE KEY" failure:

```bash
kubectl -n cpaas-system get secret <secret-name> \
  -o jsonpath='{.data.tls\.key}' | base64 -d > /tmp/tls.key
head -1 /tmp/tls.key
tail -1 /tmp/tls.key
```

Once framing is clean and the `tls.key` carries a `PRIVATE KEY`-suffixed block matching the leaf certificate's key shape (RSA on the verified secret), recreate the Secret with `kubectl create secret tls --dry-run=client -o yaml | kubectl apply -f -` and confirm the ALB2 CR's `spec.config.defaultSSLCert` still resolves to `<namespace>/<secret-name>`.
