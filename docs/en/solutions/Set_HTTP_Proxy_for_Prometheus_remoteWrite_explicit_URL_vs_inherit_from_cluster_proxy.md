---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Set HTTP Proxy for Prometheus `remoteWrite` — explicit URL vs. inherit from cluster proxy
## Issue

A Prometheus instance is configured to push metrics to an external system via `remoteWrite`. The cluster sits behind an HTTP/HTTPS proxy — egress to the internet (where the remote-write receiver lives) must go through the corporate proxy. Without that configuration, the Prometheus pod cannot reach the remote endpoint and the `remoteWrite` queue backs up:

```text
err="Post \"https://metrics-sink.example.com/api/v1/write\":
  dial tcp x.x.x.x:443: i/o timeout"
level=warn component=remote
```

The cluster already has a cluster-wide proxy object, and other cluster components route through it correctly. The Prometheus remote-write path, however, does not automatically pick up the cluster proxy — it needs an explicit configuration.

## Resolution

Two configuration paths exist, and the right one depends on the monitoring-stack operator version deployed on the cluster.

### Path 1 — explicit `proxyURL` (works on every version)

The `remoteWrite` stanza inside the cluster-monitoring config accepts a `proxyUrl` under `oauth2` (or at the top level on some operator versions). Set it to the cluster proxy's URL:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-monitoring-config
  namespace: cpaas-monitoring
data:
  config.yaml: |
    prometheusK8s:
      remoteWrite:
        - url: https://metrics-sink.example.com/api/v1/write
          oauth2:
            clientId: <id>
            clientSecret:
              name: <secret>
              key: client-secret
            tokenUrl: https://oauth.example.com/token
            proxyUrl: http://proxy.internal:3128
          writeRelabelConfigs:
            # ...
```

Apply, let the operator reconcile, and the Prometheus pods roll with the new `remoteWrite` config. The remote-write goroutine now routes through the named proxy.

Trade-off: the proxy URL is duplicated between the cluster's own `Proxy` object and the monitoring config. If the proxy URL changes, both places need to be updated. This is the path to use when the operator version does not yet support inheriting from the environment.

### Path 2 — `proxyFromEnvironment` (newer operator builds)

Recent monitoring-stack operator builds added a `proxyFromEnvironment` boolean under the `remoteWrite[].oauth2` section. When `true`, the remote-write client reads `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` from its pod environment — and the pod's environment is populated from the cluster's `Proxy` object automatically. One source of truth.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-monitoring-config
  namespace: cpaas-monitoring
data:
  config.yaml: |
    prometheusK8s:
      remoteWrite:
        - url: https://metrics-sink.example.com/api/v1/write
          oauth2:
            clientId: <id>
            clientSecret:
              name: <secret>
              key: client-secret
            tokenUrl: https://oauth.example.com/token
            proxyFromEnvironment: true
          writeRelabelConfigs:
            # ...
```

The cluster's `Proxy` object then drives the remote-write path automatically. When the proxy URL changes (or `noProxy` entries are added / removed), no monitoring-stack change is required — Prometheus pods pick up the updated environment on their next restart.

Prefer Path 2 when the operator version supports it. Verify the operator's CRD schema:

```bash
kubectl get crd prometheuses.monitoring.coreos.com -o json | \
  jq '.spec.versions[] | .schema.openAPIV3Schema.properties.spec.properties.remoteWrite
      | .items.properties.oauth2.properties | keys[]'
```

The presence of `proxyFromEnvironment` in the output confirms the operator supports Path 2.

### Verifying the routing

After applying either path, confirm the Prometheus pod is using the proxy:

```bash
POD=$(kubectl -n cpaas-monitoring get pod \
        -l app.kubernetes.io/name=prometheus \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n cpaas-monitoring exec "$POD" -c prometheus -- \
  env | grep -iE 'proxy|no_proxy'
```

Path 1 will not show these env vars (the Prometheus client read the proxy from its own config). Path 2 requires them to be present; their absence means the pod did not inherit from the Proxy object — check the operator's version and the pod's generation template.

Check the Prometheus `/remote-write` metrics:

```bash
kubectl -n cpaas-monitoring exec "$POD" -c prometheus -- \
  wget -qO- http://localhost:9090/metrics | \
  grep -E 'prometheus_remote_storage_.*_total|prometheus_remote_storage_queue_highest_sent_timestamp_seconds'
```

`samples_total` and `bytes_total` should increase over time; the queue's highest-sent timestamp should advance close to real time. If they stay flat, the remote-write is still not making it through — log messages from the `remote-write` component will name the specific error.

### What does not work

- **Leaving proxy configuration out entirely.** The remote-write client does not read `HTTPS_PROXY` on its own on older operator versions; silently, it bypasses the proxy and fails to reach the remote endpoint when egress rules require the proxy.
- **Configuring the proxy only in the Prometheus deployment's env**. The operator reconciles those env vars back to its canonical state; hand-edits do not persist.
- **Routing remote-write through an in-cluster service that forwards to the proxy**. This works but adds a hop and an extra moving part; prefer the direct `proxyUrl` / `proxyFromEnvironment` config.

## Diagnostic Steps

Confirm the remote-write is failing because of proxy absence (not a remote-endpoint issue or an auth issue):

```bash
kubectl -n cpaas-monitoring logs "$POD" -c prometheus --tail=500 | \
  grep -iE 'remote-write|remote_storage|remote:' | tail -20
```

Error lines like `i/o timeout` against the remote endpoint on a cluster that has an HTTP proxy configured indicate the client is trying to reach the endpoint directly. `401 Unauthorized` or `403 Forbidden` would instead indicate an auth issue; those are different fixes.

Verify the cluster's Proxy object has the expected settings:

```bash
kubectl get proxy cluster -o yaml | yq '.spec'
# spec:
#   httpProxy: http://proxy.internal:3128
#   httpsProxy: http://proxy.internal:3128
#   noProxy: ".internal,.svc,.cluster.local"
```

If the Proxy object is empty, the cluster does not actually have a proxy configured — and the remote-write failure is not a proxy routing problem; it is direct egress being blocked.

After applying the fix, watch the queue-drain rate:

```bash
kubectl -n cpaas-monitoring exec "$POD" -c prometheus -- \
  wget -qO- http://localhost:9090/metrics | \
  grep prometheus_remote_storage_highest_timestamp_in_seconds
```

The timestamp should catch up to current time within a few minutes of the fix landing. If it stays behind indefinitely, inspect the remote-write queue's capacity settings and the remote endpoint's throughput capability.
