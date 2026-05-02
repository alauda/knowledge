---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# 504 Timeouts Behind an External Cloud Load Balancer
## Issue

Workloads exposed through an external cloud load balancer (for example a GCP TCP/HTTPS load balancer fronting the cluster ingress) periodically return HTTP 504 to the caller, even though the backend pod is healthy. A latency probe shows the time-to-first-byte (`starttransfer`) hovering close to 30 seconds before the request is cut off, while DNS lookup, TCP connect, and TLS handshake all complete in milliseconds. Sample probe line:

```text
local_port: 43886 | dnslookup: 0.000338 | connect: 0.014501 |
appconnect: 0.035137 | pretransfer: 0.035208 |
starttransfer: 32.182811 | total: 30.182911 |
size: 14 | response: 504
```

## Root Cause

Two timers govern the request path and a 504 fires the moment the *shorter* one expires before the backend responds:

1. The in-cluster ingress proxy (the platform's HAProxy-based router on ACP ALB) has a per-route response timeout that defaults to 30 seconds. Once the upstream pod takes longer than that to start sending bytes, the proxy aborts the connection and synthesises a 504 to the client.
2. The external cloud load balancer in front of the cluster has its own backend timeout. When that timer is shorter than (or close to) the in-cluster timer, the cloud LB also returns 504 before the proxy has a chance to.

Whichever timer is reached first wins. A slow application or a chain of intermediaries (firewall, WAF, NAT) only makes the gap worse, but the 504 itself is always a timer expiring on the network path, not a kernel error.

## Resolution

Treat the timeouts as a chain that must be ordered from outermost to innermost: external LB > ingress > backend. Each hop must wait at least as long as the next hop downstream, otherwise the outer hop will give up early.

### 1. Raise the ingress timeout for the affected route

On ACP, the ALB operator (`networking/operators/alb_operator`) provides the platform-preferred entry point. Adjust the response timeout on the Ingress resource using the ALB-specific annotation; the value applies only to that Ingress and does not change the cluster default.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: slow-app
  namespace: prod
  annotations:
    alb.cpaas.io/timeout: "120s"
spec:
  rules:
    - host: slow-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: slow-app
                port:
                  number: 8080
```

If the cluster's Ingress controller is HAProxy-based (NGINX Ingress is the more common ACP default), the equivalent timeout knob is exposed through the controller's own annotation set; ALB users should rely on the annotation above.

### 2. Raise the external load balancer's backend timeout

Set the cloud-side backend timeout to a value strictly larger than the ingress timeout configured in step 1. As a rule of thumb keep at least a 30-second margin so the cluster has a chance to surface a clean 504 (with route headers and request id) before the cloud LB times the connection out and hides those signals.

For a GCP backend service this is the `--timeout` flag (in seconds). Whatever the cloud, the order must be:

```text
client timeout  >  external LB backend timeout  >  cluster ingress timeout  >  app server timeout
```

### 3. Address the slow backend

Increasing timers buys time but does not fix the underlying latency. Track down the slow backend in parallel:

- Profile the application — pure CPU, blocking I/O, or downstream dependency calls?
- Confirm the pod's CPU/memory requests are not being throttled.
- Check that the Service has healthy endpoints for the entire 30-second window (a rolling restart can leave a single endpoint serving while others come up).

## Diagnostic Steps

Reproduce the latency from inside the cluster, bypassing the external LB, to confirm the bottleneck is in the application and not on the public path:

```bash
kubectl run latency-probe --rm -it --restart=Never \
  --image=curlimages/curl:8.10.1 -- sh -c '
  while true; do
    printf "%s | " "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    curl -o /dev/null -s -w \
      "dns:%{time_namelookup} connect:%{time_connect} \
tls:%{time_appconnect} ttfb:%{time_starttransfer} \
total:%{time_total} code:%{http_code}\n" \
      http://slow-app.prod.svc.cluster.local:8080/health
    sleep 1
  done'
```

If `ttfb` already exceeds the ingress timeout from inside the cluster, the application is the slow hop. If it is fast in-cluster but slow when called through the external LB, the additional latency is on the public path or in the LB itself.

Inspect the effective timeout the ALB negotiated for the route:

```bash
kubectl get ingress slow-app -n prod \
  -o jsonpath='{.metadata.annotations}' | jq .
```

Look at the ingress controller pod logs around the time of the 504 — the log line includes the upstream address and the duration the proxy waited before cutting the connection:

```bash
kubectl -n cpaas-system logs -l app=alb -c alb --tail=200 \
  | grep -E '504|timeout|slow-app'
```

If the timeout is happening on the cloud LB instead of the cluster, the cluster logs will not show a 504 at all — the request never reaches the backend. In that case the fix lives entirely on the cloud-side configuration (step 2).
