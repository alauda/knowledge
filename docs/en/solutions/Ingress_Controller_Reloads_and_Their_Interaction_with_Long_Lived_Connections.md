---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Ingress Controller Reloads and Their Interaction with Long-Lived Connections
## Overview

Ingress controllers on ACP reconcile their rendered configuration whenever a matching `Ingress` (or ALB `Frontend` / `Rule`) is created, updated, or deleted. Each such change triggers a **reload** — a controlled swap between the old running configuration and the new one. For short-lived HTTP requests, reloads are invisible: new requests land on the freshly-loaded config, in-flight requests drain through the outgoing config, and the whole handoff completes in milliseconds.

For long-lived connections — WebSockets, server-sent events, gRPC streaming, persistent database/message-queue tunnels routed through the ingress — reloads are not invisible. They create a tension between delivering route updates quickly and not disrupting existing connections. This note lays out what that tension looks like, the operator-visible symptoms, and the knobs that exist to resolve it.

## How Reloads Work

All production ingress controllers (nginx-based, HAProxy-based, Envoy-based, and their ACP-bundled variants) implement reload along the same general shape:

1. A change event fires (route added, endpoint updated, TLS secret rotated).
2. The controller renders a new configuration file from the current API state.
3. The controller instructs its data-plane process to adopt the new config. Two families of behaviour exist:
   - **Fork-and-drain**: a new process starts with the new configuration and immediately accepts fresh connections. The old process continues serving its existing connections and exits when they have all closed (or when a hard-stop timer fires). Both processes coexist until the old one drains.
   - **In-place swap**: the existing process accepts a signal (for example `SIGHUP`), re-parses its configuration, and applies the delta to its running state without forking. Active connections keep running on the same process.

ACP's ingress surface uses the in-place style for its nginx-based ALB, which means long connections are not directly disrupted by a config reload — the connection keeps running on the same process, and the next request/event on it is served under whatever rule set is current. A fork-and-drain controller like HAProxy behaves differently: long connections stay pinned to the outgoing old process, which cannot exit until they close.

## The Tension

Regardless of which reload style is in use, long connections expose the same underlying conflict: **fresh route changes should apply immediately, but existing connections cannot reasonably be terminated just because the configuration changed.**

### Fork-and-drain: process accumulation

