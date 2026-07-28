---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Measure the Time Between Pod Creation and Pod Ready Using Prometheus or kubectl
## Issue

Capacity planners and platform SRE want to know how long Pods take to transition from `creationTimestamp` to `Ready`. The intuitive metric `kube_pod_created` is documented upstream by `kube-state-metrics`, but several distributions ship a `kube-state-metrics` Deployment with a `--metric-denylist` that hides every `kube_<resource>_created` series. The query needs to be rewritten to use the always-exposed lifecycle timestamp metrics.

## Root Cause

`kube-state-metrics` accepts both `--metric-denylist` and `--metric-allowlist` regex arguments. Different distributions wire them differently and that controls which lifecycle timestamps are visible:

- **Denylist-style installs** (some upstream Helm charts) drop `kube_<resource>_created` series to reduce cardinality. On those, the alternative timestamp metrics `kube_pod_status_scheduled_time` / `kube_pod_status_ready_time` / `kube_pod_status_initialized_time` / `kube_pod_start_time` are usually still exposed.
- **Allowlist-style installs** (ACP's `kube-prometheus` Helm chart) enumerate exactly which series to scrape. `kube_pod_created` is on the ACP allowlist and is exposed; the timestamp series above are *not* on the ACP allowlist and are absent.

So the right query depends on what `kube-state-metrics` is actually emitting. Inspect first, then pick the form.

## Resolution

### Steps

1. Inspect the `kube-state-metrics` Deployment to see which list is in effect. ACP packages kube-state-metrics inside the `kube-prometheus` Helm chart — the deployment is `kube-prometheus-exporter-kube-state` in `cpaas-system` and carries `app=exporter-kube-state` rather than `app.kubernetes.io/name=kube-state-metrics`:

   ```bash
   # ACP packaging — the args / command list shows --metric-allowlist=...,kube_pod_created,...
   kubectl -n cpaas-system get deploy kube-prometheus-exporter-kube-state \
     -o jsonpath='{.spec.template.spec.containers[0].command}{"\n"}'

   # Generic (matches both upstream and ACP labels):
   kubectl get deploy -A -l 'app in (kube-state-metrics,exporter-kube-state)' \
     -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].args}{.spec.template.spec.containers[0].command}{"\n"}{end}'
   ```

   `--metric-denylist=...kube_.+_created...` means `kube_pod_created` is intentionally hidden — use the timestamp-based PromQL in step 3. `--metric-allowlist=...kube_pod_created...` means the timestamp series are most likely *not* on the allowlist — use the simpler form in step 2 instead.

2. **If `kube_pod_created` is exposed** (ACP default): the duration is computed by joining `kube_pod_created` with `kube_pod_status_phase{phase="Running"}` and reading the time at which the phase first turned `Running`. Or, more directly, use the kubectl form in step 4 — Prometheus only buys you batch processing across many Pods, not better data.

3. **If `kube_pod_created` is suppressed by a denylist** but the timestamp series are exposed, compute the on-node startup latency as the difference between two timestamps. Pick whichever matches the question being asked:

   ```promql
   # Scheduling → readiness — closest to "scheduling and start-up cost"
   last_over_time(kube_pod_status_ready_time{namespace="test"}[1d])
     - last_over_time(kube_pod_status_scheduled_time{namespace="test"}[1d])

   # Init-container completion → readiness — isolates main container work
   last_over_time(kube_pod_status_ready_time{namespace="test"}[1d])
     - last_over_time(kube_pod_status_initialized_time{namespace="test"}[1d])

   # Container start → readiness — isolates probe latency
   last_over_time(kube_pod_status_ready_time{namespace="test"}[1d])
     - last_over_time(kube_pod_start_time{namespace="test"}[1d])
   ```

   These return one sample per Pod over the lookback window.

4. **Always-works fallback: read directly from the API.** This works on every cluster regardless of which list is in effect, because it reads the Pod object itself. The Pod's `metadata.creationTimestamp` minus the `Ready` condition's `lastTransitionTime` is exactly what either Prometheus form would report:

   ```bash
   kubectl -n test get pod -o json | jq -r '
     .items[]
     | .metadata.creationTimestamp as $created
     | (.status.conditions[] | select(.type=="Ready") | .lastTransitionTime) as $ready
     | "Pod: \(.metadata.name)\tCreated: \($created)\tReady: \($ready)\tDelta: \(($ready | fromdateiso8601) - ($created | fromdateiso8601)) s"
   '
   ```

   Example output:

   ```text
   Pod: httpd-5c4cfd69b4-mr7tq    Created: 2026-04-22T23:45:33Z    Ready: 2026-04-22T23:46:05Z    Delta: 32 s
   ```

## Diagnostic Steps

If `kube_pod_created` AND every `kube_pod_status_*_time` series are empty in Prometheus, the cluster is missing `kube-state-metrics` entirely:

```bash
# ACP packaging:
kubectl -n cpaas-system get pods -l app=exporter-kube-state

# Generic (covers both upstream and ACP labels):
kubectl get pods -A -l 'app in (kube-state-metrics,exporter-kube-state)'
```

To confirm what is actually being scraped without going through Prometheus, hit the metrics endpoint directly via the API server proxy (works without `curl` in the cluster):

```bash
kubectl get --raw "/api/v1/namespaces/cpaas-system/services/kube-prometheus-exporter-kube-state:8080/proxy/metrics" \
  | grep -E '^kube_pod_(created|status_(scheduled|ready|initialized|start)_time|start_time) ' \
  | awk '{print $1}' | sed 's/{.*//' | sort -u
```

If `kube_pod_status_ready_time` returns values but the difference comes out negative, the Pod was already scheduled but never reached `Ready` within the query window — verify the Pod's current `Ready` condition with `kubectl describe pod`.
