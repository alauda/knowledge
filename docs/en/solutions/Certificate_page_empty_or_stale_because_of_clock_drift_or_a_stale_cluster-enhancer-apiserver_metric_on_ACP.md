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

# Certificate page empty or stale because of clock drift or a stale cluster-enhancer-apiserver metric on ACP

## Issue

The platform certificate page or a certificate expiry alert does not match the certificates that actually exist:

- The certificate management page is empty although certificate metrics exist, and the Prometheus UI of the `global` cluster warns `Detected <n> seconds time difference between your browser and the server`.
- "Platform component certificates have expired" stays active after the certificate was renewed or removed, while VictoriaMetrics counts 0 expired certificates, or the alert data loads very slowly.
- After an upgrade, every cluster reports `alive-admin` certificates (`certmanager.<node-ip>-etc-kubernetes-alive-admin.conf`) as expired, with a value of about `-739,800` days.
- A Secret was rebuilt with a new certificate, and the page still shows the old date or "expired".
- `平台Kubernetes证书已到期 <= 0d 且持续 1 分钟` ("platform Kubernetes certificate has expired <= 0d for 1 minute", rule group `cpaas-cluster-rules`) names `/etc/kubernetes/kubelet.conf` or `/etc/kubernetes/admin.conf` on nodes where no matching file seems to exist.

Certificate expiry metrics (`certificate_expires_time`) are exposed by `cluster-enhancer-apiserver` (Cluster Enhancer); node certificate files are read on the nodes; the page and alert status are served through `courier` on the `global` cluster, which refreshes its stored state about every 4 hours.

Related articles: *Certificate alerts from a custom VMRule, ait.alauda.io webhook denials, or by-design short-lived certificates on ACP* (a custom `VMRule`, `ait.alauda.io` webhook denials, a one-day `cdi-uploadserver-client-cert`, or a missing `node-local-certs-exporter` Pod). [Monitoring pages stay empty because courier-api or apollo holds a stale cluster cache on ACP](Monitoring_pages_stay_empty_because_courier-api_or_apollo_holds_a_stale_cluster_cache_on_ACP.md) (Cause 3) covers an alert that remains after the expired certificate object was deleted.

## Root Cause

### Cause 1: browser time and server time differ, so the certificate page shows no data

The certificate data exists, but the page renders nothing. Querying the metrics directly (for example `curl <zeus>:19890/metrics | grep cert` from the `cluster-console` terminal of the `global` cluster) returns `certmanager_certificate_expiration_timestamp_seconds` for files such as `/etc/kubernetes/admin.conf`, `/etc/kubernetes/pki/apiserver.crt`, and `/etc/kubernetes/pki/etcd/server.crt`, together with `platform_scrape_collector_success{collector="cert"} 1`. The Prometheus UI of the `global` cluster shows:

```text
Warning: Error fetching server time: Detected 305.3659999370575 seconds time difference between your browser and the server. Prometheus relies on accurate time and time drift might cause unexpected query results.
```

The clock of the machine running the browser and the node clock differ by several minutes (after time-zone conversion). Queries evaluated against the wrong time range return nothing, so the page is empty. Synchronizing node time makes the page fill again.

### Cause 2: cluster-enhancer-apiserver is hung or cannot parse a certificate, so the expiry metric is stale

The certificate is valid or already gone, and the "expired" alert does not clear because `cluster-enhancer-apiserver` keeps exporting a stale or invalid `certificate_expires_time`. Three forms are known; restarting `cluster-enhancer-apiserver` (together with `cluster-enhancer-controller` in the hung form) clears the alert in each:

