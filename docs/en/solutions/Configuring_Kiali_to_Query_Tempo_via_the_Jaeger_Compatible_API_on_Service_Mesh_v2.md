---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Service Mesh v2 installation is migrating tracing storage from Jaeger to Tempo while keeping Kiali as the mesh visualization surface. Pointing Kiali's `in_cluster_url` at a native Tempo endpoint — for example the Tempo Gateway, the distributor, or the `/api/traces/v1` multi-tenant route — results in Kiali being unable to load any traces. The Kiali pod's log shows repeated tracing-client errors, and the Kiali UI reports "No traces found" even for workloads that are actively producing spans.

Two separate questions typically come up together:

- Which Tempo endpoint should Kiali point at?
- If the platform console has migrated its UI plugin to the new Distributed Tracing UI (and the old Jaeger UI is deprecated for user display), can the Jaeger Query Frontend be removed, and if so does Kiali still function?

## Root Cause

The Kiali version shipped with Service Mesh v2 only knows how to call the **Jaeger Query API** — it has no client code for Tempo's native gRPC / HTTP routes, and it does not speak the Tempo Gateway's multi-tenant protocol. Native Tempo API support in Kiali is added in the v3 generation of the service-mesh stack. On v2, any attempt to configure Kiali against a Tempo-native endpoint silently returns empty result sets because Kiali is issuing Jaeger-shaped requests against a route that does not serve them.

Tempo itself continues to expose a Jaeger-compatible query surface via its **Jaeger Query Frontend** deployment. That component accepts the same GET `/api/traces/...` verbs Kiali issues and translates them into Tempo reads. As long as the Jaeger Query Frontend is present in front of Tempo, Kiali v2 can read traces from a Tempo backend even though it does not know Tempo exists.

The deprecation of the Jaeger **UI** is a separate concern. The Jaeger UI is the web-browser surface previously exposed on the console; the Jaeger **Query Frontend** is the HTTP API consumed by other clients such as Kiali. Deprecating the UI for end users does not require removing the Query Frontend — Kiali continues to call the Query Frontend for as long as the v2 mesh uses it.

## Resolution

### Point Kiali at the Tempo Jaeger Query Frontend

Configure the Kiali custom resource to use the in-cluster DNS name of the Tempo stack's Jaeger Query Frontend Service, on port 16686 (the default Jaeger HTTP query port):

```yaml
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: <istio-control-plane-ns>
spec:
  external_services:
    tracing:
      enabled: true
      provider: jaeger
      in_cluster_url: http://<tempo-stack>-query-frontend.<tempo-ns>.svc.cluster.local:16686
```

Do **not** point `in_cluster_url` at any of:

- the Tempo Gateway (multi-tenant ingress; wrong shape for Kiali v2);
- the Tempo distributor (write path, not a query surface);
- the native Tempo HTTP routes such as `/api/traces/v1/{tenant}` (Kiali v2 does not issue those).

After saving the Kiali resource, the operator reconciles the new endpoint and the Kiali pod restarts. Trace panels populate on the next refresh.

### Keep the Jaeger Query Frontend deployed

For as long as Kiali is at v2, keep the Tempo Jaeger Query Frontend running. Removing it breaks Kiali's tracing panel even though traces are still being ingested and stored by Tempo. The Query Frontend is lightweight (stateless proxy) and is intended to coexist with the Distributed Tracing UI plugin — the UI plugin talks to Tempo natively while Kiali talks to the Jaeger-compat endpoint.

### Console tracing UI is unaffected

The platform's end-user tracing browser (a console UI plugin backed by the platform observability operator) uses the native Tempo API, not the Jaeger Query Frontend. That plugin remains installable and usable as the primary surface for browsing individual traces. The Jaeger Query Frontend being retained does **not** mean re-enabling a deprecated UI for users — it only means retaining an API-only service consumed by Kiali.

### Future direction: upgrade to service-mesh v3

For a clean removal of the Jaeger Query Frontend, plan the upgrade to the v3 generation of the service-mesh stack. Kiali at v3 speaks Tempo directly and can be pointed at the Tempo native API (for example the Tempo Gateway or a per-tenant distributor-query endpoint). After the upgrade, the `in_cluster_url` can be updated and the Jaeger Query Frontend removed from the Tempo stack. Plan this as part of the v2 → v3 mesh migration, not as a standalone change while still on v2.

### OSS fallback

On a vanilla Istio + Kiali + Tempo stack, the same rule applies: Kiali releases paired with Istio 1.20-era distributions only support the Jaeger Query API; use Tempo's `tempo-query-frontend` Service (port 16686 by default) as Kiali's tracing `in_cluster_url`. Kiali releases aligned with later Istio distributions add native Tempo support via the Tempo Gateway.

## Diagnostic Steps

Confirm that Kiali is failing because of the endpoint choice, not because Tempo is dropping spans.

1. Verify Tempo is actually receiving traces. From a debug pod in the Tempo namespace:

   ```bash
   kubectl -n <tempo-ns> port-forward svc/<tempo-stack>-query-frontend 16686:16686
   curl -s 'http://localhost:16686/api/services' | jq .
   ```

   The response should list the mesh-instrumented service names. If this is empty, the issue is upstream of Kiali and the Tempo ingestion path needs inspection before worrying about Kiali configuration.

2. Read Kiali's effective `in_cluster_url`:

   ```bash
   kubectl -n <control-plane-ns> get kiali kiali -o jsonpath='{.spec.external_services.tracing}{"\n"}'
   ```

   Compare against the Tempo Query Frontend Service name:

   ```bash
   kubectl -n <tempo-ns> get svc | grep query-frontend
   ```

3. From the Kiali pod, test the Jaeger-compat endpoint directly:

   ```bash
   kubectl -n <control-plane-ns> exec -it deploy/kiali -- \
     curl -s 'http://<tempo-stack>-query-frontend.<tempo-ns>.svc.cluster.local:16686/api/services' \
     | jq .
   ```

   A valid JSON response confirms the path Kiali needs. An HTTP 404 or empty response means the wrong Service or port is configured.

4. Inspect Kiali's own log for tracing-client errors:

   ```bash
   kubectl -n <control-plane-ns> logs deploy/kiali --tail=300 | grep -Ei 'tracing|tempo|jaeger'
   ```

   Messages about "unable to connect to tracing backend" or repeated decode errors against an unexpected response body confirm a wrong-endpoint choice rather than a mesh-instrumentation gap.
