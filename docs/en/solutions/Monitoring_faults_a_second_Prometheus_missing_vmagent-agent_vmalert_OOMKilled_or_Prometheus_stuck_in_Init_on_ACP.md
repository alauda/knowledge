---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16.x
  - 4.2.x
  - 4.3.x
---

# Monitoring faults: a second Prometheus, missing vmagent-agent, vmalert OOMKilled, or Prometheus stuck in Init on ACP

## Issue

A cluster inspection reports monitoring items as abnormal (the report may only say `集群巡检项异常`, "cluster inspection item abnormal", without naming a row), or platform monitoring data looks wrong, and the cause is a real fault rather than a false positive. One of these is in the report, the events, or a pod log:

- Events or the API server log contain `apiserver was unable to write a JSON response: http: Handler timeout` for `GET /apis/monitoring.coreos.com/v1/prometheusrules`. An application team has deployed its own Prometheus in the cluster.
- The VictoriaMetrics row on a global cluster (including a standby global cluster) says that the `vmagent-agent` Deployment does not exist.
- `vmalert` or another `vm*` container in `cpaas-system` restarts with `OOMKilled`, and monitoring for many clusters drops in and out.
- The cluster monitoring component is abnormal and cannot start (`集群监控组件异常 无法启动`). One Prometheus replica stays in `Init`, and its events say that the data volume cannot be mounted.

When the report names no specific row, run the first check in Diagnostic Steps before you ask for more detail. It is read-only and separates these causes from each other.

## Root Cause

### Cause 1: A second Prometheus makes the API server time out on prometheusrules

Events and API server logs show `apiserver was unable to write a JSON response: http: Handler timeout` while serving `GET /apis/monitoring.coreos.com/v1/prometheusrules`. A Prometheus installed by an application team runs in the cluster next to the platform monitoring stack. That second Prometheus is what makes platform monitoring and the inspection data wrong. Removing it restores platform monitoring. The platform monitoring release in `cpaas-system` is not the one to remove.

### Cause 2: deployments.apps "vmagent-agent" not found

The VictoriaMetrics AppRelease in `cpaas-system` stays `NotReady` with the event `deployments.apps "vmagent-agent" not found`. `kubectl get deploy -n cpaas-system vmagent-agent` confirms that the Deployment is gone. The VMAgent custom resource named `agent` can still exist, with status `expanding`. The `vm-operator` logs show no error or warning, the audit logs show no delete of that Deployment, and no resource patch (`rpch`) explains it. Updating the `victoriametrics` AppRelease, so that the controller renders the chart again, brings the Deployment back. Why the Deployment disappeared is not known.

### Cause 3: A VictoriaMetrics monitoring container is OOMKilled because its memory limit is too low

A global VictoriaMetrics monitoring container restarts with `OOMKilled` (for example `vmalert-alert` in `cpaas-system`, with both pods abnormal). Several business clusters store their metrics on the global cluster, and the memory limit of that component is too low for the load. Raising the memory limit on the monitoring component resolves it. This is not Cause 2: here the Deployment exists and is being killed.

### Cause 4: One Prometheus replica is stuck in Init because its data volume cannot be mounted on a failing storage backend

The monitoring component is reported abnormal and cannot start. The stack is Prometheus (not VictoriaMetrics). One Prometheus replica stays in `Init`, and the pod events show that the Prometheus database volume cannot be mounted. The PVC is on Ceph storage, and the storage side has a disk problem. After the storage problem is repaired, the volume mounts and monitoring returns to normal, with no change to the monitoring plugin. This is not an OOM restart: the container never starts, so there is no `OOMKilled` last state.

## Resolution

### Cause 1: A second Prometheus makes the API server time out on prometheusrules

1. Find the Prometheus instances that are not the platform release:

   ```bash
   kubectl get prometheus -A
   kubectl get deploy,sts -A | grep -i prometheus
   ```

2. Remove the application team's Prometheus.

   > **Warning:** Uninstalling that Prometheus stops the application team's metrics, rules and any dashboard that reads it. Precondition: the `Handler timeout` line is present, and you have identified the object by namespace and name as not belonging to the platform monitoring in `cpaas-system`. Rollback: reinstall it from the team's manifest. Leave the platform monitoring plugin in place.

   Uninstall it with the same method that installed it: the team's Helm release, or `kubectl delete` of their `Prometheus` and its operator.

3. Check that `GET /apis/monitoring.coreos.com/v1/prometheusrules` answers again and that the inspection items that depend on platform monitoring clear.

### Cause 2: deployments.apps "vmagent-agent" not found

1. Confirm that the Deployment is really absent:

   ```bash
   kubectl -n cpaas-system get deploy vmagent-agent
   kubectl -n cpaas-system describe ars victoriametrics
   kubectl -n cpaas-system get vmagent,ars | grep -i agent
   ```

