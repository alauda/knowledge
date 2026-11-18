---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Monitoring plugin uninstall or Prometheus to VictoriaMetrics switch leaves ModuleInfo, AppRelease, or Pods on ACP

## Issue

A monitoring plugin is being uninstalled, or a cluster is being moved from Prometheus to VictoriaMetrics, and the platform does not reach a clean state:

- The Prometheus uninstall never finishes: the global `ModuleInfo` (`minfo`) stays `deleting`, while `prometheus-operator` on the workload cluster is already gone.
- The functional-component page still says Prometheus Operator is abnormal after the cluster moved to VictoriaMetrics, and the namespace shown on the `minfo` contains no operator objects.
- VictoriaMetrics is installed and Running, but a Prometheus AppRelease (`ars`) is still `Syncing`, and Prometheus Pods such as `kube-prometheus-grafana`, `kube-prometheus-thanos-query`, `prometheus-operator` or `cpaas-monitor-prometheus-adapter` remain.
- All VictoriaMetrics Pods are Running, but the VictoriaMetrics `minfo` on global stays `Processing`.
- Installing VictoriaMetrics fails on a taint that says Prometheus is already running, although Marketplace lists Prometheus as not installed; or two VictoriaMetrics instances run on one cluster.

Plugin state is the global `ModuleInfo` plus the workload-cluster `AppRelease` in `cpaas-system`; `sentry` applies the releases, and `cluster-transformer` recreates a `minfo` that is deleted while it is running.

Related articles: [Monitoring plugin install or redeploy fails: ResourcePatch conflict, IPv6 Service, mkdirOnNode, or alertmanager-pv-0](Monitoring_plugin_install_or_redeploy_fails_ResourcePatch_conflict_IPv6_Service_mkdirOnNode_or_alertmanager-pv-0.md), [AppRelease abnormal because a ModuleInfo of a deleted cluster remains on ACP](AppRelease_abnormal_because_a_ModuleInfo_of_a_deleted_cluster_remains_on_ACP.md).

## Root Cause

### Cause 1: the post-delete job times out on a very large set of PrometheusRules

The uninstall job and the chart cleanup script walk every `PrometheusRule`. With a very large set the job hits its deadline and retries forever, so the `minfo` stays `deleting`. Pods of the old release can keep running after the AppRelease is gone, and if the `Alertmanager` and `Prometheus` custom resources were not deleted, a `prometheus-operator` that comes back adopts them again and replica counts look wrong.

### Cause 2: the Prometheus Operator plugin is still installed after the move to VictoriaMetrics

The `minfo` still points at the old operator namespace, but that namespace has no Prometheus Operator Pod, CSV or PackageManifest (seen on 3.18.2 with VictoriaMetrics live). Restarting `sentry`, editing the `minfo` version, or patching an unrelated AppRelease does not clear it. Deleting the `minfo` while `cluster-transformer` runs makes it come back; deleting it with `cluster-transformer` stopped fails the `vmoduleinfo.kb.io` webhook. Removing the Prometheus Operator plugin itself clears the row.

### Cause 3: a previous Prometheus uninstall left its AppRelease behind its finalizers

The VictoriaMetrics `minfo` is `Running`, global has no Prometheus `minfo`, and on the workload cluster the Prometheus `ars` is still `Syncing` or `Ready` with a status saying the kube-prometheus chart is Installing. The earlier uninstall did not finish, and the `ars` stays until its `finalizers` are removed.

### Cause 4: a leftover Prometheus monitor AppRelease keeps the VictoriaMetrics minfo in Processing

A Prometheus uninstall got stuck during an earlier upgrade; its `minfo` was deleted by hand but its AppReleases were not. VictoriaMetrics was then deployed on top of that state, so its `minfo` never leaves `Processing`, and a normal VictoriaMetrics uninstall cannot complete either.

### Cause 5: Prometheus and VictoriaMetrics cannot run side by side

