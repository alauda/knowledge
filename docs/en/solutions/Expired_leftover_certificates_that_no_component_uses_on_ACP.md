---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Expired leftover certificates that no component uses on ACP

## Issue

A certificate expiry alert or an inspection keeps naming a certificate that never renews, while nothing on the platform seems broken. Typical reports:

- `sentry.tls` in `cpaas-system` is expired, and the UI shows it as expired even though the Sentry certificates were renewed. After an upgrade to ACP 4.0.11 the global cluster and a business cluster alert that `sentry.tls` has expired, and the only matching Secret is `sentry.tls-<suffix>`, which holds a private key and no certificate.
- A Tekton certificate Secret such as `webhook-server-cert` is reported as not renewed.
- Istio certificates still alert after ASM v1 was uninstalled, or after the Istio feature was removed from a cluster.
- Old service names such as `compliance-manage-tls` show as expired.
- `asm-istio-cacerts-<cluster>` still alerts for a cluster that was already deleted.
- A certificate on the global cluster is about to expire and no component of the installed version uses it.

The usual question is "what is the impact, and how do I make the alert stop?"

## Root Cause

Certificate monitoring reports every `kubernetes.io/tls` Secret and every cert-manager `Certificate` it finds. When a feature is uninstalled, a cluster is removed, or a newer version stops using a certificate, the objects can stay behind. Nothing renews them, so they eventually expire and alert, but their expiry has no effect on the platform. The fix is to confirm that nothing uses them and remove them instead of renewing them.

### Cause 1: Istio Secrets left after ASM v1 or the Istio feature was removed, or alerts on historical services

After ASM v1 was uninstalled, or the Istio feature was taken off a cluster and workloads no longer use Istio, the Istio certificate Secrets remain. Nothing in the mesh uses them, and removing them stops the alerts. If Mesh v1 is still installed, its Istio certificates are not leftovers.

Expired names that belong to historical services rather than live platform certificates, such as `compliance-manage-tls`, `asm-controller-web`, `katanomi-artifacts-webhook-servie`, and `compliance-manager-tls`, do not need to be reissued.

### Cause 2: sentry.tls is expired on ACP 4.x and no component uses it

`cpaas-system/sentry.tls` is the self-signed webhook certificate of the 3.x Sentry. From 4.x onward it is not used by any component, which is confirmed on 4.0.5, 4.0.11, and 4.2. Its expiry therefore only produces alerts. The live Sentry certificates are different objects, `sentry-ca-secret` and `sentry-serving-cert` in `cpaas-system`, and they renew normally.

On 4.0.11 the alert can appear right after the upgrade, with only a Secret named `sentry.tls-<suffix>` present. That Secret holds a private key and no certificate: it is the temporary private-key Secret cert-manager keeps for a Certificate it is still trying to issue, and it belongs to the `sentry.tls` Certificate. Deleting the Certificate removes it.

Restarting `apollo` does not change the UI. Backing up and deleting the `sentry.tls` Certificate and Secret clears the alert, and they are not recreated.

On a cluster where Sentry still runs and uses `sentry.tls`, the certificate renews automatically, and restarting the Sentry Pod in `cpaas-system` triggers the renewal if it does not.

### Cause 3: Tekton webhook-server-cert is not used by any Tekton Pod and no operator recreates it

The alert names a Tekton webhook certificate Secret, `webhook-server-cert` (also seen as `webhook-cert`). No Pod in `tekton-operator` or `tekton-pipelines` references it. Because it is no longer used, no operator manages it, so nothing renews it, and it is not recreated after deletion. Removing it clears the alert.

### Cause 4: a Certificate object that the installed ACP version no longer uses

A `Certificate` on the global cluster is about to expire, and the installed version (for example ACP 4.0.10) does not use it, so its expiry has no effect on the platform. Deleting the `Certificate` resource resolves the alert.

### Cause 5: asm-istio-cacerts-<cluster> remains for a cluster that was deleted

