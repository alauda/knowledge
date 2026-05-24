---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Service Mesh v3 mTLS Fails with "upstream connect error" When Certificates Lack clientAuth EKU
## Issue

After installing or upgrading the platform service-mesh stack to its v3 generation (Istio + sidecar/Ambient with the Sail-operator API), east-west traffic between meshed workloads stops working as soon as workload mTLS is in effect. Any pod-to-pod request through the sidecar fails with:

```text
upstream connect error or disconnect/reset before headers.
reset reason: connection termination
```

The same workloads worked under the previous mesh generation, the application code is unchanged, and DNS / Service routing is healthy. The failure is reproducible with a trivial probe between two meshed pods:

```bash
for i in {0..9}; do
  kubectl exec -n sample deploy/sleep -c sleep -- \
    curl -sS helloworld.sample:5000/hello
done
upstream connect error or disconnect/reset before headers.
retried and the latest reset reason: connection termination
```

When the deployment was on the v2 generation of the mesh, the same probe returned the application response (`Hello version: v1, ...`) without changes to the certificates. After the v3 cutover the same certificates produce connection terminations.

## Root Cause

In v3 of the platform service mesh, the Istio control plane (and the sidecars / ZTunnels it programs) enforces a stricter validation of any externally provisioned mTLS certificate. The relevant rule is on the **Extended Key Usage (EKU)** X.509v3 extension:

A certificate that participates in workload mTLS must declare **both**:

- `TLS Web Server Authentication` (OID `1.3.6.1.5.5.7.3.1`)
- `TLS Web Client Authentication` (OID `1.3.6.1.5.5.7.3.2`)

If the EKU extension is **present but only lists `serverAuth`**, the certificate is *legally restricted* (in the X.509 sense) to server-side use. The sidecar acting as a client during mTLS is now formally forbidden from presenting that certificate as a client identity, the TLS handshake aborts, and Envoy reports `connection termination` to the calling workload.

Two adjacent cases for context:

- A certificate with **only** `clientAuth` is symmetrically forbidden from acting as a TLS server, and produces the same symptom in the opposite direction.
- A certificate with **no EKU extension at all** is unconstrained and accepted by the v3 control plane in either role — this is why some clusters never trip on the issue. It is, however, the weakest posture and not recommended.

The v2 mesh generation accepted server-only EKU certificates in mTLS; v3 enforces the stricter, more correct interpretation. This is a behavioral change at the cutover, not a regression — but any externally minted root, intermediate, or workload certificate that was generated with `serverAuth`-only EKU will need to be re-issued.

## Resolution

### Re-issue the affected certificates with both EKU OIDs

The fix is to regenerate the certificates being used by the mesh — root CA, intermediate CA, and any workload-level certificates if they are managed manually — to include both `serverAuth` and `clientAuth` in the Extended Key Usage extension. Update the OpenSSL configuration block used by the CSR generation or the CA signing template:

```text
[v3_ext]
extendedKeyUsage = serverAuth, clientAuth
```

Reissue the certificates with the corrected EKU. Verify the new certificate carries both OIDs:

```bash
openssl x509 -in cert.pem -text -noout | grep -A 1 "Extended Key Usage"
```

The expected output:

```text
X509v3 Extended Key Usage:
    TLS Web Server Authentication, TLS Web Client Authentication
```

If only one of the two is listed, the regeneration did not pick up the corrected `[v3_ext]` block — re-check the OpenSSL config file path passed to `openssl req` / `openssl ca`.

### Update the mesh's mTLS Secret and roll the control plane

Replace the certificate material in the Secret consumed by istiod (commonly named `cacerts` in the istio control-plane namespace; the exact name depends on how the mesh was provisioned):

```bash
kubectl -n <istio-control-plane-ns> create secret generic cacerts \
  --from-file=ca-cert.pem \
  --from-file=ca-key.pem \
  --from-file=root-cert.pem \
  --from-file=cert-chain.pem \
  --dry-run=client -o yaml | kubectl apply -f -
```

