---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cluster is configured with a cluster-wide HTTP/HTTPS proxy that performs TLS interception — the proxy re-signs traffic with a custom CA and presents a proxy-issued leaf certificate to the cluster. After upgrading to a release where the platform components are compiled against a modern Go toolchain, outbound HTTPS calls start failing with a parsing error that did not appear before:

```text
tls: failed to parse certificate from server:
  x509: negative serial number
```

The visible blast radius depends on what calls out through the proxy first:

- Update-info retrieval fails. The cluster's version controller logs a `RetrievedUpdates=False` condition with `reason=RemoteFailed` and the `x509: negative serial number` message. No new updates are discovered, the upgrade graph appears empty, and any in-flight upgrade stalls waiting on the graph endpoint.
- Arbitrary outbound HTTPS calls from cluster components (telemetry, operator-hub style catalog fetches, external Git repositories for GitOps) fail with the same error.
- Per-workload `curl`/`wget` calls behind the proxy from pods report the same message.

Nothing appears wrong with the certificate at the human level — it has a valid CN, valid dates, a sensible chain. The failure is specifically about how its serial-number field is encoded.

## Root Cause

[RFC 5280 §4.1.2.2](https://www.rfc-editor.org/rfc/rfc5280#section-4.1.2.2) specifies that the X.509 `serialNumber` field must be a **positive** integer. Some proxy/TLS-inspection appliances generate the serial by hashing or random-draw into a 20-byte buffer without explicitly clearing the sign bit — which, when the high bit is set, produces a negative DER-encoded INTEGER. The certificate is therefore non-compliant, but leaf consumers historically tolerated it.

[Go 1.23](https://pkg.go.dev/crypto/x509#ParseCertificate) tightened the X.509 parser: negative-serial certificates are now rejected by default at `ParseCertificate` time, returning the `x509: negative serial number` error. Components compiled against an older Go runtime (pre-1.23) continued to accept these certificates — so the same proxy that was fine before an upgrade starts breaking specific client flows the moment those clients are rebuilt on 1.23+.

This is not specific to any platform. It is a Go-runtime change surfaced through the platform. Two corollary points:

1. The client-side error cannot be worked around at the TLS layer alone. `InsecureSkipVerify`, CA trust bundles, or custom verify callbacks do not help, because the failure happens at DER-parse time before verification.
2. The failure is certificate-specific, not domain-specific. It will hit every endpoint the proxy re-signs, not only the upgrade-graph endpoint. The upgrade path is just the most visible because the cluster is actively exercising it.

Alauda Container Platform components that talk through the cluster-wide proxy inherit the same Go runtime, so components compiled at 1.23+ will surface the same failure when the proxy presents non-compliant certificates.

## Resolution

Two directions: fix the proxy certificate (the correct long-term fix), or bypass the proxy for the affected endpoints (short-term mitigation). In most environments a combination is practical — mitigate to unblock the upgrade, then remediate.

### Long-term fix — make the proxy certificate RFC 5280 compliant

Ask the team that owns the TLS-inspection appliance to reissue the certificate with a **non-negative** serial number. Concretely:

- The appliance's certificate-generation configuration typically has a "random serial length" or "serial bits" knob. Setting it to 159 bits (one less than a full 20-byte buffer) guarantees the high bit is zero and the DER-encoded integer is positive. Several commercial appliances expose this as a "RFC 5280 strict" toggle.
- If the appliance cannot be reconfigured, export a CSR and re-sign with a tool that enforces a positive serial (`openssl`, `cfssl`, or a scripted reissue that prefixes a `0x00` byte when the high bit of the serial would otherwise be set).
- Deploy the new certificate to the appliance and validate with `openssl s_client -showcerts` (see Diagnostic Steps) before rolling it to production.

This one change fixes **every** affected client in the environment, not just the cluster, so push for it as a wider coordination rather than owning it inside the cluster alone.

### Short-term fix — exclude the affected endpoints from the proxy

While the proxy team schedules the reissue, bypass the proxy for the specific endpoints the cluster needs. This trades the proxy's deep-inspection for direct egress on a small allow-list, which most networking teams will accept as a time-boxed measure.

1. Identify the endpoints that must pass through untouched. At minimum, include the update graph endpoint and any operator-catalog endpoints the cluster depends on for the in-flight upgrade. For each, confirm the certificate is **not** being replaced — step 2 in Diagnostic Steps.

2. Add those domains (or wildcards) to the `noProxy` field of the cluster-wide proxy. Example fragment:

   ```yaml
   apiVersion: config.alauda.io/v1
   kind: Proxy
   metadata:
     name: cluster
   spec:
     httpProxy:  http://proxy.example.com:3128
     httpsProxy: http://proxy.example.com:3128
     noProxy: ".internal.example.com,.svc,.cluster.local,*.updates.example.com"
   ```

   The actual `apiVersion`/`kind` follows the proxy object managed by the platform's cluster-configuration surface — consult `configure/clusters` for the concrete resource.

3. Allow direct egress from the cluster to those endpoints at the upstream firewall. The proxy is no longer in the path, so the firewall must now see those flows directly.

4. Wait for the rendered node configuration to propagate the new `noProxy` value across the pool. The per-node proxy environment in `/etc/...` and in the container runtime will pick up the change after the pool reconcile completes. Verify by retrying the failing call and confirming the negative-serial error is gone.

5. Track the issue so the `noProxy` entries are *removed* once the proxy certificate is reissued — leaving a growing allow-list indefinitely erodes the security posture that justified the proxy in the first place.

### What does not help

- Trusting a different CA, rotating the cluster trust bundle, or adding the proxy CA to `additionalTrustBundle` — the parse error happens before chain validation, so trust configuration is irrelevant.
- Downgrading a component to a pre-Go-1.23 build — the same endpoint will hit other Go-1.23+ clients (other operators, CLI tools) and the problem comes back as soon as those upgrade.
- Pinning to `tls.ClientHelloInfo`-based workarounds — user code cannot intercept the certificate before `ParseCertificate` runs on the Go standard-library TLS path.

## Diagnostic Steps

1. Confirm the cluster-wide proxy is actually configured (if it is not, the x509 error is coming from somewhere else):

   ```bash
   kubectl get proxy cluster -o yaml
   ```

   Check for non-empty `spec.httpProxy` / `spec.httpsProxy`.

2. Capture the exact certificate the proxy presents for the affected endpoint. If the returned chain shows a CA that does *not* belong to the intended service's issuer, the proxy is re-signing:

   ```bash
   # Replace <target-host> with the endpoint that is failing (upgrade graph, catalog, etc.)
   kubectl run tls-debug -it --rm --restart=Never \
     --image=registry.k8s.io/e2e-test-images/agnhost:2.47 \
     -- openssl s_client -connect <target-host>:443 \
         -proxy <proxy-host>:<proxy-port> -showcerts </dev/null
   ```

3. Extract the leaf certificate from the chain and read the serial number. The DER `serialNumber` is printed as a hex or decimal integer — if the first byte (high-order) is ≥ `0x80` the value is negative under RFC 5280 interpretation:

   ```bash
   # Paste the first certificate from step 2 into /tmp/proxy.crt
   openssl x509 -in /tmp/proxy.crt -noout -serial
   ```

   A serial like `-67800F...` or an OpenSSL `-serial` output whose hex representation starts with `FF`/`80..FF` is the smoking gun.

4. Cross-check against the version-controller condition to confirm the same error text is reaching the upgrade path:

   ```bash
   kubectl get clusterversion version -o json \
     | jq '.status.conditions | map(select(.type == "RetrievedUpdates"))'
   ```

   Look for `reason: "RemoteFailed"` and a message containing `x509: negative serial number`.

5. After applying the `noProxy` mitigation, re-run step 4 and verify `RetrievedUpdates=True`. If the condition is still false, the endpoint is either still routed through the proxy (verify `/etc/environment` or the container-runtime env on the node) or the firewall is blocking direct egress.

6. After the proxy certificate is reissued, repeat step 3 and confirm the serial is now a positive integer. Once all clients have picked up the new certificate, you can safely remove the temporary `noProxy` entries and let the proxy resume inspecting those flows.