2. Save the AppRelease, then update it.

   > **Warning:** Updating the `victoriametrics` AppRelease renders the chart again and can roll the VictoriaMetrics pods, and scrapes pause during that rollout. Precondition: the Deployment is missing, and you saved the AppRelease YAML on the global cluster where the event appears. Rollback: `kubectl apply -f /tmp/victoriametrics-ars.before.yaml`. Update the AppRelease; do not delete it.

   ```bash
   kubectl -n cpaas-system get ars victoriametrics -o yaml > /tmp/victoriametrics-ars.before.yaml
   ```

   Run the VictoriaMetrics plugin update in the console, so that this object is rewritten and the chart renders again.

3. Check that `vmagent-agent` exists and that the AppRelease becomes Ready:

   ```bash
   kubectl -n cpaas-system get deploy vmagent-agent
   kubectl -n cpaas-system get ars victoriametrics
   ```

### Cause 3: A VictoriaMetrics monitoring container is OOMKilled because its memory limit is too low

1. Confirm that the container's last state is `OOMKilled`:

   ```bash
   kubectl -n cpaas-system get pods | grep -E 'vmagent|vmalert|vmstorage|vminsert'
   kubectl -n cpaas-system get pod <vm-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" last="}{.lastState.terminated.reason}{"\n"}{end}'
   kubectl -n cpaas-system get pod <vm-pod> -o jsonpath='{range .spec.containers[*]}{.name}{" lim="}{.resources.limits.memory}{"\n"}{end}'
   ```

2. Raise the memory limit.

   > **Warning:** Raising the limit rolls the pods of that component, and alerting or scraping pauses briefly while they restart. Precondition: `OOMKilled` is confirmed, and the node has free memory for the new limit. Rollback: set the previous limit on the plugin again.

   Raise the memory limit of the OOMKilled component on the monitoring plugin that owns the pod, so that the plugin does not write the old value back. Size it from the usage that led to the kill and from the free memory on the node.

3. Watch that the restarts stop.

### Cause 4: One Prometheus replica is stuck in Init because its data volume cannot be mounted on a failing storage backend

1. Find out which monitoring stack the cluster uses and which pod does not start:

   ```bash
   kubectl -n cpaas-system get pods | grep -E 'prometheus|vmstorage|vmselect|vmagent|vmalert'
   kubectl -n cpaas-system describe pod <prometheus-pod> | sed -n '/Events/,$p'
   ```

2. From the events, take the PVC behind the volume that fails to mount, and find its StorageClass and provisioner:

   ```bash
   kubectl -n cpaas-system get pod <prometheus-pod> -o jsonpath='{range .spec.volumes[*]}{.name}{" "}{.persistentVolumeClaim.claimName}{"\n"}{end}'
   kubectl -n cpaas-system get pvc <pvc-name> -o wide
   kubectl get sc <storage-class> -o jsonpath='{.provisioner}{"\n"}'
   ```

3. Repair the storage backend, not the monitoring component. For Rook Ceph, check the cluster health and the OSDs first:

   ```bash
   kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
   kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
   ```

   A down OSD or a failed disk is a storage repair. Follow the procedures for that backend.

4. After the storage side is healthy, watch the Prometheus pod leave `Init`. No change to the monitoring plugin or its resources is needed.

## Diagnostic Steps

1. Read the lines that separate the causes, before you uninstall or update anything:

   ```bash
   kubectl get events -A --sort-by=.lastTimestamp | grep -i 'Handler timeout' || true
   kubectl -n kube-system logs kube-apiserver-<node> --tail=100 | grep -F 'prometheusrules' || true
   kubectl get prometheus -A
   kubectl -n cpaas-system get deploy vmagent-agent
   kubectl -n cpaas-system get pods | grep -E 'prometheus|vmalert|vmagent|vmstorage'
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `http: Handler timeout` on the `prometheusrules` path, and a Prometheus that is not the platform release | Cause 1 |
   | `deployments.apps "vmagent-agent" not found` | Cause 2 |
   | `OOMKilled` on a `vm*` container | Cause 3 |
   | A Prometheus pod in `Init` whose events report a volume mount failure | Cause 4, check the storage backend of its PVC |

3. A red monitoring row with healthy pods and only a slow scrape or query is usually a false positive, not one of these causes.

## Related Information

- Related articles: [Inspection faults: x86-64-v2 CPU error, discover-device crash loop, small ClickHouse limits, log backlog, or WebCLI role on ACP](./Inspection_faults_x86-64-v2_CPU_error_discover-device_crash_loop_small_ClickHouse_limits_log_backlog_or_WebCLI_role_on_ACP.md) covers the other real faults that a cluster inspection reports.
- [vmagent fails to scrape node-exporter 9100 metrics because its basicAuth does not match node-exporter on ACP](./vmagent_fails_to_scrape_node-exporter_9100_metrics_because_its_basicAuth_does_not_match_node-exporter_on_ACP.md)
