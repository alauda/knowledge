---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.8.x
  - 3.10.x
  - 3.12.x
  - 3.14.x
  - 3.16.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Grafana returns HTTP 500 after a password change, is missing after an upgrade, or rules and alerts do not carry over on ACP

## Issue

One of these is reported about Grafana or the monitoring stack around it:

- The operations center returns HTTP 500 on Grafana after the Grafana admin password was changed in the Grafana UI. Logging in on the Grafana page itself with the new password works.
- Platform 3.18 has no Grafana at all, or the Grafana page disappeared after an upgrade to 4.0, and JVM, Tomcat, Istio or StarRocks charts are still needed.
- On 3.8.2, logging in to Grafana (v7.5.16) with `admin/admin` fails with `Invalid username or password`.
- A security scan reports Prometheus or component metrics reachable without authentication on 3.14, including `kube-ovn-monitor`, `kube-ovn-controller`, or `devops-api` on NodePort `30699`.
- DingTalk answers `errcode: 300001`, `errmsg: msgtype is null`, or Feishu and other webhooks return `InvalidJson` from `apollo`, for example `invalid character 'å' looking for beginning of value`.
- `PrometheusRule` objects exported from a 3.10 cluster do nothing on a 4.3 VictoriaMetrics cluster.
- There is no built-in alert for APIServer restarts or etcd WAL and proposal latency.

When the chart includes it, Grafana runs in `cpaas-system` and the operations center signs in to it with a password stored in a Secret.

Related article: [External Grafana or scripts cannot query platform metrics: vmselect address, credentials, and vmui errors on ACP](External_Grafana_or_scripts_cannot_query_platform_metrics_vmselect_address_credentials_and_vmui_errors_on_ACP.md).

## Root Cause

### Cause 1: the Grafana Secret still holds the old password

The operations center signs in to Grafana server-side with the password from Grafana's Secret. A password changed only in the Grafana UI leaves the Secret on the old value, so the operations center session fails with HTTP 500 while a browser login with the new password works.

### Cause 2: platform versions from 3.18 do not ship Grafana

3.18 has Prometheus and no built-in Grafana, and later versions no longer provide Grafana dashboards. A Grafana page that is gone after an upgrade to 4.0 is expected. JVM and Tomcat charts exist only when something scrapes the application and a dashboard reads those metrics.

### Cause 3: the 3.8.2 Grafana admin password is not admin/admin and cannot be changed

On 3.8.2 `admin/admin` is rejected, and that version has no procedure for changing the Grafana admin password. The Grafana embedded under **Operations Center > Monitoring > Grafana** still shows its dashboards.

### Cause 4: metrics ports answer without authentication on 3.14

On 3.14.x the metrics ports answer without authentication; builds from 3.18.0 close it. 3.14 has no supported switch to add authentication to those ports. `kube-ovn-monitor` and `kube-ovn-controller` in `kube-system` belong to the same finding, and a build without the `--enable-metrics` flag cannot turn their handler off. `devops-api` exposed as NodePort `30699` makes its metrics reachable from outside the node.

### Cause 5: the webhook body is not the JSON the receiver requires

DingTalk answers `msgtype is null` because the rendered body has no `msgtype`. Feishu or a generic webhook returns `InvalidJson` because the template is Markdown or HTML, or webhook template rendering is off. TCP reachability is fine; the HTTP status is an application error. These cases are covered in [DingTalk robot rejects alert notifications with errcode 300001 or 310000 on ACP](DingTalk_robot_rejects_alert_notifications_with_errcode_300001_or_310000_on_ACP.md) and [Webhook alert notifications rejected as InvalidJson or sent without the notification template on ACP](Webhook_alert_notifications_rejected_as_InvalidJson_or_sent_without_the_notification_template_on_ACP.md).

### Cause 6: a PrometheusRule is not evaluated by VictoriaMetrics

3.10 alert objects are `PrometheusRule`. A VictoriaMetrics cluster (for example 4.3.2) evaluates `VMRule`. Importing the old kind creates objects that `vmalert` never loads.

### Cause 7: APIServer restarts and etcd latency have no dedicated default rule

`cpaas-cluster-rules` covers broad control-plane, controller and scheduler symptoms, but does not ship a dedicated APIServer restart-count rule or an etcd WAL / proposal rule. The series are already collected: APIServer restarts, `etcd_disk_wal_fsync_duration_seconds_bucket`, `etcd_server_proposals_pending`, `etcd_server_proposals_failed_total`, and `grpc_server_handled_total{grpc_code!="OK"}`.

## Resolution

### Cause 1: the Grafana Secret still holds the old password

1. Find the Grafana Secret and the key that holds the admin password (the name varies with the chart release; on 3.16 it is `grafana-basic-auth`):

   ```bash
   kubectl -n cpaas-system get secret | grep -i grafana
   kubectl -n cpaas-system get secret <grafana-secret> -o yaml > /tmp/grafana-secret.yaml
   ```

2. Write the password that was set in the Grafana UI into that key and recreate the Grafana Pod, which does not reload the Secret by itself.

   > **Warning:** Replacing the password and restarting Grafana logs every operations-center session out of Grafana until the Pod is Ready, and writing the wrong key overwrites another credential in that Secret. Precondition: `/tmp/grafana-secret.yaml` is saved and you change only the password key. Rollback: `kubectl apply -f /tmp/grafana-secret.yaml` and restart Grafana again.

   ```bash
   B64=$(printf '%s' '<new-password>' | base64 -w0)
   kubectl -n cpaas-system patch secret <grafana-secret> --type=merge -p "{\"data\":{\"<password-key>\":\"${B64}\"}}"
   kubectl -n cpaas-system delete pod <grafana-pod>
   ```

   On 3.16 the same is done with `kubectl edit secret -n cpaas-system grafana-basic-auth` after the `admin` password was changed in the Grafana UI.

