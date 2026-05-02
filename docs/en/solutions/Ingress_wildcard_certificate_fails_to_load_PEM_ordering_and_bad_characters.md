---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Right after the cluster's default ingress certificate is replaced with a custom one, components that consume the new bundle start crashing on TLS load. The most visible symptom is the cluster's authentication pods (the OAuth server pods that terminate `*.apps.<cluster>` traffic) entering a `CrashLoopBackOff` with a fatal log line of the form:

```text
dynamic_serving_content.go: "Loaded a new cert/key pair"
  name="serving-cert::/var/config/system/secrets/.../tls.crt::.../tls.key"
cmd.go: failed to load SNI cert and key: tls: failed to find PEM block with
  type ending in "PRIVATE KEY" in key input after skipping PEM blocks of the
  following types: [CERTIFICATE CERTIFICATE]
```

Operators that depend on the same ingress identity (console, metrics proxies, console-down handlers) report the same `failed to find PEM block with type ending in "PRIVATE KEY"` underneath, because they all read from the same TLS Secret and the parser refuses the file before any cert is served.

## Root Cause

The Go TLS loader walks the file from the top and accepts whatever PEM block it sees. When the bundle for the wildcard listener is built incorrectly, the loader meets two `CERTIFICATE` blocks and never reaches a `PRIVATE KEY`, so it gives up. Three concrete malformations produce that error reliably:

- The certificate chain is in the wrong order — a CA certificate sits ahead of the leaf, so the leaf is hidden after the loader has already consumed two `CERTIFICATE` blocks.
- The PEM file is corrupted by stray characters: a shell prompt that was accidentally pasted into the buffer, `BEGIN CERTIFICATE` and `END CERTIFICATE` collapsed onto a single line, CRLF line endings, or a UTF-8 BOM at the top of the file.
- Whitespace around the blocks is wrong — extra blank lines between blocks, missing newline before the next `-----BEGIN ...-----`, or a trailing blank line after the last block.

In every case the file looks correct to the eye but fails the strict PEM grammar that Go's `pem.Decode` enforces.

## Resolution

Rebuild the ingress bundle so that it conforms to the loader's expectations, then replace the Secret in place. The bundle for `*.apps.<cluster>` must contain, in this exact order:

1. The leaf wildcard certificate with the right SANs (at minimum `*.apps.<cluster>` and any apex names that share the listener).
2. Each intermediate CA, leaf-to-root.
3. The root CA last.

The matching private key goes in `tls.key` and is **not** concatenated into `tls.crt`.

Validate the bundle locally before applying:

```bash
# 1. The chain must verify against itself end-to-end.
openssl verify -CAfile <(awk '/BEGIN/{n++} n>1' tls.crt) \
              <(awk '/BEGIN/{n++} n==1' tls.crt)

# 2. The leaf must list *.apps.<cluster> as a SAN.
openssl x509 -in tls.crt -noout -text \
  | grep -A1 'Subject Alternative Name'

# 3. The cert and key must share a modulus.
diff <(openssl x509 -in tls.crt -noout -modulus | openssl md5) \
     <(openssl rsa  -in tls.key -noout -modulus | openssl md5)
```

If any step fails, regenerate the file and re-check before pushing it to the cluster.

Then refresh the Secret. With the cluster's ingress controller wired to a Secret named `<wildcard-secret>` in the ingress namespace:

```bash
kubectl -n <ingress-ns> create secret tls <wildcard-secret> \
  --cert=tls.crt --key=tls.key \
  --dry-run=client -o yaml | kubectl apply -f -
```

The ingress controller hot-reloads on Secret update; the auth pods pick the new bundle up on their next watch, so deleting them is rarely needed. Wait one to two minutes, then confirm:

```bash
kubectl -n <auth-ns> get pod -l app=<auth-app-label>
kubectl -n <auth-ns> logs <auth-pod> | tail -20
```

The `Loaded a new cert/key pair` line should now appear without a follow-up fatal.

## Diagnostic Steps

1. Confirm the failing Secret is the one feeding the ingress listener and not a stale copy:

   ```bash
   kubectl -n <ingress-ns> get secret <wildcard-secret> -o yaml \
     | yq '.data."tls.crt"' | base64 -d | openssl x509 -noout -subject -issuer -dates
   ```

   The `Subject` should be the wildcard you intend to publish, and `notAfter` should be in the future.

2. Pull the certificate file out of the Secret and recount the PEM blocks. The bundle must contain at least two blocks (leaf + at least one CA) for a chained wildcard:

   ```bash
   kubectl -n <ingress-ns> get secret <wildcard-secret> \
     -o jsonpath='{.data.tls\.crt}' | base64 -d \
     | grep -c 'BEGIN CERTIFICATE'
   ```

3. Inspect the raw bytes for the malformations called out above. `cat -A` exposes invisible characters; `file` flags BOM/CRLF:

   ```bash
   kubectl -n <ingress-ns> get secret <wildcard-secret> \
     -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/check.crt
   file /tmp/check.crt              # expect: 'ASCII text'
   cat -A /tmp/check.crt | tail     # no '$' alone after the last END line
   head -1 /tmp/check.crt | xxd | head -1   # no 'efbbbf' BOM bytes
   ```

4. Verify the order of the chain: `openssl crl2pkcs7 -nocrl -certfile tls.crt | openssl pkcs7 -print_certs -noout` lists the certificates in file order. The first entry must be the wildcard leaf; CAs must follow leaf-to-root.

5. If the listener still rejects the file after the bundle is correct, check that the controller is reading from the namespace and Secret name you updated — a stale reference (typo in a CR field, or two ingress controllers competing) is a common red herring.
