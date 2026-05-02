---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The platform's edge ingress data-plane pods — the HAProxy-based ALB router pods that serve cluster Ingress traffic — restart frequently with `OOMKilled` as the termination reason. Symptoms:

- The router DaemonSet / Deployment shows accumulated restart counts in the tens or hundreds over a few days:

  ```text
  NAME                              READY   STATUS    RESTARTS         AGE
  router-default-6dxxxf9-4xx6       2/2     Running   69 (9h ago)      13d
  router-default-6dxxx9-7pxx2       2/2     Running   25 (9h ago)      15d
  router-default-6xxxx9-8xxxb       2/2     Running   20 (9h ago)      13d
  router-default-6dxxxf9-cxxz6      2/2     Running   27 (9h ago)      15d
  ```

- `kubectl describe pod` on a restarting router shows the pattern of OOM-driven termination:

  ```text
  Containers:
    router:
      State:        Running
      Last State:   Terminated
        Reason:     OOMKilled
  ```

- Ingress traffic disrupts during the OOMKill / restart window — connections drop, health probes flap, and downstream services see intermittent 503s clustered around the restart.

## Root Cause

The router Deployment ships with both `requests` and `limits` set on its container — a typical spec carries `limits.cpu: "2"` and `limits.memory: "4Gi"`. HAProxy's working-set is dominated by:

- The number of concurrent connections (each one keeps a per-connection buffer).
- The size of the resolved configuration (every Ingress rule is compiled into the running config).
- The reload behaviour — during a config reload, HAProxy briefly holds the old and the new process simultaneously, which can spike memory by ~2x.

On clusters with many Ingress rules and bursty traffic, the steady-state working set sits well under the limit, but the reload spike or a connection burst pushes the cgroup over the limit and the kernel OOMKills the container. The DaemonSet restarts it; cycle repeats.

The container's `requests` reserve resources for scheduling but do not constrain the runtime. The `limits` are the cgroup ceiling that triggers OOMKill — and on a router pod, that ceiling is what hurts. Removing the limits (while keeping `requests` so the scheduler still places the pod sensibly) lets HAProxy use the headroom that is actually available on the node, eliminating the reload-spike OOMKill.

## Resolution

Patch the router Deployment to remove the `resources.limits` block. Keep `requests` so the scheduler still respects the workload's footprint. The patch shape, applied to whichever namespace the cluster's ALB / router controller manages:

```bash
ALB_NS=<alb-or-ingress-namespace>
kubectl -n "$ALB_NS" patch deployment router-default --type=json \
  -p='[{"op": "remove", "path": "/spec/template/spec/containers/0/resources/limits"}]'
```

If the router runs as a DaemonSet, the same patch shape applies — change `deployment` to `daemonset`. If the router has multiple containers (HAProxy + a metrics sidecar), confirm container index 0 is the HAProxy one before applying:

```bash
kubectl -n "$ALB_NS" get deployment router-default \
  -o jsonpath='{.spec.template.spec.containers[*].name}'
```

After the patch:

```bash
kubectl -n "$ALB_NS" rollout status deployment router-default
kubectl -n "$ALB_NS" get pod -l app.kubernetes.io/name=router
```

Restart counts should stabilise; new OOMKill events should stop appearing. Watch over a representative window (24h+) before declaring it fixed — config reloads are bursty, and the previous pattern may take a day to fully not-recur.

### Right-sizing instead of removing the limits

When the cluster runs strict resource governance (every workload must declare a limit), increase the limits rather than removing them. Pick a value with at least 2x headroom over the steady-state working set so the reload spike fits inside it:

```yaml
resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "4"
    memory: "8Gi"
```

The exact numbers depend on the cluster's Ingress count and traffic shape. Use the `process_resident_memory_bytes` HAProxy metric as the input to right-sizing:

```bash
# From a Prometheus that scrapes the router:
process_resident_memory_bytes{job="router"}
```

Take the maximum over a 7-day window, double it, round up to a YAML-friendly value — that is the floor of a safe `limits.memory`.

## Diagnostic Steps

1. Confirm the router's recent terminations are OOM-driven, not crashes:

   ```bash
   ALB_NS=<alb-or-ingress-namespace>
   kubectl -n "$ALB_NS" get pod -l app.kubernetes.io/name=router \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[?(@.name=="router")].lastState.terminated.reason}{"\n"}{end}'
   ```

2. Inspect the deployment's current resources block to confirm a limit is in fact set:

   ```bash
   kubectl -n "$ALB_NS" get deployment router-default \
     -o jsonpath='{.spec.template.spec.containers[?(@.name=="router")].resources}' | jq
   ```

3. Look at the OOM event from the kernel side on the affected node — it captures the cgroup the OOM-killer fired on and the RSS at the moment of kill:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host dmesg -T | grep -iE 'oom|killed process' | tail -30
   ```

4. After the patch, watch HAProxy's resident memory to confirm the working set fits within whatever the new ceiling is (or, if you removed the limit, that it stabilises rather than growing without bound):

   ```text
   process_resident_memory_bytes{job="router"}
   ```

   A stable value over 24h with no further `OOMKilled` events is the success signal.
