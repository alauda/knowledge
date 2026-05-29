---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500531
---

# Configure HTTP proxy for Prometheus remoteWrite on Alauda Container Platform

## Issue

On Alauda Container Platform (ACP install package `v4.3.4`) the kube-prometheus chart (helm chart version `v4.3.3`, label `chart=prometheus-0.0.50`) renders the in-cluster monitoring Prometheus CR `cpaas-system/kube-prometheus-0`, and its `spec.remoteWrite[]` carries the upstream prometheus-operator `RemoteWriteSpec` schema verbatim. The shipped `prometheus-operator` is `v0.91.0` driving a Prometheus container at `prometheus:v3.11.3` (>= v2.43.0), so two distinct proxy-control fields are available on each `remoteWrite[]` entry: a literal `oauth2.proxyUrl` and an environment-driven `oauth2.proxyFromEnvironment` / `oauth2.noProxy` pair. Operators routing remote-write traffic through an HTTP forward proxy need a clear rule for which field to set, and what additional plumbing each one requires before traffic actually flows through the proxy.

## Root Cause

The two fields encode different shapes for specifying the proxy. `oauth2.proxyUrl` is a CRD-level `string` whose description reads "proxyUrl defines the HTTP proxy server to use" — the schema accepts an explicit proxy URL as a literal string with no environment interpolation on the field itself. `oauth2.proxyFromEnvironment` is a newer boolean — its CRD description names it as the toggle for reading `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from the container environment, and the same description carries an explicit `It requires Prometheus >= v2.43.0` prerequisite that the sibling `proxyUrl` field does not, confirming that `proxyFromEnvironment` is the newer of the two and that on a prometheus-operator release predating its introduction only the literal `proxyUrl` is available. Per the same CRD description, when `proxyFromEnvironment` is true the field instructs the Prometheus container to consult the `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment variables, so it depends on those variables actually being present in the container env.

The default kube-prometheus rendering on ACP does not inject any proxy environment variables into the Prometheus container — the only env var present on the container is `GOGC=50`. As a result, turning on `proxyFromEnvironment` against the stock chart leaves the resolver with nothing to read and no proxy is applied to remote-write requests.

## Resolution

Pick one of the two proxy-control fields based on whether the proxy should be pinned in the CR or driven by container environment. Option A (`oauth2.proxyUrl`) keeps the proxy address as a literal in the CR; option B (`oauth2.proxyFromEnvironment`) defers proxy resolution to the Prometheus container's own env, and therefore requires the env to actually carry the variables.

**Option A — literal URL via `oauth2.proxyUrl`.** When the remote-write proxy is a single, stable URL that should live in the CR alongside the endpoint, set `oauth2.proxyUrl` on the `remoteWrite[]` entry. The value is taken as the literal proxy URL applied to those remote-write requests, with no environment indirection:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus-0
  namespace: cpaas-system
spec:
  remoteWrite:
    - url: https://remote.example.com/api/v1/write
      oauth2:
        clientId:
          secret:
            name: rw-oauth2
            key: client_id
        clientSecret:
          name: rw-oauth2
          key: client_secret
        tokenUrl: https://auth.example.com/oauth2/token
        proxyUrl: http://proxy.example.com:3128
```

The Prometheus CR is reconciled out of `ClusterPluginInstance/prometheus` (`spec.config.components.prometheus.*`) on ACP — apply the edit through that surface so chart re-renders do not revert it. Validate with a server-side dry-run before committing the change:

```bash
kubectl -n cpaas-system apply --dry-run=server -f kube-prometheus-0.yaml
```

A successful admission returns `prometheus.monitoring.coreos.com/kube-prometheus-0 configured (server dry run)`, confirming that the CRD accepts the literal `oauth2.proxyUrl` together with the rest of the OAuth2 block.

**Option B — environment-driven via `oauth2.proxyFromEnvironment`.** When the desired routing is "use whatever HTTP proxy the Prometheus container is configured to use" (for example, to share the cluster's outbound-proxy convention across all remote-write endpoints), set `oauth2.proxyFromEnvironment: true` and, where applicable, an `oauth2.noProxy` exclusion list (comma-separated; same `Prometheus >= v2.43.0` requirement, which the shipped `v3.11.3` image meets). Per the CRD description, the field directs the Prometheus container to read `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from its own environment:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus-0
  namespace: cpaas-system
spec:
  remoteWrite:
    - url: https://remote.example.com/api/v1/write
      oauth2:
        clientId:
          secret:
            name: rw-oauth2
            key: client_id
        clientSecret:
          name: rw-oauth2
          key: client_secret
        tokenUrl: https://auth.example.com/oauth2/token
        proxyFromEnvironment: true
        noProxy: "cluster.local,.svc,10.0.0.0/8"
```

Option B is a no-op on the stock chart unless `HTTP_PROXY` / `HTTPS_PROXY` are also placed into the Prometheus container environment. Combine the field with a `Prometheus.spec.containers[]` override that adds the proxy env to the `prometheus` container — this is the additional plumbing the environment-driven mode requires before traffic actually traverses the proxy:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus-0
  namespace: cpaas-system
spec:
  containers:
    - name: prometheus
      env:
        - name: HTTP_PROXY
          value: http://proxy.example.com:3128
        - name: HTTPS_PROXY
          value: http://proxy.example.com:3128
        - name: NO_PROXY
          value: cluster.local,.svc,10.0.0.0/8
```

The Prometheus CRD accepts a `containers[]` override block to inject environment variables into the `prometheus` container — without that injection, `proxyFromEnvironment` has no proxy environment to consult on the stock chart, whose container env only carries `GOGC=50`.

## Diagnostic Steps

Confirm that the chosen field reached the Prometheus CR — both fields live on the same `RemoteWriteSpec.oauth2` block and the apiserver accepts them coexisting (a CR carrying `proxyUrl`, `oauth2.proxyFromEnvironment: true`, and `oauth2.noProxy` together admits cleanly on the shipped CRD):

```bash
kubectl -n cpaas-system get prometheus kube-prometheus-0 \
  -o jsonpath='{.spec.remoteWrite[*].oauth2}'
```

When using `oauth2.proxyFromEnvironment`, verify the container env block contains the expected `HTTP_PROXY` / `HTTPS_PROXY` entries before relying on `proxyFromEnvironment` — the stock chart leaves only `GOGC=50` in the container env, so the field has nothing to read until the `containers[]` override is reconciled in:

```bash
kubectl -n cpaas-system get pod -l app.kubernetes.io/name=prometheus \
  -o jsonpath='{.items[0].spec.containers[?(@.name=="prometheus")].env}'
```

The default-chart output for this command shows only `GOGC=50`; once the `containers[]` override above is reconciled in, `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` should appear alongside it.
