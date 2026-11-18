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

# ALB error-rate alert fires or the ALB error-rate panel exceeds 100 percent on ACP

## Issue

`global-alb2` or a business ALB raises `error-rate` alerts while the platform or the service works, or the ALB monitoring dashboard shows an error rate above 100 percent:

- The alert `error-rate > 3%` or `error-rate > 5%` for 30 seconds (warning level) fires from the load balancer routing rule alert policy `cpaas-alb-router-rules` for routes such as `ingress/cpaas-system/dex/...` and `ingress/cpaas-system/courier-api/...`.
- Many platform Ingress objects in `cpaas-system` (`dex`, `frontend`, `apollo`, `courier-api` and others) cross the threshold at the same time.
- The ALB monitoring panel shows an error rate above 100 percent, and the access log is dominated by status `499` and `404`.

`global-alb2` in `cpaas-system` is the platform ingress data plane. Its Pods run the containers `nginx` (access log) and `alb2` (configuration loop log).

Related articles: "ALB alb_lua_shared_dict_free or alb_loop_time alerts and internal_dsl is null or fetch policy fail log lines on ACP".

## Root Cause

### Cause 1: error-rate crosses the threshold on many platform routes with no matching errors in the access log

`cpaas-alb-router-rules` evaluates the error ratio per route over a sliding window (5 minutes) and fires when it stays above the threshold for 30 seconds; the 30 seconds is the hold time, not the window. Depending on the version, the expression counts 5xx only or 4xx and 5xx, so read the expression before interpreting a value.

When many `cpaas-system` Ingresses cross the line together (for example `dex` and `courier-api` at `11.11 %` while `archon`, `base-api`, `erebus`, `frontend` and `razor` are at `0.00 %`), the `global-alb2` Pods are `2/2 Running` with no restarts, and the `nginx` access log for those rules shows `"status": "200"` and `"upstream_status": "200"` with no error wave in the window, there is no ALB defect behind the alert. On ACP 4.1.5 this signature was closed as needing no action, with the metric to be improved in a later release.

A route with very little traffic reaches a high ratio from a single failed request: one request in the window that returns HTTP 500 is 100 percent. When one route dominates, the errors come from that route's backend; an access-log line whose `upstream_status` equals `status` means the backend produced the code and the ALB passed it through.

### Cause 2: error-rate panel above 100 percent with many 499 and 404 responses

`499` is the nginx code for a client that closed the connection before the response was sent. When the access log for the window is dominated by `499` (with `404`), clients disconnected before the server answered; no ALB or backend fault was found. A panel value above 100 percent from that mix is not the alert expression computing a real backend failure rate.

## Resolution

### Cause 1: error-rate crosses the threshold on many platform routes with no matching errors in the access log

1. Read the alert expression to see which status codes it counts:

   ```bash
   kubectl get prometheusrules.monitoring.coreos.com -A -o yaml | grep -n 'nginx_http_status'
   ```

2. Check the ALB Pods and the access log for the alert window:

   ```bash
   kubectl -n cpaas-system get pods -l service_name=alb2-global-alb2 -o wide
   kubectl -n cpaas-system logs <global-alb2-pod> -c nginx --since=30m | grep dex | tail
   kubectl -n cpaas-system logs <global-alb2-pod> -c nginx --since=30m | grep -E ' (401|403|404|499|500|502|503|504) ' | tail
   ```

3. If many platform routes fired together, the Pods are healthy, and the log has no matching error wave, record the alert as not caused by a route or ALB fault. Do not raise the threshold and do not restart `global-alb2` for this signature.

4. If one route dominates, find its backend and read the backend log for the same minute. Fix sustained backend errors on the backend; raising the threshold does not fix them.

   ```bash
   kubectl get rule -A | grep <rule-id-prefix>
   kubectl get rule -n <namespace> <rule-name> -o yaml | grep -A10 service
   kubectl logs -n <namespace> deploy/<backend> --tail=200
   ```

### Cause 2: error-rate panel above 100 percent with many 499 and 404 responses

Count the status codes in the window. When `499` dominates, look at the clients: timeouts shorter than the backend response time, load-test tools that abort requests, or callers that cancel on navigation. Fix the client timeout or the slow backend; the ALB needs no change, and neither a threshold change nor an ALB restart helps. Treat a `404` share separately: it means requests matched no rule or the backend returned `404`.

```bash
kubectl -n cpaas-system logs <alb-pod> -c nginx --since=30m | grep -oE '" [1-5][0-9]{2} ' | sort | uniq -c | sort -rn | head
```

## Diagnostic Steps

1. Identify the policy and the routes. `cpaas-alb-router-rules` is the per-route `error-rate` policy; an `alb_loop_time` alert from `cpaas-alb-rules` is covered in the related article.

2. Compare the alert with the `nginx` access log of every ALB replica for the same window:

   ```bash
   kubectl -n cpaas-system logs deploy/global-alb2 -c nginx --since=30m | grep -E ' (401|403|404|499|500|502|503|504) ' | tail
   ```

   The `-c nginx` flag is needed because the Pod has two containers.

3. Map the result:

   - Many `cpaas-system` Ingresses fire together, Pods healthy, no matching error codes in the access log: Cause 1, no action.
   - One route dominates: Cause 1, follow that backend.
   - A status count led by `499` (with `404`) and a panel above 100 percent: Cause 2.
