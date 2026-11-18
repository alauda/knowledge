---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Inspection reports the monitoring component abnormal or a slow collection time while monitoring works on ACP

## Issue

The platform inspection report marks a monitoring row as failed, but the cluster still serves metrics and the monitoring page works:

- The basic inspection says the monitoring component or monitoring service is abnormal, while the Prometheus or VictoriaMetrics pods, the AppReleases, and the monitoring page are healthy. Prometheus returns `context deadline exceeded`, or `courier` logs a timeout while querying a metric.
- Pulling node-exporter metrics of a node times out.
- "asm-otel alert collection takes too long", or the average time to scrape `cpaas-system/cluster-enhancer-apiserver` (for example 20.28s against 10.00s) or to run monitoring queries (5.48s against 5.00s) is over the warning threshold.

Before treating a red row as a false positive, rule out a real monitoring fault. If the API server log shows `apiserver was unable to write a JSON response: http: Handler timeout` on `GET /apis/monitoring.coreos.com/v1/prometheusrules` and an application team runs its own Prometheus in the cluster, the inspection data is genuinely wrong; see [Monitoring faults: a second Prometheus, missing vmagent-agent, vmalert OOMKilled, or Prometheus stuck in Init on ACP](Monitoring_faults_a_second_Prometheus_missing_vmagent-agent_vmalert_OOMKilled_or_Prometheus_stuck_in_Init_on_ACP.md).

An inspection that fails with `bad_response: invalid character '<' looking for beginning of value`, with `courier` logging `Unauthorized` when it lists `clusters`, is Cause 2 of [Monitoring pages stay empty because courier-api or apollo holds a stale cluster cache on ACP](Monitoring_pages_stay_empty_because_courier-api_or_apollo_holds_a_stale_cluster_cache_on_ACP.md).

## Root Cause

### Cause 1: courier times out querying a monitoring target

The inspection runs its monitoring checks through `courier`. When a query to the monitoring backend takes longer than the query timeout configured in the `monitoring` Feature, `courier` gives up with a timeout (`context deadline exceeded`), and the row says the monitoring component is abnormal although every monitoring pod and the monitoring page are fine. `ContainerStatusUnknown` pods in the same report are historical leftovers, not the failed hop.

The item can be defined as `cpaas_cluster_prometheus_up` while the query `courier` actually runs differs: one run queried `kafka_consumergroup_lag_sum` on a business cluster that had no log storage plugin, so that series was absent, and the remaining failure was still the timeout. Raising the `monitoring` Feature timeout to 20 cleared the row. Restarting `apollo` and `courier` did not. When the row only matters as an upgrade gate, and `apollo` and the collectors log nothing, it can be recorded as a false positive; it did not block an upgrade.

### Cause 2: node-exporter metrics take longer than the scrape timeout

A manual request to the node-exporter metrics endpoint of the named node takes longer than the scrape limit (about 16s in one case), while the ServiceMonitor for node-exporter still has the default `scrapeTimeout` of `10s`. The node is up; the scrape is cut off. Apply this only after measuring the URL on the node the row names: another row, "average collection time 41s over 10s" for a business sample, was not fixed this way.

### Cause 3: a collection or query time slightly above its threshold while the component is healthy

The row names a collection or query time just above the threshold (10s for collection). For asm-otel, the pods were running without restarts, the logs had no related errors, and the time was only slightly above 10s; the warning had no impact. Rows for `cluster-enhancer-apiserver` at 20.28s and query time at 5.48s were assessed as metric request timeouts without a further cause. `cluster-enhancer-apiserver` is also the ServiceMonitor that collects `certificate_expires_time`; if that series count keeps growing, investigate it before treating a slow scrape there as harmless.

## Resolution

### Cause 1: courier times out querying a monitoring target

Only when `courier` logs a timeout on a metric query, or Prometheus returns `context deadline exceeded`, and the monitoring pods and page are otherwise healthy.

1. Save the Feature and find the timeout field:

   ```bash
   kubectl get feature monitoring -o yaml > /tmp/feature-monitoring.before.yaml
   kubectl get feature monitoring -o yaml | grep -n -i timeout
   ```

2. Raise the timeout to 20 (`20s` if the field is a duration). Leave every other field as it is.

   > **Warning:** Editing `feature monitoring` changes how the console queries metrics; a wrong field can blank monitoring pages for every cluster that uses it. Precondition: the saved YAML is on disk, the timeout is confirmed in the `courier` log, and you change only the timeout that is below 20. Rollback: `kubectl apply -f /tmp/feature-monitoring.before.yaml`.

   ```bash
   kubectl edit feature monitoring
   ```

3. Re-run the inspection. If the row stays and `courier` now logs `Unauthorized` with an HTML body, follow the `bad_response` article linked in the Issue.

### Cause 2: node-exporter metrics take longer than the scrape timeout

1. Time the node-exporter metrics URL of the named node from a host that can reach it, and read the current timeout:

   ```bash
   kubectl -n cpaas-system get servicemonitor | grep -i node
   kubectl -n cpaas-system get servicemonitor <node-exporter-servicemonitor> -o yaml | grep -n -i -e scrapeTimeout -e interval
   time curl -s -o /dev/null http://<node-ip>:<node-exporter-port>/metrics
   ```

2. If the measured time is above `scrapeTimeout`, raise it.

   > **Warning:** A longer scrape holds a scraper worker for up to 20s per node. Precondition: the measured time on that node is above the current timeout, and you saved the ServiceMonitor. Rollback: `kubectl apply -f /tmp/node-exporter-sm.before.yaml`. If a plugin sync restores `10s`, set the value through the monitoring plugin that owns the ServiceMonitor.

   ```bash
   kubectl -n cpaas-system get servicemonitor <node-exporter-servicemonitor> -o yaml > /tmp/node-exporter-sm.before.yaml
   kubectl -n cpaas-system edit servicemonitor <node-exporter-servicemonitor>
   ```

   Set `spec.endpoints[].scrapeTimeout` to `20s`; the generated Prometheus configuration then shows `scrape_timeout: 20s`. Where node scraping is defined only by a `VMNodeScrape` or `VMServiceScrape`, set that object's timeout to `20s` instead.

### Cause 3: a collection or query time slightly above its threshold while the component is healthy

Check the named component:

```bash
kubectl get pods -A | grep asm-otel
kubectl -n <namespace> logs <asm-otel-pod> --tail=200 | grep -iE 'error|timeout'
```

No restarts, no errors, and a time just above the threshold: close the row as no impact. A time well above the threshold on node-exporter is Cause 2.

## Diagnostic Steps

1. Separate a query timeout from an authorization failure:

   ```bash
   kubectl -n cpaas-system logs deploy/courier --tail=200 | grep -Ei 'timeout|unauthorized|deadline|bad_response'
   kubectl -n cpaas-system get pods | grep -Ei 'prometheus|vmagent|vmselect|vmstorage'
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `context deadline exceeded` or a `courier` query timeout, monitoring pods healthy | 1 |
   | `Unauthorized` on `clusters` plus `bad_response: invalid character '<'` | the `bad_response` article linked in the Issue |
   | The named node's metrics URL answers slower than `scrapeTimeout` | 2 |
   | A collection time just over the threshold on a healthy component | 3 |

3. Both the monitoring pipeline row and the log pipeline row abnormal right after a primary/standby switchover, with healthy pods, is a different false positive: see [Inspection reports zero free inodes, missing event data, expired dex.tls, or abnormal pipelines after switchover on ACP](Inspection_reports_zero_free_inodes_missing_event_data_expired_dex.tls_or_abnormal_pipelines_after_switchover_on_ACP.md).
