---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Application pod restart from OOMKilled and liveness probe timeout on ACP

## Issue

On Alauda Container Platform (Kubernetes v1.34.5, Ubuntu 22.04.1 LTS nodes, kernel 5.15.0-56-generic), an application container is terminated when its memory usage reaches the configured `resources.limits.memory`. The kubelet stamps the container's terminated state with the canonical reason value `OOMKilled`, which surfaces on the Pod status under `status.containerStatuses[].state.terminated.reason` or, after a restart, under `status.containerStatuses[].lastState.terminated.reason` (with the matching `exitCode`, `finishedAt`, `signal`, and `containerID` fields populated per the upstream Pod v1 shape).

When the same container is restarted by the kubelet and is OOM-killed again on each retry, the kubelet escalates the restart policy into a back-off loop and reports the container under `status.containerStatuses[].state.waiting.reason` with the canonical reason value `CrashLoopBackOff` — the standard upstream Pod v1 reason for a container that repeatedly fails to come up.

Under the same memory pressure, the kubelet's liveness probe against the container can also fail before the cgroup limit is reached, because the upstream `Probe` shape defaults `timeoutSeconds` to `1` (with `periodSeconds` `10` and `failureThreshold` `3`); when the application thread is paused by the kernel memory subsystem, a 1-second HTTP probe times out and the kubelet logs a `prober.go:NNN] Liveness probe for <pod>:<container> failed (failure): Get http://...: net/http: request canceled (Client.Timeout exceeded while awaiting headers)` line that is then visible via the kubelet's journal unit.

## Root Cause

The container's working-set memory under load exceeds the value set in `resources.limits.memory`. When the cgroup memory controller terminates the offending process, the container ends with `state.terminated.reason=OOMKilled` and the kill is reflected on the Pod object; if the Pod's `restartPolicy` permits, the container is restarted, and repeated failures of the same form surface `state.waiting.reason=CrashLoopBackOff` on subsequent attempts.

The same memory pressure also stalls in-process work long enough that the default 1-second liveness probe timeout fires; the kubelet treats successive failures (default `failureThreshold=3`) as a failed probe and restarts the container, which compounds the OOM-driven restart cycle observed on the Pod status.

## Resolution

Raise the container's memory budget on the workload's Deployment (or other controller) by setting `resources.requests.memory` and `resources.limits.memory` to values that cover the application's peak working set. The Pod spec field shape `containers[].resources.{limits,requests}` is the upstream `map[string]Quantity` (keys `memory`, `cpu`, `ephemeral-storage`) and is identical on ACP, so a standard manifest applies verbatim:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
        - name: my-app
          image: my-app:latest
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "500m"
```

Apply the change with a standard rollout:

```bash
kubectl apply -f my-app-deployment.yaml
kubectl rollout status deploy/my-app
```

Where the liveness probe is also tripping under load, relax the probe budget so the 1-second default does not fire during transient memory pressure. The `Probe` shape exposes `timeoutSeconds`, `periodSeconds`, and `failureThreshold` directly on the container spec, and raising `timeoutSeconds` (and, if needed, `failureThreshold`) gives the application time to respond when the kernel briefly pauses it:

```yaml
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          timeoutSeconds: 5
          periodSeconds: 10
          failureThreshold: 3
```

For workloads whose memory footprint scales with traffic (peak-hour load, batch windows), pair the limit increase with a `HorizontalPodAutoscaler` so that replica count grows before any single replica reaches its limit. The HPA api-group `autoscaling/v2` (`HorizontalPodAutoscaler`, short name `hpa`) is present on ACP unchanged and accepts the standard upstream spec:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 75
```

```bash
kubectl apply -f my-app-hpa.yaml
kubectl get hpa my-app
```

## Diagnostic Steps

Identify the killed container and confirm the terminated reason on the Pod object directly. The `OOMKilled` reason is what the kubelet writes when the cgroup memory controller terminates the container process, and it appears on `state.terminated.reason` on the current attempt or on `lastState.terminated.reason` after the container has been restarted:

```bash
kubectl get pod <pod> -o yaml
kubectl get pod <pod> \
  -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}'
kubectl get pod <pod> \
  -o jsonpath='{.status.containerStatuses[*].state.terminated.reason}'
```

Check whether the same container is now in a back-off loop. The waiting reason `CrashLoopBackOff` on the container status is the kubelet's canonical signal for repeated failures, and on a pod that keeps OOM-killing this is the value that appears:

```bash
kubectl get pod <pod> \
  -o jsonpath='{.status.containerStatuses[*].state.waiting.reason}'
kubectl describe pod <pod>
```

When liveness-probe failures are suspected as a contributing trigger, read the kubelet journal on the node where the pod was scheduled — the `prober.go` log line surfaces probe failures in the upstream format and the kubelet on ACP nodes runs as a plain systemd unit `kubelet.service`, so `journalctl -u kubelet` exposes the same line shape:

```bash
kubectl get pod <pod> -o jsonpath='{.spec.nodeName}'
journalctl -u kubelet --since "1 hour ago" | grep -E 'prober.go.*Liveness probe'
```
