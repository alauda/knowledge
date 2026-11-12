---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Cluster plugin install or upgrade stuck in chart sync: sentry, StatefulSet Forbidden, hook Job, or missing ModuleConfig

## Issue

A cluster plugin page shows `Installing` (Chinese UI: `安装中`) or `Deployment Failed` (`安装失败`), and the AppRelease (`ars`) or ModuleInfo carries a chart error:

- Every plugin, including Alauda AI Essentials, is stuck in Installing, and no Pod in the cluster is abnormal.
- `metallb ChartDownloadFailed [1/1] failed to download chart acp/chart-alauda-metallb-plugin-v4.0.12, err: calculating blob path for ReaderAt: cannot calculate blob path from invalid digest: invalid checksum digest length: invalid argument`.
- The log center plugin (for example Log Storage for Elasticsearch `v4.1.3` on `global`) stays Installing, the Kafka consumer-lag alert from rule `cpaas-log-rules` keeps firing (`Kafka 消费队列滞后增长速率 > 0 且持续 1 分钟`, "Kafka consumer lag growth rate > 0 for 1 minute"), and the event is `failed to apply StatefulSet "cpaas-system/cpaas-kafka": StatefulSet.apps "cpaas-kafka" is invalid: spec: Forbidden: updates to statefulset spec for fields other than ...`.
- `Installation failed：[1/1] chart ait/chart-base-central-v4.2.44-cn Upgrading` for Alauda Container Platform Central Base during platform deployment.
- A business cluster ARS (for example `base`, before a cluster upgrade) stays `syncing` for a long time.
- A plugin upgrade on a business cluster (for example Prometheus) fails, and the error looks like a missing certificate.

`sentry` installs and upgrades plugin charts on each cluster and records the result on the AppRelease. `cluster-transformer` on `global` turns ModulePlugins into ModuleConfigs and reconciles ModuleInfo.

Related articles: "Argo Rollouts, Kubeflow Base, or a wrong-architecture cluster plugin fails to install or upgrade on ACP" covers plugin-specific install failures.

## Root Cause

### Cause 1: sentry stopped processing charts

All plugins stay Installing with no abnormal Pod, or an AppRelease reports `ChartDownloadFailed ... invalid checksum digest length: invalid argument`. No underlying cause has been identified. Restarting `sentry` returns the plugins from Installing to normal and restores the AppRelease sync.

### Cause 2: StatefulSet spec Forbidden after storageSize was changed in ModuleInfo

`sentry failed to upgrade chart ait/chart-alauda-log-center-v4.1.3, err: failed to upgrade chart for release "logcenter": failed to apply StatefulSet "cpaas-system/cpaas-kafka" ... spec: Forbidden` repeats for days, and the log center plugin stays Installing.

The Kafka `storageSize` in the log center ModuleInfo was changed. That value feeds the `volumeClaimTemplates` of the existing `cpaas-kafka` StatefulSet, which Kubernetes does not allow to change in place, so every chart upgrade fails. Kafka consumer-lag alerts on `alauda_log/ALAUDA_LOG_TOPIC/<partition>` can fire at the same time. The fix is to redeploy the log plugins with the planned PVC capacity, which deletes the existing log data.

### Cause 3: Job remove-keep-annotations times out and the chart never leaves Upgrading

`Installation failed：[1/1] chart ait/chart-base-central-v4.2.44-cn Upgrading`, and the `sentry` log for release `base-central` in `cpaas-system` shows:

```text
warning: Failed to update release base-central version 4: release: not found
ServiceAccount base-central-upgrade-hook has skipped
recreate Job "remove-keep-annotations" success
Watching for changes to Job remove-keep-annotations with timeout of 2m0s
Jobs active: 0, jobs failed: 0, jobs succeeded: 0
```

The `release: not found` warning alone does not identify this cause; the deciding lines are the wait on the Job and `Jobs active: 0`. The chart upgrade waits on hook Job `remove-keep-annotations`, which never becomes active, so the wait times out on every retry. Deleting the Job and running its operations by hand lets the installation complete.

