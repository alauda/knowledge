---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Exposing an external endpoint as a cluster Service via a manual Endpoints object

## Issue

Workloads inside an ACP cluster often need to reach an external host (database, legacy app server, third-party API) by a stable in-cluster DNS name such as `<service-name>.<ns>.svc.cluster.local`, rather than by hard-coding the external IP and port into every Pod. The standard Kubernetes pattern for this — a `Service` with no `.spec.selector` plus a hand-crafted `Endpoints` object — relies on the cluster *not* auto-populating Endpoints when the selector field is empty, so that the administrator's manually supplied backends are the ones the cluster's service proxy data plane uses.

The recipe is built on plain upstream primitives. On a typical ACP install (Kubernetes `v1.34.5`, Kube-OVN `v1.15.x` as the cluster CNI) both `Service` (core/v1) and `Endpoints` (core/v1) are served by the apiserver with no ACP-specific shape or field renames, so the pattern is portable verbatim from upstream Kubernetes documentation.

## Root Cause

The in-tree endpoints controller built into Kubernetes typically populates the Endpoints object for a Service only when the Service carries a `.spec.selector`. With the selector omitted, the controller follows the documented shape of leaving the field user-managed; the cluster admin is then both free and required to create an Endpoints object with the same name and namespace as the Service to define the backend set.

Although `kubectl explain endpoints` now marks the core/v1 Endpoints API as legacy, the apiserver still accepts writes on ACP Kubernetes 1.34 (a deprecation warning is emitted on stderr but the create succeeds). A manually-created Endpoints object is mirrored into a matching EndpointSlice by the in-tree `endpointslice-mirroring` controller, so the cluster's service proxying surface — typically the combination of kube-proxy and the Kube-OVN CNI consuming Service plus Endpoints/EndpointSlice from the apiserver — resolves the Service VIP to the external IP recorded in the manual Endpoints.

## Resolution

Create two objects in the same namespace, with **identical** `metadata.name`. First the selector-less Service, advertising the in-cluster ports that consumers will dial:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-db
  namespace: app
spec:
  ports:
    - name: pg
      port: 5432
      targetPort: 5432
      protocol: TCP
```

Then the matching Endpoints object, listing the external host IP under `subsets[].addresses[].ip` and the external listener port under `subsets[].ports[].port`:

```yaml
apiVersion: v1
kind: Endpoints
metadata:
  name: external-db
  namespace: app
subsets:
  - addresses:
      - ip: 10.20.30.40
    ports:
      - port: 5432
        protocol: TCP
```

Once both objects are applied, Pods inside the cluster reach the external host by dialing `<service-name>:<service-port>` (here `external-db:5432`); cluster DNS resolves the name to the Service VIP, and the cluster's service proxy data plane forwards to the external IP recorded in Endpoints.

No ACP-specific fields or annotations are involved. The two objects above follow the standard upstream Kubernetes resource shape and can be applied with the usual `kubectl apply -f` workflow.

## Diagnostic Steps

After applying the pair, confirm that the Service genuinely has no selector — an empty result here is the signal that the endpoints controller will not overwrite the manual Endpoints with its own:

```bash
kubectl -n app get svc external-db -o jsonpath='{.spec.selector}'
```

Confirm that the manual Endpoints carries the expected external IP and port set:

```bash
kubectl -n app get endpoints external-db
```

Confirm that a matching EndpointSlice exists — its presence indicates the in-tree mirroring controller has reflected the manual Endpoints into the modern discovery API surface:

```bash
kubectl -n app get endpointslices -l kubernetes.io/service-name=external-db
```

From inside a Pod in the same cluster, verify that DNS resolves the Service name to the Service VIP. A `getent hosts` against the FQDN demonstrates the VIP is published; a `curl` against the Service DNS name will then complete the round-trip when the external host has a listener on the configured port:

```bash
getent hosts external-db.app.svc.cluster.local
curl -v external-db.app.svc:5432
```
