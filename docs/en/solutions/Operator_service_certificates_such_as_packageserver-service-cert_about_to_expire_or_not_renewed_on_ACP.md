---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.14.x
  - 3.18.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Operator service certificates such as packageserver-service-cert about to expire or not renewed on ACP

## Issue

An alert or a platform inspection says an operator service certificate is about to expire, or has expired, and the question is whether it renews by itself. Typical alert text from policy `cpaas-certificates-rule`:

- `packageserver-service-cert即将过期，过期时间低于30.00d天` (packageserver-service-cert is about to expire, less than 30.00 days)
- `位于 <cluster> / harbor-operator 的证书 ( harbor-operator-controller-manager-service-cert ) 即将过期，过期时间低于30.00d天` (the certificate in <cluster> / harbor-operator is about to expire)
- "platform component certificate expiring soon (less than 10 days) <= 10d"

Typical names are `packageserver-service-cert` (namespace `cpaas-system`), `katanomi-operator-service-cert`, `redis-operator-service-cert`, `rds-operator-controller-manager-service-cert` (namespace `operators`), `harbor-operator-controller-manager-service-cert` (namespace `operators` or `harbor-operator`), `jaeger-operator-service-cert` (namespace `istio-system`), `metallb-operator-webhook-server-service-cert` (namespace `metallb-system`), and `opentelemetry-operator-controller-manager-service-cert`.

Related reports: the cert-manager `Certificate` for `packageserver-service-cert` passed its `renewalTime` and nothing renewed; the platform certificate list shows Certificate `packageserver-service-cert` with Ready `False`; or the Secret was deleted, came back with a new two-year date, and the inspection or certificate page still flags it.

## Root Cause

### Cause 1: an operator service certificate renews about one day before expiry, so the 30-day and 10-day alerts fire first

Operator Lifecycle Manager (OLM) generates and rotates the certificates of the webhooks and API services that an operator's ClusterServiceVersion (CSV) defines. These service certificates are owned by `olm-operator` (or, for the katanomi certificates, by `katanomi-operator`), not by cert-manager. cert-manager only monitors their expiry. A 30-day `renewBefore` shown on a `Certificate` object applies only to certificates that cert-manager issues.

The owning operator normally rotates each certificate about one day before it expires, so the 30-day and 10-day alerts fire long before anything rotates. When the alert is inside that window, no action is required. To renew earlier, back up and delete the Secret: the operator writes a new certificate, valid for about two years. Silencing the alert is the other option.

The certificate status page and the inspection keep showing the old date until `courier` on the global cluster refreshes, about every 4 hours, or until `courier` is restarted.

### Cause 2: packageserver-service-cert is rotated by OLM at CSV status.certsRotateAt, not at the Certificate renewalTime

`packageserver-service-cert` is an OLM self-signed certificate. OLM issues it and writes the Secret directly, so the cert-manager `Certificate` of the same name can show a `renewalTime` 30 days before expiry while OLM has not rotated the certificate the alert counts. The Certificate can also show condition `Issuing` `True` with reason `SecretMismatch` and message `Existing private key is not up to date for spec: [spec.privateKey.algorithm]`, while `Ready` is `True`. Nothing rotates at that `renewalTime`.

The time OLM rotates it is `status.certsRotateAt` on the CSV `packageserver` in `cpaas-system`, about one day before the Secret's `notAfter`. Moving `certsRotateAt` to an earlier time makes OLM rotate immediately, and the certificate then shows Normal with a new two-year expiry. If this certificate does expire, the operator components fail and the OperatorHub page cannot be displayed.

### Cause 3: Certificate packageserver-service-cert shows Ready False while tls.crt in the Secret is valid

The certificate packageserver actually uses is `tls.crt` in Secret `cpaas-system/packageserver-service-cert`, which OLM writes and renews when it is due. A `Ready=False` status on the `Certificate` object has no functional impact on packageserver while the certificate in the Secret is valid. No action is needed.

## Resolution

### Cause 1: an operator service certificate renews about one day before expiry, so the 30-day and 10-day alerts fire first

1. On the cluster the alert names (often a business cluster, not global), find the Secret and print its dates, and read the CSV rotation times:

   ```bash
   kubectl get secrets -A | grep -E 'packageserver-service-cert|katanomi-operator-service-cert|redis-operator-service-cert|rds-operator-controller-manager-service-cert|harbor-operator-controller-manager-service-cert|jaeger-operator-service-cert|metallb-operator-webhook-server-service-cert'
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   kubectl get csv -A -o yaml | grep -n certsRotateAt
   ```

   If `notAfter` is more than a day ahead and an early renewal is not required, wait for the operator to rotate it.