On a fork-and-drain controller, every reload spawns a new data-plane process. If reloads are frequent (a high-churn cluster with many route updates) and some connections never close (a stale WebSocket whose client is behind a NAT that already forgot the flow, a database connection pool whose keepalive is shorter than the controller's drain timeout), the number of outgoing processes grows. Each process holds memory, file descriptors, and worker threads — enough of them and the pod consumes more resources than expected, crosses a cgroup limit, or hits the node's PID cap.

The recovery mechanism is a hard-stop timer: after a configurable window (hours to a day), the controller kills still-draining processes regardless of connection state. This closes runaway old processes but also drops connections that were in fact healthy, just long-lived.

### In-place swap: stale handling during the critical instant

On an in-place swap controller, a reload is instantaneous from the connection's perspective — no process swap, no drop. But the reload operation still has a brief window where the data-plane process is re-reading its config and building new worker state. Requests arriving exactly during that instant may queue or experience a one-off latency blip. For short-lived requests this is unnoticeable; for a WebSocket handshake exactly at the reload moment, it may show up as a slightly-delayed connect, which most clients tolerate.

### End-to-end effect on long connections

In both families, the contract that matters to the application is: **the connection stays up, and the rule set is eventually consistent with the latest config.** What differs is the cleanup / resource shape on the controller side.

## How to Reason About the Knobs

Four controls matter when an application depends on long-lived connections through an ingress.

### 1. Idle timeouts on the route

The most effective way to prevent runaway old processes is to limit how long a connection can stay idle. An idle-timeout on the route (or on the underlying ALB / `Ingress` annotation) means that if the connection carries no data for the timeout window, the controller drops it — which lets the outgoing process drain. Choose a timeout that is longer than the application's longest expected quiet period but shorter than the infrastructure's worst case (ALB, cloud LB, intermediate NAT all eventually forget stale flows — aligning with the shortest of those caps prevents inconsistent-state surprises).

For ALB-backed ingress, express the idle timeout through the `Frontend` / `Rule` spec or as an annotation on the `Ingress`. For other ingress stacks, consult the controller's timeout taxonomy (`timeout tunnel`, `proxy_read_timeout`, etc.).

### 2. Client-side keepalive

Long connections that should stay open need a keepalive heartbeat. Without one, the controller cannot distinguish "connection is legitimately quiet" from "client went away and the flow is dead". A keepalive at a cadence shorter than the idle timeout keeps the connection classified as active and ensures the controller will clean it up promptly the moment the client really does disconnect.

For WebSocket workloads, use the protocol's `ping` frame at a cadence of ~30–60 seconds. For long-lived TCP, enable TCP keepalives on the client side with a short enough interval to beat the idle timeout.

### 3. Graceful-shutdown window on the controller

On fork-and-drain controllers, the graceful-shutdown window (how long old processes may linger) should be sized for the application's acceptable connection-drop behaviour. Too short, and legitimate long-lived connections are killed at every reload. Too long, and process accumulation becomes the dominant resource issue. A common starting point is a few minutes: long enough to drain most short-lived flows, short enough to reap the outgoing process before a second reload piles on.

### 4. Reload-rate ceiling

Most controllers self-throttle reload frequency to prevent a thrashing cluster from reloading every few seconds. If the default ceiling is short (say, 5 seconds), a high-churn workload may experience reload-driven resource pressure — consider raising the ceiling to batch more changes per reload at the cost of taking slightly longer to propagate an individual route change.

## Symptoms and Diagnosis

### Symptom A: ingress pod memory / CPU climbing steadily

A steadily-climbing resource graph on ingress controller pods, not correlated with traffic volume, is the signature of process accumulation. Inspect the process tree inside the pod:

```bash
kubectl -n <ingress-ns> exec -it <controller-pod> -- ps -ef --forest | head -30
```

Multiple data-plane processes (e.g. several `nginx` or `haproxy` workers under the supervising parent) confirm old processes are lingering. Cross-reference with recent reload events or a reload counter metric if the controller exposes one.

### Symptom B: clients see unexpected disconnects at reload moments

A client that observes periodic TCP `RST`s correlated with ingress reloads is being hit by the graceful-shutdown window expiring. Either the window is too short, or the client's connection is idle for long stretches that exceed the idle-timeout on the route. Correlate the client's disconnect timestamps with `kubectl get events` on the ingress namespace.

### Symptom C: ingress pod OOM or PID-limit kill

An OOMKill or a container-runtime-initiated kill on the ingress pod with a high process count indicates the node's PID cap or the pod's memory limit was hit by accumulated drain processes. Check:

```bash
kubectl -n <ingress-ns> describe pod <controller-pod> \
  | grep -E 'OOMKilled|Last State|Exit Code'
kubectl get pod -n <ingress-ns> <controller-pod> \
  -o jsonpath='{.status.containerStatuses[*].lastState}{"\n"}'
```

Recovery is a hard-stop shortened until the underlying long-connection lifecycle is fixed — do not just keep raising the memory limit, because the problem will reappear at the new limit.

## Validation After Tuning

After adjusting idle timeout, keepalive cadence, or graceful-shutdown window, watch for the ingress pod's resource profile to stabilise across a business cycle. Reloads continue on every legitimate route change; the new pattern should be: memory / CPU fluctuate around a steady mean rather than climbing monotonically, and client disconnects align with idle-timeout expirations rather than arbitrary reload moments.

If the underlying ingress implementation is in-place-swap (as ACP's nginx-based ALB is), process accumulation is not a concern and tuning mainly serves the client side — making sure long-lived flows carry a keepalive that survives any external NAT / LB flow-aging that sits between the client and the ingress pod.
