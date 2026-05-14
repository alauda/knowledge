---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Java Application in a Pod Fails with java.net.SocketTimeoutException
## Issue

A Java application running inside a pod logs a `java.net.SocketTimeoutException` when calling a remote service. The exception is exposed in the pod's stdout/stderr and frequently looks like:

```text
java.net.SocketTimeoutException: Read timed out
  at java.base/sun.nio.ch.NioSocketImpl.timedRead(...)
  at <client library>...
  at com.example.MyService.invokeBackend(MyService.java:142)
```

Or, on the connect path:

```text
java.net.SocketTimeoutException: connect timed out
```

The application is otherwise running. The question is *why* the call exceeded its socket deadline — that is, whether it is the network in between, the remote server, or the application itself.

## Root Cause

`SocketTimeoutException` is a JDK-level class that the runtime raises when an I/O operation on a socket — usually a read, sometimes a connect — does not complete within the timeout configured on that socket. The exception itself is a symptom, not a cause; it tells the caller that the deadline was exceeded but says nothing about whose deadline, or what happened on the wire. There are three families of root cause:

1. **Network connectivity between the pod and the remote endpoint is broken or degraded.** Packet loss, MTU mismatch, an intermediate firewall dropping the connection, NAT-table exhaustion on a node, or a misconfigured Service / NetworkPolicy can all cause requests to leave the pod and never reach the server (or for responses to never come back). The socket sits open, gets nothing for the timeout window, and aborts.

2. **The remote server is reachable but slow.** TCP handshake completes; the request is sent; the server takes longer than the client's read timeout to compute and return the response. From the client's point of view this is indistinguishable from a network drop — the failure is identical (`Read timed out`) but the server-side log shows the request being processed normally, just past the deadline.

3. **The client-side socket timeout is too aggressive for the workload.** Defaults in some HTTP clients are aggressive (a few seconds for read), and a workload that legitimately takes longer (a long DB query, a batch job, a slow downstream) hits the deadline even though every other component is healthy.

The diagnostic discipline is to identify *which* of the three applies before changing anything; raising a timeout in the application without checking is not a fix when the cause is a dropped firewall rule.

## Resolution

Address the cause that diagnosis turned up. The recommendation is *not* to raise the socket timeout reflexively — that often masks a real problem. Work the steps in `Diagnostic Steps` first to narrow down the cause, then apply the matching change:

- **Cause: network connectivity broken.** Fix the network. This may mean adjusting a `NetworkPolicy` to allow the egress, fixing DNS for the remote hostname, working with the network team on a downstream firewall rule, scaling the conntrack table on the affected node (`nf_conntrack_max`), or — in cluster-egress paths — confirming the SNAT IP has been allow-listed by the destination.

- **Cause: remote server too slow.** The client cannot fix the server. Either coordinate with the remote service team to bring p99 latency back below the client deadline, or raise the client's socket timeout consciously (and document it). For an HTTP client like Apache HttpClient, OkHttp, or the JDK 11+ `java.net.http.HttpClient`, the relevant knob is the `socketTimeout` / `readTimeout` builder option:

  ```java
  HttpClient client = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(5))   // TCP handshake deadline
      .build();

  HttpRequest req = HttpRequest.newBuilder()
      .uri(URI.create("https://backend.example.svc.cluster.local/api"))
      .timeout(Duration.ofSeconds(30))         // per-request read deadline
      .build();
  ```

  Choose values driven by the observed p99 of the remote call plus a margin, not by guesswork.

- **Cause: client deadline too tight.** Same fix shape as above — raise the timeout on the client, but also look at whether the remote call should be made asynchronously or batched if the latency is *legitimately* long.

In all three cases, exposing a metric for the failure (counter on `SocketTimeoutException` raised, histogram of remote-call duration) is worth the small investment — repeat occurrences are then visible on the application's existing dashboards rather than buried in pod logs.

## Diagnostic Steps

The order below works through the three causes from "outside the pod" to "inside the pod".

### 1. Confirm what the client is actually doing

