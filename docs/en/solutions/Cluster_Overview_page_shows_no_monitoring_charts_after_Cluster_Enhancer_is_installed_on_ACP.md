---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Cluster Overview page shows no monitoring charts after Cluster Enhancer is installed on ACP

## Issue

Under **Cluster Management** > **Clusters**, clicking a cluster opens its **Overview** (`概览`) page, and there are no monitoring charts below the cluster information. The chart area is missing entirely; this is not a set of charts that keep loading or report an error. The question that usually follows is whether the charts only appear once the Cluster Enhancer plugin is installed.

This article applies when the **Alauda Container Platform Cluster Enhancer** plugin is installed on that cluster. In **App Marketplace Management** > **Cluster Plugins** the plugin is listed as installed, with a description saying that it enhances the cluster by backing up etcd data, monitoring certificates, and cleaning up events.

If Cluster Enhancer is **not** installed and the cluster or host dashboards are missing from **Operations Center** > **Monitoring**, see Cause 3 of [Monitoring page freezes the browser or built-in dashboards are missing on ACP](Monitoring_page_freezes_the_browser_or_built_in_dashboards_are_missing_on_ACP.md). Charts that are present but spin or stay empty are covered in [Monitoring pages return 502 or context deadline exceeded because port 11780 on the cluster VIP is blocked on ACP](Monitoring_pages_return_502_or_context_deadline_exceeded_because_port_11780_on_the_cluster_VIP_is_blocked_on_ACP.md).

## Root Cause

### Cause 1: the Overview monitoring panels are removed when Cluster Enhancer is installed

This is expected behavior, not a collection or query fault. Once Cluster Enhancer is installed on a cluster, the monitoring panels on that cluster's **Overview** page are removed. Cluster, node, container, and Pod monitoring for that cluster is shown instead in **Operations Center** > **Monitoring** > **Monitoring Dashboards**, in the built-in dashboards of the `kubernetes` group.

## Resolution

### Cause 1: the Overview monitoring panels are removed when Cluster Enhancer is installed

There is nothing to repair. Use the built-in dashboards instead:

1. Open **Operations Center** > **Monitoring** > **Monitoring Dashboards**.
2. Select the cluster and open the `kubernetes` group.
3. Use its built-in dashboards:

   | Dashboard | Name in the Chinese UI |
   | --- | --- |
   | Cluster Status | `集群状态` |
   | Container Monitoring | `容器监控` |
   | Node Monitoring | `节点监控` |
   | Pod Monitoring | `容器组监控` |

Because installing Cluster Enhancer is what removes the Overview panels, installing or reinstalling it does not bring them back. There is no setting that restores monitoring panels on the Overview page.

If those `kubernetes` dashboards are themselves empty, treat it as a separate fault: see [Monitoring dashboard panels are blank or drop to zero while the backend has data on ACP](Monitoring_dashboard_panels_are_blank_or_drop_to_zero_while_the_backend_has_data_on_ACP.md) when the API returns data, or the port 11780 article above when the browser developer tools show HTTP 500, 502, or `context deadline exceeded`.

## Diagnostic Steps

1. Confirm which page is empty. The symptom here is the **Overview** page under **Cluster Management** > **Clusters**, with no chart area at all.

2. On that cluster, list the dashboards that Cluster Enhancer synchronizes:

   ```bash
   kubectl get monitordashboards.ait.alauda.io -n cpaas-system -l helm.sh/chart-name=cluster-enhancer
   ```

   Expected for this article: objects are listed, so the plugin is installed and its dashboards are present. If nothing is listed, the plugin is not installed or has not synchronized; use the "built-in dashboards are missing" article linked in the Issue section.

3. Open the `kubernetes` group under **Operations Center** > **Monitoring** > **Monitoring Dashboards** for the same cluster. Expected: **Cluster Status** and **Node Monitoring** show data, which confirms that monitoring works and only the Overview panels were removed. To see the dashboard objects behind the group:

   ```bash
   kubectl get monitordashboards.ait.alauda.io -A | grep -i kubernetes
   ```
