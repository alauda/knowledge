---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# ALB alb_lua_shared_dict_free or alb_loop_time alerts and internal_dsl is null or fetch policy fail log lines on ACP

## Issue

An ALB (`global-alb2` or a business ALB) raises a resource or loop-time alert, or its log repeats a line that looks like an error, while traffic is served:

- The alert `alb_lua_shared_dict_free < 10%` for 30 seconds fires, and the ALB log repeats `prometheus.lua:982: log_error(): Error getting 'nginx_http_upstream_request_duration_seconds_bucket...`.
- The alert `alb_loop_time > 1000ms` for 30 seconds fires from the policy `cpaas-alb-rules`.
- The ALB log repeats `worker.lua:57: init_http_rule_dsl(): internal_dsl is null`.
- The ALB log repeats `fetch policy fail`.

Related articles: "ALB error-rate alert fires or the ALB error-rate panel exceeds 100 percent on ACP"; "ALB nginx settings are reverted after a restart or upgrade; change them through the overwrite ConfigMap on ACP".

## Root Cause

### Cause 1: alb_lua_shared_dict_free alert

The alert reports that free space in an ALB Lua shared dictionary is low. The dictionaries are declared in the ALB ConfigMap, for example `lua_shared_dict http_raw` and `lua_shared_dict prometheus_metrics`. A free-space curve that stays flat for days points at a dictionary sized close to its steady-state use rather than at a leak.

On ALB2 v4.1.2 the alert on `global-alb2` is a known defect. Its signature: in the 7-day Lua shared dictionary panel, `balancer_ewma`, `http_certs_cache`, `http_alb_cache`, `http_backend_cache`, `http_raw` and `http_ipc_shared_dict` stay at about 96 to 99 percent free while `prometheus_metrics` is near or below 10 percent, and the log repeats:

```text
[error] ... [lua] prometheus.lua:982: log_error(): Error getting 'nginx_http_upstream_request_duration_seconds_bucket{port="443",rule="global-alb2-00443-<suffix>",upstream_ip="...
```

with an `upstream_ip` label that holds a very long, repeated list of the same healthy backend addresses. Abnormal monitoring metrics keep occupying the dictionary, some ALB metrics go missing or become discontinuous, and errors appear in the log. Business forwarding is not affected. The defect is fixed in the latest 4.2 release.

### Cause 2: alb_loop_time > 1000ms for 30 seconds

`alb_loop_time` does not measure business request latency. It is the total time of one ALB processing loop: fetching and processing Ingress, Service, Endpoint and related resources, generating the nginx configuration, reloading nginx, and updating rule status. The alert fires when that loop takes longer than the threshold for 30 seconds; slow API server responses or slow writes of the configuration file can stretch it. The alert does not affect business traffic by itself.

When the alert fires intermittently and the ALB logs for the window were not retained, the cause cannot be determined afterwards: low node CPU, memory and load in that window do not prove a disk or API server cause.

### Cause 3: worker.lua:57: init_http_rule_dsl(): internal_dsl is null

A new or idle replica logs this line next to certificate-cache and policy-cache lines when the frontend has an empty policy or no backend Service. It is noise and does not indicate a failure.

### Cause 4: fetch policy fail in the ALB log

Inside the ALB, a Go process periodically writes the `policy` file and Lua periodically reads it; Lua can start reading while the file is still being written, and logs `fetch policy fail`. Traffic is served normally. This was seen with ALB image `alb2:v3.16.6` and is optimized in later versions.

## Resolution

### Cause 1: alb_lua_shared_dict_free alert

On ALB2 v4.1.2, upgrade to a release with the fix. Until then, a rolling restart of the ALB releases the metrics memory.

> **Warning:** A rolling restart drops in-flight connections on each replica in turn. Only when the image is v4.1.2 and the signature above matches, with more than one replica Ready. Do not use it to clear an `error-rate` or `alb_loop_time` alert. There is nothing to roll back.

```bash
kubectl -n cpaas-system rollout restart deploy/<alb-deploy>
```

On other versions, check the `alb2` and `nginx` container logs for errors first. If they are clean and the metric has been flat for days, raise both dictionaries to `50m` in the overwrite ConfigMap (`data.http`) and watch whether the alert clears. Edit the existing `lua_shared_dict` lines in place; nginx refuses a configuration that declares the same dictionary twice.

```nginx
lua_shared_dict http_raw 50m;
lua_shared_dict prometheus_metrics 50m;
```

> **Warning:** Applying the overwrite ConfigMap reloads nginx on every replica of the ALB, and a syntax error stops the reload for all its listeners. Each dictionary is allocated per Pod, so memory use grows. Back up the overwrite ConfigMap and check headroom under the `nginx` container limit; restoring the previous values is the rollback. The procedure is in the related overwrite ConfigMap article.

### Cause 2: alb_loop_time > 1000ms for 30 seconds

Do not delete or restart the ALB Pod to clear the alert. If it fired once, recovered within about 30 seconds, users were not blocked, and the Pods did not restart, record it and leave the policy. For intermittent firing, make sure the next occurrence leaves evidence: save the `alb2` log of every replica for the window before Pods roll, keep the platform log collection for ALB components long enough, and compare slow loops with what changed at that moment (bulk Ingress or rule edits, certificate updates, API server latency, disk latency on the node).

```bash
for p in $(kubectl -n cpaas-system get pods -l service_name=alb2-<alb-name> -o name); do
  kubectl -n cpaas-system logs "$p" -c alb2 --since=1h > "/tmp/$(basename "$p")-alb2.log"
done
kubectl -n cpaas-system logs <alb-pod> --all-containers --since=3h | grep -E 'reload:|reload timeout|generate conf|reload load balancer'
```

### Cause 3: worker.lua:57: init_http_rule_dsl(): internal_dsl is null

No change. Attach a Service to the frontend when it should carry traffic. If requests are failing on a replica that serves traffic, look elsewhere; this line is not the failure.

### Cause 4: fetch policy fail in the ALB log

If the services behind the ALB answer normally, ignore the line. Upgrading to a release with the optimized policy publishing removes it. Do not edit the policy file inside the container.

## Diagnostic Steps

1. Read the image tag, the declared dictionaries and the metrics error count:

   ```bash
   kubectl -n cpaas-system get pods <alb-pod> -o jsonpath='{.spec.containers[*].image}{"\n"}'
   kubectl -n cpaas-system get configmap <alb-name> -o yaml | grep -n lua_shared_dict
   kubectl -n cpaas-system logs <alb-pod> -c nginx --since=1h | grep -c 'prometheus.lua:982'
   ```

   A v4.1.2 image, `prometheus_metrics` as the only low dictionary, and `prometheus.lua:982` errors: Cause 1 defect. To identify the repeated `upstream_ip` addresses: `kubectl get po -A -o wide | grep -E "<ip1>|<ip2>"`.

2. For `alb_loop_time`, open the policy's monitoring graph for the window and save the `alb2` logs as in Cause 2 before any restart.

3. Check the noise lines:

   ```bash
   kubectl -n cpaas-system logs <alb-pod> -c nginx --since=10m | grep -F internal_dsl
   kubectl -n cpaas-system logs <alb-pod> -c nginx --since=1h | grep -c 'fetch policy fail'
   ```

   With traffic served normally: Cause 3 or Cause 4.
