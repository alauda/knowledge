---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Running Multiple Kiali Instances Against Separate Istio Control Planes
## Issue

When more than one Istio control plane is deployed on the same cluster — for example, one per tenant or per environment — every Kiali instance ends up surfacing the same merged telemetry. Workloads from tenant A appear in the Kiali console of tenant B, mesh topology graphs combine traffic across control planes, and operators cannot reason about a single mesh in isolation.

The visible symptoms are: Kiali shows workloads it should not see, request graphs include unrelated services, and metric counters tally traffic from foreign namespaces. Logically each Kiali should be scoped to exactly one control plane and report on exactly the data planes attached to that revision; instead all dashboards converge on the same picture.

## Root Cause

Kiali discovers what to render from two independent inputs and both must be scoped per control plane:

- The **Istio configuration model**: which `IstioRevision` (or equivalent control-plane object) Kiali is bound to, and which workload labels (`istio.io/rev=<revision>`) carry the sidecars it should consider in its mesh.
- The **metrics back end**: a single shared Prometheus that ingests `ServiceMonitor` / `PodMonitor` data from every control plane returns merged data unless the scrape targets and the queries are pre-filtered.

Common configuration mistakes that converge to the same symptom:

- Missing or wrong `meshConfig.discoverySelectors` on each control plane, so each control plane sees every namespace.
- Workloads in a tenant namespace not labelled with the matching `istio.io/rev`, so a workload is "claimed" by the wrong control plane.
- Kiali's `deployment.discovery_selectors` left at default — Kiali then enumerates everything Prometheus can see.
- Prometheus scraping `15090` (Envoy metrics) and the control-plane ports (`15012`, `15017`) without a per-mesh label that Kiali can use to filter.
- `NetworkPolicy` either too permissive (cross-tenant scrape allowed) or too restrictive (Prometheus blocked from reaching one of the meshes), so the picture in Kiali is wrong by extra data or by missing data.

## Resolution

### Preferred path on ACP

In ACP the **Service Mesh** capability (`docs/en/service_mesh/`, both v1 and v2 variants based on Istio) treats Kiali as part of the mesh control-plane lifecycle. Declare each Kiali instance through the corresponding mesh control-plane resource and let the controller pin Kiali to the mesh's Istio revision and to the discovery selector of that mesh. With that wiring, multi-tenancy on the data plane (one mesh, one Kiali, one set of `discoverySelectors`) is the default and the cross-tenant leak described above does not occur.

For the metrics back end, ACP **Observability — Monitor** (`docs/en/observability/monitor/`) provides the Prometheus / Thanos stack, and `ServiceMonitor` / `PodMonitor` are the same upstream CRDs used by the mesh. The configuration model below applies one-to-one.

### Underlying mechanics — wiring two meshes side by side

The walk-through assumes two control planes named `default` (in namespace `istio-system1`) and `default2` (in namespace `istio-system2`), with tenant workloads carrying labels `tenant: tenant-a` and `tenant: tenant-b` respectively.

1. **Scope each control plane with `discoverySelectors`.** Each revision should see only its own tenant namespaces:

   ```yaml
   apiVersion: sailoperator.io/v1
   kind: IstioRevision
   metadata:
     name: default
   spec:
     namespace: istio-system1
     updateStrategy:
       type: InPlace
     values:
       meshConfig:
         discoverySelectors:
           - matchLabels:
               tenant: tenant-a
     version: v1.27.5
   ```

   ```yaml
   apiVersion: sailoperator.io/v1
   kind: IstioRevision
   metadata:
     name: default2
   spec:
     namespace: istio-system2
     updateStrategy:
       type: InPlace
     values:
       meshConfig:
         discoverySelectors:
           - matchLabels:
               tenant: tenant-b
     version: v1.27.5
   ```

   Verify both revisions reach `Healthy`:

   ```bash
   kubectl get istiorevision -A
   ```

2. **Bind each Kiali to its revision.** In each Kiali CR, set `deployment.discovery_selectors` to the `istio.io/rev` label that matches the control plane:

   ```yaml
   spec:
     deployment:
       discovery_selectors:
         default:
           - matchLabels:
               istio.io/rev: default     # second instance uses default2
   ```

   Workloads must carry the correct `istio.io/rev=<revision>` label (typically by labelling the namespace and letting injection apply the revision label). A workload with the wrong revision label will appear in the wrong Kiali.

3. **Per-mesh scrape configuration.** For each control-plane namespace, create a `ServiceMonitor` for control-plane components and a `PodMonitor` for sidecars. Add the mesh-identifying labels Kiali expects (`app`, `version`, `namespace`, `mesh_id`) so that downstream queries can filter by mesh:

   - `ServiceMonitor` → control-plane namespace (one per mesh).
   - `PodMonitor` → control-plane namespace **and** every application namespace attached to that mesh.

   Required port coverage: `15090` (sidecar metrics), `15012`, `15017` (control-plane). Application traffic ports are scraped through the standard service/pod selectors.

4. **NetworkPolicy that mirrors the topology.** Each mesh namespace and tenant namespace gets a `NetworkPolicy` that:

   - Allows monitoring components to reach `15090` on sidecars.
   - Allows the corresponding control-plane namespace to reach pods on `15012` and `15017`.
   - Allows DNS egress.
   - Allows ingress only from the matching ingress gateway (if applicable).

   A minimal example for one tenant namespace, scoped to a single control plane and a single monitoring namespace:

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: allow-mesh-and-monitoring
     namespace: tenant-a
   spec:
     podSelector: {}
     policyTypes:
       - Ingress
       - Egress
     ingress:
       - from:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: istio-system1
             podSelector:
               matchLabels:
                 istio: ingressgateway
       - from:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: monitoring
           ports:
             - port: 15090
               protocol: TCP
       - from:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: istio-system1
           ports:
             - port: 15012
               protocol: TCP
             - port: 15017
               protocol: TCP
     egress:
       - to:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: kube-system
           ports:
             - port: 53
               protocol: UDP
             - port: 53
               protocol: TCP
       - to:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: istio-system1
           ports:
             - port: 15012
               protocol: TCP
             - port: 15017
               protocol: TCP
       - to:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: monitoring
   ```

   Substitute `istio-system1` / `tenant-a` for the second mesh's equivalents to wire `tenant-b`.

5. **Generate traffic and confirm isolation.** Drive a request through one tenant's ingress gateway and verify it shows up only in the matching Kiali, not the other:

   ```bash
   curl -k https://<tenant-a-ingress>/<path>
   ```

## Diagnostic Steps

Confirm each control plane sees only its declared namespaces:

```bash
kubectl get ns -L istio.io/rev,tenant
kubectl get pod -A -L istio.io/rev | grep -v '^NAMESPACE\|none\|<none>'
```

Every workload in a tenant namespace should carry one and only one `istio.io/rev` label, matching the mesh that namespace belongs to.

Confirm Kiali's discovery scope at runtime:

```bash
kubectl -n istio-system1 get kiali -o yaml | grep -A4 discovery_selectors
```

If Kiali still surfaces foreign workloads after applying the selectors, check Prometheus targets — a single Prometheus scraping all sidecars without per-mesh label filtering will defeat Kiali-side selection. Tag scrape jobs with a stable `mesh_id` and use that label in Kiali's external-services Prometheus URL when more than one Prometheus exists, or pre-filter in the `ServiceMonitor` / `PodMonitor` `selector`.
