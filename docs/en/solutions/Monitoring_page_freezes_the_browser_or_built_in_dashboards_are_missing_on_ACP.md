---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16
  - 3.18
  - 4.0
  - 4.1
  - 4.2
  - 4.3
---

# Monitoring page freezes the browser or built-in dashboards are missing on ACP

## Issue

The monitoring backend is healthy, but the monitoring pages themselves do not work. Typical symptoms:

- Opening the cluster monitoring page spins and then freezes the browser tab, or it loads for minutes. The Administrator overview may fail to load CPU and memory. **Operations Center** > **Monitoring** > **Monitoring Dashboards** may stay on `加载中，请稍候` (loading, please wait) and freeze as soon as the `global` cluster is selected.
- After an upgrade from 3.18, opening **Clusters** > `global` > **Monitoring** freezes the browser tab.
- Cluster and host dashboards are missing from **Operations Center** > **Monitoring**, or a newly created cluster shows an older-style monitoring page than its neighbours.
- Business clusters that are still on 3.16 under a 4.0 `global` cluster show only the overview dashboard.

All monitoring Pods and `apollo` are `Running`.

Related articles: [Monitoring dashboard panels are blank or drop to zero while the backend has data on ACP](Monitoring_dashboard_panels_are_blank_or_drop_to_zero_while_the_backend_has_data_on_ACP.md) covers individual panels that are empty; [Cluster Overview page shows no monitoring charts after Cluster Enhancer is installed on ACP](Cluster_Overview_page_shows_no_monitoring_charts_after_Cluster_Enhancer_is_installed_on_ACP.md) covers the cluster **Overview** page.

## Root Cause

### Cause 1: a MonitorDashboard has gridPos.true instead of gridPos.y

A `monitordashboards.ait.alauda.io` object has the key `true` in a `gridPos` block where the key must be `y`. This is the known Kubernetes YAML behavior that turns the key `y` into `true` (kubernetes/kubernetes issue 102308). The front end cannot lay out the dashboard and the browser freezes.

- A compatibility fix in the MonitorDashboard webhook shipped in 3.18, but a dashboard object that was never regenerated still carries the bad key. On 4.1.3 the affected object was the `advanced-search` MonitorDashboard in `cpaas-system` on the `global` cluster.
- The same bad key was written into `cluster-overview-monitor-dashboard` when **Alauda Container Platform Cluster Enhancer** v4.1.2 was installed while monitoring was down. Cluster Enhancer 4.1.7 contains the fix for that install-time defect.

### Cause 2: dashboard objects left over from a 3.18 deployment

After an upgrade from 3.18 to 4.1, `monitordashboards.ait.alauda.io` and `grafanadashboard` objects created by the 3.18 deployment remain although their plugins are gone, and they are incompatible with the new monitoring deployment. Examples are `grafanadashboard` objects named `courier` and `hermes`, old `monitordashboards.ait.alauda.io` objects in `cpaas-system` (such as `cluster-overview-monitor-dashboard`, `cluster-etcd-monitor-dashboard`, `kubernetes-nodes-monitor-dashboard`, `ns-pods-overview`) and in `kube-public` (such as `ns-application-<suffix>`, `user-alb-status-<suffix>`), all with the age of the previous deployment. Accessing the platform through another address does not change the freeze, and the `apollo` log shows only routine INFO lines.

### Cause 3: Cluster Enhancer is not installed

From 4.2.4, the cluster and host dashboards are provided by the **Alauda Container Platform Cluster Enhancer** plugin. Without it:

- **Operations Center** > **Monitoring** has no cluster or host dashboards.
- A newly created cluster shows the older-style monitoring page (tabs `ApiServer`, `Controller Manager`, `Scheduler`, `ETCD`, and `集群网络` (cluster network)), while an upgraded cluster with the same versions shows the new one, which adds `集群概览` (cluster overview), `证书状态` (certificate status), and `etcd 备份` (etcd backup).

On a healthy cluster `cluster-overview-monitor-dashboard` in `cpaas-system` carries the labels `cpaas.io/dashboard.folder: cluster`, `cpaas.io/dashboard.tag.built-in: "true"`, and `helm.sh/chart-name: cluster-enhancer`. On an affected cluster `kubectl get monitordashboards.ait.alauda.io -A` lists only component and namespace dashboards (`albstatus`, `coredns`, `kube-ovn-*`, `ns-application`, `ns-pod`, and similar) and lacks `cluster-overview-monitor-dashboard`, `cluster-certificates-monitor-dashboard`, `cluster-etcd-monitor-dashboard`, `cluster-etcd-backup-monitor-dashboard`, `cluster-kube-apiserver-monitor-dashboard`, `cluster-kube-controller-manager-monitor-dashboard`, `cluster-kube-scheduler-monitor-dashboard`, `cluster-network-monitor-dashboard`, and the `kubernetes-*-monitor-dashboard` set. Copying those objects from another cluster does not help: the page does not request them.

### Cause 4: business clusters on 3.16 under a 4.0 global cluster

When the `global` cluster has been upgraded to 4.0 (VictoriaMetrics) and business clusters are still on 3.16 (Prometheus), the monitoring dashboard page for those business clusters has only the overview, and even cluster status is missing. The cause is the version mismatch between `global` and the business clusters. On such a business cluster `kubectl get monitordashboards.ait.alauda.io -A` returns a single object, `kubernetes-cluster` in `cpaas-system`.

## Resolution

### Cause 1: a MonitorDashboard has gridPos.true instead of gridPos.y