The global cluster alerts on `asm-istio-cacerts-<cluster>` in `cpaas-system` although that cluster was removed from the platform. For a live cluster this certificate is the Istio intermediate CA, renewed by cert-manager about 15 days before expiry, and the alert can be ignored. For a deleted cluster it is a leftover, and the Secret of the same name can be deleted.

## Resolution

### Cause 1: Istio Secrets left after ASM v1 or the Istio feature was removed, or alerts on historical services

1. For historical service names such as `compliance-manage-tls`, confirm that the Service no longer exists and close the alert on that basis. Nothing needs to be reissued.

2. For Istio Secrets left after ASM v1 or Istio was removed, list them and check that no Pod references them:

   ```bash
   kubectl get secret -A | grep -i istio
   kubectl get pods -A -o json | grep -F '<secret-name>' || echo "no Pod references it"
   ```

3. Back up and delete each leftover Secret.

   > **Warning:** Deleting a Secret that a mesh workload still mounts breaks that workload's TLS. Do this only when ASM v1 (or the Istio feature) is uninstalled and step 2 shows no Pod references this Secret. Rollback is `kubectl apply -f` of the backup; without it the certificate bytes are gone.

   ```bash
   umask 077
   kubectl get secret -n <namespace> <secret-name> -o yaml > "$HOME/<secret-name>.yaml"
   kubectl delete secret -n <namespace> <secret-name>
   ```

### Cause 2: sentry.tls is expired on ACP 4.x and no component uses it

1. Confirm that the live Sentry certificates are valid, so you do not delete the wrong object, and find the `sentry.tls` objects:

   ```bash
   kubectl get secret -n cpaas-system sentry-ca-secret -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   kubectl get secret -n cpaas-system sentry-serving-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   kubectl get certificate,secret -A | grep -F 'sentry.tls'
   ```

2. Back up and delete the `sentry.tls` Certificate and Secret.

   > **Warning:** Deleting the `sentry.tls` Certificate and Secret is permanent; they are not recreated. Do this only on ACP 4.x, only when the `sentry-ca-secret` and `sentry-serving-cert` dates above are valid, and only for the objects named exactly `sentry.tls` (and its `sentry.tls-<suffix>` key Secret). Rollback is `kubectl apply -f` of the backups, which also brings the alert back.

   ```bash
   umask 077
   kubectl get certificate -n cpaas-system sentry.tls -o yaml > "$HOME/sentry.tls.certificate.yaml"
   kubectl get secret -n cpaas-system sentry.tls -o yaml > "$HOME/sentry.tls.secret.yaml" 2>/dev/null
   kubectl get secret -n cpaas-system | grep -F 'sentry.tls'
   kubectl get secret -n cpaas-system <sentry.tls-suffix-secret> -o yaml > "$HOME/sentry.tls-key.secret.yaml" 2>/dev/null
   kubectl delete certificate -n cpaas-system sentry.tls
   kubectl delete secret -n cpaas-system sentry.tls --ignore-not-found=true
   kubectl get secret -n cpaas-system | grep -F 'sentry.tls'
   ```

   Deleting the Certificate also removes the `sentry.tls-<suffix>` Secret; the last command should print nothing. Wait for the alert to clear.

3. Only on a cluster where Sentry still runs and uses `sentry.tls`, print its dates and, if it has not renewed, restart the Sentry Pod:

   ```bash
   kubectl -n cpaas-system get secret sentry.tls -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject -dates
   kubectl -n cpaas-system get pods | grep sentry
   ```

   > **Warning:** Deleting the Sentry Pod pauses the Sentry webhook until the new Pod is Running. Do this only when `sentry.tls` is still in use on that cluster and its `notAfter` is within days and has not moved. The workload recreates the Pod.

   ```bash
   kubectl -n cpaas-system delete pod <sentry-pod>
   ```

### Cause 3: Tekton webhook-server-cert is not used by any Tekton Pod and no operator recreates it

