---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.10.x
  - 3.12.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Finding which hop cuts a request through ALB on ACP: truncated large responses, 60-second cuts, 504 and SSE bursts

Related articles: [ALB cuts long HTTP or TCP connections at about 120 seconds: proxy timeouts on ACP](ALB_cuts_long_HTTP_or_TCP_connections_at_about_120_seconds_proxy_timeouts_on_ACP.md).

## Issue

A request that passes through an Alauda Load Balancer (ALB) and one or more devices in front of it fails, and it is not clear which hop is responsible. Typical reports:

- A large API response (for example JSON larger than about 1 MB) returns only about half its body through the platform entry address or domain, and the backend logs "broken pipe". A smaller response from the same service is complete, `curl` on the server returns the full body, and the same API works in another environment. The request is to check the ALB for a response-size limit, proxy buffers or timeouts.
- A request is cut at exactly 60 seconds, and the ALB has no 60-second timeout.
- A client receives `504` and asks whether the ALB timed out and which value is best practice.
- Server-sent events (SSE) or chunked output arrive in one burst; a team asks whether `proxy_buffering` or `proxy_cache` can be turned off for one domain.

The effective timeout of a chain is the smallest one along it, and the hop that closes first is often in front of the ALB.

## Root Cause

### Cause 1: a large response is truncated because an HAProxy VIP in front of the ALB resets the connection

The ALB `nginx` log shows, while the failure is reproduced:

```text
writev() failed (104: Connection reset by peer) while reading upstream, client: <haproxy-node-ip>, ... request: "GET /<path>?<query> HTTP/1.0"
```

The access-log line for the same request records status `200 200` and a request time of about `0.242` seconds. The platform entry address is a VIP served by HAProxy on two nodes in front of the ALB. The HAProxy layer closed the connection on its side while the ALB was still writing the large response, the ALB write failed with `Connection reset by peer`, and the client received a truncated body. The backend's "broken pipe" is consistent with the ALB giving up the upstream connection after its client side was reset.

Two facts place the fault in front of the ALB: the client address in the error line is an HAProxy node, and the same request sent directly to the ALB address returns the full response. The ALB is not truncating. ALB timer differences between environments (for example `proxy_read_timeout` 300s against 120s) do not explain it either, because no timer is reached by a request that finishes in a quarter of a second.

### Cause 2: requests are cut at exactly 60 seconds by a device in front of the ALB

The ALB `nginx` log shows `epoll_wait() reported that client prematurely closed connection, so upstream connection is closed too while sending request to upstream`, with many `client closed connection while waiting for request` lines around the same time. The ALB ConfigMap has no 60-second value (`proxy_connect_timeout 5s;`, `proxy_send_timeout 120s;`, `proxy_read_timeout 120s;`, `keepalive_timeout 65;`). The ALB logged the error passively when it tried to answer: the requester side had already closed. In a chain such as domain mapping, WAF, cloud ELB and then the ALB, the 60-second limit belongs to a device in front of the ALB (a load balancer idle timeout, a WAF or a proxy).

### Cause 3: a 504 Gateway Timeout, and whether the ALB is the hop that timed out

An ALB timeout shows as HTTP `504`, usually with the response headers `X-Error: 504` and `Via: alb`, and `upstream timed out` in the ALB error log, close to the configured timeout after the request started. A cloud load balancer or WAF in front can return its own `504` first. The common ALB default is 120 seconds; the effective value depends on the platform version, the ALB type and any load balancer in front, so read it from the configuration loaded in the environment.

### Cause 4: SSE or chunked output arrives in one burst

The ALB template already sets `proxy_buffering off`, and `proxy_cache` is unset, so its default `off` applies; `proxy_request_buffering` is also off by default. These ALB parameters are global only; they cannot be set per domain or per Ingress rule, and they do not need to be. When output still arrives in one burst, an outer nginx in front of the ALB is buffering, or the backend buffers the stream before it writes to the socket.

## Resolution

### Cause 1: a large response is truncated because an HAProxy VIP in front of the ALB resets the connection

Only when the ALB log shows the `writev() failed (104: Connection reset by peer)` line with an HAProxy node as the client, and a direct request to the ALB returns the full body:

1. Hand the evidence to the owner of the HAProxy layer: the ALB error line with its timestamp and client address, the `200 200` access-log line with its request time, and the two `curl` results (through the VIP and direct to the ALB) from the Diagnostic Steps.
2. Have that owner find the matching session in the HAProxy log at the same timestamp and review why HAProxy closed it. The session termination state in the HAProxy log shows which side ended the session and in which phase.
3. If the working environment has a similar layer in front of its ALB, compare that layer's configuration as well.
4. After the HAProxy configuration is changed, repeat the large request through the VIP and compare the downloaded size with the direct request.

