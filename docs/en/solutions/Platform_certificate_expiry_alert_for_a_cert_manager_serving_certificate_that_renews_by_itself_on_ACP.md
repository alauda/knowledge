---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.18.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
  - 4.4.x
---

# Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP

## Issue

The platform raises a certificate alert such as "platform component certificate expires in less than 30 days", "less than 10 days", or "platform component certificate has expired". In Chinese consoles the rule reads `平台组件证书的到期时间即将到期(小于30天) <= 30d 且持续 1 分钟` (platform component certificate expires in less than 30 days, lasting 1 minute). The summary names `<cluster>/<namespace>/<certificate>`, for example `global/cpaas-system/base-operator.tls`. Or an inspection report or the certificate status page lists a few platform certificates with about 30, 9, or 1 days left, and the question is whether they renew by themselves.

Typical names are `sentry-serving-cert`, `capi-serving-cert`, `compliance-manager-cert`, `katanomi-artifacts-serving-cert`, `global-asm-serving-cert`, `base-operator.tls`, `argocd-secret`, `asm-istio-cacerts-<cluster>`, `asm-istio-cacert-global`, and `cacerts-ca-cert.pem`.

## Root Cause

### Cause 1: a cert-manager serving certificate still has about 30 days left and will renew by itself

Platform serving certificates are issued and renewed by the platform cert-manager. The lifetime and the renewal point are set on each `Certificate` object (`spec.duration`, `spec.renewBefore`), and cert-manager renews the certificate at `status.renewalTime`, which lies ahead of `status.notAfter`. A healthy Certificate shows Ready `True` with the message `Certificate is up to date and has not expired`. A remaining validity of about 30 days on these certificates is therefore normal and needs no manual step: the 30-day alert fires at, or before, the point where cert-manager renews. When the renewal point passes, the certificate is re-signed and the alert recovers by itself.

The renewal point belongs to each object, so read it instead of assuming one number:

| Certificate | Renewal behavior |
|---|---|
| `*-serving-cert` in `cpaas-system` (`sentry-serving-cert`, `capi-serving-cert`, `katanomi-artifacts-serving-cert`, `global-asm-serving-cert`), `compliance-manager-cert`, `base-operator.tls` | Renewed by cert-manager at `renewalTime`; about 30 days left is the normal window |
| `asm-istio-cacerts-<cluster>` in `global/cpaas-system` (ACP 4.x Istio intermediate CA for a business cluster) | `duration: 1440h0m0s`, `renewBefore: 360h0m0s`: valid about 60 days and renewed about 15 days before expiry, so the 30-day alert fires about 15 days before renewal |
| `cacerts-ca-cert.pem` in `istio-system` (ACP 3.x Istio intermediate CA) | `duration: 1440h0m0s`, `renewBefore: 720h0m0s`, renewed by cert-manager on the business cluster |
| `metallb-operator` certificate | Renewed 24 hours before expiry |
| `argocd-secret` on global | Renewed by argocd-operator when it is about to expire; it can still be unrenewed with less than 29 days left |
| Operator service certificates (`packageserver-service-cert`, `*-operator-service-cert`) | Rotated by the owning operator about one day before expiry; see "Operator service certificates such as packageserver-service-cert about to expire or not renewed on ACP" |

Because the Istio intermediate CA is valid for only about two months, a recurring under-30-day report on `asm-istio-cacerts-<cluster>` is expected. The global cluster raises it under names that refer to a business cluster, because the intermediate CA for each business cluster is signed and rotated by cert-manager on global and distributed to that cluster by `global-asm-controller`. A `ca.crt` with a very long (for example 100-year) lifetime in the same Secret is the root CA, not the certificate the alert counts. Read `tls.crt`.

The following are not renewed automatically and need action when they approach expiry:

- `asm-controller-webhook-serving-cert` (the documentation lists it as not renewed automatically).
- `dex.tls` when the platform was deployed with a certificate supplied by its owner. See "Replace the platform access certificate in dex.tls on ACP".
- The one-year Harbor notary TLS certificate. See "Harbor notary-server fails with an expired x509 certificate on ACP".
- The node file `/root/.kube/config`, which the same alert can name. See "Node kubectl fails with You must be logged in to the server or an alert names root kube config on ACP".

