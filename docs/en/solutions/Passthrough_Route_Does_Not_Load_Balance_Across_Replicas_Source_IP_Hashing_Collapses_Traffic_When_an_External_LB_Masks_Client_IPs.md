---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Passthrough Route Does Not Load-Balance Across Replicas — Source-IP Hashing Collapses Traffic When an External LB Masks Client IPs
## Issue

A Service or Route configured for TLS passthrough has multiple healthy backend pods but traffic collapses onto a single pod. Even under synthetic load:

- 100 % of requests hit one backend pod.
- The other replicas show zero connection metrics on their Prometheus counters (`http_requests_total`, connection accept gauges).
- Restarting the "hot" pod does not fix the imbalance — traffic simply collapses onto another single pod.

This contradicts the standard expectation that the ingress load-balances across ready endpoints.

## Root Cause

Passthrough routes (routes where the ingress terminates only the TCP/TLS outer connection and forwards ciphertext directly to the backend) cannot inspect HTTP headers. The ingress therefore cannot perform any HTTP-level load-balancing algorithm — `roundrobin`, `leastconn`, cookie-based stickiness — because those require reading or writing request-level data.

The default load-balancing algorithm for passthrough routes on most ingress implementations (HAProxy-based, nginx-based, and ALB2-based) is **source-IP hash**: the ingress hashes the connecting client's IP address and picks a backend pod from the ready set based on that hash. This yields deterministic "same client → same pod" behaviour, which is usually what you want for session stickiness without cookies.

The failure mode arises when an **external load balancer sits in front of the cluster ingress** and does not preserve the real client IP. Examples:

- A cloud load balancer in "NAT" mode that rewrites the source address to its own.
- An on-prem L4 balancer that does not use PROXY protocol or TCP-level Keepalived with DSR.
- A gateway-to-gateway hop in which the outer gateway also uses source-IP hashing and hashes to one of a small set of intermediate IPs.

