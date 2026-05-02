---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# x509 \"certificate has expired\" When the Server Certificate Is Still Valid
## Issue

Browsers, `curl`, `openssl`, and `kubectl` all complain that an HTTPS endpoint's certificate has expired:

```text
* TLSv1.3 (OUT), TLS alert, certificate expired (557):
* SSL certificate problem: certificate has expired
* Closing connection 0
curl: (60) SSL certificate problem: certificate has expired
```

```text
The server is using an invalid certificate:
x509: certificate has expired or is not yet valid:
current time 2025-01-01T00:00:00Z is after 2024-12-31T23:59:59Z
```

The endpoint's leaf certificate, however, is **valid** — checking it directly with `openssl x509 -dates` shows `notAfter` well in the future. Refreshing the leaf does not help: the same client and the same hostname keep reporting expiry. To complicate the picture further, only **some** machines see `x509: certificate signed by unknown authority` for the same endpoint, while others see `expired`. A subset see no error at all.

The shape of this problem is almost always one of three things, and each has a different fix:

1. An **intermediate CA** in the chain has expired, but the leaf is still in date.
2. A **proxy or load balancer** in the path is presenting a different (expired) certificate than the back-end serves.
3. A **local trust store** on the affected machines holds an expired or stale CA that no longer chains to the server's leaf.

## Root Cause

A TLS handshake's "certificate is valid" decision requires the **entire chain** — leaf, every intermediate, root — to be in date and signed correctly. The TLS spec lets a server omit the chain (sending only the leaf) and trust that clients will rebuild it from their local store; it lets a server send the full chain; and it lets a server send a partial chain. Different clients on the same machine will see different errors depending on what is sent versus what the local store offers.

Concretely:

- If the server sends only the leaf and the client's local trust store contains an intermediate that has since **expired**, chain construction picks up that expired intermediate and the handshake fails with "expired" — **even though the leaf is fine**.
- If the server sends a chain whose intermediate has expired, every client that walks that chain to the server-supplied intermediate will see "expired".
- If the server sends only the leaf and the client's local store does not have the relevant intermediate at all, the client cannot build a chain to a trusted root and reports "signed by unknown authority".
- If a transparent proxy or TLS-inspecting load balancer sits between client and server, the proxy presents *its own* certificate. If the proxy's cert (or its issuing CA) has expired, the client sees "expired" regardless of what the back-end serves.

The investigation must therefore separate three questions: what does the **server** present, what does the **proxy** (if any) present, and what does the **client's local trust store** add to the chain. Each of these can be tested independently.

The remediation principle is unambiguous: the **server** should always present its full chain (leaf + every intermediate, in order). Any client- or proxy-side patching is a stop-gap; the only durable fix is on the server side.

## Resolution

Walk the diagnostic in the order below, then apply the fix that matches what was found.

### Path A — Server sends an incomplete chain

If the certificate chain returned by the server contains only the leaf (or omits an intermediate that the client needs), reconfigure the server to present the full chain. Concrete steps depend on what is terminating TLS:

- **Cluster-managed Ingress / load-balancer.** Place the full chain in the `tls.crt` field of the secret backing the Ingress. The order matters: leaf first, then each intermediate from leaf-issuer up toward the root; the root itself is optional. After updating the secret, the controller picks up the change automatically.

  ```bash
  cat leaf.crt intermediate1.crt intermediate2.crt > fullchain.crt
  kubectl create secret tls <secret-name> \
    --cert=fullchain.crt --key=leaf.key \
    --dry-run=client -o yaml | kubectl apply -f -
  ```

- **Cluster API server.** The platform's certificate-management surface for the API server (`security/cert`) accepts a named-certificate entry where the `tls.crt` is the full chain, same ordering as above. The exact CR / secret schema is owned by the platform's API-certificate configuration — consult `security/cert` for the version-specific resource.

- **A non-cluster terminator (HAProxy, Nginx, an appliance LB).** The same rule applies — concatenate the leaf and intermediates in the appropriate config field (`ssl_certificate` for Nginx, `crt` directive for HAProxy) and reload.

After reconfiguring, retest with `openssl s_client -showcerts` (Diagnostic Steps step 2). The `Certificate chain` block should now list every intermediate the leaf needs.

### Path B — Proxy in the path presents an expired certificate

If a proxy is intercepting TLS, the failing certificate is the proxy's, not the server's. Two indicators:

1. `curl --noproxy '*' https://<server>` (run from the same machine, bypassing the proxy) **succeeds** while the unmodified call fails.
2. The certificate returned by `openssl s_client -connect <server>:443` shows an issuer that does **not** belong to the server's published CA — typically a private CA owned by the network team.

