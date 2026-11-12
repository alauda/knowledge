---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12
  - 3.16
  - 3.18
  - 4.0
  - 4.1
  - 4.2
  - 4.3
---

# Monitoring dashboard panels are blank or drop to zero while the backend has data on ACP

## Issue

The monitoring backend has data, but monitoring panels do not show it as expected. Typical symptoms:

- The application monitoring overview, a namespace dashboard, or the CPU and memory **usage rate** panels show no data. A related request is a command that lists which workloads in the cluster have no CPU or memory limit.
- The network packet send or receive rate drops to 0 periodically, or its latest value reads 0, while traffic is flowing.
- Right after monitoring was deployed, the page is empty or abnormal for several minutes.
- Every monitoring page and vmui show no data (Node and Pod counts `0`, totals `无数据`, no data) although all VictoriaMetrics Pods are `Running`.

Before changing any dashboard, run the panel's expression in vmui or the Prometheus UI (`https://<platform-domain>/clusters/<cluster-name>/prometheus-0`), or read the response in the browser developer tools (F12, **Network**). If the query returns data and the chart does not, use this article. If the query is empty too, the problem is in the query path; see [Monitoring pages return 502 or context deadline exceeded because port 11780 on the cluster VIP is blocked on ACP](Monitoring_pages_return_502_or_context_deadline_exceeded_because_port_11780_on_the_cluster_VIP_is_blocked_on_ACP.md).

Related article: [Monitoring page freezes the browser or built-in dashboards are missing on ACP](Monitoring_page_freezes_the_browser_or_built_in_dashboards_are_missing_on_ACP.md) covers frozen pages and missing dashboards.

## Root Cause

### Cause 1: there is nothing to graph

- A namespace dashboard is blank while a single compute-component panel has data, and the namespace has no native application deployed. The namespace-level dashboard and the application monitoring overview monitor native applications only, so no data is the expected result.
- CPU usage rate and memory usage rate show no data when the container has no CPU or memory limit, because the ratio to the limit cannot be computed. This applies to the Pod and application monitoring overview dashboards as well (also with VictoriaMetrics on 4.2.2). The same charts still offer a usage-amount view.

Neither case is a broken scraper.

### Cause 2: packet-rate panels drop to zero because the expression uses irate

The packets received and sent per second keep oscillating: the curve shows data and then resets to zero, on business Pods and in vmui. The namespace dashboard expression uses `irate()`, which uses only the last two samples in the window; a sustained download still produces periodic zeros, so the drops come from the calculation, not from traffic stopping.

Two related faces:

- The **latest value** of a packet panel reads 0 on Pods that serve traffic. Packets do not arrive every second, so the latest point can be 0 while the enlarged chart (three-dot menu > **View**) shows the rate fluctuating. Bytes can be non-zero while packets read 0 at the same instant.
- The result depends on the query `step`. The front end uses `step=30` for ranges up to 30 minutes (and in the enlarged view up to 1 day), `step=60` in the small panel from 1 hour, and `step=300` for 3 and 7 days. A packet receive-rate panel (`网络报文量接收速率`) can return data at `step=30` and 0 at 60 or 300, in the Prometheus UI as well.

### Cause 3: monitoring was just deployed

On a newly built environment the monitoring page can be empty or abnormal right after deployment, while the VictoriaMetrics Pods are `Running` and data is already being written. Metrics can take about 10 minutes after the monitoring plugin is installed to appear on the **Monitoring** page.

### Cause 4: the clock of the computer running the browser is wrong

When the clock of the computer running the browser does not match the cluster time, the cluster monitoring page, the monitoring dashboards, and vmui all show no data, and business-cluster CPU and memory panels are empty, although every `vm` Pod is `Running`. The query time range is likely built from the client clock, so it does not cover the stored samples.

## Resolution

### Cause 1: there is nothing to graph

