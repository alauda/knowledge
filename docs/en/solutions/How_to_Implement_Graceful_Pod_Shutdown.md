---
kind:
   - How To
products:
  - Alauda Container Platform
ProductsVersion:
   - 4.x
id: KB260500140
---

# How to Implement Graceful Pod Shutdown

## Overview

When Kubernetes deletes a Pod — whether from a manual `kubectl delete pod` or a Deployment rolling update scaling down old replicas — in-flight requests can fail with connection resets or 5xx errors if the process is not handled correctly.

This document describes how graceful shutdown works in the ACP environment, what Kubernetes and the Gateway (Ingress NGINX, Envoy Gateway) do when a Pod is deleted, and what applications should (and should not) do during termination.

The goal: **all in-flight requests complete normally, and clients are unaware that a Pod was removed.**

## Prerequisites

Two conditions must hold for graceful shutdown:

1. **The Gateway stops routing new traffic to the terminating Pod.** When Kubernetes deletes a Pod, it updates EndpointSlice to mark it `ready=false`. Ingress NGINX and Envoy Gateway watch EndpointSlice and stop forwarding new requests to that Pod. This propagation takes time.

2. **The application does not exit immediately upon receiving a stop signal.** There is a gap between the Pod entering Terminating and the Gateway actually stopping new traffic. If the process exits during that gap, in-flight requests are interrupted.

## 1. What Happens When a Pod Is Deleted

### 1.1 Kubernetes Pod Termination Flow

When a Pod is deleted, Kubernetes executes the following sequence:

```text
Pod is deleted
→ deletionTimestamp is set; Pod enters Terminating state
→ terminationGracePeriodSeconds countdown begins (default 30s)
→ Control plane updates the Service's EndpointSlice
→ kubelet starts the local container stop sequence
→ If a preStop hook is configured, it runs first
→ After preStop finishes, kubelet sends SIGTERM to the container
→ If the grace period expires without exit, SIGKILL is sent
```

Key details:

- **The countdown starts when the Pod enters Terminating**, not when the application receives SIGTERM. The preStop hook duration is included in the same countdown.

- **preStop runs before SIGTERM.** Without preStop, kubelet sends SIGTERM almost immediately. With preStop, SIGTERM waits until preStop completes.

  ```text
  Pod Terminating → preStop → SIGTERM → SIGKILL
  ```

- **preStop consumes the same termination window.** Example:

  ```text
  terminationGracePeriodSeconds: 60
  preStop: sleep 15

  0s       Pod enters Terminating, 60s countdown starts
  0–15s    preStop executes
  15s      SIGTERM is sent
  15–60s   Application has at most 45s to exit
  60s      SIGKILL if still running
  ```

### 1.2 EndpointSlice Update

When a Pod is deleted, the control plane updates the corresponding EndpointSlice. A terminating Pod appears as:

```yaml
conditions:
  ready: false
  serving: true
  terminating: true
```

- `terminating: true` — the Pod has been deleted and is shutting down.
- `ready: false` — normal Service traffic should not be forwarded to this endpoint.
- `serving: true` — the application may still be processing in-flight requests.

`ready=false` is set automatically by Kubernetes because the Pod is terminating. It is independent of the application's readinessProbe result. Even if the readinessProbe is still passing, Kubernetes marks a terminating Pod as `ready=false`.

### 1.3 From EndpointSlice to Traffic Actually Stopping

EndpointSlice being marked `ready=false` does not mean traffic stops instantly. There is a propagation chain:

```text
EndpointSlice updated to ready=false
→ Ingress Controller / Gateway watches and detects the change
→ New traffic stops reaching the old Pod
```

This propagation has latency — typically on the order of seconds. The application must remain alive during this window.

### 1.4 Envoy Gateway Drain Timeouts

Envoy Gateway controls connection draining during graceful shutdown with two parameters:

- **drainTimeout** (default 60s): The maximum time Envoy waits after graceful shutdown begins to drain existing connections. After this timeout, Envoy forcibly exits and closes any remaining connections. For backends with long requests, streaming responses, or long-lived connections (gRPC streaming, WebSocket), this value should be coordinated with the application's `terminationGracePeriodSeconds` to avoid forcible connection termination.
- **minDrainDuration** (default 10s): The minimum time Envoy spends in the drain state before exiting. Even if all connections close early, Envoy waits at least this long. This ensures a baseline drain window regardless of connection state.

```text
Shutdown triggered
→ Envoy enters drain state
→ minDrainDuration (10s): Envoy stays in drain for at least this long
→ drainTimeout (60s): maximum total drain time; Envoy exits after this even if connections remain
→ Any remaining connections are forcibly closed
```

**Guideline**: `drainTimeout` should be ≥ the application's `terminationGracePeriodSeconds`, so Envoy does not close connections before the application finishes.

## 2. What the Application Should Do During Termination

For normal HTTP applications, the answer is simple: **nothing.** The application should continue running normally. After the Gateway sees the EndpointSlice change, it stops forwarding new requests. In-flight requests finish, and then the process exits.

The application does not need to close listeners, reject requests, or return 503. It just needs to stay alive.

### 2.1 When drain Is Needed: Long-Lived Connections

For backends that maintain long-lived connections (gRPC streaming, WebSocket, etc.), the situation is different. After the Gateway removes the endpoint, it does not send new requests to the old Pod, but existing long-lived connections may remain open. The Gateway does not necessarily terminate them. Until those connections are closed, the old Pod continues to receive traffic and cannot exit.