1. Find the Secret the alert names and confirm that no Pod in the Tekton namespaces references it. If the alert names a different Secret, search for that name instead.

   ```bash
   kubectl get secret -A | grep -E 'webhook-server-cert|webhook-cert'
   kubectl get pods -n tekton-operator -o yaml | grep webhook-server-cert || echo "not referenced in tekton-operator"
   kubectl get pods -n tekton-pipelines -o yaml | grep webhook-server-cert || echo "not referenced in tekton-pipelines"
   ```

2. Back up and delete it.

   > **Warning:** The delete is permanent because no operator recreates this Secret. Do this only when step 1 shows no Pod in `tekton-operator` or `tekton-pipelines` references it. Rollback is `kubectl apply -f` of the backup.

   ```bash
   umask 077
   kubectl get secret -n <namespace> webhook-server-cert -o yaml > "$HOME/webhook-server-cert.yaml"
   kubectl delete secret -n <namespace> webhook-server-cert
   ```

   The alert clears after the next refresh.

### Cause 4: a Certificate object that the installed ACP version no longer uses

1. Confirm that nothing uses the certificate with step 1 of the Diagnostic Steps: no Pod references its Secret, and no operator owns it.

2. Back up and delete the `Certificate`.

   > **Warning:** Deleting the `Certificate` stops cert-manager from managing its Secret; the alert for it ends, and any component that did depend on it would lose renewal. Do this only when the installed version does not use the certificate and step 1 found no Pod and no owner. Rollback is `kubectl apply -f` of the backup.

   ```bash
   umask 077
   kubectl get certificate -n <namespace> <certificate-name> -o yaml > "$HOME/<certificate-name>.certificate.yaml"
   kubectl delete certificate -n <namespace> <certificate-name>
   ```

### Cause 5: asm-istio-cacerts-<cluster> remains for a cluster that was deleted

1. Confirm that the cluster is gone and find the objects:

   ```bash
   kubectl get cls | grep <cluster>
   kubectl get secret -n cpaas-system | grep asm-istio-cacerts-<cluster>
   kubectl get certificate -n cpaas-system | grep asm-istio-cacerts-<cluster>
   ```

2. Back up and delete the Secret.

   > **Warning:** Deleting `asm-istio-cacerts-<cluster>` removes the Istio intermediate CA issued for that cluster; a cluster that still exists and runs the mesh would lose its CA. Do this only when `kubectl get cls` shows the cluster no longer exists. Rollback is `kubectl apply -f` of the backup.

   ```bash
   umask 077
   kubectl get secret -n cpaas-system asm-istio-cacerts-<cluster> -o yaml > "$HOME/asm-istio-cacerts-<cluster>.yaml"
   kubectl delete secret -n cpaas-system asm-istio-cacerts-<cluster>
   ```

   If step 1 still lists a `Certificate` of that name, cert-manager can write the Secret again after the delete; this procedure covers the Secret only.

## Diagnostic Steps

1. For the alerting name, decide whether anything uses it: check owners, Pod references, and an owning `Certificate`.

   ```bash
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.metadata.ownerReferences}{"\n"}{.metadata.annotations}{"\n"}'
   kubectl get pods -A -o json | grep -F '<secret-name>' || echo "no Pod references it"
   kubectl get certificate -A | grep -F '<secret-name>'
   ```

   No owner, no Pod reference, and a feature or cluster that no longer exists indicate a leftover.

2. Branch:

   - Istio Secret after ASM v1 or Istio removal, or a historical service name: Cause 1.
   - `sentry.tls` on 4.x while `sentry-serving-cert` is valid, or only a `sentry.tls-<suffix>` key Secret exists: Cause 2.
   - Tekton `webhook-server-cert` that no Pod in `tekton-operator` or `tekton-pipelines` references: Cause 3.
   - A Certificate the installed version does not use, with no Pod or owner: Cause 4.
   - `asm-istio-cacerts-<cluster>` for a cluster that `kubectl get cls` no longer lists: Cause 5.
   - A Pod mounts it, or an operator or `Certificate` owns it: not a leftover. See "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP" or "Expired platform component certificate Secret such as hco-webhook-service-cert not reissued on ACP".
