---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Ingress Proxy Pods CrashLoopBackOff After Upgrade — Connection Counts Grow Exponentially Past max-connections
## Issue

After an ingress-proxy version upgrade (the proxy component behind the cluster's default HTTP/HTTPS data-path — nginx-based ingress controller, HAProxy-based ingress controller, or similar), the proxy Deployment enters `CrashLoopBackOff`:

- Pods start, briefly serve traffic, then are OOMKilled or exit with a SIGTERM as their memory usage grows exponentially.
- Upon restart the cycle repeats; each restart is faster and the memory spike larger.
- Metrics (`proxy_current_connections`, `haproxy_frontend_current_sessions`, `nginx_connections_active`) approach the configured `max-connections` / `maxclient` limit (default 50 000 on most distributions).
- Downstream platform components that route through the ingress — the auth / console / metrics UI — start timing out, because no healthy proxy replica is available to accept their traffic.

The upgrade itself is successful in terms of binary version — the proxy executable is the new build — but the new build's default handling of keep-alive connections differs enough from the previous build that the fleet cannot serve the traffic that previously was serving fine.

## Root Cause

The proxy tracks two connection states:

1. **Active** connections — a client is currently sending or receiving bytes.
2. **Idle keep-alive** connections — the client has finished a request but the TCP/TLS session is held open so the next request on the same connection does not pay the handshake cost again.

Both state kinds count against the proxy's `max-connections` (or `maxclient`) budget. Once that budget is exhausted, the proxy starts refusing `accept()`, and load-balancer health checks in front of it begin to fail.

A keep-alive timeout change — either a longer default in the new proxy version, or a semantics change in how closed-but-not-acknowledged connections are counted — shifts the steady-state ratio. Connections that under the previous version would have been counted as closed now linger as idle for another N seconds. On a cluster with tens of thousands of concurrent clients, that difference pushes the steady-state count past the hard limit.

Once the limit is reached:

- No new connections are accepted; health-checks from the outer load balancer fail; the load balancer stops sending traffic; idle connections continue to age out slowly; and eventually the pod recovers **but** during the period of unreachable state the platform's other components time out and mark themselves unhealthy.
- If the proxy is configured with a memory limit, the per-connection buffer overhead pushes the pod past its `memory limit` and the kubelet evicts / OOMKills it.

Restart does not help — the proxy comes up, existing clients reconnect, and within seconds the connection count climbs back to the same ceiling.

There are three correct responses, used together:

1. Temporarily scale up replicas so the cluster can continue serving traffic while the fix is applied.
2. Raise `max-connections` for the short term, for the same reason.
3. Apply the configuration knob the new proxy version introduced to cap the idle keep-alive window — this is the durable fix and addresses the root cause.

## Resolution

### Step 1 — understand which proxy and which CR

Identify the ingress stack your cluster runs and the CR that configures it. Two common shapes on ACP:

- **ingress-nginx**: managed via `ingress-nginx-operator`; the controller's config lives on the `IngressClass` parameters or a ConfigMap the operator reconciles.
- **ALB2** (alauda-load-balancer-2): the cluster's native LB; parameters live on the `AlaudaLoadBalancer2` CR.

Run one of the following to locate your ingress workload:

```bash
# ingress-nginx
kubectl -n <ns> get deploy -l app.kubernetes.io/name=ingress-nginx
kubectl -n <ns> get ingressclass

# ALB2
kubectl get alaudaloadbalancer2 -A
```

### Step 2 — stabilise by scaling out and raising max-connections

Before any configuration change, get the cluster back to serving state. Increase replicas to 4–6 so there is a high probability at least one pod is running at any moment (the math: if steady-state cycle is 30 seconds and failure-to-restart is 10 seconds, 4 replicas keep aggregate availability above 95 %):

```bash
# ingress-nginx via operator-managed Deployment:
kubectl -n <ns> scale deployment <ingress-nginx-deploy> --replicas=6

# ALB2:
kubectl patch alaudaloadbalancer2 <name> -n <ns> --type=merge -p='
{"spec":{"replicas":6}}'
```

Simultaneously raise the proxy's `max-connections` to a value the node's memory can sustain. Rough sizing: each idle connection costs approximately the proxy's per-connection buffer (nginx: `client_body_buffer_size` + `client_header_buffer_size`; HAProxy: `tune.bufsize`). For a 2 GiB pod memory limit and 32 KiB per connection, the safe ceiling is around 60 000.

```bash
# ingress-nginx — via the controller's ConfigMap:
kubectl -n <ns> patch configmap <ingress-nginx-cm> --type=merge -p='
{"data":{"max-worker-connections":"60000"}}'
```

### Step 3 — apply the durable fix: cap the keep-alive window

Set an explicit short keep-alive timeout so idle connections age out before they accumulate past the limit. A sensible starting value is 60 seconds (down from the 300-second default that many proxies ship with):

```bash
# ingress-nginx:
kubectl -n <ns> patch configmap <ingress-nginx-cm> --type=merge -p='
{"data":{"keep-alive":"60","keep-alive-requests":"100"}}'

# ALB2: consult the CR schema for the equivalent parameter (typically
# spec.tuningOptions or spec.params.keepaliveTimeout).
kubectl explain alaudaloadbalancer2.spec | grep -iE 'keepalive|timeout'
```

For ingress-nginx, the effective keys on the controller ConfigMap are `keep-alive` (seconds; idle TCP keep-alive before the server closes), and `keep-alive-requests` (number of requests served on one connection before the server requires a new handshake). Both together cap how long a single client can hold a slot.

Tune the value against the real workload: too low and client reconnect-churn rises (visible as increased TLS-handshake time in p95 latency); too high and the fleet will drift back toward the old behaviour. 30–120 seconds is the band that works for most HTTP APIs.

### Step 4 — validate and unwind the temporary measures

Once the keep-alive cap is in effect, the idle-connection pool stops growing past the chosen ceiling. Confirm with metrics:

```bash
# From inside one proxy pod:
kubectl -n <ns> exec <proxy-pod> -- curl -s http://localhost:<stats-port>/metrics | \
  grep -E 'current_connections|connections_active|idle'
```

Watch the value flatten rather than climb. Once steady for a full workload cycle (typically 10–15 minutes in production), scale replicas back to the desired long-term value and optionally lower `max-connections` back to its default — the keep-alive cap is what holds the invariant.

### Step 5 — document the tuned value

Record the chosen `keep-alive` value and the reasoning (observed concurrent connection count before / after, p95 TLS-handshake latency delta) in the ingress component's ops runbook. The next upgrade is likely to ship with a different default; knowing your cluster's measured value makes the next upgrade a tuning adjustment rather than an incident.

## Diagnostic Steps

Check the crash pattern — exponential memory growth then OOMKill is the hallmark of an unbounded idle-connection pool:

```bash
kubectl -n <ns> get pod -l <ingress-selector> -o=jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\t"}{.status.containerStatuses[0].lastState.terminated.reason}{"\n"}{end}'
```

Repeated `OOMKilled` entries with rising restart counts are the signature.

Pull the current connection counts from each proxy pod and compare to the configured limit:

```bash
# ingress-nginx:
for pod in $(kubectl -n <ns> get pod -l <selector> -o name); do
  echo "=== $pod ==="
  kubectl -n <ns> exec "$pod" -- curl -s http://localhost:10254/metrics | \
    grep -E 'nginx_connections_active|nginx_connections_reading|nginx_connections_waiting'
done
```

A pod with `nginx_connections_waiting` close to `max-worker-connections` is the stuck pod.

Examine upstream health-check failures on the outer load balancer — these occur during the window a proxy is unable to accept:

```bash
# ALB2 / external LB logs — depends on the platform. Confirm failures correlate
# with the proxy pod crash timestamps from the first command.
kubectl -n <ns> logs deploy/alb-<ingress> --since=10m | \
  grep -E 'upstream|refused|timeout'
```

After Step 3's change takes effect, the metric trace from the per-pod scrape flattens: you should see `nginx_connections_active` stabilise, `nginx_connections_waiting` decrease as old keep-alives expire, and `nginx_connection_requests` continue to rise as new requests are served. Restart count should stop incrementing.

If restarts continue after the keep-alive cap is in place, the problem is elsewhere — either the new proxy version has a genuine memory leak (check for known issues / upstream CVEs on the proxy project), or the per-request buffer setting is too aggressive for the request size. In that case, capture a proxy heap profile or an `SIGQUIT` backtrace (for HAProxy: `show info`, `show stat`, `show threads`) and take the data to the proxy component's maintainer.