1. Back up the dashboard objects and look for the bad key:

   ```bash
   kubectl get monitordashboards.ait.alauda.io -A
   kubectl get monitordashboards.ait.alauda.io -n cpaas-system -o yaml > /tmp/monitordashboards-backup.yaml
   grep -n -A3 gridPos /tmp/monitordashboards-backup.yaml
   ```

   Continue only when a `gridPos` block contains the key `true` instead of `y`.

2. If the object belongs to the `advanced-search` plugin, remove the plugin and deploy it again, which regenerates its dashboard object.

   > **Warning:** Removing the `advanced-search` plugin takes its function away until it is deployed again. Do this only when the frozen page is traced to the `advanced-search` MonitorDashboard with `true` under `gridPos`. To roll back, deploy the plugin again with its previous settings.

3. For any other object, restore the key `y` in each affected `gridPos` block. If the affected panel is not needed, deleting that panel from the object also works.

   > **Warning:** A mistaken edit leaves the page frozen or changes the dashboard layout. Do this only when the backup shows `true` under `gridPos` where `y` belongs. To roll back, run `kubectl apply -f /tmp/monitordashboards-backup.yaml`. No collected data is deleted.

   ```bash
   kubectl edit monitordashboards.ait.alauda.io -n cpaas-system <dashboard-name>
   ```

4. When the object was written by Cluster Enhancer 4.1.2, upgrade Cluster Enhancer to 4.1.7 or later so that the defect does not recur.

### Cause 2: dashboard objects left over from a 3.18 deployment

1. List the dashboard objects, pick out the ones created by the 3.18 deployment (compare `metadata.creationTimestamp` and the release labels with objects of the plugin that is installed now), and back everything up:

   ```bash
   kubectl get monitordashboards.ait.alauda.io -A --sort-by=.metadata.creationTimestamp
   kubectl get grafanadashboard -A --sort-by=.metadata.creationTimestamp
   kubectl get monitordashboards.ait.alauda.io -A -o yaml > /tmp/monitordashboards-all.yaml
   kubectl get grafanadashboard -A -o yaml > /tmp/grafanadashboard-all.yaml
   ```

2. Delete the old objects.

   > **Warning:** Deleting dashboard objects removes those dashboards from the monitoring pages. Deleting an object that belongs to an installed plugin removes a current dashboard until the plugin restores it. Do this only after an upgrade from 3.18, for objects that predate the upgrade and whose plugin is no longer installed, and only after the two backup files exist. To roll back, run `kubectl apply -f` with the backup files.

   ```bash
   kubectl -n <namespace> delete monitordashboards.ait.alauda.io <old-dashboard>
   kubectl -n <namespace> delete grafanadashboard <old-grafanadashboard>
   ```

3. The deletes can create `ResourcePatch` (`rpch`) objects. List them; deleting the `rpch` objects created by these deletes makes the installed plugin update and recreate its own dashboards:

   ```bash
   kubectl get rpch -A
   kubectl delete rpch <rpch-name>
   ```

4. Reload the monitoring page. It no longer freezes.

### Cause 3: Cluster Enhancer is not installed

1. Confirm that the plugin is not installed on the cluster: the second command returns nothing.

   ```bash
   kubectl get monitordashboards.ait.alauda.io -A | grep -i -E 'cluster|node|host'
   kubectl get monitordashboards.ait.alauda.io -n cpaas-system -l helm.sh/chart-name=cluster-enhancer
   ```

2. Install **Alauda Container Platform Cluster Enhancer** on that cluster from **Cluster Plugins**. The dashboards are synchronized after the installation. Copying `monitordashboard` objects by hand is not a substitute.

3. Reload the **Monitoring** page. The new layout shows all tabs and the overview panels have data.

### Cause 4: business clusters on 3.16 under a 4.0 global cluster

The workaround is to take the dashboard objects from the `global` cluster, adjust them, and apply them to the business cluster. Remove the server-generated metadata before applying:

```bash
# on the global cluster
kubectl get monitordashboards.ait.alauda.io -n cpaas-system <dashboard-name> -o yaml > /tmp/<dashboard-name>.yaml
# remove uid, resourceVersion, creationTimestamp and managedFields, then on the business cluster:
kubectl apply -f /tmp/<dashboard-name>.yaml
```

> **Warning:** A dashboard object from the newer version can reference metrics or recording rules that the 3.16 cluster does not have, and those panels then stay empty. Do this only on a business cluster that is still on 3.16 under a 4.0 `global` cluster, after saving a copy of any object of the same name that already exists there. To roll back, run `kubectl delete -f /tmp/<dashboard-name>.yaml` on the business cluster.

## Diagnostic Steps

1. For a frozen tab, look for the bad key. Output that shows `true:` inside a `gridPos` block matches Cause 1:

   ```bash
   kubectl get monitordashboards.ait.alauda.io -A -o yaml | grep -n -A3 gridPos | grep -n 'true:'
   ```

2. If there is no bad key and the cluster was upgraded from 3.18, list dashboard objects by age. Objects with the age of the 3.18 deployment whose plugin is gone match Cause 2.

3. For missing cluster or host dashboards, run the `helm.sh/chart-name=cluster-enhancer` query from Cause 3. An empty result matches Cause 3. In the browser developer tools (**Network**), a healthy page requests `monitordashboards?labelSelector=cpaas.io/dashboard.folder=cluster` in `cpaas-system`.

4. For a business cluster that shows only the overview, compare its version with `global`, and list its dashboards. A single `kubernetes-cluster` object on a 3.16 business cluster under a 4.0 `global` matches Cause 4.
