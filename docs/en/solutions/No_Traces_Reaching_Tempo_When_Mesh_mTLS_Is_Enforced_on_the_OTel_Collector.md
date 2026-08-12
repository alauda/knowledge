---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# No Traces Reaching Tempo When Mesh mTLS Is Enforced on the OTel Collector
## Issue

On a cluster running ACP Service Mesh together with ACP OpenTelemetry v2 and a Tempo backend, the Jaeger-compatible dashboard that fronts Tempo reports zero services and zero traces, no matter how much traffic is generated inside the mesh. Symptoms:

- The OpenTelemetry Collector pod is healthy and has no error logs against Tempo.
- Tempo components (distributor, ingester, querier) show no write failures and no rejected spans.
- Every workload in the mesh is reachable end-to-end; user traffic flows normally.
- Sidecar (`istio-proxy`) logs on the source workloads report span emission to the collector's service FQDN, but those emissions never land on the collector.

## Root Cause

The OpenTelemetry Collector is running **without** an Istio sidecar (this is the recommended topology — the collector should not itself be a mesh participant). When mesh-wide or namespace-scoped `PeerAuthentication` enforces `STRICT` mTLS, every `istio-proxy` initiates the span export connection as a TLS client and expects a mesh peer certificate on the other side. The collector's service endpoint answers in plaintext gRPC/HTTP, so the TLS handshake fails silently from the proxy's perspective — the proxy records a connection error, the span is dropped, and no trace ever reaches Tempo.

This is the same pattern that already requires exceptions for other non-mesh services that mesh clients talk to (the API server, the identity/auth dashboard, cluster DNS, etc.). The collector needs the same carve-out.

## Resolution

### ACP-preferred path: declare the collector endpoint as plaintext via a mesh `DestinationRule`

ACP Service Mesh exposes the upstream Istio traffic-policy CRDs directly, so a `DestinationRule` that disables TLS for the collector's FQDN is sufficient. Apply it in the control-plane namespace (so it is honored mesh-wide) or in every namespace where mTLS is enforced.

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: otel-collector
  namespace: istio-system
spec:
  host: otel-collector.istio-system.svc.cluster.local
  trafficPolicy:
    tls:
      mode: DISABLE
```

```bash
kubectl apply -f otel-collector-dr.yaml
```

No restart is required. The policy propagates to every proxy via xDS within a few seconds. Generate a small burst of traffic through the mesh and refresh the tracing UI; services and spans should begin appearing once Tempo has flushed the batch to its backing store.

Two operational notes:

- Keep the collector **outside** the mesh. Putting a sidecar on the collector makes the collector itself a mesh peer, which creates a second mTLS leg that complicates the failure surface and does not buy any real security on the internal span path.
- If the collector is deployed in a namespace different from the mesh control-plane namespace, either create one `DestinationRule` per enforcing namespace or place a single mesh-scoped `DestinationRule` in the control-plane namespace. A namespace-scoped `DestinationRule` only affects clients **in that namespace**, not the target host globally.

### OSS fallback: same `DestinationRule`, applied directly to an Istio install

On a cluster running bare Istio (without the ACP Service Mesh wrapper), the manifest above is unchanged — `DestinationRule` is a first-class Istio CRD. Ensure the `istiod` is configured to push traffic policies to the ingress/egress gateways too if the collector is being reached from either; the `mode: DISABLE` applies per client sidecar based on the host match.

## Diagnostic Steps

1. Confirm that mTLS is in fact being enforced at the relevant scope. A mesh where `PeerAuthentication` is `PERMISSIVE` will not produce this symptom:

   ```bash
   kubectl get peerauthentication -A
   kubectl get destinationrule -A
   ```

2. Inspect the active Istio control-plane resource to see which mode the operator has rolled out:

   ```bash
   kubectl get istio -o yaml
   ```

3. Raise the sidecar log level on one source workload to surface the TLS failure. With the ACP Service Mesh bundle, use the mesh CLI's process-control commands to set logging per-pod:

   ```bash
   istioctl ps
   istioctl pc log <source-pod> --level tracing:debug
   ```

4. Tail the sidecar's container logs for failed export attempts to the collector FQDN:

   ```bash
   kubectl logs <source-pod> -c istio-proxy
   ```

   A client-side TLS handshake failure against `otel-collector.<ns>.svc.cluster.local` confirms the diagnosis.

5. After the fix, reset the temporary log level so you are not burning CPU on the proxy:

   ```bash
   istioctl pc log <source-pod> -r
   ```

6. Verify end-to-end by curling a service through the mesh, then refreshing the tracing UI. Tempo may need a few seconds to flush spans to its object store before the frontend shows them; a couple of page reloads is normal.
