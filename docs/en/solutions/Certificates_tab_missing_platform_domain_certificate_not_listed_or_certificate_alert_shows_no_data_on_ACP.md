---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.x
  - 4.2.x
---

# Certificates tab missing, platform domain certificate not listed, or certificate alert shows no data on ACP

## Issue

One of the following happens while looking for certificate status in the ACP console:

- After installing or upgrading the platform, the Administrator view has no standalone **Certificates** tab, although an older installation had one.
- The platform domain (the platform access address) and its certificate cannot be found on the Certificate Management page.
- The detail of a certificate expiry alert does not refresh and shows no data, for example for the rule `平台组件证书的到期时间即将到期(小于 30 天) <= 30d 且持续 1 分钟` (platform component certificate expires in less than 30 days, lasting 1 minute).
- The alert notification arrives with unrendered template text, for example `位于 global / 的证书 ( {{ $labels.name }} ) 即将过期，过期时间{{ .externalLabels.comparison }}{{ .externalLabels.threshold }}天` (the certificate in global / ( ... ) is about to expire).

These are questions about where certificate status is displayed and how certificate alerts render, not about whether the certificate itself renews. Whether a cert-manager serving certificate renews by itself is covered in "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP".

## Root Cause

### Cause 1: ACP 4.2 removed the legacy certificate management page

In ACP 4.2 the legacy certificate management feature, including the standalone Certificates tab, was removed. Certificate monitoring is now shown per cluster: **Clusters > Clusters**, select the cluster, open the **Monitoring** tab, then the **Certificate Status** sub-tab. The page shows a Kubernetes certificate statistic and a platform certificate statistic, each with counts for Normal, Expires soon, Expired, and Failed, and lists the Kubernetes certificates (for example `/etc/kubernetes/admin.conf`) with node, expiry time, and status.

Certificate monitoring is provided by the **Cluster Enhancer** cluster plugin, installed from **Marketplace > Cluster Plugins** in the Administrator view. It monitors:

- Kubernetes component certificates, including control plane, kubelet, and kubeconfig client certificates.
- Secrets of type `kubernetes.io/tls`.
- The serving certificates kube-apiserver actually uses, checked through the `kubernetes` Endpoints.

Status is exposed through the metrics `certificate_expires_status` and `certificate_expires_time`. If Cluster Enhancer is not installed on a cluster, its Certificate Status sub-tab has no data.

### Cause 2: the platform domain certificate is managed separately and is not in Certificate Management

The platform domain certificate is not maintained in Certificate Management, so it is not listed there. It is configured in `spec.http.tls` of the `prdb` resource `base` on the global cluster. Where that field only holds `secretRef.name: dex.tls`, the certificate is in Secret `cpaas-system/dex.tls`.

### Cause 3: on ACP 4.1 the certificate alert detail shows no data because cpaas-certificates-rule queries time out

On ACP 4.1 the alert policy `cpaas-certificates-rule` also collects the expiry times of business certificates, which it should not do. The resulting query load makes the queries time out, so the alert detail does not refresh and shows no data. This is a known issue of 4.1. The alert itself can still be valid, so check the certificate directly.

### Cause 4: the notification shows raw {{ $labels.name }} placeholders because a custom notification template lacks the variables

The alert from `cpaas-certificates-rule` is real, but it is delivered through a custom-developed webhook notification template that does not include the certificate alert variables. The template engine therefore leaves `{{ $labels.name }}`, `{{ .externalLabels.comparison }}`, and `{{ .externalLabels.threshold }}` unrendered. The fix belongs to whoever maintains that template.

## Resolution

### Cause 1: ACP 4.2 removed the legacy certificate management page

1. Open **Clusters > Clusters**, select the cluster, and open **Monitoring > Certificate Status**.
2. If the sub-tab has no data, check that the Cluster Enhancer plugin is installed on that cluster (**Marketplace > Cluster Plugins**) and that its Pods run:

   ```bash
   kubectl get pods -A | grep cluster-enhancer
   ```

3. The same data can be queried on the monitoring query page with the metrics:

   ```text
   certificate_expires_time
   certificate_expires_status
   ```

### Cause 2: the platform domain certificate is managed separately and is not in Certificate Management

Read the certificate from where it is configured, on the global cluster:

```bash
kubectl get prdb base -o jsonpath='{.spec.http.tls}{"\n"}'
kubectl get prdb base -o jsonpath='{.spec.http.tls.cert}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -dates
kubectl get secret -n cpaas-system dex.tls -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject -dates
```

To renew it, follow "Replace the platform access certificate in dex.tls on ACP". On ACP 3.12, where the certificate is held inline in `prdb`, follow "Replace the platform access HTTPS certificate in prdb with a PEM certificate and key on ACP 3.12".

### Cause 3: on ACP 4.1 the certificate alert detail shows no data because cpaas-certificates-rule queries time out

1. Read the certificate name from the alert (or from the legend at the bottom of the alert monitoring panel, which lists `name` and `secret_namespace` for each series).
2. Check the certificate itself instead of the alert detail:

   ```bash
   kubectl get certificate -A | grep <certificate-name>
   kubectl get certificate -n <namespace> <certificate-name> -o yaml | grep -E 'renewBefore|renewalTime|notAfter'
   ```

3. If `renewalTime` is in the future and the Certificate is Ready, the certificate renews automatically and the alert can be ignored. Otherwise handle the certificate with the article that matches its name (see "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP").

### Cause 4: the notification shows raw {{ $labels.name }} placeholders because a custom notification template lacks the variables

1. Confirm that the rule returns data: paste its expression into the monitoring query page.

   ```text
   (0< max by(secret_namespace,name) (certificate_expires_time{secret_namespace!=""}) - time()) / (60*60*24)<=30
   ```

2. If the query returns the certificate, the alert is real and the problem is the notification. Open the notification policy that the alert uses and check its template.
3. A custom-developed template has to be extended by its owner with the certificate alert variables (`$labels.name`, `externalLabels.comparison`, `externalLabels.threshold`). Until then, read the certificate name from the query result.

## Diagnostic Steps

1. Identify the platform version and whether the question is about the page or about the alert:

   ```bash
   kubectl get prdb
   kubectl get pods -A | grep -E 'cluster-enhancer|courier'
   ```

   The `prdb` output shows the platform version. Running `cluster-enhancer` Pods mean certificate monitoring is installed on that cluster.

2. Branch:

   - No Certificates tab on 4.2 or later: Cause 1.
   - Platform domain certificate not on Certificate Management: Cause 2.
   - Alert detail empty or not refreshing on 4.1: Cause 3.
   - Notification text shows `{{ $labels.name }}`: Cause 4.