Raising ALB timeouts or changing ALB proxy buffers is not the fix for this signature, because the ALB returns the complete response when called directly.

### Cause 2: requests are cut at exactly 60 seconds by a device in front of the ALB

Do not change the ALB. Walk the chain in front of it and find the device with a 60-second limit. Have that device's owner raise it above the request duration, and keep the ALB timer at or above it.

### Cause 3: a 504 Gateway Timeout, and whether the ALB is the hop that timed out

There is no universal value. Size the timeout to the longest normal request plus a margin: ordinary HTTP can keep the default, and long queries, large transfers or model inference may be evaluated for 300 to 600 seconds. Avoid unlimited increases: slow connections hold more ALB connections, file descriptors and memory, backend failures surface later, a slow backend or an exhausted connection pool is not fixed, and a shorter timer in front still wins. How to change the ALB timers is in the related article; how to order the timeouts of an external load balancer and the ALB is in [Diagnosing HTTP 504 timeouts behind an external load balancer on ACP](Diagnosing_HTTP_504_timeouts_behind_an_external_load_balancer_on_ACP.md).

```bash
curl -sk -o /dev/null -D - -w 'total=%{time_total}\n' https://app.example.com/<slow-path> | grep -iE '^HTTP|x-error|^via|total='
kubectl -n cpaas-system logs <alb-pod> -c nginx --since=30m | grep 'upstream timed out' | tail
```

### Cause 4: SSE or chunked output arrives in one burst

Do not add another `proxy_buffering off` on the ALB or a per-domain buffering setting. Call the ALB VIP or node port directly, bypassing the outer nginx, with the same stream URL:

- If the direct call streams and the outer URL does not, disable buffering and lengthen the read timeout on that outer nginx.
- If both arrive in one burst, the backend is buffering the stream before it writes to the socket; fix it in the application.

```bash
kubectl -n cpaas-system get configmap <alb-name> -o yaml | grep -n -E 'proxy_buffering|proxy_cache'
curl -sk -N --resolve app.example.com:443:192.0.2.20 https://app.example.com/<stream-path>
```

## Diagnostic Steps

1. Search the ALB log for the close signatures. Each points to a different cause:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep <alb-name>
   kubectl -n cpaas-system logs <alb-pod> -c nginx --since=1h | grep -E 'Connection reset by peer|writev\(\) failed|prematurely closed|upstream timed out' | tail
   ```

   - `writev() failed (104: Connection reset by peer) while reading upstream`: the ALB's client reset the connection while the response was being written (Cause 1).
   - `client prematurely closed connection` (status `499`) at a fixed duration such as 60 seconds: a device in front closed on a timer (Cause 2).
   - `upstream timed out`: an ALB proxy timer expired (Cause 3, and the related article).

2. Compare the client address of the error line with the addresses of the nodes in front of the ALB, and check which process listens and which node holds the VIP:

   ```bash
   ip -o addr show | grep '<vip>'
   ss -ltnp | grep -i haproxy
   ```

3. Send the same request through the entry address and directly to the ALB, and compare the downloaded size and time. `--resolve` keeps the host name and TLS SNI the same in both requests. In this example `198.51.100.10` is the entry VIP and `192.0.2.20` is the ALB address:

   ```bash
   curl -sk -o /tmp/via-vip.json -w 'code=%{http_code} size=%{size_download} total=%{time_total}\n' \
     --resolve app.example.com:443:198.51.100.10 'https://app.example.com/<path>?<query>'
   curl -sk -o /tmp/direct-alb.json -w 'code=%{http_code} size=%{size_download} total=%{time_total}\n' \
     --resolve app.example.com:443:192.0.2.20 'https://app.example.com/<path>?<query>'
   ```

   A smaller `size` through the VIP with a complete `size` direct to the ALB is Cause 1. If the direct request is also truncated, the cut is at the ALB or behind it; check the ALB timers and the backend. When `total` through the entry address matches a front device's timeout and the direct call lasts longer, raise that device (Cause 2).

4. To rule out ALB timers, read them in the ConfigMap with the same name as the ALB. A request time far below every value printed means no ALB timer was involved:

   ```bash
   kubectl -n cpaas-system get configmap <alb-name> -o yaml | grep -n -E 'proxy_(connect|send|read)_timeout|proxy_timeout|proxy_buffering'
   ```

5. For a `504`, a response with `X-Error: 504` and `Via: alb` and an `upstream timed out` line in the ALB log at the same time put the timeout on the ALB; a `504` without `Via: alb` came from a hop in front (Cause 3).