### Cause 4: Business cluster ARS stays syncing because a BroadcastJob is incomplete

A business cluster ARS (or its `base` component) stays in `syncing` while a BroadcastJob of that cluster is incomplete: `update-containerd-config` with stuck jobs, or `upgrade-sysctl-config` with `FAILED 1` and an `Evicted` Pod. Adding a dummy value to the ARS values only triggers the same BroadcastJob again. Both forms are covered in "base AppRelease stays failed because the upgrade-sysctl-config BroadcastJob cannot finish on a large cluster on ACP".

### Cause 5: ModuleInfo Reconcile error: ModuleConfig.cluster.alauda.io "<name>" not found

A plugin upgrade on a business cluster fails, and the `cluster-transformer` log shows:

```text
ERROR controllers/moduleinfo_controller.go:61 ModuleInfo Reconcile '<moduleinfo>' error: ModuleConfig.cluster.alauda.io "prometheus-v3.16.11-def68b41a866" not found
```

The ModuleConfig of the old version (3.16) was deleted, and the chart version in the ModulePlugin `spec.mainChart` no longer matches any existing ModuleConfig, so ModuleInfo reconciliation fails. Setting that chart `version` to the version of the ModuleConfig that exists fixes it.

## Resolution

### Cause 1: sentry stopped processing charts

```bash
kubectl get ars -A
kubectl get pods -A | grep sentry
kubectl -n cpaas-system logs <sentry-pod> --tail=300 > "$HOME/sentry-before-restart.log"
```

> **Warning:** Restarting `sentry` pauses chart install and sync on that cluster until the new Pod is Ready. Precondition: only when every plugin is stuck Installing with no abnormal Pod, or an AppRelease shows `ChartDownloadFailed` with `invalid checksum digest length`. Rollback: none needed; the Deployment recreates the Pod.

```bash
kubectl -n cpaas-system delete pod <sentry-pod>
kubectl -n cpaas-system get pods -w | grep sentry
kubectl get ars -A
```

Plugins should leave Installing and the AppRelease should sync. Keep the saved `sentry` log for Alauda support if the problem returns.

### Cause 2: StatefulSet spec Forbidden after storageSize was changed in ModuleInfo

```bash
kubectl get ars -A | grep -i logcenter
kubectl -n cpaas-system describe ars logcenter | grep -A3 ChartSynced
kubectl get minfo | grep -i log
kubectl get minfo <logcenter-minfo> -o yaml | grep -n -i storageSize
kubectl -n cpaas-system get sts cpaas-kafka -o jsonpath='{.spec.volumeClaimTemplates[*].spec.resources.requests.storage}{"\n"}'
```

A `storageSize` in ModuleInfo that differs from the StatefulSet `volumeClaimTemplates` storage is this cause. The chart upgrade can only apply while the two values match or after the StatefulSet is recreated, which here means redeploying the plugin.

> **Warning:** Redeploying the log plugin with new PVC sizes deletes the existing log storage data (the `cpaas-kafka` volumes and the stored logs). This cannot be undone. Precondition: only when the event shows the `cpaas-kafka` StatefulSet `spec: Forbidden` error, the `storageSize` change in ModuleInfo is confirmed, and the owner of the logs has confirmed the existing log data can be deleted. Rollback: none; export anything you must keep before you start.

Uninstall the log collection plugin, confirm its PVCs are gone, and install it again with the planned PVC capacity:

```bash
kubectl -n cpaas-system get pvc | grep -i kafka
```

### Cause 3: Job remove-keep-annotations times out and the chart never leaves Upgrading

Find the Job in the `sentry` log and export it before touching it:

```bash
kubectl -n cpaas-system logs <sentry-pod> --tail=500 | grep -E 'base-central|remove-keep-annotations|Watching for changes to Job|Jobs active'
kubectl get jobs -A | grep remove-keep-annotations
kubectl -n <namespace> describe job remove-keep-annotations
kubectl -n <namespace> get job remove-keep-annotations -o yaml > "$HOME/remove-keep-annotations.yaml"
```

