---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# Certificate alerts from a custom VMRule, ait.alauda.io webhook denials, or by-design short-lived certificates on ACP

## Issue

A certificate-related alert keeps firing although no platform certificate is actually expired. One of the following is seen:

- The alert `平台组件证书已到期 <= 0d 且持续 1 分钟` ("platform component certificates have expired <= 0d and persisted for 1 minute") stays active after a minor upgrade. `openssl` shows the platform certificates are valid, AlertRule `cpaas-certificates-rule` has already been deleted, and restarting the monitoring components does not stop the alert.
- kube-apiserver logs cert-manager webhook denials that reference `{cpaas-ca ClusterIssuer ait.alauda.io}`, or the custom alert "apiserver read request success rate < 0.9" fires on a workload cluster and most failed reads are `403`.
- A cluster with KubeVirt virtualization always has one certificate with one day of validity left, so the "about to expire" alert never clears.
- An external monitor such as Zabbix reports Pod `node-local-certs-exporter-<node>` in `cpaas-system` as not healthy (or failed after a scale-out), and `kubectl get pod -A` cannot find the Pod.

Certificate expiry metrics (`certificate_expires_time`) are produced by `cluster-enhancer-apiserver`; the certificate page and alert status are served through `courier` on the `global` cluster.

Related articles: *Certificate page empty or stale because of clock drift or a stale cluster-enhancer-apiserver metric on ACP* (the page is empty, or still shows a certificate that was renewed or removed). For a certificate that really is about to expire, see [Operator service certificates such as packageserver-service-cert about to expire or not renewed on ACP](Operator_service_certificates_such_as_packageserver-service-cert_about_to_expire_or_not_renewed_on_ACP.md). On ACP 4.1, an alert detail that shows no data because `cpaas-certificates-rule` queries time out is Cause 3 of [Certificates tab missing, platform domain certificate not listed, or certificate alert shows no data on ACP](Certificates_tab_missing_platform_domain_certificate_not_listed_or_certificate_alert_shows_no_data_on_ACP.md).

## Root Cause

### Cause 1: a custom VMRule still emits cpaas-certificates-rule after the AlertRule is gone

On a VictoriaMetrics cluster, `vmalert` evaluates the rules from `VMRule` objects, which are rendered into the rule-file ConfigMaps mounted into the `vmalert` Pod. When a custom `VMRule` (one that is not generated from the platform `AlertRule`) carries the `cpaas-certificates-rule` rules, deleting AlertRule `cpaas-certificates-rule` does not remove them: the rule-file ConfigMap still contains the rules, `vmalert` keeps producing the alert, and `courier-api` keeps logging it as coming from `vmalert`. Restarting `enhancer-api`, the monitoring controller, `vmalert`, `alertmanager`, or `courier-api` does not change this. Deleting the custom `VMRule` clears the alert.

The same symptom also appears when the AlertRule delete itself never took effect, for example because the cluster was broken and its monitoring plugin could not reconcile the change. In that case no `rpch` object exists for the change (`kubectl get rpch -A`). Either way, the fix is to remove the `VMRule` that still carries the rule.

### Cause 2: cert-manager webhook denials for {cpaas-ca ClusterIssuer ait.alauda.io} count as 403 read failures

Some platform certificates are deliberately not issued by cert-manager, but the platform still uses cert-manager's certificate expiry tracking for them. To do that, it registers a non-existent API group, `ait.alauda.io`, as the issuer group. Requests for that group are rejected by the cert-manager webhook, so kube-apiserver logs denials that reference `{cpaas-ca ClusterIssuer ait.alauda.io}`.

The rejections are `403` responses and count as failed reads. A custom success-rate alert such as:

```text
sum(irate(apiserver_request_total{code=~"20.*",verb=~"GET|LIST"}[2m]))/sum(irate(apiserver_request_total{verb=~"GET|LIST"}[2m]))<0.9
```

then oscillates around 0.9 on a workload cluster. On the affected versions this behavior is expected and cannot be avoided; when cert-manager runs normally and no certificate is actually expired, the log lines can be ignored.

