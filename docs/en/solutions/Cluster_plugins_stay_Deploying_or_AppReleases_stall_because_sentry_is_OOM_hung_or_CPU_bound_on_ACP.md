---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Cluster plugins stay Deploying or AppReleases stall because sentry is OOM, hung, or CPU-bound on ACP

## Issue

`sentry` is the component in `cpaas-system` of each cluster that installs, upgrades, and uninstalls plugin charts; it records the results in AppReleases (`ars`) and the chart sync records (`rels`), and applies ResourcePatches (`rpch`). When it is unhealthy, the console is up but:

- CoreDNS, log collection, Prometheus, and other cluster plugins stay **Deploying**.
- A `sentry` Pod sits near 100% of its CPU limit for days, and a critical alert fires on `sentry` CPU usage.
- Pods fail to deploy across the cluster, and several AppReleases are `Failed`, `WaitReady`, or empty, while `sentry` Pods are `Running`.
- A ResourcePatch stays `pending` while `sentry` reports OOM.
- The `base` or `region` AppRelease of a workload cluster stays syncing, and the BroadcastJob `update-containerd-config` succeeded count rises and falls back (for example 50, 51, 52, then 50 again).

Related article: [Platform health page shows components abnormal while their Pods are Running on ACP](Platform_health_page_shows_components_abnormal_while_their_Pods_are_Running_on_ACP.md).

## Root Cause

### Cause 1: sentry is OOM-killed, so AppRelease status does not sync

`sentry` is not running its sync because it is OOM-killed, so plugin rows stay **Deploying** and AppRelease status does not sync. A higher memory limit lets it complete.

### Cause 2: a large number of failed rels keeps sentry CPU high

One `sentry` replica stays at about its CPU limit while the other is near 0, and the log keeps processing AppReleases with repeated `warn="set cocurrentProcessors failed, process later"` and `info="beginning wait for 45 resources with timeout of 30s"`, although `kubectl get ars -A -w` shows every AppRelease `Synced`/`Ready` and rarely updating. A CPU profile shows most of the time in Go garbage collection, with `(*AppReleaseReconciler).Process` behind it. The cluster holds a large number of failed `rels` (chart sync records), for example left from a long abnormal period while the cluster was being imported. Raising the CPU or memory limit, or moving the Pod, does not help; deleting the failed `rels` does.

### Cause 3: sentry is hung while its Pods report Running

Pods fail across the cluster, for example the kubelet journal repeats `Error syncing pod, skipping ... CrashLoopBackOff` for platform Pods, and `kubectl get ars -A` shows some entries `Failed` (for example `cni-kube-ovn`), `WaitReady` (`logcenter`), or with no SYNC, HEALTH, or MESSAGE value (`monitor`). `sentry` itself shows `Synced`/`Ready`, and all `sentry-*` and `sentry-service-*` Pods are `1/1 Running` with 0 restarts, but `sentry` is hung and does not synchronize.

### Cause 4: a ResourcePatch stays pending because sentry is OOM

The `sentry` Pods watch and enforce ResourcePatch (`rpch`) objects. While they are OOM-killed, nothing processes a new `rpch`, so it stays `pending` when a resource is changed (seen on 3.12.3).

### Cause 5: a BroadcastJob hook cannot finish within the AppRelease timeout

After all nodes were restarted, the `region` AppRelease on a workload cluster is upgraded again. Its chart `alauda-cluster-base` has the BroadcastJob `update-containerd-config` as a `helm.sh/hook: post-upgrade` hook with `parallelism: 1`, so it processes one node at a time. On a cluster with many nodes (for example 68), it cannot finish within the AppRelease `timeout` (240 seconds), so the upgrade is retried, the BroadcastJob is recreated, and its succeeded count resets. Deleting the BroadcastJob makes it reappear, and editing the AppRelease `timeout` is reverted automatically. On the `global` cluster the `minfo` of that cluster shows the condition `CheckStatus-region` with `status: Processing`, `reason: Syncing`, and `message: '[1/2] chart ait/chart-alauda-cluster-base-<version> Upgrading'`. This was seen on 3.16. The same mechanism with the `upgrade-sysctl-config` BroadcastJob of the `base` AppRelease is described in [base AppRelease stays failed because the upgrade-sysctl-config BroadcastJob cannot finish on a large cluster on ACP](base_AppRelease_stays_failed_because_the_upgrade-sysctl-config_BroadcastJob_cannot_finish_on_a_large_cluster_on_ACP.md).

## Resolution

### Cause 1: sentry is OOM-killed, so AppRelease status does not sync

1. Confirm the OOM:

   ```bash
   kubectl get ars -A
   kubectl get pods -n cpaas-system | grep sentry
   kubectl describe pod -n cpaas-system <sentry-pod> | grep -E 'OOMKilled|Last State'
   ```

2. Export the `sentry` Deployment and raise its memory limit above the usage that was OOM-killed.

   > **Warning:** A higher limit lets `sentry` use more node memory. Do this only when the Pod's last state is `OOMKilled`. To roll back, apply the export.

   ```bash
   kubectl get deploy -n cpaas-system sentry -o yaml > "$HOME/sentry-deploy.yaml"
   kubectl set resources deploy -n cpaas-system sentry --limits=memory=<higher-limit>
   ```

3. Plugin rows leave **Deploying** once `sentry` stays `Running` and AppRelease status syncs.

### Cause 2: a large number of failed rels keeps sentry CPU high

1. Confirm the signature:

   ```bash
   kubectl top pod -n cpaas-system | grep sentry
   kubectl logs -n cpaas-system <sentry-pod> --tail=300 | grep -E 'cocurrentProcessors|beginning wait for'
   kubectl get rels -A | wc -l
   kubectl get rels -A | grep -i fail | head
   ```

   If `rels` is not a known resource type on the cluster, find the kind of the chart sync records with `kubectl api-resources` first.