> **Warning:** Deleting the Job removes the step the chart waits on; the operations that Job performs are not done until you run them yourself. Precondition: only when the chart is stuck at `chart ait/chart-base-central-<version> Upgrading`, the `sentry` log shows the wait on Job `remove-keep-annotations` timing out with `Jobs active: 0`, and the Job is exported. Rollback: re-create the Job from the export if the chart must run it again.

```bash
kubectl -n <namespace> delete job remove-keep-annotations
```

Run the operations of the exported Job by hand: its container `command` and `args` are under `.spec.template.spec.containers[]` in the export, and the ServiceAccount it runs as is `.spec.template.spec.serviceAccountName`. Then check that the chart leaves `Upgrading`. Use the same procedure for another hook Job only when the `sentry` log shows that Job's wait timing out.

### Cause 4: Business cluster ARS stays syncing because a BroadcastJob is incomplete

```bash
kubectl get job,bcj -n cpaas-system
kubectl -n cpaas-system logs <sentry-pod> --tail=500 | grep -E 'update-containerd-config|upgrade-sysctl-config'
```

Follow "base AppRelease stays failed because the upgrade-sysctl-config BroadcastJob cannot finish on a large cluster on ACP": delete the `Evicted` Pod for a `FAILED` `upgrade-sysctl-config`, or raise `parallelism` for a stuck `update-containerd-config`, each with its Warning.

### Cause 5: ModuleInfo Reconcile error: ModuleConfig.cluster.alauda.io "<name>" not found

```bash
kubectl -n cpaas-system logs deploy/cluster-transformer --tail=300 | grep -i 'ModuleConfig.cluster.alauda.io'
kubectl get mconfig | grep -i <plugin-name>
kubectl get mplugin <plugin-name> -o yaml > "$HOME/mplugin-<plugin-name>.before.yaml"
grep -n -A8 'mainChart' "$HOME/mplugin-<plugin-name>.before.yaml"
```

> **Warning:** The chart version in `spec.mainChart` decides which chart the platform installs for this plugin. Precondition: only when the `cluster-transformer` log reports `ModuleConfig.cluster.alauda.io "<name>" not found` for the referenced version, and you set the version to one that `kubectl get mconfig` lists. Rollback: `kubectl apply -f "$HOME/mplugin-<plugin-name>.before.yaml"`.

```bash
kubectl edit mplugin <plugin-name>
```

Set the `version` of the chart under `spec.mainChart` to the version of the existing ModuleConfig, save, and retry the upgrade.

## Diagnostic Steps

```bash
kubectl get ars -A
kubectl get minfo | grep <cluster-name>
kubectl get pods -A | grep -E 'sentry|cluster-transformer'
kubectl -n cpaas-system logs deploy/cluster-transformer --tail=300 | grep -i error
kubectl get broadcastjob -A
```

- All plugins stuck with healthy Pods, or `invalid checksum digest length`: Cause 1. If `sentry` itself shows `OOMKilled` restarts, raise its memory instead of only restarting it.
- `StatefulSet ... spec: Forbidden` after a `storageSize` change: Cause 2.
- `chart ... Upgrading` with `Watching for changes to Job remove-keep-annotations` and `Jobs active: 0` in the `sentry` log: Cause 3.
- An ARS in `syncing` with an incomplete BroadcastJob (`update-containerd-config`, or `upgrade-sysctl-config` with an `Evicted` Pod): Cause 4.
- `ModuleInfo Reconcile ... ModuleConfig.cluster.alauda.io "<name>" not found` from `cluster-transformer` during a plugin upgrade: Cause 5.

For a release that reports `release: not found`, check whether Helm still has the release record before acting; a missing revision Secret matches that warning, and the hook Job lines decide Cause 3:

```bash
kubectl get secret -n cpaas-system | grep 'sh.helm.release.v1.<release>'
```