Hand the issue to the proxy/network team: rotate the proxy certificate (or its intermediate) so that nothing in the proxy-presented chain is expired. The cluster cannot fix this; trying to bypass it with `InsecureSkipVerify` or by stuffing the proxy CA into client trust stores hides the underlying expiry rather than resolving it.

### Path C — Local trust store on a subset of machines is stale

If the same endpoint works from machine A and fails from machine B, and Path B is ruled out, the difference is the local trust store. Path C is a narrow stop-gap:

- Update the local trust store on the affected machine. The exact steps depend on the client's OS and certificate-store conventions.
- Where the cluster supplies an additional trust bundle (for example, custom CAs configured for cluster components to trust), confirm that bundle does not contain an expired version of an intermediate that is now superseded.

This only fixes the one machine. The right long-term fix is still Path A — make the server send a chain that is self-sufficient and does not depend on any particular client trust store containing an extra intermediate.

### Why "the certificate is valid" is misleading

When the operator says "the certificate is valid", they mean the **leaf**. TLS does not care about leaf-only validity; it cares about the entire chain that the verifier walks. An expired intermediate still in the local store, or supplied by a proxy, will make a perfectly valid leaf appear expired. The fix is to ensure the chain — wherever it is constructed — does not include any expired link.

Alauda Container Platform's certificate-management surface (`security/cert`) covers Ingress, API-server, and component certificates; for cert-manager-based automated rotation, refer to the same surface for the supported `Issuer` / `ClusterIssuer` patterns.

## Diagnostic Steps

1. Confirm the leaf is in date. Pulls the certificate from the configured secret (replace placeholders for the actual API certificate name in your environment):

   ```bash
   kubectl -n <namespace> get secret <cert-secret> \
     -o json | jq -r '.data."tls.crt"' | base64 -d \
     | openssl x509 -dates -subject -noout
   ```

   `notBefore` should be in the past, `notAfter` in the future. If the leaf is already expired, that is a different problem — replace the leaf.

2. Capture what the server actually presents on the wire. Pay attention to the `Certificate chain` block and to per-cert `notAfter`:

   ```bash
   openssl s_client -connect <server>:443 -showcerts </dev/null 2>&1 \
     | sed -n '/Certificate chain/,/-----END CERTIFICATE-----/p'
   ```

   For each certificate in the block, copy it into a file and check expiry:

   ```bash
   for f in /tmp/chain-*.crt; do
     echo "=== $f ==="
     openssl x509 -in "$f" -noout -subject -issuer -dates
   done
   ```

   The `Certificate chain` block lists certificates the server sent. Anything **not** listed there but needed for verification has to come from the local trust store — that is where Path C comes in.

3. Distinguish a proxy in the path from a direct connection. Run the same call without any proxy:

   ```bash
   curl --noproxy '*' -v https://<server>:443/ </dev/null 2>&1 | head -50
   ```

   If this succeeds while the proxied call fails, the proxy is presenting the bad certificate (Path B).

4. Identify which intermediate is expired. From the `openssl s_client` output, the verify trace prints each `depth=` step and any per-step `verify error`. An entry like:

   ```text
   depth=1 ... CN = Example CA 2
     verify error:num=10:certificate has expired
     notAfter=Dec 31 23:59:59 2024 GMT
   depth=0 ... CN = api.example.com
     notAfter=Dec 31 23:59:59 2028 GMT
   ```

   says the intermediate at depth 1 is expired while the leaf at depth 0 is fine — Path A applies to the server (have it present a non-expired intermediate).

5. If multiple certificates share the same secret/file, `openssl x509` only inspects the first. Use `openssl crl2pkcs7` + `openssl pkcs7` to enumerate all of them in a multi-cert PEM:

   ```bash
   openssl crl2pkcs7 -nocrl -certfile fullchain.crt \
     | openssl pkcs7 -print_certs -noout
   ```

6. If Path C applies, inspect the local trust store to find the expired intermediate. The `CAfile` and `CApath` are reported by `openssl s_client -CAfile` debug output:

   ```text
   * successfully set certificate verify locations:
   *   CAfile: /etc/pki/tls/certs/ca-bundle.crt
   *   CApath: none
   ```

   Search the bundle for expired entries:

   ```bash
   awk '/-----BEGIN CERTIFICATE-----/{i++; f="/tmp/cert."i".pem"} {print > f}' \
     < /etc/pki/tls/certs/ca-bundle.crt
   for f in /tmp/cert.*.pem; do
     openssl x509 -in "$f" -noout -checkend 0 \
       || echo "EXPIRED: $(openssl x509 -in $f -noout -subject)"
   done
   ```

7. After applying the relevant fix (server-side chain rebuild, proxy cert rotation, or local trust update), repeat step 2 and confirm every certificate in the chain has a future `notAfter`. The handshake error should not recur.
