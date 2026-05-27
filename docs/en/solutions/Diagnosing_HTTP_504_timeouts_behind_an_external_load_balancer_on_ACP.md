---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Diagnosing HTTP 504 timeouts behind an external load balancer on ACP

## Issue

On Alauda Container Platform (ACP install package v4.3.13, Kubernetes v1.34.5, ALB2 `v4.3.1` data plane `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1` in the `cpaas-system` namespace fronted by `ingressclass/global-alb2`), an HTTP client receives an HTTP `504 Gateway Timeout` for a request that traverses an external cloud load balancer in front of the cluster ingress before reaching a backend Pod. The user-facing request path layers an external L4/L7 load balancer, the in-cluster ALB2 data plane, and the workload Pod, and any one of these hops can close a slow response before the next hop has a chance to return it.

The end-to-end shape of the path is the standard Kubernetes `Service` of type `LoadBalancer` topology — the upstream `Service.spec.type` enum (`ClusterIP / ExternalName / LoadBalancer / NodePort`) is identical on ACP, and an external cloud LB attaches in front of a `LoadBalancer`-typed Service exactly the same way it does on any conformant cluster. On the customer cluster the symptom appears as the `504` returned to the browser/client whenever the backend takes longer to produce the first response byte than the lowest-timeout hop on that path allows.

## Root Cause

A request that crosses multiple network hops is governed by each hop's independent timeout, and the connection is terminated by whichever hop has the lowest configured timeout — not by the slowest hop nor the backend itself. When a slow upstream causes the response's time-to-first-byte to exceed the configured timeout on any intermediate hop, that hop closes the connection and the client observes the closure as an HTTP `504 Gateway Timeout`; this is distribution-independent because the status code is read by `libcurl` (or any HTTP client) from whichever upstream closed or responded, and the same code surfaces on ACP exactly as on any other Kubernetes platform.

For the external-load-balancer-in-front topology specifically, when the cloud LB's own request timeout is configured lower than the cluster ingress's timeout, the external LB terminates a slow-but-otherwise-valid request before the in-cluster ingress data plane can return the backend's response, and the client sees `504` from the LB rather than the backend.

## Resolution

The remediation principle is "outer timeout must be greater than inner timeout for every hop on the request path". Concretely, when a user-managed external load balancer fronts an ACP cluster, the external LB's request timeout must be configured higher than the cluster ingress's timeout so that the LB does not close a connection the ingress would still serve. The external LB's timeout is a property of the external device and is configured outside the cluster on the LB itself (cloud-provider console, on-prem appliance, etc.) — this configuration is generic to the LB product and is not a Kubernetes object.

On the ACP side, the in-cluster ingress data plane is ALB2 (`alaudaloadbalancer2.crd.alauda.io`, ingressclass `global-alb2`, controller `cpaas.io/alb2`, data plane image `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1` in the `cpaas-system` namespace). ALB2 exposes per-frontend timeout knobs through the `Frontend` CRD (`frontends.crd.alauda.io/v1`) under `.spec.config.timeout`, where `proxy_connect_timeout_ms`, `proxy_read_timeout_ms`, and `proxy_send_timeout_ms` set the upstream connect / read / send budgets the data plane applies to traffic for that frontend. The ALB2 Frontend timeout is the ACP-side instance of the inner-hop timeout in the outer-must-exceed-inner ordering: raise it to match the application's expected time-to-first-byte before raising the external LB timeout to a value strictly greater than the ALB2 timeout, so the external LB never closes a connection the ALB2 data plane would still serve:

```yaml
apiVersion: crd.alauda.io/v1
kind: Frontend
metadata:
  name: <frontend-name>
  namespace: cpaas-system
spec:
  config:
    timeout:
      proxy_connect_timeout_ms: 60000
      proxy_read_timeout_ms: 60000
      proxy_send_timeout_ms: 60000
```

After updating the ALB2 `Frontend` and the external LB timeout (with the LB value strictly greater than the ALB2 value, which in turn is greater than the observed `time_starttransfer`), re-run the curl diagnostic against the user-facing URL and confirm the request now completes with `http_code: 200` (or the backend's real status) instead of `504`.

## Diagnostic Steps

Capture per-request timing plus HTTP status from an external vantage point using `curl --write-out`. The libcurl `--write-out` variables (`%{time_namelookup}`, `%{time_connect}`, `%{time_appconnect}`, `%{time_pretransfer}`, `%{time_starttransfer}`, `%{time_total}`, `%{size_download}`, `%{http_code}`) are rendered verbatim by `curl` 8.5.0 / libcurl and work the same way against any ACP-fronted URL — the format string below produces one labelled line per request and is safe to run in a sustained loop from a client outside the cluster:

```bash
while true; do
  curl -s -o /dev/null \
    --write-out 'dnslookup: %{time_namelookup} | connect: %{time_connect} | appconnect: %{time_appconnect} | pretransfer: %{time_pretransfer} | starttransfer: %{time_starttransfer} | total: %{time_total} | size: %{size_download} | response: %{http_code}\n' \
    "https://<user-facing-url>/<path>"
  sleep 1
done
```

Inspect the per-request output and compare `time_starttransfer` against the configured upstream timeouts. When `time_starttransfer` (the elapsed time from request start to the first response byte) exceeds the lowest configured timeout on the request path, the request is terminated upstream and the `%{http_code}` field renders `504` for that sample; this is the canonical signal that "the backend was too slow for the hop that closed the connection" and identifies which timeout needs to be raised.

```text
dnslookup: 0.004 | connect: 0.012 | appconnect: 0.045 | pretransfer: 0.046 | starttransfer: 30.001 | total: 30.002 | size: 0 | response: 504
```

Confirm the external-LB-in-front topology by listing `LoadBalancer`-typed Services and inspecting the front-door binding. `Service.spec.type` accepts the upstream enum (`ClusterIP / ExternalName / LoadBalancer / NodePort`) unchanged on ACP, and an external cloud LB attaches in front of a Service of `type: LoadBalancer` the same way it does on any conformant cluster:

```bash
kubectl get svc -A --field-selector spec.type=LoadBalancer
kubectl get alaudaloadbalancer2 -n cpaas-system global-alb2 \
  -o jsonpath='{.status.allocatedAddress}{"\n"}'
```

When the LB timeout is the closing hop, raising only the ALB2 `Frontend` timeout does not resolve the symptom — the external LB will still close the connection at its own (lower) limit. The rule "outer ≥ inner" must hold for every hop on the path, so apply the timeout increase to whichever hop the curl `time_starttransfer` sample shows is closing first.
