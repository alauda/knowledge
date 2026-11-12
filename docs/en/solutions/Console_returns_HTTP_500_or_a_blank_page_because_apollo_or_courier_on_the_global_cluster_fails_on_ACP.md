---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.14"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Console returns HTTP 500 or a blank page because apollo or courier on the global cluster fails on ACP

## Issue

The browser reaches the platform host, but a page stays blank, spins, or returns HTTP 500. Typical reports are "apollo reports errors and the platform returns 500", a monitoring home page that spins for one cluster, or Operations Center saying that monitoring is not installed while the monitoring Pods are `Running`.

Start from the failing request, not the screenshot. In the browser developer tools (**Network**), sort by status and note the first failing path and its status code:

| Failing request | First component to check |
| --- | --- |
| Broad `/platform/...` 500, or the document itself errors after login | `apollo` and other `cpaas-system` Pods on the `global` cluster |
| `/platform/monitoring.alauda.io/v1beta1/clusters/<cluster>/metrics` returns 500, Grafana says `cluster <name> not found` | the `apollo` cluster cache |
| Operations Center says monitoring is not installed, or vmui returns 403 | `courier` and `courier-api` |
| The document request never completes, or HTTP 502 from the load balancer | the entry path, not this article |

`apollo`, `courier`, `courier-api`, `frontend`, `archon`, and `erebus` are console backends in `cpaas-system` on the `global` cluster. `apollo` aggregates the platform API, `erebus` proxies calls toward a target cluster, `courier` and `courier-api` feed the monitoring and inspection views, `frontend` serves the shell, and `archon` serves file download from containers.

## Root Cause

### Cause 1: apollo crash-loops with apiserver 401 because node clocks differ

`apollo` is `CrashLoopBackOff` and its log shows cache calls returning 401 and an API server authentication failure. The node clocks are skewed, for example after nodes were powered off without stopping `kubelet` and the container runtime, or after a single master was rebooted. Token authentication between platform components fails when the clocks differ. On a 3.14 `global` cluster the same skew after one master reboot showed as `katanomi` not starting, `archon` and other components returning 401, and the platform saying the license could not be loaded. Recreating `apollo` without fixing the clocks clears the symptom only until the next authentication check.

### Cause 2: apollo does not have the cluster in its cache

The monitoring home page of a cluster spins, the metrics API returns 500, and the global `apollo` log contains `get cluster <name> from cache error`, `cluster <name> not found`, or `New manager error`. The business cluster's Prometheus answers. This happens for a newly created cluster, or when `apollo` Pods have run for a long time without picking up a new cluster. Restarting the global `apollo` Pods reloads the cluster list. Restarting `erebus` or other controllers does not.

### Cause 3: apollo receives HTML instead of JSON from the metrics backend

Monitoring charts stay empty after Prometheus was installed or reinstalled, while Prometheus itself returns `up`. `apollo` repeats `bad_response: invalid character '<' looking for beginning of value`: it received an HTML or XML body instead of JSON. A user-created Prometheus Deployment in `cpaas-system` is not necessarily the cause; restarting `apollo` restores the charts.

### Cause 4: courier holds a stale view and the UI says monitoring is not installed

Marketplace, the monitoring Pods, and the AppReleases are healthy, but Operations Center says the monitoring component is not installed and vmui returns 403. Restarting `courier` and `courier-api` reloads the view.

### Cause 5: courier panics in the leftover resource-statistics job

`courier` keeps restarting with a panic in the resource usage statistics path. Older versions ran that scheduled job; the current version no longer uses the feature, but the code that schedules it is still present. Scheduling the job for a date that never occurs stops the restarts.

### Cause 6: the global control-plane disk is full of etcd backups

The browser reports that the site cannot be reached, and `kubectl get pods -n cpaas-system` shows Pods that are not `Running`. The global control-plane filesystem is at 100% because etcd backups under `/cpaas-backup` filled it. This is a node disk fault that shows as a dead console.

## Resolution

### Cause 1: apollo crash-loops with apiserver 401 because node clocks differ

1. Compare the clocks of all nodes. After a single master reboot, that node is the likely outlier:

   ```bash
   date -u
   timedatectl status
   ```

2. Synchronize every control-plane and worker node to the same NTP source.

   > **Warning:** Stepping a node clock affects TLS, leases, and log order. Prefer slewing through the NTP service; if the clock must be stepped, do it in a maintenance window and expect brief API server 401 errors until `apollo` is restarted.

3. Restart `apollo` only, and confirm the new Pod stays `Running` and the 500 is gone:

   ```bash
   kubectl get pods -n cpaas-system --no-headers | awk '$1 ~ /^apollo-/ {print $1}'
   kubectl delete pod -n cpaas-system <apollo-pod>
   ```