- **Empty alive certificate after an upgrade.** The expression `(max by(secret_namespace,name) (certificate_expires_time{secret_namespace!=""}) - time()) / (60*60*24)<=0` returns series `certmanager.<node-ip>-etc-kubernetes-alive-admin.conf` in `secret_namespace="cpaas-system"` with `check_time`, `not_after`, and `not_before` all `0001-01-01T00:00:00Z` and the value `-62135596800` (the zero time). The `cluster-enhancer-apiserver` log has `failed to parse certificate from secret cpaas-system/certmanager.<node-ip>-etc-kubernetes-alive-admin.conf, error: PEM is empty` for each control-plane node, sometimes with watch errors ending in `net/http: TLS handshake timeout`, while its Pods are `1/1 Running`.
- **Zero expiry on a region cluster.** The alert detail of `cpaas-certificates-rule` lists `certmanager.<node>-etc-kubernetes-alive-admin.conf` entries at about `-739781 d` (the distance back to year 1, the same zero time), while other certificates such as `cluster-enhancer-apiserver-cert` are positive. `/etc/kubernetes/alive/admin.conf` on the alerting nodes has no `client-certificate-data`. Why that field was missing has not been determined.
- **Hung after certificates were removed.** Expired certificates were removed (for example `argocd-gitops-ca` and `argocd-gitops-tls` in `argocd`, by uninstalling the Argo CD GitOps plugin); VictoriaMetrics then counts 0 expired, but the alert stays and the alert data loads very slowly. `kubectl logs -f` of `cluster-enhancer-apiserver` stops at startup lines such as `Caches are synced for client-ca::kube-system::extension-apiserver-authentication::requestheader-client-ca-file` and prints nothing new.

If alert data loads slowly because `vmselect` is overloaded or `OOMKilled`, not because `cluster-enhancer-apiserver` is hung, the cause is query load, not this one.

### Cause 3: the certificate was reissued, or its file was deleted, and the page still shows the previous state

The status the page and alert show is refreshed about every 4 hours. After a Secret is deleted and recreated with a new certificate, the old date or "expired" remains until that refresh, or until `courier` on the `global` cluster is restarted. A variant after a renewal: the browser console reports `found duplicate series for the match group` with one `phase="Expired"` and one `phase="Normal"` series for the same certificate and `many-to-many matching not allowed`; a `courier` restart clears it.

Node-file alerts follow the same rule. When `/etc/kubernetes/kubelet.conf` shows a negative number of days (for example about `-158 d`), the node certificate really has expired. When `/etc/kubernetes/admin.conf` shows a large negative value (for example about `-745 d`) but the file has been deleted, the collector cannot read a new file and keeps reporting the last state. In both situations, reissue the certificates and then wait four hours or restart `courier`. Stale node-file rows after an upgrade (for example `/var/lib/kubelet/pki/kubelet.crt` or `/etc/kubernetes/super-admin.conf`) have also been cleared by restarting `cluster-enhancer-controller` and `cluster-enhancer-apiserver` instead, so if a `courier` restart does not help, apply the Cause 2 restart.

## Resolution

### Cause 1: browser time and server time differ, so the certificate page shows no data

1. From the `cluster-console` terminal of the `global` cluster, confirm the data exists and read the server time; compare it with the clock of the machine running the browser (convert the time zone first):

   ```bash
   curl -s <zeus>:19890/metrics | grep cert | head
   date
   ```

2. If the metrics are present and the clocks differ by minutes, compare node time with a reference clock and with the browser host, and fix time synchronization on whichever clock is wrong. On nodes that use chrony:

   ```bash
   date -u
   timedatectl status
   chronyc tracking 2>/dev/null || ntpq -p
   ```

   See [Configuring chrony NTP on Cluster Nodes](Configuring_chrony_NTP_on_Cluster_Nodes.md) for the node time source.

3. Correct the node clock.

   > **Warning:** Stepping the clock of a running node can disturb certificate validity checks, leases, and etcd on that node. Do this only when the offset is confirmed against a reference clock and the Prometheus UI shows the time-difference warning. Prefer letting chrony slew the clock; a large step belongs in a maintenance window, one control-plane node at a time. There is no rollback to the previous wrong time; if the new time source is wrong, point chrony back to the previous source.

   ```bash
   systemctl restart chronyd
   chronyc makestep
   ```

4. Reload the certificate page; it should list the certificates again.

### Cause 2: cluster-enhancer-apiserver is hung or cannot parse a certificate, so the expiry metric is stale