Restart istiod and the application pods so they pick up the rotated material:

```bash
kubectl -n <istio-control-plane-ns> rollout restart deploy/istiod
# Then restart application pods so sidecars get fresh workload certs
kubectl -n <app-ns> rollout restart deploy/<app>
```

After the rollouts complete, the meshed-pod probe above should once again return the application response.

### Use cert-manager for ongoing rotation

For long-term hygiene, mint mesh certificates through cert-manager rather than out-of-band OpenSSL. A `Certificate` resource declares the EKU set explicitly, so the constraint is encoded in YAML and not in a hand-edited OpenSSL config:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: mesh-intermediate-ca
  namespace: <istio-control-plane-ns>
spec:
  isCA: true
  secretName: cacerts
  usages:
    - server auth
    - client auth
    - cert sign
    - crl sign
  issuerRef:
    name: <root-issuer>
    kind: ClusterIssuer
```

The `usages` list translates directly into the X.509v3 Key Usage and Extended Key Usage extensions, including both `server auth` and `client auth`, so renewal cycles do not silently drop one of the two OIDs.

### OSS fallback

On a vanilla upstream Istio (1.22+) without the platform's mesh operator, the same EKU rule applies: workload mTLS requires both `serverAuth` and `clientAuth` in the EKU when the extension is present. The OpenSSL `[v3_ext]` block above and the `openssl x509 -text` verification step are identical. The fix path is the same — replace `cacerts`, restart istiod, restart application pods.

## Diagnostic Steps

Pin the failure to certificate EKU rather than mTLS being misconfigured at the mesh policy layer.

1. Reproduce the symptom from a known-meshed source pod against a known-meshed destination Service:

   ```bash
   kubectl exec -n <ns> deploy/<source> -c <source-container> -- \
     curl -sS http://<dest-svc>.<ns>:<port>/<path>
   ```

   `upstream connect error ... reset reason: connection termination` is the expected v3-EKU-failure shape. A different reset reason (for example `local_reset`, `tls_handshake_error` with a specific subreason) points elsewhere — for example to a missing `PeerAuthentication` or `DestinationRule`.

2. Read Envoy's perspective on the failed handshake from the source pod:

   ```bash
   kubectl exec -n <ns> deploy/<source> -c istio-proxy -- \
     curl -s http://localhost:15000/logging?config=debug
   # Trigger one failing call, then:
   kubectl logs -n <ns> deploy/<source> -c istio-proxy --tail=200 \
     | grep -Ei 'tls|x509|eku|client.*auth|cert.*verify'
   ```

   Look for `client cert chain ... not allowed for client authentication` or similar phrasing. That is the X.509 EKU-rejection message and confirms the root cause.

3. Inspect the certificate currently mounted in the sidecar:

   ```bash
   kubectl exec -n <ns> deploy/<source> -c istio-proxy -- \
     openssl s_client -showcerts -connect <dest-svc>.<ns>:<port> </dev/null 2>/dev/null \
     | openssl x509 -text -noout \
     | grep -A1 "Extended Key Usage"
   ```

   If the EKU lists only `TLS Web Server Authentication`, the workload certificate is the one that needs reissuing.

4. Inspect the root and intermediate CA certificates packaged in the istiod Secret:

   ```bash
   kubectl -n <istio-control-plane-ns> get secret cacerts \
     -o jsonpath='{.data.ca-cert\.pem}' | base64 -d \
     | openssl x509 -text -noout | grep -A1 "Extended Key Usage"
   ```

   If the issuing CA itself is missing `clientAuth`, every workload certificate signed by it is silently restricted to server use, and reissuing only the leaf certificates will not help — the CA must be reissued first, then leaves rotated to chain off the corrected CA.

5. After the rotation and rolling restart, re-run step 1; the application response should replace the connection-termination message.