### Cause 2: platform versions from 3.18 do not ship Grafana

- On 4.0 and later, import the existing Grafana dashboard JSON under **Operations Center > Monitoring > Monitoring Dashboards**; it is converted into a native monitoring dashboard. JVM metrics are viewed the same way, with queries on the exposed metric names.
- On 3.18, make the application expose JVM metrics, scrape them with a ServiceMonitor (see [How to Add Metrics for Monitoring Collection](How_to_Add_Metrics_for_Monitoring_Collection.md)), install your own Grafana, and point it at `https://<platform-address>/clusters/<cluster-name>/prometheus-0` with basic auth. Do not look for a hidden Grafana Deployment.

Confirm that the process actually exposes the JVM metrics before debugging any dashboard.

### Cause 3: the 3.8.2 Grafana admin password is not admin/admin and cannot be changed

Leave the Grafana password unchanged on 3.8.2. Use the embedded Grafana under **Operations Center > Monitoring > Grafana**, or read data through the Prometheus `query_range` API with the `monitor@cpaas.io` credentials from Secret `kube-prometheus-prometheus-basic-auth`:

```bash
kubectl get secret -n cpaas-system kube-prometheus-prometheus-basic-auth -o jsonpath='{.data.password}' | base64 -d; echo
```

The full `curl` and the Windows `curl.exe` note are in Cause 1 of the related article above.

### Cause 4: metrics ports answer without authentication on 3.14

Upgrade to 3.18.0 or later; that is the fix for the Prometheus metrics ports and for kube-ovn. Do not add `--enable-metrics=false` to a kube-ovn build that does not already have the flag.

If a port must be closed before the upgrade:

> **Warning:** A host firewall drop on the Prometheus metrics port stops all scraping through it and the operations-center charts that read it; the rest of the platform keeps running. This is not authentication. Precondition: a monitoring blackout until the upgrade is accepted, and the current firewall rules are saved. Rollback: restore the saved rules.

For `devops-api` on NodePort `30699`:

> **Warning:** Changing `devops-api` to ClusterIP closes port `30699` on every node, including for any legitimate external scraper. Precondition: the Service name and namespace are confirmed. Rollback: set `spec.type` back to `NodePort` with `nodePort: 30699`.

```bash
kubectl get svc -A | grep devops-api
kubectl -n <namespace> patch svc devops-api --type=merge -p '{"spec":{"type":"ClusterIP"}}'
```

### Cause 5: the webhook body is not the JSON the receiver requires

Enable webhook template rendering and replace the Markdown sample with a JSON body that the receiver's API documents. A DingTalk body that returned HTTP 200 and `errcode: 0`:

```json
{"msgtype":"text","text":{"content":"alert fired"}}
```

Read what `apollo` rendered; if it is not JSON, the template is still wrong:

```bash
kubectl -n cpaas-system logs deploy/apollo --tail=200 | grep -Ei 'webhook|InvalidJson|msgtype'
```

### Cause 6: a PrometheusRule is not evaluated by VictoriaMetrics

1. Confirm the API group on the destination cluster and read the labels of a healthy existing `VMRule`, so the new objects carry the label `vmalert` selects:

   ```bash
   kubectl api-resources | grep -i vmrule
   kubectl get vmrule -A --show-labels | head
   ```

2. Convert each exported rule to a `VMRule`:

   ```yaml
   apiVersion: operator.victoriametrics.com/v1beta1
   kind: VMRule
   metadata:
     name: <rule-name>
     namespace: <namespace>
     labels:
       victoriametrics: "true"   # use the label key and value of an existing healthy VMRule
   spec:
     groups:
       - name: <group>
         rules:
           - alert: <alertname>
             expr: <expression>
             for: 5m
   ```

   > **Warning:** A `VMRule` with an expression that is true on empty or wrong labels pages at once. Precondition: run each expression in vmui and compare the firing set with the old cluster. Rollback: `kubectl delete vmrule <rule-name> -n <namespace>`.

### Cause 7: APIServer restarts and etcd latency have no dedicated default rule

Create a custom alert rule from the expression you need, with your own threshold, for example:

```promql
increase(etcd_server_proposals_failed_total[5m]) > 0
```

Do not expect `cpaas-cluster-rules` to gain these rules by itself.

## Diagnostic Steps

1. HTTP 500 on Grafana only from the operations center, right after a password change in the Grafana UI: Cause 1. Compare the decoded Secret password with the one that logs in.

2. Record the platform version. 3.18 or later with no Grafana Deployment is Cause 2; 3.8.2 with `admin/admin` rejected is Cause 3; an unauthenticated-metrics finding below 3.18.0 is Cause 4, and a `NodePort` type on `devops-api` is its NodePort variant:

   ```bash
   kubectl get svc -A | grep -E 'devops-api|kube-ovn'
   ```

3. A vendor error code from the webhook receiver (`msgtype is null`, `InvalidJson`): Cause 5.

4. Show which rule kind the cluster evaluates; `PrometheusRule` objects on a VictoriaMetrics cluster with no matching `VMRule` are Cause 6:

   ```bash
   kubectl get prometheusrule,vmrule -A
   ```

5. No alert for APIServer restarts or etcd latency in `cpaas-cluster-rules`: Cause 7. Confirm the series exist in vmui first, for example `etcd_server_proposals_pending`.