The platform Prometheus and VictoriaMetrics share the same node-exporter, so they are not allowed to coexist and the install conflict is expected. After an upgrade from 3.18 to 4.1, the Prometheus Pods were still running while Marketplace listed Prometheus as not installed. Two platform VictoriaMetrics instances on one 4.2 global cluster made the data services page show wrong data. A second, self-installed open-source VictoriaMetrics next to the platform one uses the same upstream CRDs and may cause data conflicts; it is not recommended.

## Resolution

### Cause 1: the post-delete job times out on a very large set of PrometheusRules

1. Count the rules and read the module state:

   ```bash
   kubectl get prometheusrule -A --no-headers | wc -l
   kubectl get moduleinfo -A | grep -i prometheus
   kubectl -n cpaas-system get pod | grep -Ei 'prometheus|alertmanager|sentry'
   ```

2. Back up the rules off the cluster, then delete them per namespace that holds a large share.

   > **Warning:** Deleting `PrometheusRule` objects removes those alerts until they are restored, and the backup file is the only rollback. Precondition: `/tmp/prometheusrule-backup.yaml` is copied off the cluster, and missing alerts are acceptable for the window. Do not delete `cpaas-cluster-rules` unless it is part of the blocking set and is in the backup. Rollback: `kubectl apply -f /tmp/prometheusrule-backup.yaml`.

   ```bash
   kubectl get prometheusrule -A -o yaml > /tmp/prometheusrule-backup.yaml
   kubectl delete prometheusrule -n <namespace> --all
   ```

3. Let `sentry` retry the post-delete job. If it does not retry, recreate the `sentry` Pod.

   > **Warning:** Recreating `sentry` pauses module installs and uninstalls platform-wide until it is Ready. Precondition: the rule backlog is already deleted, or the job times out again. Rollback is the controller starting a new Pod.

   ```bash
   kubectl get pod -A | grep sentry
   kubectl -n <sentry-namespace> delete pod <sentry-pod>
   ```

4. Remove leftover operator objects so a later install does not adopt them.

   > **Warning:** Deleting the `Prometheus` and `Alertmanager` resources tears down their StatefulSets and stops scraping and notification. Precondition: this is the uninstall you intended, and the data on the PVC is expendable or copied. Rollback: reinstall the plugin, which creates new resources.

   ```bash
   kubectl -n cpaas-system get prometheus,alertmanager
   kubectl -n cpaas-system delete prometheus <name>
   kubectl -n cpaas-system delete alertmanager <name>
   ```

### Cause 2: the Prometheus Operator plugin is still installed after the move to VictoriaMetrics

```bash
kubectl get minfo -A | grep -i prometheus
kubectl get pod,csv,packagemanifest -A | grep -i prometheus
kubectl -n cpaas-system get pod | grep -Ei 'cluster-transformer|sentry'
```

> **Warning:** Removing the Prometheus Operator plugin deletes any operands it still has. Precondition: VictoriaMetrics already serves the cluster, and any `PrometheusRule` you still need is backed up (Cause 1). Rollback: install the plugin again from the catalog.

Uninstall the Prometheus Operator plugin through the platform with `cluster-transformer` left running; do not delete the `minfo` by hand. If a VictoriaMetrics install in the same window fails on a `webhook.cert-manager.io` `context deadline exceeded` timeout, repair the cert-manager webhook before retrying.

### Cause 3: a previous Prometheus uninstall left its AppRelease behind its finalizers

1. Confirm VictoriaMetrics is the live stack and the Prometheus `ars` is the leftover:

   ```bash
   kubectl get minfo -A | grep -Ei 'prometheus|victoriametrics'
   kubectl -n cpaas-system get ars
   kubectl get pods -A -o wide | grep prometheus | grep -iv exporter
   ```

2. Save the `ars`, clear its finalizers and delete it.

   > **Warning:** This drops the leftover Prometheus release, including its Grafana, Thanos query, operator and adapter, and any scraping that still depended on it. Precondition: the VictoriaMetrics `minfo` is `Running`, no Prometheus `minfo` exists, and the `ars` shows the old kube-prometheus chart Installing. Rollback after a successful delete: install the Prometheus plugin again; old Prometheus data is reattached only if its PVC still exists.

   ```bash
   kubectl -n cpaas-system get ars <prometheus-ars-name> -o yaml > /tmp/prometheus-ars.yaml
   kubectl -n cpaas-system patch ars <prometheus-ars-name> --type=json -p '[{"op":"remove","path":"/metadata/finalizers"}]'
   kubectl -n cpaas-system delete ars <prometheus-ars-name> --wait=false
   ```

