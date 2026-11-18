---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# AppRelease abnormal because a ModuleInfo of a deleted cluster remains on ACP

## Issue

An AppRelease (`ars`) is reported abnormal. The cluster it relates to has already been deleted from the platform, but a `ModuleInfo` (`minfo`) for that cluster is still present on the global cluster, for example the `clickhouse-updater` module of the deleted cluster.

Related article: [Monitoring plugin uninstall or Prometheus to VictoriaMetrics switch leaves ModuleInfo, AppRelease, or Pods on ACP](Monitoring_plugin_uninstall_or_Prometheus_to_VictoriaMetrics_switch_leaves_ModuleInfo_AppRelease_or_Pods_on_ACP.md).

## Root Cause

### Cause 1: a ModuleInfo of the deleted cluster was left behind

A `ModuleInfo` describes a module installed on one cluster; the label `cpaas.io/cluster-name` names that cluster. When the cluster was deleted, the `clickhouse-updater` `minfo` of that cluster was not removed with it. That leftover `minfo` for a cluster that no longer exists makes the AppRelease abnormal.

## Resolution

### Cause 1: a ModuleInfo of the deleted cluster was left behind

1. On the global cluster, confirm that the cluster no longer exists and list the `minfo` objects that still point at it:

   ```bash
   kubectl get cls | grep <cluster-name>
   kubectl get minfo -A -l cpaas.io/cluster-name=<cluster-name>
   kubectl get minfo -A | grep <cluster-name>
   ```

2. Back up each leftover `minfo` of the deleted cluster, then delete it.

   > **Warning:** Deleting a `ModuleInfo` removes the platform's record of that module installation. Precondition: the cluster named on the `minfo` no longer exists, and the backup file is saved. Do not delete a `minfo` whose cluster still exists. Rollback: `kubectl apply -f /tmp/<minfo-name>.yaml`.

   ```bash
   kubectl get minfo <minfo-name> -o yaml > /tmp/<minfo-name>.yaml
   kubectl delete minfo <minfo-name>
   ```

3. Check the AppReleases again; the abnormal status clears.

   ```bash
   kubectl get ars -A | grep -v -E 'Ready|Synced'
   ```

## Diagnostic Steps

1. List the clusters the platform knows (`kubectl get cls`) and compare them with the clusters named on `ModuleInfo` objects:

   ```bash
   kubectl get minfo -A -o custom-columns='NAME:.metadata.name,CLUSTER:.metadata.labels.cpaas\.io/cluster-name,MODULE:.metadata.labels.cpaas\.io/module-name'
   ```

   Expected for this cause: one or more `minfo` objects (for example module `clickhouse-updater`) whose cluster is no longer in the cluster list.

2. List AppReleases that are not healthy:

   ```bash
   kubectl get ars -A | grep -v -E 'Ready|Synced'
   ```

   An abnormal AppRelease that relates to the deleted cluster, with its `minfo` still present, is this cause. An abnormal AppRelease for a cluster that still exists is not.
