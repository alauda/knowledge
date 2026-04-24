---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Operators want to cap the traffic that any single client can push through a specific ingress entry — a few concurrent TCP connections from one source IP, a bounded HTTP request rate per second, a bounded new-TCP-connection rate — without affecting other entries on the same ingress tier. The ask is explicitly *per route*, not per ingress, so that a noisy consumer on one hostname does not starve another hostname served by the same tier.

This is basic abuse protection: it rate-limits scraping, dampens amateur-grade denial-of-service attempts, and smooths traffic spikes. It is not a replacement for an upstream WAF, but it is the right first layer to have on any externally exposed ingress.

## Root Cause

ACP's ingress tier is the **ALB Operator** (`networking/operators/alb_operator`). Depending on the ALB data-plane backend in use, rate limiting is expressed either as ALB-native CR fields or as annotations carried on the route-level object the controller reconciles. Both shapes ultimately program the data plane with per-source-IP counters (stick tables on the HAProxy path, equivalent mechanisms on the NGINX path) and a reject rule when any counter crosses its threshold. Turning them on is a purely declarative change; no restart or data-plane reload needs to be triggered manually.

## Resolution

Four knobs compose: an on/off switch, a concurrent-TCP cap, an HTTP request-rate cap, and a new-TCP-connection rate cap. Turn rate limiting *on* for the route first, then set the specific per-source ceilings.

| Knob | Meaning |
|---|---|
| `rate-limit-connections` | `"true"` enables the per-route rate-limit machinery. Required for any of the other three to take effect. |
| `rate-limit-connections.concurrent-tcp` | Maximum number of simultaneously-open TCP connections from the same source IP, numeric. |
| `rate-limit-connections.rate-http` | Maximum HTTP request rate from the same source IP, numeric (requests per the window the data plane tracks). |
| `rate-limit-connections.rate-tcp` | Maximum new-TCP-connection rate from the same source IP, numeric. |

Consult the ALB Operator CRD reference for the current field path / annotation prefix that maps to each knob above — the prefix is stable per ALB release, but it is ALB-specific and may evolve. The annotation shape (when it is annotation-driven) typically looks like:

```yaml
metadata:
  name: my-app
  namespace: my-ns
  annotations:
    <alb-ratelimit-prefix>/rate-limit-connections:              "true"
    <alb-ratelimit-prefix>/rate-limit-connections.concurrent-tcp: "10"
    <alb-ratelimit-prefix>/rate-limit-connections.rate-http:      "10"
    <alb-ratelimit-prefix>/rate-limit-connections.rate-tcp:       "10"
```

Or imperatively on an existing route-level object:

```bash
kubectl -n <namespace> annotate <route-object> <route-name> \
  <alb-ratelimit-prefix>/rate-limit-connections="true" \
  <alb-ratelimit-prefix>/rate-limit-connections.concurrent-tcp=10 \
  <alb-ratelimit-prefix>/rate-limit-connections.rate-http=10 \
  <alb-ratelimit-prefix>/rate-limit-connections.rate-tcp=10
```

The numbers above (10 concurrent / 10 per second) are deliberately tight — they make sense for a back-office endpoint that should never see heavy traffic from one source. For a user-facing endpoint, start an order of magnitude higher and watch the reject rate before tightening.

Under the hood the ALB data plane translates the above into stick-table rules shaped roughly like:

```text
stick-table type ip size 100k expire 30s store conn_cur,conn_rate(3s),http_req_rate(10s)
tcp-request content reject if { src_conn_cur      ge 10 }
tcp-request content reject if { src_conn_rate     ge 10 }
tcp-request content reject if { src_http_req_rate ge 10 }
```

The key point is that the per-source-IP counter is maintained per route (per HAProxy backend), so a flood against one route does not consume the counter budget of any other route on the same tier.

### Caveats

- The source IP the data plane sees must be the **actual** client IP, not an intermediate proxy. If the cluster sits behind an L7 load balancer that does not preserve source addresses, the rate limit will effectively be per-intermediate-proxy and will trigger on well-behaved aggregate traffic. Either use PROXY protocol / `X-Forwarded-For` honoring at the ingress, or apply the rate limit at the outer edge instead.
- These annotations are a DDoS *mitigant*, not a DDoS *defence*. They keep one misbehaving client from hurting others; they do not stop a distributed flood. Pair them with upstream capacity / a real DDoS service at the edge when the exposure warrants it.
- Do not scatter-blanket the same aggressive limits across every route. Set them per-route, scaled to the route's expected traffic shape.

## Diagnostic Steps

Confirm the annotations landed on the route:

```bash
kubectl -n <namespace> get <route-object> <route-name> \
  -o jsonpath='{.metadata.annotations}{"\n"}'
```

Reach the endpoint from a single client above the configured ceiling and confirm the data plane rejects:

```bash
# Expect some of these to return connection-refused / reset once concurrent-tcp or rate-tcp fires.
for i in $(seq 1 30); do
  curl -skI https://my-app.example.com/ >/dev/null &
done
wait
```

On a rejecting request you will see the connection reset or the HTTP exchange terminated by the ingress data plane before the backend ever sees it. That confirms the stick-table rules are compiled and active.

If the annotations are present but no rejection occurs:

- Check that `rate-limit-connections: "true"` is set literally (string, not boolean) — the data plane matches on the string value.
- Check the source-IP attribution: `kubectl -n <ingress-namespace> logs <alb-pod>` and look at the access-log line's source address. If every request appears to come from an intermediate proxy's IP, the rate limit is being applied per proxy, not per real client; fix the source-IP propagation at the ingress before re-testing.