3. Delete the leftover Prometheus Pods and Jobs from the list (for example `cpaas-monitor-prometheus-adapter`, `kube-prometheus-grafana`, `kube-prometheus-thanos-query`, `prometheus-operator`). Skip every name that belongs to the VictoriaMetrics release.

   > **Warning:** Deleting them stops the old Prometheus query path and adapter. Precondition: each name is in the leftover list and vmui already returns samples. Rollback: reinstall Prometheus.

   ```bash
   kubectl -n cpaas-system delete pod <leftover-prometheus-pod>
   ```

### Cause 4: a leftover Prometheus monitor AppRelease keeps the VictoriaMetrics minfo in Processing

1. Identify the leftover monitor `ars` created by the earlier Prometheus install:

   ```bash
   kubectl get minfo -A | grep -Ei 'victoriametrics|prometheus'
   kubectl -n cpaas-system get ars
   kubectl -n cpaas-system get ars <monitor-ars> -o yaml | grep -n -i -E 'chart|prometheus'
   ```

2. Save and delete the VictoriaMetrics `minfo` (on global), the VictoriaMetrics `ars` and the leftover monitor `ars` (on the workload cluster), then deploy VictoriaMetrics again.

   > **Warning:** This removes VictoriaMetrics monitoring of that cluster until it is redeployed; data on a retained volume is reattached only if the same PVC is reused. Precondition: the VictoriaMetrics `minfo` is stuck in `Processing`, a Prometheus monitor `ars` predates it, and a normal uninstall cannot complete. Rollback: redeploy the plugin; the saved YAML is for reference, not for reapplying the stuck state.

   ```bash
   kubectl get minfo <vm-minfo> -o yaml > /tmp/vm-minfo.yaml
   kubectl -n cpaas-system get ars <vm-ars> -o yaml > /tmp/vm-ars.yaml
   kubectl -n cpaas-system get ars <monitor-ars> -o yaml > /tmp/monitor-ars.yaml
   kubectl delete minfo <vm-minfo>
   kubectl -n cpaas-system delete ars <vm-ars> <monitor-ars>
   ```

   If an object hangs on finalizers, handle it as in Cause 3.

### Cause 5: Prometheus and VictoriaMetrics cannot run side by side

```bash
kubectl get minfo -A | grep -Ei 'prometheus|victoriametrics'
kubectl get ds -A | grep -i exporter-node
```

Run one platform monitoring solution per cluster. Switch by uninstalling the current plugin through the platform before installing the other; clean up leftovers of an incomplete switch with Causes 3 and 4 rather than deleting the Prometheus DaemonSet and Pods by hand, which left the overview without cluster metrics. For two platform VictoriaMetrics instances on global, uninstall the duplicate. For a business-owned second VictoriaMetrics, do not install it on a cluster that already runs the platform one.

## Diagnostic Steps

1. Read the module phase on global and the AppReleases on the workload cluster before restarting anything:

   ```bash
   kubectl get minfo -A
   kubectl -n cpaas-system get ars
   ```

2. `deleting` plus a large `PrometheusRule` count: Cause 1.

3. An abnormal Prometheus Operator row with an empty namespace while VictoriaMetrics is live: Cause 2.

4. VictoriaMetrics `minfo` `Running`, no Prometheus `minfo`, and a Prometheus `ars` still Installing: Cause 3.

5. VictoriaMetrics `minfo` stuck `Processing` with a leftover Prometheus monitor `ars`: Cause 4.

6. A taint that says Prometheus is running, or two VictoriaMetrics installs: Cause 5. Expected after cleanup: exactly one monitoring `minfo` per cluster, `Running`.