A certificate that is not a platform object is renewed by the application owner. For example, a Secret such as `sentry-nginx-tls` in a `sentry-<suffix>` namespace belongs to a separately deployed Sentry instance, not to the platform's built-in Sentry component.

## Resolution

### Cause 1: a cert-manager serving certificate still has about 30 days left and will renew by itself

1. On the cluster the alert names, read the Certificate's readiness, renewal time, and Secret, then print the leaf certificate:

   ```bash
   kubectl get certificate -n <namespace> <certificate-name> \
     -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,RENEW:.status.renewalTime,SECRET:.spec.secretName'
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

2. If the Certificate is Ready `True`, `renewalTime` is in the future, and `notAfter` is still ahead, leave the Secret in place. After `renewalTime`, run the commands again and confirm that `notAfter` moved forward. The alert clears by itself. A recurring Istio CA alert that is explained by the table above can be silenced.

3. To renew now instead of at the automatic point, back up and delete the Secret so that cert-manager reissues it. For the Istio intermediate CA on a business cluster that uses the certificate management plugin, restart `istiod` after the delete.

   > **Warning:** Deleting a cert-manager-managed Secret leaves the component without its certificate until cert-manager writes the new one, and restarting `istiod` briefly interrupts certificate issuance to mesh sidecars. Do this only for the cert-manager-managed names in the table above, and only when an immediate renewal is needed or the certificate is already past `notAfter`. Do not delete `asm-istio-cacerts-<cluster>` for a cluster that still exists unless the renewal is really needed: it holds that cluster's Istio intermediate CA. Take the backup first. Rollback is `kubectl apply -f` of the backup, which puts the previous certificate back.

   ```bash
   umask 077
   kubectl get secret -n <namespace> <secret-name> -o yaml > "$HOME/<secret-name>.yaml"
   kubectl delete secret -n <namespace> <secret-name>
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   # Istio certificate on a business cluster only: restart istiod after the delete
   kubectl get deploy -n istio-system | grep istiod
   kubectl rollout restart deployment -n istio-system <istiod-deployment>
   ```

4. If the Secret is not regenerated after the delete, restart cert-manager on the cluster that holds the Secret.

   > **Warning:** Deleting the cert-manager Pods pauses issuance and renewal of every cert-manager certificate on that cluster until the new Pods are Running; certificates already issued keep working. Do this only after the Secret backup exists and the Secret was deleted in step 3 but was not regenerated. The Deployment recreates the Pods. If the Secret still does not come back, restore it with `kubectl apply -f` of the backup.

   ```bash
   kubectl get pods -A | grep cert-manager
   kubectl delete pod -n <cert-manager-namespace> <cert-manager-pod>
   kubectl get secret -n <namespace> <secret-name>
   ```

## Diagnostic Steps

1. Read the alert's cluster, namespace, and certificate name. When the alert does not name the certificate, scroll to the bottom of the alert monitoring detail panel; the legend lists each alerting series with `name` and `secret_namespace`. A series whose latest value is exactly `30.0 d` has just entered the alert window.

2. On that cluster, print the leaf and, for comparison, the CA in the same Secret:

   ```bash
   kubectl get certificate -A | grep <certificate-name>
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.ca\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

   The `tls.crt` dates are what the alert counts.

3. For `asm-istio-cacerts-<cluster>`, confirm that the cluster still exists:

   ```bash
   kubectl get cls | grep <cluster>
   ```

   A cluster that no longer exists leaves a leftover Secret. That case is covered in "Expired leftover certificates that no component uses on ACP".

4. Branch:

   - Ready `True`, future `renewalTime`, a name from the table: Cause 1, wait.
   - The Certificate condition reads `Existing private key is not up to date for spec: [spec.keyAlgorithm]`, or the alert name matches no Secret: "Platform component certificate not renewed: stale private key, issuerRef group, or alert name that differs from the Secret on ACP".
   - The Secret is already past `notAfter`: "Expired platform component certificate Secret such as hco-webhook-service-cert not reissued on ACP".
   - An operator service certificate (`packageserver-service-cert`, `<name>-operator-service-cert`): "Operator service certificates such as packageserver-service-cert about to expire or not renewed on ACP".