A `SocketTimeoutException` could be on the connect path (no TCP handshake within the deadline) or on the read path (handshake succeeded, but no response within the deadline). The two have different root causes; the JVM stack trace makes the distinction:

- `connect timed out` ⇒ TCP SYN got no SYN/ACK → DNS or layer-3/4 reachability problem.
- `Read timed out` ⇒ handshake succeeded, application sent its request, server (or the network on the return leg) failed to deliver a response in time.

Capture the stack trace and route the next step on whichever it is.

### 2. Reproduce the call from inside the pod with `curl`

Detach from the application's HTTP client and exercise the same endpoint with a known-good tool. From inside the pod:

```bash
kubectl exec -it -n <ns> <pod> -- sh -c '
  time curl -v --connect-timeout 5 --max-time 30 \
       https://backend.example.svc.cluster.local/api/health
'
```

Three outcomes and what they mean:

- **`curl` succeeds quickly.** The network and the server are fine. The application's own timeout is too tight, or the application is sending a slower / heavier request than the health check.
- **`curl` connects but the response is slow / times out.** The server is the bottleneck; the network is fine. Investigate the server side.
- **`curl` fails to connect at all.** Layer-3/4 problem. Pull DNS first (`nslookup backend.example.svc.cluster.local`), then test reachability to the resolved IP and port (`nc -zv <ip> <port>`).

If the pod image is too minimal to have `curl`, use a sidecar debug container or `kubectl debug -it <pod> --image=curlimages/curl --target=<container>`.

### 3. Look at the server side

If the failure looks like "connect succeeded, response slow", verify the server's own metrics for latency around the time of the failure. Capture the request id from the client (most HTTP clients add one) and grep for it in the server's log. A common pattern is that the server logs the request as completing in 30+ seconds while the client's read timeout was 10 — both sides "succeeded" by their own definition; the deadline mismatch is the actual issue.

### 4. Capture packets at both ends

When the client and server reports disagree, capture pcap on both sides simultaneously. From inside the pod:

```bash
kubectl exec -it -n <ns> <pod> -- sh -c '
  apk add tcpdump 2>/dev/null || apt-get install -y tcpdump 2>/dev/null
  tcpdump -i eth0 -w /tmp/client.pcap host backend.example.svc.cluster.local
'
```

(If the pod image cannot install `tcpdump`, use a debug container with `--share-processes` or a sidecar with `NET_ADMIN`.)

On the server side, run the equivalent capture, then offload both files (`kubectl cp`) and compare in Wireshark. The pattern that confirms a network drop is: SYN sent, no SYN/ACK received, retransmits visible in the client capture, no SYN seen at all in the server capture — a packet was dropped between them. The pattern that confirms a slow server is: handshake completes, request sent, no response data in either capture for the full duration of the client timeout; eventually the server replies and the client has already torn the connection down.

### 5. Check NetworkPolicy and DNS

If the pod can resolve other hostnames but not this one, the resolver may be returning `NXDOMAIN` quickly — but a misconfigured `search` path can convert that into 5-second timeouts as the resolver iterates through suffixes. From inside the pod:

```bash
kubectl exec -it -n <ns> <pod> -- sh -c '
  cat /etc/resolv.conf
  time getent hosts backend.example.svc.cluster.local
'
```

If `resolv.conf` carries a long `search` list and the lookup takes seconds, prepend the fully-qualified name with a dot (`backend.example.svc.cluster.local.`) in the application's URL to skip the search phase, or shorten the namespace-scoped name to one the search list resolves quickly.

If a `NetworkPolicy` is defined in the source namespace, confirm that egress to the destination is permitted:

```bash
kubectl -n <ns> get networkpolicy
kubectl -n <ns> describe networkpolicy <name>
```

A default-deny egress policy without an explicit allow for the destination produces exactly the symptom in step 2 (`curl` fails to connect, no DNS or routing problem).

Working through these five steps narrows the cause to one of the three buckets in `Root Cause`; only then is it safe to change a timeout, a NetworkPolicy, or open a ticket against the remote service.