### Cause 2: apollo does not have the cluster in its cache

1. Confirm the log signature:

   ```bash
   kubectl logs -n cpaas-system <apollo-pod> --tail=200 | grep -E 'from cache error|not found|New manager error'
   ```

2. Restart every global `apollo` Pod.

   > **Warning:** Platform API calls, including monitoring and other aggregated pages, return errors until the new Pods are `Ready`. Do this when users can retry. The Pods are recreated from the same spec. If the new Pods log the same `cluster <name> not found` after several minutes, the cluster object is missing or the API watch is failing; do not keep deleting Pods.

   ```bash
   kubectl delete pod -n cpaas-system <apollo-pod-1> <apollo-pod-2>
   ```

The monitoring-specific variants of this cache problem are covered in more detail in [Monitoring pages stay empty because courier-api or apollo holds a stale cluster cache on ACP](Monitoring_pages_stay_empty_because_courier-api_or_apollo_holds_a_stale_cluster_cache_on_ACP.md).

### Cause 3: apollo receives HTML instead of JSON from the metrics backend

1. Confirm the log line:

   ```bash
   kubectl logs -n cpaas-system <apollo-pod> --tail=200 | grep bad_response
   ```

2. Restart `apollo`.

   > **Warning:** Platform APIs return errors until the Pod is `Ready`. Do not delete a user's Prometheus just because it is in `cpaas-system`.

   ```bash
   kubectl delete pod -n cpaas-system <apollo-pod>
   ```

3. If `bad_response` continues, the upstream still returns a non-JSON body; check it before restarting `apollo` again.

### Cause 4: courier holds a stale view and the UI says monitoring is not installed

> **Warning:** Restarting these Deployments interrupts the monitoring and inspection views until the new Pods are `Ready`. The monitoring store keeps running.

```bash
kubectl get deploy -n cpaas-system | grep courier
kubectl rollout restart deployment -n cpaas-system <courier-deployment>
kubectl rollout restart deployment -n cpaas-system <courier-api-deployment>
kubectl rollout status deployment -n cpaas-system <courier-api-deployment>
```

### Cause 5: courier panics in the leftover resource-statistics job

1. Export the Deployment:

   ```bash
   kubectl get deploy -n cpaas-system -o name | grep courier
   kubectl get deploy -n cpaas-system <courier-deployment> -o yaml > "$HOME/courier-deploy.yaml"
   ```

2. Add the following argument to the `command` of the `courier` container. It schedules the job for 31 February, which never occurs.

   > **Warning:** Editing the command rolls the Deployment and interrupts health and monitoring views until the new Pod is `Ready`. Do this only when the panic is in the resource-statistics job. To roll back, apply the export, which re-enables the job and can bring the panic back.

   ```yaml
   - --record-job-spec=CRON_TZ=Asia/Shanghai 0 0 31 2 *
   ```

   ```bash
   kubectl edit deploy -n cpaas-system <courier-deployment>
   ```

3. `courier` stays `Running` after the rollout. If the argument disappears and the panic returns, the owning release is still rendering the old command.

### Cause 6: the global control-plane disk is full of etcd backups

1. Find what fills the disk:

   ```bash
   df -h
   du -sh /cpaas-backup/* 2>/dev/null | sort -h
   ```

2. Remove old backups.

   > **Warning:** Files under `/cpaas-backup` are etcd backups and deleting them is irreversible. Copy the newest successful backup to another disk first, and never touch the live etcd data directory. If the disk is full for another reason, removing backups is not the fix.

   ```bash
   rm -f /cpaas-backup/<old-etcd-backup>
   df -h
   ```

3. Watch the `cpaas-system` Pods return to `Running`, then load the console again.

## Diagnostic Steps

1. In the browser **Network** panel, reproduce the problem once and note the first failing path and status.

2. On the `global` cluster, list the platform Pods that are not `Running` and read the matching log:

   ```bash
   kubectl get pods -n cpaas-system -o wide
   kubectl get pods -n cpaas-system | grep -viE 'Running|Completed'
   kubectl logs -n cpaas-system <pod> --since=30m --tail=200
   ```

3. Match the log text:

   ```text
   401 and CrashLoopBackOff on apollo                      -> Cause 1 (node time)
   archon 401, license cannot be loaded after one master reboot -> Cause 1
   get cluster <name> from cache error                     -> Cause 2
   bad_response: invalid character '<'                     -> Cause 3
   vmui 403, UI says monitoring is not installed           -> Cause 4
   courier panic in the resource-statistics job            -> Cause 5
   filesystem 100% and /cpaas-backup is large              -> Cause 6
   ```

4. If only one feature path fails (logs, a registry, DevOps, a data-service instance) and `apollo` is healthy, the problem is in that product, not in the platform backends.