A drain endpoint addresses this: it notifies the application that it is about to be deleted, so the application can proactively close all long-lived connections. Clients detect the disconnect and re-establish connections. New connections are routed by the Gateway to the newly started Pods, and the old Pod's traffic drops to zero.

```text
Application receives drain notification
→ Closes all long-lived connections
→ Clients detect disconnect and reconnect
→ Gateway routes new connections to new Pods
→ Old Pod traffic reaches zero; safe to exit
```

For plain HTTP applications without long-lived connections, implementing a drain endpoint is unnecessary. The only requirement is to not exit immediately on SIGTERM.

### 2.2 Trigger Sources

preStop, SIGTERM, and manual `/drain` calls are different trigger sources for the same action. The application should have a single drain implementation that all sources reuse.

Drain must be idempotent. The same instance may receive multiple triggers concurrently:

```text
preStop calls /drain
SIGTERM handler triggers drain
Manual call to /drain
```

After the first invocation, subsequent triggers should not re-close resources or interrupt in-flight requests.

### 2.3 PID 1 and Signal Forwarding

kubelet sends SIGTERM to PID 1 inside the container. If the application process is not PID 1, it will not receive the signal and will be forcibly killed by SIGKILL after the grace period expires — the same as if it did not handle SIGTERM at all.

This commonly happens when:

- The Dockerfile uses a shell form ENTRYPOINT: `ENTRYPOINT sh -c "java -jar app.jar"`. The shell becomes PID 1, not the JVM.
- A startup script runs the application in the background: `java -jar app.jar &`.

Fixes:

- Use the exec form in the Dockerfile so the application becomes PID 1 directly:

  ```dockerfile
  ENTRYPOINT ["java", "-jar", "app.jar"]
  ```

- Or use `exec` in the shell form to replace the shell process:

  ```bash
  exec java -jar app.jar
  ```

- For containers that run as non-PID 1 by design (e.g., init systems, supervisord), configure the init system to forward signals to the application process.

To verify, run `docker exec <container> ps 1` and confirm PID 1 is the application binary, not a shell.

## 3. Best Practices

### 3.1 preStop: A Fallback for Legacy Applications

preStop primarily solves one scenario: the application exits immediately on SIGTERM and the code cannot be changed. In this case, preStop keeps the process alive during the preStop phase, giving the Gateway time to stop routing traffic.

The actual Gateway propagation time is on the order of seconds. A `sleep 15` in preStop is conservative to provide sufficient margin.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: app
          image: demo-app:latest
          ports:
            - containerPort: 8080
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - "sleep 15"
```

> **Note:** This example assumes the container image includes `/bin/sh` and `sleep`. Minimal images (distroless, scratch) may not have these binaries. In that case, use a lightweight static binary (e.g., `busybox sleep 15`), an `httpGet` preStop hook against a health endpoint, or handle the delay in the application code itself.

Timeline:

```text
0s       Pod enters Terminating, 30s countdown starts
0s       Control plane updates EndpointSlice ready=false
0–15s    preStop sleep; Gateway completes traffic switch (actual: seconds)
15s      preStop ends; kubelet sends SIGTERM
15–30s   Application exits
30s      SIGKILL if still running
```

If the application already handles SIGTERM correctly (does not exit immediately), preStop is unnecessary. Handling SIGTERM in the application is more reliable than relying on preStop.

### 3.2 Applications with Long-Lived Connections: drain + Extended Grace Period

Applications that maintain long-lived connections need two things: a preStop hook that calls the drain endpoint to close long-lived connections, and a sufficiently large `terminationGracePeriodSeconds` to allow time for the shutdown to complete.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 120
      containers:
        - name: app
          image: demo-app:latest
          ports:
            - containerPort: 8080
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - |
                    curl -fsS http://127.0.0.1:8080/drain
                    sleep 15
```

Timeline:

```text
0s        Pod enters Terminating, 120s countdown starts
0s        Control plane updates EndpointSlice ready=false
0s        preStop calls /drain; application starts closing long-lived connections
0–15s     preStop sleep 15s; waits for Gateway switch + connection closure propagation
15s       preStop ends; kubelet sends SIGTERM
15–120s   Application waits for long-lived connections to close, releases resources, exits
120s      SIGKILL if still running
```

The `terminationGracePeriodSeconds: 120` is needed because closing long-lived connections can take significant time (waiting for client reconnections, waiting for streaming requests to finish). If the shutdown completes within 30s, the default value is sufficient.

### 3.3 Summary

- When a Pod enters Terminating, Kubernetes automatically updates EndpointSlice to cut traffic. The application does not need to make readiness fail.
- Normal HTTP applications should not exit immediately on SIGTERM. Staying alive for a few seconds while the Gateway switches traffic is sufficient.
- Applications with long-lived connections should implement a drain endpoint. Upon receiving the drain notification, they proactively close long-lived connections so clients reconnect to new Pods.
- preStop is a fallback for legacy applications that cannot be modified to handle SIGTERM correctly. If the code can be changed, handle SIGTERM in the application directly.
- drain must be idempotent and tolerate repeated triggers.
- livenessProbe should remain successful during drain to avoid kubelet restarting the container and interrupting in-flight requests.
- The default `terminationGracePeriodSeconds` of 30s is sufficient for plain HTTP applications. Only applications with long-lived connections that need more than 30s to shut down should increase this value.
- Even with correct graceful shutdown, a brief failure window exists between Pod deletion and Gateway traffic switch. Clients should implement retry with exponential backoff to handle these transient failures transparently.
