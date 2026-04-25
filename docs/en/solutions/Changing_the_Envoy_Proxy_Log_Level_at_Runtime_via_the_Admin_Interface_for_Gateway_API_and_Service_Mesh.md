---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An administrator needs to debug a request flow through an Envoy proxy that backs a `Gateway` (Gateway API) or an `Ingress` / `VirtualService` (Istio Service Mesh) on ACP. The default Envoy log level is `warning`, which is too quiet to see the per-request decisions (route match, retry, circuit-break, upstream selection).

The administrator wants to:

- Raise the log level to `debug` (or a per-component level like `http:debug`) on a single proxy pod.
- Keep the change in effect long enough to capture the failing request.
- Revert to the default afterwards without restarting the pod.

The Gateway / Istio CRs do not expose a `spec.logging.level` knob today — runtime tuning has to happen through Envoy's own admin interface.

## Root Cause

Envoy ships with a built-in **admin interface** bound to a local port inside each Envoy pod (`localhost:15000` is the convention used by Istio and Gateway API implementations on top of it). The admin API exposes runtime knobs that are not part of the configuration push:

- `POST /logging?level=<level>` — set the global log level for all Envoy components.
- `POST /logging?<component>=<level>` — set the level for one component (e.g., `http`, `connection`, `router`).
- `GET /logging` — read the current per-component levels.

Because the admin port is bound to `localhost` (not a Kubernetes Service), it is reachable from inside the pod's network namespace but not from outside. The fix path is therefore "open a shell inside the pod's network namespace and POST to `localhost:15000`."

The change is **runtime-only**: when the pod is restarted, replaced, or rolled, Envoy reads the level from its bootstrap config and you are back to the platform default. There is no `Gateway` / `Sidecar` field that persists this — it is by design (logging is debug-time, not steady-state).

## Resolution

### Step 1 — identify the Envoy pod backing the failing path

For a Gateway API resource, the gateway implementation creates a Deployment with a name derived from the `Gateway`'s `name` and namespace:

```bash
NS=<gateway-namespace>
GW=<gateway-name>

# Find the data-plane Deployment / Pod the Gateway points to.
# Naming varies by implementation; the istio-proxy container name is the constant.
kubectl -n "$NS" get pod -l "gateway.networking.k8s.io/gateway-name=$GW" \
  -o=custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,READY:.status.containerStatuses[?(@.name=="istio-proxy")].ready'
```

For an Istio sidecar attached to an application pod:

```bash
APP_NS=<app-namespace>
APP=<app-deploy>

kubectl -n "$APP_NS" get pod -l app="$APP" \
  -o=jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[?(@.name=="istio-proxy")].ready}{"\n"}{end}'
```

Pick the specific pod that is handling the failing request (correlate with logs / access-log timestamps).

### Step 2 — set the log level via `kubectl exec` (preferred)

The simplest path: exec into the `istio-proxy` container and `curl` the admin endpoint over `localhost`. The container ships with `curl`:

```bash
NS=<gateway-namespace>
POD=<envoy-pod>

# Raise to debug across all components:
kubectl -n "$NS" exec "$POD" -c istio-proxy -- \
  curl -sX POST 'http://localhost:15000/logging?level=debug'

# Or raise only the HTTP layer (less noise):
kubectl -n "$NS" exec "$POD" -c istio-proxy -- \
  curl -sX POST 'http://localhost:15000/logging?http=debug&router=debug&connection=info'
```

Verify the new state:

```bash
kubectl -n "$NS" exec "$POD" -c istio-proxy -- \
  curl -s http://localhost:15000/logging
# Output: a list "<component>: <level>" — confirm the lines you set.
```

### Step 3 — capture the failing request

While the level is `debug`, reproduce the failing path. Tail the Envoy log:

```bash
kubectl -n "$NS" logs "$POD" -c istio-proxy -f
```

Look for the request's correlation lines: route match, host header, upstream chosen, response code, and any `connection refused` / `upstream connect error`. A single failing request typically prints 30–80 lines at `debug` — capture them with a timestamp window or grep on the request ID.

### Step 4 — revert to the default level

When the capture is done, set the level back to avoid permanent noise (and CPU cost — `debug` adds a few % overhead per request):

```bash
kubectl -n "$NS" exec "$POD" -c istio-proxy -- \
  curl -sX POST 'http://localhost:15000/logging?level=warning'
```

Or, if you only changed individual components, set each one back to its prior value (read from the `GET /logging` output captured before Step 2).

If you forget — the level is still ephemeral. The next pod restart resets everything.

### Step 5 — fall back to node-debug when `kubectl exec` is denied

If RBAC blocks `pods/exec` in the gateway namespace (a common posture for production Service Mesh clusters), open a node debug shell on the node hosting the pod and reach into the pod's network namespace via `nsenter`:

```bash
# Find the node:
NODE=$(kubectl -n "$NS" get pod "$POD" -o=jsonpath='{.spec.nodeName}')

kubectl debug node/"$NODE" --image=docker.io/library/ubuntu:22.04 -it -- chroot /host bash
```

Inside the node:

```bash
# Locate the istio-proxy container's PID via crictl:
CID=$(crictl ps --name istio-proxy --label io.kubernetes.pod.name="<pod-name>" -q | head -n1)
PID=$(crictl inspect "$CID" | jq -r '.info.pid')

# POST to the admin port from the container's netns:
nsenter -t "$PID" -n curl -sX POST 'http://localhost:15000/logging?level=debug'
```

Same revert step, with `level=warning`, when done.

This path requires `node/debug` permission and works regardless of `pods/exec` RBAC. Prefer Step 2 when available; the `nsenter` path is the break-glass.

### Step 6 — request a permanent knob if you keep needing this

If you find yourself raising the log level repeatedly for the same Gateway, that is a signal:

- For per-route diagnostics, an `EnvoyFilter` / `Gateway` annotation can attach an access-log entry that captures the request fields you care about, in JSON, at `info` level — without flipping the global log level.
- For chronic incident-response, the platform team should consider exposing a typed `loggingLevel` field on the Gateway / DestinationRule. Track the upstream issue list at <https://github.com/envoyproxy/envoy/issues> and <https://github.com/istio/istio/issues>.

## Diagnostic Steps

If `curl` to `localhost:15000` returns "connection refused", the admin port is not running — verify its presence:

```bash
kubectl -n "$NS" exec "$POD" -c istio-proxy -- ss -ltn | grep 15000
# Expected: LISTEN ... 127.0.0.1:15000
```

If absent, the proxy is started without the admin interface (rare; would be a hardening choice). The Step 5 fallback would also fail — there is no admin endpoint to hit at all, and you would need to redeploy the Gateway with the admin port enabled (a platform-team change).

If the admin endpoint is up but the log lines never arrive at the level you set, check whether your `kubectl logs` is reading the right container and that the container's stdout is not being filtered by a downstream collector with a level filter:

```bash
kubectl -n "$NS" logs "$POD" --all-containers --prefix | grep -E '\[debug\]'
```

Typical valid Envoy log levels: `trace`, `debug`, `info`, `warning`, `error`, `critical`, `off`. `trace` is extremely verbose; reserve it for protocol-level deep dives.

For per-component listings of valid component names, the `GET /logging` output (Step 2 verify) is authoritative — it lists every component the running Envoy build supports.
