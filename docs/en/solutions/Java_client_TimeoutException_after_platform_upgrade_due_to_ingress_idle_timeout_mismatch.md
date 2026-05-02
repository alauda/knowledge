---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After a platform upgrade, Java microservices that talk to other services
through the cluster's ingress start to hang intermittently. The
application logs:

```text
java.util.concurrent.TimeoutException:
  Did not observe any item or terminal signal within 300000ms in 'flatMap'.
```

The pattern is reproducible: as long as the application keeps the same
HTTP connection idle for around five minutes, the next request on that
connection hangs and is eventually aborted by the application's
own `responseTimeout`. The same call against the service's internal
ClusterIP (bypassing the ingress) does not exhibit the problem.

## Root Cause

The ingress proxy (HAProxy in the cluster's ingress data plane) is
configured with a connection idle timeout in the order of five minutes.
When a downstream client opens a TCP connection to the ingress and then
holds it idle past that timeout, the proxy sends a `FIN` to close the
connection.

A Java HTTP client backed by Reactor Netty (or any other client that
maintains a connection pool) does not necessarily detect the proxy-side
close until it tries to use the connection again. On the first request
after the proxy has closed, the client sends bytes onto a half-open TCP
connection, the kernel returns no data, and the request stalls until the
client's own response timeout fires.

A platform upgrade exposes the issue when the proxy's behaviour around
idle connections becomes more aggressive — newer HAProxy releases close
idle connections more eagerly to reduce memory footprint, and the
cluster CNI's connection-tracking layer enforces stricter conntrack
timeouts than the previous SDN. The application logic did not change;
the time window in which a half-open connection survives unnoticed by
the client got smaller.

## Resolution

Make the client's idle-eviction policy strictly more aggressive than the
ingress proxy's idle timeout. With Reactor Netty's `ConnectionProvider`,
configure `maxIdleTime` to be a few seconds below the proxy's idle
timeout and enable `evictInBackground` so idle connections are pruned
proactively rather than at the next request:

```java
ConnectionProvider provider = ConnectionProvider.builder("customPool")
    .maxIdleTime(Duration.ofSeconds(290))   // < proxy idle timeout (e.g. 300s)
    .evictInBackground(Duration.ofSeconds(300))
    .build();

HttpClient httpClient = HttpClient.create(provider);

WebClient webClient = WebClient.builder()
    .clientConnector(new ReactorClientHttpConnector(httpClient))
    .build();
```

The same pattern applies to other connection pools:

- Apache HttpClient: `setConnectionTimeToLive` and a
  `IdleConnectionEvictor` thread.
- OkHttp: `ConnectionPool(maxIdleConnections, keepAliveDuration)` —
  set `keepAliveDuration` below the proxy's idle timeout.
- gRPC channels: `keepAliveTime` and `keepAliveTimeout` on the channel
  builder; combined with HTTP/2 PING frames they detect a half-open
  connection without relying on a fresh request.

For workloads where modifying the client is impractical (third-party
clients, legacy code), the alternative is to stretch the ingress proxy's
idle timeout. On the cluster's ingress controller / ALB / route /
ingress-class object, expose a tuning knob that maps to the underlying
proxy's `client-timeout` / `keep-alive-timeout` field and raise it to a
value larger than the longest expected client idle time. Trade-off: a
longer idle timeout means the proxy keeps connections around longer and
its memory footprint grows.

## Diagnostic Steps

1. Confirm the failure correlates with idle time on the connection. From
   the application pod, drive a request once and then again after about
   six minutes of silence — the second request hangs.

2. Confirm the issue is at the ingress, not within the application.
   Repeat the same scenario against the service's internal ClusterIP.
   No hang means the proxy's idle timeout is involved.

3. Confirm the proxy's idle timeout. The exact field depends on the
   ingress controller / ALB:

   ```bash
   kubectl get ingressclass -o yaml
   kubectl get <controller-cr> -A -o yaml | yq '.spec.tuning'
   ```

4. Capture the half-open behaviour with `tcpdump` on the application
   node, filtering for the application's egress port. A `FIN` from the
   ingress IP arriving roughly five minutes after the last data exchange
   is the proof.

5. After applying the client-side eviction policy, repeat the original
   scenario. The half-open connection is reaped before it can be reused
   and the request completes normally.

6. As a defensive step, cap any client-side `maxIdleTime` you set across
   the codebase to a value below the cluster's ingress idle timeout
   minus a 10 second safety margin — the gap protects against the
   client's eviction loop firing right as the proxy's timer expires.
