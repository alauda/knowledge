---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An application pod restarts intermittently. The kubelet records two distinct symptoms back-to-back on the affected node, both pointing at the same workload:

- A liveness probe times out:

  ```text
  prober.go: Liveness probe for "<pod>" failed (failure):
    Get http://<podIP>:8080/health-check?type=ALIVE:
    net/http: request canceled (Client.Timeout exceeded while awaiting headers)
  ```

- The kernel out-of-memory killer reaps the container shortly after, leaving a cgroup record:

  ```text
  kernel: memory: usage 2457600kB, limit 2457600kB, failcnt 176087
  ```

The crash usually appears under load — peak hours, a burst from an upstream caller, or a slow downstream that backs up the application's request queue. Once the load relaxes the pod runs cleanly again until the next spike.

## Root Cause

Both signals trace back to the same condition: the container is operating right at its memory limit and is starved of CPU at exactly the moment the kubelet probes it. The probe timeout fires because the application is too busy (or too memory-pressured) to answer the health endpoint within the configured window; the OOM kill fires because the working set has grown past the configured limit. The kubelet records the probe failure first because it polls on a faster cadence than the kernel's OOM accounting.

The ratio of `requests` to `limits` aggravates the problem. A container that requests `2m` CPU but allows itself to burst to `1500m` is competing with every other burstable pod on the node every time it tries to scale up — and burstable pods receive CPU only after guaranteed-tier work has been served. Under contention, the application stalls, the probe fails, and the pod is restarted; under sustained pressure, it allocates past its memory limit and is killed.

## Resolution

1. **Right-size CPU and memory requests.** `requests` is what the scheduler reserves and what the kernel guarantees — not `limits`. If the workload routinely uses 800m CPU at peak, request 800m, not 2m. The same applies to memory: requests should reflect the steady-state working set so the scheduler does not pack the node beyond what the workload actually needs.

   ```yaml
   resources:
     requests:
       cpu: "800m"
       memory: "2400Mi"
     limits:
       cpu: "1500m"
       memory: "3000Mi"
   ```

   Leaving headroom between request and limit (memory in particular) reduces the chance of an OOM kill on a transient spike. A 1:1 request:limit on memory promotes the pod to the `Guaranteed` QoS class and prevents it from being evicted before lower-priority work — a sensible default for latency-sensitive workloads.

2. **Tune the liveness probe so it survives a brief stall.** The default `timeoutSeconds: 1` is aggressive for any application that does work in its health endpoint. Increase it to 3–5 seconds, raise `failureThreshold` to 3, and add an `initialDelaySeconds` long enough for warm-up:

   ```yaml
   livenessProbe:
     httpGet:
       path: /health-check?type=ALIVE
       port: 8080
     initialDelaySeconds: 30
     periodSeconds: 10
     timeoutSeconds: 5
     failureThreshold: 3
   ```

   Distinguish liveness from readiness. A readiness probe failure removes the pod from the Service endpoints; a liveness probe failure restarts the container. Many "OOM during peak" reports are actually the liveness probe restarting a healthy-but-slow pod into oblivion.

3. **Distribute load across more replicas.** If a single pod cannot absorb the peak, scale horizontally rather than vertically. A `HorizontalPodAutoscaler` keyed off CPU (or, with metrics-server + an adapter, off a custom metric like queue depth) prevents the next spike from killing the pod set:

   ```yaml
   apiVersion: autoscaling/v2
   kind: HorizontalPodAutoscaler
   metadata:
     name: app
   spec:
     scaleTargetRef:
       apiVersion: apps/v1
       kind: Deployment
       name: app
     minReplicas: 2
     maxReplicas: 10
     metrics:
       - type: Resource
         resource:
           name: cpu
           target:
             type: Utilization
             averageUtilization: 70
   ```

4. **Confirm the application is actually leak-free.** Repeated OOM kills with growing `failcnt` between restarts can mean the application's memory grows unboundedly under load. Capture a heap profile (or the equivalent for the runtime) at peak and walk back to the allocator before assuming the limits are too low.

## Diagnostic Steps

Inspect the pod's restart history and look for the OOM signature:

```bash
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].restartCount}{"\n"}'
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}{"\n"}'
kubectl describe pod <pod> | sed -n '/Last State/,/Ready/p'
```

A `Reason: OOMKilled` confirms the kernel killed the container; pair that with the kubelet probe events:

```bash
kubectl describe pod <pod> | sed -n '/Events/,$p' | grep -E "Unhealthy|OOM|Killing"
```

Capture per-container memory usage to see how close the working set is to the limit:

```bash
kubectl top pod <pod> --containers
```

A container reporting memory `~95%` of its limit at idle is one transient spike away from an OOM kill. From the node, the kernel's OOM record gives the precise moment of death:

```bash
kubectl debug node/<node> -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl -k --since "1 hour ago" | grep -E "Killed process|oom-kill"
```

Cross-reference the timestamps with the application's own logs to confirm whether the kill landed mid-request or during a quiescent moment — a kill at idle points to a leak; a kill mid-request points to under-provisioned limits.
