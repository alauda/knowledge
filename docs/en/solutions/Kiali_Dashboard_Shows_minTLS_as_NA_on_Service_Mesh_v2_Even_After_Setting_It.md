---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Kiali Dashboard Shows minTLS as N/A on Service Mesh v2 Even After Setting It
## Issue

In a v2 service-mesh installation, the Kiali dashboard's mesh-configuration view shows the **minTLS** value as `N/A`. Setting the minimum protocol version on the `ServiceMeshControlPlane` (SMCP) as the docs suggest does not change what Kiali displays:

```yaml
apiVersion: maistra.io/v2
kind: ServiceMeshControlPlane
metadata:
  name: basic
spec:
  security:
    controlPlane:
      tls:
        minProtocolVersion: TLSv1_2
```

Kiali continues to render `N/A` next to the `meshConfig.meshMTLS.minProtocolVersion` label, suggesting the setting was ignored — even though the control plane is actually honouring it at the Envoy level.

## Root Cause

On the v2 mesh-control-plane API (the Maistra `ServiceMeshControlPlane` CRD), the minimum TLS protocol version is propagated to istiod by setting the `TLS_MIN_PROTOCOL_VERSION` **environment variable** on the istiod pod, not by writing `meshConfig.meshMTLS.minProtocolVersion` in the Istio ConfigMap that the in-mesh sidecars read.

Kiali, however, reads the minimum TLS protocol version from exactly one place — `meshConfig.meshMTLS.minProtocolVersion` in the Istio ConfigMap — which on the v2 control plane is never populated. With no value in the ConfigMap, Kiali has nothing to display and falls back to `N/A`.

This is strictly a display-layer gap in Kiali's paired code on the v2 mesh. The control plane is enforcing `TLSv1_2` (or whichever value was set on the SMCP) on actual traffic; only the dashboard readout is wrong. There is no equivalent SMCP v2 API field that surfaces the configured value into `meshConfig.meshMTLS.minProtocolVersion` either — this is validated by:

```bash
kubectl explain smcp.spec.meshConfig --recursive | head
```

The returned field list for v2 only includes `discoverySelectors` and `extensionProviders`; no `meshMTLS` block is available, so there is no user-side YAML tweak on v2 that would cause the Kiali dashboard to start showing the actual value.

By contrast the v3 generation of the mesh control plane (the Sail-operator `Istio` CRD) exposes `spec.values.meshConfig.tlsDefaults.minProtocolVersion` directly:

```bash
kubectl explain istio.spec.values.meshConfig.tlsDefaults
```

and writes it into the ConfigMap where Kiali expects it. The dashboard therefore renders the configured value correctly on v3.

## Resolution

### Preferred: migrate the mesh to v3

Upgrade the service-mesh control plane from the v2 / Maistra API generation to the v3 / Sail-operator API generation. On v3, set:

```yaml
apiVersion: sailoperator.io/v1
kind: Istio
metadata:
  name: default
spec:
  values:
    meshConfig:
      tlsDefaults:
        minProtocolVersion: TLSv1_2
```

The value flows into the Istio ConfigMap; Kiali reads it from there and the dashboard displays the actual minimum TLS version instead of `N/A`. The v2-to-v3 migration is the supported path for this dashboard gap and for several other configuration surfaces that are only available on v3.

### Alternative: upgrade to the Kiali point release that ships the fix

If staying on the v2 control plane in the short term, upgrade to a Kiali build paired with a later v2 operator release that reads the `TLS_MIN_PROTOCOL_VERSION` env var from istiod as a fallback source. After the upgrade, the dashboard renders the configured value without any additional SMCP change. Consult the v2 mesh operator change log for the Kiali version where the fix lands (the upstream issue is tracked under the Kiali-Istio integration series).

If the dashboard still shows `N/A` after this upgrade, the configured value on the SMCP itself may not be taking effect; see the diagnostic steps below.

### Enforcement is unaffected

Regardless of what the dashboard displays, confirm that the actual minimum TLS version on the wire matches intent by inspecting the istiod environment and the Envoy configuration of a representative sidecar. Nothing about this dashboard regression weakens enforcement — the `TLS_MIN_PROTOCOL_VERSION` env var *is* being honored by istiod in v2, and negotiated TLS sessions reflect the configured floor.

### OSS fallback

On upstream Istio + Kiali without the v2 / Maistra operator, the display of `minProtocolVersion` in the Kiali dashboard depends on the field being present in the Istio ConfigMap `mesh` block. If a custom install writes it via Helm values or via `istioctl install`, the Kiali dashboard renders it. Setting TLS floor via istiod env var or CLI flag rather than via `meshConfig` yields the same `N/A` display until the value is also written to the ConfigMap.

## Diagnostic Steps

Confirm that enforcement is correct and that only the dashboard is affected.

1. Verify `TLS_MIN_PROTOCOL_VERSION` is set on istiod:

   ```bash
   kubectl -n <control-plane-ns> get deploy istiod \
     -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="TLS_MIN_PROTOCOL_VERSION")].value}{"\n"}'
   ```

   Expected value: `TLSv1_2` (or whatever was declared in `smcp.spec.security.controlPlane.tls.minProtocolVersion`). An empty response means the SMCP setting did not propagate and the issue is not merely a Kiali readout — the operator needs to be investigated first.

2. Inspect a sidecar's listener TLS context to confirm the actual negotiated floor. Pick any meshed workload pod:

   ```bash
   kubectl -n <ns> exec <pod> -c istio-proxy -- \
     pilot-agent request GET config_dump | \
     jq '.configs[] | select(."@type"|test("ListenersConfigDump")) | .dynamic_listeners[].active_state.listener.filter_chains[].transport_socket' \
     | grep -i tls_minimum_protocol_version
   ```

   Finding `TLSv1_2` (or the configured value) in the sidecar confirms enforcement is in place and the symptom is cosmetic.

3. Confirm the Istio ConfigMap does not carry `meshMTLS.minProtocolVersion` on v2 — this is the proximate cause of Kiali displaying `N/A`:

   ```bash
   kubectl -n <control-plane-ns> get cm istio -o yaml \
     | yq '.data.mesh' \
     | grep -A2 meshMTLS
   ```

   No `minProtocolVersion` field under `meshMTLS` is the expected (and wrong-for-display) v2 shape.

4. Check Kiali's logs for what it actually read:

   ```bash
   kubectl -n <control-plane-ns> logs deploy/kiali --tail=200 | grep -Ei 'minTls|meshMTLS|protocolVersion'
   ```

   If Kiali reports the field as empty in its config-reader, the upgrade path in "Resolution" is the intended fix.
