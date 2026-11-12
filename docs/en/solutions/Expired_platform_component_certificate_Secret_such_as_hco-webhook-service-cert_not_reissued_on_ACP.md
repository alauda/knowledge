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

# Expired platform component certificate Secret such as hco-webhook-service-cert not reissued on ACP

## Issue

The alert `平台组件证书已到期 <= 0d 且持续 1 分钟` (platform component certificate has expired, lasting 1 minute) fires, or an inspection lists a platform component certificate that is already past its end date, and it has not been renewed. Typical names are `hco-webhook-service-cert`, and the Argo CD GitOps certificates `argocd-gitops-tls` and `argocd-gitops-ca` in namespace `argocd`. The alert expression is:

```text
(max by(secret_namespace,name) (certificate_expires_time{secret_namespace!=""}) - time()) / (60*60*24)<=0
```

Or the platform says that a cluster's `packageserver-service-cert` is about to expire, and the question is how to renew it now.

Certificates that are still inside their renewal window are covered in "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP". Certificates that nothing uses any more are covered in "Expired leftover certificates that no component uses on ACP".

## Root Cause

### Cause 1: hco-webhook-service-cert or another component Secret is already expired and was not reissued

The `tls.crt` in a platform component Secret is past `notAfter` and was not renewed. Backing up and deleting the Secret makes its controller write a new certificate, with a validity of several years. The same backup-and-delete is used when other platform component Secrets are expired and the component needs to start again. It applies only to a platform component Secret whose certificate is actually expired. A business TLS Secret is not reissued by a delete.

The Argo CD GitOps certificates behave the same way: `argocd-gitops-tls` (issuer `CN = argocd-operator@argocd-gitops`) and `argocd-gitops-ca` in `argocd` can be past `notAfter` while `argocd-operator-controller-manager-service-cert`, which the Deployments mount as `apiservice-cert` and `webhook-cert`, is valid, and the platform is otherwise unaffected. Deleting the expired Secret regenerates it and the alert recovers.

### Cause 2: packageserver-service-cert is about to expire and has to be renewed now

`packageserver-service-cert` is owned by `olm-operator`, which normally rotates it about one day before expiry, so the 30-day alert fires first (see "Operator service certificates such as packageserver-service-cert about to expire or not renewed on ACP"). When the renewal is wanted now, or the rotation did not happen, backing up and deleting the Secret on the cluster the alert names makes the platform create a new certificate automatically.

## Resolution

### Cause 1: hco-webhook-service-cert or another component Secret is already expired and was not reissued

1. Locate the Secret by name and print `tls.crt`:

   ```bash
   kubectl get secrets -A | grep <secret-name>
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

   Continue only when `notAfter` is in the past and the name is a platform component Secret.

2. Back up and delete the Secret, and check the new dates.

   > **Warning:** Deleting `hco-webhook-service-cert` or another expired component Secret drops that webhook's certificate until the controller recreates it; admission that depends on the webhook fails during the gap. Do this only when step 1 shows the Secret is already expired and it is a platform component Secret, not a business TLS Secret. Rollback is `kubectl apply -f` of the backup.

   ```bash
   umask 077
   kubectl get secret -n <namespace> <secret-name> -o yaml > "$HOME/<secret-name>.yaml"
   kubectl delete secret -n <namespace> <secret-name>
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -serial -dates -subject -issuer
   ```

   The new `notAfter` must be years ahead. If the Secret is not recreated, restore the backup and see "Platform component certificate not renewed: stale private key, issuerRef group, or alert name that differs from the Secret on ACP".

3. Watch the alert clear after the new dates are present.

### Cause 2: packageserver-service-cert is about to expire and has to be renewed now

1. On the cluster the alert names, find the namespace (normally `cpaas-system`) and print the current dates:

   ```bash
   kubectl get secrets -A | grep packageserver-service-cert
   kubectl get secret -n <namespace> packageserver-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

2. Back up and delete the Secret.

   > **Warning:** Deleting `packageserver-service-cert` leaves the packageserver API service without its certificate until the new one is written; OLM and OperatorHub requests that use it can fail in the gap. Do this only on the cluster the alert names, when `tls.crt` is near expiry or past `notAfter`, and only with the backup. Rollback is `kubectl apply -f` of the backup; apply it also if the Secret is not recreated.

   ```bash
   umask 077
   kubectl get secret -n <namespace> packageserver-service-cert -o yaml > "$HOME/packageserver-service-cert.yaml"
   kubectl delete secret -n <namespace> packageserver-service-cert
   ```

3. Verify that the Secret is back and that `notAfter` moved forward, normally about two years:

   ```bash
   kubectl get secret -n <namespace> packageserver-service-cert
   kubectl get secret -n <namespace> packageserver-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -serial -dates
   ```

   If the certificate page or inspection still shows the old date, use the `courier` step in "Operator service certificates such as packageserver-service-cert about to expire or not renewed on ACP".

## Diagnostic Steps

1. Read the alert's cluster, namespace, and certificate name. When the alert does not name the certificate, the legend at the bottom of the alert monitoring detail panel lists each alerting series with `name` and `secret_namespace`. Print `tls.crt` on that cluster; a long-lived `ca.crt` in the same Secret is not what the alert counts.

2. What the common names protect:

   | Name | Purpose |
   |---|---|
   | `*-serving-cert` | Components that serve HTTPS, a webhook, or an internal API |
   | `dex.tls` | The platform access address and the Dex login (OIDC/SSO) |
   | `packageserver-service-cert` | Package Server / OLM API service traffic |
   | MetalLB `webhook-server-cert` | The MetalLB admission webhook |
   | `base-operator.tls`, katanomi certificates | Internal TLS of that operator and of the DevOps components |
   | `etcd-ca` | The root CA that etcd certificates trust |

3. Branch:

   - `hco-webhook-service-cert`, `argocd-gitops-tls`, `argocd-gitops-ca`, or another platform component Secret already past `notAfter`: Cause 1.
   - `packageserver-service-cert` about to expire, and it has to be renewed now: Cause 2.
   - About 30 days left on a `*-serving-cert` or an Istio CA name: "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP".
   - A Secret that belongs to a separately deployed application (for example `sentry-nginx-tls` in a `sentry-<suffix>` namespace): renewed by the application owner, not by the platform.
