---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500587
---

# Pod CrashLoopBackOff with bind address already in use on ACP worker nodes

## Issue

On ACP worker nodes running Kubernetes v1.34.5, a pod can enter `CrashLoopBackOff` when its container fails to acquire the TCP listening port it needs at startup, and the kubelet keeps restarting the container after each failed attempt. The kubelet emits `BackOff` events against the pod as the restart loop continues, which surface in `kubectl describe pod` output the same way as for any other repeated container failure.

The container's own log stream typically ends with a `bind: address already in use` line written by the runtime when the application's `bind(2)` call is rejected. The application-level message immediately preceding that line is application-specific — for example `error received after stop sequence was engaged` or `failed to start metrics server: failed to create listener` — so it is not a reliable cross-application diagnostic on its own. The stable signal across applications is the trailing `bind: address already in use` substring in the container log.

## Root Cause

When a container's `bind(2)` fails this way the standard k8s-side surface is the kubelet's `BackOff` event against the failing container, with the underlying `bind: address already in use` socket-bind failure preserved in container logs. The generic POSIX/Linux meaning of `EADDRINUSE` is that another process attached to the same network namespace already holds the target port, so the new container's `bind(2)` cannot succeed. When the held port is exactly the one the new container needs, every restart attempt fails the same way and the pod stays in `CrashLoopBackOff` indefinitely; in practice the holder is often a host-side process or a third-party in-cluster agent (for example a security, monitoring, or audit agent that is not part of the ACP platform) that opened the port previously and has not released it across the pod restart.

## Diagnostic Steps

Confirm the pod is restarting in a loop and inspect the kubelet's `BackOff` events for the failing container, which appear in the `Events:` section of `kubectl describe pod` whenever the kubelet's restart loop is active:

```bash
kubectl -n <namespace> get pod <pod> -o wide
kubectl -n <namespace> describe pod <pod>
```

Read the container's own log to pick up the bind error. The trailing `bind: address already in use` substring is the load-bearing signal; the line above it varies by application:

```bash
kubectl -n <namespace> logs <pod> -c <container>
kubectl -n <namespace> logs <pod> -c <container> --previous
```

If the log shows the bind error, the cause is another process on the same network namespace already holding the target port. On the affected worker node, identify what is bound to that port (for example with `ss -ltnp` or `lsof -iTCP:<port> -sTCP:LISTEN` from a node debug session) to determine whether the holder is a host-side process or another in-cluster agent.

## Resolution

Stop the process or agent holding the port so the new container's `bind(2)` can succeed. When the holder is a third-party in-cluster agent (a security, monitoring, or audit agent not bundled with ACP) that has retained the port across the pod restart, disable or stop that agent on the affected node before restarting the workload.

After the offending holder is stopped, recreate the affected pods so the kubelet starts fresh containers that can bind their ports and exit `CrashLoopBackOff`:

```bash
kubectl -n <namespace> delete pod <pod>
```

If the port remains held after the suspected holder is stopped — for example because an orphaned process on the worker still owns the socket — reboot the affected worker node to clear the orphaned port holders, after which the rescheduled pods can bind their ports normally.