### Cause 3: cdi-uploadserver-client-cert on a KubeVirt cluster is valid for one day by design

On a cluster with KubeVirt virtualization, `cdi-uploadserver-client-cert` has a one-day lifetime and is renewed daily. It is the client TLS certificate for VM image upload, used only for mutual TLS between `cdi-uploadproxy` (or the upload client) and `cdi-uploadserver` when an ISO or qemu image is uploaded into a DataVolume. That traffic is short-lived, so the short lifetime is intended. The certificate is active and not deprecated. The platform cannot silence the alert for one individual certificate, so the "about to expire" alert keeps firing for it.

### Cause 4: the node-local-certs-exporter Pod is short-lived and no longer exists

`node-local-certs-exporter-<node>` belongs to Cluster Enhancer and inspects node certificates. It runs one check, and once it has collected the certificate information it is cleaned up automatically. An external monitor that discovers Pods through kube-apiserver can catch it while it runs, or in a final failed state, and then keep alerting on a Pod that no longer exists. Its absence is normal. Why a single run ended in a failed state cannot be determined after the Pod has been cleaned up.

## Resolution

### Cause 1: a custom VMRule still emits cpaas-certificates-rule after the AlertRule is gone

1. Confirm that the platform certificates are not expired (see Diagnostic Steps) and that AlertRule `cpaas-certificates-rule` is gone:

   ```bash
   kubectl get alertrule -A | grep cpaas-certificates-rule
   ```

2. Find the object that still carries the rule. Name matches are not enough, because a custom `VMRule` can have any name; search the `vmalert` rule-file ConfigMaps and the `VMRule` contents:

   ```bash
   kubectl get vmrule -A
   for i in 0 1 2; do kubectl get cm -n cpaas-system vm-alert-rulefiles-$i -o yaml | grep -B5 -A10 "certificate_expires_time"; done
   kubectl get vmrule -A -o yaml | grep -B5 -A10 "certificate_expires_time"
   kubectl get rpch -A
   ```

3. Back up and delete that `VMRule`.

   > **Warning:** Deleting the custom `VMRule` stops every alert it generates, including alerts you may still want from it. Do this only when `openssl` shows the platform certificates are valid and this `VMRule` is still the source of `cpaas-certificates-rule` after the AlertRule is gone. Roll back with `kubectl apply -f` of the backup, which restores the same alerts.

   ```bash
   kubectl get vmrule -n <namespace> <vmrule-name> -o yaml > "$HOME/<vmrule-name>.yaml"
   kubectl delete vmrule -n <namespace> <vmrule-name>
   ```

4. Repeat step 2. The rule-file ConfigMaps should no longer contain the rule, and the alert should resolve.

### Cause 2: cert-manager webhook denials for {cpaas-ca ClusterIssuer ait.alauda.io} count as 403 read failures

1. Check that cert-manager is running and that no certificate is actually failing:

   ```bash
   kubectl get pods -A | grep cert-manager
   kubectl get certificate -A | grep -v True
   ```

   If cert-manager is healthy and the second command lists only the header, the log lines need no fix.

2. If a custom read-success-rate alert fires because of these 403s, edit that existing alert policy (do not create a second one) so that 4xx responses are excluded from the denominator:

   ```text
   sum(irate(apiserver_request_total{code=~"20.*",verb=~"GET|LIST"}[2m]))/sum(irate(apiserver_request_total{code!~"4..",verb=~"GET|LIST"}[2m]))<0.9
   ```

   This is a workaround: it also hides 4xx responses from other clients. For other sources of apiserver error-rate alerts, see [kube-apiserver latency alerts, noisy apiserver logs, and controller-manager or scheduler health alerts on ACP](kube-apiserver_latency_alerts_noisy_apiserver_logs_and_controller-manager_or_scheduler_health_alerts_on_ACP.md).

### Cause 3: cdi-uploadserver-client-cert on a KubeVirt cluster is valid for one day by design