1. Check whether the namespace has any native application. If it has none, a blank namespace-level dashboard is expected and no change is needed.
2. If the namespace runs workloads and the blank panel is a usage-rate panel, check whether the workloads declare CPU and memory limits. Without a limit, the usage-amount view is what the chart can show. Setting limits caps the container, so it is a decision for the workload owner, not a monitoring fix.

   ```bash
   kubectl -n <namespace> get deploy,sts,ds
   kubectl -n <namespace> get deploy,sts,ds -o jsonpath='{range .items[*]}{.metadata.name}{" limits="}{.spec.template.spec.containers[0].resources.limits}{"\n"}{end}'
   ```

   This reads only the first container of each workload in one namespace.

3. To list, across the whole cluster, every Pod that has at least one container without a CPU limit or without a memory limit (read-only, requires `jq`):

   ```bash
   kubectl get pods -A -o json |
   jq -r '
   ["Namespace", "Pod"],
   (
   .items[]
   | select(
   any(
   .spec.containers[];
   (.resources.limits.cpu // "") == ""
   or
   (.resources.limits.memory // "") == ""
   )
   )
   | [.metadata.namespace, .metadata.name]
   )
   | @tsv
   ' | column -t
   ```

   Pods of one Deployment share its name as a prefix. Init containers are not checked by this filter.

### Cause 2: packet-rate panels drop to zero because the expression uses irate

1. Find the namespace dashboards (names starting with `ns` in `cpaas-system`) and back them up:

   ```bash
   kubectl get monitordashboards.ait.alauda.io -n cpaas-system -o name | grep '/ns'
   kubectl get monitordashboards.ait.alauda.io -n cpaas-system -o yaml > /tmp/ns-monitordashboards.yaml
   ```

2. Replace `irate` with `rate` in the packet-rate expressions only.

   > **Warning:** The change affects the packet-rate panels of every namespace that uses the dashboard, and a bulk replace outside those expressions changes unrelated panels. Do this only when vmui shows the same reset to zero and the packet expression in the backup uses `irate`. To roll back, run `kubectl apply -f /tmp/ns-monitordashboards.yaml`. Stored samples are not affected.

   ```bash
   kubectl edit monitordashboards.ait.alauda.io -n cpaas-system <ns-dashboard-name>
   ```

   No monitoring Pod restart is required.

3. For the step-dependent zero, select the last 30 minutes, or use the enlarged view for ranges up to 1 day (`step=30`).
4. When the only complaint is a latest value of 0, open the enlarged chart and read the curve. The latest value of this metric has little meaning on its own; nothing needs to change.

### Cause 3: monitoring was just deployed

Check that the monitoring Pods are `Running`, wait about 10 minutes, and reload the page:

```bash
kubectl -n cpaas-system get pod | grep -Ei 'vm|prometheus'
```

If the page is still empty after that, follow the port 11780 article linked in the Issue section.

### Cause 4: the clock of the computer running the browser is wrong

1. Print the time on a cluster node and compare it with the clock of the computer running the browser, or with the `start` and `end` parameters of a query in the browser developer tools:

   ```bash
   date -u '+%Y-%m-%d %H:%M:%S UTC'
   ```

2. Correct the time of the client computer and reload. The data is displayed once the two clocks match.

## Diagnostic Steps

1. Run the panel expression in vmui or the Prometheus UI and read the F12 response for the chart. Expected for this article: the API returns data and the chart does not show it as expected.

2. Blank usage-rate panels: check whether the namespace has native applications and whether the containers declare limits (Cause 1). Expected: no application, or an empty `limits=` field.

3. Packet panels that drop to 0: open the dashboard object and look for `irate` in the packet expressions (Cause 2):

   ```bash
   kubectl get monitordashboards.ait.alauda.io -n cpaas-system -o yaml | grep -n 'irate'
   ```

4. A page that is empty only in the first minutes after deployment, with healthy Pods: Cause 3.

5. Every page and vmui empty with healthy Pods: compare the client clock with a node (Cause 4). Expected: a difference large enough to move the query window away from the stored samples.