2. Back up and delete the failed `rels`.

   > **Warning:** Deleted records cannot be restored; `sentry` creates new ones as it reconciles. Delete only objects that are already failed, and leave successful ones in place.

   ```bash
   kubectl get rels -A -o yaml > "$HOME/rels-backup.yaml"
   kubectl delete rels -n <namespace> <failed-rels-name>
   ```

3. `sentry` CPU returns to normal once the failed records are gone.

### Cause 3: sentry is hung while its Pods report Running

1. Confirm the signature:

   ```bash
   journalctl -u kubelet --since "30 min ago" | grep -E 'Error syncing pod|CrashLoopBackOff' | tail
   kubectl get ars -A
   kubectl get pods -n cpaas-system | grep sentry
   ```

2. Recreate all `sentry` and `sentry-service` Pods.

   > **Warning:** AppRelease reconciliation pauses until the new Pods are `Ready`. Do this only when several AppReleases are `Failed`, `WaitReady`, or empty, Pods fail across the cluster, and the `sentry` Pods are `Running` with no restarts. The Pods are recreated from the same specs.

   ```bash
   kubectl delete pod -n cpaas-system <sentry-pod-1> <sentry-pod-2> <sentry-service-pod-1> <sentry-service-pod-2>
   kubectl get ars -A
   ```

3. Every AppRelease returns to `Synced`/`Ready`/`chart synced` with a recent UPDATE time. If one stays `Failed`, read its message instead of restarting `sentry` again.

### Cause 4: a ResourcePatch stays pending because sentry is OOM

1. Confirm the OOM, find the pending object, and save the current state:

   ```bash
   kubectl get deploy -A | grep -E 'sentry|cluster-transformer'
   kubectl describe pod -n cpaas-system <sentry-pod> | grep -E 'OOMKilled|Last State'
   kubectl get rpch -A | grep -i pending
   kubectl get rpch <rpch-name> -o yaml > "$HOME/<rpch-name>-rpch.yaml"
   kubectl get deploy -n cpaas-system sentry sentry-service cluster-transformer -o yaml > "$HOME/sentry-deploys.yaml"
   ```

2. Delete the pending `rpch`, stop the components, raise the `sentry` limit, and start them again with their previous replica counts.

   > **Warning:** Deleting the `rpch` drops the patch it would have applied. With the three Deployments at 0 replicas, plugin and AppRelease reconciliation stops. Do this only when `sentry` is OOM-killed and an `rpch` is stuck `pending`, in a maintenance window. To roll back, apply the Deployment export and, if the patch is still wanted, the `rpch` export once `sentry` is healthy.

   ```bash
   kubectl delete rpch <rpch-name>
   kubectl scale deploy -n cpaas-system sentry sentry-service cluster-transformer --replicas=0
   kubectl set resources deploy -n cpaas-system sentry --limits=memory=<higher-limit>
   kubectl scale deploy -n cpaas-system sentry --replicas=<previous-sentry-replicas>
   kubectl scale deploy -n cpaas-system sentry-service --replicas=<previous-sentry-service-replicas>
   kubectl scale deploy -n cpaas-system cluster-transformer --replicas=<previous-cluster-transformer-replicas>
   ```

3. `sentry` stays `Running`, and a new resource change does not leave its `rpch` pending.

### Cause 5: a BroadcastJob hook cannot finish within the AppRelease timeout

1. Confirm the loop:

   ```bash
   kubectl get broadcastjobs.operator.alauda.io -A
   kubectl describe broadcastjobs.operator.alauda.io -n cpaas-system update-containerd-config | sed -n '/Events/,$p'
   kubectl get broadcastjobs.operator.alauda.io -n cpaas-system update-containerd-config -o yaml | grep -n -E 'parallelism|helm.sh/hook|ttlSecondsAfterFinished|restartLimit'
   kubectl get ars -n cpaas-system region -o yaml | grep -n timeout
   ```

   Expected: SUCCEEDED cycles below DESIRED, and the event shows thousands of `SuccessfulCreate` for `update-containerd-config-<suffix>` Pods.

2. Raise the parallelism so that the hook finishes within the timeout.

   > **Warning:** This BroadcastJob updates the containerd configuration on every node it runs on; with `parallelism: 10` up to ten nodes are processed at the same time. Do this only on the signature above. To roll back, set `parallelism` back to `1`; work already done on nodes is not undone.

   ```bash
   kubectl patch broadcastjobs.operator.alauda.io -n cpaas-system update-containerd-config --type=merge -p '{"spec":{"parallelism":10}}'
   kubectl get broadcastjobs.operator.alauda.io -n cpaas-system update-containerd-config -w
   ```

3. SUCCEEDED reaches DESIRED, and the `region` AppRelease and the `CheckStatus-region` condition return to normal.

## Diagnostic Steps

```bash
kubectl get pods -n cpaas-system | grep sentry
kubectl get ars -A | grep -viE 'Ready|Succeeded|Running' || true
kubectl get broadcastjobs.operator.alauda.io -A
kubectl get rpch -A
```

```text
plugins stuck Deploying, sentry OOMKilled                                  -> Cause 1
sentry CPU high for days, cocurrentProcessors warnings, many failed rels   -> Cause 2
Pods fail cluster-wide, ars Failed or WaitReady, sentry Running with 0 restarts -> Cause 3
rpch pending after a resource change, sentry OOMKilled                     -> Cause 4
update-containerd-config SUCCEEDED cycles, CheckStatus-region Processing   -> Cause 5
```
