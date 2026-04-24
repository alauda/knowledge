---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

HAProxy-based ingress pods on infra nodes restart with exit code `137` (`OOMKilled`). The pattern reads:

- Memory of the ingress pod climbs gradually over hours or days, never plateaus, and the container is killed once it crosses its limit.
- Inside the running pod, `ps aux | grep -c haproxy` returns far more processes than expected — typically dozens to hundreds — instead of the steady-state two or three.
- The Prometheus metric `haproxy_backend_current_sessions` is high, with most of the volume showing up against the synthetic backend that fronts SNI passthrough (its name varies by build but the SNI passthrough backend is the common identifier).
- Frequent reload events appear in the ingress pod log (config rebuild, soft reload), each one followed by an additional set of HAProxy worker processes.
- Restarting the ingress pod temporarily clears the symptom, but it returns over the next interval.

The cluster usually serves at least one TLS **passthrough** route to a workload that maintains long-lived client connections — gRPC, WebSocket, or HTTP/1.1 with aggressive keep-alive.

## Root Cause

When the route table changes, HAProxy performs a **soft reload**: a fresh worker is spawned with the new configuration, while the old worker stays alive long enough to drain its in-flight connections. For short HTTP/1.1 traffic this drain happens in seconds and the old worker exits cleanly. For passthrough routes the ingress controller does not terminate TLS — it tunnels the encrypted bytes by SNI — so it has no view of the application-layer protocol and cannot influence connection lifetime. Long-lived sessions (WebSocket, gRPC streaming, persistent keep-alive) therefore pin the old HAProxy worker open for the entire life of the connection.

Combine that with frequent reloads (e.g. every Route or Endpoint change) and worker processes accumulate at a rate faster than connections close. Each worker holds its own copy of the routing data structures and TLS state; total memory grows roughly linearly with worker count. The container memory limit is eventually exceeded and the kernel OOM-killer terminates the pod, which is the `137` exit code observed.

This is consistent with how HAProxy is designed to behave under those traffic patterns; it is not a defect in the platform.

## Resolution

ACP fronts ingress traffic with the **ALB Operator** (`networking/operators/alb_operator`); HAProxy-based ingress runs only as a fallback or in legacy clusters. The mitigation pattern is the same in both cases: shrink the population of long-lived passthrough connections, or shorten the lifetime of HAProxy workers, or both.

### Preferred: ACP ALB with explicit termination strategy

Move the workload off TLS passthrough whenever the application can tolerate TLS being terminated at the edge. ALB supports edge and reencrypt termination; both let the proxy see the HTTP layer, enforce idle timeouts, and close stale streams during reloads.

1. **Identify the passthrough Ingress objects fronting long-lived workloads.** On ALB-managed ingress these appear as `Ingress` resources annotated for SSL passthrough (the exact annotation name follows the ALB project's documentation; check the ALB CR's annotation reference for the cluster):

   ```bash
   kubectl get ingress -A -o json \
     | jq -r '.items[]
              | select(.metadata.annotations
                       | to_entries[]?
                       | select(.key|test("ssl-passthrough|passthrough")))
                       | "\(.metadata.namespace)/\(.metadata.name)"'
   ```

2. **Switch suitable ones to edge or reencrypt termination.** Replace the passthrough annotation with the edge variant and provide a TLS secret for the cluster certificate. With termination at the proxy, ALB sees the HTTP stream and:

   - applies its own idle-timeout to break truly idle WebSocket/gRPC sessions;
   - drains in-flight streams gracefully on reload using HTTP/2 GOAWAY semantics;
   - exposes per-route metrics for connection age, which makes the next iteration of capacity planning data-driven.

3. **For the routes that genuinely need passthrough**, accept that connections cannot be drained at the proxy, and tune two knobs:

   - **Application-side idle timeout.** Have the workload close idle gRPC/WebSocket sessions after a bounded interval (typically 30–60 minutes). This is the only way passthrough connections shorten without disrupting active traffic.
   - **Reduce reload frequency.** Pin route, endpoint, and service churn at the source — for example, by avoiding rolling updates that thrash Endpoints, or by batching Route reconfiguration. Each avoided reload is one fewer wave of stale workers.

4. **Right-size the ingress pod's memory request and limit.** Memory bumps are a temporary cushion, not a fix, but they buy time during the migration above. Set the request and limit on the ingress pod so the worker pile-up has more headroom before the OOM-killer fires.

### Fallback: stock HAProxy ingress (no ALB)

If the cluster runs vanilla HAProxy ingress directly:

- Set HAProxy's `hard-stop-after` to a finite value (e.g. 1 hour) so the old worker is forced to exit even if some streams are still open. Existing long-lived clients see a connection reset and reconnect; the population of stale workers becomes bounded by `hard-stop-after / reload-interval`.
- Run multiple HAProxy replicas behind a Service so that not every reload affects every connection — at least the new connections after a reload spread across less-loaded instances.
- Otherwise the same termination-strategy and idle-timeout advice applies; HAProxy's behaviour is identical regardless of who packages it.

## Diagnostic Steps

Confirm the symptom is HAProxy worker accumulation rather than a single bloated process:

```bash
kubectl top pods -n <ingress-ns>
kubectl top nodes
```

Inspect the ingress pod for `OOMKilled`:

```bash
kubectl describe pod -n <ingress-ns> <ingress-pod>
```

Look in the container status for `lastState.terminated.reason: OOMKilled` and `exitCode: 137`. The current `restartCount` shows how often the kill loop has fired.

Count HAProxy workers inside the pod:

```bash
kubectl exec -it -n <ingress-ns> <ingress-pod> -- bash -c 'ps -eo pid,ppid,etime,rss,cmd | grep haproxy'
```

Healthy steady-state on an idle reload is two or three lines. Tens or hundreds, with `etime` values spanning hours, are the smoking gun for the stuck-drain pattern. Cross-check with reload counts in the controller log:

```bash
kubectl logs -n <ingress-ns> <ingress-pod> --tail=2000 | grep -ci reload
```

A high reload count over a short window combined with a high worker count quantifies the gap between reload rate and connection close rate.

Identify the passthrough hosts that the SNI backend is currently switching on:

```bash
kubectl exec -it -n <ingress-ns> <ingress-pod> -- \
  cat /var/lib/haproxy/conf/os_sni_passthrough.map
```

(The exact path may differ across builds; on ALB-managed ingress check the ALB pod's runtime config dump instead.) Cross-reference those hostnames with the ingress objects:

```bash
kubectl get ingress -A -o wide | grep -E '<hostname1>|<hostname2>'
```

For each, check Prometheus for connection age — `haproxy_backend_current_sessions` paired with `rate(haproxy_backend_connections_total[1h])` shows whether connections turn over or accumulate.

Identify the client pods holding the long-lived connections by extracting source addresses from HAProxy's runtime API or `ss -tn` inside the ingress pod, then matching:

```bash
kubectl get pod -A -o wide | grep <client-ip>
```

That tells you which application is the source of the durable sessions and is the natural starting point for the application-side timeout work.
