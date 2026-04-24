---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After upgrading the mesh control plane from an Istio 1.20-era release (for example ACP Service Mesh v2 or the v1 extension) to an Istio 1.24-era release (ACP Service Mesh v2 with a newer control plane, or the standalone Service Mesh v2 extension), external HTTPS requests to internal services that were working before the upgrade now fail at the IngressGateway:

```text
upstream_reset_before_response_started{remote_connection_failure|TLS_error:|268435581:SSL routines:OPENSSL_internal:CERTIFICATE_VERIFY_FAILED}
```

The affected backend services tend to share one pattern: they are served by a Kubernetes `Service` whose TLS certificate was auto-minted by the platform's service-CA machinery (the Secret lives in the service's namespace and is mounted into the workload pods). Adding `tls.insecureSkipVerify: true` to the matching `DestinationRule` makes the failure go away — confirming the problem is certificate validation, not reachability.

## Root Cause

The Istio 1.21 release introduced two security-hardening defaults that propagate forward into 1.24. Both fire silently during an upgrade from an older mesh:

1. `ENABLE_AUTO_SNI` now defaults to **`true`**. Envoy takes the value of the HTTP `Host` header and uses it as the SNI on the upstream TLS handshake. For traffic that enters the mesh from outside with an external hostname (e.g. `my-app.example.com`) and is routed to an internal Service (e.g. `backend.my-ns.svc.cluster.local`), the SNI sent to the backend now does **not** match the backend certificate's Subject Alternative Name. Hostname validation fails before the handshake completes.
2. `VERIFY_CERT_AT_CLIENT` now defaults to **`true`**. Envoy validates the server certificate against the default OS CA bundle shipped with the proxy image. That bundle does not contain the platform's internal service CA, so certificates signed by it are rejected unless the CA is explicitly supplied to the client side.

The pre-upgrade behaviour relied on both defaults being off: no SNI was asserted, and server-cert validation was lax. The new defaults align the mesh with upstream Istio and general TLS best practice, but any `DestinationRule` that used to get away with only `tls.mode: SIMPLE` (no `caCertificates`, no `sni`) will break on upgrade.

## Resolution

Make both settings explicit on every `DestinationRule` that targets a Service which uses the platform's internal service CA. The preferred path on ACP is to stay inside the mesh's native APIs — `DestinationRule` is the contract for controlling how the client side of the mesh authenticates an upstream — rather than re-enable the legacy defaults cluster-wide.

1. **Confirm the service CA is reachable from the IngressGateway pod.** On ACP, each workload pod receives the platform service CA bundle at a well-known path (in most deployments the file projected by the service-account projection includes `service-ca.crt`). Inspect an IngressGateway pod:

   ```bash
   kubectl -n istio-system exec -it <ingressgateway-pod> -- \
     ls /var/run/secrets/kubernetes.io/serviceaccount/
   ```

   If `service-ca.crt` is not there, mount the platform's service-CA ConfigMap explicitly into the gateway deployment:

   ```yaml
   spec:
     containers:
       - name: istio-proxy
         volumeMounts:
           - name: service-ca
             mountPath: /etc/istio/service-ca
             readOnly: true
     volumes:
       - name: service-ca
         configMap:
           name: service-ca.crt   # substitute the actual ConfigMap name on the cluster
   ```

2. **Pin both `caCertificates` and `sni` on the `DestinationRule`.** The `sni` must match a SAN on the backend certificate — typically the internal `<service>.<ns>.svc.cluster.local` FQDN:

   ```yaml
   apiVersion: networking.istio.io/v1beta1
   kind: DestinationRule
   metadata:
     name: backend
     namespace: my-ns
   spec:
     host: backend.my-ns.svc.cluster.local
     trafficPolicy:
       portLevelSettings:
         - port:
             number: 8443
           tls:
             mode: SIMPLE
             caCertificates: /var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt
             sni: backend.my-ns.svc.cluster.local
   ```

   - `caCertificates` points the IngressGateway's Envoy at the platform service CA. Envoy now trusts backend certs signed by that CA and does not need to fall back to the OS bundle.
   - `sni` overrides the new `ENABLE_AUTO_SNI` behaviour. The gateway sends `backend.my-ns.svc.cluster.local` instead of the external `Host:` header, so hostname validation succeeds against the backend's SAN.

3. **Avoid relying on `insecureSkipVerify`.** It silences the diagnostic without actually trusting anything — it reduces the TLS between gateway and backend to encryption without authentication. Use it only as a temporary bypass while the above change is rolled out.

### Fallback when `DestinationRule` is not practical

On clusters where the mesh pre-dates Istio 1.21 and cannot yet be moved to 1.24 defaults, the two knobs can be set to their old values in the Istio installation (e.g. via the control-plane CR's `meshConfig` / `defaultConfig`). Treat this as a transition option: re-enabling the lax defaults across the cluster postpones the migration but does not fix the underlying issue. Convert to explicit `DestinationRule` TLS as soon as the next upgrade window allows.

## Diagnostic Steps

1. **Verify the backend certificate's SAN.** Pull the secret that the service CA populates and decode the certificate:

   ```bash
   kubectl -n my-ns get secret backend-tls \
     -o jsonpath='{.data.tls\.crt}' | base64 -d | \
     openssl x509 -noout -text | grep -A1 "Subject Alternative Name"
   ```

   Confirm the internal FQDN (`backend.my-ns.svc.cluster.local`) is in the SAN list. If not, the service CA contract was not followed — pin the name that actually is in the SAN.

2. **Prove the backend works from inside the namespace.** Run a short-lived debug pod and curl the backend directly with the service CA as the trust bundle:

   ```bash
   kubectl -n my-ns run cert-check --rm -it --restart=Never \
     --image=curlimages/curl:8.10.1 -- \
     curl -v \
       --cacert /var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt \
       https://backend.my-ns.svc.cluster.local:8443/
   ```

   Success here narrows the failure to the gateway's TLS client configuration.

3. **Inspect the IngressGateway's Envoy cluster for the backend.** `istioctl proxy-config` shows exactly what SNI and CA the gateway is sending:

   ```bash
   GATEWAY_POD=$(kubectl -n istio-system get pods \
     -l istio=ingressgateway -o jsonpath='{.items[0].metadata.name}')

   istioctl proxy-config cluster "$GATEWAY_POD" -n istio-system \
     --fqdn backend.my-ns.svc.cluster.local --port 8443 -o json
   ```

   Look for `transport_socket.typed_config.sni` and `transport_socket.typed_config.common_tls_context.validation_context`. Before the fix, `sni` reflects the external `Host` header and `validation_context` lacks the service-CA file.

4. **Reapply the `DestinationRule`.** After applying, repeat step 3. Envoy config updates in seconds; no proxy restart required.