When every TCP connection arriving at the cluster ingress has the same source IP (the external LB's IP), source-IP hashing produces the same hash every time, and every connection is steered to the same backend. The algorithm is working correctly; its inputs are wrong.

The fix has two parallel tracks:

1. **Make the external LB preserve client IPs** (PROXY protocol, transparent mode, DSR, `externalTrafficPolicy: Local` on Services of type LoadBalancer that front the ingress). With diverse source IPs, source-IP hashing behaves sensibly.

2. **Change the ingress algorithm on the affected route** to one that does not rely on source IP — for passthrough this typically means switching to round-robin, accepting that session affinity is lost.

## Resolution

### Step 1 — confirm the source IP at the ingress is collapsed

On ALB2, enable ingress access logging and inspect the source IP field:

```bash
# ALB2 access logs: path depends on the ALB2 CR spec. Confirm logging is
# enabled; then tail the logs on the ALB pods during a live test:
ALB_NS=<ns>
ALB=$(kubectl -n "$ALB_NS" get alaudaloadbalancer2 -o=jsonpath='{.items[0].metadata.name}')

# With access logging enabled, read recent entries:
kubectl -n "$ALB_NS" logs deploy/"$ALB"-global --tail=200 | \
  grep passthrough
```

Typical offending line (note the source IP matches the external LB, not real clients):

```text
2026-01-16T16:41:53 haproxy[244]: 10.19.11.214:58518 [16/Jan:16:41:49] public_ssl be_tcp:svc:passthrough /pod:https:xx.xxx.xxx.xx:8443 …
```

If every log line over a multi-minute window shows the same source IP or a very narrow source-IP range, source-IP hashing will collapse. If source IPs are diverse, this runbook does not apply — look elsewhere for the imbalance.

### Step 2 — change the load-balancing algorithm on the affected route

For ALB2, the algorithm is on the `Rule` or `Frontend` CR:

```bash
# Find the Rule / Frontend that backs the problem service:
kubectl -n <ns> get rule,frontend -A | grep <service-name>

# Patch to round-robin:
kubectl -n <ns> patch rule <rule-name> --type=merge -p='
{"spec":{"balance":"roundrobin"}}'
```

For an Ingress / Gateway API HTTPRoute, passthrough typically cannot set the algorithm per-route because it is a TCP-level decision — the algorithm is set at the GatewayClass / controller level (ALB2's annotations, nginx's ConfigMap). Consult the controller's documentation for the exact key.

Useful algorithm choices:

- `roundrobin` — even distribution, no affinity. Fine when clients do not need sticky sessions.
- `leastconn` — load-based distribution. Useful when backends have varying request costs.
- `source` — the default; keep only if you trust client IPs are diverse.

Avoid cookie-based `balance cookie <name>` on passthrough routes — HAProxy / ALB2 cannot set cookies on traffic they do not terminate.

### Step 3 — alternative: make the external LB preserve client IP

If session stickiness-by-client-IP is genuinely desired, the durable fix is to push the original client IP through the external load balancer.

Options, depending on your LB product:

| External LB pattern | Client-IP preservation mechanism |
|---|---|
| Kubernetes Service `type: LoadBalancer` | Set `spec.externalTrafficPolicy: Local` — preserves client IP at the cost of one extra hop penalty per packet; kube-proxy forwards locally. |
| L4 cloud LB (AWS NLB, GCP ILB in NLB mode) | Enable "Client IP preservation" in the LB config (per-provider knob). |
| On-prem L4 with PROXY protocol support | Enable PROXY protocol on the LB → accept PROXY protocol on the ingress. For ALB2, set `spec.proxyProtocol: enabled` on the ALB2 CR. |
| On-prem L4 with DSR | Direct Server Return — the ingress sees the client directly; no rewrite. |

After enabling, re-run the check in Step 1: the ALB's access log should show a variety of source IPs. Source-IP hashing then distributes across backends naturally.

### Step 4 — verify the spread

Drive synthetic traffic and observe that load reaches every backend:

```bash
# Simple test: 50 concurrent requests from N different client pods.
NS=<ns>
SVC=<service-name>
for i in 1 2 3 4 5; do
  kubectl -n "$NS" run client-$i --image=curlimages/curl:8 --rm -it --restart=Never -- \
    sh -c "for n in \$(seq 1 20); do curl -ks https://$SVC/ -o /dev/null -w '%{http_code}\n'; done" &
done
wait
```

Inspect each backend pod's connection counts:

```bash
for pod in $(kubectl -n "$NS" get pod -l app=<backend-label> -o name); do
  echo "=== $pod ==="
  kubectl -n "$NS" exec "$pod" -- curl -s http://localhost:9090/metrics 2>/dev/null | \
    grep -E '^http_requests_total' | head -3
done
```

Healthy: every pod has a non-zero count roughly proportional to its share (roundrobin) or diverse source IPs (source hash with Step 3 applied).

## Diagnostic Steps

Check the algorithm actually configured on the route / frontend:

```bash
# ALB2:
kubectl -n <ns> get rule -A -o=jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.balance}{"\n"}{end}'
```

If `spec.balance` is unset or `source`, and external-LB client IPs are collapsed, the symptom of this article is the expected behaviour.

Count distinct source IPs over a sample window:

```bash
kubectl -n "$ALB_NS" logs deploy/"$ALB"-global --tail=1000 | \
  awk '{print $5}' | awk -F: '{print $1}' | sort -u | wc -l
```

A number under 5 with clients that should be diverse (different users / regions) confirms the upstream LB is masking.

Check the kube-proxy service routing mode if the ingress is fronted by a Kubernetes `type: LoadBalancer` Service — `externalTrafficPolicy: Cluster` is the default and hides client IPs:

```bash
kubectl get svc -A -o=jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.namespace}/{.metadata.name}{"\t"}{.spec.externalTrafficPolicy}{"\n"}{end}'
```

Services fronting the ingress should be `Local` if you need client-IP preservation.

After any change (Step 2 or Step 3), allow the ingress time to reload — ALB2 reloads on the next reconcile cycle, typically under 10 seconds. If reload does not happen, check the ALB2 controller logs for a reconciliation error.
