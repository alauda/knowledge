---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After upgrading from Service Mesh v2 to v3, applications that egress to an external host via a `ServiceEntry` with `resolution: DNS` start receiving `HTTP 404` from the internet gateway or the upstream service. The same `ServiceEntry` manifest had been working on v2 unchanged: the hostname, ports, resolution mode, and upstream proxy configuration are all identical.

Traffic reaches the sidecar, but the sidecar never issues a DNS lookup for the hostname declared in the `ServiceEntry`. Instead, the destination address reaches the `tcp-proxy` / passthrough cluster and the upstream gateway returns 404 because the `Host:` header or SNI does not match any configured virtual host.

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: external-svc
spec:
  hosts:
    - tcp-echo.external.svc.cluster.local
  ports:
    - name: external-svc
      number: 9000
      protocol: TCP
  resolution: DNS
```

## Root Cause

`resolution: DNS` on a `ServiceEntry` only does the right thing if the sidecar is *also* intercepting the pod's DNS queries through Istio's DNS capture feature. DNS capture is controlled by the proxy metadata key `ISTIO_META_DNS_CAPTURE`. When it is `true`, the sidecar's in-proxy DNS table resolves the `ServiceEntry` hostnames, hands the correct upstream endpoint to the listener, and the Host header / SNI survive the hop. When it is `false`, the sidecar falls back to the pod's native resolver; the hostname is looked up in the cluster DNS (CoreDNS) scope, does not resolve to a real upstream, and the connection defaults to the passthrough cluster.

On Service Mesh v2 the control plane shipped a default mesh-config that set `ISTIO_META_DNS_CAPTURE: 'true'` for every injected proxy. The v3 control plane changed the default: it no longer stamps DNS capture onto the proxy metadata. Existing manifests that relied on the v2 implicit default therefore break after the upgrade.

The failure mode is cosmetic rather than fatal — the connection completes and a 404 comes back — so operators often chase routing or upstream misconfiguration first. The real fix is to put DNS capture back.

## Resolution

ACP ships managed Istio control planes through the `service_mesh` capability area. The preferred path is to enable DNS capture per workload through a Service Mesh v2-compatible annotation on the Deployment, so the behaviour is pinned to the pod and survives future control-plane default changes. If the annotation path is not available (vendor-specific chart strip-down, for example), the plain upstream Istio fallback is to set the same key via a `Sidecar` or `ProxyConfig` resource.

### ACP-preferred path: annotate the workload

Add `proxy.istio.io/config` to the pod template and pin `ISTIO_META_DNS_CAPTURE: "true"`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    metadata:
      annotations:
        proxy.istio.io/config: |
          proxyMetadata:
            ISTIO_META_DNS_CAPTURE: "true"
    spec:
      containers:
        - name: app
          image: myorg/app:1.0
```

Restart the Deployment so the new proxy-config lands. Verify on the sidecar that the key is present (see diagnostic steps below). The `ServiceEntry` resumes working as on v2, with no manifest change.

### Upstream Istio fallback: set it via ProxyConfig / Sidecar

If the cluster runs a plain OSS Istio 1.22+ control plane, the same metadata key can be set cluster-wide through a `ProxyConfig` CR in the `istio-system` namespace:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: ProxyConfig
metadata:
  name: enable-dns-capture
  namespace: istio-system
spec:
  environmentVariables:
    ISTIO_META_DNS_CAPTURE: "true"
```

This scopes the change to every namespace with sidecar injection enabled; prefer the per-workload annotation when only a few applications need DNS capture, to avoid changing the behaviour of sidecars that never relied on the v2 default.

### Do not reach for `resolution: STATIC` or `endpoints:` as a workaround

Pinning the `ServiceEntry` to a static IP or adding `endpoints:` with explicit hosts silences the 404 only if the upstream IP never changes. For an internet gateway that is fronted by a load balancer with rotating backends, this guarantees a future outage the first time the backend pool rolls. Turning DNS capture back on is the correct fix.

## Diagnostic Steps

Verify the sidecar actually received the DNS-capture metadata key:

```bash
kubectl exec -n <ns> <pod> -c istio-proxy -- \
  curl -s http://localhost:15000/config_dump \
  | jq '.configs[] | select(.["@type"] | test("BootstrapConfigDump")) | .bootstrap.node.metadata.ISTIO_META_DNS_CAPTURE'
```

A working sidecar returns `"true"`. An empty string or `null` means the annotation did not land — check the pod was restarted after the annotation was added.

Confirm the listener in the proxy sees the `ServiceEntry` hostname as a resolvable cluster:

```bash
istioctl proxy-config listeners <pod>.<ns> --port <serviceentry-port>
istioctl proxy-config endpoints <pod>.<ns> \
  | grep <serviceentry-hostname>
```

With DNS capture on, `endpoints` shows one or more upstream IPs keyed off the hostname. Without it, `endpoints` shows nothing and the listener routes to the generic passthrough cluster `PassthroughCluster`, which is the ultimate cause of the 404.

Observe the DNS traffic that the sidecar intercepts:

```bash
kubectl exec -n <ns> <pod> -c istio-proxy -- \
  curl -s http://localhost:15000/stats | grep dns_filter
```

A non-zero `dns_filter.query_success` counter proves the proxy is the one answering DNS, confirming the feature is live end-to-end.