1. Confirm the alerting certificate is `cdi-uploadserver-client-cert`:

   ```bash
   kubectl get secret -A | grep cdi-uploadserver-client-cert
   ```

2. Leave the certificate as it is and handle the alert on the policy side. Under **Operation and Maintenance Center** > **Alerts** > **Alert Policies**, find the certificate expiry policy and adjust it, for example by turning off the 30-day and 10-day pre-expiry rules and keeping the already-expired rule, or silence the policy. Changing the alert level of the built-in policy from the console may not be possible.

3. Alternatively, lengthen the certificate lifetime through the HyperConverged (HCO) object with a CDI JSON patch annotation that sets `/spec/certConfig/client`.

   > **Warning:** HCO passes the patch to CDI, which reissues the upload client certificate with the new lifetime (ten years below). Invalid JSON in the annotation can stop HCO from reconciling CDI. Do this only when the alerting certificate is `cdi-uploadserver-client-cert`. Save the HCO object first. Roll back by removing the annotation: `kubectl annotate hco -n kubevirt kubevirt-hyperconverged containerizeddataimporter.kubevirt.io/jsonpatch-`.

   ```bash
   kubectl get hco -n kubevirt kubevirt-hyperconverged -o yaml > "$HOME/kubevirt-hyperconverged.yaml"
   kubectl annotate hco -n kubevirt kubevirt-hyperconverged --overwrite \
     containerizeddataimporter.kubevirt.io/jsonpatch='[{"op": "add", "path": "/spec/certConfig/client", "value": {"duration": "87600h0m0s", "renewBefore": "720h0m0s"}}]'
   kubectl get secret -n kubevirt cdi-uploadserver-client-cert -o yaml | grep -E 'certConfig|certificate-not-after'
   ```

   The Secret should then carry the annotation `operator.cdi.kubevirt.io/certConfig` with `"lifetime":"87600h0m0s"`.

### Cause 4: the node-local-certs-exporter Pod is short-lived and no longer exists

1. Confirm the Pod is gone:

   ```bash
   kubectl get pod -A -o wide | grep certs
   ```

   If needed, use the kube-apiserver audit log to confirm the Pod was created and deleted as part of a normal run.

2. No repair is required. Tune the external monitor so that it does not alert on this short-lived Pod.

If the Pod exists and stays in `Error` with `cert-tool export` in its log, that is a different fault: see Cause 3 of [Node kubectl fails with You must be logged in to the server or an alert names root kube config on ACP](Node_kubectl_fails_with_You_must_be_logged_in_to_the_server_or_an_alert_names_root_kube_config_on_ACP.md).

## Diagnostic Steps

1. Print the real certificate the alert names, to tell whether the certificate or the alert is wrong:

   ```bash
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject
   ```

   A `notAfter` in the future means the certificate is valid and the alert source has to be found.

2. Check the components and rule objects that produce the alert:

   ```bash
   kubectl get po -A | grep -E 'cluster-enhancer|courier|vmalert'
   kubectl get vmrule -A | grep -i cert
   kubectl get alertrule -A | grep cpaas-certificates-rule
   ```

3. Match the signature:

   | What you see | Cause |
   | --- | --- |
   | AlertRule `cpaas-certificates-rule` absent, rule still in `vm-alert-rulefiles-*` or a `VMRule` | 1 |
   | kube-apiserver log mentions `ait.alauda.io`; failed reads are mostly `403` | 2 |
   | Alerting certificate is `cdi-uploadserver-client-cert` with one day left | 3 |
   | External monitor alerts on a `node-local-certs-exporter-<node>` Pod that does not exist | 4 |
   | Certificate page empty, or still shows a renewed or removed certificate | *Certificate page empty or stale because of clock drift or a stale cluster-enhancer-apiserver metric on ACP* |

   To see which response codes drive a read-failure alert, query in the monitoring UI:

   ```text
   sum by (code) (rate(apiserver_request_total{verb=~"GET|LIST",code!~"2.."}[5m]))
   ```

   A result dominated by `code="403"` together with `ait.alauda.io` in the kube-apiserver log matches Cause 2.