1. Confirm the certificate is valid or removed (see Diagnostic Steps), then check `cluster-enhancer-apiserver` on the cluster that raised the alert:

   ```bash
   kubectl get po -A | grep cluster-enhancer-apiserver
   kubectl logs -n <namespace> <cluster-enhancer-apiserver-pod> --since=1h | tail -50
   ```

   No log lines in the last hour (the log stops at startup lines such as `Caches are synced for client-ca::...`), or `failed to parse certificate from secret ... error: PEM is empty`, matches this cause. For a removed certificate, check that its Secret is really gone:

   ```bash
   kubectl get secret -n <namespace> | grep <cert-name>
   ```

2. Restart `cluster-enhancer-apiserver`.

   > **Warning:** Restarting `cluster-enhancer-apiserver` pauses certificate metric collection for that cluster until the new Pod is Running. Do this only when `openssl` or the certificate page already shows the alerting certificate as valid or removed, and the component is silent or logs `PEM is empty`. The Deployment recreates the Pod; there is nothing else to roll back.

   ```bash
   kubectl delete pod -n <namespace> <cluster-enhancer-apiserver-pod>
   kubectl get po -n <namespace> | grep cluster-enhancer-apiserver
   ```

3. When `cluster-enhancer-apiserver` was hung (no new log lines), restart both Cluster Enhancer Pods in `cpaas-system` on that cluster. The same Warning applies; the controller is also paused until its Pod is Running.

   ```bash
   kubectl get pod -n cpaas-system | grep enhancer | awk '{print $1}' | xargs kubectl delete pod -n cpaas-system
   kubectl get pod -n cpaas-system | grep enhancer
   ```

4. After one scrape interval, re-run the alert expression in the VictoriaMetrics UI. It should return no series for the fixed certificate.

### Cause 3: the certificate was reissued, or its file was deleted, and the page still shows the previous state

1. Print the real certificate:

   ```bash
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   ```

   For a node-file alert, print the file the alert names on that node:

   ```bash
   ls -l /etc/kubernetes/kubelet.conf /etc/kubernetes/admin.conf
   grep client-certificate-data /etc/kubernetes/kubelet.conf | awk '{print $2}' | base64 -d | openssl x509 -noout -dates
   ```

   If the kubeconfig has `client-certificate: <path>` instead of `client-certificate-data`, run `openssl x509 -noout -dates -in <path>` on that file.

   If the certificate in the file is expired, it is a real expiry; reissue it with the certificate renewal procedure for your ACP version before continuing. If the file no longer exists, the alert is the last stored state.

2. When the real certificate is new (or back in place), wait about 4 hours, or restart `courier` on the `global` cluster.

   > **Warning:** Deleting the `courier` Pod fails in-flight monitoring and inspection calls and pauses notification sending until the replacement is Ready. Do this only after the certificate is confirmed valid and only the displayed state is old. The controller recreates the Pod; there is nothing to roll back.

   ```bash
   kubectl -n cpaas-system get pods | grep courier
   kubectl -n cpaas-system delete pod <courier-pod>
   ```

3. If the stale row remains and the VictoriaMetrics UI still returns the old `certificate_expires_time` series, apply the Cause 2 restart.

## Diagnostic Steps

1. Print the real certificate the alert or page names, to tell whether the certificate or the display is wrong:

   ```bash
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject
   ```

2. Check the components that produce the status:

   ```bash
   kubectl get po -A | grep -E 'cluster-enhancer|courier|vm'
   ```

3. Query the series in the VictoriaMetrics UI:

   ```text
   (max by(secret_namespace,name) (certificate_expires_time{secret_namespace!=""}) - time()) / (60*60*24)<=0
   ```

4. Match the signature:

   | What you see | Cause |
   | --- | --- |
   | Page empty, metrics present, Prometheus warns `Detected <n> seconds time difference between your browser and the server` | 1 |
   | Series with `not_after="0001-01-01T00:00:00Z"` (about `-739,800 d`), or `PEM is empty` in the `cluster-enhancer-apiserver` log | 2 |
   | Certificate removed, VictoriaMetrics counts 0 expired, `cluster-enhancer-apiserver` log silent | 2 |
   | Secret rebuilt or node file deleted, no stale series in VictoriaMetrics, page shows the previous state | 3 |
   | Node file such as `kubelet.conf` contains a certificate that is really expired | 3 (real expiry: reissue first) |