2. To renew now, or when the certificate has already expired, back up and delete the Secret.

   > **Warning:** Deleting the Secret removes the certificate the operator webhook or API service is serving until `olm-operator` writes a new one; API calls that hit that webhook fail in the gap. Do this only for the operator service certificate names above, after `openssl` confirmed the dates, and only with a YAML backup. Rollback is `kubectl apply -f` of the backup, which restores the old certificate; apply it also if the Secret is not recreated.

   ```bash
   umask 077
   kubectl get secret -n <namespace> <secret-name> -o yaml > "$HOME/<secret-name>.yaml"
   kubectl delete secret -n <namespace> <secret-name>
   kubectl get secret -n <namespace> <secret-name>
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

   The new `notAfter` should be about two years ahead. If the Secret does not come back, restore the backup and see "Platform component certificate not renewed: stale private key, issuerRef group, or alert name that differs from the Secret on ACP" (for example `rds-operator-controller-manager-service-cert` with `issuerRef.group: ait.alauda.io`).

3. If the certificate page or a re-run inspection still shows the previous date, wait about 4 hours, or restart the `courier` and `courier-api` Pods in `cpaas-system` on the global cluster and run the inspection again.

   > **Warning:** Restarting the global `courier` Pods interrupts alert delivery and console certificate status until they are Running again. Do this only after the new Secret's `notAfter` is in the future. The workload recreates the Pods.

   ```bash
   kubectl get pods -n cpaas-system | grep courier
   kubectl delete pod -n cpaas-system <courier-pod> <courier-api-pod>
   ```

4. The alert can also be silenced: **Platform Management > Operations Center > Alerts > Alert Policies**, policy `cpaas-certificates-rule` on the cluster, action **Set Silence**.

### Cause 2: packageserver-service-cert is rotated by OLM at CSV status.certsRotateAt, not at the Certificate renewalTime

1. Read both schedules and the Secret dates:

   ```bash
   kubectl -n cpaas-system get csv packageserver -o jsonpath='{.status.certsRotateAt}{"\n"}'
   kubectl get certificate -n cpaas-system packageserver-service-cert -o yaml | grep -E 'renewBefore|renewalTime|notAfter|reason|message'
   kubectl get secret -n cpaas-system packageserver-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   ```

   `certsRotateAt` about one day before `notAfter` is the normal OLM schedule.

2. To rotate earlier, either back up and delete the Secret (Cause 1, step 2), or move `certsRotateAt` so that OLM rotates now.

   > **Warning:** Patching `status.certsRotateAt` makes OLM rotate `packageserver-service-cert` at the new time; the packageserver API service serves the new certificate from then on, and requests in flight during the rotation can fail. Do this only when the CSV shows `certsRotateAt` about one day before `notAfter` and the Secret has not been rotated. Save the CSV first. Once OLM has rotated the certificate there is nothing to roll back. `--subresource=status` needs kubectl 1.24 or later. Use a full RFC 3339 time, already past or a few minutes ahead.

   ```bash
   kubectl -n cpaas-system get csv packageserver -o yaml > "$HOME/csv-packageserver.yaml"
   kubectl patch csv -n cpaas-system packageserver \
     --type merge \
     --subresource=status \
     --patch '{"status":{"certsRotateAt":"<YYYY-MM-DDTHH:MM:SSZ>"}}'
   kubectl get secret -n cpaas-system packageserver-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   ```

   The new `notAfter` should be about two years ahead. Restart `courier` as in Cause 1 if the page keeps the old date.

### Cause 3: Certificate packageserver-service-cert shows Ready False while tls.crt in the Secret is valid

1. Read the certificate from the Secret, not from the Certificate status:

   ```bash
   kubectl get secret -n cpaas-system packageserver-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   kubectl get certificate -n cpaas-system packageserver-service-cert
   ```

2. When `notAfter` is in the future, packageserver is unaffected and no action is needed; OLM renews the Secret when it is due. Only when `notAfter` is close or past and the Secret has not been renewed, use step 2 of Cause 1.

## Diagnostic Steps

1. Read the alert's cluster, namespace, and certificate name, switch to that cluster, and print the dates:

   ```bash
   kubectl get secret -A | grep <certificate-name>
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   kubectl get certificate -A | grep <certificate-name>
   ```

2. Branch:

   - An operator service certificate from the list above near expiry: Cause 1.
   - `packageserver-service-cert` whose Certificate shows `SecretMismatch` with `[spec.privateKey.algorithm]` and passed `renewalTime` without rotating: read CSV `certsRotateAt`, then Cause 2.
   - Certificate `packageserver-service-cert` Ready `False` while the Secret's `notAfter` is in the future: Cause 3, no action.
   - Secret recreated with a new date, and the page or inspection still flags it: step 3 of Cause 1.
   - Secret not recreated after the delete, or not found on the cluster you searched: "Platform component certificate not renewed: stale private key, issuerRef group, or alert name that differs from the Secret on ACP".
   - A `*-serving-cert` with about 30 days left: "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP".
