---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Enabling Debug Logging on Istio Sidecars and Gateways with istioctl
## Issue

When triaging mesh traffic — a request that is being rejected by mTLS, a route that is not matching, a destination that intermittently returns 503 — the default log level on Envoy sidecars and gateways rarely carries enough detail. Operators need to raise Envoy's log verbosity on a specific proxy for a short window (often on a single pod, sometimes restricted to a single logger like `http` or `rbac`), and then return it to the steady-state level once the investigation is over.

Restarting the workload just to change a log level is disruptive: it re-establishes mTLS handshakes, moves the traffic share to other replicas, and — for stateful workloads — loses useful signal. The investigation should happen live.

## Resolution

The Service Mesh deployment ships with the Istio CLI, `istioctl`. Its `proxy-config log` subcommand talks to the target pod's Envoy admin API and mutates log levels in place, with no pod restart. This works uniformly against sidecars injected into application namespaces and against ingress/egress gateway pods.

1. Identify the target pod (a sidecar-injected application pod, or a gateway pod in the mesh control namespace):

   ```bash
   kubectl -n <app-ns> get pods
   ```

2. Raise the proxy to global debug while you reproduce:

   ```bash
   istioctl proxy-config log <pod-name> -n <app-ns> --level debug
   ```

3. Verify which loggers are now enabled — useful on a machine where someone else may have already changed levels:

   ```bash
   istioctl proxy-config log <pod-name> -n <app-ns>
   ```

   Example output:

   ```text
   active loggers:
     default: debug
   ```

4. For a more surgical view, target individual Envoy loggers instead of raising the whole proxy. Common scopes:

   ```bash
   # HTTP-level routing / filter chain
   istioctl proxy-config log <pod-name> -n <app-ns> --level http:debug

   # mTLS / peer authentication / secrets fetch
   istioctl proxy-config log <pod-name> -n <app-ns> --level secret:debug,upstream:debug

   # AuthorizationPolicy evaluation
   istioctl proxy-config log <pod-name> -n <app-ns> --level rbac:debug
   ```

   The `--level` flag accepts a comma-separated list of `logger:level` pairs. Loggers that are not mentioned keep their current level.

5. Once the problem is reproduced and captured, return the proxy to its default level. `warning` is the usual steady state; `info` is reasonable if you want slightly more context in steady-state operations:

   ```bash
   istioctl proxy-config log <pod-name> -n <app-ns> --level warning
   ```

The log-level change lives in the Envoy process's in-memory state. If the pod is restarted (deployment rollout, node drain, crash), the level reverts to whatever the `sidecar.istio.io/logLevel` annotation or the mesh-wide default specifies — this is desirable for debug sessions because it bounds the blast radius of forgetting to turn the level back down.

## Diagnostic Steps

Use the following checks to confirm the change took effect and is not being masked by another source of configuration:

1. **Confirm the new level is active.** Re-run the read form and match the expected scope:

   ```bash
   istioctl proxy-config log <pod-name> -n <app-ns>
   ```

2. **Stream the Envoy log while reproducing the incident.** The combined log now contains per-request details for any logger you raised:

   ```bash
   kubectl -n <app-ns> logs <pod-name> -c istio-proxy -f
   ```

3. **If nothing new appears at the higher level**, double-check that you targeted the correct pod (for example, for a route problem on ingress you almost certainly want the gateway pod, not the application) and that the pod actually has the `istio-proxy` container — workloads in the mesh without sidecar injection will not be affected by `istioctl proxy-config log`:

   ```bash
   kubectl -n <app-ns> get pod <pod-name> -o jsonpath='{.spec.containers[*].name}{"\n"}'
   ```

4. **When the session is complete**, reset the level and, optionally, archive the captured log. If the workload has a persistent need for a non-default level, promote it to an annotation on the pod template instead of relying on a live `istioctl` session:

   ```yaml
   metadata:
     annotations:
       sidecar.istio.io/logLevel: "info"
   ```

   This way the level survives restarts and is visible in the manifest, which makes the configuration auditable.
